/**
 * Deterministic production simulation.
 *
 * The line is modelled as stages linked by finite WIP buffers (slip tanks, powder
 * silos, buffer racks…). Every plant minute each stage produces
 *   min(capacity, input available, output space)
 * so starvation and blocking propagate naturally up and down the line, and a
 * capacity loss at one stage reaches the others only once the buffers between
 * them have drained or filled.
 *
 * All variation comes from seeded per-entity streams (src/sim/rng.ts); scenarios are
 * explicit, timestamped inputs. Given the same seed and scenario log, the state at any
 * minute is identical — "reset" replays the baseline.
 */
import {
  BASE_REJECT_RATE,
  BUFFERS,
  CHANGEOVER_EVERY_MIN,
  CONVEYORS,
  CONVEYOR_BY_ID,
  CONVEYOR_IDS,
  DEFAULT_EVENT_RULES,
  DEFECTS,
  DEFECT_ORDER,
  INSPECTION_STATIONS,
  LINE,
  OPS_BY_ID,
  OUTPUT_BUFFER,
  PLANNED_STOPS,
  PROCESS_MACHINES,
  PRODUCTS,
  REASON_BY_CODE,
  STAGES,
  STAGE_BY_ID,
  TILES_PER_PALLET,
} from '../model/plant';
import type {
  Alert,
  AlertSeverity,
  DefectCategory,
  DowntimeEvent,
  EquipmentRuntime,
  EventRules,
  Evidence,
  FeedRuntime,
  OpEvent,
  HourBucket,
  MachineState,
  ProductionBatch,
  QualityBucket,
  QualityInspection,
  ScenarioActivation,
  StageId,
} from '../model/types';
import { createLogistics, stepLogistics, applyLogisticsScenario, type LogisticsState } from './logistics';
import { CONSUMERS, stepEnergy, type EnergyBucket } from './energy';
import { createHealth, degradationLoad, startMaintenance, stepHealth, type HealthState } from './health';
import { expBounded, lerpRange, noise01, streamFor, weighted, type Rng } from './rng';
import { DEFAULT_START, MIN_PER_DAY, SHIFT_MIN, formatDate } from './time';
import { createEventInternal, stepEvents, type EventInternal } from './events';

export const DEFAULT_SEED = 20261012;

export type SimState = {
  seed: number;
  /** Next minute to simulate; the state describes the plant at the start of this minute. */
  minute: number;
  machines: Record<string, EquipmentRuntime>;
  /** equipmentId → hour index → bucket. */
  hours: Record<string, Map<number, HourBucket>>;
  /** Buffer id → tiles currently held. */
  buffers: Record<string, number>;
  /** Buffer id → hour → average level (fraction), for trends. */
  bufferHours: Record<string, Map<number, number>>;
  downtime: DowntimeEvent[];
  /** Line output: first-quality tiles accepted at sorting, per hour. */
  lineGood: Map<number, number>;
  quality: Map<number, Record<string, QualityBucket>>;
  inspections: QualityInspection[];
  batches: ProductionBatch[];
  scenarios: ScenarioActivation[];
  alerts: Alert[];
  logistics: LogisticsState;
  /** Consumer id → hour → energy (kWh). */
  energy: Record<string, Map<number, EnergyBucket>>;
  health: HealthState;
  /** Simulated data-feed health per process machine and conveyor (PLC / gateway link). */
  feeds: Record<string, FeedRuntime>;
  /** Per-minute history of the last LOG_MIN minutes (rate and state) for evidence and signal trends. */
  minuteLog: Record<string, MinuteLog>;
  /** Per-minute inspection counts (last LOG_MIN minutes) for minute-accurate quality rules. */
  qualityLog: QualityLog;
  /** Per-minute buffer levels (tiles, last LOG_MIN minutes). */
  bufferLog: Record<string, { level: Float32Array; t: Int32Array }>;
  /** Unified operational events (all use cases) and their evidence — see src/sim/events.ts. */
  events: OpEvent[];
  evidence: Evidence[];
  /** Detection-rule thresholds currently in force. */
  rules: EventRules;
  /** Whether the event engine runs (off for the baseline twin). */
  eventsOn: boolean;
  /** Minute this demo session started; events before it are pre-rolled history. */
  liveFrom: number;
  /** Internal bookkeeping (not for display). */
  internal: Internal;
  /** Incremented on every change; UI memoisation key. */
  version: number;
};

type Internal = {
  failRng: Record<string, Rng>;
  nextFailure: Record<string, number>;
  /** Scheduled stop windows not yet started: equipmentId → list. */
  pendingStops: { equipmentId: string; start: number; duration: number; reason: string }[];
  /** Starved/blocked spell tracking per machine. */
  spell: Record<string, { kind: 'Starved' | 'Blocked'; start: number; eventId: string | null } | null>;
  /** Fractional reject accumulators per station+defect for record emission. */
  recordAcc: Record<string, number>;
  qualityRng: Rng;
  /** Separate stream for illustrative vision detections (keeps quality records stable). */
  cvRng: Rng;
  palletAcc: number;
  seq: number;
  /** Last minute an alert of a given key fired (de-duplication). */
  alertAt: Record<string, number>;
  /** Event-engine state (open conditions, rule timers); separate id sequence so other ids are unchanged. */
  ev: EventInternal;
};

