/**
 * Derived metrics. Every figure shown in the product is computed here from the one
 * simulation state, so the 3D scene, tables, charts and KPIs can never disagree.
 *
 * Line OEE is measured at the line constraint (H-KILN) — availability and performance
 * of the kiln — with first-pass quality from sorting. Machine OEE uses that machine's
 * own time accounting and the rejects attributed to its stage.
 */
import { EQUIPMENT_BY_ID } from '../data/equipment';
import {
  BUFFERS,
  DEFECTS,
  DEFECT_ORDER,
  DOCKS,
  INSPECTION_STATIONS,
  LINE,
  M2_PER_TILE,
  OPS_BY_ID,
  PROCESS_MACHINES,
  REASON_BY_CODE,
  STAGES,
  TARGET,
} from '../model/plant';
import type { DefectCategory, DowntimeCategory, DowntimeEvent, HourBucket, ShiftId, StageId, Vehicle } from '../model/types';
import type { SimState } from './engine';
import type { TruckRuntime } from './logistics';
import { combineOee, computeOee, lossTree, quality, type OeeResult } from './oee';
import { CONSUMERS, CONSUMER_BY_ID, DEFAULT_TARIFFS, type Tariffs } from './energy';
import { MIN_PER_DAY, SHIFT_MIN, dayStart, shiftAt, shiftInstance } from './time';

export type Period = { from: number; to: number; label: string };
export type PeriodKey = 'shift' | 'prev-shift' | 'today' | '24h' | '7d';

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  shift: 'Current shift',
  'prev-shift': 'Previous shift',
  today: 'Today (since 06:00)',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
};

/** Resolve a period key against the current simulation minute. `to` is exclusive and never in the future. */
export function resolvePeriod(key: PeriodKey, now: number): Period {
  const sh = shiftAt(now);
  switch (key) {
    case 'shift':
      return { from: sh.start, to: now, label: sh.label };
    case 'prev-shift': {
      const p = shiftAt(sh.start - 1);
      return { from: p.start, to: p.end, label: p.label };
    }
    case 'today':
      return { from: dayStart(now), to: now, label: PERIOD_LABELS.today };
    // Rolling windows start on an hour boundary so they align with the hourly accounting buckets.
    case '24h':
      return { from: hourFloor(Math.max(0, now - MIN_PER_DAY + 60)), to: now, label: PERIOD_LABELS['24h'] };
    case '7d':
      return { from: hourFloor(Math.max(0, now - 7 * MIN_PER_DAY + 60)), to: now, label: PERIOD_LABELS['7d'] };
  }
}

const hourFloor = (m: number) => Math.floor(m / 60) * 60;

/** Hour indices touched by the period. Periods must start on an hour boundary (all built-in ones do). */
const hoursIn = (p: Period) => {
  const out: number[] = [];
  for (let h = Math.floor(p.from / 60); h * 60 < p.to; h++) out.push(h);
  return out;
};

export function sumBuckets(s: SimState, id: string, p: Period): HourBucket {
  const total: HourBucket = { planned: 0, operating: 0, down: 0, plannedStop: 0, starved: 0, blocked: 0, count: 0, rejects: 0 };
  const map = s.hours[id];
  if (!map) return total;
  for (const h of hoursIn(p)) {
    const b = map.get(h);
    if (!b) continue;
    for (const k of Object.keys(total) as (keyof HourBucket)[]) total[k] += b[k];
  }
  return total;
}

const periodMinutes = (p: Period) => Math.max(0, p.to - p.from);

export type MachineMetrics = {
  id: string;
  name: string;
  stage: StageId;
  totals: HourBucket;
  oee: OeeResult;
  idealRatePerHour: number;
};

export function machineMetrics(s: SimState, id: string, p: Period): MachineMetrics {
  const ops = OPS_BY_ID[id];
  const t = sumBuckets(s, id, p);
  const ideal = ops.idealRatePerHour!;
  const oee = computeOee({
    plannedMin: t.planned,
    operatingMin: t.operating,
    idealCycleMin: 60 / ideal,
    totalCount: t.count,
    goodCount: t.count - t.rejects,
    periodMin: periodMinutes(p),
  });
  return { id, name: EQUIPMENT_BY_ID[id].name, stage: ops.stage!, totals: t, oee, idealRatePerHour: ideal };
}

