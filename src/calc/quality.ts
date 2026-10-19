/**
 * Quality ratios (brief §10): reject rate, first-pass yield, and a two-proportion z-test that says
 * whether a change against a baseline is larger than sampling noise (a 'Statistical' rule basis).
 */
import { insufficient, invalid, ok, unavailable, type Calc } from './types';
import { fmt, isNum } from './internal';

export type ProportionChange = {
  /** Proportion in the current window (x ÷ n). */
  current: number;
  /** Proportion in the baseline window. */
  baseline: number;
  /** current − baseline (signed). */
  diff: number;
  /** Two-proportion z statistic (pooled standard error); positive when the current proportion is higher. */
  z: number;
  /** |z| ≥ the critical value (two-sided). */
  significant: boolean;
};

/** A ratio part ÷ whole of two counts, with the shared missing / zero / invalid handling. */
function countRatio(part: number | null, whole: number | null, labels: { part: string; whole: string; none: string }): Calc<number> {
  if (!isNum(part) || !isNum(whole)) return unavailable(`${labels.part} or ${labels.whole} count not reported`);
  if (part < 0 || whole < 0) return invalid('Negative count');
  if (whole === 0) return unavailable(labels.none);
  if (part > whole) return invalid(`${labels.part} count (${fmt(part)}) exceeds ${labels.whole} count (${fmt(whole)})`);
  return ok(part / whole);
}

/**
 * Reject rate = rejected ÷ inspected (a fraction). Nothing inspected or a missing count → 'unavailable'
 * (never 0 %); negative counts or more rejects than inspections → 'invalid'.
 */
export function rejectRate(rejected: number | null, inspected: number | null): Calc<number> {
  return countRatio(rejected, inspected, { part: 'Reject', whole: 'inspected', none: 'Nothing inspected — reject rate undefined' });
}

/**
 * First-pass yield = units good at the first pass ÷ all units assessed (a fraction). Same handling as
 * rejectRate: no units or a missing count → 'unavailable'; good above total or negative → 'invalid'.
 */
export function firstPassYield(firstPassGood: number | null, total: number | null): Calc<number> {
  return countRatio(firstPassGood, total, { part: 'First-pass good', whole: 'total', none: 'Nothing assessed — first-pass yield undefined' });
}

/**
 * Two-proportion z-test of current x/n against baseline x/n (e.g. rejects / inspected). Both windows need
 * at least `minN` units (default 200) or the result is 'insufficient'; `z` is the two-sided critical value
 * (default 1.96 ≈ 95 %). Assumes independent units and windows that do not overlap. When neither window
 * varies (all 0 or all 1) the standard error is 0: z = 0 and the change is not significant.
 */
export function proportionChange(
  current: { x: number; n: number },
  baseline: { x: number; n: number },
  opts: { minN?: number; z?: number } = {},
): Calc<ProportionChange> {
  const minN = opts.minN ?? 200;
  const zCrit = opts.z ?? 1.96;
  for (const [label, c] of [
    ['Current window', current],
    ['Baseline window', baseline],
  ] as const) {
    if (!c || !isNum(c.x) || !isNum(c.n)) return unavailable(`${label}: counts not reported`);
    if (c.x < 0 || c.n < 0 || c.x > c.n) return invalid(`${label}: ${fmt(c.x)} of ${fmt(c.n)} is not a valid proportion`);
  }
  if (!isNum(zCrit) || zCrit <= 0) return invalid('The critical z value must be positive');
  if (current.n < minN || baseline.n < minN)
    return insufficient(`Needs at least ${minN} in each window (current ${fmt(current.n)}, baseline ${fmt(baseline.n)})`);
  if (current.n === 0 || baseline.n === 0) return unavailable('Nothing counted in one of the windows');
  const p1 = current.x / current.n;
  const p0 = baseline.x / baseline.n;
  const pooled = (current.x + baseline.x) / (current.n + baseline.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / current.n + 1 / baseline.n));
  if (!(se > 0)) return ok({ current: p1, baseline: p0, diff: p1 - p0, z: 0, significant: false }, 'No variation in either window');
  const z = (p1 - p0) / se;
  return ok({ current: p1, baseline: p0, diff: p1 - p0, z, significant: Math.abs(z) >= zCrit });
}
