/**
 * Unified operational event engine — one record per event for every use case (production,
 * conveyors, OEE, quality, vehicles, energy, data feeds).
 *
 *   detection rule  →  OpEvent (+ frozen evidence)  →  lifecycle  →  impact  →  report / PDF / copilot
 *
 * Rules run inside the deterministic simulation step, so the same seed and scenario log always
 * produce the same events. Each condition has a dedupe key: while it persists the event is updated,
 * never duplicated; if it returns within REOPEN_MIN of clearing, the same event is reopened.
 * A cleared condition auto-resolves only if nobody acknowledged it; acknowledged / investigating
 * events stay open until a user resolves them. Events are never deleted when equipment recovers.
 *
 * Observed facts, inferred causes and estimates are kept apart: `facts` are read from signals and
 * records, `causes` carry a confidence ('confirmed' only when directly observed or a scenario input).
 */
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { DEFECT_ACTIONS, REASON_ACTIONS } from '../model/actions';
import {
  BUFFERS,
  CAMERA_BY_ID,
  CONVEYORS,
  CONVEYOR_BY_ID,
  DEFECTS,
  DEFECT_ORDER,
  DOCKS,
  GEOFENCES,
  INSPECTION_STATIONS,
  LINE,
  M2_PER_TILE,
  MONITORED_STAGES,
  OPS_BY_ID,
  PROCESS_MACHINES,
  REASON_BY_CODE,
  STAGES,
  STAGE_BY_ID,
  cameraFor,
} from '../model/plant';
import type {
  AlertSeverity,
  DefectCategory,
  DowntimeEvent,
  EventAccumulators,
  EventCategory,
  EventCause,
  EventStatus,
  EventTrigger,
  EventType,
  Evidence,
  EvidenceSeries,
  MachineState,
  MonitoredStage,
  MonitoredStageId,
  OpEvent,
  RecordSource,
  StageId,
  Vehicle,
} from '../model/types';
import type { SimState } from './engine';
import { LOG_MIN, minuteAt } from './engine';
import { CONSUMER_BY_ID, CONSUMERS } from './energy';
import { HEALTH_ASSETS, HEALTH_BY_ID, assess, sensorHistory, type HealthLevel } from './health';
import { formatClock, formatDuration } from './time';

// ── Labels ────────────────────────────────────────────────────────────────────

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  'machine-fault': 'Machine fault',
  'machine-stop': 'Unexpected machine stop',
  'conveyor-stop': 'Conveyor stoppage',
  'below-rate': 'Running below expected rate',
  starvation: 'Upstream starvation',
  blockage: 'Downstream blockage',
  'counter-inactive': 'Counter inactivity / data stale',
  'condition-abnormal': 'Abnormal condition signals',
  'io-imbalance': 'Input / output imbalance',
  'defect-rate': 'Reject rate above threshold',
  'defect-count': 'Defect count above threshold',
  'defect-repeat': 'Repeated defect',
  'defect-deterioration': 'Defect deterioration vs baseline',
  'critical-defect': 'Critical defect — review',
  'truck-waiting': 'Truck waiting beyond threshold',
  'dock-overstay': 'Dock occupied too long',
  'yard-congestion': 'Yard congestion',
  'turnaround-exceeded': 'Turnaround above threshold',
  'restricted-entry': 'Restricted-zone entry',
  'energy-deviation': 'Energy deviation from model',
};

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  production: 'Production',
  quality: 'Quality',
  logistics: 'Vehicles & logistics',
  equipment: 'Equipment condition',
  energy: 'Energy',
  data: 'Data quality',
};

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  active: 'Active',
  acknowledged: 'Acknowledged',
  investigating: 'Investigating',
  resolved: 'Resolved',
};

/** Detection rules, for display (Assets & Data, reports). `threshold` names the EventRules field. */
export const EVENT_RULE_DEFS: {
  id: string;
  type: EventType | null;
  category: EventCategory;
  label: string;
  description: string;
  threshold?: keyof SimState['rules'];
  available: boolean;
  unavailableReason?: string;
}[] = [
  { id: 'R-STOP', type: 'machine-fault', category: 'production', label: 'Unexpected stop / fault', description: 'Machine state changes to stopped without a planned-stop or changeover order; the alarm code classifies it as a fault or a stop.', available: true },
  { id: 'R-CONV', type: 'conveyor-stop', category: 'production', label: 'Conveyor stoppage', description: 'Conveyor run state changes to stopped (drive trip, jam, pull-cord).', available: true },
  { id: 'R-RATE', type: 'below-rate', category: 'production', label: 'Running below expected rate', description: 'Average rate over the window below the threshold share of the ideal rate while the machine is neither starved nor blocked.', threshold: 'belowRateFactor', available: true },
  { id: 'R-STARVE', type: 'starvation', category: 'production', label: 'Upstream starvation', description: 'Machine waiting for material for most of the window; the cause is traced upstream (inferred).', threshold: 'starvedMinutes', available: true },
  { id: 'R-BLOCK', type: 'blockage', category: 'production', label: 'Downstream blockage', description: 'Machine unable to discharge for most of the window; the cause is traced downstream (inferred).', threshold: 'starvedMinutes', available: true },
  { id: 'R-COUNTER', type: 'counter-inactive', category: 'data', label: 'Counter inactivity', description: 'Counter has not changed while the last reported state was running — data feed stale.', threshold: 'counterInactiveMinutes', available: true },
  { id: 'R-COND', type: 'condition-abnormal', category: 'equipment', label: 'Abnormal temperature / vibration / current', description: 'Condition-monitoring level (rule-based, simulated signals) at watch or above.', available: true },
  { id: 'R-IO', type: 'io-imbalance', category: 'production', label: 'Input / output imbalance', description: 'Kiln output vs tiles reaching sorting (incl. buffer change) differs by more than the threshold over 60 min.', threshold: 'ioImbalanceMax', available: true },
  { id: 'Q-RATE', type: 'defect-rate', category: 'quality', label: 'Reject rate above threshold', description: 'Rejected ÷ inspected over the last 60 min (gauge + vision).', threshold: 'rejectRateMax', available: true },
  { id: 'Q-COUNT', type: 'defect-count', category: 'quality', label: 'Defect count above threshold', description: 'Rejected tiles of one category in the last 30 min.', threshold: 'defectCount30Max', available: true },
  { id: 'Q-REPEAT', type: 'defect-repeat', category: 'quality', label: 'Repeated defect', description: 'Consecutive reject records of the same category at one station.', threshold: 'defectRepeatRecords', available: true },
  { id: 'Q-DET', type: 'defect-deterioration', category: 'quality', label: 'Deterioration from baseline', description: 'Category rate over the last 2 h vs the 24 h before.', threshold: 'deteriorationRatio', available: true },
  { id: 'Q-CRIT', type: 'critical-defect', category: 'quality', label: 'Critical defect requiring review', description: 'Reject record classified critical; grouped per station within 30 min.', available: true },
  { id: 'L-WAIT', type: 'truck-waiting', category: 'logistics', label: 'Truck waiting beyond threshold', description: 'Time in the holding area waiting for a dock.', threshold: 'truckWaitMax', available: true },
  { id: 'L-DOCK', type: 'dock-overstay', category: 'logistics', label: 'Dock occupied too long', description: 'One truck at the same dock longer than the threshold.', threshold: 'dockStayMax', available: true },
  { id: 'L-YARD', type: 'yard-congestion', category: 'logistics', label: 'Yard congestion', description: 'Trucks waiting for a dock at or above the threshold.', threshold: 'yardQueueMax', available: true },
  { id: 'L-TURN', type: 'turnaround-exceeded', category: 'logistics', label: 'Turnaround above threshold', description: 'Time on site since gate-in.', threshold: 'turnaroundMax', available: true },
  { id: 'L-ZONE', type: 'restricted-entry', category: 'logistics', label: 'Restricted-zone entry', description: 'Internal vehicle position (simulated) inside a restricted geofence.', available: true },
  { id: 'L-PROX', type: null, category: 'logistics', label: 'Vehicle–pedestrian proximity', description: 'Needs proximity sensing (e.g. UWB / RFID tags on people and vehicles).', available: false, unavailableReason: 'No proximity sensing configured' },
  { id: 'L-ROUTE', type: null, category: 'logistics', label: 'Route deviation', description: 'Needs actual vehicle location data (GPS / indoor positioning).', available: false, unavailableReason: 'No tracking integration — positions are simulated' },
  { id: 'E-DEV', type: 'energy-deviation', category: 'energy', label: 'Energy deviation from model', description: 'Consumer energy of the last full hour vs the energy model.', threshold: 'energyDeviationMax', available: true },
];

// ── Internal state ────────────────────────────────────────────────────────────

export type EventInternal = {
  seq: number;
  /** dedupeKey → id of the event whose condition is active. */
  open: Record<string, string>;
  /** dedupeKey → recently cleared event (reopen window). */
  recent: Record<string, { id: string; at: number }>;
  lastDowntimeSeq: number;
  lastInspectionSeq: number;
  lastRestrictedSeq: number;
  /** station → run of consecutive same-category reject records. */
  repeat: Record<string, { defect: DefectCategory | null; ids: string[] }>;
  /** Last time a reject of the key was seen (repeat / critical grouping). */
  lastSeen: Record<string, number>;
  levels: Record<string, HealthLevel>;
  index: Map<string, OpEvent>;
  /** Rule timers: consecutive minutes a condition held (with gap tolerance). */
  run: Record<string, { n: number; gap: number; first: number }>;
  /** Open stop events → their downtime record (recovery check without searching the log). */
  stops: Record<string, DowntimeEvent>;
};

export const createEventInternal = (): EventInternal => ({
  seq: 0,
  open: {},
  recent: {},
  lastDowntimeSeq: 0,
  lastInspectionSeq: 0,
  lastRestrictedSeq: 0,
  repeat: {},
  lastSeen: {},
  levels: {},
  index: new Map(),
  run: {},
  stops: {},
});

/** State code (see STATE_CODE in engine.ts) of an asset at minute t, or -1 when not logged. */
function stateCodeAt(s: SimState, id: string, t: number) {
  const log = s.minuteLog[id];
  const i = t % LOG_MIN;
  return log && t >= 0 && log.t[i] === t ? log.state[i] : -1;
}

/** Updates a held-condition timer; returns the run (consecutive minutes, 1-minute gaps tolerated). */
function tick(I: EventInternal, key: string, held: boolean, t: number) {
  const r = I.run[key];
  if (held) {
    if (!r || r.gap > 1) I.run[key] = { n: 1, gap: 0, first: t };
    else {
      r.n++;
      r.gap = 0;
    }
  } else if (r) {
    r.gap++;
    if (r.gap > 3) delete I.run[key];
  }
  return I.run[key];
}

const REOPEN_MIN = 10;
export const DEMO_USER = 'Demo presenter';
const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };
const seqOf = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1)) || 0;
const clock = formatClock;
const nameOf = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? id;
const STATE_WORD: Record<MachineState, string> = {
  running: 'RUNNING',
  reduced: 'RUNNING (reduced rate)',
  starved: 'STARVED',
  blocked: 'BLOCKED',
  down: 'STOPPED',
  planned: 'PLANNED STOP',
};
const stageOf = (id: string): StageId | undefined => OPS_BY_ID[id]?.stage ?? CONVEYOR_BY_ID[id]?.to ?? undefined;
const zoneOf = (id: string) => OPS_BY_ID[id]?.zone ?? CONVEYOR_BY_ID[id]?.zone;

export const eventById = (s: SimState, id: string): OpEvent | undefined => {
  const I = s.internal.ev;
  const hit = I.index.get(id);
  if (hit) return hit;
  const found = s.events.find((e) => e.id === id);
  if (found) I.index.set(id, found);
  return found;
};
export const evidenceById = (s: SimState, id: string) => s.evidence.find((x) => x.id === id);
export const evidenceOf = (s: SimState, ev: OpEvent): Evidence[] => {
  const ids = new Set(ev.evidence);
  return s.evidence.filter((x) => ids.has(x.id));
};

// ── Creation, update, clearing ────────────────────────────────────────────────

type Spec = {
  key: string;
  category: EventCategory;
  type: EventType;
  severity: AlertSeverity;
  title: string;
  summary: string;
  asset: OpEvent['asset'];
  trigger: EventTrigger;
  facts: string[];
  causes?: EventCause[];
  recommendations: string[];
  refs?: OpEvent['refs'];
  source: RecordSource;
  start?: number;
  consequenceOf?: string;
  /** Called once when a new event is created (capture evidence). */
  capture?: (ev: OpEvent) => void;
};

