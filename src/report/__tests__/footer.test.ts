/**
 * The PDF footer and header note describe the provenance of the evidence the document shows: a frame
 * grabbed from a configured camera stream is never called a digital-twin render, and a document with
 * twin renders only keeps the twin wording. The stage shift summary (no camera images) claims nothing
 * about camera views.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { buildEventReport } from '../../intel/report';
import type { Evidence } from '../../model/types';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { attachEvidenceImage, evidenceOf } from '../../sim/events';
import { buildEventPdf, buildStageShiftPdf, type PdfLib } from '../build';
import { contentWidth } from '../layout';
import {
  BAND_NOTE,
  BAND_NOTE_LIVE_CAMERA,
  FOOTER_DISCLAIMER,
  FOOTER_DISCLAIMER_LIVE_CAMERA,
  STAGE_FOOTER_DISCLAIMER,
  eventPdfModel,
  footerDisclaimer,
  hasLiveCameraFrame,
  missingReason,
} from '../model';
import type { AutoTableFn } from '../render';
import { stageShiftModel } from '../stageShift';
import { pdfText } from '../text';

const lib: PdfLib = { jsPDF, autoTable: autoTable as unknown as AutoTableFn };
/** 1 × 1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** As recorded by the evidence capturer for a frame of a playing configured stream (ui/feeds/capture.ts). */
const LIVE = (cameraId: string): Evidence['provenance'] => ({ origin: 'live-camera', sourceId: cameraId, label: 'Frame from the configured camera stream' });

let s: SimState;
let liveId: string;
let twinId: string;

beforeAll(() => {
  s = createSim(51, 2 * 1440 + 240);
  s.liveFrom = s.minute;
  const t0 = s.minute;
  // Two conveyor stops with camera snapshots: one captured from a configured stream, one rendered from the twin.
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 30, label: 'Kiln infeed belt stop' });
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: t0 + 30, label: 'Packing belt stop' });
  advance(s, t0 + 10);
  const stops = s.events.filter((e) => e.type === 'conveyor-stop' && e.start >= t0 && evidenceOf(s, e).some((x) => x.kind === 'camera-snapshot'));
  expect(stops.length).toBeGreaterThanOrEqual(2);
  [liveId, twinId] = [stops[0].id, stops[1].id];
  const live = evidenceOf(s, stops[0]).find((x) => x.kind === 'camera-snapshot')!;
  attachEvidenceImage(s, live.id, { key: live.id, width: 1, height: 1, frameTime: s.minute }, LIVE(live.cameraId!));
  const twin = evidenceOf(s, stops[1]).find((x) => x.kind === 'camera-snapshot')!;
  attachEvidenceImage(s, twin.id, { key: twin.id, width: 1, height: 1, frameTime: s.minute });
});

const snapOf = (eventId: string) => evidenceOf(s, s.events.find((e) => e.id === eventId)!).find((x) => x.kind === 'camera-snapshot')!;

/** Footer lines as the renderer draws them (6.2 pt Helvetica, content width − 28 mm, at most 3 lines). */
function footerLines(doc: InstanceType<typeof jsPDF>, text: string) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.2);
  return doc.splitTextToSize(pdfText(text), contentWidth() - 28) as string[];
}
const pdfLiteral = (t: string) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

describe('PDF footer reflects the provenance of the camera evidence', () => {
  it('does not call a frame from a configured stream a digital-twin render', () => {
    const r = buildEventReport(s, liveId)!;
    expect(hasLiveCameraFrame(r.visualEvidence)).toBe(true);
    const m = eventPdfModel(r, { images: { [snapOf(liveId).id]: { dataUrl: PNG, width: 1, height: 1, format: 'PNG' } } });
    expect(m.disclaimer).toBe(pdfText(FOOTER_DISCLAIMER_LIVE_CAMERA));
    expect(m.disclaimer).not.toMatch(/Camera views are digital-twin renders/);
    expect(m.disclaimer).toMatch(/frame from a configured camera stream/);
    expect(m.bandNote).toBe(pdfText(BAND_NOTE_LIVE_CAMERA));
    expect(m.bandNote).not.toMatch(/no live plant data/);
    // The figure itself is captioned as a camera frame (unchanged behaviour).
    const fig = m.sections[3].blocks.find((b) => b.kind === 'figures');
    if (!fig || fig.kind !== 'figures') throw new Error('no figure block');
    expect(fig.items[0].caption[0]).toMatch(/^Camera frame/);
  });

  it('keeps the twin wording when the camera evidence is a twin render', () => {
    const r = buildEventReport(s, twinId)!;
    expect(hasLiveCameraFrame(r.visualEvidence)).toBe(false);
    const m = eventPdfModel(r);
    expect(m.disclaimer).toBe(pdfText(FOOTER_DISCLAIMER));
    expect(m.bandNote).toBe(pdfText(BAND_NOTE));
    expect(footerDisclaimer([])).toBe(FOOTER_DISCLAIMER);
  });

  it('prints the live-camera footer on every page, in full (no line cut off)', () => {
    const out = buildEventPdf(lib, s, liveId, { compress: false, imageUrls: { [snapOf(liveId).id]: PNG } })!;
    const raw = out.doc.output();
    const pages = out.doc.getNumberOfPages();
    const lines = footerLines(out.doc, out.model.disclaimer);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const l of lines) expect(raw.split(pdfLiteral(l)).length - 1).toBeGreaterThanOrEqual(pages);
    expect(raw).not.toContain('Camera views are digital-twin renders');
    expect(raw).not.toContain('no live plant data');
    expect(raw.split(pdfLiteral(pdfText(BAND_NOTE_LIVE_CAMERA))).length - 1).toBe(pages);
  });

  it('explains a missing live frame as a camera frame, not a rendered image', () => {
    const x = { ...snapOf(liveId), originLabel: 'Live camera' };
    expect(missingReason(x, false)).toMatch(/camera frame is no longer held/);
    expect(missingReason(x, false)).not.toMatch(/rendered/i);
    expect(missingReason({ ...snapOf(twinId), originLabel: 'Digital-twin render' }, false)).toMatch(/rendered image is no longer held/);
  });

  it('stage shift summary: no claim about camera views, and the figures are said not to come from cameras', () => {
    const m = stageShiftModel(s, 'KILN')!;
    expect(m.disclaimer).toBe(pdfText(STAGE_FOOTER_DISCLAIMER));
    expect(m.disclaimer).not.toMatch(/Camera views are digital-twin renders/);
    const prov = m.sections.find((x) => x.title === 'Data provenance & limitations')!;
    const text = JSON.stringify(prov.blocks);
    expect(text).not.toMatch(/camera is connected/);
    expect(text).toMatch(/no camera feeds these figures/);
    const out = buildStageShiftPdf(lib, s, 'KILN', { compress: false })!;
    const raw = out.doc.output();
    const lines = footerLines(out.doc, m.disclaimer);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const l of lines) expect(raw).toContain(pdfLiteral(l));
    expect(raw).toContain(pdfText(BAND_NOTE));
  });
});
