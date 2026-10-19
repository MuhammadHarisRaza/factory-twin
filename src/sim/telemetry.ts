/**
 * Simulated telemetry source (src/model/telemetry.ts `TelemetrySource`): current readings, history series and
 * state timelines of every configured signal (SIGNALS in src/model/plant.ts) and every simulated process
 * signal (PROCESS_SIGNALS in src/model/catalog/process.ts), read from the simulation the way a read-only
 * adapter would read a PLC gateway or historian. Nothing here is plant telemetry: every value is simulated
 * and `kind` is 'simulated'.
 *
 * - Readings carry the timestamp of the minute they describe (the last simulated minute, s.minute − 1) and a
 *   quality. A stale feed ('signal-loss' scenario) serves every signal of the asset as last received, with
 *   quality 'stale' and the timestamp frozen at the last update. Data-quality scenarios act here: 'bad-quality'
 *   flags samples bad, 'frozen' stops the value and its timestamp (stale once older than STALE_AGE_MIN),
 *   'counter-reset' restarts the asset's production counters from 0, 'spike' reads implausibly outside the
 *   engineering range every SPIKE_EVERY_MIN minutes, 'gap' delivers no samples. 'command-no-feedback' acts on
 *   production (src/sim/engine.ts) and shows as a run command on with the machine stopped.
 * - History: minute data from the minute logs (LOG_MIN = 8 h: the 15 min / 1 h / 8 h ranges, 8 h in 5-min
 *   steps), hourly buckets for 24 h / 7 d, the process model (src/sim/process.ts) and the condition model
 *   (sensorsAt) for any minute. A bad, stale or missing sample is null in the series — never 0.
 * - State timelines from the minute log (state codes) and the downtime records (stops, changeovers, starved /
 *   blocked spells) beyond it, in the product's state vocabulary (operationalState).
 */
import type { Quality } from '../calc/types';
import { PROCESS_SIGNALS, PROCESS_SIGNAL_BY_ID, type ProcessSignalSpec } from '../model/catalog/process';
import { CONVEYOR_BY_ID, DEFECTS, DEFECT_ORDER, INSPECTION_STATIONS, OPS_BY_ID, REASON_BY_CODE, SIGNALS, bufferOfLevelSignal } from '../model/plant';
import { RANGE_BY_KEY, type EquipmentStateSegment, type RangeKey, type TelemetrySample, type TelemetrySeries, type TelemetrySource } from '../model/telemetry';
import type { OperationalState, ScenarioActivation, SignalDef } from '../model/types';
import { CONSUMERS } from './energy';
import { LOG_MIN, minuteAt, type SimState } from './engine';
import { HEALTH_BY_ID, sensorsAt } from './health';
import { stopState } from './metrics';
import { processValue, stopAt } from './process';
import { PLACEHOLDER_SIGNAL_IDS, conveyorSpeed, signalValue } from './signals';
import { MIN_PER_DAY, formatClock } from './time';
import { minuteMemo } from './memo';

/** Simulated signals update every minute (the simulation step). */
export const SAMPLE_INTERVAL_MIN = 1;
/** Age (minutes) at which a value that should update every minute is reported stale (5 × the update interval). */
export const STALE_AGE_MIN = 5;
/** A 'spike' data-quality scenario reads one implausible sample every this many minutes, from its start. */
export const SPIKE_EVERY_MIN = 10;
/** Closed downtime records are kept eight days (engine pruneHistory); state history older than this is unknown. */
const RECORD_HISTORY_MIN = 8 * MIN_PER_DAY - 60;

const SIGNAL_DEF: Record<string, SignalDef> = Object.fromEntries(SIGNALS.map((d) => [d.id, d]));
/** Every signal id the simulated source can read: the configured SIGNALS and the PROCESS_SIGNALS. */
export const TELEMETRY_SIGNAL_IDS: string[] = [...SIGNALS.map((d) => d.id), ...PROCESS_SIGNALS.map((p) => p.id)];

/** Production counters a 'counter-reset' scenario restarts (energy meters are not reset). */
const PRODUCTION_COUNTERS: ReadonlySet<string> = new Set(['count_total', 'tile_count', 'count_inspected', 'count_rejected', 'count_good', 'carton_count', 'pallet_count']);
/** Signals of the energy model (illustrative, no meter connected). */
const ENERGY_SIGNALS: ReadonlySet<string> = new Set(['energy_kwh', 'active_power', 'gas_flow']);
/** Display decimals of the configured numeric signals. */
const DIGITS: Record<string, number> = { level: 1, speed: 1, vibration: 2, temperature: 1 };

