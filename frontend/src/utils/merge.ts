/**
 * 离线档案逐条合并引擎（烘焙间 / 门店两份各改各的，回店合并成一份）。
 *
 * 规则（严格按需求）：
 * 1. 同一条（按主键 id）先比修订号 revision，再比 updatedAt；只有一边有的直接补进来。
 * 2. 修订号/时间都相同但两边业务内容都改过（不一致）→ 不用后到的盖掉，保留两个候选交人工裁决。
 * 3. 入库前先看生豆在库余量：对端带来的、本店尚未扣减过的「已完成」烘焙要占用在库余量，
 *    容量不够就整单拒绝入库，落为可重试草稿；补货后可接着同一草稿重试。
 * 4. 合并落地后重算：曲线节点分段 RoR、杯测加权总分、拼配均分（由合并结果实时派生）、
 *    生豆在库余量（只按本次新采纳的已完成记录统一扣一遍，避免两边各扣一遍）。
 * 5. 旧数据没有修订号时，已先按业务日期回填（见 db.ts 的 v3 迁移），再参与合并。
 */
import type { GreenBean } from '../types/greenbean';
import { BEAN_PROCESS_ORDER } from '../types/greenbean';
import type { MachineTemplate, RoastProfile } from '../types/roastprofile';
import { AIRFLOW_ORDER, ROAST_STATE_ORDER } from '../types/roastprofile';
import type { RoastEvent } from '../types/event';
import type { Cupping } from '../types/cupping';
import { weightedTotalScore } from '../types/cupping';
import type { Blend } from '../types/blend';
import { BLEND_STATE_ORDER } from '../types/blend';
import { revisionFromDate } from './revision';
import { rorPerMinBetween } from './curve';
import type { DatabaseSnapshot } from './db';

/* ------------------------------ 类型定义 ------------------------------ */

export type MergeTableName = 'greenBeans' | 'roastProfiles' | 'events' | 'cuppings' | 'blends' | 'machineTemplates';

export type MergeSide = 'local' | 'incoming';

/** 逐条合并处置方式 */
export type MergeDecision =
  | 'identical' // 两边完全一致
  | 'localOnly' // 仅本店有
  | 'incomingOnly' // 仅对端有（直接补入）
  | 'localWins' // 同一条：本店版本较新
  | 'incomingWins' // 同一条：对端版本较新
  | 'conflict'; // 两边都动过且分不出新旧 → 双候选

export interface MergeRowPlan<T = unknown> {
  table: MergeTableName;
  id: string;
  decision: MergeDecision;
  local: T | null;
  incoming: T | null;
  /** 预演阶段给出的建议选择；conflict 时为 null，必须人工裁决 */
  suggestedSide: MergeSide | null;
  /** conflict 裁决结果（'local' / 'incoming' 分别留一个，'both' 留两个候选） */
  resolution?: MergeResolution;
  /** 该条被拒绝原因（容量不足等）；存在时不入库 */
  rejectReason?: string;
}

/** 冲突裁决：保留本店版 / 对端版 / 两个候选都留 */
export type MergeResolution = MergeSide | 'both';

export interface MergeStockCheck {
  greenBeanId: string;
  origin: string;
  /** 合并前在库余量（kg） */
  stockKg: number;
  /** 对端带来的新增已完成烘焙合计占用（kg） */
  neededKg: number;
  /** 涉及的烘焙记录 id */
  profileIds: string[];
  ok: boolean;
  shortKg: number;
}

export interface MergeReport {
  plans: MergeRowPlan[];
  conflicts: MergeRowPlan[];
  rejected: MergeRowPlan[];
  stockChecks: MergeStockCheck[];
  /** 汇总计数 */
  counts: Record<MergeTableName, { add: number; update: number; conflict: number; reject: number; identical: number }>;
}

/** 持久化的可重试合并草稿 */
export interface MergeDraft {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** 待入库的对端整库快照（结构与导出档案一致） */
  snapshot: DatabaseSnapshot;
  /** 已做过的冲突裁决（重试时沿用） */
  resolutions: Record<string, MergeResolution>;
  /** 上次失败原因 */
  lastError: string;
  /** 已重试次数 */
  attempts: number;
}