const emptyAcc = (): EventAccumulators => ({
  minutes: 0,
  assetLostTiles: 0,
  constraintMin: 0,
  constraintLostTiles: 0,
  kilnTypicalRate: 0,
  inspected: 0,
  rejects: 0,
  referenceRejectRate: null,
  waitMin: 0,
});

function raise(s: SimState, t: number, spec: Spec): OpEvent {
  const I = s.internal.ev;
  const openId = I.open[spec.key];
  const open = openId ? eventById(s, openId) : undefined;
  if (open) {
    open.lastUpdate = t;
    return open;
  }
  const recent = I.recent[spec.key];
  if (recent && t - recent.at <= REOPEN_MIN) {
    const ev = eventById(s, recent.id);
    if (ev && ev.resolution?.by !== 'user') {
      ev.end = null;
      ev.lastUpdate = t;
      if (ev.status === 'resolved') {
        ev.status = 'active';
        ev.resolution = null;
      }
      ev.history.push({ t, action: 'reopened', by: 'system', text: `Condition returned at ${clock(t)} — event reopened` });
      I.open[spec.key] = ev.id;
      delete I.recent[spec.key];
      return ev;
    }
  }
  const start = spec.start ?? t;
  const ev: OpEvent = {
    id: `EV-${String(++I.seq).padStart(5, '0')}`,
    category: spec.category,
    type: spec.type,
    severity: spec.severity,
    status: 'active',
    title: spec.title,
    summary: spec.summary,
    start,
    end: null,
    lastUpdate: t,
    asset: spec.asset,
    trigger: spec.trigger,
    facts: spec.facts,
    causes: spec.causes ?? [],
    related: [],
    evidence: [],
    refs: spec.refs ?? {},
    recommendations: spec.recommendations,
    owner: null,
    notes: [],
    resolution: null,
    history: [
      { t: start, action: 'detected', by: 'system', text: `Detected by rule ${spec.trigger.ruleId}: ${spec.trigger.description}` },
    ],
    reports: [],
    dedupeKey: spec.key,
    source: spec.source,
    historical: t < s.liveFrom,
    consequenceOf: spec.consequenceOf,
    acc: emptyAcc(),
  };
  if (ev.consequenceOf) {
    const root = eventById(s, ev.consequenceOf);
    if (root) {
      link(root, ev.id);
      link(ev, root.id);
    }
  }
  s.events.push(ev);
  I.index.set(ev.id, ev);
  I.open[spec.key] = ev.id;
  initAcc(s, ev, t);
  spec.capture?.(ev);
  s.version++;
  return ev;
}

const link = (ev: OpEvent, other: string) => {
  if (!ev.related.includes(other)) ev.related.push(other);
};

function escalate(ev: OpEvent, severity: AlertSeverity, t: number, text: string) {
  if (RANK[severity] <= RANK[ev.severity]) return;
  ev.severity = severity;
  ev.lastUpdate = t;
  ev.history.push({ t, action: 'escalated', by: 'system', text });
}

function clearKey(s: SimState, t: number, key: string, text: string) {
  const I = s.internal.ev;
  const id = I.open[key];
  if (!id) return;
  delete I.open[key];
  const ev = eventById(s, id);
  if (!ev) return;
  ev.end = t;
  ev.lastUpdate = t;
  ev.history.push({ t, action: 'cleared', by: 'system', text });
  if (ev.status === 'active') {
    ev.status = 'resolved';
    const lead = /^[A-Z]{1,3}-|^[A-Z0-9]{2,}\b/.test(text) ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    ev.resolution = { t, by: 'system', reason: `Auto-resolved: ${lead} (not acknowledged)` };
    ev.history.push({ t, action: 'resolved', by: 'system', text: 'Auto-resolved — the condition cleared before anyone acknowledged it' });
  } else {
    ev.history.push({ t, action: 'updated', by: 'system', text: 'Condition cleared — awaiting resolution by the owner' });
  }
  I.recent[key] = { id, at: t };
  refreshOnClear(s, ev, t);
  s.version++;
}

const isOpen = (s: SimState, key: string) => s.internal.ev.open[key] != null;
const openEvent = (s: SimState, key: string) => {
  const id = s.internal.ev.open[key];
  return id ? eventById(s, id) : undefined;
};

// ── Lifecycle actions (user) ──────────────────────────────────────────────────

export type LifecycleResult = { ok: true } | { ok: false; reason: string };

export function canResolve(ev: OpEvent): LifecycleResult {
  if (ev.status === 'resolved') return { ok: false, reason: 'Already resolved' };
  if (ev.end == null) return { ok: false, reason: 'The condition is still active — resolve it after recovery, or acknowledge / investigate now' };
  return { ok: true };
}

export function acknowledgeEvent(s: SimState, id: string, by = DEMO_USER): LifecycleResult {
  const ev = eventById(s, id);
  if (!ev) return { ok: false, reason: 'Event not found' };
  if (ev.status !== 'active') return { ok: false, reason: `Event is ${EVENT_STATUS_LABEL[ev.status].toLowerCase()}` };
  ev.status = 'acknowledged';
  ev.history.push({ t: s.minute, action: 'acknowledged', by: 'user', text: `Acknowledged by ${by}` });
  if (!ev.owner) ev.owner = by;
  s.version++;
  return { ok: true };
}

export function assignEvent(s: SimState, id: string, owner: string, by = DEMO_USER): LifecycleResult {
  const ev = eventById(s, id);
  if (!ev) return { ok: false, reason: 'Event not found' };
  const name = owner.trim();
  if (!name) return { ok: false, reason: 'Enter an owner' };
  ev.owner = name;
  ev.history.push({ t: s.minute, action: 'owner', by: 'user', text: `Owner set to ${name} by ${by}` });
  s.version++;
  return { ok: true };
}

export function investigateEvent(s: SimState, id: string, by = DEMO_USER): LifecycleResult {
  const ev = eventById(s, id);
  if (!ev) return { ok: false, reason: 'Event not found' };
  if (ev.status === 'resolved' || ev.status === 'investigating') return { ok: false, reason: `Event is ${EVENT_STATUS_LABEL[ev.status].toLowerCase()}` };
  if (ev.status === 'active') ev.history.push({ t: s.minute, action: 'acknowledged', by: 'user', text: `Acknowledged by ${by}` });
  ev.status = 'investigating';
  if (!ev.owner) ev.owner = by;
  ev.history.push({ t: s.minute, action: 'investigating', by: 'user', text: `Investigation started by ${by}` });
  s.version++;
  return { ok: true };
}

export function addEventNote(s: SimState, id: string, text: string, by = DEMO_USER): LifecycleResult {
  const ev = eventById(s, id);
  if (!ev) return { ok: false, reason: 'Event not found' };
  const note = text.trim();
  if (!note) return { ok: false, reason: 'Write a note first' };
  ev.notes.push({ t: s.minute, by, text: note });
  ev.history.push({ t: s.minute, action: 'note', by: 'user', text: `Note by ${by}: ${note}` });
  s.version++;
  return { ok: true };
}

export function resolveEvent(s: SimState, id: string, reason: string, action?: string, by = DEMO_USER): LifecycleResult {
  const ev = eventById(s, id);
  if (!ev) return { ok: false, reason: 'Event not found' };
  const can = canResolve(ev);
  if (!can.ok) return can;
  const why = reason.trim();
  if (!why) return { ok: false, reason: 'Give a resolution reason' };
  ev.status = 'resolved';
  ev.resolution = { t: s.minute, by: 'user', reason: why, action: action?.trim() || undefined };
  ev.history.push({ t: s.minute, action: 'resolved', by: 'user', text: `Resolved by ${by}: ${why}${action?.trim() ? ` · action: ${action.trim()}` : ''}` });
  s.version++;
  return { ok: true };
}

/** Logs that a report was exported from this record. */
export function recordReport(s: SimState, id: string, at: string) {
  const ev = eventById(s, id);
  if (!ev) return;
  ev.reports.push({ t: s.minute, at, format: 'pdf' });
  ev.history.push({ t: s.minute, action: 'report', by: 'user', text: 'PDF report exported' });
  s.version++;
}

/** Attaches a rendered image (camera snapshot / annotated frame) to pending evidence. */
export function attachEvidenceImage(
  s: SimState,
  evidenceId: string,
  image: { key: string; width: number; height: number; frameTime: number; annotated?: boolean },
  provenance?: Evidence['provenance'],
) {
  const x = evidenceById(s, evidenceId);
  if (!x) return;
  x.image = image;
  x.status = 'available';
  x.capturedAt = image.frameTime;
  if (provenance) x.provenance = provenance;
  s.version++;
}

export function markEvidenceUnavailable(s: SimState, evidenceId: string, reason: string) {
  const x = evidenceById(s, evidenceId);
  if (!x || x.status === 'available') return;
  x.status = 'unavailable';
  x.unavailableReason = reason;
  s.version++;
}

/** Evidence waiting for the UI to render a twin view or grab a camera frame. */
export const pendingSnapshots = (s: SimState) => s.evidence.filter((x) => x.status === 'pending' && x.kind === 'camera-snapshot');

// ── Evidence capture ──────────────────────────────────────────────────────────

function addEvidence(s: SimState, ev: OpEvent, x: Omit<Evidence, 'id' | 'eventId'>): Evidence {
  const e: Evidence = { ...x, id: `EVD-${String(++s.internal.ev.seq).padStart(5, '0')}`, eventId: ev.id };
  s.evidence.push(e);
  ev.evidence.push(e.id);
  return e;
}

const simProv = (ev: OpEvent, label: string): Evidence['provenance'] => ({
  origin: ev.source === 'scenario' ? 'scenario' : 'simulation',
  sourceId: 'SIM',
  label,
});

/** Per-minute series of an asset's output from the minute log (window clipped to the log). */
function rateSeries(s: SimState, id: string, from: number, to: number): EvidenceSeries {
  const lo = Math.max(from, to - LOG_MIN + 1, 0);
  const t: number[] = [];
  const v: (number | null)[] = [];
  for (let m = lo; m <= to; m++) {
    const x = minuteAt(s, id, m);
    t.push(m);
    v.push(x ? Math.round(x.rate * 60) : null);
  }
  const ideal = OPS_BY_ID[id]?.idealRatePerHour ?? CONVEYOR_BY_ID[id]?.capacityPerHour ?? null;
  return {
    // Conveyors count tiles at a photo-eye; machines report a rate.
    id: CONVEYOR_BY_ID[id] ? `${id}.tile_count` : `${id}.rate`,
    label: `${id} output`,
    unit: 'tiles/h',
    t,
    // Logged per minute (tiles/min), shown as an hourly rate.
    v,
    limit: ideal ? { label: OPS_BY_ID[id]?.idealRatePerHour ? 'Ideal rate' : 'Capacity', value: ideal } : undefined,
  };
}

function captureStateTransition(s: SimState, ev: OpEvent, id: string, t: number) {
  const transitions: { t: number; from: string; to: string; note?: string }[] = [];
  let prev: MachineState | null = null;
  for (let m = Math.max(0, t - 30); m <= t; m++) {
    const x = minuteAt(s, id, m);
    if (!x) continue;
    if (prev && x.state !== prev) transitions.push({ t: m, from: STATE_WORD[prev], to: STATE_WORD[x.state] });
    prev = x.state;
  }
  addEvidence(s, ev, {
    kind: 'state-transition',
    title: `${id} state signal (${CONVEYOR_BY_ID[id] ? 'run_state' : 'state'})`,
    capturedAt: t,
    provenance: simProv(ev, 'Simulated PLC state signal'),
    status: transitions.length ? 'available' : 'unavailable',
    unavailableReason: transitions.length ? undefined : 'No state change recorded in the 30 min before detection',
    transitions,
  });
}

function captureCounter(s: SimState, ev: OpEvent, id: string, t: number) {
  const series = rateSeries(s, id, ev.start - 30, t);
  addEvidence(s, ev, {
    kind: 'counter-series',
    title: `${id} output rate (from ${CONVEYOR_BY_ID[id] ? 'tile_count' : 'count_total'})`,
    capturedAt: t,
    provenance: simProv(ev, 'Simulated counter, per minute'),
    status: 'available',
    series: [series],
  });
}

