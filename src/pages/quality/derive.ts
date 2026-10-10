/**
 * Pure derivations for AI Defect Monitoring: how an inspection record links to quality events,
 * the detection rules evaluated at a record, the production context at the time and the scrap /
 * rework impact. Everything is read from the one shared simulation state — nothing is kept here.
 *
 * Inference is simulated: records, classes, boxes and confidences come from deterministic rules of
 * the simulation. No vision model runs.
 */
import { BASE_REJECT_RATE, DEFECTS, DEFECT_ORDER, INSPECTION_STATIONS, PRODUCTS, STAGE_BY_ID } from '../../model/plant';
import type {
  DefectCategory,
  EventStatus,
  MachineState,
  OpEvent,
  QualityInspection,
  ScenarioActivation,
  StageId,
} from '../../model/types';
import { LOG_MIN, minuteAt, type SimState } from '../../sim/engine';
import { EVENT_RULE_DEFS, eventById, eventsFor, qualityWindow } from '../../sim/events';
import { rejectCost, type FinanceAssumptions, type MoneyLine } from '../../sim/finance';
import { lineMetrics, qualityIn, type Period } from '../../sim/metrics';
import type { Metric, OeeResult } from '../../sim/oee';
import type { EventImpact } from '../../intel/report';

// ── Inference source ─────────────────────────────────────────────────────────

/** Model / source shown for tunnel classifications. Simulated — not a trained model. */
export const SIM_MODEL = 'SIM-CV v0 (simulated)';
export const SIM_INFERENCE = 'Simulated inference · deterministic rules, no vision model';
export const VISION_NOTE = 'Real vision inference would come from a configured model (VISION data source — not connected).';

export const VISION_CLASSES: DefectCategory[] = INSPECTION_STATIONS.find((s) => s.id === 'ST-VIS')?.detects ?? [];
export const GAUGE_CLASSES: DefectCategory[] = INSPECTION_STATIONS.find((s) => s.id === 'ST-GAUGE')?.detects ?? [];
export const isGaugeDefect = (d: DefectCategory) => DEFECTS[d].station === 'ST-GAUGE';

export type InspectionMethod = {
  kind: 'vision' | 'gauge' | 'lab';
  /** Model version / source of the result. */
  source: string;
  /** What the category is (vision class vs measurement). */
  classKind: string;
  note: string;
};

/** Only tunnel classifications carry a (simulated) confidence; gauge results are tolerance checks on a measurement. */
export const isVisionRecord = (rec: Pick<QualityInspection, 'stationId'> | null | undefined) => rec?.stationId === 'ST-VIS';

export function inspectionMethod(stationId: string): InspectionMethod {
  if (stationId === 'ST-VIS') return { kind: 'vision', source: SIM_MODEL, classKind: 'Vision class', note: SIM_INFERENCE };
  if (stationId === 'ST-GAUGE')
    return {
      kind: 'gauge',
      source: 'Gauge tolerance rule · simulated laser reading',
      classKind: 'Gauge measurement (non-vision)',
      note: 'A measurement checked against a tolerance — not a vision classification',
    };
  return { kind: 'lab', source: 'Manual lab check (simulated)', classKind: 'Lab sample', note: 'Water absorption / MOR sample — not a vision classification' };
}

// ── Record ↔ event links ─────────────────────────────────────────────────────

/**
 * Inspection record id → ids of the quality events that reference it (OpEvent.refs.inspectionIds
 * or inspection-image evidence), newest event first.
 */
export function inspectionEventLinks(s: SimState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (recId: string, evId: string) => {
    const a = out.get(recId);
    if (!a) out.set(recId, [evId]);
    else if (!a.includes(evId)) a.push(evId);
  };
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (e.category !== 'quality') continue;
    for (const id of e.refs.inspectionIds ?? []) add(id, e.id);
  }
  for (let i = s.evidence.length - 1; i >= 0; i--) {
    const x = s.evidence[i];
    if (x.kind === 'inspection-image' && x.inspectionId) add(x.inspectionId, x.eventId);
  }
  return out;
}

/** Quality events that reference a record, newest first. */
export function eventsOfRecord(s: SimState, links: Map<string, string[]>, recId: string): OpEvent[] {
  return (links.get(recId) ?? []).map((id) => eventById(s, id)).filter((e): e is OpEvent => !!e).sort((a, b) => b.start - a.start);
}

