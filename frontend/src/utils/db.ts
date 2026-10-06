/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbroastlog，数据结构版本号 DB_VERSION = 3
 *   （v1 初版 / v2 补 createdAt·updatedAt 与载量模板并补算 RoR·总分 / v3 加修订号 revision 与 mergeDrafts 重试草稿表）
 * - 生豆 / 烘焙记录 / 曲线事件 / 杯测 / 拼配方案 分表存储（另有载量模板表、合并草稿表）
 * - 首屏自动播种演示数据（父→子→孙三层贯通，幂等）
 * - 整库快照导出、逐条合并落地、合并重试草稿、级联删除、下豆扣减生豆在库重量
 * 纯前端应用：不依赖任何后端或数据库服务。
 */
import Dexie, { type Table } from 'dexie';
import type { GreenBean } from '../types/greenbean';
import { LOW_STOCK_KG } from '../types/greenbean';
import type { MachineTemplate, RoastProfile, RoastState } from '../types/roastprofile';
import { ROAST_STATE_LABEL } from '../types/roastprofile';
import type { RoastEvent } from '../types/event';
import type { Cupping } from '../types/cupping';
import { weightedTotalScore } from '../types/cupping';
import type { Blend } from '../types/blend';
import { rorPerMinBetween } from './curve';
import { nextRevision, revisionFromDate } from './revision';
import type { MergeDraft, MergedSnapshot } from './merge';
import { buildMergedSnapshot, type MergeReport } from './merge';

/** 数据库名（= 项目英文短名） */
export const DB_NAME = 'gbroastlog';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_VERSION = 3;

/** 各业务表修订号回填/递增时参考的业务日期字段 */
const REVISION_DATE_FIELD: Record<string, string> = {
  greenBeans: 'arrivedAt',
  roastProfiles: 'roastedAt',
  events: 'createdAt',
  cuppings: 'cuppedAt',
  blends: 'createdAt',
  machineTemplates: 'createdAt',
};

class RoastLogDatabase extends Dexie {
  greenBeans!: Table<GreenBean, string>;
  roastProfiles!: Table<RoastProfile, string>;
  events!: Table<RoastEvent, string>;
  cuppings!: Table<Cupping, string>;
  blends!: Table<Blend, string>;
  machineTemplates!: Table<MachineTemplate, string>;
  /** 容量不足被拒绝、留待重试的合并草稿 */
  mergeDrafts!: Table<MergeDraft, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（仅业务字段，保留历史数据）
    this.version(1).stores({
      greenBeans: 'id, origin, process, arrivedAt, createdAt',
      roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state',
      events: 'id, profileId, type, atSec',
      cuppings: 'id, profileId, cuppedAt',
      blends: 'id, name, state, createdAt',
    });

