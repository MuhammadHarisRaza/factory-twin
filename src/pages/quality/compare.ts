/**
 * Derivations of the Quality & Defects Compare tab (pure, no React): reject rate and first-pass yield by
 * production batch, by shift and by product, each against the rest of the window with a two-proportion
 * z-test; the hourly reject-rate / FPY trend; defect categories with their modelled origin stage; and the
 * process association — the QL-PROCESS-ASSOCIATION findings of the rule engine and, when enough batches
 * have matched data, each batch's mean |PV − SP| against its reject rate.
 *
 * Counting rules (one definition everywhere, the same as the KPIs, src/sim/metrics qualityIn):
 * - Tiles inspected = the vision tunnel count (every sorted tile passes the gauge and the tunnel);
 *   tiles rejected = gauge + tunnel rejects. Lab samples (QC bench) are not part of either. Inspection
 *   records are never a denominator — each stands for several rejected tiles.
 * - Whole hours come from the hourly inspection buckets, parts of an hour from the per-minute quality log
 *   (last LOG_MIN minutes). A part of an hour older than the log cannot be split: it is rounded to the
 *   whole hour and said so.
 * - Batch attribution: tiles reaching sorting belong to the batch pressed BATCH_LAG_MIN earlier — the
 *   simulation's fixed press-to-sorting lag, the same rule that tags every inspection record with its
 *   batch id. A batch is therefore counted over the minutes its tiles passed sorting.
 * - Shift attribution: by the time the tiles were inspected at sorting.
 * - Rates use src/calc rejectRate / firstPassYield (nothing inspected → unavailable, never 0 %). The line has
 *   no rework loop in the model, so first-pass yield = accepted ÷ inspected = 1 − reject rate.
 *
 * A significant difference says it is unlikely to be chance — not what caused it. The process association
 * is an association to investigate, never a cause. Everything is simulated.
 */
