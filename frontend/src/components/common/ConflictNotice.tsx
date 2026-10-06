/**
 * ConflictNotice 待裁决冲突提示条：
 * 有两边都改过、并存为候选的记录时，在相关业务页（生豆 / 机型 / 曲线 / 发展 / 杯测）顶部提示，
 * 点击跳到 /blends 的合并中心逐条裁决。候选行不进业务列表，避免被误改或重复扣减。
 */
import { Alert, Button } from 'antd';
import { FileProtectOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { countOpenConflictsNow } from '../../utils/merge';
import { ROUTES } from '../../router/routes';

export default function ConflictNotice() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    const tick = (): void => {
      void countOpenConflictsNow().then((value) => {
        if (mounted) setCount(value);
      });
    };
    tick();
    const timer = window.setInterval(tick, 4000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  if (count === 0) return null;
  return (
    <Alert
      type="warning"
      showIcon
      icon={<FileProtectOutlined />}
      style={{ marginBottom: 12 }}
      message={`有 ${count} 条两边都改过的记录并存为候选，尚未裁决`}
      description="候选版本暂不参与业务操作（如下豆扣减、杯测均分等），请到合并中心选择保留版本，合并后分段 RoR、发展时间占比、杯测总分与生豆余量会统一重算。"
      action={
        <Button size="small" type="primary" onClick={() => navigate(ROUTES.blends)}>
          去合并中心
        </Button>
      }
    />
  );
}
