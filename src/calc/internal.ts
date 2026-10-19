/**
 * Small helpers shared by the calculation modules. Not part of the public API (the barrel does not
 * re-export this file); `usableValue` and `GAP_FACTOR` are re-exported from ./series.
 */
import type { Quality, Sample, StopRecord, Window } from './types';

/** A finite number: null, undefined, NaN and ±Infinity are not values here. */
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Sample qualities whose value a calculation must not use. 'uncertain' samples are still used. */
export const UNUSABLE_QUALITY: ReadonlySet<Quality> = new Set<Quality>(['bad', 'stale', 'missing']);

/**
 * The value of a sample a calculation may use, or null: no value, a non-finite value or timestamp, or a
 * bad / stale / missing quality flag. A sample without a quality flag counts as good.
 */
export const usableValue = (s: Sample): number | null => (isNum(s.t) && isNum(s.v) && !(s.q && UNUSABLE_QUALITY.has(s.q)) ? s.v : null);

/** A step between timestamps longer than GAP_FACTOR × the expected step is a gap (a missing sample). */
export const GAP_FACTOR = 1.5;

/** Samples in time order: a stable sorted copy without samples whose timestamp is not finite. */
export const byTime = (samples: Sample[]): Sample[] => samples.filter((s) => isNum(s.t)).sort((a, b) => a.t - b.t);

/** Typical sample step: the median of the positive timestamp differences (null with fewer than two timestamps). */
export function typicalStep(sorted: Sample[]): number | null {
  const steps: number[] = [];
  for (let i = 1; i < sorted.length; i++) if (sorted[i].t > sorted[i - 1].t) steps.push(sorted[i].t - sorted[i - 1].t);
  if (!steps.length) return null;
  steps.sort((a, b) => a - b);
  const mid = Math.floor(steps.length / 2);
  return steps.length % 2 ? steps[mid] : (steps[mid - 1] + steps[mid]) / 2;
}

/** Compact number for reasons and notes: at most `digits` decimals, no trailing zeros, no locale grouping. */
export const fmt = (n: number, digits = 2): string => String(Number(n.toFixed(digits)));

/** "1 stop" / "3 stops". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A window with finite bounds that is not empty. */
export const validWindow = (w: Window): boolean => isNum(w.from) && isNum(w.to) && w.to > w.from;

/** A stop record with usable times: a finite start and an end that is null (still open) or not before the start. */
export const validStop = (s: StopRecord): boolean => isNum(s.start) && (s.end == null || (isNum(s.end) && s.end >= s.start));

/** Whether a (valid) stop started inside the window [from, to). */
export const startsIn = (s: StopRecord, w: Window): boolean => validStop(s) && s.start >= w.from && s.start < w.to;

/** The part of a stop inside the window as [from, to] (an open stop runs to window.to); null when none. */
export function clipStop(s: StopRecord, w: Window): [number, number] | null {
  if (!validStop(s)) return null;
  const from = Math.max(s.start, w.from);
  const to = Math.min(s.end ?? w.to, w.to);
  return to > from ? [from, to] : null;
}

/** Minutes of a stop inside the window (0 outside it or for a malformed record). */
export const clippedMinutes = (s: StopRecord, w: Window): number => {
  const iv = clipStop(s, w);
  return iv ? iv[1] - iv[0] : 0;
};
