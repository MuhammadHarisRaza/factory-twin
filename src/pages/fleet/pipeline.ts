/**
 * Vehicle Monitoring derivations: the truck stage pipeline, loading state, period visit
 * statistics, internal-vehicle handling events and dwell, route trails and the vehicle events
 * of the shared event engine. Pure functions over the one simulation state — a truck's stage is
 * read from its visit phase, current leg activity and visit timestamps; nothing is stored here.
 */
import { CHECKIN_MIN } from '../../sim/logistics';
import type { Vec2 } from '../../data/types';
import { DATA_SOURCES, DEFAULT_EVENT_RULES, GEOFENCES } from '../../model/plant';
import type { EventRules, EventType, Evidence, Geofence, OpEvent, RestrictedZoneEvent, Vehicle, VehicleLeg } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { EVENT_RULE_DEFS, eventsFor, evidenceOf } from '../../sim/events';
import type { TruckRuntime } from '../../sim/logistics';
import { externalVehicles, internalActivity, internalVehicles, type Period } from '../../sim/metrics';
import { dayStart, formatClock } from '../../sim/time';
import { DOCK_NAME, externalRows, internalRows, type ExtRow, type IntRow } from './derive';

/**
 * Driver check-in at the gatehouse after parking in the holding area, before a truck can be called
 * to a dock. Mirrors CHECKIN_MIN in src/sim/logistics.ts (not exported there).
 */
export const DRIVER_CHECKIN_MIN = CHECKIN_MIN;

// ── Stages ────────────────────────────────────────────────────────────────────

export type StageKey = 'gate' | 'checkin' | 'holding' | 'queue' | 'dock' | 'staging' | 'exit';

export type StageDef = { key: StageKey; label: string; sub: string; def: string };

export const PIPELINE_STAGES: StageDef[] = [
  {
    key: 'gate',
    label: 'Entry gate',
    sub: 'before gate-in',
    def: 'Approaching the main gate on the access road (before gate-in). Arrivals injected by a scenario that have not reached the gate yet are shown as due.',
  },
  {
    key: 'checkin',
    label: 'Check-in / weighbridge',
    sub: 'gate stop · inbound weighing',
    def: 'Gate check-in stop (every truck), then for inbound tippers the drive to and the gross weighing on the weighbridge.',
  },
  {
    key: 'holding',
    label: 'Holding yard',
    sub: 'parked · driver check-in',
    def: `Outbound trucks driving to and parked in the holding area while the driver checks in at the gatehouse (${DRIVER_CHECKIN_MIN} min) — not yet callable to a dock.`,
  },
  {
    key: 'queue',
    label: 'Queue',
    sub: 'ready · first in, first out',
    def: 'Checked in and waiting for a free dock, first in first out. When the holding area is full the overflow waits on the road shoulder.',
  },
  {
    key: 'dock',
    label: 'Loading / unloading dock',
    sub: 'docking · loading · paperwork',
    def: 'Outbound: called to a dock, reversing on, loading, then paperwork & sealing (or a documentation hold). Inbound: driving to and unloading at the raw-material shed bay.',
  },
  {
    key: 'staging',
    label: 'Dispatch staging',
    sub: 'K-STG lanes → trailers',
    def: 'Pallet staging lanes (K-STG) that feed outbound loading: dispatch forklifts bring pallets from the racks through the lanes into the trailers. Shows the loads in progress — the trucks themselves are counted at the dock.',
  },
  {
    key: 'exit',
    label: 'Exit gate',
    sub: 'to gate · check-out',
    def: 'Undocked or unloaded and driving to the gate, gate check-out, leaving the site.',
  },
];
export const STAGE_BY_KEY = Object.fromEntries(PIPELINE_STAGES.map((x, i) => [x.key, { ...x, step: i + 1 }])) as Record<StageKey, StageDef & { step: number }>;

/** The leg a vehicle is on at minute t (last leg started at or before t). */
export function legAt(v: Vehicle, t: number): VehicleLeg | null {
  for (let i = v.legs.length - 1; i >= 0; i--) if (v.legs[i].start <= t) return v.legs[i];
  return null;
}

export type TruckPlace = {
  stage: StageKey;
  /** Short status within the stage. */
  status: string;
  /** Minute the truck entered the stage (null for a scheduled arrival). */
  since: number | null;
  /** Scheduled arrival injected by a scenario, not yet at the gate. */
  due: boolean;
  /** Waiting on the road shoulder because the holding area is full. */
  overflow: boolean;
  /** FIFO position among the trucks queued for a dock (1 = next). */
  queuePos: number | null;
};