const nameOf = (signalId: string) => signalId.slice(signalId.indexOf('.') + 1);
const equipmentOf = (signalId: string) => signalId.slice(0, signalId.indexOf('.'));
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const fmtNum = (v: number, digits: number) => (digits ? v.toFixed(digits) : intFmt.format(Math.round(v)));
const unitOfDef = (d: SignalDef) => (d.kind === 'state' || d.kind === 'event' ? null : d.unit);
const digitsOf = (signalId: string) => PROCESS_SIGNAL_BY_ID[signalId]?.digits ?? (bufferOfLevelSignal(signalId) ? DIGITS.level : DIGITS[nameOf(signalId)]) ?? 0;

function textOf(signalId: string, v: number | string | boolean | null): string {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'number') return fmtNum(v, digitsOf(signalId));
  return v;
}

const isCounter = (signalId: string) => PRODUCTION_COUNTERS.has(nameOf(signalId));
const covers = (sc: ScenarioActivation, t: number) => sc.start <= t && (sc.end == null || sc.end > t);

// ── Data-quality scenarios ───────────────────────────────────────────────────

/** The signal a 'spike' scenario without a signal id acts on: the asset's first process value, else its rate. */
function spikeTarget(equipmentId: string): string | null {
  const pv = PROCESS_SIGNALS.find((p) => p.equipmentId === equipmentId && p.role === 'pv');
  if (pv) return pv.id;
  return SIGNAL_DEF[`${equipmentId}.rate`] ? `${equipmentId}.rate` : null;
}

/** Whether a data-quality scenario acts on a signal (all of its asset's signals when it names none). */
function affects(sc: ScenarioActivation, signalId: string): boolean {
  if (sc.kind !== 'data-quality' || !sc.equipmentId || sc.equipmentId !== equipmentOf(signalId)) return false;
  if (sc.mode === 'command-no-feedback') return false;
  if (sc.mode === 'spike') return (sc.signalId ?? spikeTarget(sc.equipmentId)) === signalId;
  if (sc.signalId) return sc.signalId === signalId;
  return sc.mode === 'counter-reset' ? isCounter(signalId) : true;
}

/** An implausible reading outside the engineering range (what a broken transmitter or a scaling error sends). */
function spikeValue(s: SimState, signalId: string): number {
  const spec = PROCESS_SIGNAL_BY_ID[signalId];
  if (spec?.engineeringMax != null) return spec.engineeringMax + Math.max(1, spec.engineeringMax - (spec.engineeringMin ?? 0)) * 0.5;
  const eq = equipmentOf(signalId);
  const name = nameOf(signalId);
  if (name === 'rate') return (OPS_BY_ID[eq]?.idealRatePerHour ?? CONVEYOR_BY_ID[eq]?.capacityPerHour ?? 1000) * 5;
  if (bufferOfLevelSignal(signalId)) return 250;
  const a = HEALTH_BY_ID[eq];
  if (a && name === 'vibration') return a.vib.trip * 4;
  if (a && name === 'temperature') return a.temp.trip * 4;
  if (a && name === 'motor_current') return a.currentRated * 4;
  const v = signalValue(s, signalId).value;
  return (typeof v === 'number' ? Math.abs(v) : 0) * 10 + 1000;
}

/** Value of a signal as frozen / as the reset base at a scenario's start: the snapshot of its asset (process values from the model). */
function valueAtStart(s: SimState, sc: ScenarioActivation, signalId: string): number | string | boolean | null {
  if (PROCESS_SIGNAL_BY_ID[signalId]) return processValue(s, signalId, Math.max(0, sc.start - 1));
  return s.internal.dqSnap[sc.id]?.[signalId]?.value ?? null;
}

type Mask =
  | { kind: 'stale' | 'bad' | 'missing'; note: string; since: number }
  | { kind: 'frozen'; note: string; since: number; value: number | string | boolean | null }
  | { kind: 'spike'; note: string; value: number };

/** Telemetry context of one signal: the scenarios that change what a reader of it sees. */
type Ctx = {
  s: SimState;
  signalId: string;
  equipmentId: string;
  /** Feed-loss windows of the asset (tracked assets only). */
  lost: ScenarioActivation[];
  dq: ScenarioActivation[];
  resets: ScenarioActivation[];
};

/** `feedWindows`: mask the minutes of past feed losses (history); a current read takes the feed status instead. */
function contextOf(s: SimState, signalId: string, feedWindows = true): Ctx {
  const equipmentId = equipmentOf(signalId);
  const lost = feedWindows && s.feeds[equipmentId] ? s.scenarios.filter((sc) => sc.kind === 'signal-loss' && sc.equipmentId === equipmentId) : [];
  const dq = s.scenarios.filter((sc) => affects(sc, signalId) && sc.mode !== 'counter-reset');
  const resets = s.scenarios.filter((sc) => affects(sc, signalId) && sc.mode === 'counter-reset').sort((a, b) => a.start - b.start);
  return { s, signalId, equipmentId, lost, dq, resets };
}

const RANK: Record<string, number> = { gap: 0, frozen: 1, 'bad-quality': 2, spike: 3 };

