/**
 * 合并 slice：维护离线档案合并的待重试草稿列表（容量不足被拒绝的整单入库）。
 * 预演/裁决结果只在 /merge 页面内使用（React state），草稿跨会话持久化在 mergeDrafts 表。
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import type { DatabaseSnapshot } from '../utils/db';
import {
  createId,
  getMergeDraft,
  listMergeDrafts,
  nowIso,
  putMergeDraft,
  removeMergeDraft,
} from '../utils/db';
import type { MergeDraft, MergeResolution } from '../utils/merge';

interface MergeStateShape {
  drafts: MergeDraft[];
  loading: boolean;
  error: string;
}

const initialState: MergeStateShape = {
  drafts: [],
  loading: false,
  error: '',
};

export const fetchMergeDrafts = createAsyncThunk('merge/fetchDrafts', async () => listMergeDrafts());

export interface SaveMergeDraftInput {
  /** 已存在则更新（重试失败接着同一草稿），否则新建 */
  id?: string;
  snapshot: DatabaseSnapshot;
  resolutions: Record<string, MergeResolution>;
  lastError: string;
}

/** 容量不足时把整单对端档案落为可重试草稿（已存在则沿用 attempts 并更新时间/原因） */
export const saveMergeDraft = createAsyncThunk('merge/saveDraft', async (input: SaveMergeDraftInput) => {
  const stamp = nowIso();
  const previous = input.id ? await getMergeDraft(input.id) : undefined;
  const draft: MergeDraft = {
    id: input.id ?? previous?.id ?? createId('md'),
    createdAt: previous?.createdAt ?? stamp,
    updatedAt: stamp,
    snapshot: input.snapshot,
    resolutions: input.resolutions,
    lastError: input.lastError,
    attempts: (previous?.attempts ?? 0) + 1,
  };
  await putMergeDraft(draft);
  return listMergeDrafts();
});

export const deleteMergeDraft = createAsyncThunk('merge/deleteDraft', async (id: string) => {
  await removeMergeDraft(id);
  return listMergeDrafts();
});

const mergeSlice = createSlice({
  name: 'merge',
  initialState,
  reducers: {
    clearMergeError(state) {
      state.error = '';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchMergeDrafts.pending, (state) => {
        state.loading = true;
        state.error = '';
      })
      .addCase(fetchMergeDrafts.fulfilled, (state, action) => {
        state.loading = false;
        state.drafts = action.payload;
      })
      .addCase(fetchMergeDrafts.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '合并草稿读取失败';
      })
      .addCase(saveMergeDraft.fulfilled, (state, action) => {
        state.loading = false;
        state.drafts = action.payload;
      })
      .addCase(saveMergeDraft.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message ?? '合并草稿保存失败';
      })
      .addCase(deleteMergeDraft.fulfilled, (state, action) => {
        state.drafts = action.payload;
      })
      .addCase(deleteMergeDraft.rejected, (state, action) => {
        state.error = action.error.message ?? '合并草稿删除失败';
      });
  },
});

export const { clearMergeError } = mergeSlice.actions;

export default mergeSlice.reducer;
