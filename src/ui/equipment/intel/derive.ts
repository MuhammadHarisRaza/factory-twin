/**
 * Equipment intelligence — the derivation behind the one equipment panel (contract: ./types.ts).
 *
 * `deriveEquipmentIntel` and `deriveVehicleIntel` turn the shared simulation state into the panel's
 * view model: header, one feed, facets, the KPI tiles, "what matters" insights, analytics, PLC-style
 * signals and events. Pure (no React); every figure is read from the simulation and the metric layer
 * (kpis, metrics, health, events, constraint claim) — what applies to an asset is configured in
 * ./profiles.ts, never hard-coded per machine.
 *
 * Honesty rules applied here:
 *  - observed facts are stated as facts; a cause that is not established is a "possible contributing
 *    factor" (certainty 'possible'), a traced constraint is 'likely';
 *  - every insight says what it rests on: an event record (its rule id), a scenario input, or a
 *    configured rule on the simulated signals — nothing is called a prediction or AI, and no failure
 *    probability or 0–100 score is produced for the main view;
 *  - the temperature of a condition-monitored asset is its COMPONENT's temperature (bearing, gearmotor),
 *    never a process temperature; placeholder process values and energy counters are never rows, only
 *    "not modelled" lines with their reason;
 *  - a stale data feed (Decision 1): raw values are the last ones received ("Last value hh:mm"), the
 *    state is unknown, the trend after the freeze is empty, aggregate tiles keep the running accounting
 *    with the not-confirmed mark (equipmentKpis), and the panel's first insight says so;
 *  - the line constraint (Decision 2) is only ever worded from constraintClaim / constraintMarker:
 *    "constraining output" only when claim.constraining, otherwise "design constraint (modeled)".
 */
import { EQUIPMENT_BY_ID } from '../../../data/equipment';
import { ZONE_BY_ID } from '../../../data/layout';
import {
  BUFFERS,
  CONVEYORS,
  CONVEYOR_BY_ID,
  DEFECTS,
  DEFECT_ORDER,
  DOCKS,
  INSPECTION_STATIONS,
  LINE,
  M2_PER_TILE,
  MONITORED_STAGE_BY_ID,
  OPS_BY_ID,
  OUTPUT_BUFFER,
  REASON_BY_CODE,
  SCENARIO_KIND_LABELS,
  SIGNALS,
  STAGES,
  cameraFor,
} from '../../../model/plant';
import { DEFECT_ACTIONS, REASON_ACTIONS } from '../../../model/actions';
import { KG_PER_TILE, STAGE_BY_NO, catalogFor, definitionOf, stageOfEquipment } from '../../../model/catalog';
import type { RangeKey } from '../../../model/telemetry';
import { seriesOf } from '../../../sim/telemetry';
import type { BufferDef, DefectCategory, DowntimeEvent, MachineState, OpEvent, OperationalState, ProcessStage, SignalDef, StageId, Vehicle } from '../../../model/types';
import type { CameraSource } from '../../../app/store';
import { LOG_MIN, minuteAt, type SimState } from '../../../sim/engine';
import { EVENT_TYPE_LABEL, eventById } from '../../../sim/events';
import { DEFAULT_FINANCE, type FinanceAssumptions } from '../../../sim/finance';
import { HEALTH_BY_ID, assess, expectedTemp, expectedVib, formatH, sensorHistory, sensorsAt, type HealthAssessment, type SensorReading } from '../../../sim/health';
import type { TruckRuntime } from '../../../sim/logistics';
import {
  HELD_UP_SHARE,
  OPERATIONAL_STATE_LABEL,
  clippedDuration,
  externalVehicles,
  fleetMetrics,
  internalActivity,
  operationalState,
  qualityIn,
  resolvePeriod,
  risingDefects,
  stopState,
  sumBuckets,
  visitDurations,
  type Period,
} from '../../../sim/metrics';
import { signalValue, type SignalReading } from '../../../sim/signals';
import { formatDuration } from '../../../sim/time';
import { delayedTrucks } from '../../../intel/kpis';
import { liveFindingsFor } from '../../../intel/rules/live';
import { liveCharts } from './live';
import { windowOf } from './ranges';


import { eventImpact } from '../../../intel/report';
import { clockLabel, constraintClaim, type ConstraintClaim } from '../../../intel/summary';
import { ALL_EVENTS_FILTERS, filterEvents } from '../../../pages/events/filters';
import { truckTrip, vehicleLocation, vehicleMovement, videoTopicFor } from '../../../pages/fleet/movement';
import { VIDEOS } from '../../../video/registry';
import { EQUIPMENT_TOPICS, TOPIC_LABEL } from '../../../video/topics';
import type { VideoRef, VideoTopic } from '../../../video/types';
import { constraintMarker, type ConstraintMarker } from '../../twin/constraint';
import { assetStatus, selectionCamera, vehicleGeofence, type AssetStatus } from '../../twin/derive';
import { activeRootEvents, constraintRole, eventsOfAsset } from '../context';
import { NO_OPERATING_DATA, bufferLevelBand, equipmentKpis, ownStops, signalRate, vehicleKpis, type EqKpiSet } from '../kpis';
import { assetFindings, catalogView, eventLog, mergeFindings, panelCharts, processView, tileTrends } from './panelData';
import { signalTableRows, type SignalTableRow } from './signalTable';
import { assetProfile, type AssetProfile } from '../profile';
import { basisOf } from '../signals';
import {
  BUFFER_BAND,
  BUFFER_ETA_MIN,
  FLOW_WINDOW_MIN,
  NOT_MODELLED_SIGNALS,
  QUALITY_RISE,
  VEHICLE_PROFILE,
  intelProfileFor,
  type InsightRuleId,
  type IntelProfile,
} from './profiles';
import type {
  EquipmentIntel,
  Facet,
  FacetKey,
  FeedChoice,
  FeedDetail,
  IntelAnalytics,
  IntelEventRow,
  IntelEvents,
  IntelEvidence,
  IntelHeader,
  IntelInsight,
  IntelSignal,
  IntelSignals,
  IntelTone,
  TimelineSegment,
} from './types';

// ── Context ──────────────────────────────────────────────────────────────────

/**
 * What the derivation needs from the app besides the simulation: the financial assumptions, configured camera streams
 * and (optional, added) the viewer's chart range (default 8 h).
 */
export type IntelContext = {
  finance: FinanceAssumptions;
  cameraSources: Record<string, CameraSource>;
  range?: RangeKey;
  /**
   * A live card: the rule findings are the live evaluation (src/intel/rules/live.ts, re-run at most every few simulated
   * minutes) and the history charts and tile sparklines the live chart set (./live.ts); each says when it was made.
   */
  live?: boolean;
};
export const DEFAULT_INTEL_CONTEXT: IntelContext = { finance: DEFAULT_FINANCE, cameraSources: {} };

// ── Formatting ───────────────────────────────────────────────────────────────

const int = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-GB'));
const pct = (f: number, d = 0) => `${(f * 100).toFixed(d)} %`;
const m2 = (tiles: number) => int(tiles * M2_PER_TILE);
const dur = formatDuration;
const lower1 = (t: string) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);
const cap1 = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${Math.round(n) === 1 ? one : many}`;
const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
const fmt1 = (n: number) => n.toFixed(1);

/** "Roller drive gearmotor · firing zone" → "roller drive gearmotor (firing zone)". */
export function componentWords(component: string) {
  const [head, where] = component.split(' · ');
  return where ? `${lower1(head)} (${where})` : lower1(head);
}

const nameOf = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;
/** Defect categories the model attributes to a process stage. */
const defectsOf = (stage: StageId) => DEFECT_ORDER.filter((d) => DEFECTS[d].origin === stage);
const BUFFER_BY_ID: Record<string, BufferDef> = Object.fromEntries(BUFFERS.map((b) => [b.id, b]));
const STAGE_INDEX = Object.fromEntries(STAGES.map((st, i) => [st.id, i])) as Record<StageId, number>;
const KILN_INDEX = STAGE_INDEX[LINE.designConstraint];
const KILN_STAGE = STAGES[KILN_INDEX];
const KILN_ID = KILN_STAGE.machines[0];
const KILN_IDEAL = KILN_STAGE.machines.reduce((a, m) => a + (OPS_BY_ID[m]?.idealRatePerHour ?? 0), 0);

const OP_TONE: Record<OperationalState, IntelTone> = {
  running: 'good',
  reduced: 'warning',
  idle: 'warning',
  stopped: 'critical',
  fault: 'critical',
  starved: 'warning',
  blocked: 'warning',
  planned: 'neutral',
  changeover: 'neutral',
  disconnected: 'neutral',
  unknown: 'neutral',
};

const SEV_RANK: Record<IntelInsight['severity'], number> = { positive: 1, info: 2, warning: 3, serious: 4, critical: 5 };
const RULE_PRIORITY: Record<InsightRuleId, number> = {
  stale: 60,
  'neighbour-stale': 45,
  event: 40,
  planned: 35,
  role: 30,
  flow: 25,
  buffer: 25,
  condition: 20,
  logistics: 20,
  vehicle: 20,
  rate: 15,
  quality: 10,
  normal: 0,
};

type Ranked = IntelInsight & { rule: InsightRuleId };

/** Most important first: severity, then the rule's priority; a positive insight leads the info-level context. */
function rankInsights(list: Ranked[], max = 3): IntelInsight[] {
  const weight = (i: Ranked) => SEV_RANK[i.severity] * 100 + RULE_PRIORITY[i.rule];
  const sorted = [...list].sort((a, b) => weight(b) - weight(a));
  const positive = sorted.find((i) => i.severity === 'positive');
  const ordered = positive ? [positive, ...sorted.filter((i) => i !== positive)] : sorted;
  return ordered.slice(0, max).map(({ rule: _rule, ...i }) => {
    void _rule;
    return i;
  });
}

// ── Minute log ───────────────────────────────────────────────────────────────

type Sample = { t: number; rate: number; state: MachineState; limited: boolean };

/** The panel's recent-activity window (its "Last 4 h" timeline, buffer and vehicle trends); the minute log holds LOG_MIN ≥ this. */
const PANEL_WINDOW_MIN = 240;

/** Logged minutes of an asset in [from, to), oldest first (the ring buffer holds the last LOG_MIN minutes). */
function samples(s: SimState, id: string, from: number, to: number): Sample[] {
  const out: Sample[] = [];
  for (let t = Math.max(0, from, to - LOG_MIN); t < to; t++) {
    const x = minuteAt(s, id, t);
    if (x) out.push({ t, ...x });
  }
  return out;
}

/** Own stop records (not starved / blocked spells) of an asset overlapping [from, now]. */
const ownDowntime = (s: SimState, id: string, from: number) =>
  s.downtime.filter((d) => d.equipmentId === id && d.category !== 'Starved' && d.category !== 'Blocked' && (d.end ?? s.minute) > from);

/**
 * The operational state the product shows for a logged minute (operationalState's rule): unknown once
 * the feed went stale, fault / stopped / planned from the stop record covering the minute, a conveyor
 * running empty is idle.
 */
function opOfSample(s: SimState, id: string, x: Sample, staleFrom: number | null, stops: DowntimeEvent[]): OperationalState {
  if (staleFrom != null && x.t >= staleFrom) return 'unknown';
  if (x.state === 'down') {
    const d = stops.find((r) => r.start <= x.t && (r.end ?? s.minute) > x.t);
    return stopState(d?.reasonCode);
  }
  if (x.state === 'planned') return 'planned';
  if (CONVEYOR_BY_ID[id]) return x.state === 'starved' ? 'idle' : x.state === 'blocked' ? 'blocked' : 'running';
  return x.state;
}

type Recent = { minutes: number; starved: number; blocked: number; down: number; known: number; sumRate: number };

/** Shares of the last `minutes` from the minute log (minutes after a stale freeze are not counted). */
function recentStats(s: SimState, id: string, minutes: number, staleFrom: number | null): Recent {
  const r: Recent = { minutes: 0, starved: 0, blocked: 0, down: 0, known: 0, sumRate: 0 };
  for (const x of samples(s, id, s.minute - minutes, s.minute)) {
    r.minutes++;
    if (staleFrom != null && x.t >= staleFrom) continue;
    r.known++;
    r.sumRate += x.rate;
    if (x.state === 'starved') r.starved++;
    else if (x.state === 'blocked') r.blocked++;
    else if (x.state === 'down') r.down++;
  }
  return r;
}

/** Means of rate × 60 (tiles/h) over steps of `step` minutes ending now; null where no known sample. */
function rateSeries(s: SimState, id: string, minutes: number, step: number, staleFrom: number | null): (number | null)[] {
  const to = s.minute;
  const from = Math.max(0, to - minutes, to - LOG_MIN);
  const n = Math.ceil((to - from) / step);
  const out: (number | null)[] = [];
  for (let k = 0; k < n; k++) {
    const a = to - (n - k) * step;
    const b = a + step;
    let sum = 0;
    let c = 0;
    for (const x of samples(s, id, Math.max(from, a), b)) {
      if (staleFrom != null && x.t >= staleFrom) continue;
      sum += x.rate * 60;
      c++;
    }
    out.push(c ? sum / c : null);
  }
  return out;
}

// ── Line flow around an asset ────────────────────────────────────────────────

type Flow = {
  stage: ProcessStage;
  idx: number;
  up: ProcessStage | null;
  down: ProcessStage | null;
  inBuf: BufferDef | null;
  outBuf: BufferDef | null;
  /** Conveyor stopped on the way in / out (cuts the transfer). */
  inCut: string | null;
  outCut: string | null;
};

const stoppedNow = (s: SimState, id: string) => {
  const op = operationalState(s, id);
  return op === 'stopped' || op === 'fault' || op === 'planned' || op === 'changeover';
};

function flowOf(s: SimState, stageId: StageId): Flow {
  const idx = STAGE_INDEX[stageId];
  const stage = STAGES[idx];
  const outId = OUTPUT_BUFFER[stageId];
  return {
    stage,
    idx,
    up: STAGES[idx - 1] ?? null,
    down: STAGES[idx + 1] ?? null,
    inBuf: stage.inputBuffer ? BUFFER_BY_ID[stage.inputBuffer] : null,
    outBuf: outId ? BUFFER_BY_ID[outId] : null,
    inCut: CONVEYORS.find((c) => c.blocksInputOf.includes(stageId) && stoppedNow(s, c.id))?.id ?? null,
    outCut: CONVEYORS.find((c) => c.blocksOutputOf.includes(stageId) && stoppedNow(s, c.id))?.id ?? null,
  };
}

const level = (s: SimState, b: BufferDef) => s.buffers[b.id] / b.capacity;
const bufferWords = (s: SimState, b: BufferDef) =>
  BULK_BUFFERS.has(b.id) ? `${b.name} (${b.id}) at ${pct(level(s, b))} (level only — no level-to-mass calibration)` : `${b.name} (${b.id}) at ${pct(level(s, b))} of ${int(b.capacity)} tiles`;

/** Tiles held in the buffers from a stage's output up to the kiln's input — what the kiln can still fire if the stage stops supplying. */
function wipToKiln(s: SimState, idx: number) {
  let tiles = 0;
  for (let i = idx + 1; i <= KILN_INDEX; i++) {
    const b = STAGES[i].inputBuffer;
    if (b) tiles += s.buffers[b];
  }
  return tiles;
}

/** Free space in the buffers from the kiln's output up to a stage's input — what the kiln can still discharge if the stage stops taking. */
function spaceFromKiln(s: SimState, idx: number) {
  let tiles = 0;
  for (let i = KILN_INDEX + 1; i <= idx; i++) {
    const b = STAGES[i].inputBuffer;
    if (b) tiles += BUFFER_BY_ID[b].capacity - s.buffers[b];
  }
  return tiles;
}

type StageState = { words: string; held: 'starved' | 'blocked' | null; culprit: string | null; culpritKind: 'stopped' | 'planned' | 'reduced' | null };

/** A stage's state in words for a sentence: "stopped (G-LINE · roller jam)", "running at 1,402 tiles/h", "itself starved". */
function stageWords(s: SimState, st: ProcessStage): StageState {
  const ops = st.machines.map((m) => ({ id: m, op: operationalState(s, m), a: assetStatus(s, m) }));
  const why = (o: (typeof ops)[number]) => `${o.id}${o.a.reason ? ` · ${lower1(o.a.reason)}` : ''}`;
  const stopped = ops.find((o) => o.op === 'stopped' || o.op === 'fault');
  if (stopped) return { words: `stopped (${why(stopped)})`, held: null, culprit: stopped.id, culpritKind: 'stopped' };
  const planned = ops.find((o) => o.op === 'planned' || o.op === 'changeover');
  if (planned) return { words: `in a ${planned.op === 'changeover' ? 'product changeover' : 'planned stop'} (${why(planned)})`, held: null, culprit: planned.id, culpritKind: 'planned' };
  const unknown = ops.find((o) => o.op === 'unknown');
  if (unknown) return { words: `of unknown state (${unknown.id} data stale)`, held: null, culprit: null, culpritKind: null };
  const reduced = ops.find((o) => o.op === 'reduced');
  if (reduced) return { words: `running below its set rate (${reduced.id} at ${int(reduced.a.rate)} tiles/h)`, held: null, culprit: reduced.id, culpritKind: 'reduced' };
  if (ops.every((o) => o.op === 'starved')) return { words: 'itself starved', held: 'starved', culprit: null, culpritKind: null };
  if (ops.every((o) => o.op === 'blocked')) return { words: 'itself blocked', held: 'blocked', culprit: null, culpritKind: null };
  const rate = ops.reduce((a, o) => a + o.a.rate, 0);
  return { words: `running at ${int(rate)} tiles/h`, held: null, culprit: null, culpritKind: null };
}

type Holder = { assetId: string; words: string; kind: 'stopped' | 'planned' | 'reduced' };

/**
 * Walks from a held-up stage in the flow's direction to the first asset that is stopped or slowed — a
 * stopped conveyor on the way first — the way the event engine traces a starvation (inferred, so a
 * "possible contributing factor" unless an event record already names it).
 */
function traceHolder(s: SimState, f: Flow, kind: 'starved' | 'blocked'): Holder | null {
  const cut = kind === 'starved' ? f.inCut : f.outCut;
  const since = (id: string) => {
    const a = assetStatus(s, id);
    return ` since ${formatClockOf(s, a.since)}${a.reason ? ` · ${lower1(a.reason)}` : ''}`;
  };
  if (cut) return { assetId: cut, words: `${nameOf(cut)} (${cut}) ${operationalState(s, cut) === 'planned' ? 'in a planned stop' : 'stopped'}${since(cut)}`, kind: operationalState(s, cut) === 'planned' ? 'planned' : 'stopped' };
  const dir = kind === 'starved' ? -1 : 1;
  for (let i = f.idx + dir; i >= 0 && i < STAGES.length; i += dir) {
    const st = STAGES[i];
    const w = stageWords(s, st);
    if (w.culprit && w.culpritKind) {
      const what = w.culpritKind === 'stopped' ? 'stopped' : w.culpritKind === 'planned' ? 'in a planned stop' : 'running below its set rate';
      return { assetId: w.culprit, words: `${nameOf(w.culprit)} (${w.culprit}) ${what}${since(w.culprit)}`, kind: w.culpritKind };
    }
    const conv = CONVEYORS.find((c) => (kind === 'starved' ? c.blocksInputOf.includes(st.id) : c.blocksOutputOf.includes(st.id)) && stoppedNow(s, c.id));
    if (conv) return { assetId: conv.id, words: `${conv.name} (${conv.id}) stopped${since(conv.id)}`, kind: operationalState(s, conv.id) === 'planned' ? 'planned' : 'stopped' };
    if (w.held !== kind) break;
  }
  return null;
}

const formatClockOf = (s: SimState, t: number) => clockLabel(t, s.minute);

// ── Shared per-asset state ───────────────────────────────────────────────────

type X = {
  s: SimState;
  id: string;
  now: number;
  clock: (t: number) => string;
  prof: AssetProfile;
  ip: IntelProfile;
  shift: Period;
  claim: ConstraintClaim;
  marker: ConstraintMarker;
  metrics: EqKpiSet;
  status: AssetStatus | null;
  op: OperationalState | null;
  staleSince: number | null;
  health: HealthAssessment | null;
  /** Process stage whose flow the asset belongs to (machines: own stage; conveyors: the stage they feed). */
  flow: Flow | null;
  ideal: number | null;
  /** Rate as the product has it (the last value received while the feed is stale), tiles/h; null = no value received (never 0). */
  rate: number | null;
  /** The engine marks the stage's last minute as limited by input / output (paced by a neighbour). */
  limitedNow: boolean;
  recent: Recent | null;
  events: OpEvent[];
  roots: OpEvent[];
  finance: FinanceAssumptions;
  /** The stop record the asset is in now (null while it runs). */
  activeStop: DowntimeEvent | null;
  /** In a product changeover now — said as "Changeover" everywhere (not "planned stop", not "unplanned stop"). */
  changeover: boolean;
};

function contextOf(s: SimState, id: string, ctx: IntelContext): X {
  const prof = assetProfile(id);
  const ip = intelProfileFor(prof);
  const shift = resolvePeriod('shift', s.minute);
  const claim = constraintClaim(s);
  const marker = constraintMarker(s, claim);
  const tracked = prof.tracked && !!s.machines[id];
  const status = tracked ? assetStatus(s, id) : null;
  const staleSince = status?.staleSince ?? null;
  const conv = CONVEYOR_BY_ID[id];
  const flowStage: StageId | null = prof.kind === 'machine' ? prof.stage : conv ? (conv.blocksInputOf[0] ?? conv.to) : null;
  const ideal = prof.kind === 'machine' ? (OPS_BY_ID[id]?.idealRatePerHour ?? null) : conv ? conv.capacityPerHour : null;
  const m = s.machines[id];
  const activeStop = tracked && m?.activeDowntimeId && status?.op !== 'unknown' ? (s.downtime.find((d) => d.id === m.activeDowntimeId) ?? null) : null;
  return {
    activeStop,
    changeover: status?.op === 'changeover',
    s,
    id,
    now: s.minute,
    clock: (t) => clockLabel(t, s.minute),
    prof,
    ip,
    shift,
    claim,
    marker,
    metrics: equipmentKpis(s, id, shift, claim),
    status,
    op: status?.op ?? null,
    staleSince,
    health: prof.conditionMonitored ? assess(s, id) : null,
    flow: flowStage ? flowOf(s, flowStage) : null,
    ideal,
    rate: tracked ? signalRate(s, id) : null,
    limitedNow: tracked ? (minuteAt(s, id, s.minute - 1)?.limited ?? false) : false,
    recent: tracked ? recentStats(s, id, FLOW_WINDOW_MIN, staleSince) : null,
    events: eventsOfAsset(s, id),
    roots: activeRootEvents(s, id),
    finance: ctx.finance,
  };
}

const isKilnStage = (x: X) => x.prof.kind === 'machine' && x.prof.stage === LINE.designConstraint;
const claimedHere = (x: X) => x.prof.kind === 'machine' && x.prof.stage != null && x.marker.processStage === x.prof.stage;
const constrainingHere = (x: X) => claimedHere(x) && x.marker.active;

// ── Header ───────────────────────────────────────────────────────────────────

function zoneOf(id: string): IntelHeader['zone'] {
  const z = ZONE_BY_ID[EQUIPMENT_BY_ID[id]?.zone ?? OPS_BY_ID[id]?.zone ?? CONVEYOR_BY_ID[id]?.zone ?? ''];
  return z ? { id: z.id, color: z.color } : null;
}

/** The brief's 12-stage mapping line of an asset ("Brief stage 7 · Kiln firing"), null for site utilities / support. */
export function stage12Of(id: string): IntelHeader['stage12'] {
  const no = stageOfEquipment(id);
  if (no == null) return null;
  const st = STAGE_BY_NO[no];
  return { no, label: `Brief stage ${no} · ${st.name}`, note: st.note };
}

/** Newest sample time of the asset's simulated catalogue signals (null when it has none). */
const lastUpdateOf = (rows: SignalTableRow[]) => rows.reduce<number | null>((a, r) => (r.timestamp != null && r.def.availabilityStatus === 'simulated' ? Math.max(a ?? -Infinity, r.timestamp) : a), null);

function header(x: X, rows: SignalTableRow[] = []): IntelHeader {
  const { prof, id, status, op } = x;
  const stageName = prof.monitored ? MONITORED_STAGE_BY_ID[prof.monitored].name : (EQUIPMENT_BY_ID[id]?.stage ?? prof.category);
  let state: IntelHeader['state'];
  if (!status || !op) state = { label: 'No operating state modelled', tone: 'neutral', op: null };
  else {
    // A stale feed: "Unknown" — the source pill next to it already says "Stale since hh:mm".
    // A product changeover is "Changeover" (its own stop category, neither a planned stop nor a fault).
    const base = op === 'unknown' ? 'Unknown' : x.changeover ? 'Changeover' : OPERATIONAL_STATE_LABEL[op];
    const reason = !x.changeover && (op === 'stopped' || op === 'fault' || op === 'planned') && status.reason ? ` · ${lower1(status.reason)}` : '';
    state = { label: `${base}${reason}`, tone: OP_TONE[op], op };
  }
  // Assets without operating data say so — never "Simulated": catalogue entries but nothing simulated, or a layout item only.
  const noData = !status && x.metrics.note === NO_OPERATING_DATA;
  const source: IntelHeader['source'] =
    x.staleSince != null
      ? { kind: 'stale', label: `Stale since ${x.clock(x.staleSince)}`, since: x.staleSince }
      : noData
        ? catalogFor(id).length
          ? { kind: 'unavailable', label: 'Unavailable · no operating data' }
          : { kind: 'reference', label: 'Reference · layout only' }
        : { kind: 'simulated', label: 'Simulated' };
  return {
    title: prof.name,
    subtitle: `${stageName} · ${id}`,
    zone: zoneOf(id),
    state,
    since: status ? status.since : null,
    source,
    lastUpdate: noData ? null : lastUpdateOf(rows),
    stage12: stage12Of(id),
  };
}

// ── Feed (exactly one) ───────────────────────────────────────────────────────

const RECORDING_NOTE = 'A recording — not a live feed; its overlays come from the system that recorded it.';
const REFERENCE_NOTE = 'Footage of a comparable process — not this plant, not live.';
const STREAM_NOTE = 'A stream configured for this camera; it is shown as Live only while it plays.';

const clientRecordings = () => VIDEOS.filter((v) => v.sourceType === 'client-recording');

function recordingFor(equipmentId: string | null, topics: VideoTopic[], byTopic = true): VideoRef | null {
  const recs = clientRecordings();
  return (equipmentId ? recs.find((v) => v.equipment.includes(equipmentId)) : undefined) ?? (byTopic && topics[0] ? recs.find((v) => v.topic === topics[0]) : undefined) ?? null;
}

/** Best reference clip for the topics (equipment match first, embeddable first) — clipsFor's rule, reference footage only. */
function referenceFor(equipmentId: string | null, topics: VideoTopic[]): VideoRef | null {
  for (const topic of topics) {
    const cands = VIDEOS.filter((v) => v.topic === topic && v.sourceType === 'public-reference');
    if (!cands.length) continue;
    const ranked = [...cands].sort((a, b) => Number(b.embedUrl != null) - Number(a.embedUrl != null));
    return ranked.find((v) => equipmentId != null && v.equipment.includes(equipmentId)) ?? ranked[0];
  }
  return null;
}

const detail = (label: string, value: string | null | undefined): FeedDetail[] => (value ? [{ label, value }] : []);

/**
 * The one feed of a subject in the panel's order (exported for the stage panel's shell, which shows a
 * stage's feed the same way). `recordingByTopic: false` takes a client recording only when it lists the
 * subject's equipment (a vehicle: the asset of the geofence it is in) — a recording of the site entrance
 * is not the feed of a truck on the weighbridge.
 */
export function chooseFeed(
  subject: { equipmentId: string | null; label: string },
  camera: ReturnType<typeof cameraFor>,
  topics: VideoTopic[],
  cameraSources: Record<string, CameraSource>,
  opts: { recordingByTopic?: boolean } = {},
): FeedChoice {
  if (camera && cameraSources[camera.id]) {
    const src = cameraSources[camera.id];
    return {
      kind: 'live-stream',
      cameraId: camera.id,
      badge: 'Live stream',
      details: [...detail('Camera', `${camera.name} (${camera.id})`), ...detail('Stream', src.kind === 'auto' ? 'Configured stream (format detected on play)' : `Configured stream (${src.kind.toUpperCase()})`), { label: 'Note', value: STREAM_NOTE }],
    };
  }
  const rec = recordingFor(subject.equipmentId, topics, opts.recordingByTopic ?? true);
  if (rec)
    return {
      kind: 'recording',
      video: rec,
      badge: 'Recorded',
      details: [
        ...detail('Title', rec.title),
        ...detail('Camera', rec.recording?.camera ?? 'Not named in the recording'),
        ...detail('Recorded at', rec.recording?.recordedAt ?? 'Not shown in the recording'),
        ...detail('Overlays', rec.recording?.overlays ? `${rec.recording.overlays} (drawn by the recording system)` : null),
        // "Provided by the client" → "the client" (the label already says "Provided by").
        ...detail('Provided by', rec.publisher.replace(/^Provided by\s+/i, '')),
        ...detail('Licence', rec.licence),
        { label: 'Note', value: RECORDING_NOTE },
      ],
    };
  const ref = referenceFor(subject.equipmentId, topics);
  if (ref)
    return {
      kind: 'reference',
      video: ref,
      badge: 'Reference',
      details: [
        ...detail('Title', ref.title),
        ...detail('Publisher', `${ref.publisher}${ref.provider !== 'other' ? ` · ${cap1(ref.provider)}` : ''}`),
        ...detail('Licence', ref.licence),
        ...detail('Attribution', ref.attribution),
        ...detail('Source', ref.sourceUrl),
        { label: 'Note', value: REFERENCE_NOTE },
      ],
    };
  if (camera)
    return {
      kind: 'none',
      reason: `No stream is configured for ${camera.name} (${camera.id}). Configure one under Technical details › Cameras.`,
      badge: null,
      details: [],
    };
  return {
    kind: 'none',
    reason: topics.length
      ? `No camera covers ${subject.label} and no footage of ${TOPIC_LABEL[topics[0]].toLowerCase()} is registered.`
      : `No camera covers ${subject.label} and no footage is registered for it.`,
    badge: null,
    details: [],
  };
}

// ── Facets ───────────────────────────────────────────────────────────────────

function machineFacet(x: X): Facet | null {
  if (x.prof.kind === 'station') {
    // An inspection station inspects only while the sorting line runs.
    const host = STAGES.find((st) => st.id === 'SORT')?.machines[0];
    if (!host || !x.s.machines[host]) return null;
    const op = operationalState(x.s, host);
    const v = op === 'running' || op === 'reduced' ? 'Running' : op === 'starved' ? 'Up · waiting for tiles' : op === 'blocked' ? 'Up · output full' : OPERATIONAL_STATE_LABEL[op];
    return { key: 'machine', label: 'Sorting line', value: v, tone: op === 'starved' || op === 'blocked' ? 'neutral' : OP_TONE[op], hint: `Run state of the sorting line (${host}.state): tiles are inspected only while it runs.` };
  }
  const op = x.op;
  if (!op) return null;
  const conv = x.prof.kind === 'conveyor';
  const byOp: Record<OperationalState, [string, IntelTone]> = {
    running: ['Running', 'good'],
    reduced: ['Running', 'good'],
    starved: ['Up · waiting', 'neutral'],
    blocked: [conv ? 'Running · accumulating' : 'Up · waiting', 'neutral'],
    idle: ['Running empty', 'neutral'],
    stopped: ['Stopped', 'critical'],
    fault: ['Fault', 'critical'],
    planned: ['Planned stop', 'neutral'],
    changeover: ['Changeover', 'neutral'],
    disconnected: ['Disconnected', 'neutral'],
    unknown: ['Unknown', 'neutral'],
  };
  const [value, tone] = byOp[op];
  return {
    key: 'machine',
    label: conv ? 'Conveyor' : 'Machine',
    value,
    tone,
    hint: `Run state from ${x.id}.${conv ? 'run_state' : 'state'} (simulated PLC signal). Up / running says the machine is available — whether material is being processed is the Material facet, whether it meets its rate the Rate facet.`,
  };
}

/** Where a running machine's pace comes from now: its own pace, its supply, or the space downstream. */
function pacedBy(x: X): 'supply' | 'downstream' | null {
  const f = x.flow;
  if (!f || !x.limitedNow) return null;
  if (f.inCut || (f.inBuf && level(x.s, f.inBuf) <= 0.02)) return 'supply';
  if (f.outCut || (f.outBuf && level(x.s, f.outBuf) >= 0.98)) return 'downstream';
  return f.inBuf && (!f.outBuf || level(x.s, f.inBuf) < 1 - level(x.s, f.outBuf)) ? 'supply' : 'downstream';
}

function materialFacet(x: X): Facet | null {
  const op = x.op;
  const f = x.flow;
  if (x.prof.kind === 'buffer') return bufferLevelFacet(x);
  if (!op) return null;
  const hint = `From ${x.id}'s state and the minute log (limited by input / output) with the levels of the buffers either side.`;
  if (op === 'unknown' || op === 'disconnected') return { key: 'material', label: 'Material', value: 'Unknown', tone: 'neutral', hint: 'The data feed is stale — whether material is being processed is not known.' };
  // Stopped: nothing is processed — the header already says so; an empty "—" chip carries no meaning.
  if (op === 'stopped' || op === 'fault' || op === 'planned' || op === 'changeover') return null;
  if (x.prof.kind === 'conveyor') {
    if (op === 'idle') return { key: 'material', label: 'Material', value: 'Nothing to carry', tone: 'neutral', hint: 'Running empty: the stage feeding the conveyor sends nothing.' };
    if (op === 'blocked') return { key: 'material', label: 'Material', value: 'Accumulating — receiver held', tone: 'warning', hint: 'The receiving stage cannot take tiles (stopped, blocked or full).' };
    return { key: 'material', label: 'Material', value: 'Carrying', tone: 'good', hint };
  }
  if (op === 'starved')
    return { key: 'material', label: 'Material', value: `Starved — ${f?.inCut ? `${f.inCut} stopped` : f?.inBuf ? `${lower1(f.inBuf.name)} empty` : 'no input'}`, tone: 'warning', hint };
  if (op === 'blocked')
    return { key: 'material', label: 'Material', value: `Blocked — ${f?.outCut ? `${f.outCut} stopped` : f?.outBuf ? `${lower1(f.outBuf.name)} full` : 'downstream full'}`, tone: 'warning', hint };
  const paced = pacedBy(x);
  if (paced) return { key: 'material', label: 'Material', value: paced === 'supply' ? 'Fed · paced by supply' : 'Fed · paced by downstream space', tone: 'neutral', hint };
  return { key: 'material', label: 'Material', value: 'Fed', tone: 'good', hint: f?.inBuf ? `${hint} Input buffer ${bufferWords(x.s, f.inBuf)}.` : `${hint} Raw-material supply never limits the simulated line.` };
}

