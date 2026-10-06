/**
 * MergeCenter 合并中心：
 * - 待裁决冲突：两边都动过同一条（同 rev、时间也不分先后），并列两个候选，选择保留本端或采用对端；
 * - 入库重试草稿：容量不足被拒的整单，列出生豆缺口，补货后一键接着草稿重试或放弃。
 * 挂在 /blends 页顶部，数据来自 useMergeCenter（Dexie 实时订阅）。
 */
import { App as AntdApp, Alert, Button, Card, Empty, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckOutlined,
  CloseOutlined,
  CloudSyncOutlined,
  DeleteOutlined,
  FileProtectOutlined,
  RedoOutlined,
} from '@ant-design/icons';
import useMergeCenter from '../../hooks/useMergeCenter';
import type { MergeDraft } from '../../types/sync';
import {
  TABLE_LABEL,
  type ConflictGroup,
  type MergeReport,
} from '../../utils/merge';
import { BEAN_PROCESS_LABEL } from '../../types/greenbean';
import { EVENT_TYPE_LABEL } from '../../types/event';

/** 把冲突行压成一行可读摘要 */
function summarizeRow(table: ConflictGroup['table'], row: Record<string, unknown>): string {
  const text = (value: unknown): string => (value === undefined || value === null || value === '' ? '—' : String(value));
  switch (table) {
    case 'greenBeans': {
      const process = BEAN_PROCESS_LABEL[row.process as keyof typeof BEAN_PROCESS_LABEL] ?? '';
      return `${text(row.origin)} · ${text(row.farm)} · ${process} · 在库 ${text(row.stockKg)}kg`;
    }
    case 'roastProfiles':
      return `${text(row.machineModel)} · ${text(row.roastedAt)} · ${text(row.chargeG)}g · ${text(row.state)}`;
    case 'events': {
      const type = EVENT_TYPE_LABEL[row.type as keyof typeof EVENT_TYPE_LABEL] ?? text(row.type);
      return `${type} · ${text(row.atSec)}s · ${text(row.beanTempC)}℃ · RoR ${text(row.rorPerMin)}`;
    }
    case 'cuppings':
      return `杯测 ${text(row.cuppedAt)} · 总分 ${text(row.totalScore)}`;
    case 'blends':
      return `${text(row.name)} · ${text(row.state)} · ${Array.isArray(row.items) ? row.items.length : 0} 项成分`;
    case 'machineTemplates':
      return `${text(row.model)} · ${text(row.chargeG)}g · ${text(row.gasLevel)} 档`;
    default:
      return text(row.id);
  }
}

interface MergeCenterProps {
  /** 合并落地 / 重试后通知页面重新拉取各 slice */
  onChanged: () => void;
}

