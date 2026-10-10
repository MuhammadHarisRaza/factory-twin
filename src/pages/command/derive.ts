/**
 * Pure derivations for the Command Center. Every figure comes from the shared simulation
 * state through src/sim/metrics.ts, src/sim/events.ts, src/sim/health.ts and the finance
 * assumptions; these helpers only select, merge and rank them for the operational overview.
 * Alerts are not used here any more: the operational events (one record per event, with its
 * lifecycle, evidence and report) are what the Command Center lists, ranks and acts on.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID, M2_PER_TILE, MONITORED_STAGES, OPS_BY_ID, PRODUCTS, REASON_BY_CODE, SCENARIO_KIND_LABELS, STAGE_BY_ID, TARGET } from '../../model/plant';
import type { AlertSeverity, EventCategory, MonitoredStageId, OperationalState, OpEvent, Product, ProductionBatch, RecordSource, ScenarioActivation } from '../../model/types';
import { TRACKED_ASSETS, batchAt, findDowntime, scenariosActive, type SimState } from '../../sim/engine';
import type { Tariffs } from '../../sim/energy';
import { openEvents } from '../../sim/events';
import { lostOutputValue, type FinanceAssumptions } from '../../sim/finance';
import { HEALTH_ASSETS, assess, type HealthLevel } from '../../sim/health';
import {
  OPERATIONAL_STATE_LABEL,
  bottleneck,
  capacityBreakdown,
  clippedDuration,
  defectShift,
  downtimeIn,
  energyIn,
  fleetMetrics,
  lineMetrics,
  operationalState,
  qualityIn,
  resolvePeriod,
  type LineMetrics,
  type Period,
} from '../../sim/metrics';
import { formatClock, formatDuration } from '../../sim/time';

export const eqName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;
const hourFloor = (m: number) => Math.floor(m / 60) * 60;
const isFlow = (category: string) => category === 'Starved' || category === 'Blocked';

/** Window of the event timeline. */
export const TIMELINE_WINDOW_MIN = 4 * 60;
/** Recently detected events shown alongside the open ones (quality panel). */
export const RECENT_EVENT_MIN = 8 * 60;

export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/** Alert-style severity of a stoppage (timeline colour for stop events without a record). */
export const stopSeverity = (equipmentId: string): AlertSeverity =>
  equipmentId === 'H-KILN' ? 'critical' : OPS_BY_ID[equipmentId]?.stage === 'PRESS' ? 'serious' : 'warning';

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * Event priority: unacknowledged first, then severity, then condition still active, then newest.
 * Used by every event list on this page so they read in the same order.
 */
export function byPriority(a: OpEvent, b: OpEvent) {
  return (
    Number(b.status === 'active') - Number(a.status === 'active') ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    Number(b.end == null) - Number(a.end == null) ||
    b.start - a.start ||
    (a.id < b.id ? 1 : -1)
  );
}

export type EventScope = 'open' | 'unacknowledged' | 'condition';

/** Open (not resolved) events in priority order, optionally narrowed. */
export function prioritisedEvents(s: SimState, scope: EventScope = 'open', category?: EventCategory): OpEvent[] {
  return openEvents(s)
    .filter((e) => (scope === 'unacknowledged' ? e.status === 'active' : scope === 'condition' ? e.end == null : true))
    .filter((e) => !category || e.category === category)
    .sort(byPriority);
}

export type EventCounts = {
  open: number;
  /** Open and not yet acknowledged by anyone. */
  unacknowledged: number;
  /** Condition still present (not recovered). */
  conditionActive: number;
  bySeverity: Record<AlertSeverity, number>;
  byCategory: Record<EventCategory, number>;
};

export function eventCounts(events: OpEvent[]): EventCounts {
  const c: EventCounts = {
    open: 0,
    unacknowledged: 0,
    conditionActive: 0,
    bySeverity: { critical: 0, serious: 0, warning: 0, info: 0 },
    byCategory: { production: 0, quality: 0, logistics: 0, equipment: 0, energy: 0, data: 0 },
  };
  for (const e of events) {
    if (e.status === 'resolved') continue;
    c.open++;
    if (e.status === 'active') c.unacknowledged++;
    if (e.end == null) c.conditionActive++;
    c.bySeverity[e.severity]++;
    c.byCategory[e.category]++;
  }
  return c;
}