    // v2：补齐 createdAt/updatedAt 索引；新增载量模板表；按时间顺序补算历史 RoR 与杯测总分
    this.version(2)
      .stores({
        greenBeans: 'id, origin, process, arrivedAt, createdAt, updatedAt',
        roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, updatedAt',
        events: 'id, profileId, type, atSec, createdAt, updatedAt',
        cuppings: 'id, profileId, cuppedAt, totalScore, updatedAt',
        blends: 'id, name, state, createdAt, updatedAt',
        machineTemplates: 'id, model, chargeG, gasLevel',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 1) 全部表补齐 createdAt / updatedAt（v1 只写了业务字段）
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('greenBeans'),
          tx.table('roastProfiles'),
          tx.table('events'),
          tx.table('cuppings'),
          tx.table('blends'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.createdAt !== 'string' || row.createdAt === '') row.createdAt = stamp;
            if (typeof row.updatedAt !== 'string' || row.updatedAt === '') row.updatedAt = row.createdAt;
          });
        }

        // 2) 生豆：兜底处理法、含水率与在库重量
        await tx.table('greenBeans').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.process !== 'string') row.process = 'washed';
          if (typeof row.moisturePct !== 'number') row.moisturePct = 11;
          if (typeof row.stockKg !== 'number' || !Number.isFinite(row.stockKg)) row.stockKg = 0;
        });

        // 3) 烘焙记录：兜底状态、风门与火力档
        await tx.table('roastProfiles').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string') row.state = 'recording';
          if (typeof row.airflow !== 'string') row.airflow = 'half';
          if (typeof row.gasLevel !== 'number') row.gasLevel = 3;
        });

        // 4) 曲线事件：按 profileId 分组、按时间升序补算缺失的 RoR，并补齐备注
        const eventRows = (await tx.table('events').toArray()) as Array<Record<string, unknown>>;
        const grouped = new Map<string, Array<Record<string, unknown>>>();
        eventRows.forEach((row) => {
          const profileId = typeof row.profileId === 'string' ? row.profileId : '';
          const list = grouped.get(profileId) ?? [];
          list.push(row);
          grouped.set(profileId, list);
        });
        const migratedEvents: Array<Record<string, unknown>> = [];
        grouped.forEach((list) => {
          list.sort((a, b) => Number(a.atSec ?? 0) - Number(b.atSec ?? 0));
          list.forEach((row, index) => {
            const prev = list[index - 1];
            if ((typeof row.rorPerMin !== 'number' || row.rorPerMin === 0) && prev) {
              row.rorPerMin = rorPerMinBetween(
                Number(prev.atSec ?? 0),
                Number(prev.beanTempC ?? 0),
                Number(row.atSec ?? 0),
                Number(row.beanTempC ?? 0),
              );
            }
            if (typeof row.rorPerMin !== 'number') row.rorPerMin = 0;
            if (typeof row.note !== 'string') row.note = '';
            migratedEvents.push(row);
          });
        });
        if (migratedEvents.length > 0) {
          await tx.table('events').bulkPut(migratedEvents);
        }

        // 5) 杯测：按分项加权补算历史总分
        await tx.table('cuppings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.totalScore !== 'number' || row.totalScore <= 0) {
            row.totalScore = weightedTotalScore({
              dryAroma: Number(row.dryAroma ?? 0),
              wetAroma: Number(row.wetAroma ?? 0),
              acidity: Number(row.acidity ?? 0),
              sweetness: Number(row.sweetness ?? 0),
              aftertaste: Number(row.aftertaste ?? 0),
            });
          }
        });

        // 6) 拼配方案：兜底配方明细与状态
        await tx.table('blends').toCollection().modify((row: Record<string, unknown>) => {
          if (!Array.isArray(row.items)) row.items = [];
          if (typeof row.state !== 'string') row.state = 'trial';
          if (typeof row.targetFlavor !== 'string') row.targetFlavor = '';
        });
      });

    // v3：离线合并支持——全部表补 revision（旧数据按业务日期回填）；新增 mergeDrafts 重试草稿表
    this.version(DB_VERSION)
      .stores({
        greenBeans: 'id, origin, process, arrivedAt, revision, createdAt, updatedAt',
        roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, revision, updatedAt',
        events: 'id, profileId, type, atSec, revision, createdAt, updatedAt',
        cuppings: 'id, profileId, cuppedAt, totalScore, revision, updatedAt',
        blends: 'id, name, state, createdAt, revision, updatedAt',
        machineTemplates: 'id, model, chargeG, gasLevel, revision',
        mergeDrafts: 'id, createdAt, updatedAt',
      })
      .upgrade(async (tx) => {
        // 旧数据没有修订号：按各自业务日期回填后再参与合并
        for (const [tableName, dateField] of Object.entries(REVISION_DATE_FIELD)) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const current = Number(row.revision);
              if (!Number.isFinite(current) || current <= 0) {
                const dateText = typeof row[dateField] === 'string' ? String(row[dateField]) : '';
                row.revision = revisionFromDate(dateText || (typeof row.updatedAt === 'string' ? row.updatedAt : ''));
              } else {
                row.revision = Math.trunc(current);
              }
            });
        }
      });
  }
}

export const db = new RoastLogDatabase();

/* ------------------------------ 通用工具 ------------------------------ */

