/**
 * Fleet & Movement: where one vehicle is (and what kind of location that is), whether it is moving,
 * how long it has dwelt, whether its visit record is trustworthy, the delay review and the page
 * summary. Pure functions over the one simulation state.
 *
 * Location integrity. A vehicle on site has a SIMULATED POSITION (now): interpolated from its
 * simulated route, never a GPS fix. A vehicle that has left has only a LAST KNOWN (HISTORICAL)
 * location with its time; it is never presented as current. A scenario arrival that is still due
 * has no position at all.
 *
 * Dwell. Trucks: on site since gate-in, waiting for a dock, at the dock (visit timestamps).
 * Internal vehicles: time at the current stop (`internalActivity().stationaryMin`). Zone residency
 * (`internalActivity().zoneSince`) is context — "working in <zone> since …" — never a dwell: a
 * forklift that works inside one zone all week has not "dwelt" there for a week.
 *
 * Record integrity. A visit without a gate-out far beyond the turnaround limit is flagged
 * "Record incomplete?" (a possibly missing gate-out) instead of being shown as a real stay.
 */
import { DOCKS } from '../../model/plant';
import type { OpEvent, Vehicle } from '../../model/types';
import { delayedTrucks, staleVisitLimit, type DelayedTruck } from '../../intel/kpis';
import type { SimState } from '../../sim/engine';
import { poseAt, type TruckRuntime } from '../../sim/logistics';
import { externalVehicles, internalActivity, internalVehicles } from '../../sim/metrics';
import { formatClock, formatDuration } from '../../sim/time';
import type { VideoTopic } from '../../video/types';
import { DOCK_NAME, dockBoard, geofenceName, liveDurations } from './derive';
import { visitIntegrity, type VisitIntegrity } from './integrity';
import { activeVehicleEvents, legAt, loadingCompleteTimes, pipeline, truckPlace, STAGE_BY_KEY } from './pipeline';

type Clock = (m: number) => string;
const dur = (m: number | null | undefined) => formatDuration(m);

// ── Location ──────────────────────────────────────────────────────────────────

/**
 * simulated: on site now, position from the simulated route · historical: left the site, last known
 * location and its time · not-arrived: scenario arrival still due · none: nothing recorded yet.
 */
export type LocationKind = 'simulated' | 'historical' | 'not-arrived' | 'none';

export const LOCATION_KIND_LABEL: Record<LocationKind, string> = {
  simulated: 'Simulated position (now)',
  historical: 'Last known (historical)',
  'not-arrived': 'No position yet',
  none: 'No position recorded',
};

export type VehicleLocation = {
  kind: LocationKind;
  /** Full label of the location kind, with its time where it is not "now" (e.g. "Last known (historical) · 09:15"). */
  label: string;
  /** Plain-language place (zone / area name). */
  place: string;
  /** What the vehicle is doing there (current or last leg activity). */
  detail: string | null;
  zone: string | null;
  /** Minute the location refers to: now for a simulated position, the last-known time for a historical one. */
  at: number | null;
};

/** Is the vehicle on site with a simulated position right now? */
export function isOnSite(s: SimState, v: Vehicle): boolean {
  return s.logistics.active.includes(v.id) && poseAt(v, s.minute) != null;
}

