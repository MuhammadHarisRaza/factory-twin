/**
 * Inspection-frame images for the in-app report and the PDF (browser only): the Quality workspace's
 * illustrative still of the record (src/pages/quality/rasterise.ts, registered with
 * src/twin/inspectionImage.ts), annotated with the defect box and captioned as an illustration of a
 * simulated record. Camera snapshots come from the twin image store (images.ts).
 */
import type { Evidence, QualityInspection } from '../model/types';
import { initInspectionRasteriser } from '../pages/quality/rasterise';
import { renderInspectionImage } from '../twin/inspectionImage';
import { snapshotImage } from './images';

/** PNG data URL of an inspection record's annotated illustrative frame, or null. */
export async function inspectionImage(rec: QualityInspection, size = 320): Promise<string | null> {
  initInspectionRasteriser(); // idempotent: makes sure the real illustration is used, not the bridge fallback
  try {
    return await renderInspectionImage(rec, { annotated: true, size });
  } catch {
    return null;
  }
}

/**
 * Image data URLs of an event's visual evidence, by evidence id (null = no image; the report then
 * explains why). Snapshots are read from the image store; inspection frames are drawn.
 */
export async function collectEvidenceImages(
  evidence: Evidence[],
  records: Record<string, QualityInspection>,
  frameSize = 360,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  await Promise.all(
    evidence.map(async (x) => {
      if (x.kind === 'camera-snapshot') out[x.id] = snapshotImage(x)?.dataUrl ?? null;
      else if (x.kind === 'inspection-image') {
        const rec = x.inspectionId ? records[x.inspectionId] : undefined;
        out[x.id] = x.status === 'available' && rec ? await inspectionImage(rec, frameSize) : null;
      }
    }),
  );
  return out;
}