/** 合并落地后的整库快照（六个表均为最终数据） */
export interface MergedSnapshot {
  greenBeans: GreenBean[];
  roastProfiles: RoastProfile[];
  events: RoastEvent[];
  cuppings: Cupping[];
  blends: Blend[];
  machineTemplates: MachineTemplate[];
}

/* ------------------------------ 工具函数 ------------------------------ */

type AnyRow = Record<string, unknown>;

const TABLE_DATE_FIELD: Record<MergeTableName, string> = {
  greenBeans: 'arrivedAt',
  roastProfiles: 'roastedAt',
  events: 'createdAt',
  cuppings: 'cuppedAt',
  blends: 'createdAt',
  machineTemplates: 'createdAt',
};

/** 生成带前缀的 id（与 db.createId 同风格，此处独立避免与 db.ts 形成运行时循环依赖） */
function mergeCreateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 取修订号（旧数据缺省时按业务日期回填，不修改入参） */
export function revisionOf(row: AnyRow, table: MergeTableName): number {
  const revision = Number(row.revision);
  if (Number.isFinite(revision) && revision > 0) return Math.trunc(revision);
  const dateText = typeof row[TABLE_DATE_FIELD[table]] === 'string' ? String(row[TABLE_DATE_FIELD[table]]) : '';
  return revisionFromDate(dateText || (typeof row.updatedAt === 'string' ? row.updatedAt : '') || todayText());
}