export function lineGoodIn(s: SimState, p: Period) {
  let good = 0;
  for (const h of hoursIn(p)) good += s.lineGood.get(h) ?? 0;
  return good;
}

export function qualityIn(s: SimState, p: Period) {
  const byStation: Record<string, { inspected: number; rejected: number }> = Object.fromEntries(
    INSPECTION_STATIONS.map((st) => [st.id, { inspected: 0, rejected: 0 }]),
  );
  const byDefect = Object.fromEntries(DEFECT_ORDER.map((d) => [d, 0])) as Record<DefectCategory, number>;
  for (const h of hoursIn(p)) {
    const q = s.quality.get(h);
    if (!q) continue;
    for (const [st, b] of Object.entries(q)) {
      byStation[st].inspected += b.inspected;
      byStation[st].rejected += b.rejected;
      for (const [d, n] of Object.entries(b.byDefect)) byDefect[d as DefectCategory] += n ?? 0;
    }
  }
  // Every tile passes the gauge and the vision tunnel; inspected = tiles sorted.
  const inspected = byStation['ST-VIS'].inspected;
  const rejected = byStation['ST-VIS'].rejected + byStation['ST-GAUGE'].rejected;
  return { inspected, rejected, accepted: inspected - rejected, byStation, byDefect };
}

export type LineMetrics = {
  period: Period;
  output: number;
  outputM2: number;
  target: number;
  targetM2: number;
  attainment: number | null;
  oee: OeeResult;
  constraint: MachineMetrics;
  good: number;
  rejected: number;
  inspected: number;
  downtimeMin: number;
  activeStops: DowntimeEvent[];
};

export function lineMetrics(s: SimState, p: Period): LineMetrics {
  const constraint = machineMetrics(s, LINE.designConstraint === 'KILN' ? 'H-KILN' : 'H-KILN', p);
  const q = qualityIn(s, p);
  // Availability and performance at the line constraint (kiln time accounting and its own
  // count); quality is first-pass yield at sorting. Components come from two measurement
  // points, so they are combined explicitly.
  const atConstraint = computeOee({
    plannedMin: constraint.totals.planned,
    operatingMin: constraint.totals.operating,
    idealCycleMin: 60 / constraint.idealRatePerHour,
    totalCount: constraint.totals.count,
    goodCount: constraint.totals.count,
    periodMin: periodMinutes(p),
  });
  const oee = combineOee(atConstraint.availability, atConstraint.performance, quality(q.accepted, q.inspected));
  const output = lineGoodIn(s, p);
  const target = (TARGET.goodPerHour * periodMinutes(p)) / 60;
  const events = downtimeIn(s, p).filter((d) => d.category !== 'Starved' && d.category !== 'Blocked' && d.category !== 'Planned');
  return {
    period: p,
    output,
    outputM2: output * M2_PER_TILE,
    target,
    targetM2: target * M2_PER_TILE,
    attainment: target > 0 ? output / target : null,
    oee,
    constraint,
    good: q.accepted,
    rejected: q.rejected,
    inspected: q.inspected,
    downtimeMin: events.reduce((a, d) => a + clippedDuration(d, p, s.minute), 0),
    activeStops: s.downtime.filter((d) => d.end == null && !REASON_BY_CODE[d.reasonCode].planned && d.category !== 'Starved' && d.category !== 'Blocked'),
  };
}

/** Loss tree for the line waterfall (minutes of constraint time). */
export function lineLossTree(s: SimState, p: Period) {
  const c = machineMetrics(s, 'H-KILN', p);
  const q = qualityIn(s, p);
  return lossTree({
    plannedMin: c.totals.planned,
    operatingMin: c.totals.operating,
    idealCycleMin: 60 / c.idealRatePerHour,
    totalCount: c.totals.count,
    goodCount: c.totals.count * (q.inspected > 0 ? q.accepted / q.inspected : 1),
  });
}

// ── Downtime ──────────────────────────────────────────────────────────────────

export const clippedDuration = (d: DowntimeEvent, p: Period, now: number) =>
  Math.max(0, Math.min(d.end ?? now, p.to) - Math.max(d.start, p.from));

export const eventDuration = (d: DowntimeEvent, now: number) => (d.end ?? now) - d.start;