export default function MergeCenter({ onChanged }: MergeCenterProps) {
  const { message, modal } = AntdApp.useApp();
  const { drafts, conflicts, loading, retry, discard, chooseLocal, chooseIncoming } = useMergeCenter();

  if (drafts.length === 0 && conflicts.length === 0 && !loading) return null;

  const handleRetry = (draft: MergeDraft): void => {
    modal.confirm({
      title: '接着草稿重试入库？',
      content: `将按当前在库余量重新预检：${draft.shortages
        .map((item) => `${item.origin} 缺 ${item.shortKg}kg`)
        .join('；')}。仍然不足会继续保留草稿。`,
      okText: '重试入库',
      cancelText: '取消',
      async onOk() {
        let report: MergeReport;
        try {
          report = await retry(draft);
        } catch (error) {
          message.error(`重试失败：${error instanceof Error ? error.message : '未知错误'}`);
          return;
        }
        if (report.ok) {
          message.success(report.message);
          onChanged();
        } else {
          message.warning(report.message);
        }
      },
    });
  };

  const handleDiscard = (draft: MergeDraft): void => {
    modal.confirm({
      title: '放弃这份入库草稿？',
      content: '草稿里的对端档案将不会再入库，且无法恢复。',
      okText: '放弃草稿',
      okButtonProps: { danger: true },
      cancelText: '取消',
      async onOk() {
        await discard(draft.id);
        message.success('草稿已删除');
      },
    });
  };

  const handleChoose = async (group: ConflictGroup, side: 'local' | 'incoming'): Promise<void> => {
    try {
      if (side === 'local') await chooseLocal(group);
      else await chooseIncoming(group);
      message.success('已按所选候选合并为一条');
      onChanged();
    } catch (error) {
      message.error(`裁决失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const draftColumns: ColumnsType<MergeDraft> = [
    {
      title: '草稿 / 来源',
      key: 'label',
      width: 240,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{row.label}</Typography.Text>
          <span className="gb-muted">来源 {row.sourceName} · 已尝试 {row.attempts} 次</span>
        </Space>
      ),
    },
    {
      title: '容量缺口（合并前预检）',
      key: 'shortages',
      render: (_value, row) => (
        <Space direction="vertical" size={2}>
          {row.shortages.map((item) => (
            <Tag key={item.greenBeanId} color="#b3372f">
              {item.origin}
              {item.farm ? ` · ${item.farm}` : ''} 需 {item.requiredKg}kg / 在库 {item.availableKg}kg / 缺 {item.shortKg}kg
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_value, row) => (
        <Space>
          <Button size="small" type="primary" icon={<RedoOutlined />} onClick={() => handleRetry(row)}>
            补货后重试
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDiscard(row)}>
            放弃
          </Button>
        </Space>
      ),
    },
  ];

  const conflictColumns: ColumnsType<ConflictGroup> = [
    {
      title: '类型 / 原记录',
      key: 'meta',
      width: 240,
      render: (_value, row) => (
        <Space direction="vertical" size={0}>
          <Tag color="#7a4b8f">{TABLE_LABEL[row.table]}</Tag>
          <span className="gb-mono gb-muted" style={{ fontSize: 12 }}>
            {row.baseId}
          </span>
        </Space>
      ),
    },
    {
      title: '本端候选（门店档案）',
      key: 'local',
      render: (_value, row) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Typography.Text>{summarizeRow(row.table, row.base)}</Typography.Text>
          <Button size="small" icon={<CheckOutlined />} onClick={() => void handleChoose(row, 'local')}>
            保留本端
          </Button>
        </Space>
      ),
    },
    {
      title: '对端候选（烘焙间档案）',
      key: 'incoming',
      render: (_value, row) =>
        row.candidate ? (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Typography.Text>{summarizeRow(row.table, row.candidate)}</Typography.Text>
            <Space size={6}>
              <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => void handleChoose(row, 'incoming')}>
                采用对端
              </Button>
              <Typography.Text className="gb-muted">rev {String(row.candidate.rev ?? row.base.rev)}</Typography.Text>
            </Space>
          </Space>
        ) : (
          <CloseOutlined />
        ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <CloudSyncOutlined />
          离线档案合并中心
        </Space>
      }
      size="small"
      styles={{ body: { paddingTop: 10 } }}
      extra={<span className="gb-muted">同一条先比修订号再比时间；两边都动过就留两个候选，裁决前不会互相覆盖</span>}
    >
      {conflicts.length > 0 ? (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            icon={<FileProtectOutlined />}
            message={`有 ${conflicts.length} 组两边都改过的记录，已并存为候选，请逐组裁决（分段 RoR、杯测总分、生豆余量会在裁决合并后自动重算）。`}
          />
          <Table
            className="gb-table"
            rowKey={(row) => `${row.table}:${row.baseId}`}
            size="small"
            loading={loading}
            columns={conflictColumns}
            dataSource={conflicts}
            pagination={false}
          />
        </>
      ) : null}

      {drafts.length > 0 ? (
        <div style={conflicts.length > 0 ? { marginTop: 14 } : undefined}>
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 10 }}
            message={`有 ${drafts.length} 份因生豆容量不足被拒绝的入库草稿，补货后可直接接着重试。`}
          />
          <Table
            className="gb-table"
            rowKey="id"
            size="small"
            columns={draftColumns}
            dataSource={drafts}
            pagination={false}
          />
        </div>
      ) : null}

      {conflicts.length === 0 && drafts.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待裁决冲突或待重试入库" /> : null}
    </Card>
  );
}