/** Open events of a category plus the ones detected in the recent window (open first, then newest). */
export function categoryEvents(s: SimState, category: EventCategory, recentMin = RECENT_EVENT_MIN): OpEvent[] {
  const from = s.minute - recentMin;
  return s.events
    .filter((e) => e.category === category && (e.status !== 'resolved' || e.start >= from || (e.end ?? s.minute) >= from))
    .sort((a, b) => Number(b.status !== 'resolved') - Number(a.status !== 'resolved') || byPriority(a, b));
}

/** The open event that best describes an asset right now (highest priority), or null. */
export function openEventByAsset(s: SimState): Map<string, OpEvent> {
  const by = new Map<string, OpEvent>();
  for (const e of openEvents(s)) {
    const id = e.asset.equipmentId;
    if (!id) continue;
    const cur = by.get(id);
    if (!cur || byPriority(e, cur) < 0) by.set(id, e);
  }
  return by;
}

// ── Next actions (from open events) ───────────────────────────────────────────

export type EventAction = {
  ev: OpEvent;
  /** First recommendation of the record (rule-based). */
  action: string;
  /** Lifecycle step offered from the Command Center. */
  next: 'acknowledge' | 'investigate' | 'resolve';
};

/** One action per open event, in priority order: what to do and the next lifecycle step. */
export function eventActions(s: SimState): EventAction[] {
  return prioritisedEvents(s).map((ev) => ({
    ev,
    action: ev.recommendations[0] ?? 'Open the event report and review the evidence.',
    next: ev.status === 'active' ? 'acknowledge' : ev.status === 'acknowledged' ? 'investigate' : 'resolve',
  }));
}

// ── Equipment requiring attention ─────────────────────────────────────────────

export type AttentionKind = 'down' | 'stale' | 'reduced' | 'health';

export type AttentionRow = {
  id: string;
  name: string;
  conveyor: boolean;
  /** State as the product shows it (a stale feed makes it 'unknown'). */
  op: OperationalState | null;
  kinds: AttentionKind[];
  /** Why the asset is listed (stop reason, stale feed, rate, health finding). */
  reasons: string[];
  /** Since when the condition holds (null when unknown). */
  since: number | null;
  health: { level: HealthLevel; score: number } | null;
  scenario: boolean;
  /** Open event on this asset (the report to open), if any. */
  eventId: string | null;
  /** Ordering weight (higher first). */
  rank: number;
};

const HEALTH_RANK: Record<HealthLevel, number> = { alarm: 280, warning: 200, watch: 60, normal: 0, offline: 0 };
/** Conveyors that feed or empty the kiln: a stop there reaches the line constraint first. */
const KILN_CONVEYORS = ['CV-GLZ', 'CV-KIN', 'CV-SORT'];

/**
 * Machines and conveyors that are stopped, have a stale data feed or run below rate, and
 * condition-monitored assets at health warning or alarm. Starved / blocked / idle assets are
 * not listed: they are held up by a neighbour, which is listed instead.
 */
