import { describe, expect, it } from 'vitest';
import { productionRate, varianceVsTarget } from '../rate';
import type { Calc } from '../types';

describe('productionRate', () => {
  const cases: { name: string; count: number | null; minutes: number | null; status: Calc<number>['status']; value?: number }[] = [
    { name: '120 tiles in 15 min', count: 120, minutes: 15, status: 'ok', value: 480 },
    { name: 'a genuine 0 count is a 0 rate', count: 0, minutes: 60, status: 'ok', value: 0 },
    { name: 'fractional minutes', count: 10, minutes: 0.5, status: 'ok', value: 1200 },
    { name: 'missing count', count: null, minutes: 60, status: 'unavailable' },
    { name: 'missing duration', count: 10, minutes: null, status: 'unavailable' },
    { name: 'NaN count', count: Number.NaN, minutes: 60, status: 'unavailable' },
    { name: 'zero duration (division by zero)', count: 10, minutes: 0, status: 'unavailable' },
    { name: 'negative count', count: -5, minutes: 60, status: 'invalid' },
    { name: 'negative duration', count: 5, minutes: -1, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ count, minutes, status, value }) => {
    const r = productionRate(count, minutes);
    expect(r.status).toBe(status);
    if (value === undefined) {
      expect(r.value).toBeNull();
      expect(r.status !== 'ok' && r.reason.length).toBeGreaterThan(0);
    } else expect(r.value).toBeCloseTo(value, 9);
  });
});

describe('varianceVsTarget', () => {
  const cases: { name: string; actual: number | null; target: number | null; status: string; abs?: number; rel?: number }[] = [
    { name: 'below target', actual: 900, target: 1000, status: 'ok', abs: -100, rel: -0.1 },
    { name: 'above target', actual: 1100, target: 1000, status: 'ok', abs: 100, rel: 0.1 },
    { name: 'on target', actual: 1000, target: 1000, status: 'ok', abs: 0, rel: 0 },
    { name: 'actual 0 against a target', actual: 0, target: 500, status: 'ok', abs: -500, rel: -1 },
    { name: 'negative target keeps the sign of the variance', actual: -8, target: -10, status: 'ok', abs: 2, rel: 0.2 },
    { name: 'missing actual', actual: null, target: 1000, status: 'unavailable' },
    { name: 'no target', actual: 900, target: null, status: 'unavailable' },
    { name: 'zero target (relative variance undefined)', actual: 900, target: 0, status: 'unavailable' },
  ];
  it.each(cases)('$name', ({ actual, target, status, abs, rel }) => {
    const r = varianceVsTarget(actual, target);
    expect(r.status).toBe(status);
    if (abs === undefined) expect(r.value).toBeNull();
    else {
      expect(r.value?.abs).toBeCloseTo(abs, 9);
      expect(r.value?.rel).toBeCloseTo(rel!, 9);
    }
  });
});
