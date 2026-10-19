/**
 * Simulated process model (brief §4 / §9): the value of every PROCESS_SIGNALS id
 * (src/model/catalog/process.ts) at any minute the simulation history covers. Every value is a
 * labelled simulation, never plant telemetry.
 *
 * - Setpoints are the recipe values (the spec's nominal), constant in this release.
 * - A PV follows its setpoint with smooth deterministic noise (`noise01`, two octaves), plus the offset of
 *   an active 'process-deviation' scenario (ramped in over `rampMin`). While its machine is stopped it
 *   follows the spec's stopped behaviour — 'hold' (keeps following the setpoint), 'decay' (relaxes towards
 *   a value with a time constant; recovers after the restart three times faster) or 'none' (no value) —
 *   with `stoppedDown` for unplanned stops; a product changeover counts as a planned-like stop.
 *   A 'none' PV (press pressure, powder moisture) also has no value in a minute without output.
 * - Derived values come from the simulated production: drives from the machine's own pace, mass flows
 *   from the tile-equivalent rate × KG_PER_TILE (simulated assumption), press strokes from the rate ÷
 *   PRESS_CAVITIES, cycle time = 60 / strokes per minute, carton / pallet counters from the count totals.
 * - A run command is on unless the machine is in an own stop; a 'data-quality' scenario in mode
 *   'command-no-feedback' holds the machine stopped while its command stays on.
 *
 * Machine state history: own stops from the downtime records (kept eight days, so any minute of a 7-day
 * range), output per minute from the minute log (LOG_MIN) and from the hourly buckets beyond it. The
 * functions are pure for any minute that history covers, and cheap: values are evaluated on demand
 * (charts, rules), never stored per minute.
 */
import { KG_PER_TILE, PRESS_CAVITIES, PROCESS_SIGNAL_BY_ID, TILES_PER_CARTON, type ProcessSignalSpec, type StoppedBehaviour } from '../model/catalog/process';
import { OPS_BY_ID, REASON_BY_CODE, TILES_PER_PALLET } from '../model/plant';
import type { ScenarioActivation, StageId } from '../model/types';
import { LOG_MIN, minuteAt, ownPaceAt, type SimState } from './engine';
import { noise01, noiseKey, smoothNoiseAt } from './rng';

export type ProcessValue = number | boolean | null;

// ── Own stops (machine state history) ────────────────────────────────────────

/** Kind of an own stop: planned (cleaning, maintenance), a product changeover, or an unplanned stop. */
export type StopKind = 'planned' | 'changeover' | 'down';
/** An own stop of an asset over [start, end) (end = Infinity while still open). */
export type StopSpan = { start: number; end: number; kind: StopKind; reasonCode: string };

const stopCache = new WeakMap<SimState, { minute: number; records: number; version: number; byId: Map<string, StopSpan[]> }>();

/**
 * Own stops of an asset (not starved / blocked spells), oldest first, from the downtime records. Cached per
 * simulation step, so a chart or a rule evaluating many minutes scans the records once.
 */
export function ownStops(s: SimState, id: string): StopSpan[] {
  let c = stopCache.get(s);
  if (!c || c.minute !== s.minute || c.records !== s.downtime.length || c.version !== s.version) {
    c = { minute: s.minute, records: s.downtime.length, version: s.version, byId: new Map() };
    stopCache.set(s, c);
  }
  let list = c.byId.get(id);
  if (!list) {
    list = [];
    for (const d of s.downtime) {
      if (d.equipmentId !== id || d.category === 'Starved' || d.category === 'Blocked') continue;
      const kind: StopKind = REASON_BY_CODE[d.reasonCode]?.planned ? 'planned' : d.reasonCode === 'CHG_PRODUCT' ? 'changeover' : 'down';
      list.push({ start: d.start, end: d.end ?? Infinity, kind, reasonCode: d.reasonCode });
    }
    list.sort((a, b) => a.start - b.start);
    c.byId.set(id, list);
  }
  return list;
}

/** Index of the last stop starting at or before t (−1 if none). Stops of one asset never overlap. */
function lastStartingBy(list: StopSpan[], t: number) {
  let lo = 0;
  let hi = list.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= t) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