/** Ring buffer: tiles moved per minute and a state code, indexed by minute % LOG_MIN. */
export type MinuteLog = {
  rate: Float32Array;
  state: Uint8Array;
  /** 0 = own pace, 1 = limited by input, 2 = limited by output (held by a neighbour). */
  lim: Uint8Array;
  t: Int32Array;
};
export const LOG_MIN = 240;
export type QualityLog = { t: Int32Array; inspected: Float32Array; rejected: Float32Array; defect: Record<DefectCategory, Float32Array> };
export const STATE_CODE: Record<MachineState, number> = { running: 0, reduced: 1, starved: 2, blocked: 3, down: 4, planned: 5 };
export const CODE_STATE: MachineState[] = ['running', 'reduced', 'starved', 'blocked', 'down', 'planned'];
/** Assets with stop/failure accounting: process machines and conveyors. */
export const TRACKED_ASSETS = [...PROCESS_MACHINES, ...CONVEYOR_IDS];

const BUFFER_CAP = Object.fromEntries(BUFFERS.map((b) => [b.id, b.capacity]));
/** Tiles per illustrative inspection record. */
const TILES_PER_RECORD = 6;
const MAX_INSPECTIONS = 4000;
const MAX_ALERTS = 400;

const emptyBucket = (): HourBucket => ({
  planned: 0,
  operating: 0,
  down: 0,
  plannedStop: 0,
  starved: 0,
  blocked: 0,
  count: 0,
  rejects: 0,
});

export const nextId = (s: SimState, prefix: string) => `${prefix}-${String(++s.internal.seq).padStart(6, '0')}`;

// ── Creation & stepping ───────────────────────────────────────────────────────

export function createSim(seed = DEFAULT_SEED, startMinute = DEFAULT_START, opts: { events?: boolean } = {}): SimState {
  const s: SimState = {
    seed,
    minute: 0,
    machines: {},
    hours: {},
    buffers: Object.fromEntries(BUFFERS.map((b) => [b.id, Math.round(b.capacity * b.initialFill)])),
    bufferHours: Object.fromEntries(BUFFERS.map((b) => [b.id, new Map()])),
    downtime: [],
    lineGood: new Map(),
    quality: new Map(),
    inspections: [],
    batches: [],
    scenarios: [],
    alerts: [],
    logistics: createLogistics(seed),
    energy: {},
    health: createHealth(seed),
    feeds: {},
    minuteLog: {},
    qualityLog: {
      t: new Int32Array(LOG_MIN).fill(-1),
      inspected: new Float32Array(LOG_MIN),
      rejected: new Float32Array(LOG_MIN),
      defect: Object.fromEntries(DEFECT_ORDER.map((d) => [d, new Float32Array(LOG_MIN)])) as Record<DefectCategory, Float32Array>,
    },
    bufferLog: Object.fromEntries(BUFFERS.map((b) => [b.id, { level: new Float32Array(LOG_MIN), t: new Int32Array(LOG_MIN).fill(-1) }])),
    events: [],
    evidence: [],
    rules: { ...DEFAULT_EVENT_RULES },
    eventsOn: opts.events ?? true,
    liveFrom: startMinute,
    internal: {
      failRng: {},
      nextFailure: {},
      pendingStops: [],
      spell: {},
      recordAcc: {},
      qualityRng: streamFor(seed, 'quality'),
      cvRng: streamFor(seed, 'cv'),
      palletAcc: 0,
      seq: 0,
      alertAt: {},
      ev: createEventInternal(),
    },
    version: 0,
  };
  for (const id of TRACKED_ASSETS) {
    s.machines[id] = {
      id,
      state: 'running',
      since: 0,
      rateFactor: 1,
      ratePerHour: 0,
      countTotal: 0,
      countRejectAttributed: 0,
      activeDowntimeId: null,
    };
    s.hours[id] = new Map();
    s.feeds[id] = { status: 'ok', since: 0 };
    s.minuteLog[id] = { rate: new Float32Array(LOG_MIN), state: new Uint8Array(LOG_MIN), lim: new Uint8Array(LOG_MIN), t: new Int32Array(LOG_MIN).fill(-1) };
    const rng = streamFor(seed, `fail:${id}`);
    s.internal.failRng[id] = rng;
    const rel = reliabilityOf(id);
    s.internal.nextFailure[id] = Math.round(expBounded(rng(), rel.mtbf, 20, rel.mtbf * 3));
    s.internal.spell[id] = null;
  }
  s.batches.push({ id: batchId(0, 0), sku: PRODUCTS[0].sku, start: 0, end: null });
  advance(s, startMinute);
  return s;
}

/** Simulate whole minutes up to (not including) `toMinute`. */
export function advance(s: SimState, toMinute: number) {
  while (s.minute < toMinute) stepMinute(s);
  s.version++;
}

function stepMinute(s: SimState) {
  const t = s.minute;
  try {
    scheduleCalendarStops(s, t);
    startDueStops(s, t);
    startFailures(s, t);
    applyScenarioStops(s, t);
    applyScenarioFeeds(s, t);
    endFinishedDowntime(s, t);
    logMinute(s, t, produce(s, t));
    const active = activeScenarios(s, t);
    stepEnergy(s, t, active, degradationLoad(s, t));
    if (t % 15 === 0) energyAlerts(s, t);
    stepHealth(s, t);
    stepLogistics(s, t);
    if (s.eventsOn) stepEvents(s, t);
    if (t % 60 === 0) pruneHistory(s, t);
  } finally {
    // A failing subsystem must never re-run a minute (that would double-count the buckets).
    s.minute = t + 1;
  }
}

const reliabilityOf = (id: string) => CONVEYOR_BY_ID[id]?.reliability ?? OPS_BY_ID[id].reliability!;

