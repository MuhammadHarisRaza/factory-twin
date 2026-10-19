import { describe, expect, it } from 'vitest';
import { gaps, outOfRange, seriesToSamples, stats, usableValue } from '../series';
import type { Sample, Series, Window } from '../types';

describe('seriesToSamples', () => {
  const series: Series = { t: [10, 11, 12, 13, 14], v: [1, null, 3, 4, Number.NaN], q: ['good', 'missing', 'good', 'stale', 'good'], stepMin: 1, unit: '°C' };

  it('keeps timestamps, values and quality from the window start on', () => {
    expect(seriesToSamples(series, 12)).toEqual([
      { t: 12, v: 3, q: 'good' },
      { t: 13, v: 4, q: 'stale' },
      { t: 14, v: null, q: 'bad' },
    ]);
  });

  const cases: { name: string; series: Series; from: number; want: Sample[] }[] = [
    {
      name: 'a null without quality becomes missing, never 0',
      series: { t: [0, 1], v: [5, null], stepMin: 1, unit: null },
      from: 0,
      want: [
        { t: 0, v: 5 },
        { t: 1, v: null, q: 'missing' },
      ],
    },
    {
      name: 'a null flagged good is not good',
      series: { t: [0, 1], v: [null, null], q: ['good', 'stale'], stepMin: 1, unit: null },
      from: 0,
      want: [
        { t: 0, v: null, q: 'missing' },
        { t: 1, v: null, q: 'stale' },
      ],
    },
    {
      name: 'a non-finite value becomes a bad null',
      series: { t: [0], v: [Number.POSITIVE_INFINITY], stepMin: 1, unit: null },
      from: 0,
      want: [{ t: 0, v: null, q: 'bad' }],
    },
    {
      name: 'a series without timestamps starts at `from`',
      series: { t: [], v: [1, 2, 3], stepMin: 5, unit: null },
      from: 60,
      want: [
        { t: 60, v: 1 },
        { t: 65, v: 2 },
        { t: 70, v: 3 },
      ],
    },
    { name: 'a window after the series', series: { t: [0, 1], v: [1, 2], stepMin: 1, unit: null }, from: 5, want: [] },
  ];
  it.each(cases)('$name', ({ series: s, from, want }) => {
    expect(seriesToSamples(s, from)).toEqual(want);
  });

  it('keeps the NaN from the series as a gap', () => {
    const samples = seriesToSamples(series, 0);
    expect(samples.map((s) => s.v)).toEqual([1, null, 3, 4, null]);
  });
});

describe('usableValue', () => {
  const cases: { name: string; sample: Sample; want: number | null }[] = [
    { name: 'no quality flag counts as good', sample: { t: 0, v: 5 }, want: 5 },
    { name: 'good', sample: { t: 0, v: 5, q: 'good' }, want: 5 },
    { name: 'uncertain is still used', sample: { t: 0, v: 5, q: 'uncertain' }, want: 5 },
    { name: 'bad', sample: { t: 0, v: 5, q: 'bad' }, want: null },
    { name: 'stale', sample: { t: 0, v: 5, q: 'stale' }, want: null },
    { name: 'missing', sample: { t: 0, v: 5, q: 'missing' }, want: null },
    { name: 'null value', sample: { t: 0, v: null }, want: null },
    { name: 'NaN value', sample: { t: 0, v: Number.NaN }, want: null },
    { name: 'non-finite timestamp', sample: { t: Number.NaN, v: 5 }, want: null },
    { name: 'zero is a value', sample: { t: 0, v: 0 }, want: 0 },
  ];
  it.each(cases)('$name', ({ sample, want }) => {
    expect(usableValue(sample)).toBe(want);
  });
});

describe('gaps', () => {
  const at = (...ts: number[]): Sample[] => ts.map((t) => ({ t, v: 1 }));
  const cases: { name: string; samples: Sample[]; step: number; want: Window[] }[] = [
    { name: 'regular minute data', samples: at(0, 1, 2, 3), step: 1, want: [] },
    { name: 'two samples missing', samples: at(0, 1, 2, 5, 6), step: 1, want: [{ from: 3, to: 5 }] },
    { name: 'several gaps, unsorted input', samples: at(20, 0, 10, 5), step: 5, want: [{ from: 15, to: 20 }] },
    { name: 'small jitter is not a gap', samples: at(0, 1.2, 2, 3.4), step: 1, want: [] },
    { name: 'duplicates are not gaps', samples: at(0, 1, 1, 2), step: 1, want: [] },
    { name: 'a null value at a present timestamp is not a timestamp gap', samples: [{ t: 0, v: 1 }, { t: 1, v: null }, { t: 2, v: 1 }], step: 1, want: [] },
    { name: 'a non-positive step', samples: at(0, 10), step: 0, want: [] },
    { name: 'no samples', samples: [], step: 1, want: [] },
  ];
  it.each(cases)('$name', ({ samples, step, want }) => {
    expect(gaps(samples, step)).toEqual(want);
  });
});

describe('outOfRange', () => {
  const samples: Sample[] = [
    { t: 0, v: -5 },
    { t: 1, v: 0 },
    { t: 2, v: 650 },
    { t: 3, v: 701 },
    { t: 4, v: null },
    { t: 5, v: 9999, q: 'bad' },
  ];
  const cases: { name: string; min?: number; max?: number; ts: number[] }[] = [
    { name: 'engineering range 0–700', min: 0, max: 700, ts: [0, 3, 5] },
    { name: 'upper bound only', max: 700, ts: [3, 5] },
    { name: 'lower bound only', min: 0, ts: [0] },
    { name: 'no bounds', ts: [] },
  ];
  it.each(cases)('$name', ({ min, max, ts }) => {
    expect(outOfRange(samples, min, max).map((s) => s.t)).toEqual(ts);
  });
});

describe('stats', () => {
  const cases: { name: string; values: (number | null)[]; status: string; value?: { n: number; mean: number; min: number; max: number } }[] = [
    { name: 'plain values', values: [2, 4, 6], status: 'ok', value: { n: 3, mean: 4, min: 2, max: 6 } },
    { name: 'nulls are ignored, not zeros', values: [2, null, 6, null], status: 'ok', value: { n: 2, mean: 4, min: 2, max: 6 } },
    { name: 'zero is a value', values: [0, 0], status: 'ok', value: { n: 2, mean: 0, min: 0, max: 0 } },
    { name: 'negative values', values: [-3, 3], status: 'ok', value: { n: 2, mean: 0, min: -3, max: 3 } },
    { name: 'no values', values: [], status: 'unavailable' },
    { name: 'all missing', values: [null, null], status: 'unavailable' },
  ];
  it.each(cases)('$name', ({ values, status, value }) => {
    const r = stats(values);
    expect(r.status).toBe(status);
    expect(r.value).toEqual(value ?? null);
  });

  it('notes the ignored gaps', () => {
    const r = stats([1, null, 3]);
    expect(r.status === 'ok' && r.note).toBe('1 missing value ignored');
  });
});
