import { describe, expect, it } from 'vitest';
import { firstPassYield, proportionChange, rejectRate } from '../quality';

describe('rejectRate', () => {
  const cases: { name: string; rejected: number | null; inspected: number | null; status: string; value?: number }[] = [
    { name: '18 of 1200', rejected: 18, inspected: 1200, status: 'ok', value: 0.015 },
    { name: 'no rejects is a genuine 0 %', rejected: 0, inspected: 500, status: 'ok', value: 0 },
    { name: 'all rejected', rejected: 40, inspected: 40, status: 'ok', value: 1 },
    { name: 'nothing inspected is unavailable, not 0 %', rejected: 0, inspected: 0, status: 'unavailable' },
    { name: 'missing reject count', rejected: null, inspected: 100, status: 'unavailable' },
    { name: 'missing inspection count', rejected: 3, inspected: null, status: 'unavailable' },
    { name: 'more rejects than inspections', rejected: 120, inspected: 100, status: 'invalid' },
    { name: 'negative count', rejected: -1, inspected: 100, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ rejected, inspected, status, value }) => {
    const r = rejectRate(rejected, inspected);
    expect(r.status).toBe(status);
    if (value === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(value, 12);
  });
});

describe('firstPassYield', () => {
  const cases: { name: string; good: number | null; total: number | null; status: string; value?: number }[] = [
    { name: '976 of 1000', good: 976, total: 1000, status: 'ok', value: 0.976 },
    { name: 'a genuine 0 yield', good: 0, total: 50, status: 'ok', value: 0 },
    { name: 'no units', good: 0, total: 0, status: 'unavailable' },
    { name: 'missing good count', good: null, total: 100, status: 'unavailable' },
    { name: 'good above total', good: 101, total: 100, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ good, total, status, value }) => {
    const r = firstPassYield(good, total);
    expect(r.status).toBe(status);
    if (value === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(value, 12);
  });
});

describe('proportionChange (two-proportion z-test)', () => {
  it('flags a doubling of the reject rate on 1000 vs 1000 as significant', () => {
    const r = proportionChange({ x: 30, n: 1000 }, { x: 15, n: 1000 });
    expect(r.status).toBe('ok');
    expect(r.value?.current).toBeCloseTo(0.03, 12);
    expect(r.value?.baseline).toBeCloseTo(0.015, 12);
    expect(r.value?.diff).toBeCloseTo(0.015, 12);
    // pooled 0.0225, se = √(0.0225 × 0.9775 × 2/1000) ≈ 0.006632 → z ≈ 2.262
    expect(r.value?.z).toBeCloseTo(2.262, 2);
    expect(r.value?.significant).toBe(true);
  });

  type Counts = { x: number; n: number };
  const cases: { name: string; cur: Counts; base: Counts; opts?: { minN?: number; z?: number }; significant: boolean; sign: number }[] = [
    { name: 'a small rise is noise', cur: { x: 20, n: 1000 }, base: { x: 15, n: 1000 }, significant: false, sign: 1 },
    { name: 'an improvement gives a negative z', cur: { x: 5, n: 1000 }, base: { x: 30, n: 1000 }, significant: true, sign: -1 },
    { name: 'a stricter critical value', cur: { x: 30, n: 1000 }, base: { x: 15, n: 1000 }, opts: { z: 2.58 }, significant: false, sign: 1 },
    { name: 'a lower minimum sample size', cur: { x: 12, n: 100 }, base: { x: 2, n: 100 }, opts: { minN: 50 }, significant: true, sign: 1 },
  ];
  it.each(cases)('$name', ({ cur, base, opts, significant, sign }) => {
    const r = proportionChange(cur, base, opts);
    expect(r.status).toBe('ok');
    expect(r.value?.significant).toBe(significant);
    expect(Math.sign(r.value!.z)).toBe(sign);
  });

  it('reports no variation as z = 0, not significant', () => {
    const r = proportionChange({ x: 0, n: 500 }, { x: 0, n: 500 });
    expect(r.value).toEqual({ current: 0, baseline: 0, diff: 0, z: 0, significant: false });
  });

  const notOk: { name: string; cur: { x: number; n: number }; base: { x: number; n: number }; opts?: { minN?: number; z?: number }; status: string }[] = [
    { name: 'current window below the default 200', cur: { x: 5, n: 150 }, base: { x: 15, n: 1000 }, status: 'insufficient' },
    { name: 'baseline window below the default 200', cur: { x: 5, n: 1000 }, base: { x: 1, n: 199 }, status: 'insufficient' },
    { name: 'nothing counted with minN 0', cur: { x: 0, n: 0 }, base: { x: 1, n: 100 }, opts: { minN: 0 }, status: 'unavailable' },
    { name: 'x above n', cur: { x: 300, n: 200 }, base: { x: 15, n: 1000 }, status: 'invalid' },
    { name: 'negative count', cur: { x: -1, n: 500 }, base: { x: 15, n: 1000 }, status: 'invalid' },
    { name: 'non-positive critical value', cur: { x: 30, n: 1000 }, base: { x: 15, n: 1000 }, opts: { z: 0 }, status: 'invalid' },
  ];
  it.each(notOk)('is not ok for $name', ({ cur, base, opts, status }) => {
    const r = proportionChange(cur, base, opts);
    expect(r.status).toBe(status);
    expect(r.value).toBeNull();
  });

  it('names the sample sizes when there are too few', () => {
    const r = proportionChange({ x: 5, n: 150 }, { x: 15, n: 1000 });
    expect(r.status !== 'ok' && r.reason).toBe('Needs at least 200 in each window (current 150, baseline 1000)');
  });
});
