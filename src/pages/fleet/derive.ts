/**
 * Fleet & Logistics page derivations. Pure helpers over the one simulation state; all
 * durations build on src/sim/metrics.ts (visitDurations, internalActivity) and only add
 * row shaping for the page's tables, board and charts.
 */
import { DOCKS, GEOFENCES } from '../../model/plant';
import type { RecordSource, Vehicle } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { poseAt, type TruckRuntime } from '../../sim/logistics';
import { externalVehicles, internalActivity, internalVehicles, visitDurations, type Period, type VisitDurations } from '../../sim/metrics';
import { dayStart } from '../../sim/time';

export const GEOFENCE_BY_ID = Object.fromEntries(GEOFENCES.map((g) => [g.id, g]));
export const geofenceName = (id: string | null | undefined) => (id ? (GEOFENCE_BY_ID[id]?.name ?? id) : '—');
export const DOCK_NAME = Object.fromEntries(DOCKS.map((d) => [d.id, d.name]));

export const truckSource = (v: Vehicle): RecordSource => (v.visit?.scenarioId ? 'scenario' : 'simulation');

/**
 * visitDurations, restricted to events that have already happened. (Inbound visits carry
 * their planned unloading window from arrival; it must not show before it occurs.)
 */
export function liveDurations(v: TruckRuntime, now: number): VisitDurations {
  const d = visitDurations(v, now);
  const vis = v.visit!;
  const started = vis.dockStart != null && vis.dockStart <= now;
  return {
    ...d,
    gateToDock: started && vis.gateIn <= now ? vis.dockStart! - vis.gateIn : null,
    dockTime: started ? Math.min(vis.dockEnd ?? now, now) - vis.dockStart! : null,
  };
}

/** Zone the vehicle is in at `now` (from its current leg). */
export function currentZone(v: Vehicle, now: number): string | null {
  return poseAt(v, now)?.leg?.zone ?? null;
}

// ── Docks ─────────────────────────────────────────────────────────────────────

export type DockStatus = 'free' | 'reserved' | 'loading' | 'paperwork' | 'held';

export type DockRow = {
  id: string;
  name: string;
  x: number;
  status: DockStatus;
  truck: TruckRuntime | null;
  /** Docked since (or dock assigned, while reserved). */
  since: number | null;
  dockTime: number | null;
  loaded: number | null;
  load: number | null;
};

export function dockBoard(s: SimState): DockRow[] {
  const now = s.minute;
  return DOCKS.map((d) => {
    const rt = s.logistics.docks[d.id];
    const id = rt.vehicleId ?? rt.reservedBy;
    const truck = id ? (s.logistics.vehicles[id] as TruckRuntime) : null;
    let status: DockStatus = 'free';
    if (rt.vehicleId && truck) {
      const done = (truck.palletsLoaded ?? 0) >= truck.visit!.load;
      status = done ? (truck.holdExtra > 0 ? 'held' : 'paperwork') : 'loading';
    } else if (rt.reservedBy) status = 'reserved';
    const since = rt.vehicleId ? rt.since : (truck?.visit?.dockAssigned ?? null);
    return {
      id: d.id,
      name: d.name,
      x: d.x,
      status,
      truck,
      since,
      dockTime: rt.vehicleId && rt.since != null ? now - rt.since : null,
      loaded: truck ? (truck.palletsLoaded ?? 0) : null,
      load: truck ? truck.visit!.load : null,
    };
  });
}

// ── Vehicles ──────────────────────────────────────────────────────────────────

export type ExtRow = {
  id: string;
  v: TruckRuntime;
  active: boolean;
  zone: string | null;
  d: VisitDurations;
  source: RecordSource;
};

/** External vehicles active on site plus those that left within the period. */
export function externalRows(s: SimState, p: Period): ExtRow[] {
  const now = s.minute;
  const active = externalVehicles(s)
    .filter((v) => v.spawned <= now)
    .map((v) => ({ id: v.id, v, active: true, zone: currentZone(v, now), d: liveDurations(v, now), source: truckSource(v) }));
  const left = s.logistics.departed
    .filter((v) => v.visit!.gateOut != null && v.visit!.gateOut >= p.from && v.visit!.gateOut < p.to)
    .map((v) => ({ id: v.id, v, active: false, zone: null, d: liveDurations(v, now), source: truckSource(v) }));
  return [...active, ...left];
}

export type IntRow = {
  id: string;
  v: Vehicle;
  zone: string | null;
  moving: boolean;
  activity: string | null;
  dwell: number | null;
  idleLastHour: number | null;
  restrictedToday: number;
};

export function internalRows(s: SimState): IntRow[] {
  const now = s.minute;
  const from = dayStart(now);
  return internalVehicles(s).map((v) => {
    const a = internalActivity(v, now);
    return {
      id: v.id,
      v,
      zone: a.zone,
      moving: !!a.current?.moving && a.current.end > now,
      activity: a.current?.activity ?? null,
      dwell: a.dwell,
      idleLastHour: a.idleLastHour,
      restrictedToday: s.logistics.restrictedEvents.filter((e) => e.vehicleId === v.id && e.time >= from && e.time <= now).length,
    };
  });
}

// ── Event log ─────────────────────────────────────────────────────────────────

export type LogType = 'gate' | 'dock' | 'restricted';
export type LogRow = { id: string; time: number; type: LogType; event: string; detail: string; vehicleId: string; source: RecordSource };

