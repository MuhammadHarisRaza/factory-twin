/**
 * Cumulative counters (brief §10): the step between two counter readings and a production rate built
 * from timestamped counter samples. PLC counters reset (power cycle, shift or batch reset, program
 * download) and roll over at their register size (2^16, 2^32); a step is classified before it is used,
 * so neither event is ever read as negative production or as a huge burst.
 */
import { insufficient, invalid, ok, type Calc, type Sample } from './types';
import { byTime, fmt, isNum, plural, usableValue } from './internal';

/** Register sizes of common PLC counters (the value after the maximum is 0). */
export const ROLLOVER_16 = 2 ** 16;
export const ROLLOVER_32 = 2 ** 32;

export type CounterEvent = 'normal' | 'reset' | 'rollover' | 'invalid' | 'missing';

export type CounterOptions = {
  /** Register size: the counter wraps to 0 when it reaches this value (e.g. ROLLOVER_16). null / absent = no rollover. */
  rolloverAt?: number | null;
  /** Largest increase that is physically possible between two readings; a larger step is 'invalid'. */
  maxPlausibleDelta?: number;
};

export type CounterDelta = { delta: number | null; event: CounterEvent };

export type CounterRate = { perHour: number; resets: number; rollovers: number; invalid: number };

/**
 * Units counted between two readings of a cumulative counter.
 *
 * - 'missing': either reading is null / not a finite number → delta null.
 * - 'normal': next ≥ prev → delta = next − prev (unless above maxPlausibleDelta → 'invalid').
 * - 'rollover': next < prev, a register size is configured and the wrapped step rolloverAt − prev + next is
 *   plausible (≤ maxPlausibleDelta, and never more than half the register) → delta = the wrapped step.
 * - 'reset': next < prev otherwise → the counter restarted from 0, delta = next (counts made before the
 *   reset within this step cannot be recovered). With maxPlausibleDelta, next must itself be plausible.
 * - 'invalid': a negative reading, a reading at or beyond the register size, or a step no reset or rollover
 *   explains (e.g. an implausible spike) → delta null.
 * Readings need not be integers (energy counters are fractional).
 */
export function counterDelta(prev: number | null, next: number | null, opts: CounterOptions = {}): CounterDelta {
  if (!isNum(prev) || !isNum(next)) return { delta: null, event: 'missing' };
  const bad: CounterDelta = { delta: null, event: 'invalid' };
  const roll = isNum(opts.rolloverAt) && opts.rolloverAt > 0 ? opts.rolloverAt : null;
  const max = isNum(opts.maxPlausibleDelta) && opts.maxPlausibleDelta >= 0 ? opts.maxPlausibleDelta : Infinity;
  if (prev < 0 || next < 0) return bad;
  if (roll !== null && (prev >= roll || next >= roll)) return bad;
  if (next >= prev) return next - prev <= max ? { delta: next - prev, event: 'normal' } : bad;
  if (roll !== null) {
    const wrapped = roll - prev + next;
    if (wrapped <= Math.min(max, roll / 2)) return { delta: wrapped, event: 'rollover' };
  }
  return next <= max ? { delta: next, event: 'reset' } : bad;
}

/**
 * Average rate (units per hour) from timestamped samples of a cumulative counter (`t` in plant minutes).
 *
 * Assumptions:
 * - Samples are sorted by time here; samples without a good value (null, non-finite, bad / stale / missing
 *   quality) are skipped. Because the counter is cumulative, counts made during a skipped sample or a
 *   timestamp gap are still captured by the next good reading.
 * - Every step goes through counterDelta. Resets and rollovers are counted and handled. An invalid step
 *   (e.g. a spike) is left out: the last trusted reading stays the reference, so a spike that comes back
 *   costs nothing; if the counter really jumped to a new level, the next consistent step re-anchors on it
 *   and the time between the trusted reading and the jump is excluded.
 * - The rate is Σ accepted deltas ÷ Σ the time those steps cover, so excluded time does not dilute it.
 * Not ok: fewer than two good samples or no elapsed time ('insufficient'); no plausible step ('invalid').
 */
export function counterRate(samples: Sample[], opts: CounterOptions = {}): Calc<CounterRate> {
  const good = byTime(samples).filter((s) => usableValue(s) !== null);
  const skipped = samples.length - good.length;
  if (good.length < 2) return insufficient(`Need at least two good counter samples (have ${good.length})`);
  let ref = good[0];
  let pending: Sample | null = null;
  let units = 0;
  let minutes = 0;
  let steps = 0;
  let resets = 0;
  let rollovers = 0;
  let bad = 0;
  for (const s of good.slice(1)) {
    let d = counterDelta(ref.v, s.v, opts);
    if (d.event === 'invalid' && pending) {
      const p = counterDelta(pending.v, s.v, opts);
      if (p.event === 'normal' || p.event === 'rollover') {
        ref = pending;
        d = p;
      }
    }
    if (d.delta === null) {
      bad++;
      pending = s;
      continue;
    }
    units += d.delta;
    minutes += s.t - ref.t;
    steps++;
    if (d.event === 'reset') resets++;
    if (d.event === 'rollover') rollovers++;
    ref = s;
    pending = null;
  }
  if (steps === 0) return invalid(`No plausible counter step (${plural(bad, 'implausible step')})`);
  if (minutes <= 0) return insufficient('Counter samples span no time');
  const notes = [
    resets ? `${plural(resets, 'counter reset')} (counts before a reset within its step are not recovered)` : '',
    rollovers ? plural(rollovers, 'rollover') : '',
    bad ? `${plural(bad, 'implausible step')} left out` : '',
    skipped ? `${plural(skipped, 'sample')} without a good value skipped` : '',
  ].filter(Boolean);
  const note = notes.length ? `${notes.join(' · ')} · rate over ${fmt(minutes)} min` : undefined;
  return ok({ perHour: (units * 60) / minutes, resets, rollovers, invalid: bad }, note);
}