/** Minute each truck's loading completed (dock 'loading-complete' events). */
export function loadingCompleteTimes(s: SimState): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of s.logistics.dockEvents) if (e.kind === 'loading-complete') out.set(e.vehicleId, e.time);
  return out;
}

export type LoadState = { label: string; done: boolean; loaded: number | null; load: number };

/** Loading / unloading state of a truck at minute `now`. */
export function loadState(v: TruckRuntime, now: number, completeAt: number | null): LoadState {
  const vis = v.visit!;
  if (vis.direction === 'inbound') {
    const started = vis.dockStart != null && vis.dockStart <= now;
    const ended = vis.dockEnd != null && vis.dockEnd <= now;
    return {
      label: ended ? `Unloaded · ${vis.load} t` : started ? `Unloading ${vis.material ?? ''}`.trim() : `${vis.load} t ${vis.material ?? ''} · not unloaded`.trim(),
      done: ended,
      loaded: null,
      load: vis.load,
    };
  }
  const loaded = Math.min(vis.load, v.palletsLoaded ?? 0);
  if (completeAt != null && completeAt <= now) return { label: `Loaded ${vis.load} pallets`, done: true, loaded: vis.load, load: vis.load };
  const docked = vis.dockStart != null && vis.dockStart <= now;
  if (!docked) return { label: `Not started · ${vis.load} pallets`, done: false, loaded: 0, load: vis.load };
  return { label: loaded > 0 ? `Loading ${loaded} / ${vis.load} pallets` : `Docked · 0 / ${vis.load} pallets`, done: false, loaded, load: vis.load };
}

const firstLeg = (v: Vehicle, activity: string | RegExp) =>
  v.legs.find((l) => (typeof activity === 'string' ? l.activity === activity : activity.test(l.activity))) ?? null;

/** Stage of one truck at minute `now`, from its phase, current leg and visit timestamps. */
export function truckPlace(v: TruckRuntime, now: number, completeAt: number | null): TruckPlace {
  const vis = v.visit!;
  const base = { due: false, overflow: false, queuePos: null };
  if (v.spawned > now) return { ...base, stage: 'gate', status: `Due ${formatClock(v.spawned)}`, since: null, due: true };
  const leg = legAt(v, now);
  const act = leg?.activity ?? '';
  const dock = vis.dockId ? DOCK_NAME[vis.dockId] : 'dock';
  switch (v.phase ?? 'approaching') {
    case 'approaching':
    case 'at-gate':
      return act === 'Gate check-in'
        ? { ...base, stage: 'checkin', status: 'Gate check-in', since: leg!.start }
        : { ...base, stage: 'gate', status: 'Approaching gate', since: vis.arrival };
    case 'weighing':
      return { ...base, stage: 'checkin', status: act.startsWith('Weighing') ? 'On weighbridge' : 'To weighbridge', since: firstLeg(v, 'Gate check-in')?.start ?? vis.gateIn };
    case 'to-holding':
      return { ...base, stage: 'holding', status: 'To holding area', since: vis.gateIn };
    case 'waiting': {
      const q = v.queuedAt ?? vis.gateIn;
      const overflow = leg != null && leg.zone !== 'GF-HOLD';
      if (now < q + DRIVER_CHECKIN_MIN) return { ...base, stage: 'holding', status: overflow ? 'Driver check-in · road shoulder' : 'Driver check-in', since: vis.gateIn, overflow };
      return { ...base, stage: 'queue', status: overflow ? 'Waiting · road shoulder' : 'Waiting for a dock', since: q + DRIVER_CHECKIN_MIN, overflow };
    }
    case 'to-dock':
      if (vis.direction === 'inbound') return { ...base, stage: 'dock', status: 'To unloading bay', since: firstLeg(v, 'To unloading bay')?.start ?? vis.gateIn };
      return { ...base, stage: 'dock', status: act.startsWith('Reversing') ? `Reversing onto ${dock}` : `To ${dock}`, since: vis.dockAssigned ?? vis.gateIn };
    case 'loading': {
      const ls = loadState(v, now, completeAt);
      const status = ls.done ? (v.holdExtra > 0 ? `Held (documentation) · ${dock}` : `Paperwork & sealing · ${dock}`) : `${ls.label} · ${dock}`;
      return { ...base, stage: 'dock', status, since: vis.dockAssigned ?? vis.dockStart ?? vis.gateIn };
    }
    case 'unloading':
      return { ...base, stage: 'dock', status: `Unloading ${vis.material ?? ''}`.trim(), since: firstLeg(v, 'To unloading bay')?.start ?? vis.dockStart ?? vis.gateIn };
    case 'departing':
      return { ...base, stage: 'exit', status: act === 'Gate check-out' ? 'Gate check-out' : 'To exit gate', since: vis.dockEnd ?? vis.gateIn };
    case 'departed':
      return { ...base, stage: 'exit', status: 'Leaving site', since: vis.dockEnd ?? vis.gateOut ?? vis.gateIn };
  }
}