/** What the scenarios do to the sample of minute t (stale feed first, then gap, frozen, bad quality, spike). */
function maskAt(c: Ctx, t: number): Mask | null {
  for (const sc of c.lost) if (covers(sc, t)) return { kind: 'stale', since: sc.start, note: `Feed stale since ${formatClock(sc.start)} (simulated PLC / gateway link loss)` };
  let best: ScenarioActivation | null = null;
  for (const sc of c.dq) if (covers(sc, t) && (!best || RANK[sc.mode!] < RANK[best.mode!])) best = sc;
  if (!best) return null;
  const at = formatClock(best.start);
  switch (best.mode) {
    case 'gap':
      return { kind: 'missing', since: best.start, note: `No samples since ${at} (simulated data-quality scenario: gap)` };
    case 'frozen':
      return t - best.start >= STALE_AGE_MIN
        ? { kind: 'stale', since: best.start, note: `Value not updating since ${at} (simulated data-quality scenario: frozen value)` }
        : { kind: 'frozen', since: best.start, value: valueAtStart(c.s, best, c.signalId), note: `Value not updating since ${at} (simulated data-quality scenario: frozen value)` };
    case 'bad-quality':
      return { kind: 'bad', since: best.start, note: `Bad quality flag from the source since ${at} (simulated data-quality scenario)` };
    case 'spike':
      return (t - best.start) % SPIKE_EVERY_MIN === 0 ? { kind: 'spike', value: spikeValue(c.s, c.signalId), note: 'Implausible reading outside the engineering range (simulated data-quality scenario: spike)' } : null;
    default:
      return null;
  }
}

/** Counter value after the latest reset at or before t (counters restart from 0; unchanged before any reset). */
function applyReset(c: Ctx, t: number, v: number | null): number | null {
  if (v == null) return v;
  let last: ScenarioActivation | null = null;
  for (const sc of c.resets) if (sc.start <= t) last = sc;
  if (!last) return v;
  const base = valueAtStart(c.s, last, c.signalId);
  return typeof base === 'number' ? Math.max(0, v - base) : v;
}

// ── Current readings ─────────────────────────────────────────────────────────

const unknownSample = (signalId: string): TelemetrySample => ({ signalId, value: null, text: '—', unit: null, quality: 'missing', timestamp: null, status: 'unavailable', note: 'Unknown signal id' });

/** Timestamp of a live reading of a configured signal: the event time for event signals, else the last simulated minute. */
function liveTimestamp(s: SimState, def: SignalDef, now: number): number | null {
  if (def.name === 'gate_event') return s.logistics.gateEvents[s.logistics.gateEvents.length - 1]?.time ?? null;
  if (def.name === 'sample_result') {
    const st = INSPECTION_STATIONS.find((x) => x.equipmentId === def.equipmentId);
    for (let i = s.inspections.length - 1; i >= 0; i--) if (s.inspections[i].stationId === st?.id) return s.inspections[i].time;
    return null;
  }
  return now;
}

/** Current reading of a signal id (configured signal or process signal) as an adapter would deliver it. */
export function readSignal(s: SimState, signalId: string): TelemetrySample {
  const spec = PROCESS_SIGNAL_BY_ID[signalId];
  const def = SIGNAL_DEF[signalId];
  if (!spec && !def) return unknownSample(signalId);
  const unit = spec ? spec.unit : unitOfDef(def);
  if (!spec && PLACEHOLDER_SIGNAL_IDS.has(signalId))
    return { signalId, value: null, text: '—', unit, quality: 'missing', timestamp: null, status: 'not-modelled', note: 'Not modelled: the simulation has no model for this value' };
  const base = { signalId, unit, status: 'simulated' as const };
  // Nothing simulated yet: no reading at all (not a 0 from the initial runtime).
  if (s.minute <= 0) return { ...base, value: null, text: '—', quality: 'missing', timestamp: null, note: 'No value received yet' };
  const now = s.minute - 1;
  const c = contextOf(s, signalId, false);
  const energyNote = def && ENERGY_SIGNALS.has(def.name) ? 'Illustrative energy model (simulated) — no meter connected' : undefined;

  // Stale feed: every signal of the asset as last received, timestamp frozen at the last update.
  const f = s.feeds[c.equipmentId];
  if (f?.status === 'stale') {
    const at = Math.max(0, f.since - 1);
    const last = spec ? null : signalValue(s, signalId);
    const v = spec ? processValue(s, signalId, at) : last!.value;
    return { ...base, value: v, text: last ? last.text : textOf(signalId, v), quality: 'stale', timestamp: at, note: `Feed stale since ${formatClock(f.since)} — last value received` };
  }

  let value: number | string | boolean | null;
  let text: string;
  let timestamp: number | null;
  if (spec) {
    value = processValue(s, signalId, now);
    text = textOf(signalId, value);
    timestamp = now;
  } else {
    const r = signalValue(s, signalId);
    value = r.value;
    text = r.text;
    timestamp = value == null ? null : liveTimestamp(s, def, now);
  }
  if (isCounter(signalId) && typeof value === 'number') {
    const v = applyReset(c, now, value);
    if (v !== value) {
      value = v;
      text = textOf(signalId, v);
    }
  }
  const mask = maskAt(c, now);
  if (mask) {
    if (mask.kind === 'spike') return { ...base, value: mask.value, text: textOf(signalId, mask.value), quality: 'good', timestamp: now, note: mask.note };
    if (mask.kind === 'missing') return { ...base, value: null, text: '—', quality: 'missing', timestamp: mask.since - 1 >= 0 ? mask.since - 1 : null, note: mask.note };
    if (mask.kind === 'bad') return { ...base, value, text, quality: 'bad', timestamp, note: mask.note };
    // Frozen (still young) or frozen long enough to be stale: the value (and display text) and timestamp of its start.
    const sc = c.dq.find((x) => x.mode === 'frozen' && covers(x, now));
    const frozen = sc ? valueAtStart(s, sc, signalId) : null;
    const snapText = sc && !spec ? s.internal.dqSnap[sc.id]?.[signalId]?.text : undefined;
    return { ...base, value: frozen, text: snapText ?? textOf(signalId, frozen), quality: mask.kind === 'frozen' ? 'good' : 'stale', timestamp: Math.max(0, mask.since - 1), note: mask.note };
  }
  if (value == null) {
    // A process value with nothing to report (machine stopped / no stroke) is a good sample without a value.
    if (spec) return { ...base, value: null, text: '—', quality: 'good', timestamp, note: 'No value: the machine is not producing' };
    return { ...base, value: null, text: '—', quality: 'missing', timestamp: null, note: 'No value received yet' };
  }
  return { ...base, value, text, quality: 'good', timestamp, note: energyNote };
}

