/**
 * 修订号（rev）工具：
 * - 旧数据没有修订号时，按烘焙日期回填后再参与合并；没有日期的按「到货 / 创建 / 时间戳」兜底。
 * - 每次本地编辑修订号 +1（且不小于业务日期 YYYYMMDD，保证日期越晚的批次天然不更旧）。
 */
import type { GreenBean } from '../types/greenbean';
import type { RoastProfile } from '../types/roastprofile';
import type { RoastEvent } from '../types/event';
import type { Cupping } from '../types/cupping';
import type { Blend } from '../types/blend';
import type { MachineTemplate } from '../types/roastprofile';
import type { SyncTableName } from '../types/sync';

export type AnySyncRow = GreenBean | RoastProfile | RoastEvent | Cupping | Blend | MachineTemplate;

/** YYYY-MM-DD（或可被 Date 解析的时间串）→ 8 位日期整数；无法解析返回 0 */
export function dateRevOf(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) {
    return Number(`${match[1]}${match[2]}${match[3]}`);
  }
  const time = Date.parse(value);
  if (Number.isFinite(time)) {
    const date = new Date(time);
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  }
  return 0;
}

/** 各表回填修订号使用的业务日期字段（优先级从高到低） */
const DATE_FIELDS: Record<SyncTableName, string[]> = {
  greenBeans: ['arrivedAt'],
  roastProfiles: ['roastedAt'],
  events: ['atSec'],
  cuppings: ['cuppedAt'],
  blends: ['createdAt'],
  machineTemplates: ['createdAt'],
};

/** 事件表的 atSec 是「入豆后的秒数」，本身不是日期，需要借助所属烘焙记录的 roastedAt */
export function fallbackRevForTable(table: SyncTableName, row: Record<string, unknown>, profileDateMap?: Map<string, string>): number {
  if (table === 'events') {
    const profileId = typeof row.profileId === 'string' ? row.profileId : '';
    const roastedAt = profileDateMap?.get(profileId);
    const fromProfile = dateRevOf(roastedAt);
    if (fromProfile > 0) return fromProfile;
  }
  for (const field of DATE_FIELDS[table]) {
    const rev = dateRevOf(row[field]);
    if (rev > 0) return rev;
  }
  for (const field of ['updatedAt', 'createdAt']) {
    const rev = dateRevOf(row[field]);
    if (rev > 0) return rev;
  }
  return 0;
}

/** 读取行上的修订号（兼容旧数据） */
export function readRev(row: Record<string, unknown>): number {
  const rev = Number(row.rev);
  return Number.isInteger(rev) && rev > 0 ? rev : 0;
}

/**
 * 旧数据按业务日期回填修订号。
 * @param profileDateMap 事件表用：profileId → roastedAt
 */
export function ensureRev<T>(
  table: SyncTableName,
  row: T,
  profileDateMap?: Map<string, string>,
): T & { rev: number } {
  const record = row as unknown as Record<string, unknown>;
  const existing = readRev(record);
  if (existing > 0) return { ...row, rev: existing };
  return { ...row, rev: fallbackRevForTable(table, record, profileDateMap) };
}

/** 编辑后推进修订号：至少 +1，且不小于业务日期（晚烘焙的记录不会被早烘焙的盖掉） */
export function nextRevForTable(table: SyncTableName, row: Record<string, unknown>, currentRev = 0): number {
  const dateBase = fallbackRevForTable(table, row);
  return Math.max(currentRev + 1, dateBase, 1);
}
