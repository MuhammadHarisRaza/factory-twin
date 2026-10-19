import { describe, expect, it } from 'vitest';
import { counterDelta, counterRate, ROLLOVER_16, ROLLOVER_32, type CounterDelta, type CounterOptions } from '../counter';
import type { Sample } from '../types';

/** One sample per minute from t = 0. */
const perMinute = (...values: (number | null)[]): Sample[] => values.map((v, t) => ({ t, v }));

describe('counterDelta', () => {
  const cases: { name: string; prev: number | null; next: number | null; opts?: CounterOptions; want: CounterDelta }[] = [
    { name: 'normal increase', prev: 100, next: 112, want: { delta: 12, event: 'normal' } },
    { name: 'no change is a genuine 0', prev: 100, next: 100, want: { delta: 0, event: 'normal' } },
    { name: 'fractional energy counter', prev: 10.25, next: 10.75, want: { delta: 0.5, event: 'normal' } },
    { name: 'missing previous reading', prev: null, next: 5, want: { delta: null, event: 'missing' } },
    { name: 'missing next reading', prev: 5, next: null, want: { delta: null, event: 'missing' } },
    { name: 'NaN is missing, not zero', prev: Number.NaN, next: 5, want: { delta: null, event: 'missing' } },
    { name: 'reset without a register size', prev: 5000, next: 3, want: { delta: 3, event: 'reset' } },
    { name: 'reset to exactly 0', prev: 5000, next: 0, want: { delta: 0, event: 'reset' } },
    { name: 'rollover at 2^16', prev: 65530, next: 4, opts: { rolloverAt: ROLLOVER_16 }, want: { delta: 10, event: 'rollover' } },
    { name: 'rollover at 2^16 from the top value', prev: 65535, next: 0, opts: { rolloverAt: ROLLOVER_16 }, want: { delta: 1, event: 'rollover' } },
    { name: 'rollover at 2^32', prev: 4294967290, next: 6, opts: { rolloverAt: ROLLOVER_32 }, want: { delta: 12, event: 'rollover' } },
    { name: 'drop low in a 2^16 range is a reset', prev: 5000, next: 3, opts: { rolloverAt: ROLLOVER_16 }, want: { delta: 3, event: 'reset' } },
    { name: 'drop low in a 2^32 range is a reset', prev: 1_000_000, next: 25, opts: { rolloverAt: ROLLOVER_32 }, want: { delta: 25, event: 'reset' } },
    {
      name: 'rollover when the wrapped step is plausible',
      prev: 65500,
      next: 20,
      opts: { rolloverAt: ROLLOVER_16, maxPlausibleDelta: 100 },
      want: { delta: 56, event: 'rollover' },
    },
    {
      name: 'reset when the wrapped step would be implausible',
      prev: 30000,
      next: 20,
      opts: { rolloverAt: ROLLOVER_16, maxPlausibleDelta: 100 },
      want: { delta: 20, event: 'reset' },
    },
    { name: 'implausible jump up (spike)', prev: 100, next: 100000, opts: { maxPlausibleDelta: 1000 }, want: { delta: null, event: 'invalid' } },
    { name: 'drop explained by neither reset nor rollover', prev: 5000, next: 3000, opts: { maxPlausibleDelta: 100 }, want: { delta: null, event: 'invalid' } },
    { name: 'negative reading', prev: -1, next: 5, want: { delta: null, event: 'invalid' } },
    { name: 'reading beyond the register size', prev: 70000, next: 70010, opts: { rolloverAt: ROLLOVER_16 }, want: { delta: null, event: 'invalid' } },
  ];
  it.each(cases)('$name', ({ prev, next, opts, want }) => {
    expect(counterDelta(prev, next, opts)).toEqual(want);
  });
});

describe('counterRate', () => {
  it('turns a steady counter into units per hour', () => {
    const r = counterRate(perMinute(100, 110, 120, 130));
    expect(r).toEqual({ status: 'ok', value: { perHour: 600, resets: 0, rollovers: 0, invalid: 0 } });
  });

  it('counts through a timestamp gap (the counter keeps counting)', () => {
    const r = counterRate([
      { t: 0, v: 100 },
      { t: 1, v: 110 },
      { t: 10, v: 200 },
    ]);
    expect(r.value?.perHour).toBe(600);
  });

  it('sorts samples by time first', () => {
    const r = counterRate([
      { t: 2, v: 120 },
      { t: 0, v: 100 },
      { t: 1, v: 110 },
    ]);
    expect(r.value?.perHour).toBe(600);
  });

  const cases: { name: string; samples: Sample[]; opts?: CounterOptions; perHour: number; resets?: number; rollovers?: number; invalid?: number }[] = [
    { name: 'a reset mid-window is handled, not negative', samples: perMinute(100, 110, 5, 15), perHour: 500, resets: 1 },
    { name: 'rollover at 2^16', samples: perMinute(65530, 65535, 4, 9), opts: { rolloverAt: ROLLOVER_16 }, perHour: 300, rollovers: 1 },
    { name: 'rollover at 2^32', samples: perMinute(4294967290, 4294967295, 4, 9), opts: { rolloverAt: ROLLOVER_32 }, perHour: 300, rollovers: 1 },
    {
      name: 'a spike that comes back costs nothing',
      samples: perMinute(100, 100000, 120, 130),
      opts: { maxPlausibleDelta: 1000 },
      perHour: 600,
      invalid: 1,
    },
    {
      name: 'a real jump to a new level re-anchors on the next consistent step',
      samples: perMinute(100, 100000, 100010, 100020),
      opts: { maxPlausibleDelta: 1000 },
      perHour: 600,
      invalid: 1,
    },
  ];
  it.each(cases)('$name', ({ samples, opts, perHour, resets = 0, rollovers = 0, invalid = 0 }) => {
    const r = counterRate(samples, opts);
    expect(r.status).toBe('ok');
    const { perHour: got, ...events } = r.value!;
    expect(got).toBeCloseTo(perHour, 9);
    expect(events).toEqual({ resets, rollovers, invalid });
  });

  it('skips bad, stale and missing samples but keeps the counts across them', () => {
    const r = counterRate([
      { t: 0, v: 100 },
      { t: 1, v: 999, q: 'bad' },
      { t: 2, v: 110, q: 'stale' },
      { t: 3, v: null },
      { t: 4, v: 140, q: 'good' },
    ]);
    expect(r.value?.perHour).toBe(600);
    expect(r.status === 'ok' && r.note).toMatch(/3 samples without a good value skipped/);
  });

  const notOk: { name: string; samples: Sample[]; opts?: CounterOptions; status: string }[] = [
    { name: 'no samples', samples: [], status: 'insufficient' },
    { name: 'one sample', samples: perMinute(100), status: 'insufficient' },
    { name: 'only nulls', samples: perMinute(null, null, null), status: 'insufficient' },
    { name: 'one good sample among bad ones', samples: [{ t: 0, v: 1 }, { t: 1, v: 2, q: 'bad' }], status: 'insufficient' },
    { name: 'samples at the same minute', samples: [{ t: 5, v: 100 }, { t: 5, v: 110 }], status: 'insufficient' },
    { name: 'every step implausible', samples: perMinute(100, 100000, 5000000), opts: { maxPlausibleDelta: 1000 }, status: 'invalid' },
  ];
  it.each(notOk)('is not ok for $name', ({ samples, opts, status }) => {
    const r = counterRate(samples, opts);
    expect(r.status).toBe(status);
    expect(r.value).toBeNull();
  });
});
