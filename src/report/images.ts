/**
 * Store-free evidence lookups shared by the in-app report, the PDF builder and the tests:
 * the stored twin render of a camera snapshot (src/twin/bridge.ts — never presented as a camera
 * image) and the inspection records behind inspection-image evidence. Drawing the frames needs a
 * browser: see frames.ts.
 */
import type { Evidence, QualityInspection } from '../model/types';
import type { SimState } from '../sim/engine';
import { getImage } from '../twin/bridge';

/** Stored twin render of a camera-snapshot evidence item (null when not captured / not held any more). */
export function snapshotImage(x: Evidence) {
  if (x.kind !== 'camera-snapshot' || x.status !== 'available' || !x.image) return null;
  return getImage(x.image.key);
}

/** Inspection record behind an inspection-image evidence item (null when no longer retained). */
export const inspectionRecord = (s: SimState, x: Evidence): QualityInspection | null =>
  x.inspectionId ? (s.inspections.find((r) => r.id === x.inspectionId) ?? null) : null;

/** Inspection records of a set of evidence items, by record id. */
export function inspectionRecords(s: SimState, evidence: Evidence[]): Record<string, QualityInspection> {
  const out: Record<string, QualityInspection> = {};
  for (const x of evidence) {
    if (x.kind !== 'inspection-image') continue;
    const r = inspectionRecord(s, x);
    if (r) out[r.id] = r;
  }
  return out;
}