export function downtimeIn(s: SimState, p: Period) {
  return s.downtime.filter((d) => d.start < p.to && (d.end ?? s.minute) > p.from);
}

export type ParetoRow = { key: string; label: string; category: DowntimeCategory; minutes: number; events: number; share: number; cumulative: number };

/** Downtime losses by reason, largest first, with cumulative share. */
export function downtimePareto(s: SimState, p: Period, opts: { includeFlow?: boolean; equipmentId?: string } = {}): ParetoRow[] {
  const rows = new Map<string, ParetoRow>();
  for (const d of downtimeIn(s, p)) {
    if (d.category === 'Planned') continue;
    if (!opts.includeFlow && (d.category === 'Starved' || d.category === 'Blocked')) continue;
    if (opts.equipmentId && d.equipmentId !== opts.equipmentId) continue;
    const r = REASON_BY_CODE[d.reasonCode];
    const row = rows.get(d.reasonCode) ?? { key: d.reasonCode, label: r.label, category: r.category, minutes: 0, events: 0, share: 0, cumulative: 0 };
    row.minutes += clippedDuration(d, p, s.minute);
    row.events++;
    rows.set(d.reasonCode, row);
  }
  const list = [...rows.values()].sort((a, b) => b.minutes - a.minutes);
  const total = list.reduce((a, r) => a + r.minutes, 0);
  let cum = 0;
  for (const r of list) {
    r.share = total > 0 ? r.minutes / total : 0;
    cum += r.share;
    r.cumulative = cum;
  }
  return list;
}

// ── Stages & bottleneck ───────────────────────────────────────────────────────

export type StageMetrics = {
  stage: StageId;
  name: string;
  machines: MachineMetrics[];
  output: number;
  /** Share of planned time the stage was working or down on its own (not waiting on neighbours). */
  activeShare: number;
  starvedShare: number;
  blockedShare: number;
  downShare: number;
  inputBufferLevel: number | null;
};

export function stageMetrics(s: SimState, p: Period): StageMetrics[] {
  return STAGES.map((st) => {
    const ms = st.machines.map((id) => machineMetrics(s, id, p));
    const sum = (k: keyof HourBucket) => ms.reduce((a, m) => a + m.totals[k], 0);
    const planned = sum('planned');
    const buf = st.inputBuffer ? BUFFERS.find((b) => b.id === st.inputBuffer)! : null;
    return {
      stage: st.id,
      name: st.name,
      machines: ms,
      output: sum('count'),
      activeShare: planned > 0 ? (planned - sum('starved') - sum('blocked')) / planned : 0,
      starvedShare: planned > 0 ? sum('starved') / planned : 0,
      blockedShare: planned > 0 ? sum('blocked') / planned : 0,
      downShare: planned > 0 ? sum('down') / planned : 0,
      inputBufferLevel: buf ? s.buffers[buf.id] / buf.capacity : null,
    };
  });
}

/** Starved / blocked share of the window above which a stage counts as held up by its neighbours. */
export const HELD_UP_SHARE = 0.05;

export type BottleneckCause = 'constraint' | 'starving' | 'blocking';

/**
 * Bottleneck detection traced from the designed constraint (the kiln):
 * - the kiln neither starved nor blocked (≤ 5 % of the window) → the kiln limits the line, as designed;
 * - the kiln starved → walk upstream past every stage that was itself starved; the first stage that was
 *   not (working flat out, slowed or broken down) is what the line is waiting for;
 * - the kiln blocked → walk downstream past every blocked stage in the same way.
 * Upstream of a bottleneck stages are blocked, downstream they are starved — the evidence shown with it.
 */
export function bottleneck(s: SimState, windowMin = 120) {
  const p: Period = { from: Math.max(0, s.minute - windowMin), to: s.minute, label: `Last ${windowMin} min` };
  const stages = stageMetrics(s, p);
  const ci = stages.findIndex((st) => st.stage === LINE.designConstraint);
  const c = stages[ci];
  let i = ci;
  let cause: BottleneckCause = 'constraint';
  if (c.starvedShare > HELD_UP_SHARE && c.starvedShare >= c.blockedShare) {
    cause = 'starving';
    while (i > 0 && stages[i].starvedShare > HELD_UP_SHARE) i--;
  } else if (c.blockedShare > HELD_UP_SHARE) {
    cause = 'blocking';
    while (i < stages.length - 1 && stages[i].blockedShare > HELD_UP_SHARE) i++;
  }
  const current = stages[i];
  const ranked = [current, ...stages.filter((st) => st !== current).sort((a, b) => b.activeShare - a.activeShare)];
  return { period: p, current, cause, constraint: c, stages, ranked, shifted: current.stage !== LINE.designConstraint };
}