/** The own stop covering minute t, if any. */
export function stopAt(s: SimState, id: string, t: number): StopSpan | null {
  const list = ownStops(s, id);
  const i = lastStartingBy(list, t);
  return i >= 0 && list[i].end > t ? list[i] : null;
}

// ── Production history ───────────────────────────────────────────────────────

/**
 * Output of a tracked asset in minute t, tiles per hour: from the minute log while it holds t, beyond it 0
 * in an own stop and otherwise the hour's mean rate over its minutes not stopped (hourly buckets).
 * Null for a minute without any record (before the start, not simulated yet, not a tracked asset).
 */
export function rateAt(s: SimState, id: string, t: number): number | null {
  if (t < 0 || t > s.minute - 1 || !s.machines[id]) return null;
  const x = minuteAt(s, id, t);
  if (x) return x.rate * 60;
  if (stopAt(s, id, t)) return 0;
  const h = Math.floor(t / 60);
  const b = s.hours[id]?.get(h);
  if (!b) return null;
  const minutes = Math.min(60, s.minute - h * 60);
  const run = minutes - b.down - b.plannedStop;
  return run > 0 ? (b.count / run) * 60 : 0;
}

/**
 * Lifetime count of a tracked asset after minute t (tiles): inside the minute log the current total less the
 * minutes after t; older, the hourly buckets before t's hour plus that hour's bucket pro rata (monotonic into the log).
 */
export function countAt(s: SimState, id: string, t: number): number | null {
  const m = s.machines[id];
  if (!m || t < 0) return null;
  if (t >= s.minute - 1) return t === s.minute - 1 ? m.countTotal : null;
  if (t >= s.minute - LOG_MIN) {
    let v = m.countTotal;
    for (let k = s.minute - 1; k > t; k--) {
      const x = minuteAt(s, id, k);
      if (!x) return null;
      v -= x.rate;
    }
    return Math.max(0, v);
  }
  const h = Math.floor(t / 60);
  const map = s.hours[id];
  let sum = 0;
  for (const [hh, b] of map) if (hh < h) sum += b.count;
  const b = map.get(h);
  if (!b) return sum;
  // The hour the minute log starts in: interpolate up to the exact count before the log, so the counter never
  // steps back where the pro-rata estimate meets the exact minute data.
  const logFrom = s.minute - LOG_MIN;
  if (logFrom > h * 60 && logFrom < (h + 1) * 60) {
    const atLog = countAt(s, id, logFrom);
    const x = minuteAt(s, id, logFrom);
    if (atLog != null && x) return sum + ((Math.max(sum, atLog - x.rate) - sum) * (t - h * 60 + 1)) / (logFrom - h * 60);
  }
  return sum + (b.count * (t - h * 60 + 1)) / Math.min(60, s.minute - h * 60);
}

// ── Process values ───────────────────────────────────────────────────────────

/** Smooth deterministic noise in [−1, 1] for a signal: a slow and a faster octave. */
const wobble = (seed: number, id: string, t: number) => {
  const k = wobbleKeys(seed, id);
  return 0.65 * (2 * smoothNoiseAt(k.a, t, 17) - 1) + 0.35 * (2 * smoothNoiseAt(k.b, t, 4) - 1);
};

/** The noise streams `pv:<id>:a` / `pv:<id>:b` of a signal, keyed once per seed (hot: every PV sample of every chart and rule). */
const WOBBLE_KEYS = new Map<string, { seed: number; a: number; b: number }>();
function wobbleKeys(seed: number, id: string) {
  let k = WOBBLE_KEYS.get(id);
  if (!k || k.seed !== seed) WOBBLE_KEYS.set(id, (k = { seed, a: noiseKey(seed, `pv:${id}:a`), b: noiseKey(seed, `pv:${id}:b`) }));
  return k;
}

const isDeviation = (sc: ScenarioActivation, signalId: string, t: number) =>
  sc.kind === 'process-deviation' && sc.signalId === signalId && sc.start <= t && (sc.end == null || sc.end > t);