/** 生成带前缀的主键 id */
export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 当前时间 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 保留三位小数的重量换算 */
export function roundKg(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 取某表一行的业务日期（修订号按它回填/递增） */
function businessDateOf(tableName: keyof typeof REVISION_DATE_FIELD, row: Record<string, unknown>): string {
  const field = REVISION_DATE_FIELD[tableName];
  const value = row[field];
  return typeof value === 'string' && value ? value : new Date().toISOString().slice(0, 10);
}

/** 写入前统一分配修订号：已存在则在原修订号上 +1，新记录按业务日期起算 */
async function withBumpedRevision<T extends { id: string; revision?: number }>(
  table: Table<T, string>,
  tableName: keyof typeof REVISION_DATE_FIELD,
  row: T,
): Promise<T & { revision: number }> {
  const existing = await table.get(row.id);
  return {
    ...row,
    revision: nextRevision(existing?.revision, businessDateOf(tableName, row as Record<string, unknown>)),
  };
}

/* --------------------------- 生豆 GreenBean --------------------------- */

export async function listGreenBeans(): Promise<GreenBean[]> {
  const rows = await db.greenBeans.toArray();
  return rows.sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt) || a.origin.localeCompare(b.origin, 'zh-Hans-CN'));
}

export async function getGreenBean(id: string): Promise<GreenBean | undefined> {
  return db.greenBeans.get(id);
}

/** 写入生豆（修订号由持久层统一分配：新建按到货日期起算，编辑在原值上 +1） */
export async function putGreenBean(row: Omit<GreenBean, 'revision'> & { revision?: number }): Promise<void> {
  await db.greenBeans.put(await withBumpedRevision(db.greenBeans, 'greenBeans', row));
}

/** 删除生豆：级联删除其烘焙记录、曲线事件、杯测，并从拼配配方中摘除相关成分 */
export async function removeGreenBean(id: string): Promise<void> {
  await db.transaction('rw', db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, async () => {
    const profiles = await db.roastProfiles.where('greenBeanId').equals(id).toArray();
    const profileIds = profiles.map((profile) => profile.id);
    if (profileIds.length > 0) {
      await db.events.where('profileId').anyOf(profileIds).delete();
      await db.cuppings.where('profileId').anyOf(profileIds).delete();
      await db.roastProfiles.bulkDelete(profileIds);
    }
    const blends = await db.blends.toArray();
    const stamp = nowIso();
    const affected = blends
      .map((blend) => {
        const items = blend.items.filter((item) => item.greenBeanId !== id && !profileIds.includes(item.profileId));
        return items.length === blend.items.length ? null : { ...blend, items, updatedAt: stamp };
      })
      .filter((blend): blend is Blend => blend !== null);
    if (affected.length > 0) await db.blends.bulkPut(affected);
    await db.greenBeans.delete(id);
  });
}

/* ------------------------ 烘焙记录 RoastProfile ------------------------ */

export async function listRoastProfiles(): Promise<RoastProfile[]> {
  const rows = await db.roastProfiles.toArray();
  return rows.sort((a, b) => b.roastedAt.localeCompare(a.roastedAt));
}

export async function getRoastProfile(id: string): Promise<RoastProfile | undefined> {
  return db.roastProfiles.get(id);
}

/** 写入烘焙记录（修订号由持久层按烘焙日期统一分配/递增） */
export async function putRoastProfile(row: Omit<RoastProfile, 'revision'> & { revision?: number }): Promise<void> {
  await db.roastProfiles.put(await withBumpedRevision(db.roastProfiles, 'roastProfiles', row));
}

/** 删除烘焙记录：级联删除曲线事件与杯测，并从拼配配方中摘除相关成分 */
export async function removeRoastProfile(id: string): Promise<void> {
  await db.transaction('rw', db.roastProfiles, db.events, db.cuppings, db.blends, async () => {
    await db.events.where('profileId').equals(id).delete();
    await db.cuppings.where('profileId').equals(id).delete();
    const blends = await db.blends.toArray();
    const stamp = nowIso();
    const affected = blends
      .map((blend) => {
        const items = blend.items.filter((item) => item.profileId !== id);
        return items.length === blend.items.length ? null : { ...blend, items, updatedAt: stamp };
      })
      .filter((blend): blend is Blend => blend !== null);
    if (affected.length > 0) await db.blends.bulkPut(affected);
    await db.roastProfiles.delete(id);
  });
}

