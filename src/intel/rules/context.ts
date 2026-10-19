/**
 * What a rule reads (brief §7 / §12): the evaluation context. Signal values, history and state timelines come
 * through the TelemetrySource adapter (the demo's `simulatedSource` by default — every value simulated); records
 * the adapter boundary does not carry yet (stop records, inspection records, quality counts, operational events,
 * scenario log) come from the simulation state through the helpers below. Every read is memoised per context, so
 * rules that share a signal over the same window read it once per evaluation.
 */
import { seriesToSamples, type Sample, type StopRecord, type Window } from '../../calc';
import { definitionOf, type SignalDefinition } from '../../model/catalog';
import { DEFECT_ORDER, DEFECTS, INSPECTION_STATIONS, OPS_BY_ID, REASON_BY_CODE } from '../../model/plant';
import { RANGE_BY_KEY, type EquipmentStateSegment, type RangeKey, type TelemetrySample, type TelemetrySeries, type TelemetrySource } from '../../model/telemetry';
import type { DefectCategory, DowntimeCategory, OpEvent, ProductionBatch, QualityInspection, RecordSource, ScenarioActivation } from '../../model/types';
import { LOG_MIN, batchAt, type SimState } from '../../sim/engine';
import { eventsFor } from '../../sim/events';
import { qualityIn } from '../../sim/metrics';
import { simulatedSource } from '../../sim/telemetry';
import { formatClock } from '../../sim/time';
import { paramOf } from './thresholds';

/** A window for history reads: a chart range, or minutes [from, to) with a step (default 1 min). */
export type SeriesRange = RangeKey | { from: number; to: number; stepMin?: number };

/** A stop of an equipment item as reliability / production rules need it (StopRecord + where it came from). */
export type RuleStop = StopRecord & {
  downtimeId: string;
  /** planned stop, product changeover, unplanned stop; starved / blocked spells only with includeFlow. */
  kind: 'planned' | 'changeover' | 'down' | 'starved' | 'blocked';
  category: DowntimeCategory;
  source: RecordSource;
  scenarioId?: string;
};

/** Inspection counts over a window (line: every tile passes the gauge and the vision tunnel). */
export type QualityCounts = {
  /** The window the counts cover (whole hours when read from the hourly buckets). */
  window: Window;
  resolution: 'minute' | 'hour';
  /** Tiles inspected (vision tunnel). */
  inspected: number;
  /** Rejected tiles: gauge + vision, or of the requested defect / station. */
  rejected: number;
  byDefect: Record<DefectCategory, number>;
  /** Minutes (or hours) with records vs the minutes (hours) of the window. */
  coverage: { expected: number; present: number };
  note?: string;
};

export type RuleContext = {
  s: SimState;
  /** Evaluation minute: the plant clock (s.minute). Windows end here: [now − W, now) are the last W simulated minutes. */
  now: number;
  source: TelemetrySource<SimState>;
  /** Threshold overrides in force ('RULE.param', 'RULE.param@EQUIPMENT'). */
  values: Record<string, number>;
  /** The value in force of a rule parameter (override → mirrored event rule → default). */
  param(ruleId: string, key: string, equipmentId?: string | null): number;
  /** Current reading with its catalogue definition (null when the catalogue does not know the id). */
  read(signalId: string): TelemetrySample & { def: SignalDefinition | null };
  /** History over a range (null when the signal has no numeric history). */
  series(signalId: string, range: SeriesRange): TelemetrySeries | null;
  /** The same history as calc samples (bad / stale / missing samples keep their quality and a null value). */
  samples(signalId: string, range: SeriesRange): Sample[];
  /** State intervals of a tracked asset over a window. */
  states(equipmentId: string, window: Window): EquipmentStateSegment[];
  /** Own stops overlapping the window, oldest first, with reason labels. */
  stops(equipmentId: string, window: Window, opts?: { includeFlow?: boolean }): RuleStop[];
  /** Inspection counts of the line over a window (minute log when it covers the window, else hourly buckets). */
  quality(window: Window, opts?: { defect?: DefectCategory; stationId?: string }): QualityCounts;
  /** Inspection records in the window (newest last), optionally of one station / defect / batch. */
  inspections(window: Window, opts?: { stationId?: string; defect?: DefectCategory; batchId?: string }): QualityInspection[];
  /** The production batch pressed at minute t (batch ids follow the tiles to sorting). */
  batchAt(t: number): ProductionBatch;
  /** Operational events of an equipment item (or all) that overlap the window (default: the minute log), newest first. */
  events(equipmentId?: string | null, window?: Window): OpEvent[];
  /** Simulated scenarios acting on the equipment item that overlap the window (default: active now). */
  scenarios(equipmentId: string, window?: Window | null): ScenarioActivation[];
  /** [now − minutes, now). */
  window(minutes: number): Window;
};

