/**
 * Small helpers shared by the rule definitions (src/intel/rules/defs/*): names, units and clock text from the
 * configuration, the signal ids an equipment item exposes, per-minute state lookups over a state timeline, and
 * a least-squares slope with its t statistic. Pure; nothing here reads signal values.
 */
import { usableValue, type Sample, type Window } from '../../calc';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { definitionOf } from '../../model/catalog';
import { BUFFER_LEVEL_SIGNAL, BUFFERS, CONVEYOR_BY_ID, OPS_BY_ID, OUTPUT_BUFFER, STAGE_BY_ID } from '../../model/plant';
import type { EquipmentStateSegment } from '../../model/telemetry';
import type { BufferDef } from '../../model/types';
import { formatClock, formatDuration } from '../../sim/time';
import type { RuleScope } from './types';

export type EquipmentState = EquipmentStateSegment['state'];

/** Display name of an equipment item (its id when unknown). */
export const equipmentName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? id;
/** Catalogue name of a signal (its id when unknown). */
export const signalName = (id: string) => definitionOf(id)?.name ?? id;
/** Catalogue unit of a signal (null for states, events, unknown ids). */
export const signalUnit = (id: string) => definitionOf(id)?.unit ?? null;
/** Whether the catalogue knows the signal (any availability status). */
export const inCatalog = (id: string) => definitionOf(id) != null;

export const clock = formatClock;
export const duration = formatDuration;
/** "13:05–14:05". */
export const span = (w: Window) => `${clock(w.from)}–${clock(w.to)}`;

const nf = (digits: number) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF = [nf(0), nf(1), nf(2), nf(3)];
/** A number with fixed decimals and grouping ("1,234", "15.3"); '—' for null. */
export const num = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? '—' : NF[Math.min(3, digits)].format(v).replace(/^-/, '−'));
/** A fraction as a percentage ("85 %"); '—' for null. */
export const pct = (f: number | null | undefined, digits = 0) => (f == null || !Number.isFinite(f) ? '—' : `${NF[Math.min(3, digits)].format(f * 100)} %`);
/** A signed percentage ("+40 %", "−12 %"). */
export const signedPct = (f: number, digits = 0) => `${f >= 0 ? '+' : '−'}${pct(Math.abs(f), digits)}`;
/** "a, b and c". */
export const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** The equipment item of an equipment scope (null for stage / plant scopes). */
export const equipmentOf = (scope: RuleScope) => (scope.kind === 'equipment' ? scope.equipmentId : null);

/** Whether the asset is a conveyor (run_state / tile_count) rather than a process machine (state / count_total). */
export const isConveyor = (id: string) => !!CONVEYOR_BY_ID[id];
/** State signal of a tracked asset: `<id>.state` (machines) or `<id>.run_state` (conveyors). */
export const stateSignalOf = (id: string) => `${id}.${isConveyor(id) ? 'run_state' : 'state'}`;
/** Output counter of a tracked asset: `<id>.count_total` (machines) or `<id>.tile_count` (conveyors). */
export const counterSignalOf = (id: string) => `${id}.${isConveyor(id) ? 'tile_count' : 'count_total'}`;
/** Ideal rate of a process machine (units / h, configuration), null for anything else. */
export const idealRateOf = (id: string) => OPS_BY_ID[id]?.idealRatePerHour ?? null;

/** The other machines of the same process stage (e.g. presses 1 and 3 for press 2). */
export function peersOf(id: string): string[] {
  const stage = OPS_BY_ID[id]?.stage;
  return stage ? STAGE_BY_ID[stage].machines.filter((m) => m !== id) : [];
}

/** Input and output buffer of a process machine's stage, with their level signals. */
export function buffersOf(id: string): { input: (BufferDef & { levelSignal: string }) | null; output: (BufferDef & { levelSignal: string }) | null } {
  const stage = OPS_BY_ID[id]?.stage;
  const find = (bufferId: string | null | undefined) => {
    const b = bufferId ? BUFFERS.find((x) => x.id === bufferId) : undefined;
    return b && BUFFER_LEVEL_SIGNAL[b.id] ? { ...b, levelSignal: BUFFER_LEVEL_SIGNAL[b.id] } : null;
  };
  return stage ? { input: find(STAGE_BY_ID[stage].inputBuffer), output: find(OUTPUT_BUFFER[stage]) } : { input: null, output: null };
}

