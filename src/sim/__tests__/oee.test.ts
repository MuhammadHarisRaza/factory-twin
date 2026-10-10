import { describe, expect, it } from 'vitest';
import { availability, computeOee, lossTree, performance, quality } from '../oee';

describe('OEE components', () => {
  it('computes the textbook example', () => {
    // 420 min planned, 47 min down → 373 operating; ideal 1 s/unit; 19 271 total, 18 848 good.
    const r = computeOee({ plannedMin: 420, operatingMin: 373, idealCycleMin: 1 / 60, totalCount: 19271, goodCount: 18848 });
    expect(r.availability.value).toBeCloseTo(0.8881, 4);
    expect(r.performance.value).toBeCloseTo(0.8611, 4);
    expect(r.quality.value).toBeCloseTo(0.978, 3);
    expect(r.oee.value).toBeCloseTo(r.availability.value! * r.performance.value! * r.quality.value!, 9);
    expect(r.issues).toEqual([]);
  });

  it('treats zero planned time as unavailable, not zero', () => {
    const a = availability(0, 0);
    expect(a.status).toBe('unavailable');
    expect(a.value).toBeNull();
  });

  it('reports genuine zero availability as 0 and OEE 0', () => {
    const r = computeOee({ plannedMin: 60, operatingMin: 0, idealCycleMin: 0.1, totalCount: 0, goodCount: 0 });
    expect(r.availability).toEqual({ value: 0, status: 'ok' });
    expect(r.performance.status).toBe('unavailable');
    expect(r.oee).toEqual({ value: 0, status: 'ok' });
  });

  it('flags operating time above planned time instead of clamping', () => {
    const a = availability(60, 75);
    expect(a.status).toBe('invalid');
    expect(a.issue).toMatch(/exceeds planned/);
  });

  it('flags planned time longer than the reporting period', () => {
    expect(availability(500, 400, 480).status).toBe('invalid');
  });

  it('flags performance above 100 %', () => {
    const p = performance(1, 120, 100);
    expect(p.status).toBe('invalid');
    expect(p.issue).toMatch(/ideal/);
  });

  it('flags units counted with zero operating time', () => {
    expect(performance(0.5, 10, 0).status).toBe('invalid');
  });

  it('needs an ideal cycle time for performance', () => {
    expect(performance(null, 10, 10).status).toBe('unavailable');
    expect(performance(0, 10, 10).status).toBe('unavailable');
  });

  it('distinguishes a missing good count from a zero good count', () => {
    expect(quality(undefined, 100).status).toBe('unavailable');
    expect(quality(0, 100)).toEqual({ value: 0, status: 'ok' });
    expect(quality(0, 0).status).toBe('unavailable');
    expect(quality(120, 100).status).toBe('invalid');
    expect(quality(-1, 100).status).toBe('invalid');
  });

  it('propagates invalid and unavailable components to OEE', () => {
    expect(computeOee({ plannedMin: 60, operatingMin: 70, idealCycleMin: 0.1, totalCount: 10, goodCount: 10 }).oee.status).toBe('invalid');
    expect(computeOee({ plannedMin: 60, operatingMin: 50, idealCycleMin: 0.1, totalCount: 10, goodCount: undefined }).oee.status).toBe(
      'unavailable',
    );
  });

  it('loss tree sums back to planned time', () => {
    const t = lossTree({ plannedMin: 420, operatingMin: 373, idealCycleMin: 1 / 60, totalCount: 19271, goodCount: 18848 })!;
    expect(t.availabilityLoss + t.performanceLoss + t.qualityLoss + t.fullyProductive).toBeCloseTo(420, 6);
  });
});
