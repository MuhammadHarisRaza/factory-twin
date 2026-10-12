/**
 * Derivations of the Quality & Defects investigation workspace (pure, no React): the page summary
 * (rate vs limit, most frequent and rising defect), the reject-rate trend, the defect list (quality
 * events + reject records outside an event), the default selection and the evidence of one
 * selected event or record.
 *
 * Everything is read from the one shared simulation state. Records, classes, boxes and confidences
 * are simulated; an origin stage is process knowledge (a hypothesis), never a confirmed cause.
 */
import { DEFECT_ACTIONS } from '../../model/actions';
import { DEFECTS, DEFECT_ORDER, STAGE_BY_ID } from '../../model/plant';
import type { DefectCategory, EventCause, EventValue, OpEvent, ProductionBatch, QualityInspection, ScenarioActivation, StageId } from '../../model/types';
import { batchAt, type SimState } from '../../sim/engine';
import { EVENT_RULE_DEFS, eventById, qualityWindow } from '../../sim/events';
import { defectTrend, qualityIn, risingDefects, type Period, type RisingDefects } from '../../sim/metrics';
import type { VideoTopic } from '../../video/types';
import { eventRecordIds, eventsOfRecord, inMinuteLog, inspectionEventLinks, qualityEventsIn, referenceRate } from './derive';
import { BATCH_LAG_MIN, activeQualityScenario, affectingScenario, isFrameStation } from './frames';
import { STATION_BY_ID } from './lookup';

type QualityEventSets = { open: OpEvent[]; resolved: OpEvent[] };

// ── Rising defect ────────────────────────────────────────────────────────────

export type RisingDefect = {
  defect: DefectCategory;
  /** Category rate (rejected ÷ inspected) over the last 120 min of the period. */
  recentRate: number;
  /** Category rate in the 24 h before (as the deterioration rule reads it). */
  referenceRate: number;
  /** recent ÷ reference (a rising category always has a reference rate). */
  ratio: number | null;
  recentTiles: number;
  /** Rejects above the reference rate for the tiles inspected recently. */
  excessTiles: number;
  window: { from: number; to: number };
};

/**
 * The defect category rising the most at the end of the period — risingDefects (src/sim/metrics.ts),
 * the one shared rule: the deterioration rule's 120 min vs the 24 h before, its thresholds, ranked by
 * excess rejects. The copilot and the insights read the same function. Null when nothing is rising.
 */
export function risingDefect(s: SimState, p: Period, r: RisingDefects = risingDefects(s, p)): RisingDefect | null {
  const top = r.rising[0];
  if (!top || top.recentRate == null || top.referenceRate == null) return null;
  return {
    defect: top.defect,
    recentRate: top.recentRate,
    referenceRate: top.referenceRate,
    ratio: top.ratio,
    recentTiles: top.recentTiles,
    excessTiles: top.excessTiles,
    window: r.window,
  };
}

// ── Summary ──────────────────────────────────────────────────────────────────

export type QualitySummary = {
  inspected: number;
  rejected: number;
  /** Reject rate in the period (null when nothing was inspected). */
  rate: number | null;
  /** Alert limit of the reject-rate rule (fraction). */
  limit: number;
  top: { defect: DefectCategory; tiles: number; share: number } | null;
  rising: RisingDefect | null;
  /** Enough tiles were inspected in the last 120 min (and the 24 h before) to tell whether a category is rising. */
  riseJudged: boolean;
  /** Unresolved quality events, and how many of them still have their condition active. */
  open: number;
  active: number;
  scenario: ScenarioActivation | null;
};

export function qualitySummary(s: SimState, p: Period, events: QualityEventSets = qualityEventsIn(s, p)): QualitySummary {
  const q = qualityIn(s, p);
  const ranked = DEFECT_ORDER.map((d) => ({ d, n: q.byDefect[d] })).sort((a, b) => b.n - a.n);
  const top = ranked[0] && ranked[0].n > 0 ? { defect: ranked[0].d, tiles: ranked[0].n, share: q.rejected > 0 ? ranked[0].n / q.rejected : 0 } : null;
  const rise = risingDefects(s, p);
  return {
    inspected: q.inspected,
    rejected: q.rejected,
    rate: q.inspected > 0 ? q.rejected / q.inspected : null,
    limit: s.rules.rejectRateMax,
    top,
    rising: risingDefect(s, p, rise),
    riseJudged: rise.sufficient,
    open: events.open.length,
    active: events.open.filter((e) => e.end == null).length,
    scenario: activeQualityScenario(s),
  };
}

