/**
 * Pure derivations for the Command Center. Every figure comes from the shared simulation
 * state through src/sim/metrics.ts, src/sim/health.ts and src/intel/insights.ts; these
 * helpers only select, merge and rank them for the operational overview.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { M2_PER_TILE, OPS_BY_ID, PROCESS_MACHINES, PRODUCTS, REASON_BY_CODE, SCENARIO_KIND_LABELS, STAGE_BY_ID } from '../../model/plant';
import type { Alert, AlertSeverity, MachineState, Product, ProductionBatch, RecordSource, ScenarioActivation } from '../../model/types';
import { batchAt, scenariosActive, type SimState } from '../../sim/engine';
import type { Tariffs } from '../../sim/energy';
import { HEALTH_ASSETS, assess, type HealthLevel } from '../../sim/health';
import {
  bottleneck,
  clippedDuration,
  defectShift,
  downtimeIn,
  energyIn,
  fleetMetrics,
  lineMetrics,
  qualityIn,
  resolvePeriod,
  type LineMetrics,
  type Period,
} from '../../sim/metrics';
import { formatDuration } from '../../sim/time';

export const eqName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? id;
const hourFloor = (m: number) => Math.floor(m / 60) * 60;
const isFlow = (category: string) => category === 'Starved' || category === 'Blocked';

/** Window of the alerts table and the alert counts in the header strip. */
export const ALERT_WINDOW_MIN = 8 * 60;
/** Window of the event timeline. */
export const TIMELINE_WINDOW_MIN = 4 * 60;

/** Alert severity of a stoppage, as the engine raises it. */
export const stopSeverity = (equipmentId: string): AlertSeverity =>
  equipmentId === 'H-KILN' ? 'critical' : OPS_BY_ID[equipmentId]?.stage === 'PRESS' ? 'serious' : 'warning';

// ── Alerts ────────────────────────────────────────────────────────────────────

/** Alerts raised in the last `windowMin` minutes, newest first. */
export function recentAlerts(s: SimState, windowMin = ALERT_WINDOW_MIN): Alert[] {
  const from = s.minute - windowMin;
  const out: Alert[] = [];
  for (let i = s.alerts.length - 1; i >= 0; i--) {
    const a = s.alerts[i];
    if (a.time < from) continue;
    out.push(a);
  }
  return out.sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
}

export type SeverityCounts = Record<AlertSeverity, number>;

export function countBySeverity(alerts: Alert[]): SeverityCounts {
  const c: SeverityCounts = { critical: 0, serious: 0, warning: 0, info: 0 };
  for (const a of alerts) c[a.severity]++;
  return c;
}

// ── Equipment requiring attention ─────────────────────────────────────────────

export type AttentionKind = 'down' | 'reduced' | 'health';

export type AttentionRow = {
  id: string;
  name: string;
  state: MachineState | null;
  kinds: AttentionKind[];
  /** Why the asset is listed (stop reason, rate, health finding). */
  reasons: string[];
  /** Since when the condition holds (null when unknown). */
  since: number | null;
  health: { level: HealthLevel; score: number } | null;
  scenario: boolean;
  /** Ordering weight (higher first). */
  rank: number;
};

const HEALTH_RANK: Record<HealthLevel, number> = { alarm: 280, warning: 200, watch: 60, normal: 0, offline: 0 };