import { firstPassYield, proportionChange, rejectRate, type Calc, type ProportionChange, type Window } from '../../calc';
import { findingsFor, paramOf, useRuleThresholds, type RuleFinding } from '../../intel/rules';
import { ASSOCIATION_PVS } from '../../intel/rules/defs/quality';
import { STAGE_BY_NO, definitionOf, stageOfEquipment } from '../../model/catalog';
import { DEFECTS, DEFECT_ORDER, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { RangeOption } from '../../model/telemetry';
import type { DefectCategory, ProductionBatch, ShiftId, StageId } from '../../model/types';
import { LOG_MIN, type SimState } from '../../sim/engine';
import { qualityIn } from '../../sim/metrics';
import { simulatedSource } from '../../sim/telemetry';
import { SHIFT_MIN, formatClock, formatDateTime, shiftAt } from '../../sim/time';
import { BATCH_LAG_MIN } from './frames';
import { PRODUCT_BY_SKU } from './lookup';

// ── Settings ─────────────────────────────────────────────────────────────────

export type CompareRangeKey = '8h' | '24h' | '7d';

/** The tab's windows: whole hours of the hourly inspection buckets, ending with the current (partial) hour. */
export const COMPARE_RANGES: (RangeOption & { key: CompareRangeKey })[] = [
  { key: '8h', label: '8 h', minutes: 480, stepMin: 60, resolution: 'hour' },
  { key: '24h', label: '24 h', minutes: 1440, stepMin: 60, resolution: 'hour' },
  { key: '7d', label: '7 days', minutes: 10080, stepMin: 60, resolution: 'hour' },
];
const RANGE_MIN: Record<CompareRangeKey, number> = { '8h': 480, '24h': 1440, '7d': 10080 };

/** Critical |z| of the group-vs-rest test (two-sided, ≈ 99 % — the QL quality rules' default). */
export const COMPARE_Z = 2.58;
/** Tiles inspected needed in a group and in the rest before the test gives a verdict. */
export const COMPARE_MIN_TILES = 200;
/** Batches with matched process data needed before the scatter is drawn. */
export const SCATTER_MIN_BATCHES = 5;
/** Running minutes with a usable PV and SP a batch needs for its mean deviation. */
export const MIN_PV_MINUTES = 60;
/** The rule the association block shows. */
export const ASSOC_RULE_ID = 'QL-PROCESS-ASSOCIATION';
/** Wording every association view carries. */
export const ASSOCIATION_NOTE = 'Association to investigate, not a cause';
export const RECIPE_NOTE = 'Recipe: not modelled (product SKU shown)';

// ── Counts ───────────────────────────────────────────────────────────────────

export type Counts = {
  /** Tiles inspected (vision tunnel; every sorted tile). */
  inspected: number;
  /** Tiles rejected (gauge + tunnel). */
  rejected: number;
  byDefect: Record<DefectCategory, number>;
  /** Hours the window touches, and those with inspection data. */
  hours: number;
  hoursWithData: number;
  /** Part of an hour older than the minute log was rounded to the whole hour. */
  rounded: boolean;
};

const noDefects = () => Object.fromEntries(DEFECT_ORDER.map((d) => [d, 0])) as Record<DefectCategory, number>;
export const emptyCounts = (): Counts => ({ inspected: 0, rejected: 0, byDefect: noDefects(), hours: 0, hoursWithData: 0, rounded: false });

function addTo(out: Counts, c: { inspected: number; rejected: number; byDefect: Record<DefectCategory, number> }) {
  out.inspected += c.inspected;
  out.rejected += c.rejected;
  for (const d of DEFECT_ORDER) out.byDefect[d] += c.byDefect[d];
}

export function sumCounts(list: Counts[]): Counts {
  const out = emptyCounts();
  for (const c of list) {
    addTo(out, c);
    out.hours += c.hours;
    out.hoursWithData += c.hoursWithData;
    out.rounded ||= c.rounded;
  }
  return out;
}

/** Counts over windows of one simulation state; hourly buckets are read once per hour. */
export type Ledger = { counts(w: Window): Counts };

export function quality(s: SimState): Ledger {
  const hours = new Map<number, ReturnType<typeof qualityIn> | null>();
  const hour = (h: number) => {
    if (!hours.has(h)) hours.set(h, s.quality.has(h) ? qualityIn(s, { from: h * 60, to: h * 60 + 60, label: '' }) : null);
    return hours.get(h)!;
  };
  const L = s.qualityLog;
  return {
    counts(w) {
      const out = emptyCounts();
      const now = s.minute;
      const from = Math.max(0, Math.floor(w.from));
      const to = Math.min(now, Math.ceil(w.to));
      if (to <= from) return out;
      const logFrom = Math.max(0, now - LOG_MIN);
      for (let h = Math.floor(from / 60); h * 60 < to; h++) {
        const a = h * 60;
        const b = Math.min(a + 60, now);
        const lo = Math.max(a, from);
        const hi = Math.min(b, to);
        if (hi <= lo) continue;
        out.hours++;
        if (lo === a && hi === b) {
          const q = hour(h);
          if (q && q.inspected > 0) {
            addTo(out, q);
            out.hoursWithData++;
          }
          continue;
        }
        if (lo >= logFrom) {
          let any = false;
          for (let m = lo; m < hi; m++) {
            const i = m % LOG_MIN;
            if (L.t[i] !== m) continue;
            any = true;
            out.inspected += L.inspected[i];
            out.rejected += L.rejected[i];
            for (const d of DEFECT_ORDER) out.byDefect[d] += L.defect[d][i];
          }
          if (any) out.hoursWithData++;
          continue;
        }
        // Part of an hour older than the minute log: the whole hour's bucket when the window covers most of it.
        out.rounded = true;
        const q = hi - lo >= (b - a) / 2 ? hour(h) : null;
        if (q && q.inspected > 0) {
          addTo(out, q);
          out.hoursWithData++;
        }
      }
      return out;
    },
  };
}

// ── Group statistics and the test against the rest ───────────────────────────

export type Verdict = 'higher' | 'lower' | 'not-significant' | 'too-few' | 'no-rest' | 'unavailable';

export const VERDICT_LABEL: Record<Verdict, string> = {
  higher: 'Significant · higher',
  lower: 'Significant · lower',
  'not-significant': 'Not significant',
  'too-few': 'Too few samples',
  'no-rest': 'Nothing to compare with',
  unavailable: 'Unavailable',
};

export type Comparison = {
  verdict: Verdict;
  /** The z-test (null when there was nothing to test). */
  test: Calc<ProportionChange> | null;
  /** Reject rate of the rest of the window (null when nothing else was inspected). */
  restRate: number | null;
  /** Tiles inspected in the rest of the window. */
  restInspected: number;
  /** Why there is no verdict, or the figures of the verdict. */
  text: string;
};

export type GroupStats = {
  counts: Counts;
  rate: Calc<number>;
  fpy: Calc<number>;
  top: { defect: DefectCategory; tiles: number; share: number } | null;
};

export type GroupRow = GroupStats & { key: string; label: string; sub: string; vs: Comparison };

export const valueOf = (c: Calc<number>) => (c.status === 'ok' ? c.value : null);
const pctText = (f: number | null, digits = 2) => (f == null ? '—' : `${(f * 100).toFixed(digits)} %`);
const zText = (z: number) => `z = ${z < 0 ? '−' : ''}${Math.abs(z).toFixed(1)}`;
const int = (n: number) => Math.round(n).toLocaleString('en-GB');

export function groupStats(c: Counts): GroupStats {
  let top: GroupStats['top'] = null;
  for (const d of DEFECT_ORDER) if (c.byDefect[d] > 0 && (!top || c.byDefect[d] > top.tiles)) top = { defect: d, tiles: c.byDefect[d], share: 0 };
  if (top) top.share = c.rejected > 0 ? top.tiles / c.rejected : 0;
  return { counts: c, rate: rejectRate(c.rejected, c.inspected), fpy: firstPassYield(c.inspected - c.rejected, c.inspected), top };
}

/**
 * The group against the rest of the window (total − group: the groups partition the window's tiles, so no
 * tile is counted twice): pooled two-proportion z-test of tiles rejected ÷ tiles inspected, |z| ≥ COMPARE_Z,
 * at least COMPARE_MIN_TILES in each.
 */
export function versusRest(group: Counts, total: Counts, opts: { z?: number; minN?: number } = {}): Comparison {
  const z = opts.z ?? COMPARE_Z;
  const minN = opts.minN ?? COMPARE_MIN_TILES;
  // Float sums of fractional simulated tiles: never a negative rest.
  const rest = { x: Math.max(0, total.rejected - group.rejected), n: Math.max(0, total.inspected - group.inspected) };
  rest.x = Math.min(rest.x, rest.n);
  const restRate = valueOf(rejectRate(rest.x, rest.n));
  if (group.inspected <= 0) return { verdict: 'unavailable', test: null, restRate, restInspected: rest.n, text: 'No tile inspected — no reject rate to compare' };
  if (rest.n <= 1e-9) return { verdict: 'no-rest', test: null, restRate: null, restInspected: 0, text: 'No other tiles inspected in the window' };
  const test = proportionChange({ x: Math.min(group.rejected, group.inspected), n: group.inspected }, rest, { minN, z });
  if (test.status === 'insufficient') return { verdict: 'too-few', test, restRate, restInspected: rest.n, text: test.reason };
  if (test.status !== 'ok') return { verdict: 'unavailable', test, restRate, restInspected: rest.n, text: test.reason };
  const t = test.value;
  const verdict: Verdict = t.significant ? (t.diff > 0 ? 'higher' : 'lower') : 'not-significant';
  return { verdict, test, restRate, restInspected: rest.n, text: `${pctText(t.current)} vs ${pctText(t.baseline)} for the rest (${int(rest.n)} tiles), ${zText(t.z)}` };
}

// ── Window ───────────────────────────────────────────────────────────────────

/** The last N whole hours ending with the current (partial) hour; clipped to the simulated history. */
export function compareWindow(now: number, key: CompareRangeKey): { window: Window; clipped: boolean } {
  const n = RANGE_MIN[key] / 60;
  const first = (Math.floor((now - 1) / 60) - n + 1) * 60;
  return { window: { from: Math.max(0, first), to: Math.max(0, now) }, clipped: first < 0 };
}

/** Ranges the history cannot serve differently from a shorter one, with the reason (TimeRange disabled). */
export function rangeAvailability(now: number): Partial<Record<CompareRangeKey, string>> {
  const out: Partial<Record<CompareRangeKey, string>> = {};
  const hours = Math.max(0, Math.ceil(now / 60));
  if (hours <= 8) out['24h'] = `Only ${hours} h of simulated history — the same as 8 h`;
  if (hours <= 24) out['7d'] = `Only ${hours} h of simulated history — the same as 24 h`;
  return out;
}

// ── Batches ──────────────────────────────────────────────────────────────────

export type BatchStatus = 'not-at-sorting' | 'at-sorting' | 'complete';

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  'not-at-sorting': 'Not at sorting yet',
  'at-sorting': 'At sorting now',
  complete: 'Inspected',
};