function captureSignals(s: SimState, ev: OpEvent, id: string, t: number, minutes = 60, step = 1) {
  const a = HEALTH_BY_ID[id];
  if (!a) return;
  const hist = sensorHistory(s, id, minutes, step);
  addEvidence(s, ev, {
    kind: 'signal-series',
    title: `${id} condition signals (vibration, temperature, motor current)`,
    capturedAt: t,
    provenance: simProv(ev, 'Simulated condition-monitoring sensors'),
    status: hist.length ? 'available' : 'unavailable',
    unavailableReason: hist.length ? undefined : 'No samples in the window',
    series: [
      { id: `${id}.vibration`, label: 'Vibration', unit: 'mm/s RMS', t: hist.map((r) => r.t), v: hist.map((r) => Math.round(r.vibration * 100) / 100), limit: { label: 'Alarm', value: a.vib.alarm } },
      { id: `${id}.temperature`, label: 'Temperature', unit: '°C', t: hist.map((r) => r.t), v: hist.map((r) => Math.round(r.temperature * 10) / 10), limit: { label: 'Alarm', value: a.temp.alarm } },
      { id: `${id}.motor_current`, label: 'Motor current', unit: 'A', t: hist.map((r) => r.t), v: hist.map((r) => Math.round(r.current * 10) / 10), limit: { label: 'Rated', value: a.currentRated } },
    ],
  });
}

/** Camera snapshot evidence: pending for the UI to render (live session only), or why it cannot exist. */
function captureCamera(s: SimState, ev: OpEvent, coverId: string | undefined, t: number) {
  const cam = cameraFor(coverId);
  if (!cam) {
    addEvidence(s, ev, {
      kind: 'camera-snapshot',
      title: 'Camera snapshot',
      capturedAt: t,
      provenance: { origin: 'simulation', sourceId: 'none', label: 'No camera' },
      status: 'unavailable',
      unavailableReason: `No camera position covers ${coverId ?? 'this asset'}`,
    });
    return;
  }
  addEvidence(s, ev, {
    kind: 'camera-snapshot',
    title: `${cam.id} · ${cam.name}`,
    capturedAt: t,
    cameraId: cam.id,
    provenance: { origin: 'digital-twin-render', sourceId: cam.id, label: 'Rendered from the digital twin (simulated camera view)' },
    status: ev.historical ? 'unavailable' : 'pending',
    unavailableReason: ev.historical ? 'Occurred before this demo session — no view was rendered at the time' : undefined,
  });
}

function captureMetrics(s: SimState, ev: OpEvent, title: string, metrics: { label: string; value: number | string; unit?: string }[], t: number) {
  addEvidence(s, ev, { kind: 'metrics', title, capturedAt: t, provenance: simProv(ev, 'Simulated operational records'), status: 'available', metrics });
}

/** Buffer context around a stage at detection. */
function bufferContext(s: SimState, stage: StageId | undefined) {
  if (!stage) return [];
  const i = STAGES.findIndex((x) => x.id === stage);
  const out: { label: string; value: number | string; unit?: string }[] = [];
  const inBuf = STAGES[i]?.inputBuffer;
  const outBuf = STAGES[i + 1]?.inputBuffer;
  const lvl = (id: string | null | undefined, label: string) => {
    if (!id) return;
    const capacity = s.buffers[id] != null ? capOf(id) : 0;
    if (!capacity) return;
    out.push({ label: `${label} (${id})`, value: Math.round((s.buffers[id] / capacity) * 100), unit: '% full' });
  };
  lvl(inBuf, 'Input buffer');
  lvl(outBuf, 'Output buffer');
  return out;
}
const BUFFER_CAPS: Record<string, number> = Object.fromEntries(BUFFERS.map((b) => [b.id, b.capacity]));
const capOf = (bufferId: string) => BUFFER_CAPS[bufferId] ?? 0;

function refreshOnClear(s: SimState, ev: OpEvent, t: number) {
  // Extend the frozen output series to the recovery so the report shows the whole episode.
  for (const x of evidenceOf(s, ev)) {
    if (x.kind === 'counter-series' && x.series?.[0]) {
      const id = x.series[0].id.replace(/\.(rate|tile_count)$/, '');
      x.series = [rateSeries(s, id, ev.start - 30, t)];
      x.capturedAt = t;
    }
  }
}

// ── Accumulated impact ────────────────────────────────────────────────────────

const HELD: MachineState[] = ['down', 'starved', 'blocked'];

function initAcc(s: SimState, ev: OpEvent, t: number) {
  // Kiln typical rate: its average output over the last hour while running (fallback 94 % of ideal).
  let sum = 0;
  let n = 0;
  for (let m = t - 60; m < t; m++) {
    const x = minuteAt(s, 'H-KILN', m);
    if (x && (x.state === 'running' || x.state === 'reduced')) {
      sum += x.rate;
      n++;
    }
  }
  const ideal = OPS_BY_ID['H-KILN'].idealRatePerHour! / 60;
  ev.acc.kilnTypicalRate = n >= 10 ? sum / n : ideal * 0.94;
  if (ev.category === 'quality') ev.acc.referenceRejectRate = referenceRejectRate(s, t);
}

/** Per-minute accumulation for every event whose condition is active. */
function accumulate(s: SimState, t: number) {
  const kiln = minuteAt(s, 'H-KILN', t);
  const kilnHeld = kiln != null && HELD.includes(kiln.state);
  // Which active event explains the kiln being held this minute (its own stop, or the root of its starvation/blockage)?
  let kilnOwner: OpEvent | undefined;
  if (kilnHeld) {
    kilnOwner = openEvent(s, 'stop:H-KILN') ?? openEvent(s, 'starved:H-KILN') ?? openEvent(s, 'blocked:H-KILN');
  }
  const owners = new Set<OpEvent>();
  if (kilnOwner) {
    owners.add(kilnOwner);
    if (kilnOwner.consequenceOf) {
      const root = eventById(s, kilnOwner.consequenceOf);
      if (root && root.end == null) owners.add(root);
    }
  }
  const q = qualityMinute(s, t);
  for (const id of Object.values(s.internal.ev.open)) {
    const ev = eventById(s, id);
    if (!ev) continue;
    ev.acc.minutes++;
    const asset = ev.asset.equipmentId;
    if (asset && ev.category === 'production') {
      const x = minuteAt(s, asset, t);
      const ideal = OPS_BY_ID[asset]?.idealRatePerHour;
      // Conveyors: tiles not transported vs the line's typical flow (the kiln's typical rate).
      const typical = ideal ? (ideal / 60) * 0.945 : CONVEYOR_BY_ID[asset] ? ev.acc.kilnTypicalRate : 0;
      if (x && typical) ev.acc.assetLostTiles += Math.max(0, typical - x.rate);
    }
    if (owners.has(ev) && kiln) {
      ev.acc.constraintMin++;
      ev.acc.constraintLostTiles += Math.max(0, ev.acc.kilnTypicalRate - kiln.rate);
    }
    if (ev.category === 'quality' && q) {
      const relevant = ev.refs.defect ? (q.byDefect[ev.refs.defect] ?? 0) : q.rejected;
      ev.acc.inspected += q.inspected;
      ev.acc.rejects += relevant;
    }
    if (ev.type === 'truck-waiting' || ev.type === 'dock-overstay' || ev.type === 'turnaround-exceeded') ev.acc.waitMin++;
  }
}

// ── Quality minute log helpers ────────────────────────────────────────────────

function qualityMinute(s: SimState, t: number) {
  const L = s.qualityLog;
  const i = t % LOG_MIN;
  if (L.t[i] !== t) return null;
  const byDefect: Partial<Record<DefectCategory, number>> = {};
  for (const d of DEFECT_ORDER) byDefect[d] = L.defect[d][i];
  return { inspected: L.inspected[i], rejected: L.rejected[i], byDefect };
}

/** Inspected / rejected (optionally one category) over [t - minutes + 1, t] from the minute log. */
export function qualityWindow(s: SimState, t: number, minutes: number, defect?: DefectCategory) {
  const L = s.qualityLog;
  const arr = defect ? L.defect[defect] : L.rejected;
  let inspected = 0;
  let rejected = 0;
  for (let m = Math.max(0, t - minutes + 1, t - LOG_MIN + 1); m <= t; m++) {
    const i = m % LOG_MIN;
    if (L.t[i] !== m) continue;
    inspected += L.inspected[i];
    rejected += arr[i];
  }
  return { inspected, rejected, rate: inspected > 0 ? rejected / inspected : null };
}

function referenceRejectRate(s: SimState, t: number, defect?: DefectCategory) {
  // 24 h before the last 2 h, from the hourly station buckets.
  const h1 = Math.floor((t - 120) / 60);
  let inspected = 0;
  let rejected = 0;
  for (let h = h1 - 24; h < h1; h++) {
    const q = s.quality.get(h);
    if (!q) continue;
    inspected += q['ST-VIS'].inspected;
    if (defect) {
      const st = q[DEFECTS[defect].station];
      rejected += st.byDefect[defect] ?? 0;
    } else rejected += q['ST-VIS'].rejected + q['ST-GAUGE'].rejected;
  }
  return inspected > 0 ? rejected / inspected : null;
}

// ── Rules ─────────────────────────────────────────────────────────────────────

export function stepEvents(s: SimState, t: number) {
  stopRules(s, t);
  rateRules(s, t);
  flowRules(s, t);
  feedRules(s, t);
  if (t % 10 === 0) conditionRules(s, t);
  if (t % 5 === 0) qualityRules(s, t);
  inspectionRecordRules(s, t);
  logisticsRules(s, t);
  if (t % 15 === 0) energyRules(s, t);
  if (t % 30 === 0) ioRule(s, t);
  accumulate(s, t);
}

/** Unexpected stops and faults of machines and conveyors, from the downtime records. */
function stopRules(s: SimState, t: number) {
  const I = s.internal.ev;
  // New downtime records since the last minute (records are appended in id order).
  const fresh: DowntimeEvent[] = [];
  for (let i = s.downtime.length - 1; i >= 0; i--) {
    const d = s.downtime[i];
    if (seqOf(d.id) <= I.lastDowntimeSeq) break;
    fresh.push(d);
  }
  if (fresh.length) I.lastDowntimeSeq = seqOf(fresh[0].id);
  for (const d of fresh.reverse()) {
    const reason = REASON_BY_CODE[d.reasonCode];
    if (!reason || reason.planned || d.category === 'Starved' || d.category === 'Blocked' || d.reasonCode === 'CHG_PRODUCT') continue;
    if (d.end != null && d.end <= d.start) continue;
    openStopEvent(s, t, d);
  }
  // Recovery.
  for (const [key, d] of Object.entries(I.stops)) {
    if (d.end == null) continue;
    delete I.stops[key];
    const ev = openEvent(s, key);
    if (!ev) continue;
    const dur = d.end - d.start;
    ev.facts.push(`Recovered at ${clock(d.end)}: state back to RUNNING after ${formatDuration(dur)} (final downtime ${formatDuration(dur)}).`);
    clearKey(s, d.end, key, `${d.equipmentId} back in operation at ${clock(d.end)} after ${formatDuration(dur)}`);
  }
}

