/**
 * Logistics simulation: external trucks (outbound dispatch and inbound raw material)
 * and internal vehicles (warehouse forklifts, packaging forklift, wheel loader).
 *
 * Vehicles move along fixed routes drawn on the site's roads, yards and aisles, so they
 * never cut through buildings or machinery. Each movement is a timed leg; the pose at
 * any (fractional) minute is interpolated from the legs, which is what the 3D scene and
 * the site map draw. Events (gate in/out, dock assigned/docked/undocked, restricted-zone
 * entries) are emitted when simulation time passes them — never ahead of time.
 *
 * Positions are a visualisation of the simulated movement at zone level; no GPS,
 * ANPR or indoor positioning is involved.
 */
import type { Vec2 } from '../data/types';
import { DOCKS, GEOFENCES } from '../model/plant';
import type {
  DockEvent,
  GateEvent,
  RestrictedZoneEvent,
  ScenarioActivation,
  Vehicle,
  VehicleLeg,
  VehicleVisitPhase,
} from '../model/types';
import type { SimState } from './engine';
import { nextId, raiseAlert } from './engine';
import { expBounded, lerpRange, streamFor, type Rng } from './rng';

// ── Geometry ──────────────────────────────────────────────────────────────────

const SPEED = { road: 6, yard: 3.5, reverse: 1.4, forklift: 2.6, forkliftLoaded: 2.0, loader: 2.2 };
/** Truck origin when backed onto a dock (trailer rear on the bumpers). */
const DOCKED_Z = 69.8;
const HOLDING_SLOTS: Vec2[] = [55, 59.5, 64, 68.5, 73, 77.5, 82, 86].map((z): Vec2 => [-40, z]);
/** Overflow queue on the perimeter-road shoulder when the holding area is full. */
const OVERFLOW_SLOTS: Vec2[] = [-2, 15, 32, 49, 66].map((x): Vec2 => [x, 93]);
const GATE_STOP_IN: Vec2 = [80, 106.5];
const GATE_STOP_OUT: Vec2 = [80, 101];
const PUBLIC_EAST: Vec2 = [150, 110];

const PUT_STATION: Vec2 = [-89.5, 20];
const AISLES_Z = [12.85, 19.35, 25.85, 32.35, 38.85];
const CROSS_X = -92;
const FRONT_Z = 47;
const LOADER_LOOP: Vec2[] = [
  [-108, -31],
  [-94, -31],
  [-96, -16],
  [-106, -16],
];

/** Dock preparation before loading starts (leveller, seal, load check) and paperwork after it. */
const DOCK_PREP_MIN = 8;
const PAPERWORK_MIN = 12;
/** Driver check-in before a waiting truck may be called to a dock. */
const CHECKIN_MIN = 6;

const CARRIERS = ['Indus Freight', 'Ravi Haulage', 'Northline Logistics', 'Margalla Transport', 'Crescent Carriers'];
const RAW_MATERIALS = ['Ball clay', 'Feldspar', 'Silica sand', 'Kaolin'];

const len = (p: Vec2[]) => p.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
/** Heading convention of the 3D model: rotation.y = -atan2(dz, dx) for travel along +x. */
const headingOf = (a: Vec2, b: Vec2) => -Math.atan2(b[1] - a[1], b[0] - a[0]);

// ── State ─────────────────────────────────────────────────────────────────────

type DockRuntime = { vehicleId: string | null; reservedBy: string | null; since: number | null };

type TimelineEvent = { time: number; kind: string; vehicleId: string; data?: Record<string, unknown> };

type ForkliftRuntime = {
  role: 'putaway' | 'dispatch' | 'packaging';
  home: Vec2;
  busyUntil: number;
  /** Dispatch assignment. */
  truckId: string | null;
  cycle: number;
};

export type TruckRuntime = Vehicle & {
  slot: number | null;
  /** Extra dock dwell added by scenarios (min). */
  holdExtra: number;
  queuedAt: number | null;
  /** Pallets loaded so far (outbound). */
  palletsLoaded?: number;
};

export type LogisticsState = {
  vehicles: Record<string, Vehicle>;
  /** Ids of vehicles currently simulated (internal + external on site). */
  active: string[];
  /** External vehicles that have left the site (for turnaround statistics). */
  departed: TruckRuntime[];
  gateEvents: GateEvent[];
  dockEvents: DockEvent[];
  restrictedEvents: RestrictedZoneEvent[];
  docks: Record<string, DockRuntime>;
  /** Dock id → hour → occupied minutes. */
  dockBusy: Record<string, Map<number, number>>;
  holding: (string | null)[];
  queue: string[];
  timeline: TimelineEvent[];
  forklifts: Record<string, ForkliftRuntime>;
  nextOutbound: number;
  nextInbound: number;
  truckSeq: number;
  rng: { outbound: Rng; inbound: Rng; forklift: Rng };
  palletsProduced: number;
  putawayQueue: number;
  stockPallets: number;
  restrictedOpen: Record<string, { geofenceId: string; eventId: string } | null>;
};

