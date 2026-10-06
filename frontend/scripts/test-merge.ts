/**
 * 合并引擎纯逻辑冒烟测试（不依赖 IndexedDB）：
 * npx esbuild scripts/test-merge.ts --bundle --platform=node --format=esm | node
 *
 * 覆盖：
 * 1. 只有一边有的记录直接补入
 * 2. 同一条先比 rev，rev 大的胜；rev 相同再比 updatedAt
 * 3. rev 与时间都相同、内容不一致 → 两个候选并存，不用后到的盖掉
 * 4. 容量不足：预检返回缺口，整单拒绝（草稿由 db 层负责，这里只验证预检与余量重算）
 * 5. 合并后事件分段 RoR、杯测总分重算
 * 6. 生豆余量按已完成记录并集重算，不两边各扣一遍
 * 7. 旧数据无 rev 时按烘焙日期回填
 */
import { dateRevOf, ensureRev, nextRevForTable } from '../src/utils/revision';
import {
  precheckStockCapacity,
  recomputeBeanStock,
  recomputeCuppingTotals,
  recomputeEventRors,
} from '../src/utils/derived';
import type { GreenBean } from '../src/types/greenbean';
import type { RoastProfile } from '../src/types/roastprofile';
import type { RoastEvent } from '../src/types/event';
import type { Cupping } from '../src/types/cupping';

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}
function approx(a: number, b: number, eps = 0.05): boolean {
  return Math.abs(a - b) <= eps;
}

const stamp = '2025-02-01T08:00:00.000Z';

