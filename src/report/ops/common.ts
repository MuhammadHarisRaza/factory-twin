/**
 * Shared pieces of the operational report builders: period and scope labels, the significant
 * events of a period (the same OpEvent records as Events & Reports, by id), their impact headline and
 * estimate (src/intel/report.ts eventImpact — consequence events are valued under their root), the
 * evidence they already carry, and the actions they recommend.
 */
import { eventImpact, type EventImpact } from '../../intel/report';
import { feedStaleSince, type KpiModel } from '../../intel/kpis';
import { DEFECTS, MONITORED_STAGE_BY_ID, REASON_BY_CODE } from '../../model/plant';
import type { AlertSeverity, MonitoredStageId, OpEvent } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { DEFAULT_TARIFFS, type Tariffs } from '../../sim/energy';
import { EVENT_STATUS_LABEL, EVENT_TYPE_LABEL, evidenceOf } from '../../sim/events';
import { DEFAULT_FINANCE, type FinanceAssumptions } from '../../sim/finance';
import { PERIOD_LABELS, resolvePeriod, type Period } from '../../sim/metrics';
import { formatClock, formatDate, formatDateTime, formatDay } from '../../sim/time';
import { cameraName } from '../../intel/report';
import { LABELS, fmtMoney, plantClock, plantTime } from '../format';
import { hasLiveCameraFrame } from '../model';
import { fileSafe } from '../text';
import { SEV_RANK, inQueryScope, inStageOf, isSignificant, overlapsPeriod, type ReportEventQuery } from './select';
import type { Basis, OpsReportType, ReportBlock, ReportEventRow, ReportEvidenceItem, ReportKpi, ReportPeriodKey, ReportScope, ReportSection } from './types';

export { SEV_RANK } from './select';

export const REPORT_TYPE_LABEL: Record<OpsReportType | 'incident', string> = {
  shift: 'Shift production performance',
  oee: 'OEE & production losses',
  quality: 'Quality & defect trends',
  fleet: 'Vehicle movement & delays',
  incident: 'Incident investigation',
};

export const sevLabel = (s: AlertSeverity) => s.charAt(0).toUpperCase() + s.slice(1);