export function createLogistics(seed: number): LogisticsState {
  const st: LogisticsState = {
    vehicles: {},
    active: [],
    departed: [],
    gateEvents: [],
    dockEvents: [],
    restrictedEvents: [],
    docks: Object.fromEntries(DOCKS.map((d) => [d.id, { vehicleId: null, reservedBy: null, since: null }])),
    dockBusy: Object.fromEntries(DOCKS.map((d) => [d.id, new Map()])),
    holding: HOLDING_SLOTS.map(() => null),
    queue: [],
    timeline: [],
    forklifts: {},
    nextOutbound: 25,
    nextInbound: 50,
    truckSeq: 1040,
    rng: { outbound: streamFor(seed, 'outbound'), inbound: streamFor(seed, 'inbound'), forklift: streamFor(seed, 'forklift') },
    palletsProduced: 0,
    putawayQueue: 0,
    stockPallets: 1100,
    restrictedOpen: {},
  };
  const internal: [string, ForkliftRuntime['role'], Vec2, string][] = [
    ['FL-01', 'putaway', PUT_STATION, 'Put-away'],
    ['FL-02', 'dispatch', [-104, FRONT_Z], 'Dispatch loading'],
    ['FL-03', 'dispatch', [-116, FRONT_Z], 'Dispatch loading'],
    ['FL-04', 'dispatch', [-98, FRONT_Z - 1.5], 'Dispatch loading'],
    ['FL-05', 'packaging', [-48.5, 25.5], 'Packaging floor'],
  ];
  for (const [id, role, home, task] of internal) {
    st.vehicles[id] = {
      id,
      class: 'internal',
      type: 'forklift',
      label: `Forklift ${id.slice(3)}`,
      operator: role === 'packaging' ? 'Packaging' : 'Warehouse',
      legs: [stop(0, Infinity, home, role === 'packaging' ? 'GF-PACK' : 'GF-RACK', 'Idle', 0)],
      zoneLog: [{ zone: role === 'packaging' ? 'GF-PACK' : 'GF-RACK', start: 0 }],
      task,
      spawned: 0,
    };
    st.active.push(id);
    st.forklifts[id] = { role, home, busyUntil: 0, truckId: null, cycle: 0 };
  }
  st.vehicles['WL-01'] = {
    id: 'WL-01',
    class: 'internal',
    type: 'wheel-loader',
    label: 'Wheel loader 01',
    operator: 'Raw materials',
    legs: [],
    task: 'Bay → box feeder transfer',
    spawned: 0,
  };
  st.active.push('WL-01');
  return st;
}

// ── Leg builders ──────────────────────────────────────────────────────────────

function drive(start: number, path: Vec2[], speed: number, zone: string, activity: string, opts: Partial<VehicleLeg> = {}): VehicleLeg {
  return { start, end: start + len(path) / speed / 60, path, zone, activity, moving: true, ...opts };
}

function stop(start: number, end: number, at: Vec2, zone: string, activity: string, face: number, opts: Partial<VehicleLeg> = {}): VehicleLeg {
  return { start, end, path: [at], zone, activity, moving: false, face, ...opts };
}

const lastLeg = (v: Vehicle) => v.legs[v.legs.length - 1];
const endOf = (v: Vehicle) => lastLeg(v).end;
const posEnd = (leg: VehicleLeg): Vec2 => leg.path[leg.path.length - 1];
const faceEnd = (leg: VehicleLeg) => {
  if (leg.path.length < 2) return leg.face ?? 0;
  const a = leg.path[leg.path.length - 2];
  const b = leg.path[leg.path.length - 1];
  return leg.reverse ? headingOf(b, a) : headingOf(a, b);
};

function push(v: Vehicle, leg: VehicleLeg) {
  const prev = lastLeg(v);
  v.legs.push(leg);
  if (v.class !== 'internal') return;
  // Zone entries outlive the pruned legs so dwell time stays right for long stays in one zone.
  if (!prev || prev.zone !== leg.zone) {
    const log = (v.zoneLog ??= []);
    log.push({ zone: leg.zone, start: leg.start });
    if (log.length > 40) log.splice(0, log.length - 40);
  }
  if (v.legs.length > 60) v.legs.splice(0, v.legs.length - 60);
}