export type PipelineTruck = { v: TruckRuntime; place: TruckPlace; inStage: number | null; load: LoadState };
export type StagingLoad = { v: TruckRuntime; dockId: string; loaded: number; load: number; forklifts: string[] };
export type DispatchForklift = { id: string; truckId: string | null; activity: string | null; zone: string | null };

export type Pipeline = {
  stages: Record<StageKey, PipelineTruck[]>;
  /** Outbound loads being supplied from the staging lanes (trucks at a dock, loading not complete). */
  loads: StagingLoad[];
  palletsToLoad: number;
  forklifts: DispatchForklift[];
  stock: number;
  /** External vehicles past gate-in and still on site (same count as fleetMetrics.onSite). */
  onSite: number;
  due: number;
};

export function pipeline(s: SimState): Pipeline {
  const now = s.minute;
  const L = s.logistics;
  const done = loadingCompleteTimes(s);
  const stages = Object.fromEntries(PIPELINE_STAGES.map((x) => [x.key, [] as PipelineTruck[]])) as Record<StageKey, PipelineTruck[]>;
  const trucks = externalVehicles(s);
  for (const v of trucks) {
    const c = done.get(v.id) ?? null;
    const place = truckPlace(v, now, c);
    stages[place.stage].push({ v, place, inStage: place.since != null ? Math.max(0, now - place.since) : null, load: loadState(v, now, c) });
  }
  const order = new Map(L.queue.map((id, i) => [id, i]));
  stages.queue.sort((a, b) => (order.get(a.v.id) ?? 1e9) - (order.get(b.v.id) ?? 1e9));
  stages.queue.forEach((x, i) => (x.place.queuePos = i + 1));
  for (const k of ['checkin', 'holding', 'dock', 'exit'] as StageKey[]) stages[k].sort((a, b) => (b.inStage ?? 0) - (a.inStage ?? 0));
  stages.gate.sort((a, b) => Number(a.place.due) - Number(b.place.due) || a.v.spawned - b.v.spawned);

  const forklifts: DispatchForklift[] = Object.entries(L.forklifts)
    .filter(([, f]) => f.role === 'dispatch')
    .map(([id, f]) => {
      const leg = legAt(L.vehicles[id], now);
      return { id, truckId: f.truckId, activity: leg?.activity ?? null, zone: leg?.zone ?? null };
    });
  const loads: StagingLoad[] = [];
  for (const [dockId, d] of Object.entries(L.docks)) {
    if (!d.vehicleId) continue;
    const v = L.vehicles[d.vehicleId] as TruckRuntime;
    const c = done.get(v.id) ?? null;
    if (v.visit?.direction !== 'outbound' || (c != null && c <= now)) continue;
    loads.push({ v, dockId, loaded: Math.min(v.visit.load, v.palletsLoaded ?? 0), load: v.visit.load, forklifts: forklifts.filter((f) => f.truckId === v.id).map((f) => f.id) });
  }
  loads.sort((a, b) => a.dockId.localeCompare(b.dockId));
  return {
    stages,
    loads,
    palletsToLoad: loads.reduce((a, x) => a + (x.load - x.loaded), 0),
    forklifts,
    stock: L.stockPallets,
    onSite: trucks.filter((v) => v.visit!.gateIn <= now).length,
    due: stages.gate.filter((x) => x.place.due).length,
  };
}

