/**
 * Counting boundaries: sorting passes on only accepted tiles, so packing and palletising count good
 * output, and every difference between counting points is explained by a buffer change.
 */
import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../engine';
import { countReconciliation, internalActivity } from '../metrics';

const START = 2 * 1440 + 240;
const win = (from: number, to: number) => ({ from, to, label: 'test' });

describe('count reconciliation', () => {
  it('closes fired → sorted → good → packed → palletised over a day (residuals ≈ 0)', () => {
    const s = createSim(71, START);
    const r = countReconciliation(s, win(START - 1440, START));
    expect(r.fired).toBeGreaterThan(10_000);
    expect(r.good).toBeCloseTo(r.inspected - r.rejected, 6);
    for (const v of Object.values(r.wip)) expect(v).not.toBeNull();
    for (const v of Object.values(r.residuals)) expect(Math.abs(v ?? Infinity)).toBeLessThan(1e-6);
    // Packing never receives rejected tiles: packed can exceed good only by what the buffer gave back.
    expect(r.packed).toBeLessThanOrEqual(r.good - (r.wip.accumulation ?? 0) + 1e-6);
  });

  it('still closes when the finishing end is disturbed (buffers move)', () => {
    const s = createSim(72, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'I-SORT', end: START + 40, label: 'Sorting stop' });
    advance(s, s.minute + 90);
    const r = countReconciliation(s, win(START, s.minute));
    expect(Math.abs(r.wip.accumulation ?? 0) + Math.abs(r.wip.kilnOutfeed ?? 0)).toBeGreaterThan(0);
    for (const v of Object.values(r.residuals)) expect(Math.abs(v ?? Infinity)).toBeLessThan(1e-6);
  });
});

describe('internal vehicles: stationary time is separate from zone residency', () => {
  it('stationary time never exceeds zone residency and is 0 while moving', () => {
    const s = createSim(73, START);
    advance(s, s.minute + 30);
    const internal = Object.values(s.logistics.vehicles).filter((v) => v.class === 'internal');
    expect(internal.length).toBeGreaterThan(0);
    for (const v of internal) {
      const a = internalActivity(v, s.minute);
      if (a.dwell == null) continue;
      expect(a.stationaryMin).not.toBeNull();
      expect(a.stationaryMin!).toBeLessThanOrEqual(a.dwell + 1e-9);
      if (a.moving) expect(a.stationaryMin).toBe(0);
    }
  });
});
