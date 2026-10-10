import { describe, expect, it } from 'vitest';
import { PROCESS_MACHINES } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { lineLossTree, lineMetrics, resolvePeriod } from '../../sim/metrics';
import type { Metric } from '../../sim/oee';
import { cumulativeVsPlan, lineTrend, machineLoss, machineLosses, oeeExplain, roundingCheck, shiftProjection } from './derive';

const ok = (value: number): Metric => ({ value, status: 'ok' });

describe('production page derivations', () => {
  // Monday 12 Oct 10:30 — 4.5 h into shift A, with 7 days of history.
  const s = createSim(11, 7 * 1440 + 270);

  it('cumulative actual and plan agree with the line metrics', () => {
    const p = resolvePeriod('shift', s.minute);
    const lm = lineMetrics(s, p);
    const c = cumulativeVsPlan(s, 'shift', p);
    expect(c.step).toBe(1);
    expect(c.times[0]).toBe(p.from);
    expect(c.times.at(-1)).toBe(c.end);
    expect(c.end - p.from).toBe(480);
    expect(c.actualNowM2).toBeCloseTo(lm.outputM2, 6);
    expect(c.planNowM2).toBeCloseTo(lm.targetM2, 6);
    const iNow = c.times.indexOf(s.minute);
    expect(iNow).toBeGreaterThan(0);
    expect(c.actual[iNow]).toBeCloseTo(lm.outputM2, 6);
    expect(c.actual[iNow + 1]).toBeNull();
    // Monotonic cumulative output.
    for (let i = 1; i <= iNow; i++) expect(c.actual[i]!).toBeGreaterThanOrEqual(c.actual[i - 1]! - 1e-9);
    // Projection starts at "now" and matches the shift projection in the summary band.
    expect(c.projection[iNow - 1]).toBeNull();
    expect(c.projection[iNow]).toBeCloseTo(c.actualNowM2, 6);
    expect(c.projectedEndM2).toBeCloseTo(shiftProjection(s, lm.output)!.projectedM2, 6);
    expect(c.projection.at(-1)).toBeCloseTo(c.projectedEndM2!, 6);
  });

  it('completed and rolling periods end at the period end without a projection', () => {
    const prev = resolvePeriod('prev-shift', s.minute);
    const c = cumulativeVsPlan(s, 'prev-shift', prev);
    expect(c.projects).toBe(false);
    expect(c.projectedEndM2).toBeNull();
    expect(c.actual.at(-1)).toBeCloseTo(lineMetrics(s, prev).outputM2, 6);
    const week = resolvePeriod('7d', s.minute);
    const w = cumulativeVsPlan(s, '7d', week);
    expect(w.step).toBe(60);
    expect(w.actual.every((v) => v == null || v <= w.actualNowM2 + 1e-9)).toBe(true);
    expect(w.projection.every((v) => v == null)).toBe(true);
  });

  it('losses by machine cover every process machine and add up', () => {
    const p = resolvePeriod('24h', s.minute);
    const rows = machineLosses(s, p);
    expect(rows.map((r) => r.id).sort()).toEqual([...PROCESS_MACHINES].sort());
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].totalM2).toBeGreaterThanOrEqual(rows[i].totalM2);
    for (const r of rows) expect(r.totalM2).toBeCloseTo(r.downM2 + r.starvedM2 + r.blockedM2, 9);
  });

  it('a breakdown shows up as downtime loss on that machine', () => {
    const t = createSim(5, 7 * 1440 + 120);
    const before = machineLoss(t, 'E-PRS2', resolvePeriod('shift', t.minute)).downMin;
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'test' });
    advance(t, t.minute + 30);
    const after = machineLoss(t, 'E-PRS2', resolvePeriod('shift', t.minute));
    expect(after.downMin - before).toBeGreaterThanOrEqual(29);
    expect(after.downM2).toBeCloseTo(((after.downMin * 450) / 60) * 0.36, 6);
  });

  it('explains the line OEE from its underlying values', () => {
    const p = resolvePeriod('shift', s.minute);
    const x = oeeExplain(s, p);
    expect(x.calendarMin).toBe(s.minute - p.from);
    expect(x.idealCycleSec).toBeCloseTo(2.88, 9);
    expect(x.oee.availability.value).toBeCloseTo(x.operatingMin / x.plannedMin, 9);
    expect(x.oee.performance.value).toBeCloseTo(x.netRunMin / x.operatingMin, 9);
    expect(x.oee.quality.value).toBeCloseTo(x.good / x.sorted, 9);
    expect(x.oee.oee.value).toBeCloseTo(x.oee.availability.value! * x.oee.performance.value! * x.oee.quality.value!, 12);
    // The waterfall tells the same story: fully productive ÷ planned time = OEE.
    const tree = lineLossTree(s, p)!;
    expect(tree.fullyProductive / tree.planned).toBeCloseTo(x.oee.oee.value!, 9);
  });

  it('flags when rounded components do not multiply to the displayed OEE', () => {
    expect(roundingCheck({ availability: ok(0.95), performance: ok(0.95), quality: ok(0.95), oee: ok(0.95 ** 3) }).matches).toBe(true);
    const v = 0.90049;
    const r = roundingCheck({ availability: ok(v), performance: ok(v), quality: ok(v), oee: ok(v ** 3) });
    expect(r.applicable).toBe(true);
    expect(r.productOfShown).toBeCloseTo(0.729, 9);
    expect(r.matches).toBe(false);
    const na: Metric = { value: null, status: 'unavailable', issue: 'x' };
    expect(roundingCheck({ availability: na, performance: ok(1), quality: ok(1), oee: na })).toEqual({ applicable: false, productOfShown: null, matches: true });
  });

  it('trend buckets carry a defect rate consistent with their counts', () => {
    const p = resolvePeriod('24h', s.minute);
    for (const b of lineTrend(s, p, 'hour')) {
      if (b.inspected > 0) expect(b.defectRate).toBeCloseTo(b.rejected / b.inspected, 12);
      else expect(b.defectRate).toBeNull();
    }
  });
});
