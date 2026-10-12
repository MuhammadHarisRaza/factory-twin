/**
 * Inspection-image rasteriser for reports and the PDF: draws the FrameArt still of a record (the
 * same illustration the Quality & Defects workspace shows) into an offscreen canvas and returns
 * a PNG data URL. Every image carries a caption band saying it is an illustrative frame of a
 * simulated record — it is never a camera image and no vision model produced it.
 *
 * Registered with src/twin/inspectionImage.ts when this module is imported (QualityPage imports it
 * for its side effect) and through initInspectionRasteriser() for callers that need it earlier.
 */
import { PRODUCTS } from '../../model/plant';
import type { QualityInspection } from '../../model/types';
import { useSim } from '../../sim/store';
import { registerInspectionRasteriser, type InspectionImageOpts } from '../../twin/inspectionImage';
import { frameForRecord } from './frames';
import { GAUGE_CAPTION, STILL_CAPTION, frameStillMarkup } from './still';

/** `crop`: square crop around the detection box (annotated or original). */
export type RasteriseOpts = InspectionImageOpts & { crop?: boolean };

const CACHE_MAX = 48;
const cache = new Map<string, string>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Inspection frame could not be drawn'));
    img.src = src;
  });
}

/** Caption band (bottom of the image): what this is, and which record. */
function caption(g: CanvasRenderingContext2D, size: number, rec: QualityInspection, what: string) {
  const pad = Math.max(4, Math.round(size * 0.022));
  const avail = size - 2 * pad;
  let fs = Math.max(8, Math.round(size * 0.032));
  const font = (n: number) => `500 ${n}px "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif`;
  // Tunnel records carry a simulated classification; gauge records a simulated measurement.
  const head = rec.stationId === 'ST-VIS' ? STILL_CAPTION : GAUGE_CAPTION;
  g.font = font(fs);
  while (fs > 8 && g.measureText(head).width > avail) g.font = font(--fs);
  const detail = `${rec.id} · ${what} · simulated record`;
  const lines = g.measureText(head).width <= avail ? [head, detail] : [head.split(' — ')[0], 'no vision model', detail];
  const lh = Math.round(fs * 1.32);
  const bandH = lines.length * lh + pad;
  g.fillStyle = 'rgba(10, 13, 15, 0.84)';
  g.fillRect(0, size - bandH, size, bandH);
  g.textBaseline = 'top';
  lines.forEach((t, i) => {
    g.fillStyle = i < lines.length - 1 ? '#fab219' : '#a9b3bc';
    g.fillText(t, pad, size - bandH + pad / 2 + i * lh, avail);
  });
}

/**
 * PNG data URL of a record's illustrative frame, or null (lab samples have no frame; no DOM).
 * Same record and options → same image (deterministic drawing; cached).
 */
export async function rasteriseInspection(rec: QualityInspection, opts: RasteriseOpts): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const sim = useSim.getState().sim;
  const sku = sim.batches.find((b) => b.id === rec.batchId)?.sku ?? PRODUCTS[0].sku;
  const frame = frameForRecord(rec, sku);
  if (!frame) return null;
  const size = Math.max(64, Math.round(opts.size ?? 320));
  const crop = !!opts.crop && !!rec.box;
  const key = [rec.id, rec.time, rec.defect, rec.batchId, sku, opts.annotated ? 'a' : 'o', crop ? 'c' : 'f', size].join('|');
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const markup = await frameStillMarkup(frame, { annotated: opts.annotated, crop, size });
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0, size, size);
    caption(g, size, rec, `${opts.annotated ? 'annotated' : 'original'}${crop ? ' crop' : ''}`);
    const url = c.toDataURL('image/png');
    cache.set(key, url);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return url;
  } catch {
    return null;
  }
}

/** Registers the rasteriser with the shared inspection-image bridge (idempotent). */
export function initInspectionRasteriser() {
  registerInspectionRasteriser(rasteriseInspection);
}

initInspectionRasteriser();
