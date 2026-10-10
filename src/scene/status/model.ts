/**
 * Pure helpers behind the operational overlays of the 3D twin (status beacons, health,
 * energy and inspection pins, product flow, flow-overlay speeds, the selected vehicle's
 * route). Everything is derived from the one shared simulation state — nothing here keeps
 * its own copy of a machine, quality or energy value — and nothing touches three.js, so
 * the logic is unit-tested without a renderer.
 */
import type { Vec2, Vec3 } from '../../data/types';
import { DEFECTS, DEFECT_ORDER, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { MachineState, StageId, Vehicle, VehicleLeg } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { HEALTH_ASSETS, assess } from '../../sim/health';
import { bottleneck, defectShift, energyIn, qualityIn, type Period } from '../../sim/metrics';

// ── Polylines ─────────────────────────────────────────────────────────────────

export type Polyline = { pts: Vec3[]; cum: number[]; length: number };

export function polyline(pts: Vec3[]): Polyline {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay, az] = pts[i - 1];
    const [bx, by, bz] = pts[i];
    cum.push(cum[i - 1] + Math.hypot(bx - ax, by - ay, bz - az));
  }
  return { pts, cum, length: cum[cum.length - 1] };
}

export type PolylinePoint = { x: number; y: number; z: number; yaw: number };

/** Point and heading (rotation.y convention of the scene) at arc length `d`, clamped to the line. */
export function pointAt(pl: Polyline, d: number, out: PolylinePoint): PolylinePoint {
  const { pts, cum } = pl;
  const t = Math.min(Math.max(d, 0), pl.length);
  let i = 1;
  while (i < pts.length - 1 && cum[i] < t) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const seg = cum[i] - cum[i - 1];
  const k = seg > 0 ? (t - cum[i - 1]) / seg : 0;
  out.x = a[0] + (b[0] - a[0]) * k;
  out.y = a[1] + (b[1] - a[1]) * k;
  out.z = a[2] + (b[2] - a[2]) * k;
  out.yaw = -Math.atan2(b[2] - a[2], b[0] - a[0]);
  return out;
}

/**
 * Splits a route [x, z] into consecutive vertex ranges at the vertices listed in `breaks`
 * (matched within 0.5 m). Ranges share their boundary vertex; a break on the last vertex
 * is ignored. Each range carries the value of the break it starts at (`initial` before
 * the first one).
 */
export function splitRoute<T>(pts: Vec2[], breaks: { at: Vec2; value: T }[], initial: T) {
  const out: { from: number; to: number; value: T }[] = [];
  let from = 0;
  let value = initial;
  for (let i = 0; i < pts.length - 1; i++) {
    const b = breaks.find((x) => Math.hypot(x.at[0] - pts[i][0], x.at[1] - pts[i][1]) < 0.5);
    if (!b) continue;
    if (i > from) out.push({ from, to: i, value });
    from = i;
    value = b.value;
  }
  if (pts.length - 1 > from) out.push({ from, to: pts.length - 1, value });
  return out;
}

// ── Machine and stage throughput ──────────────────────────────────────────────

/** States in which a machine's conveyors stand still. */
export const STANDSTILL: ReadonlySet<MachineState> = new Set<MachineState>(['down', 'planned', 'starved', 'blocked']);

/** Live output of one machine relative to its ideal rate (0–1.1), and whether its line is moving. */
export function machineFlow(s: SimState, id: string): { rate: number; moving: boolean } {
  const m = s.machines[id];
  const ideal = OPS_BY_ID[id]?.idealRatePerHour;
  if (!m || !ideal) return { rate: 0, moving: false };
  const rate = Math.min(1.1, Math.max(0, m.ratePerHour / ideal));
  return { rate, moving: !STANDSTILL.has(m.state) && rate > 0.01 };
}