const pctText = (f: number, d = 1) => `${(f * 100).toFixed(d)} %`;
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const upper = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The period as a phrase: "in Shift A · 06:00–14:00", "in the last 24 hours", "today (since 06:00)". */
export function inPeriod(label: string): string {
  if (/^(Last|Previous|Current) /.test(label)) return `in the ${lower(label)}`;
  if (/^Today\b/.test(label)) return lower(label);
  return `in ${label}`;
}

/** How much a rising category grew, in words ("2.4× its rate in the 24 h before", or "new"). */
export function riseText(r: RisingDefect): string {
  return r.ratio == null ? 'none in the 24 h before' : `${r.ratio.toFixed(1)}× its rate in the 24 h before`;
}

/** The page's one-paragraph operational summary, from the data only. */
export function summaryText(m: QualitySummary, periodLabel: string): string {
  const parts: string[] = [];
  if (m.rate == null) parts.push(`No tiles have been inspected ${inPeriod(periodLabel)} yet.`);
  else parts.push(`Reject rate ${pctText(m.rate, 2)} ${inPeriod(periodLabel)} — ${m.rate > m.limit ? 'above' : 'within'} the ${pctText(m.limit, 0)} alert limit.`);
  const rising = m.rising ? DEFECTS[m.rising.defect].label : null;
  const top = m.top ? DEFECTS[m.top.defect].label : null;
  if (rising && m.top && m.rising!.defect === m.top.defect)
    parts.push(`${upper(rising)} is rising (${riseText(m.rising!)}) and is the most frequent defect (${pctText(m.top.share, 0)} of rejects).`);
  else {
    const bits: string[] = [];
    if (rising) bits.push(`${upper(rising)} is rising (${riseText(m.rising!)})`);
    if (top) bits.push(`${rising ? lower(top) : upper(top)} is the most frequent defect (${pctText(m.top!.share, 0)} of rejects)`);
    if (bits.length) parts.push(`${bits.join('; ')}.`);
    if (!rising && m.rate != null)
      parts.push(m.riseJudged === false ? 'Too few tiles were inspected in the last 2 h to tell whether a defect category is rising.' : 'No defect category is rising against the 24 h before.');
  }
  parts.push(
    m.open === 0
      ? 'No quality event is open.'
      : `${m.open} quality event${m.open === 1 ? ' is' : 's are'} open${m.active ? `, ${m.active} with the condition still active` : ''}.`,
  );
  return parts.join(' ');
}

// ── Trend ────────────────────────────────────────────────────────────────────

export type TrendPoint = { start: number; inspected: number; rejected: number; rate: number | null; focusRate: number | null };

/** Reject rate per hour (per 4 h over a week) for all defects and one focus category. */
export function rateTrend(s: SimState, p: Period, focus: DefectCategory | null): { bucketMin: number; points: TrendPoint[] } {
  const bucketMin = p.to - p.from > 2 * 1440 ? 240 : 60;
  const points = defectTrend(s, p, bucketMin).map((b) => {
    const rejected = DEFECT_ORDER.reduce((a, d) => a + b.byDefect[d], 0);
    return {
      start: b.start,
      inspected: b.inspected,
      rejected,
      rate: b.inspected > 0 ? rejected / b.inspected : null,
      focusRate: focus && b.inspected > 0 ? b.byDefect[focus] / b.inspected : null,
    };
  });
  return { bucketMin, points };
}

// ── Defect list ──────────────────────────────────────────────────────────────

export type DefectListData = {
  /** Quality events: open now (whatever the period), then resolved in the period. */
  events: OpEvent[];
  /** Reject records with a defect in the period that no quality event references, newest first (limited). */
  records: QualityInspection[];
  /** All such records in the period (before the limit). */
  recordTotal: number;
  /** Rejected tiles per category in the period (for the filter). */
  byDefect: Record<DefectCategory, number>;
};

export function defectList(
  s: SimState,
  p: Period,
  opts: { defect: DefectCategory | null; recordLimit: number },
  links: Map<string, string[]> = inspectionEventLinks(s),
  events: QualityEventSets = qualityEventsIn(s, p),
): DefectListData {
  const d = opts.defect;
  const evs = [...events.open, ...events.resolved].filter((e) => !d || e.refs.defect === d);
  const records: QualityInspection[] = [];
  let recordTotal = 0;
  for (let i = s.inspections.length - 1; i >= 0; i--) {
    const r = s.inspections[i];
    if (r.time >= p.to) continue;
    if (r.time < p.from) break;
    if (r.result !== 'reject' || !r.defect || links.has(r.id) || (d && r.defect !== d)) continue;
    recordTotal++;
    if (records.length < opts.recordLimit) records.push(r);
  }
  return { events: evs, records, recordTotal, byDefect: qualityIn(s, p).byDefect };
}

