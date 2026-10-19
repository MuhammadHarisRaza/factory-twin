import { describe, expect, it } from 'vitest';
import { deviationEpisodes, setpointDeviation, withinLimitsShare, type DeviationBand, type DeviationEpisode } from '../setpoint';
import type { Sample } from '../types';

describe('setpointDeviation', () => {
  const band: DeviationBand = { warn: 10, alarm: 20 };
  const cases: { name: string; pv: number | null; sp: number | null; band?: DeviationBand; status: string; abs?: number; rel?: number; level?: string }[] = [
    { name: 'on setpoint', pv: 1195, sp: 1195, band, status: 'ok', abs: 0, rel: 0, level: 'within' },
    { name: 'inside the warning band', pv: 1203, sp: 1195, band, status: 'ok', abs: 8, rel: 8 / 1195, level: 'within' },
    { name: 'exactly at the warning limit is within', pv: 1205, sp: 1195, band, status: 'ok', abs: 10, rel: 10 / 1195, level: 'within' },
    { name: 'above: warning', pv: 1210, sp: 1195, band, status: 'ok', abs: 15, rel: 15 / 1195, level: 'warning' },
    { name: 'below: warning (signed abs)', pv: 1180, sp: 1195, band, status: 'ok', abs: -15, rel: -15 / 1195, level: 'warning' },
    { name: 'alarm', pv: 1170, sp: 1195, band, status: 'ok', abs: -25, rel: -25 / 1195, level: 'alarm' },
    { name: 'missing PV (no value is not "within")', pv: null, sp: 1195, band, status: 'unavailable' },
    { name: 'missing SP', pv: 1195, sp: null, band, status: 'unavailable' },
    { name: 'SP 0: relative deviation undefined', pv: 3, sp: 0, band, status: 'unavailable' },
    { name: 'band with alarm inside warning', pv: 1195, sp: 1195, band: { warn: 20, alarm: 10 }, status: 'invalid' },
    { name: 'negative band', pv: 1195, sp: 1195, band: { warn: -1, alarm: 10 }, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ pv, sp, band: b, status, abs, rel, level }) => {
    const r = setpointDeviation(pv, sp, b);
    expect(r.status).toBe(status);
    if (abs === undefined) expect(r.value).toBeNull();
    else {
      expect(r.value?.abs).toBeCloseTo(abs, 9);
      expect(r.value?.rel).toBeCloseTo(rel!, 12);
      expect(r.value?.level).toBe(level);
    }
  });

  it('says the level was not assessed without a band', () => {
    const r = setpointDeviation(1250, 1195);
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.note).toMatch(/level not assessed/);
  });
});