export type ContextOptions = {
  /** Telemetry adapter (default: the demo's simulated source). */
  source?: TelemetrySource<SimState>;
  /** Threshold overrides (default: none — findingsFor passes the thresholds store's values). */
  values?: Record<string, number>;
};

/** The window of a chart range ending at `now` (aligned with src/sim/telemetry.ts for the simulated source). */
export function rangeWindow(range: SeriesRange, now: number): { from: number; to: number; stepMin: number } {
  if (typeof range !== 'string') return { from: range.from, to: range.to, stepMin: Math.max(1, Math.round(range.stepMin ?? 1)) };
  const r = RANGE_BY_KEY[range];
  if (r.resolution === 'hour') {
    const n = Math.round(r.minutes / 60);
    const lastHour = Math.floor((now - 1) / 60);
    return { from: (lastHour - n + 1) * 60, to: (lastHour + 1) * 60, stepMin: 60 };
  }
  return { from: now - r.minutes, to: now, stepMin: r.stepMin };
}

const overlaps = (from: number, to: number | null, w: Window) => from < w.to && (to ?? Infinity) > w.from;

/** Whether a scenario acts on an equipment item: named on it, on its process stage, or on one of its signals. */
function touches(sc: ScenarioActivation, equipmentId: string): boolean {
  if (sc.equipmentId === equipmentId) return true;
  if (sc.signalId && sc.signalId.startsWith(`${equipmentId}.`)) return true;
  const stage = OPS_BY_ID[equipmentId]?.stage;
  return !!stage && sc.stage === stage;
}

const EMPTY_DEFECTS = () => Object.fromEntries(DEFECT_ORDER.map((d) => [d, 0])) as Record<DefectCategory, number>;

