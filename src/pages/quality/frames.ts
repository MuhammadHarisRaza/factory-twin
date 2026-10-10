/**
 * Inspection frame feed for the vision station view (pure derivations, no React).
 *
 * A frame is either a reject record from the optical tunnel (ST-VIS) or the planarity /
 * caliper gauge (ST-GAUGE), or a *sampled pass frame*: a deterministic pseudo-frame of a
 * tile that passed, shown between reject records so the feed reads like an inspection
 * stream. Every tile passes the tunnel; pass frames are only a display sample. Nothing
 * here is camera data — records, boxes and confidences come from the simulation.
 */
import { DEFECTS, PRODUCTS } from '../../model/plant';
import type { DefectCategory, DowntimeEvent, ProductionBatch, QualityInspection, ScenarioActivation } from '../../model/types';
import { batchAt, type SimState } from '../../sim/engine';
import { qualityIn } from '../../sim/metrics';
import { noise01 } from '../../sim/rng';

export type FrameStation = 'ST-VIS' | 'ST-GAUGE';
export type FeedMode = 'all' | 'rejects';

export type Frame = {
  id: string;
  kind: 'reject' | 'pass';
  time: number;
  stationId: FrameStation;
  batchId: string;
  sku: string;
  /** The inspection record behind a reject frame; null for sampled pass frames. */
  rec: QualityInspection | null;
};

const PASS_PREFIX = 'PF-';
/** Share of production minutes on which a pass frame is sampled for display. */
const PASS_SAMPLE = 0.42;
/** Inspected tiles belong to the batch pressed ~3 h earlier (same rule as the engine). */
const BATCH_LAG_MIN = 180;

export const isFrameStation = (id: string): id is FrameStation => id === 'ST-VIS' || id === 'ST-GAUGE';
export const isPassFrameId = (id: string) => id.startsWith(PASS_PREFIX);