/** Close an open (end = Infinity) stop at `t` and continue with `next` legs. */
function closeOpen(v: Vehicle, t: number) {
  const l = lastLeg(v);
  if (l && l.end === Infinity) l.end = Math.max(l.start, t);
}

function schedule(st: LogisticsState, ev: TimelineEvent) {
  st.timeline.push(ev);
  st.timeline.sort((a, b) => a.time - b.time);
}

// ── Pose (shared by 3D scene, site map and geofencing) ───────────────────────

export type Pose = { x: number; z: number; heading: number; moving: boolean; leg: VehicleLeg | null };

export function poseAt(v: Vehicle, t: number): Pose | null {
  if (t < v.spawned || (v.despawned != null && t >= v.despawned) || !v.legs.length) return null;
  let leg = v.legs[v.legs.length - 1];
  for (let i = v.legs.length - 1; i >= 0; i--) {
    if (v.legs[i].start <= t) {
      leg = v.legs[i];
      break;
    }
  }
  if (!leg.moving || leg.path.length < 2) {
    const [x, z] = leg.path[0];
    return { x, z, heading: leg.face ?? 0, moving: false, leg };
  }
  const total = len(leg.path);
  const f = leg.end > leg.start ? Math.min(1, Math.max(0, (t - leg.start) / (leg.end - leg.start))) : 1;
  let d = f * total;
  for (let i = 0; i < leg.path.length - 1; i++) {
    const a = leg.path[i];
    const b = leg.path[i + 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= seg || i === leg.path.length - 2) {
      const k = seg > 0 ? Math.min(1, d / seg) : 0;
      return {
        x: a[0] + (b[0] - a[0]) * k,
        z: a[1] + (b[1] - a[1]) * k,
        heading: leg.reverse ? headingOf(b, a) : headingOf(a, b),
        moving: f < 1,
        leg,
      };
    }
    d -= seg;
  }
  return null;
}

export const geofenceAt = (x: number, z: number, kinds?: string[]) =>
  GEOFENCES.find((g) => (!kinds || kinds.includes(g.kind)) && x >= g.rect.x[0] && x <= g.rect.x[1] && z >= g.rect.z[0] && z <= g.rect.z[1]);

// ── Step ──────────────────────────────────────────────────────────────────────

export function stepLogistics(s: SimState, t: number) {
  const st = s.logistics;
  spawnArrivals(s, t);
  // Process due timeline events in time order.
  while (st.timeline.length && st.timeline[0].time < t + 1) {
    const ev = st.timeline.shift()!;
    handleEvent(s, ev);
  }
  assignDocks(s, t);
  runForklifts(s, t);
  runLoader(st, t);
  accounting(s, t);
}

function spawnArrivals(s: SimState, t: number) {
  const st = s.logistics;
  const hourOfDay = Math.floor((t % 1440) / 60) + 6;
  const day = hourOfDay % 24 >= 6 && hourOfDay % 24 < 22;
  if (t >= st.nextOutbound) {
    spawnTruck(s, t, 'outbound');
    // ≈ 12 outbound visits a day, balancing the line's ≈ 105 pallets/day.
    st.nextOutbound = t + Math.round(expBounded(st.rng.outbound(), day ? 95 : 220, 20, 300));
  }
  if (t >= st.nextInbound) {
    if (day) spawnTruck(s, t, 'inbound');
    st.nextInbound = t + Math.round(expBounded(st.rng.inbound(), day ? 140 : 300, 40, 360));
  }
}

export function spawnTruck(s: SimState, t: number, direction: 'outbound' | 'inbound', scenarioId?: string): Vehicle {
  const st = s.logistics;
  const r = direction === 'outbound' ? st.rng.outbound : st.rng.inbound;
  const id = `TRK-${++st.truckSeq}`;
  const approach = drive(t, [PUBLIC_EAST, [80, 110], GATE_STOP_IN], SPEED.road, 'GF-GATE', 'Approaching gate');
  const gate = stop(approach.end, approach.end + 1.5, GATE_STOP_IN, 'GF-GATE', 'Gate check-in', Math.PI / 2);
  const load = direction === 'outbound' ? Math.round(lerpRange(r(), 6, 10)) : Math.round(lerpRange(r(), 18, 28));
  const v: TruckRuntime = {
    id,
    class: 'external',
    type: direction === 'outbound' ? 'outbound-truck' : 'inbound-tipper',
    label: id.replace('-', ' '),
    operator: CARRIERS[Math.floor(r() * CARRIERS.length)],
    legs: [approach, gate],
    phase: 'approaching',
    spawned: t,
    visit: {
      direction,
      arrival: t,
      gateIn: gate.end,
      dockId: null,
      dockAssigned: null,
      dockStart: null,
      dockEnd: null,
      gateOut: null,
      load,
      material: direction === 'inbound' ? RAW_MATERIALS[Math.floor(r() * RAW_MATERIALS.length)] : undefined,
      scenarioId,
    },
    slot: null,
    holdExtra: 0,
    queuedAt: null,
  };
  st.vehicles[id] = v;
  st.active.push(id);
  schedule(st, { time: gate.end, kind: 'gate-in', vehicleId: id });
  return v;
}