const SEV_RANK = { info: 0, warning: 1, serious: 2, critical: 3 } as const;
export const STATUS_ORDER: Record<EventStatus, number> = { active: 0, investigating: 1, acknowledged: 2, resolved: 3 };

/**
 * Quality events for the page: every event still open now (whatever the period — an open event
 * needs attention), condition-active first, then by severity and recency; and the resolved events
 * that overlap the period, most recently ended first.
 */
export function qualityEventsIn(s: SimState, p: Period): { open: OpEvent[]; resolved: OpEvent[] } {
  const open = s.events
    .filter((e) => e.category === 'quality' && e.status !== 'resolved')
    .sort((a, b) => Number(a.end != null) - Number(b.end != null) || SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.start - a.start);
  const resolved = eventsFor(s, { category: 'quality', from: p.from, to: p.to - 1 })
    .filter((e) => e.status === 'resolved')
    .sort((a, b) => (b.end ?? b.start) - (a.end ?? a.start));
  return { open, resolved };
}

/** Label and threshold of the rule that raised an event (thresholds from the rule set in force). */
export function eventRule(s: SimState, ev: OpEvent) {
  const def = EVENT_RULE_DEFS.find((r) => r.id === ev.trigger.ruleId);
  const threshold = ev.trigger.threshold ? `${ev.trigger.threshold.value}${ev.trigger.threshold.unit ? ` ${ev.trigger.threshold.unit}` : ''}` : null;
  const current = def?.threshold ? s.rules[def.threshold] : null;
  return { id: ev.trigger.ruleId, label: def?.label ?? ev.trigger.ruleId, threshold, current };
}

// ── Rules evaluated at one record ────────────────────────────────────────────

export type RuleCheck = {
  id: 'Q-RATE' | 'Q-COUNT' | 'Q-REPEAT' | 'Q-DET' | 'Q-CRIT';
  label: string;
  threshold: string;
  /** Value at the record; null when it cannot be evaluated (reason in `note`). */
  value: string | null;
  /** Condition met at the record (null = not evaluable). */
  over: boolean | null;
  note?: string;
};

const pct = (f: number, d = 1) => `${(f * 100).toFixed(d)} %`;

/** Whether [t − minutes + 1, t] is still entirely inside the per-minute log. */
export const inMinuteLog = (s: SimState, t: number, minutes: number) => t < s.minute && t - minutes + 1 >= s.minute - LOG_MIN;

/** Category rate in the 24 h before the last 2 h (the deterioration rule's reference, from hourly buckets). */
export function referenceRate(s: SimState, t: number, d: DefectCategory): number | null {
  const h1 = Math.floor((t - 120) / 60);
  let inspected = 0;
  let rejected = 0;
  for (let h = h1 - 24; h < h1; h++) {
    const q = s.quality.get(h);
    if (!q) continue;
    inspected += q['ST-VIS'].inspected;
    rejected += q[DEFECTS[d].station]?.byDefect[d] ?? 0;
  }
  return inspected > 0 ? rejected / inspected : null;
}

/** Consecutive reject records of the record's category at its station, ending with the record. */
export function repeatRun(s: SimState, rec: Pick<QualityInspection, 'id' | 'stationId' | 'defect'>): number {
  const i = s.inspections.findIndex((r) => r.id === rec.id);
  if (i < 0 || !rec.defect) return 0;
  let n = 0;
  for (let j = i; j >= 0; j--) {
    const r = s.inspections[j];
    if (r.stationId !== rec.stationId || r.result !== 'reject' || !r.defect) continue;
    if (r.defect !== rec.defect) break;
    n++;
  }
  return n;
}

const OUT_OF_LOG = 'window outside the 4-hour minute log';

/**
 * The quality detection rules evaluated at a record (or, for a sampled pass frame, at a minute):
 * the same windows and thresholds the event engine uses (s.rules).
 */
