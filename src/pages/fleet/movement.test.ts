/**
 * Fleet & Movement integrity: what kind of location a vehicle shows (simulated now vs last known
 * historical vs none), dwell scoped correctly (internal vehicles: time at the current stop, never
 * zone residency; trucks: gate-in, waiting, at the dock), visit records that look incomplete, the
 * delay review and the reference-footage topic.
 */
import { describe, expect, it } from 'vitest';
import { delayedTrucks, delayedVehiclesKpi } from '../../intel/kpis';
import { DEFAULT_SEED, activateScenario, advance, createSim } from '../../sim/engine';
import type { TruckRuntime } from '../../sim/logistics';
import { externalVehicles, internalActivity, internalVehicles, visitDurations } from '../../sim/metrics';
import { DEFAULT_START, formatClock } from '../../sim/time';
import { loadingCompleteTimes } from './pipeline';
import {
  LOCATION_KIND_LABEL,
  delayMarker,
  delayReview,
  dockUsage,
  fleetSummary,
  internalDwell,
  movementLabel,
  staleVisitLimit,
  truckDwell,
  vehicleLocation,
  vehicleMovement,
  videoTopicFor,
  visitIntegrity,
  zoneContext,
} from './movement';

/** The seeded demo state (read-only tests share one; it pre-rolls seven simulated days, hence their longer timeout). */
let seededState: ReturnType<typeof createSim> | null = null;
const seeded = () => (seededState ??= createSim(DEFAULT_SEED, DEFAULT_START));

const scenarioTruck = (s: ReturnType<typeof createSim>, scenarioId: string) =>
  Object.values(s.logistics.vehicles).find((v) => v.visit?.scenarioId === scenarioId) as TruckRuntime;

