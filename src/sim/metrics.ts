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
  CONVEYOR_BY_ID,
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
  TILES_PER_PALLET,
  MONITORED_STAGE_BY_ID,
} from '../model/plant';
import type { DefectCategory, DowntimeCategory, DowntimeEvent, HourBucket, MonitoredStageId, OperationalState, ShiftId, StageId, Vehicle } from '../model/types';
import type { SimState } from './engine';
import { LOG_MIN, findDowntime, minuteAt } from './engine';
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
    // Nothing produced → quality is unavailable (rejects detected later belong to earlier output).
    goodCount: t.count > 0 ? t.count - t.rejects : 0,
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

/** One rule for "are we on target?" — used by every workspace, the insights and the copilot. */
export type TargetStatus = 'none' | 'ahead' | 'on-track' | 'behind' | 'well-behind';
export const TARGET_STATUS_LABEL: Record<TargetStatus, string> = {
  none: 'No production time yet',
  ahead: 'Ahead of target',
  'on-track': 'On track',
  behind: 'Behind target',
  'well-behind': 'Well behind target',
};
/** ≥ 100 % ahead · ≥ 97 % on track (within normal hour-to-hour variation) · ≥ 90 % behind · below that well behind. */
export function targetStatus(attainment: number | null): TargetStatus {
  if (attainment == null) return 'none';
  if (attainment >= 1) return 'ahead';
  if (attainment >= 0.97) return 'on-track';
  return attainment >= 0.9 ? 'behind' : 'well-behind';
}

/**
 * Planned production minutes of the line in a period: calendar minutes minus the planned stops at
 * the kiln (line constraint), from its time accounting. The plan (target) is set per planned hour,
 * so a planned stop lowers the target instead of showing up as a shortfall.
 */
export function plannedProductionMin(s: SimState, p: Period, kilnTotals: HourBucket = sumBuckets(s, 'H-KILN', p)) {
  const minutes = periodMinutes(p);
  return Math.max(0, minutes - Math.min(minutes, kilnTotals.plannedStop));
}

/** The production plan (target good tiles) for a period: TARGET.goodPerHour × planned production hours. */
export const planTiles = (s: SimState, p: Period, kilnTotals?: HourBucket) => (TARGET.goodPerHour * plannedProductionMin(s, p, kilnTotals)) / 60;

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
  // Plan per planned hour: planned stops at the kiln reduce the target (they are not a shortfall).
  const target = planTiles(s, p, constraint.totals);
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
  /** Share of planned time the stage was actually producing at its own pace (active minus its own downtime). */
  workingShare: number;
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
      workingShare: planned > 0 ? Math.max(0, planned - sum('starved') - sum('blocked') - sum('down')) / planned : 0,
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
  // Shares from the per-minute log: exactly the last `windowMin` minutes, whatever the minute of the hour.
  const stages = stageMetrics(s, p).map((st) => ({ ...st, ...logShares(s, st.stage, p.from, p.to) }));
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

