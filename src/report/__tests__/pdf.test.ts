/**
 * Report → PDF: the PDF model is built from the same EventReport the in-app view renders, every
 * section of the spec appears in order, missing evidence is explained, every string is WinAnsi-safe,
 * and real documents are produced in node with jsPDF + autoTable.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { buildEventReport } from '../../intel/report';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { attachEvidenceImage, evidenceOf } from '../../sim/events';
import { resolvePeriod } from '../../sim/metrics';
import { clearImages, putImage } from '../../twin/bridge';
import { buildEventPdf, buildStageShiftPdf, pdfImage, type PdfLib } from '../build';
import { LABELS } from '../format';
import { EVENT_SECTION_TITLES, eventPdfModel, type PdfDocModel } from '../model';
import type { AutoTableFn } from '../render';
import { stageEvents, stageShiftModel } from '../stageShift';
import { isWinAnsiSafe } from '../text';

const lib: PdfLib = { jsPDF, autoTable: autoTable as unknown as AutoTableFn };
/** 1 × 1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Every string anywhere in the model (image data excluded). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'dataUrl') strings(x, out);
  return out;
}

let s: SimState;
let convId: string;

beforeAll(() => {
  s = createSim(51, 2 * 1440 + 240);
  s.liveFrom = s.minute;
  const t0 = s.minute;
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 40, label: 'Kiln infeed belt stop' });
  advance(s, t0 + 20);
  convId = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-KIN' && e.start >= t0)!.id;
});

const snapshotOf = (id: string) => evidenceOf(s, s.events.find((e) => e.id === id)!).find((x) => x.kind === 'camera-snapshot')!;

describe('event report → PDF section model', () => {
  it('has all 12 sections of the report, in order, from the same record', () => {
    const r = buildEventReport(s, convId, { generatedAt: '2026-10-11T08:00:00.000Z' })!;
    const m = eventPdfModel(r);
    expect(m.sections.map((x) => x.title)).toEqual([...EVENT_SECTION_TITLES]);
    expect(m.sections.map((x) => x.num)).toEqual(EVENT_SECTION_TITLES.map((_, i) => i + 1));
    expect(m.docId).toBe(convId);
    expect(m.docType).toBe('Event report');
    expect(m.fileName).toBe(`wAI-event-${convId}.pdf`);
    expect(m.title).toBe(r.summary.title.replace(/[—–]/g, '-'));
    expect(JSON.stringify(m.sections[0])).toContain(convId);
    expect(m.sections[7].tag).toBe(LABELS.estimate);
  });

  it('explains missing visual evidence instead of leaving a blank', () => {
    const m = eventPdfModel(buildEventReport(s, convId)!);
    const vis = m.sections[3];
    const fig = vis.blocks.find((b) => b.kind === 'figures');
    if (!fig || fig.kind !== 'figures') throw new Error('no figure block');
    expect(fig.items[0].image).toBeNull();
    // The live snapshot is still pending (no twin renderer in node) → "being captured".
    expect(fig.items[0].missing).toMatch(/Being captured/);
    expect(fig.items[0].caption.join(' ')).toMatch(/rendered from the digital twin/i);
    // No NVR → explicit video box.
    expect(vis.blocks.some((b) => b.kind === 'missing' && /Video segment/.test(b.title))).toBe(true);
  });

  it('draws the series of the supporting evidence as charts with their limits', () => {
    const m = eventPdfModel(buildEventReport(s, convId)!);
    const charts = m.sections[4].blocks.filter((b) => b.kind === 'charts');
    expect(charts.length).toBeGreaterThan(0);
    const c = charts[0].kind === 'charts' ? charts[0].items[0] : null;
    expect(c?.series[0].values.length).toBe(c?.xLabels.length);
    expect(c?.limit?.value).toBeGreaterThan(0);
    // State transitions become a table.
    expect(m.sections[4].blocks.some((b) => b.kind === 'table' && b.head[0] === 'Time')).toBe(true);
  });

  it('shows the detection-time measurements once, under operational context', () => {
    const r = buildEventReport(s, convId)!;
    const m = eventPdfModel(r);
    const ctxTitle = r.supportingEvidence.find((x) => x.kind === 'metrics')!.title;
    expect(m.sections[4].blocks.some((b) => b.kind === 'subhead' && b.text === ctxTitle)).toBe(false);
    expect(m.sections[5].blocks.some((b) => b.kind === 'subhead' && b.text.includes(ctxTitle))).toBe(true);
  });

  it('only contains text the standard fonts can draw, for every recent event of the state', () => {
    const bad: string[] = [];
    for (const ev of s.events.slice(-80)) {
      const m: PdfDocModel = eventPdfModel(buildEventReport(s, ev.id)!);
      for (const t of strings(m)) if (!isWinAnsiSafe(t)) bad.push(`${ev.id}: ${t}`);
    }
    expect(bad).toEqual([]);
  });

  it('uses an attached snapshot image', () => {
    const snap = snapshotOf(convId);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const img = pdfImage(doc, PNG);
    expect(img).toMatchObject({ width: 1, height: 1, format: 'PNG' });
    expect(pdfImage(doc, 'data:text/plain;base64,AAAA')).toBeNull();
    expect(pdfImage(doc, null)).toBeNull();
    attachEvidenceImage(s, snap.id, { key: snap.id, width: 1, height: 1, frameTime: s.minute - 1 });
    putImage(snap.id, { dataUrl: PNG, width: 1, height: 1 });
    const m = eventPdfModel(buildEventReport(s, convId)!, { images: { [snap.id]: img } });
    const fig = m.sections[3].blocks.find((b) => b.kind === 'figures');
    if (!fig || fig.kind !== 'figures') throw new Error('no figure block');
    expect(fig.items[0].image?.format).toBe('PNG');
    expect(fig.items[0].missing).toBeUndefined();
    clearImages();
  });
});

describe('PDF documents in node', () => {
  it('builds the event PDF of a real event: pages, id, marker, page numbers, image', () => {
    const snap = snapshotOf(convId);
    const out = buildEventPdf(lib, s, convId, { compress: false, imageUrls: { [snap.id]: PNG } })!;
    const pages = out.doc.getNumberOfPages();
    expect(pages).toBeGreaterThan(0);
    const raw = out.doc.output();
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).toContain(convId);
    expect(raw.split('SIMULATED DATA').length - 1).toBeGreaterThanOrEqual(pages);
    expect(raw).toContain(`Page 1 of ${pages}`);
    expect(raw).toContain(`Page ${pages} of ${pages}`);
    expect(raw).toContain('/Subtype /Image');
    expect(out.report.summary.id).toBe(convId);
  });

  it('builds the PDF of a historical event with an explained missing snapshot', () => {
    const hist = s.events.find((e) => e.historical && e.category === 'production')!;
    const out = buildEventPdf(lib, s, hist.id, { compress: false })!;
    expect(out.doc.getNumberOfPages()).toBeGreaterThan(0);
    const raw = out.doc.output();
    expect(raw).toContain(hist.id);
    expect(raw).toContain('Not available - ');
    expect(buildEventPdf(lib, s, 'EV-99999')).toBeNull();
  });

  it('paginates a long record and repeats table headers', () => {
    const ev = s.events.find((e) => e.id === convId)!;
    for (let i = 0; i < 90; i++)
      ev.notes.push({ t: s.minute, by: 'Test', text: `Note ${i} — a long note that wraps over more than one line in the notes table of the report to force page breaks` });
    const out = buildEventPdf(lib, s, convId, { compress: false })!;
    const raw = out.doc.output();
    expect(out.doc.getNumberOfPages()).toBeGreaterThan(3);
    // The notes table header ("Time | By | Note") is drawn again on each page the table spans.
    expect(raw.split('(Note) Tj').length - 1).toBeGreaterThan(1);
    ev.notes.splice(0);
  });

  it('builds the stage shift summary of a monitored stage', () => {
    const p = resolvePeriod('shift', s.minute);
    const events = stageEvents(s, 'KILN', p);
    const model = stageShiftModel(s, 'KILN')!;
    expect(model.sections.map((x) => x.title)).toEqual(['Summary', 'Stage input / output', 'Equipment states', 'Events in the shift', 'Losses', 'Data provenance & limitations']);
    for (const t of strings(model)) expect(isWinAnsiSafe(t)).toBe(true);
    const out = buildStageShiftPdf(lib, s, 'KILN', { compress: false })!;
    const raw = out.doc.output();
    expect(out.doc.getNumberOfPages()).toBeGreaterThan(0);
    expect(raw).toContain('Stage shift summary');
    for (const e of events.slice(0, 5)) expect(raw).toContain(e.id);
    expect(buildStageShiftPdf(lib, s, 'WH')).not.toBeNull();
  });
});
