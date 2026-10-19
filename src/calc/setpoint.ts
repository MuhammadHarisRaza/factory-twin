/**
 * Process values against setpoints and limits (brief §7 / §10): the deviation now, the episodes where
 * the deviation exceeded a threshold, and the share of time inside limits. Samples without a good value
 * (null, bad / stale / missing quality) are never read as "within" or "deviating": they are gaps.
 */
import { invalid, ok, unavailable, type Calc, type Sample } from './types';
import { byTime, GAP_FACTOR, isNum, plural, typicalStep, usableValue } from './internal';

export type DeviationLevel = 'within' | 'warning' | 'alarm';

/** Warning / alarm thresholds on |PV − SP|, in engineering units. */
export type DeviationBand = { warn: number; alarm: number };

export type SetpointDeviation = { abs: number; rel: number; level: DeviationLevel };

export type DeviationEpisode = { from: number; to: number; minutes: number; maxAbs: number };

/**
 * Deviation of a process value from its setpoint: abs = PV − SP (signed, engineering units), rel = abs ÷ |SP|
 * (signed fraction). With a band, level is 'alarm' when |abs| > alarm, 'warning' when |abs| > warn, else
 * 'within'; without a band the level is not assessed (reported as 'within' with a note saying so — pass a
 * band before showing the level). Missing PV / SP or SP = 0 (relative deviation undefined) → 'unavailable';
 * a band that is not 0 ≤ warn ≤ alarm → 'invalid'.
 */
export function setpointDeviation(pv: number | null, sp: number | null, band?: DeviationBand): Calc<SetpointDeviation> {
  if (!isNum(pv)) return unavailable('Process value not reported');
  if (!isNum(sp)) return unavailable('Setpoint not reported');
  if (band && (!isNum(band.warn) || !isNum(band.alarm) || band.warn < 0 || band.alarm < band.warn))
    return invalid('Deviation band needs 0 ≤ warning ≤ alarm');
  if (sp === 0) return unavailable('Setpoint is 0 — relative deviation undefined');
  const abs = pv - sp;
  const mag = Math.abs(abs);
  const level: DeviationLevel = !band ? 'within' : mag > band.alarm ? 'alarm' : mag > band.warn ? 'warning' : 'within';
  return ok({ abs, rel: abs / Math.abs(sp), level }, band ? undefined : 'No warning / alarm band given — level not assessed');
}

/** The setpoint in force at time t: a constant, or the last SP sample at or before t (null when unknown or not good). */
function setpointAt(sp: Sample[] | number): (t: number) => number | null {
  if (!Array.isArray(sp)) return () => (isNum(sp) ? sp : null);
  const sorted = byTime(sp);
  return (t) => {
    let lo = 0;
    let hi = sorted.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].t <= t) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return at < 0 ? null : usableValue(sorted[at]);
  };
}

/**
 * Episodes where |PV − SP| stayed above `threshold`. `sp` is a constant or an SP series (step-held: the last
 * SP sample at or before each PV sample applies). Each PV sample stands for the time up to the next sample,
 * at most one sample step (`opts.stepMin`, default the median spacing, else 1 min); an episode is
 * [first deviating sample, end of the last deviating sample's interval). A PV sample without a good value,
 * an unknown SP, or a timestamp gap (> 1.5 steps) ends an episode — a deviation is not assumed to persist
 * through missing data. Only episodes of at least `minMinutes` (default 0) are returned, in time order.
 * maxAbs is the largest |PV − SP| in the episode. A negative or non-finite threshold gives [].
 */
export function deviationEpisodes(
  pv: Sample[],
  sp: Sample[] | number,
  threshold: number,
  opts: { minMinutes?: number; stepMin?: number } = {},
): DeviationEpisode[] {
  if (!isNum(threshold) || threshold < 0) return [];
  const pts = byTime(pv);
  if (!pts.length) return [];
  const step = isNum(opts.stepMin) && opts.stepMin > 0 ? opts.stepMin : (typicalStep(pts) ?? 1);
  const spAt = setpointAt(sp);
  const minMinutes = opts.minMinutes ?? 0;
  const out: DeviationEpisode[] = [];
  let cur: DeviationEpisode | null = null;
  const close = () => {
    if (cur) {
      cur.minutes = cur.to - cur.from;
      if (cur.minutes >= minMinutes) out.push(cur);
    }
    cur = null;
  };
  for (let i = 0; i < pts.length; i++) {
    const s = pts[i];
    const next = pts[i + 1];
    const end = next && next.t - s.t <= step * GAP_FACTOR ? next.t : s.t + step;
    const v = usableValue(s);
    const ref = spAt(s.t);
    const dev = v !== null && ref !== null ? Math.abs(v - ref) : null;
    if (dev === null || dev <= threshold) {
      close();
      continue;
    }
    if (cur && cur.to >= s.t) {
      cur.to = end;
      cur.maxAbs = Math.max(cur.maxAbs, dev);
    } else {
      close();
      cur = { from: s.t, to: end, minutes: 0, maxAbs: dev };
    }
  }
  close();
  return out;
}

/**
 * Share (0–1) of good samples inside the limits (inclusive; a missing side is open). Samples without a
 * good value are left out and reported in the note. No limit given → 'unavailable'; low > high → 'invalid';
 * no good sample → 'unavailable'.
 */
export function withinLimitsShare(samples: Sample[], limits: { low?: number; high?: number }): Calc<number> {
  const { low, high } = limits;
  if (!isNum(low) && !isNum(high)) return unavailable('No limits configured');
  if (isNum(low) && isNum(high) && low > high) return invalid('Low limit is above the high limit');
  let n = 0;
  let inside = 0;
  for (const s of samples) {
    const v = usableValue(s);
    if (v === null) continue;
    n++;
    if ((!isNum(low) || v >= low) && (!isNum(high) || v <= high)) inside++;
  }
  if (!n) return unavailable(samples.length ? 'No good-quality samples in the window' : 'No samples in the window');
  const skipped = samples.length - n;
  return ok(inside / n, skipped ? `${plural(skipped, 'sample')} without a good value left out` : undefined);
}