export type BatchRow = GroupRow & {
  batch: ProductionBatch;
  product: string;
  /** Minutes its tiles passed sorting (all of them, not clipped to the window); null before any arrived. */
  atSorting: Window | null;
  status: BatchStatus;
  /** Some of its tiles were inspected before the window starts (not counted here). */
  partial: boolean;
};

/**
 * The minutes the tiles of batch i reach sorting: [start + lag, next start + lag) — the engine tags the tiles
 * inspected at minute t with the batch pressed at t − BATCH_LAG_MIN (the first batch also takes the very first
 * minutes of the run).
 */
export function batchSortingWindow(batches: ProductionBatch[], i: number): Window {
  const from = i === 0 ? 0 : batches[i].start + BATCH_LAG_MIN;
  const next = batches[i + 1];
  return { from, to: next ? next.start + BATCH_LAG_MIN : Infinity };
}

/** The batch whose tiles passed sorting at minute t (the same rule as the inspection records' batch ids). */
export function batchAtSorting(batches: ProductionBatch[], t: number): ProductionBatch | null {
  for (let i = batches.length - 1; i >= 0; i--) {
    const w = batchSortingWindow(batches, i);
    if (t >= w.from && t < w.to) return batches[i];
  }
  return null;
}

/**
 * The shortest range whose window contains some of the batch's minutes at sorting; 'none' when no range
 * does (older than 7 days, unknown batch). A batch whose tiles have not reached sorting yet: the shortest range.
 */