/** The rate in words with its tone — the KPI tile's rule (warning only when below its own set rate or constraining). */
function rateWords(x: X): { value: string; tone: IntelTone } | null {
  const op = x.op;
  if (!op || x.ideal == null || x.ideal <= 0) return null;
  const conv = x.prof.kind === 'conveyor';
  if (x.rate == null) return { value: op === 'stopped' || op === 'fault' ? OPERATIONAL_STATE_LABEL[op] : 'Rate not reported', tone: op === 'stopped' || op === 'fault' ? 'critical' : 'neutral' };
  const ratio = x.rate / x.ideal;
  const share = conv ? `${pct(ratio)} of capacity` : `${pct(ratio)} of ideal`;
  if (op === 'unknown' || op === 'disconnected') return { value: `Last value · ${share}`, tone: 'neutral' };
  if (op === 'stopped' || op === 'fault') return { value: conv ? 'Stopped' : `0 % of ideal · stopped`, tone: 'critical' };
  if (op === 'planned' || op === 'changeover') return { value: op === 'changeover' ? 'Changeover' : 'Planned stop', tone: 'neutral' };
  if (conv) return { value: share, tone: 'neutral' };
  if (constrainingHere(x)) return { value: `${share} · constraining`, tone: 'warning' };
  if (op === 'reduced') return { value: `${share} · below its set rate`, tone: 'warning' };
  const paced = op === 'starved' ? 'supply' : op === 'blocked' ? 'downstream' : pacedBy(x);
  if (paced && ratio < 0.95) return { value: `${share} · paced by ${paced === 'supply' ? 'supply' : 'downstream space'}`, tone: 'neutral' };
  return { value: share, tone: ratio >= 0.95 ? 'good' : 'neutral' };
}

function rateFacet(x: X): Facet | null {
  if (x.prof.kind === 'buffer') return bufferFlowFacet(x);
  const w = rateWords(x);
  if (!w) return null;
  const conv = x.prof.kind === 'conveyor';
  return {
    key: 'rate',
    label: 'Rate',
    value: w.value,
    tone: w.tone,
    hint: conv
      ? `Tiles carried per hour (${x.id} rate) against the conveyor's nominal capacity of ${int(x.ideal)} ${conveyorRateUnit(x.id)} — a conveyor moves what the next stage takes, so a lower share is not a loss.`
      : `Rate reported by ${x.id}.rate (${int(x.rate)} tiles/h) against its ideal ${int(x.ideal)} tiles/h. The line is paced by its constraint: a machine below its ideal rate because of its supply or the space downstream has spare capacity — a warning only when it runs below its own set rate or the constraint claim names its stage as the one holding up line output.`,
  };
}

function conditionFacet(x: X): Facet {
  if (!x.prof.conditionMonitored || !x.health)
    return { key: 'condition', label: 'Condition', value: 'Not monitored', tone: 'neutral', hint: 'No condition-monitoring sensors (vibration, temperature, current) on this asset in the model.' };
  if (x.staleSince != null) return { key: 'condition', label: 'Condition', value: 'Unknown', tone: 'neutral', hint: `The data feed is stale since ${x.clock(x.staleSince)}: the condition signals are last values, so the condition now is not known.` };
  const lv = x.health.level;
  const map: Record<HealthAssessment['level'], [string, IntelTone]> = { normal: ['Normal', 'good'], watch: ['Watch', 'warning'], warning: ['Warning', 'warning'], alarm: ['Alarm', 'critical'], offline: ['Not running', 'neutral'] };
  const [value, tone] = map[lv];
  return {
    key: 'condition',
    label: 'Condition',
    value,
    tone,
    hint: `${HEALTH_BY_ID[x.id].component}: rule-based level from vibration against the value expected at the current load, its 3-h trend and the component temperature against its alarm limit (simulated signals) — not a probability of failure.`,
  };
}

function roleFacet(x: X): Facet | null {
  if (x.prof.kind !== 'machine') return null;
  const role = constraintRole(x.s, x.prof, x.marker);
  if (role?.kind === 'constraint')
    return { key: 'role', label: 'Line role', value: role.marker.active ? 'Constraining output' : 'Design constraint (modeled)', tone: role.marker.active ? 'warning' : 'neutral', hint: role.marker.title };
  if (role?.kind === 'held-up')
    return {
      key: 'role',
      label: 'Line role',
      value: 'Held up by neighbours',
      tone: 'neutral',
      hint: `Starved ${pct(role.starvedShare)}, blocked ${pct(role.blockedShare)} of the ${role.window} (more than ${pct(HELD_UP_SHARE)}). ${x.marker.sentence}`,
    };
  return { key: 'role', label: 'Line role', value: 'Not constraining', tone: 'neutral', hint: x.marker.sentence };
}

function qualityFacet(x: X): Facet | null {
  const q = qualityIn(x.s, x.shift);
  const limit = x.s.rules.rejectRateMax;
  const st = x.prof.stationId ? INSPECTION_STATIONS.find((i) => i.id === x.prof.stationId) : null;
  if (st && !st.detects.length) {
    const last = lastSample(x.s, st.id);
    if (!last) return { key: 'quality', label: 'Last sample', value: 'None yet', tone: 'neutral', hint: 'No laboratory sample recorded yet.' };
    return {
      key: 'quality',
      label: 'Last sample',
      value: `${last.result === 'pass' ? 'Pass' : 'Out of spec'} · ${x.clock(last.time)}`,
      tone: last.result === 'pass' ? 'good' : 'warning',
      hint: `Most recent laboratory sample record: ${last.measurement ?? '—'}.`,
    };
  }
  const by = st ? q.byStation[st.id] : { inspected: q.inspected, rejected: q.rejected };
  if (!by || by.inspected <= 0) return { key: 'quality', label: 'Rejects', value: 'No tiles inspected yet', tone: 'neutral', hint: 'Nothing inspected in the shift yet.' };
  const rate = by.rejected / by.inspected;
  const hint = `${st ? `Tiles this station rejected` : 'Tiles rejected at the gauge and the vision tunnel'} ÷ tiles inspected this shift (${x.shift.label}), against the line's reject-rate limit of ${pct(limit)} (detection rule Q-RATE). Classification is simulated.`;
  // The counts rest on a stale feed (Decision 1): the running accounting, no green / red verdict on it.
  const mark = x.metrics.stale;
  if (mark) return { key: 'quality', label: 'Rejects', value: `${pct(rate, 2)} · not confirmed`, tone: 'neutral', hint: `${mark.label} — ${mark.note} ${hint}` };
  return { key: 'quality', label: 'Rejects', value: `${pct(rate, 2)} · limit ${pct(limit)}`, tone: rate > limit ? 'critical' : 'good', hint };
}

function lastSample(s: SimState, stationId: string) {
  for (let i = s.inspections.length - 1; i >= 0; i--) {
    const r = s.inspections[i];
    if (r.stationId === stationId && r.time <= s.minute) return r;
  }
  return null;
}

// Buffers ---------------------------------------------------------------------