export function ruleChecks(s: SimState, at: { time: number; rec: QualityInspection | null }): RuleCheck[] {
  const R = s.rules;
  const t = at.time;
  const rec = at.rec;
  const d = rec?.result === 'reject' ? rec.defect : null;
  const out: RuleCheck[] = [];

  const rate: RuleCheck = { id: 'Q-RATE', label: 'Reject rate · 60 min', threshold: `> ${pct(R.rejectRateMax)}`, value: null, over: null };
  if (inMinuteLog(s, t, 60)) {
    const w = qualityWindow(s, t, 60);
    rate.value = w.rate != null ? pct(w.rate, 2) : '—';
    rate.over = w.rate != null && w.inspected >= 300 ? w.rate > R.rejectRateMax : null;
    if (w.inspected < 300) rate.note = 'fewer than 300 tiles inspected — rule not evaluated';
  } else rate.note = OUT_OF_LOG;
  out.push(rate);

  if (d) {
    const count: RuleCheck = { id: 'Q-COUNT', label: `${DEFECTS[d].label} · 30 min`, threshold: `> ${R.defectCount30Max} tiles`, value: null, over: null };
    if (inMinuteLog(s, t, 30)) {
      const w = qualityWindow(s, t, 30, d);
      count.value = `${Math.round(w.rejected)} tiles`;
      count.over = w.rejected > R.defectCount30Max;
    } else count.note = OUT_OF_LOG;
    out.push(count);

    const n = repeatRun(s, rec!);
    out.push({
      id: 'Q-REPEAT',
      label: 'Consecutive same-class records',
      threshold: `≥ ${R.defectRepeatRecords} records`,
      value: n > 0 ? `${n} record${n === 1 ? '' : 's'}` : null,
      over: n > 0 ? n >= R.defectRepeatRecords : null,
      note: n > 0 ? undefined : 'record no longer in the retained history',
    });

    const det: RuleCheck = { id: 'Q-DET', label: `${DEFECTS[d].label} · 2 h vs 24 h before`, threshold: `≥ ${R.deteriorationRatio}×`, value: null, over: null, note: 'evaluated every 15 min' };
    if (inMinuteLog(s, t, 120)) {
      const recent = qualityWindow(s, t, 120, d);
      const ref = referenceRate(s, t, d);
      const ratio = recent.rate != null && ref ? recent.rate / ref : null;
      if (ratio != null) {
        det.value = `${ratio.toFixed(1)}×`;
        det.over = recent.inspected >= 600 && ratio >= R.deteriorationRatio && (recent.rate ?? 0) >= 0.004;
      } else det.note = 'no reference rate for the 24 h before';
    } else det.note = OUT_OF_LOG;
    out.push(det);

    out.push({ id: 'Q-CRIT', label: 'Critical classification', threshold: 'severity = critical', value: rec!.severity ?? '—', over: rec!.severity === 'critical' });
  }
  return out;
}

// ── Production context ───────────────────────────────────────────────────────

export type StateAt = { id: string; role: string; state: MachineState | null };

/**
 * Machine states at a minute (from the 4-hour minute log): the defect's origin-stage machines and
 * the sorting line. null = not in the log any more.
 */
export function contextStates(s: SimState, rec: Pick<QualityInspection, 'time' | 'defect'>, t = rec.time): StateAt[] {
  const ids: { id: string; role: string }[] = [];
  if (rec.defect) for (const id of STAGE_BY_ID[DEFECTS[rec.defect].origin].machines) ids.push({ id, role: `Origin · ${STAGE_BY_ID[DEFECTS[rec.defect].origin].name}` });
  ids.push({ id: 'I-SORT', role: 'Sorting line' });
  return ids.map((x) => ({ ...x, state: minuteAt(s, x.id, t)?.state ?? null }));
}

// ── Impact ───────────────────────────────────────────────────────────────────

/** Scrap and rework cost of rejected tiles (estimate from the finance assumptions). */
export function rejectImpact(f: FinanceAssumptions, rejectedTiles: number): { lines: MoneyLine[]; total: number } {
  const lines = rejectCost(f, Math.max(0, rejectedTiles));
  return { lines, total: lines.reduce((a, l) => a + l.amount, 0) };
}

/** OEE points lost to quality: A × P × (1 − Q), or null when a component is not available. */
export function qualityOeeLoss(oee: OeeResult): number | null {
  const { availability: a, performance: p, quality: q } = oee;
  if (a.status !== 'ok' || p.status !== 'ok' || q.status !== 'ok') return null;
  return a.value! * p.value! * (1 - q.value!);
}

