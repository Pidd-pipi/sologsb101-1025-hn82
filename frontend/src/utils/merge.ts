/**
 * 离线档案逐条合并引擎（烘焙间 / 门店各存一份，回店合并成一份）。
 *
 * 规则：
 * 1. 同一条（按 id 对齐）先比修订号 rev，rev 大者胜；rev 相同再比 updatedAt。
 * 2. rev 相同且两边内容都动过（不一致）→ 两个候选都留下（主记录 + 冲突候选行），绝不用后到的盖掉。
 * 3. 只有一边有的记录直接补进来。
 * 4. 合并前先看生豆在库余量：对端新增的已完成烘焙容量不够时，整单拒绝入库并存为重试草稿，
 *    补货后可拿草稿继续重试。
 * 5. 旧数据没有修订号时，先按烘焙日期（等）回填 rev 再参与合并。
 * 6. 落地后重算：曲线事件分段 RoR、杯测加权总分、生豆余量（按已完成烘焙记录并集，不各扣一遍）。
 */
import type { GreenBean } from '../types/greenbean';
import type { MachineTemplate, RoastProfile } from '../types/roastprofile';
import type { RoastEvent } from '../types/event';
import type { Cupping } from '../types/cupping';
import type { Blend } from '../types/blend';
import type { MergeDraft, StockShortage, SyncTableName } from '../types/sync';
import { conflictCandidateId } from '../types/sync';
import {
  db,
  createId,
  getMergeDraft,
  isDatabaseSnapshot,
  listMergeDrafts,
  nowIso,
  putMergeDraft,
  removeMergeDraft,
  resolveConflict,
  type DatabaseSnapshot,
} from './db';
import { ensureRev } from './revision';
import {
  precheckStockCapacity,
  recomputeBeanStock,
  recomputeCuppingTotals,
  recomputeEventRors,
  type StockPrecheckShortage,
} from './derived';

/** 参与逐条合并的表（顺序：父表先于子表） */
export const MERGE_TABLES = [
  'greenBeans',
  'roastProfiles',
  'events',
  'cuppings',
  'blends',
  'machineTemplates',
] as const;

export type MergeTableKey = (typeof MERGE_TABLES)[number];

export interface TableMergeStat {
  /** 对端独有 / 本端独有而直接补入的条数 */
  added: number;
  /** 修订号或时间更新而覆盖的条数 */
  updated: number;
  /** 两边都动过、留下两个候选的冲突组数 */
  conflicts: number;
  /** 双方一致、未改动的条数 */
  unchanged: number;
}

export type MergeStats = Record<MergeTableKey, TableMergeStat>;

export interface MergeReport {
  ok: boolean;
  importedAt: string;
  stats: MergeStats;
  /** 本次合并后仍待裁决的冲突总数 */
  openConflicts: number;
  /** 容量不足明细（ok=false 时） */
  shortages: StockShortage[];
  message: string;
  /** 容量不足时生成 / 更新的重试草稿 id */
  draftId?: string;
}

/** 容量预检失败：整单先不落地，留待重试 */
export class CapacityShortError extends Error {
  shortages: StockPrecheckShortage[];
  constructor(shortages: StockPrecheckShortage[]) {
    super('生豆在库余量不足，已拒绝本次入库并存为重试草稿');
    this.name = 'CapacityShortError';
    this.shortages = shortages;
  }
}

const emptyTableStat = (): TableMergeStat => ({ added: 0, updated: 0, conflicts: 0, unchanged: 0 });

/** 去掉合并候选标记，转成「主记录」形态 */
function stripConflict<T extends { conflictOf?: string; conflictSide?: string }>(row: T): T {
  const next = { ...row };
  delete next.conflictOf;
  delete next.conflictSide;
  return next;
}

/** 比较两边业务内容是否一致（忽略修订元数据：updatedAt / rev / 冲突标记） */
function samePayload(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ignore = new Set(['rev', 'updatedAt', 'conflictOf', 'conflictSide']);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (ignore.has(key)) continue;
    const valueA = a[key];
    const valueB = b[key];
    if (JSON.stringify(valueA) !== JSON.stringify(valueB)) return false;
  }
  return true;
}

