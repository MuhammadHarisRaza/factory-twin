import { describe, expect, it } from 'vitest';
import { flowBalance, massFromLevel, timeToEmpty, timeToFull, trendSlope, type LevelCalibration } from '../buffer';
import type { Sample } from '../types';

/** A level rising 0.5 %/min (30 %/h) from 50 %. */
const linear = (t: number) => 50 + 0.5 * t;

describe('trendSlope', () => {
  it('fits units per hour', () => {
    const r = trendSlope([0, 1, 2, 3, 4, 5].map((t) => ({ t, v: linear(t) })));
    expect(r.status).toBe('ok');
    expect(r.value).toBeCloseTo(30, 9);
  });

  it('is exact on linear data with nulls, missing timestamps and a bad-quality outlier', () => {
    const samples: Sample[] = [
      { t: 0, v: linear(0) },
      { t: 1, v: null },
      { t: 2, v: linear(2) },
      // t = 3…6 missing (timestamp gap)
      { t: 7, v: linear(7) },
      { t: 8, v: 999, q: 'bad' },
      { t: 9, v: 0, q: 'stale' },
      { t: 12, v: linear(12), q: 'uncertain' },
    ];
    const r = trendSlope(samples);
    expect(r.value).toBeCloseTo(30, 9);
    expect(r.status === 'ok' && r.note).toMatch(/3 samples without a good value ignored/);
  });

  it('gives a negative slope for a draining level', () => {
    const r = trendSlope([0, 10, 20, 30].map((t) => ({ t, v: 80 - t })));
    expect(r.value).toBeCloseTo(-60, 9);
  });

  it('fits noisy data around the true slope', () => {
    const noise = [0.3, -0.2, 0.1, -0.4, 0.2, 0.0, -0.1, 0.3, -0.2, 0.1];
    const r = trendSlope(noise.map((n, t) => ({ t: t * 5, v: 40 - 0.1 * t * 5 + n })));
    expect(r.value).toBeCloseTo(-6, 0);
  });

  const notOk: { name: string; samples: Sample[]; opts?: { minSamples?: number; minSpanMin?: number } }[] = [
    { name: 'no samples', samples: [] },
    { name: 'two samples (default minimum 3)', samples: [{ t: 0, v: 1 }, { t: 1, v: 2 }] },
    { name: 'three samples, all null', samples: [{ t: 0, v: null }, { t: 1, v: null }, { t: 2, v: null }] },
    { name: 'enough samples but all bad quality', samples: [0, 1, 2, 3].map((t) => ({ t, v: t, q: 'bad' as const })) },
    { name: 'all at the same timestamp (no division by zero)', samples: [{ t: 5, v: 1 }, { t: 5, v: 2 }, { t: 5, v: 3 }] },
    { name: 'span shorter than required', samples: [0, 1, 2].map((t) => ({ t, v: t })), opts: { minSpanMin: 10 } },
    { name: 'fewer than a custom minimum', samples: [0, 1, 2, 3].map((t) => ({ t, v: t })), opts: { minSamples: 5 } },
  ];
  it.each(notOk)('is insufficient for $name', ({ samples, opts }) => {
    const r = trendSlope(samples, opts);
    expect(r.status).toBe('insufficient');
    expect(r.value).toBeNull();
  });
});

describe('flowBalance', () => {
  const cases: { name: string; inflow: number | null; outflow: number | null; deadband?: number; status: string; net?: number; direction?: string }[] = [
    { name: 'filling', inflow: 1200, outflow: 1000, status: 'ok', net: 200, direction: 'filling' },
    { name: 'draining', inflow: 800, outflow: 1000, status: 'ok', net: -200, direction: 'draining' },
    { name: 'exactly balanced', inflow: 1000, outflow: 1000, status: 'ok', net: 0, direction: 'balanced' },
    { name: 'inside the deadband', inflow: 1010, outflow: 1000, deadband: 20, status: 'ok', net: 10, direction: 'balanced' },
    { name: 'just outside the deadband', inflow: 975, outflow: 1000, deadband: 20, status: 'ok', net: -25, direction: 'draining' },
    { name: 'both stopped is balanced at 0', inflow: 0, outflow: 0, status: 'ok', net: 0, direction: 'balanced' },
    { name: 'missing inflow', inflow: null, outflow: 1000, status: 'unavailable' },
    { name: 'missing outflow', inflow: 1000, outflow: null, status: 'unavailable' },
    { name: 'negative flow', inflow: -5, outflow: 1000, status: 'invalid' },
    { name: 'negative deadband', inflow: 5, outflow: 10, deadband: -1, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ inflow, outflow, deadband, status, net, direction }) => {
    const r = flowBalance(inflow, outflow, { deadband });
    expect(r.status).toBe(status);
    expect(r.value).toEqual(net === undefined ? null : { net, direction });
  });
});