/** Minute-accurate state shares of a stage over [from, to) from the minute log (planned stops excluded). */
function logShares(s: SimState, stage: StageId, from: number, to: number) {
  let planned = 0;
  let starved = 0;
  let blocked = 0;
  let down = 0;
  for (const id of STAGE_BY_ID_LOCAL[stage]) {
    for (let m = Math.max(from, to - LOG_MIN); m < to; m++) {
      const x = minuteAt(s, id, m);
      if (!x || x.state === 'planned') continue;
      planned++;
      if (x.state === 'starved') starved++;
      else if (x.state === 'blocked') blocked++;
      else if (x.state === 'down') down++;
    }
  }
  if (!planned) return {};
  return {
    activeShare: (planned - starved - blocked) / planned,
    workingShare: (planned - starved - blocked - down) / planned,
    starvedShare: starved / planned,
    blockedShare: blocked / planned,
    downShare: down / planned,
  };
}
const STAGE_BY_ID_LOCAL = Object.fromEntries(STAGES.map((st) => [st.id, st.machines])) as Record<StageId, string[]>;

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
      target: lm.target,
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
    const q = qualityIn(s, { from: Math.max(p.from, from), to: Math.min(p.to, from + bucketMin), label: '' });
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
  /** Rejected ÷ inspected — comparable even when a scenario changes how much was produced. */
  rejectRate: number | null;
  baselineRejectRate: number | null;
  deltaRejectRatePts: number | null;
  energyCost: number;
  deltaEnergyCost: number;
  /** Energy cost per good m² — a stopped line costs less in total but more per m². */
  costPerGoodM2: number | null;
  baselineCostPerGoodM2: number | null;
  deltaCostPerGoodM2: number | null;
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
  const rejectRate = a.inspected > 0 ? a.rejected / a.inspected : null;
  const baselineRejectRate = b.inspected > 0 ? b.rejected / b.inspected : null;
  const costPerGoodM2 = a.outputM2 > 1 ? ea.cost / a.outputM2 : null;
  const baselineCostPerGoodM2 = b.outputM2 > 1 ? eb.cost / b.outputM2 : null;
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
    rejectRate,
    baselineRejectRate,
    deltaRejectRatePts: rejectRate != null && baselineRejectRate != null ? (rejectRate - baselineRejectRate) * 100 : null,
    energyCost: ea.cost,
    deltaEnergyCost: ea.cost - eb.cost,
    costPerGoodM2,
    baselineCostPerGoodM2,
    deltaCostPerGoodM2: costPerGoodM2 != null && baselineCostPerGoodM2 != null ? costPerGoodM2 - baselineCostPerGoodM2 : null,
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


// ── Operational state (what the product shows for an asset) ──────────────────

/**
 * State shown for an asset, from signal logic only: a stale data feed makes it 'unknown';
 * a stop is a 'fault' when its alarm code is a mechanical / electrical fault and 'stopped' otherwise;
 * planned stops and changeovers are 'planned'; a conveyor running empty is 'idle'.
 */
export function operationalState(s: SimState, id: string): OperationalState {
  const f = s.feeds[id];
  if (f && f.status === 'stale') return 'unknown';
  const m = s.machines[id];
  if (!m) return 'unknown';
  if (m.state === 'down') {
    const d = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
    const r = d ? REASON_BY_CODE[d.reasonCode] : undefined;
    if (r?.planned || d?.reasonCode === 'CHG_PRODUCT') return 'planned';
    return r && (r.category === 'Mechanical' || r.category === 'Electrical & control') && d!.reasonCode !== 'SCN_STOP' && d!.reasonCode !== 'SCN_CNV_STOP' ? 'fault' : 'stopped';
  }
  if (m.state === 'planned') return 'planned';
  if (CONVEYOR_BY_ID[id]) return m.state === 'starved' ? 'idle' : m.state === 'blocked' ? 'blocked' : 'running';
  return m.state;
}

export const OPERATIONAL_STATE_LABEL: Record<OperationalState, string> = {
  running: 'Running',
  reduced: 'Running below rate',
  idle: 'Idle (no material)',
  stopped: 'Stopped',
  fault: 'Fault',
  starved: 'Starved',
  blocked: 'Blocked',
  planned: 'Planned stop',
  disconnected: 'Disconnected',
  unknown: 'Unknown (data stale)',
};

// ── Conveyors ─────────────────────────────────────────────────────────────────

export function conveyorMetrics(s: SimState, id: string, p: Period) {
  const c = CONVEYOR_BY_ID[id];
  const t = sumBuckets(s, id, p);
  const stops = s.downtime.filter((d) => d.equipmentId === id && d.start < p.to && (d.end ?? s.minute) > p.from);
  return {
    id,
    name: c.name,
    totals: t,
    /** Running (not stopped) share of the period — OEE is not meaningful for a conveyor. */
    availability: t.planned > 0 ? (t.planned - t.down) / t.planned : null,
    /** Transported tiles vs nominal capacity over the planned time. */
    utilisation: t.planned > 0 ? t.count / ((c.capacityPerHour / 60) * t.planned) : null,
    stops: stops.length,
    downMin: stops.reduce((a, d) => a + clippedDuration(d, p, s.minute), 0),
  };
}

