/**
 * Intelligence profiles: what the equipment intelligence panel shows for each kind of asset and
 * production stage — the facets, the order and wording of the PLC-style signal rows, the insight
 * rules evaluated, the analytics computed, and the parameters an operator would expect that the
 * model does not contain. The derivation (./derive.ts) reads only this configuration; there is no
 * per-machine code path and no value is configured here (every figure comes from the simulation).
 *
 * Profiles are resolved from the asset profile (src/ui/equipment/profile.ts): a base per asset kind,
 * refined per process stage for process machines (and for the conveyor feeding a stage).
 */
import type { StageId } from '../../../model/types';
import { BUFFER_LEVEL_BAND } from '../kpis';
import type { AssetKind, AssetProfile } from '../profile';
import type { FacetKey } from './types';

/** Insight rules (PANEL_SPEC "what matters"), evaluated in this order of priority. */
export type InsightRuleId =
  /** 7 · the asset's own data feed is stale (values are last received). */
  | 'stale'
  /** 7b · a figure of the panel rests on another asset's stale feed (neighbour of a buffer, the sorting line for a station). */
  | 'neighbour-stale'
  /** 1 · an active root event record on the asset (stop, fault, below rate, conveyor stop, quality, logistics). */
  | 'event'
  /** A planned stop / changeover / maintenance in progress (not a fault, excluded from plan time). */
  | 'planned'
  /** 2 · starved / blocked now or > 5 % of the last 60 min (minute log). */
  | 'flow'
  /** 3 · rule-based condition level ≥ watch (vibration vs expected, trend, ETA). */
  | 'condition'
  /** 4 · running below its own set rate while not starved / blocked ('reduced'). */
  | 'rate'
  /** 5 · the constraint claim names the asset's stage as currently constraining output. */
  | 'role'
  /** 6 · rejects attributed to the stage this shift above its 24 h rate (machines), or the station's reject rate. */
  | 'quality'
  /** Buffer level: runs empty / fills within the hour, or nearly empty / full. */
  | 'buffer'
  /** Yard, docks and forklifts: queue, overstay, waiting against the configured limits. */
  | 'logistics'
  /** Vehicles: visit progress against the waiting / dock / turnaround limits, idle share. */
  | 'vehicle'
  /** 8 · nothing above applies and the data shows normal operation: one positive insight with the evidence. */
  | 'normal';

export type AnalyticsSpec = {
  /** State timeline + time in state over the minute log. */
  timeline: boolean;
  /** Rate trend reference: the asset's ideal rate, a conveyor's nominal capacity, or none. */
  rate: 'ideal' | 'capacity' | null;
  /** Stoppage statistics (shift, MTBF / MTTR). */
  stops: boolean;
  /** Output not made at the ideal rate in the shift. */
  loss: boolean;
};

export type IntelProfile = {
  /** Profile key, e.g. "machine:KILN", "conveyor", "buffer". */
  key: string;
  facets: FacetKey[];
  rules: InsightRuleId[];
  /** Null: no analytics (no minute log for the asset). */
  analytics: AnalyticsSpec | null;
  /** Signal names (src/model/plant.ts SIGNALS `name`) in display order; any other signal of the asset follows. */
  signalOrder: string[];
  /** Human labels per signal name ("Vibration" / "Temperature" get the monitored component appended). */
  signalLabels: Record<string, string>;
  /** Parameters an operator would expect for this asset that the model does not contain (shown as one muted line). */
  notModelled: { label: string; reason: string }[];
  /** The asset's output in words, for sentences ("tiles fired", "slip (tile-equivalents)"). */
  output: { noun: string; equivalent: boolean };
};

/** Display order of the PLC-style rows: state, rate, alarm, condition, conveyor, buffer, inspection, counters. */
export const SIGNAL_ORDER = [
  'state',
  'run_state',
  'rate',
  'alarm',
  'vibration',
  'temperature',
  'motor_current',
  'speed',
  'level',
  'count_inspected',
  'count_rejected',
  'sample_result',
  'count_good',
  'count_total',
  'tile_count',
  'dock_occupancy',
  'gate_event',
  'vehicle_zone',
];

export const BASE_SIGNAL_LABELS: Record<string, string> = {
  state: 'Run state',
  run_state: 'Run state',
  rate: 'Output rate',
  alarm: 'Alarm / stop code',
  vibration: 'Vibration',
  temperature: 'Temperature',
  motor_current: 'Motor current',
  speed: 'Conveyor speed',
  level: 'Buffer level',
  count_inspected: 'Tiles inspected · counter',
  count_rejected: 'Tiles rejected · counter',
  sample_result: 'Last laboratory sample',
  count_good: 'First-quality accepted · counter',
  count_total: 'Production counter',
  tile_count: 'Tiles moved · counter',
  dock_occupancy: 'Docks occupied',
  gate_event: 'Last gate event',
  vehicle_zone: 'Vehicle zone',
};