export function rangeCovering(s: SimState, batchId: string): CompareRangeKey | 'none' {
  const i = s.batches.findIndex((b) => b.id === batchId);
  if (i < 0) return 'none';
  const sw = batchSortingWindow(s.batches, i);
  for (const o of COMPARE_RANGES) {
    const { window } = compareWindow(s.minute, o.key);
    if (sw.from >= s.minute || (sw.from < window.to && sw.to > window.from)) return o.key;
  }
  return 'none';
}

// ── Trend and defects ────────────────────────────────────────────────────────

export type TrendBucket = {
  /** Hour start (plant minute). */
  t: number;
  inspected: number;
  rejected: number;
  /** null = nothing inspected that hour (a gap, never 0 %). */
  rate: number | null;
  fpy: number | null;
  /** The current hour, still filling. */
  partial: boolean;
};

export type DefectRow = {
  defect: DefectCategory;
  label: string;
  tiles: number;
  /** Share of all rejects in the window. */
  share: number;
  /** Tiles of the category ÷ tiles inspected. */
  rate: Calc<number>;
  origin: StageId;
  /** Modelled origin in the 12-stage view: "Kiln firing · stage 7". */
  originText: string;
};

/** "Kiln firing · stage 7" — the 12-stage name and number of the stage where a category is modelled to originate. */
export function originText(stage: StageId): string {
  const no = stageOfEquipment(STAGE_BY_ID[stage].machines[0]);
  return no ? `${STAGE_BY_NO[no].name} · stage ${no}` : STAGE_BY_ID[stage].name;
}