// ── Period statistics ─────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Loading duration (docked → loading complete) of outbound visits that left within the period. */
export function loadingStats(s: SimState, p: Period) {
  const done = loadingCompleteTimes(s);
  const xs: number[] = [];
  for (const v of s.logistics.departed) {
    const vis = v.visit!;
    if (vis.direction !== 'outbound' || vis.gateOut == null || vis.gateOut < p.from || vis.gateOut >= p.to || vis.dockStart == null) continue;
    const c = done.get(v.id);
    if (c != null && c >= vis.dockStart) xs.push(c - vis.dockStart);
  }
  return { avg: mean(xs), n: xs.length, max: xs.length ? Math.max(...xs) : null };
}

/** Current dwell of the internal vehicles in their zones (simulated positions, zone level). */
export function internalDwell(s: SimState) {
  const now = s.minute;
  const rows = internalVehicles(s)
    .map((v) => ({ v, a: internalActivity(v, now) }))
    .filter((x) => x.a.dwell != null);
  const longest = rows.reduce<(typeof rows)[number] | null>((m, x) => (!m || x.a.dwell! > m.a.dwell! ? x : m), null);
  return {
    avg: mean(rows.map((x) => x.a.dwell!)),
    n: rows.length,
    longest: longest ? { id: longest.v.id, dwell: longest.a.dwell!, zone: longest.a.zone } : null,
  };
}

// ── Internal vehicles: handling events, route trail ───────────────────────────

export type HandlingEvent = {
  id: string;
  vehicleId: string;
  kind: 'pickup' | 'dropoff';
  time: number;
  activity: string;
  zone: string;
  /** Dock served, for pallets placed into a trailer. */
  dock?: string;
};

const PICK_STOP = /pick|loading from/i;

/**
 * Pickups and drop-offs of one vehicle from its legs: a pickup where the vehicle becomes loaded,
 * a drop-off where it becomes empty again. Only movements that have happened by `now`.
 */
export function handlingEvents(v: Vehicle, now: number, from = -Infinity): HandlingEvent[] {
  const out: HandlingEvent[] = [];
  const legs = v.legs;
  for (let i = 1; i < legs.length; i++) {
    const cur = legs[i];
    const prev = legs[i - 1];
    if (cur.start > now) break;
    if (cur.start < from) continue;
    if (!!cur.loaded === !!prev.loaded) continue;
    if (cur.loaded) {
      const named = !prev.moving && PICK_STOP.test(prev.activity) ? prev : cur;
      out.push({ id: `${v.id}@${cur.start.toFixed(3)}-p`, vehicleId: v.id, kind: 'pickup', time: cur.start, activity: named.activity, zone: named.zone });
    } else {
      const drive = legs[i - 2];
      const dock = drive?.activity.startsWith('Loading Dock') ? drive.activity.slice('Loading '.length) : undefined;
      out.push({ id: `${v.id}@${cur.start.toFixed(3)}-d`, vehicleId: v.id, kind: 'dropoff', time: cur.start, activity: prev.activity, zone: prev.zone, dock });
    }
  }
  return out;
}

/** Handling events of every internal vehicle since `from`, newest first. */
export function allHandling(s: SimState, from: number): HandlingEvent[] {
  const now = s.minute;
  return internalVehicles(s)
    .flatMap((v) => handlingEvents(v, now, from))
    .sort((a, b) => b.time - a.time || a.vehicleId.localeCompare(b.vehicleId));
}

const segLen = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Point of a moving leg at time t and the index of the segment it lies on. */
function pointOnLeg(leg: VehicleLeg, t: number): { p: Vec2; i: number } {
  const total = leg.path.slice(1).reduce((a, q, i) => a + segLen(leg.path[i], q), 0);
  const f = leg.end > leg.start ? Math.min(1, Math.max(0, (t - leg.start) / (leg.end - leg.start))) : 1;
  let d = f * total;
  for (let i = 0; i < leg.path.length - 1; i++) {
    const a = leg.path[i];
    const b = leg.path[i + 1];
    const seg = segLen(a, b);
    if (d <= seg || i === leg.path.length - 2) {
      const k = seg > 0 ? Math.min(1, d / seg) : 0;
      return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], i };
    }
    d -= seg;
  }
  return { p: leg.path[leg.path.length - 1], i: Math.max(0, leg.path.length - 2) };
}