/** Offset of a PV from its setpoint by active 'process-deviation' scenarios at minute t (ramped in over rampMin). */
export function deviationOffset(s: SimState, signalId: string, t: number) {
  let off = 0;
  for (const sc of s.scenarios) {
    if (!isDeviation(sc, signalId, t)) continue;
    const ramp = sc.rampMin && sc.rampMin > 0 ? Math.min(1, (t - sc.start + 1) / sc.rampMin) : 1;
    off += (sc.offset ?? 0) * ramp;
  }
  return off;
}

/** The PV the controller holds while the machine runs: setpoint + scenario offset + noise. */
const controlled = (s: SimState, spec: ProcessSignalSpec, t: number) => (spec.nominal ?? 0) + deviationOffset(s, spec.id, t) + (spec.noise ?? 0) * wobble(s.seed, spec.id, t);

const behaviourOf = (spec: ProcessSignalSpec, kind: StopKind): StoppedBehaviour =>
  (kind === 'down' ? spec.stoppedDown : undefined) ?? spec.stopped ?? { kind: 'hold' };

/** Restart is faster than cooling (burners / heaters at high fire): recovery time constant = decay τ ÷ 3. */
const RECOVERY_SPEEDUP = 3;
/** Earlier stops followed back when a PV is still decaying / recovering from them (older ones count as settled). */
const MAX_DEPTH = 4;

function pvAt(s: SimState, spec: ProcessSignalSpec, t: number, depth = 0): number | null {
  const list = ownStops(s, spec.equipmentId);
  const i = lastStartingBy(list, t);
  const st = i >= 0 ? list[i] : null;
  if (st && st.end > t) {
    const b = behaviourOf(spec, st.kind);
    if (b.kind === 'hold') return controlled(s, spec, t);
    if (b.kind === 'none') return null;
    const from = (depth < MAX_DEPTH ? pvAt(s, spec, st.start - 1, depth + 1) : null) ?? controlled(s, spec, st.start - 1);
    return b.value + (from - b.value) * Math.exp(-(t - st.start + 1) / b.tauMin);
  }
  if (spec.stopped?.kind === 'none' && rateAt(s, spec.equipmentId, t) === 0) return null;
  const run = controlled(s, spec, t);
  // Recovering after the last stop of a decaying PV: the gap to the controlled value closes exponentially.
  if (st && depth < MAX_DEPTH) {
    const b = behaviourOf(spec, st.kind);
    if (b.kind === 'decay') {
      const tau = b.tauMin / RECOVERY_SPEEDUP;
      const since = t - st.end + 1;
      if (since < tau * 8) {
        const atEnd = pvAt(s, spec, st.end - 1, depth + 1);
        if (atEnd != null) return run + (atEnd - controlled(s, spec, st.end - 1)) * Math.exp(-since / tau);
      }
    }
  }
  return run;
}

/** The ink supply's lowest channel: drawn down by printing, refilled from the IBCs (deterministic sawtooth, %). */
function inkLevel(seed: number, t: number) {
  const P = 360;
  const x = t + Math.floor(noise01(seed, 'ink:phase', 0) * P);
  const k = Math.floor(x / P);
  const f = (x - k * P) / P;
  return 95 - (60 + 13 * noise01(seed, 'ink', k)) * f;
}

/** Whether a 'data-quality' scenario in mode 'command-no-feedback' holds the asset at minute t. */
export const commandWithoutFeedback = (s: SimState, id: string, t: number) =>
  s.scenarios.some((sc) => sc.kind === 'data-quality' && sc.mode === 'command-no-feedback' && sc.equipmentId === id && sc.start <= t && (sc.end == null || sc.end > t));