// ── The view ─────────────────────────────────────────────────────────────────

export type CompareView = {
  range: CompareRangeKey;
  window: Window;
  /** The history is shorter than the range. */
  clipped: boolean;
  /** "Mon 5 Oct 11:00 – Mon 12 Oct 10:30". */
  windowText: string;
  total: GroupStats;
  batches: BatchRow[];
  shifts: GroupRow[];
  products: GroupRow[];
  trend: TrendBucket[];
  defects: DefectRow[];
  /** Alert limit of the reject-rate rule (fraction). */
  limit: number;
};

const SHIFT_IDS: ShiftId[] = ['A', 'B', 'C'];
const SHIFT_HOURS: Record<ShiftId, string> = { A: '06:00–14:00', B: '14:00–22:00', C: '22:00–06:00' };

export function compareView(s: SimState, range: CompareRangeKey): CompareView {
  const now = s.minute;
  const { window, clipped } = compareWindow(now, range);
  const q = quality(s);
  const total = q.counts(window);
  const totalStats = groupStats(total);
  const row = (key: string, label: string, sub: string, c: Counts): GroupRow => ({ key, label, sub, ...groupStats(c), vs: versusRest(c, total) });

  // Batches whose tiles passed sorting in the window, newest first; the batch being pressed whose tiles are not at sorting yet too.
  const batches: BatchRow[] = [];
  s.batches.forEach((b, i) => {
    const sw = batchSortingWindow(s.batches, i);
    const notYet = sw.from >= now;
    if (notYet ? !(b.start < now && b.start >= window.from - BATCH_LAG_MIN) : !(sw.from < window.to && sw.to > window.from)) return;
    const overlap = { from: Math.max(sw.from, window.from), to: Math.min(sw.to, window.to) };
    const c = notYet ? emptyCounts() : q.counts(overlap);
    const product = PRODUCT_BY_SKU[b.sku]?.name ?? b.sku;
    const status: BatchStatus = notYet ? 'not-at-sorting' : sw.to > now ? 'at-sorting' : 'complete';
    const vs: Comparison = notYet
      ? { verdict: 'unavailable', test: null, restRate: null, restInspected: 0, text: `No tile of this batch has reached sorting yet (tiles reach sorting about ${BATCH_LAG_MIN / 60} h after pressing)` }
      : versusRest(c, total);
    batches.push({
      key: b.id,
      label: b.id,
      sub: product,
      ...groupStats(c),
      vs,
      batch: b,
      product,
      atSorting: notYet ? null : { from: sw.from, to: Math.min(sw.to, now) },
      status,
      partial: !notYet && sw.from < window.from,
    });
  });
  batches.reverse();

  // Shifts of inspection (A / B / C across the window's days).
  const byShift = new Map<ShiftId, { windows: Window[]; instances: number }>();
  for (let st = shiftAt(window.from).start; st < window.to; st += SHIFT_MIN) {
    const sh = shiftAt(st);
    const w = { from: Math.max(sh.start, window.from), to: Math.min(sh.end, window.to) };
    if (w.to <= w.from) continue;
    const g = byShift.get(sh.id) ?? { windows: [], instances: 0 };
    g.windows.push(w);
    g.instances++;
    byShift.set(sh.id, g);
  }
  const shifts = SHIFT_IDS.filter((id) => byShift.has(id)).map((id) => {
    const g = byShift.get(id)!;
    return row(id, `Shift ${id} · ${SHIFT_HOURS[id]}`, `${g.instances} shift${g.instances === 1 ? '' : 's'} in the window`, sumCounts(g.windows.map((w) => q.counts(w))));
  });

  // Products (SKU) over their batches' tiles in the window.
  const bySku = new Map<string, BatchRow[]>();
  for (const b of batches) if (b.status !== 'not-at-sorting') bySku.set(b.batch.sku, [...(bySku.get(b.batch.sku) ?? []), b]);
  const products = [...bySku.entries()].map(([sku, rows]) =>
    row(sku, PRODUCT_BY_SKU[sku]?.name ?? sku, `${sku} · ${rows.length} batch${rows.length === 1 ? '' : 'es'}`, sumCounts(rows.map((r) => r.counts))),
  );

  // Hourly trend: a gap where nothing was inspected.
  const trend: TrendBucket[] = [];
  for (let a = Math.floor(window.from / 60) * 60; a < window.to; a += 60) {
    const c = q.counts({ from: Math.max(a, window.from), to: Math.min(a + 60, window.to) });
    trend.push({ t: a, inspected: c.inspected, rejected: c.rejected, rate: valueOf(rejectRate(c.rejected, c.inspected)), fpy: valueOf(firstPassYield(c.inspected - c.rejected, c.inspected)), partial: a + 60 > now });
  }

  const defects: DefectRow[] = DEFECT_ORDER.filter((d) => total.byDefect[d] > 0)
    .map((d) => ({
      defect: d,
      label: DEFECTS[d].label,
      tiles: total.byDefect[d],
      share: total.rejected > 0 ? total.byDefect[d] / total.rejected : 0,
      rate: rejectRate(total.byDefect[d], total.inspected),
      origin: DEFECTS[d].origin,
      originText: originText(DEFECTS[d].origin),
    }))
    .sort((a, b) => b.tiles - a.tiles);

  return {
    range,
    window,
    clipped,
    windowText: window.to > window.from ? `${formatDateTime(window.from)} – ${formatDateTime(window.to)}` : 'No simulated history yet',
    total: totalStats,
    batches,
    shifts,
    products,
    trend,
    defects,
    limit: s.rules.rejectRateMax,
  };
}