/** Route travelled between `from` and `to` (fractional minutes) as one polyline on the ground plane. */
export function trail(v: Vehicle, from: number, to: number): Vec2[] {
  const pts: Vec2[] = [];
  const add = (p: Vec2) => {
    const last = pts[pts.length - 1];
    if (!last || segLen(last, p) > 0.05) pts.push(p);
  };
  for (const leg of v.legs) {
    if (leg.start > to) break;
    const end = Number.isFinite(leg.end) ? leg.end : to;
    if (end < from) continue;
    if (!leg.moving || leg.path.length < 2) {
      add(leg.path[0]);
      continue;
    }
    const a = pointOnLeg(leg, Math.max(from, leg.start));
    const b = pointOnLeg(leg, Math.min(to, leg.end));
    add(a.p);
    for (let k = a.i + 1; k <= b.i; k++) add(leg.path[k]);
    add(b.p);
  }
  return pts;
}

export const trailPath = (pts: Vec2[]) => (pts.length < 2 ? '' : `M${pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L')}`);

// ── Vehicle events (shared event engine) ─────────────────────────────────────

export const VEHICLE_EVENT_TYPES: EventType[] = ['truck-waiting', 'dock-overstay', 'yard-congestion', 'turnaround-exceeded', 'restricted-entry'];
const TYPE_SET = new Set<EventType>(VEHICLE_EVENT_TYPES);

/** Vehicle events touching the period: condition still active first, then open, then newest. */
export function vehicleEvents(s: SimState, p: Period): OpEvent[] {
  return eventsFor(s, { category: 'logistics', from: p.from })
    .filter((e) => TYPE_SET.has(e.type))
    .sort((a, b) => Number(a.end != null) - Number(b.end != null) || Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.start - a.start);
}

/** Vehicles with a vehicle event whose condition is still active → most severe such event. */
export function activeVehicleEvents(s: SimState): Map<string, OpEvent> {
  const rank = { info: 0, warning: 1, serious: 2, critical: 3 } as const;
  const out = new Map<string, OpEvent>();
  for (const e of s.events) {
    if (e.end != null || !e.asset.vehicleId || !TYPE_SET.has(e.type)) continue;
    const cur = out.get(e.asset.vehicleId);
    if (!cur || rank[e.severity] > rank[cur.severity]) out.set(e.asset.vehicleId, e);
  }
  return out;
}

export const timelineEvidence = (s: SimState, ev: OpEvent): Evidence[] => evidenceOf(s, ev).filter((x) => x.kind === 'vehicle-timeline');
export const snapshotEvidence = (s: SimState, ev: OpEvent): Evidence | null => evidenceOf(s, ev).find((x) => x.kind === 'camera-snapshot') ?? null;

// ── Safety configuration & capabilities that are not available ───────────────

/** Restricted geofences configured for internal vehicles (checked against simulated positions). */
export const SAFETY_ZONES = GEOFENCES.filter((g) => g.kind === 'restricted');

export type Unavailable = { id: string; label: string; needs: string; instead: string; status: string };

const rule = (id: string) => EVENT_RULE_DEFS.find((r) => r.id === id);
const TEL = DATA_SOURCES.find((d) => d.id === 'TEL');

export const NOT_AVAILABLE: Unavailable[] = [
  {
    id: 'L-PROX',
    label: rule('L-PROX')?.label ?? 'Vehicle–pedestrian proximity',
    status: rule('L-PROX')?.unavailableReason ?? 'No proximity sensing configured',
    needs: `${rule('L-PROX')?.description ?? 'Needs proximity sensing.'} Tags or a certified proximity-warning system per vehicle, with an event feed into the platform.`,
    instead: 'Only restricted-geofence entries on simulated positions are checked; near-misses cannot be assessed.',
  },
  {
    id: 'L-ROUTE',
    label: rule('L-ROUTE')?.label ?? 'Route deviation',
    status: rule('L-ROUTE')?.unavailableReason ?? 'No tracking integration',
    needs: `${rule('L-ROUTE')?.description ?? 'Needs actual vehicle locations.'} Plus the planned route per task from the WMS / yard system.`,
    instead: 'Vehicles follow fixed simulated routes, so a deviation cannot occur or be detected.',
  },
  {
    id: 'GPS',
    label: 'GPS / telematics',
    status: TEL ? `${TEL.name}: ${TEL.status}` : 'Not connected',
    needs: `Carrier or fleet telematics API (position, speed, ignition, ETA) mapped to truck visits${TEL ? ` — integration boundary: ${TEL.protocol}` : ''}.`,
    instead: 'Positions are a visualisation of the simulated movement at zone level; arrivals come from the simulation.',
  },
  {
    id: 'ANPR',
    label: 'ANPR (number-plate recognition)',
    status: 'No gate cameras or ANPR system connected',
    needs: 'ANPR cameras at the main gate and a plate → booking match against dispatch orders (ERP) or the gate system.',
    instead: 'Gate-in / gate-out events are simulated; truck ids are simulation ids, not plates.',
  },
  {
    id: 'CCTV',
    label: 'CCTV analytics',
    status: 'No camera stream or video model connected',
    needs: 'Camera streams through a video gateway (RTSP / ONVIF → WebRTC, HLS or MJPEG) plus a validated vehicle / person detection model.',
    instead: 'Camera views are rendered from the digital twin; no video analytics runs on them.',
  },
];