/** Figures of an event's impact (the same EventImpact the report renders). */
export function impactFigures(impact: EventImpact) {
  const row = (label: string) => impact.rows.find((r) => r.label === label)?.value ?? null;
  return {
    inspected: row('Inspected in the event window'),
    rejected: impact.rows.find((r) => r.label.startsWith('Rejected'))?.value ?? null,
    excess: row('Excess rejects'),
    rateEffect: row('Effect on quality rate'),
    total: impact.estimate && impact.estimate.lines.length ? impact.estimate.total : null,
    currency: impact.estimate?.currency ?? null,
  };
}

export const fmtMoney = (currency: string, v: number | null | undefined, digits = 0) =>
  v == null || !Number.isFinite(v) ? '—' : `${currency} ${v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

// ── Period impact (scrap / rework, quality rate, OEE) ────────────────────────

export type PeriodQualityImpact = {
  inspected: number;
  rejected: number;
  accepted: number;
  rate: number | null;
  /** Scrap and rework of every rejected tile in the period. */
  lines: MoneyLine[];
  total: number;
  /** Rejects above the plant's baseline reject rate (BASE_REJECT_RATE) and their cost. */
  baseRate: number;
  excessVsBase: number;
  excessVsBaseTotal: number;
  /** Rejects of the same seed simulated without scenarios (null until that twin is in step). */
  baselineRejected: number | null;
  extraVsBaseline: number | null;
  extraVsBaselineTotal: number | null;
  /** Line quality rate (first-pass yield at sorting = the Q of line OEE) and line OEE. */
  quality: Metric;
  oee: Metric;
  /** OEE points lost to quality: A × P × (1 − Q); null when a component is unavailable. */
  oeeLossToQuality: number | null;
};

export function periodQualityImpact(s: SimState, p: Period, f: FinanceAssumptions, baseline: SimState | null): PeriodQualityImpact {
  const lm = lineMetrics(s, p);
  const { inspected, rejected } = lm;
  const all = rejectImpact(f, rejected);
  const excessVsBase = Math.max(0, rejected - inspected * BASE_REJECT_RATE);
  const base = baseline && baseline.minute === s.minute ? qualityIn(baseline, p).rejected : null;
  const extra = base != null ? rejected - base : null;
  return {
    inspected,
    rejected,
    accepted: lm.good,
    rate: inspected > 0 ? rejected / inspected : null,
    lines: all.lines,
    total: all.total,
    baseRate: BASE_REJECT_RATE,
    excessVsBase,
    excessVsBaseTotal: rejectImpact(f, excessVsBase).total,
    baselineRejected: base,
    extraVsBaseline: extra,
    extraVsBaselineTotal: extra != null ? rejectImpact(f, Math.max(0, extra)).total : null,
    quality: lm.oee.quality,
    oee: lm.oee.oee,
    oeeLossToQuality: qualityOeeLoss(lm.oee),
  };
}

// ── Correlation evidence for root-cause hypotheses ───────────────────────────

export type DefectMixRow = { d: DefectCategory; n: number; share: number; refShare: number | null };
export type MachineWindow = { id: string; logged: number; byState: Partial<Record<MachineState, number>> };

export type Correlation = {
  from: number;
  to: number;
  /** Whether the window lies inside the 4-hour per-minute log (otherwise hourly counters are used). */
  minuteResolution: boolean;
  /** Rejects by category in the event window, with the category's share in the 24 h before detection. */
  mix: DefectMixRow[];
  topDefect: DefectCategory | null;
  /** Stage where the event's category (or the window's top category) usually originates. */
  origin: StageId | null;
  /** States of the origin stage's machines during the window (minutes from the 4-hour minute log). */
  machines: MachineWindow[];
  /** Non-quality events on the origin stage's machines that overlap the window (correlation in time only). */
  concurrent: OpEvent[];
  /** Batches of the inspection records linked to the event. */
  batches: { id: string; sku: string; records: number }[];
  /** Scenario recorded on the event (a known input of the simulation). */
  scenario: ScenarioActivation | null;
};

/** Category shares of rejects in the 24 h before a minute (hourly station buckets). */
export function referenceMix(s: SimState, t: number): Partial<Record<DefectCategory, number>> {
  const h1 = Math.floor(t / 60);
  const by: Partial<Record<DefectCategory, number>> = {};
  let total = 0;
  for (let h = h1 - 24; h < h1; h++) {
    const q = s.quality.get(h);
    if (!q) continue;
    for (const st of Object.values(q))
      for (const [d, n] of Object.entries(st.byDefect)) {
        by[d as DefectCategory] = (by[d as DefectCategory] ?? 0) + (n ?? 0);
        total += n ?? 0;
      }
  }
  const out: Partial<Record<DefectCategory, number>> = {};
  if (total > 0) for (const d of DEFECT_ORDER) out[d] = (by[d] ?? 0) / total;
  return out;
}

/** Inspection record ids an event references (refs and inspection-image evidence). */
export function eventRecordIds(s: SimState, ev: OpEvent): string[] {
  const ids = new Set(ev.refs.inspectionIds ?? []);
  const own = new Set(ev.evidence);
  for (const x of s.evidence) if (x.kind === 'inspection-image' && x.inspectionId && own.has(x.id)) ids.add(x.inspectionId);
  return [...ids];
}

/**
 * Evidence that correlates with a quality event: defect mix vs the reference, origin-stage machine
 * states, concurrent events, batches and recorded scenario inputs. Correlation only — it supports
 * or weakens a hypothesis, it never establishes a cause.
 */
export function correlationEvidence(s: SimState, ev: OpEvent): Correlation {
  const to = Math.max(ev.start, Math.min(ev.end ?? s.minute - 1, s.minute - 1));
  const from = ev.start;
  const len = to - from + 1;
  const minuteResolution = inMinuteLog(s, to, len);
  const counts: Partial<Record<DefectCategory, number>> = {};
  if (minuteResolution) for (const d of DEFECT_ORDER) counts[d] = qualityWindow(s, to, len, d).rejected;
  else {
    const q = qualityIn(s, { from, to: to + 1, label: '' });
    for (const d of DEFECT_ORDER) counts[d] = q.byDefect[d];
  }
  const total = DEFECT_ORDER.reduce((a, d) => a + (counts[d] ?? 0), 0);
  const ref = referenceMix(s, from);
  const mix = DEFECT_ORDER.map((d) => ({ d, n: counts[d] ?? 0, share: total > 0 ? (counts[d] ?? 0) / total : 0, refShare: ref[d] ?? null }))
    .filter((r) => r.n > 0 || r.d === ev.refs.defect)
    .sort((a, b) => b.n - a.n);
  const topDefect = ev.refs.defect ?? (mix[0] && mix[0].n > 0 ? mix[0].d : null);
  const origin = topDefect ? DEFECTS[topDefect].origin : null;
  const machineIds = origin ? STAGE_BY_ID[origin].machines : [];
  const machines = machineIds.map((id) => {
    const byState: Partial<Record<MachineState, number>> = {};
    let logged = 0;
    for (let m = Math.max(from, s.minute - LOG_MIN); m <= to; m++) {
      const x = minuteAt(s, id, m);
      if (!x) continue;
      logged++;
      byState[x.state] = (byState[x.state] ?? 0) + 1;
    }
    return { id, logged, byState };
  });
  const concurrent = eventsFor(s, { from, to })
    .filter((e) => e.category !== 'quality' && !!e.asset.equipmentId && machineIds.includes(e.asset.equipmentId))
    .sort((a, b) => a.start - b.start);
  const recIds = new Set(eventRecordIds(s, ev));
  const byBatch = new Map<string, number>();
  for (const r of s.inspections) if (recIds.has(r.id)) byBatch.set(r.batchId, (byBatch.get(r.batchId) ?? 0) + 1);
  const batches = [...byBatch.entries()].map(([id, records]) => ({ id, sku: s.batches.find((b) => b.id === id)?.sku ?? PRODUCTS[0].sku, records }));
  const scenario = ev.refs.scenarioId ? (s.scenarios.find((x) => x.id === ev.refs.scenarioId) ?? null) : null;
  return { from, to, minuteResolution, mix, topDefect, origin, machines, concurrent, batches, scenario };
}