// ── Process association ──────────────────────────────────────────────────────

export type PvOption = { id: string; spId: string; equipmentId: string; label: string; unit: string | null; min?: number; max?: number };

/** The process values the association rule watches (PVs with a setpoint and a warning band, simulated). */
export const PV_OPTIONS: PvOption[] = ASSOCIATION_PVS.map((id) => {
  const d = definitionOf(id)!;
  return { id, spId: d.setpointSignalId!, equipmentId: d.equipmentId, label: `${d.equipmentId} · ${d.name.split(' · ')[0]}`, unit: d.unit, min: d.engineeringMin, max: d.engineeringMax };
});
const PV_BY_ID: Record<string, PvOption> = Object.fromEntries(PV_OPTIONS.map((p) => [p.id, p]));

/** The process value a finding is about (its deviation evidence), if any. */
export function pvOfFinding(f: RuleFinding): string | null {
  for (const e of f.evidence) if (e.kind === 'signal' && e.ref && PV_BY_ID[e.ref]) return e.ref;
  for (const m of f.measurements) if (m.signalId && PV_BY_ID[m.signalId]) return m.signalId;
  return null;
}

export type AssociationPoint = { batchId: string; sku: string; product: string; x: number; y: number; inspected: number; minutes: number };

export type AssociationModel = {
  /** QL-PROCESS-ASSOCIATION findings (rule engine, sorting & inspection stage), detected first. */
  findings: RuleFinding[];
  pv: PvOption;
  /** Why this process value is shown. */
  pvWhy: string;
  /** Minutes from the PV's stage to sorting (the rule's transit setting). */
  transitMin: number;
  points: AssociationPoint[];
  unmatched: { batchId: string; reason: string }[];
  enough: boolean;
};

