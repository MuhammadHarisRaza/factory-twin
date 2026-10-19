/**
 * Production rate and variance against a target (brief §10). Rates are per hour; durations are minutes.
 */
import { invalid, ok, unavailable, type Calc } from './types';
import { fmt, isNum } from './internal';

/**
 * Units per hour from a count over a duration (count × 60 ÷ minutes). A genuine 0 count over a real
 * duration is a rate of 0. Missing inputs or zero elapsed time → 'unavailable'; negative inputs → 'invalid'.
 */
export function productionRate(count: number | null, minutes: number | null): Calc<number> {
  if (!isNum(count) || !isNum(minutes)) return unavailable('Count or elapsed time not reported');
  if (count < 0) return invalid(`Negative count (${fmt(count)})`);
  if (minutes < 0) return invalid(`Negative duration (${fmt(minutes)} min)`);
  if (minutes === 0) return unavailable('No elapsed time — rate undefined');
  return ok((count / minutes) * 60);
}

/**
 * Variance of an actual value against its target: abs = actual − target (signed, in the value's unit) and
 * rel = abs ÷ |target| (signed fraction; −0.1 = 10 % below target). Missing values or a zero target
 * (relative variance undefined) → 'unavailable'.
 */
export function varianceVsTarget(actual: number | null, target: number | null): Calc<{ abs: number; rel: number }> {
  if (!isNum(actual)) return unavailable('Actual value not reported');
  if (!isNum(target)) return unavailable('No target set');
  if (target === 0) return unavailable('Target is zero — relative variance undefined');
  const abs = actual - target;
  return ok({ abs, rel: abs / Math.abs(target) });
}