/** Records the minute's output and state of every tracked asset in its ring buffer. */
function logMinute(s: SimState, t: number, limits: Partial<Record<StageId, 'input' | 'output' | null>>) {
  const i = t % LOG_MIN;
  for (const id of TRACKED_ASSETS) {
    const m = s.machines[id];
    const log = s.minuteLog[id];
    log.rate[i] = m.ratePerHour / 60;
    log.state[i] = STATE_CODE[m.state];
    const st = OPS_BY_ID[id]?.stage;
    const l = st ? limits[st] : null;
    log.lim[i] = l === 'input' ? 1 : l === 'output' ? 2 : 0;
    log.t[i] = t;
  }
}

/** Output (tiles/min) and state of an asset at minute t, if still in the ring buffer. */
export function minuteAt(s: SimState, id: string, t: number): { rate: number; state: MachineState; limited: boolean } | null {
  const log = s.minuteLog[id];
  if (!log || t < 0) return null;
  const i = t % LOG_MIN;
  if (log.t[i] !== t) return null;
  return { rate: log.rate[i], state: CODE_STATE[log.state[i]], limited: log.lim[i] !== 0 };
}

/** Drops closed records older than eight days (open ones and anything a 7-day view can touch stay). */
function pruneHistory(s: SimState, t: number) {
  const cutoff = t - 8 * MIN_PER_DAY;
  if (s.downtime.length && s.downtime[0].end != null && s.downtime[0].end < cutoff)
    s.downtime = s.downtime.filter((d) => d.end == null || d.end >= cutoff);
  if (s.events.length && s.events[0].end != null && s.events[0].end < cutoff) {
    const keep = s.events.filter((e) => e.end == null || e.end >= cutoff || e.status !== 'resolved');
    const ids = new Set(keep.map((e) => e.id));
    s.events = keep;
    s.internal.ev.index = new Map(keep.map((e) => [e.id, e]));
    s.evidence = s.evidence.filter((x) => ids.has(x.eventId));
  }
}

/** Simulated data-feed loss: the asset keeps producing, but its signals stop updating. */
function applyScenarioFeeds(s: SimState, t: number) {
  const lost = new Map<string, string>();
  for (const sc of activeScenarios(s, t)) if (sc.kind === 'signal-loss' && sc.equipmentId) lost.set(sc.equipmentId, sc.id);
  for (const id of TRACKED_ASSETS) {
    const f = s.feeds[id];
    const scn = lost.get(id);
    if (scn && f.status === 'ok') {
      const m = s.machines[id];
      s.feeds[id] = { status: 'stale', since: t, scenarioId: scn, lastState: m.state, lastCount: m.countTotal, lastRate: m.ratePerHour };
    }
    else if (!scn && f.status === 'stale') s.feeds[id] = { status: 'ok', since: t };
  }
}

// ── Calendar: planned cleaning, product changeovers, batches ────────────────

const batchId = (minute: number, n: number) => `B-${formatDate(minute).slice(2).replace(/-/g, '')}-${String(n).padStart(2, '0')}`;

function scheduleCalendarStops(s: SimState, t: number) {
  if (t % SHIFT_MIN === 0) {
    for (const p of PLANNED_STOPS)
      s.internal.pendingStops.push({ equipmentId: p.equipmentId, start: t + p.offset, duration: p.duration, reason: 'PLN_CLEAN' });
  }
  if (t > 0 && t % CHANGEOVER_EVERY_MIN === 120) {
    // New production batch starts at the presses; glaze line changes colour when it arrives (~2.5 h later).
    const n = s.batches.length;
    const prev = s.batches[n - 1];
    prev.end = t;
    s.batches.push({ id: batchId(t, n), sku: PRODUCTS[n % PRODUCTS.length].sku, start: t, end: null });
    const rng = streamFor(s.seed, `chg:${t}`);
    ['E-PRS1', 'E-PRS2', 'E-PRS3'].forEach((id, i) =>
      s.internal.pendingStops.push({ equipmentId: id, start: t + i * 12, duration: Math.round(lerpRange(rng(), 18, 30)), reason: 'CHG_PRODUCT' }),
    );
    s.internal.pendingStops.push({ equipmentId: 'G-LINE', start: t + 150, duration: Math.round(lerpRange(rng(), 12, 20)), reason: 'CHG_PRODUCT' });
    s.internal.pendingStops.push({ equipmentId: 'G-INK', start: t + 158, duration: Math.round(lerpRange(rng(), 8, 14)), reason: 'CHG_PRODUCT' });
  }
}

function startDueStops(s: SimState, t: number) {
  const due = s.internal.pendingStops.filter((p) => p.start <= t);
  if (!due.length) return;
  s.internal.pendingStops = s.internal.pendingStops.filter((p) => p.start > t);
  for (const p of due) {
    const m = s.machines[p.equipmentId];
    if (m.activeDowntimeId) continue; // already stopped; the window is skipped
    openDowntime(s, p.equipmentId, p.reason, t, t + p.duration, 'simulation');
  }
}

function startFailures(s: SimState, t: number) {
  for (const id of TRACKED_ASSETS) {
    if (s.internal.nextFailure[id] > t) continue;
    const m = s.machines[id];
    const rel = reliabilityOf(id);
    const rng = s.internal.failRng[id];
    if (!m.activeDowntimeId) {
      const reason = weighted(rng(), rel.reasons.map((r, i): [string, number] => [r, 3 - i]));
      const duration = Math.round(lerpRange(rng() ** 1.6, rel.repairMin, rel.repairMax));
      openDowntime(s, id, reason, t, t + duration, 'simulation');
      s.internal.nextFailure[id] = t + duration + Math.round(expBounded(rng(), rel.mtbf, 20, rel.mtbf * 3));
    } else {
      s.internal.nextFailure[id] = t + 5;
    }
  }
}

/** End time scheduled for an open downtime event (not exposed in the record until it ends). */
const scheduledEnd = new WeakMap<DowntimeEvent, number | null>();

