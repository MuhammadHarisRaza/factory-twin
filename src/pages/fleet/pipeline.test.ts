import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../../sim/engine';
import type { TruckRuntime } from '../../sim/logistics';
import { fleetMetrics, resolvePeriod } from '../../sim/metrics';
import {
  CONGESTION_TRUCKS,
  PIPELINE_STAGES,
  RESTRICTED_VEHICLE,
  STAGE_BY_KEY,
  dockHoldTarget,
  handlingEvents,
  handlingWindow,
  internalTableRows,
  loadingCompleteTimes,
  loadingStats,
  pipeline,
  restrictedEntryGate,
  ruleRows,
  trail,
  truckPlace,
  truckRows,
  vehicleEvents,
  zoneRows,
} from './pipeline';

describe('vehicle monitoring pipeline', () => {
  const s = createSim(11, 2 * 1440 + 360);

  it('puts every active truck in exactly one stage; on-site count matches fleetMetrics', () => {
    const pipe = pipeline(s);
    const ids = PIPELINE_STAGES.filter((x) => x.key !== 'staging').flatMap((x) => pipe.stages[x.key].map((r) => r.v.id));
    const trucks = s.logistics.active.filter((id) => s.logistics.vehicles[id].class === 'external');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...trucks].sort());
    expect(pipe.onSite).toBe(fleetMetrics(s, resolvePeriod('shift', s.minute)).onSite);
    pipe.stages.queue.forEach((x, i) => expect(x.place.queuePos).toBe(i + 1));
    for (const l of pipe.loads) expect(l.loaded).toBeLessThanOrEqual(l.load);
  });

  it('moves a truck forward through the stages in visit order, ending at the exit', () => {
    const t = createSim(5, 1440 + 400);
    const sc = activateScenario(t, { kind: 'truck-arrival', end: null, label: 'test' });
    const v = Object.values(t.logistics.vehicles).find((x) => x.visit?.scenarioId === sc.id) as TruckRuntime;
    const seen: number[] = [];
    for (let i = 0; i < 400 && t.logistics.active.includes(v.id); i++) {
      const c = loadingCompleteTimes(t).get(v.id) ?? null;
      const step = STAGE_BY_KEY[truckPlace(v, t.minute, c).stage].step;
      if (seen.at(-1) !== step) seen.push(step);
      advance(t, t.minute + 1);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[0]).toBeLessThanOrEqual(STAGE_BY_KEY.checkin.step);
    expect(seen).toContain(STAGE_BY_KEY.dock.step);
    expect(seen.at(-1)).toBe(STAGE_BY_KEY.exit.step);
    expect(seen).not.toContain(STAGE_BY_KEY.staging.step);
  });

  it('derives alternating pickups and drop-offs from movement legs', () => {
    for (const id of ['FL-02', 'FL-05', 'WL-01']) {
      const v = s.logistics.vehicles[id];
      const h = handlingEvents(v, s.minute);
      expect(h.length).toBeGreaterThan(0);
      for (let i = 1; i < h.length; i++) {
        expect(h[i].time).toBeGreaterThanOrEqual(h[i - 1].time);
        expect(h[i].kind).not.toBe(h[i - 1].kind);
      }
      for (const x of h) expect(x.time).toBeLessThanOrEqual(s.minute);
    }
    const drops = handlingEvents(s.logistics.vehicles['FL-02'], s.minute).filter((x) => x.kind === 'dropoff');
    if (drops.length) expect(drops.some((x) => x.dock?.startsWith('Dock '))).toBe(true);
    expect(handlingWindow(s, 60)).toBeGreaterThanOrEqual(s.minute - 60);
    expect(handlingWindow(s, 60)).toBeLessThanOrEqual(s.minute);
  });

  it('builds a route trail from the legs travelled', () => {
    const v = s.logistics.vehicles['WL-01']; // loops continuously
    const pts = trail(v, s.minute - 15, s.minute);
    expect(pts.length).toBeGreaterThan(1);
    for (const p of pts) for (const c of p) expect(Number.isFinite(c)).toBe(true);
  });

  it('shapes truck and internal rows consistently', () => {
    const p = resolvePeriod('24h', s.minute);
    const rows = truckRows(s, p);
    for (const r of rows) {
      expect(r.place == null).toBe(!r.active);
      if (r.loading != null) expect(r.loading).toBeGreaterThanOrEqual(0);
    }
    const internal = internalTableRows(s);
    expect(internal).toHaveLength(6);
    for (const r of internal) {
      expect(['moving', 'working', 'idle']).toContain(r.movement);
      expect(r.handled60).toBeGreaterThanOrEqual(0);
    }
    const ls = loadingStats(s, p);
    if (ls.n) expect(ls.avg!).toBeGreaterThan(0);
  });

  it('reflects the engine thresholds in the rule rows', () => {
    const p = resolvePeriod('shift', s.minute);
    const rr = ruleRows(s, p);
    expect(rr.map((r) => r.id)).toEqual(['L-WAIT', 'L-DOCK', 'L-YARD', 'L-TURN', 'L-ZONE']);
    expect(rr.find((r) => r.id === 'L-WAIT')!.value).toBe(s.rules.truckWaitMax);
    expect(rr.find((r) => r.id === 'L-ZONE')!.key).toBeNull();
  });
});