export function vehicleLocation(s: SimState, v: Vehicle, clock: Clock = formatClock): VehicleLocation {
  const now = s.minute;
  const truck = v.class === 'external' ? (v as TruckRuntime) : null;
  const pose = s.logistics.active.includes(v.id) ? poseAt(v, now) : null;
  if (pose) {
    const zone = pose.leg?.zone ?? null;
    const beforeGate = truck != null && truck.visit!.gateIn > now;
    const overflow = truck?.phase === 'waiting' && zone !== 'GF-HOLD';
    const place = beforeGate ? 'Access road · before gate-in' : overflow ? 'Road shoulder (overflow queue)' : geofenceName(zone);
    return { kind: 'simulated', label: LOCATION_KIND_LABEL.simulated, place, detail: pose.leg?.activity ?? null, zone, at: now };
  }
  if (v.spawned > now) {
    return { kind: 'not-arrived', label: `${LOCATION_KIND_LABEL['not-arrived']} · due ${clock(v.spawned)}`, place: 'Not on site yet', detail: 'Scheduled arrival (scenario)', zone: null, at: null };
  }
  const last = legAt(v, now);
  if (!last) return { kind: 'none', label: LOCATION_KIND_LABEL.none, place: '—', detail: null, zone: null, at: null };
  const gateOut = truck?.visit?.gateOut ?? null;
  const at = gateOut != null && gateOut <= now ? gateOut : (v.despawned ?? Math.min(last.end, now));
  return {
    kind: 'historical',
    label: `${LOCATION_KIND_LABEL.historical} · ${clock(at)}`,
    place: gateOut != null ? 'Main gate · checked out' : geofenceName(last.zone),
    detail: gateOut != null ? 'Left the site' : last.activity,
    zone: last.zone,
    at,
  };
}

// ── Movement ──────────────────────────────────────────────────────────────────

export type MovementInfo = {
  state: 'moving' | 'stationary' | 'off-site';
  /** Moving: start of the current movement · stationary: arrival at the current stop. */
  since: number | null;
  /** Minutes at the current stop (0 while moving, null off site). */
  stationaryMin: number | null;
  activity: string | null;
};

/** Moving, or stationary since when — from the simulated route (same rule as internalActivity). */
export function vehicleMovement(s: SimState, v: Vehicle): MovementInfo {
  if (!isOnSite(s, v)) return { state: 'off-site', since: null, stationaryMin: null, activity: null };
  const a = internalActivity(v, s.minute);
  if (a.moving) return { state: 'moving', since: a.current?.start ?? null, stationaryMin: 0, activity: a.current?.activity ?? null };
  const m = a.stationaryMin ?? 0;
  return { state: 'stationary', since: s.minute - m, stationaryMin: m, activity: a.current?.activity ?? null };
}

export function movementLabel(m: MovementInfo, clock: Clock = formatClock): string {
  if (m.state === 'off-site') return 'Not on site — no current movement';
  if (m.state === 'moving') return `Moving${m.activity ? ` · ${m.activity}` : ''}`;
  return `Stationary since ${clock(m.since!)} · ${dur(m.stationaryMin)}`;
}

// ── Visit-record integrity (./integrity.ts) ─────────────────────────────────

export { staleVisitLimit, visitIntegrity, type VisitIntegrity, type VisitIntegrityKind } from './integrity';

// ── Dwell ───────────────────────────────────────────────────────────────────

export type TruckDwell = {
  kind: 'truck';
  gateIn: number | null;
  /** Gate-in → now (on site) or → gate-out (left). Null before gate-in or for an incomplete record. */
  onSite: number | null;
  /** Holding arrival → dock assigned (or now while waiting). */
  waiting: number | null;
  /** Docked → undocked (or now while at the dock). */
  atDock: number | null;
  turnaround: number | null;
  integrity: VisitIntegrity;
};

export type InternalDwell = {
  kind: 'internal';
  /** Minutes at the current stop — the dwell of an internal vehicle (0 while moving). */
  atStop: number | null;
  stopSince: number | null;
  moving: boolean;
  /** Context only (not a dwell): the zone the vehicle works in and since when. */
  zone: string | null;
  zoneSince: number | null;
  idleLastHour: number | null;
};

export function truckDwell(s: SimState, v: TruckRuntime): TruckDwell {
  const now = s.minute;
  const vis = v.visit!;
  const integrity = visitIntegrity(s, v);
  const d = liveDurations(v, now);
  const inside = vis.gateIn <= now;
  const gateOut = vis.gateOut != null && vis.gateOut <= now ? vis.gateOut : null;
  return {
    kind: 'truck',
    gateIn: inside ? vis.gateIn : null,
    onSite: !inside || integrity.kind === 'incomplete' ? null : (gateOut ?? now) - vis.gateIn,
    waiting: d.waiting,
    atDock: d.dockTime,
    turnaround: gateOut != null ? gateOut - vis.gateIn : null,
    integrity,
  };
}

