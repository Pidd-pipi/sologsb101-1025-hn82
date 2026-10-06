/**
 * /merge 档案合并中心（烘焙间 ↔ 门店离线各改，回店合并成一份）
 * 流程：选择对端档案 → 逐条预演（先比修订号再比时间）→ 两边都改过的人工裁决（留本店/留对端/双候选）
 *       → 容量闸门（生豆余量不够整单拒绝，落可重试草稿）→ 落地（RoR/总分/余量统一重算）。
 * 被容量拒绝的草稿补货后可在本页直接「接着草稿重试」，裁决选择会沿用。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Radio,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  FileSearchOutlined,
  MergeCellsOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useAppDispatch, useAppSelector } from '../stores/store';
import { fetchGreenBeans } from '../stores/beanSlice';
import { fetchMachineTemplates, fetchRoastProfiles } from '../stores/roastSlice';
import { fetchCuppings } from '../stores/cuppingSlice';
import { fetchBlends } from '../stores/blendSlice';
import {
  deleteMergeDraft,
  fetchMergeDrafts,
  saveMergeDraft,
} from '../stores/mergeSlice';
import {
  commitMergedSnapshot,
  exportSnapshot,
  type DatabaseSnapshot,
} from '../utils/db';
import {
  ensureSnapshotRevisions,
  planMerge,
  type MergeDecision,
  type MergeDraft,
  type MergeReport,
  type MergeResolution,
  type MergeRowPlan,
  type MergeSide,
  type MergeStockCheck,
  type MergeTableName,
  mergePlanKey,
} from '../utils/merge';
import { describeError, parseArchiveJson, readFileAsText } from '../utils/export';
import { takePendingIncoming } from '../utils/mergeDraftTransfer';
import { BEAN_PROCESS_LABEL } from '../types/greenbean';
import { ROAST_STATE_LABEL } from '../types/roastprofile';
import { EVENT_TYPE_LABEL } from '../types/event';
import { BLEND_STATE_LABEL } from '../types/blend';

const TABLE_LABEL: Record<MergeTableName, string> = {
  greenBeans: '生豆',
  roastProfiles: '烘焙记录',
  events: '曲线节点',
  cuppings: '杯测',
  blends: '拼配方案',
  machineTemplates: '载量模板',
};

const DECISION_META: Record<MergeDecision, { label: string; color: string }> = {
  identical: { label: '两边一致', color: '#8c8c8c' },
  localOnly: { label: '仅本店', color: '#3b7ea1' },
  incomingOnly: { label: '对端补入', color: '#2f6f4f' },
  localWins: { label: '本店较新', color: '#7a5230' },
  incomingWins: { label: '对端较新', color: '#7a4b8f' },
  conflict: { label: '两边都改过', color: '#b3372f' },
};

interface IncomingSource {
  snapshot: DatabaseSnapshot;
  /** 来自重试草稿时带上草稿 id */
  draftId?: string;
  label: string;
}

/** 取一行可展示的标题（各表挑代表性字段） */
function describeRow(plan: MergeRowPlan, side: MergeSide): string {
  const row = (side === 'local' ? plan.local : plan.incoming) as Record<string, unknown> | null;
  if (!row) return '—';
  switch (plan.table) {
    case 'greenBeans':
      return `${String(row.origin ?? '')} · ${BEAN_PROCESS_LABEL[row.process as keyof typeof BEAN_PROCESS_LABEL] ?? ''} · 余量 ${String(row.stockKg ?? '?')}kg`;
    case 'roastProfiles':
      return `${String(row.roastedAt ?? '')} · ${String(row.machineModel ?? '')} · 载量 ${String(row.chargeG ?? '?')}g · ${ROAST_STATE_LABEL[row.state as keyof typeof ROAST_STATE_LABEL] ?? ''}`;
    case 'events':
      return `${EVENT_TYPE_LABEL[row.type as keyof typeof EVENT_TYPE_LABEL] ?? ''} · ${String(row.atSec ?? '?')}s · ${String(row.beanTempC ?? '?')}℃`;
    case 'cuppings':
      return `${String(row.cuppedAt ?? '')} · 总分 ${String(row.totalScore ?? '?')}`;
    case 'blends':
      return `${String(row.name ?? '')} · ${BLEND_STATE_LABEL[row.state as keyof typeof BLEND_STATE_LABEL] ?? ''}`;
    case 'machineTemplates':
      return `${String(row.model ?? '')} · 载量 ${String(row.chargeG ?? '?')}g`;
    default:
      return String(row.id);
  }
}