type BufferFlow = {
  buf: BufferDef;
  level: number;
  up: ProcessStage | undefined;
  down: ProcessStage | undefined;
  /** Rates of the neighbouring stages in tile-equivalents per hour (the thresholds' unit); shown through `show`. */
  inflow: number;
  outflow: number;
  net: number;
  staleNeighbour: boolean;
  /** Slip tanks and powder silos: level % only, flows shown in simulated t/h (KG_PER_TILE), never tiles. */
  bulk: boolean;
  /** A rate in the buffer's display unit: "9.9 t/h" (simulated, slip / powder) or "1,250 tiles/h". */
  show: (tilesPerHour: number) => string;
};

/** Slip tanks (stage 1) and powder silos (stage 2): material in bulk, no tiles. */
const BULK_BUFFERS = new Set(['BUF-SLIP', 'BUF-SILO']);
/** A conveyor's rate unit: tile-equivalents for the powder belt (stage 2, catalogue 'tile-eq'), tiles elsewhere. */
const conveyorRateUnit = (id: string) => (definitionOf(`${id}.tile_count`)?.unit === 'tile-eq' ? 'tile-eq/h' : 'tiles/h');
const showFlow = (bulk: boolean) => (v: number) => (bulk ? `${((v * KG_PER_TILE) / 1000).toFixed(1)} t/h` : `${int(v)} tiles/h`);

function bufferFlow(x: X): BufferFlow | null {
  const buf = x.prof.bufferId ? BUFFER_BY_ID[x.prof.bufferId] : null;
  if (!buf) return null;
  const i = STAGES.findIndex((st) => st.inputBuffer === buf.id);
  const up = i > 0 ? STAGES[i - 1] : undefined;
  const down = i >= 0 ? STAGES[i] : undefined;
  // A side without a neighbour carries nothing (0 is a fact there); a neighbour without a rate value leaves the flow unknown.
  const rate = (st: ProcessStage | undefined): number | null => {
    if (!st) return 0;
    let a = 0;
    for (const m of st.machines) {
      const r = signalRate(x.s, m);
      if (r == null) return null;
      a += r;
    }
    return a;
  };
  const staleNeighbour = [...(up?.machines ?? []), ...(down?.machines ?? [])].some((m) => x.s.feeds[m]?.status === 'stale');
  const inflow = rate(up);
  const outflow = rate(down);
  if (inflow == null || outflow == null) return null;
  const bulk = BULK_BUFFERS.has(buf.id);
  return { buf, level: x.s.buffers[buf.id], up, down, inflow, outflow, net: inflow - outflow, staleNeighbour, bulk, show: showFlow(bulk) };
}

/** The buffer feeds a stage at or before the kiln (an empty buffer here can starve the line constraint). */
const bufferAhead = (b: BufferFlow) => b.down != null && STAGE_INDEX[b.down.id] <= KILN_INDEX;

/**
 * What the level means on this side of the kiln: a concern, normal balancing, or within the band —
 * the KPI tile's band (bufferLevelBand), so the facet, the tile, the signal row and the insight read a
 * level the same way.
 */
function bufferBand(b: BufferFlow): { words: string; tone: IntelTone; meaning: string; label: string } {
  const band = bufferLevelBand(b.buf.id, b.level / b.buf.capacity);
  const up = b.up ? lower1(b.up.name) : 'the stage filling it';
  const down = b.down ? lower1(b.down.name) : 'the next stage';
  if (band.side === 'low')
    return band.concern
      ? { words: 'nearly empty', tone: 'warning', label: band.label, meaning: `nearly empty: ${down} is starved when it runs out` }
      : { words: 'low', tone: 'neutral', label: band.label, meaning: `low is normal here: ${down} is faster than ${up} and waits for tiles` };
  if (band.side === 'high')
    return band.concern
      ? { words: 'nearly full', tone: 'warning', label: band.label, meaning: `nearly full: ${up} is blocked when it fills, and the blockage moves towards the kiln` }
      : { words: 'full', tone: 'neutral', label: band.label, meaning: `full is normal here: ${up} has spare capacity and is paced by ${down}` };
  return { words: 'normal', tone: 'good', label: band.label, meaning: `within its normal band (${pct(BUFFER_BAND.low)}–${pct(BUFFER_BAND.high)})` };
}

function bufferLevelFacet(x: X): Facet | null {
  const b = bufferFlow(x);
  if (!b) return null;
  const band = bufferBand(b);
  return { key: 'material', label: 'Level', value: `${pct(b.level / b.buf.capacity)} · ${band.words}`, tone: band.tone, hint: `${bufferWords(x.s, b.buf)} — simulated level signal; ${band.meaning}.` };
}

function bufferFlowFacet(x: X): Facet | null {
  const b = bufferFlow(x);
  if (!b) return null;
  const hint = `Filling from ${b.up?.name.toLowerCase() ?? '—'} (${b.show(b.inflow)}) minus drawn by ${b.down?.name.toLowerCase() ?? '—'} (${b.show(b.outflow)}), from their rate signals${b.bulk ? ` (simulated t/h: tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg)` : ''}${b.staleNeighbour ? ' — includes a last value received from a stale feed' : ''}.`;
  if (b.staleNeighbour) return { key: 'rate', label: 'Net flow', value: 'Not confirmed', tone: 'neutral', hint };
  if (b.inflow < 1 && b.outflow < 1) return { key: 'rate', label: 'Net flow', value: 'No flow', tone: 'neutral', hint };
  if (Math.abs(b.net) < 30) return { key: 'rate', label: 'Net flow', value: 'Steady', tone: 'good', hint };
  return { key: 'rate', label: 'Net flow', value: b.net > 0 ? `Filling · +${b.show(b.net)}` : `Emptying · −${b.show(-b.net)}`, tone: 'neutral', hint };
}

// Logistics / raw ---------------------------------------------------------------

function dwellFacet(x: X): Facet | null {
  const s = x.s;
  const fm = fleetMetrics(s, x.shift);
  switch (x.id) {
    case 'A-GATE':
      return { key: 'dwell', label: 'Trucks on site', value: `${fm.onSite} · ${fm.inbound} inbound`, tone: 'neutral', hint: 'External trucks between gate-in and gate-out now (simulated gate events).' };
    case 'A-HOLD':
      return {
        key: 'dwell',
        label: 'Queue',
        value: `${plural(fm.waiting, 'truck')} waiting · limit ${s.rules.yardQueueMax}`,
        tone: fm.waiting >= s.rules.yardQueueMax ? 'warning' : fm.waiting > 0 ? 'neutral' : 'good',
        hint: 'Outbound trucks waiting for a dock now, against the yard-congestion rule (L-YARD).',
      };
    case 'K-DOCK': {
      const occ = DOCKS.filter((d) => s.logistics.docks[d.id]?.vehicleId).length;
      return { key: 'dwell', label: 'Docks', value: `${occ} of ${DOCKS.length} occupied`, tone: 'neutral', hint: 'Docks with a truck at them now (K-DOCK.dock_occupancy).' };
    }
    case 'K-FLT': {
      const acts = forklifts(s).map((v) => internalActivity(v, s.minute));
      return { key: 'dwell', label: 'Forklifts', value: `${acts.filter((a) => a.moving).length} moving · ${acts.filter((a) => !a.moving).length} stationary`, tone: 'neutral', hint: 'Internal forklifts on a driving leg now (simulated route legs).' };
    }
    default:
      if (x.prof.kind === 'raw') {
        const n = externalVehicles(s).filter((v) => v.visit?.direction === 'inbound' && v.visit.gateIn <= s.minute).length;
        return { key: 'dwell', label: 'Tippers on site', value: String(n), tone: 'neutral', hint: 'Inbound raw-material trucks between gate-in and gate-out now.' };
      }
      return { key: 'dwell', label: 'Stock', value: `${int(s.logistics.stockPallets)} pallets`, tone: 'neutral', hint: 'Finished-goods pallets in the warehouse now (simulated stock).' };
  }
}

const forklifts = (s: SimState) => s.logistics.active.map((v) => s.logistics.vehicles[v]).filter((v) => v && v.class === 'internal' && v.type === 'forklift');

function facets(x: X): Facet[] {
  const make: Record<FacetKey, (x: X) => Facet | null> = {
    machine: machineFacet,
    material: materialFacet,
    rate: rateFacet,
    condition: conditionFacet,
    role: roleFacet,
    quality: qualityFacet,
    dwell: dwellFacet,
    feed: () => null,
    location: () => null,
    movement: () => null,
    trip: () => null,
  };
  return x.ip.facets
    .map((k) => make[k](x))
    .filter((f): f is Facet => f != null)
    .slice(0, 5);
}

// ── Insights ─────────────────────────────────────────────────────────────────

const sev = (e: OpEvent): IntelInsight['severity'] => e.severity;
const isScenarioEvent = (e: OpEvent) => e.source === 'scenario' || e.trigger.kind === 'scenario';
const activeScenario = (s: SimState, pred: (sc: SimState['scenarios'][number]) => boolean) =>
  s.scenarios.find((sc) => sc.start <= s.minute && (sc.end == null || sc.end > s.minute) && pred(sc)) ?? null;

const eventEvidence = (e: OpEvent): IntelEvidence => ({ kind: 'event', label: `${e.id} · ${EVENT_TYPE_LABEL[e.type]}`, ref: e.id });
/** A chip for one of the asset's signals (a link to its row, named by the row's label), or a plain figure when the asset has no such signal. */
const signalEvidence = (x: X, name: string, label: string): IntelEvidence => {
  const sid = `${x.id}.${name}`;
  return SIGNALS.some((d) => d.id === sid) ? { kind: 'signal', label, ref: sid, short: x.ip.signalLabels[name] ?? cap1(name.replace(/_/g, ' ')) } : { kind: 'metric', label };
};

/** The signal an event trigger's observation describes (the state, the alarm code, the rate, the vibration …). */
const OBSERVED_SIGNAL: Record<string, string> = {
  State: 'state',
  'Last state': 'state',
  'Last update': 'state',
  'Minutes starved': 'state',
  'Minutes blocked': 'state',
  'Alarm / reason code': 'alarm',
  'Average rate': 'rate',
  'Share of ideal': 'rate',
  Vibration: 'vibration',
  'Expected at load': 'vibration',
};

/** Minute the event engine raised the record (its "detected" history entry; the condition start otherwise). */
const detectedAt = (e: OpEvent) => e.history.find((h) => h.action === 'detected')?.t ?? e.start;
/**
 * "At detection (10:41): …" — an event summary is written once, when the rule fires, so a relative
 * window in it ("in the last 60 min") is the window before detection, not the last 60 min now.
 */
const atDetection = (clock: (t: number) => string, e: OpEvent) => `At detection (${clock(detectedAt(e))}): ${/^[A-Z][a-z]/.test(e.summary) ? lower1(sentence(e.summary)) : sentence(e.summary)}`;

/**
 * What the buffers between an asset and the kiln give the kiln at its ideal rate, in words: the tiles
 * it can still fire (upstream of the kiln) or the room it can still discharge into (downstream). Null
 * at the kiln itself.
 */
function lineCoverWords(s: SimState, idx: number): string | null {
  if (idx === KILN_INDEX) return null;
  if (idx < KILN_INDEX) {
    const wip = wipToKiln(s, idx);
    if (wip < 1) return 'the buffers between it and the kiln are empty';
    return `the buffers between it and the kiln hold ${int(wip)} tiles ≈ ${dur((wip / KILN_IDEAL) * 60)} of firing at the kiln's ideal rate`;
  }
  const room = spaceFromKiln(s, idx);
  if (room < 1) return 'the buffers between the kiln and it are full';
  return `the buffers between the kiln and it have room for ${int(room)} tiles ≈ ${dur((room / KILN_IDEAL) * 60)} of firing`;
}

/** The kiln held up now in the direction that concerns an asset (starved for upstream assets, blocked for downstream ones). */
function kilnHeldFor(s: SimState, idx: number): { op: 'starved' | 'blocked' | 'stopped'; since: number } | null {
  if (idx === KILN_INDEX || !s.machines[KILN_ID]) return null;
  const op = operationalState(s, KILN_ID);
  const since = assetStatus(s, KILN_ID).since;
  if (idx < KILN_INDEX && op === 'starved') return { op, since };
  if (idx > KILN_INDEX && op === 'blocked') return { op, since };
  return null;
}

/** 1 · Active root event records on the asset (stop, fault, below rate, conveyor stop, quality, logistics). */
function eventInsights(x: X): Ranked[] {
  const skip = new Set<OpEvent['type']>(['condition-abnormal', 'counter-inactive', 'starvation', 'blockage']);
  return x.roots
    .filter((e) => !skip.has(e.type))
    .slice(0, 2)
    .map((e): Ranked => {
      const imp = eventImpact(x.s, e, x.finance);
      const row = (re: RegExp) => imp.rows.find((r) => re.test(r.label));
      const kilnMin = e.acc.constraintMin;
      const parts: string[] = [];
      // The card's headline is the event's impact — the event row's impact line, so the row below can
      // show title, time and status only; the explanation is the "why".
      let impact: string | null = eventImpactLine(x.s, e, x.finance);
      if (e.category === 'production') {
        const assetLost = row(/^(Output not made|Tiles not transported)/)?.value;
        if (kilnMin > 0)
          parts.push(
            e.asset.equipmentId === KILN_ID
              ? 'The kiln is the line constraint: every minute it is held up is line output lost.'
              : `The kiln's hold-up is attributed to this event by the event engine (inferred from states and buffers).`,
          );
        else {
          const idx = x.flow?.idx ?? null;
          const held = idx != null ? kilnHeldFor(x.s, idx) : null;
          const cover = idx != null ? lineCoverWords(x.s, idx) : null;
          if (constrainingHere(x)) {
            parts.push(`The constraint trace names this stage: ${x.claim.evidence}. Every minute lost here is lost line output.`);
            impact = assetLost ? `${assetLost} not made so far` : null;
          } else if (held) {
            parts.push(
              `The kiln (line constraint) has been ${held.op} since ${x.clock(held.since)}, so line output is being lost; the event record does not attribute it to this stop — a possible contributing factor.`,
            );
            impact = assetLost ? `${assetLost} not made so far` : null;
          } else if (cover) parts.push(`${cap1(cover)}.`);
        }
        if (e.type === 'below-rate' && x.ideal && x.rate != null) parts.push(`Performance loss ≈ ${int(Math.max(0, x.ideal - x.rate))} tiles/h (${m2(Math.max(0, x.ideal - x.rate))} m²/h) below its ideal rate.`);
      } else if (e.category === 'quality') {
        const excess = row(/^Excess rejects/)?.value;
        const vs = row(/^Rate vs 24 h/)?.value;
        parts.push(`${vs ? `Reject rate ${vs} (24 h reference). ` : ''}${excess ? `${excess} of excess rejects so far.` : ''}`.trim() || 'Rejected tiles leave the line at sorting and are not output.');
      } else if (e.category === 'logistics') {
        const beyond = row(/^Minutes beyond/)?.value;
        if (beyond) parts.push(`${beyond} beyond the threshold so far.`);
        if (imp.notes[0]) parts.push(imp.notes[0]);
      }
      const cause = e.causes[0];
      if (cause) parts.push(cause.confidence === 'confirmed' ? `Cause: ${lower1(cause.text)} (${lower1(cause.basis)}).` : `${cause.confidence === 'likely' ? 'Likely cause' : 'Possible contributing factor'}: ${lower1(cause.text)} — not confirmed.`);
      if (constrainingHere(x) && e.category === 'production' && kilnMin > 0 && e.asset.equipmentId !== KILN_ID) parts.push('This stage is currently constraining output — every minute lost here is lost line output.');
      const ev: IntelEvidence[] = [eventEvidence(e)];
      const ownsSignal = !!e.trigger.signalId?.startsWith(`${x.id}.`);
      for (const o of e.trigger.observed.slice(0, 2)) {
        const label = `${o.label} ${o.value}${o.unit ? ` ${o.unit}` : ''}`;
        // Each observation links to the signal it describes (the reason code to the alarm row, not the run state).
        const name = OBSERVED_SIGNAL[o.label];
        const sig = name === 'state' && CONVEYOR_BY_ID[x.id] ? 'run_state' : name;
        ev.push(ownsSignal && sig ? signalEvidence(x, sig, label) : { kind: 'metric', label });
      }
      const scen = isScenarioEvent(e);
      return {
        rule: 'event',
        id: `event:${e.id}`,
        severity: sev(e),
        title: e.title,
        observed: `${impact ? `${sentence(cap1(impact))} ` : ''}${atDetection(x.clock, e)} ${e.end == null ? `Ongoing for ${dur(x.now - e.start)}.` : ''}`.trim(),
        why: parts.join(' ') || 'See the event record for its facts and evidence.',
        evidence: ev,
        next: e.recommendations[0] ?? null,
        basis: scen ? 'scenario' : 'event',
        basisLabel: scen ? `Scenario input · event rule ${e.trigger.ruleId}` : `Event rule ${e.trigger.ruleId}`,
        certainty: 'observed',
      };
    });
}

/** 7 · The asset's own data feed is stale. */
function staleInsight(x: X): Ranked[] {
  if (x.staleSince == null) return [];
  const f = x.s.feeds[x.id];
  const ev = x.events.find((e) => e.type === 'counter-inactive' && e.end == null);
  const scen = !!f?.scenarioId;
  const last = f?.lastState ? lower1(OPERATIONAL_STATE_LABEL[f.lastState === 'down' ? 'stopped' : f.lastState]) : 'unknown';
  return [
    {
      rule: 'stale',
      id: `stale:${x.id}`,
      severity: 'serious',
      title: `Data feed stale since ${x.clock(x.staleSince)}`,
      observed: `No signal from ${x.id} has updated for ${dur(x.now - x.staleSince)}: state, counter and rate are frozen at their last values (last reported ${last}${f?.lastRate != null ? ` at ${int(f.lastRate)} tiles/h` : ''}).`,
      why: `The current state of ${x.prof.name} is unknown. Values shown are the last ones received; shift figures are the simulation's running accounting, which the feed has not confirmed since ${x.clock(x.staleSince)}.`,
      evidence: [
        ...(ev ? [eventEvidence(ev)] : []),
        signalEvidence(x, CONVEYOR_BY_ID[x.id] ? 'tile_count' : 'count_total', `Counter frozen since ${x.clock(x.staleSince)}`),
        ...(x.metrics.stale ? [{ kind: 'metric' as const, label: x.metrics.stale.label }] : []),
      ],
      next: `Check the PLC / gateway link of ${x.id} (network, power, tag server) and confirm on the floor whether it is running; treat its state as unknown until data resumes.`,
      basis: scen ? 'scenario' : ev ? 'event' : 'rule',
      basisLabel: scen ? 'Scenario input · data feed loss' : ev ? `Event rule ${ev.trigger.ruleId}` : 'Data-feed check (rule-based)',
      certainty: 'observed',
    },
  ];
}

/** 7b · A figure of the panel rests on another asset's stale feed. */
function neighbourStaleInsight(x: X): Ranked[] {
  const mark = x.metrics.stale;
  if (!mark || x.staleSince != null) return [];
  const ids = mark.assetIds.filter((a) => a !== x.id);
  if (!ids.length) return [];
  const scen = ids.some((a) => x.s.feeds[a]?.scenarioId);
  return [
    {
      rule: 'neighbour-stale',
      id: `neighbour-stale:${x.id}`,
      severity: 'warning',
      title: `Figures not confirmed — ${ids.join(', ')} data stale`,
      observed: `The data feed of ${ids.join(', ')} has not updated since ${x.clock(mark.since)}; ${mark.note}`,
      why: `Treat the affected figures as last values or the simulation's running accounting until the feed resumes — no conclusion about ${x.prof.name} is drawn from them.`,
      evidence: [{ kind: 'metric', label: mark.label }],
      next: `Check the PLC / gateway link of ${ids.join(', ')}.`,
      basis: scen ? 'scenario' : 'rule',
      basisLabel: scen ? 'Scenario input · data feed loss' : 'Data-feed check (rule-based)',
      certainty: 'observed',
    },
  ];
}

/** A planned stop, changeover or maintenance stop in progress (not a fault). */
function plannedInsight(x: X): Ranked[] {
  if ((x.op !== 'planned' && x.op !== 'changeover') || !x.status) return [];
  const m = x.s.machines[x.id];
  const d = m?.activeDowntimeId ? x.s.downtime.find((r) => r.id === m.activeDowntimeId) : undefined;
  const code = d?.reasonCode ?? '';
  const label = d ? REASON_BY_CODE[code]?.label ?? code : 'Planned stop';
  const scen = d?.source === 'scenario';
  const changeover = code === 'CHG_PRODUCT';
  const maint = code === 'PLN_MAINT';
  return [
    {
      rule: 'planned',
      id: `planned:${x.id}`,
      severity: 'info',
      title: `${label} in progress`,
      observed: `${x.prof.name} has been stopped for ${lower1(label)} since ${x.clock(d?.start ?? x.status.since)} (${dur(x.now - (d?.start ?? x.status.since))}).`,
      why: changeover
        ? `A scheduled product changeover: it counts as changeover downtime in the shift, not as a fault${x.flow && lineCoverWords(x.s, x.flow.idx) ? `; ${lineCoverWords(x.s, x.flow.idx)}` : ''}.`
        : maint
          ? 'A condition-based maintenance stop: planned time, excluded from the shift plan; the developing fault is cleared when it completes.'
          : 'A planned stop: excluded from planned production time, so it is not a loss against the shift plan.',
      evidence: [signalEvidence(x, CONVEYOR_BY_ID[x.id] ? 'run_state' : 'state', `State ${changeover ? 'changeover' : 'planned'} since ${x.clock(d?.start ?? x.status.since)}`)],
      next: changeover ? REASON_ACTIONS.CHG_PRODUCT : maint ? 'After restart, confirm the vibration returns to the value expected at the load.' : null,
      basis: scen ? 'scenario' : 'rule',
      basisLabel: scen ? `Scenario input · ${SCENARIO_KIND_LABELS.maintenance.toLowerCase()}` : 'Planned-stop record (simulated calendar)',
      certainty: 'observed',
    },
  ];
}