function handleEvent(s: SimState, ev: TimelineEvent) {
  const st = s.logistics;
  const v = st.vehicles[ev.vehicleId] as TruckRuntime;
  const t = ev.time;
  switch (ev.kind) {
    case 'gate-in': {
      st.gateEvents.push({ id: nextId(s, 'GE'), time: t, vehicleId: v.id, direction: 'in', source: v.visit!.scenarioId ? 'scenario' : 'simulation' });
      if (v.visit!.direction === 'outbound') toHolding(s, v, t);
      else toWeighbridge(st, v, t);
      break;
    }
    case 'arrive-holding':
      v.phase = 'waiting';
      v.queuedAt = t;
      st.queue.push(v.id);
      if (st.queue.length >= 5 && t - (s.internal.alertAt['yard'] ?? -1e9) > 60) {
        s.internal.alertAt['yard'] = t;
        raiseAlert(s, t, 'warning', 'Yard congestion', `${st.queue.length} trucks waiting for a dock`, { vehicleId: v.id }, 'simulation');
      }
      break;
    case 'docked': {
      const dockId = ev.data!.dockId as string;
      v.phase = 'loading';
      v.visit!.dockStart = t;
      st.docks[dockId].vehicleId = v.id;
      st.docks[dockId].since = t;
      st.dockEvents.push({ id: nextId(s, 'DE'), time: t, vehicleId: v.id, dockId, kind: 'docked', source: 'simulation' });
      break;
    }
    case 'loading-complete': {
      const dockId = v.visit!.dockId!;
      st.dockEvents.push({ id: nextId(s, 'DE'), time: t, vehicleId: v.id, dockId, kind: 'loading-complete', source: 'simulation' });
      st.stockPallets -= v.visit!.load;
      const undock = t + PAPERWORK_MIN + v.holdExtra;
      lastLeg(v).activity = v.holdExtra > 0 ? 'Held at dock (documentation)' : 'Paperwork & sealing';
      lastLeg(v).loaded = true;
      schedule(st, { time: undock, kind: 'undock', vehicleId: v.id });
      break;
    }
    case 'undock': {
      const dockId = v.visit!.dockId!;
      closeOpen(v, t);
      lastLeg(v).end = t;
      v.visit!.dockEnd = t;
      st.docks[dockId] = { vehicleId: null, reservedBy: null, since: null };
      st.dockEvents.push({ id: nextId(s, 'DE'), time: t, vehicleId: v.id, dockId, kind: 'undocked', source: 'simulation' });
      const x = DOCKS.find((d) => d.id === dockId)!.x;
      v.phase = 'departing';
      const out = drive(t, [[x, DOCKED_Z], [x, 88], [x + 8, 96], [78, 96], GATE_STOP_OUT], SPEED.yard, 'GF-YARD', 'Departing to gate', { loaded: true });
      push(v, out);
      exitViaGate(st, v, out.end);
      break;
    }
    case 'weighed':
      // Driving from the weighbridge into the shed; unloading starts on arrival at the bay.
      v.phase = 'to-dock';
      break;
    case 'unload-start':
      v.phase = 'unloading';
      v.visit!.dockStart = t;
      break;
    case 'unloaded':
      v.phase = 'departing';
      v.visit!.dockEnd = t;
      break;
    case 'gate-out': {
      v.visit!.gateOut = t;
      v.phase = 'departed';
      st.gateEvents.push({ id: nextId(s, 'GE'), time: t, vehicleId: v.id, direction: 'out', source: v.visit!.scenarioId ? 'scenario' : 'simulation' });
      break;
    }
    case 'despawn': {
      v.despawned = t;
      st.active = st.active.filter((id) => id !== v.id);
      st.departed.push(v);
      if (st.departed.length > 600) st.departed.splice(0, st.departed.length - 600);
      break;
    }
    case 'putaway-done':
      st.forklifts[ev.vehicleId].busyUntil = t;
      break;
  }
}