export function attentionList(s: SimState): AttentionRow[] {
  const now = s.minute;
  const active = scenariosActive(s);
  const events = openEventByAsset(s);
  const rows = new Map<string, AttentionRow>();
  const row = (id: string): AttentionRow => {
    let r = rows.get(id);
    if (!r) {
      r = {
        id,
        name: eqName(id),
        conveyor: !!CONVEYOR_BY_ID[id],
        op: s.machines[id] ? operationalState(s, id) : null,
        kinds: [],
        reasons: [],
        since: null,
        health: null,
        scenario: false,
        eventId: events.get(id)?.id ?? null,
        rank: 0,
      };
      rows.set(id, r);
    }
    return r;
  };

  for (const id of TRACKED_ASSETS) {
    const m = s.machines[id];
    if (!m) continue;
    const op = operationalState(s, id);
    if (op === 'stopped' || op === 'fault') {
      const d = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
      const r = row(id);
      r.kinds.push('down');
      r.reasons.push(d ? (REASON_BY_CODE[d.reasonCode]?.label ?? d.reasonCode) : 'Unplanned stop');
      r.since = d?.start ?? m.since;
      r.scenario ||= d?.source === 'scenario';
      r.rank = Math.max(r.rank, id === 'H-KILN' ? 400 : KILN_CONVEYORS.includes(id) ? 330 : OPS_BY_ID[id]?.stage === 'PRESS' ? 320 : 300);
    } else if (op === 'unknown') {
      const f = s.feeds[id];
      const r = row(id);
      r.kinds.push('stale');
      const last = f?.lastState ? ` · last reported ${f.lastState === 'down' ? 'stopped' : f.lastState}` : '';
      r.reasons.push(`Data feed stale — counter and state frozen since ${formatClock(f?.since ?? now)}${last}`);
      r.since = f?.since ?? null;
      r.scenario ||= !!f?.scenarioId;
      r.rank = Math.max(r.rank, 260);
    } else if (op === 'reduced') {
      const sc = active.find((x) => (x.kind === 'reduced-rate' && x.equipmentId === id) || (x.kind === 'bottleneck' && x.stage === OPS_BY_ID[id]?.stage));
      const r = row(id);
      r.kinds.push('reduced');
      r.reasons.push(`Running at ${Math.round(m.rateFactor * 100)} % of ideal rate${sc ? ` · ${sc.label}` : ''}`);
      r.since = m.since;
      r.scenario ||= !!sc;
      r.rank = Math.max(r.rank, 150);
    }
  }

  for (const a of HEALTH_ASSETS) {
    const h = assess(s, a.id);
    if (h.level !== 'warning' && h.level !== 'alarm') {
      // Keep the health reading on rows listed for another reason.
      const r = rows.get(a.id);
      if (r) r.health = { level: h.level, score: h.score };
      continue;
    }
    const r = row(a.id);
    r.kinds.push('health');
    r.health = { level: h.level, score: h.score };
    r.reasons.push(h.findings[0] ?? `${a.component}: abnormal signal pattern`);
    if (r.since == null) r.since = conditionSince(s, a.id);
    r.rank = Math.max(r.rank, HEALTH_RANK[h.level]) + (100 - h.score) / 10;
  }

  return [...rows.values()].sort((x, y) => y.rank - x.rank || (x.since ?? now) - (y.since ?? now) || x.id.localeCompare(y.id));
}

/** Start of the asset's open condition-abnormal event (when the abnormal pattern was detected). */
function conditionSince(s: SimState, id: string): number | null {
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (e.type === 'condition-abnormal' && e.asset.equipmentId === id && e.end == null) return e.start;
  }
  return null;
}

export function attentionCounts(rows: AttentionRow[]) {
  return {
    total: rows.length,
    down: rows.filter((r) => r.kinds.includes('down')).length,
    conveyorsDown: rows.filter((r) => r.conveyor && r.kinds.includes('down')).length,
    stale: rows.filter((r) => r.kinds.includes('stale')).length,
    reduced: rows.filter((r) => r.kinds.includes('reduced')).length,
    health: rows.filter((r) => r.kinds.includes('health')).length,
  };
}

// ── Losses ────────────────────────────────────────────────────────────────────

export type MachineLoss = { id: string; name: string; lostM2: number; minutes: number; events: number; active: boolean };

/**
 * Output lost to each machine's own unplanned stops in the period (ideal-rate m² not made),
 * pro-rated for events that started before the period. Starved/blocked and planned stops excluded.
 */