/**
 * 2 · Starved / blocked now or > 5 % of the last 60 min. Waiting on a neighbour is normal line balancing
 * for a stage with spare capacity: without a stopped / slowed neighbour or an event record, it is
 * reported only while the machine is held now (as context, severity info), never as a problem.
 */
function flowInsight(x: X): Ranked[] {
  const r = x.recent;
  const f = x.flow;
  const op = x.op;
  if (!r || !f || x.prof.kind !== 'machine' || !op || x.staleSince != null) return [];
  if (op !== 'running' && op !== 'reduced' && op !== 'starved' && op !== 'blocked') return [];
  const now = op === 'starved' || op === 'blocked' ? op : null;
  const known = Math.max(1, r.known);
  const starvedShare = r.starved / known;
  const blockedShare = r.blocked / known;
  const kind: 'starved' | 'blocked' | null = now ?? (starvedShare > HELD_UP_SHARE || blockedShare > HELD_UP_SHARE ? (starvedShare >= blockedShare ? 'starved' : 'blocked') : null);
  if (!kind) return [];
  const starving = kind === 'starved';
  const share = starving ? starvedShare : blockedShare;
  const kiln = isKilnStage(x);
  const beforeKiln = f.idx < KILN_INDEX;
  const flowEvent = x.events.find((e) => e.end == null && e.type === (starving ? 'starvation' : 'blockage'));
  const rootId = flowEvent?.consequenceOf ?? flowEvent?.causes.find((c) => c.relatedEventId)?.relatedEventId;
  const root = rootId ? eventById(x.s, rootId) : undefined;
  const holder = traceHolder(x.s, f, kind);
  const neighbour = starving ? f.up : f.down;
  const buf = starving ? f.inBuf : f.outBuf;
  const cut = starving ? f.inCut : f.outCut;
  const scheduled = holder?.kind === 'planned' && !root;
  const balancing = !holder && !root && !flowEvent;
  // Plain balancing that is not happening now is not worth an insight (the facets say how it is paced).
  if (balancing && !now && !kiln) return [];

  const since = x.status!.since;
  const observed = [
    now
      ? `${x.prof.name} has been ${kind} since ${x.clock(since)} (${dur(x.now - since)}); ${kind} ${pct(share)} of the last ${r.minutes} min.`
      : `${x.prof.name} was ${kind} ${pct(share)} of the last ${r.minutes} min (running now).`,
    cut ? `${nameOf(cut)} (${cut}) is stopped, so ${starving ? 'nothing reaches it' : 'it cannot discharge'}.` : buf ? `${starving ? 'Input' : 'Output'} buffer ${bufferWords(x.s, buf)}.` : '',
    neighbour ? `${starving ? 'Upstream' : 'Downstream'}, ${lower1(neighbour.name)} is ${stageWords(x.s, neighbour).words}.` : '',
  ].filter(Boolean);

  // Why it matters, by the asset's place in the line.
  let why: string;
  let severity: IntelInsight['severity'];
  if (kiln) {
    severity = now ? 'serious' : 'warning';
    // One lost-output figure per condition: the event impact model's (the event row beside it says the
    // same), from the record that carries the loss — the root when the starvation is its consequence.
    const lossEv = flowEvent ? (flowEvent.consequenceOf ? (root ?? null) : flowEvent) : null;
    const lost = lossEv ? eventImpact(x.s, lossEv, x.finance).rows.find((r) => /^Line good output lost/.test(r.label))?.value : undefined;
    why = lossEv && lost
      ? `The kiln is the line constraint: every minute it is ${kind} is line output lost — ${lost} so far (${lossEv.id}: kiln held up ${int(lossEv.acc.constraintMin)} min, event impact model).`
      : `The kiln is the line constraint: every minute it is ${kind} is line output lost — at most ≈ ${m2(KILN_IDEAL / 60)} m² per minute at its ideal ${int(KILN_IDEAL)} tiles/h${now ? ` (≤ ${m2(((x.now - since) * KILN_IDEAL) / 60)} m² since ${x.clock(since)} at the ideal rate, an upper bound)` : ''}.`;
  } else if (starving && beforeKiln) {
    const held = kilnHeldFor(x.s, f.idx);
    severity = balancing || scheduled ? 'info' : 'warning';
    why = held
      ? `The kiln (line constraint) is already starved (since ${x.clock(held.since)}): line output is being lost until the supply resumes.`
      : `${f.stage.name} has spare capacity and the kiln keeps firing meanwhile — ${lineCoverWords(x.s, f.idx)}. If the starvation lasts longer, the kiln (line constraint) loses output.`;
  } else if (starving) {
    severity = 'info';
    why = `${f.stage.name} works downstream of the kiln and can only process what it fires: waiting here loses no line output.`;
  } else if (beforeKiln) {
    severity = 'info';
    why = `${f.stage.name} has spare capacity ahead of the kiln: it catches up once ${neighbour ? lower1(neighbour.name) : 'the next stage'} draws again — no line output is lost by waiting here.`;
  } else {
    const held = kilnHeldFor(x.s, f.idx);
    severity = balancing || scheduled ? 'info' : 'warning';
    why = held
      ? `The blockage has reached the kiln (blocked since ${x.clock(held.since)}): line output is being lost until the take-away resumes.`
      : `If the blockage continues it moves upstream to the kiln — ${lineCoverWords(x.s, f.idx)}; after that the kiln is blocked and line output is lost.`;
  }
  const causeText = root
    ? `Likely cause (event record): ${root.title} (${root.id}).`
    : holder
      ? holder.kind === 'planned'
        ? `${cap1(holder.words)} — a scheduled stop, not a fault.`
        : `Possible contributing factor: ${holder.words} — inferred from states and buffer levels, requires confirmation.`
      : flowEvent?.causes[0]
        ? `${flowEvent.causes[0].confidence === 'likely' ? 'Likely cause' : 'Possible contributing factor'} (event record): ${lower1(flowEvent.causes[0].text)} — requires confirmation.`
        : kiln
          ? `No stopped or slowed asset is found ${starving ? 'upstream' : 'downstream'} now: short stops or speed losses ${neighbour ? `at ${lower1(neighbour.name)}` : 'next to it'} are a possible contributing factor — requires investigation.`
          : 'No stopped or slowed asset was found in that direction: normal line balancing.';
  why = `${why} ${causeText}`;

  const culprit = root?.asset.equipmentId ?? holder?.assetId ?? null;
  const ref = root ? ` — see ${root.id}` : '';
  let next: string | null;
  if (scheduled) next = kiln ? `Check when ${culprit} restarts against the kiln infeed and be ready to refill the buffers ahead of the kiln.` : null;
  else if (culprit && (kiln || (starving && beforeKiln) || (!starving && !beforeKiln)))
    next = `Restore ${culprit} first${ref}; ${kiln ? 'every minute counts at the kiln' : starving ? 'keep the buffers ahead of the kiln stocked' : 'clear the take-away before the blockage reaches the kiln'}.`;
  else if (culprit) next = `No action needed at ${x.id}: it ${starving ? 'resumes' : 'catches up'} when ${culprit} runs again${ref}.`;
  else if (kiln) next = `Check ${neighbour ? `${lower1(neighbour.name)} (${neighbour.machines.join(', ')})` : 'the neighbouring stage'} for short stops and speed losses, and keep ${buf ? lower1(buf.name) : 'its buffer'} ${starving ? 'stocked' : 'clear'}.`;
  else next = null;

  const evidence: IntelEvidence[] = [
    signalEvidence(x, 'state', now ? `State ${kind.toUpperCase()} since ${x.clock(since)}` : `State running · ${kind} ${pct(share)} of ${r.minutes} min`),
    { kind: 'metric', label: `Starved ${pct(starvedShare)} · blocked ${pct(blockedShare)} of the last ${r.minutes} min` },
    ...(buf ? [{ kind: 'metric' as const, label: `${buf.name} ${pct(level(x.s, buf))}` }] : []),
    ...(flowEvent ? [eventEvidence(flowEvent)] : []),
    ...(root ? [eventEvidence(root)] : []),
  ];
  const scen = (root && isScenarioEvent(root)) || (flowEvent && isScenarioEvent(flowEvent));
  return [
    {
      rule: 'flow',
      id: `flow:${x.id}`,
      severity,
      title: starving ? 'Upstream material starvation' : 'Downstream blockage',
      observed: observed.join(' '),
      why,
      evidence,
      next,
      basis: scen ? 'scenario' : flowEvent ? 'event' : 'rule',
      basisLabel: scen ? `Scenario input · ${flowEvent ? `event rule ${flowEvent.trigger.ruleId}` : 'flow rule'}` : flowEvent ? `Event rule ${flowEvent.trigger.ruleId}` : 'Flow rule · minute log (rule-based)',
      certainty: 'observed',
    },
  ];
}

/**
 * Conveyors: running empty (nothing to carry) or accumulating (the receiving stage cannot take tiles).
 * A conveyor moves what the next stage takes, so this is context — where the line is held — not a loss
 * at the conveyor.
 */
function conveyorFlowInsight(x: X): Ranked[] {
  const f = x.flow;
  const conv = CONVEYOR_BY_ID[x.id];
  if (!f || !conv || x.staleSince != null || (x.op !== 'idle' && x.op !== 'blocked')) return [];
  const empty = x.op === 'idle';
  const supplier = conv.from ? STAGES[STAGE_INDEX[conv.from]] : f.up;
  const neighbour = empty ? supplier : f.stage;
  const w = neighbour ? stageWords(x.s, neighbour) : null;
  const holder = traceHolder(x.s, f, empty ? 'starved' : 'blocked');
  const since = x.status!.since;
  return [
    {
      rule: 'flow',
      id: `flow:${x.id}`,
      severity: 'info',
      title: empty ? 'Running empty' : 'Accumulating',
      observed: `${x.prof.name} has been ${empty ? 'running without tiles' : 'accumulating tiles it cannot hand over'} since ${x.clock(since)} (${dur(x.now - since)}).${neighbour && w ? ` ${cap1(lower1(neighbour.name))} ${empty ? 'feeding it' : 'receiving from it'} is ${w.words}.` : ''}`,
      why: `A conveyor carries what the next stage takes, so no loss arises at the conveyor itself.${holder && holder.assetId !== x.id ? ` The line is held at ${holder.words}${holder.kind === 'planned' ? ' — a scheduled stop' : ' — a possible contributing factor, inferred from states'}.` : ''}`,
      evidence: [signalEvidence(x, 'run_state', `Run state ${empty ? 'running empty' : 'accumulating'} since ${x.clock(since)}`), signalEvidence(x, 'tile_count', x.rate != null ? `Carrying ${int(x.rate)} ${conveyorRateUnit(x.id)}` : 'Rate not reported')],
      next: null,
      basis: 'rule',
      basisLabel: 'Flow rule · conveyor state (rule-based)',
      certainty: 'observed',
    },
  ];
}

/**
 * 3 · Rule-based condition level ≥ watch (assess, src/sim/health.ts): vibration against the value
 * expected at the current load, its 3-h trend extrapolated to the alarm / trip limits, the component
 * temperature against its expectation. The level rests on the 60-min mean of the running samples; a
 * single reading above a limit is reported as such without changing the level. No failure probability.
 */
/** The running samples assess() rests its level on: every 5 min over the last 60 min (src/sim/health.ts). */
function runningSamples(x: X): SensorReading[] {
  const now = Math.max(0, x.now - 1);
  const out: SensorReading[] = [];
  for (let t = Math.max(0, now - 180); t <= now; t += 5) {
    const r = t > now - 60 ? sensorsAt(x.s, x.id, t) : null;
    if (r) out.push(r);
  }
  return out.filter((r) => r.running);
}

/** The 60-min mean vibration of the running samples (the value the condition rule compares with its limits). */
function runningMean(x: X): number | null {
  const r = runningSamples(x);
  return r.length ? r.reduce((a, b) => a + b.vibration, 0) / r.length : null;
}

/**
 * "Before the stop": the means of the running samples the condition level rests on (the last 60 min of
 * running) — the minute a machine stops can already read like a repaired one, so a single last reading
 * is not what the level describes. `expected` is the mean vibration expected at those samples' load.
 */
function runningBefore(x: X): { vibration: number; temperature: number; load: number; expected: number } | null {
  const r = runningSamples(x);
  if (!r.length) return null;
  const a = HEALTH_BY_ID[x.id];
  const avg = (f: (s: SensorReading) => number) => r.reduce((acc, s) => acc + f(s), 0) / r.length;
  return { vibration: avg((s) => s.vibration), temperature: avg((s) => s.temperature), load: avg((s) => s.load), expected: avg((s) => expectedVib(a, s.load, true)) };
}

function conditionInsight(x: X): Ranked[] {
  const h = x.health;
  if (!h || x.staleSince != null || !(h.level === 'watch' || h.level === 'warning' || h.level === 'alarm')) return [];
  const a = HEALTH_BY_ID[x.id];
  const comp = componentWords(a.component);
  const head = cap1(comp.split(' (')[0]);
  const running = h.reading.running;
  // The level rests on the running samples of the last 60 min. While the asset is stopped the last
  // sample is an idle reading: quote what the level rests on — the running samples before the stop —
  // and no extrapolation (a trend of a stopped machine says nothing about when it reaches a limit).
  const before = running ? null : runningBefore(x);
  const at = before ?? h.reading;
  const vib = at.vibration;
  const exp = before ? before.expected : expectedVib(a, at.load, true);
  const ratio = running ? h.vibrationRatio : (h.vibrationRatio ?? vib / exp);
  const trend = h.trend;
  const rising = running && trend != null && trend > 0.05;
  // The 60-min mean the rule compares with the limits: recomputed from the running samples it uses.
  const mean = runningMean(x);
  const tExp = expectedTemp(a, at.load);
  const temp = at.temperature;
  const tempHigh = temp >= tExp + 4;
  const tempAlarm = temp >= a.temp.alarm;
  // The alarm the rule raised: the 60-min vibration mean at / above its limit, else the temperature.
  const vibAlarm = h.level === 'alarm' && ((mean != null && mean >= a.vib.alarm) || !tempAlarm);
  const base =
    h.level === 'alarm'
      ? vibAlarm
        ? 'Vibration at alarm limit'
        : `${head} temperature at alarm limit`
      : rising
        ? 'Vibration rising'
        : ratio != null && ratio >= 1.25
          ? 'Vibration above expected'
          : tempHigh
            ? `${head} temperature above expected`
            : 'Condition watch';
  const title = running ? base : `${base} before the stop`;
  // The first sentence is the card's headline (short); the limits follow it.
  const obs: string[] = [
    running
      ? `Vibration ${fmt1(vib)} mm/s RMS at the ${comp}${ratio != null ? `: ${ratio.toFixed(1)}× expected (${fmt1(exp)} mm/s at this load)` : ''}${rising ? `, rising ${trend!.toFixed(2)} mm/s per hour` : ''}.`
      : `Stopped since ${x.clock(x.status?.since ?? x.now)}; before the stop, vibration averaged ${fmt1(vib)} mm/s RMS at the ${comp}${ratio != null ? `: ${ratio.toFixed(1)}× expected (${fmt1(exp)} mm/s at that load)` : ''}.`,
    `${running ? (rising ? 'Trend over the last 3 h of running. ' : '') : 'That is the mean of its running samples of the last 60 min. '}Limits: alarm ${a.vib.alarm}, trip ${a.vib.trip} mm/s.`,
  ];
  if (running && vib >= a.vib.alarm && h.level !== 'alarm' && mean != null) obs.push(`The reading is above the alarm limit; its 60-min mean (${fmt1(mean)} mm/s) is not yet.`);
  if (tempHigh) obs.push(`${head} temperature ${running ? '' : 'averaged '}${temp.toFixed(0)} °C (component, not process), ${(temp - tExp).toFixed(0)} °C above the ${tExp.toFixed(0)} °C expected at ${running ? 'this' : 'that'} load (alarm ${a.temp.alarm} °C).`);
  const repair = `${(a.repair[0] / 60).toFixed(1)}–${(a.repair[1] / 60).toFixed(1)} h`;
  const failure = REASON_BY_CODE[a.failureReason]?.label.toLowerCase() ?? 'component failure';
  const meanAbove = mean != null && mean >= a.vib.alarm;
  const eta = !running
    ? ''
    : h.etaAlarmH != null
      ? `If the 3-h trend continues, the 60-min mean reaches the alarm limit in ≈ ${formatH(h.etaAlarmH)}${h.etaTripH != null ? ` and the trip limit in ≈ ${formatH(h.etaTripH)}` : ''} (linear extrapolation, not a forecast of failure). `
      : h.etaTripH != null
        ? `The 60-min mean${mean != null ? ` (${fmt1(mean)} mm/s)` : ''} is ${meanAbove ? 'above' : 'at'} the alarm limit; if the 3-h trend continues it reaches the trip limit in ≈ ${formatH(h.etaTripH)} (linear extrapolation, not a forecast of failure). `
        : meanAbove
          ? `The 60-min mean (${fmt1(mean!)} mm/s) is above the alarm limit. `
          : '';
  const lineWords = isKilnStage(x) ? ' — line output is lost while the kiln is down' : '; whether that costs line output depends on the buffers at the time';
  const scen = activeScenario(x.s, (sc) => sc.kind === 'degradation' && sc.equipmentId === x.id);
  const ev = x.events.find((e) => e.type === 'condition-abnormal' && e.end == null);
  return [
    {
      rule: 'condition',
      id: `condition:${x.id}`,
      severity: h.level === 'alarm' ? 'critical' : h.level === 'warning' ? 'serious' : 'warning',
      title,
      observed: obs.join(' '),
      why: `${eta}${running ? `A failure of the ${comp} would stop ${x.prof.name} for an estimated ${repair} (${failure})${lineWords}.` : `Check the ${comp} before the restart: a failure would stop ${x.prof.name} for an estimated ${repair} (${failure})${lineWords}.`} Possible contributing factor: ${lower1(a.component.split(' · ')[0])} wear or damage — only an inspection can confirm.`,
      evidence: [
        signalEvidence(x, 'vibration', `Vibration ${fmt1(vib)} mm/s${running ? '' : ' · 60-min running mean before the stop'} (expected ${fmt1(exp)}, alarm ${a.vib.alarm})`),
        ...(tempHigh ? [signalEvidence(x, 'temperature', `${head} temperature ${temp.toFixed(0)} °C${running ? '' : ' · mean before the stop'} (alarm ${a.temp.alarm})`)] : []),
        ...(ev ? [eventEvidence(ev)] : []),
        // The rule in a few words (how it works is the basis tag's and the Condition facet's tooltip).
        { kind: 'rule', label: `Condition rule · level ${h.level}` },
      ],
      next: a.action,
      basis: scen ? 'scenario' : 'rule',
      basisLabel: scen ? 'Scenario input · simulated condition model (rule-based)' : 'Simulated condition model (rule-based)',
      certainty: 'observed',
    },
  ];
}