/** Index of the first record with time >= t (records are appended in time order). */
function lowerBound(recs: QualityInspection[], t: number) {
  let lo = 0;
  let hi = recs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (recs[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const sorterStops = (s: SimState): DowntimeEvent[] => s.downtime.filter((d) => d.equipmentId === 'I-SORT');

/** Was the sorter inspecting tiles in minute t? (no open stop / starved spell, tiles counted that hour) */
function inspecting(s: SimState, t: number, stops: DowntimeEvent[]) {
  if ((s.quality.get(Math.floor(t / 60))?.['ST-VIS']?.inspected ?? 0) <= 0) return false;
  for (const d of stops) if (d.start <= t && (d.end ?? Infinity) > t) return false;
  return true;
}

const isPassSample = (s: SimState, t: number, stops: DowntimeEvent[]) =>
  Number.isInteger(t) && t >= 0 && t < s.minute && noise01(s.seed, 'vision-pass-frame', t) < PASS_SAMPLE && inspecting(s, t, stops);

const skuOf = (s: SimState, batchId: string) => s.batches.find((b) => b.id === batchId)?.sku ?? PRODUCTS[0].sku;

function passFrame(s: SimState, t: number): Frame {
  const b = batchAt(s, t - BATCH_LAG_MIN);
  return { id: `${PASS_PREFIX}${t}`, kind: 'pass', time: t, stationId: 'ST-VIS', batchId: b.id, sku: b.sku, rec: null };
}

function recordFrame(s: SimState, r: QualityInspection & { stationId: FrameStation }): Frame {
  return frameForRecord(r, skuOf(s, r.batchId))!;
}

/** The illustrative frame of a tunnel / gauge record (null for lab samples, which have no frame). */
export function frameForRecord(r: QualityInspection, sku: string): Frame | null {
  if (!isFrameStation(r.stationId)) return null;
  return { id: r.id, kind: r.result, time: r.time, stationId: r.stationId, batchId: r.batchId, sku, rec: r };
}

const idNum = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1)) || 0;

/** Chronological order; pass frames sort before records of the same minute. */
export function compareFrames(a: Frame, b: Frame) {
  return a.time - b.time || (a.kind === b.kind ? 0 : a.kind === 'pass' ? -1 : 1) || idNum(a.id) - idNum(b.id);
}

/** Frames with time in [from, to), oldest first. */
export function framesIn(s: SimState, from: number, to: number, mode: FeedMode): Frame[] {
  const out: Frame[] = [];
  const recs = s.inspections;
  for (let i = lowerBound(recs, from); i < recs.length && recs[i].time < to; i++) {
    const r = recs[i];
    if (isFrameStation(r.stationId) && (mode === 'all' || r.result === 'reject')) out.push(recordFrame(s, r as QualityInspection & { stationId: FrameStation }));
  }
  if (mode === 'all') {
    const stops = sorterStops(s);
    for (let t = Math.max(0, from); t < Math.min(to, s.minute); t++) if (isPassSample(s, t, stops)) out.push(passFrame(s, t));
  }
  return out.sort(compareFrames);
}

/** The latest n frames up to the current minute, oldest first. */
export function latestFrames(s: SimState, n: number, mode: FeedMode): Frame[] {
  let w = 60;
  let frames: Frame[] = [];
  for (;;) {
    frames = framesIn(s, s.minute - w, s.minute, mode);
    if (frames.length >= n || w >= 7 * 1440) break;
    w *= 2;
  }
  return frames.slice(-n);
}

/** Resolve a frame id (record id or sampled pass-frame id). Null if it is not a frame. */
export function frameById(s: SimState, id: string): Frame | null {
  if (isPassFrameId(id)) {
    const t = Number(id.slice(PASS_PREFIX.length));
    return isPassSample(s, t, sorterStops(s)) ? passFrame(s, t) : null;
  }
  for (let i = s.inspections.length - 1; i >= 0; i--) {
    const r = s.inspections[i];
    if (r.id === id) return isFrameStation(r.stationId) ? recordFrame(s, r as QualityInspection & { stationId: FrameStation }) : null;
  }
  return null;
}

/** The frame the vision viewer shows: the pinned one, else the latest of the feed. */
export function viewerFrame(s: SimState, selected: string | null, n: number, mode: FeedMode): Frame | null {
  const pinned = selected ? frameById(s, selected) : null;
  if (pinned) return pinned;
  const feed = latestFrames(s, n, mode);
  return feed[feed.length - 1] ?? null;
}

/** Previous (dir −1) or next (dir +1) frame in the feed order; null at either end. */
export function neighbourFrame(s: SimState, frame: Frame, dir: -1 | 1, mode: FeedMode): Frame | null {
  for (const w of [30, 120, 480, 1440, 10080]) {
    const list = framesIn(s, frame.time - w, frame.time + w + 1, mode);
    if (dir > 0) {
      const f = list.find((x) => compareFrames(x, frame) > 0);
      if (f) return f;
      if (frame.time + w + 1 >= s.minute) return null;
    } else {
      for (let i = list.length - 1; i >= 0; i--) if (compareFrames(list[i], frame) < 0) return list[i];
      if (frame.time - w <= 0) return null;
    }
  }
  return null;
}

// ── Scenario attribution ──────────────────────────────────────────────────────

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

export type ScenarioBatch = { batchId: string; sku: string; records: number; tiles: number; last: number };

export type QualityScenarioImpact = {
  scenario: ScenarioActivation;
  /** Reject records raised by the scenario's defect categories since it started. */
  records: number;
  tiles: number;
  byDefect: Partial<Record<DefectCategory, number>>;
  /** Affected batches, most recently rejected first. */
  batches: ScenarioBatch[];
  /** The batch to show prominently: the one being rejected now (or now at inspection). */
  focus: { batch: ProductionBatch; records: number; tiles: number };
  /** Rejected tiles (all defects) since the hour the scenario started, and the no-scenario baseline. */
  windowFrom: number;
  rejected: number;
  baselineRejected: number | null;
};

/** Impact of each active quality-deterioration scenario on inspection records and batches. */
export function qualityScenarioImpacts(s: SimState, baseline: SimState | null): QualityScenarioImpact[] {
  const active = s.scenarios.filter((sc) => sc.kind === 'quality-deterioration' && covers(sc, s.minute));
  return active.map((sc) => {
    const byBatch = new Map<string, ScenarioBatch>();
    const byDefect: Partial<Record<DefectCategory, number>> = {};
    let records = 0;
    let tiles = 0;
    const recs = s.inspections;
    for (let i = lowerBound(recs, sc.start); i < recs.length; i++) {
      const r = recs[i];
      if (affectingScenario(s, r)?.id !== sc.id) continue;
      records++;
      tiles += r.tiles;
      byDefect[r.defect!] = (byDefect[r.defect!] ?? 0) + r.tiles;
      const b = byBatch.get(r.batchId) ?? { batchId: r.batchId, sku: skuOf(s, r.batchId), records: 0, tiles: 0, last: r.time };
      b.records++;
      b.tiles += r.tiles;
      b.last = Math.max(b.last, r.time);
      byBatch.set(r.batchId, b);
    }
    const batches = [...byBatch.values()].sort((a, b) => b.last - a.last);
    const focusId = batches[0]?.batchId ?? batchAt(s, s.minute - 1 - BATCH_LAG_MIN).id;
    const focusBatch = s.batches.find((b) => b.id === focusId) ?? batchAt(s, s.minute - 1 - BATCH_LAG_MIN);
    const fb = byBatch.get(focusBatch.id);
    const windowFrom = Math.floor(sc.start / 60) * 60;
    const p = { from: windowFrom, to: s.minute, label: '' };
    const rejected = qualityIn(s, p).rejected;
    const baselineRejected = baseline && baseline.minute === s.minute ? qualityIn(baseline, p).rejected : null;
    return {
      scenario: sc,
      records,
      tiles,
      byDefect,
      batches,
      focus: { batch: focusBatch, records: fb?.records ?? 0, tiles: fb?.tiles ?? 0 },
      windowFrom,
      rejected,
      baselineRejected,
    };
  });
}

// ── Frame context (detail panel) ─────────────────────────────────────────────

export type FrameContext = {
  scenario: ScenarioActivation | null;
  batch: ProductionBatch | null;
  /** All reject records of the frame's batch (any station). */
  batchRejectTiles: number;
  batchTopDefect: DefectCategory | null;
  /** Reject records at the frame's station in the 60 min before the frame. */
  stationRecentRecords: number;
  stationRecentTiles: number;
};

export function frameContext(s: SimState, f: Frame): FrameContext {
  const batch = s.batches.find((b) => b.id === f.batchId) ?? null;
  const byDefect = new Map<DefectCategory, number>();
  let batchRejectTiles = 0;
  let recentRecords = 0;
  let recentTiles = 0;
  for (const r of s.inspections) {
    if (r.result !== 'reject') continue;
    if (r.batchId === f.batchId) {
      batchRejectTiles += r.tiles;
      if (r.defect) byDefect.set(r.defect, (byDefect.get(r.defect) ?? 0) + r.tiles);
    }
    if (r.stationId === f.stationId && r.time > f.time - 60 && r.time <= f.time) {
      recentRecords++;
      recentTiles += r.tiles;
    }
  }
  const top = [...byDefect.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    scenario: affectingScenario(s, f.rec),
    batch,
    batchRejectTiles,
    batchTopDefect: top ? top[0] : null,
    stationRecentRecords: recentRecords,
    stationRecentTiles: recentTiles,
  };
}
