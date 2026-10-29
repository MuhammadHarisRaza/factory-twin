/**
 * PDF document model. The event PDF is built from the SAME EventReport the in-app report renders
 * (src/intel/report.ts buildEventReport): this module only arranges that model into numbered
 * sections of printable blocks — it adds no figures of its own. Missing evidence becomes an explicit
 * "Not available — reason" block, never a blank.
 *
 * All strings are sanitised for jsPDF's WinAnsi standard fonts (text.ts) at the end.
 */
import { cameraName, type EventReport, type ReportEvidence } from '../intel/report';
import { DEFECTS } from '../model/plant';
import type { Evidence, QualityInspection } from '../model/types';
import { CONFIDENCE_LABEL, HISTORY_LABEL, LABELS, fmtMoney, fmtValue, plantClock, plantTime, wallClock } from './format';
import { fileSafe, sanitizeDeep } from './text';
import { LEGEND } from './ops/types';

// ── Model types ───────────────────────────────────────────────────────────────

export type PdfImage = { dataUrl: string; width: number; height: number; format: 'PNG' | 'JPEG' };

export type PdfFigure = {
  title: string;
  /** null → a "Not available — reason" box is drawn in its place. */
  image: PdfImage | null;
  missing?: string;
  caption: string[];
  /** Maximum image height (mm). */
  maxH: number;
};

export type PdfChart = {
  title: string;
  unit: string;
  xLabels: string[];
  series: { label: string; values: (number | null)[]; dashed?: boolean }[];
  limit?: { label: string; value: number };
};

/** A headline KPI tile (operational reports). `tone` colours the side bar; the status words carry the meaning. */
export type PdfKpi = {
  label: string;
  value: string;
  unit?: string;
  scope: string;
  target?: string;
  status?: string;
  tone?: 'good' | 'warning' | 'critical' | 'neutral';
  unavailable?: string;
};

export type PdfBar = { label: string; value: number; display: string; note?: string };

export type PdfBlock =
  | { kind: 'kv'; rows: [string, string][]; columns?: 2 | 4; /** Label column width (mm); defaults 24 (4 columns) / 36 (2 columns). */ labelW?: number }
  | { kind: 'table'; head: string[]; rows: string[][]; widths?: (number | 'auto')[]; empty?: string; align?: ('l' | 'r')[]; foot?: string[] }
  | { kind: 'kpis'; items: PdfKpi[] }
  | { kind: 'bars'; title: string; unit: string; rows: PdfBar[]; empty?: string }
  | { kind: 'text'; text: string; tone?: 'normal' | 'muted' }
  | { kind: 'list'; items: string[]; numbered?: boolean }
  | { kind: 'subhead'; text: string }
  | { kind: 'figures'; items: PdfFigure[]; columns: number }
  | { kind: 'charts'; items: PdfChart[]; columns: number }
  | { kind: 'missing'; title: string; reason: string }
  | { kind: 'total'; label: string; value: string; note?: string };

export type PdfSection = { num: number | null; title: string; tag?: string; blocks: PdfBlock[] };

export type PdfDocModel = {
  /** "Event report" / "Stage shift summary" — printed in the header band. */
  docType: string;
  docId: string;
  title: string;
  lead: string;
  /** Short facts printed under the title ("Severity: Serious"). */
  facts: string[];
  /** Wall-clock and plant-time generation stamps. */
  generatedAt: string;
  generatedAtPlant: string;
  sections: PdfSection[];
  fileName: string;
  /** Page-footer disclaimer; it must match the provenance of what the document shows (see footerDisclaimer). */
  disclaimer: string;
  /** Short note under the SIMULATED DATA marker in the header band (default: "Demonstration · no live plant data"). */
  bandNote?: string;
  /** Scope and period printed after the document id in the header band of every page. */
  bandContext?: string;
};

export type EventPdfContext = {
  /** Resolved images by evidence id (snapshot JPEG / inspection PNG); missing → explained box. */
  images?: Record<string, PdfImage | null | undefined>;
  /** Inspection records of inspection-image evidence, by record id (captions). */
  inspections?: Record<string, QualityInspection | undefined>;
};