/** 4 · Below its own set rate while not starved / blocked. */
function rateInsight(x: X): Ranked[] {
  if (x.op !== 'reduced' || !x.ideal || !x.flow || x.rate == null || x.roots.some((e) => e.type === 'below-rate')) return [];
  const rate = x.rate;
  const loss = Math.max(0, x.ideal - rate);
  const f = x.flow;
  const kiln = isKilnStage(x);
  // Best case for the stage: the other machines at their ideal rate.
  const stageBest = f.stage.machines.reduce((a, m) => a + (m === x.id ? rate : (OPS_BY_ID[m]?.idealRatePerHour ?? 0)), 0);
  const scen = activeScenario(x.s, (sc) => (sc.kind === 'reduced-rate' && sc.equipmentId === x.id) || (sc.kind === 'bottleneck' && sc.stage === f.stage.id));
  const why = kiln
    ? `Performance loss ≈ ${int(loss)} tiles/h (${m2(loss)} m²/h) below its ideal rate. This is the line constraint — the loss is lost line output.`
    : stageBest < KILN_IDEAL
      ? `Performance loss ≈ ${int(loss)} tiles/h (${m2(loss)} m²/h). Even with ${f.stage.machines.length > 1 ? 'the other machines of the stage at their ideal rate' : 'no other loss'}, ${lower1(f.stage.name)} can make ≈ ${int(stageBest)} tiles/h — below the kiln's ${int(KILN_IDEAL)} tiles/h, so the buffers between them ${f.idx < KILN_INDEX ? 'run down' : 'fill up'} and, if it lasts, the kiln is held up.`
      : `Performance loss ≈ ${int(loss)} tiles/h (${m2(loss)} m²/h), but ${lower1(f.stage.name)} can still make ≈ ${int(stageBest)} tiles/h, above the kiln's ${int(KILN_IDEAL)} tiles/h — spare capacity absorbs it; no line output is lost.`;
  return [
    {
      rule: 'rate',
      id: `rate:${x.id}`,
      severity: kiln || stageBest < KILN_IDEAL ? 'warning' : 'info',
      title: 'Running below its set rate',
      observed: `${x.prof.name} has run at ${pct(rate / x.ideal)} of its ideal rate since ${x.clock(x.status!.since)} at its own pace (not starved or blocked): ${int(rate)} vs ${int(x.ideal)} tiles/h.`,
      why: `${why} ${scen ? `Cause: rate reduction applied by a scenario (${scen.label}).` : 'Possible contributing factor: speed setpoint lowered or frequent short stops — not distinguishable from the rate signal alone.'}`,
      evidence: [signalEvidence(x, 'rate', `Rate ${int(rate)} tiles/h (ideal ${int(x.ideal)})`), signalEvidence(x, 'state', `State reduced since ${x.clock(x.status!.since)}`)],
      next: `Check the ${x.id} speed setpoint against the recipe and look for repeated short stops in its alarm log.`,
      basis: scen ? 'scenario' : 'rule',
      basisLabel: scen ? 'Scenario input · rate reduction' : 'Rate rule (rule-based)',
      certainty: 'observed',
    },
  ];
}

/** 5 · The constraint claim names the asset's stage as currently constraining output (traced stages; kiln stops are rule 1). */
function roleInsight(x: X, already: Ranked[]): Ranked[] {
  if (!constrainingHere(x) || x.staleSince != null) return [];
  // The kiln stopped / slowed is already the event or rate insight, which says it is lost line output.
  if (already.some((i) => i.rule === 'event' || i.rule === 'rate')) return [];
  const st = x.flow?.stage;
  const machines = st?.machines.join(', ') ?? x.id;
  const cut = x.flow?.inCut ?? x.flow?.outCut ?? null;
  const next = cut
    ? `Restore ${cut} first: the stopped ${lower1(CONVEYOR_BY_ID[cut]?.name ?? 'conveyor')} cuts the transfer ${x.flow?.inCut ? 'into' : 'out of'} ${lower1(x.claim.name)}.`
    : x.claim.kind === 'starving'
      ? `Restore ${lower1(x.claim.name)} capacity (${machines}): check rate settings and recent stops; keep the buffer ahead of the kiln stocked.`
      : x.claim.kind === 'blocking'
        ? `Clear the take-away at ${lower1(x.claim.name)} (${machines}) before the kiln outfeed fills.`
        : x.claim.kind === 'kiln-slow'
          ? 'Get the kiln back to its design rate: check the roller speed setpoint and the recent alarm log.'
          : 'Restore the kiln first — every minute it is stopped is line output lost.';
  return [
    {
      rule: 'role',
      id: `role:${x.id}`,
      severity: 'warning',
      title: 'Constraining line output',
      observed: `${sentence(cap1(x.claim.evidence))}`,
      why: `Every minute lost here is lost line output — ≈ ${m2(KILN_IDEAL / 60)} m² per minute at the kiln's ideal rate.`,
      evidence: [{ kind: 'rule', label: `${x.marker.label} · ${x.claim.name} (trace over ${x.claim.window})` }],
      next,
      basis: 'rule',
      basisLabel: `Constraint trace · ${x.claim.window} (rule-based)`,
      certainty: x.claim.kind === 'starving' || x.claim.kind === 'blocking' ? 'likely' : 'observed',
    },
  ];
}

/** 6 · Quality: rejects attributed to the stage above its 24 h rate (machines), the station's / line's reject rate. */
function qualityInsight(x: X): Ranked[] {
  const s = x.s;
  if (x.staleSince != null) return [];
  const rise = risingDefects(s, x.shift);
  if (x.prof.kind === 'station' || (x.prof.kind === 'machine' && x.prof.stage === 'SORT')) {
    const st = x.prof.stationId ? INSPECTION_STATIONS.find((i) => i.id === x.prof.stationId) : null;
    if (st && !st.detects.length) {
      const last = lastSample(s, st.id);
      if (!last || last.result === 'pass') return [];
      return [
        {
          rule: 'quality',
          id: `quality:${x.id}`,
          severity: 'warning',
          title: 'Last laboratory sample out of specification',
          observed: `Sample of ${x.clock(last.time)} (batch ${last.batchId}): ${last.measurement ?? 'out of specification'}.`,
          why: 'A failed laboratory check calls the batch into question until a retest passes. Possible contributing factor: the firing of that batch — requires investigation.',
          evidence: [signalEvidence(x, 'sample_result', `Sample ${x.clock(last.time)} · out of spec`)],
          next: `Retest batch ${last.batchId} as requested and hold its pallets until the retest passes.`,
          basis: 'rule',
          basisLabel: 'Laboratory sample record (simulated)',
          certainty: 'observed',
        },
      ];
    }
    // An active quality event on the asset is already the first insight (rule 1).
    if (x.roots.some((e) => e.category === 'quality')) return [];
    const q = qualityIn(s, x.shift);
    const by = st ? q.byStation[st.id] : { inspected: q.inspected, rejected: q.rejected };
    if (!by || by.inspected < QUALITY_RISE.minTiles) return [];
    const rate = by.rejected / by.inspected;
    const limit = s.rules.rejectRateMax;
    const mine = rise.rising.filter((r) => !st || st.detects.includes(r.defect));
    if (rate <= limit && !mine.length) return [];
    const top = mine[0];
    const origin = top ? STAGES[STAGE_INDEX[DEFECTS[top.defect].origin]].name : null;
    const scen = activeScenario(s, (sc) => sc.kind === 'quality-deterioration');
    const ev = x.events.find((e) => e.category === 'quality' && e.end == null);
    return [
      {
        rule: 'quality',
        id: `quality:${x.id}`,
        severity: rate > limit ? 'serious' : 'warning',
        title: rate > limit ? `Reject rate above the ${pct(limit)} limit` : `${top!.label} rising`,
        observed: `${int(by.rejected)} of ${int(by.inspected)} tiles rejected ${st ? 'here' : 'at sorting'} this shift (${pct(rate, 2)}; limit ${pct(limit)}).${top ? ` ${top.label}: ${pct(top.recentRate ?? 0, 2)} of tiles in the last 2 h vs ${pct(top.referenceRate ?? 0, 2)} in the 24 h before (${top.ratio!.toFixed(1)}×).` : ''}`,
        why: `Rejected tiles leave the line here and are not output${top ? ` — ≈ ${m2(Math.max(0, top.excessTiles))} m² above the reference rate in the last 2 h` : ''}.${origin ? ` Possible origin: ${lower1(origin)} — the model attributes ${top!.label.toLowerCase()} there; a hypothesis to check, not a confirmed cause.` : ''}`,
        evidence: [
          // A station's reject counter is its own signal; the sorting line's shift rate is a figure of the gauge and vision counters.
          st ? signalEvidence(x, 'count_rejected', `Reject rate ${pct(rate, 2)} this shift`) : { kind: 'metric' as const, label: `Reject rate ${pct(rate, 2)} this shift (gauge + vision)` },
          ...(top ? [{ kind: 'rule' as const, label: `Deterioration rule Q-DET: ≥ ${rise.threshold.ratio}× the 24 h rate` }] : []),
          ...(ev ? [eventEvidence(ev)] : []),
        ],
        next: top ? DEFECT_ACTIONS[top.defect] : 'Review the reject records of the last hour by defect category and check the origin stage named most often.',
        basis: scen ? 'scenario' : ev ? 'event' : 'rule',
        basisLabel: scen ? 'Scenario input · quality rule' : ev ? `Event rule ${ev.trigger.ruleId}` : 'Quality rule · shift vs limit and 24 h (rule-based)',
        certainty: 'observed',
      },
    ];
  }
  // Machines of a stage the model attributes defects to.
  const stage = x.prof.stage;
  if (x.prof.kind !== 'machine' || !stage) return [];
  const defects = defectsOf(stage);
  if (!defects.length) return [];
  const t = sumBuckets(s, x.id, x.shift);
  const ref = sumBuckets(s, x.id, resolvePeriod('24h', s.minute));
  const rate = t.count > 0 ? t.rejects / t.count : 0;
  const refRate = ref.count > 0 ? ref.rejects / ref.count : 0;
  const rising = rise.rising.filter((r) => defects.includes(r.defect));
  const above = t.count >= QUALITY_RISE.minTiles && refRate > 0 && rate >= refRate * QUALITY_RISE.ratio;
  if (!above && !rising.length) return [];
  const top = rising[0];
  const shiftByDefect = qualityIn(s, x.shift).byDefect;
  const frequent = [...defects].sort((a, b) => (shiftByDefect[b] ?? 0) - (shiftByDefect[a] ?? 0))[0];
  const d: DefectCategory = top?.defect ?? frequent;
  const scen = activeScenario(s, (sc) => sc.kind === 'quality-deterioration' && (!sc.stage || sc.stage === stage));
  const ev = s.events.find((e) => e.category === 'quality' && e.end == null && e.asset.stage === stage);
  const stageName = STAGES[STAGE_INDEX[stage]].name.toLowerCase();
  return [
    {
      rule: 'quality',
      id: `quality:${x.id}`,
      severity: 'warning',
      title: top ? `${top.label} rising · possible origin ${stageName}` : `Rejects attributed to ${stageName} above the 24 h rate`,
      observed: `${int(t.rejects)} tiles rejected at sorting this shift for defects the model attributes to ${x.id} (${defects.map((c) => DEFECTS[c].label.toLowerCase()).join(', ')}): ${pct(rate, 2)} of its output vs ${pct(refRate, 2)} over the last 24 h.${top ? ` ${top.label} at sorting: ${pct(top.recentRate ?? 0, 2)} of tiles in the last 2 h vs ${pct(top.referenceRate ?? 0, 2)} before (${top.ratio!.toFixed(1)}×).` : ''}`,
      why: `≈ ${m2(Math.max(0, t.rejects - t.count * refRate))} m² of rejects above the 24 h rate this shift. The origin is a modelled attribution — a possible contributing factor to check at ${x.id}, not a confirmed cause.`,
      evidence: [
        { kind: 'metric', label: `Attributed rejects ${pct(rate, 2)} this shift vs ${pct(refRate, 2)} (24 h)` },
        ...(top ? [{ kind: 'rule' as const, label: `Deterioration rule Q-DET: ${top.label.toLowerCase()} ≥ ${rise.threshold.ratio}× its 24 h rate` }] : []),
        ...(ev ? [eventEvidence(ev)] : []),
      ],
      next: DEFECT_ACTIONS[d],
      basis: scen ? 'scenario' : ev ? 'event' : 'rule',
      basisLabel: scen ? 'Scenario input · quality rule' : ev ? `Event rule ${ev.trigger.ruleId}` : 'Quality rule · shift vs 24 h (rule-based)',
      certainty: 'possible',
    },
  ];
}

/**
 * Buffers: what the level means depends on the side of the kiln. Ahead of the kiln an empty buffer
 * starves the next stage (a full one is normal balancing: the stage filling it has spare capacity);
 * behind the kiln a full buffer moves the blockage towards the kiln (a low one is normal: the stages
 * after the kiln are faster and wait for tiles).
 */
function bufferInsight(x: X): Ranked[] {
  const b = bufferFlow(x);
  if (!b || b.staleNeighbour) return [];
  const s = x.s;
  const f = b.level / b.buf.capacity;
  const ahead = bufferAhead(b);
  const feedsKiln = b.down?.id === LINE.designConstraint;
  const fedByKiln = b.up?.id === LINE.designConstraint;
  const emptyMin = b.net < -1 && b.level > 0 ? (b.level / -b.net) * 60 : null;
  const fullMin = b.net > 1 ? ((b.buf.capacity - b.level) / b.net) * 60 : null;
  const upW = b.up ? stageWords(s, b.up) : null;
  const downW = b.down ? stageWords(s, b.down) : null;
  const up = b.up ? lower1(b.up.name) : 'the stage filling it';
  const down = b.down ? lower1(b.down.name) : 'the next stage';
  const flowWords = `${cap1(up)} supplies ${b.show(b.inflow)} while ${down} draws ${b.show(b.outflow)} (${b.net >= 0 ? '+' : '−'}${b.show(Math.abs(b.net))}${b.bulk ? ', simulated' : ''}).`;
  const observed = `Level ${pct(f)}${b.bulk ? ' (level only — no level-to-mass calibration)' : ` (${int(b.level)} of ${int(b.buf.capacity)} tiles)`}. ${flowWords}`;
  const evidence: IntelEvidence[] = [signalEvidence(x, 'level', `Level ${pct(f)}`), { kind: 'metric', label: `Net ${b.net >= 0 ? '+' : '−'}${b.show(Math.abs(b.net))}` }];
  const base = { rule: 'buffer' as const, id: `buffer:${x.id}`, observed, evidence, basis: 'rule' as const, basisLabel: 'Buffer rule · level and net flow (rule-based)', certainty: 'observed' as const };
  const stoppedWords = (w: StageState | null) => (w?.culpritKind === 'stopped' || w?.culpritKind === 'planned' ? w.words : null);

  // Ahead of the kiln, running empty within the hour (or nearly empty and still emptying).
  if (ahead && ((emptyMin != null && emptyMin <= BUFFER_ETA_MIN) || (f <= BUFFER_BAND.low && b.net < 0))) {
    const upStop = stoppedWords(upW);
    return [
      {
        ...base,
        severity: feedsKiln ? 'serious' : 'warning',
        title: emptyMin != null ? `Runs empty in ≈ ${dur(emptyMin)}` : 'Nearly empty',
        why: `When it is empty ${down} is starved${feedsKiln ? ' — it feeds the kiln, the line constraint, so that is lost line output' : `; ${lineCoverWords(s, STAGE_INDEX[b.down!.id]) ?? 'the kiln follows once the buffers after it run down'}`}.${upStop ? ` Possible contributing factor: ${up} ${upStop}.` : ''}`,
        next: `Restore ${up} output (${b.up?.machines.join(', ') ?? '—'}) before the buffer empties, or plan a controlled slow-down of ${down}.`,
      },
    ];
  }
  // Behind the kiln, filling up within the hour (or nearly full and still filling).
  if (!ahead && ((fullMin != null && fullMin <= BUFFER_ETA_MIN) || (f >= BUFFER_BAND.high && b.net > 0))) {
    const downStop = stoppedWords(downW);
    return [
      {
        ...base,
        severity: fedByKiln ? 'serious' : 'warning',
        title: fullMin != null ? `Full in ≈ ${dur(fullMin)}` : 'Nearly full',
        why: `When it is full ${up} is blocked${fedByKiln ? ' — that is the kiln, the line constraint, so line output is lost' : ` and the blockage moves towards the kiln — ${lineCoverWords(s, STAGE_INDEX[b.up!.id]) ?? 'then the kiln is blocked'}`}.${downStop ? ` Possible contributing factor: ${down} ${downStop}.` : ''}`,
        next: `Restore the take-away at ${down} (${b.down?.machines.join(', ') ?? '—'}) before the buffer is full.`,
      },
    ];
  }
  // A neighbour is stopped: the buffer is not drawn, or not filled.
  const downStop = stoppedWords(downW);
  if (downStop)
    return [
      {
        ...base,
        severity: 'info',
        title: `Not drawn — ${down} ${downW!.culpritKind === 'planned' ? 'in a planned stop' : 'stopped'}`,
        why: `${f >= 0.99 ? `It is full, so ${up} is blocked.` : `${cap1(up)} keeps filling it${fullMin != null ? ` (full in ≈ ${dur(fullMin)})` : ''}; once it is full ${up} is blocked.`} ${ahead ? `${cap1(up)} has spare capacity ahead of the kiln, so the loss is at ${down}, not here.` : 'Behind the kiln, a full buffer moves the blockage towards the kiln.'} ${cap1(down)} is ${downStop}.`,
        next: null,
      },
    ];
  const upStop = stoppedWords(upW);
  if (upStop) {
    const cover = b.outflow > 0 ? (b.level / b.outflow) * 60 : null;
    return [
      {
        ...base,
        severity: ahead ? 'warning' : 'info',
        title: `Not filled — ${up} ${upW!.culpritKind === 'planned' ? 'in a planned stop' : 'stopped'}`,
        why: `${cover != null ? `It covers ≈ ${dur(cover)} of ${down} at its current ${b.show(b.outflow)}` : `${cap1(down)} is not drawing from it now`}${ahead ? `; then ${down} is starved${feedsKiln ? ' — the kiln, so line output is lost' : ''}` : ''}. ${cap1(up)} is ${upStop}.`,
        next: ahead ? `Restore ${up} (${b.up?.machines.join(', ') ?? '—'}) before the buffer runs out.` : null,
      },
    ];
  }
  // Nothing moves through it: the line is held on both sides (the buffer is not the cause).
  if (b.inflow < 1 && b.outflow < 1)
    return [
      {
        ...base,
        severity: 'info',
        title: 'No flow through it',
        why: `${cap1(up)} is ${upW?.words ?? 'not running'} and ${down} is ${downW?.words ?? 'not running'}: the line is held elsewhere, not by this buffer.`,
        next: null,
      },
    ];
  // One side is itself held or sends / takes nothing: the buffer is not filled or not drawn — said with
  // its run-out time, neutrally (the line is held further away, not here). A stage held BY this buffer
  // (blocked because it is full, starved because it is empty) is the buffer's own level, not this case.
  const cover = b.outflow >= 1 ? (b.level / b.outflow) * 60 : null;
  const notFilled = b.up && (upW?.held === 'starved' || (b.inflow < 1 && upW?.held !== 'blocked' && f < BUFFER_BAND.high));
  const notDrawn = b.down && (downW?.held === 'blocked' || (b.outflow < 1 && downW?.held !== 'starved' && f > BUFFER_BAND.low));
  if (notFilled)
    return [
      {
        ...base,
        severity: ahead ? 'warning' : 'info',
        title: `Not filled — ${up} ${upW?.held ? `itself ${upW.held}` : 'sends nothing'}`,
        why: `${cover != null ? `It covers ≈ ${dur(cover)} of ${down} at its current ${b.show(b.outflow)}` : `${cap1(down)} is not drawing from it now`}${ahead ? `; then ${down} is starved${feedsKiln ? ' — the kiln, so line output is lost' : ''}` : `; behind the kiln, ${down} waiting for tiles loses no line output`}. ${cap1(up)} is ${upW?.words ?? 'not running'} — the line is held further upstream.`,
        next: null,
      },
    ];
  if (notDrawn)
    return [
      {
        ...base,
        severity: ahead ? 'info' : 'warning',
        title: `Not drawn — ${down} ${downW?.held ? `itself ${downW.held}` : 'takes nothing'}`,
        why: `${fullMin != null ? `It is full in ≈ ${dur(fullMin)} at the current ${b.show(b.inflow)}; then ${up} is blocked` : `${cap1(up)} is not filling it now`}${ahead ? ` — ahead of the kiln ${up} has spare capacity, so no line output is lost` : fedByKiln ? ' — that is the kiln, so line output is lost' : ' and the blockage moves towards the kiln'}. ${cap1(down)} is ${downW?.words ?? 'not running'} — the line is held further downstream.`,
        next: null,
      },
    ];
  // Running empty behind the kiln within the hour: normal balancing, said neutrally with its run-out time.
  if (!ahead && emptyMin != null && emptyMin <= BUFFER_ETA_MIN)
    return [
      {
        ...base,
        severity: 'info',
        title: `Runs empty in ≈ ${dur(emptyMin)}`,
        why: `${cap1(down)} draws more than ${up} supplies; once it is empty ${down} waits for tiles. Behind the kiln that is normal balancing — no line output is lost.`,
        next: null,
      },
    ];
  // Out of its band on the side where that matters, but recovering.
  if (ahead && f <= BUFFER_BAND.low)
    return [
      {
        ...base,
        severity: 'info',
        title: 'Low, refilling',
        why: `${cap1(down)} is starved if it runs empty; at the current flow it is refilling${feedsKiln ? ' — it feeds the kiln, the line constraint' : ''}.`,
        next: null,
      },
    ];
  if (!ahead && f >= BUFFER_BAND.high)
    return [
      {
        ...base,
        severity: 'info',
        title: 'High, draining',
        why: `${cap1(up)} is blocked if it fills, and the blockage moves towards the kiln; at the current flow it is draining.`,
        next: null,
      },
    ];
  return [];
}