/** Combined output of several machines feeding one conveyor; it moves while any of them does. */
export function groupFlow(s: SimState, ids: readonly string[]): { rate: number; moving: boolean } {
  if (ids.length === 1) return machineFlow(s, ids[0]);
  let rate = 0;
  let ideal = 0;
  let moving = false;
  for (const id of ids) {
    rate += s.machines[id]?.ratePerHour ?? 0;
    ideal += OPS_BY_ID[id]?.idealRatePerHour ?? 0;
    moving ||= machineFlow(s, id).moving;
  }
  return { rate: ideal > 0 ? Math.min(1.1, rate / ideal) : 0, moving };
}

/** Throughput of a process stage relative to its ideal capacity (sum over its machines). */
export function stageFlow(s: SimState, stage: StageId): number {
  let rate = 0;
  let ideal = 0;
  for (const id of STAGE_BY_ID[stage].machines) {
    rate += s.machines[id]?.ratePerHour ?? 0;
    ideal += OPS_BY_ID[id]?.idealRatePerHour ?? 0;
  }
  return ideal > 0 ? Math.min(1.1, rate / ideal) : 0;
}

/** Slowest of several stages (a route through a stopped stage stops). `null` = not line-driven. */
export function routeFlow(s: SimState, stages: StageId[] | null): number {
  if (!stages || !stages.length) return 1;
  return Math.min(...stages.map((st) => stageFlow(s, st)));
}

/** Frame-rate independent exponential approach of `value` to `target` (time constant `tau` s). */
export const approach = (value: number, target: number, dt: number, tau: number) =>
  value + (target - value) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));

// ── Animated product flow on a conveyor ───────────────────────────────────────

/**
 * Items on one conveyor: arc positions, newest last (smallest position). Items are emitted
 * at the start at a rate proportional to the feeding machine's output and travel with the
 * belt; a stopped machine stops its belt, so the items stand still.
 */
export type Belt = { pos: Float32Array; n: number; credit: number; speed: number };

export const createBelt = (max: number): Belt => ({ pos: new Float32Array(max), n: 0, credit: 0, speed: 0 });

/** Evenly fill a belt (used once so lines don't start empty). */
export function seedBelt(b: Belt, length: number, spacing: number, offset = 0) {
  b.n = 0;
  for (let p = length - 0.3 - offset; p >= 0 && b.n < b.pos.length; p -= spacing) b.pos[b.n++] = p;
}

export type BeltDrive = {
  length: number;
  /** Belt speed the belt accelerates towards (m/s). */
  targetSpeed: number;
  /** New items per second while the belt moves. */
  emitPerSec: number;
  /** Minimum distance between consecutive items (m). */
  minGap: number;
};

export function stepBelt(b: Belt, dt: number, d: BeltDrive) {
  b.speed = approach(b.speed, d.targetSpeed, dt, 0.35);
  if (b.speed < 0.004) b.speed = d.targetSpeed === 0 ? 0 : b.speed;
  const dx = b.speed * dt;
  let w = 0;
  for (let i = 0; i < b.n; i++) {
    const p = b.pos[i] + dx;
    if (p <= d.length) b.pos[w++] = p;
  }
  b.n = w;
  if (b.speed <= 0.02 || d.emitPerSec <= 0) return;
  b.credit = Math.min(1, b.credit + d.emitPerSec * dt);
  const last = b.n ? b.pos[b.n - 1] : Infinity;
  if (b.credit >= 1 && last >= d.minGap && b.n < b.pos.length) {
    b.pos[b.n++] = 0;
    b.credit -= 1;
  }
}

// ── Per-state memoisation ─────────────────────────────────────────────────────

/**
 * Caches a derivation per simulation state and version, so several overlays reading the
 * same figure in one simulated minute compute it once.
 */
export function perVersion<T>(fn: (s: SimState) => T): (s: SimState) => T {
  const cache = new WeakMap<SimState, { version: number; value: T }>();
  return (s) => {
    const hit = cache.get(s);
    if (hit && hit.version === s.version) return hit.value;
    const value = fn(s);
    cache.set(s, { version: s.version, value });
    return value;
  };
}

// ── Reporting windows ─────────────────────────────────────────────────────────

/** "Last hour" as the insights use it: from the start of the previous plant hour to now. */
export const lastHour = (now: number): Period => {
  const from = Math.floor((now - 60) / 60) * 60;
  return { from, to: now, label: 'Last hour' };
};