function toHolding(s: SimState, v: TruckRuntime, t: number) {
  const st = s.logistics;
  v.phase = 'to-holding';
  let slot = st.holding.findIndex((x) => x === null);
  let at: Vec2;
  let path: Vec2[];
  if (slot >= 0) {
    st.holding[slot] = v.id;
    at = HOLDING_SLOTS[slot];
    path = [GATE_STOP_IN, [80, 96], [-20, 96], [-20, at[1]], at];
  } else {
    slot = HOLDING_SLOTS.length + Math.min(OVERFLOW_SLOTS.length - 1, st.queue.length - HOLDING_SLOTS.length);
    at = OVERFLOW_SLOTS[slot - HOLDING_SLOTS.length];
    path = [GATE_STOP_IN, [80, 96], [at[0] + 10, 96], at];
  }
  v.slot = slot;
  const leg = drive(t, path, SPEED.road, 'GF-SITE', 'To holding area');
  push(v, leg);
  push(v, stop(leg.end, Infinity, at, slot < HOLDING_SLOTS.length ? 'GF-HOLD' : 'GF-SITE', 'Waiting for dock', faceEnd(leg)));
  schedule(st, { time: leg.end, kind: 'arrive-holding', vehicleId: v.id });
}

function toWeighbridge(st: LogisticsState, v: TruckRuntime, t: number) {
  v.phase = 'weighing';
  const toWb = drive(t, [GATE_STOP_IN, [80, 96], [116, 96], [116, -68], [-142, -68], [-142, -28], [-129, -28]], SPEED.road, 'GF-SITE', 'To weighbridge', { loaded: true });
  push(v, toWb);
  const weigh = stop(toWb.end, toWb.end + 3, [-129, -28], 'GF-RCV', 'Weighing (gross)', 0, { loaded: true });
  push(v, weigh);
  const inShed = drive(weigh.end, [[-129, -28], [-112, -28]], SPEED.yard, 'GF-SHED', 'To unloading bay', { loaded: true });
  push(v, inShed);
  const unloadMin = Math.round(lerpRange(st.rng.inbound(), 12, 20));
  const unload = stop(inShed.end, inShed.end + unloadMin, [-112, -28], 'GF-SHED', `Unloading ${v.visit!.material}`, 0);
  push(v, unload);
  const out = drive(unload.end, [[-112, -28], [-112, -14], [-125, -10], [-142, -10], [-142, 96], [78, 96], GATE_STOP_OUT], SPEED.road, 'GF-SITE', 'Departing to gate');
  push(v, out);
  schedule(st, { time: weigh.end, kind: 'weighed', vehicleId: v.id });
  schedule(st, { time: unload.start, kind: 'unload-start', vehicleId: v.id });
  schedule(st, { time: unload.end, kind: 'unloaded', vehicleId: v.id });
  exitViaGate(st, v, out.end);
}

function exitViaGate(st: LogisticsState, v: TruckRuntime, t: number) {
  const g = stop(t, t + 1, GATE_STOP_OUT, 'GF-GATE', 'Gate check-out', -Math.PI / 2, { loaded: v.visit!.direction === 'outbound' });
  push(v, g);
  const leave = drive(g.end, [GATE_STOP_OUT, [80, 110], PUBLIC_EAST], SPEED.road, 'GF-GATE', 'Leaving site');
  push(v, leave);
  schedule(st, { time: g.end, kind: 'gate-out', vehicleId: v.id });
  schedule(st, { time: leave.end, kind: 'despawn', vehicleId: v.id });
}