function openStopEvent(s: SimState, t: number, d: DowntimeEvent) {
  const id = d.equipmentId;
  const conv = CONVEYOR_BY_ID[id];
  const reason = REASON_BY_CODE[d.reasonCode];
  const isFault = !conv && (reason.category === 'Mechanical' || reason.category === 'Electrical & control') && d.reasonCode !== 'SCN_STOP';
  const type: EventType = conv ? 'conveyor-stop' : isFault ? 'machine-fault' : 'machine-stop';
  const stage = stageOf(id);
  const severity: AlertSeverity = conv
    ? ['CV-KIN', 'CV-SORT', 'CV-GLZ'].includes(id)
      ? 'serious'
      : 'warning'
    : id === LINE.designConstraint || id === 'H-KILN'
      ? 'critical'
      : stage === 'PRESS' || stage === 'GLAZE' || stage === 'DECOR'
        ? 'serious'
        : 'warning';
  const prev = minuteAt(s, id, d.start - 1);
  const signalId = conv ? `${id}.run_state` : `${id}.state`;
  const facts = [
    `${signalId} changed ${prev ? STATE_WORD[prev.state] : 'RUNNING'} → STOPPED at ${clock(d.start)}.`,
    d.source === 'scenario'
      ? `Stop injected by a simulation scenario (${reason.label}).`
      : `${conv ? 'Conveyor' : 'Machine'} alarm reported: ${reason.label} (code ${d.reasonCode}).`,
    `No planned stop or changeover was scheduled for ${id} at this time.`,
  ];
  if (conv) {
    const into = conv.blocksInputOf.map((x) => STAGE_BY_ID[x].name.toLowerCase());
    const outOf = conv.blocksOutputOf.map((x) => STAGE_BY_ID[x].name.toLowerCase());
    if (into.length) facts.push(`While it is stopped, ${into.join(' and ')} receive${into.length > 1 ? '' : 's'} no tiles.`);
    if (outOf.length) {
      const who = outOf.join(' and ');
      facts.push(`${who.charAt(0).toUpperCase()}${who.slice(1)} cannot discharge onto it.`);
    }
  }
  const causes: EventCause[] = [
    d.source === 'scenario'
      ? { text: 'Scenario input: simulated stop', confidence: 'confirmed', basis: 'Scenario log' }
      : { text: `${reason.label}`, confidence: 'likely', basis: `Alarm code ${d.reasonCode} reported with the stop (simulated); not yet confirmed by maintenance` },
  ];
  // A developing fault detected earlier on the same asset.
  const cond = s.internal.ev.open[`cond:${id}`] ?? s.internal.ev.recent[`cond:${id}`]?.id;
  const condEv = cond ? eventById(s, cond) : undefined;
  if (condEv) causes.push({ text: `Developing ${HEALTH_BY_ID[id]?.component ?? 'component'} fault flagged by condition monitoring since ${clock(condEv.start)}`, confidence: 'likely', basis: 'Rising vibration / temperature before the stop (rule-based, simulated signals)', relatedEventId: condEv.id });
  const name = nameOf(id);
  const ev = raise(s, t, {
    key: `stop:${id}`,
    category: 'production',
    type,
    severity,
    title: conv ? `${name} stopped` : isFault ? `${name} fault: ${reason.label.toLowerCase()}` : `${name} stopped`,
    summary: `${id} stopped at ${clock(d.start)} (${reason.label}).${conv ? ' Tiles stop moving at this transfer.' : ''}`,
    asset: { equipmentId: id, stage, zone: zoneOf(id) },
    trigger: {
      kind: d.source === 'scenario' ? 'scenario' : 'signal',
      ruleId: conv ? 'R-CONV' : 'R-STOP',
      description: conv ? 'Conveyor run state = STOPPED' : 'Machine state = STOPPED with no planned stop or changeover order',
      signalId,
      observed: [
        { label: 'State', value: 'STOPPED' },
        { label: 'Alarm / reason code', value: d.reasonCode },
      ],
    },
    facts,
    causes,
    recommendations: [REASON_ACTIONS[d.reasonCode] ?? REASON_ACTIONS.SCN_STOP, conv ? 'Watch the downstream accumulation buffer and the kiln infeed while the conveyor is stopped.' : 'Check the downstream buffer cover; restart in sequence and confirm the first tiles are good.'],
    refs: { downtimeId: d.id, scenarioId: d.scenarioId },
    source: d.source,
    start: d.start,
    capture: (e) => {
      captureStateTransition(s, e, id, t);
      captureCounter(s, e, id, t);
      captureSignals(s, e, id, t, 60, 1);
      captureCamera(s, e, id, t);
      captureMetrics(s, e, 'Line context at detection', [...bufferContext(s, stage), { label: 'Kiln state', value: STATE_WORD[s.machines['H-KILN'].state] }], t);
    },
  });
  if (condEv) {
    link(ev, condEv.id);
    link(condEv, ev.id);
  }
  if (ev.end == null) {
    ev.refs.downtimeId = d.id;
    s.internal.ev.stops[`stop:${id}`] = d;
  }
}

/** Machines running clearly below their expected rate at their own pace (not held up by neighbours). */
function rateRules(s: SimState, t: number) {
  const R = s.rules;
  const I = s.internal.ev;
  const n = Math.max(3, Math.round(R.belowRateMinutes));
  for (const id of PROCESS_MACHINES) {
    const key = `rate:${id}`;
    const ideal = OPS_BY_ID[id].idealRatePerHour! / 60;
    const x = minuteAt(s, id, t);
    const own = x != null && (x.state === 'running' || x.state === 'reduced') && !x.limited;
    const slow = own && x!.rate < ideal * R.belowRateFactor;
    const run = tick(I, `slow:${id}`, slow, t);
    const open = isOpen(s, key);
    if (!open && run && run.n >= n) {
      let sum = 0;
      let k = 0;
      for (let m = t - n + 1; m <= t; m++) {
        const y = minuteAt(s, id, m);
        if (y && !y.limited && (y.state === 'running' || y.state === 'reduced')) {
          sum += y.rate;
          k++;
        }
      }
      const avg = k ? sum / k : x!.rate;
      const scen = s.scenarios.find(
        (sc) =>
          sc.start <= t &&
          (sc.end == null || sc.end > t) &&
          ((sc.kind === 'reduced-rate' && sc.equipmentId === id) || (sc.kind === 'bottleneck' && sc.stage === OPS_BY_ID[id].stage)),
      );
      const share = avg / ideal;
      raise(s, t, {
        key,
        category: 'production',
        type: 'below-rate',
        severity: OPS_BY_ID[id].stage === LINE.designConstraint ? 'serious' : 'warning',
        title: `${nameOf(id)} running at ${Math.round(share * 100)} % of ideal rate`,
        summary: `${id} has averaged ${Math.round(avg * 60)} tiles/h over ${n} min against an ideal ${Math.round(ideal * 60)} tiles/h, at its own pace (not starved or blocked).`,
        asset: { equipmentId: id, stage: OPS_BY_ID[id].stage ?? undefined, zone: OPS_BY_ID[id].zone },
        trigger: {
          kind: scen ? 'scenario' : 'rule',
          ruleId: 'R-RATE',
          description: `Rate < ${Math.round(R.belowRateFactor * 100)} % of ideal for ${n} min while running at its own pace`,
          signalId: `${id}.rate`,
          observed: [
            { label: 'Average rate', value: Math.round(avg * 60), unit: 'tiles/h' },
            { label: 'Share of ideal', value: `${Math.round(share * 100)} %` },
          ],
          threshold: { label: 'Threshold', value: `${Math.round(R.belowRateFactor * 100)} % of ${Math.round(ideal * 60)} tiles/h` },
        },
        facts: [
          `${id}.rate averaged ${Math.round(avg * 60)} tiles/h from ${clock(run.first)} to ${clock(t)} (${Math.round(share * 100)} % of ideal).`,
          'The machine was RUNNING and neither waiting for input nor unable to discharge.',
        ],
        causes: scen
          ? [{ text: `Rate reduction applied by a scenario (${scen.label})`, confidence: 'confirmed', basis: 'Scenario log' }]
          : [
              { text: 'Speed setpoint lowered or frequent micro-stops', confidence: 'possible', basis: 'Typical causes of sustained speed loss; not distinguishable from the rate signal alone' },
              { text: 'Process adjustment (material or recipe)', confidence: 'possible', basis: 'Requires process data or an operator note to confirm' },
            ],
        recommendations: [
          'Check the speed setpoint against the recipe and look for repeated short stops in the machine alarm log.',
          OPS_BY_ID[id].stage === LINE.designConstraint
            ? 'This is the line constraint — every lost minute is lost output.'
            : 'Check whether the downstream buffer still covers the kiln; if it drains, the speed loss becomes line output loss.',
        ],
        refs: { scenarioId: scen?.id },
        source: scen ? 'scenario' : 'simulation',
        start: run.first,
        capture: (e) => {
          captureCounter(s, e, id, t);
          captureCamera(s, e, id, t);
        },
      });
    } else if (open) {
      const x5 = [0, 1, 2, 3, 4].map((k) => minuteAt(s, id, t - k));
      const recovered = x5.every((y) => y && (y.state === 'running' || y.state === 'reduced') && (y.limited || y.rate >= ideal * 0.92));
      const stopped = x != null && (x.state === 'down' || x.state === 'planned');
      if (recovered) clearKey(s, t, key, `${id} back above 92 % of ideal rate`);
      else if (stopped) clearKey(s, t, key, `${id} stopped — tracked by its stop event`);
    }
  }
}

/**
 * Starvation and blockage per stage (one event for the presses, not three). Stages next to the kiln
 * carry spare capacity, so waiting on a full or empty buffer is normal line balancing: an event is
 * raised only for the line constraint, or when a stopped / slowed neighbour explains it (inferred).
 */
function flowRules(s: SimState, t: number) {
  const R = s.rules;
  const I = s.internal.ev;
  for (const st of STAGES) {
    const id = st.machines[0];
    const isConstraint = st.id === LINE.designConstraint;
    // State codes this minute of the stage's machines that are not themselves stopped.
    let up = 0;
    let starved = 0;
    let blocked = 0;
    for (const mid of st.machines) {
      const code = stateCodeAt(s, mid, t);
      if (code < 0 || code === 4 || code === 5) continue;
      up++;
      if (code === 2) starved++;
      else if (code === 3) blocked++;
    }
    for (const kind of ['starved', 'blocked'] as const) {
      const key = `${kind}:${id}`;
      const n = Math.max(3, Math.round(isConstraint ? R.starvedMinutesConstraint : R.starvedMinutes));
      const heldNow = up > 0 && (kind === 'starved' ? starved : blocked) === up;
      const run = tick(I, key, heldNow, t);
      const open = isOpen(s, key);
      if (!open && heldNow && run && run.n >= n) {
        const root = traceCause(s, id, kind, t);
        if (!isConstraint && !root.rootEventId) continue;
        // A stage that was already held up before the root event began is ordinary line balancing
        // (upstream surplus waiting on a full buffer), not a consequence of it.
        const rootEv = root.rootEventId ? eventById(s, root.rootEventId) : undefined;
        if (!isConstraint && rootEv && run.first < rootEv.start) continue;
        const who = st.machines.length > 1 ? `${st.name} (${st.machines.join(', ')})` : nameOf(id);
        raise(s, t, {
          key,
          category: 'production',
          type: kind === 'starved' ? 'starvation' : 'blockage',
          // Knock-on effects on other stages are informational: their root event carries the alarm.
          severity: isConstraint ? 'serious' : rootEv ? 'info' : 'warning',
          title: `${who} ${kind === 'starved' ? 'starved of material' : 'blocked — cannot discharge'}`,
          summary: `${st.name} has been ${kind} since ${clock(run.first)}.${isConstraint ? ' This is the line constraint: line output is being lost.' : ''} ${root.summary}`,
          asset: { equipmentId: id, stage: st.id, zone: st.zone },
          trigger: {
            kind: 'rule',
            ruleId: kind === 'starved' ? 'R-STARVE' : 'R-BLOCK',
            description: `${kind === 'starved' ? 'Waiting for input' : 'Unable to discharge'} for ${n} min`,
            signalId: `${id}.state`,
            observed: [
              { label: 'State', value: kind.toUpperCase() },
              { label: `Minutes ${kind}`, value: run.n },
            ],
            threshold: { label: 'Window', value: n, unit: 'min' },
          },
          facts: [
            `${st.machines.map((m) => `${m}.state`).join(', ')} = ${kind.toUpperCase()} since ${clock(run.first)} (${run.n} min).`,
            `${kind === 'starved' ? 'Input' : 'Output'} buffer: ${root.bufferText}.`,
            'The stage itself reports no fault.',
          ],
          causes: root.causes,
          recommendations: root.recommendations,
          source: root.source,
          start: run.first,
          consequenceOf: root.rootEventId,
          capture: (e) => {
            captureCounter(s, e, id, t);
            captureMetrics(s, e, 'Flow context at detection', bufferContext(s, st.id), t);
          },
        });
      } else if (open && !run) clearKey(s, t, key, `${st.name} no longer ${kind}`);
    }
  }
}

