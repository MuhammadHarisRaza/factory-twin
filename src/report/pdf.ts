/**
 * PDF export of event reports and stage shift summaries.
 *
 * Both read the shared stores at click time and build from the same records the in-app views show:
 * the event PDF renders the SAME EventReport model as <EventReportView/> (src/intel/report.ts
 * buildEventReport, with the live financial assumptions and tariffs). The report is frozen when the
 * button is pressed, then the visual evidence is resolved (camera snapshot from the image store,
 * illustrative inspection frames), and the document is drawn and saved as wAI-event-<id>.pdf.
 * The export is logged on the event record (history + reports).
 */
import { buildEventReport } from '../intel/report';
import { MONITORED_STAGE_BY_ID } from '../model/plant';
import type { MonitoredStageId } from '../model/types';
import { useApp } from '../app/store';
import { useSim } from '../sim/store';
import { eventPdfFromReport, loadPdfLib, renderModel } from './build';
import { stageShiftModel } from './stageShift';
import { collectEvidenceImages } from './frames';
import { inspectionRecords } from './images';

/** Exports the event's report as a PDF download (resolves to the file name). Rejects with a readable message on failure. */
export async function exportEventPdf(eventId: string): Promise<string> {
  const s = useSim.getState().sim;
  const { finance, tariffs } = useApp.getState();
  const generatedAt = new Date().toISOString();
  const live = buildEventReport(s, eventId, { finance, tariffs, generatedAt });
  if (!live) throw new Error(`Event ${eventId} is not in the current demo state`);
  // Freeze the record as it is now: the simulation keeps running while images are prepared.
  const report = structuredClone(live);
  const inspections = structuredClone(inspectionRecords(s, report.visualEvidence));
  const [lib, imageUrls] = await Promise.all([loadPdfLib(), collectEvidenceImages(report.visualEvidence, inspections)]);
  const { doc, model } = eventPdfFromReport(lib, report, { imageUrls, inspections });
  doc.save(model.fileName);
  useSim.getState().reportExported(eventId);
  return model.fileName;
}

/** Exports the current-shift summary of a monitored stage as a PDF download (resolves to the file name). */
export async function exportStageShiftPdf(stageId: string): Promise<string> {
  if (!MONITORED_STAGE_BY_ID[stageId as MonitoredStageId]) throw new Error(`Unknown stage ${stageId}`);
  const s = useSim.getState().sim;
  const { finance, tariffs } = useApp.getState();
  // The model is plain, sanitised data built now — the state at the moment of the click.
  const model = stageShiftModel(s, stageId as MonitoredStageId, { finance, tariffs, generatedAt: new Date().toISOString() });
  if (!model) throw new Error(`Unknown stage ${stageId}`);
  const lib = await loadPdfLib();
  const { doc } = renderModel(lib, model);
  doc.save(model.fileName);
  return model.fileName;
}