// ── Stage input / output (production monitoring) ──────────────────────────────

export type StageIO = {
  stage: MonitoredStageId;
  unit: 'tiles' | 'pallets';
  input: number | null;
  output: number | null;
  good: number | null;
  rejected: number | null;
  /** Work in progress at the stage input (buffer level now), null if not measured. */
  wip: number | null;
  wipCapacity: number | null;
  /** Actual output per hour over the period vs the expected (ideal × planned time) rate. */
  ratePerHour: number | null;
  expectedPerHour: number | null;
  /** Minutes the stage was down / starved / blocked (sum over its machines ÷ machines). */
  downMin: number;
  starvedMin: number;
  blockedMin: number;
};

/** Counts at a monitored stage for a period, from its configured counting points. */
export function stageIO(s: SimState, id: MonitoredStageId, p: Period): StageIO {
  void MONITORED_STAGE_BY_ID[id];
  const hrs = Math.max(1 / 60, (p.to - p.from) / 60);
  if (id === 'WH') {
    const pallets = (from: number, to: number) => {
      let n = 0;
      for (const h of hoursIn({ from, to, label: '' })) n += (s.hours['J-PAL']?.get(h)?.count ?? 0) / TILES_PER_PALLET;
      return n;
    };
    const dispatched = s.logistics.dockEvents.filter((e) => e.kind === 'loading-complete' && e.time >= p.from && e.time < p.to)
      .reduce((a, e) => a + (s.logistics.vehicles[e.vehicleId]?.visit?.load ?? 0), 0);
    return {
      stage: id,
      unit: 'pallets',
      input: pallets(p.from, p.to),
      output: dispatched,
      good: null,
      rejected: null,
      wip: s.logistics.stockPallets,
      wipCapacity: null,
      ratePerHour: dispatched / hrs,
      expectedPerHour: null,
      downMin: 0,
      starvedMin: 0,
      blockedMin: 0,
    };
  }
  const stageIds: StageId[] = id === 'GLAZE' ? ['GLAZE', 'DECOR'] : id === 'PACK' ? ['PACK', 'PAL'] : [id];
  const first = STAGES.find((x) => x.id === stageIds[0])!;
  const last = STAGES.find((x) => x.id === stageIds[stageIds.length - 1])!;
  const count = (st: (typeof STAGES)[number]) => st.machines.reduce((a, m) => a + sumBuckets(s, m, p).count, 0);
  const input = count(first);
  const output = count(last);
  const q = id === 'SORT' ? qualityIn(s, p) : null;
  const buf = first.inputBuffer ? BUFFERS.find((b) => b.id === first.inputBuffer)! : null;
  const ideal = last.machines.reduce((a, m) => a + (OPS_BY_ID[m].idealRatePerHour ?? 0), 0);
  const tot = (k: keyof HourBucket) => stageIds.flatMap((x) => STAGES.find((y) => y.id === x)!.machines).reduce((a, m) => a + sumBuckets(s, m, p)[k], 0);
  const nMach = stageIds.flatMap((x) => STAGES.find((y) => y.id === x)!.machines).length;
  const planned = last.machines.reduce((a, m) => a + sumBuckets(s, m, p).planned, 0) / last.machines.length;
  return {
    stage: id,
    unit: 'tiles',
    input,
    output,
    good: q ? q.inspected - q.rejected : null,
    rejected: q ? q.rejected : null,
    wip: buf ? s.buffers[buf.id] : null,
    wipCapacity: buf ? buf.capacity : null,
    ratePerHour: output / hrs,
    expectedPerHour: planned > 0 ? (ideal * planned) / 60 / hrs : null,
    downMin: tot('down') / nMach,
    starvedMin: tot('starved') / nMach,
    blockedMin: tot('blocked') / nMach,
  };
}