describe('vehicle scenarios', () => {
  it('yard congestion injects the configured number of trucks and raises vehicle events', () => {
    const s = createSim(3, 1440 + 600);
    const sc = activateScenario(s, { kind: 'yard-congestion', count: CONGESTION_TRUCKS, end: null, label: `Yard congestion · ${CONGESTION_TRUCKS} trucks` });
    const injected = Object.values(s.logistics.vehicles).filter((v) => v.visit?.scenarioId === sc.id);
    expect(injected).toHaveLength(CONGESTION_TRUCKS);
    advance(s, s.minute + 90);
    const evs = vehicleEvents(s, { from: sc.start, to: s.minute, label: '' });
    expect(evs.some((e) => e.type === 'yard-congestion')).toBe(true);
    for (const e of evs) expect(e.category).toBe('logistics');
  });

  it('restricted-zone entry on FL-05 produces a scenario record and an event', () => {
    const s = createSim(3, 1440 + 600);
    expect(restrictedEntryGate(s).ok).toBe(true);
    const sc = activateScenario(s, { kind: 'restricted-entry', vehicleId: RESTRICTED_VEHICLE, end: null, label: 'test' });
    advance(s, s.minute + 20);
    const rec = s.logistics.restrictedEvents.filter((r) => r.vehicleId === RESTRICTED_VEHICLE && r.time >= sc.start);
    expect(rec.some((r) => r.source === 'scenario')).toBe(true);
    expect(s.events.some((e) => e.type === 'restricted-entry' && e.asset.vehicleId === RESTRICTED_VEHICLE && e.source === 'scenario')).toBe(true);
    expect(zoneRows(s).reduce((a, z) => a + z.today, 0)).toBeGreaterThan(0);
    expect(restrictedEntryGate(s).ok).toBe(true);
  });

  it('targets the selected docked truck for a prolonged stay, else a docked truck', () => {
    const s = createSim(3, 1440 + 600);
    for (let i = 0; i < 240 && !Object.values(s.logistics.docks).some((d) => d.vehicleId); i++) advance(s, s.minute + 1);
    const docked = Object.entries(s.logistics.docks).filter(([, d]) => d.vehicleId);
    expect(docked.length).toBeGreaterThan(0);
    const [dockId, d] = docked[docked.length - 1];
    const t = dockHoldTarget(s, d.vehicleId);
    expect(t).toMatchObject({ dockId, truckId: d.vehicleId });
    expect(dockHoldTarget(s, null)?.truckId).toBeTruthy();
  });
});