/** 状态流转：记录中 → 已完成 / 作废（流转也产生一次修订） */
export async function updateRoastState(id: string, state: RoastState): Promise<void> {
  const existing = await db.roastProfiles.get(id);
  if (!existing) return;
  const stamp = nowIso();
  await db.roastProfiles.put({
    ...existing,
    state,
    updatedAt: stamp,
    revision: nextRevision(existing.revision, existing.roastedAt),
  });
}

/* --------------------------- 曲线事件 RoastEvent --------------------------- */

export async function listEvents(profileId?: string): Promise<RoastEvent[]> {
  const rows = profileId
    ? await db.events.where('profileId').equals(profileId).toArray()
    : await db.events.toArray();
  return rows.sort((a, b) => a.atSec - b.atSec);
}

export async function listAllEvents(): Promise<RoastEvent[]> {
  return db.events.toArray();
}

export async function getEvent(id: string): Promise<RoastEvent | undefined> {
  return db.events.get(id);
}

/** 写入单个曲线节点（修订号由持久层统一分配/递增） */
export async function putEvent(row: Omit<RoastEvent, 'revision'> & { revision?: number }): Promise<void> {
  await db.events.put(await withBumpedRevision(db.events, 'events', row));
}

/** 批量写入曲线节点：已存在按原修订号 +1，新节点按创建时间起算 */
export async function putEvents(rows: Array<Omit<RoastEvent, 'revision'> & { revision?: number }>): Promise<void> {
  const next = await Promise.all(rows.map((row) => withBumpedRevision(db.events, 'events', row)));
  await db.events.bulkPut(next);
}

export async function removeEvent(id: string): Promise<void> {
  await db.events.delete(id);
}

/* ----------------------------- 杯测 Cupping ----------------------------- */

export async function listCuppings(): Promise<Cupping[]> {
  const rows = await db.cuppings.toArray();
  return rows.sort((a, b) => b.cuppedAt.localeCompare(a.cuppedAt));
}

/** 写入杯测（修订号由持久层按杯测日期统一分配/递增；总分由分项重算） */
export async function putCupping(row: Omit<Cupping, 'revision'> & { revision?: number }): Promise<void> {
  await db.cuppings.put(await withBumpedRevision(db.cuppings, 'cuppings', row));
}

export async function removeCupping(id: string): Promise<void> {
  await db.cuppings.delete(id);
}

/* ------------------------------ 拼配 Blend ------------------------------ */