/**
 * Process values in the signal registry without a physical model behind them (placeholders) and the
 * illustrative energy model's values: never a signal row, always a "not modelled" line with its reason.
 */
export const NOT_MODELLED_SIGNALS: Record<string, { label: string; reason: string }> = {
  temp_firing: { label: 'Firing temperature profile', reason: 'no thermal model of the kiln — the temp_firing signal is listed under Technical details without a value' },
  temp_preheat: { label: 'Pre-heating temperature', reason: 'no thermal model of the kiln — the temp_preheat signal has no value' },
  temp_inlet: { label: 'Hot-air inlet temperature', reason: 'no thermal model of the spray dryer — the temp_inlet signal has no value' },
  powder_moisture: { label: 'Powder moisture', reason: 'no drying model — residual moisture is not calculated' },
  temp_deck: { label: 'Dryer deck temperature', reason: 'no thermal model of the dryer — the temp_deck signal has no value' },
  header_pressure: { label: 'Compressed-air header pressure', reason: 'no pneumatic model of the compressed-air network' },
  tank_level: { label: 'Water tank level', reason: 'no water-supply model' },
  energy_kwh: { label: 'Energy consumption', reason: 'energy is not monitored in this product (the illustrative energy model is not a product module)' },
  active_power: { label: 'Active power', reason: 'energy is not monitored in this product' },
  gas_flow: { label: 'Gas flow', reason: 'energy is not monitored in this product' },
};

const MACHINE_RULES: InsightRuleId[] = ['stale', 'event', 'planned', 'flow', 'condition', 'rate', 'role', 'quality', 'normal'];
const FULL_ANALYTICS: AnalyticsSpec = { timeline: true, rate: 'ideal', stops: true, loss: true };

const BASE: Record<AssetKind, Omit<IntelProfile, 'key'>> = {
  machine: {
    facets: ['machine', 'material', 'rate', 'condition', 'role'],
    rules: MACHINE_RULES,
    analytics: FULL_ANALYTICS,
    signalOrder: SIGNAL_ORDER,
    signalLabels: BASE_SIGNAL_LABELS,
    notModelled: [],
    output: { noun: 'tiles', equivalent: false },
  },
  conveyor: {
    facets: ['machine', 'material', 'rate', 'condition'],
    rules: ['stale', 'event', 'planned', 'flow', 'normal'],
    analytics: { timeline: true, rate: 'capacity', stops: true, loss: false },
    signalOrder: SIGNAL_ORDER,
    signalLabels: BASE_SIGNAL_LABELS,
    notModelled: [{ label: 'Drive current and belt tension', reason: 'conveyors carry no condition-monitoring sensors in the model' }],
    output: { noun: 'tiles moved', equivalent: false },
  },
  buffer: {
    facets: ['material', 'rate'],
    rules: ['neighbour-stale', 'event', 'buffer', 'normal'],
    analytics: null,
    signalOrder: SIGNAL_ORDER,
    signalLabels: BASE_SIGNAL_LABELS,
    notModelled: [],
    output: { noun: 'tiles held', equivalent: false },
  },
  station: {
    facets: ['machine', 'quality'],
    rules: ['neighbour-stale', 'event', 'quality', 'normal'],
    analytics: null,
    signalOrder: SIGNAL_ORDER,
    signalLabels: BASE_SIGNAL_LABELS,
    notModelled: [],
    output: { noun: 'tiles inspected', equivalent: false },
  },
  raw: {
    facets: ['dwell'],
    rules: ['event', 'logistics', 'normal'],
    analytics: null,
    signalOrder: SIGNAL_ORDER,
    signalLabels: BASE_SIGNAL_LABELS,
    notModelled: [
      { label: 'Stockpile quantities', reason: 'raw-material stock is not tracked; supply never limits the simulated line' },
      { label: 'Feed (dosing) rate', reason: 'box-feeder weighing is not integrated' },
    ],
    output: { noun: 'raw material', equivalent: false },
  },
  logistics: {
    facets: ['dwell'],
    rules: ['event', 'logistics', 'normal'],
    analytics: null,
    signalOrder: SIGNAL_ORDER,
    signalLabels: BASE_SIGNAL_LABELS,
    notModelled: [],
    output: { noun: 'pallets', equivalent: false },
  },
  storage: { facets: [], rules: [], analytics: null, signalOrder: SIGNAL_ORDER, signalLabels: BASE_SIGNAL_LABELS, notModelled: [], output: { noun: '', equivalent: false } },
  utility: { facets: [], rules: [], analytics: null, signalOrder: SIGNAL_ORDER, signalLabels: BASE_SIGNAL_LABELS, notModelled: [], output: { noun: '', equivalent: false } },
  support: { facets: [], rules: [], analytics: null, signalOrder: SIGNAL_ORDER, signalLabels: BASE_SIGNAL_LABELS, notModelled: [], output: { noun: '', equivalent: false } },
};