export function machineLosses(s: SimState, p: Period): MachineLoss[] {
  const by = new Map<string, MachineLoss>();
  for (const d of downtimeIn(s, p)) {
    if (isFlow(d.category) || REASON_BY_CODE[d.reasonCode].planned) continue;
    const total = (d.end ?? s.minute) - d.start;
    const inPeriod = clippedDuration(d, p, s.minute);
    if (inPeriod <= 0) continue;
    const r = by.get(d.equipmentId) ?? { id: d.equipmentId, name: eqName(d.equipmentId), lostM2: 0, minutes: 0, events: 0, active: false };
    r.lostM2 += (total > 0 ? d.lostTiles * (inPeriod / total) : 0) * M2_PER_TILE;
    r.minutes += inPeriod;
    r.events++;
    r.active ||= d.end == null;
    by.set(d.equipmentId, r);
  }
  return [...by.values()].sort((a, b) => b.lostM2 - a.lostM2);
}

// ── Quality exceptions ────────────────────────────────────────────────────────

export type QualityExceptions = {
  /** Last ≈ 2 h (hour-aligned) vs the 24 h before — the same windows as defectShift. */
  from: number;
  inspected: number;
  rejected: number;
  rate: number | null;
  refRate: number | null;
  ratio: number | null;
  rows: ReturnType<typeof defectShift>;
  rising: ReturnType<typeof defectShift>;
  batch: ProductionBatch;
  product: Product | null;
  /** Quality events: open ones and those of the last 8 h (the same records as Events & Reports). */
  events: OpEvent[];
  openEvents: number;
  exception: boolean;
};

/** Ratio above which a defect category counts as rising. */
export const RISING_RATIO = 1.3;

export function qualityExceptions(s: SimState): QualityExceptions {
  const now = s.minute;
  const split = hourFloor(now - 120);
  const rec = qualityIn(s, { from: split, to: now, label: '' });
  const ref = qualityIn(s, { from: hourFloor(now - 120 - 1440), to: split, label: '' });
  const rate = rec.inspected > 0 ? rec.rejected / rec.inspected : null;
  const refRate = ref.inspected > 0 ? ref.rejected / ref.inspected : null;
  const ratio = rate != null && refRate ? rate / refRate : null;
  const rows = defectShift(s, 120, 1440);
  const rising = rows.filter((d) => d.ratio != null && d.ratio > RISING_RATIO && (d.rateRecent ?? 0) > 0.002);
  // Tiles reaching sorting now were pressed ≈ 3 h ago (same convention as the insights).
  const batch = batchAt(s, now - 180);
  const events = categoryEvents(s, 'quality');
  const open = events.filter((e) => e.status !== 'resolved').length;
  return {
    from: split,
    inspected: rec.inspected,
    rejected: rec.rejected,
    rate,
    refRate,
    ratio,
    rows,
    rising,
    batch,
    product: PRODUCTS.find((p) => p.sku === batch.sku) ?? null,
    events,
    openEvents: open,
    exception: open > 0 || (ratio ?? 0) >= 1.35 || rising.length > 0,
  };
}

// ── Use cases ─────────────────────────────────────────────────────────────────

export type StageIssue = { stage: MonitoredStageId; name: string; assetId: string; state: OperationalState };

const ISSUE_ORDER: Partial<Record<OperationalState, number>> = { fault: 4, stopped: 3, unknown: 2, reduced: 1 };

/**
 * Production monitoring at every stage: the worst issue per monitored stage among its machines
 * and conveyors (stopped / fault / data stale / below rate). Starved, blocked and idle are left
 * out — they are consequences of an issue elsewhere, which is counted where it happens.
 */
export function stageIssues(s: SimState): { stages: number; issues: StageIssue[] } {
  const issues: StageIssue[] = [];
  for (const st of MONITORED_STAGES) {
    let worst: StageIssue | null = null;
    for (const id of [...st.equipment, ...st.conveyors]) {
      if (!s.machines[id]) continue;
      const op = operationalState(s, id);
      const rank = ISSUE_ORDER[op];
      if (!rank) continue;
      if (!worst || rank > (ISSUE_ORDER[worst.state] ?? 0)) worst = { stage: st.id, name: st.name, assetId: id, state: op };
    }
    if (worst) issues.push(worst);
  }
  return { stages: MONITORED_STAGES.length, issues };
}