describe('deviationEpisodes', () => {
  /** Minute samples from t = 0 with PV values (null = no value). */
  const minutes = (...values: (number | null)[]): Sample[] => values.map((v, t) => ({ t, v }));
  const SP = 100;

  type Case = { name: string; pv: Sample[]; sp?: Sample[] | number; threshold?: number; opts?: { minMinutes?: number; stepMin?: number }; want: DeviationEpisode[] };
  const cases: Case[] = [
    { name: 'no deviation', pv: minutes(100, 101, 99, 102), want: [] },
    { name: 'one episode of three minutes', pv: minutes(100, 106, 108, 107, 100), want: [{ from: 1, to: 4, minutes: 3, maxAbs: 8 }] },
    { name: 'deviation on both sides counts (|PV − SP|)', pv: minutes(100, 94, 92, 100), want: [{ from: 1, to: 3, minutes: 2, maxAbs: 8 }] },
    { name: 'exactly at the threshold is not a deviation', pv: minutes(100, 105, 105, 100), want: [] },
    { name: 'still deviating at the end of the data', pv: minutes(100, 100, 107, 109), want: [{ from: 2, to: 4, minutes: 2, maxAbs: 9 }] },
    {
      name: 'two episodes',
      pv: minutes(110, 110, 100, 100, 120, 100),
      want: [
        { from: 0, to: 2, minutes: 2, maxAbs: 10 },
        { from: 4, to: 5, minutes: 1, maxAbs: 20 },
      ],
    },
    {
      name: 'minMinutes drops the short one',
      pv: minutes(110, 110, 100, 100, 120, 100),
      opts: { minMinutes: 2 },
      want: [{ from: 0, to: 2, minutes: 2, maxAbs: 10 }],
    },
    {
      name: 'a missing value ends the episode (not assumed to persist)',
      pv: minutes(110, 110, null, 110, 100),
      want: [
        { from: 0, to: 2, minutes: 2, maxAbs: 10 },
        { from: 3, to: 4, minutes: 1, maxAbs: 10 },
      ],
    },
    {
      name: 'a bad or stale sample ends the episode',
      pv: [
        { t: 0, v: 110 },
        { t: 1, v: 110, q: 'stale' },
        { t: 2, v: 110, q: 'bad' },
        { t: 3, v: 110, q: 'uncertain' },
      ],
      want: [
        { from: 0, to: 1, minutes: 1, maxAbs: 10 },
        { from: 3, to: 4, minutes: 1, maxAbs: 10 },
      ],
    },
    {
      name: 'a timestamp gap ends the episode',
      pv: [
        { t: 0, v: 110 },
        { t: 1, v: 110 },
        { t: 2, v: 110 },
        { t: 6, v: 110 },
        { t: 7, v: 110 },
      ],
      want: [
        { from: 0, to: 3, minutes: 3, maxAbs: 10 },
        { from: 6, to: 8, minutes: 2, maxAbs: 10 },
      ],
    },
    {
      name: 'a setpoint series is step-held',
      pv: minutes(100, 100, 100, 100, 100),
      // SP changes to 90 at minute 2: PV 100 is then 10 away.
      sp: [
        { t: 0, v: 100 },
        { t: 2, v: 90 },
      ],
      want: [{ from: 2, to: 5, minutes: 3, maxAbs: 10 }],
    },
    {
      name: 'an unknown setpoint is a gap',
      pv: minutes(110, 110, 110, 110),
      sp: [
        { t: 1, v: 100 },
        { t: 2, v: null },
        { t: 3, v: 100 },
      ],
      want: [
        { from: 1, to: 2, minutes: 1, maxAbs: 10 },
        { from: 3, to: 4, minutes: 1, maxAbs: 10 },
      ],
    },
    {
      name: '5-minute samples (8 h range)',
      pv: [0, 5, 10, 15, 20].map((t, i) => ({ t, v: [100, 110, 112, 100, 100][i] })),
      want: [{ from: 5, to: 15, minutes: 10, maxAbs: 12 }],
    },
    { name: 'a negative threshold is refused', pv: minutes(110, 110), threshold: -1, want: [] },
    { name: 'no samples', pv: [], want: [] },
  ];
  it.each(cases)('$name', ({ pv, sp, threshold, opts, want }) => {
    expect(deviationEpisodes(pv, sp ?? SP, threshold ?? 5, opts)).toEqual(want);
  });
});

describe('withinLimitsShare', () => {
  const samples: Sample[] = [100, 104, 96, 111, 89, 100, 100, 100].map((v, t) => ({ t, v }));
  const cases: { name: string; samples: Sample[]; limits: { low?: number; high?: number }; status: string; value?: number }[] = [
    { name: 'both limits (inclusive)', samples, limits: { low: 90, high: 110 }, status: 'ok', value: 6 / 8 },
    { name: 'high limit only', samples, limits: { high: 104 }, status: 'ok', value: 7 / 8 },
    { name: 'low limit only', samples, limits: { low: 96 }, status: 'ok', value: 7 / 8 },
    {
      name: 'bad, stale and null samples are left out, not counted inside',
      samples: [{ t: 0, v: 100 }, { t: 1, v: 200 }, { t: 2, v: 100, q: 'stale' }, { t: 3, v: 100, q: 'bad' }, { t: 4, v: null }],
      limits: { low: 90, high: 110 },
      status: 'ok',
      value: 0.5,
    },
    { name: 'no limits configured', samples, limits: {}, status: 'unavailable' },
    { name: 'no samples', samples: [], limits: { low: 90 }, status: 'unavailable' },
    { name: 'only bad samples', samples: [{ t: 0, v: 100, q: 'bad' }], limits: { low: 90 }, status: 'unavailable' },
    { name: 'low above high', samples, limits: { low: 110, high: 90 }, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ samples: s, limits, status, value }) => {
    const r = withinLimitsShare(s, limits);
    expect(r.status).toBe(status);
    if (value === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(value, 12);
  });
});