export default function MergeCenter() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const drafts = useAppSelector((state) => state.merge.drafts);
  const draftLoading = useAppSelector((state) => state.merge.loading);

  const [localSnapshot, setLocalSnapshot] = useState<DatabaseSnapshot | null>(null);
  const [incoming, setIncoming] = useState<IncomingSource | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, MergeResolution>>({});
  const [committing, setCommitting] = useState(false);
  const [doneReport, setDoneReport] = useState<{ added: number; updated: number; conflicts: number } | null>(null);

  const refreshLocal = async (): Promise<void> => {
    setLocalSnapshot(await exportSnapshot());
  };

  useEffect(() => {
    void (async () => {
      await refreshLocal();
      void dispatch(fetchMergeDrafts());
      const pending = takePendingIncoming();
      if (pending) loadIncoming(pending, '从拼配页带入的档案');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  const loadIncoming = (snapshot: DatabaseSnapshot, label: string, draftId?: string): void => {
    setIncoming({ snapshot: ensureSnapshotRevisions(snapshot), draftId, label });
    setResolutions({});
    setDoneReport(null);
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const snapshot = parseArchiveJson(text);
      await refreshLocal();
      loadIncoming(snapshot, file.name);
    } catch (error) {
      message.error(describeError(error));
    }
  };

  /** 预演结果（裁决变化即重算，含容量闸门） */
  const report: MergeReport | null = useMemo(() => {
    if (!localSnapshot || !incoming) return null;
    return planMerge({ local: localSnapshot, incoming: incoming.snapshot, resolutions });
  }, [localSnapshot, incoming, resolutions]);

  const unresolved = report?.conflicts.length ?? 0;
  const blockedByStock = (report?.rejected.length ?? 0) > 0;
  const stockFailures = useMemo(() => (report?.stockChecks ?? []).filter((check) => !check.ok), [report]);

  const setResolution = (plan: MergeRowPlan, value: MergeResolution): void => {
    setResolutions((prev) => ({ ...prev, [mergePlanKey(plan.table, plan.id)]: value }));
  };

  /** 容量不足：整单拒绝入库，落（或更新）重试草稿 */
  const persistRetryDraft = async (reason: string): Promise<void> => {
    if (!incoming) return;
    await dispatch(
      saveMergeDraft({
        id: incoming.draftId,
        snapshot: incoming.snapshot,
        resolutions,
        lastError: reason,
      }),
    ).unwrap();
    void dispatch(fetchMergeDrafts());
  };

  const handleCommit = async (): Promise<void> => {
    if (!report || !incoming) return;
    if (unresolved > 0) {
      message.warning(`还有 ${unresolved} 条两边都改过的记录未裁决`);
      return;
    }
    if (blockedByStock) {
      const reason = stockFailures
        .map((check) => `${check.origin} 缺口 ${check.shortKg}kg（在库 ${check.stockKg}kg / 需 ${check.neededKg}kg）`)
        .join('；');
      setCommitting(true);
      try {
        await persistRetryDraft(reason);
        message.error(`已拒绝入库并保存为重试草稿：${reason}`);
      } catch (error) {
        message.error(`草稿保存失败：${describeError(error)}`);
      } finally {
        setCommitting(false);
      }
      return;
    }

    setCommitting(true);
    try {
      await commitMergedSnapshot(report);
      const added = Object.values(report.counts).reduce((acc, item) => acc + item.add, 0);
      const updated = Object.values(report.counts).reduce((acc, item) => acc + item.update, 0);
      // 成功后清掉对应重试草稿
      if (incoming.draftId) {
        await dispatch(deleteMergeDraft(incoming.draftId)).unwrap();
      }
      await Promise.all([
        dispatch(fetchGreenBeans()),
        dispatch(fetchRoastProfiles()),
        dispatch(fetchMachineTemplates()),
        dispatch(fetchCuppings()),
        dispatch(fetchBlends()),
        dispatch(fetchMergeDrafts()),
      ]);
      setDoneReport({ added, updated, conflicts: Object.values(report.counts).reduce((acc, item) => acc + item.conflict, 0) });
      message.success('合并已落地：RoR、杯测总分与生豆余量均已重算');
      await refreshLocal();
      setIncoming(null);
      setResolutions({});
    } catch (error) {
      message.error(`合并失败：${describeError(error)}`);
    } finally {
      setCommitting(false);
    }
  };

  const retryDraft = async (draft: MergeDraft): Promise<void> => {
    await refreshLocal();
    loadIncoming(draft.snapshot, `重试草稿（第 ${draft.attempts + 1} 次尝试）`, draft.id);
    setResolutions(draft.resolutions ?? {});
  };

  const removeDraft = (draft: MergeDraft): void => {
    void dispatch(deleteMergeDraft(draft.id));
    message.success('重试草稿已删除');
  };

  /* -------------------------------- 表格列 -------------------------------- */

  const conflictColumns: ColumnsType<MergeRowPlan> = [
    {
      title: '档案表',
      dataIndex: 'table',
      width: 100,
      render: (table: MergeTableName) => <Tag>{TABLE_LABEL[table]}</Tag>,
    },
    {
      title: 'id',
      dataIndex: 'id',
      width: 190,
      render: (id: string) => <Typography.Text className="gb-mono" style={{ fontSize: 12 }}>{id}</Typography.Text>,
    },
    {
      title: '本店版本',
      key: 'local',
      render: (_v, plan) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{describeRow(plan, 'local')}</Typography.Text>
          <span className="gb-muted">修订号 {String((plan.local as Record<string, unknown> | null)?.revision ?? '—')}</span>
        </Space>
      ),
    },
    {
      title: '对端版本',
      key: 'incoming',
      render: (_v, plan) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{describeRow(plan, 'incoming')}</Typography.Text>
          <span className="gb-muted">修订号 {String((plan.incoming as Record<string, unknown> | null)?.revision ?? '—')}</span>
        </Space>
      ),
    },
    {
      title: '裁决（不用后到的盖掉）',
      key: 'resolution',
      width: 300,
      render: (_v, plan) => (
        <Radio.Group
          optionType="button"
          size="small"
          value={resolutions[mergePlanKey(plan.table, plan.id)]}
          onChange={(event) => setResolution(plan, event.target.value as MergeResolution)}
          options={[
            { label: '留本店', value: 'local' },
            { label: '留对端', value: 'incoming' },
            { label: '两个候选都留', value: 'both' },
          ]}
        />
      ),
    },
  ];

  const planColumns: ColumnsType<MergeRowPlan> = [
    { title: '档案表', dataIndex: 'table', width: 100, render: (table: MergeTableName) => TABLE_LABEL[table] },
    {
      title: 'id',
      dataIndex: 'id',
      width: 200,
      render: (id: string) => <Typography.Text className="gb-mono" style={{ fontSize: 12 }}>{id}</Typography.Text>,
    },
    {
      title: '处置',
      dataIndex: 'decision',
      width: 120,
      render: (decision: MergeDecision) => <Tag color={DECISION_META[decision].color}>{DECISION_META[decision].label}</Tag>,
    },
    { title: '本店', key: 'local', render: (_v, plan) => describeRow(plan, 'local') },
    { title: '对端', key: 'incoming', render: (_v, plan) => describeRow(plan, 'incoming') },
  ];

  const conflictRows = report?.conflicts ?? [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => void handleFile(event)}
      />

      <Card
        title={
          <Space>
            <MergeCellsOutlined />
            离线档案逐条合并（烘焙间 / 门店）
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void refreshLocal()}>
              刷新本店档案
            </Button>
            <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => fileInputRef.current?.click()}>
              选择对端档案
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph className="gb-muted" style={{ marginBottom: 8 }}>
          同一条先比<strong>修订号</strong>、再比<strong>更新时间</strong>；只有一边有的直接补进来；两边都动过且分不出新旧时
          <strong> 保留两个候选</strong>人工裁决，不会用后到的盖掉。落地前先校验生豆在库余量，容量不够整单拒绝并留重试草稿；
          落地后统一重算曲线分段 RoR、杯测总分、拼配均分与生豆余量（已完成烘焙只扣一遍）。
        </Typography.Paragraph>

        {doneReport && (
          <Alert
            type="success"
            showIcon
            style={{ marginTop: 8 }}
            message={`合并完成：新增 ${doneReport.added} 条 / 更新 ${doneReport.updated} 条，派生指标已重算`}
          />
        )}

        {!incoming ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="尚未选择对端档案。可在 /blends 点「合并档案」，或在此选择从另一台设备导出的 gbroastlog 档案 JSON。"
            style={{ padding: '24px 0' }}
          />
        ) : (
          <Descriptions
            size="small"
            column={3}
            bordered
            styles={{ label: { width: 120 } }}
            items={[
              { key: 'src', label: '对端档案', children: incoming.label },
              { key: 'time', label: '导出时间', children: incoming.snapshot.exportedAt || '—' },
              {
                key: 'scale',
                label: '档案规模',
                children: `生豆 ${incoming.snapshot.greenBeans.length} / 烘焙 ${incoming.snapshot.roastProfiles.length} / 节点 ${incoming.snapshot.events.length} / 杯测 ${incoming.snapshot.cuppings.length} / 拼配 ${incoming.snapshot.blends.length}`,
              },
            ]}
          />
        )}
      </Card>

      {report && (
        <>
          <Card title="预演汇总" size="small">
            <Space size={28} wrap>
              {(Object.keys(TABLE_LABEL) as MergeTableName[]).map((table) => {
                const bucket = report.counts[table];
                return (
                  <Statistic
                    key={table}
                    title={TABLE_LABEL[table]}
                    value={bucket.add + bucket.update + bucket.conflict + bucket.reject}
                    formatter={() => (
                      <Space size={6}>
                        <Tooltip title="新增（仅对端 / 双候选副本）">
                          <Tag color="#2f6f4f">+{bucket.add}</Tag>
                        </Tooltip>
                        <Tooltip title="采纳对端更新">
                          <Tag color="#7a4b8f">↻{bucket.update}</Tag>
                        </Tooltip>
                        <Tooltip title="待裁决">
                          <Badge count={bucket.conflict} showZero color="#b3372f" />
                        </Tooltip>
                        <Tooltip title="容量不足被拒">
                          <Badge count={bucket.reject} showZero color="#d48806" />
                        </Tooltip>
                      </Space>
                    )}
                  />
                );
              })}
            </Space>
          </Card>

          {/* 容量闸门 */}
          <Card title="生豆在库余量闸门（新增已完成烘焙入库前先校验）" size="small">
            {report.stockChecks.length === 0 ? (
              <Typography.Text className="gb-muted">本次没有需要新占用在库余量的对端已完成烘焙。</Typography.Text>
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {report.stockChecks.map((check: MergeStockCheck) => (
                  <Alert
                    key={check.greenBeanId}
                    type={check.ok ? 'success' : 'error'}
                    showIcon
                    message={
                      <Space wrap>
                        <strong>{check.origin}</strong>
                        <span>在库 {check.stockKg}kg</span>
                        <span>本次新增已完成烘焙需 {check.neededKg}kg（{check.profileIds.length} 锅）</span>
                        {check.ok ? <Tag color="#2f6f4f">容量足够</Tag> : <Tag color="#b3372f">缺口 {check.shortKg}kg</Tag>}
                      </Space>
                    }
                  />
                ))}
              </Space>
            )}
          </Card>

          {/* 冲突裁决 */}
          <Card
            title={
              <Space>
                <FileSearchOutlined />
                两边都改过 · 冲突裁决
                <Tag color={unresolved > 0 ? '#b3372f' : '#2f6f4f'}>
                  {unresolved > 0 ? `待裁决 ${unresolved} 条` : '已全部裁决'}
                </Tag>
              </Space>
            }
            size="small"
          >
            {conflictRows.length === 0 ? (
              <Typography.Text className="gb-muted">没有两边都动过且分不出新旧的记录。</Typography.Text>
            ) : (
              <Table
                className="gb-table"
                rowKey={(plan) => mergePlanKey(plan.table, plan.id)}
                size="small"
                columns={conflictColumns}
                dataSource={conflictRows}
                pagination={false}
                scroll={{ x: 1080 }}
              />
            )}
          </Card>

          {/* 全量逐条计划 */}
          <Card title="逐条合并计划（修订号 / 时间比对结果）" size="small">
            <Table
              className="gb-table"
              rowKey={(plan) => mergePlanKey(plan.table, plan.id)}
              size="small"
              columns={planColumns}
              dataSource={report.plans.filter((plan) => plan.decision !== 'identical' && plan.decision !== 'localOnly')}
              pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 条待落地变化` }}
            />
          </Card>

          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button onClick={() => { setIncoming(null); setResolutions({}); }} disabled={committing}>
              取消
            </Button>
            <Button
              type="primary"
              size="large"
              loading={committing}
              disabled={unresolved > 0}
              onClick={() => void handleCommit()}
            >
              {blockedByStock ? '容量不足，拒绝入库并保存重试草稿' : '确认合并落地并重算派生指标'}
            </Button>
          </Space>
        </>
      )}

      {/* 重试草稿 */}
      <Card
        title={
          <Space>
            <ReloadOutlined />
            失败重试草稿
            <Tag color={drafts.length > 0 ? '#d48806' : '#2f6f4f'}>{drafts.length} 份</Tag>
          </Space>
        }
        size="small"
        loading={draftLoading}
      >
        {drafts.length === 0 ? (
          <Typography.Text className="gb-muted">暂无草稿。容量不足被拒绝的合并会整单留在这里，补货后可接着重试。</Typography.Text>
        ) : (
          <Timeline
            items={drafts.map((draft) => ({
              color: 'orange',
              children: (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space wrap>
                    <strong>容量不足待重试档案</strong>
                    <Tag>已尝试 {draft.attempts} 次</Tag>
                    <span className="gb-muted">更新于 {draft.updatedAt}</span>
                  </Space>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    上次失败：{draft.lastError}
                  </Typography.Text>
                  <Space wrap>
                    <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => void retryDraft(draft)}>
                      接着草稿重试
                    </Button>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeDraft(draft)}>
                      删除草稿
                    </Button>
                  </Space>
                </Space>
              ),
            }))}
          />
        )}
      </Card>
    </Space>
  );
}