// ── History ──────────────────────────────────────────────────────────────────

/** Where the numeric history of a signal comes from. */
type Source = {
  /** Value of minute t (null = no value that minute); undefined when the source has no minute data. */
  minute?: (t: number) => number | null;
  /** First minute the minute data covers. */
  minuteFrom: number;
  minuteLabel: string;
  /** Hourly value of hour h: the mean over the hour, or the value at its end for counters. */
  hour: (h: number) => number | null;
  hourLabel: string;
  /** Counters and commands: a step aggregates to its last value, not its mean. */
  last: boolean;
  /** Why minute data is not available (energy model: hourly totals only). */
  minuteNote?: string;
};

/** Minutes simulated in hour h (60 for past hours, fewer for the current one). */
const minutesIn = (s: SimState, h: number) => Math.max(0, Math.min(60, s.minute - h * 60));

/** Cumulative per-hour sums: value through hour h (inclusive) of `valueOf(h)` over the hours present in `hours`. */
function cumulative(hours: Iterable<number>, valueOf: (h: number) => number): (h: number) => number {
  const keys = [...hours].sort((a, b) => a - b);
  const cum: number[] = [];
  let run = 0;
  for (const k of keys) cum.push((run += valueOf(k)));
  return (h) => {
    let lo = 0;
    let hi = keys.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= h) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return at >= 0 ? cum[at] : 0;
  };
}

/**
 * A counter at every minute the logs hold, computed backwards from its current total: value after minute t =
 * total − the per-minute increments after t (exact wherever the log covers, whatever the minute of the hour).
 */
function backwardCounter(s: SimState, from: number, total: number, perMinute: (m: number) => number | null): (t: number) => number | null {
  const now = s.minute - 1;
  const n = now - from + 1;
  if (n <= 0) return () => null;
  const after = new Float64Array(n);
  let run = total;
  let k = n - 1;
  for (; k >= 0; k--) {
    after[k] = run;
    const inc = perMinute(from + k);
    if (inc == null) break;
    run -= inc;
  }
  const valid = k + 1;
  return (t) => (t < from + valid || t > now ? null : Math.max(0, after[t - from]));
}

/** Means of a minute function at four points of hour h (every 15 min), over the simulated minutes. */
function hourMean(s: SimState, h: number, fn: (t: number) => number | null): number | null {
  let sum = 0;
  let n = 0;
  for (const k of [7, 22, 37, 52]) {
    const t = h * 60 + k;
    if (t < 0 || t > s.minute - 1) continue;
    const v = fn(t);
    if (v == null) continue;
    sum += v;
    n++;
  }
  return n ? sum / n : null;
}

const hourEnd = (s: SimState, h: number) => Math.min(h * 60 + 59, s.minute - 1);

