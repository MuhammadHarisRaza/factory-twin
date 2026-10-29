/**
 * Operational report → PDF document model. Arranges the SAME OpsReport the in-app preview renders
 * (src/ui/report/OpsReportView.tsx) into printable blocks — it adds no figure of its own. Evidence
 * images are passed in by evidence id (browser: collectEvidenceImages); a missing one becomes an
 * explicit "Not available — reason" box. All strings are sanitised for the PDF standard fonts.
 * Every significant event is printed (the table continues across pages); the header note, footer
 * and provenance list follow the evidence the report actually includes (a frame of a configured
 * camera stream is labelled as a camera frame).
 */
import type { jsPDF as JsPDF } from 'jspdf';
import { BAND_NOTE, BAND_NOTE_LIVE_CAMERA, type PdfBlock, type PdfDocModel, type PdfImage, type PdfKpi, type PdfSection } from '../model';
import { renderPdf } from '../render';
import { sanitizeDeep } from '../text';
import { reportHasLiveCameraFrame } from './common';
import { BASIS_LABEL, cellText, type OpsReport, type ReportBlock, type ReportEvidenceItem, type ReportKpi } from './types';

export type OpsPdfContext = { images?: Record<string, PdfImage | null | undefined> };

const toneOf = (k: ReportKpi): PdfKpi['tone'] =>
  !k.status ? undefined : k.status.tone === 'good' ? 'good' : k.status.tone === 'critical' ? 'critical' : k.status.tone === 'warning' || k.status.tone === 'serious' ? 'warning' : 'neutral';

export const pdfKpi = (k: ReportKpi): PdfKpi => ({
  label: k.label,
  value: k.display,
  unit: k.unit,
  scope: k.scope,
  target: k.target,
  status: k.status?.label,
  tone: toneOf(k),
  unavailable: k.unavailable,
});

/** Why an evidence figure has no image in the PDF. */
const missingImage = (x: ReportEvidenceItem) =>
  x.reason ??
  (x.kind === 'camera-snapshot'
    ? x.provenance.origin === 'live-camera'
      ? 'The camera frame is no longer held in this browser session (images are kept in memory only)'
      : 'The rendered image is no longer held in this browser session (images are kept in memory only)'
    : 'The illustrative frame could not be rendered');

function blocks(b: ReportBlock, ctx: OpsPdfContext): PdfBlock[] {
  switch (b.kind) {
    case 'kpis':
      return [{ kind: 'kpis', items: b.items.map(pdfKpi) }, ...(b.note ? ([{ kind: 'text', text: b.note, tone: 'muted' }] as PdfBlock[]) : [])];
    case 'kv':
      return [b.rows.length >= 4 ? { kind: 'kv', rows: b.rows, columns: 4, labelW: 40 } : { kind: 'kv', rows: b.rows, columns: 2, labelW: 64 }];
    case 'table':
      return [{ kind: 'table', head: b.head, rows: b.rows.map((r) => r.map(cellText)), widths: b.widths, align: b.align, empty: b.empty, foot: b.foot }];
    case 'bars':
      return [{ kind: 'bars', title: b.title, unit: b.unit, rows: b.rows, empty: b.empty }];
    case 'chart': {
      const c = b.chart;
      const hasData = c.series.some((sr) => sr.values.some((v) => v != null));
      return [
        { kind: 'text', text: c.question, tone: 'muted' },
        hasData
          ? { kind: 'charts', columns: 1, items: [{ title: c.title, unit: c.unit, xLabels: c.labels, series: c.series, limit: c.limit }] }
          : { kind: 'missing', title: c.title, reason: 'No samples in the period yet — chart omitted' },
      ];
    }
    case 'text':
      return [{ kind: 'text', text: b.text, tone: b.tone }];
    case 'list':
      return [{ kind: 'list', items: b.items, numbered: b.numbered }];
    case 'subhead':
      return [{ kind: 'subhead', text: b.text }];
    case 'missing':
      return [{ kind: 'missing', title: b.title, reason: b.reason }];
    case 'total':
      return [{ kind: 'total', label: b.label, value: b.value, note: b.note }];
    case 'evidence':
      return [
        {
          kind: 'figures',
          columns: Math.min(4, Math.max(2, b.items.length)),
          items: b.items.map((x) => {
            const img = x.status === 'available' ? (ctx.images?.[x.evidenceId] ?? null) : null;
            return {
              title: x.title,
              image: img,
              missing: img ? undefined : missingImage(x),
              caption: x.caption,
              maxH: x.kind === 'camera-snapshot' ? 48 : 40,
            };
          }),
        },
      ];
    case 'events-link':
      // The PDF prints every event in the table; the link to the Events tab is an in-app action.
      return [];
  }
}

/** Arranges an OpsReport into numbered PDF sections, plus the legend and provenance section. */
export function opsPdfModel(r: OpsReport, ctx: OpsPdfContext = {}): PdfDocModel {
  const liveCamera = reportHasLiveCameraFrame(r.sections);
  const sections: PdfSection[] = r.sections.map((sec, i) => ({
    num: i + 1,
    title: sec.title,
    tag: sec.tag ?? (sec.basis ? BASIS_LABEL[sec.basis] : undefined),
    blocks: sec.blocks.flatMap((b) => blocks(b, ctx)),
  }));
  sections.push({
    num: sections.length + 1,
    title: 'How to read this report · data provenance',
    blocks: [
      { kind: 'table', head: ['Label', 'Meaning'], rows: r.legend.map((l) => [l.label, l.text]), widths: [38, 'auto'] },
      {
        kind: 'list',
        items: [
          liveCamera
            ? 'wAI Manufacturing Digital Twin — demonstration of a representative ceramic tile plant. No PLC, SCADA, MES, vision system, vehicle tracking or language model is connected; a camera frame in this report comes from a stream configured in this browser and is labelled as such.'
            : 'wAI Manufacturing Digital Twin — demonstration of a representative ceramic tile plant. No PLC, SCADA, MES, camera, vision system, vehicle tracking or language model is connected.',
          'KPIs use the same definitions and functions as the application, for the period and scope printed in the header.',
          'Financial figures are estimates from the stated, editable assumptions — not verified business losses or savings.',
        ],
      },
      { kind: 'text', text: `Report generated ${r.generatedAt} (wall clock) · ${r.generatedAtPlant}. Period ${r.period.text}. The in-app preview shows this same model.`, tone: 'muted' },
    ],
  });
  return sanitizeDeep<PdfDocModel>({
    docType: r.typeLabel,
    docId: `${r.scope.label} · ${r.period.label}`,
    title: r.title,
    lead: r.summary,
    facts: [`Period: ${r.period.text}`, `Scope: ${r.scope.label}`, `${r.events.length} significant event${r.events.length === 1 ? '' : 's'}`, 'Simulated data'],
    generatedAt: r.generatedAt,
    generatedAtPlant: r.generatedAtPlant,
    sections,
    fileName: r.fileName,
    disclaimer: r.disclaimer,
    bandNote: liveCamera ? BAND_NOTE_LIVE_CAMERA : BAND_NOTE,
  });
}

/** Draws an operational report into a fresh jsPDF document (works in node and the browser). */
export function renderOpsPdf(doc: JsPDF, autoTable: Parameters<typeof renderPdf>[1], r: OpsReport, ctx: OpsPdfContext = {}) {
  const model = opsPdfModel(r, ctx);
  renderPdf(doc, autoTable, model);
  return model;
}