/** Walks up (starved) or down (blocked) the line to find what is holding the machine up. */
function traceCause(s: SimState, id: string, kind: 'starved' | 'blocked', t: number) {
  void t;
  const stage = OPS_BY_ID[id].stage!;
  const idx = STAGES.findIndex((x) => x.id === stage);
  const dir = kind === 'starved' ? -1 : 1;
  const bufId = kind === 'starved' ? STAGES[idx].inputBuffer : STAGES[idx + 1]?.inputBuffer;
  const lvl = bufId && capOf(bufId) ? Math.round((s.buffers[bufId] / capOf(bufId)) * 100) : null;
  const bufferText = bufId ? `${bufId} at ${lvl} %` : 'no buffer';
  // Stopped conveyors on the way in / out of this stage first.
  const convs = CONVEYORS.filter((c) => (kind === 'starved' ? c.blocksInputOf.includes(stage) : c.blocksOutputOf.includes(stage)));
  const stops: { assetId: string; evId?: string }[] = [];
  for (const c of convs) if (s.machines[c.id].activeDowntimeId) stops.push({ assetId: c.id, evId: s.internal.ev.open[`stop:${c.id}`] });
  // Then neighbouring stages in the direction of the flow.
  for (let i = idx + dir; !stops.length && i >= 0 && i < STAGES.length; i += dir) {
    const st = STAGES[i];
    for (const mid of st.machines) {
      const m = s.machines[mid];
      if (m.state === 'down') stops.push({ assetId: mid, evId: s.internal.ev.open[`stop:${mid}`] });
      else if (s.internal.ev.open[`rate:${mid}`]) stops.push({ assetId: mid, evId: s.internal.ev.open[`rate:${mid}`] });
    }
    for (const c of CONVEYORS) if ((kind === 'starved' ? c.blocksInputOf.includes(st.id) : c.blocksOutputOf.includes(st.id)) && s.machines[c.id].activeDowntimeId) stops.push({ assetId: c.id, evId: s.internal.ev.open[`stop:${c.id}`] });
    if (stops.length) break;
    // Keep walking only while that stage is itself held up the same way.
    if (!st.machines.some((mid) => s.machines[mid].state === kind)) break;
  }
  if (stops.length) {
    const top = stops[0];
    const rootEv = top.evId ? eventById(s, top.evId) : undefined;
    const what = s.machines[top.assetId].state === 'down' ? 'stopped' : 'running below rate';
    return {
      summary: `Likely cause: ${top.assetId} ${what}${rootEv ? ` (${rootEv.id})` : ''}.`,
      bufferText,
      causes: [
        {
          text: `${nameOf(top.assetId)} (${top.assetId}) ${what} ${kind === 'starved' ? 'upstream' : 'downstream'}`,
          confidence: 'likely' as const,
          basis: `It is the first held-up asset ${kind === 'starved' ? 'upstream' : 'downstream'} and the buffer between them is ${kind === 'starved' ? 'empty' : 'full'} (inferred from states and buffer levels)`,
          relatedEventId: rootEv?.id,
        },
      ],
      recommendations: [`Restore ${top.assetId} first — see ${rootEv ? rootEv.id : 'its stop event'}.`, kind === 'starved' ? 'Keep upstream buffers full ahead of the constraint.' : 'Clear the downstream blockage before it reaches the kiln.'],
      rootEventId: rootEv?.id,
      source: (rootEv?.source ?? 'simulation') as RecordSource,
    };
  }
  return {
    summary: 'No stopped asset was found in that direction.',
    bufferText,
    causes: [
      {
        text: `${kind === 'starved' ? 'Upstream supply' : 'Downstream take-away'} slower than this stage over the window`,
        confidence: 'possible' as const,
        basis: 'No stopped or slowed asset found; the imbalance may come from short stops or speed losses',
      },
    ],
    recommendations: [`Review ${kind === 'starved' ? 'upstream' : 'downstream'} stage rates and short stops for the window.`],
    rootEventId: undefined,
    source: 'simulation' as RecordSource,
  };
}

/** Counter inactivity: a data feed stopped updating while the asset was reported running. */
function feedRules(s: SimState, t: number) {
  const R = s.rules;
  let any = false;
  for (const id in s.feeds) if (s.feeds[id].status !== 'ok' || s.internal.ev.open[`feed:${id}`]) any = true;
  if (!any) return;
  for (const [id, f] of Object.entries(s.feeds)) {
    const key = `feed:${id}`;
    if (f.status === 'stale' && t - f.since >= R.counterInactiveMinutes && !isOpen(s, key)) {
      const counter = CONVEYOR_BY_ID[id] ? `${id}.tile_count` : `${id}.count_total`;
      raise(s, t, {
        key,
        category: 'data',
        type: 'counter-inactive',
        severity: 'warning',
        title: `${nameOf(id)}: counter not updating (data stale)`,
        summary: `${counter} has not changed for ${t - f.since} min while the last reported state was ${STATE_WORD[f.lastState ?? 'running']}. The asset's status is unknown until data resumes.`,
        asset: { equipmentId: id, stage: stageOf(id), zone: zoneOf(id) },
        trigger: {
          kind: f.scenarioId ? 'scenario' : 'rule',
          ruleId: 'R-COUNTER',
          description: `No counter change for ≥ ${R.counterInactiveMinutes} min while last state = running`,
          signalId: counter,
          observed: [{ label: 'Last update', value: clock(f.since) }, { label: 'Last state', value: STATE_WORD[f.lastState ?? 'running'] }],
          threshold: { label: 'Inactivity', value: R.counterInactiveMinutes, unit: 'min' },
        },
        facts: [`No signal from ${id} has updated since ${clock(f.since)} — counter, state and rate are all frozen.`, 'Line output is still counted independently at sorting (I-SORT), so line KPIs remain valid.'],
        causes: f.scenarioId
          ? [{ text: 'Simulated PLC / gateway communication loss (scenario input)', confidence: 'confirmed', basis: 'Scenario log' }]
          : [
              { text: 'PLC or gateway communication loss', confidence: 'likely', basis: 'All signals of the asset stopped updating together' },
              { text: 'Counter sensor fault', confidence: 'possible', basis: 'Would freeze the counter only; check whether the state signal also froze' },
            ],
        recommendations: ['Check the PLC / gateway link for this asset (network, power, tag server).', 'Confirm on the floor whether the machine is actually running; until data resumes, treat its status as unknown.'],
        refs: { scenarioId: f.scenarioId },
        source: f.scenarioId ? 'scenario' : 'simulation',
        start: f.since,
        capture: (e) => captureCamera(s, e, id, t),
      });
    } else if (f.status === 'ok' && isOpen(s, key)) {
      clearKey(s, t, key, `Data from ${id} resumed at ${clock(t)}`);
    }
  }
}

/** Condition-monitoring levels (rule-based on simulated signals), every 10 minutes. */
function conditionRules(s: SimState, t: number) {
  if (t <= 0) return;
  const sevOf: Record<HealthLevel, AlertSeverity> = { normal: 'info', offline: 'info', watch: 'info', warning: 'warning', alarm: 'serious' };
  for (const a of HEALTH_ASSETS) {
    const lvl = s.health.level[a.id] ?? 'normal';
    const prev = s.internal.ev.levels[a.id] ?? 'normal';
    s.internal.ev.levels[a.id] = lvl;
    const key = `cond:${a.id}`;
    const abnormal = lvl === 'watch' || lvl === 'warning' || lvl === 'alarm';
    if (abnormal && !isOpen(s, key) && s.machines[a.id] && s.machines[a.id].state !== 'down' && s.machines[a.id].state !== 'planned') {
      const h = assess(s, a.id);
      // Readings must come from a running asset (a stopped machine reads near zero vibration).
      if (!h.reading.running) continue;
      // Only the scenario log is used here — the hidden degradation state is never read.
      const scen = s.scenarios.find((sc) => sc.kind === 'degradation' && sc.equipmentId === a.id && sc.start <= t && (sc.end == null || sc.end > t))?.id;
      raise(s, t, {
        key,
        category: 'equipment',
        type: 'condition-abnormal',
        severity: sevOf[lvl],
        title: `${nameOf(a.id)}: ${a.component} — condition ${lvl}`,
        summary: `${h.findings[0] ?? 'Abnormal condition pattern'}${h.etaTripH != null ? ` Projected to reach the trip limit in ≈ ${h.etaTripH.toFixed(1)} h if the trend continues.` : ''}`,
        asset: { equipmentId: a.id, stage: OPS_BY_ID[a.id]?.stage ?? undefined, zone: OPS_BY_ID[a.id]?.zone },
        trigger: {
          kind: 'rule',
          ruleId: 'R-COND',
          description: 'Observed vibration vs expected-at-load, 3-h trend to alarm/trip limits, load-corrected temperature (rule-based, simulated signals)',
          signalId: `${a.id}.vibration`,
          observed: [
            { label: 'Vibration', value: Math.round(h.reading.vibration * 10) / 10, unit: 'mm/s' },
            { label: 'Expected at load', value: Math.round(h.expectedVibration * 10) / 10, unit: 'mm/s' },
            { label: 'Health score', value: h.score, unit: '/100' },
          ],
          threshold: { label: 'Alarm limit', value: a.vib.alarm, unit: 'mm/s' },
        },
        facts: h.findings,
        causes: [
          { text: `${a.component} wear or damage`, confidence: 'possible', basis: 'Vibration rising above the load-corrected expectation is typical of bearing / gear wear; only an inspection can confirm' },
          ...(scen ? [{ text: 'Developing fault injected by a scenario', confidence: 'confirmed' as const, basis: 'Scenario log' }] : []),
        ],
        recommendations: [h.recommendation ?? 'Inspect the component at the next opportunity.', 'Plan condition-based maintenance in the next planned window rather than waiting for a trip.'],
        refs: { scenarioId: scen },
        source: scen ? 'scenario' : 'simulation',
        capture: (e) => {
          captureSignals(s, e, a.id, t, 360, 10);
          captureMetrics(s, e, 'Assessment at detection', [
            { label: 'Level', value: lvl },
            { label: 'Score', value: h.score, unit: '/100' },
            { label: 'Trend', value: h.trend != null ? Math.round(h.trend * 100) / 100 : '—', unit: 'mm/s per h' },
            { label: 'Time to alarm', value: h.etaAlarmH != null ? h.etaAlarmH.toFixed(1) : '—', unit: 'h' },
            { label: 'Time to trip', value: h.etaTripH != null ? h.etaTripH.toFixed(1) : '—', unit: 'h' },
          ], t);
        },
      });
    } else if (abnormal && isOpen(s, key) && s.internal.ev.open[`stop:${a.id}`] && openEvent(s, `stop:${a.id}`)!.related.includes(s.internal.ev.open[key])) {
      // The developing fault has tripped the machine: the stop event now carries it.
      const stopEv = openEvent(s, `stop:${a.id}`)!;
      openEvent(s, key)!.facts.push(`${clock(t)}: the fault tripped ${a.id} — see ${stopEv.id}.`);
      clearKey(s, t, key, `Fault realised — ${a.id} stopped (${stopEv.id})`);
    } else if (abnormal && isOpen(s, key) && lvl !== prev) {
      const ev = openEvent(s, key)!;
      escalate(ev, sevOf[lvl], t, `Condition level rose to ${lvl}`);
      ev.facts.push(`${clock(t)}: level ${prev} → ${lvl}.`);
    } else if (!abnormal && isOpen(s, key)) {
      const down = s.machines[a.id].state === 'down';
      clearKey(s, t, key, down ? `${a.id} stopped (${lvl === 'offline' ? 'not assessed while stopped' : 'level normal'})` : `${a.id} condition back to normal`);
    }
  }
}