// ── Capacity: theoretical → planned → actual → good ──────────────────────────

/**
 * Capacity comparison at the line constraint (kiln), all in m² of tile for the period:
 * theoretical = design rate × calendar time; planned = the production plan (target per planned
 * hour); actual = tiles fired; good = first-quality tiles accepted at sorting. The gap is split into
 * planned stops, availability, speed and quality losses at the constraint — each lost unit is
 * counted once, at the constraint, never per machine — plus a signed `transit` step (kind
 * 'transit', not a loss: tiles between the kiln and sorting). Rank or share only kind 'loss'.
 */
export function capacityBreakdown(s: SimState, p: Period) {
  const lm = lineMetrics(s, p);
  const k = lm.constraint;
  const ideal = k.idealRatePerHour / 60;
  const calendar = Math.max(0, Math.min(p.to, s.minute) - p.from);
  const m2 = (tiles: number) => tiles * M2_PER_TILE;
  const theoretical = m2(ideal * calendar);
  const plannedStopLoss = m2(ideal * k.totals.plannedStop);
  const availabilityLoss = m2(ideal * (k.totals.planned - k.totals.operating));
  const speedLoss = m2(ideal * k.totals.operating - k.totals.count);
  const fired = m2(k.totals.count);
  const good = m2(lm.good);
  // Quality = tiles rejected at sorting in the period. Fired − inspected is work in transit between
  // the kiln and sorting (signed: the outfeed buffer can also be drawn down), so the steps close
  // exactly to good output: theoretical − planned − availability − speed − quality − transit = good.
  const qualityLoss = m2(lm.rejected);
  const transitTiles = k.totals.count - lm.inspected;
  return {
    period: p,
    calendarMin: calendar,
    theoreticalM2: theoretical,
    plannedM2: lm.targetM2,
    actualM2: fired,
    goodM2: good,
    capacityGapM2: theoretical - good,
    planGapM2: lm.targetM2 - good,
    losses: [
      { key: 'planned', label: 'Planned stops', m2: plannedStopLoss, basis: `${Math.round(k.totals.plannedStop)} min of planned stops at the kiln × design rate`, kind: 'loss' as const },
      { key: 'availability', label: 'Downtime (availability)', m2: availabilityLoss, basis: `${Math.round(k.totals.planned - k.totals.operating)} min the kiln was down, starved or blocked × design rate`, kind: 'loss' as const },
      { key: 'speed', label: 'Speed (performance)', m2: Math.max(0, speedLoss), basis: 'Kiln running below its design rate', kind: 'loss' as const },
      { key: 'quality', label: 'Quality (rejects)', m2: qualityLoss, basis: 'Fired tiles rejected at sorting (first pass)', kind: 'loss' as const },
      {
        key: 'transit',
        label: transitTiles >= 0 ? 'Fired, not yet sorted' : 'Sorted from the kiln outfeed buffer',
        m2: m2(transitTiles),
        basis: transitTiles >= 0 ? 'Tiles fired in the period still between the kiln and sorting (not a loss)' : 'Tiles sorted in the period that were fired before it (not a gain)',
        kind: 'transit' as const,
      },
    ],
    assumptions: [
      `Design rate of the line constraint H-KILN: ${k.idealRatePerHour} tiles/h (${(k.idealRatePerHour * M2_PER_TILE).toFixed(0)} m²/h).`,
      `Plan: ${TARGET.goodPerHour} good tiles per planned hour (OEE target ${Math.round(TARGET.oeeTarget * 100)} %).`,
      'Losses are valued at the constraint only; time lost elsewhere costs output only if it holds up the kiln.',
    ],
  };
}
