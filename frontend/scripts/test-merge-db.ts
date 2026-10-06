/**
 * 合并引擎端到端测试（fake-indexeddb + Dexie 真实读写）：
 * npx esbuild scripts/test-merge-db.ts --bundle --platform=node --format=esm | node
 */
import 'fake-indexeddb/auto';
import {
  db,
  exportSnapshot,
  initDatabase,
  putGreenBean,
  putRoastProfile,
  listGreenBeans,
  listRoastProfiles,
  listMergeDrafts,
} from '../src/utils/db';
import { mergeArchive } from '../src/utils/merge';
import { ensureRev } from '../src/utils/revision';
import type { GreenBean } from '../src/types/greenbean';
import type { RoastProfile } from '../src/types/roastprofile';
import type { RoastEvent } from '../src/types/event';
import type { Cupping } from '../src/types/cupping';
import type { Blend } from '../src/types/blend';
import type { MachineTemplate } from '../src/types/roastprofile';

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

const stamp = '2025-03-20T08:00:00.000Z';

function greenBean(partial: Partial<GreenBean> & Pick<GreenBean, 'id' | 'origin' | 'stockKg' | 'arrivedAt'>): GreenBean {
  const row: GreenBean = {
    farm: '庄园',
    process: 'washed',
    altitudeM: 1800,
    moisturePct: 11,
    createdAt: stamp,
    updatedAt: stamp,
    ...partial,
  } as GreenBean;
  return ensureRev('greenBeans', row);
}
function roastProfile(
  partial: Partial<RoastProfile> & Pick<RoastProfile, 'id' | 'greenBeanId' | 'state' | 'roastedAt'>,
): RoastProfile {
  const row = {
    machineModel: 'HB-M6',
    chargeG: 500,
    chargeTempC: 200,
    airflow: 'half' as const,
    gasLevel: 4,
    createdAt: stamp,
    updatedAt: stamp,
    ...partial,
  } as RoastProfile;
  return ensureRev('roastProfiles', row);
}

