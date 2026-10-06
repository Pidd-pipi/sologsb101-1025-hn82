/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbroastlog，数据结构版本号 DB_VERSION = 3
 *   version(1) 初版 → version(2) 时间戳/模板/派生值迁移 → version(3) 离线合并：rev 修订号 + 冲突候选 + 入库重试草稿表
 * - 生豆 / 烘焙记录 / 曲线事件 / 杯测 / 拼配方案 分表存储（另有载量模板表、合并草稿表）
 * - 首屏自动播种演示数据（父→子→孙三层贯通，幂等）
 * - 整库快照导出导入、级联删除、下豆扣减生豆在库重量
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
import type { MergeDraft, SyncTableName } from '../types/sync';
import { conflictCandidateId } from '../types/sync';
import { ensureRev, nextRevForTable } from './revision';
import { rorPerMinBetween } from './curve';

/** 数据库名（= 项目英文短名） */
export const DB_NAME = 'gbroastlog';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_VERSION = 3;

class RoastLogDatabase extends Dexie {
  greenBeans!: Table<GreenBean, string>;
  roastProfiles!: Table<RoastProfile, string>;
  events!: Table<RoastEvent, string>;
  cuppings!: Table<Cupping, string>;
  blends!: Table<Blend, string>;
  machineTemplates!: Table<MachineTemplate, string>;
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

