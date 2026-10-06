/**
 * 待合并档案的页面间传递：在 /blends 选好整库档案 JSON 后，
 * 经 sessionStorage 带到 /merge 合并中心做预演（不落 IndexedDB，避免半截数据）。
 * 数据只在当前标签页会话内有效，合并页读取一次后即清除。
 */
import type { DatabaseSnapshot } from './db';

const STORAGE_KEY = 'gbroastlog.pendingIncomingArchive';

/** 暂存一份待合并的对端档案，供下一页面读取 */
export function savePendingIncoming(snapshot: DatabaseSnapshot): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

/** 读取并清除暂存的待合并档案（没有则返回 null） */
export function takePendingIncoming(): DatabaseSnapshot | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(STORAGE_KEY);
  try {
    return JSON.parse(raw) as DatabaseSnapshot;
  } catch {
    return null;
  }
}
