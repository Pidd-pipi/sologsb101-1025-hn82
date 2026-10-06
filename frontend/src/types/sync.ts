/**
 * 离线档案同步类型：修订号（rev）、冲突候选标记与入库重试草稿。
 * 烘焙间与门店各存一份档案，离线各自修改后通过整库档案 JSON 逐条合并：
 * 同一条先比修订号、再比时间；修订号相同且两边都改过则同时保留两个候选。
 */

/** 冲突候选标记：只有合并产生的「另一份候选」才带这些字段 */
export interface ConflictMeta {
  /** 候选标识：'conflict:' + 归属表 + ':' + 原记录 id */
  conflictOf: string;
  /** 候选来源：incoming=对端档案带来的候选；local=本端保留的候选 */
  conflictSide: 'incoming' | 'local';
}

/** 可参与合并的实体都带修订号；冲突候选额外带 ConflictMeta */
export type SyncRow<T> = T & {
  /** 修订号：按业务日期回填为 YYYYMMDD 整数，每次编辑 +1（不小于当天） */
  rev: number;
  conflictOf?: string;
  conflictSide?: 'incoming' | 'local';
};

/** 下豆容量预检里单条生豆的缺口情况 */
export interface StockShortage {
  greenBeanId: string;
  origin: string;
  farm: string;
  /** 合并后预计需要的生豆（kg） */
  requiredKg: number;
  /** 合并后可用余量（kg） */
  availableKg: number;
  /** 缺口（kg，>0） */
  shortKg: number;
}

/** 入库重试草稿：容量不足被拒绝后留档，补货后可直接拿草稿再试 */
export interface MergeDraft {
  id: string;
  label: string;
  /** 对端档案名（一般为 gbroastlog） */
  sourceName: string;
  createdAt: string;
  /** 最近一次重试时间 */
  lastTriedAt: string;
  /** 最近一次重试失败原因（容量不足时的提示） */
  lastError: string;
  attempts: number;
  shortages: StockShortage[];
  snapshot: unknown;
}

/** 冲突归属表标识（用于 conflictOf 前缀） */
export type SyncTableName = 'greenBeans' | 'roastProfiles' | 'events' | 'cuppings' | 'blends' | 'machineTemplates';

/** 冲突候选 id：deterministic，重复合并幂等 */
export function conflictCandidateId(table: SyncTableName, baseId: string, side: 'incoming' | 'local'): string {
  return `conflict:${table}:${side}:${baseId}`;
}

/** 取候选归属的原记录 id 与表名 */
export function parseConflictOf(conflictOf: string): { table: string; baseId: string } | null {
  const match = /^conflict:(greenBeans|roastProfiles|events|cuppings|blends|machineTemplates):(.+)$/.exec(conflictOf);
  if (!match) return null;
  return { table: match[1], baseId: match[2] };
}

export function isConflictRow(row: { conflictOf?: string }): boolean {
  return typeof row.conflictOf === 'string' && row.conflictOf !== '';
}