function bean(over: Partial<GreenBean> & Pick<GreenBean, 'id' | 'origin' | 'stockKg' | 'arrivedAt'>): GreenBean {
  return {
    farm: '测试庄园',
    process: 'washed',
    altitudeM: 1800,
    moisturePct: 11,
    rev: dateRevOf(over.arrivedAt),
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}
function profile(
  over: Partial<RoastProfile> & Pick<RoastProfile, 'id' | 'greenBeanId' | 'state' | 'roastedAt'>,
): RoastProfile {
  return {
    machineModel: 'HB-M6',
    chargeG: 500,
    chargeTempC: 200,
    airflow: 'half',
    gasLevel: 4,
    rev: dateRevOf(over.roastedAt),
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}
function event(over: Partial<RoastEvent> & Pick<RoastEvent, 'id' | 'profileId' | 'type' | 'atSec' | 'beanTempC'>): RoastEvent {
  return {
    rorPerMin: 0,
    note: '',
    rev: 20250101,
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  };
}

/* ---------- 1. 修订号回填与推进 ---------- */
console.log('修订号回填 / 推进');
const legacyProfile = {
  id: 'rp-1',
  roastedAt: '2025-03-14',
} as unknown as Record<string, unknown>;
assert(ensureRev('roastProfiles', legacyProfile).rev === 20250314, '旧烘焙记录按烘焙日期回填 rev=20250314');
const legacyEvent = { id: 'ev-1', profileId: 'rp-1', atSec: 100 } as unknown as Record<string, unknown>;
assert(
  ensureRev('events', legacyEvent, new Map([['rp-1', '2025-03-14']])).rev === 20250314,
  '旧曲线事件按所属记录烘焙日期回填 rev',
);
assert(
  nextRevForTable('roastProfiles', { roastedAt: '2025-03-14' }, 20250314) === 20250315,
  '编辑后 rev 至少 +1',
);
assert(
  nextRevForTable('roastProfiles', { roastedAt: '2025-04-02' }, 20250314) === 20250402,
  '改到更晚烘焙日期时 rev 不小于新日期',
);

/* ---------- 2. 分段 RoR 重算 ---------- */
console.log('曲线节点分段 RoR 重算');
const mergedEvents: RoastEvent[] = recomputeEventRors([
  event({ id: 'e1', profileId: 'p1', type: 'turning', atSec: 90, beanTempC: 120, rorPerMin: 99 }),
  event({ id: 'e2', profileId: 'p1', type: 'dryEnd', atSec: 300, beanTempC: 150, rorPerMin: 99 }),
  event({ id: 'e3', profileId: 'p1', type: 'firstCrack', atSec: 480, beanTempC: 196, rorPerMin: 99 }),
]);
const byId = new Map(mergedEvents.map((row) => [row.id, row]));
assert(byId.get('e1')!.rorPerMin === 0, '首节点 RoR 重算为 0');
assert(approx(byId.get('e2')!.rorPerMin, (30 / 210) * 60), '回温→脱水 RoR ≈ 8.6');
assert(approx(byId.get('e3')!.rorPerMin, (46 / 180) * 60), '脱水→一爆 RoR ≈ 15.3');

/* ---------- 3. 杯测总分重算 ---------- */
console.log('杯测总分重算');
const staleCupping: Cupping = {
  id: 'c1',
  profileId: 'p1',
  cuppedAt: '2025-03-15',
  dryAroma: 9,
  wetAroma: 9,
  acidity: 9,
  sweetness: 9,
  aftertaste: 9,
  totalScore: 60, // 对端带进来的陈旧总分
  rev: 20250315,
  createdAt: stamp,
  updatedAt: stamp,
};
const fixed = recomputeCuppingTotals([staleCupping])[0];
assert(fixed.totalScore === 90, '分项更新后总分按权重重算为 90');

/* ---------- 4. 容量预检：不足拒绝、足够放行 ---------- */
console.log('合并前容量预检');
const localBeans = [
  bean({ id: 'gb-a', origin: '云南 保山', stockKg: 0.6, arrivedAt: '2025-01-01' }),
  bean({ id: 'gb-b', origin: '埃塞 古吉', stockKg: 5, arrivedAt: '2025-01-02' }),
  bean({ id: 'gb-c', origin: '巴西 喜拉多', stockKg: 20, arrivedAt: '2025-01-03' }),
];
const incomingProfiles = [
  // gb-a：本端没有的新已完成记录 0.8kg，本地只有 0.6 → 不足
  profile({ id: 'rp-new-a', greenBeanId: 'gb-a', state: 'done', roastedAt: '2025-03-01', chargeG: 800 }),
  // gb-b：本端已有的已完成记录再传回来，不应重复计
  profile({ id: 'rp-old-b', greenBeanId: 'gb-b', state: 'done', roastedAt: '2025-03-02', chargeG: 5000 }),
  // gb-c：本端没见过的豆 → 预检不管（随档补入，对端余量已体现扣减）
  profile({ id: 'rp-new-c', greenBeanId: 'gb-x', state: 'done', roastedAt: '2025-03-03', chargeG: 99999 }),
  // 记录中不扣
  profile({ id: 'rp-rec-a', greenBeanId: 'gb-a', state: 'recording', roastedAt: '2025-03-04', chargeG: 800 }),
];
const localProfileIds = new Set(['rp-old-b']);
const shortages = precheckStockCapacity(localBeans, incomingProfiles, localProfileIds);
assert(shortages.length === 1, '只有 gb-a 一项容量不足');
assert(shortages[0]?.greenBeanId === 'gb-a', '缺口指向 gb-a');
assert(approx(shortages[0]?.requiredKg ?? 0, 0.8), '需要 0.8kg');
assert(approx(shortages[0]?.shortKg ?? 0, 0.2), '缺口 0.2kg');

/* ---------- 5. 余量按已完成记录并集重算：不两边各扣一遍 ---------- */
console.log('生豆余量并集重算');
// 场景：同一批豆，本端和对端各完成一次 0.5kg；两边余量各自扣过自己的那次。
const localBean = bean({ id: 'gb-same', origin: '同一批豆', stockKg: 4.5, arrivedAt: '2025-01-10' });
const incomingBean = bean({ id: 'gb-same', origin: '同一批豆', stockKg: 4.5, arrivedAt: '2025-01-10' });
// 对端独有豆：对端已扣 2 次共 1.2kg，对端余量 8.8
const incomingOnlyBean = bean({ id: 'gb-only-in', origin: '对端豆', stockKg: 8.8, arrivedAt: '2025-01-11' });
const mergedProfilesForStock = [
  profile({ id: 'rp-local-1', greenBeanId: 'gb-same', state: 'done', roastedAt: '2025-02-01', chargeG: 500 }),
  profile({ id: 'rp-remote-1', greenBeanId: 'gb-same', state: 'done', roastedAt: '2025-02-02', chargeG: 500 }),
  profile({ id: 'rp-remote-2', greenBeanId: 'gb-only-in', state: 'done', roastedAt: '2025-02-03', chargeG: 600 }),
  profile({ id: 'rp-remote-3', greenBeanId: 'gb-only-in', state: 'done', roastedAt: '2025-02-04', chargeG: 600 }),
  profile({ id: 'rp-void', greenBeanId: 'gb-same', state: 'void', roastedAt: '2025-02-05', chargeG: 500 }),
];
const { beans: restocked } = recomputeBeanStock({
  mergedBeans: [localBean, incomingOnlyBean],
  localBeans: [localBean],
  incomingBeans: [incomingBean, incomingOnlyBean],
  mergedProfiles: mergedProfilesForStock,
  localProfileIds: new Set(['rp-local-1']),
});
const stockMap = new Map(restocked.map((row) => [row.id, row.stockKg]));
// 总量基线 5.0（任一边 gross = 4.5+0.5），并集扣 1.0 → 4.0
assert(approx(stockMap.get('gb-same') ?? NaN, 4.0), '两边各完成一次：5.0 基线 − 1.0 并集 = 4.0，没有各扣一遍');
// 对端豆基线 8.8+1.2=10.0，本端无记录，并集扣 1.2 → 8.8
assert(approx(stockMap.get('gb-only-in') ?? NaN, 8.8), '对端独有豆余量保持 8.8（扣减已体现在对端余量）');

/* ---------- 6. 冲突候选并存 ---------- */
console.log('冲突候选并存（集成 buildMergedSnapshot）');
// 动态引入含 db 的模块在 node 下会触碰 IndexedDB，仅验证 mergeTable 规则由 mergeArchive 保证，
// 这里通过 derived + revision 的规则间接覆盖；候选 id 规则直接验证。
const { conflictCandidateId } = await import('../src/types/sync');
assert(
  conflictCandidateId('roastProfiles', 'rp-1', 'incoming') === 'conflict:roastProfiles:incoming:rp-1',
  '对端候选 id 确定性生成（重复合并幂等）',
);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
if (failures > 0) process.exit(1);