const DOCK_KIND: Record<string, string> = {
  assigned: 'Dock assigned',
  docked: 'Docked',
  'loading-complete': 'Loading complete',
  undocked: 'Undocked',
};

export function eventLog(s: SimState, p: Period): LogRow[] {
  const L = s.logistics;
  const inP = (t: number) => t >= p.from && t < Math.max(p.to, s.minute + 1);
  const rows: LogRow[] = [];
  for (const g of L.gateEvents)
    if (inP(g.time))
      rows.push({ id: g.id, time: g.time, type: 'gate', event: g.direction === 'in' ? 'Gate in' : 'Gate out', detail: 'Main gate', vehicleId: g.vehicleId, source: g.source });
  for (const d of L.dockEvents)
    if (inP(d.time))
      rows.push({
        id: d.id,
        time: d.time,
        type: 'dock',
        event: DOCK_KIND[d.kind] ?? d.kind,
        detail: DOCK_NAME[d.dockId] ?? d.dockId,
        vehicleId: d.vehicleId,
        source: L.vehicles[d.vehicleId]?.visit?.scenarioId ? 'scenario' : d.source,
      });
  for (const r of L.restrictedEvents)
    if (inP(r.time))
      rows.push({
        id: r.id,
        time: r.time,
        type: 'restricted',
        event: 'Restricted-zone entry',
        detail: `${geofenceName(r.geofenceId)} · ${r.durationMin} min`,
        vehicleId: r.vehicleId,
        source: r.source,
      });
  return rows.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
}

// ── Selected vehicle ─────────────────────────────────────────────────────────

export type TimelineStep = { key: string; label: string; time: number | null; note?: string };

/** Visit milestones with timestamps from the visit record and dock events; null = not yet. */
export function visitTimeline(s: SimState, v: TruckRuntime): TimelineStep[] {
  const now = s.minute;
  const vis = v.visit!;
  const past = (t: number | null | undefined) => (t != null && t <= now ? t : null);
  if (vis.direction === 'inbound') {
    const weigh = v.legs.find((l) => l.activity.startsWith('Weighing'));
    return [
      { key: 'gate-in', label: 'Gate in', time: past(vis.gateIn) },
      { key: 'weigh', label: 'Weighbridge', time: past(weigh?.start) },
      { key: 'unload-start', label: 'Unloading started', time: past(vis.dockStart), note: vis.material },
      { key: 'unload-end', label: 'Unloading complete', time: past(vis.dockEnd) },
      { key: 'gate-out', label: 'Gate out', time: past(vis.gateOut) },
    ];
  }
  const ev = (kind: string) => s.logistics.dockEvents.find((e) => e.vehicleId === v.id && e.kind === kind)?.time ?? null;
  const dock = vis.dockId ? DOCK_NAME[vis.dockId] : undefined;
  return [
    { key: 'gate-in', label: 'Gate in', time: past(vis.gateIn) },
    { key: 'holding', label: 'Arrived in holding', time: past(v.queuedAt) },
    { key: 'assigned', label: 'Dock assigned', time: past(vis.dockAssigned), note: dock },
    { key: 'docked', label: 'Docked', time: past(vis.dockStart) },
    { key: 'loaded', label: 'Loading complete', time: past(ev('loading-complete')), note: `${vis.load} pallets` },
    { key: 'undocked', label: 'Undocked', time: past(vis.dockEnd) },
    { key: 'gate-out', label: 'Gate out', time: past(vis.gateOut) },
  ];
}

export function recentLegs(v: Vehicle, now: number, n = 10) {
  return v.legs
    .filter((l) => l.start <= now)
    .slice(-n)
    .reverse()
    .map((l) => ({ ...l, duration: Math.max(0, Math.min(l.end, now) - l.start), open: l.end > now }));
}

// ── Analytics ─────────────────────────────────────────────────────────────────

const hoursOf = (p: Period) => {
  const out: number[] = [];
  for (let h = Math.floor(p.from / 60); h * 60 < p.to; h++) out.push(h);
  return out;
};

export function hourlyGate(s: SimState, p: Period) {
  const hours = hoursOf(p);
  const idx = new Map(hours.map((h, i) => [h, i]));
  const values = hours.map(() => [0, 0]);
  for (const g of s.logistics.gateEvents) {
    if (g.time < p.from || g.time >= p.to) continue;
    const i = idx.get(Math.floor(g.time / 60));
    if (i != null) values[i][g.direction === 'in' ? 0 : 1]++;
  }
  return { hours, values };
}

/** Dock occupied minutes and utilisation per dock (same hour buckets as fleetMetrics). */
export function dockUtilisation(s: SimState, p: Period) {
  const hours = hoursOf(p);
  const minutes = Math.max(1, p.to - p.from);
  return DOCKS.map((d) => {
    let busy = 0;
    for (const h of hours) busy += s.logistics.dockBusy[d.id].get(h) ?? 0;
    return { id: d.id, name: d.name, busy, share: busy / minutes };
  });
}

/** Visits that left within the period, in gate-out order. */
export function completedVisits(s: SimState, p: Period) {
  return s.logistics.departed
    .filter((v) => v.visit!.gateOut != null && v.visit!.gateOut >= p.from && v.visit!.gateOut < p.to)
    .sort((a, b) => a.visit!.gateOut! - b.visit!.gateOut!)
    .map((v) => ({ v, d: liveDurations(v, s.minute) }));
}