function processSource(s: SimState, spec: ProcessSignalSpec): Source {
  const num = (t: number) => {
    const v = processValue(s, spec.id, t);
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  };
  const last = spec.role === 'command' || spec.id.endsWith('_count');
  return {
    minute: num,
    minuteFrom: 0,
    minuteLabel: 'process model',
    hour: (h) => (last ? (hourEnd(s, h) >= h * 60 ? num(hourEnd(s, h)) : null) : hourMean(s, h, num)),
    hourLabel: 'process model (hourly mean)',
    last,
  };
}

/** Cumulative station counters (count_inspected / count_rejected / count_good) after minute t, from the quality log. */
function stationSource(s: SimState, def: SignalDef): Source {
  const station = INSPECTION_STATIONS.find((x) => x.equipmentId === def.equipmentId);
  const good = def.name === 'count_good';
  // Every tile passes the gauge and the vision tunnel: good = inspected − rejected at both (= line good output).
  const countOf = (q: Record<string, { inspected: number; rejected: number }>) =>
    good ? q['ST-VIS'].inspected - q['ST-VIS'].rejected - q['ST-GAUGE'].rejected : def.name === 'count_inspected' ? q[station!.id].inspected : q[station!.id].rejected;
  const through = cumulative(s.quality.keys(), (h) => countOf(s.quality.get(h)!));
  const defects = station ? DEFECT_ORDER.filter((d) => DEFECTS[d].station === station.id) : [];
  const L = s.qualityLog;
  const perMinute = (m: number) => {
    const i = m % LOG_MIN;
    if (L.t[i] !== m) return 0; // nothing inspected that minute
    if (good) return L.inspected[i] - L.rejected[i];
    if (def.name === 'count_inspected') return L.inspected[i];
    return defects.reduce((a, d) => a + L.defect[d][i], 0);
  };
  const minuteFrom = Math.max(0, s.minute - LOG_MIN);
  const atMinute = backwardCounter(s, minuteFrom, through(Math.floor((s.minute - 1) / 60)), perMinute);
  return {
    minute: atMinute,
    minuteFrom,
    minuteLabel: 'quality log (per minute)',
    hour: (h) => (h * 60 <= s.minute - 1 ? through(h) : null),
    hourLabel: 'hourly quality counters',
    last: true,
  };
}

function energySource(s: SimState, def: SignalDef): Source {
  const note = 'The energy model keeps hourly totals only';
  if (def.name === 'energy_kwh') {
    const map = s.energy[def.equipmentId];
    const through = map ? cumulative(map.keys(), (h) => map.get(h)!.elec + map.get(h)!.thermal) : () => 0;
    return { minuteFrom: Infinity, minuteLabel: 'energy model', minuteNote: note, hour: (h) => (map?.has(h) ? through(h) : null), hourLabel: 'energy model (hourly totals)', last: true };
  }
  // Mean power over the hour (kW), or gas flow at ~10.5 kWh/Nm³ (as the live reading).
  const ids = def.equipmentId === 'A-COMP' ? ['A-COMP'] : CONSUMERS.map((x) => x.id);
  const key = def.name === 'gas_flow' ? 'thermal' : 'elec';
  return {
    minuteFrom: Infinity,
    minuteLabel: 'energy model',
    minuteNote: note,
    hour: (h) => {
      const min = minutesIn(s, h);
      let kwh = 0;
      let any = false;
      for (const id of ids) {
        const b = s.energy[id]?.get(h);
        if (!b) continue;
        kwh += b[key];
        any = true;
      }
      if (!any || !min) return null;
      const kw = (kwh * 60) / min;
      return def.name === 'gas_flow' ? kw / 10.5 : kw;
    },
    hourLabel: 'energy model (hourly mean)',
    last: false,
  };
}