describe('timeToEmpty / timeToFull', () => {
  const empty: { name: string; level: number | null; slope: number | null; emptyAt?: number; status: string; minutes?: number }[] = [
    { name: '60 % falling 30 %/h', level: 60, slope: -30, status: 'ok', minutes: 120 },
    { name: 'to a low-level trip at 10 %', level: 60, slope: -30, emptyAt: 10, status: 'ok', minutes: 100 },
    { name: 'already empty', level: 0, slope: -30, status: 'ok', minutes: 0 },
    { name: 'rising level never empties', level: 60, slope: 12, status: 'unavailable' },
    { name: 'steady level never empties', level: 60, slope: 0, status: 'unavailable' },
    { name: 'missing level', level: null, slope: -30, status: 'unavailable' },
    { name: 'missing trend', level: 60, slope: null, status: 'unavailable' },
  ];
  it.each(empty)('timeToEmpty: $name', ({ level, slope, emptyAt, status, minutes }) => {
    const r = timeToEmpty(level, slope, emptyAt);
    expect(r.status).toBe(status);
    if (minutes === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(minutes, 9);
  });

  const full: { name: string; level: number | null; slope: number | null; fullAt?: number; status: string; minutes?: number }[] = [
    { name: '60 % rising 20 %/h', level: 60, slope: 20, status: 'ok', minutes: 120 },
    { name: 'to a high-level limit at 90 %', level: 60, slope: 20, fullAt: 90, status: 'ok', minutes: 90 },
    { name: 'already full', level: 100, slope: 5, status: 'ok', minutes: 0 },
    { name: 'falling level never fills', level: 60, slope: -3, status: 'unavailable' },
    { name: 'steady level never fills', level: 60, slope: 1e-12, status: 'unavailable' },
    { name: 'missing level', level: null, slope: 20, status: 'unavailable' },
  ];
  it.each(full)('timeToFull: $name', ({ level, slope, fullAt, status, minutes }) => {
    const r = timeToFull(level, slope, fullAt);
    expect(r.status).toBe(status);
    if (minutes === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(minutes, 9);
  });

  it('explains a level moving away', () => {
    const r = timeToEmpty(60, 12);
    expect(r.status !== 'ok' && r.reason).toBe('Level is rising — not emptying');
  });
});

describe('massFromLevel', () => {
  const silo: LevelCalibration = {
    unit: 't',
    points: [
      [0, 0],
      [50, 40],
      [100, 100],
    ],
  };

  it('has no mass without a calibration', () => {
    expect(massFromLevel(55, null)).toEqual({ status: 'unavailable', value: null, reason: 'No level-to-mass calibration configured' });
  });

  const cases: { name: string; level: number | null; calibration: LevelCalibration; status: string; value?: number }[] = [
    { name: 'interpolates on the first segment', level: 25, calibration: silo, status: 'ok', value: 20 },
    { name: 'interpolates on the second segment', level: 75, calibration: silo, status: 'ok', value: 70 },
    { name: 'hits a calibration point', level: 50, calibration: silo, status: 'ok', value: 40 },
    { name: 'the top of the range', level: 100, calibration: silo, status: 'ok', value: 100 },
    { name: 'unsorted points', level: 25, calibration: { unit: 'kg', points: [[100, 1000], [0, 0]] }, status: 'ok', value: 250 },
    { name: 'missing level', level: null, calibration: silo, status: 'unavailable' },
    { name: 'outside the calibrated range is not extrapolated', level: 3, calibration: { unit: 't', points: [[5, 1], [95, 50]] }, status: 'unavailable' },
    { name: 'level above 100 %', level: 120, calibration: silo, status: 'invalid' },
    { name: 'a single point', level: 50, calibration: { unit: 't', points: [[50, 40]] }, status: 'invalid' },
    { name: 'two points at one level', level: 50, calibration: { unit: 't', points: [[0, 0], [50, 40], [50, 45]] }, status: 'invalid' },
    { name: 'mass falling with level', level: 50, calibration: { unit: 't', points: [[0, 10], [100, 5]] }, status: 'invalid' },
    { name: 'a non-finite point', level: 50, calibration: { unit: 't', points: [[0, 0], [100, Number.NaN]] }, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ level, calibration, status, value }) => {
    const r = massFromLevel(level, calibration);
    expect(r.status).toBe(status);
    if (value === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(value, 9);
  });

  it('notes the calibration and its unit', () => {
    const r = massFromLevel(25, silo);
    expect(r.status === 'ok' && r.note).toBe('From a 3-point level calibration (t)');
  });
});
