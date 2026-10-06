/**
 * 合并落地后的派生值重算：
 * - 曲线节点的分段 RoR（相邻节点按时间重算，首个节点为 0）
 * - 杯测分项一更新就重算加权总分
 * - 生豆余量按「已完成」烘焙记录统一再算一次，避免两边各扣一遍
 * 纯函数，输入合并后的全量行，输出重算后的新数组（不修改入参）。
 */
import type { GreenBean } from '../types/greenbean';
import type { RoastProfile } from '../types/roastprofile';
import type { RoastEvent } from '../types/event';
import type { Cupping } from '../types/cupping';
import { partsOf, weightedTotalScore } from '../types/cupping';
import { roundKg } from './db';
import { rorPerMinBetween, sortEventsByTime } from './curve';

/** 重算一批曲线事件的分段 RoR：同一条烘焙记录内按 atSec 升序，逐段相邻计算 */
export function recomputeEventRors(events: RoastEvent[]): RoastEvent[] {
  const grouped = new Map<string, RoastEvent[]>();
  events.forEach((event) => {
    const list = grouped.get(event.profileId) ?? [];
    list.push({ ...event });
    grouped.set(event.profileId, list);
  });
  const result: RoastEvent[] = [];
  grouped.forEach((list) => {
    const sorted = sortEventsByTime(list);
    sorted.forEach((event, index) => {
      const prev = sorted[index - 1];
      event.rorPerMin = prev
        ? rorPerMinBetween(prev.atSec, prev.beanTempC, event.atSec, event.beanTempC)
        : 0;
    });
    result.push(...sorted);
  });
  return result;
}

/** 重算杯测加权总分：分项一旦在合并中变化，总分必须跟着重算 */
export function recomputeCuppingTotals(cuppings: Cupping[]): Cupping[] {
  return cuppings.map((cupping) => ({ ...cupping, totalScore: weightedTotalScore(partsOf(cupping)) }));
}

/**
 * 按已完成烘焙记录重算每批生豆余量，避免两份档案各扣一遍。
 * 思路：分别还原两边「到货总量基线」（当前余量 + 该边已扣载量），取较大者，
 * 再扣除两边已完成记录并集的载量——每条已完成记录在合并结果里恰好扣一次。
 * 作废 / 记录中不扣；冲突候选行不参与。
 */
export interface RecomputeStockInput {
  mergedBeans: GreenBean[];
  localBeans: GreenBean[];
  incomingBeans: GreenBean[];
  mergedProfiles: RoastProfile[];
  /** 本端合并前已有烘焙记录 id（区分已完成记录归属哪一边） */
  localProfileIds: ReadonlySet<string>;
}

export function recomputeBeanStock(input: RecomputeStockInput): {
  beans: GreenBean[];
  negativeStockBeanIds: string[];
} {
  const { mergedBeans, localBeans, incomingBeans, mergedProfiles, localProfileIds } = input;
  const localBeanMap = new Map(localBeans.filter((bean) => !bean.conflictOf).map((bean) => [bean.id, bean]));
  const incomingBeanMap = new Map(incomingBeans.filter((bean) => !bean.conflictOf).map((bean) => [bean.id, bean]));

  // 每条已完成（非候选）记录按生豆归类，并标记归属边
  const unionByBean = new Map<string, number>();
  const localDoneByBean = new Map<string, number>();
  const incomingDoneByBean = new Map<string, number>();
  mergedProfiles.forEach((profile) => {
    if (profile.conflictOf || profile.state !== 'done') return;
    const grams = Number(profile.chargeG);
    if (!Number.isFinite(grams) || grams <= 0) return;
    unionByBean.set(profile.greenBeanId, (unionByBean.get(profile.greenBeanId) ?? 0) + grams);
    const bucket = localProfileIds.has(profile.id) ? localDoneByBean : incomingDoneByBean;
    bucket.set(profile.greenBeanId, (bucket.get(profile.greenBeanId) ?? 0) + grams);
  });

  const negativeStockBeanIds: string[] = [];
  const canonical = mergedBeans
    .filter((bean) => !bean.conflictOf)
    .map((bean) => {
      const unionKg = roundKg((unionByBean.get(bean.id) ?? 0) / 1000);
      const localBean = localBeanMap.get(bean.id);
      const incomingBean = incomingBeanMap.get(bean.id);
      // 该生豆只存在于一边时，基线就是那一边的「余量 + 已扣」
      const grossLocal = localBean ? roundKg(localBean.stockKg + roundKg((localDoneByBean.get(bean.id) ?? 0) / 1000)) : null;
      const grossIncoming = incomingBean
        ? roundKg(incomingBean.stockKg + roundKg((incomingDoneByBean.get(bean.id) ?? 0) / 1000))
        : null;
      const candidates = [grossLocal, grossIncoming].filter((value): value is number => value !== null);
      if (candidates.length === 0) return bean;
      const gross = Math.max(...candidates);
      const nextKg = roundKg(gross - unionKg);
      if (nextKg + 1e-6 < 0) negativeStockBeanIds.push(bean.id);
      return { ...bean, stockKg: nextKg };
    });

  // 冲突候选行原样保留（不参与余量重算），交回合并中心裁决
  const candidates = mergedBeans.filter((bean) => bean.conflictOf);
  return { beans: [...canonical, ...candidates], negativeStockBeanIds };
}

/**
 * 入库容量预检：合并前先看生豆在库余量。
 * 对本端已有的生豆，若对端新增的已完成烘焙所需豆量超过当前余量，则拒绝整单入库。
 * 对端独有的生豆直接随档案补进来，其已完成扣减已体现在对端余量里，不受预检限制。
 */
export interface StockPrecheckShortage {
  greenBeanId: string;
  origin: string;
  farm: string;
  requiredKg: number;
  availableKg: number;
  shortKg: number;
}

export function precheckStockCapacity(
  localBeans: GreenBean[],
  incomingProfiles: RoastProfile[],
  localProfileIds: ReadonlySet<string>,
): StockPrecheckShortage[] {
  const beanMap = new Map(localBeans.filter((bean) => !bean.conflictOf).map((bean) => [bean.id, bean]));
  const needByBean = new Map<string, number>();
  incomingProfiles.forEach((profile) => {
    if (profile.state !== 'done') return;
    if (localProfileIds.has(profile.id)) return;
    if (!beanMap.has(profile.greenBeanId)) return;
    const grams = Number(profile.chargeG);
    if (!Number.isFinite(grams) || grams <= 0) return;
    needByBean.set(profile.greenBeanId, (needByBean.get(profile.greenBeanId) ?? 0) + grams);
  });

  const shortages: StockPrecheckShortage[] = [];
  needByBean.forEach((grams, beanId) => {
    const bean = beanMap.get(beanId);
    if (!bean) return;
    const requiredKg = roundKg(grams / 1000);
    const availableKg = roundKg(bean.stockKg);
    if (availableKg + 1e-6 < requiredKg) {
      shortages.push({
        greenBeanId: bean.id,
        origin: bean.origin,
        farm: bean.farm,
        requiredKg,
        availableKg,
        shortKg: roundKg(requiredKg - availableKg),
      });
    }
  });
  return shortages;
}
