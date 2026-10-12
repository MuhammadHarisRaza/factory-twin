/**
 * Illustrative inspection frames of simulated records (pure derivations, no React).
 *
 * A frame is the drawing of a reject record from the optical tunnel (ST-VIS) or the planarity /
 * caliper gauge (ST-GAUGE): the procedural tile of the batch product with the recorded defect, and
 * the record's simulated box. Nothing here is camera data — records, boxes and confidences come
 * from the simulation. Lab samples (ST-QC) have no frame.
 */
import { DEFECTS, PRODUCTS } from '../../model/plant';
import type { QualityInspection, ScenarioActivation } from '../../model/types';
import type { SimState } from '../../sim/engine';

export type FrameStation = 'ST-VIS' | 'ST-GAUGE';

export type Frame = {
  id: string;
  kind: 'reject' | 'pass';
  time: number;
  stationId: FrameStation;
  batchId: string;
  sku: string;
  /** The inspection record the frame illustrates. */
  rec: QualityInspection | null;
};

/** Inspected tiles belong to the batch pressed ~3 h earlier (same rule as the engine's batchAt(t − 180)). */
export const BATCH_LAG_MIN = 180;

export const isFrameStation = (id: string): id is FrameStation => id === 'ST-VIS' || id === 'ST-GAUGE';

export const skuOf = (s: SimState, batchId: string) => s.batches.find((b) => b.id === batchId)?.sku ?? PRODUCTS[0].sku;

/** The illustrative frame of a tunnel / gauge record (null for lab samples, which have no frame). */
export function frameForRecord(r: QualityInspection, sku: string): Frame | null {
  if (!isFrameStation(r.stationId)) return null;
  return { id: r.id, kind: r.result, time: r.time, stationId: r.stationId, batchId: r.batchId, sku, rec: r };
}

/** Frame of a retained record by id (null when it is not retained or has no frame). */
export function frameById(s: SimState, id: string): Frame | null {
  for (let i = s.inspections.length - 1; i >= 0; i--) {
    const r = s.inspections[i];
    if (r.id === id) return frameForRecord(r, skuOf(s, r.batchId));
  }
  return null;
}

const covers = (sc: ScenarioActivation, t: number) => sc.start <= t && (sc.end == null || sc.end > t);

/**
 * The quality-deterioration scenario that raised this reject, if any: active at the
 * record's time and targeting the stage the defect originates from.
 */
export function affectingScenario(s: SimState, rec: Pick<QualityInspection, 'time' | 'result' | 'defect'> | null): ScenarioActivation | null {
  if (!rec || rec.result !== 'reject' || !rec.defect) return null;
  const origin = DEFECTS[rec.defect].origin;
  return s.scenarios.find((sc) => sc.kind === 'quality-deterioration' && covers(sc, rec.time) && (!sc.stage || sc.stage === origin)) ?? null;
}

/** The quality-deterioration scenario running now, if any. */
export const activeQualityScenario = (s: SimState): ScenarioActivation | null =>
  s.scenarios.find((sc) => sc.kind === 'quality-deterioration' && covers(sc, s.minute)) ?? null;