/**
 * 单表逐条合并。
 * 候选行（带确定性前缀 id）按自身 id 对齐：新候选在本端不存在 → 作为候选补入；
 * 同 id 已存在（重复合并）→ 按 rev/时间/冲突规则继续合并，不会被普通更新悄悄盖掉。
 */
function mergeTable<T extends { id: string; rev: number; updatedAt: string; conflictOf?: string }>(
  table: SyncTableName,
  localRaw: T[],
  incomingRaw: T[],
): { rows: T[]; stat: TableMergeStat } {
  const local = localRaw.map((row) => ensureRev(table, row as unknown as Record<string, unknown>) as unknown as T);
  // 对端导出的冲突候选行不参与按 id 合并：冲突一律以两边主记录比较结果重新产生，
  // 否则对端候选（带前缀 id）会被当成「对端独有」补进本端，造成重复副本。
  const incoming = incomingRaw
    .filter((row) => !row.conflictOf)
    .map((row) => ensureRev(table, row as unknown as Record<string, unknown>) as unknown as T);
  const stat = emptyTableStat();

  const byId = new Map<string, { local?: T; incoming?: T }>();
  local.forEach((row) => byId.set(row.id, { ...byId.get(row.id), local: row }));
  incoming.forEach((row) => byId.set(row.id, { ...byId.get(row.id), incoming: row }));

  const output: T[] = [];
  byId.forEach((pair) => {
    const { local: left, incoming: right } = pair;

    // 本端尚未裁决的冲突候选：对端候选已在上方过滤，候选只保留本端版本，等待人工裁决
    if (left?.conflictOf) {
      output.push(left);
      return;
    }

    if (left && !right) {
      output.push(left); // 本端独有
      return;
    }
    if (!left && right) {
      output.push(stripConflict(right));
      stat.added += 1; // 对端独有，直接补入
      return;
    }
    if (!left || !right) return;

    if (samePayload(left as Record<string, unknown>, right as Record<string, unknown>)) {
      // 内容一致：保留 rev/updatedAt 较新的元数据
      const winner = right.rev > left.rev || (right.rev === left.rev && right.updatedAt > left.updatedAt) ? right : left;
      output.push(stripConflict(winner));
      stat.unchanged += 1;
      return;
    }

    if (right.rev > left.rev) {
      output.push(stripConflict(right));
      stat.updated += 1;
      return;
    }
    if (left.rev > right.rev) {
      // 本端更新，对端是旧版：不改动，不被后到的盖掉
      output.push(left);
      stat.unchanged += 1;
      return;
    }

    // rev 相同：先比时间
    if (right.updatedAt > left.updatedAt) {
      output.push(stripConflict(right));
      stat.updated += 1;
      return;
    }
    if (left.updatedAt > right.updatedAt) {
      output.push(left);
      stat.unchanged += 1;
      return;
    }

    // rev 相同且时间相同、内容却不一致：两边都动过，留两个候选，主记录保留本端
    const baseId = left.id;
    const localCandidate: T = stripConflict(left);
    const incomingCandidate: T = {
      ...stripConflict(right),
      id: conflictCandidateId(table, baseId, 'incoming'),
      conflictOf: baseId,
      conflictSide: 'incoming' as const,
    };
    output.push(localCandidate, incomingCandidate);
    stat.conflicts += 1;
  });

  return { rows: output, stat };
}

interface NormalizedSnapshot {
  greenBeans: GreenBean[];
  roastProfiles: RoastProfile[];
  events: RoastEvent[];
  cuppings: Cupping[];
  blends: Blend[];
  machineTemplates: MachineTemplate[];
}