/** Per hour: Σ|PV − SP| and minutes over the running minutes with a usable PV and SP, and the running minutes. */
type DevHour = { sum: number; usable: number; running: number };
const DEV_CACHE = new WeakMap<SimState, Map<string, Map<number, DevHour>>>();
const RUNNING = new Set(['running', 'reduced']);
const usableQ = (q: string | undefined) => q == null || q === 'good' || q === 'uncertain';

/**
 * Hourly deviation sums of a PV from minute data (telemetry adapter), only while its machine runs (a stopped
 * machine makes no tiles, so its cooling is no exposure — the association rule's reading). Readings outside the
 * engineering range are bad measurements, not deviations. Completed hours are cached per simulation state.
 */
function deviationHours(s: SimState, pv: PvOption, h0: number, h1: number): Map<number, DevHour> {
  let byPv = DEV_CACHE.get(s);
  if (!byPv) DEV_CACHE.set(s, (byPv = new Map()));
  let cache = byPv.get(pv.id);
  if (!cache) byPv.set(pv.id, (cache = new Map()));
  const closed = Math.floor(s.minute / 60);
  const missing: [number, number][] = [];
  for (let h = Math.max(0, h0); h < h1; h++) {
    if (h < closed && cache.has(h)) continue;
    const last = missing[missing.length - 1];
    if (last && last[1] === h) last[1] = h + 1;
    else missing.push([h, h + 1]);
  }
  for (const [a, b] of missing) {
    const from = a * 60;
    const to = Math.min(b * 60, s.minute);
    if (to <= from) continue;
    const w = { from, to, stepMin: 1 };
    const x = simulatedSource.series(s, pv.id, w);
    const sp = simulatedSource.series(s, pv.spId, w);
    const segs = [...simulatedSource.states(s, pv.equipmentId, { from, to })].sort((p, q) => p.from - q.from);
    const recs = new Map<number, DevHour>();
    for (let h = a; h < b; h++) recs.set(h, { sum: 0, usable: 0, running: 0 });
    let k = 0;
    const n = x ? x.t.length : 0;
    for (let i = 0; i < n; i++) {
      const t = x!.t[i];
      if (t >= to) break;
      while (k < segs.length && segs[k].to <= t) k++;
      const running = !segs.length || (k < segs.length && segs[k].from <= t && RUNNING.has(segs[k].state));
      if (!running) continue;
      const r = recs.get(Math.floor(t / 60))!;
      r.running++;
      const v = x!.v[i];
      const sv = sp?.v[i] ?? null;
      if (v == null || sv == null || !usableQ(x!.q?.[i]) || !usableQ(sp?.q?.[i])) continue;
      if ((pv.min != null && v < pv.min) || (pv.max != null && v > pv.max)) continue;
      r.sum += Math.abs(v - sv);
      r.usable++;
    }
    for (const [h, r] of recs) cache.set(h, r);
  }
  const out = new Map<number, DevHour>();
  for (let h = Math.max(0, h0); h < h1; h++) {
    const r = cache.get(h);
    if (r) out.set(h, r);
  }
  return out;
}

/** The default process value: the detected association's, else one with a deviation, else the origin stage of the top defect's. */
function defaultPv(findings: RuleFinding[], view: CompareView): { id: string; why: string } {
  const fired = findings.find((f) => f.status === 'fired' && pvOfFinding(f));
  if (fired) return { id: pvOfFinding(fired)!, why: 'the process value of the detected association' };
  const seen = findings.find((f) => pvOfFinding(f));
  if (seen) return { id: pvOfFinding(seen)!, why: 'a process value that left its warning band in the rule’s look-back' };
  for (const d of view.defects) {
    const machines = STAGE_BY_ID[d.origin].machines;
    const pv = PV_OPTIONS.find((p) => machines.includes(p.equipmentId) || OPS_BY_ID[p.equipmentId]?.stage === d.origin);
    if (pv) return { id: pv.id, why: `a process value at the modelled origin of the most frequent defect with one (${d.label.toLowerCase()})` };
  }
  return { id: PV_OPTIONS[0].id, why: 'the first process value with a setpoint' };
}