export async function listBlends(): Promise<Blend[]> {
  const rows = await db.blends.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 写入拼配方案（修订号由持久层按创建日期统一分配/递增） */
export async function putBlend(row: Omit<Blend, 'revision'> & { revision?: number }): Promise<void> {
  await db.blends.put(await withBumpedRevision(db.blends, 'blends', row));
}

export async function removeBlend(id: string): Promise<void> {
  await db.blends.delete(id);
}

/* -------------------------- 载量模板 MachineTemplate -------------------------- */

export async function listMachineTemplates(): Promise<MachineTemplate[]> {
  const rows = await db.machineTemplates.toArray();
  return rows.sort((a, b) => a.model.localeCompare(b.model, 'zh-Hans-CN') || a.chargeG - b.chargeG);
}

/** 写入载量模板（修订号由持久层统一分配/递增） */
export async function putMachineTemplate(
  row: Omit<MachineTemplate, 'revision'> & { revision?: number },
): Promise<void> {
  await db.machineTemplates.put(await withBumpedRevision(db.machineTemplates, 'machineTemplates', row));
}

export async function removeMachineTemplate(id: string): Promise<void> {
  await db.machineTemplates.delete(id);
}

/* --------------------------- 下豆扣减在库重量 --------------------------- */

export interface StockConsumeResult {
  ok: boolean;
  message: string;
  /** 本次扣减重量（kg） */
  deductedKg: number;
  /** 扣减后余量（kg） */
  remainingKg: number;
  /** 余量是否低于警戒线 */
  warning: boolean;
  bean?: GreenBean;
  profile?: RoastProfile;
}

/**
 * 烘焙下豆后按载量自动扣减生豆在库重量，并把记录状态推进为「已完成」。
 * 只有「记录中」的记录允许扣减，避免重复扣减；余量不足时直接拒绝。
 */
export async function consumeStockForProfile(profileId: string): Promise<StockConsumeResult> {
  return db.transaction('rw', db.greenBeans, db.roastProfiles, async () => {
    const profile = await db.roastProfiles.get(profileId);
    if (!profile) {
      return { ok: false, message: '烘焙记录不存在', deductedKg: 0, remainingKg: 0, warning: false };
    }
    const bean = await db.greenBeans.get(profile.greenBeanId);
    if (!bean) {
      return { ok: false, message: '该烘焙记录关联的生豆已不存在', deductedKg: 0, remainingKg: 0, warning: false };
    }
    const deductedKg = roundKg(profile.chargeG / 1000);
    if (profile.state !== 'recording') {
      return {
        ok: false,
        message: `该记录当前为「${ROAST_STATE_LABEL[profile.state]}」，无需重复扣减`,
        deductedKg: 0,
        remainingKg: bean.stockKg,
        warning: bean.stockKg < LOW_STOCK_KG,
        bean,
        profile,
      };
    }
    if (bean.stockKg + 1e-6 < deductedKg) {
      return {
        ok: false,
        message: `生豆余量不足：在库 ${bean.stockKg}kg < 本次载量 ${deductedKg}kg，请先补货或下调载量`,
        deductedKg: 0,
        remainingKg: bean.stockKg,
        warning: true,
        bean,
        profile,
      };
    }
    const stamp = nowIso();
    const remainingKg = roundKg(bean.stockKg - deductedKg);
    const nextBean: GreenBean = {
      ...bean,
      stockKg: remainingKg,
      revision: nextRevision(bean.revision, bean.arrivedAt),
      updatedAt: stamp,
    };
    const nextProfile: RoastProfile = {
      ...profile,
      state: 'done',
      revision: nextRevision(profile.revision, profile.roastedAt),
      updatedAt: stamp,
    };
    await db.greenBeans.put(nextBean);
    await db.roastProfiles.put(nextProfile);
    const warning = remainingKg < LOW_STOCK_KG;
    return {
      ok: true,
      message: `已按载量扣减 ${deductedKg}kg，${bean.farm || bean.origin} 余量 ${remainingKg}kg${
        warning ? '（余量偏低，请及时补货）' : ''
      }`,
      deductedKg,
      remainingKg,
      warning,
      bean: nextBean,
      profile: nextProfile,
    };
  });
}

/* ----------------------------- 整库导入导出 ----------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  greenBeans: GreenBean[];
  roastProfiles: RoastProfile[];
  events: RoastEvent[];
  cuppings: Cupping[];
  blends: Blend[];
  machineTemplates: MachineTemplate[];
}

/** 结构校验：判断任意对象是否为可导入的快照 */
export function isDatabaseSnapshot(value: unknown): value is DatabaseSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const keys: Array<keyof DatabaseSnapshot> = [
    'greenBeans',
    'roastProfiles',
    'events',
    'cuppings',
    'blends',
  ];
  return keys.every((key) => Array.isArray(candidate[key]));
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates] = await Promise.all([
    db.greenBeans.toArray(),
    db.roastProfiles.toArray(),
    db.events.toArray(),
    db.cuppings.toArray(),
    db.blends.toArray(),
    db.machineTemplates.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: nowIso(),
    greenBeans,
    roastProfiles,
    events,
    cuppings,
    blends,
    machineTemplates,
  };
}

/**
 * 按预演报告把两份离线档案合并落地（逐条合并的最终写入）。
 * - 未裁决冲突 / 容量不足：buildMergedSnapshot 会直接抛 MergeBlockedError，整单不写；
 * - 六张业务表在同一事务内整体替换为合并结果，保证「要么合并成功，要么原样不动」；
 * - 曲线分段 RoR、杯测总分、生豆余量已在构建阶段统一重算。
 */