/** Builds the evaluation context of one simulation state. */
export function buildContext(s: SimState, opts: ContextOptions = {}): RuleContext {
  const source = opts.source ?? simulatedSource;
  const values = opts.values ?? {};
  const now = s.minute;
  const reads = new Map<string, TelemetrySample & { def: SignalDefinition | null }>();
  const series = new Map<string, TelemetrySeries | null>();
  const samples = new Map<string, Sample[]>();
  const states = new Map<string, EquipmentStateSegment[]>();

  const seriesOf = (signalId: string, range: SeriesRange) => {
    const w = rangeWindow(range, now);
    const k = `${signalId}|${w.from}|${w.to}|${w.stepMin}`;
    if (!series.has(k)) series.set(k, source.series(s, signalId, w));
    return { k, x: series.get(k)! };
  };

  const ctx: RuleContext = {
    s,
    now,
    source,
    values,
    param: (ruleId, key, equipmentId) => paramOf(values, ruleId, key, equipmentId, s.rules),
    read: (signalId) => {
      let r = reads.get(signalId);
      if (!r) reads.set(signalId, (r = { ...source.read(s, signalId), def: definitionOf(signalId) }));
      return r;
    },
    series: (signalId, range) => seriesOf(signalId, range).x,
    samples: (signalId, range) => {
      const { k, x } = seriesOf(signalId, range);
      let out = samples.get(k);
      if (!out) samples.set(k, (out = x ? seriesToSamples(x, x.t[0] ?? rangeWindow(range, now).from) : []));
      return out;
    },
    states: (equipmentId, window) => {
      const k = `${equipmentId}|${window.from}|${window.to}`;
      let out = states.get(k);
      if (!out) states.set(k, (out = source.states(s, equipmentId, window)));
      return out;
    },
    stops: (equipmentId, window, o = {}) => {
      const out: RuleStop[] = [];
      for (const d of s.downtime) {
        if (d.equipmentId !== equipmentId || !overlaps(d.start, d.end, window)) continue;
        const flow = d.category === 'Starved' || d.category === 'Blocked';
        if (flow && !o.includeFlow) continue;
        const reason = REASON_BY_CODE[d.reasonCode];
        const kind: RuleStop['kind'] = flow ? (d.category === 'Starved' ? 'starved' : 'blocked') : reason?.planned ? 'planned' : d.reasonCode === 'CHG_PRODUCT' ? 'changeover' : 'down';
        out.push({
          start: d.start,
          end: d.end,
          equipmentId,
          reasonCode: d.reasonCode,
          reasonLabel: reason?.label ?? d.reasonCode,
          // Planned stops and product changeovers are not failures (calc recurrence / MTBF leave them out).
          planned: kind !== 'down',
          downtimeId: d.id,
          kind,
          category: d.category,
          source: d.source,
          ...(d.scenarioId ? { scenarioId: d.scenarioId } : {}),
        });
      }
      return out.sort((a, b) => a.start - b.start);
    },
    quality: (window, o = {}) => {
      const from = Math.max(0, Math.floor(window.from));
      const to = Math.min(now, Math.ceil(window.to));
      const byDefect = EMPTY_DEFECTS();
      const station = o.stationId ? INSPECTION_STATIONS.find((x) => x.id === o.stationId) : undefined;
      const counts = (d: DefectCategory) => (!o.defect || o.defect === d) && (!station || DEFECTS[d].station === station.id);
      if (to <= from) return { window: { from, to: Math.max(from, to) }, resolution: 'minute', inspected: 0, rejected: 0, byDefect, coverage: { expected: 0, present: 0 }, note: 'Empty window' };
      if (from >= now - LOG_MIN) {
        const L = s.qualityLog;
        let inspected = 0;
        let present = 0;
        for (let m = from; m < to; m++) {
          const i = m % LOG_MIN;
          if (L.t[i] !== m) continue;
          present++;
          inspected += L.inspected[i];
          for (const d of DEFECT_ORDER) byDefect[d] += L.defect[d][i];
        }
        const rejected = DEFECT_ORDER.reduce((a, d) => a + (counts(d) ? byDefect[d] : 0), 0);
        return { window: { from, to }, resolution: 'minute', inspected, rejected, byDefect, coverage: { expected: to - from, present } };
      }
      // Beyond the minute log: whole hourly buckets.
      const h0 = Math.floor(from / 60);
      const h1 = Math.ceil(to / 60);
      const q = qualityIn(s, { from: h0 * 60, to, label: '' });
      for (const d of DEFECT_ORDER) byDefect[d] = q.byDefect[d];
      let present = 0;
      for (let h = h0; h < h1; h++) if (s.quality.has(h)) present++;
      const rejected = o.defect || station ? DEFECT_ORDER.reduce((a, d) => a + (counts(d) ? byDefect[d] : 0), 0) : q.rejected;
      return {
        window: { from: h0 * 60, to: Math.min(now, h1 * 60) },
        resolution: 'hour',
        inspected: q.inspected,
        rejected,
        byDefect,
        coverage: { expected: h1 - h0, present },
        // Plant minute 0 is 06:00 (src/sim/time): the clock of an hour comes from the formatter, not from h0 % 24.
        note: `Hourly inspection buckets (whole hours from ${formatClock(h0 * 60)}); minute counts cover the last ${LOG_MIN / 60} h`,
      };
    },
    inspections: (window, o = {}) =>
      s.inspections.filter(
        (r) =>
          r.time >= window.from &&
          r.time < window.to &&
          (!o.stationId || r.stationId === o.stationId) &&
          (!o.defect || r.defect === o.defect) &&
          (!o.batchId || r.batchId === o.batchId),
      ),
    batchAt: (t) => batchAt(s, t),
    events: (equipmentId, window) => {
      const w = window ?? { from: now - LOG_MIN, to: now };
      return eventsFor(s, { equipmentId: equipmentId ?? undefined, from: w.from, to: w.to, includeHistorical: true }).sort((a, b) => b.start - a.start);
    },
    scenarios: (equipmentId, window) => {
      const w = window ?? { from: now - 1, to: now };
      return s.scenarios.filter((sc) => touches(sc, equipmentId) && overlaps(sc.start, sc.end, w));
    },
    window: (minutes) => ({ from: now - minutes, to: now }),
  };
  return ctx;
}