/** Reject-rate, defect-count and deterioration rules (every 5 min). */
function qualityRules(s: SimState, t: number) {
  const R = s.rules;
  // Line reject rate over the last 60 min.
  const w60 = qualityWindow(s, t, 60);
  const rateKey = 'qrate:line';
  if (w60.inspected >= 300 && w60.rate != null && w60.rate > R.rejectRateMax && !isOpen(s, rateKey)) {
    const top = DEFECT_ORDER.map((d) => ({ d, n: qualityWindow(s, t, 60, d).rejected })).sort((a, b) => b.n - a.n)[0];
    const scen = activeQualityScenario(s, t);
    raise(s, t, {
      key: rateKey,
      category: 'quality',
      type: 'defect-rate',
      severity: 'serious',
      title: `Reject rate ${(w60.rate * 100).toFixed(1)} % over the last hour`,
      summary: `Sorting rejected ${Math.round(w60.rejected)} of ${Math.round(w60.inspected)} tiles in the last 60 min (threshold ${(R.rejectRateMax * 100).toFixed(1)} %). Largest category: ${DEFECTS[top.d].label.toLowerCase()}.`,
      asset: { equipmentId: 'I-VIS', stationId: 'ST-VIS', stage: 'SORT', zone: 'I' },
      trigger: {
        kind: scen ? 'scenario' : 'rule',
        ruleId: 'Q-RATE',
        description: 'Rejected ÷ inspected over 60 min above threshold',
        signalId: 'I-VIS.count_rejected',
        observed: [{ label: 'Reject rate', value: `${(w60.rate * 100).toFixed(2)} %` }, { label: 'Rejected', value: Math.round(w60.rejected), unit: 'tiles' }, { label: 'Inspected', value: Math.round(w60.inspected), unit: 'tiles' }],
        threshold: { label: 'Threshold', value: `${(R.rejectRateMax * 100).toFixed(1)} %` },
      },
      facts: [`${Math.round(w60.rejected)} rejects / ${Math.round(w60.inspected)} inspected from ${clock(t - 59)} to ${clock(t)}.`, `Largest category: ${DEFECTS[top.d].label} (${Math.round(top.n)} tiles).`],
      causes: qualityCauses(s, t, top.d, scen),
      recommendations: [DEFECT_ACTIONS[top.d], 'Quarantine pallets of the affected batch until the quality engineer reviews them.'],
      refs: { scenarioId: scen?.id, defect: undefined },
      source: scen ? 'scenario' : 'simulation',
      start: t - 59,
      capture: (e) => captureQuality(s, e, t, undefined, 'ST-VIS'),
    });
  } else if (isOpen(s, rateKey)) {
    const w30 = qualityWindow(s, t, 30);
    if (w30.rate != null && w30.rate < R.rejectRateMax * 0.8) clearKey(s, t, rateKey, `Reject rate back to ${(w30.rate * 100).toFixed(1)} % over 30 min`);
  }

  // Per-category counts (30 min) and deterioration vs 24 h reference (every 15 min).
  for (const d of DEFECT_ORDER) {
    const station = DEFECTS[d].station;
    const st = INSPECTION_STATIONS.find((x) => x.id === station)!;
    const countKey = `qcount:${d}`;
    const w30 = qualityWindow(s, t, 30, d);
    if (w30.rejected > R.defectCount30Max && !isOpen(s, countKey)) {
      const scen = activeQualityScenario(s, t);
      raise(s, t, {
        key: countKey,
        category: 'quality',
        type: 'defect-count',
        severity: 'warning',
        title: `${DEFECTS[d].label}: ${Math.round(w30.rejected)} rejects in 30 min`,
        summary: `${Math.round(w30.rejected)} tiles rejected for ${DEFECTS[d].label.toLowerCase()} at ${st.name} in the last 30 min (threshold ${R.defectCount30Max}).`,
        asset: { equipmentId: st.equipmentId, stationId: station, stage: 'SORT', zone: 'I' },
        trigger: {
          kind: scen ? 'scenario' : 'rule',
          ruleId: 'Q-COUNT',
          description: 'Rejected tiles of one category in 30 min above threshold',
          signalId: `${st.equipmentId}.count_rejected`,
          observed: [{ label: 'Rejected (30 min)', value: Math.round(w30.rejected), unit: 'tiles' }],
          threshold: { label: 'Threshold', value: R.defectCount30Max, unit: 'tiles' },
        },
        facts: [`${Math.round(w30.rejected)} ${DEFECTS[d].label.toLowerCase()} rejects at ${station} between ${clock(t - 29)} and ${clock(t)}.`],
        causes: qualityCauses(s, t, d, scen),
        recommendations: [DEFECT_ACTIONS[d]],
        refs: { scenarioId: scen?.id, defect: d },
        source: scen ? 'scenario' : 'simulation',
        start: t - 29,
        capture: (e) => captureQuality(s, e, t, d, station),
      });
    } else if (isOpen(s, countKey) && w30.rejected < R.defectCount30Max * 0.6) clearKey(s, t, countKey, `${DEFECTS[d].label} rejects back below threshold`);

    if (t % 15 !== 0) continue;
    const detKey = `qdet:${d}`;
    const recent = qualityWindow(s, t, 120, d);
    const ref = referenceRejectRate(s, t, d);
    const ratio = recent.rate != null && ref ? recent.rate / ref : null;
    if (ratio != null && recent.inspected >= 600 && ratio >= R.deteriorationRatio && (recent.rate ?? 0) >= 0.004 && !isOpen(s, detKey)) {
      const scen = activeQualityScenario(s, t);
      raise(s, t, {
        key: detKey,
        category: 'quality',
        type: 'defect-deterioration',
        severity: ratio >= 3 ? 'serious' : 'warning',
        title: `${DEFECTS[d].label} ${ratio.toFixed(1)}× its 24 h rate`,
        summary: `${DEFECTS[d].label} reject rate is ${((recent.rate ?? 0) * 100).toFixed(2)} % over the last 2 h against ${(ref! * 100).toFixed(2)} % in the 24 h before.`,
        asset: { equipmentId: st.equipmentId, stationId: station, stage: DEFECTS[d].origin, zone: 'I' },
        trigger: {
          kind: scen ? 'scenario' : 'rule',
          ruleId: 'Q-DET',
          description: 'Category rate (2 h) vs the 24 h before',
          signalId: `${st.equipmentId}.count_rejected`,
          observed: [{ label: 'Rate (2 h)', value: `${((recent.rate ?? 0) * 100).toFixed(2)} %` }, { label: 'Reference (24 h)', value: `${(ref! * 100).toFixed(2)} %` }, { label: 'Ratio', value: `${ratio.toFixed(1)}×` }],
          threshold: { label: 'Ratio threshold', value: `${R.deteriorationRatio}×` },
        },
        facts: [`${DEFECTS[d].label} rate ${((recent.rate ?? 0) * 100).toFixed(2)} % (${Math.round(recent.rejected)} tiles, last 2 h) vs ${(ref! * 100).toFixed(2)} % reference.`],
        causes: qualityCauses(s, t, d, scen),
        recommendations: [DEFECT_ACTIONS[d], `Compare the process parameters of ${STAGE_BY_ID[DEFECTS[d].origin].name.toLowerCase()} now vs yesterday.`],
        refs: { scenarioId: scen?.id, defect: d },
        source: scen ? 'scenario' : 'simulation',
        start: t - 119,
        capture: (e) => captureQuality(s, e, t, d, station),
      });
    } else if (isOpen(s, detKey) && (ratio == null || ratio < 1.5)) clearKey(s, t, detKey, `${DEFECTS[d].label} rate back near its reference`);
  }
}

const activeQualityScenario = (s: SimState, t: number) =>
  s.scenarios.find((sc) => sc.kind === 'quality-deterioration' && sc.start <= t && (sc.end == null || sc.end > t));

function qualityCauses(s: SimState, t: number, d: DefectCategory, scen: ReturnType<typeof activeQualityScenario>): EventCause[] {
  const origin = DEFECTS[d].origin;
  const out: EventCause[] = [];
  if (scen && (!scen.stage || scen.stage === origin))
    out.push({ text: `Quality deterioration at ${STAGE_BY_ID[origin].name.toLowerCase()} injected by a scenario`, confidence: 'confirmed', basis: 'Scenario log' });
  out.push({
    text: `Process condition at ${STAGE_BY_ID[origin].name.toLowerCase()} (where ${DEFECTS[d].label.toLowerCase()} usually originates)`,
    confidence: 'possible',
    basis: 'Process knowledge of the defect category — a hypothesis to check, not a confirmed cause',
  });
  for (const mid of STAGE_BY_ID[origin].machines) {
    const id = s.internal.ev.open[`rate:${mid}`] ?? s.internal.ev.open[`stop:${mid}`] ?? s.internal.ev.open[`cond:${mid}`];
    const ev = id ? eventById(s, id) : undefined;
    if (ev) out.push({ text: `Concurrent event on ${mid}: ${ev.title}`, confidence: 'possible', basis: 'Correlation in time only', relatedEventId: ev.id });
  }
  void t;
  return out;
}

function captureQuality(s: SimState, ev: OpEvent, t: number, d: DefectCategory | undefined, station: string) {
  const recs = s.inspections.filter((r) => r.result === 'reject' && r.stationId === station && r.time >= ev.start - 5 && r.time <= t && (!d || r.defect === d)).slice(-4);
  ev.refs.inspectionIds = recs.map((r) => r.id);
  for (const r of recs)
    addEvidence(s, ev, {
      kind: 'inspection-image',
      title: `${r.id} · ${r.defect ? DEFECTS[r.defect].label : 'Reject'} · ${clock(r.time)}`,
      capturedAt: r.time,
      inspectionId: r.id,
      provenance: { origin: 'simulation', sourceId: station, label: 'Illustrative frame of a simulated inspection record — no camera image, no vision model' },
      status: 'available',
    });
  if (!recs.length)
    addEvidence(s, ev, {
      kind: 'inspection-image',
      title: 'Inspection frames',
      capturedAt: t,
      provenance: { origin: 'simulation', sourceId: station, label: 'No reject record in the window' },
      status: 'unavailable',
      unavailableReason: 'No individual reject record falls in the event window',
    });
  const w = qualityWindow(s, t, Math.max(30, t - ev.start + 1), d);
  const all = qualityWindow(s, t, Math.max(30, t - ev.start + 1));
  captureMetrics(s, ev, 'Inspection counts in the window', [
    { label: 'Inspected', value: Math.round(all.inspected), unit: 'tiles' },
    { label: 'Accepted (first pass)', value: Math.round(all.inspected - all.rejected), unit: 'tiles' },
    { label: 'Rejected (all categories)', value: Math.round(all.rejected), unit: 'tiles' },
    ...(d ? [{ label: `Rejected — ${DEFECTS[d].label}`, value: Math.round(w.rejected), unit: 'tiles' }] : []),
    { label: 'Reject rate', value: all.rate != null ? `${(all.rate * 100).toFixed(2)} %` : '—' },
  ], t);
  // Reject-rate series per 5 min over the last 2 h.
  const tt: number[] = [];
  const vv: (number | null)[] = [];
  for (let m = t - 115; m <= t; m += 5) {
    const q = qualityWindow(s, m + 4, 5, d);
    tt.push(m);
    vv.push(q.rate != null ? Math.round(q.rate * 10000) / 100 : null);
  }
  addEvidence(s, ev, {
    kind: 'counter-series',
    title: `${d ? DEFECTS[d].label : 'Reject'} rate per 5 min (last 2 h)`,
    capturedAt: t,
    provenance: simProv(ev, 'Simulated inspection counters'),
    status: 'available',
    series: [{ id: `${station}.reject_rate`, label: 'Reject rate', unit: '%', t: tt, v: vv }],
  });
  captureCamera(s, ev, station === 'ST-GAUGE' ? 'I-GAUGE' : 'I-VIS', t);
}

/** Repeated and critical defects, from new inspection records. */
function inspectionRecordRules(s: SimState, t: number) {
  const I = s.internal.ev;
  const R = s.rules;
  const fresh = [];
  for (let i = s.inspections.length - 1; i >= 0; i--) {
    const r = s.inspections[i];
    if (seqOf(r.id) <= I.lastInspectionSeq) break;
    fresh.push(r);
  }
  if (fresh.length) I.lastInspectionSeq = seqOf(fresh[0].id);
  for (const r of fresh.reverse()) {
    if (r.result !== 'reject' || !r.defect) continue;
    const st = INSPECTION_STATIONS.find((x) => x.id === r.stationId)!;
    // Repeats.
    const run = (I.repeat[r.stationId] ??= { defect: null, ids: [] });
    if (run.defect === r.defect) run.ids.push(r.id);
    else I.repeat[r.stationId] = { defect: r.defect, ids: [r.id] };
    const cur = I.repeat[r.stationId];
    const repKey = `qrep:${r.stationId}:${r.defect}`;
    I.lastSeen[repKey] = r.time;
    if (cur.ids.length >= R.defectRepeatRecords && !isOpen(s, repKey)) {
      const scen = activeQualityScenario(s, t);
      raise(s, t, {
        key: repKey,
        category: 'quality',
        type: 'defect-repeat',
        severity: 'warning',
        title: `Repeated ${DEFECTS[r.defect].label.toLowerCase()} at ${st.name}`,
        summary: `${cur.ids.length} consecutive reject records at ${r.stationId} are ${DEFECTS[r.defect].label.toLowerCase()}.`,
        asset: { equipmentId: st.equipmentId, stationId: r.stationId, stage: DEFECTS[r.defect].origin, zone: 'I' },
        trigger: {
          kind: scen ? 'scenario' : 'rule',
          ruleId: 'Q-REPEAT',
          description: 'Consecutive reject records of the same category',
          observed: [{ label: 'Consecutive records', value: cur.ids.length }, { label: 'Category', value: DEFECTS[r.defect].label }],
          threshold: { label: 'Threshold', value: R.defectRepeatRecords, unit: 'records' },
        },
        facts: [`Records ${cur.ids.slice(-R.defectRepeatRecords).join(', ')} — all ${DEFECTS[r.defect].label.toLowerCase()}.`],
        causes: qualityCauses(s, t, r.defect, scen),
        recommendations: [DEFECT_ACTIONS[r.defect]],
        refs: { scenarioId: scen?.id, defect: r.defect, inspectionIds: cur.ids.slice(-6) },
        source: scen ? 'scenario' : 'simulation',
        start: s.inspections.find((x) => x.id === cur.ids[0])?.time ?? t,
        capture: (e) => captureQuality(s, e, t, r.defect!, r.stationId),
      });
    }
    // Critical defects needing review, grouped per station within 30 min.
    if (r.severity === 'critical') {
      const critKey = `qcrit:${r.stationId}`;
      I.lastSeen[critKey] = r.time;
      const open = openEvent(s, critKey);
      if (open) {
        open.refs.inspectionIds = [...(open.refs.inspectionIds ?? []), r.id].slice(-8);
        open.facts.push(`${clock(r.time)}: ${r.id} — ${DEFECTS[r.defect].label} (critical)${r.measurement ? `, ${r.measurement}` : ''}.`);
        open.lastUpdate = t;
      } else {
        raise(s, t, {
          key: critKey,
          category: 'quality',
          type: 'critical-defect',
          severity: 'warning',
          title: `Critical ${DEFECTS[r.defect].label.toLowerCase()} — review required`,
          summary: `${r.id} at ${st.name} was classified critical (${DEFECTS[r.defect].label.toLowerCase()}${r.measurement ? `, ${r.measurement}` : ''}). A quality engineer should review the tile and its batch ${r.batchId}.`,
          asset: { equipmentId: st.equipmentId, stationId: r.stationId, stage: DEFECTS[r.defect].origin, zone: 'I' },
          trigger: {
            kind: 'model',
            ruleId: 'Q-CRIT',
            description: 'Reject record classified critical (simulated classification)',
            observed: [
              { label: 'Record', value: r.id },
              { label: 'Class', value: DEFECTS[r.defect].label },
              ...(r.stationId === 'ST-VIS' && r.confidence != null ? [{ label: 'Confidence (simulated)', value: `${Math.round(r.confidence * 100)} %` }] : []),
              ...(r.measurement ? [{ label: 'Measurement', value: r.measurement }] : []),
            ],
          },
          facts: [`${clock(r.time)}: ${r.id} — ${DEFECTS[r.defect].label} (critical), batch ${r.batchId}${r.measurement ? `, ${r.measurement}` : ''}.`],
          causes: qualityCauses(s, t, r.defect, activeQualityScenario(s, t)),
          recommendations: ['Pull the tile for manual review and check the neighbouring tiles of the same batch.', DEFECT_ACTIONS[r.defect]],
          refs: { inspectionIds: [r.id], defect: r.defect },
          source: r.source,
          start: r.time,
          capture: (e) => captureQuality(s, e, t, r.defect!, r.stationId),
        });
      }
    }
  }
  // Clear repeat / critical groups 30 min after their last record.
  for (const key of Object.keys(I.open)) {
    if (!key.startsWith('qrep:') && !key.startsWith('qcrit:')) continue;
    const last = I.lastSeen[key] ?? 0;
    if (t - last >= 30) clearKey(s, t, key, key.startsWith('qcrit:') ? 'No further critical defect in 30 min' : 'No repeat of this category in 30 min');
  }
}