export function internalDwell(s: SimState, v: Vehicle): InternalDwell {
  const now = s.minute;
  const a = internalActivity(v, now);
  return {
    kind: 'internal',
    atStop: a.stationaryMin,
    stopSince: a.stationaryMin != null && !a.moving ? now - a.stationaryMin : null,
    moving: a.moving,
    zone: a.zone,
    zoneSince: a.zoneSince,
    idleLastHour: a.idleLastHour,
  };
}

/** "Working in <zone> since …" — zone residency as context, with the start of the simulated history called out. */
export function zoneContext(d: InternalDwell, clock: Clock = formatClock): string | null {
  if (!d.zone || d.zoneSince == null) return null;
  const since = d.zoneSince < 1 ? `${clock(d.zoneSince)} (start of the simulated history)` : clock(d.zoneSince);
  return `Working in ${geofenceName(d.zone)} since ${since}`;
}

// ── Trip / assignment ───────────────────────────────────────────────────────

export type TripInfo = {
  /** Visit phase / stage in plain words, e.g. "Stage 4 · Queue — Waiting for a dock (#1)". */
  phase: string;
  /** Dock / bay assignment. */
  dock: string;
  dockId: string | null;
  /** Load in plain words. */
  load: string;
};

export function truckTrip(s: SimState, v: TruckRuntime, clock: Clock = formatClock): TripInfo {
  const now = s.minute;
  const vis = v.visit!;
  const done = loadingCompleteTimes(s).get(v.id) ?? null;
  const out = vis.direction === 'outbound';
  const active = s.logistics.active.includes(v.id);
  const place = active ? truckPlace(v, now, done) : null;
  const stage = place ? STAGE_BY_KEY[place.stage] : null;
  const phase = stage
    ? `Stage ${stage.step} · ${stage.label} — ${place!.status}${place!.queuePos != null ? ` (#${place!.queuePos} in queue)` : ''}`
    : vis.gateOut != null
      ? `Visit completed · gate-out ${clock(vis.gateOut)}`
      : 'Not on site';
  const at = (m: number | null) => (m != null && m <= now ? clock(m) : null);
  let dock: string;
  if (!out) dock = 'Raw-material shed bay (unloading)';
  else if (vis.dockId) {
    const assigned = at(vis.dockAssigned);
    dock = `${DOCK_NAME[vis.dockId]}${assigned ? ` · assigned ${assigned}` : ''}${vis.dockEnd != null && vis.dockEnd <= now ? ` · undocked ${clock(vis.dockEnd)}` : ''}`;
  } else dock = active ? 'Not assigned yet' : 'No dock recorded';
  let load: string;
  if (!out) load = `${vis.load} t ${vis.material ?? 'raw material'}${vis.dockEnd != null && vis.dockEnd <= now ? ' · unloaded' : vis.dockStart != null && vis.dockStart <= now ? ' · unloading' : ''}`;
  else if (done != null && done <= now) load = `${vis.load} pallets loaded${v.holdExtra > 0 ? ` · documentation hold +${v.holdExtra} min (scenario)` : ''}`;
  else if (vis.dockStart != null && vis.dockStart <= now) load = `Loading ${Math.min(vis.load, v.palletsLoaded ?? 0)} / ${vis.load} pallets`;
  else load = `${vis.load} pallets to load`;
  return { phase, dock, dockId: out ? vis.dockId : null, load };
}

/** Dispatch forklift → the truck it is loading (and that truck's dock). */
export function servingTruck(s: SimState, vehicleId: string): { truckId: string; dock: string | null } | null {
  const f = s.logistics.forklifts[vehicleId];
  if (!f?.truckId) return null;
  const t = s.logistics.vehicles[f.truckId] as TruckRuntime | undefined;
  return { truckId: f.truckId, dock: t?.visit?.dockId ? (DOCK_NAME[t.visit.dockId] ?? t.visit.dockId) : null };
}

// ── Reference video topic ───────────────────────────────────────────────────

/**
 * Reference-footage topic for a vehicle's class and current activity. The footage illustrates the
 * activity type — it never shows this vehicle or proves where it is.
 */
export function videoTopicFor(s: SimState, v: Vehicle): VideoTopic {
  if (v.type === 'forklift') return 'warehouse-forklift';
  if (v.type === 'wheel-loader') return 'internal-transport';
  const t = v as TruckRuntime;
  const now = s.minute;
  if (!s.logistics.active.includes(v.id)) return 'yard-movement';
  if (t.phase === 'loading') {
    const done = loadingCompleteTimes(s).get(v.id);
    return done != null && done <= now ? 'dock-operations' : 'truck-loading';
  }
  if (t.phase === 'unloading') return 'dock-operations';
  if (t.phase === 'to-dock' && legAt(v, now)?.activity.startsWith('Reversing')) return 'dock-operations';
  return 'yard-movement';
}

// ── Delay review ────────────────────────────────────────────────────────────

export type DelayRow = DelayedTruck & {
  v: TruckRuntime;
  integrity: VisitIntegrity;
  /** Minutes past the limit. */
  over: number;
  /** Stage status now, e.g. "Waiting for a dock" or "Loading 3 / 8 pallets · Dock 2". */
  status: string;
  /** Where the truck is (simulated position place, or its last known place). */
  where: string;
  /** Most severe vehicle event whose condition is still active. */
  event: OpEvent | null;
};

export type WatchRow = { id: string; v: TruckRuntime; minutes: number; limit: number; status: string; where: string; queuePos: number | null };

export type DelayReview = {
  /** Active visits past a waiting, dock or turnaround limit, worst first. */
  delayed: DelayRow[];
  /** Visit records without a gate-out far beyond the turnaround limit — flagged, not treated as a dwell. */
  incomplete: DelayRow[];
  /** Waiting for a dock, still within the waiting limit (longest first). */
  watch: WatchRow[];
};

export function delayReview(s: SimState, alerts: Map<string, OpEvent> = activeVehicleEvents(s)): DelayReview {
  const now = s.minute;
  const done = loadingCompleteTimes(s);
  const status = (v: TruckRuntime) => (s.logistics.active.includes(v.id) ? truckPlace(v, now, done.get(v.id) ?? null).status : 'Not simulated on site');
  const where = (v: TruckRuntime) => vehicleLocation(s, v).place;
  const rows: DelayRow[] = delayedTrucks(s).map((d) => {
    const v = s.logistics.vehicles[d.id] as TruckRuntime;
    return { ...d, v, integrity: visitIntegrity(s, v), over: d.minutes - d.limit, status: status(v), where: where(v), event: alerts.get(d.id) ?? null };
  });
  const listed = new Set(rows.map((r) => r.id));
  // Open visits far beyond the turnaround limit: the core delay list leaves them out (possibly a
  // missing gate-out); the review lists them apart as incomplete records.
  for (const id of s.logistics.active) {
    const v = s.logistics.vehicles[id];
    if (!v || v.class !== 'external' || listed.has(id)) continue;
    const t = v as TruckRuntime;
    if (!t.visit || t.visit.gateOut != null || t.visit.gateIn > now || now - t.visit.gateIn <= staleVisitLimit(s.rules)) continue;
    rows.push({ id, label: v.label, reason: 'On site', minutes: now - t.visit.gateIn, limit: s.rules.turnaroundMax, v: t, integrity: visitIntegrity(s, t), over: now - t.visit.gateIn - s.rules.turnaroundMax, status: status(t), where: where(t), event: alerts.get(id) ?? null });
    listed.add(id);
  }
  // Visit records that left the simulation without a gate-out (defensive: the engine always records one).
  for (const v of Object.values(s.logistics.vehicles)) {
    if (v.class !== 'external' || listed.has(v.id) || s.logistics.active.includes(v.id) || v.spawned > now) continue;
    const t = v as TruckRuntime;
    if (t.visit?.gateOut != null || t.visit == null || t.visit.gateIn > now) continue;
    rows.push({
      id: v.id,
      label: v.label,
      reason: 'No gate-out record',
      minutes: now - t.visit.gateIn,
      limit: s.rules.turnaroundMax,
      v: t,
      integrity: visitIntegrity(s, t),
      over: 0,
      status: 'Not simulated on site',
      where: where(t),
      event: alerts.get(v.id) ?? null,
    });
    listed.add(v.id);
  }
  const pipe = pipeline(s);
  const pos = new Map(pipe.stages.queue.map((x) => [x.v.id, x.place.queuePos]));
  const watch: WatchRow[] = externalVehicles(s)
    .filter((v) => v.phase === 'waiting' && v.queuedAt != null && v.visit!.gateIn <= now && !listed.has(v.id))
    .map((v) => ({ id: v.id, v, minutes: now - v.queuedAt!, limit: s.rules.truckWaitMax, status: status(v), where: where(v), queuePos: pos.get(v.id) ?? null }))
    .sort((a, b) => b.minutes - a.minutes);
  return {
    delayed: rows.filter((r) => r.integrity.kind !== 'incomplete'),
    incomplete: rows.filter((r) => r.integrity.kind === 'incomplete'),
    watch,
  };
}

/** Short marker text for a delayed truck on the map, e.g. "Waiting 38 min · limit 25". */
export function delayMarker(r: Pick<DelayRow, 'reason' | 'minutes' | 'limit'>): string {
  const what = r.reason === 'Waiting for a dock' ? 'Waiting' : r.reason === 'At the dock' ? 'At dock' : r.reason === 'On site' ? 'On site' : r.reason;
  return `${what} ${dur(r.minutes)} · limit ${r.limit} min`;
}

// ── Dock usage & page summary ───────────────────────────────────────────────

export function dockUsage(s: SimState) {
  const rows = dockBoard(s);
  return {
    rows,
    occupied: rows.filter((r) => r.status === 'loading' || r.status === 'paperwork' || r.status === 'held').length,
    reserved: rows.filter((r) => r.status === 'reserved').length,
    held: rows.filter((r) => r.status === 'held').length,
    total: DOCKS.length,
  };
}

/** One data-driven sentence: trucks on site, waiting / delayed with the worst one, dock usage, records to check. */
export function fleetSummary(s: SimState, review: DelayReview, docks: ReturnType<typeof dockUsage>): string {
  const now = s.minute;
  const trucks = externalVehicles(s).filter((v) => v.visit!.gateIn <= now).length;
  const internal = internalVehicles(s).length;
  const parts: string[] = [`${trucks} truck${trucks === 1 ? '' : 's'} on site and ${internal} internal vehicle${internal === 1 ? '' : 's'} (simulated positions).`];
  const w = review.watch.length;
  if (review.delayed.length) {
    const top = review.delayed[0];
    const n = review.delayed.length;
    parts.push(
      `${n} truck${n === 1 ? ' is' : 's are'} past a limit — worst ${top.id}: ${top.reason.toLowerCase()} ${dur(top.minutes)} (limit ${top.limit} min)${w ? `; ${w} more waiting for a dock within the limit` : ''}.`,
    );
  } else if (w) {
    parts.push(`No truck is past a limit; ${w} waiting for a dock (longest ${review.watch[0].id}, ${dur(review.watch[0].minutes)} of ${review.watch[0].limit} min).`);
  } else parts.push('No truck is waiting for a dock or past a waiting, dock or turnaround limit.');
  parts.push(`${docks.occupied} of ${docks.total} docks occupied${docks.reserved ? `, ${docks.reserved} reserved for an arriving truck` : ''}${docks.held ? ` (${docks.held} on a documentation hold)` : ''}.`);
  const k = review.incomplete.length;
  if (k) parts.push(`${k} visit record${k === 1 ? '' : 's'} without a gate-out ${k === 1 ? 'looks' : 'look'} incomplete — flagged for checking, not counted as a real stay.`);
  return parts.join(' ');
}