function assignDocks(s: SimState, t: number) {
  const st = s.logistics;
  while (st.queue.length) {
    const dock = DOCKS.find((d) => !st.docks[d.id].vehicleId && !st.docks[d.id].reservedBy);
    if (!dock) return;
    // First truck (FIFO) whose driver has completed check-in at the gatehouse office.
    const idx = st.queue.findIndex((id) => t >= ((st.vehicles[id] as TruckRuntime).queuedAt ?? t) + CHECKIN_MIN);
    if (idx < 0) return;
    const v = st.vehicles[st.queue.splice(idx, 1)[0]] as TruckRuntime;
    st.docks[dock.id].reservedBy = v.id;
    v.visit!.dockId = dock.id;
    const at = t;
    v.visit!.dockAssigned = at;
    v.phase = 'to-dock';
    st.dockEvents.push({ id: nextId(s, 'DE'), time: at, vehicleId: v.id, dockId: dock.id, kind: 'assigned', source: 'simulation' });
    if (v.slot != null && v.slot < HOLDING_SLOTS.length) st.holding[v.slot] = null;
    closeOpen(v, at);
    const from = posEnd(lastLeg(v));
    const path: Vec2[] =
      v.slot != null && v.slot < HOLDING_SLOTS.length
        ? [from, [-62, from[1]], [-62, 96], [dock.x, 96]]
        : [from, [dock.x, 96]];
    const toDock = drive(at, path, SPEED.yard, 'GF-YARD', `To ${dock.name}`);
    push(v, toDock);
    const back = drive(toDock.end, [[dock.x, 96], [dock.x, DOCKED_Z]], SPEED.reverse, 'GF-DOCKS', 'Reversing onto dock', { reverse: true });
    push(v, back);
    push(v, stop(back.end, Infinity, [dock.x, DOCKED_Z], 'GF-DOCKS', 'Loading', Math.PI / -2));
    v.slot = null;
    schedule(st, { time: back.end, kind: 'docked', vehicleId: v.id, data: { dockId: dock.id } });
  }
}

// ── Forklifts ─────────────────────────────────────────────────────────────────

function rackSlot(r: Rng): Vec2 {
  return [-97 - r() * 28, AISLES_Z[Math.floor(r() * AISLES_Z.length)]];
}

function runForklifts(s: SimState, t: number) {
  const st = s.logistics;
  for (const [id, fl] of Object.entries(st.forklifts)) {
    const v = st.vehicles[id];
    if (fl.busyUntil > t) continue;
    if (fl.role === 'putaway' && st.putawayQueue > 0) {
      st.putawayQueue--;
      closeOpen(v, t);
      const [rx, az] = rackSlot(st.rng.forklift);
      let c = t;
      const legs = [
        stop(c, (c += 0.6), PUT_STATION, 'GF-PUT', 'Picking pallet at put-away', Math.PI, { loaded: true }),
      ];
      const go = drive(c, [PUT_STATION, [CROSS_X, 20], [CROSS_X, az], [rx, az]], SPEED.forkliftLoaded, 'GF-RACK', 'Put-away to rack', { loaded: true });
      legs.push(go);
      c = go.end;
      legs.push(stop(c, (c += 0.6), [rx, az], 'GF-RACK', 'Placing pallet in rack', Math.PI, { loaded: true }));
      const back = drive(c, [[rx, az], [CROSS_X, az], [CROSS_X, 20], PUT_STATION], SPEED.forklift, 'GF-RACK', 'Returning to put-away');
      legs.push(back);
      legs.push(stop(back.end, Infinity, PUT_STATION, 'GF-PUT', 'Waiting for pallet', 0));
      legs.forEach((l) => push(v, l));
      v.task = 'Put-away: packaging → racking';
      fl.busyUntil = back.end;
    } else if (fl.role === 'dispatch') {
      dispatchWork(s, id, fl, t);
    } else if (fl.role === 'packaging') {
      packagingLoop(s, v, fl, t);
    }
  }
}