// ── Table rows ────────────────────────────────────────────────────────────────

export type TruckRow = ExtRow & {
  /** Stage now (null once the truck has left the site). */
  place: TruckPlace | null;
  load: LoadState;
  /** Docked → loading complete (outbound, once complete). */
  loading: number | null;
  /** Most severe vehicle event whose condition is still active. */
  alert: OpEvent | null;
};

/** External vehicles on site plus those that left in the period, with stage, loading state and alert. */
export function truckRows(s: SimState, p: Period, alerts: Map<string, OpEvent> = activeVehicleEvents(s)): TruckRow[] {
  const now = s.minute;
  const done = loadingCompleteTimes(s);
  return externalRows(s, p).map((r) => {
    const c = done.get(r.id) ?? null;
    const vis = r.v.visit!;
    return {
      ...r,
      place: r.active ? truckPlace(r.v, now, c) : null,
      load: loadState(r.v, now, c),
      loading: c != null && vis.dockStart != null && c <= now ? c - vis.dockStart : null,
      alert: alerts.get(r.id) ?? null,
    };
  });
}

/** Movement state of an internal vehicle: driving, stationary at a task, or idle / waiting. */
export type MovementState = 'moving' | 'working' | 'idle';

const IDLE_ACTIVITY = /idle|waiting|available/i;

export function movementState(leg: VehicleLeg | null, now: number): MovementState {
  if (!leg) return 'idle';
  if (leg.moving && leg.end > now) return 'moving';
  return IDLE_ACTIVITY.test(leg.activity) ? 'idle' : 'working';
}

export type InternalRow = IntRow & {
  movement: MovementState;
  loaded: boolean;
  /** Latest pickup or drop-off (any time in the retained movement history). */
  last: HandlingEvent | null;
  /** Pickups + drop-offs in the last 60 min (or since `historyFrom` if that is later). */
  handled60: number;
  /** Oldest movement still retained for this vehicle (the simulation keeps the last 60 legs). */
  historyFrom: number | null;
  /** Restricted geofence the vehicle is inside right now (simulated position). */
  insideRestricted: string | null;
  alert: OpEvent | null;
};

export function internalTableRows(s: SimState, alerts: Map<string, OpEvent> = activeVehicleEvents(s)): InternalRow[] {
  const now = s.minute;
  return internalRows(s).map((r) => {
    const leg = legAt(r.v, now);
    const all = handlingEvents(r.v, now);
    return {
      ...r,
      movement: movementState(leg, now),
      loaded: !!leg?.loaded,
      last: all.at(-1) ?? null,
      handled60: all.filter((h) => h.time >= now - 60).length,
      historyFrom: r.v.legs[0]?.start ?? null,
      insideRestricted: s.logistics.restrictedOpen[r.id]?.geofenceId ?? null,
      alert: alerts.get(r.id) ?? null,
    };
  });
}

/**
 * Start of the window in which the handling history is complete for every internal vehicle:
 * the later of `now − minutes` and the newest "oldest retained leg" across vehicles.
 */
export function handlingWindow(s: SimState, minutes = 60): number {
  const now = s.minute;
  let from = now - minutes;
  for (const v of internalVehicles(s)) {
    const first = v.legs[0]?.start;
    if (first != null && first > from && first <= now) from = first;
  }
  return Math.min(now, from);
}

// ── Detection rules & restricted zones ───────────────────────────────────────

export type RuleLimit = { unit: string; min: number; max: number; step: number };