/** History source of a configured signal; null when it has no numeric history (states, events, not-modelled values). */
function signalSource(s: SimState, def: SignalDef): Source | null {
  if (PLACEHOLDER_SIGNAL_IDS.has(def.id)) return null;
  const id = def.equipmentId;
  const logFrom = Math.max(0, s.minute - LOG_MIN);
  const inLog = (t: number) => t >= logFrom && t <= s.minute - 1;
  const bucket = (h: number) => s.hours[id]?.get(h);
  // Buffer levels: `<equipmentId>.level` and the hosted level signals of the buffers without equipment.
  const b = bufferOfLevelSignal(def.id);
  if (b) {
    const log = s.bufferLog[b.id];
    return {
      minute: (t) => {
        if (!inLog(t)) return null;
        const i = t % LOG_MIN;
        return log.t[i] === t ? (log.level[i] / b.capacity) * 100 : null;
      },
      minuteFrom: logFrom,
      minuteLabel: 'buffer log',
      hour: (h) => {
        const v = s.bufferHours[b.id]?.get(h);
        return v == null ? null : v * 100;
      },
      hourLabel: 'hourly buffer averages',
      last: false,
    };
  }
  switch (def.name) {
    case 'rate':
      return {
        minute: (t) => {
          const x = inLog(t) ? minuteAt(s, id, t) : null;
          return x ? x.rate * 60 : null;
        },
        minuteFrom: logFrom,
        minuteLabel: 'minute log',
        hour: (h) => {
          const b = bucket(h);
          const min = minutesIn(s, h);
          return b && min ? (b.count / min) * 60 : null;
        },
        hourLabel: 'hourly buckets (mean rate)',
        last: false,
      };
    case 'count_total':
    case 'tile_count': {
      const map = s.hours[id];
      if (!map) return null;
      const through = cumulative(map.keys(), (h) => map.get(h)!.count);
      const atMinute = backwardCounter(s, logFrom, s.machines[id]?.countTotal ?? 0, (m) => minuteAt(s, id, m)?.rate ?? null);
      return {
        minute: atMinute,
        minuteFrom: logFrom,
        minuteLabel: 'minute log (counter)',
        hour: (h) => (map.has(h) ? through(h) : null),
        hourLabel: 'hourly buckets (counter)',
        last: true,
      };
    }
    case 'speed': {
      const c = CONVEYOR_BY_ID[id];
      if (!c) return null;
      return {
        minute: (t) => {
          if (!inLog(t)) return null;
          const x = minuteAt(s, id, t);
          return x ? (x.state === 'down' ? 0 : conveyorSpeed(s.seed, id, t + 1)) : null;
        },
        minuteFrom: logFrom,
        minuteLabel: 'minute log',
        hour: (h) => {
          const b = bucket(h);
          return b && b.planned > 0 ? (c.speedMpm * (b.planned - b.down)) / b.planned : null;
        },
        hourLabel: 'hourly buckets (running share × nominal speed)',
        last: false,
      };
    }
    case 'vibration':
    case 'temperature':
    case 'motor_current': {
      if (!HEALTH_BY_ID[id]) return null;
      const fn = (t: number) => {
        const r = sensorsAt(s, id, t);
        return r ? (def.name === 'vibration' ? r.vibration : def.name === 'temperature' ? r.temperature : r.current) : null;
      };
      return { minute: fn, minuteFrom: 0, minuteLabel: 'condition model', hour: (h) => hourMean(s, h, fn), hourLabel: 'condition model (hourly mean)', last: false };
    }
    case 'count_inspected':
    case 'count_rejected':
    case 'count_good':
      return stationSource(s, def);
    case 'energy_kwh':
    case 'active_power':
    case 'gas_flow':
      return energySource(s, def);
    default:
      // States, alarms, events, dock occupancy and vehicle zones keep no numeric history (see stateTimeline).
      return null;
  }
}

type Grid = { t: number[]; stepMin: number; resolution: 'minute' | 'hour' };

/** n grid points from `from` every `step` minutes (a plain loop: Array.from with a mapper is several times slower). */
function steps(from: number, step: number, n: number): number[] {
  const t = new Array<number>(n);
  for (let i = 0; i < n; i++) t[i] = from + i * step;
  return t;
}

function gridOf(s: SimState, range: RangeKey | { from: number; to: number; stepMin: number }): Grid {
  if (typeof range === 'string') {
    const r = RANGE_BY_KEY[range];
    if (r.resolution === 'hour') {
      // Whole hours ending with the current (partial) one, aligned with the hourly buckets.
      const n = Math.round(r.minutes / 60);
      const lastHour = Math.floor((s.minute - 1) / 60);
      return { t: steps((lastHour - n + 1) * 60, 60, n), stepMin: 60, resolution: 'hour' };
    }
    const n = Math.round(r.minutes / r.stepMin);
    const from = s.minute - r.minutes;
    return { t: steps(from, r.stepMin, n), stepMin: r.stepMin, resolution: 'minute' };
  }
  const step = Math.max(1, Math.round(range.stepMin));
  const n = Math.max(0, Math.ceil((range.to - range.from) / step));
  const hourly = step % 60 === 0 && range.from % 60 === 0;
  return { t: steps(range.from, step, n), stepMin: step, resolution: hourly ? 'hour' : 'minute' };

}

const QUALITY_RANK: Record<Quality, number> = { good: 0, uncertain: 1, bad: 2, stale: 3, missing: 4 };

/**
 * History of a numeric signal over a chart range (RANGE_OPTIONS) or an explicit window: minute data for
 * 15 min / 1 h, 5-min steps of minute data for 8 h, hourly for 24 h / 7 d. Null when the signal has no
 * numeric history at all (states, events, not-modelled values, unknown ids). Bad, stale or missing samples
 * are null with their quality; samples after the last simulated minute are not part of the coverage.
 */
