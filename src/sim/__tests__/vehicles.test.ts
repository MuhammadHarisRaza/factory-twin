import { describe, expect, it } from 'vitest';
import { HALL, RAW_SHED, WAREHOUSE } from '../../data/layout';
import { activateScenario, advance, createSim } from '../engine';
import { poseAt, type TruckRuntime } from '../logistics';
import { fleetMetrics, visitDurations } from '../metrics';

const START = 2 * 1440 + 300;

describe('truck visit durations', () => {
  it('derive from event timestamps', () => {
    const s = createSim(21, START);
    const done = s.logistics.departed.filter((v) => v.visit!.direction === 'outbound');
    expect(done.length).toBeGreaterThan(5);
    for (const v of done) {
      const d = visitDurations(v, s.minute);
      const vis = v.visit!;
      expect(d.turnaround).toBeCloseTo(vis.gateOut! - vis.gateIn, 9);
      expect(d.gateToDock).toBeCloseTo(vis.dockStart! - vis.gateIn, 9);
      expect(d.dockTime).toBeCloseTo(vis.dockEnd! - vis.dockStart!, 9);
      expect(d.waiting!).toBeGreaterThanOrEqual(0);
      expect(vis.gateIn).toBeLessThanOrEqual(vis.dockAssigned!);
      expect(vis.dockAssigned!).toBeLessThanOrEqual(vis.dockStart!);
      expect(vis.dockStart!).toBeLessThan(vis.dockEnd!);
      expect(vis.dockEnd!).toBeLessThan(vis.gateOut!);
    }
  });

  it('never exposes a timestamp before the event has happened', () => {
    const s = createSim(27, START);
    for (let i = 0; i < 240; i++) {
      advance(s, s.minute + 1);
      for (const id of s.logistics.active) {
        const vis = s.logistics.vehicles[id].visit;
        if (!vis) continue;
        for (const t of [vis.dockAssigned, vis.dockStart, vis.dockEnd, vis.gateOut]) if (t != null) expect(t).toBeLessThan(s.minute + 1);
      }
    }
  });

  it('every departed truck has exactly one gate-in and one gate-out', () => {
    const s = createSim(22, START);
    expect(s.logistics.departed.length).toBeGreaterThan(5);
    for (const v of s.logistics.departed) {
      const ev = s.logistics.gateEvents.filter((g) => g.vehicleId === v.id);
      expect(ev.map((g) => g.direction).sort()).toEqual(['in', 'out']);
    }
  });

  it('a prolonged dock stay extends dock time by the hold', () => {
    const s = createSim(23, START);
    activateScenario(s, { kind: 'truck-arrival', end: null, label: 'Truck' });
    let truckId: string | null | undefined;
    for (let i = 0; i < 40 && !truckId; i++) {
      advance(s, s.minute + 1);
      truckId = Object.values(s.logistics.docks).find((d) => d.vehicleId)?.vehicleId;
    }
    expect(truckId).toBeTruthy();
    activateScenario(s, { kind: 'prolonged-dock-stay', count: 75, end: null, label: 'Hold' });
    advance(s, s.minute + 180);
    const tr = s.logistics.vehicles[truckId!] as TruckRuntime;
    expect(visitDurations(tr, s.minute).dockTime!).toBeGreaterThan(75);
  });

  it('yard congestion queues trucks in the holding area', () => {
    const s = createSim(24, START);
    activateScenario(s, { kind: 'yard-congestion', count: 10, end: null, label: 'Congestion' });
    advance(s, s.minute + 24);
    expect(fleetMetrics(s, { from: s.minute - 60, to: s.minute, label: '' }).waiting).toBeGreaterThanOrEqual(3);
  });
});

describe('vehicle paths respect the site layout', () => {
  const inside = (r: { x: [number, number]; z: [number, number] }, x: number, z: number, m = 0.5) =>
    x > r.x[0] + m && x < r.x[1] - m && z > r.z[0] + m && z < r.z[1] - m;

  it('trucks never drive through the production hall or warehouse; only tippers enter the raw shed', () => {
    const s = createSim(25, START);
    const trucks = [...s.logistics.departed, ...s.logistics.active.map((id) => s.logistics.vehicles[id] as TruckRuntime)].filter(
      (v) => v.class === 'external',
    );
    expect(trucks.length).toBeGreaterThan(5);
    for (const v of trucks)
      for (const leg of v.legs) {
        if (!Number.isFinite(leg.end)) continue;
        for (let t = leg.start; t <= leg.end; t += 0.05) {
          const p = poseAt(v, t);
          if (!p) continue;
          expect(inside(HALL.rect, p.x, p.z)).toBe(false);
          expect(inside(WAREHOUSE.rect, p.x, p.z)).toBe(false);
          if (v.visit!.direction === 'outbound') expect(inside(RAW_SHED.rect, p.x, p.z)).toBe(false);
        }
      }
  });

  it('warehouse forklifts stay inside the warehouse and on the dock levellers', () => {
    const s = createSim(26, START);
    for (const id of ['FL-01', 'FL-02', 'FL-03', 'FL-04']) {
      const v = s.logistics.vehicles[id];
      for (const leg of v.legs) {
        const end = Number.isFinite(leg.end) ? leg.end : leg.start;
        for (let t = leg.start; t <= end; t += 0.05) {
          const p = poseAt(v, t);
          if (!p) continue;
          expect(p.x).toBeGreaterThan(WAREHOUSE.rect.x[0]);
          expect(p.x).toBeLessThan(WAREHOUSE.rect.x[1] + 0.1);
          expect(p.z).toBeGreaterThan(WAREHOUSE.rect.z[0]);
          expect(p.z).toBeLessThan(62.5);
        }
      }
    }
  });
});