type StageOverride = { labels?: Record<string, string>; notModelled?: { label: string; reason: string }[]; output?: IntelProfile['output']; facets?: FacetKey[] };

/** Stage refinements for process machines: names of the rate / counter and the stage's not-modelled parameters. */
const STAGE: Partial<Record<StageId, StageOverride>> = {
  PREP: {
    labels: { rate: 'Slip output rate', count_total: 'Slip counter · tile-eq.' },
    notModelled: [
      { label: 'Slip density', reason: 'only recorded as a stop reason (slip density out of spec), never measured' },
      { label: 'Raw-material feed rate', reason: 'box-feeder weighing is not integrated; the mills are fed continuously' },
    ],
    output: { noun: 'slip (tile-equivalents)', equivalent: true },
  },
  SPRAY: {
    labels: { rate: 'Powder output rate', count_total: 'Powder counter · tile-eq.' },
    output: { noun: 'powder (tile-equivalents)', equivalent: true },
  },
  PRESS: {
    labels: { rate: 'Press output rate', count_total: 'Tiles pressed · counter' },
    notModelled: [{ label: 'Pressing force / specific pressure', reason: 'no hydraulic process model — only the hydraulic pump’s condition is monitored' }],
    output: { noun: 'tiles pressed', equivalent: false },
  },
  DRY: {
    labels: { rate: 'Throughput', count_total: 'Tiles dried · counter' },
    notModelled: [{ label: 'Drying (residence) time', reason: 'no thermal model of the dryer' }],
    output: { noun: 'tiles dried', equivalent: false },
  },
  GLAZE: {
    labels: { rate: 'Line rate', count_total: 'Tiles glazed · counter' },
    notModelled: [{ label: 'Glaze density and viscosity', reason: 'only recorded as a stop reason (glaze viscosity adjustment), never measured' }],
    output: { noun: 'tiles glazed', equivalent: false },
  },
  DECOR: {
    labels: { rate: 'Print rate', count_total: 'Tiles decorated · counter' },
    notModelled: [{ label: 'Ink levels and nozzle status', reason: 'ink supply and printhead faults appear only as stop reasons' }],
    output: { noun: 'tiles decorated', equivalent: false },
  },
  KILN: {
    labels: { rate: 'Production rate', count_total: 'Tiles fired · counter' },
    notModelled: [{ label: 'Firing-cycle time', reason: 'no thermal model of the kiln' }],
    output: { noun: 'tiles fired', equivalent: false },
  },
  SORT: {
    labels: { rate: 'Sorting rate', count_total: 'Tiles sorted · counter' },
    facets: ['machine', 'material', 'rate', 'quality', 'role'],
    output: { noun: 'tiles sorted', equivalent: false },
  },
  PACK: {
    labels: { rate: 'Packing rate', count_total: 'Tiles boxed · counter' },
    output: { noun: 'tiles packed', equivalent: false },
  },
  PAL: {
    labels: { rate: 'Palletising rate', count_total: 'Tiles palletised · counter' },
    output: { noun: 'tiles palletised', equivalent: false },
  },
};

/** The intelligence profile of an asset (base per kind, refined per stage for process machines). */
export function intelProfileFor(prof: AssetProfile): IntelProfile {
  const base = BASE[prof.kind];
  const st = prof.kind === 'machine' && prof.stage ? STAGE[prof.stage] : undefined;
  return {
    key: st ? `${prof.kind}:${prof.stage}` : prof.kind,
    ...base,
    facets: st?.facets ?? base.facets,
    signalLabels: { ...base.signalLabels, ...(st?.labels ?? {}) },
    notModelled: [...base.notModelled, ...(st?.notModelled ?? [])],
    output: st?.output ?? base.output,
  };
}

/** Vehicles: one profile (simulated position, movement, trip, dwell). */
export const VEHICLE_PROFILE = {
  key: 'vehicle',
  facets: ['location', 'movement', 'trip', 'dwell'] as FacetKey[],
  rules: ['event', 'vehicle', 'normal'] as InsightRuleId[],
  notModelled: [
    { label: 'GPS / telematics position', reason: 'no GPS, telematics or indoor positioning is connected — positions come from the simulated route, at zone level' },
    { label: 'Speed and engine data', reason: 'no vehicle telematics in the model' },
  ],
};

/** Buffer level band used by the panel — the KPI tiles' band (src/ui/equipment/kpis.ts), one reading of a level. */
export const BUFFER_BAND = BUFFER_LEVEL_BAND;
/** A buffer running empty / full within this many minutes is called out. */
export const BUFFER_ETA_MIN = 60;
/** Starved / blocked share of the last 60 min above which the flow insight applies (src/sim/metrics.ts HELD_UP_SHARE). */
export const FLOW_WINDOW_MIN = 60;
/** Attributed reject rate this shift at or above this multiple of the 24 h rate is called out (with enough output). */
export const QUALITY_RISE = { ratio: 1.3, minTiles: 600 };