/** 更新时间（缺失时退化为创建时间） */
function updatedAtOf(row: AnyRow): string {
  if (typeof row.updatedAt === 'string' && row.updatedAt) return row.updatedAt;
  if (typeof row.createdAt === 'string' && row.createdAt) return row.createdAt;
  return '';
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 参与「两边是否都动过」判定的业务字段（元数据字段不参与） */
const META_KEYS = new Set(['id', 'revision', 'createdAt', 'updatedAt']);

/**
 * 派生字段不参与内容比对：它们在合并落地时统一重算，
 * 仅派生值差异（对端总分/RoR/余量是旧算法或已各自扣减）不算「业务内容两边都改过」。
 */
const DERIVED_KEYS_BY_TABLE: Partial<Record<MergeTableName, Set<string>>> = {
  events: new Set(['rorPerMin']),
  cuppings: new Set(['totalScore']),
  greenBeans: new Set(['stockKg']),
};

function businessContent(row: AnyRow, table: MergeTableName): string {
  const ignored = DERIVED_KEYS_BY_TABLE[table];
  const keys = Object.keys(row)
    .filter((key) => !META_KEYS.has(key) && !(ignored?.has(key)))
    .sort();
  return JSON.stringify(keys.map((key) => [key, row[key]]));
}

/** 重量换算（kg，保留三位小数） */
function roundKg(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 为一行补 revision（缺省按业务日期回填），返回新对象 */
function withRevision<T>(row: T, table: MergeTableName): T {
  const record = row as unknown as AnyRow;
  if (Number.isFinite(Number(record.revision)) && Number(record.revision) > 0) return row;
  return { ...record, revision: revisionOf(record, table) } as unknown as T;
}

/* ------------------------------ 单表逐条比对 ------------------------------ */

function compareRows<T>(table: MergeTableName, localRows: T[], incomingRows: T[]): Array<MergeRowPlan<T>> {
  const localMap = new Map<string, T>(
    (localRows as unknown as AnyRow[]).map((row) => [String(row.id), row]) as Array<[string, T]>,
  );
  const incomingMap = new Map<string, T>(
    (incomingRows as unknown as AnyRow[]).map((row) => [String(row.id), row]) as Array<[string, T]>,
  );
  const ids = Array.from(new Set([...localMap.keys(), ...incomingMap.keys()]));

  return ids.map((id) => {
    const local = localMap.get(id) ?? null;
    const incoming = incomingMap.get(id) ?? null;
    const base: MergeRowPlan<T> = { table, id, decision: 'identical', local, incoming, suggestedSide: null };

    if (local && !incoming) return { ...base, decision: 'localOnly' };
    if (!local && incoming) return { ...base, decision: 'incomingOnly', suggestedSide: 'incoming' };
    if (!local || !incoming) return base;

    const localRecord = local as unknown as AnyRow;
    const incomingRecord = incoming as unknown as AnyRow;
    if (businessContent(localRecord, table) === businessContent(incomingRecord, table)) {
      return { ...base, decision: 'identical' };
    }

    const localRevision = revisionOf(localRecord, table);
    const incomingRevision = revisionOf(incomingRecord, table);
    if (incomingRevision > localRevision) {
      return { ...base, decision: 'incomingWins', suggestedSide: 'incoming' };
    }
    if (incomingRevision < localRevision) {
      return { ...base, decision: 'localWins', suggestedSide: 'local' };
    }

    // 修订号相同 → 再比时间
    const localTime = updatedAtOf(localRecord);
    const incomingTime = updatedAtOf(incomingRecord);
    if (incomingTime && localTime && incomingTime !== localTime) {
      return incomingTime > localTime
        ? { ...base, decision: 'incomingWins', suggestedSide: 'incoming' }
        : { ...base, decision: 'localWins', suggestedSide: 'local' };
    }

    // 修订号相同、时间也分不出新旧，且两边业务内容不一致 → 两边都动过，留两个候选
    return { ...base, decision: 'conflict', suggestedSide: null };
  });
}

/* ------------------------ 已完成烘焙的新增占用口径 ------------------------ */

/**
 * 判定某条对端烘焙记录落地后，是否需要在本店余量上「新扣」载量：
 * - 本店没有这条记录（对端新增）且为已完成 → 要扣；
 * - 本店有同 id 记录但本店尚未完成（对端把它烘完了，裁决采纳对端）→ 要扣；
 * - 本店同 id 记录本就已完成 → 本店下豆时已经扣过，不再重复扣；
 * - 冲突裁决「两份都留」→ 对端副本视为另一锅实物烘焙，要扣；
 * - 裁决留本店 / 本店版本胜出 → 以本店状态为准，不新增扣减。
 */
function profileNeedsDeduct(plan: MergeRowPlan<RoastProfile>): boolean {
  const incoming = plan.incoming;
  if (!incoming || incoming.state !== 'done') return false;
  const local = plan.local;
  switch (plan.decision) {
    case 'incomingOnly':
      return true;
    case 'incomingWins':
      return !local || local.state !== 'done';
    case 'conflict':
      if (plan.resolution === 'incoming') return !local || local.state !== 'done';
      if (plan.resolution === 'both') return true;
      return false;
    default:
      return false;
  }
}

/**
 * 生豆在库余量闸门：对端带来的新增已完成烘焙合计载量是否超出本店当前在库余量。
 * 任一生豆不够 → 整单拒绝（由调用方落重试草稿），不做部分入库。
 */
export function checkStockCapacity(
  local: Pick<DatabaseSnapshot, 'greenBeans' | 'roastProfiles'>,
  profilePlans: MergeRowPlan<RoastProfile>[],
): MergeStockCheck[] {
  const localBeans = new Map(local.greenBeans.map((bean) => [bean.id, bean]));
  const checks = new Map<string, MergeStockCheck>();

  const ensure = (beanId: string): MergeStockCheck => {
    let check = checks.get(beanId);
    if (!check) {
      const bean = localBeans.get(beanId);
      check = {
        greenBeanId: beanId,
        origin: bean ? `${bean.origin}${bean.farm ? ` · ${bean.farm}` : ''}` : '（本店暂无此生豆）',
        stockKg: bean ? bean.stockKg : 0,
        neededKg: 0,
        profileIds: [],
        ok: true,
        shortKg: 0,
      };
      checks.set(beanId, check);
    }
    return check;
  };

  profilePlans.forEach((plan) => {
    if (!profileNeedsDeduct(plan) || plan.rejectReason) return;
    const incoming = plan.incoming as RoastProfile;
    const check = ensure(incoming.greenBeanId);
    check.neededKg = roundKg(check.neededKg + incoming.chargeG / 1000);
    check.profileIds.push(incoming.id);
  });

  return Array.from(checks.values()).map((check) => {
    const ok = check.stockKg + 1e-6 >= check.neededKg;
    return { ...check, ok, shortKg: ok ? 0 : roundKg(check.neededKg - check.stockKg) };
  });
}

/* ------------------------------ 合并预演 ------------------------------ */

export interface MergePreviewInput {
  local: DatabaseSnapshot;
  incoming: DatabaseSnapshot;
  /** 冲突的人工裁决（key = `${table}:${id}`） */
  resolutions?: Record<string, MergeResolution>;
}

/** 预演：逐条比对 + 套用冲突裁决 + 容量闸门，产出可直接落地或落草稿的计划 */
export function planMerge(input: MergePreviewInput): MergeReport {
  const { local, incoming, resolutions = {} } = input;

  const plans: MergeRowPlan[] = [
    ...compareRows('greenBeans', local.greenBeans, incoming.greenBeans),
    ...compareRows('roastProfiles', local.roastProfiles, incoming.roastProfiles),
    ...compareRows('events', local.events, incoming.events),
    ...compareRows('cuppings', local.cuppings, incoming.cuppings),
    ...compareRows('blends', local.blends, incoming.blends),
    ...compareRows('machineTemplates', local.machineTemplates ?? [], incoming.machineTemplates ?? []),
  ];

  // 套用人工裁决
  plans.forEach((plan) => {
    if (plan.decision === 'conflict') {
      plan.resolution = resolutions[`${plan.table}:${plan.id}`];
    }
  });

  // 容量闸门（按当前裁决结果计算）
  const profilePlans = plans.filter(
    (plan): plan is MergeRowPlan<RoastProfile> => plan.table === 'roastProfiles',
  );
  const stockChecks = checkStockCapacity(local, profilePlans);
  const failedChecks = new Map(stockChecks.filter((check) => !check.ok).map((check) => [check.greenBeanId, check]));

  const rejected: MergeRowPlan[] = [];
  profilePlans.forEach((plan) => {
    const incoming = plan.incoming;
    if (!incoming || incoming.state !== 'done' || !profileNeedsDeduct(plan)) return;
    const fail = failedChecks.get(incoming.greenBeanId);
    if (fail && fail.profileIds.includes(incoming.id)) {
      plan.rejectReason = `生豆余量不足：在库 ${fail.stockKg}kg，本次新增已完成烘焙共需 ${fail.neededKg}kg，缺口 ${fail.shortKg}kg`;
      rejected.push(plan);
    }
  });

  const conflicts = plans.filter((plan) => plan.decision === 'conflict' && !plan.resolution);

  const emptyCounts = (): MergeReport['counts'][MergeTableName] => ({
    add: 0,
    update: 0,
    conflict: 0,
    reject: 0,
    identical: 0,
  });
  const counts: MergeReport['counts'] = {
    greenBeans: emptyCounts(),
    roastProfiles: emptyCounts(),
    events: emptyCounts(),
    cuppings: emptyCounts(),
    blends: emptyCounts(),
    machineTemplates: emptyCounts(),
  };
  plans.forEach((plan) => {
    const bucket = counts[plan.table];
    if (plan.rejectReason) {
      bucket.reject += 1;
      return;
    }
    if (plan.decision === 'identical' || plan.decision === 'localOnly') {
      if (plan.decision === 'identical') bucket.identical += 1;
      return;
    }
    if (plan.decision === 'conflict' && !plan.resolution) {
      bucket.conflict += 1;
      return;
    }
    const adoptsIncoming =
      plan.decision === 'incomingOnly' ||
      plan.decision === 'incomingWins' ||
      (plan.decision === 'conflict' && (plan.resolution === 'incoming' || plan.resolution === 'both'));
    if (adoptsIncoming) {
      if (plan.local) bucket.update += 1;
      else bucket.add += 1;
    }
    if (plan.decision === 'conflict' && plan.resolution === 'both') {
      // 双留：对端副本另算一次 add（副本会生成新 id）
      bucket.add += 1;
    }
  });

  return { plans, conflicts, rejected, stockChecks, counts };
}

/* ------------------------------ 落地后重算 ------------------------------ */

/** 按 profileId 分组重算全部曲线事件的分段 RoR（首点为 0） */
export function recomputeEventsRor(events: RoastEvent[]): RoastEvent[] {
  const grouped = new Map<string, RoastEvent[]>();
  events.forEach((event) => {
    const list = grouped.get(event.profileId) ?? [];
    list.push(event);
    grouped.set(event.profileId, list);
  });
  const next: RoastEvent[] = [];
  grouped.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.atSec - b.atSec);
    sorted.forEach((event, index) => {
      const prev = sorted[index - 1];
      next.push({
        ...event,
        rorPerMin: prev ? rorPerMinBetween(prev.atSec, prev.beanTempC, event.atSec, event.beanTempC) : 0,
      });
    });
  });
  return next;
}