/**
 * The process association of the window: the rule engine's QL-PROCESS-ASSOCIATION findings, and per batch the
 * mean |PV − SP| of one process value over the running minutes its tiles took (the minutes they passed sorting,
 * less the rule's transit time) against the batch reject rate. A batch is matched only with enough inspected
 * tiles and enough usable PV minutes; a batch without them is listed with the reason, never plotted as 0.
 */
export function associationModel(
  s: SimState,
  view: CompareView,
  opts: { pvId?: string | null; findings?: RuleFinding[]; transitMin?: number } = {},
): AssociationModel {
  const findings = (opts.findings ?? findingsFor(s, { kind: 'stage', stageNo: 10 })).filter((f) => f.ruleId === ASSOC_RULE_ID);
  const def = defaultPv(findings, view);
  const chosen = opts.pvId && PV_BY_ID[opts.pvId] ? opts.pvId : null;
  const pv = PV_BY_ID[chosen ?? def.id] ?? PV_OPTIONS[0];
  const transitMin = Math.max(0, Math.round(opts.transitMin ?? paramOf(useRuleThresholds.getState().values, ASSOC_RULE_ID, 'transitMin', null, s.rules)));
  const points: AssociationPoint[] = [];
  const unmatched: AssociationModel['unmatched'] = [];
  for (const b of view.batches) {
    if (b.status === 'not-at-sorting' || !b.atSorting) {
      unmatched.push({ batchId: b.batch.id, reason: 'no tile at sorting yet' });
      continue;
    }
    if (b.counts.inspected < COMPARE_MIN_TILES) {
      unmatched.push({ batchId: b.batch.id, reason: `${int(b.counts.inspected)} tiles inspected in the window (needs ${COMPARE_MIN_TILES})` });
      continue;
    }
    // The batch's minutes at sorting inside the window, moved back by the transit time to the PV's stage.
    const w = { from: Math.max(b.atSorting.from, view.window.from) - transitMin, to: Math.min(b.atSorting.to, view.window.to) - transitMin };
    const hours = deviationHours(s, pv, Math.floor(w.from / 60), Math.ceil(w.to / 60));
    let sum = 0;
    let usable = 0;
    let running = 0;
    for (const [h, r] of hours) {
      const lo = Math.max(h * 60, w.from);
      const hi = Math.min(h * 60 + 60, w.to, s.minute);
      // Whole hours (the batch windows of this simulation are hour-aligned); a part hour counts when mostly covered.
      if (hi - lo < Math.min(30, (Math.min(h * 60 + 60, s.minute) - h * 60) / 2)) continue;
      sum += r.sum;
      usable += r.usable;
      running += r.running;
    }
    if (!running) {
      unmatched.push({ batchId: b.batch.id, reason: `${pv.equipmentId} not running while its tiles were made` });
      continue;
    }
    if (usable < MIN_PV_MINUTES || usable < running / 2) {
      unmatched.push({ batchId: b.batch.id, reason: `usable ${pv.label} for ${usable} of ${running} running minutes` });
      continue;
    }
    points.push({ batchId: b.batch.id, sku: b.batch.sku, product: b.product, x: sum / usable, y: valueOf(b.rate)!, inspected: b.counts.inspected, minutes: usable });
  }
  return {
    findings,
    pv,
    pvWhy: chosen ? 'chosen' : def.why,
    transitMin,
    points,
    unmatched,
    enough: points.length >= SCATTER_MIN_BATCHES,
  };
}

/** "10:00–11:00" or "Mon 5 Oct 22:00 – Tue 6 Oct 14:00". */
export function windowText(w: Window): string {
  return w.to - w.from <= 1440 && formatDateTime(w.from).slice(0, -6) === formatDateTime(w.to).slice(0, -6)
    ? `${formatDateTime(w.from)}–${formatClock(w.to)}`
    : `${formatDateTime(w.from)} – ${formatDateTime(w.to)}`;
}