// ── Health, energy, quality, bottleneck flags ─────────────────────────────────

export type FlagLevel = 'watch' | 'warning' | 'alarm';
export type HealthFlag = { id: string; level: FlagLevel; score: number };

/** Condition-monitored assets whose rule-based assessment is above normal. */
export function healthFlags(s: SimState): HealthFlag[] {
  const out: HealthFlag[] = [];
  for (const a of HEALTH_ASSETS) {
    const h = assess(s, a.id);
    if (h.level === 'watch' || h.level === 'warning' || h.level === 'alarm') out.push({ id: a.id, level: h.level, score: h.score });
  }
  return out;
}

export type EnergyFlag = { id: string; label: string; deviation: number; actual: number; expected: number };

/** Energy consumers drawing more than `threshold` above the energy model over the last hour. */
export function energyFlags(s: SimState, threshold = 0.08, minExpectedKwh = 25): EnergyFlag[] {
  const e = energyIn(s, lastHour(s.minute));
  return e.rows
    .filter((r) => r.deviation != null && r.deviation > threshold && r.expected >= minExpectedKwh)
    .map((r) => ({ id: r.id, label: r.label, deviation: r.deviation!, actual: r.total, expected: r.expected }));
}

export type StationId = 'ST-GAUGE' | 'ST-VIS';
export type StationStatus = { rate: number | null; inspected: number; flagged: boolean };
export type QualityStatus = {
  /** A quality exception is active (same rule as the quality insight, a > 5 % reject hour, or a scenario). */
  exception: boolean;
  scenario: boolean;
  /** Line reject rate over the last hour (null without inspections). */
  rate: number | null;
  stations: Record<StationId, StationStatus>;
  /** Latest QC laboratory sample. */
  qc: { result: 'pass' | 'reject'; time: number } | null;
};

const rateOf = (rejected: number, inspected: number) => (inspected > 0 ? rejected / inspected : null);

export function qualityStatus(s: SimState): QualityStatus {
  const now = s.minute;
  const p = lastHour(now);
  const recent = qualityIn(s, p);
  const ref = qualityIn(s, { from: Math.floor((now - 60 - 1440) / 60) * 60, to: p.from, label: '' });
  const rate = rateOf(recent.rejected, recent.inspected);
  const refRate = rateOf(ref.rejected, ref.inspected);

  const scenarios = s.scenarios.filter((sc) => sc.kind === 'quality-deterioration' && sc.start <= now && (sc.end == null || sc.end > now));
  const scenarioStations = new Set<string>();
  for (const sc of scenarios)
    for (const d of DEFECT_ORDER) if (!sc.stage || DEFECTS[d].origin === sc.stage) scenarioStations.add(DEFECTS[d].station);

  // The quality insight's rule (src/intel/insights.ts), so the twin and the insight list agree.
  let rule = false;
  if (recent.inspected >= 300 && ref.inspected >= 1000 && rate != null && refRate != null) {
    const top = defectShift(s, 120, 1440)[0];
    const rising = !!top && top.ratio != null && top.ratio > 1.6 && (top.rateRecent ?? 0) > 0.004;
    rule = rate >= refRate * 1.35 || rising;
  }
  const high = rate != null && recent.inspected >= 200 && rate > 0.05;
  const exception = scenarios.length > 0 || rule || high;

  const station = (id: StationId): StationStatus => {
    const r = recent.byStation[id];
    const b = ref.byStation[id];
    const sr = rateOf(r.rejected, r.inspected);
    const br = rateOf(b.rejected, b.inspected);
    const elevated = sr != null && br != null && br > 0 && r.inspected >= 200 && sr >= br * 1.35;
    return { rate: sr, inspected: r.inspected, flagged: exception && (scenarioStations.has(id) || elevated) };
  };
  const stations = { 'ST-GAUGE': station('ST-GAUGE'), 'ST-VIS': station('ST-VIS') };
  // An exception always shows on at least one station; the vision tunnel finds most defects.
  if (exception && !stations['ST-GAUGE'].flagged && !stations['ST-VIS'].flagged) stations['ST-VIS'].flagged = true;

  let qc: QualityStatus['qc'] = null;
  for (let i = s.inspections.length - 1; i >= 0; i--) {
    const r = s.inspections[i];
    if (r.stationId === 'ST-QC') {
      qc = { result: r.result, time: r.time };
      break;
    }
  }
  return { exception, scenario: scenarios.length > 0, rate, stations, qc };
}