/** 杯测分一更新，总分就按五项权重重算 */
export function recomputeCuppingScore(cupping: Cupping): Cupping {
  return {
    ...cupping,
    totalScore: weightedTotalScore({
      dryAroma: cupping.dryAroma,
      wetAroma: cupping.wetAroma,
      acidity: cupping.acidity,
      sweetness: cupping.sweetness,
      aftertaste: cupping.aftertaste,
    }),
  };
}

/* ------------------------------ 规范化（缺省字段兜底） ------------------------------ */

function asNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 规范化一行旧数据（字段兜底 + 修订号回填），供合并落地前统一使用 */
export function normalizeRow(row: unknown, table: MergeTableName): AnyRow | null {
  if (typeof row !== 'object' || row === null) return null;
  const source = row as AnyRow;
  if (typeof source.id !== 'string' || !source.id) return null;

  const stamp = typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString();
  const base: AnyRow = {
    ...source,
    id: source.id,
    createdAt: asString(source.createdAt, stamp),
    updatedAt: asString(source.updatedAt, asString(source.createdAt, stamp)),
    revision: revisionOf(source, table),
  };

  switch (table) {
    case 'greenBeans':
      return {
        ...base,
        origin: asString(source.origin, '未登记产地'),
        farm: asString(source.farm, ''),
        process: pickEnum(source.process, BEAN_PROCESS_ORDER, 'washed'),
        altitudeM: asNumber(source.altitudeM, 0),
        moisturePct: asNumber(source.moisturePct, 11),
        stockKg: asNumber(source.stockKg, 0),
        arrivedAt: asString(source.arrivedAt, todayText()),
      } as GreenBean & AnyRow;
    case 'roastProfiles':
      return {
        ...base,
        greenBeanId: asString(source.greenBeanId, ''),
        machineModel: asString(source.machineModel, ''),
        chargeG: asNumber(source.chargeG, 0),
        chargeTempC: asNumber(source.chargeTempC, 0),
        airflow: pickEnum(source.airflow, AIRFLOW_ORDER, 'half'),
        gasLevel: asNumber(source.gasLevel, 3),
        roastedAt: asString(source.roastedAt, todayText()),
        state: pickEnum(source.state, ROAST_STATE_ORDER, 'recording'),
      } as RoastProfile & AnyRow;
    case 'events':
      return {
        ...base,
        profileId: asString(source.profileId, ''),
        type: asString(source.type, 'turning'),
        atSec: asNumber(source.atSec, 0),
        beanTempC: asNumber(source.beanTempC, 0),
        rorPerMin: asNumber(source.rorPerMin, 0),
        note: asString(source.note, ''),
      } as RoastEvent & AnyRow;
    case 'cuppings': {
      const normalized: AnyRow = {
        ...base,
        profileId: asString(source.profileId, ''),
        cuppedAt: asString(source.cuppedAt, todayText()),
        dryAroma: asNumber(source.dryAroma, 0),
        wetAroma: asNumber(source.wetAroma, 0),
        acidity: asNumber(source.acidity, 0),
        sweetness: asNumber(source.sweetness, 0),
        aftertaste: asNumber(source.aftertaste, 0),
      };
      normalized.totalScore = weightedTotalScore({
        dryAroma: asNumber(normalized.dryAroma, 0),
        wetAroma: asNumber(normalized.wetAroma, 0),
        acidity: asNumber(normalized.acidity, 0),
        sweetness: asNumber(normalized.sweetness, 0),
        aftertaste: asNumber(normalized.aftertaste, 0),
      });
      return normalized as Cupping & AnyRow;
    }
    case 'blends':
      return {
        ...base,
        name: asString(source.name, '未命名拼配'),
        items: Array.isArray(source.items)
          ? source.items.map((item) => {
              const record = (item ?? {}) as AnyRow;
              return {
                greenBeanId: asString(record.greenBeanId, ''),
                profileId: asString(record.profileId, ''),
                ratioPct: asNumber(record.ratioPct, 0),
              };
            })
          : [],
        targetFlavor: asString(source.targetFlavor, ''),
        createdAt: asString(source.createdAt, todayText()),
        state: pickEnum(source.state, BLEND_STATE_ORDER, 'trial'),
      } as Blend & AnyRow;
    case 'machineTemplates':
      return {
        ...base,
        model: asString(source.model, ''),
        airflow: pickEnum(source.airflow, AIRFLOW_ORDER, 'half'),
        gasLevel: asNumber(source.gasLevel, 3),
        chargeG: asNumber(source.chargeG, 0),
        note: asString(source.note, ''),
      } as MachineTemplate & AnyRow;
    default:
      return base;
  }
}