/** Process machines that are down or running at a reduced rate, and monitored assets at health warning or alarm. */
export function attentionList(s: SimState): AttentionRow[] {
  const now = s.minute;
  const active = scenariosActive(s);
  const rows = new Map<string, AttentionRow>();
  const row = (id: string): AttentionRow => {
    let r = rows.get(id);
    if (!r) {
      r = { id, name: eqName(id), state: s.machines[id]?.state ?? null, kinds: [], reasons: [], since: null, health: null, scenario: false, rank: 0 };
      rows.set(id, r);
    }
    return r;
  };

  for (const id of PROCESS_MACHINES) {
    const m = s.machines[id];
    if (m.state === 'down') {
      const ev = m.activeDowntimeId ? s.downtime.find((d) => d.id === m.activeDowntimeId) : undefined;
      const r = row(id);
      r.kinds.push('down');
      r.reasons.push(ev ? REASON_BY_CODE[ev.reasonCode].label : 'Unplanned stop');
      r.since = ev?.start ?? m.since;
      r.scenario ||= ev?.source === 'scenario';
      r.rank = Math.max(r.rank, id === 'H-KILN' ? 400 : stopSeverity(id) === 'serious' ? 320 : 300);
    } else if (m.state === 'reduced') {
      const sc = active.find((x) => (x.kind === 'reduced-rate' && x.equipmentId === id) || (x.kind === 'bottleneck' && x.stage === OPS_BY_ID[id].stage));
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
    if (r.since == null) r.since = lastHealthAlert(s, a.id);
    r.rank = Math.max(r.rank, HEALTH_RANK[h.level]) + (100 - h.score) / 10;
  }

  return [...rows.values()].sort((x, y) => y.rank - x.rank || (x.since ?? now) - (y.since ?? now));
}

/** Time of the latest condition-monitoring escalation alert for an asset. */
function lastHealthAlert(s: SimState, id: string): number | null {
  for (let i = s.alerts.length - 1; i >= 0; i--) {
    const a = s.alerts[i];
    if (a.equipmentId === id && a.title.startsWith('Condition monitoring:')) return a.time;
  }
  return null;
}

export function attentionCounts(rows: AttentionRow[]) {
  return {
    total: rows.length,
    down: rows.filter((r) => r.kinds.includes('down')).length,
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
  inspected: number;
  rejected: number;
  rate: number | null;
  refRate: number | null;
  ratio: number | null;
  rows: ReturnType<typeof defectShift>;
  rising: ReturnType<typeof defectShift>;
  batch: ProductionBatch;
  product: Product | null;
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
  return {
    inspected: rec.inspected,
    rejected: rec.rejected,
    rate,
    refRate,
    ratio,
    rows,
    rising,
    batch,
    product: PRODUCTS.find((p) => p.sku === batch.sku) ?? null,
    exception: (ratio ?? 0) >= 1.35 || rising.length > 0,
  };
}

// ── Header strip ──────────────────────────────────────────────────────────────

export function strip(s: SimState, tariffs: Tariffs) {
  const sp = resolvePeriod('shift', s.minute);
  const lm = lineMetrics(s, sp);
  const bn = bottleneck(s);
  const e = energyIn(s, sp, tariffs);
  const fm = fleetMetrics(s, sp);
  const alerts = countBySeverity(recentAlerts(s));
  const attention = attentionCounts(attentionList(s));
  const q = qualityExceptions(s);
  return {
    period: sp,
    lm,
    bn: { name: bn.current.name, stage: bn.current.stage, activeShare: bn.current.activeShare, shifted: bn.shifted, machines: STAGE_BY_ID[bn.current.stage].machines },
    energy: { excessCost: e.excessCost, deviation: e.deviation, cost: e.cost },
    fleet: { waiting: fm.waiting, onSite: fm.onSite, atDock: fm.atDock },
    alerts,
    attention,
    quality: { rate: q.rate, refRate: q.refRate, ratio: q.ratio, rising: q.rising.length, exception: q.exception },
  };
}

// ── Shift comparison ──────────────────────────────────────────────────────────

export function shiftCompare(s: SimState): { current: LineMetrics; previous: LineMetrics } {
  return { current: lineMetrics(s, resolvePeriod('shift', s.minute)), previous: lineMetrics(s, resolvePeriod('prev-shift', s.minute)) };
}

// ── Event timeline ────────────────────────────────────────────────────────────

export type TimelineKind = 'stop' | 'restart' | 'planned' | 'planned-end' | 'alert' | 'scenario-start' | 'scenario-end' | 'gate-in' | 'gate-out';

export type TimelineItem = {
  key: string;
  time: number;
  kind: TimelineKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  equipmentId?: string;
  vehicleId?: string;
  source: RecordSource;
};

const SAME_MINUTE_ORDER: Record<TimelineKind, number> = {
  stop: 0,
  planned: 0,
  alert: 1,
  'gate-in': 1,
  'gate-out': 1,
  restart: 2,
  'planned-end': 2,
  'scenario-end': 3,
  'scenario-start': 4,
};

/** One-off logistics injections are logged with a 1-minute duration; their "end" is not an event. */
const ONE_OFF = new Set<ScenarioActivation['kind']>(['truck-arrival', 'yard-congestion', 'prolonged-dock-stay']);

function scenarioTarget(sc: ScenarioActivation): string {
  if (sc.equipmentId) return sc.equipmentId;
  if (sc.stage) return STAGE_BY_ID[sc.stage].machines[0];
  return sc.kind === 'truck-arrival' ? 'A-GATE' : 'K-DOCK';
}

/**
 * Merged, newest-first stream of stoppage starts/ends, alerts, scenario starts/ends and
 * (optionally) gate events since `from`. Alerts that only repeat a stoppage start or a
 * scenario start/clear are folded into those events.
 */
export function timeline(s: SimState, opts: { windowMin?: number; gate?: boolean; limit?: number } = {}): TimelineItem[] {
  const now = s.minute;
  const from = now - (opts.windowMin ?? TIMELINE_WINDOW_MIN);
  const inWindow = (t: number) => t >= from && t <= now;
  const out: TimelineItem[] = [];
  const stopStarts = new Set<string>();
  // A stop that ends in the same minute another one starts on that machine was superseded
  // (e.g. by a scenario breakdown): the machine was not back in operation.
  const startsAt = new Set(s.downtime.filter((d) => !isFlow(d.category) && d.start >= from).map((d) => `${d.equipmentId}@${d.start}`));

  for (const d of s.downtime) {
    if (isFlow(d.category)) continue;
    if ((d.end ?? now) < from) continue;
    const reason = REASON_BY_CODE[d.reasonCode];
    const planned = reason.planned;
    const base = { equipmentId: d.equipmentId, source: d.source };
    if (inWindow(d.start)) {
      stopStarts.add(`${d.equipmentId}@${d.start}`);
      out.push({
        ...base,
        key: `${d.id}:s`,
        time: d.start,
        kind: planned ? 'planned' : 'stop',
        severity: planned ? 'info' : stopSeverity(d.equipmentId),
        title: planned ? `${d.equipmentId} planned stop` : `${d.equipmentId} stopped`,
        detail: `${reason.label} · ${eqName(d.equipmentId)}`,
      });
    }
    if (d.end != null && inWindow(d.end) && !startsAt.has(`${d.equipmentId}@${d.end}`))
      out.push({
        ...base,
        key: `${d.id}:e`,
        time: d.end,
        kind: planned ? 'planned-end' : 'restart',
        severity: 'info',
        title: planned ? `${d.equipmentId} planned stop ended` : `${d.equipmentId} back in operation`,
        detail: `${reason.label} · stopped ${formatDuration(d.end - d.start)}`,
      });
  }

  for (const sc of s.scenarios) {
    const equipmentId = scenarioTarget(sc);
    if (inWindow(sc.start))
      out.push({ key: `${sc.id}:s`, time: sc.start, kind: 'scenario-start', severity: 'info', title: `Scenario started: ${sc.label}`, detail: SCENARIO_KIND_LABELS[sc.kind], equipmentId, source: 'scenario' });
    if (sc.end != null && sc.end <= now && inWindow(sc.end) && !ONE_OFF.has(sc.kind))
      out.push({ key: `${sc.id}:e`, time: sc.end, kind: 'scenario-end', severity: 'info', title: `Scenario ended: ${sc.label}`, detail: SCENARIO_KIND_LABELS[sc.kind], equipmentId, source: 'scenario' });
  }

  for (const a of s.alerts) {
    if (!inWindow(a.time)) continue;
    if (a.title.startsWith('Scenario started:') || a.title.startsWith('Scenario cleared:')) continue;
    if (a.equipmentId && a.title === `${a.equipmentId} stopped` && stopStarts.has(`${a.equipmentId}@${a.time}`)) continue;
    out.push({ key: a.id, time: a.time, kind: 'alert', severity: a.severity, title: a.title, detail: a.detail, equipmentId: a.equipmentId, vehicleId: a.vehicleId, source: a.source });
  }

  if (opts.gate)
    for (const g of s.logistics.gateEvents) {
      if (!inWindow(g.time)) continue;
      const label = s.logistics.vehicles[g.vehicleId]?.label ?? g.vehicleId;
      out.push({
        key: g.id,
        time: g.time,
        kind: g.direction === 'in' ? 'gate-in' : 'gate-out',
        severity: 'info',
        title: g.direction === 'in' ? `${label} entered the site` : `${label} left the site`,
        detail: `Main gate · ${g.vehicleId}`,
        vehicleId: g.vehicleId,
        equipmentId: 'A-GATE',
        source: g.source,
      });
    }

  // Newest first; within one minute show effects above causes (a scenario start sits below the stop it caused).
  out.sort((a, b) => b.time - a.time || SAME_MINUTE_ORDER[a.kind] - SAME_MINUTE_ORDER[b.kind] || (a.key < b.key ? 1 : -1));
  return opts.limit ? out.slice(0, opts.limit) : out;
}