describe('location-kind labelling', () => {
  const s = createSim(11, 2 * 1440 + 360);

  it('labels every vehicle on site "Simulated position (now)" at the current minute', () => {
    let n = 0;
    for (const id of s.logistics.active) {
      const v = s.logistics.vehicles[id];
      if (v.spawned > s.minute) continue;
      const loc = vehicleLocation(s, v);
      expect(loc.kind, id).toBe('simulated');
      expect(loc.label).toBe(LOCATION_KIND_LABEL.simulated);
      expect(loc.label).toBe('Simulated position (now)');
      expect(loc.at).toBe(s.minute);
      expect(loc.place).not.toBe('—');
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it('labels a truck that has left "Last known (historical) · <gate-out time>" — never as current', () => {
    const t = s.logistics.departed.at(-1)!;
    expect(t.visit!.gateOut).not.toBeNull();
    const loc = vehicleLocation(s, t, formatClock);
    expect(loc.kind).toBe('historical');
    expect(loc.label).toBe(`Last known (historical) · ${formatClock(t.visit!.gateOut!)}`);
    expect(loc.label).not.toContain('(now)');
    expect(loc.at).toBe(t.visit!.gateOut);
    expect(loc.at!).toBeLessThan(s.minute);
    expect(loc.place).toBe('Main gate · checked out');
    // A departed vehicle has no movement state and no dwell "so far".
    const m = vehicleMovement(s, t);
    expect(m.state).toBe('off-site');
    expect(movementLabel(m)).toMatch(/^Not on site/);
    const d = truckDwell(s, t);
    expect(d.integrity.kind).toBe('completed');
    expect(d.turnaround).toBe(t.visit!.gateOut! - t.visit!.gateIn);
    expect(d.onSite).toBe(d.turnaround);
  });

  it('follows one truck from no position (due) → simulated position → last known (historical)', () => {
    const t = createSim(5, 1440 + 400);
    const sc = activateScenario(t, { kind: 'yard-congestion', count: 3, end: null, label: 'test' });
    const trucks = Object.values(t.logistics.vehicles).filter((v) => v.visit?.scenarioId === sc.id);
    const later = trucks.find((v) => v.spawned > t.minute)!;
    expect(later).toBeTruthy();
    const due = vehicleLocation(t, later);
    expect(due.kind).toBe('not-arrived');
    expect(due.label).toMatch(/^No position yet · due /);
    expect(visitIntegrity(t, later as TruckRuntime).kind).toBe('scheduled');

    const kinds: string[] = [];
    for (let i = 0; i < 600 && !t.logistics.departed.includes(later as TruckRuntime); i++) {
      const k = vehicleLocation(t, later).kind;
      if (kinds.at(-1) !== k) kinds.push(k);
      advance(t, t.minute + 1);
    }
    const end = vehicleLocation(t, later);
    if (kinds.at(-1) !== end.kind) kinds.push(end.kind);
    expect(kinds).toEqual(['not-arrived', 'simulated', 'historical']);
    expect(end.label.startsWith('Last known (historical) · ')).toBe(true);
  });
});

describe('dwell is scoped correctly', () => {
  it('internal vehicles: dwell = time at the current stop (stationaryMin), zone residency only as context', () => {
    const s = seeded();
    for (const v of internalVehicles(s)) {
      const a = internalActivity(v, s.minute);
      const d = internalDwell(s, v);
      expect(d.atStop, v.id).toBe(a.stationaryMin);
      expect(d.moving).toBe(a.moving);
      if (a.moving) expect(d.atStop).toBe(0);
      else expect(d.stopSince!).toBeCloseTo(s.minute - a.stationaryMin!, 6);
      expect(d.zoneSince).toBe(a.zoneSince);
    }
    // The wheel loader works inside the raw-material shed all week: its zone residency is days,
    // its time at the current stop is minutes — and only the latter is the dwell.
    const wl = s.logistics.vehicles['WL-01'];
    const a = internalActivity(wl, s.minute);
    expect(a.dwell!).toBeGreaterThan(24 * 60);
    const d = internalDwell(s, wl);
    expect(d.atStop!).toBeLessThan(60);
    expect(d.atStop).not.toBe(a.dwell);
    expect(zoneContext(d)).toMatch(/^Working in Raw-material shed since /);
  }, 120_000);

  it('stationary time grows one minute per minute while a vehicle stands, and is 0 while it moves', () => {
    const s = createSim(DEFAULT_SEED, 1440 + 600);
    const prev = new Map<string, ReturnType<typeof internalDwell>>();
    let standing = 0;
    let moving = 0;
    for (let i = 0; i < 90; i++) {
      for (const v of internalVehicles(s)) {
        const d = internalDwell(s, v);
        const p = prev.get(v.id);
        if (d.moving) {
          expect(d.atStop).toBe(0);
          moving++;
        } else if (p && !p.moving && p.stopSince != null && Math.abs(p.stopSince - d.stopSince!) < 1e-6) {
          expect(d.atStop! - p.atStop!).toBeCloseTo(1, 6);
          standing++;
        }
        prev.set(v.id, d);
      }
      advance(s, s.minute + 1);
    }
    expect(standing).toBeGreaterThan(20);
    expect(moving).toBeGreaterThan(0);
  });

  it('trucks: on site since gate-in, waiting and at-dock from the visit timestamps', () => {
    const s = createSim(3, 1440 + 600);
    activateScenario(s, { kind: 'yard-congestion', count: 6, end: null, label: 'test' });
    advance(s, s.minute + 45);
    let n = 0;
    for (const v of externalVehicles(s)) {
      if (v.visit!.gateIn > s.minute) continue;
      const d = truckDwell(s, v);
      const raw = visitDurations(v, s.minute);
      expect(d.integrity.kind, v.id).toBe('active');
      expect(d.onSite).toBeCloseTo(s.minute - v.visit!.gateIn, 6);
      expect(d.waiting).toBe(raw.waiting);
      if (d.atDock != null) expect(d.atDock).toBeGreaterThanOrEqual(0);
      expect(d.turnaround).toBeNull();
      n++;
    }
    expect(n).toBeGreaterThan(3);
  });
});

describe('visit-record integrity', () => {
  it('flags an open visit far beyond the turnaround limit "Record incomplete?" instead of a real 20-hour dwell', () => {
    const s = createSim(3, 1440 + 600);
    const sc = activateScenario(s, { kind: 'truck-arrival', end: null, label: 'test' });
    advance(s, s.minute + 15);
    const v = scenarioTruck(s, sc.id);
    expect(visitIntegrity(s, v).kind).toBe('active');

    // A lost gate-out: the record says gate-in 20 h ago and the truck never left.
    v.visit!.gateIn = s.minute - 20 * 60;
    const integrity = visitIntegrity(s, v);
    expect(integrity.kind).toBe('incomplete');
    expect(integrity.label).toBe('Record incomplete?');
    expect(integrity.note).toContain('20 h 00 min');
    expect(integrity.note).toContain(`${s.rules.turnaroundMax}-min turnaround limit`);
    expect(truckDwell(s, v).onSite).toBeNull();

    // The core delay list (and the KPI) leave a possibly incomplete record out; the review keeps it apart.
    expect(delayedTrucks(s).some((x) => x.id === v.id)).toBe(false);
    const review = delayReview(s);
    expect(review.incomplete.map((r) => r.id)).toContain(v.id);
    expect(review.delayed.map((r) => r.id)).not.toContain(v.id);
    expect(review.watch.map((r) => r.id)).not.toContain(v.id);
    expect(fleetSummary(s, review, dockUsage(s))).toMatch(/look(s)? incomplete — flagged for checking, not counted as a real stay/);
  });

  it('keeps a long but plausible stay an active (delayed) visit', () => {
    const s = createSim(3, 1440 + 600);
    const sc = activateScenario(s, { kind: 'truck-arrival', end: null, label: 'test' });
    advance(s, s.minute + 15);
    const v = scenarioTruck(s, sc.id);
    v.visit!.gateIn = s.minute - (s.rules.turnaroundMax + 40);
    expect(visitIntegrity(s, v).kind).toBe('active');
    const review = delayReview(s);
    const row = review.delayed.find((r) => r.id === v.id)!;
    expect(row).toBeTruthy();
    expect(row.minutes).toBeGreaterThan(row.limit);
    expect(row.over).toBeCloseTo(row.minutes - row.limit, 6);
    expect(delayMarker(row)).toMatch(/· limit \d+ min$/);
  });

  it('uses a floor so a short turnaround limit never turns a real stay into a broken record', () => {
    expect(staleVisitLimit({ turnaroundMax: 30 })).toBe(720);
    expect(staleVisitLimit({ turnaroundMax: 150 })).toBe(720);
    expect(staleVisitLimit({ turnaroundMax: 300 })).toBe(1200);
  });

  it('finds no incomplete record in the seeded demo data', () => {
    const s = seeded();
    for (const v of [...externalVehicles(s), ...s.logistics.departed]) expect(visitIntegrity(s, v).kind, v.id).not.toBe('incomplete');
    expect(delayReview(s).incomplete).toHaveLength(0);
  }, 120_000);
});

describe('delay review', () => {
  it('lists every truck past a limit (minutes vs limit, worst first) plus the trucks waiting within it', () => {
    const s = createSim(3, 1440 + 600);
    activateScenario(s, { kind: 'yard-congestion', count: 10, end: null, label: 'test' });
    advance(s, s.minute + 50);
    const r = delayReview(s);
    const core = delayedTrucks(s);
    expect(r.delayed.length + r.incomplete.length).toBe(core.length);
    expect(r.delayed.length + r.watch.length).toBeGreaterThan(0);
    for (let i = 1; i < r.delayed.length; i++) expect(r.delayed[i - 1].over).toBeGreaterThanOrEqual(r.delayed[i].over);
    for (const x of r.delayed) {
      expect(x.minutes).toBeGreaterThan(x.limit);
      expect(x.integrity.kind).toBe('active');
    }
    for (const w of r.watch) {
      expect(w.minutes).toBeLessThanOrEqual(w.limit);
      expect(core.some((c) => c.id === w.id)).toBe(false);
    }
    // Same population as the KPI's "past a limit" count.
    const kpi = delayedVehiclesKpi(s);
    if (core.length) expect(kpi.status!.label).toBe(`${core.length} past a limit`);
  });
});

describe('reference footage topic', () => {
  it('chooses footage by vehicle class and activity', () => {
    const s = createSim(3, 1440 + 600);
    expect(videoTopicFor(s, s.logistics.vehicles['FL-02'])).toBe('warehouse-forklift');
    expect(videoTopicFor(s, s.logistics.vehicles['WL-01'])).toBe('internal-transport');
    const sc = activateScenario(s, { kind: 'truck-arrival', end: null, label: 'test' });
    const v = scenarioTruck(s, sc.id);
    expect(videoTopicFor(s, v)).toBe('yard-movement');
    let loading = false;
    for (let i = 0; i < 240 && s.logistics.active.includes(v.id); i++) {
      advance(s, s.minute + 1);
      const done = loadingCompleteTimes(s).get(v.id);
      if (v.phase === 'loading' && (done == null || done > s.minute)) {
        expect(videoTopicFor(s, v)).toBe('truck-loading');
        loading = true;
      }
      if (v.phase === 'loading' && done != null && done <= s.minute) expect(videoTopicFor(s, v)).toBe('dock-operations');
    }
    expect(loading).toBe(true);
    expect(videoTopicFor(s, v)).toBe('yard-movement');
  });
});