/** 给整份快照的每张表补齐 revision（用于对端旧版本档案） */
export function ensureSnapshotRevisions(snapshot: DatabaseSnapshot): DatabaseSnapshot {
  const tables: Array<{ table: MergeTableName; rows: unknown[] }> = [
    { table: 'greenBeans', rows: snapshot.greenBeans },
    { table: 'roastProfiles', rows: snapshot.roastProfiles },
    { table: 'events', rows: snapshot.events },
    { table: 'cuppings', rows: snapshot.cuppings },
    { table: 'blends', rows: snapshot.blends },
    { table: 'machineTemplates', rows: snapshot.machineTemplates ?? [] },
  ];
  const next = { ...snapshot } as unknown as Record<MergeTableName, unknown[]>;
  tables.forEach(({ table, rows }) => {
    next[table] = rows.map((row) => withRevision(row as AnyRow, table));
  });
  return next as unknown as DatabaseSnapshot;
}

/* ------------------------------ 落地构建 ------------------------------ */

function planKey(plan: MergeRowPlan): string {
  return `${plan.table}:${plan.id}`;
}

/** 未裁决冲突时抛错 */
export class MergeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeBlockedError';
  }
}

/**
 * 依据预演报告构建合并后的最终整库数据，并完成全部落地重算：
 * - 被容量拒绝的记录及其子表（曲线事件 / 杯测）不入库；
 * - 冲突裁决「两份都留」时，对端副本生成新 id，其曲线事件/杯测跟随新 profileId；
 * - 落地后：分段 RoR 全量重算、杯测总分全量重算、生豆余量只按本次新增已完成记录扣一遍；
 * - 拼配均分不存字段，由合并后的杯测结果在页面 / slice 中实时派生。
 */