function normalizeSnapshot(snapshot: DatabaseSnapshot): NormalizedSnapshot {
  const profileDateMap = new Map<string, string>();
  (snapshot.roastProfiles ?? []).forEach((profile) => {
    if (profile && typeof profile.id === 'string') profileDateMap.set(profile.id, profile.roastedAt);
  });
  return {
    greenBeans: (snapshot.greenBeans ?? []).map(
      (row) => ensureRev('greenBeans', row as unknown as Record<string, unknown>) as unknown as GreenBean,
    ),
    roastProfiles: (snapshot.roastProfiles ?? []).map(
      (row) => ensureRev('roastProfiles', row as unknown as Record<string, unknown>) as unknown as RoastProfile,
    ),
    events: (snapshot.events ?? []).map(
      (row) =>
        ensureRev('events', row as unknown as Record<string, unknown>, profileDateMap) as unknown as RoastEvent,
    ),
    cuppings: (snapshot.cuppings ?? []).map(
      (row) => ensureRev('cuppings', row as unknown as Record<string, unknown>) as unknown as Cupping,
    ),
    blends: (snapshot.blends ?? []).map(
      (row) => ensureRev('blends', row as unknown as Record<string, unknown>) as unknown as Blend,
    ),
    machineTemplates: (snapshot.machineTemplates ?? []).map(
      (row) =>
        ensureRev('machineTemplates', row as unknown as Record<string, unknown>) as unknown as MachineTemplate,
    ),
  };
}

async function readLocal(): Promise<NormalizedSnapshot> {
  // 读全量（含本端尚未裁决的冲突候选）参与合并；业务列表的过滤在 list* 层做
  const [greenBeans, roastProfiles, events, cuppings, blends, machineTemplates] = await Promise.all([
    db.greenBeans.toArray(),
    db.roastProfiles.toArray(),
    db.events.toArray(),
    db.cuppings.toArray(),
    db.blends.toArray(),
    db.machineTemplates.toArray(),
  ]);
  return normalizeSnapshot({
    name: db.name,
    schemaVersion: 0,
    exportedAt: '',
    greenBeans,
    roastProfiles,
    events,
    cuppings,
    blends,
    machineTemplates,
  });
}

function toShortages(rows: StockPrecheckShortage[]): StockShortage[] {
  return rows.map((row) => ({ ...row }));
}

/**
 * 纯计算：把对端档案合并进本端快照（不写库）。
 * 同时返回容量预检结果；调用方决定是落地还是存草稿。
 */
export function buildMergedSnapshot(
  local: NormalizedSnapshot,
  incoming: NormalizedSnapshot,
): {
  merged: NormalizedSnapshot;
  stats: MergeStats;
  localProfileIds: Set<string>;
  shortages: StockPrecheckShortage[];
} {
  const localProfileIds = new Set(local.roastProfiles.filter((row) => !row.conflictOf).map((row) => row.id));

  const beansMerge = mergeTable('greenBeans', local.greenBeans, incoming.greenBeans);
  const profilesMerge = mergeTable('roastProfiles', local.roastProfiles, incoming.roastProfiles);
  const eventsMerge = mergeTable('events', local.events, incoming.events);
  const cuppingsMerge = mergeTable('cuppings', local.cuppings, incoming.cuppings);
  const blendsMerge = mergeTable('blends', local.blends, incoming.blends);
  const templatesMerge = mergeTable('machineTemplates', local.machineTemplates, incoming.machineTemplates);

  const merged: NormalizedSnapshot = {
    greenBeans: beansMerge.rows,
    roastProfiles: profilesMerge.rows,
    events: recomputeEventRors(eventsMerge.rows),
    cuppings: recomputeCuppingTotals(cuppingsMerge.rows),
    blends: blendsMerge.rows,
    machineTemplates: templatesMerge.rows,
  };

  // 合并前先看本端在库余量：对端新增的已完成烘焙，本端豆够不够
  const shortages = precheckStockCapacity(local.greenBeans, incoming.roastProfiles, localProfileIds);

  return {
    merged,
    stats: {
      greenBeans: beansMerge.stat,
      roastProfiles: profilesMerge.stat,
      events: eventsMerge.stat,
      cuppings: cuppingsMerge.stat,
      blends: blendsMerge.stat,
      machineTemplates: templatesMerge.stat,
    },
    localProfileIds,
    shortages,
  };
}

function countOpenConflicts(merged: NormalizedSnapshot): number {
  return [
    ...merged.greenBeans,
    ...merged.roastProfiles,
    ...merged.events,
    ...merged.cuppings,
    ...merged.blends,
    ...merged.machineTemplates,
  ].filter((row) => Boolean(row.conflictOf)).length;
}