/** Truck waiting, dock overstay, yard congestion, turnaround and restricted-zone entries. */
function logisticsRules(s: SimState, t: number) {
  const R = s.rules;
  const st = s.logistics;
  const trucks = st.active.map((id) => st.vehicles[id]).filter((v): v is Vehicle => v.class === 'external');
  const waiting = trucks.filter((v) => v.phase === 'waiting');
  for (const v of trucks) {
    // Waiting for a dock.
    const wKey = `wait:${v.id}`;
    const waitLeg = v.legs.find((l) => l.activity === 'Waiting for dock');
    const waited = v.phase === 'waiting' && waitLeg ? t - waitLeg.start : 0;
    if (v.phase === 'waiting' && waited >= R.truckWaitMax && !isOpen(s, wKey)) {
      const busy = Object.values(st.docks).filter((d) => d.vehicleId || d.reservedBy).length;
      const longest = Object.entries(st.docks).filter(([, d]) => d.vehicleId && d.since != null).sort((a, b) => a[1].since! - b[1].since!)[0];
      const overstay = longest ? s.internal.ev.open[`dock:${longest[0]}`] : undefined;
      raise(s, t, {
        key: wKey,
        category: 'logistics',
        type: 'truck-waiting',
        severity: 'warning',
        title: `${v.label} waiting ${Math.round(waited)} min for a dock`,
        summary: `${v.label} (${v.operator}) has waited ${Math.round(waited)} min in the holding area; ${busy} of ${DOCKS.length} docks are occupied or reserved.`,
        asset: { vehicleId: v.id, geofenceId: 'GF-HOLD', zone: 'A' },
        trigger: { kind: v.visit?.scenarioId ? 'scenario' : 'rule', ruleId: 'L-WAIT', description: 'Waiting for a dock longer than the threshold', observed: [{ label: 'Waiting', value: Math.round(waited), unit: 'min' }, { label: 'Docks busy', value: `${busy} / ${DOCKS.length}` }], threshold: { label: 'Threshold', value: R.truckWaitMax, unit: 'min' } },
        facts: [`${v.label} entered at ${clock(v.visit!.gateIn)} and has been waiting since ${clock(waitLeg!.start)}.`, `${busy} of ${DOCKS.length} docks busy; ${waiting.length} truck${waiting.length === 1 ? '' : 's'} waiting.`],
        causes: overstay
          ? [{ text: `Dock held by a prolonged stay (${overstay})`, confidence: 'likely', basis: 'A docked truck has exceeded the dock-stay threshold', relatedEventId: overstay }]
          : [{ text: 'Dock capacity below arrival rate', confidence: 'possible', basis: `${busy} of ${DOCKS.length} docks busy at detection` }],
        recommendations: ['Check the dock board for trucks that have finished loading; release or reassign a dock.', 'If loading is the bottleneck, add a dispatch forklift to the busiest dock.'],
        refs: { scenarioId: v.visit?.scenarioId },
        source: v.visit?.scenarioId ? 'scenario' : 'simulation',
        start: waitLeg!.start,
        capture: (e) => {
          captureVisit(s, e, v, t);
          captureCamera(s, e, 'GF-HOLD', t);
        },
      });
    } else if (v.phase !== 'waiting' && isOpen(s, wKey)) clearKey(s, t, wKey, `${v.label} assigned a dock at ${clock(v.visit?.dockAssigned ?? t)}`);
    // Turnaround.
    const tKey = `turn:${v.id}`;
    const onSite = v.visit ? t - v.visit.gateIn : 0;
    if (v.visit && t >= v.visit.gateIn && onSite >= R.turnaroundMax && v.visit.gateOut == null && !isOpen(s, tKey)) {
      raise(s, t, {
        key: tKey,
        category: 'logistics',
        type: 'turnaround-exceeded',
        severity: 'warning',
        title: `${v.label} on site ${Math.round(onSite)} min`,
        summary: `${v.label} has been on site for ${Math.round(onSite)} min since gate-in at ${clock(v.visit.gateIn)} (threshold ${R.turnaroundMax} min).`,
        asset: { vehicleId: v.id, dockId: v.visit.dockId ?? undefined, zone: 'K' },
        trigger: { kind: v.visit.scenarioId ? 'scenario' : 'rule', ruleId: 'L-TURN', description: 'Time on site since gate-in above threshold', observed: [{ label: 'On site', value: Math.round(onSite), unit: 'min' }], threshold: { label: 'Threshold', value: R.turnaroundMax, unit: 'min' } },
        facts: [`Gate-in ${clock(v.visit.gateIn)}; current phase: ${v.phase ?? '—'}.`],
        causes: [],
        recommendations: ['Find the phase holding the truck (waiting, loading, paperwork) on the visit timeline and act on it.'],
        refs: { scenarioId: v.visit.scenarioId },
        source: v.visit.scenarioId ? 'scenario' : 'simulation',
        start: v.visit.gateIn,
        capture: (e) => captureVisit(s, e, v, t),
      });
    }
  }
  // Departed trucks close their turnaround / waiting events.
  for (const key of Object.keys(s.internal.ev.open)) {
    if (!key.startsWith('turn:') && !key.startsWith('wait:')) continue;
    const id = key.slice(5);
    const v = st.vehicles[id];
    if (!v || (v.despawned != null && v.despawned <= t) || v.visit?.gateOut != null) {
      const ev = openEvent(s, key);
      if (ev && v?.visit?.gateOut != null) ev.facts.push(`Gate-out ${clock(v.visit.gateOut)} — total turnaround ${Math.round(v.visit.gateOut - v.visit.gateIn)} min.`);
      clearKey(s, t, key, `${id} left the site`);
    }
  }
  // Dock overstay.
  for (const [dockId, d] of Object.entries(st.docks)) {
    const key = `dock:${dockId}`;
    const stay = d.vehicleId && d.since != null ? t - d.since : 0;
    if (d.vehicleId && stay >= R.dockStayMax && !isOpen(s, key)) {
      const v = st.vehicles[d.vehicleId];
      const dock = DOCKS.find((x) => x.id === dockId)!;
      raise(s, t, {
        key,
        category: 'logistics',
        type: 'dock-overstay',
        severity: stay >= R.dockStayMax * 1.5 ? 'serious' : 'warning',
        title: `${dock.name} occupied ${Math.round(stay)} min by ${v.label}`,
        summary: `${v.label} has been at ${dock.name} since ${clock(d.since!)} (threshold ${R.dockStayMax} min).`,
        asset: { vehicleId: v.id, dockId, equipmentId: 'K-DOCK', zone: 'K' },
        trigger: { kind: v.visit?.scenarioId ? 'scenario' : 'rule', ruleId: 'L-DOCK', description: 'Same truck at a dock longer than the threshold', observed: [{ label: 'At dock', value: Math.round(stay), unit: 'min' }], threshold: { label: 'Threshold', value: R.dockStayMax, unit: 'min' } },
        facts: [`Docked at ${clock(d.since!)}; activity now: ${v.legs[v.legs.length - 1]?.activity ?? '—'}.`, `Pallets loaded: ${(v as Vehicle & { palletsLoaded?: number }).palletsLoaded ?? '—'} of ${v.visit?.load ?? '—'}.`],
        causes: v.visit?.scenarioId
          ? [{ text: 'Truck held at the dock by a scenario (prolonged stay)', confidence: 'confirmed', basis: 'Scenario log' }]
          : [{ text: 'Loading slower than planned or documentation delay', confidence: 'possible', basis: 'Dock time above threshold; the visit timeline shows which phase took longer' }],
        recommendations: ['Check loading progress and paperwork with the dock supervisor; release the dock as soon as loading completes.'],
        refs: { scenarioId: v.visit?.scenarioId },
        source: v.visit?.scenarioId ? 'scenario' : 'simulation',
        start: d.since!,
        capture: (e) => {
          captureVisit(s, e, v, t);
          captureCamera(s, e, 'GF-DOCKS', t);
        },
      });
    } else if (isOpen(s, key)) {
      const ev = openEvent(s, key)!;
      if (!d.vehicleId || d.vehicleId !== ev.asset.vehicleId) clearKey(s, t, key, `${ev.asset.vehicleId} left ${dockId}`);
    }
  }
  // Yard congestion (hysteresis: clears below threshold − 1).
  const yKey = 'yard';
  if (waiting.length >= R.yardQueueMax && !isOpen(s, yKey)) {
    raise(s, t, {
      key: yKey,
      category: 'logistics',
      type: 'yard-congestion',
      severity: 'warning',
      title: `Yard congestion: ${waiting.length} trucks waiting`,
      summary: `${waiting.length} trucks are waiting for a dock (threshold ${R.yardQueueMax}).`,
      asset: { geofenceId: 'GF-HOLD', equipmentId: 'A-HOLD', zone: 'A' },
      trigger: { kind: waiting.some((v) => v.visit?.scenarioId) ? 'scenario' : 'rule', ruleId: 'L-YARD', description: 'Trucks waiting for a dock at or above threshold', observed: [{ label: 'Trucks waiting', value: waiting.length }], threshold: { label: 'Threshold', value: R.yardQueueMax } },
      facts: [`Waiting: ${waiting.map((v) => v.label).join(', ')}.`],
      causes: waiting.some((v) => v.visit?.scenarioId)
        ? [{ text: 'Burst of arrivals injected by a scenario', confidence: 'confirmed', basis: 'Scenario log' }]
        : [{ text: 'Arrivals bunched while docks were occupied', confidence: 'possible', basis: 'Queue length above threshold' }],
      recommendations: ['Stagger arrival slots with carriers; prioritise docks for trucks with completed paperwork.'],
      source: waiting.some((v) => v.visit?.scenarioId) ? 'scenario' : 'simulation',
      capture: (e) => captureCamera(s, e, 'GF-HOLD', t),
    });
  } else if (isOpen(s, yKey) && waiting.length < R.yardQueueMax - 1) clearKey(s, t, yKey, `Queue down to ${waiting.length}`);

  // Restricted-zone entries (from the geofence records).
  const I = s.internal.ev;
  const fresh = [];
  for (let i = st.restrictedEvents.length - 1; i >= 0; i--) {
    const r = st.restrictedEvents[i];
    if (seqOf(r.id) <= I.lastRestrictedSeq) break;
    fresh.push(r);
  }
  if (fresh.length) I.lastRestrictedSeq = seqOf(fresh[0].id);
  for (const r of fresh.reverse()) {
    const v = st.vehicles[r.vehicleId];
    const gf = GEOFENCES.find((g) => g.id === r.geofenceId)!;
    raise(s, t, {
      key: `rz:${r.vehicleId}`,
      category: 'logistics',
      type: 'restricted-entry',
      severity: 'warning',
      title: `${v.label} entered ${gf.name}`,
      summary: `${v.label} (simulated position) entered the restricted geofence ${gf.id} at ${clock(r.time)}.`,
      asset: { vehicleId: r.vehicleId, geofenceId: gf.id, equipmentId: gf.equipmentId, zone: 'J' },
      trigger: { kind: r.source === 'scenario' ? 'scenario' : 'rule', ruleId: 'L-ZONE', description: 'Internal vehicle position inside a restricted geofence', observed: [{ label: 'Geofence', value: gf.name }], threshold: { label: 'Rule', value: 'No entry' } },
      facts: [`Position (simulated) inside ${gf.id} at ${clock(r.time)}; task: ${v.task ?? '—'}.`, 'Positions come from the simulation — no indoor tracking system is connected.'],
      causes: r.source === 'scenario'
        ? [{ text: 'Route across the walkway forced by a scenario', confidence: 'confirmed', basis: 'Scenario log' }]
        : [{ text: 'Shortcut across the pedestrian walkway on the empty-pallet run', confidence: 'likely', basis: 'Route of the run that entered the zone' }],
      recommendations: ['Remind the driver of the walkway rule; consider physical barriers or a marked crossing point.', 'With real tracking, add a speed limit and pedestrian-proximity alerting here.'],
      refs: { restrictedEventId: r.id },
      source: r.source,
      start: r.time,
      capture: (e) => {
        captureVisit(s, e, v, t);
        captureCamera(s, e, gf.id, t);
      },
    });
  }
  for (const key of Object.keys(I.open)) {
    if (!key.startsWith('rz:')) continue;
    const vid = key.slice(3);
    if (!st.restrictedOpen[vid]) {
      const ev = openEvent(s, key);
      const rec = ev?.refs.restrictedEventId ? st.restrictedEvents.find((x) => x.id === ev.refs.restrictedEventId) : undefined;
      if (ev && rec) ev.facts.push(`Left the zone after ${rec.durationMin} min.`);
      clearKey(s, t, key, `${vid} left the restricted zone`);
    }
  }
}