export function openDowntime(
  s: SimState,
  equipmentId: string,
  reasonCode: string,
  start: number,
  end: number | null,
  source: DowntimeEvent['source'],
  scenarioId?: string,
) {
  const reason = REASON_BY_CODE[reasonCode];
  const ev: DowntimeEvent = {
    id: nextId(s, 'DT'),
    equipmentId,
    reasonCode,
    category: reason.category,
    start,
    end: null,
    lostTiles: 0,
    constraintImpactMin: 0,
    source,
    scenarioId,
  };
  scheduledEnd.set(ev, end);
  s.downtime.push(ev);
  const m = s.machines[equipmentId];
  m.activeDowntimeId = ev.id;
  setState(m, reason.planned ? 'planned' : 'down', start);
  if (!reason.planned) {
    const severity: AlertSeverity = equipmentId === 'H-KILN' ? 'critical' : OPS_BY_ID[equipmentId]?.stage === 'PRESS' ? 'serious' : 'warning';
    raiseAlert(s, start, severity, `${equipmentId} stopped`, reason.label, { equipmentId }, source);
  }
  return ev;
}

function closeDowntime(s: SimState, ev: DowntimeEvent, t: number) {
  ev.end = t;
  const m = s.machines[ev.equipmentId];
  if (m.activeDowntimeId === ev.id) {
    m.activeDowntimeId = null;
    setState(m, 'running', t);
  }
}

function endFinishedDowntime(s: SimState, t: number) {
  for (const id of TRACKED_ASSETS) {
    const m = s.machines[id];
    if (!m.activeDowntimeId) continue;
    const ev = findDowntime(s, m.activeDowntimeId);
    const end = ev ? scheduledEnd.get(ev) : null;
    if (ev && end != null && end <= t) closeDowntime(s, ev, t);
  }
}

export const findDowntime = (s: SimState, id: string) => {
  for (let i = s.downtime.length - 1; i >= 0; i--) if (s.downtime[i].id === id) return s.downtime[i];
  return undefined;
};