export const int = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-GB'));
export const dec1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
export const pct1 = (f: number | null | undefined) => (f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(1)} %`);

/** The report period: resolvePeriod (the same as the header period selector) with a readable span. */
export function reportPeriod(key: ReportPeriodKey, now: number) {
  const p = resolvePeriod(key, now);
  const toDate = p.to >= now;
  const span = `${formatDateTime(p.from)} – ${Math.floor(p.from / 1440) === Math.floor(p.to / 1440) ? formatClock(p.to) : formatDateTime(p.to)}${toDate ? ' (to date)' : ''}`;
  const label = key === 'shift' ? `Current shift · ${p.label}` : key === 'prev-shift' ? `Previous shift · ${p.label}` : PERIOD_LABELS[key];
  return { key, label, from: p.from, to: p.to, text: span, period: p as Period };
}

/** "Whole line" or the stage name. */
export function scopeLabel(scope: ReportScope, whole = 'Whole line') {
  if (scope === 'line') return whole;
  const st = MONITORED_STAGE_BY_ID[scope];
  return st ? `${st.name} (${st.id})` : scope;
}

export const withBasis = (k: KpiModel, basis: Basis): ReportKpi => ({ ...k, basis });

// Stale data feeds (one rule with the app): a figure that rests on a feed which stopped updating keeps the
// simulation's running accounting — the same number as the KPI card — and carries the card's mark
// "Not confirmed · <asset> data stale since hh:mm"; report text never states it as a fact.

/** The stale mark a KPI model carries ("Not confirmed · kiln data stale since 10:30"), or null when its feed is fresh. */
export const staleStatus = (k: KpiModel): string | null => (k.provenance === 'stale' ? (k.status?.label ?? 'Not confirmed · data stale') : null);
/** The mark without its "Not confirmed · " lead, for a sentence: "kiln data stale since 10:30". */
export const staleReason = (mark: string) => mark.replace(/^Not confirmed · /, '');
/** A table value a stale feed has not confirmed: "98.7 % · not confirmed" (the note under the table says why). */
export const notConfirmedCell = (v: string, mark: string | null) => (mark ? `${v} · not confirmed` : v);

/** Feed names as the KPI cards say them; other assets by id. */
const FEED_WORD: Record<string, string> = { 'H-KILN': 'kiln', 'I-SORT': 'sorting' };
/** The stale mark of one asset's data feed in the period ("Not confirmed · E-PRS1 data stale since 10:20"), or null. */
export function feedStaleMark(s: SimState, id: string, p: Period): string | null {
  const since = feedStaleSince(s, id, p);
  return since == null ? null : `Not confirmed · ${FEED_WORD[id] ?? id} data stale since ${whenLabel(since, s.minute)}`;
}

/**
 * The significant events of a report: root events of warning severity and above whose condition
 * overlaps the period, in the query's categories and stage — most severe first, then ongoing, then
 * newest. The Events tab lists the same events from the same query (select.ts).
 */
export function significantEvents(s: SimState, p: Period, q: Pick<ReportEventQuery, 'categories' | 'stage'>, minSeverity: AlertSeverity = 'warning'): OpEvent[] {
  return s.events
    .filter((e) => overlapsPeriod(e, p, s.minute) && isSignificant(e, minSeverity) && inQueryScope(e, q))
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || Number(b.end == null) - Number(a.end == null) || b.start - a.start || b.id.localeCompare(a.id));
}

/** Whether an event belongs to a scope (any event for the whole line, else the stage rule used by Production). */
export function inScope(e: OpEvent, scope: ReportScope) {
  return scope === 'line' || inStageOf(e, scope);
}

/** The event query of a report: its period, categories (null = any) and stage (null = whole line). */
export const eventQuery = (period: ReportPeriodKey, categories: ReportEventQuery['categories'], scope: ReportScope): ReportEventQuery => ({ period, categories, stage: scope === 'line' ? null : scope });

const rowValue = (imp: EventImpact, label: string | RegExp) => imp.rows.find((r) => (typeof label === 'string' ? r.label === label : label.test(r.label)))?.value;

/** One short impact statement per event, read from its impact rows (nothing recomputed). */
export function impactHeadline(ev: OpEvent, imp: EventImpact): string {
  switch (ev.category) {
    case 'production': {
      if (ev.consequenceOf) return `Counted under ${ev.consequenceOf}`;
      const lost = rowValue(imp, 'Line good output lost');
      return ev.acc.constraintMin > 0 ? `${lost ?? '—'} line output · kiln held ${int(ev.acc.constraintMin)} min` : 'No line output lost (buffers absorbed it)';
    }
    case 'quality':
      return rowValue(imp, 'Excess rejects') ? `${rowValue(imp, 'Excess rejects')} excess rejects` : `${rowValue(imp, /^Rejected/) ?? '—'} rejected`;
    case 'logistics':
      return rowValue(imp, 'Minutes beyond the threshold')
        ? `${rowValue(imp, 'Minutes beyond the threshold')} beyond the limit`
        : rowValue(imp, 'Trucks waiting at detection')
          ? `${rowValue(imp, 'Trucks waiting at detection')} trucks waiting at detection`
          : (rowValue(imp, 'Safety exposure') ?? (imp.rows[0]?.value ?? '—'));
    case 'equipment':
      return rowValue(imp, 'Health now') ? `Health ${rowValue(imp, 'Health now')}` : (imp.rows[0]?.value ?? '—');
    case 'data':
      return `Data gap ${rowValue(imp, 'Data gap') ?? '—'}`;
    default:
      return imp.rows[0]?.value ?? '—';
  }
}

/** Where an event happened, in a few words. */
export function eventWhere(ev: OpEvent): string {
  const a = ev.asset;
  const stage = a.stage ? (MONITORED_STAGE_BY_ID[a.stage as MonitoredStageId]?.name ?? a.stage) : null;
  const what = a.equipmentId ?? a.stationId ?? a.vehicleId ?? a.dockId ?? a.geofenceId ?? (a.zone ? `Zone ${a.zone}` : 'Plant');
  return stage ? `${what} · ${stage}` : what;
}

export function eventRow(s: SimState, ev: OpEvent, finance: FinanceAssumptions = DEFAULT_FINANCE, tariffs: Tariffs = DEFAULT_TARIFFS): ReportEventRow {
  const imp = eventImpact(s, ev, finance, tariffs);
  return {
    id: ev.id,
    start: ev.start,
    title: ev.title,
    severity: ev.severity,
    status: ev.status,
    category: ev.category,
    active: ev.end == null,
    source: ev.source,
    where: eventWhere(ev),
    impact: impactHeadline(ev, imp),
    estimate: imp.estimate && imp.estimate.lines.length ? imp.estimate.total : null,
  };
}

/** Clock time when on the same plant day as `now`, otherwise day and time. */
export const whenLabel = (t: number, now: number) => (Math.floor(t / 1440) === Math.floor(now / 1440) ? plantClock(t) : plantTime(t));

/** Lifecycle status and, while open, whether the condition still persists ("Not acknowledged · ongoing"). */
export const statusText = (r: Pick<ReportEventRow, 'status' | 'active'>) =>
  r.status === 'resolved' ? 'Resolved' : `${r.status === 'active' ? 'Not acknowledged' : EVENT_STATUS_LABEL[r.status]} · ${r.active ? 'ongoing' : 'cleared'}`;

/** Rows of the event table the in-app preview shows before "Show all" (the PDF prints every row). */
export const EVENT_PREVIEW_ROWS = 12;

/**
 * Table of ALL significant events of the report (ids link to the event in the app) — the PDF prints
 * every row (autoTable continues the table across pages, header repeated); the preview shows the
 * first EVENT_PREVIEW_ROWS with "Show all", and offers the same list in the Events tab.
 */
export function eventsTable(rows: ReportEventRow[], currency: string, empty: string, now: number, query: ReportEventQuery): ReportBlock[] {
  const out: ReportBlock[] = [
    {
      kind: 'table',
      head: ['Event', 'Start', 'Event title', 'Severity', 'Status', 'Where', 'Impact', 'Estimate'],
      rows: rows.map((r) => [
        { text: r.id, eventId: r.id },
        whenLabel(r.start, now),
        `${r.title}${r.source === 'scenario' ? ' (scenario)' : ''}`,
        sevLabel(r.severity),
        statusText(r),
        r.where,
        r.impact,
        r.estimate != null ? fmtMoney(currency, r.estimate) : '—',
      ]),
      align: ['l', 'l', 'l', 'l', 'l', 'l', 'l', 'r'],
      widths: [17, 20, 'auto', 14, 20, 24, 30, 18],
      empty,
      collapseAfter: EVENT_PREVIEW_ROWS,
    },
  ];
  if (rows.length) out.push({ kind: 'events-link', count: rows.length, query });
  return out;
}

/** "3 events listed above" — the count printed with a total, so the total can be checked against the rows. */
export const listedCount = (n: number) => `${n} event${n === 1 ? '' : 's'} listed above`;

/**
 * Camera snapshots / inspection frames the events already carry (frozen at detection), with their
 * provenance. Nothing is captured for the report: only evidence that is available is shown (at most
 * `perEvent` items per event, `max` in all), so the report never pads itself with empty frames.
 */
export function evidenceItems(s: SimState, events: OpEvent[], kinds: ReportEvidenceItem['kind'][], max = 4, perEvent = 1): ReportEvidenceItem[] {
  const out: ReportEvidenceItem[] = [];
  for (const ev of events) {
    let n = 0;
    for (const x of evidenceOf(s, ev)) {
      if (out.length >= max) return out;
      if (n >= perEvent) break;
      if (x.kind !== 'camera-snapshot' && x.kind !== 'inspection-image') continue;
      if (!kinds.includes(x.kind) || x.status !== 'available') continue;
      const rec = x.inspectionId ? s.inspections.find((r) => r.id === x.inspectionId) : undefined;
      if (x.kind === 'inspection-image' && !rec) continue;
      if (x.kind === 'camera-snapshot' && !x.image) continue;
      const caption: string[] = [`${ev.id} · ${ev.title}`];
      if (x.kind === 'camera-snapshot') {
        caption.push(x.provenance.origin === 'live-camera' ? `Camera frame · ${x.provenance.label}` : LABELS.noCameraFrame);
        caption.push(`Frame time ${plantTime(x.image?.frameTime ?? x.capturedAt)}${x.cameraId ? ` · ${x.cameraId} ${cameraName(x.cameraId)}` : ''}`);
      } else if (rec) {
        caption.push(`${rec.defect ? DEFECTS[rec.defect].label : 'No defect'}${rec.confidence != null ? ` · ${Math.round(rec.confidence * 100)} % ${LABELS.simulatedConfidence}` : ''} · ${rec.stationId} · ${plantClock(rec.time)}`);
        caption.push(LABELS.illustrativeFrame);
      }
      out.push({ eventId: ev.id, evidenceId: x.id, kind: x.kind, title: x.title, caption, status: 'available', inspectionId: x.inspectionId, provenance: x.provenance });
      n++;
    }
  }
  return out;
}

/** A subhead and the evidence figures, or nothing when no evidence is available. */
export const evidenceBlocks = (items: ReportEvidenceItem[], title: string): ReportBlock[] => (items.length ? [{ kind: 'subhead', text: title }, { kind: 'evidence', items }] : []);

/** The first recommended action of each open significant event (deduplicated, with the event id). */
export function eventActions(events: OpEvent[], max = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.status === 'resolved') continue;
    const rec = e.recommendations[0];
    if (!rec || seen.has(rec)) continue;
    seen.add(rec);
    out.push(`${e.id} (${EVENT_TYPE_LABEL[e.type].toLowerCase()}, ${e.end == null ? 'condition ongoing' : 'condition cleared'}): ${rec}`);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Recurring causes among the significant events — the same stop reason (by downtime reason code)
 * or the same defect class (by defect id) in two or more events. Grouped by stable ids only.
 */
export function recurringPatterns(s: SimState, events: OpEvent[], max = 3): string[] {
  const groups = new Map<string, { label: string; ids: string[]; where: Set<string> }>();
  for (const e of events) {
    let key: string | null = null;
    let label = '';
    if (e.refs.downtimeId) {
      const d = s.downtime.find((x) => x.id === e.refs.downtimeId);
      if (d) {
        key = `dt:${d.reasonCode}`;
        label = `stop reason "${REASON_BY_CODE[d.reasonCode]?.label ?? d.reasonCode}"`;
      }
    } else if (e.category === 'quality' && e.refs.defect) {
      key = `q:${e.refs.defect}`;
      label = `defect "${DEFECTS[e.refs.defect].label}"`;
    } else if (e.category === 'logistics') {
      key = `l:${e.type}`;
      label = `"${EVENT_TYPE_LABEL[e.type].toLowerCase()}"`;
    }
    if (!key) continue;
    const g = groups.get(key) ?? { label, ids: [], where: new Set<string>() };
    g.ids.push(e.id);
    g.where.add(e.asset.equipmentId ?? e.asset.vehicleId ?? e.asset.stationId ?? e.asset.dockId ?? 'site');
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.ids.length >= 2)
    .sort((a, b) => b.ids.length - a.ids.length)
    .slice(0, max)
    .map((g) => `Recurring ${g.label}: ${g.ids.length} events (${g.ids.slice(0, 4).join(', ')}${g.ids.length > 4 ? ', …' : ''}) on ${[...g.where].join(', ')} — look for a common cause rather than treating each one alone.`);
}

/**
 * Time buckets of a report chart: hours for periods up to a day, shifts (8 h, aligned to 06/14/22:00)
 * for the 7-day period, so a chart never has more than ~24 points.
 */
export function chartBuckets(p: Period, key: ReportPeriodKey, now: number): { from: number; to: number; label: string }[] {
  const size = key === '7d' ? 480 : 60;
  const out: { from: number; to: number; label: string }[] = [];
  for (let from = Math.floor(p.from / size) * size; from < p.to; from += size) {
    const a = Math.max(p.from, from);
    const b = Math.min(p.to, now, from + size);
    if (b <= a) continue;
    const label = size === 60 ? formatClock(from) : `${formatDay(from).replace(/^\w+,?\s*/, '')} ${['A', 'B', 'C'][Math.floor((from % 1440) / 480)]}`;
    out.push({ from: a, to: b, label });
  }
  return out;
}

/** Downtime minutes in the period by reason (planned stops and starved / blocked spells excluded), optionally for some assets only. */
export function downtimeByReason(s: SimState, p: Period, assets?: string[]) {
  const rows = new Map<string, { label: string; category: string; minutes: number; n: number }>();
  for (const d of s.downtime) {
    if (!(d.start < p.to && (d.end ?? s.minute) > p.from)) continue;
    if (d.category === 'Planned' || d.category === 'Starved' || d.category === 'Blocked') continue;
    if (assets && !assets.includes(d.equipmentId)) continue;
    const r = REASON_BY_CODE[d.reasonCode];
    const row = rows.get(d.reasonCode) ?? { label: r?.label ?? d.reasonCode, category: r?.category ?? d.category, minutes: 0, n: 0 };
    row.minutes += Math.max(0, Math.min(d.end ?? s.minute, p.to) - Math.max(d.start, p.from));
    row.n++;
    rows.set(d.reasonCode, row);
  }
  return [...rows.values()].filter((r) => r.minutes > 0).sort((a, b) => b.minutes - a.minutes);
}

export function reportFileName(type: OpsReportType, scope: ReportScope, period: { key: ReportPeriodKey; from: number }) {
  return `wAI-report-${type}-${fileSafe(scope === 'line' ? 'line' : scope)}-${period.key}-${formatDate(period.from)}.pdf`;
}

export const OPS_DISCLAIMER =
  'Demonstration with simulated data of a representative plant — not plant results. Figures come from the simulation, not from plant systems; no camera image is included, inspection frames are illustrations of simulated records, financial figures are estimates from the stated assumptions.';
/** Footer of an operational report whose evidence includes a frame grabbed from a configured camera stream. */
export const OPS_DISCLAIMER_LIVE_CAMERA =
  'Demonstration with simulated data of a representative plant — not plant results. Figures come from the simulation, not from plant systems; camera evidence includes a frame from a configured camera stream (labelled as a camera frame), inspection frames illustrate simulated records, financial figures are estimates.';

/** The evidence figures a report includes (every evidence block of every section). */
export const reportEvidence = (sections: ReportSection[]): ReportEvidenceItem[] => sections.flatMap((sec) => sec.blocks.flatMap((b) => (b.kind === 'evidence' ? b.items : [])));

/** Whether the report includes a frame of a configured camera stream. */
export const reportHasLiveCameraFrame = (sections: ReportSection[]) => hasLiveCameraFrame(reportEvidence(sections));

/** Footer disclaimer that matches the provenance of the evidence the report actually includes. */
export const opsDisclaimer = (sections: ReportSection[]) => (reportHasLiveCameraFrame(sections) ? OPS_DISCLAIMER_LIVE_CAMERA : OPS_DISCLAIMER);