/** Yard and docks: the longest waiting truck / dock stay against the limits, with the time left. */
function logisticsInsight(x: X): Ranked[] {
  const s = x.s;
  const now = s.minute;
  if (x.id === 'A-HOLD') {
    const waiting = externalVehicles(s).filter((v) => v.phase === 'waiting' && v.queuedAt != null && v.visit!.gateIn <= now).sort((a, b) => a.queuedAt! - b.queuedAt!);
    if (!waiting.length) return [];
    const top = waiting[0];
    const w = now - top.queuedAt!;
    const limit = s.rules.truckWaitMax;
    if (w > limit) return []; // the waiting event (L-WAIT) carries it
    return [
      {
        rule: 'logistics',
        id: `logistics:${x.id}`,
        severity: w >= 0.8 * limit ? 'warning' : 'info',
        title: `${plural(waiting.length, 'truck')} waiting for a dock`,
        observed: `Longest: ${top.label} for ${dur(w)} of the ${limit} min limit; ${DOCKS.filter((d) => s.logistics.docks[d.id]?.vehicleId).length} of ${DOCKS.length} docks occupied.`,
        why: `${top.label} reaches the waiting limit in ≈ ${dur(limit - w)}; waiting beyond it is detention cost (an estimate with stated assumptions).`,
        evidence: [{ kind: 'metric', label: `Queue ${waiting.length} · limit ${s.rules.yardQueueMax}` }],
        next: 'Release the dock closest to completion first and pre-stage the pallets of the next truck.',
        basis: 'rule',
        basisLabel: 'Yard rules L-WAIT / L-YARD (rule-based)',
        certainty: 'observed',
      },
    ];
  }
  if (x.id === 'K-DOCK') {
    const stays = DOCKS.map((d) => ({ d, rt: s.logistics.docks[d.id] })).filter((r) => r.rt?.vehicleId && r.rt.since != null);
    if (!stays.length) return [];
    const top = stays.sort((a, b) => a.rt.since! - b.rt.since!)[0];
    const stay = now - top.rt.since!;
    const limit = s.rules.dockStayMax;
    if (stay > limit || stay < 0.8 * limit) return [];
    const v = s.logistics.vehicles[top.rt.vehicleId!];
    return [
      {
        rule: 'logistics',
        id: `logistics:${x.id}`,
        severity: 'info',
        title: `${top.d.name} near its stay limit`,
        observed: `${v?.label ?? top.rt.vehicleId} at ${top.d.name} for ${dur(stay)} of the ${limit} min limit.`,
        why: `It reaches the limit in ≈ ${dur(limit - stay)}; an occupied dock is unavailable to the next truck in the queue.`,
        evidence: [{ kind: 'metric', label: `Docked since ${x.clock(top.rt.since!)}` }],
        next: 'Check the loading / paperwork status with the dock supervisor.',
        basis: 'rule',
        basisLabel: 'Dock rule L-DOCK (rule-based)',
        certainty: 'observed',
      },
    ];
  }
  return [];
}

/** A numeric signal value as the registry reports it (rounded as its row shows it), or null. */
function numericSignal(s: SimState, signalId: string): number | null {
  if (!SIGNALS.some((d) => d.id === signalId)) return null;
  const r = signalValue(s, signalId);
  return typeof r.value === 'number' ? r.value : null;
}

/** 8 · Operating normally: nothing above applies and the data shows normal operation. */
function normalInsight(x: X, others: Ranked[]): Ranked[] {
  if (others.some((i) => SEV_RANK[i.severity] >= SEV_RANK.warning) || x.roots.length || x.staleSince != null || x.metrics.stale) return [];
  // Never "operating normally" next to a key figure in warning or critical.
  if (x.metrics.kpis.some((k) => k.status && (k.status.tone === 'warning' || k.status.tone === 'critical' || k.status.tone === 'serious'))) return [];
  const s = x.s;
  const parts: string[] = [];
  const evidence: IntelEvidence[] = [];
  let why = 'No signal is outside its configured limit and no event is open, so nothing requires investigation.';
  if (x.prof.kind === 'machine' || x.prof.kind === 'conveyor') {
    if (x.op !== 'running') return [];
    const h = x.health;
    if (h && h.level !== 'normal') return [];
    if (h) {
      const a = HEALTH_BY_ID[x.id];
      // The figures the signal rows show (the registry rounds the current to whole amps): one value, one share of rated.
      const cur = numericSignal(s, `${x.id}.motor_current`) ?? Math.round(h.reading.current);
      const vib = numericSignal(s, `${x.id}.vibration`) ?? h.reading.vibration;
      parts.push(`motor current ${int(cur)} A (${pct(cur / a.currentRated)} of rated ${a.currentRated} A) and vibration ${fmt1(vib)} mm/s (expected ${fmt1(h.expectedVibration)}, alarm ${a.vib.alarm}) within limits`);
      evidence.push(signalEvidence(x, 'motor_current', `Motor current ${int(cur)} A`), signalEvidence(x, 'vibration', `Vibration ${fmt1(vib)} mm/s`));
    }
    if (x.prof.kind === 'conveyor') {
      const sp = signalValue(s, `${x.id}.speed`);
      const conv = CONVEYOR_BY_ID[x.id];
      if (typeof sp.value === 'number') {
        const r = x.rate;
        parts.push(`running at ${fmt1(sp.value)} m/min (nominal ${conv.speedMpm})${r != null ? `, carrying ${int(r)} ${conveyorRateUnit(x.id)} (${pct(r / conv.capacityPerHour)} of capacity)` : ''}`);
        evidence.push(signalEvidence(x, 'speed', `Speed ${fmt1(sp.value)} m/min`));
      }
    } else if (x.ideal && x.rate != null) {
      // The rate itself is the Key figures' rate tile (and the rate trend): said here in words only.
      const paced = pacedBy(x);
      parts.push(`running at ${pct(x.rate / x.ideal)} of ideal${paced ? `, paced by ${paced === 'supply' ? 'its supply' : 'the space downstream'}` : ''}`);
    }
    if (claimedHere(x)) why = `${x.marker.sentence} ${why}`;
  } else if (x.prof.kind === 'buffer') {
    const b = bufferFlow(x);
    if (!b || b.staleNeighbour) return [];
    // Both neighbours must actually be running with flow: a stage that is itself starved / blocked, or
    // stopped, or sends / takes nothing, is not "running" (the buffer insight says so instead) — unless
    // it is held by this buffer's normal level (blocked by a full buffer ahead of the kiln, starved by an
    // empty one after it), which is the line balancing the level band calls normal.
    const fill = b.level / b.buf.capacity;
    const ahead = bufferAhead(b);
    const pacedHere = (side: 'up' | 'down', w: StageState) =>
      side === 'up' ? w.held === 'blocked' && ahead && fill >= BUFFER_BAND.high : w.held === 'starved' && !ahead && fill <= BUFFER_BAND.low;
    const flowing = (side: 'up' | 'down', st: ProcessStage | undefined, rate: number) => {
      if (!st) return { ok: true, paced: false };
      const w = stageWords(s, st);
      const paced = pacedHere(side, w);
      return { ok: (w.held == null || paced) && (w.culpritKind == null || w.culpritKind === 'reduced') && !w.words.startsWith('of unknown') && (rate >= 1 || paced), paced };
    };
    const upF = flowing('up', b.up, b.inflow);
    const downF = flowing('down', b.down, b.outflow);
    const band = bufferBand(b);
    if (!upF.ok || !downF.ok || band.tone === 'warning') return [];
    parts.push(`level ${pct(fill)} — ${band.meaning}`, `filling ${b.show(b.inflow)} and drawn ${b.show(b.outflow)}`);
    evidence.push(signalEvidence(x, 'level', `Level ${pct(fill)}`));
    const upName = b.up ? lower1(b.up.name) : 'the stage filling it';
    const downName = b.down ? lower1(b.down.name) : 'the next stage';
    const sides =
      upF.paced || downF.paced
        ? `${upF.paced ? `${upName} waits for room in it (normal ahead of the kiln)` : `${upName} keeps running`} and ${downF.paced ? `${downName} waits for tiles (normal after the kiln)` : `${downName} keeps running`}`
        : `${upName} and ${downName} keep running`;
    why = `Neither running ${ahead ? 'empty' : 'full'} within the hour nor held by a neighbour: ${sides}.`;
  } else if (x.prof.kind === 'station') {
    const st = x.prof.stationId ? INSPECTION_STATIONS.find((i) => i.id === x.prof.stationId) : null;
    if (st && !st.detects.length) {
      const last = lastSample(s, st.id);
      if (!last) return [];
      parts.push(`last laboratory sample ${x.clock(last.time)} within specification (${last.measurement ?? 'pass'})`);
      evidence.push(signalEvidence(x, 'sample_result', `Sample ${x.clock(last.time)} · pass`));
    } else {
      const q = qualityIn(s, x.shift);
      const by = st ? q.byStation[st.id] : null;
      if (!by || by.inspected <= 0) return [];
      parts.push(`reject rate ${pct(by.rejected / by.inspected, 2)} this shift, within the ${pct(s.rules.rejectRateMax)} line limit`, 'no defect category it detects is rising (deterioration rule)');
      evidence.push(signalEvidence(x, 'count_rejected', `Rejected ${int(by.rejected)} of ${int(by.inspected)}`));
    }
    why = 'Inspection results are within the configured limits; the classification is simulated.';
  } else if (x.prof.kind === 'logistics' || x.prof.kind === 'raw') {
    const fm = fleetMetrics(s, x.shift);
    const delayed = delayedTrucks(s);
    if (delayed.length && (x.id === 'A-GATE' || x.id === 'A-HOLD' || x.id === 'K-DOCK')) return [];
    if (x.id === 'A-GATE') parts.push(`${plural(fm.onSite, 'truck')} on site, ${plural(fm.gateIn, 'gate-in')} this shift`, 'none past a waiting, dock or turnaround limit');
    else if (x.id === 'A-HOLD') parts.push(fm.waiting ? `${plural(fm.waiting, 'truck')} waiting, within the limits` : 'no truck waiting for a dock');
    else if (x.id === 'K-DOCK') parts.push(`${DOCKS.filter((d) => s.logistics.docks[d.id]?.vehicleId).length} of ${DOCKS.length} docks occupied`, 'no stay past the dock limit');
    else if (x.id === 'K-FLT') {
      const acts = forklifts(s).map((v) => internalActivity(v, s.minute));
      parts.push(`${plural(acts.length, 'forklift')} on duty, ${acts.filter((a) => a.moving).length} moving now`);
    } else if (x.prof.kind === 'raw') {
      const n = s.logistics.departed.concat(externalVehicles(s)).filter((v) => v.visit?.direction === 'inbound' && v.visit.dockEnd != null && v.visit.dockEnd >= x.shift.from && v.visit.dockEnd <= s.minute).length;
      parts.push(`${plural(n, 'tipper')} unloaded this shift`);
      why = 'Raw-material supply never limits the simulated line; deliveries are the only operating data of this area.';
    } else parts.push(`${int(s.logistics.stockPallets)} pallets in stock`);
    if (x.prof.kind !== 'raw') why = 'No logistics rule is above its threshold and no event is open.';
  } else return [];
  parts.push('no open event');
  return [
    {
      rule: 'normal',
      id: `normal:${x.id}`,
      severity: 'positive',
      title: 'Operating normally',
      observed: sentence(cap1(parts.join('; '))),
      why,
      evidence,
      next: null,
      basis: 'rule',
      basisLabel: 'Rule-based',
      certainty: 'observed',
    },
  ];
}

function insights(x: X): IntelInsight[] {
  const out: Ranked[] = [];
  const rules = new Set(x.ip.rules);
  if (rules.has('stale')) out.push(...staleInsight(x));
  if (rules.has('neighbour-stale')) out.push(...neighbourStaleInsight(x));
  if (rules.has('event')) out.push(...eventInsights(x));
  if (rules.has('planned')) out.push(...plannedInsight(x));
  if (x.staleSince == null) {
    if (rules.has('flow')) out.push(...flowInsight(x), ...conveyorFlowInsight(x));
    if (rules.has('condition')) out.push(...conditionInsight(x));
    if (rules.has('rate')) out.push(...rateInsight(x));
    if (rules.has('role')) out.push(...roleInsight(x, out));
    if (rules.has('quality')) out.push(...qualityInsight(x));
    if (rules.has('buffer')) out.push(...bufferInsight(x));
    if (rules.has('logistics')) out.push(...logisticsInsight(x));
    if (rules.has('normal')) out.push(...normalInsight(x, out));
  }
  return rankInsights(out);
}

// ── Analytics ────────────────────────────────────────────────────────────────

/** Own unplanned stops counted for MTBF / MTTR: breakdowns and process stops (no changeovers, planned stops or starved / blocked spells). */
const FAILURE_CATEGORIES = new Set(['Mechanical', 'Electrical & control', 'Process']);

function stopsOf(x: X): IntelAnalytics['stops'] {
  const s = x.s;
  const st = ownStops(s, x.id, x.shift);
  const inShift = s.downtime.filter(
    (d) => d.equipmentId === x.id && d.category !== 'Starved' && d.category !== 'Blocked' && !REASON_BY_CODE[d.reasonCode]?.planned && d.start < x.shift.to && (d.end ?? s.minute) > x.shift.from,
  );
  const byReason = new Map<string, number>();
  for (const d of inShift) {
    const label = REASON_BY_CODE[d.reasonCode]?.label ?? d.reasonCode;
    byReason.set(label, (byReason.get(label) ?? 0) + clippedDuration(d, x.shift, s.minute));
  }
  const top = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0];
  const histFrom = Math.max(0, s.minute - 7 * 1440);
  const hist: Period = { from: histFrom, to: s.minute, label: '' };
  const failures = s.downtime.filter((d) => d.equipmentId === x.id && FAILURE_CATEGORIES.has(d.category) && (d.end ?? s.minute) > histFrom);
  const n = failures.length;
  const downMin = failures.reduce((a, d) => a + clippedDuration(d, hist, s.minute), 0);
  const closed = failures.filter((d) => d.end != null);
  const enough = n >= 2;
  const mtbfH = enough ? (s.minute - histFrom - downMin) / n / 60 : null;
  const mttrMin = enough && closed.length ? closed.reduce((a, d) => a + (d.end! - d.start), 0) / closed.length : null;
  const histLabel = histFrom === 0 ? 'since the start of the simulated history' : 'over the last 7 days';
  return {
    shiftCount: st.count,
    shiftMinutes: st.minutes,
    topReason: top ? { label: top[0], minutes: top[1] } : null,
    mtbfH,
    mttrMin,
    basis: `Shift: own stops of ${x.id} — unplanned stops (breakdowns, process stops) and product changeovers, as the Stoppages tile. MTBF / MTTR: its ${plural(n, 'breakdown or process stop', 'breakdowns and process stops')} ${histLabel} — MTBF = time not down ÷ stops, MTTR = mean duration of the closed ones${enough ? '' : '; fewer than 2 stops, so not calculated'}. Changeovers, planned stops and time starved / blocked by neighbours are excluded.`,
    ...(x.metrics.stale ? { notConfirmed: x.metrics.stale.label } : {}),
  };
}

/**
 * Did the asset's shortfall reach line output? Attributed the way the event engine attributes kiln
 * time (an event owns a kiln minute only when it is the kiln's own condition or the root of the kiln's
 * starvation / blockage — src/sim/events.ts accumulate), never from a stop merely overlapping a kiln
 * stall in time: the downtime record's constraintImpactMin counts every open stop while the kiln is
 * held, whatever held it.
 */
function lineReach(x: X): { reached: 'yes' | 'no' | 'unknown'; words: string } {
  const s = x.s;
  if (isKilnStage(x)) return { reached: 'yes', words: 'The kiln is the line constraint: what it does not fire is line output lost.' };
  if (constrainingHere(x)) return { reached: 'yes', words: 'The stage is currently constraining output: its shortfall reaches line output.' };
  if (x.staleSince != null) return { reached: 'unknown', words: 'Its data feed is stale, so whether its shortfall reached line output is not known.' };
  const inShift = (start: number, end: number | null) => start < x.shift.to && (end ?? s.minute) > x.shift.from;
  const own = s.events.filter((e) => e.category === 'production' && !e.consequenceOf && e.asset.equipmentId === x.id && inShift(e.start, e.end));
  const held = own.filter((e) => e.acc.constraintMin > 0);
  if (held.length) {
    const min = held.reduce((a, e) => a + e.acc.constraintMin, 0);
    return {
      reached: 'yes',
      words: `The event engine attributes ${int(min)} min of kiln hold-up to its ${held.length === 1 ? 'event' : 'events'} ${held.map((e) => e.id).join(', ')} (inferred from states and buffers — the root of the kiln's starvation / blockage).`,
    };
  }
  // Stops without an event record (product changeovers) are not attributed by the event engine: one
  // that overlapped a kiln stall leaves the question open.
  const overlapped = ownDowntime(s, x.id, x.shift.from).filter((d) => d.start < x.shift.to && d.constraintImpactMin > 0 && !s.events.some((e) => e.refs.downtimeId === d.id));
  if (overlapped.length)
    return {
      reached: 'unknown',
      words: `${overlapped.length === 1 ? 'A stop' : `${overlapped.length} stops`} without an event record (${[...new Set(overlapped.map((d) => lower1(REASON_BY_CODE[d.reasonCode]?.label ?? d.reasonCode)))].join(', ')}) overlapped a kiln stall — not attributed, so whether it reached line output is not known.`,
    };
  return {
    reached: 'no',
    words: 'No event of it this shift held up the kiln (event engine attribution): the buffers absorbed its stops, and time waiting on neighbours or below the ideal pace is spare capacity of a stage paced by the line.',
  };
}

function lossOf(x: X): IntelAnalytics['loss'] {
  const s = x.s;
  if (x.prof.kind !== 'machine' || !x.ideal) return null;
  const t = sumBuckets(s, x.id, x.shift);
  const perMin = x.ideal / 60;
  const expected = t.planned * perMin;
  const tiles = Math.max(0, expected - t.count);
  const stops = Math.min(tiles, t.down * perMin);
  const waiting = Math.min(tiles - stops, (t.starved + t.blocked) * perMin);
  const pace = Math.max(0, tiles - stops - waiting);
  const reach = lineReach(x);
  const reachedLine = reach.reached;
  const eq = x.ip.output.equivalent ? ' (tile-equivalents of slip / powder — m² equivalent)' : '';
  return {
    tiles,
    m2: tiles * M2_PER_TILE,
    reachedLine,
    ...(x.metrics.stale ? { notConfirmed: x.metrics.stale.label } : {}),
    ...(x.ip.output.equivalent ? { unit: 'tile-eq.' } : {}),
    basis: `Planned production time this shift (${int(t.planned)} min) × ideal rate ${int(x.ideal)} ${x.ip.output.equivalent ? 'tile-eq./h' : 'tiles/h'} − ${int(t.count)} ${x.ip.output.noun} = ${int(tiles)} ${x.ip.output.equivalent ? 'tile-eq.' : 'tiles'}${eq}. ${reach.words}`,
    breakdown: [
      { key: 'stops', label: 'Own stops', tiles: stops, hint: `${int(t.down)} min stopped by its own unplanned stops × ideal rate.` },
      { key: 'waiting', label: 'Waiting on neighbours', tiles: waiting, hint: `${int(t.starved + t.blocked)} min-equivalents starved or blocked × ideal rate.` },
      { key: 'pace', label: 'Below ideal pace', tiles: pace, hint: 'The rest: running below the ideal rate (speed losses, short stops, a reduced set rate).' },
    ],
  };
}