function derivedAt(s: SimState, spec: ProcessSignalSpec, t: number): number | null {
  const id = spec.equipmentId;
  const name = spec.id.slice(spec.id.indexOf('.') + 1);
  const ideal = OPS_BY_ID[id]?.idealRatePerHour ?? null;
  switch (name) {
    case 'slip_flow':
    case 'powder_flow': {
      const r = rateAt(s, id, t);
      return r == null ? null : (r * KG_PER_TILE) / 1000;
    }
    case 'strokes_per_min': {
      const r = rateAt(s, id, t);
      return r == null ? null : r / 60 / PRESS_CAVITIES;
    }
    case 'cycle_time': {
      const r = rateAt(s, id, t);
      if (r == null) return null;
      const strokes = r / 60 / PRESS_CAVITIES;
      // No stroke in the minute → no cycle to time (not 0 s, not infinite).
      return strokes > 1e-6 ? 60 / strokes : null;
    }
    case 'cycle_time_target':
      return ideal ? 60 / (ideal / 60 / PRESS_CAVITIES) : null;
    case 'mill_speed':
      if (rateAt(s, id, t) == null) return null;
      return stopAt(s, id, t) ? 0 : (spec.nominal ?? 0) * (1 + 0.004 * wobble(s.seed, spec.id, t));
    case 'roller_speed':
    case 'line_speed':
      // Drives run at the machine's own pace (they keep turning when the machine waits for tiles).
      if (rateAt(s, id, t) == null) return null;
      return stopAt(s, id, t) ? 0 : (spec.nominal ?? 0) * ownPaceAt(s, id, t);
    case 'ink_level':
      return inkLevel(s.seed, t);
    case 'carton_count': {
      const c = countAt(s, id, t);
      return c == null ? null : Math.floor(c / TILES_PER_CARTON + 1e-6);
    }
    case 'pallet_count': {
      const c = countAt(s, id, t);
      return c == null ? null : Math.floor(c / TILES_PER_PALLET + 1e-6);
    }
    default:
      return null;
  }
}

/**
 * Value of a PROCESS_SIGNALS id at minute t (default: the last simulated minute, s.minute − 1): a number for
 * PVs, setpoints and derived values, a boolean for run commands, null where there is no value (stopped with
 * behaviour 'none', no stroke, before the start or after the last simulated minute, unknown id).
 */
export function processValue(s: SimState, signalId: string, t: number = s.minute - 1): ProcessValue {
  const spec = PROCESS_SIGNAL_BY_ID[signalId];
  if (!spec || t < 0 || t > s.minute - 1) return null;
  switch (spec.role) {
    case 'sp':
      return spec.nominal ?? null;
    case 'pv':
      return pvAt(s, spec, t);
    case 'command':
      return commandWithoutFeedback(s, spec.equipmentId, t) || !stopAt(s, spec.equipmentId, t);
    case 'derived':
      return derivedAt(s, spec, t);
  }
}

// ── Process → quality coupling ───────────────────────────────────────────────

/** Reject-weight gain per warning band of excess: weight × (1 + GAIN × excess ÷ warning band). */
export const DEVIATION_REJECT_GAIN = 3;

/**
 * Reject-weight multipliers per defect-origin stage from the active process deviations at minute t: a PV
 * whose deviation from its setpoint exceeds its warning band raises the defects that originate at its
 * machine's stage by 1 + GAIN × excess ÷ band (deterministic; the largest when several act on one stage).
 * Deviations at stages where no defect category originates (PREP, SPRAY, DRY, the slip tanks) only move
 * the PV. Evaluated from the controlled value, so it holds for the minute being simulated.
 */
export function deviationBoosts(s: SimState, t: number, active: ScenarioActivation[]): Partial<Record<StageId, number>> {
  const out: Partial<Record<StageId, number>> = {};
  for (const sc of active) {
    if (sc.kind !== 'process-deviation' || !sc.signalId) continue;
    const spec = PROCESS_SIGNAL_BY_ID[sc.signalId];
    const stage = spec ? OPS_BY_ID[spec.equipmentId]?.stage : null;
    if (!spec || spec.role !== 'pv' || !stage || spec.nominal == null) continue;
    const dev = controlled(s, spec, t) - spec.nominal;
    const edge = dev >= 0 ? spec.warningHigh : spec.warningLow;
    if (edge == null) continue;
    const band = Math.abs(edge - spec.nominal);
    const excess = Math.abs(dev) - band;
    if (band <= 0 || excess <= 0) continue;
    out[stage] = Math.max(out[stage] ?? 1, 1 + (DEVIATION_REJECT_GAIN * excess) / band);
  }
  return out;
}