export const issueText = (i: StageIssue) => `${i.name}: ${i.assetId} ${OPERATIONAL_STATE_LABEL[i.state].toLowerCase()}`;

export type UseCaseSummary = ReturnType<typeof useCases>;

/** Headline of each of the four use cases for the current shift (one state, four views). */
export function useCases(s: SimState, finance: FinanceAssumptions) {
  const sp = resolvePeriod('shift', s.minute);
  const lm = lineMetrics(s, sp);
  const cap = capacityBreakdown(s, sp);
  const ev = eventCounts(openEvents(s));
  const st = stageIssues(s);
  const q = qualityExceptions(s);
  const fm = fleetMetrics(s, sp);
  const planGapM2 = Math.max(0, cap.planGapM2);
  const value = lostOutputValue(finance, planGapM2 / M2_PER_TILE);
  return {
    period: sp,
    production: {
      stages: st.stages,
      issues: st.issues,
      openEvents: ev.byCategory.production + ev.byCategory.data,
    },
    oee: {
      oee: lm.oee.oee,
      target: TARGET.oeeTarget,
      attainment: lm.attainment,
      planGapM2,
      capacityGapM2: Math.max(0, cap.capacityGapM2),
      /** Estimate: good output behind plan valued at contribution margin (finance assumptions). */
      value: value.amount,
      valueBasis: value.basis,
      currency: finance.currency,
    },
    defects: {
      rate: q.rate,
      refRate: q.refRate,
      ratio: q.ratio,
      openEvents: q.openEvents,
      exception: q.exception,
    },
    vehicles: {
      onSite: fm.onSite,
      waiting: fm.waiting,
      atDock: fm.atDock,
      openEvents: ev.byCategory.logistics,
    },
  };
}

// ── Situation strip ───────────────────────────────────────────────────────────

export function strip(s: SimState, tariffs: Tariffs) {
  const sp = resolvePeriod('shift', s.minute);
  const bn = bottleneck(s);
  const e = energyIn(s, sp, tariffs);
  const events = eventCounts(openEvents(s));
  const attention = attentionCounts(attentionList(s));
  return {
    period: sp,
    bn: {
      name: bn.current.name,
      stage: bn.current.stage,
      workingShare: bn.current.workingShare,
      label: bn.period.label,
      shifted: bn.shifted,
      machines: STAGE_BY_ID[bn.current.stage].machines,
    },
    energy: { excessCost: e.excessCost, deviation: e.deviation, cost: e.cost, openEvents: events.byCategory.energy },
    events,
    attention,
  };
}

// ── Shift comparison ──────────────────────────────────────────────────────────

export function shiftCompare(s: SimState): { current: LineMetrics; previous: LineMetrics } {
  return { current: lineMetrics(s, resolvePeriod('shift', s.minute)), previous: lineMetrics(s, resolvePeriod('prev-shift', s.minute)) };
}

// ── Event timeline ────────────────────────────────────────────────────────────

export type TimelineKind = 'detected' | 'cleared' | 'acknowledged' | 'investigating' | 'resolved' | 'scenario-start' | 'scenario-end';

export type TimelineItem = {
  key: string;
  time: number;
  kind: TimelineKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Event the item belongs to (opens its report). */
  eventId?: string;
  equipmentId?: string;
  vehicleId?: string;
  source: RecordSource;
};

/** Within one minute show effects above causes: a scenario start sits below the event it caused. */
const SAME_MINUTE_ORDER: Record<TimelineKind, number> = {
  resolved: 0,
  investigating: 0,
  acknowledged: 0,
  cleared: 1,
  detected: 2,
  'scenario-end': 3,
  'scenario-start': 4,
};

/** One-off logistics injections are logged with a 1-minute duration; their "end" is not an event. */
const ONE_OFF = new Set<ScenarioActivation['kind']>(['truck-arrival', 'yard-congestion', 'prolonged-dock-stay', 'restricted-entry']);