/** States in which an asset produces at its own pace (a conveyor running empty is 'idle', not running). */
export const RUNNING: ReadonlySet<EquipmentState> = new Set<EquipmentState>(['running', 'reduced']);
/** States that are not production time: planned stops and setups (left out of output targets). */
export const NOT_SCHEDULED: ReadonlySet<EquipmentState> = new Set<EquipmentState>(['planned', 'changeover']);

/** Per-minute state lookup over contiguous segments (null for a minute no segment covers). */
export function stateLookup(segments: EquipmentStateSegment[]): (t: number) => EquipmentStateSegment | null {
  const segs = [...segments].sort((a, b) => a.from - b.from);
  return (t) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const x = segs[mid];
      if (t < x.from) hi = mid - 1;
      else if (t >= x.to) lo = mid + 1;
      else return x;
    }
    return null;
  };
}

/** Minutes of the window whose state satisfies `pred` (minutes without a state are not counted). */
export function minutesWhere(segments: EquipmentStateSegment[], window: Window, pred: (state: EquipmentState) => boolean): number {
  let n = 0;
  for (const x of segments) {
    if (!pred(x.state)) continue;
    const from = Math.max(x.from, window.from);
    const to = Math.min(x.to, window.to);
    if (to > from) n += to - from;
  }
  return n;
}

/**
 * Start of the trailing run where `pred` holds for every minute up to `to` (exclusive), scanning back no further
 * than `from`; null when it does not hold at minute to − 1.
 */
export function trailingRunStart(pred: (t: number) => boolean, from: number, to: number): number | null {
  if (to - 1 < from || !pred(to - 1)) return null;
  let t = to - 1;
  while (t - 1 >= from && pred(t - 1)) t--;
  return t;
}

export type SlopeTest = {
  /** Least-squares slope in value units per hour (t in plant minutes). */
  slopePerHour: number;
  /** Standard error of the slope (per hour). */
  sePerHour: number;
  /** t statistic of the slope (slope ÷ standard error); ±Infinity for a perfect fit. */
  t: number;
  n: number;
  /** Fitted values at the first and the last sample time. */
  fittedStart: number;
  fittedEnd: number;
  from: number;
  to: number;
};

/**
 * Least-squares slope of the usable samples (null, bad, stale, missing ignored) with its standard error and t
 * statistic (n − 2 degrees of freedom). The test assumes independent residuals: minute samples of a smooth process
 * are autocorrelated, so it overstates certainty — callers say so. Null with fewer than three usable samples or no
 * time spread.
 */
export function slopeTest(samples: Sample[]): SlopeTest | null {
  const pts: [number, number][] = [];
  for (const s of samples) {
    const v = usableValue(s);
    if (v !== null) pts.push([s.t, v]);
  }
  const n = pts.length;
  if (n < 3) return null;
  pts.sort((x, y) => x[0] - y[0]);
  let tSum = 0;
  let vSum = 0;
  for (const [t, v] of pts) {
    tSum += t;
    vSum += v;
  }
  const tMean = tSum / n;
  const vMean = vSum / n;
  let sxx = 0;
  let sxy = 0;
  for (const [t, v] of pts) {
    sxx += (t - tMean) ** 2;
    sxy += (t - tMean) * (v - vMean);
  }
  if (sxx <= 0) return null;
  const b = sxy / sxx;
  const a = vMean - b * tMean;
  let sse = 0;
  for (const [t, v] of pts) sse += (v - (a + b * t)) ** 2;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const from = pts[0][0];
  const to = pts[n - 1][0];
  return { slopePerHour: b * 60, sePerHour: se * 60, t: se > 0 ? b / se : b === 0 ? 0 : b > 0 ? Infinity : -Infinity, n, fittedStart: a + b * from, fittedEnd: a + b * to, from, to };
}