    // v3：离线逐条合并——各表加 rev 修订号与 conflictOf 候选索引，新增入库重试草稿表；
    // 旧数据没有修订号时按烘焙日期（生豆按到货、杯测按杯测日期…）回填后再参与合并。
    this.version(DB_VERSION)
      .stores({
        greenBeans: 'id, origin, process, arrivedAt, createdAt, updatedAt, rev, conflictOf',
        roastProfiles: 'id, greenBeanId, machineModel, roastedAt, state, updatedAt, rev, conflictOf',
        events: 'id, profileId, type, atSec, createdAt, updatedAt, rev, conflictOf',
        cuppings: 'id, profileId, cuppedAt, totalScore, updatedAt, rev, conflictOf',
        blends: 'id, name, state, createdAt, updatedAt, rev, conflictOf',
        machineTemplates: 'id, model, chargeG, gasLevel, rev, conflictOf',
        mergeDrafts: 'id, createdAt, lastTriedAt',
      })
      .upgrade(async (tx) => {
        // 事件按所属烘焙记录的烘焙日期回填修订号
        const profiles = (await tx.table('roastProfiles').toArray()) as Array<Record<string, unknown>>;
        const profileDateMap = new Map<string, string>();
        profiles.forEach((row) => {
          if (typeof row.id === 'string' && typeof row.roastedAt === 'string') {
            profileDateMap.set(row.id, row.roastedAt);
          }
        });

        const revTables: SyncTableName[] = [
          'greenBeans',
          'roastProfiles',
          'events',
          'cuppings',
          'blends',
          'machineTemplates',
        ];
        for (const name of revTables) {
          const rows = (await tx.table(name).toArray()) as Array<Record<string, unknown>>;
          if (rows.length === 0) continue;
          const backfilled = rows.map((row) => ensureRev(name, row, profileDateMap));
          await tx.table(name).bulkPut(backfilled);
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

/* --------------------------- 生豆 GreenBean --------------------------- */

export async function listGreenBeans(): Promise<GreenBean[]> {
  const rows = (await db.greenBeans.toArray()).filter((row) => !row.conflictOf);
  return rows.sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt) || a.origin.localeCompare(b.origin, 'zh-Hans-CN'));
}

export async function getGreenBean(id: string): Promise<GreenBean | undefined> {
  return db.greenBeans.get(id);
}

export async function putGreenBean(row: GreenBean): Promise<void> {
  await db.greenBeans.put(row);
}

/** 删除生豆：级联删除其烘焙记录、曲线事件、杯测与对应冲突候选，并从拼配配方中摘除相关成分 */
export async function removeGreenBean(id: string): Promise<void> {
  await db.transaction('rw', db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, async () => {
    const profiles = await db.roastProfiles.where('greenBeanId').equals(id).toArray();
    const profileIds = profiles.map((profile) => profile.id);
    if (profileIds.length > 0) {
      await db.events.where('profileId').anyOf(profileIds).delete();
      await db.cuppings.where('profileId').anyOf(profileIds).delete();
      await db.roastProfiles.bulkDelete(profileIds);
      // 清理这些烘焙记录的冲突候选
      const profileCandidates = (await db.roastProfiles.toArray())
        .filter((row) => typeof row.conflictOf === 'string' && profileIds.includes(row.conflictOf))
        .map((row) => row.id);
      if (profileCandidates.length > 0) await db.roastProfiles.bulkDelete(profileCandidates);
    }
    const blends = await db.blends.toArray();
    const stamp = nowIso();
    const affected = blends
      .map((blend) => {
        const items = blend.items.filter((item) => item.greenBeanId !== id && !profileIds.includes(item.profileId));
        if (items.length === blend.items.length) return null;
        return {
          ...blend,
          items,
          rev: nextRevForTable('blends', { ...blend, items }, blend.rev),
          updatedAt: stamp,
        };
      })
      .filter((blend): blend is Blend => blend !== null);
    if (affected.length > 0) await db.blends.bulkPut(affected);
    await db.greenBeans.delete(id);
    const beanCandidates = await db.greenBeans.where('conflictOf').equals(id).primaryKeys();
    if (beanCandidates.length > 0) await db.greenBeans.bulkDelete(beanCandidates as string[]);
  });
}

/* ------------------------ 烘焙记录 RoastProfile ------------------------ */

export async function listRoastProfiles(): Promise<RoastProfile[]> {
  const rows = (await db.roastProfiles.toArray()).filter((row) => !row.conflictOf);
  return rows.sort((a, b) => b.roastedAt.localeCompare(a.roastedAt));
}

export async function getRoastProfile(id: string): Promise<RoastProfile | undefined> {
  return db.roastProfiles.get(id);
}

export async function putRoastProfile(row: RoastProfile): Promise<void> {
  await db.roastProfiles.put(row);
}

/** 删除烘焙记录：级联删除曲线事件、杯测与冲突候选，并从拼配配方中摘除相关成分 */
export async function removeRoastProfile(id: string): Promise<void> {
  await db.transaction('rw', db.roastProfiles, db.events, db.cuppings, db.blends, async () => {
    await db.events.where('profileId').equals(id).delete();
    await db.cuppings.where('profileId').equals(id).delete();
    const blends = await db.blends.toArray();
    const stamp = nowIso();
    const affected = blends
      .map((blend) => {
        const items = blend.items.filter((item) => item.profileId !== id);
        if (items.length === blend.items.length) return null;
        return {
          ...blend,
          items,
          rev: nextRevForTable('blends', { ...blend, items }, blend.rev),
          updatedAt: stamp,
        };
      })
      .filter((blend): blend is Blend => blend !== null);
    if (affected.length > 0) await db.blends.bulkPut(affected);
    await db.roastProfiles.delete(id);
    const candidateKeys = await db.roastProfiles.where('conflictOf').equals(id).primaryKeys();
    if (candidateKeys.length > 0) await db.roastProfiles.bulkDelete(candidateKeys as string[]);
  });
}

/** 状态流转：记录中 → 已完成 / 作废（状态变化也是一次修订，rev +1） */
export async function updateRoastState(id: string, state: RoastState): Promise<void> {
  const existing = await db.roastProfiles.get(id);
  const stamp = nowIso();
  if (!existing) {
    await db.roastProfiles.update(id, { state, updatedAt: stamp });
    return;
  }
  const next: RoastProfile = {
    ...existing,
    state,
    updatedAt: stamp,
    rev: nextRevForTable('roastProfiles', { ...existing, state }, existing.rev),
  };
  await db.roastProfiles.put(next);
}

/* --------------------------- 曲线事件 RoastEvent --------------------------- */

export async function listEvents(profileId?: string): Promise<RoastEvent[]> {
  const rows = (
    profileId
      ? await db.events.where('profileId').equals(profileId).toArray()
      : await db.events.toArray()
  ).filter((row) => !row.conflictOf);
  return rows.sort((a, b) => a.atSec - b.atSec);
}

export async function listAllEvents(): Promise<RoastEvent[]> {
  return (await db.events.toArray()).filter((row) => !row.conflictOf);
}

export async function putEvent(row: RoastEvent): Promise<void> {
  await db.events.put(row);
}

export async function putEvents(rows: RoastEvent[]): Promise<void> {
  await db.events.bulkPut(rows);
}

export async function removeEvent(id: string): Promise<void> {
  await db.events.delete(id);
}

/* ----------------------------- 杯测 Cupping ----------------------------- */

export async function listCuppings(): Promise<Cupping[]> {
  const rows = (await db.cuppings.toArray()).filter((row) => !row.conflictOf);
  return rows.sort((a, b) => b.cuppedAt.localeCompare(a.cuppedAt));
}

export async function putCupping(row: Cupping): Promise<void> {
  await db.cuppings.put(row);
}

export async function removeCupping(id: string): Promise<void> {
  await db.cuppings.delete(id);
}

/* ------------------------------ 拼配 Blend ------------------------------ */

export async function listBlends(): Promise<Blend[]> {
  const rows = (await db.blends.toArray()).filter((row) => !row.conflictOf);
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function putBlend(row: Blend): Promise<void> {
  await db.blends.put(row);
}

export async function removeBlend(id: string): Promise<void> {
  await db.blends.delete(id);
}

/* -------------------------- 载量模板 MachineTemplate -------------------------- */

export async function listMachineTemplates(): Promise<MachineTemplate[]> {
  const rows = (await db.machineTemplates.toArray()).filter((row) => !row.conflictOf);
  return rows.sort((a, b) => a.model.localeCompare(b.model, 'zh-Hans-CN') || a.chargeG - b.chargeG);
}

export async function putMachineTemplate(row: MachineTemplate): Promise<void> {
  await db.machineTemplates.put(row);
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
    if (profile.conflictOf) {
      return {
        ok: false,
        message: '该记录是待裁决的合并冲突候选，请先在合并中心选定保留版本后再下豆',
        deductedKg: 0,
        remainingKg: bean.stockKg,
        warning: false,
        bean,
        profile,
      };
    }
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
      rev: nextRevForTable('greenBeans', { ...bean, stockKg: remainingKg }, bean.rev),
      updatedAt: stamp,
    };
    const nextProfile: RoastProfile = {
      ...profile,
      state: 'done',
      rev: nextRevForTable('roastProfiles', { ...profile, state: 'done' }, profile.rev),
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
  /** 容量不足被拒后留待重试的入库草稿（门店端导出时随档带走） */
  mergeDrafts?: MergeDraft[];
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
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, mergeDrafts] = await Promise.all([
    db.greenBeans.toArray(),
    db.roastProfiles.toArray(),
    db.events.toArray(),
    db.cuppings.toArray(),
    db.blends.toArray(),
    db.machineTemplates.toArray(),
    db.mergeDrafts.toArray(),
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
    mergeDrafts,
  };
}

/** 用快照覆盖整库（旧的「覆盖导入」，保留供清空重建使用；跨店合并请用 utils/merge.ts） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  if (!isDatabaseSnapshot(snapshot)) {
    throw new Error('档案结构不合法：缺少 greenBeans / roastProfiles / events / cuppings / blends 数组字段');
  }
  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.machineTemplates, db.mergeDrafts],
    async () => {
      await Promise.all([
        db.greenBeans.clear(),
        db.roastProfiles.clear(),
        db.events.clear(),
        db.cuppings.clear(),
        db.blends.clear(),
        db.machineTemplates.clear(),
        db.mergeDrafts.clear(),
      ]);
      await db.greenBeans.bulkPut(snapshot.greenBeans);
      await db.roastProfiles.bulkPut(snapshot.roastProfiles);
      await db.events.bulkPut(snapshot.events);
      await db.cuppings.bulkPut(snapshot.cuppings);
      await db.blends.bulkPut(snapshot.blends);
      await db.machineTemplates.bulkPut(snapshot.machineTemplates ?? []);
      // 覆盖导入是「整库重建」，不接收对端的重试草稿，避免把别处的未完成入库带进来
    },
  );
}

/** 清空全部表（保留库结构与合并草稿，草稿跨清库仍可重试） */
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

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, mergeDrafts] = await Promise.all([
    db.greenBeans.count(),
    db.roastProfiles.count(),
    db.events.count(),
    db.cuppings.count(),
    db.blends.count(),
    db.machineTemplates.count(),
    db.mergeDrafts.count(),
  ]);
  return { greenBeans, roastProfiles, events, cuppings, blends, machineTemplates, mergeDrafts };
}

/** 重置为演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
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

  const greenBeans: Array<Omit<GreenBean, 'rev'>> = [
    {
      id: 'gb-guji-washed',
      origin: '埃塞俄比亚 古吉',
      farm: '乌拉嘎水洗站',
      process: 'washed',
      altitudeM: 2050,
      moisturePct: 10.8,
      stockKg: 12.5,
      arrivedAt: day(-52),
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
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  const roastProfiles: Array<Omit<RoastProfile, 'rev'>> = [
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

  const events: Array<Omit<RoastEvent, 'rev'>> = eventSeed.map(([id, profileId, type, atSec, beanTempC, note]) => ({
    id,
    profileId,
    type,
    atSec,
    beanTempC,
    rorPerMin: 0,
    note,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  // 按时间顺序补算 RoR（播种后就带上真实速率，页面直接可用）
  const grouped = new Map<RoastEvent['profileId'], Array<Omit<RoastEvent, 'rev'>>>();
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
  ): Omit<Cupping, 'rev'> => ({
    id,
    profileId,
    cuppedAt,
    dryAroma,
    wetAroma,
    acidity,
    sweetness,
    aftertaste,
    totalScore: weightedTotalScore({ dryAroma, wetAroma, acidity, sweetness, aftertaste }),
    createdAt: stamp,
    updatedAt: stamp,
  });

  const cuppings: Array<Omit<Cupping, 'rev'>> = [
    buildCupping('cp-guji-01', 'rp-guji-500', day(4), 8.5, 8.8, 8.6, 8.9, 8.4),
    buildCupping('cp-cerrado-01', 'rp-cerrado-1200', day(12), 8.2, 8.4, 7.8, 8.8, 8.6),
    buildCupping('cp-huila-01', 'rp-huila-800', day(9), 7.9, 8.1, 7.4, 8.2, 7.8),
  ];

  const blends: Array<Omit<Blend, 'rev'>> = [
    {
      id: 'bl-house-01',
      name: '晨光拼配 House Blend',
      items: [
        { greenBeanId: 'gb-guji-washed', profileId: 'rp-guji-500', ratioPct: 40 },
        { greenBeanId: 'gb-cerrado-natural', profileId: 'rp-cerrado-1200', ratioPct: 45 },
        { greenBeanId: 'gb-huila-honey', profileId: 'rp-huila-800', ratioPct: 15 },
      ],
      targetFlavor: '柑橘果酸、坚果可可',
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
      createdAt: day(27),
      state: 'trial',
      updatedAt: stamp,
    },
  ];

  const machineTemplates: Array<Omit<MachineTemplate, 'rev'>> = [
    {
      id: 'mt-hb-m6',
      model: 'HB-M6',
      airflow: 'half',
      gasLevel: 4,
      chargeG: 500,
      note: '常规出品载量',
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
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];

  // 按业务日期回填修订号（生豆到货 / 烘焙 / 杯测 / 创建日期），事件跟随所属烘焙记录
  const profileDateMap = new Map(roastProfiles.map((profile) => [profile.id, profile.roastedAt]));
  const seedGreenBeans: GreenBean[] = greenBeans.map((row) => ensureRev('greenBeans', row, profileDateMap));
  const seedRoastProfiles: RoastProfile[] = roastProfiles.map((row) =>
    ensureRev('roastProfiles', row, profileDateMap),
  );
  const seedEvents: RoastEvent[] = events.map((row) => ensureRev('events', row, profileDateMap));
  const seedCuppings: Cupping[] = cuppings.map((row) => ensureRev('cuppings', row, profileDateMap));
  const seedBlends: Blend[] = blends.map((row) => ensureRev('blends', row, profileDateMap));
  const seedMachineTemplates: MachineTemplate[] = machineTemplates.map((row) =>
    ensureRev('machineTemplates', row, profileDateMap),
  );

  await db.transaction(
    'rw',
    [db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends, db.machineTemplates],
    async () => {
      await db.greenBeans.bulkPut(seedGreenBeans);
      await db.roastProfiles.bulkPut(seedRoastProfiles);
      await db.events.bulkPut(seedEvents);
      await db.cuppings.bulkPut(seedCuppings);
      await db.blends.bulkPut(seedBlends);
      await db.machineTemplates.bulkPut(seedMachineTemplates);
    },
  );
}

/* --------------------------- 入库重试草稿（合并） --------------------------- */

/** 列出全部入库重试草稿，按创建时间倒序 */
export async function listMergeDrafts(): Promise<MergeDraft[]> {
  const rows = await db.mergeDrafts.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function putMergeDraft(draft: MergeDraft): Promise<void> {
  await db.mergeDrafts.put(draft);
}

export async function getMergeDraft(id: string): Promise<MergeDraft | undefined> {
  return db.mergeDrafts.get(id);
}

export async function removeMergeDraft(id: string): Promise<void> {
  await db.mergeDrafts.delete(id);
}

/* ----------------------------- 冲突候选裁决 ----------------------------- */

/** 各表候选行裁决后回写：以选中候选覆盖主记录，删除同组其余候选，并推进一次修订号。
 * 裁决烘焙记录时，子表（曲线事件 / 杯测）里归属被淘汰候选的孤儿候选一并清掉。 */
export async function resolveConflict(
  table: SyncTableName,
  winner: Record<string, unknown>,
): Promise<void> {
  const baseId = typeof winner.conflictOf === 'string' ? winner.conflictOf : String(winner.id);
  const dexieTable = db.table(table);
  const all = (await dexieTable.toArray()) as Array<Record<string, unknown>>;
  const group = all.filter((row) => {
    if (typeof row.conflictOf === 'string') return row.conflictOf === baseId;
    return String(row.id) === baseId;
  });
  const stamp = nowIso();
  const currentRev = group.reduce((acc, row) => Math.max(acc, Number(row.rev) || 0), 0);
  const resolved: Record<string, unknown> = {
    ...winner,
    id: baseId,
    conflictOf: undefined,
    conflictSide: undefined,
    updatedAt: stamp,
    rev: nextRevForTable(table, winner, currentRev),
  };
  delete resolved.conflictOf;
  delete resolved.conflictSide;
  const removeIds = group.map((row) => String(row.id)).filter((id) => id !== baseId);

  if (table === 'roastProfiles') {
    // 该记录下的事件/杯测候选跟随被淘汰的候选版本一起清除
    const childTables = [db.events, db.cuppings] as unknown as Array<Table<Record<string, unknown>, string>>;
    for (const child of childTables) {
      const orphans = (await child.toArray()).filter((row) => {
        if (typeof row.profileId !== 'string') return false;
        return removeIds.includes(row.profileId) || row.profileId === String(resolved.id);
      });
      // 只删候选行；主行（无 conflictOf）即使 profileId 暂时指向候选 id 也保留，交由后续合并修正
      const orphanIds = orphans
        .filter((row) => typeof row.conflictOf === 'string')
        .map((row) => String(row.id));
      if (orphanIds.length > 0) await child.bulkDelete(orphanIds);
    }
  }

  await dexieTable.bulkDelete(removeIds);
  await dexieTable.put(resolved);
}

/** 通用候选 id 生成（与 merge 引擎保持一致） */
export function candidateIdOf(table: SyncTableName, baseId: string, side: 'incoming' | 'local'): string {
  return conflictCandidateId(table, baseId, side);
}
