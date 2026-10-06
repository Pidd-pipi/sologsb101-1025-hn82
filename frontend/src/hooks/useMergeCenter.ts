/**
 * useMergeCenter：订阅入库重试草稿与待裁决冲突候选。
 * 合并中心（/blends 顶部卡片）消费；重试成功或裁决后各列表通过重新拉取刷新。
 */
import { useCallback, useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../utils/db';
import {
  countOpenConflictsNow,
  discardMergeDraft,
  keepIncomingConflict,
  keepLocalConflict,
  listConflictGroups,
  listMergeDrafts,
  retryMergeDraft,
  type ConflictGroup,
  type MergeReport,
} from '../utils/merge';
import type { MergeDraft } from '../types/sync';

export interface UseMergeCenterResult {
  drafts: MergeDraft[];
  conflicts: ConflictGroup[];
  loading: boolean;
  error: string;
  retry: (draft: MergeDraft) => Promise<MergeReport>;
  discard: (id: string) => Promise<void>;
  chooseLocal: (group: ConflictGroup) => Promise<void>;
  chooseIncoming: (group: ConflictGroup) => Promise<void>;
}

export function useMergeCenter(): UseMergeCenterResult {
  const [drafts, setDrafts] = useState<MergeDraft[]>([]);
  const [conflicts, setConflicts] = useState<ConflictGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [draftRows, groups] = await Promise.all([listMergeDrafts(), listConflictGroups()]);
      setDrafts(draftRows);
      setConflicts(groups);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '合并中心读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshIfLive = (): void => {
      if (!cancelled) void refresh();
    };
    // 业务表（候选裁决）与草稿表（重试/放弃）都可能改变中心内容，全部订阅
    const subscriptions = [db.mergeDrafts, db.greenBeans, db.roastProfiles, db.events, db.cuppings, db.blends].map(
      (table) =>
        liveQuery(() => table.toCollection().primaryKeys()).subscribe({
          next: refreshIfLive,
          error: () => undefined,
        }),
    );
    void refresh();
    return () => {
      cancelled = true;
      subscriptions.forEach((subscription) => subscription.unsubscribe());
    };
  }, [refresh]);

  const retry = useCallback(
    async (draft: MergeDraft) => {
      const report = await retryMergeDraft(draft);
      await refresh();
      return report;
    },
    [refresh],
  );

  const discard = useCallback(
    async (id: string) => {
      await discardMergeDraft(id);
      await refresh();
    },
    [refresh],
  );

  const chooseLocal = useCallback(
    async (group: ConflictGroup) => {
      await keepLocalConflict(group);
      await refresh();
    },
    [refresh],
  );

  const chooseIncoming = useCallback(
    async (group: ConflictGroup) => {
      await keepIncomingConflict(group);
      await refresh();
    },
    [refresh],
  );

  return { drafts, conflicts, loading, error, retry, discard, chooseLocal, chooseIncoming };
}

/** 简单暴露一个刷新计数：外部写入后可手动触发中心重算 */
export async function refreshConflictCount(): Promise<number> {
  return countOpenConflictsNow();
}

export default useMergeCenter;