function dispatchWork(s: SimState, id: string, fl: ForkliftRuntime, t: number) {
  const st = s.logistics;
  const v = st.vehicles[id];
  // Find a docked truck that is loading and has no forklift yet.
  if (!fl.truckId) {
    const taken = new Set(Object.values(st.forklifts).map((f) => f.truckId));
    const dockId = Object.keys(st.docks).find((d) => {
      const tr = st.docks[d].vehicleId;
      const truck = tr ? (st.vehicles[tr] as TruckRuntime) : null;
      return (
        truck &&
        !taken.has(truck.id) &&
        truck.phase === 'loading' &&
        truck.visit!.dockStart != null &&
        t >= truck.visit!.dockStart + DOCK_PREP_MIN &&
        !loadingDone(st, truck.id)
      );
    });
    if (!dockId) {
      if (lastLeg(v).end !== Infinity) push(v, stop(endOf(v), Infinity, posEnd(lastLeg(v)), 'GF-STG', 'Idle', faceEnd(lastLeg(v))));
      v.task = 'Available';
      return;
    }
    fl.truckId = st.docks[dockId].vehicleId;
  }
  const truck = st.vehicles[fl.truckId!] as TruckRuntime;
  const dock = DOCKS.find((d) => d.id === truck.visit!.dockId)!;
  const loaded = truck.palletsLoaded ?? 0;
  if (loaded >= truck.visit!.load) {
    // Truck complete: release and return home.
    fl.truckId = null;
    closeOpen(v, t);
    const back = drive(t, [posEnd(lastLeg(v)), [dock.x, FRONT_Z], fl.home], SPEED.forklift, 'GF-STG', 'Returning to staging');
    push(v, back);
    push(v, stop(back.end, Infinity, fl.home, 'GF-STG', 'Idle', 0));
    fl.busyUntil = back.end;
    return;
  }
  // One trip: two pallets from the racks into the trailer.
  closeOpen(v, t);
  const [rx, az] = rackSlot(st.rng.forklift);
  const from = posEnd(lastLeg(v));
  let c = t;
  const toRack = drive(c, [from, [from[0], FRONT_Z], [CROSS_X, FRONT_Z], [CROSS_X, az], [rx, az]], SPEED.forklift, 'GF-RACK', 'To pick location');
  push(v, toRack);
  c = toRack.end;
  push(v, stop(c, (c += 0.7), [rx, az], 'GF-RACK', 'Picking 2 pallets', 0, { loaded: true }));
  const toTruck = drive(c, [[rx, az], [CROSS_X, az], [CROSS_X, FRONT_Z], [dock.x, FRONT_Z], [dock.x, 61.5]], SPEED.forkliftLoaded, 'GF-STG', `Loading ${dock.name}`, { loaded: true });
  push(v, toTruck);
  c = toTruck.end;
  push(v, stop(c, (c += 0.6), [dock.x, 61.5], 'GF-DOCKS', 'Placing pallets in trailer', -Math.PI / 2, { loaded: true }));
  const out = drive(c, [[dock.x, 61.5], [dock.x, 52]], SPEED.forklift, 'GF-STG', 'Reversing from trailer', { reverse: true });
  push(v, out);
  push(v, stop(out.end, Infinity, [dock.x, 52], 'GF-STG', 'Waiting', -Math.PI / 2));
  v.task = `Loading ${truck.label} at ${dock.name}`;
  fl.busyUntil = out.end;
  truck.palletsLoaded = Math.min(truck.visit!.load, loaded + 2);
  if (truck.palletsLoaded >= truck.visit!.load) schedule(st, { time: toTruck.end + 0.6, kind: 'loading-complete', vehicleId: truck.id });
}

const loadingDone = (st: LogisticsState, truckId: string) => {
  const tr = st.vehicles[truckId] as TruckRuntime;
  return (tr.palletsLoaded ?? 0) >= tr.visit!.load;
};

/** Packaging-floor forklift: empty-pallet runs to the palletiser magazine; every 4th run cuts across the walkway. */
function packagingLoop(s: SimState, v: Vehicle, fl: ForkliftRuntime, t: number) {
  closeOpen(v, t);
  fl.cycle++;
  const shortcut = fl.cycle % 4 === 0;
  const home = fl.home;
  let c = t;
  const route: Vec2[] = shortcut
    ? [home, [-48.5, 8], [-52, 3.2], [-72, 3.2], [-72, 24]]
    : [home, [-56, 27.5], [-72, 27.5], [-72, 24]];
  const go = drive(c, route, SPEED.forkliftLoaded, 'GF-PACK', shortcut ? 'Empty pallets (via walkway)' : 'Empty pallets to palletiser', { loaded: true });
  push(v, go);
  c = go.end;
  push(v, stop(c, (c += 1), [-72, 24], 'GF-PACK', 'Unloading empty pallets', Math.PI / 2, { loaded: true }));
  const back = drive(c, [[-72, 24], [-72, 27.5], [-56, 27.5], home], SPEED.forklift, 'GF-PACK', 'Returning to staging');
  push(v, back);
  const wait = Math.round(lerpRange(s.logistics.rng.forklift(), 14, 26));
  push(v, stop(back.end, back.end + wait, home, 'GF-PACK', 'Staging cartons', Math.PI));
  v.task = 'Empty-pallet supply';
  fl.busyUntil = back.end + wait;
}

function runLoader(st: LogisticsState, t: number) {
  const v = st.vehicles['WL-01'];
  if (v.legs.length && endOf(v) > t) return;
  let c = Math.max(t, v.legs.length ? endOf(v) : t);
  const scoop = stop(c, (c += 0.8), LOADER_LOOP[0], 'GF-SHED', 'Loading from bay', 0);
  push(v, scoop);
  const go = drive(c, [LOADER_LOOP[0], LOADER_LOOP[1], LOADER_LOOP[2]], SPEED.loader, 'GF-SHED', 'Carrying to box feeder', { loaded: true });
  push(v, go);
  c = go.end;
  push(v, stop(c, (c += 0.6), LOADER_LOOP[2], 'GF-SHED', 'Tipping into feeder', Math.PI, { loaded: true }));
  push(v, drive(c, [LOADER_LOOP[2], LOADER_LOOP[3], LOADER_LOOP[0]], SPEED.loader, 'GF-SHED', 'Returning to bay'));
}

