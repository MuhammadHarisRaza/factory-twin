/**
 * History charts of the live cards (equipment and stage panels), throttled with src/sim/live.ts: a chart set over a
 * range with 5-minute steps (8 h) is recomputed at most every 5 simulated minutes, an hourly one (24 h, 7 days) when the
 * hour changes; minute-step ranges (15 min, 1 h) every minute. Anything material (a stop, an event, a scenario, a feed)
 * recomputes at once. The card says "to hh:mm" while the charts end earlier than now.
 */
import { RANGE_BY_KEY, type RangeKey } from '../../../model/telemetry';
import type { SimState } from '../../../sim/engine';
import { liveValue, type Live } from '../../../sim/live';
import type { IntelCharts } from './types';

/** Whether charts over `range` computed at minute `at` still serve at `now`. */
export function chartsFresh(range: RangeKey, at: number, now: number): boolean {
  const r = RANGE_BY_KEY[range];
  if (r.resolution === 'hour') return Math.floor((at - 1) / 60) === Math.floor((now - 1) / 60);
  return r.stepMin > 1 && now - at < r.stepMin;
}

/** A live card's chart set (and whatever is computed with it over the same range, e.g. tile sparklines). */
export function liveCharts<T extends { charts: IntelCharts | null }>(s: SimState, name: string, key: string, wanted: RangeKey, compute: () => T): Live<T> {
  return liveValue(s, name, key, (at, now, v) => chartsFresh(v.charts?.range ?? wanted, at, now), compute);
}