function analytics(x: X): IntelAnalytics | null {
  const spec = x.ip.analytics;
  if (!spec || !x.status) return null;
  const s = x.s;
  const list = samples(s, x.id, s.minute - PANEL_WINDOW_MIN, s.minute);
  if (!list.length) return null;
  const from = list[0].t;
  const to = s.minute;
  const stops = ownDowntime(s, x.id, from);
  const timeline: TimelineSegment[] = [];
  // Per state and label: a product changeover is a 'planned' minute labelled "Changeover" (never "Planned stop").
  const minutes = new Map<string, { state: OperationalState; label?: string; m: number }>();
  for (const smp of list) {
    const op = opOfSample(s, x.id, smp, x.staleSince, stops);
    const label =
      op === 'unknown' && x.staleSince != null
        ? 'Unknown (feed stale)'
        : op === 'changeover'
          ? 'Changeover'
          : undefined;
    const key = `${op}|${label ?? ''}`;
    const e = minutes.get(key) ?? { state: op, ...(label ? { label } : {}), m: 0 };
    e.m++;
    minutes.set(key, e);
    const last = timeline[timeline.length - 1];
    if (last && last.state === op && last.label === label && last.to === smp.t) last.to = smp.t + 1;
    else timeline.push(label ? { from: smp.t, to: smp.t + 1, state: op, label } : { from: smp.t, to: smp.t + 1, state: op });
  }
  const timeInState = [...minutes.values()].sort((a, b) => b.m - a.m).map(({ state, label, m }) => (label ? { state, minutes: m, label } : { state, minutes: m }));
  const span = to - from;
  const rate = spec.rate ? { points: rateSeries(s, x.id, span, 10, x.staleSince), stepMin: 10, ideal: x.ideal, unit: 'tiles/h', idealLabel: spec.rate === 'capacity' ? 'nominal capacity' : 'ideal rate' } : null;
  const known = list.filter((smp) => x.staleSince == null || smp.t < x.staleSince);
  const made = known.reduce((a, smp) => a + smp.rate, 0);
  const meanRate = known.length ? (made / known.length) * 60 : null;
  // After a stale freeze the figures cover only the minutes before it: labelled with what they cover.
  const cut = x.staleSince != null && known.length < list.length;
  const scope = cut ? `${windowWords(known.length)} to ${x.clock(x.staleSince!)}` : windowWords(span);
  const excluded = cut ? ` Minutes after the feed went stale at ${x.clock(x.staleSince!)} are excluded (no data).` : '';
  const facts: NonNullable<IntelAnalytics['facts']> = [];
  if (meanRate != null && x.ideal)
    facts.push({
      label: `Mean rate · ${scope}`,
      value: `${int(meanRate)} tiles/h · ${pct(meanRate / x.ideal)} of ${spec.rate === 'capacity' ? 'capacity' : 'ideal'}`,
      hint: `Tiles ${x.prof.kind === 'conveyor' ? 'carried' : 'made'} per logged minute × 60, over the minutes with data.${excluded}`,
    });
  if (known.length)
    facts.push({ label: `${x.prof.kind === 'conveyor' ? 'Carried' : 'Output'} · ${scope}`, value: `${int(made)} tiles · ${m2(made)} m²${x.ip.output.equivalent ? ' eq.' : ''}`, hint: `Sum of the per-minute counts in the window (minute log).${excluded}` });
  if (x.recent && x.prof.kind === 'machine' && x.recent.known > 0)
    facts.push({
      label: x.recent.known < x.recent.minutes && x.staleSince != null ? `Starved / blocked · ${x.recent.known} min to ${x.clock(x.staleSince)}` : `Starved / blocked · last ${x.recent.minutes} min`,
      value: `${pct(x.recent.starved / x.recent.known)} / ${pct(x.recent.blocked / x.recent.known)}`,
      hint: `Share of the last ${x.recent.minutes} min waiting for material / unable to discharge (minute log); above ${pct(HELD_UP_SHARE)} counts as held up by neighbours.`,
    });
  return {
    window: { from, to, label: `Last ${windowWords(span)}` },
    timeline,
    timeInState,
    rate,
    stops: spec.stops ? stopsOf(x) : null,
    loss: spec.loss ? lossOf(x) : null,
    facts,
  };
}