// ── Trends & shifts ───────────────────────────────────────────────────────────

export type HourPoint = { hour: number; start: number; output: number; target: number; oee: number | null; rejects: number };

export function hourlyTrend(s: SimState, p: Period): HourPoint[] {
  return hoursIn(p).map((h) => {
    const hp: Period = { from: h * 60, to: Math.min(s.minute, h * 60 + 60), label: '' };
    const lm = lineMetrics(s, hp);
    return {
      hour: h,
      start: h * 60,
      output: lm.output,
      target: (TARGET.goodPerHour * Math.max(0, hp.to - hp.from)) / 60,
      oee: lm.oee.oee.status === 'ok' ? lm.oee.oee.value : null,
      rejects: lm.rejected,
    };
  });
}

export type ShiftRow = { id: ShiftId; date: string; start: number; end: number; label: string; complete: boolean; metrics: LineMetrics };

export function shiftHistory(s: SimState, days = 7): ShiftRow[] {
  const rows: ShiftRow[] = [];
  const nowDay = Math.floor(s.minute / MIN_PER_DAY);
  for (let d = Math.max(0, nowDay - days + 1); d <= nowDay; d++)
    for (const id of ['A', 'B', 'C'] as ShiftId[]) {
      const sh = shiftInstance(d, id);
      if (sh.start >= s.minute) continue;
      const p: Period = { from: sh.start, to: Math.min(sh.end, s.minute), label: sh.label };
      rows.push({ ...sh, complete: sh.end <= s.minute, metrics: lineMetrics(s, p) });
    }
  return rows.reverse();
}

export const SHIFT_LENGTH = SHIFT_MIN;

// ── Quality trend ─────────────────────────────────────────────────────────────

export function defectTrend(s: SimState, p: Period, bucketMin = 60) {
  const out: { start: number; inspected: number; byDefect: Record<DefectCategory, number> }[] = [];
  for (let from = Math.floor(p.from / bucketMin) * bucketMin; from < p.to; from += bucketMin) {
    const q = qualityIn(s, { from, to: Math.min(p.to, from + bucketMin), label: '' });
    out.push({ start: from, inspected: q.inspected, byDefect: q.byDefect });
  }
  return out;
}

export const defectLabel = (d: DefectCategory) => DEFECTS[d].label;

// ── Logistics ─────────────────────────────────────────────────────────────────

export const externalVehicles = (s: SimState): TruckRuntime[] =>
  s.logistics.active.map((id) => s.logistics.vehicles[id]).filter((v): v is TruckRuntime => v.class === 'external');
export const internalVehicles = (s: SimState): Vehicle[] =>
  s.logistics.active.map((id) => s.logistics.vehicles[id]).filter((v) => v.class === 'internal');

export type VisitDurations = {
  waiting: number | null;
  gateToDock: number | null;
  dockTime: number | null;
  turnaround: number | null;
};