export async function commitMergedSnapshot(report: MergeReport): Promise<void> {
  const merged: MergedSnapshot = buildMergedSnapshot(report);
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.machineTemplates],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
      ]);
      await db.greenBeans.bulkPut(merged.greenBeans);
      await db.roastProfiles.bulkPut(merged.roastProfiles);
      await db.events.bulkPut(merged.events);
      await db.cuppings.bulkPut(merged.cuppings);
      await db.blends.bulkPut(merged.blends);
      await db.machineTemplates.bulkPut(merged.machineTemplates);
    },
  );
}

/* --------------------------- 合并重试草稿 mergeDrafts --------------------------- */

/** 列出全部「容量不足待重试」的合并草稿（新的在前） */
export async function listMergeDrafts(): Promise<MergeDraft[]> {
  const rows = await db.mergeDrafts.toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 保存 / 更新合并重试草稿 */
export async function putMergeDraft(draft: MergeDraft): Promise<void> {
  await db.mergeDrafts.put(draft);
}

export async function getMergeDraft(id: string): Promise<MergeDraft | undefined> {
  return db.mergeDrafts.get(id);
}

export async function removeMergeDraft(id: string): Promise<void> {
  await db.mergeDrafts.delete(id);
}

/** 清空全部表 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.machineTemplates],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
      ]);
    },
  );
}

/** 重置为演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates] = await Promise.all([
    db.greenBeans.count(),
    db.roastProfiles.count(),
    db.events.count(),
    db.cuppings.count(),
    db.blends.count(),
    db.machineTemplates.count(),
  ]);
  return { greenBeans, roastProfiles, events, cuppings, blends, machineTemplates };
}

/* ------------------------------ 首屏初始化 ------------------------------ */

/** 打开数据库：空库时自动播种演示数据，保证每个页面开箱即有内容 */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.greenBeans.count()) === 0) {
    await seedDatabase();
  }
}

/**
 * 播种演示数据（幂等：固定 id + bulkPut）。
 * 层次：生豆 → 烘焙记录 → 曲线事件 / 杯测 → 拼配方案（→ 表示父引用子）。
 */