async function persistMerged(merged: NormalizedSnapshot): Promise<void> {
  // 用「完整合并结果集」覆盖业务表：同 id 更新/并存候选，本地多余行清除，
  // 保证「逐条合并」得到一份确定的全库结果（mergeDrafts 草稿表不动）。
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

async function upsertRetryDraft(
  snapshot: DatabaseSnapshot,
  shortages: StockPrecheckShortage[],
  existingDraftId?: string,
): Promise<string> {
  const stamp = nowIso();
  const message = shortageMessage(shortages);
  if (existingDraftId) {
    const existing = await getMergeDraft(existingDraftId);
    if (existing) {
      const updated: MergeDraft = {
        ...existing,
        lastTriedAt: stamp,
        lastError: message,
        attempts: existing.attempts + 1,
        shortages: toShortages(shortages),
        snapshot,
      };
      await putMergeDraft(updated);
      return existing.id;
    }
  }
  const draft: MergeDraft = {
    id: createId('md'),
    label: `入库重试 ${stamp.slice(0, 10)} ${new Date(stamp).toTimeString().slice(0, 5)}`,
    sourceName: snapshot.name,
    createdAt: stamp,
    lastTriedAt: stamp,
    lastError: message,
    attempts: 1,
    shortages: toShortages(shortages),
    snapshot,
  };
  await putMergeDraft(draft);
  return draft.id;
}

function shortageMessage(shortages: StockPrecheckShortage[]): string {
  return shortages
    .map((item) => `${item.origin}${item.farm ? ` · ${item.farm}` : ''} 需 ${item.requiredKg}kg，在库仅 ${item.availableKg}kg，缺 ${item.shortKg}kg`)
    .join('；');
}

function validateSnapshot(snapshot: unknown): DatabaseSnapshot {
  if (!isDatabaseSnapshot(snapshot)) {
    throw new Error('档案结构不合法：缺少 greenBeans / roastProfiles / events / cuppings / blends 数组字段');
  }
  const candidate = snapshot as DatabaseSnapshot;
  if (candidate.name !== 'gbroastlog') {
    throw new Error(`档案来源不匹配：期望 gbroastlog 档案，实际为「${candidate.name}」`);
  }
  return candidate;
}

function reportSummary(stats: MergeStats): string {
  return MERGE_TABLES.map((key) => {
    const stat = stats[key];
    const parts = [`补入 ${stat.added}`, `更新 ${stat.updated}`, `冲突 ${stat.conflicts}`];
    return `${TABLE_LABEL[key]} ${parts.join(' / ')}`;
  }).join('；');
}

export const TABLE_LABEL: Record<MergeTableKey, string> = {
  greenBeans: '生豆',
  roastProfiles: '烘焙记录',
  events: '曲线节点',
  cuppings: '杯测',
  blends: '拼配',
  machineTemplates: '载量模板',
};

/**
 * 整库档案逐条合并入库：
 * - 容量不足时整单拒绝、落地为重试草稿（不写业务表），返回 ok:false；
 * - 成功时落地合并结果（事件 RoR、杯测总分、生豆余量已重算）。
 */
export async function mergeArchive(snapshotInput: unknown, draftId?: string): Promise<MergeReport> {
  const snapshot = validateSnapshot(snapshotInput);
  const local = await readLocal();
  const incoming = normalizeSnapshot(snapshot);
  const { merged, stats, localProfileIds, shortages } = buildMergedSnapshot(local, incoming);

  if (shortages.length > 0) {
    const id = await upsertRetryDraft(snapshot, shortages, draftId);
    return {
      ok: false,
      importedAt: nowIso(),
      stats,
      openConflicts: 0,
      shortages: toShortages(shortages),
      message: `生豆在库余量不足，已拒绝本次入库并存为重试草稿：${shortageMessage(shortages)}`,
      draftId: id,
    };
  }

  // 容量足够：按已完成烘焙记录并集统一再算一次余量，避免两边各扣一遍。
  // 本端已有豆的「新增对端已完成」在预检中已确认够扣，这里不会扣成负数。
  const { beans, negativeStockBeanIds } = recomputeBeanStock({
    mergedBeans: merged.greenBeans,
    localBeans: local.greenBeans,
    incomingBeans: incoming.greenBeans,
    mergedProfiles: merged.roastProfiles,
    localProfileIds,
  });
  merged.greenBeans = beans;

  // 防御性兜底：预检通过仍算出负余量（如候选数据导致的统计偏差），同样拒绝并留草稿
  if (negativeStockBeanIds.length > 0) {
    const fallbackShortages: StockPrecheckShortage[] = negativeStockBeanIds.map((beanId) => {
      const bean = local.greenBeans.find((item) => item.id === beanId);
      return {
        greenBeanId: beanId,
        origin: bean?.origin ?? beanId,
        farm: bean?.farm ?? '',
        requiredKg: 0,
        availableKg: bean?.stockKg ?? 0,
        shortKg: 0,
      };
    });
    const id = await upsertRetryDraft(snapshot, fallbackShortages, draftId);
    return {
      ok: false,
      importedAt: nowIso(),
      stats,
      openConflicts: 0,
      shortages: toShortages(fallbackShortages),
      message: '生豆余量重算后出现负数，已拒绝本次入库并存为重试草稿，请核对在库余量后重试',
      draftId: id,
    };
  }

  await persistMerged(merged);

  // 成功落地后清掉对应草稿
  if (draftId) await removeMergeDraft(draftId).catch(() => undefined);

  return {
    ok: true,
    importedAt: nowIso(),
    stats,
    openConflicts: countOpenConflicts(merged),
    shortages: [],
    message: `合并完成：${reportSummary(stats)}`,
  };
}

/** 拿重试草稿再试一次（补货后） */
export async function retryMergeDraft(draft: MergeDraft): Promise<MergeReport> {
  return mergeArchive(draft.snapshot, draft.id);
}

/** 仅做预检不落库：供界面试算提示 */
export async function previewArchiveMerge(snapshotInput: unknown): Promise<{
  stats: MergeStats;
  shortages: StockPrecheckShortage[];
  openConflicts: number;
}> {
  const snapshot = validateSnapshot(snapshotInput);
  const local = await readLocal();
  const incoming = normalizeSnapshot(snapshot);
  const { merged, stats, shortages } = buildMergedSnapshot(local, incoming);
  return { stats, shortages, openConflicts: countOpenConflicts(merged) };
}

/* ------------------------------ 冲突候选与草稿查询 ------------------------------ */

export interface ConflictGroup {
  table: MergeTableKey;
  /** 主记录 id */
  baseId: string;
  /** 主记录（本端版本） */
  base: Record<string, unknown>;
  /** 对端候选 */
  candidate?: Record<string, unknown>;
}

/** 列出各表待裁决的冲突组（主记录 + 对端候选） */
export async function listConflictGroups(): Promise<ConflictGroup[]> {
  const groups: ConflictGroup[] = [];
  for (const table of MERGE_TABLES) {
    const rows = (await db.table(table).toArray()) as Array<Record<string, unknown>>;
    const candidateByBase = new Map<string, Record<string, unknown>>();
    rows.forEach((row) => {
      if (typeof row.conflictOf === 'string' && row.conflictOf) {
        candidateByBase.set(row.conflictOf, row);
      }
    });
    candidateByBase.forEach((candidate, baseId) => {
      const base = rows.find((row) => String(row.id) === baseId);
      if (base) {
        groups.push({ table, baseId, base, candidate });
      }
    });
  }
  return groups;
}

/** 冲突总数（徽标用） */
export async function countOpenConflictsNow(): Promise<number> {
  const groups = await listConflictGroups();
  return groups.length;
}

/** 保留本端主记录版本：删除对端候选，主记录推进一次修订 */
export async function keepLocalConflict(group: ConflictGroup): Promise<void> {
  await resolveConflict(group.table, group.base);
}

/** 采用对端候选：以候选内容覆盖主记录并删除候选行 */
export async function keepIncomingConflict(group: ConflictGroup): Promise<void> {
  if (!group.candidate) throw new Error('该冲突没有对端候选');
  await resolveConflict(group.table, group.candidate);
}

/** 删除一份入库重试草稿（放弃重试） */
export async function discardMergeDraft(id: string): Promise<void> {
  await removeMergeDraft(id);
}

export { listMergeDrafts };