/** Durations from one truck's event timestamps; null where the event has not happened yet. */
export function visitDurations(v: TruckRuntime, now: number): VisitDurations {
  const vis = v.visit!;
  const onSite = vis.gateIn <= now;
  return {
    waiting: v.queuedAt != null ? (vis.dockAssigned ?? now) - v.queuedAt : null,
    gateToDock: vis.dockStart != null && onSite ? vis.dockStart - vis.gateIn : null,
    dockTime: vis.dockStart != null && vis.dockStart <= now ? (vis.dockEnd ?? now) - vis.dockStart : null,
    turnaround: vis.gateOut != null ? vis.gateOut - vis.gateIn : null,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function fleetMetrics(s: SimState, p: Period) {
  const now = s.minute;
  const ext = externalVehicles(s).filter((v) => v.visit!.gateIn <= now);
  const completed = s.logistics.departed.filter((v) => v.visit!.gateOut != null && v.visit!.gateOut >= p.from && v.visit!.gateOut < p.to);
  const outbound = completed.filter((v) => v.visit!.direction === 'outbound');
  const d = completed.map((v) => visitDurations(v, now));
  const dOut = outbound.map((v) => visitDurations(v, now));
  let busy = 0;
  for (const dock of DOCKS) for (const h of hoursIn(p)) busy += s.logistics.dockBusy[dock.id].get(h) ?? 0;
  const minutes = Math.max(1, p.to - p.from);
  return {
    onSite: ext.length,
    waiting: ext.filter((v) => v.phase === 'waiting').length,
    atDock: ext.filter((v) => v.phase === 'loading' || v.phase === 'unloading').length,
    inbound: ext.filter((v) => v.visit!.direction === 'inbound').length,
    completedVisits: completed.length,
    avgTurnaround: mean(d.map((x) => x.turnaround!).filter((x) => x != null)),
    avgGateToDock: mean(dOut.map((x) => x.gateToDock!).filter((x) => x != null)),
    avgDockTime: mean(dOut.map((x) => x.dockTime!).filter((x) => x != null)),
    avgWaiting: mean(dOut.map((x) => x.waiting!).filter((x) => x != null)),
    dockUtilisation: busy / (DOCKS.length * minutes),
    gateIn: s.logistics.gateEvents.filter((g) => g.direction === 'in' && g.time >= p.from && g.time < p.to).length,
    gateOut: s.logistics.gateEvents.filter((g) => g.direction === 'out' && g.time >= p.from && g.time < p.to).length,
    stockPallets: s.logistics.stockPallets,
  };
}

/** Minutes an internal vehicle has spent in its current zone, and idle minutes in the last hour. */
export function internalActivity(v: Vehicle, now: number) {
  const legs = v.legs.filter((l) => l.start <= now);
  const current = legs[legs.length - 1];
  if (!current) return { zone: null, dwell: null, idleLastHour: null, current: null };
  let since = current.start;
  for (let i = legs.length - 2; i >= 0 && legs[i].zone === current.zone; i--) since = legs[i].start;
  const entry = v.zoneLog?.filter((z) => z.start <= now).pop();
  if (entry && entry.zone === current.zone) since = Math.min(since, entry.start);
  let idle = 0;
  for (const l of legs) {
    if (l.moving || !/idle|waiting|available/i.test(l.activity)) continue;
    idle += Math.max(0, Math.min(l.end, now) - Math.max(l.start, now - 60));
  }
  const coversHour = legs.length > 0 && legs[0].start <= now - 60;
  return { zone: current.zone, dwell: now - since, idleLastHour: coversHour ? idle : null, current };
}

export const processMachines = PROCESS_MACHINES;

// ── Energy ────────────────────────────────────────────────────────────────────

export type EnergyRow = {
  id: string;
  label: string;
  elec: number;
  thermal: number;
  expElec: number;
  expThermal: number;
  total: number;
  expected: number;
  /** (actual − expected) / expected; null when the consumer drew (almost) nothing. */
  deviation: number | null;
  cost: number;
  expectedCost: number;
};

export function energyIn(s: SimState, p: Period, tariffs: Tariffs = DEFAULT_TARIFFS) {
  const rows: EnergyRow[] = CONSUMERS.map((c) => {
    let elec = 0;
    let thermal = 0;
    let expElec = 0;
    let expThermal = 0;
    for (const h of hoursIn(p)) {
      const b = s.energy[c.id]?.get(h);
      if (!b) continue;
      elec += b.elec;
      thermal += b.thermal;
      expElec += b.expElec;
      expThermal += b.expThermal;
    }
    const total = elec + thermal;
    const expected = expElec + expThermal;
    return {
      id: c.id,
      label: c.label,
      elec,
      thermal,
      expElec,
      expThermal,
      total,
      expected,
      deviation: expected > 1 ? total / expected - 1 : null,
      cost: elec * tariffs.electricity + thermal * tariffs.gas,
      expectedCost: expElec * tariffs.electricity + expThermal * tariffs.gas,
    };
  });
  const sum = (k: keyof EnergyRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
  const goodM2 = lineGoodIn(s, p) * M2_PER_TILE;
  const total = sum('total');
  const expected = sum('expected');
  const cost = sum('cost');
  const expectedCost = sum('expectedCost');
  return {
    rows,
    elec: sum('elec'),
    thermal: sum('thermal'),
    total,
    expected,
    deviation: expected > 0 ? total / expected - 1 : null,
    cost,
    expectedCost,
    excessCost: cost - expectedCost,
    co2Kg: sum('elec') * tariffs.co2Electricity + sum('thermal') * tariffs.co2Gas,
    goodM2,
    /** Specific energy consumption, kWh per good m² (null when nothing good was made). */
    sec: goodM2 > 0 ? total / goodM2 : null,
    expectedSec: goodM2 > 0 ? expected / goodM2 : null,
  };
}

/** Hourly actual vs model energy (kWh) for the period, optionally for one consumer. */
export function energyTrend(s: SimState, p: Period, id?: string) {
  return hoursIn(p).map((h) => {
    let act = 0;
    let exp = 0;
    for (const c of CONSUMERS) {
      if (id && c.id !== id) continue;
      const b = s.energy[c.id]?.get(h);
      if (!b) continue;
      act += b.elec + b.thermal;
      exp += b.expElec + b.expThermal;
    }
    return { hour: h, start: h * 60, actual: act, expected: exp };
  });
}

/** Gas the kiln burnt while it was starved or blocked (no output) in the period, kWh. */
export function kilnIdleBurn(s: SimState, p: Period) {
  const c = CONSUMER_BY_ID['H-KILN'];
  let kwh = 0;
  for (const h of hoursIn(p)) {
    const b = s.hours['H-KILN']?.get(h);
    if (!b) continue;
    kwh += ((b.starved + b.blocked) / 60) * c.thermal![0];
  }
  return kwh;
}

// ── Scenario impact vs the no-scenario baseline ──────────────────────────────

export type Impact = {
  period: Period;
  outputM2: number;
  baselineOutputM2: number;
  deltaOutputM2: number;
  oee: number | null;
  baselineOee: number | null;
  deltaOeePts: number | null;
  downtimeMin: number;
  deltaDowntimeMin: number;
  rejects: number;
  deltaRejects: number;
  energyCost: number;
  deltaEnergyCost: number;
};

/**
 * Compares the live simulation with a baseline run of the same seed without scenarios.
 * Because the engine is deterministic, the baseline is exactly "what would have happened".
 */
export function impactVsBaseline(s: SimState, base: SimState, p: Period, tariffs: Tariffs = DEFAULT_TARIFFS): Impact {
  const a = lineMetrics(s, p);
  const b = lineMetrics(base, p);
  const ea = energyIn(s, p, tariffs);
  const eb = energyIn(base, p, tariffs);
  const oee = a.oee.oee.status === 'ok' ? a.oee.oee.value : null;
  const baselineOee = b.oee.oee.status === 'ok' ? b.oee.oee.value : null;
  return {
    period: p,
    outputM2: a.outputM2,
    baselineOutputM2: b.outputM2,
    deltaOutputM2: a.outputM2 - b.outputM2,
    oee,
    baselineOee,
    deltaOeePts: oee != null && baselineOee != null ? (oee - baselineOee) * 100 : null,
    downtimeMin: a.downtimeMin,
    deltaDowntimeMin: a.downtimeMin - b.downtimeMin,
    rejects: a.rejected,
    deltaRejects: a.rejected - b.rejected,
    energyCost: ea.cost,
    deltaEnergyCost: ea.cost - eb.cost,
  };
}

/** Defect rate per category in a recent window vs a reference window (for "what increased"). */
export function defectShift(s: SimState, recentMin = 120, referenceMin = 1440) {
  const now = s.minute;
  const rec = qualityIn(s, { from: hourFloor(now - recentMin), to: now, label: '' });
  const ref = qualityIn(s, { from: hourFloor(now - recentMin - referenceMin), to: hourFloor(now - recentMin), label: '' });
  return DEFECT_ORDER.map((d) => {
    const rateRecent = rec.inspected > 0 ? rec.byDefect[d] / rec.inspected : null;
    const rateRef = ref.inspected > 0 ? ref.byDefect[d] / ref.inspected : null;
    return { defect: d, label: DEFECTS[d].label, rateRecent, rateRef, ratio: rateRecent != null && rateRef ? rateRecent / rateRef : null };
  }).sort((x, y) => (y.ratio ?? 0) - (x.ratio ?? 0));
}