export async function seedDatabase(): Promise<void> {
  const existing = await db.greenBeans.count();
  if (existing > 0) return;

  const stamp = nowIso();
  const day = (offset: number): string => {
    const base = new Date('2025-01-10T08:00:00.000Z');
    base.setUTCDate(base.getUTCDate() + offset);
    return base.toISOString().slice(0, 10);
  };

  const greenBeans: GreenBean[] = [
    {
      id: 'gb-guji-washed',
      origin: '埃塞俄比亚 古吉',
      farm: '乌拉嘎水洗站',
      process: 'washed',
      altitudeM: 2050,
      moisturePct: 10.8,
      stockKg: 12.5,
      arrivedAt: day(-52),
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-huila-honey',
      origin: '哥伦比亚 惠兰',
      farm: '圣安东尼奥庄园',
      process: 'honey',
      altitudeM: 1750,
      moisturePct: 11.2,
      stockKg: 1.4,
      arrivedAt: day(-38),
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-cerrado-natural',
      origin: '巴西 喜拉多',
      farm: '圣伊莎贝尔庄园',
      process: 'natural',
      altitudeM: 1150,
      moisturePct: 11.6,
      stockKg: 20,
      arrivedAt: day(-22),
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'gb-nyeri-washed',
      origin: '肯尼亚 涅里',
      farm: '加图吉处理厂',
      process: 'washed',
      altitudeM: 1850,
      moisturePct: 10.4,
      stockKg: 6.4,
      arrivedAt: day(-10),
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const roastProfiles: RoastProfile[] = [
    {
      id: 'rp-guji-500',
      greenBeanId: 'gb-guji-washed',
      machineModel: 'HB-M6',
      chargeG: 500,
      chargeTempC: 198,
      airflow: 'half',
      gasLevel: 4,
      roastedAt: day(2),
      state: 'done',
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-huila-800',
      greenBeanId: 'gb-huila-honey',
      machineModel: 'Giesen W6A',
      chargeG: 800,
      chargeTempC: 205,
      airflow: 'open',
      gasLevel: 5,
      roastedAt: day(6),
      state: 'recording',
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-cerrado-1200',
      greenBeanId: 'gb-cerrado-natural',
      machineModel: 'Probat P12',
      chargeG: 1200,
      chargeTempC: 195,
      airflow: 'half',
      gasLevel: 6,
      roastedAt: day(10),
      state: 'done',
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'rp-nyeri-400',
      greenBeanId: 'gb-nyeri-washed',
      machineModel: 'Mill City 500g',
      chargeG: 400,
      chargeTempC: 200,
      airflow: 'closed',
      gasLevel: 3,
      roastedAt: day(12),
      state: 'void',
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const eventSeed: Array<[string, string, RoastEvent['type'], number, number, string]> = [
    ['ev-guji-1', 'rp-guji-500', 'turning', 95, 118.2, '回温点，火力保持 4 档'],
    ['ev-guji-2', 'rp-guji-500', 'dryEnd', 288, 152.6, '脱水结束转黄，风门调半开'],
    ['ev-guji-3', 'rp-guji-500', 'firstCrack', 462, 196.4, '一爆密集，火力回调至 3 档'],
    ['ev-guji-4', 'rp-guji-500', 'secondCrack', 640, 214.2, '二爆初起，准备下豆'],
    ['ev-guji-5', 'rp-guji-500', 'drop', 700, 219.5, '下豆冷却，发展率 34%'],
    ['ev-huila-1', 'rp-huila-800', 'turning', 102, 121, '回温偏晚，火力 5 档'],
    ['ev-huila-2', 'rp-huila-800', 'dryEnd', 305, 149.8, '蜜处理脱水稍慢'],
    ['ev-huila-3', 'rp-huila-800', 'firstCrack', 496, 193.5, '一爆清晰，待补录二爆与下豆'],
    ['ev-cerrado-1', 'rp-cerrado-1200', 'turning', 110, 116.4, '满锅载量，回温 110 秒'],
    ['ev-cerrado-2', 'rp-cerrado-1200', 'dryEnd', 330, 150.2, '脱水结束，火力维持 6 档'],
    ['ev-cerrado-3', 'rp-cerrado-1200', 'firstCrack', 540, 194.8, '一爆均匀'],
    ['ev-cerrado-4', 'rp-cerrado-1200', 'secondCrack', 720, 212.6, '二爆，风门半开'],
    ['ev-cerrado-5', 'rp-cerrado-1200', 'drop', 780, 217.2, '下豆，发展率 30.8%'],
    ['ev-nyeri-1', 'rp-nyeri-400', 'turning', 118, 114.5, '风门关，回温慢'],
    ['ev-nyeri-2', 'rp-nyeri-400', 'dryEnd', 372, 131.8, '脱水期过长、RoR 偏低，判定作废重烘'],
  ];

  const events: RoastEvent[] = eventSeed.map(([id, profileId, type, atSec, beanTempC, note]) => ({
    id,
    profileId,
    type,
    atSec,
    beanTempC,
    rorPerMin: 0,
    note,
    revision: revisionFromDate(stamp.slice(0, 10)),
    createdAt: stamp,
    updatedAt: stamp,
  }));
  // 按时间顺序补算 RoR（播种后就带上真实速率，页面直接可用）
  const grouped = new Map<string, RoastEvent[]>();
  events.forEach((event) => {
    const list = grouped.get(event.profileId) ?? [];
    list.push(event);
    grouped.set(event.profileId, list);
  });
  grouped.forEach((list) => {
    list.sort((a, b) => a.atSec - b.atSec);
    list.forEach((event, index) => {
      const prev = list[index - 1];
      event.rorPerMin = prev
        ? rorPerMinBetween(prev.atSec, prev.beanTempC, event.atSec, event.beanTempC)
        : 0;
    });
  });

  const buildCupping = (
    id: string,
    profileId: string,
    cuppedAt: string,
    dryAroma: number,
    wetAroma: number,
    acidity: number,
    sweetness: number,
    aftertaste: number,
  ): Cupping => ({
    id,
    profileId,
    cuppedAt,
    dryAroma,
    wetAroma,
    acidity,
    sweetness,
    aftertaste,
    totalScore: weightedTotalScore({ dryAroma, wetAroma, acidity, sweetness, aftertaste }),
    revision: revisionFromDate(cuppedAt),
    createdAt: stamp,
    updatedAt: stamp,
  });

  const cuppings: Cupping[] = [
    buildCupping('cp-guji-01', 'rp-guji-500', day(4), 8.5, 8.8, 8.6, 8.9, 8.4),
    buildCupping('cp-cerrado-01', 'rp-cerrado-1200', day(12), 8.2, 8.4, 7.8, 8.8, 8.6),
    buildCupping('cp-huila-01', 'rp-huila-800', day(9), 7.9, 8.1, 7.4, 8.2, 7.8),
  ];

  const blends: Blend[] = [
    {
      id: 'bl-house-01',
      name: '晨光拼配 House Blend',
      items: [
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 40 },
        { greenBeanId: 'gb-cerrado-natural', profileId: 'rp-cerrado-1200', ratioPct: 45 },
        { greenBeanId: 'gb-huila-honey', profileId: 'rp-huila-800', ratioPct: 15 },
      ],
      targetFlavor: '柑橘果酸、坚果可可',
      revision: revisionFromDate(day(15)),
      createdAt: day(15),
      state: 'final',
      updatedAt: stamp,
    },
    {
      id: 'bl-espresso-02',
      name: '深烘意式 Espresso Base',
      items: [
        { greenBeanId: 'gb-cerrado-natural', profileId: 'rp-cerrado-1200', ratioPct: 70 },
        { greenBeanId: 'gb-nyeri-washed', profileId: 'rp-nyeri-400', ratioPct: 30 },
      ],
      targetFlavor: '坚果可可、焦糖甜感',
      revision: revisionFromDate(day(23)),
      createdAt: day(23),
      state: 'trial',
      updatedAt: stamp,
    },
    {
      id: 'bl-draft-03',
      name: '实验批次（占比待调平）',
      items: [
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 50 },
        { greenBeanId: 'gb-huila-honey', profileId: 'rp-huila-800', ratioPct: 30 },
      ],
      targetFlavor: '花香、莓果',
      revision: revisionFromDate(day(27)),
      createdAt: day(27),
      state: 'trial',
      updatedAt: stamp,
    },
  ];

  const machineTemplates: MachineTemplate[] = [
    {
      id: 'mt-hb-m6',
      model: 'HB-M6',
      airflow: 'half',
      gasLevel: 4,
      chargeG: 500,
      note: '常规出品载量',
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-giesen-w6a',
      model: 'Giesen W6A',
      airflow: 'open',
      gasLevel: 5,
      chargeG: 800,
      note: '满锅载量，适合日晒豆',
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-probat-p12',
      model: 'Probat P12',
      airflow: 'half',
      gasLevel: 6,
      chargeG: 1200,
      note: '批量生产档',
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: 'mt-millcity-500',
      model: 'Mill City 500g',
      airflow: 'closed',
      gasLevel: 3,
      chargeG: 400,
      note: '样品烘焙，风门关',
      revision: nextRevision(undefined, day(0)),
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  // 修订号按各自业务日期对齐（旧数据回填口径一致：日期相对纪元的天数）
  greenBeans.forEach((bean) => {
    bean.revision = revisionFromDate(bean.arrivedAt);
  });
  roastProfiles.forEach((profile) => {
    profile.revision = revisionFromDate(profile.roastedAt);
  });
  blends.forEach((blend) => {
    blend.revision = revisionFromDate(blend.createdAt);
  });
  machineTemplates.forEach((template) => {
    template.revision = revisionFromDate(stamp.slice(0, 10));
  });

  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.machineTemplates],
    async () => {
      await db.greenBeans.bulkPut(greenBeans);
      await db.roastProfiles.bulkPut(roastProfiles);
      await db.events.bulkPut(events);
      await db.cuppings.bulkPut(cuppings);
      await db.blends.bulkPut(blends);
      await db.machineTemplates.bulkPut(machineTemplates);
    },
  );
}