/** `qualityStatus`, computed once per simulated minute however many overlays read it. */
export const sharedQualityStatus = perVersion(qualityStatus);

export type BottleneckInfo = { stage: StageId; name: string; machines: string[]; shifted: boolean; activeShare: number };

/** The active-period bottleneck (src/sim/metrics.ts `bottleneck`), or null before any production. */
export function bottleneckInfo(s: SimState): BottleneckInfo | null {
  const b = bottleneck(s);
  const c = b.current;
  if (!c || !(c.activeShare > 0)) return null;
  return { stage: c.stage, name: c.name, machines: STAGE_BY_ID[c.stage].machines, shifted: b.shifted, activeShare: c.activeShare };
}

// ── Selected vehicle: remaining planned route ─────────────────────────────────

export type RouteLeg = { leg: VehicleLeg; offset: number; length: number };
export type PlannedRoute = {
  /** Ground polyline [x, z] from the start of the current leg to the destination. */
  pts: Vec2[];
  cum: number[];
  length: number;
  legs: RouteLeg[];
  /** The stop the vehicle is heading for. */
  dest: { x: number; z: number; leg: VehicleLeg };
};

const pathLength = (p: Vec2[]) => p.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);

/**
 * The vehicle's remaining planned path at time `t`: from its current leg up to the next stop
 * where it works or waits (gate check-in/out stops are passed through), or the end of the
 * plan. Null when the vehicle is not moving towards anything (waiting, idle, off site).
 */
export function plannedRoute(v: Vehicle, t: number): PlannedRoute | null {
  const legs = v.legs;
  if (!legs.length || t < v.spawned || (v.despawned != null && t >= v.despawned)) return null;
  let ci = 0;
  for (let i = legs.length - 1; i >= 0; i--)
    if (legs[i].start <= t) {
      ci = i;
      break;
    }
  let di = -1;
  for (let j = ci + 1; j < legs.length; j++)
    if (!legs[j].moving && legs[j].zone !== 'GF-GATE') {
      di = j;
      break;
    }
  if (di < 0) di = legs.length - 1;
  if (di <= ci && !(legs[ci].moving && t < legs[ci].end)) return null;

  const pts: Vec2[] = [];
  const cum: number[] = [];
  const out: RouteLeg[] = [];
  const add = (p: Vec2) => {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-3) return;
    cum.push(last ? cum[cum.length - 1] + Math.hypot(p[0] - last[0], p[1] - last[1]) : 0);
    pts.push(p);
  };
  for (let j = ci; j <= di; j++) {
    const leg = legs[j];
    if (leg.moving && leg.path.length >= 2) {
      add(leg.path[0]);
      out.push({ leg, offset: cum[cum.length - 1], length: pathLength(leg.path) });
      for (const p of leg.path.slice(1)) add(p);
    } else {
      add(leg.path[0]);
      out.push({ leg, offset: cum[cum.length - 1], length: 0 });
    }
  }
  if (pts.length < 2) return null;
  const end = pts[pts.length - 1];
  return { pts, cum, length: cum[cum.length - 1], legs: out, dest: { x: end[0], z: end[1], leg: legs[di] } };
}

/** Distance travelled along a planned route at time `t` (matches `poseAt`). */
export function routeProgress(r: PlannedRoute, t: number): number {
  let d = 0;
  for (const l of r.legs) {
    if (l.leg.start > t) break;
    if (l.length > 0) {
      const span = l.leg.end - l.leg.start;
      const f = span > 0 ? Math.min(1, Math.max(0, (t - l.leg.start) / span)) : 1;
      d = l.offset + f * l.length;
    } else d = l.offset;
  }
  return d;
}