// ── Accounting & geofencing ───────────────────────────────────────────────────

function accounting(s: SimState, t: number) {
  const st = s.logistics;
  const hour = Math.floor(t / 60);
  for (const [dockId, d] of Object.entries(st.docks)) {
    if (!d.vehicleId) continue;
    const m = st.dockBusy[dockId];
    m.set(hour, (m.get(hour) ?? 0) + 1);
  }
  for (const id of st.active) {
    const v = st.vehicles[id];
    if (v.class !== 'internal') continue;
    const p = poseAt(v, t + 0.5);
    const gf = p ? geofenceAt(p.x, p.z, ['restricted']) : undefined;
    const open = st.restrictedOpen[id];
    if (gf && !open) {
      const ev: RestrictedZoneEvent = { id: nextId(s, 'RZ'), time: t, vehicleId: id, geofenceId: gf.id, durationMin: 1, source: 'simulation' };
      st.restrictedEvents.push(ev);
      st.restrictedOpen[id] = { geofenceId: gf.id, eventId: ev.id };
      raiseAlert(s, t, 'warning', `Restricted zone entry: ${v.label}`, gf.name, { vehicleId: id }, 'simulation');
    } else if (gf && open) {
      const ev = st.restrictedEvents.find((e) => e.id === open.eventId);
      if (ev) ev.durationMin++;
    } else if (!gf && open) st.restrictedOpen[id] = null;
  }
  // Long dock stays.
  for (const d of Object.values(st.docks)) {
    if (!d.vehicleId || d.since == null) continue;
    if (t - d.since === 90) raiseAlert(s, t, 'serious', `Prolonged dock stay: ${st.vehicles[d.vehicleId].label}`, 'Docked for 90 min', { vehicleId: d.vehicleId }, 'simulation');
  }
  if (st.gateEvents.length > 3000) st.gateEvents.splice(0, st.gateEvents.length - 3000);
  if (st.dockEvents.length > 4000) st.dockEvents.splice(0, st.dockEvents.length - 4000);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

export function applyLogisticsScenario(s: SimState, sc: ScenarioActivation) {
  const st = s.logistics;
  if (sc.kind === 'truck-arrival') {
    spawnTruck(s, sc.start, 'outbound', sc.id);
  } else if (sc.kind === 'yard-congestion') {
    const n = sc.count ?? 6;
    for (let i = 0; i < n; i++) {
      // Staggered arrivals two minutes apart; spawned now with delayed starts.
      const v = spawnTruck(s, sc.start, 'outbound', sc.id);
      const delay = i * 2;
      v.spawned += delay;
      v.visit!.arrival += delay;
      v.visit!.gateIn += delay;
      for (const l of v.legs) {
        l.start += delay;
        l.end += delay;
      }
      const ev = st.timeline.find((e) => e.vehicleId === v.id && e.kind === 'gate-in');
      if (ev) ev.time += delay;
      st.timeline.sort((a, b) => a.time - b.time);
    }
  } else if (sc.kind === 'prolonged-dock-stay') {
    const extra = sc.count ?? 75;
    const dockId = sc.dockId ?? Object.keys(st.docks).find((d) => st.docks[d].vehicleId) ?? null;
    const truckId = dockId ? st.docks[dockId].vehicleId ?? st.docks[dockId].reservedBy : null;
    if (!truckId) return;
    const tr = st.vehicles[truckId] as TruckRuntime;
    tr.holdExtra += extra;
    tr.visit!.scenarioId = sc.id;
    // If loading has already completed, push the scheduled undock.
    const undock = st.timeline.find((e) => e.vehicleId === truckId && e.kind === 'undock');
    if (undock) {
      undock.time += extra;
      lastLeg(tr).activity = 'Held at dock (documentation)';
      st.timeline.sort((a, b) => a.time - b.time);
    }
  }
}

export const phaseLabel: Record<VehicleVisitPhase, string> = {
  approaching: 'Approaching',
  'at-gate': 'At gate',
  'to-holding': 'To holding',
  waiting: 'Waiting',
  'to-dock': 'To dock',
  loading: 'Loading',
  unloading: 'Unloading',
  weighing: 'Weighing',
  departing: 'Departing',
  departed: 'Departed',
};