export function buildMergedSnapshot(report: MergeReport): MergedSnapshot {
  if (report.conflicts.length > 0) {
    throw new MergeBlockedError(`还有 ${report.conflicts.length} 条两边都改过的记录未裁决，请先选择保留方式`);
  }
  if (report.rejected.length > 0) {
    const reasons = Array.from(new Set(report.rejected.map((plan) => plan.rejectReason))).join('；');
    throw new MergeBlockedError(`容量不足，已拒绝入库：${reasons}`);
  }

  const plans = report.plans;

  // 烘焙记录双留副本的 id 映射：原 profileId → 副本新 profileId
  const profileDupId = new Map<string, string>();
  const profilePlans = plans.filter((plan) => plan.table === 'roastProfiles');
  profilePlans.forEach((plan) => {
    if (plan.decision === 'conflict' && plan.resolution === 'both') {
      profileDupId.set(plan.id, mergeCreateId('rp'));
    }
  });

  // 被拒绝记录（理论上前置校验已挡住，这里再兜底一次）→ 其子表一并剔除
  const rejectedProfileIds = new Set(report.rejected.map((plan) => plan.id));

  function collectTable<T>(table: MergeTableName): T[] {
    const rows: T[] = [];
    plans
      .filter((plan) => plan.table === table)
      .forEach((plan) => {
        // 本店独有 / 完全一致：本店行原样保留
        if (plan.decision === 'localOnly' || plan.decision === 'identical') {
          if (plan.local) rows.push(withRevision(plan.local, table) as T);
          return;
        }
        if (plan.decision === 'localWins' || (plan.decision === 'conflict' && plan.resolution === 'local')) {
          if (plan.local) rows.push(withRevision(plan.local, table) as T);
          return;
        }
        const adoptsIncoming =
          plan.decision === 'incomingOnly' ||
          plan.decision === 'incomingWins' ||
          (plan.decision === 'conflict' && plan.resolution === 'incoming');
        if (adoptsIncoming && plan.incoming) {
          rows.push(normalizeRow(plan.incoming, table) as T);
          return;
        }
        if (plan.decision === 'conflict' && plan.resolution === 'both' && plan.local && plan.incoming) {
          rows.push(withRevision(plan.local, table) as T);
          const duplicate = normalizeRow(plan.incoming, table) as T;
          if (table === 'roastProfiles') {
            (duplicate as unknown as AnyRow).id = profileDupId.get(plan.id);
          } else {
            (duplicate as unknown as AnyRow).id = mergeCreateId(table.slice(0, 2));
          }
          rows.push(duplicate);
        }
      });
    return rows;
  }

  let greenBeans = collectTable<GreenBean>('greenBeans');
  const roastProfiles = collectTable<RoastProfile>('roastProfiles').filter(
    (profile) => !rejectedProfileIds.has(profile.id),
  );
  const blends = collectTable<Blend>('blends');
  const machineTemplates = collectTable<MachineTemplate>('machineTemplates');

  // 被拒绝记录的子表剔除；双留烘焙记录时，对端侧子记录挂到副本新 profileId
  const remapChildren = <T extends { id: string; profileId: string }>(
    table: MergeTableName,
    idPrefix: string,
  ): T[] => {
    const rows: T[] = [];
    const pushLocal = (row: T): void => {
      if (rejectedProfileIds.has(row.profileId)) return;
      rows.push(row);
    };
    const pushIncoming = (row: T): void => {
      if (rejectedProfileIds.has(row.profileId)) return;
      const dupProfileId = profileDupId.get(row.profileId);
      rows.push(dupProfileId ? { ...row, id: mergeCreateId(idPrefix), profileId: dupProfileId } : row);
    };

    plans
      .filter((plan) => plan.table === table)
      .forEach((plan) => {
        const local = plan.local as T | null;
        const incoming = plan.incoming as T | null;
        switch (plan.decision) {
          case 'localOnly':
          case 'identical':
          case 'localWins':
            if (local) pushLocal(local);
            break;
          case 'incomingOnly':
          case 'incomingWins':
            if (incoming) pushIncoming(normalizeRow(incoming, table) as T);
            break;
          case 'conflict':
            if (plan.resolution === 'local' && local) pushLocal(local);
            if (plan.resolution === 'incoming' && incoming) pushIncoming(normalizeRow(incoming, table) as T);
            if (plan.resolution === 'both') {
              if (local) pushLocal(local);
              if (incoming) pushIncoming(normalizeRow(incoming, table) as T);
            }
            break;
          default:
            break;
        }
      });
    return rows;
  };

  let events = remapChildren<RoastEvent>('events', 'ev');
  let cuppings = remapChildren<Cupping>('cuppings', 'cp');

  // 落地重算 1：全部曲线节点分段 RoR
  events = recomputeEventsRor(events);
  // 落地重算 2：杯测总分（分项一更新，总分必随）
  cuppings = cuppings.map((cupping) => recomputeCuppingScore(cupping));

  // 落地重算 3：生豆余量只按本次新采纳的已完成烘焙统一扣一遍（本店历史已完成早已扣过）
  const deductions = new Map<string, number>();
  plans
    .filter((plan): plan is MergeRowPlan<RoastProfile> => plan.table === 'roastProfiles')
    .forEach((plan) => {
      if (!profileNeedsDeduct(plan) || plan.rejectReason || !plan.incoming) return;
      const beanId = plan.incoming.greenBeanId;
      let kg = plan.incoming.chargeG / 1000;
      if (plan.decision === 'conflict' && plan.resolution === 'both') kg = plan.incoming.chargeG / 1000;
      deductions.set(beanId, roundKg((deductions.get(beanId) ?? 0) + kg));
    });
  greenBeans = greenBeans.map((bean) => {
    const deduct = deductions.get(bean.id) ?? 0;
    if (deduct <= 0) return bean;
    return { ...bean, stockKg: roundKg(Math.max(0, bean.stockKg - deduct)) };
  });

  return { greenBeans, roastProfiles, events, cuppings, blends, machineTemplates };
}

/** 未裁决冲突数（页面用于禁用「落地合并」） */
export function unresolvedConflictCount(report: MergeReport): number {
  return report.conflicts.length;
}

/** 计划 key（页面裁决表单与草稿持久化共用） */
export function mergePlanKey(table: MergeTableName, id: string): string {
  return `${table}:${id}`;
}

export { planKey };
