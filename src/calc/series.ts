/**
 * Sample and series utilities (brief §6B / §10): series → samples, timestamp gaps, out-of-range
 * readings and basic statistics. A null value is a gap, never a zero.
 */
import { ok, unavailable, type Calc, type Sample, type Series, type Window } from './types';
import { byTime, GAP_FACTOR, isNum, plural } from './internal';

export { GAP_FACTOR, usableValue } from './internal';

/**
 * The samples of a regularly stepped series from time `from` (inclusive) on. Timestamps come from
 * `series.t`; a series without timestamps (t shorter than v) is taken to start at `from` (or at t[0]) and
 * step by stepMin. A null value keeps its per-sample quality when that is bad / stale / missing, else gets
 * 'missing'; a non-finite value becomes null with quality 'bad'. Values with no quality flag are left
 * unflagged (treated as good downstream).
 */
export function seriesToSamples(series: Series, from: number): Sample[] {
  const base = series.t.length ? series.t[0] : from;
  const out: Sample[] = [];
  for (let i = 0; i < series.v.length; i++) {
    const t = series.t[i] ?? base + i * series.stepMin;
    if (!(t >= from)) continue;
    const raw = series.v[i];
    const q = series.q?.[i];
    if (isNum(raw)) out.push(q ? { t, v: raw, q } : { t, v: raw });
    // A null keeps a quality that can describe it (bad / stale / missing); 'good' or 'uncertain' cannot.
    else out.push({ t, v: null, q: raw != null ? 'bad' : q && q !== 'good' && q !== 'uncertain' ? q : 'missing' });
  }
  return out;
}

/**
 * Timestamp discontinuities: where consecutive samples (in time order, duplicates ignored) are more than
 * 1.5 × `expectedStepMin` apart. Each gap is the window of the missing samples, [previous t + step, next t).
 * Null values at present timestamps are not gaps here (see usableValue for those). A non-positive step gives [].
 */
export function gaps(samples: Sample[], expectedStepMin: number): Window[] {
  if (!isNum(expectedStepMin) || expectedStepMin <= 0) return [];
  const sorted = byTime(samples);
  const out: Window[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].t;
    const t = sorted[i].t;
    if (t - prev > expectedStepMin * GAP_FACTOR) out.push({ from: prev + expectedStepMin, to: t });
  }
  return out;
}

/**
 * Samples whose value lies below `min` or above `max` (engineering range; a missing bound is open).
 * Null values are not out of range (they are missing). Quality flags are not considered: this is a check on
 * the raw reading. No bound → [].
 */
export function outOfRange(samples: Sample[], min?: number, max?: number): Sample[] {
  if (!isNum(min) && !isNum(max)) return [];
  return samples.filter((s) => isNum(s.v) && ((isNum(min) && s.v < min) || (isNum(max) && s.v > max)));
}

/**
 * Count, mean, min and max of the finite values; nulls (gaps) are ignored and reported in the note.
 * No value at all → 'unavailable'.
 */
export function stats(values: (number | null)[]): Calc<{ n: number; mean: number; min: number; max: number }> {
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!isNum(v)) continue;
    n++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!n) return unavailable(values.length ? 'No values — every sample is missing' : 'No values');
  const skipped = values.length - n;
  return ok({ n, mean: sum / n, min, max }, skipped ? `${plural(skipped, 'missing value')} ignored` : undefined);
}