async function main(): Promise<void> {
  /* ---- 场景 1：正常逐条合并 + 冲突并存 ---- */
  console.log('场景 1：逐条合并、新增补入、高 rev 覆盖、同 rev 冲突并存');
  await initDatabase();
  // 清掉播种数据，构造干净场景
  await db.greenBeans.clear();
  await db.roastProfiles.clear();
  await db.events.clear();
  await db.cuppings.clear();
  await db.blends.clear();
  await db.machineTemplates.clear();
  await db.mergeDrafts.clear();

  // 本端（门店）。gb1 本端已完成 rp1 扣过 0.5kg，所以余量 8.5 = 9.0 基线 − 0.5
  await putGreenBean(greenBean({ id: 'gb1', origin: '本地豆 rev1', stockKg: 8.5, arrivedAt: '2025-01-01', rev: 20250101 }));
  await putGreenBean(greenBean({ id: 'gb2', origin: '同 rev 冲突豆', stockKg: 5, arrivedAt: '2025-01-05', rev: 20250310 }));
  await putRoastProfile(
    roastProfile({ id: 'rp1', greenBeanId: 'gb1', state: 'recording', roastedAt: '2025-03-01', rev: 20250301 }),
  );

  const incomingSnapshot = {
    name: 'gbroastlog',
    schemaVersion: 3,
    exportedAt: stamp,
    greenBeans: [
      // gb1：对端修订更高（对端同批完成，余量也扣过一次，故同样为 8.5）
      greenBean({ id: 'gb1', origin: '本地豆 rev3', stockKg: 8.5, arrivedAt: '2025-01-01', rev: 20250301 }),
      // gb2：同 rev、同 updatedAt、内容不同 → 冲突
      greenBean({ id: 'gb2', origin: '同 rev 冲突豆(对端改)', stockKg: 4.2, arrivedAt: '2025-01-05', rev: 20250310 }),
      // gb3：对端独有 → 补入
      greenBean({ id: 'gb3', origin: '对端新豆', stockKg: 9, arrivedAt: '2025-02-10', rev: 20250210 }),
    ],
    roastProfiles: [
      // 同一条 rp1，对端 rev 更低 → 本端保留，不被后到的盖
      roastProfile({ id: 'rp1', greenBeanId: 'gb1', state: 'done', roastedAt: '2025-03-01', rev: 20250302 }),
      roastProfile({ id: 'rp2', greenBeanId: 'gb3', state: 'done', roastedAt: '2025-03-05', rev: 20250305, chargeG: 500 }),
    ],
    events: [] as RoastEvent[],
    cuppings: [] as Cupping[],
    blends: [] as Blend[],
    machineTemplates: [] as MachineTemplate[],
  };

  const report = await mergeArchive(incomingSnapshot);
  assert(report.ok === true, '容量足够，合并成功');
  assert(report.stats.greenBeans.added === 1, '生豆补入 1 条（gb3）');
  assert(report.stats.greenBeans.updated === 1, '生豆高 rev 覆盖 1 条（gb1）');
  assert(report.stats.greenBeans.conflicts === 1, 'gb2 同 rev 两边都改 → 1 组冲突');
  assert(report.stats.roastProfiles.added === 1, '烘焙记录补入 1 条（rp2）');

  const beans = await db.greenBeans.toArray();
  const gb1 = beans.find((row) => row.id === 'gb1');
  assert(gb1?.origin === '本地豆 rev3' && gb1.stockKg === 8.5, 'gb1 采用对端高 rev 版本（余量按并集重算仍为 8.5）');
  const gb2Candidate = beans.find((row) => row.conflictOf === 'gb2');
  assert(Boolean(gb2Candidate), 'gb2 对端候选已并存');
  assert(gb2Candidate?.stockKg === 4.2, '候选保留对端余量 4.2');
  assert(beans.some((row) => row.id === 'gb2' && !row.conflictOf), 'gb2 本端主记录仍在');

  const profiles = await db.roastProfiles.toArray();
  const rp1 = profiles.find((row) => row.id === 'rp1' && !row.conflictOf);
  assert(rp1?.state === 'done' && rp1.rev === 20250302, 'rp1 采用对端 rev20250302 版本（已完成）');

  /* ---- 场景 2：余量重算——rp2 是新增已完成 0.5kg，gb3 对端余量 9 已扣过，本端没有 gb3 → 保持 9 ---- */
  const gb3 = (await listGreenBeans()).find((row) => row.id === 'gb3');
  assert(gb3?.stockKg === 9, '对端独有豆补入后余量保持对端值 9kg（不重复扣）');

  /* ---- 场景 3：容量不足 → 拒绝 + 草稿，补货后重试成功 ---- */
  console.log('场景 2：容量不足拒绝、落草稿、补货后重试');
  await putGreenBean(greenBean({ id: 'gbShort', origin: '会缺货的豆', stockKg: 0.3, arrivedAt: '2025-02-01', rev: 20250201 }));
  const shortSnapshot = {
    name: 'gbroastlog',
    schemaVersion: 3,
    exportedAt: stamp,
    greenBeans: [],
    roastProfiles: [
      roastProfile({ id: 'rpShort', greenBeanId: 'gbShort', state: 'done', roastedAt: '2025-03-18', rev: 20250318, chargeG: 1000 }),
    ],
    events: [] as RoastEvent[],
    cuppings: [] as Cupping[],
    blends: [] as Blend[],
    machineTemplates: [] as MachineTemplate[],
  };
  const rejected = await mergeArchive(shortSnapshot);
  assert(rejected.ok === false, '余量 0.3kg < 载量 1kg，整单拒绝');
  assert(rejected.shortages[0]?.shortKg === 0.7, '缺口 0.7kg');
  assert(Boolean(rejected.draftId), '已生成重试草稿');
  const draftsAfterReject = await listMergeDrafts();
  assert(draftsAfterReject.length === 1, '草稿表有 1 份待重试');
  const rpStillAbsent = !(await listRoastProfiles()).some((row) => row.id === 'rpShort');
  assert(rpStillAbsent, '拒绝后业务表没有写入 rpShort');

  // 补货 2kg 后接着同一份草稿重试
  const shortBean = await db.greenBeans.get('gbShort');
  await putGreenBean({ ...shortBean!, stockKg: 2.3, rev: 20250319, updatedAt: stamp });
  const draft = draftsAfterReject[0];
  const retried = await mergeArchive(draft.snapshot, draft.id);
  assert(retried.ok === true, '补货后重试成功');
  const profilesAfter = await listRoastProfiles();
  assert(profilesAfter.some((row) => row.id === 'rpShort' && row.state === 'done'), 'rpShort 已合并为已完成');
  const draftsAfterRetry = await listMergeDrafts();
  assert(draftsAfterRetry.length === 0, '成功后草稿自动清除');
  const restocked = (await listGreenBeans()).find((row) => row.id === 'gbShort');
  // 本端总量基线 2.3（本端此前没有 done 记录），并集新增扣 1.0 → 1.3
  assert(restocked?.stockKg === 1.3, `补货豆重试后余量 2.3 - 1.0 = 1.3，实际 ${restocked?.stockKg}`);

  /* ---- 场景 4：合并落地后分段 RoR 与杯测总分按新内容重算 ---- */
  console.log('场景 3：合并落地后分段 RoR / 杯测总分重算');
  await putGreenBean(greenBean({ id: 'gbCalc', origin: '重算用豆', stockKg: 10, arrivedAt: '2025-01-01', rev: 20250101 }));
  await putRoastProfile(
    roastProfile({ id: 'rpCalc', greenBeanId: 'gbCalc', state: 'recording', roastedAt: '2025-03-10', rev: 20250310 }),
  );
  const calcSnapshot = {
    name: 'gbroastlog',
    schemaVersion: 3,
    exportedAt: stamp,
    greenBeans: [],
    roastProfiles: [
      roastProfile({ id: 'rpCalc', greenBeanId: 'gbCalc', state: 'recording', roastedAt: '2025-03-10', rev: 20250311 }),
    ],
    events: [
      // 故意把 rorPerMin 写成错误值，合并后应被重算覆盖
      { id: 'ev1', profileId: 'rpCalc', type: 'turning', atSec: 100, beanTempC: 120, rorPerMin: 77, note: '', rev: 20250310, createdAt: stamp, updatedAt: stamp },
      { id: 'ev2', profileId: 'rpCalc', type: 'dryEnd', atSec: 300, beanTempC: 150, rorPerMin: 77, note: '', rev: 20250310, createdAt: stamp, updatedAt: stamp },
    ] as unknown as RoastEvent[],
    cuppings: [
      // 分项全 8 → 总分应为 80；给个陈旧 totalScore 50
      { id: 'cp1', profileId: 'rpCalc', cuppedAt: '2025-03-11', dryAroma: 8, wetAroma: 8, acidity: 8, sweetness: 8, aftertaste: 8, totalScore: 50, rev: 20250311, createdAt: stamp, updatedAt: stamp },
    ] as unknown as Cupping[],
    blends: [] as Blend[],
    machineTemplates: [] as MachineTemplate[],
  };
  const calcReport = await mergeArchive(calcSnapshot);
  assert(calcReport.ok, '重算场景合并成功');
  const ev2 = await db.events.get('ev2');
  const expectedRor = Math.round(((30 / 200) * 60) * 10) / 10;
  assert(ev2?.rorPerMin === expectedRor, `曲线节点分段 RoR 重算为 ${expectedRor}（陈旧 77 被覆盖）`);
  const cp1 = await db.cuppings.get('cp1');
  assert(cp1?.totalScore === 80, '杯测分项合并后总分重算为 80（陈旧 50 被覆盖）');

  /* ---- 场景 5：旧数据无 rev 的档案也能参与合并（按日期回填） ---- */
  console.log('场景 4：旧档案（无 rev / 无时间戳字段）回填后合并');  const legacySnapshot = {
    name: 'gbroastlog',
    schemaVersion: 2,
    exportedAt: stamp,
    greenBeans: [
      { id: 'gbLegacy', origin: '旧版豆', farm: '', process: 'natural', altitudeM: 1000, moisturePct: 11, stockKg: 3, arrivedAt: '2024-12-01' },
    ] as unknown as GreenBean[],
    roastProfiles: [
      {
        id: 'rpLegacy',
        greenBeanId: 'gbLegacy',
        machineModel: 'Probat',
        chargeG: 300,
        chargeTempC: 190,
        airflow: 'open',
        gasLevel: 3,
        roastedAt: '2024-12-20',
        state: 'recording',
      },
    ] as unknown as RoastProfile[],
    events: [] as RoastEvent[],
    cuppings: [] as Cupping[],
    blends: [] as Blend[],
    machineTemplates: [] as MachineTemplate[],
  };
  const legacyReport = await mergeArchive(legacySnapshot);
  assert(legacyReport.ok, '旧档案可合并');
  const legacyBean = await db.greenBeans.get('gbLegacy');
  assert(legacyBean?.rev === 20241201, '旧生豆按到货日期回填 rev=20241201');
  const legacyProfile = await db.roastProfiles.get('rpLegacy');
  assert(legacyProfile?.rev === 20241220, '旧烘焙记录按烘焙日期回填 rev=20241220');

  const exported = await exportSnapshot();
  assert(Array.isArray(exported.mergeDrafts), '导出快照携带重试草稿数组');

  /* ---- 场景 5：重复合并幂等；对端自带候选行不会重复补入 ---- */
  console.log('场景 5：重复合并幂等 & 忽略对端候选行');
  // 再合并一次与场景 1 相同的档案
  await mergeArchive(incomingSnapshot);
  const beansAfterTwice = await db.greenBeans.toArray();
  const gb2Candidates = beansAfterTwice.filter((row) => row.conflictOf === 'gb2');
  assert(gb2Candidates.length === 1, '重复合并后 gb2 仍只有 1 个对端候选（幂等）');
  const gb3Count = beansAfterTwice.filter((row) => row.id === 'gb3').length;
  assert(gb3Count === 1, 'gb3 没有被重复写入');

  // 对端快照里故意带一个「冲突候选行」（前缀 id），不应作为新记录补入
  const snapshotWithCandidate = {
    name: 'gbroastlog',
    schemaVersion: 3,
    exportedAt: stamp,
    greenBeans: [
      greenBean({ id: 'gbCandBase', origin: '又一批豆', stockKg: 6, arrivedAt: '2025-02-15', rev: 20250215 }),
      {
        ...greenBean({ id: 'conflict:greenBeans:incoming:gbCandBase', origin: '不该出现的候选', stockKg: 6, arrivedAt: '2025-02-15', rev: 20250215 }),
        conflictOf: 'gbCandBase',
        conflictSide: 'incoming' as const,
      },
    ],
    roastProfiles: [] as RoastProfile[],
    events: [] as RoastEvent[],
    cuppings: [] as Cupping[],
    blends: [] as Blend[],
    machineTemplates: [] as MachineTemplate[],
  };
  const candReport = await mergeArchive(snapshotWithCandidate);
  assert(candReport.ok, '带候选行的档案合并成功');
  const allBeans = await db.greenBeans.toArray();
  assert(Boolean(allBeans.find((row) => row.id === 'gbCandBase' && !row.conflictOf)), '主记录 gbCandBase 已补入');
  assert(!allBeans.some((row) => row.id === 'conflict:greenBeans:incoming:gbCandBase'), '对端自带候选行没有被补入');

  /* ---- 场景 6：冲突裁决 ---- */
  console.log('场景 6：冲突候选裁决（采用对端 / 保留本端）');
  const { listConflictGroups, keepIncomingConflict } = await import('../src/utils/merge');
  let groups = await listConflictGroups();
  const gb2Group = groups.find((group) => group.table === 'greenBeans' && group.baseId === 'gb2');
  assert(Boolean(gb2Group), '合并中心能查到 gb2 冲突组');
  await keepIncomingConflict(gb2Group!);
  const gb2Resolved = await db.greenBeans.get('gb2');
  assert(gb2Resolved?.stockKg === 4.2 && gb2Resolved.origin.includes('对端改'), '采用对端后 gb2 主记录变为对端内容');
  assert(!gb2Resolved?.conflictOf, '裁决后冲突标记已清除');
  assert((gb2Resolved?.rev ?? 0) > 20250310, `裁决后 rev 推进（${gb2Resolved?.rev}）`);
  assert(!(await db.greenBeans.get('conflict:greenBeans:incoming:gb2')), '对端候选行已删除');
  groups = await listConflictGroups();
  assert(!groups.some((group) => group.baseId === 'gb2'), 'gb2 已不在待裁决列表');

  console.log(failures === 0 ? '\n端到端全部通过 ✅' : `\n${failures} 项失败 ❌`);
  if (failures > 0) process.exit(1);
}

void main();
