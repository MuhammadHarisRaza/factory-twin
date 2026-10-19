import { describe, expect, it } from 'vitest';
import { cycleTimeSec, histogram } from '../cycle';

describe('cycleTimeSec', () => {
  const cases: { name: string; units: number | null; run: number | null; perCycle?: number; status: string; value?: number }[] = [
    { name: '60 tiles in 30 min', units: 60, run: 30, status: 'ok', value: 30 },
    { name: 'two-cavity press: 240 tiles in 60 min = 120 strokes', units: 240, run: 60, perCycle: 2, status: 'ok', value: 30 },
    { name: 'missing units', units: null, run: 60, status: 'unavailable' },
    { name: 'missing run time', units: 10, run: null, status: 'unavailable' },
    { name: 'no units (cycle time undefined, not 0)', units: 0, run: 60, status: 'unavailable' },
    { name: 'units with no run time', units: 10, run: 0, status: 'invalid' },
    { name: 'negative units', units: -1, run: 60, status: 'invalid' },
    { name: 'zero units per cycle', units: 10, run: 60, perCycle: 0, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ units, run, perCycle, status, value }) => {
    const r = cycleTimeSec(units, run, perCycle);
    expect(r.status).toBe(status);
    if (value === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(value, 9);
  });
});

describe('histogram', () => {
  const tenToNineteen = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

  it('bins values and gives mean, median and 90th percentile', () => {
    const r = histogram(tenToNineteen, { binWidth: 2 });
    expect(r.status).toBe('ok');
    expect(r.value?.bins).toEqual([
      { from: 10, to: 12, count: 2 },
      { from: 12, to: 14, count: 2 },
      { from: 14, to: 16, count: 2 },
      { from: 16, to: 18, count: 2 },
      { from: 18, to: 20, count: 2 },
    ]);
    expect(r.value?.n).toBe(10);
    expect(r.value?.mean).toBeCloseTo(14.5, 9);
    expect(r.value?.p50).toBeCloseTo(14.5, 9);
    // Linear interpolation: position 0.9 × 9 = 8.1 → 18 + 0.1 × (19 − 18).
    expect(r.value?.p90).toBeCloseTo(18.1, 9);
  });

  const percentiles: { name: string; values: number[]; p50: number; p90: number }[] = [
    { name: 'odd count', values: [5, 1, 3, 2, 4], p50: 3, p90: 4.6 },
    { name: 'all equal', values: [15.3, 15.3, 15.3, 15.3, 15.3], p50: 15.3, p90: 15.3 },
    { name: 'skewed (one long cycle)', values: [15, 15, 15, 15, 15, 15, 15, 15, 15, 60], p50: 15, p90: 19.5 },
  ];
  it.each(percentiles)('percentiles: $name', ({ values, p50, p90 }) => {
    const r = histogram(values, { binWidth: 1 });
    expect(r.value?.p50).toBeCloseTo(p50, 9);
    expect(r.value?.p90).toBeCloseTo(p90, 9);
  });

  it('ignores nulls and says so', () => {
    const r = histogram([...tenToNineteen, null, null], { binWidth: 2 });
    expect(r.value?.n).toBe(10);
    expect(r.status === 'ok' && r.note).toMatch(/2 missing values ignored/);
  });

  it('leaves values outside an explicit range out and keeps Σ counts = n', () => {
    const r = histogram([...tenToNineteen, 2, 45], { binWidth: 5, min: 10, max: 20 });
    expect(r.value?.bins).toEqual([
      { from: 10, to: 15, count: 5 },
      { from: 15, to: 20, count: 5 },
    ]);
    expect(r.value?.n).toBe(10);
    expect(r.status === 'ok' && r.note).toMatch(/2 values outside the range/);
  });

  it('puts a value equal to max into the last bin and cuts the last bin at max', () => {
    const r = histogram([0, 1, 2, 3, 7], { binWidth: 3, min: 0, max: 7 });
    expect(r.value?.bins).toEqual([
      { from: 0, to: 3, count: 3 },
      { from: 3, to: 6, count: 1 },
      { from: 6, to: 7, count: 1 },
    ]);
  });

  it('starts the bin grid at an off-grid min without a narrow last bin', () => {
    const r = histogram([0.05, 0.1, 0.2, 0.3, 0.34], { binWidth: 0.1, min: 0.05 });
    expect(r.value?.bins.map((b) => [b.from, b.to, b.count])).toEqual([
      [0.05, 0.15, 2],
      [0.15, 0.25, 1],
      [0.25, 0.35, 2],
    ]);
  });

  it('keeps decimal bin edges clean', () => {
    const r = histogram([0.1, 0.2, 0.3, 0.3, 0.45], { binWidth: 0.1 });
    expect(r.value?.bins.map((b) => [b.from, b.to, b.count])).toEqual([
      [0.1, 0.2, 1],
      [0.2, 0.3, 1],
      [0.3, 0.4, 2],
      [0.4, 0.5, 1],
    ]);
  });

  const notOk: { name: string; values: (number | null)[]; opts: Parameters<typeof histogram>[1]; status: string }[] = [
    { name: 'too few values', values: [1, 2, 3], opts: { binWidth: 1 }, status: 'insufficient' },
    { name: 'only nulls', values: [null, null, null, null, null, null], opts: { binWidth: 1 }, status: 'insufficient' },
    { name: 'below a custom minimum', values: tenToNineteen, opts: { binWidth: 1, minSamples: 20 }, status: 'insufficient' },
    { name: 'zero bin width', values: tenToNineteen, opts: { binWidth: 0 }, status: 'invalid' },
    { name: 'negative bin width', values: tenToNineteen, opts: { binWidth: -1 }, status: 'invalid' },
    { name: 'empty range', values: tenToNineteen, opts: { binWidth: 1, min: 20, max: 10 }, status: 'invalid' },
    { name: 'too many bins', values: [0, 1, 2, 3, 1e6], opts: { binWidth: 1 }, status: 'invalid' },
  ];
  it.each(notOk)('is not ok for $name', ({ values, opts, status }) => {
    const r = histogram(values, opts);
    expect(r.status).toBe(status);
    expect(r.value).toBeNull();
  });
});
