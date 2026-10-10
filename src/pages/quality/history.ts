/**
 * Inputs of the inspection-record table, kept identity-stable between simulated minutes.
 *
 * The page recomputes its data on every simulated minute (up to five times a second at 300×), which
 * builds new record lists and maps even when no record, scenario link or event link changed. The
 * table is memoised on these inputs, so `keepUnchanged` hands back the previous objects while their
 * content is the same: the 500-row table then renders only when a record arrives, leaves the
 * period, or its scenario / event links change.
 */
import { useState } from 'react';
import type { QualityInspection, ScenarioActivation } from '../../model/types';
import type { SimState } from '../../sim/engine';
import type { Period } from '../../sim/metrics';
import { affectingScenario } from './frames';

export type HistoryInputs = {
  /** Records of the period, newest first. */
  records: QualityInspection[];
  /** Record id → the quality-deterioration scenario that raised it. */
  affected: Map<string, ScenarioActivation>;
  /** Record id → ids of the quality events that reference it (see inspectionEventLinks). */
  links: Map<string, string[]>;
};

/** Inspection records of the period (from ≤ time < to), newest first. */
export function periodRecords(s: SimState, p: Pick<Period, 'from' | 'to'>): QualityInspection[] {
  const out: QualityInspection[] = [];
  for (let i = s.inspections.length - 1; i >= 0; i--) {
    const r = s.inspections[i];
    if (r.time >= p.from && r.time < p.to) out.push(r);
  }
  return out;
}

/** Records raised by a quality-deterioration scenario (defect origin = scenario stage). */
export function scenarioAffected(s: SimState, records: readonly QualityInspection[]): Map<string, ScenarioActivation> {
  const out = new Map<string, ScenarioActivation>();
  for (const r of records) {
    const sc = affectingScenario(s, r);
    if (sc) out.set(r.id, sc);
  }
  return out;
}

/** Same items in the same order (records are immutable once stored, so identity is content). */
export const sameList = <T>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

export function sameMap<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>, eq: (x: V, y: V) => boolean = Object.is) {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!b.has(k) || !eq(v, b.get(k)!)) return false;
  }
  return true;
}

/** `next`, reusing every part of `prev` whose content did not change (and `prev` itself if nothing did). */
export function keepUnchanged(prev: HistoryInputs, next: HistoryInputs): HistoryInputs {
  const records = sameList(prev.records, next.records) ? prev.records : next.records;
  const affected = sameMap(prev.affected, next.affected) ? prev.affected : next.affected;
  const links = sameMap(prev.links, next.links, sameList) ? prev.links : next.links;
  return records === prev.records && affected === prev.affected && links === prev.links ? prev : { records, affected, links };
}

/**
 * `value`, but keeping the identity of the previously returned value as far as `merge` allows
 * (React's "adjust state while rendering" pattern: no effect, no extra commit).
 */
export function useStable<T>(value: T, merge: (prev: T, next: T) => T): T {
  const [kept, setKept] = useState(value);
  if (kept === value) return kept;
  const merged = merge(kept, value);
  if (merged !== kept) setKept(merged);
  return merged;
}
