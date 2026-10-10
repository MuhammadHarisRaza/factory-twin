/**
 * Raster image of an inspection record's illustrative frame (for reports and the PDF).
 *
 * The Quality workspace owns the frame drawing (src/pages/quality/FrameArt.tsx) and registers a
 * rasteriser here; until it does, a plain placeholder is drawn so callers always get an image or
 * null. Frames are illustrations of simulated records — never camera images.
 */
import type { QualityInspection } from '../model/types';

export type InspectionImageOpts = { annotated: boolean; size?: number };
export type InspectionRasteriser = (rec: QualityInspection, opts: InspectionImageOpts) => Promise<string | null>;

let rasteriser: InspectionRasteriser | null = null;

export function registerInspectionRasteriser(r: InspectionRasteriser) {
  rasteriser = r;
}

/** PNG data URL of the record's frame (annotated = with the defect box and label), or null. */
export async function renderInspectionImage(rec: QualityInspection, opts: InspectionImageOpts): Promise<string | null> {
  if (rasteriser) return rasteriser(rec, opts);
  if (typeof document === 'undefined') return null;
  const size = opts.size ?? 320;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#d8cfc0';
  g.fillRect(0, 0, size, size);
  if (opts.annotated && rec.box) {
    g.strokeStyle = '#e05252';
    g.lineWidth = 3;
    g.strokeRect(rec.box.x * size, rec.box.y * size, rec.box.w * size, rec.box.h * size);
  }
  g.fillStyle = '#333';
  g.font = '14px sans-serif';
  g.fillText(`${rec.id} · illustrative`, 10, size - 12);
  return c.toDataURL('image/png');
}
