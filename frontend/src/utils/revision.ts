/**
 * 修订号（revision）工具：离线双份档案逐条合并的排序依据。
 * - 取值规则：以业务日期（YYYY-MM-DD，按本地时区）相对 2000-01-01 的天数为底，
 *   同一天内每改一次 +1。这样旧数据没有修订号时可按烘焙日期/业务日期直接回填，
 *   新编辑在同一天单调递增，跨天会自动跳到更大的量级，仍保持单调。
 * - 合并时先比修订号（大者新），同修订号再比 updatedAt（晚者新），
 *   同修订号且业务内容不一致视为「两边都动过」，保留两个候选交人工裁决。
 */

/** 修订号纪元：2000-01-01（UTC，与日期字符串解析对齐） */
export const REVISION_EPOCH_MS = Date.UTC(2000, 0, 1);

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 把 YYYY-MM-DD 解析成 UTC 时间戳（非法日期回退到当前时间） */
function dateToMs(dateText: string): number {
  if (typeof dateText === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateText)) {
    const ms = Date.parse(`${dateText.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

/** 按业务日期生成基础修订号（日期相对纪元的天数） */
export function revisionFromDate(dateText: string): number {
  return Math.max(0, Math.round((dateToMs(dateText) - REVISION_EPOCH_MS) / DAY_MS));
}

/** 当前日期对应的基础修订号 */
export function revisionToday(): number {
  return revisionFromDate(new Date().toISOString().slice(0, 10));
}

/**
 * 在既有修订号上递增：
 * - 新记录（prevRevision <= 0）：以业务日期为底；
 * - 既有记录：取「业务日期底值 + 1」与「prevRevision + 1」的较大者，
 *   保证同一天可多次自增、跨天也不会倒退。
 */
export function nextRevision(prevRevision: number | undefined, businessDate?: string): number {
  const base = revisionFromDate(businessDate ?? new Date().toISOString().slice(0, 10));
  const prev = Number.isFinite(prevRevision) && (prevRevision as number) > 0 ? (prevRevision as number) : 0;
  return Math.max(prev + 1, base + 1);
}