export const PRODUCT_NAME = 'wAI Manufacturing Digital Twin';
/** Footer of an event report without a camera frame. */
export const FOOTER_DISCLAIMER =
  'Demonstration with simulated data of a representative plant — not plant results. No camera image is included; inspection frames are illustrations of simulated records, financial figures are estimates from the stated assumptions.';
/** Footer of an event report whose camera evidence includes a frame grabbed from a configured camera stream. */
export const FOOTER_DISCLAIMER_LIVE_CAMERA =
  'Demonstration with simulated data of a representative plant — not plant results. Camera evidence includes a frame from a configured camera stream (labelled as a camera frame); inspection frames are illustrations of simulated records, financial figures are estimates from the stated assumptions.';
/** Footer of a stage shift summary: it shows no camera image, and no camera feeds its figures. */
export const STAGE_FOOTER_DISCLAIMER =
  'Demonstration with simulated data of a representative plant — not plant results. The stage figures come from the simulation, not from cameras or plant systems; financial figures are estimates from the stated assumptions.';
export const BAND_NOTE = 'Demonstration · no live plant data';
export const BAND_NOTE_LIVE_CAMERA = 'Demonstration · simulated plant data + camera frame';

/** Whether the evidence includes a frame grabbed from a configured camera stream. */
export const hasLiveCameraFrame = (evidence: Pick<Evidence, 'kind' | 'provenance'>[]) =>
  evidence.some((x) => x.kind === 'camera-snapshot' && x.provenance.origin === 'live-camera');

/** Page-footer disclaimer that matches the provenance of the document's camera evidence. */
export const footerDisclaimer = (evidence: Pick<Evidence, 'kind' | 'provenance'>[]) =>
  hasLiveCameraFrame(evidence) ? FOOTER_DISCLAIMER_LIVE_CAMERA : FOOTER_DISCLAIMER;

/** The section titles of the event report, in order (in-app and PDF). */
export const EVENT_SECTION_TITLES = [
  'Summary',
  'Affected asset',
  'Detection',
  'Visual evidence',
  'Supporting signals & measurements',
  'Operational context',
  'Impact',
  'Cost estimate',
  'Diagnosis',
  'Recommendations',
  'Acknowledgement & resolution',
  'Data provenance & limitations',
] as const;

// ── Event report → PDF model ─────────────────────────────────────────────────

const or = (v: string | null | undefined, d = '—') => (v == null || v === '' ? d : v);

/** Why a visual evidence item has no image. */
export function missingReason(x: ReportEvidence, hasImage: boolean): string | null {
  if (x.status === 'pending') return 'Being captured — the twin view was still rendering when this report was generated';
  if (x.status === 'unavailable') return x.unavailableReason ?? 'Unavailable';
  if (!hasImage) {
    if (x.kind === 'video-ref') return 'No video recording (NVR) is integrated';
    if (x.kind === 'camera-snapshot')
      return x.provenance.origin === 'live-camera'
        ? 'The camera frame is no longer held in this browser session (images are kept in memory only)'
        : 'The rendered image is no longer held in this browser session (images are kept in memory only)';
    return 'The illustrative frame could not be rendered';
  }
  return null;
}

function snapshotFigure(x: ReportEvidence, img: PdfImage | null | undefined): PdfFigure {
  const live = x.provenance.origin === 'live-camera';
  return {
    title: x.title,
    image: img ?? null,
    missing: missingReason(x, !!img) ?? undefined,
    caption: [
      live ? `Camera frame · ${x.provenance.label}` : LABELS.noCameraFrame,
      `Frame time ${plantTime(x.image?.frameTime ?? x.capturedAt)} (plant time)`,
      `Provenance: ${x.originLabel} — ${x.provenance.label}${x.cameraId ? ` · ${x.cameraId} ${cameraName(x.cameraId)}` : ''}`,
    ],
    maxH: 82,
  };
}