/** Editable logistics thresholds (EventRules keys) with sensible input bounds. */
export const LOGISTICS_RULE_LIMITS: Partial<Record<keyof EventRules, RuleLimit>> = {
  truckWaitMax: { unit: 'min', min: 5, max: 180, step: 5 },
  dockStayMax: { unit: 'min', min: 15, max: 300, step: 5 },
  yardQueueMax: { unit: 'trucks', min: 2, max: 15, step: 1 },
  turnaroundMax: { unit: 'min', min: 30, max: 600, step: 10 },
};

export type RuleRow = {
  id: string;
  type: EventType;
  label: string;
  description: string;
  key: keyof EventRules | null;
  limit: RuleLimit | null;
  value: number | null;
  def: number | null;
  /** Events of this rule touching the period, and how many are still active. */
  count: number;
  active: number;
};

/** The vehicle detection rules of the shared event engine with their current thresholds. */
export function ruleRows(s: SimState, p: Period): RuleRow[] {
  const evs = vehicleEvents(s, p);
  return EVENT_RULE_DEFS.filter((r) => r.category === 'logistics' && r.available && r.type && TYPE_SET.has(r.type)).map((r) => {
    const key = r.threshold ?? null;
    const of = evs.filter((e) => e.type === r.type);
    return {
      id: r.id,
      type: r.type!,
      label: r.label,
      description: r.description,
      key,
      limit: key ? (LOGISTICS_RULE_LIMITS[key] ?? null) : null,
      value: key ? (s.rules[key] as number) : null,
      def: key ? (DEFAULT_EVENT_RULES[key] as number) : null,
      count: of.length,
      active: of.filter((e) => e.end == null).length,
    };
  });
}

export type ZoneRow = { g: Geofence; today: number; last: RestrictedZoneEvent | null; inside: string[] };

/** Configured restricted geofences with today's entries and the vehicles inside now. */
export function zoneRows(s: SimState): ZoneRow[] {
  const now = s.minute;
  const from = dayStart(now);
  const L = s.logistics;
  return SAFETY_ZONES.map((g) => {
    const today = L.restrictedEvents.filter((r) => r.geofenceId === g.id && r.time >= from && r.time <= now);
    const inside = Object.entries(L.restrictedOpen)
      .filter(([, o]) => o?.geofenceId === g.id)
      .map(([id]) => id);
    return { g, today: today.length, last: today.at(-1) ?? null, inside };
  });
}

// ── Scenario targets (Simulate buttons) ──────────────────────────────────────

/** Trucks injected by "Simulate yard congestion" (two minutes apart). */
export const CONGESTION_TRUCKS = 10;
/** Extra dock dwell added by "Simulate prolonged dock stay" (min). */
export const DOCK_HOLD_MIN = 75;
/** Packaging forklift whose next run crosses the walkway in "Simulate restricted-zone entry". */
export const RESTRICTED_VEHICLE = 'FL-05';

export type DockHoldTarget = { dockId: string; name: string; truckId: string; held: boolean };

/**
 * Docked truck a prolonged-stay scenario acts on: the selected truck when it is at a dock,
 * else the longest-docked truck that is not already held, else any docked truck.
 */
export function dockHoldTarget(s: SimState, selectedId: string | null): DockHoldTarget | null {
  const L = s.logistics;
  const docked = Object.entries(L.docks)
    .filter(([, d]) => d.vehicleId)
    .map(([dockId, d]) => ({ dockId, truck: L.vehicles[d.vehicleId!] as TruckRuntime, since: d.since ?? s.minute }));
  if (!docked.length) return null;
  const pick =
    docked.find((x) => x.truck.id === selectedId) ?? [...docked].filter((x) => x.truck.holdExtra === 0).sort((a, b) => a.since - b.since)[0] ?? docked[0];
  return { dockId: pick.dockId, name: DOCK_NAME[pick.dockId] ?? pick.dockId, truckId: pick.truck.id, held: pick.truck.holdExtra > 0 };
}

/** Whether a restricted-zone entry can be simulated now (and why not). */
export function restrictedEntryGate(s: SimState): { ok: true } | { ok: false; reason: string } {
  const fl = s.logistics.forklifts[RESTRICTED_VEHICLE];
  if (!fl || !s.logistics.vehicles[RESTRICTED_VEHICLE]) return { ok: false, reason: `Forklift ${RESTRICTED_VEHICLE} is not in the simulation` };
  if (fl.forceShortcut) return { ok: false, reason: `${RESTRICTED_VEHICLE} already has a walkway run pending — it starts on its next empty-pallet run` };
  return { ok: true };
}