function computeSeries(s: SimState, signalId: string, range: RangeKey | { from: number; to: number; stepMin: number }): TelemetrySeries | null {
  const spec = PROCESS_SIGNAL_BY_ID[signalId];
  const def = SIGNAL_DEF[signalId];
  const src = spec ? processSource(s, spec) : def ? signalSource(s, def) : null;
  if (!src) return null;
  const unit = spec ? spec.unit : unitOfDef(def);
  const g = gridOf(s, range);
  const c = contextOf(s, signalId);
  const counter = isCounter(signalId);
  const v: (number | null)[] = [];
  const q: Quality[] = [];
  let expected = 0;
  let present = 0;
  let beforeCoverage = false;
  let maskNote: string | undefined;
  const now = s.minute - 1;

  /** One minute's sample after the scenarios: [value, quality]. */
  const minuteSample = (t: number): [number | null, Quality] => {
    if (!src.minute || t < src.minuteFrom) {
      beforeCoverage = true;
      return [null, 'missing'];
    }
    let x = src.minute(t);
    if (counter) x = applyReset(c, t, x);
    const m = maskAt(c, t);
    if (m) {
      maskNote ??= m.note;
      if (m.kind === 'spike') return [m.value, 'good'];
      if (m.kind === 'frozen') return [typeof m.value === 'boolean' ? (m.value ? 1 : 0) : typeof m.value === 'number' ? m.value : null, 'good'];
      return [null, m.kind];
    }
    return [x, x == null ? 'missing' : 'good'];
  };

  for (const t0 of g.t) {
    const t1 = t0 + g.stepMin;
    if (t0 > now || t1 <= 0) {
      v.push(null);
      q.push('missing');
      continue;
    }
    expected++;
    let value: number | null = null;
    let quality: Quality = 'missing';
    if (g.resolution === 'hour') {
      // Hourly aggregates; a stale / bad / missing window over the hour's sample points masks or flags it.
      const hours: number[] = [];
      for (let h = Math.floor(t0 / 60); h * 60 < t1; h++) if (h * 60 <= now && h >= 0) hours.push(h);
      const vals = hours.map((h) => {
        const x = src.hour(h);
        return counter ? applyReset(c, hourEnd(s, h), x) : x;
      });
      const usable = vals.filter((x): x is number => x != null);
      if (usable.length) value = src.last ? usable[usable.length - 1] : usable.reduce((a, b) => a + b, 0) / usable.length;
      let masked = 0;
      let points = 0;
      let worst: Quality = 'good';
      for (const h of hours)
        for (const k of [7, 22, 37, 52]) {
          const t = h * 60 + k;
          if (t > now) continue;
          points++;
          const m = maskAt(c, t);
          if (m && m.kind !== 'spike' && m.kind !== 'frozen') {
            masked++;
            maskNote ??= m.note;
            if (QUALITY_RANK[m.kind] > QUALITY_RANK[worst]) worst = m.kind;
          }
        }
      if (points && masked === points) {
        value = null;
        quality = worst;
      } else quality = value == null ? 'missing' : masked ? 'uncertain' : 'good';
    } else {
      const xs: number[] = [];
      let worst: Quality = 'good';
      let bad = 0;
      let lastVal: number | null = null;
      for (let t = Math.max(0, t0); t < t1 && t <= now; t++) {
        const [x, qq] = minuteSample(t);
        if (x != null) {
          xs.push(x);
          lastVal = x;
        } else {
          bad++;
          if (QUALITY_RANK[qq] > QUALITY_RANK[worst]) worst = qq;
        }
      }
      if (xs.length) {
        value = src.last ? lastVal : xs.reduce((a, b) => a + b, 0) / xs.length;
        quality = bad ? 'uncertain' : 'good';
      } else quality = worst === 'good' ? 'missing' : worst;
    }
    if (value != null) present++;
    v.push(value);
    q.push(quality);
  }
  const notes: string[] = [];
  if (g.resolution === 'minute' && beforeCoverage)
    notes.push(src.minuteNote ?? `Minute history covers the last ${LOG_MIN / 60} h (${src.minuteLabel}); older minutes are not kept`);
  if (maskNote) notes.push(maskNote);
  return {
    signalId,
    t: g.t,
    v,
    q,
    stepMin: g.stepMin,
    unit,
    resolution: g.resolution,
    source: g.resolution === 'hour' ? src.hourLabel : src.minuteLabel,
    status: 'simulated',
    coverage: { expected, present },
    ...(notes.length ? { note: notes.join('. ') } : {}),
  };
}

// ── State timelines ──────────────────────────────────────────────────────────

/**
 * State intervals of a tracked asset (process machine or conveyor) over [from, to), contiguous and clipped
 * to the simulated minutes: 'unknown' while its feed was stale or a data-quality scenario left its state signal
 * without valid samples (gap, bad quality, frozen past the stale age); own stops as planned / changeover / fault /
 * stopped (reason code and label kept); inside the minute log its logged state (a conveyor running empty is
 * 'idle'); beyond the log starved / blocked spells from their records and 'running' otherwise (a reduced rate
 * and spells under 3 min are not recorded there — said in the label). Empty for assets without a state signal.
 */