function inspectionFigure(x: ReportEvidence, img: PdfImage | null | undefined, rec: QualityInspection | undefined): PdfFigure {
  const caption: string[] = [];
  if (rec) {
    caption.push(
      `${rec.defect ? DEFECTS[rec.defect].label : 'No defect'}${rec.severity ? ` · ${rec.severity}` : ''}${rec.confidence != null ? ` · ${Math.round(rec.confidence * 100)} % ${LABELS.simulatedConfidence}` : ''}`,
    );
    if (rec.measurement) caption.push(rec.measurement);
    caption.push(`${rec.stationId} · batch ${rec.batchId} · ${plantClock(rec.time)}`);
  }
  caption.push(x.status === 'available' ? LABELS.illustrativeFrame : x.provenance.label);
  const usable = x.status === 'available' && !!rec && !!img;
  return {
    title: x.title,
    image: usable ? img! : null,
    missing: usable ? undefined : x.status === 'available' && !rec ? INSPECTION_GONE : (missingReason(x, !!img) ?? undefined),
    caption,
    maxH: 44,
  };
}

export const INSPECTION_GONE = 'Inspection record no longer retained (the newest 4 000 records are kept)';

/**
 * The measurements captured at detection are shown once, under Operational context ("At detection"),
 * not again under Supporting signals: this is the evidence item they come from (see buildEventReport).
 */
export const contextEvidenceId = (r: EventReport) => r.supportingEvidence.find((x) => x.kind === 'metrics')?.id ?? null;

function seriesCharts(x: ReportEvidence): PdfChart[] {
  return (x.series ?? []).map((sr) => {
    const series: PdfChart['series'] = [{ label: sr.label, values: sr.v }];
    if (sr.expected?.some((v) => v != null)) series.push({ label: 'Expected', values: sr.expected, dashed: true });
    return {
      title: sr.label,
      unit: sr.unit,
      xLabels: sr.t.map((m) => plantClock(m)),
      series,
      limit: sr.limit ? { label: `${sr.limit.label} ${sr.limit.value.toLocaleString('en-GB')} ${sr.unit}`, value: sr.limit.value } : undefined,
    };
  });
}

function supportingBlocks(x: ReportEvidence): PdfBlock[] {
  const out: PdfBlock[] = [{ kind: 'subhead', text: x.title }];
  const prov = `${x.originLabel} — ${x.provenance.label} · captured ${plantTime(x.capturedAt)}${x.kind === 'vehicle-timeline' ? ` · ${LABELS.position}` : ''}`;
  out.push({ kind: 'text', text: prov, tone: 'muted' });
  if (x.status !== 'available') {
    out.push({ kind: 'missing', title: x.title, reason: x.status === 'pending' ? 'Being captured' : (x.unavailableReason ?? 'Unavailable') });
    return out;
  }
  switch (x.kind) {
    case 'signal-series':
    case 'counter-series': {
      const charts = seriesCharts(x).filter((c) => c.series.some((sr) => sr.values.some((v) => v != null)));
      if (charts.length) out.push({ kind: 'charts', items: charts, columns: charts.length > 1 ? 2 : 1 });
      else out.push({ kind: 'missing', title: x.title, reason: 'No samples in the captured window — chart omitted' });
      break;
    }
    case 'state-transition':
      out.push({
        kind: 'table',
        head: ['Time', 'From', 'To', 'Note'],
        rows: (x.transitions ?? []).map((tr) => [plantClock(tr.t), tr.from, tr.to, or(tr.note)]),
        widths: [18, 'auto', 'auto', 'auto'],
        empty: 'No state change recorded',
      });
      break;
    case 'vehicle-timeline':
      out.push({
        kind: 'table',
        head: ['Milestone', 'Time', 'Note'],
        rows: (x.milestones ?? []).map((m) => [m.label, m.t == null ? 'Not reached' : plantTime(m.t), or(m.note)]),
        widths: ['auto', 34, 'auto'],
      });
      break;
    case 'metrics':
      out.push({ kind: 'kv', rows: (x.metrics ?? []).map((m) => [m.label, fmtValue(m)] as [string, string]), columns: 2 });
      break;
    case 'related-events':
      out.push({ kind: 'list', items: (x.eventIds ?? []).length ? x.eventIds! : ['None'] });
      break;
    default:
      break;
  }
  return out;
}