const newest = (list: OpEvent[]) => [...list].sort((a, b) => b.start - a.start || b.id.localeCompare(a.id))[0] ?? null;

/**
 * What the workspace shows when the address names nothing: the newest open quality event, else the
 * newest resolved one of the period, else the newest reject record of the period.
 */
export function defaultSelection(s: SimState, p: Period, links: Map<string, string[]> = inspectionEventLinks(s), events: QualityEventSets = qualityEventsIn(s, p)): string | null {
  const ev = newest(events.open) ?? newest(events.resolved);
  if (ev) return ev.id;
  for (let i = s.inspections.length - 1; i >= 0; i--) {
    const r = s.inspections[i];
    if (r.time >= p.to) continue;
    if (r.time < p.from) break;
    if (r.result === 'reject' && r.defect && !links.has(r.id)) return r.id;
  }
  return null;
}

// ── Selection ────────────────────────────────────────────────────────────────

export type Selection =
  | { kind: 'event'; id: string; ev: OpEvent }
  | { kind: 'record'; id: string; rec: QualityInspection }
  /** Not (or no longer) retained — or an event of another category (`other`). */
  | { kind: 'missing'; id: string; other: OpEvent | null };

export function resolveSelection(s: SimState, id: string): Selection {
  const ev = eventById(s, id);
  if (ev) return ev.category === 'quality' ? { kind: 'event', id, ev } : { kind: 'missing', id, other: ev };
  for (let i = s.inspections.length - 1; i >= 0; i--) if (s.inspections[i].id === id) return { kind: 'record', id, rec: s.inspections[i] };
  return { kind: 'missing', id, other: null };
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/** A rate in the evidence metrics; `unavailable` explains a missing value instead of inventing one. */
export type RateStat = { value: number | null; note: string; unavailable?: string };

export type EvidenceStats = {
  /** What the rates measure ("Glaze inconsistency rate" or "Reject rate"). */
  measure: string;
  before: RateStat;
  during: RateStat;
  after: RateStat;
  /** Rejects above the reference rate in the event window (events only). */
  excess: number | null;
};

export type EvidenceModel = {
  id: string;
  kind: 'event' | 'record';
  ev: OpEvent | null;
  /** The record itself when a record is selected (also a lab sample, which has no image). */
  rec: QualityInspection | null;
  defect: DefectCategory | null;
  /** Records the image strip offers (retained), oldest first; for a record, itself. */
  records: QualityInspection[];
  /** Records the event references that are no longer retained. */
  missing: string[];
  /** Why there is no inspection image, when there is none. */
  noImage: string | null;
  /** Record shown first. */
  primaryId: string | null;
  /** Batch per record (null when not retained), and the batch at inspection for an event without records. */
  batches: Record<string, ProductionBatch | null>;
  eventBatch: ProductionBatch | null;
  stationId: string | null;
  equipmentId: string | null;
  /** Modeled origin stage of the defect category — a hypothesis, not a finding. */
  origin: StageId | null;
  time: number;
  end: number | null;
  source: 'simulation' | 'scenario';
  scenario: ScenarioActivation | null;
  /** Other quality events that share records with this one, or the events that reference the record. */
  related: OpEvent[];
  stats: EvidenceStats;
  causes: EventCause[];
  /** Recommended quality actions (first = the defect category's standard action). */
  actions: string[];
  rule: { id: string; label: string; description: string; observed: EventValue[]; threshold: EventValue | null } | null;
};

const AFTER_MIN = 60;

/** Category (or all-defect) rate over [t − minutes + 1, t] from the minute log; null outside it. */
function windowRate(s: SimState, t: number, minutes: number, d: DefectCategory | null): { rate: number | null; inspected: number; rejected: number } | null {
  if (!inMinuteLog(s, t, minutes)) return null;
  const w = qualityWindow(s, t, minutes, d ?? undefined);
  return { rate: w.rate, inspected: w.inspected, rejected: w.rejected };
}

function afterStat(s: SimState, from: number, d: DefectCategory | null, what: string): RateStat {
  const elapsed = s.minute - 1 - from;
  if (elapsed < 10) return { value: null, note: `${AFTER_MIN} min after ${what}`, unavailable: `Less than 10 min since ${what}` };
  const win = Math.min(AFTER_MIN, elapsed);
  const w = windowRate(s, from + win, win, d);
  if (!w) return { value: null, note: `${win} min after ${what}`, unavailable: 'Older than the 4-hour per-minute log' };
  return { value: w.rate, note: `${win} min after ${what}` };
}

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Possible causes of a record outside an event: the category's modeled origin (a hypothesis) and a recorded scenario input. */
export function recordCauses(s: SimState, rec: QualityInspection): EventCause[] {
  if (!rec.defect) return [];
  const origin = STAGE_BY_ID[DEFECTS[rec.defect].origin];
  const out: EventCause[] = [];
  const sc = affectingScenario(s, rec);
  if (sc) out.push({ text: `Quality deterioration at ${origin.name.toLowerCase()} injected by a scenario (${sc.label})`, confidence: 'confirmed', basis: 'Scenario log' });
  out.push({
    text: `Process condition at ${origin.name.toLowerCase()} (where ${DEFECTS[rec.defect].label.toLowerCase()} usually originates)`,
    confidence: 'possible',
    basis: 'Process knowledge of the defect category — a hypothesis to check, not a confirmed cause',
  });
  return out;
}

const batchById = (s: SimState, id: string) => s.batches.find((b) => b.id === id) ?? null;

export function eventEvidence(s: SimState, ev: OpEvent, links: Map<string, string[]> = inspectionEventLinks(s)): EvidenceModel {
  const ids = eventRecordIds(s, ev);
  const byId = new Map<string, QualityInspection>();
  if (ids.length) {
    const want = new Set(ids);
    for (const r of s.inspections) if (want.has(r.id)) byId.set(r.id, r);
  }
  const records = ids
    .map((id) => byId.get(id))
    .filter((r): r is QualityInspection => !!r)
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const missing = ids.filter((id) => !byId.has(id));
  const imaged = records.filter((r) => isFrameStation(r.stationId));
  // A critical-defect review starts at the record that raised it; other rules at their latest record.
  const primary = ev.type === 'critical-defect' ? imaged[0] : imaged[imaged.length - 1];
  const d = ev.refs.defect ?? null;
  const stationId = ev.asset.stationId ?? null;
  const unavailableEvidence = s.evidence.find((x) => x.eventId === ev.id && x.kind === 'inspection-image' && x.status === 'unavailable');
  const noImage = imaged.length
    ? null
    : missing.length
      ? 'The records of this event are no longer in the retained inspection history'
      : (unavailableEvidence?.unavailableReason ?? 'No individual reject record falls in the event window');

  // Related quality events: those sharing a record, and the events named by its causes or relations.
  const relatedIds = new Set<string>();
  for (const id of ids) for (const e of links.get(id) ?? []) relatedIds.add(e);
  for (const c of ev.causes) if (c.relatedEventId) relatedIds.add(c.relatedEventId);
  for (const r of ev.related) relatedIds.add(r);
  relatedIds.delete(ev.id);
  const related = [...relatedIds]
    .map((id) => eventById(s, id))
    .filter((e): e is OpEvent => !!e)
    .sort((a, b) => b.start - a.start)
    .slice(0, 5);

  const ref = ev.acc.referenceRejectRate;
  const inspected = ev.acc.inspected;
  const rejects = ev.acc.rejects;
  const rule = EVENT_RULE_DEFS.find((r) => r.id === ev.trigger.ruleId);
  return {
    id: ev.id,
    kind: 'event',
    ev,
    rec: null,
    defect: d,
    records: imaged,
    missing,
    noImage,
    primaryId: primary?.id ?? null,
    batches: Object.fromEntries(records.map((r) => [r.id, batchById(s, r.batchId)])),
    eventBatch: primary ? batchById(s, primary.batchId) : batchAt(s, ev.start - BATCH_LAG_MIN),
    stationId,
    equipmentId: ev.asset.equipmentId ?? (stationId ? (STATION_BY_ID[stationId]?.equipmentId ?? null) : null),
    origin: d ? DEFECTS[d].origin : null,
    time: ev.start,
    end: ev.end,
    source: ev.source,
    scenario: ev.refs.scenarioId ? (s.scenarios.find((x) => x.id === ev.refs.scenarioId) ?? null) : null,
    related,
    stats: {
      measure: d ? `${DEFECTS[d].label} rate` : 'Reject rate',
      before: ref != null ? { value: ref, note: '24 h before detection' } : { value: null, note: '24 h before detection', unavailable: 'No inspection in the 24 h before detection' },
      during:
        inspected > 0
          ? { value: rejects / inspected, note: `${Math.round(rejects)} of ${Math.round(inspected)} tiles` }
          : { value: null, note: 'Event window', unavailable: 'No tile inspected in the event window' },
      after: ev.end == null ? { value: null, note: 'After clearing', unavailable: 'Condition still active' } : afterStat(s, ev.end, d, 'clearing'),
      excess: ref != null ? Math.max(0, rejects - ref * inspected) : null,
    },
    causes: ev.causes,
    actions: unique([...(d ? [DEFECT_ACTIONS[d]] : []), ...ev.recommendations]),
    rule: {
      id: ev.trigger.ruleId,
      label: rule?.label ?? ev.trigger.ruleId,
      description: ev.trigger.description,
      observed: ev.trigger.observed,
      threshold: ev.trigger.threshold ?? null,
    },
  };
}

export function recordEvidence(s: SimState, rec: QualityInspection, links: Map<string, string[]> = inspectionEventLinks(s)): EvidenceModel {
  const d = rec.defect;
  const imaged = isFrameStation(rec.stationId);
  const sc = affectingScenario(s, rec);
  const before = d ? referenceRate(s, rec.time, d) : null;
  const during = windowRate(s, rec.time, 60, d);
  const lab = rec.stationId === 'ST-QC';
  const stats: EvidenceStats = lab
    ? {
        measure: 'Lab sample',
        before: { value: null, note: '24 h reference', unavailable: 'A lab sample is not part of the sorting reject rate' },
        during: { value: null, note: '60 min to the record', unavailable: 'A lab sample is not part of the sorting reject rate' },
        after: { value: null, note: '60 min after the record', unavailable: 'A lab sample is not part of the sorting reject rate' },
        excess: null,
      }
    : {
        measure: d ? `${DEFECTS[d].label} rate` : 'Reject rate',
        before: before != null ? { value: before, note: '24 h reference' } : { value: null, note: '24 h reference', unavailable: 'No inspection in the 24 h reference window' },
        during: during ? { value: during.rate, note: '60 min to the record' } : { value: null, note: '60 min to the record', unavailable: 'Older than the 4-hour per-minute log' },
        after: afterStat(s, rec.time, d, 'the record'),
        excess: null,
      };
  return {
    id: rec.id,
    kind: 'record',
    ev: null,
    rec,
    defect: d,
    records: imaged ? [rec] : [],
    missing: [],
    noImage: imaged ? null : 'Lab sample checks are measured on the bench and not imaged',
    primaryId: imaged ? rec.id : null,
    batches: { [rec.id]: batchById(s, rec.batchId) },
    eventBatch: batchById(s, rec.batchId),
    stationId: rec.stationId,
    equipmentId: STATION_BY_ID[rec.stationId]?.equipmentId ?? null,
    origin: d ? DEFECTS[d].origin : null,
    time: rec.time,
    end: null,
    source: rec.source,
    scenario: sc,
    related: eventsOfRecord(s, links, rec.id),
    stats,
    causes: recordCauses(s, rec),
    actions: d
      ? unique([
          ...(rec.severity === 'critical' ? ['Pull the tile for manual review and check the neighbouring tiles of the same batch.'] : []),
          DEFECT_ACTIONS[d],
        ])
      : rec.result === 'reject'
        ? ['Retest the sample and hold the batch until the lab result is confirmed.']
        : [],
    rule: null,
  };
}

/** Evidence of the selected event or record (null when it is not retained or not a quality item). */
export function evidenceFor(s: SimState, sel: Selection, links: Map<string, string[]> = inspectionEventLinks(s)): EvidenceModel | null {
  if (sel.kind === 'event') return eventEvidence(s, sel.ev, links);
  if (sel.kind === 'record') return recordEvidence(s, sel.rec, links);
  return null;
}

// ── Reference footage ────────────────────────────────────────────────────────

const DEFECT_TOPIC: Record<DefectCategory, VideoTopic> = {
  crack: 'crack-chip-inspection',
  chip: 'crack-chip-inspection',
  surface: 'surface-inspection',
  shade: 'surface-inspection',
  glaze: 'glaze-defect-inspection',
  planarity: 'dimensional-inspection',
  dimension: 'dimensional-inspection',
};

/**
 * Reference-footage topic for an inspection: by defect category, else by station. Lab samples have
 * no matching inspection footage (null).
 */
export function inspectionTopic(stationId: string | null, defect: DefectCategory | null): VideoTopic | null {
  if (defect) return DEFECT_TOPIC[defect];
  if (stationId === 'ST-GAUGE') return 'dimensional-inspection';
  if (stationId === 'ST-VIS') return 'surface-inspection';
  return null;
}