function computeStateTimeline(s: SimState, equipmentId: string, window: { from: number; to: number }): EquipmentStateSegment[] {
  if (!s.machines[equipmentId]) return [];
  const from = Math.max(0, Math.floor(window.from));
  const to = Math.min(s.minute, Math.ceil(window.to));
  if (to <= from) return [];
  const conv = !!CONVEYOR_BY_ID[equipmentId];
  const logFrom = s.minute - LOG_MIN;
  const historyFrom = s.minute - RECORD_HISTORY_MIN;
  const lost = s.feeds[equipmentId] ? s.scenarios.filter((sc) => sc.kind === 'signal-loss' && sc.equipmentId === equipmentId) : [];
  // Data-quality scenarios on the state signal: no samples, a bad flag or a value frozen past the stale age → state unknown.
  const stateSignal = contextOf(s, `${equipmentId}.${conv ? 'run_state' : 'state'}`, false);
  const flow = s.downtime
    .filter((d) => d.equipmentId === equipmentId && (d.category === 'Starved' || d.category === 'Blocked') && d.start < to && (d.end ?? s.minute) > from)
    .sort((a, b) => a.start - b.start);
  const out: EquipmentStateSegment[] = [];
  let fi = 0;
  for (let t = from; t < to; t++) {
    let state: OperationalState;
    let label: string | undefined;
    let reason: string | undefined;
    const stop = stopAt(s, equipmentId, t);
    const dq = stateSignal.dq.length ? maskAt(stateSignal, t) : null;
    if (lost.some((sc) => covers(sc, t))) {
      state = 'unknown';
      label = 'Data feed stale';
    } else if (dq && (dq.kind === 'missing' || dq.kind === 'bad' || dq.kind === 'stale')) {
      state = 'unknown';
      label = dq.note;
    } else if (stop) {
      state = stopState(stop.reasonCode);
      label = REASON_BY_CODE[stop.reasonCode]?.label;
      reason = stop.reasonCode;
    } else if (t >= logFrom) {
      const x = minuteAt(s, equipmentId, t);
      if (!x) {
        state = 'unknown';
        label = 'Not logged';
      } else if (conv) state = x.state === 'starved' ? 'idle' : x.state === 'blocked' ? 'blocked' : 'running';
      else state = x.state === 'down' ? 'stopped' : x.state === 'planned' ? 'planned' : x.state;
    } else if (t < historyFrom) {
      state = 'unknown';
      label = 'No state history kept';
    } else {
      while (fi < flow.length && (flow[fi].end ?? s.minute) <= t) fi++;
      const d = fi < flow.length && flow[fi].start <= t ? flow[fi] : null;
      if (d) state = d.category === 'Starved' ? (conv ? 'idle' : 'starved') : 'blocked';
      else {
        state = 'running';
        label = 'Running (from stop records; reduced rate and short waits are not recorded beyond the minute log)';
      }
    }
    const last = out[out.length - 1];
    if (last && last.state === state && last.label === label && last.reason === reason && last.to === t) last.to = t + 1;
    else out.push({ from: t, to: t + 1, state, ...(label ? { label } : {}), ...(reason ? { reason } : {}) });
  }
  return out;
}

// ── Shared per minute ────────────────────────────────────────────────────────

// The same history or state timeline is asked for by several surfaces each simulated minute (the rule engine's plant /
// stage / equipment passes, the equipment panel's charts and tiles): computed once per state, minute and version
// (src/sim/memo.ts). Results are shared — read-only. Current readings are cheap and not memoised (they follow any
// change of the state at once, also one made without a version bump: readSignal above).
const seriesMemo = minuteMemo(computeSeries, (signalId: string, range: RangeKey | { from: number; to: number; stepMin: number }) =>
  typeof range === 'string' ? `${signalId}|${range}` : `${signalId}|${range.from}|${range.to}|${range.stepMin}`,
);
const timelineMemo = minuteMemo(computeStateTimeline, (equipmentId: string, window: { from: number; to: number }) => `${equipmentId}|${window.from}|${window.to}`);

/** History of a numeric signal over a chart range or an explicit window (see computeSeries). */
export function seriesOf(s: SimState, signalId: string, range: RangeKey | { from: number; to: number; stepMin: number }): TelemetrySeries | null {
  return seriesMemo(s, signalId, range);
}

/** State intervals of a tracked asset over [from, to) (see computeStateTimeline). */
export function stateTimeline(s: SimState, equipmentId: string, window: { from: number; to: number }): EquipmentStateSegment[] {
  return timelineMemo(s, equipmentId, window);
}

// ── The adapter ──────────────────────────────────────────────────────────────

/** The demo's telemetry source: every consumer reads simulated telemetry through this (kind 'simulated'). */
export const simulatedSource: TelemetrySource<SimState> = {
  kind: 'simulated',
  read: readSignal,
  series: (s, signalId, window) => seriesOf(s, signalId, window),
  states: stateTimeline,
};