/** Arranges an EventReport into the 12 numbered PDF sections. */
export function eventPdfModel(r: EventReport, ctx: EventPdfContext = {}): PdfDocModel {
  const ev = r.event;
  const images = ctx.images ?? {};
  const S = r.summary;
  const sections: PdfSection[] = [];
  const sec = (title: (typeof EVENT_SECTION_TITLES)[number], blocks: PdfBlock[], tag?: string) =>
    sections.push({ num: EVENT_SECTION_TITLES.indexOf(title) + 1, title, blocks, tag });

  // 1 Summary
  sec('Summary', [
    {
      kind: 'kv',
      columns: 4,
      rows: [
        ['Event id', S.id],
        ['Type', S.type],
        ['Category', S.category],
        ['Severity', S.severity],
        ['Status', S.status],
        ['Condition', S.condition === 'Active' ? 'Active — condition persists' : 'Cleared'],
        ['Start', S.start],
        ['End', S.end ?? 'Ongoing'],
        ['Duration', `${S.duration}${S.end ? '' : ' so far'}`],
        ['Source', S.source === 'Scenario' ? 'Simulation — demo scenario' : 'Simulation'],
        ['Detected', S.historical ? 'Before this demo session (pre-rolled history)' : 'During this demo session'],
        ['Last update', plantTime(ev.lastUpdate)],
      ],
    },
  ]);

  // 2 Affected asset
  const A = r.asset;
  sec('Affected asset', [
    {
      kind: 'kv',
      columns: 4,
      rows: [
        ['Kind', A.kind],
        ['Id', A.id],
        ['Name', A.name],
        ['Stage', or(A.stage)],
        ['Zone', or(A.zone)],
        ['Camera', A.camera ? `${A.camera} · ${cameraName(A.camera)}` : 'No camera covers this asset'],
      ],
    },
  ]);

  // 3 Detection
  const D = r.detection;
  sec('Detection', [
    {
      kind: 'kv',
      columns: 2,
      rows: [
        ['Source', D.kind],
        ['Rule', `${D.rule} · ${D.ruleLabel}`],
        ['Rule logic', D.description],
        ['Signal', or(D.signalId, 'No single signal — rule on records')],
        ['Threshold', D.threshold ? `${D.threshold.label}: ${fmtValue(D.threshold)}` : 'No numeric threshold'],
      ],
    },
    { kind: 'table', head: ['Observed at detection', 'Value'], rows: D.observed.map((o) => [o.label, fmtValue(o)]), widths: ['auto', 50], empty: 'No observed values recorded' },
  ]);

  // 4 Visual evidence
  const vis: PdfBlock[] = [];
  const snaps = r.visualEvidence.filter((x) => x.kind === 'camera-snapshot');
  const frames = r.visualEvidence.filter((x) => x.kind === 'inspection-image');
  const videos = r.visualEvidence.filter((x) => x.kind === 'video-ref');
  if (snaps.length) vis.push({ kind: 'subhead', text: 'Camera snapshot' }, { kind: 'figures', items: snaps.map((x) => snapshotFigure(x, images[x.id])), columns: 1 });
  if (frames.length) {
    vis.push(
      { kind: 'subhead', text: 'Inspection frames' },
      {
        kind: 'figures',
        items: frames.map((x) => inspectionFigure(x, images[x.id], x.inspectionId ? ctx.inspections?.[x.inspectionId] : undefined)),
        columns: Math.min(4, Math.max(2, frames.length)),
      },
    );
  }
  for (const x of videos) vis.push({ kind: 'missing', title: x.title, reason: missingReason(x, false) ?? 'No video recording' });
  for (const u of r.provenance.unavailable.filter((u) => u.title === 'Video segment')) vis.push({ kind: 'missing', title: 'Video segment', reason: u.reason });
  if (!snaps.length && !frames.length) vis.unshift({ kind: 'text', text: 'No camera or inspection evidence applies to this event.', tone: 'muted' });
  sec('Visual evidence', vis);

  // 5 Supporting signals & measurements
  const ctxId = contextEvidenceId(r);
  const ctxEvidence = r.supportingEvidence.find((x) => x.id === ctxId);
  const sup = r.supportingEvidence.filter((x) => x.id !== ctxId).flatMap(supportingBlocks);
  sec('Supporting signals & measurements', sup.length ? sup : [{ kind: 'text', text: 'No further signal or measurement evidence was captured for this event.', tone: 'muted' }]);

  // 6 Operational context
  const C = r.context;
  sec('Operational context', [
    { kind: 'kv', columns: 2, rows: [['Shift at detection', C.shift], ...C.lineNow.map((x) => [x.label, fmtValue(x)] as [string, string])] },
    ...(C.atDetection.length
      ? ([
          { kind: 'subhead', text: `At detection${ctxEvidence ? ` · ${ctxEvidence.title}` : ''}` },
          ...(ctxEvidence ? [{ kind: 'text', text: `${ctxEvidence.originLabel} — ${ctxEvidence.provenance.label} · captured ${plantTime(ctxEvidence.capturedAt)}`, tone: 'muted' }] : []),
          { kind: 'table', head: ['Measure', 'Value'], rows: C.atDetection.map((x) => [x.label, fmtValue(x)]), widths: ['auto', 50] },
        ] as PdfBlock[])
      : []),
    { kind: 'subhead', text: 'Related events' },
    {
      kind: 'table',
      head: ['Event', 'Title', 'Relation', 'Status'],
      rows: C.related.map((x) => [x.id, x.title, x.relation, x.status]),
      widths: [22, 'auto', 42, 24],
      empty: 'No related events',
    },
  ]);

  // 7 Impact
  const I = r.impact;
  sec('Impact', [
    { kind: 'table', head: ['Measure', 'Value', 'Basis'], rows: I.rows.map((x) => [x.label, x.value, x.basis]), widths: [50, 38, 'auto'], empty: 'No impact quantities apply' },
    ...(I.notes.length ? ([{ kind: 'list', items: I.notes }] as PdfBlock[]) : []),
  ]);

  // 8 Cost estimate
  const E = I.estimate;
  const cost: PdfBlock[] = [];
  if (!E) cost.push({ kind: 'text', text: 'No cost model applies to this event type — no monetary figure is given.', tone: 'muted' });
  else {
    if (E.lines.length) {
      cost.push({ kind: 'table', head: ['Cost line', 'Amount', 'Basis'], rows: E.lines.map((l) => [l.label, fmtMoney(E.currency, l.amount), l.basis]), widths: [48, 28, 'auto'] });
      cost.push({ kind: 'total', label: 'Estimated total', value: fmtMoney(E.currency, E.total), note: 'Estimate from the assumptions below — not a verified business loss.' });
    } else cost.push({ kind: 'text', text: 'No monetary loss is estimated for this event.', tone: 'muted' });
    cost.push({ kind: 'subhead', text: 'Assumptions' }, { kind: 'list', items: E.assumptions });
    if (E.missing.length) cost.push({ kind: 'subhead', text: 'Missing data' }, { kind: 'list', items: E.missing });
    if (E.limitations.length) cost.push({ kind: 'subhead', text: 'Limitations' }, { kind: 'list', items: E.limitations });
  }
  sec('Cost estimate', cost, LABELS.estimate);

  // 9 Diagnosis
  const G = r.diagnosis;
  sec('Diagnosis', [
    { kind: 'subhead', text: 'Observed facts' },
    { kind: 'list', items: G.facts.length ? G.facts : ['No facts recorded'] },
    { kind: 'subhead', text: 'Suspected causes (hypotheses unless confirmed)' },
    {
      kind: 'table',
      head: ['Cause', 'Confidence', 'Basis', 'Related'],
      rows: G.causes.map((c) => [c.text, CONFIDENCE_LABEL[c.confidence], c.basis, or(c.relatedEventId)]),
      widths: ['auto', 22, 'auto', 22],
      empty: 'No cause suggested',
    },
    { kind: 'subhead', text: 'Uncertainty' },
    { kind: 'list', items: G.uncertainty.length ? G.uncertainty : ['None stated'] },
  ]);

  // 10 Recommendations
  sec('Recommendations', [r.recommendations.length ? { kind: 'list', items: r.recommendations, numbered: true } : { kind: 'text', text: 'No recommendation recorded.', tone: 'muted' }]);

  // 11 Acknowledgement & resolution
  const R = r.resolution;
  sec('Acknowledgement & resolution', [
    {
      kind: 'kv',
      columns: 2,
      rows: [
        ['Status', R.status],
        ['Owner', or(R.owner, 'Unassigned')],
        [
          'Resolution',
          R.resolution ? `${R.resolution.by === 'user' ? 'Resolved by user' : 'Resolved by the system'} at ${plantTime(R.resolution.t)}: ${R.resolution.reason}` : 'Not resolved',
        ],
        ['Action taken', or(R.resolution?.action)],
      ],
    },
    { kind: 'subhead', text: 'Notes' },
    { kind: 'table', head: ['Time', 'By', 'Note'], rows: R.notes.map((n) => [plantTime(n.t), n.by, n.text]), widths: [30, 30, 'auto'], empty: 'No notes' },
    { kind: 'subhead', text: 'History' },
    {
      kind: 'table',
      head: ['Time', 'Action', 'By', 'Detail'],
      rows: R.history.map((h) => [plantTime(h.t), HISTORY_LABEL[h.action], h.by === 'user' ? 'User' : 'System', h.text]),
      widths: [30, 26, 14, 'auto'],
    },
    ...(R.reports.length
      ? ([
          { kind: 'subhead', text: 'Reports exported earlier' },
          { kind: 'table', head: ['Plant time', 'Wall clock', 'Format'], rows: R.reports.map((x) => [plantTime(x.t), wallClock(x.at), x.format.toUpperCase()]), widths: [34, 'auto', 18] },
        ] as PdfBlock[])
      : []),
  ]);

  // 12 Data provenance & limitations
  const P = r.provenance;
  sec('Data provenance & limitations', [
    { kind: 'kv', columns: 2, rows: [['Origin', P.origin], ['Signals used', P.sources.length ? P.sources.join(', ') : 'None (rule on records)']] },
    { kind: 'subhead', text: 'Unavailable evidence' },
    { kind: 'table', head: ['Item', 'Reason'], rows: P.unavailable.map((u) => [u.title, u.reason]), widths: [56, 'auto'], empty: 'Nothing missing' },
    { kind: 'subhead', text: 'Limitations' },
    { kind: 'list', items: P.disclaimers },
    { kind: 'subhead', text: 'How to read this report' },
    { kind: 'table', head: ['Label', 'Meaning'], rows: LEGEND.map((l) => [l.label, l.text]), widths: [38, 'auto'] },
    { kind: 'text', text: `Report generated ${wallClock(r.generatedAt)} (wall clock) · ${r.generatedAtPlant}. Built from event record ${ev.id} and its evidence; the in-app report shows the same model.`, tone: 'muted' },
  ]);

  return sanitizeDeep<PdfDocModel>({
    docType: 'Event report',
    docId: ev.id,
    title: ev.title,
    lead: ev.summary,
    facts: [`Severity: ${S.severity}`, `Status: ${S.status}`, `Condition: ${S.condition}`, `Category: ${S.category}`, `Source: ${S.source}`],
    generatedAt: wallClock(r.generatedAt),
    generatedAtPlant: r.generatedAtPlant,
    sections,
    fileName: `wAI-event-${fileSafe(ev.id)}.pdf`,
    bandContext: `${A.id === '—' ? A.name : A.id} · ${plantTime(ev.start)} - ${ev.end != null ? plantClock(ev.end) : 'ongoing'}`,
    // The footer says whether a frame grabbed from a configured stream is included.
    disclaimer: footerDisclaimer(r.visualEvidence),
    bandNote: hasLiveCameraFrame(r.visualEvidence) ? BAND_NOTE_LIVE_CAMERA : BAND_NOTE,
  });
}

/** Image format jsPDF needs for a data URL. */
export const imageFormat = (dataUrl: string): PdfImage['format'] => (/^data:image\/jpe?g/i.test(dataUrl) ? 'JPEG' : 'PNG');