export function scenarioTarget(sc: ScenarioActivation): { equipmentId?: string; vehicleId?: string } {
  if (sc.vehicleId) return { vehicleId: sc.vehicleId };
  if (sc.equipmentId) return { equipmentId: sc.equipmentId };
  if (sc.stage) return { equipmentId: STAGE_BY_ID[sc.stage].machines[0] };
  return { equipmentId: sc.kind === 'truck-arrival' || sc.kind === 'yard-congestion' ? 'A-GATE' : 'K-DOCK' };
}

const subjectOf = (s: SimState, ev: OpEvent) =>
  ev.asset.vehicleId ? (s.logistics.vehicles[ev.asset.vehicleId]?.label ?? ev.asset.vehicleId) : (ev.asset.equipmentId ?? ev.asset.stationId ?? ev.asset.stage ?? '');

/**
 * Newest-first stream of the operational events (condition started, cleared and — optionally —
 * the lifecycle steps people took on them) and the scenario inputs, since `windowMin` ago.
 * Every event item opens the same record in Events & Reports.
 */
export function timeline(s: SimState, opts: { windowMin?: number; lifecycle?: boolean; limit?: number } = {}): TimelineItem[] {
  const now = s.minute;
  const from = now - (opts.windowMin ?? TIMELINE_WINDOW_MIN);
  const inWindow = (t: number) => t >= from && t <= now;
  const out: TimelineItem[] = [];

  for (const ev of s.events) {
    if ((ev.end ?? now) < from && ev.lastUpdate < from) continue;
    const base = { eventId: ev.id, equipmentId: ev.asset.equipmentId, vehicleId: ev.asset.vehicleId, source: ev.source };
    const who = subjectOf(s, ev);
    if (inWindow(ev.start))
      out.push({ ...base, key: `${ev.id}:d`, time: ev.start, kind: 'detected', severity: ev.severity, title: ev.title, detail: `${ev.id} · ${who}${who ? ' · ' : ''}${ev.trigger.ruleId}` });
    if (ev.end != null && inWindow(ev.end)) {
      const auto = ev.resolution?.by === 'system' && ev.resolution.t === ev.end;
      out.push({
        ...base,
        key: `${ev.id}:c`,
        time: ev.end,
        kind: 'cleared',
        severity: 'info',
        title: `Condition cleared: ${ev.title}`,
        detail: `${ev.id} · after ${formatDuration(ev.end - ev.start)}${auto ? ' · auto-resolved (not acknowledged)' : ''}`,
      });
    }
    if (opts.lifecycle)
      ev.history.forEach((h, i) => {
        if (h.by !== 'user' || !inWindow(h.t)) return;
        if (h.action !== 'acknowledged' && h.action !== 'investigating' && h.action !== 'resolved') return;
        out.push({ ...base, key: `${ev.id}:h${i}`, time: h.t, kind: h.action, severity: 'info', title: `${h.action[0].toUpperCase()}${h.action.slice(1)}: ${ev.title}`, detail: `${ev.id} · ${h.text}` });
      });
  }

  for (const sc of s.scenarios) {
    const target = scenarioTarget(sc);
    if (inWindow(sc.start))
      out.push({ key: `${sc.id}:s`, time: sc.start, kind: 'scenario-start', severity: 'info', title: `Scenario started: ${sc.label}`, detail: SCENARIO_KIND_LABELS[sc.kind], ...target, source: 'scenario' });
    if (sc.end != null && sc.end <= now && inWindow(sc.end) && !ONE_OFF.has(sc.kind))
      out.push({ key: `${sc.id}:e`, time: sc.end, kind: 'scenario-end', severity: 'info', title: `Scenario ended: ${sc.label}`, detail: SCENARIO_KIND_LABELS[sc.kind], ...target, source: 'scenario' });
  }

  out.sort((a, b) => b.time - a.time || SAME_MINUTE_ORDER[a.kind] - SAME_MINUTE_ORDER[b.kind] || (a.key < b.key ? 1 : -1));
  return opts.limit ? out.slice(0, opts.limit) : out;
}
