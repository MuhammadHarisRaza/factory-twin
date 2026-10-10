/**
 * Builds PDF documents from the shared report models without touching the UI stores, so the same
 * code runs in the browser (pdf.ts) and in node (tests): jsPDF + jspdf-autotable are passed in.
 *
 *   EventReport (src/intel/report.ts)  →  eventPdfModel (model.ts)  →  renderPdf (render.ts)
 *   SimState + stage                   →  stageShiftModel (stageShift.ts) → renderPdf
 */
import type { jsPDF as JsPDF, jsPDFOptions } from 'jspdf';
import { buildEventReport, type EventReport } from '../intel/report';
import type { MonitoredStageId, QualityInspection } from '../model/types';
import type { SimState } from '../sim/engine';
import type { Tariffs } from '../sim/energy';
import type { FinanceAssumptions } from '../sim/finance';
import { inspectionRecords } from './images';
import { eventPdfModel, imageFormat, type PdfDocModel, type PdfImage } from './model';
import { renderPdf, type AutoTableFn } from './render';
import { stageShiftModel } from './stageShift';

export type PdfLib = { jsPDF: new (options?: jsPDFOptions) => JsPDF; autoTable: AutoTableFn };

/** Loads jsPDF and autoTable on demand (kept out of the main bundle). */
export async function loadPdfLib(): Promise<PdfLib> {
  const [{ jsPDF }, at] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  return { jsPDF, autoTable: (at.autoTable ?? at.default) as unknown as AutoTableFn };
}

/** A fresh A4 portrait document in millimetres. */
export const newDoc = (lib: PdfLib, compress = true) => new lib.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress });

/** Reads an image data URL's pixel size; null when jsPDF cannot decode it (the report then shows why). */
export function pdfImage(doc: JsPDF, dataUrl: string | null | undefined): PdfImage | null {
  if (!dataUrl || !/^data:image\/(png|jpe?g);base64,/i.test(dataUrl)) return null;
  try {
    const p = doc.getImageProperties(dataUrl);
    if (!(p.width > 0 && p.height > 0)) return null;
    return { dataUrl, width: p.width, height: p.height, format: imageFormat(dataUrl) };
  } catch {
    return null;
  }
}

export type EventPdfInput = {
  /** Image data URLs of the visual evidence by evidence id (see images.ts collectEvidenceImages). */
  imageUrls?: Record<string, string | null | undefined>;
  /** Inspection records of the inspection-image evidence by record id. */
  inspections?: Record<string, QualityInspection>;
  compress?: boolean;
};

export type BuiltPdf = { doc: JsPDF; model: PdfDocModel };

/** Renders an already-built EventReport (the in-app model) into a PDF. */
export function eventPdfFromReport(lib: PdfLib, report: EventReport, input: EventPdfInput = {}): BuiltPdf {
  const doc = newDoc(lib, input.compress ?? true);
  const images: Record<string, PdfImage | null> = {};
  for (const [id, url] of Object.entries(input.imageUrls ?? {})) images[id] = pdfImage(doc, url);
  const model = eventPdfModel(report, { images, inspections: input.inspections });
  renderPdf(doc, lib.autoTable, model);
  return { doc, model };
}

/** Builds the report from the state and renders it (null when the event does not exist). */
export function buildEventPdf(
  lib: PdfLib,
  s: SimState,
  eventId: string,
  opts: { finance?: FinanceAssumptions; tariffs?: Tariffs; generatedAt?: string } & EventPdfInput = {},
): (BuiltPdf & { report: EventReport }) | null {
  const report = buildEventReport(s, eventId, opts);
  if (!report) return null;
  const inspections = opts.inspections ?? inspectionRecords(s, report.visualEvidence);
  return { ...eventPdfFromReport(lib, report, { ...opts, inspections }), report };
}

/** Draws a finished document model (its strings are already sanitised and frozen). */
export function renderModel(lib: PdfLib, model: PdfDocModel, compress = true): BuiltPdf {
  const doc = newDoc(lib, compress);
  renderPdf(doc, lib.autoTable, model);
  return { doc, model };
}

/** Shift summary of a monitored stage (null for an unknown stage). */
export function buildStageShiftPdf(
  lib: PdfLib,
  s: SimState,
  stageId: MonitoredStageId,
  opts: { finance?: FinanceAssumptions; tariffs?: Tariffs; generatedAt?: string; compress?: boolean } = {},
): BuiltPdf | null {
  const model = stageShiftModel(s, stageId, opts);
  return model ? renderModel(lib, model, opts.compress ?? true) : null;
}
