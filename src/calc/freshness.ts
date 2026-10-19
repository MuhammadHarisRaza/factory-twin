/**
 * Data freshness per signal (brief §5 / §10): how old the last value is against the signal's expected
 * update interval. Stale is never current: a consumer shows the age and does not treat the value as now.
 */
import { isNum } from './internal';

export type FreshnessStatus = 'fresh' | 'late' | 'stale' | 'missing' | 'event-driven';

export type Freshness = { ageS: number | null; status: FreshnessStatus };

/**
 * Age of the last update in seconds and its status. `lastUpdate` and `now` are plant minutes;
 * `expectedIntervalS` is in seconds (the catalogue's expectedUpdateIntervalS).
 *
 * - No last update (null) → 'missing', ageS null.
 * - No expected interval (null, ≤ 0) → 'event-driven': the age is reported but cannot be judged.
 * - age ≤ lateFactor × interval (default 2×) → 'fresh'; ≤ staleFactor × interval (default 5×) → 'late';
 *   older → 'stale'. The boundaries themselves are the better status.
 * A timestamp ahead of `now` (clock skew, rounding) counts as age 0. staleFactor is never below lateFactor.
 */
export function freshness(
  lastUpdate: number | null,
  now: number,
  expectedIntervalS: number | null,
  opts: { lateFactor?: number; staleFactor?: number } = {},
): Freshness {
  if (!isNum(lastUpdate) || !isNum(now)) return { ageS: null, status: 'missing' };
  const ageS = Math.max(0, Math.round((now - lastUpdate) * 60 * 1000) / 1000);
  if (!isNum(expectedIntervalS) || expectedIntervalS <= 0) return { ageS, status: 'event-driven' };
  const late = opts.lateFactor ?? 2;
  const stale = Math.max(late, opts.staleFactor ?? 5);
  if (ageS > stale * expectedIntervalS) return { ageS, status: 'stale' };
  if (ageS > late * expectedIntervalS) return { ageS, status: 'late' };
  return { ageS, status: 'fresh' };
}