const windowWords = (min: number) => (min % 60 === 0 ? `${min / 60} h` : min > 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`);

// ── Signals ──────────────────────────────────────────────────────────────────

/** Running-sample history of the condition signals (10-min steps, last 4 h); null after a stale freeze. */
function conditionTrend(x: X): Record<'vibration' | 'temperature' | 'motor_current', (number | null)[]> | null {
  if (!x.prof.conditionMonitored) return null;
  const hist: SensorReading[] = sensorHistory(x.s, x.id, 240, 10);
  const cut = (r: SensorReading) => x.staleSince != null && r.t >= x.staleSince;
  return {
    vibration: hist.map((r) => (cut(r) || !r.running ? null : Number(r.vibration.toFixed(2)))),
    temperature: hist.map((r) => (cut(r) ? null : Number(r.temperature.toFixed(1)))),
    motor_current: hist.map((r) => (cut(r) || !r.running ? null : Math.round(r.current))),
  };
}

function bufferTrend(s: SimState, b: BufferDef): (number | null)[] {
  const log = s.bufferLog[b.id];
  if (!log) return [];
  const out: (number | null)[] = [];
  for (let t = Math.max(0, s.minute - PANEL_WINDOW_MIN); t < s.minute; t += 10) {
    const i = t % LOG_MIN;
    out.push(log.t[i] === t ? Math.round((log.level[i] / b.capacity) * 1000) / 10 : null);
  }
  return out;
}

const STATE_INTERP: Record<OperationalState, { tone: IntelTone; label: string }> = {
  running: { tone: 'good', label: 'Producing' },
  reduced: { tone: 'warning', label: 'Below its set rate' },
  idle: { tone: 'neutral', label: 'Running empty — nothing to carry' },
  starved: { tone: 'warning', label: 'Waiting for material' },
  blocked: { tone: 'warning', label: 'Cannot discharge' },
  stopped: { tone: 'critical', label: 'Not producing' },
  fault: { tone: 'critical', label: 'Not producing · fault' },
  planned: { tone: 'neutral', label: 'Scheduled stop — not a fault' },
  changeover: { tone: 'neutral', label: 'Product changeover — setup, not a fault' },
  disconnected: { tone: 'neutral', label: 'No data' },
  unknown: { tone: 'neutral', label: 'Last value — current state unknown' },
};

function signalRow(x: X, def: SignalDef, cond: ReturnType<typeof conditionTrend>): IntelSignal {
  const s = x.s;
  const reading: SignalReading = signalValue(s, def.id);
  const stale = reading.quality === 'stale';
  const freshness = stale ? `Last value ${x.clock(reading.since ?? x.staleSince ?? s.minute)} (feed stale)` : 'Simulated · now';
  const base = x.ip.signalLabels[def.name] ?? def.name.replace(/_/g, ' ');
  const a = HEALTH_BY_ID[x.id];
  // "Vibration · roller drive gearmotor": the monitored component (its location stays in the limits / insights),
  // so a component temperature is never read as a process (firing) temperature.
  const label = (def.name === 'vibration' || def.name === 'temperature') && a ? `${base} · ${lower1(a.component.split(' · ')[0])}` : base;
  const row: IntelSignal = { id: def.id, label, value: null, unit: null, interpretation: null, limits: null, trend: null, freshness, stale };
  const num = typeof reading.value === 'number' ? reading.value : null;
  switch (def.name) {
    case 'state':
    case 'run_state':
      row.value = reading.value == null ? null : reading.text;
      row.interpretation = x.op ? (x.changeover ? { tone: 'neutral', label: 'Changeover — not a fault' } : STATE_INTERP[x.op]) : null;
      return row;
    case 'rate': {
      row.value = num == null ? null : int(num);
      row.unit = def.unit;
      const w = rateWords(x);
      row.interpretation = w ? { tone: w.tone, label: w.value } : null;
      row.limits = x.ideal ? `ideal ${int(x.ideal)} tiles/h` : null;
      const tr = rateSeries(s, x.id, 60, 5, x.staleSince).map((v) => (v == null ? null : Math.round(v)));
      row.trend = tr.some((v) => v != null) ? tr : null;
      return row;
    }
    case 'alarm': {
      if (stale) {
        row.interpretation = { tone: 'neutral', label: `No value since ${x.clock(reading.since ?? s.minute)}` };
        return row;
      }
      if (reading.value == null) return row;
      if (reading.value === 'none') {
        // An absent alarm code is not proof of no fault: neutral words, no health verdict.
        row.value = 'No active alarm code';
        row.interpretation = { tone: 'neutral', label: 'No code reported' };
        return row;
      }
      const code = String(reading.value);
      row.value = code;
      row.interpretation = { tone: x.op === 'planned' || x.op === 'changeover' ? 'neutral' : 'critical', label: `${REASON_BY_CODE[code]?.label ?? code}${x.op === 'planned' || x.op === 'changeover' ? ' (scheduled)' : ''}${x.status ? ` · since ${x.clock(x.status.since)}` : ''}` };
      return row;
    }
    case 'vibration':
    case 'temperature':
    case 'motor_current': {
      if (num == null || !a) return row;
      const at = stale ? sensorsAt(s, x.id, Math.max(0, (reading.since ?? s.minute) - 1)) : (x.health?.reading ?? sensorsAt(s, x.id, Math.max(0, s.minute - 1)));
      if (!at) return row;
      const tr = cond?.[def.name] ?? null;
      row.trend = tr && tr.some((v) => v != null) ? tr : null;
      row.unit = def.unit;
      if (def.name === 'vibration') {
        const exp = expectedVib(a, at.load, at.running);
        row.value = fmt1(num);
        row.limits = `expected ${fmt1(exp)} · alarm ${a.vib.alarm} · trip ${a.vib.trip} mm/s`;
        row.interpretation = !at.running
          ? { tone: 'neutral', label: 'Not running — not assessed' }
          : num >= a.vib.trip
            ? { tone: 'critical', label: 'At trip limit' }
            : num >= a.vib.alarm
              ? { tone: 'critical', label: 'Above alarm limit' }
              : num >= 0.8 * a.vib.alarm
                ? { tone: 'warning', label: 'Near alarm limit' }
                : num / exp >= 1.25
                  ? { tone: 'warning', label: `${(num / exp).toFixed(1)}× expected` }
                  : { tone: 'good', label: 'Within limit' };
      } else if (def.name === 'temperature') {
        const exp = expectedTemp(a, at.load);
        row.value = num.toFixed(0);
        row.limits = `expected ${exp.toFixed(0)} · alarm ${a.temp.alarm} · trip ${a.temp.trip} °C — ${componentWords(a.component)} (component, not process)`;
        row.interpretation =
          num >= a.temp.alarm
            ? { tone: 'critical', label: 'Above alarm limit' }
            : num >= a.temp.alarm - 5
              ? { tone: 'warning', label: 'Near alarm limit' }
              : num >= exp + 4
                ? { tone: 'warning', label: `+${(num - exp).toFixed(0)} °C above expected` }
                : { tone: 'good', label: 'Normal for the load' };
      } else {
        row.value = int(num);
        row.limits = `rated ${a.currentRated} A`;
        row.interpretation = !at.running
          ? { tone: 'neutral', label: 'Idle draw — not running' }
          : num > a.currentRated
            ? { tone: 'warning', label: 'Above rated current' }
            : { tone: 'good', label: `${pct(num / a.currentRated)} of rated` };
      }
      // A last value received is not a confirmed reading now: no green / amber verdict on it.
      if (stale && row.interpretation) row.interpretation = { tone: 'neutral', label: `Last value · ${lower1(row.interpretation.label)}` };
      return row;
    }
    case 'speed': {
      const conv = CONVEYOR_BY_ID[x.id];
      if (num == null || !conv) return row;
      row.value = fmt1(num);
      row.unit = def.unit;
      row.limits = `nominal ${conv.speedMpm} m/min`;
      row.interpretation = stale
        ? { tone: 'neutral', label: 'Last value' }
        : num <= 0.01
          ? { tone: x.op === 'planned' || x.op === 'changeover' ? 'neutral' : 'critical', label: 'Stopped' }
          : Math.abs(num / conv.speedMpm - 1) <= 0.03
            ? { tone: 'good', label: 'At set speed' }
            : { tone: 'neutral', label: `${pct(num / conv.speedMpm)} of set speed` };
      return row;
    }
    case 'level': {
      const b = BUFFERS.find((y) => y.equipmentId === x.id);
      if (num == null || !b) return row;
      row.value = num.toFixed(0);
      row.unit = '%';
      row.limits = `low ${pct(BUFFER_BAND.low)} · high ${pct(BUFFER_BAND.high)}${BULK_BUFFERS.has(b.id) ? ' · level only (no level-to-mass calibration)' : ` · ${int(s.buffers[b.id])} of ${int(b.capacity)} tiles`}`;
      // Read on its side of the kiln — the facet's, the tile's and the insight's band (a full buffer
      // ahead of the kiln, an empty one behind it, is normal balancing).
      const band = bufferLevelBand(b.id, num / 100);
      row.interpretation = { tone: band.concern ? 'warning' : band.side === 'normal' ? 'good' : 'neutral', label: band.label };
      const tr = bufferTrend(s, b);
      row.trend = tr.some((v) => v != null) ? tr : null;
      return row;
    }
    case 'count_inspected':
    case 'count_rejected': {
      row.value = num == null ? null : int(num);
      row.unit = def.unit;
      const st = INSPECTION_STATIONS.find((i) => i.equipmentId === x.id);
      const by = st ? qualityIn(s, x.shift).byStation[st.id] : null;
      if (by && def.name === 'count_inspected') row.interpretation = { tone: 'neutral', label: `+${int(by.inspected)} this shift` };
      if (by && def.name === 'count_rejected') {
        const r = by.inspected > 0 ? by.rejected / by.inspected : null;
        row.interpretation = r == null ? null : { tone: r > s.rules.rejectRateMax ? 'critical' : 'good', label: `${pct(r, 2)} of inspected this shift` };
        row.limits = `line limit ${pct(s.rules.rejectRateMax)}`;
      }
      // The station counts rest on the sorting line's feed (the KPI set's stale mark): not confirmed, no verdict.
      const mark = x.metrics.stale;
      if (mark && !stale) {
        row.stale = true;
        row.freshness = `Not confirmed · ${mark.assetIds.join(', ')} feed stale since ${x.clock(mark.since)}`;
        if (row.interpretation) row.interpretation = { tone: 'neutral', label: `${row.interpretation.label} · not confirmed` };
      }
      return row;
    }
    case 'count_good': {
      row.value = num == null ? null : int(num);
      row.unit = def.unit;
      const q = qualityIn(s, x.shift);
      row.interpretation = { tone: 'neutral', label: `+${int(q.accepted)} this shift${stale || x.metrics.stale ? ' · not confirmed' : ''}` };
      return row;
    }
    case 'count_total':
    case 'tile_count': {
      row.value = num == null ? null : int(num);
      row.unit = def.unit;
      if (stale) row.interpretation = { tone: 'neutral', label: `Frozen since ${x.clock(reading.since ?? s.minute)}` };
      else {
        const last10 = samples(s, x.id, s.minute - 10, s.minute).reduce((acc, smp) => acc + smp.rate, 0);
        row.interpretation = { tone: 'neutral', label: `+${int(last10)} in the last 10 min` };
      }
      return row;
    }
    case 'sample_result': {
      if (reading.value == null) return row;
      row.value = reading.text;
      const st = INSPECTION_STATIONS.find((i) => i.equipmentId === x.id);
      const last = st ? lastSample(s, st.id) : null;
      row.interpretation = reading.value === 'pass' ? { tone: 'good', label: 'Within specification' } : { tone: 'warning', label: 'Retest requested' };
      row.limits = last?.measurement ?? null;
      return row;
    }
    case 'dock_occupancy': {
      row.value = reading.text;
      const occ = typeof reading.value === 'number' ? reading.value : null;
      row.interpretation = occ == null ? null : { tone: 'neutral', label: `${pct(occ / DOCKS.length)} occupied` };
      return row;
    }
    default:
      row.value = reading.value == null ? null : `${reading.text}`;
      row.unit = num != null && !['enum', 'code', 'in/out', 'docks', 'pass/fail', 'zone id'].includes(def.unit) ? def.unit : null;
      return row;
  }
}

function signals(x: X): IntelSignals {
  const defs = SIGNALS.filter((d) => d.equipmentId === x.id);
  const order = (n: string) => {
    const i = x.ip.signalOrder.indexOf(n);
    return i < 0 ? x.ip.signalOrder.length : i;
  };
  const cond = conditionTrend(x);
  const rows: IntelSignal[] = [];
  const notModelled: IntelSignals['notModelled'] = [];
  const seen = new Set<string>();
  const addNm = (n: { label: string; reason: string }) => {
    if (seen.has(n.label)) return;
    seen.add(n.label);
    notModelled.push(n);
  };
  for (const def of [...defs].sort((a, b) => order(a.name) - order(b.name))) {
    const basis = basisOf(def.name);
    if (basis === 'placeholder' || basis === 'energy-model') {
      addNm(NOT_MODELLED_SIGNALS[def.name] ?? { label: def.name.replace(/_/g, ' '), reason: definitionOf(def.id)?.statusNote ?? (basis === 'placeholder' ? 'no physical model' : 'energy is not monitored in this product') });
      continue;
    }
    rows.push(signalRow(x, def, cond));
  }
  for (const n of x.ip.notModelled) addNm(n);
  return { rows, notModelled };
}

// ── Events ───────────────────────────────────────────────────────────────────

const EV_SEV = { info: 0, warning: 1, serious: 2, critical: 3 } as const;

/** One impact line from the event report's impact model (eventImpact), where it supports one. */
export function eventImpactLine(s: SimState, e: OpEvent, finance: FinanceAssumptions = DEFAULT_FINANCE): string | null {
  if (e.consequenceOf) return `Consequence of ${e.consequenceOf} — its line loss is counted there`;
  const imp = eventImpact(s, e, finance);
  const row = (re: RegExp) => imp.rows.find((r) => re.test(r.label))?.value ?? null;
  const open = e.end == null;
  switch (e.category) {
    case 'production': {
      const kiln = e.acc.constraintMin;
      if (kiln > 0) return `Kiln held up ${int(kiln)} min · ${row(/^Line good output lost/) ?? '—'} line output lost${open ? ' so far' : ''}`;
      const asset = row(/^(Output not made|Tiles not transported)/);
      return `${asset ? `${asset} not made · ` : ''}no line output lost${open ? ' so far' : ' — buffers absorbed it'}`;
    }
    case 'quality': {
      const excess = row(/^Excess rejects/);
      if (excess) return `Excess rejects ${excess} vs the 24 h reference`;
      const rej = imp.rows.find((r) => /^Rejected/.test(r.label));
      return rej ? `${rej.label} ${rej.value}` : null;
    }
    case 'logistics': {
      const beyond = row(/^Minutes beyond/);
      if (beyond) return `${beyond} beyond the threshold${open ? ' so far' : ''}`;
      const queue = row(/^Trucks waiting at detection/);
      if (queue) return `${queue} trucks waiting at detection`;
      return row(/^Safety exposure/);
    }
    case 'equipment': {
      if (!open) return null;
      const trip = row(/^Projected time to trip/);
      if (trip) return `Trip limit in ≈ ${trip} if the trend continues`;
      const fail = row(/^Downtime if it fails/);
      return fail ? `A failure would stop it ≈ ${fail}` : null;
    }
    case 'data': {
      const gap = row(/^Data gap/);
      return gap ? `Data gap ${gap}${open ? ' so far' : ''}` : null;
    }
    default:
      return null;
  }
}

/** Open first (active, then cleared but unresolved), then the newest resolved — repeated types collapsed — at most `max`. */
export function eventRows(s: SimState, list: OpEvent[], finance: FinanceAssumptions, max = 5): IntelEventRow[] {
  const active = list.filter((e) => e.end == null).sort((a, b) => EV_SEV[b.severity] - EV_SEV[a.severity] || b.start - a.start);
  const cleared = list.filter((e) => e.end != null && e.status !== 'resolved').sort((a, b) => b.end! - a.end! || b.start - a.start);
  const resolved = list.filter((e) => e.end != null && e.status === 'resolved').sort((a, b) => b.end! - a.end! || b.start - a.start);
  const byType = new Map<string, { e: OpEvent; earlier: number }>();
  for (const e of resolved) {
    const hit = byType.get(e.type);
    if (hit) hit.earlier++;
    else byType.set(e.type, { e, earlier: 0 });
  }
  const rows: IntelEventRow[] = [...active, ...cleared].map((e) => ({ event: e, impact: eventImpactLine(s, e, finance) }));
  for (const { e, earlier } of byType.values()) {
    if (rows.length >= max) break;
    rows.push(earlier > 0 ? { event: e, impact: eventImpactLine(s, e, finance), earlier } : { event: e, impact: eventImpactLine(s, e, finance) });
  }
  return rows.slice(0, max);
}

/** Count of the list "View all events" opens (Events & Reports filtered to the id, all recorded time). */
const viewAllCount = (s: SimState, query: string) =>
  filterEvents(s.events, { ...ALL_EVENTS_FILTERS, query }, { now: s.minute, vehicleLabel: (vid) => s.logistics.vehicles[vid]?.label }).length;

function events(x: X): IntelEvents {
  return { rows: eventRows(x.s, x.events, x.finance), openCount: x.events.filter((e) => e.status !== 'resolved').length, total: viewAllCount(x.s, x.id) };
}

// ── Copilot question ─────────────────────────────────────────────────────────

/** The Copilot question: about the top open event when an insight rests on one, otherwise about the subject by its id. */
function askFor(id: string, list: IntelInsight[], fallback = `How is ${id} performing?`): EquipmentIntel['ask'] {
  const ev = list.flatMap((i) => i.evidence).find((e) => e.kind === 'event' && e.ref);
  const top = list[0];
  if (ev?.ref && top && top.severity !== 'positive') return { prompt: `What should we do about ${ev.ref} on ${id}?`, eventId: ev.ref };
  return { prompt: fallback };
}

// ── Equipment ────────────────────────────────────────────────────────────────

/**
 * The equipment intelligence model of one selectable asset (machine, conveyor, buffer, station, raw
 * material, logistics, storage, utility or support item), from the shared simulation state.
 */
export function deriveEquipmentIntel(s: SimState, id: string, ctx: IntelContext = DEFAULT_INTEL_CONTEXT): EquipmentIntel {
  const x = contextOf(s, id, ctx);
  const camera = cameraFor(id);
  // The rule engine's findings merged with the curated insights: one statement per topic.
  const live = ctx.live ? liveFindingsFor(s, { kind: 'equipment', equipmentId: id }) : null;
  const found = live ? live.value : assetFindings(s, id);
  const merged = mergeFindings(insights(x), found);
  const list = merged.insights;
  const sigs = signals(x);
  // The table keeps the panel's component-specific words ("Vibration · hydraulic power unit") where it has them.
  const words = new Map(sigs.rows.map((r) => [r.id, r.label]));
  const rows = signalTableRows(s, id).map((r) => (words.has(r.def.signalId) ? { ...r, label: words.get(r.def.signalId) } : r));
  const wanted = ctx.range ?? '8h';
  const tileKeys = x.metrics.kpis.filter((k) => !k.unavailable).map((k) => k.key);
  // The history charts and the tile sparklines over the same range (a live card: its throttled set).
  const history = () => {
    const charts = panelCharts(s, { kind: 'equipment', equipmentId: id }, wanted);
    return { charts, trends: tileTrends(s, id, tileKeys, charts?.range ?? wanted) };
  };
  const hist = ctx.live ? liveCharts(s, `charts:${id}:${wanted}`, tileKeys.join(','), wanted, history) : { value: history(), at: s.minute };
  const charts = hist.value.charts && hist.at < s.minute ? { ...hist.value.charts, at: hist.at } : hist.value.charts;
  const range = charts?.range ?? wanted;
  // The log covers the range up to now (also while the live charts end a few minutes earlier).
  const window = charts ? windowOf(s, range) : { from: s.minute - 480, to: s.minute };
  return {
    subject: { type: 'equipment', id, profile: x.prof },
    header: header(x, rows),
    feed: chooseFeed({ equipmentId: id, label: x.prof.name }, camera, EQUIPMENT_TOPICS[id] ?? [], ctx.cameraSources),
    facets: facets(x),
    metrics: x.metrics,
    insights: list,
    analytics: analytics(x),
    signals: sigs,
    events: events(x),
    health: x.health,
    cameraId: camera?.id ?? null,
    ask: askFor(id, list),
    charts,
    signalTable: rows,
    history: (signalId) => seriesOf(s, signalId, range),
    // An asset without operating data has nothing to evaluate: its catalogue says what is missing (Technical details).
    findings: found.length && x.metrics.note !== NO_OPERATING_DATA ? (live ? { ...merged.findings, at: live.at } : merged.findings) : null,
    log: eventLog(s, id, { from: window.from, to: window.to }, found),
    catalog: catalogView(s, id),
    process: x.metrics.note === NO_OPERATING_DATA ? null : processView(s, id),
    tileTrends: hist.value.trends,
  };
}

// ── Vehicles ─────────────────────────────────────────────────────────────────

/** "Stage 4 · Queue — Waiting for a dock (#1 in queue)" → "Waiting for a dock (#1 in queue)". */
const tripStatus = (phase: string) => {
  const i = phase.indexOf(' — ');
  return i >= 0 ? phase.slice(i + 3) : phase.replace(/^Stage \d+ · /, '');
};

const VEHICLE_TYPE: Record<Vehicle['type'], string> = { 'outbound-truck': 'Outbound truck', 'inbound-tipper': 'Inbound tipper', forklift: 'Forklift', 'wheel-loader': 'Wheel loader' };

function vehicleZone(s: SimState, id: string): IntelHeader['zone'] {
  const gf = vehicleGeofence(s, id);
  return gf?.equipmentId ? zoneOf(gf.equipmentId) : null;
}

function vehicleAnalytics(s: SimState, v: Vehicle): IntelAnalytics | null {
  const now = s.minute;
  const end = v.despawned != null ? Math.min(now, v.despawned) : now;
  const legs = v.legs.filter((l) => l.start < end && l.end > now - PANEL_WINDOW_MIN).sort((a, b) => a.start - b.start);
  if (!legs.length) return null;
  // Exact (fractional) leg bounds: a 0.2-min driving leg keeps its 0.2 min — rounding each bound to whole
  // minutes dropped short legs and made 1-min "no route record" slices between consecutive legs.
  const from = Math.max(now - PANEL_WINDOW_MIN, v.spawned, legs[0].start);
  const to = end;
  if (to - from < 1) return null;
  /** Gaps shorter than this between consecutive legs are float noise, not a missing route record. */
  const GAP = 0.05;
  const timeline: TimelineSegment[] = [];
  const minutes = new Map<OperationalState, { m: number; label: string }>();
  const push = (a: number, b: number, moving: boolean | null) => {
    if (b - a <= 1e-9) return;
    const state: OperationalState = moving == null ? 'unknown' : moving ? 'running' : 'idle';
    const label = moving == null ? 'No route record' : moving ? 'Moving' : 'Stationary';
    const e = minutes.get(state) ?? { m: 0, label };
    e.m += b - a;
    minutes.set(state, e);
    const last = timeline[timeline.length - 1];
    if (last && last.state === state && last.to >= a - 1e-9) last.to = Math.max(last.to, b);
    else timeline.push({ from: a, to: b, state, label });
  };
  let cur = from;
  let prev: (typeof legs)[number] | null = null;
  for (const l of legs) {
    const a = Math.max(cur, l.start);
    // Between two legs the vehicle stands where the last one ended (the movement model's rule,
    // internalActivity): stationary. Only before its first leg is there no route record. A float-noise
    // gap belongs to the next leg.
    const start = a - cur > GAP ? a : cur;
    if (start > cur) push(cur, Math.min(start, to), prev ? false : null);
    const b = Math.min(to, l.end);
    if (b > start) push(start, b, l.moving);
    cur = Math.max(cur, b);
    prev = l;
    if (cur >= to) break;
  }
  // After the last leg: standing at its end point (or, without any leg in the window, unknown).
  if (to - cur > GAP) push(cur, to, prev ? false : null);
  else if (to > cur && timeline.length) {
    // Float noise at the end: the last segment runs to the end of the window.
    const last = timeline[timeline.length - 1];
    minutes.get(last.state)!.m += to - last.to;
    last.to = to;
  }
  const act = internalActivity(v, now);
  const hourLegs = v.legs.filter((l) => l.moving && l.start >= now - 60 && l.start <= now);
  const facts: NonNullable<IntelAnalytics['facts']> = [
    { label: 'Moves · last hour', value: String(hourLegs.length), hint: 'Driving legs started in the last 60 min (simulated route).' },
    { label: 'Loaded moves · last hour', value: String(hourLegs.filter((l) => l.loaded).length), hint: 'Driving legs with a load (pallet, tipper load) started in the last 60 min.' },
  ];
  if (act.idleLastHour != null) facts.push({ label: 'Idle · last hour', value: dur(act.idleLastHour), hint: 'Time on legs marked idle / waiting / available in the last 60 min.' });
  if (act.current && !act.moving && act.stationaryMin != null) facts.push({ label: 'At current stop', value: dur(act.stationaryMin), hint: 'Time standing at the current stop (not zone residency).' });
  return {
    window: { from, to, label: `Last ${windowWords(Math.round(to - from))}` },
    timeline,
    timeInState: [...minutes.entries()].sort((a, b) => b[1].m - a[1].m).map(([state, e]) => ({ state, minutes: e.m, label: e.label })),
    rate: null,
    stops: null,
    loss: null,
    facts,
  };
}

function vehicleFacets(s: SimState, v: Vehicle): Facet[] {
  const loc = vehicleLocation(s, v);
  const mv = vehicleMovement(s, v);
  const out: Facet[] = [
    {
      key: 'location',
      label: loc.kind === 'historical' ? 'Last known' : 'Location',
      value: loc.kind === 'historical' && loc.at != null ? `${loc.place} · ${clockLabel(loc.at, s.minute)}` : loc.place,
      tone: 'neutral',
      hint: `${loc.label} — zone level, from the simulated route (no GPS, telematics or indoor positioning).`,
    },
    {
      key: 'movement',
      label: 'Movement',
      value: mv.state === 'off-site' ? 'Not on site' : mv.state === 'moving' ? 'Moving' : `Stationary · ${dur(mv.stationaryMin)}`,
      tone: 'neutral',
      hint: mv.state === 'stationary' ? 'Time standing at the current stop — not the time spent in the zone.' : 'On a driving leg of its simulated route.',
    },
  ];
  if (v.class === 'external') {
    const t = v as TruckRuntime;
    const trip = truckTrip(s, t);
    const d = t.visit ? visitDurations(t, s.minute) : null;
    out.push({ key: 'trip', label: 'Visit', value: tripStatus(trip.phase), tone: t.phase === 'waiting' ? 'warning' : 'neutral', hint: `${trip.phase}. Dock: ${trip.dock}. Load: ${trip.load}.` });
    const onSite = t.visit && t.visit.gateIn <= s.minute ? (t.visit.gateOut ?? s.minute) - t.visit.gateIn : null;
    if (onSite != null)
      out.push({
        key: 'dwell',
        label: t.visit?.gateOut != null ? 'Turnaround' : 'On site',
        value: `${dur(onSite)} · limit ${s.rules.turnaroundMax} min`,
        tone: onSite > s.rules.turnaroundMax ? 'warning' : 'neutral',
        hint: `Gate-in to ${t.visit?.gateOut != null ? 'gate-out' : 'now'}${d?.waiting != null ? `; waited ${dur(d.waiting)} for a dock` : ''}${d?.dockTime != null ? `; ${dur(d.dockTime)} at the dock` : ''}.`,
      });
  } else {
    const act = internalActivity(v, s.minute);
    out.push({ key: 'trip', label: 'Task', value: act.current?.activity ?? v.task ?? 'Idle', tone: 'neutral', hint: 'Activity of the current simulated route leg.' });
    if (act.stationaryMin != null) out.push({ key: 'dwell', label: 'At stop', value: act.moving ? '—' : dur(act.stationaryMin), tone: 'neutral', hint: 'Time standing at the current stop — not the time spent in the zone.' });
  }
  return out.slice(0, 5);
}

function vehicleInsights(s: SimState, v: Vehicle, events: OpEvent[], finance: FinanceAssumptions): IntelInsight[] {
  const now = s.minute;
  const out: Ranked[] = [];
  const roots = events.filter((e) => e.end == null && !e.consequenceOf).sort((a, b) => EV_SEV[b.severity] - EV_SEV[a.severity] || b.start - a.start);
  for (const e of roots.slice(0, 2)) {
    const scen = isScenarioEvent(e);
    const line = eventImpactLine(s, e, finance);
    const cause = e.causes[0];
    out.push({
      rule: 'event',
      id: `event:${e.id}`,
      severity: e.severity,
      title: e.title,
      // The impact line is the headline (the event row below then shows title, time and status only).
      observed: `${line ? `${sentence(cap1(line))} ` : ''}${atDetection((t) => clockLabel(t, now), e)} Ongoing for ${dur(now - e.start)}.`,
      why: cause
        ? cause.confidence === 'confirmed'
          ? `Cause: ${lower1(cause.text)}.`
          : `${cause.confidence === 'likely' ? 'Likely cause' : 'Possible contributing factor'}: ${lower1(cause.text)} — not confirmed.`
        : 'No cause is recorded on the event; see its record for the facts and evidence.',
      evidence: [eventEvidence(e), ...e.trigger.observed.slice(0, 2).map((o): IntelEvidence => ({ kind: 'metric', label: `${o.label} ${o.value}${o.unit ? ` ${o.unit}` : ''}` }))],
      next: e.recommendations[0] ?? null,
      basis: scen ? 'scenario' : 'event',
      basisLabel: scen ? `Scenario input · event rule ${e.trigger.ruleId}` : `Event rule ${e.trigger.ruleId}`,
      certainty: 'observed',
    });
  }
  const gone = (v.despawned != null && v.despawned <= now) || !s.logistics.active.includes(v.id);
  if (v.class === 'external') {
    const t = v as TruckRuntime;
    const vis = t.visit;
    if (vis && gone && vis.gateOut != null) {
      out.push({
        rule: 'vehicle',
        id: `vehicle:${v.id}:left`,
        severity: 'info',
        title: `Left the site at ${clockLabel(vis.gateOut, now)}`,
        observed: `Turnaround ${dur(vis.gateOut - vis.gateIn)} (limit ${s.rules.turnaroundMax} min); last known location: main gate.`,
        why: 'Its position is historical — the vehicle is no longer simulated on site.',
        evidence: [{ kind: 'metric', label: `Gate-out ${clockLabel(vis.gateOut, now)}` }],
        next: null,
        basis: 'rule',
        basisLabel: 'Visit record (simulated gate events)',
        certainty: 'observed',
      });
    } else if (vis && vis.gateIn <= now) {
      const d = visitDurations(t, now);
      const onSite = now - vis.gateIn;
      const checks: { what: string; m: number; limit: number }[] = [];
      if (t.phase === 'waiting' && d.waiting != null) checks.push({ what: 'Waiting for a dock', m: d.waiting, limit: s.rules.truckWaitMax });
      if ((t.phase === 'loading' || t.phase === 'unloading') && d.dockTime != null) checks.push({ what: t.phase === 'loading' ? 'At the dock' : 'Unloading', m: d.dockTime, limit: s.rules.dockStayMax });
      checks.push({ what: 'On site', m: onSite, limit: s.rules.turnaroundMax });
      const near = checks.find((c) => c.m >= 0.8 * c.limit && c.m <= c.limit);
      const trip = truckTrip(s, t);
      if (near && !roots.length)
        out.push({
          rule: 'vehicle',
          id: `vehicle:${v.id}:near`,
          severity: 'warning',
          title: `${near.what} · ${dur(near.m)} of ${near.limit} min`,
          observed: `${v.label}: ${lower1(tripStatus(trip.phase))}; ${lower1(near.what)} for ${dur(near.m)} of the ${near.limit} min limit.`,
          why: `It reaches the limit in ≈ ${dur(near.limit - near.m)}; beyond it the visit is flagged as delayed.`,
          evidence: [{ kind: 'metric', label: `Gate-in ${clockLabel(vis.gateIn, now)} · ${trip.dock}` }],
          next: t.phase === 'waiting' ? 'Release the dock closest to completion first, or re-sequence the queue.' : 'Check the loading / paperwork status with the dock supervisor.',
          basis: 'rule',
          basisLabel: 'Visit limits (rule-based)',
          certainty: 'observed',
        });
      else if (!roots.length && checks.every((c) => c.m <= c.limit))
        out.push({
          rule: 'normal',
          id: `normal:${v.id}`,
          severity: 'positive',
          title: 'Visit on schedule',
          observed: `${sentence(cap1(`${lower1(tripStatus(trip.phase))}; on site ${dur(onSite)} of the ${s.rules.turnaroundMax} min turnaround limit${d.waiting != null ? `; waited ${dur(d.waiting)} for a dock (limit ${s.rules.truckWaitMax} min)` : ''}${d.dockTime != null ? `; ${dur(d.dockTime)} at the dock (limit ${s.rules.dockStayMax} min)` : ''}; no open event`))}`,
          why: 'Every visit time is within its configured limit.',
          evidence: [{ kind: 'metric', label: `${trip.dock} · ${trip.load}` }],
          next: null,
          basis: 'rule',
          basisLabel: 'Rule-based',
          certainty: 'observed',
        });
    }
  } else if (!gone) {
    const act = internalActivity(v, now);
    const idle = act.idleLastHour;
    if (idle != null && idle >= 40 && !roots.length)
      out.push({
        rule: 'vehicle',
        id: `vehicle:${v.id}:idle`,
        severity: 'info',
        title: 'Mostly idle in the last hour',
        // The header already says whether it moves or stands now (and since when): only the hour's figure here.
        observed: `Idle or waiting ${dur(idle)} of the last 60 min${act.current && !/idle|waiting|available/i.test(act.current.activity) ? `; now ${lower1(act.current.activity)}` : ''}.`,
        why: 'Spare handling capacity — it can take work from a busier vehicle.',
        // The figure is in the observed text and the utilisation tile: the chip names the rule, not the value again.
        evidence: [{ kind: 'rule', label: 'Idle ≥ 40 min of the last hour (simulated activity log)' }],
        next: null,
        basis: 'rule',
        basisLabel: 'Activity log (simulated)',
        certainty: 'observed',
      });
    else if (!roots.length && act.current)
      out.push({
        rule: 'normal',
        id: `normal:${v.id}`,
        severity: 'positive',
        title: 'Working normally',
        observed: sentence(cap1(`${act.moving ? 'moving' : `stationary for ${dur(act.stationaryMin)}`} · ${lower1(act.current.activity)}${idle != null ? `; idle ${dur(idle)} in the last hour` : ''}; no open event`)),
        why: 'No vehicle rule (restricted zone, waiting, dock stay) is above its threshold.',
        evidence: [{ kind: 'metric', label: `Zone ${vehicleGeofence(s, v.id)?.name ?? '—'} (simulated)` }],
        next: null,
        basis: 'rule',
        basisLabel: 'Rule-based',
        certainty: 'observed',
      });
  }
  return rankInsights(out);
}

/** The intelligence model of a vehicle (truck or internal vehicle) — the same panel as equipment. */
export function deriveVehicleIntel(s: SimState, vehicleId: string, ctx: IntelContext = DEFAULT_INTEL_CONTEXT): EquipmentIntel {
  const v = s.logistics.vehicles[vehicleId];
  const metrics = vehicleKpis(s, vehicleId);
  const events: OpEvent[] = s.events.filter((e) => e.asset.vehicleId === vehicleId).sort((a, b) => b.start - a.start);
  const emptySignals: IntelSignals = { rows: [], notModelled: VEHICLE_PROFILE.notModelled };
  if (!v)
    return {
      subject: { type: 'vehicle', id: vehicleId },
      header: { title: vehicleId, subtitle: 'Vehicle', zone: null, state: { label: 'No longer simulated', tone: 'neutral', op: null }, since: null, source: { kind: 'simulated', label: 'Simulated' } },
      feed: { kind: 'none', reason: 'This vehicle is no longer simulated.', badge: null, details: [] },
      facets: [],
      metrics,
      insights: [],
      analytics: null,
      signals: emptySignals,
      events: { rows: eventRows(s, events, ctx.finance), openCount: events.filter((e) => e.status !== 'resolved').length, total: viewAllCount(s, vehicleId) },
      health: null,
      cameraId: null,
    };
  const mv = vehicleMovement(s, v);
  const loc = vehicleLocation(s, v);
  let state: IntelHeader['state'];
  if (loc.kind === 'historical') state = { label: 'Left site', tone: 'neutral', op: null };
  else if (loc.kind === 'not-arrived') state = { label: 'Not on site yet', tone: 'neutral', op: null };
  else if (v.class === 'external' && (v as TruckRuntime).phase === 'waiting') state = { label: 'Waiting for a dock', tone: 'warning', op: null };
  else if (mv.state === 'moving') state = { label: `Moving${mv.activity ? ` · ${lower1(mv.activity)}` : ''}`, tone: 'good', op: null };
  else if (mv.state === 'stationary') state = { label: `Stationary${mv.activity ? ` · ${lower1(mv.activity)}` : ''}`, tone: 'neutral', op: null };
  else state = { label: 'Not on site', tone: 'neutral', op: null };
  const typeLabel = VEHICLE_TYPE[v.type];
  const onSite = loc.kind === 'simulated';
  const camera = onSite ? selectionCamera(s, { vehicleId }) : null;
  const topic = videoTopicFor(s, v);
  const list = vehicleInsights(s, v, events, ctx.finance);
  // A vehicle off site has no feed; on site, a recording only of the place it is in (its geofence's asset).
  const gf = onSite ? vehicleGeofence(s, vehicleId) : undefined;
  const feed: FeedChoice = onSite
    ? chooseFeed({ equipmentId: gf?.equipmentId ?? null, label: gf ? lower1(gf.name) : 'this vehicle’s area' }, camera, [topic], ctx.cameraSources, { recordingByTopic: false })
    : {
        kind: 'none',
        reason: loc.kind === 'historical' ? 'Left the site — no feed.' : loc.kind === 'not-arrived' ? 'Not on site yet — no feed.' : 'No simulated position — no feed.',
        badge: null,
        details: [],
      };
  return {
    subject: { type: 'vehicle', id: vehicleId },
    header: {
      title: `${v.id} · ${typeLabel}`,
      subtitle: `${v.label !== v.id ? `${v.label} · ` : ''}${v.class === 'external' ? `${(v as TruckRuntime).visit?.direction === 'inbound' ? 'Inbound' : 'Outbound'} visit` : 'Internal vehicle'} · ${v.operator}`,
      zone: loc.kind === 'simulated' ? vehicleZone(s, vehicleId) : null,
      state,
      since: mv.since,
      source: { kind: 'simulated', label: 'Simulated' },
    },
    feed,
    facets: vehicleFacets(s, v),
    metrics,
    insights: list,
    analytics: vehicleAnalytics(s, v),
    signals: emptySignals,
    events: { rows: eventRows(s, events, ctx.finance), openCount: events.filter((e) => e.status !== 'resolved').length, total: viewAllCount(s, vehicleId) },
    health: null,
    cameraId: camera?.id ?? null,
    ask: askFor(vehicleId, list, `What is ${typeLabel.toLowerCase()} ${vehicleId} doing?`),
  };
}