function setState(m: EquipmentRuntime, state: MachineState, t: number) {
  if (m.state !== state) {
    m.state = state;
    m.since = t;
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

const activeScenarios = (s: SimState, t: number) => s.scenarios.filter((sc) => sc.start <= t && (sc.end == null || sc.end > t));

function applyScenarioStops(s: SimState, t: number) {
  for (const sc of activeScenarios(s, t)) {
    if ((sc.kind !== 'machine-stop' && sc.kind !== 'conveyor-stop') || !sc.equipmentId) continue;
    const m = s.machines[sc.equipmentId];
    if (!m) continue;
    const current = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
    if (current?.scenarioId === sc.id) continue;
    if (current) closeDowntime(s, current, t);
    openDowntime(s, sc.equipmentId, sc.kind === 'conveyor-stop' ? 'SCN_CNV_STOP' : 'SCN_STOP', t, sc.end, 'scenario', sc.id);
  }
}

/** Scenario-driven rate factor for one machine at minute t. */
function scenarioRate(s: SimState, id: string, stage: StageId, t: number) {
  let f = 1;
  for (const sc of activeScenarios(s, t)) {
    if (sc.kind === 'reduced-rate' && sc.equipmentId === id) f *= sc.factor ?? 0.6;
    if (sc.kind === 'bottleneck' && sc.stage === stage) f *= sc.factor ?? 0.55;
  }
  return f;
}

export function activateScenario(s: SimState, def: Omit<ScenarioActivation, 'id' | 'start'> & { start?: number }) {
  const sc: ScenarioActivation = { ...def, id: nextId(s, 'SCN'), start: def.start ?? s.minute };
  if (sc.kind === 'degradation' && sc.equipmentId) {
    // A developing fault: starts mildly abnormal and progresses towards failure.
    s.health.episodes.push({
      id: nextId(s, 'DG'),
      equipmentId: sc.equipmentId,
      start: sc.start,
      startSeverity: 0.3,
      ratePerMin: sc.factor ?? 0.0068,
      end: null,
      endReason: null,
      cause: 'Developing component fault (scenario)',
      source: 'scenario',
      scenarioId: sc.id,
    });
  }
  if (sc.kind === 'maintenance' && sc.equipmentId) {
    const duration = sc.count ?? 45;
    startMaintenance(s, sc.equipmentId, duration, sc.id);
    sc.end = sc.start + duration;
  }
  // One-off logistics injections are applied at once; they are logged, not left "active".
  if (sc.kind === 'truck-arrival' || sc.kind === 'yard-congestion' || sc.kind === 'prolonged-dock-stay' || sc.kind === 'restricted-entry')
    sc.end = sc.start + 1;
  s.scenarios.push(sc);
  if (sc.kind === 'machine-stop' || sc.kind === 'conveyor-stop') applyScenarioStops(s, s.minute);
  if (sc.kind === 'signal-loss') applyScenarioFeeds(s, s.minute);
  applyLogisticsScenario(s, sc);
  raiseAlert(s, sc.start, 'info', `Scenario started: ${sc.label}`, 'Simulated scenario input', { equipmentId: sc.equipmentId }, 'scenario');
  s.version++;
  return sc;
}

export function clearScenario(s: SimState, id: string) {
  const sc = s.scenarios.find((x) => x.id === id);
  if (!sc || (sc.end != null && sc.end <= s.minute)) return;
  sc.end = s.minute;
  if ((sc.kind === 'machine-stop' || sc.kind === 'conveyor-stop') && sc.equipmentId) {
    const m = s.machines[sc.equipmentId];
    const ev = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
    if (ev?.scenarioId === sc.id) closeDowntime(s, ev, s.minute);
  }
  if (sc.kind === 'signal-loss') applyScenarioFeeds(s, s.minute);
  if (sc.kind === 'degradation')
    for (const e of s.health.episodes)
      if (e.scenarioId === sc.id && e.end == null) {
        e.end = s.minute;
        e.endReason = 'maintenance';
      }
  if (sc.kind === 'maintenance' && sc.equipmentId) {
    // Cancelling maintenance ends the planned stop early; the fault it was meant to remove stays.
    const m = s.machines[sc.equipmentId];
    const ev = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
    if (ev?.scenarioId === sc.id) closeDowntime(s, ev, s.minute);
    if (s.health.fixAt[sc.equipmentId]?.scenarioId === sc.id) delete s.health.fixAt[sc.equipmentId];
    for (let i = s.health.maintenance.length - 1; i >= 0; i--) {
      const r = s.health.maintenance[i];
      if (r.equipmentId === sc.equipmentId && r.type === 'Condition-based' && r.end > s.minute) {
        r.end = s.minute;
        r.description += ' (cancelled)';
        break;
      }
    }
  }
  raiseAlert(s, s.minute, 'info', `Scenario cleared: ${sc.label}`, 'Simulated scenario input', { equipmentId: sc.equipmentId }, 'scenario');
  s.version++;
}

// ── Production ────────────────────────────────────────────────────────────────

/** Smooth bounded performance variation (micro-stops, speed losses): 0.90–0.99. */
function performanceNoise(seed: number, id: string, t: number) {
  const k = Math.floor(t / 20);
  const f = (t % 20) / 20;
  const a = noise01(seed, `perf:${id}`, k);
  const b = noise01(seed, `perf:${id}`, k + 1);
  const v = a + (b - a) * (f * f * (3 - 2 * f));
  return 0.9 + 0.09 * v;
}

/** Slow drift of the baseline reject rate (×0.7 – ×1.35). */
function qualityDrift(seed: number, t: number) {
  const k = Math.floor(t / 90);
  const f = (t % 90) / 90;
  const a = noise01(seed, 'qdrift', k);
  const b = noise01(seed, 'qdrift', k + 1);
  return 0.7 + 0.65 * (a + (b - a) * f);
}

const bucket = (s: SimState, id: string, hour: number) => {
  const map = s.hours[id];
  let b = map.get(hour);
  if (!b) {
    b = emptyBucket();
    map.set(hour, b);
  }
  return b;
};

function produce(s: SimState, t: number) {
  const hour = Math.floor(t / 60);
  /** Was the constraint (kiln) held up by input/output this minute? */
  let constraintStalled = false;
  // A stopped conveyor cuts the transfer it carries: no input for the stages it feeds, no discharge for the ones feeding it.
  const inputCut = new Set<StageId>();
  const outputCut = new Set<StageId>();
  for (const c of CONVEYORS)
    if (s.machines[c.id].activeDowntimeId) {
      c.blocksInputOf.forEach((x) => inputCut.add(x));
      c.blocksOutputOf.forEach((x) => outputCut.add(x));
    }
  const producedBy: Partial<Record<StageId, number>> = {};
  const limitOf: Partial<Record<StageId, 'input' | 'output' | null>> = {};

  for (let si = STAGES.length - 1; si >= 0; si--) {
    const stage = STAGES[si];
    const inBuf = stage.inputBuffer;
    const outBuf = OUTPUT_BUFFER[stage.id];
    const caps = stage.machines.map((id) => {
      const m = s.machines[id];
      if (m.activeDowntimeId) return 0;
      const ideal = OPS_BY_ID[id].idealRatePerHour! / 60;
      const scn = scenarioRate(s, id, stage.id, t);
      m.rateFactor = scn;
      return ideal * scn * performanceNoise(s.seed, id, t);
    });
    const capTotal = caps.reduce((a, b) => a + b, 0);
    const available = inputCut.has(stage.id) ? 0 : inBuf ? s.buffers[inBuf] : Infinity;
    const space = outputCut.has(stage.id) ? 0 : outBuf ? BUFFER_CAP[outBuf] - s.buffers[outBuf] : Infinity;
    const produced = Math.max(0, Math.min(capTotal, available, space));
    const limitedBy: 'input' | 'output' | null =
      produced < capTotal * 0.999 ? (available <= space ? 'input' : 'output') : null;
    producedBy[stage.id] = produced;
    limitOf[stage.id] = limitedBy;

    if (inBuf) s.buffers[inBuf] -= produced;
    if (outBuf) s.buffers[outBuf] += produced;

    stage.machines.forEach((id, i) => {
      const m = s.machines[id];
      const b = bucket(s, id, hour);
      const share = capTotal > 0 ? caps[i] / capTotal : 0;
      const made = produced * share;
      m.countTotal += made;
      b.count += made;
      m.ratePerHour = made * 60;
      if (m.activeDowntimeId) {
        const ev = findDowntime(s, m.activeDowntimeId)!;
        if (REASON_BY_CODE[ev.reasonCode].planned) b.plannedStop++;
        else {
          b.planned++;
          b.down++;
          ev.lostTiles += OPS_BY_ID[id].idealRatePerHour! / 60;
        }
        trackSpell(s, id, null, t);
        return;
      }
      b.planned++;
      const runFrac = caps[i] > 0 ? Math.min(1, made / caps[i]) : 0;
      b.operating += runFrac;
      if (limitedBy && runFrac < 0.5) {
        const kind = limitedBy === 'input' ? 'Starved' : 'Blocked';
        if (kind === 'Starved') b.starved += 1 - runFrac;
        else b.blocked += 1 - runFrac;
        setState(m, kind === 'Starved' ? 'starved' : 'blocked', t);
        trackSpell(s, id, kind, t);
      } else {
        if (limitedBy === 'input') b.starved += 1 - runFrac;
        else if (limitedBy === 'output') b.blocked += 1 - runFrac;
        setState(m, m.rateFactor < 0.95 ? 'reduced' : 'running', t);
        trackSpell(s, id, null, t);
      }
    });

    if (stage.id === LINE.designConstraint && (capTotal === 0 || (limitedBy && produced < capTotal * 0.5))) constraintStalled = true;
    if (stage.id === 'SORT') inspect(s, t, hour, produced);
    if (stage.id === 'PAL') {
      s.internal.palletAcc += produced;
      while (s.internal.palletAcc >= TILES_PER_PALLET) {
        s.internal.palletAcc -= TILES_PER_PALLET;
        s.logistics.palletsProduced++;
        s.logistics.putawayQueue++;
        // Warehouse stock counts the pallet from the moment it leaves the wrapper (incl. awaiting put-away).
        s.logistics.stockPallets++;
      }
    }
  }

  conveyorAccounting(s, t, hour, producedBy, limitOf);
  bufferAndImpact(s, t, hour, constraintStalled);
  return limitOf;
}

function bufferAndImpact(s: SimState, t: number, hour: number, constraintStalled: boolean) {
  // Operational impact: every open unplanned event accrues constraint-stall minutes.
  if (constraintStalled)
    for (const id of TRACKED_ASSETS) {
      const m = s.machines[id];
      if (!m.activeDowntimeId) continue;
      const ev = findDowntime(s, m.activeDowntimeId)!;
      if (!REASON_BY_CODE[ev.reasonCode].planned) ev.constraintImpactMin++;
    }
  if (constraintStalled && s.machines['H-KILN'].state !== 'down' && s.machines['H-KILN'].state !== 'planned') {
    const since = s.machines['H-KILN'].since;
    if (t - since === 10)
      raiseAlert(s, t, 'serious', `Constraint ${s.machines['H-KILN'].state}: H-KILN`, 'Kiln held up for 10 min — line output lost', { equipmentId: 'H-KILN' }, 'simulation');
  }

  for (const b of BUFFERS) {
    const map = s.bufferHours[b.id];
    const minuteInHour = t % 60;
    const level = s.buffers[b.id] / b.capacity;
    const log = s.bufferLog[b.id];
    log.level[t % LOG_MIN] = s.buffers[b.id];
    log.t[t % LOG_MIN] = t;
    map.set(hour, ((map.get(hour) ?? 0) * minuteInHour + level) / (minuteInHour + 1));
  }
}

/**
 * Conveyor runtime: a conveyor moves what the stage it feeds takes in. It is 'down' while stopped,
 * 'starved' (running empty) when there is nothing to carry and 'blocked' (accumulating) when the
 * receiving stage cannot take tiles.
 */
function conveyorAccounting(
  s: SimState,
  t: number,
  hour: number,
  producedBy: Partial<Record<StageId, number>>,
  limitOf: Partial<Record<StageId, 'input' | 'output' | null>>,
) {
  for (const c of CONVEYORS) {
    const m = s.machines[c.id];
    const b = bucket(s, c.id, hour);
    const fed = c.blocksInputOf[0] ?? c.to;
    const flow = m.activeDowntimeId ? 0 : (fed ? (producedBy[fed] ?? 0) : 0);
    m.countTotal += flow;
    m.ratePerHour = flow * 60;
    b.count += flow;
    b.planned++;
    if (m.activeDowntimeId) {
      b.down++;
      continue;
    }
    const cap = c.capacityPerHour / 60;
    b.operating += flow > 0 ? 1 : 0;
    const receiver = fed ? s.machines[STAGE_BY_ID[fed].machines[0]] : null;
    const receiverHeld = receiver != null && (receiver.state === 'down' || receiver.state === 'planned' || receiver.state === 'blocked');
    if (flow < cap * 0.05) {
      if (receiverHeld || (fed && limitOf[fed] === 'output')) {
        b.blocked++;
        setState(m, 'blocked', t);
      } else {
        b.starved++;
        setState(m, 'starved', t);
      }
    } else setState(m, 'running', t);
  }
}

/** Opens a starved/blocked event once a spell lasts 3 min; closes it when it ends. */
function trackSpell(s: SimState, id: string, kind: 'Starved' | 'Blocked' | null, t: number) {
  const sp = s.internal.spell[id];
  if (sp && sp.kind !== kind) {
    if (sp.eventId) {
      const ev = findDowntime(s, sp.eventId);
      if (ev) ev.end = t;
    }
    s.internal.spell[id] = null;
  }
  if (!kind) return;
  const cur = s.internal.spell[id];
  if (!cur) {
    s.internal.spell[id] = { kind, start: t, eventId: null };
    return;
  }
  if (!cur.eventId && t - cur.start >= 3) {
    const ev: DowntimeEvent = {
      id: nextId(s, 'DT'),
      equipmentId: id,
      reasonCode: kind === 'Starved' ? 'STARVED' : 'BLOCKED',
      category: kind,
      start: cur.start,
      end: null,
      lostTiles: (OPS_BY_ID[id].idealRatePerHour! / 60) * (t - cur.start),
      constraintImpactMin: 0,
      source: 'simulation',
    };
    s.downtime.push(ev);
    cur.eventId = ev.id;
  } else if (cur.eventId) {
    const ev = findDowntime(s, cur.eventId);
    if (ev) ev.lostTiles += OPS_BY_ID[id].idealRatePerHour! / 60;
  }
}

// ── Quality ───────────────────────────────────────────────────────────────────

function rejectRate(s: SimState, t: number) {
  let rate = BASE_REJECT_RATE * qualityDrift(s.seed, t);
  const boosts: Partial<Record<DefectCategory, number>> = {};
  for (const sc of activeScenarios(s, t)) {
    if (sc.kind !== 'quality-deterioration') continue;
    const mult = sc.factor ?? 3;
    // Concentrate the deterioration in the defects originating at the chosen stage.
    for (const d of DEFECT_ORDER) if (!sc.stage || DEFECTS[d].origin === sc.stage) boosts[d] = (boosts[d] ?? 1) * mult;
  }
  const weights = DEFECT_ORDER.map((d): [DefectCategory, number] => [d, DEFECTS[d].weight * (boosts[d] ?? 1)]);
  const baseWeight = DEFECT_ORDER.reduce((a, d) => a + DEFECTS[d].weight, 0);
  const totalWeight = weights.reduce((a, [, w]) => a + w, 0);
  return { rate: rate * (totalWeight / baseWeight), weights, totalWeight };
}

function inspect(s: SimState, t: number, hour: number, inspected: number) {
  if (inspected <= 0) return;
  const { rate, weights, totalWeight } = rejectRate(s, t);
  const rejected = Math.min(inspected, inspected * rate);
  const good = inspected - rejected;
  const ql = s.qualityLog;
  const qi = t % LOG_MIN;
  ql.t[qi] = t;
  ql.inspected[qi] = inspected;
  ql.rejected[qi] = rejected;
  s.lineGood.set(hour, (s.lineGood.get(hour) ?? 0) + good);
  const sortBucket = bucket(s, 'I-SORT', hour);
  void sortBucket;

  let qh = s.quality.get(hour);
  if (!qh) {
    qh = Object.fromEntries(INSPECTION_STATIONS.map((st) => [st.id, { inspected: 0, rejected: 0, byDefect: {} }]));
    s.quality.set(hour, qh);
  }
  qh['ST-GAUGE'].inspected += inspected;
  qh['ST-VIS'].inspected += inspected;

  const batch = batchAt(s, t - 180);
  for (const [defect, w] of weights) {
    const n = rejected * (w / totalWeight);
    ql.defect[defect][qi] = n;
    const def = DEFECTS[defect];
    const st = qh[def.station];
    st.rejected += n;
    st.byDefect[defect] = (st.byDefect[defect] ?? 0) + n;
    attributeRejects(s, def.origin, hour, n);
    const key = `${def.station}:${defect}`;
    s.internal.recordAcc[key] = (s.internal.recordAcc[key] ?? 0) + n;
    while (s.internal.recordAcc[key] >= TILES_PER_RECORD) {
      s.internal.recordAcc[key] -= TILES_PER_RECORD;
      pushInspection(s, t, def.station, batch.id, defect);
    }
  }
  // QC laboratory sample every 60 min.
  if (t % 60 === 30) {
    const rng = s.internal.qualityRng;
    const pass = rng() > 0.05;
    const wa = (pass ? 0.32 + rng() * 0.12 : 0.51 + rng() * 0.11).toFixed(2);
    const mor = (34 + rng() * 8).toFixed(1);
    pushRecord(s, {
      id: nextId(s, 'INS'),
      time: t,
      stationId: 'ST-QC',
      batchId: batch.id,
      result: pass ? 'pass' : 'reject',
      defect: null,
      severity: pass ? null : 'minor',
      measurement: `Water absorption ${wa} % (limit 0.50) · MOR ${mor} N/mm²${pass ? '' : ' · retest requested'}`,
      tiles: 5,
      confidence: null,
      box: null,
      source: 'simulation',
    });
  }
  const recent = recentRejectRate(s, t);
  if (recent > 0.05 && t - (s.internal.alertAt['quality'] ?? -1e9) > 120) {
    s.internal.alertAt['quality'] = t;
    raiseAlert(s, t, 'serious', 'Reject rate above 5 %', `Sorting reject rate ${(recent * 100).toFixed(1)} % over the last hour`, { equipmentId: 'I-VIS' }, 'simulation');
  }
}

function recentRejectRate(s: SimState, t: number) {
  const h = Math.floor(t / 60);
  const q = s.quality.get(h);
  if (!q || q['ST-VIS'].inspected < 200) return 0;
  return (q['ST-VIS'].rejected + q['ST-GAUGE'].rejected) / q['ST-VIS'].inspected;
}

/** Reject tiles are charged to the machines of the stage where the defect originated. */
function attributeRejects(s: SimState, stage: StageId, hour: number, n: number) {
  const machines = STAGE_BY_ID[stage].machines;
  // Shares follow this hour's output; when the origin stage made nothing this hour (e.g. stopped),
  // the tiles now being rejected passed it earlier — charge them to that earlier hour instead.
  let h = hour;
  let counts = machines.map((id) => s.hours[id].get(h)?.count ?? 0);
  for (let back = 1; back <= 6 && counts.every((c) => c <= 0); back++) {
    h = hour - back;
    counts = machines.map((id) => s.hours[id].get(h)?.count ?? 0);
  }
  hour = h;
  const total = counts.reduce((a, b) => a + b, 0);
  machines.forEach((id, i) => {
    const share = total > 0 ? counts[i] / total : 1 / machines.length;
    bucket(s, id, hour).rejects += n * share;
    s.machines[id].countRejectAttributed += n * share;
  });
}

const MEASURE: Record<DefectCategory, (r: Rng) => string> = {
  crack: (r) => `Crack length ≈ ${Math.round(6 + r() * 30)} mm`,
  chip: (r) => `Edge chip ≈ ${(1.5 + r() * 4).toFixed(1)} mm`,
  surface: (r) => `${Math.round(2 + r() * 9)} pinholes / spots in 100 cm²`,
  glaze: (r) => `Glaze weight deviation ${(r() > 0.5 ? '+' : '−')}${(4 + r() * 9).toFixed(1)} %`,
  shade: (r) => `ΔE ${(1.1 + r() * 1.6).toFixed(1)} vs master`,
  planarity: (r) => `Centre deviation ${(r() > 0.4 ? '+' : '−')}${(0.42 + r() * 0.5).toFixed(2)} mm (limit ±0.40)`,
  dimension: (r) => {
    const u = r() - 0.5;
    const dev = Math.sign(u || 1) * (0.7 + Math.abs(u) * 1.0);
    return `Caliber ${(600 + dev).toFixed(1)} mm (600 ± 0.6)`;
  },
};

function pushInspection(s: SimState, t: number, stationId: string, batchIdValue: string, defect: DefectCategory) {
  const r = s.internal.qualityRng;
  const sev = weighted(r(), [
    ['minor', 0.62],
    ['major', 0.32],
    ['critical', 0.06],
  ] as ['minor' | 'major' | 'critical', number][]);
  pushRecord(s, {
    id: nextId(s, 'INS'),
    time: t,
    stationId,
    batchId: batchIdValue,
    result: 'reject',
    defect,
    severity: sev,
    measurement: MEASURE[defect](r),
    tiles: TILES_PER_RECORD,
    ...visionFields(stationId, detection(s.internal.cvRng, defect)),
    source: activeScenarios(s, t).some((sc) => sc.kind === 'quality-deterioration') ? 'scenario' : 'simulation',
  });
}

/** Gauge results are laser measurements: they keep the measured location but carry no classification confidence. */
const visionFields = (stationId: string, d: Pick<QualityInspection, 'confidence' | 'box'>) => (stationId === 'ST-VIS' ? d : { confidence: null, box: d.box });

/** Illustrative defect box (tile coordinates 0–1) and classification confidence for a record. */
function detection(r: Rng, defect: DefectCategory): Pick<QualityInspection, 'confidence' | 'box'> {
  const confidence = Math.round((0.78 + r() * 0.21) * 1000) / 1000;
  const at = (w: number, h: number) => ({ x: 0.06 + r() * (0.88 - w), y: 0.06 + r() * (0.88 - h), w, h });
  const corner = () => {
    const w = 0.1 + r() * 0.06;
    return { x: r() > 0.5 ? 0 : 1 - w, y: r() > 0.5 ? 0 : 1 - w, w, h: w };
  };
  const box =
    defect === 'crack'
      ? at(0.12 + r() * 0.1, 0.35 + r() * 0.3)
      : defect === 'chip'
        ? corner()
        : defect === 'surface'
          ? at(0.1 + r() * 0.08, 0.1 + r() * 0.08)
          : defect === 'glaze'
            ? at(0.25 + r() * 0.2, 0.18 + r() * 0.15)
            : defect === 'shade'
              ? at(0.45 + r() * 0.2, 0.45 + r() * 0.2)
              : defect === 'planarity'
                ? { x: 0.04, y: 0.04, w: 0.92, h: 0.92 }
                : { x: 0, y: 0.3 + r() * 0.3, w: 0.08, h: 0.3 };
  return { confidence, box };
}

function pushRecord(s: SimState, rec: QualityInspection) {
  s.inspections.push(rec);
  if (s.inspections.length > MAX_INSPECTIONS) s.inspections.splice(0, s.inspections.length - MAX_INSPECTIONS);
}

export function batchAt(s: SimState, t: number): ProductionBatch {
  for (let i = s.batches.length - 1; i >= 0; i--) if (s.batches[i].start <= t) return s.batches[i];
  return s.batches[0];
}

// ── Energy alerts ─────────────────────────────────────────────────────────────

/** Flags consumers whose last-hour consumption deviates > 10 % from the energy model. */
function energyAlerts(s: SimState, t: number) {
  const hour = Math.floor((t - 1) / 60);
  for (const c of CONSUMERS) {
    const b = s.energy[c.id]?.get(hour);
    if (!b) continue;
    const exp = b.expElec + b.expThermal;
    const act = b.elec + b.thermal;
    if (exp < 20) continue;
    const dev = act / exp - 1;
    const key = `energy:${c.id}`;
    if (dev > 0.1 && t - (s.internal.alertAt[key] ?? -1e9) > 120) {
      s.internal.alertAt[key] = t;
      const scen = activeScenarios(s, t).some((sc) => sc.kind === 'energy-anomaly' && sc.equipmentId === c.id);
      raiseAlert(s, t, 'serious', `Energy anomaly: ${c.id}`, `${c.label} consumption ${(dev * 100).toFixed(0)} % above the energy model this hour`, { equipmentId: c.id }, scen ? 'scenario' : 'simulation');
    }
  }
}

// ── Alerts ────────────────────────────────────────────────────────────────────

export function raiseAlert(
  s: SimState,
  time: number,
  severity: AlertSeverity,
  title: string,
  detail: string,
  ref: { equipmentId?: string; vehicleId?: string },
  source: Alert['source'],
) {
  s.alerts.push({ id: nextId(s, 'AL'), time, severity, title, detail, ...ref, source });
  if (s.alerts.length > MAX_ALERTS) s.alerts.splice(0, s.alerts.length - MAX_ALERTS);
}

/** Open (unfinished) downtime events. */
export const activeDowntime = (s: SimState) => s.downtime.filter((d) => d.end == null);

/** Scenarios currently in effect. */
export const scenariosActive = (s: SimState) => activeScenarios(s, s.minute);