function captureVisit(s: SimState, ev: OpEvent, v: Vehicle, t: number) {
  if (v.class === 'external' && v.visit) {
    const x = v.visit;
    addEvidence(s, ev, {
      kind: 'vehicle-timeline',
      title: `${v.label} visit timeline`,
      capturedAt: t,
      provenance: simProv(ev, 'Simulated gate / dock events'),
      status: 'available',
      milestones: [
        { label: 'Arrival', t: x.arrival <= t ? x.arrival : null },
        { label: 'Gate in', t: x.gateIn <= t ? x.gateIn : null },
        { label: 'Dock assigned', t: x.dockAssigned != null && x.dockAssigned <= t ? x.dockAssigned : null, note: x.dockId ?? undefined },
        { label: x.direction === 'inbound' ? 'Unloading start' : 'Docked', t: x.dockStart != null && x.dockStart <= t ? x.dockStart : null },
        { label: x.direction === 'inbound' ? 'Unloading complete' : 'Loading complete', t: x.dockEnd != null && x.dockEnd <= t ? x.dockEnd : null },
        { label: 'Gate out', t: x.gateOut != null && x.gateOut <= t ? x.gateOut : null },
      ],
    });
  } else {
    const legs = v.legs.filter((l) => l.start <= t && l.end >= t - 30).slice(-8);
    addEvidence(s, ev, {
      kind: 'vehicle-timeline',
      title: `${v.label} movements (last 30 min)`,
      capturedAt: t,
      provenance: simProv(ev, 'Simulated vehicle positions (zone level)'),
      status: legs.length ? 'available' : 'unavailable',
      unavailableReason: legs.length ? undefined : 'No movement in the window',
      milestones: legs.map((l) => ({ label: `${l.activity} · ${l.zone}`, t: Math.round(l.start), note: l.moving ? 'moving' : 'stopped' })),
    });
  }
}

/** Energy of the last full hour vs the model (every 15 min). */
function energyRules(s: SimState, t: number) {
  const R = s.rules;
  const hour = Math.floor((t - 1) / 60);
  for (const c of CONSUMERS) {
    const b = s.energy[c.id]?.get(hour);
    const key = `energy:${c.id}`;
    if (!b) continue;
    const exp = b.expElec + b.expThermal;
    const act = b.elec + b.thermal;
    if (exp < 20) continue;
    const dev = act / exp - 1;
    if (dev > R.energyDeviationMax && !isOpen(s, key)) {
      const scen = s.scenarios.find((sc) => sc.kind === 'energy-anomaly' && sc.equipmentId === c.id && sc.start <= t && (sc.end == null || sc.end > t));
      raise(s, t, {
        key,
        category: 'energy',
        type: 'energy-deviation',
        severity: dev > R.energyDeviationMax * 2 ? 'serious' : 'warning',
        title: `${c.label}: energy ${Math.round(dev * 100)} % above model`,
        summary: `${c.label} used ${Math.round(act)} kWh in the hour from ${clock(hour * 60)} against ${Math.round(exp)} kWh expected by the energy model for its load.`,
        asset: { equipmentId: c.id, stage: OPS_BY_ID[c.id]?.stage ?? undefined, zone: OPS_BY_ID[c.id]?.zone },
        trigger: { kind: scen ? 'scenario' : 'rule', ruleId: 'E-DEV', description: 'Last full hour vs energy model (illustrative)', signalId: `${c.id}.energy_kwh`, observed: [{ label: 'Actual', value: Math.round(act), unit: 'kWh' }, { label: 'Model', value: Math.round(exp), unit: 'kWh' }, { label: 'Deviation', value: `${Math.round(dev * 100)} %` }], threshold: { label: 'Threshold', value: `${Math.round(R.energyDeviationMax * 100)} %` } },
        facts: [`${clock(hour * 60)}–${clock(hour * 60 + 60)}: ${Math.round(act)} kWh actual vs ${Math.round(exp)} kWh model (${Math.round(dev * 100)} %).`],
        causes: scen
          ? [{ text: `Energy anomaly injected by a scenario (${scen.label})`, confidence: 'confirmed', basis: 'Scenario log' }]
          : [{ text: CONSUMER_BY_ID[c.id]?.thermal ? 'Combustion settings or heat losses' : 'Mechanical friction or idle running', confidence: 'possible', basis: 'Typical causes for this consumer type' }],
        recommendations: [CONSUMER_BY_ID[c.id]?.thermal ? 'Check burner air/gas ratio and flue-gas O₂; inspect seals and doors for heat losses.' : 'Check for idle running, compressed-air leaks or mechanical drag.'],
        refs: { scenarioId: scen?.id },
        source: scen ? 'scenario' : 'simulation',
        start: hour * 60,
        capture: (e) =>
          captureMetrics(s, e, 'Energy of the hour', [
            { label: 'Actual', value: Math.round(act), unit: 'kWh' },
            { label: 'Model', value: Math.round(exp), unit: 'kWh' },
            { label: 'Deviation', value: `${Math.round(dev * 100)} %` },
          ], t),
      });
    } else if (isOpen(s, key) && dev < R.energyDeviationMax / 2) clearKey(s, t, key, `${c.label} back within ${Math.round((R.energyDeviationMax / 2) * 100)} % of the model`);
  }
}

/** Kiln output vs tiles arriving at sorting, including the outfeed buffer change (every 30 min). */
function ioRule(s: SimState, t: number) {
  let kilnOut = 0;
  let sorted = 0;
  let n = 0;
  for (let m = t - 59; m <= t; m++) {
    const k = minuteAt(s, 'H-KILN', m);
    const q = minuteAt(s, 'I-SORT', m);
    if (!k || !q) continue;
    kilnOut += k.rate;
    sorted += q.rate;
    n++;
  }
  if (n < 55 || kilnOut < 100) return;
  const lvl = s.bufferLog?.['BUF-KOUT'];
  const before = lvl ? lvl.level[(t - 60 + LOG_MIN) % LOG_MIN] : null;
  const after = lvl ? lvl.level[t % LOG_MIN] : null;
  const dWip = before != null && after != null ? after - before : 0;
  const unaccounted = kilnOut - sorted - dWip;
  const share = Math.abs(unaccounted) / kilnOut;
  const key = 'io:KILN-SORT';
  if (share > s.rules.ioImbalanceMax && !isOpen(s, key)) {
    raise(s, t, {
      key,
      category: 'production',
      type: 'io-imbalance',
      severity: 'warning',
      title: `Kiln → sorting imbalance ${(share * 100).toFixed(1)} %`,
      summary: `${Math.round(kilnOut)} tiles left the kiln, ${Math.round(sorted)} reached sorting and the outfeed buffer changed by ${Math.round(dWip)} in 60 min.`,
      asset: { equipmentId: 'CV-SORT', stage: 'SORT', zone: 'I' },
      trigger: { kind: 'rule', ruleId: 'R-IO', description: 'Kiln output − sorted − Δ outfeed buffer over 60 min', observed: [{ label: 'Unaccounted', value: Math.round(unaccounted), unit: 'tiles' }], threshold: { label: 'Threshold', value: `${(s.rules.ioImbalanceMax * 100).toFixed(1)} %` } },
      facts: [`Kiln out ${Math.round(kilnOut)} · sorted ${Math.round(sorted)} · Δ buffer ${Math.round(dWip)} → ${Math.round(unaccounted)} tiles unaccounted.`],
      causes: [{ text: 'Breakage on the roller line or a counting error', confidence: 'possible', basis: 'Mass balance does not close' }],
      recommendations: ['Inspect the kiln exit and the sorting line for broken tiles; verify the counters.'],
      source: 'simulation',
      start: t - 59,
    });
  } else if (isOpen(s, key) && share < s.rules.ioImbalanceMax / 2) clearKey(s, t, key, 'Balance closes again');
}

// ── Queries for the UI ────────────────────────────────────────────────────────

/** Process stages fully contained in a monitored stage (GLAZE = glazing + decoration, PACK = packing + palletising). */
const SUB_STAGES: Record<string, StageId[]> = Object.fromEntries(
  MONITORED_STAGES.map((ms) => [ms.id, STAGES.filter((st) => st.machines.every((m) => ms.equipment.includes(m))).map((st) => st.id)]),
);
const EXTRA_EVENT_ASSETS: Partial<Record<MonitoredStageId, string[]>> = {
  SORT: INSPECTION_STATIONS.map((x) => x.equipmentId),
  WH: ['K-FLT'],
};

/**
 * Whether an event belongs to a monitored stage: its asset is one of the stage's machines or conveyors,
 * or its stage is one of the stage's process stages (quality events carry the defect's origin stage).
 * Conveyor events match only the stages that list the conveyor. Used by the monitoring views and the
 * stage shift PDF so both count the same events.
 */
export function eventInMonitoredStage(ms: MonitoredStage, e: OpEvent): boolean {
  const eq = e.asset.equipmentId;
  if (eq && CONVEYOR_BY_ID[eq]) return ms.conveyors.includes(eq);
  if (eq && (ms.equipment.includes(eq) || EXTRA_EVENT_ASSETS[ms.id]?.includes(eq))) return true;
  const st = e.asset.stage;
  if (st && (st === ms.id || (SUB_STAGES[ms.id] ?? []).includes(st as StageId))) return true;
  return ms.id === 'WH' && (e.asset.dockId != null || e.asset.zone === 'K');
}

export const activeEvents = (s: SimState) => s.events.filter((e) => e.end == null);
export const openEvents = (s: SimState) => s.events.filter((e) => e.status !== 'resolved');

export function eventsFor(
  s: SimState,
  f: { equipmentId?: string; vehicleId?: string; stage?: string; stationId?: string; category?: EventCategory; from?: number; to?: number; includeHistorical?: boolean },
) {
  return s.events.filter(
    (e) =>
      (!f.equipmentId || e.asset.equipmentId === f.equipmentId) &&
      (!f.vehicleId || e.asset.vehicleId === f.vehicleId) &&
      (!f.stage || e.asset.stage === f.stage) &&
      (!f.stationId || e.asset.stationId === f.stationId) &&
      (!f.category || e.category === f.category) &&
      (f.from == null || (e.end ?? s.minute) >= f.from) &&
      (f.to == null || e.start <= f.to),
  );
}

/** Camera used for an event's visual evidence (by asset coverage). */
export const eventCamera = (ev: OpEvent) =>
  cameraFor(ev.asset.equipmentId) ?? cameraFor(ev.asset.geofenceId) ?? (ev.asset.stationId ? cameraFor(INSPECTION_STATIONS.find((x) => x.id === ev.asset.stationId)?.equipmentId) : null);

export const cameraLabel = (id: string) => CAMERA_BY_ID[id]?.name ?? id;
export const M2 = M2_PER_TILE;
