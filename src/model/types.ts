/**
 * Shared operational data model.
 *
 * Every workspace (Factory Twin, Production Monitoring, OEE & Loss, AI Defect Monitoring, Vehicle Monitoring,
 * Assets & Data) reads these entities from one simulation state — nothing in the UI
 * keeps its own copy of machine, counter or vehicle values.
 *
 * Time is "plant minutes": integer minutes since SIM_EPOCH (see src/sim/time.ts).
 * Continuous positions (vehicles) use fractional minutes.
 */

import type { Vec2 } from '../data/types';

// ── Provenance ────────────────────────────────────────────────────────────────

/** Where a value or record came from. This release only ever produces 'simulation' / 'scenario'. */
export type RecordSource = 'simulation' | 'scenario';

/** Integration status of an external data source. Never claim 'connected' without a real link. */
export type SourceStatus = 'simulated' | 'configured' | 'disconnected' | 'connected';

export type DataSource = {
  id: string;
  name: string;
  kind: 'simulation' | 'plc' | 'scada' | 'iot-gateway' | 'mes' | 'erp' | 'wms' | 'telematics' | 'vision';
  status: SourceStatus;
  /** Protocol / interface the integration boundary expects (documentation only). */
  protocol: string;
  description: string;
  /** Signals this source would provide (signal ids). */
  provides: string[];
};

// ── Plant structure ───────────────────────────────────────────────────────────

export type Factory = {
  id: string;
  name: string;
  /** Short reference text; the plant is representative, not a reproduction of a real site. */
  reference: string;
  timezoneLabel: string;
};

/** Production zone = the 12 physical zones A–L of the 3D model (src/data/layout.ts). */
export type ZoneId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L';

export type ProductionLine = {
  id: string;
  name: string;
  /** Ordered process stages. */
  stages: StageId[];
  /** Stage whose output is reported as line output (first-quality tiles accepted at sorting). */
  outputStage: StageId;
  /** Designed constraint (lowest ideal rate). The bottleneck view checks whether it still is. */
  designConstraint: StageId;
};

export type StageId = 'PREP' | 'SPRAY' | 'PRESS' | 'DRY' | 'GLAZE' | 'DECOR' | 'KILN' | 'SORT' | 'PACK' | 'PAL';

export type ProcessStage = {
  id: StageId;
  name: string;
  /** Process step number shown in the flow view. */
  step: number;
  zone: ZoneId;
  machines: string[];
  /** Buffer feeding this stage (null = unlimited raw-material supply). */
  inputBuffer: string | null;
};

/** Physical WIP buffer between two stages (silo, buffer rack, conveyor accumulation). */
export type BufferDef = {
  id: string;
  name: string;
  /** Equipment id of the physical buffer in the 3D model, if any. */
  equipmentId: string | null;
  /** Capacity in tiles (pieces) equivalent. */
  capacity: number;
  initialFill: number;
};

export type EquipmentCategory =
  | 'process'
  | 'buffer'
  | 'inspection'
  | 'material-handling'
  | 'storage'
  | 'logistics'
  | 'utility'
  | 'support';

/** Operational metadata for one asset. `id` equals the 3D Selectable id. */
export type EquipmentOps = {
  id: string;
  category: EquipmentCategory;
  zone: ZoneId;
  lineId: string | null;
  stage: StageId | null;
  /** Ideal rate in tiles per hour (process machines only). */
  idealRatePerHour: number | null;
  /** Mean time between failures (min) and repair-time bounds for the baseline failure model. */
  reliability?: { mtbf: number; repairMin: number; repairMax: number; reasons: string[] };
  signals: string[];
  /** Data source currently feeding this asset. */
  sourceId: string;
};

export type SignalDef = {
  id: string;
  equipmentId: string;
  name: string;
  unit: string;
  kind: 'state' | 'counter' | 'analog' | 'event';
  /** OEE / KPI metrics computed from this signal. */
  metrics: MetricId[];
  sourceId: string;
};

export type MetricId =
  | 'availability'
  | 'performance'
  | 'quality'
  | 'oee'
  | 'output'
  | 'downtime'
  | 'rejects'
  | 'buffer-level'
  | 'energy'
  | 'health'
  | 'turnaround';

// ── Runtime: equipment ────────────────────────────────────────────────────────

export type MachineState =
  | 'running'
  | 'reduced' // running below 95 % of ideal rate
  | 'starved' // ready, no input
  | 'blocked' // ready, output full
  | 'down' // unplanned stop
  | 'planned'; // planned stop (excluded from planned production time)

export type EquipmentRuntime = {
  id: string;
  state: MachineState;
  /** Since when (minute) the current state holds. */
  since: number;
  /** Current rate factor applied to the ideal rate (1 = ideal). */
  rateFactor: number;
  /** Instantaneous output, tiles per hour (last minute). */
  ratePerHour: number;
  /** Lifetime counters since the simulation epoch. */
  countTotal: number;
  countRejectAttributed: number;
  /** Active downtime event id while down/planned. */
  activeDowntimeId: string | null;
};

/** Minute-resolution accounting bucket (one per machine per plant hour). */
export type HourBucket = {
  /** Minutes inside the planned production window. */
  planned: number;
  /** Minutes with output > 0 (operating time). */
  operating: number;
  down: number;
  plannedStop: number;
  starved: number;
  blocked: number;
  /** Tiles produced (total count). */
  count: number;
  /** Rejected tiles attributed to this machine's stage (detected at inspection). */
  rejects: number;
};

export type ProductionCounter = {
  equipmentId: string;
  /** Hour index (minutes / 60, floored) → bucket. */
  hours: Map<number, HourBucket>;
};

// ── Shifts, targets, batches ─────────────────────────────────────────────────

export type ShiftId = 'A' | 'B' | 'C';

export type ShiftInstance = {
  id: ShiftId;
  /** Calendar date (plant time) the shift starts on, YYYY-MM-DD. */
  date: string;
  start: number;
  end: number;
  label: string;
};

export type ProductionTarget = {
  lineId: string;
  /** First-quality tiles per hour of planned time. */
  goodPerHour: number;
  /** Target OEE used to derive the hourly target. */
  oeeTarget: number;
};

export type Product = { sku: string; name: string; format: string; m2PerTile: number };

export type ProductionBatch = {
  id: string;
  sku: string;
  start: number;
  end: number | null;
};

// ── Downtime ──────────────────────────────────────────────────────────────────

export type DowntimeCategory =
  | 'Mechanical'
  | 'Electrical & control'
  | 'Process'
  | 'Changeover'
  | 'Starved'
  | 'Blocked'
  | 'Planned';

export type DowntimeReason = { code: string; label: string; category: DowntimeCategory; planned: boolean };

export type DowntimeEvent = {
  id: string;
  equipmentId: string;
  reasonCode: string;
  category: DowntimeCategory;
  start: number;
  /** null while still active. */
  end: number | null;
  /** Ideal-rate production not made during the event (tiles). */
  lostTiles: number;
  /** Minutes the line constraint was starved/blocked while this event was active. */
  constraintImpactMin: number;
  source: RecordSource;
  scenarioId?: string;
};

// ── Quality ───────────────────────────────────────────────────────────────────

export type DefectCategory = 'crack' | 'chip' | 'surface' | 'glaze' | 'shade' | 'planarity' | 'dimension';

export type InspectionStation = {
  id: string;
  equipmentId: string;
  name: string;
  method: string;
  detects: DefectCategory[];
};

export type QualityInspection = {
  id: string;
  time: number;
  stationId: string;
  batchId: string;
  result: 'reject' | 'pass';
  defect: DefectCategory | null;
  severity: 'minor' | 'major' | 'critical' | null;
  /** Illustrative measurement (e.g. planarity deviation in mm). */
  measurement: string | null;
  /** Rejected tiles represented by this record. */
  tiles: number;
  /** Illustrative vision output (simulated): classification confidence 0–1 and defect box on the tile (0–1 coords). */
  confidence: number | null;
  box: { x: number; y: number; w: number; h: number } | null;
  source: RecordSource;
};

/** Hourly inspection aggregate per station. */
export type QualityBucket = {
  inspected: number;
  rejected: number;
  byDefect: Partial<Record<DefectCategory, number>>;
};

// ── Material flow ─────────────────────────────────────────────────────────────

export type MaterialFlowConnection = {
  id: string;
  from: string;
  to: string;
  /** Conveyor / buffer equipment carrying the flow. */
  via: string | null;
  material: 'raw' | 'intermediate' | 'finished';
};

// ── Logistics ─────────────────────────────────────────────────────────────────

export type VehicleClass = 'external' | 'internal';
export type VehicleType = 'outbound-truck' | 'inbound-tipper' | 'forklift' | 'wheel-loader';

/** One timed movement or stop of a vehicle. Times in fractional plant minutes. */
export type VehicleLeg = {
  start: number;
  end: number;
  /** Polyline [x, z]; a single point for a stop. */
  path: Vec2[];
  /** Drive backwards along the path (reversing onto a dock). */
  reverse?: boolean;
  activity: string;
  /** Logical zone / geofence id the vehicle is in during this leg. */
  zone: string;
  moving: boolean;
  /** Carrying a load (forklift with pallet, truck loaded). */
  loaded?: boolean;
  /** Heading (rad, same convention as the 3D model's rotation.y) while stationary. */
  face?: number;
};

export type VehicleVisitPhase =
  | 'approaching'
  | 'at-gate'
  | 'to-holding'
  | 'waiting'
  | 'to-dock'
  | 'loading'
  | 'unloading'
  | 'weighing'
  | 'departing'
  | 'departed';

export type Vehicle = {
  id: string;
  class: VehicleClass;
  type: VehicleType;
  label: string;
  /** Fictitious carrier / owner. */
  operator: string;
  /** Planned legs; the current pose is interpolated from these at render time. */
  legs: VehicleLeg[];
  /** Internal: zone entry times (kept longer than the pruned legs), for dwell time. */
  zoneLog?: { zone: string; start: number }[];
  /** External: visit timeline (minutes). */
  visit?: TruckVisit;
  /** Internal: current task description. */
  task?: string;
  /** External: current visit phase. */
  phase?: VehicleVisitPhase;
  /** Simulation time the vehicle appeared on (or near) site. */
  spawned: number;
  /** Set when the vehicle has left the site. */
  despawned?: number;
};

export type TruckVisit = {
  direction: 'outbound' | 'inbound';
  arrival: number;
  gateIn: number;
  dockId: string | null;
  /** Minute a dock was assigned (end of waiting). */
  dockAssigned: number | null;
  dockStart: number | null;
  dockEnd: number | null;
  gateOut: number | null;
  /** Pallets (outbound) or tonnes (inbound). */
  load: number;
  material?: string;
  scenarioId?: string;
};

export type Dock = { id: string; name: string; x: number; equipmentId: 'K-DOCK' };

export type Geofence = {
  id: string;
  name: string;
  /** Axis-aligned rectangle on the ground plane. */
  rect: { x: [number, number]; z: [number, number] };
  kind: 'zone' | 'restricted' | 'dock' | 'holding' | 'gate';
  /** Equipment id the geofence belongs to (for navigation). */
  equipmentId?: string;
};

export type GateEvent = {
  id: string;
  time: number;
  vehicleId: string;
  direction: 'in' | 'out';
  source: RecordSource;
};

export type DockEvent = {
  id: string;
  time: number;
  vehicleId: string;
  dockId: string;
  kind: 'assigned' | 'docked' | 'loading-complete' | 'undocked';
  source: RecordSource;
};

export type RestrictedZoneEvent = {
  id: string;
  time: number;
  vehicleId: string;
  geofenceId: string;
  durationMin: number;
  source: RecordSource;
};

// ── Alerts & scenarios ────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'serious' | 'critical';

export type Alert = {
  id: string;
  time: number;
  severity: AlertSeverity;
  title: string;
  detail: string;
  equipmentId?: string;
  vehicleId?: string;
  source: RecordSource;
};

export type ScenarioKind =
  | 'machine-stop'
  | 'reduced-rate'
  | 'bottleneck'
  | 'quality-deterioration'
  | 'truck-arrival'
  | 'yard-congestion'
  | 'prolonged-dock-stay'
  | 'energy-anomaly'
  | 'degradation'
  | 'maintenance'
  | 'conveyor-stop'
  | 'signal-loss'
  | 'restricted-entry';

export type ScenarioActivation = {
  id: string;
  kind: ScenarioKind;
  /** Minute the scenario was activated. */
  start: number;
  /** Minute it ends (null = until cleared). */
  end: number | null;
  equipmentId?: string;
  stage?: StageId;
  /** Rate / capacity factor (0–1) or reject multiplier. */
  factor?: number;
  dockId?: string;
  /** Vehicle the scenario acts on (restricted-zone entry). */
  vehicleId?: string;
  count?: number;
  label: string;
};

// ── Data-source transparency ──────────────────────────────────────────────────

/**
 * Freshness of one feed as the product shows it. 'live' only ever appears for a source that is
 * actually connected and delivering (e.g. a configured camera stream that is playing).
 */
export type FeedStatus = 'simulated' | 'live' | 'stale' | 'disconnected' | 'unavailable';

/** Per-asset data-feed health inside the simulation (a simulated PLC/gateway link). */
export type FeedRuntime = {
  status: 'ok' | 'stale';
  since: number;
  scenarioId?: string;
  /** Last values received before the feed went stale (what a real gateway would still show). */
  lastState?: MachineState;
  lastCount?: number;
  lastRate?: number;
};

/**
 * State shown for an asset, derived only from signal logic or scenarios:
 * a planned stop is not a fault, starvation/blockage are caused elsewhere, and an asset whose
 * data feed is stale is 'unknown' rather than assumed to be running.
 */
export type OperationalState =
  | 'running'
  | 'reduced'
  | 'idle'
  | 'stopped'
  | 'fault'
  | 'starved'
  | 'blocked'
  | 'planned'
  | 'disconnected'
  | 'unknown';

// ── Conveyors ─────────────────────────────────────────────────────────────────

/**
 * A conveyor carrying tiles between stages. While it is stopped, the stages in `blocksInputOf`
 * receive nothing and the stages in `blocksOutputOf` cannot discharge — starvation and blocking
 * then follow through the buffers as on the real line.
 */
export type ConveyorDef = {
  id: string;
  name: string;
  zone: ZoneId;
  kind: 'belt' | 'roller';
  /** Stage feeding the conveyor and stage it delivers to (null = outside the line). */
  from: StageId | null;
  to: StageId | null;
  /** WIP buffer carried on / fed by the conveyor, if any. */
  bufferId: string | null;
  blocksInputOf: StageId[];
  blocksOutputOf: StageId[];
  /** Nominal transport capacity, tiles per hour. */
  capacityPerHour: number;
  /** Nominal belt / roller speed, m/min (signal value while running). */
  speedMpm: number;
  reliability: { mtbf: number; repairMin: number; repairMax: number; reasons: string[] };
};

// ── Cameras ───────────────────────────────────────────────────────────────────

/**
 * A camera position in the plant. Every camera has a simulated feed rendered from the digital twin;
 * a real stream is only used when one is configured and actually plays (see src/ui/feeds).
 */
export type CameraDef = {
  id: string;
  name: string;
  zone: ZoneId;
  stage: StageId | 'WH' | 'YARD' | null;
  /** Equipment / geofence ids visible in this camera's field of view. */
  covers: string[];
  purpose: string;
};

// ── Production monitoring registry ────────────────────────────────────────────

/** A counting point: where and how a quantity is measured (or why it is not). */
export type CountingPoint = {
  label: string;
  unit: string;
  /** Signal providing it, or null when not measured at this stage. */
  signalId: string | null;
  measured: boolean;
  note?: string;
};

export type MonitoredStageId = StageId | 'WH';

/** Configurable monitored stage (the process stages plus warehouse transfer). */
export type MonitoredStage = {
  id: MonitoredStageId;
  name: string;
  step: number;
  zone: ZoneId;
  equipment: string[];
  conveyors: string[];
  cameras: string[];
  input: CountingPoint;
  output: CountingPoint;
  good: CountingPoint | null;
  rejected: CountingPoint | null;
  /** Buffer whose level is this stage's work in progress at its input. */
  wipBufferId: string | null;
  /** Whether a standalone OEE is meaningful for the stage. */
  oeeMeaningful: boolean;
  /** Unit of the stage's own counts (tiles, or pallets for warehouse transfer). */
  unit: 'tiles' | 'pallets';
};

// ── Events & evidence ─────────────────────────────────────────────────────────

export type EventCategory = 'production' | 'quality' | 'logistics' | 'equipment' | 'energy' | 'data';

export type EventType =
  | 'machine-fault'
  | 'machine-stop'
  | 'conveyor-stop'
  | 'below-rate'
  | 'starvation'
  | 'blockage'
  | 'counter-inactive'
  | 'condition-abnormal'
  | 'io-imbalance'
  | 'defect-rate'
  | 'defect-count'
  | 'defect-repeat'
  | 'defect-deterioration'
  | 'critical-defect'
  | 'truck-waiting'
  | 'dock-overstay'
  | 'yard-congestion'
  | 'turnaround-exceeded'
  | 'restricted-entry'
  | 'energy-deviation';

/** Lifecycle: Detected → Active → Acknowledged → Investigating → Resolved. */
export type EventStatus = 'active' | 'acknowledged' | 'investigating' | 'resolved';

export type EventValue = { label: string; value: number | string; unit?: string };

export type EventTrigger = {
  kind: 'signal' | 'rule' | 'model' | 'scenario';
  ruleId: string;
  /** Human description of the rule that fired. */
  description: string;
  signalId?: string;
  observed: EventValue[];
  threshold?: EventValue;
};

export type EventCause = {
  text: string;
  /** confirmed = directly observed; likely / possible = inference from correlated evidence. */
  confidence: 'confirmed' | 'likely' | 'possible';
  basis: string;
  relatedEventId?: string;
};

export type EventHistoryEntry = {
  t: number;
  action: 'detected' | 'updated' | 'escalated' | 'cleared' | 'reopened' | 'acknowledged' | 'owner' | 'investigating' | 'note' | 'resolved' | 'report';
  by: 'system' | 'user';
  text: string;
};

export type OpEvent = {
  id: string;
  category: EventCategory;
  type: EventType;
  severity: AlertSeverity;
  status: EventStatus;
  title: string;
  summary: string;
  /** Condition start; `end` is when the condition cleared (recovery), null while it persists. */
  start: number;
  end: number | null;
  lastUpdate: number;
  asset: {
    equipmentId?: string;
    stage?: MonitoredStageId;
    zone?: ZoneId;
    stationId?: string;
    vehicleId?: string;
    dockId?: string;
    geofenceId?: string;
  };
  trigger: EventTrigger;
  /** Observed facts captured when the event was detected and updated. */
  facts: string[];
  /** Suspected causes — inferences, never presented as confirmed unless observed. */
  causes: EventCause[];
  related: string[];
  evidence: string[];
  refs: { downtimeId?: string; scenarioId?: string; inspectionIds?: string[]; restrictedEventId?: string; defect?: DefectCategory };
  recommendations: string[];
  owner: string | null;
  notes: { t: number; by: string; text: string }[];
  resolution: { t: number; by: 'system' | 'user'; reason: string; action?: string } | null;
  history: EventHistoryEntry[];
  /** Reports exported from this record (plant minute + wall-clock ISO time). */
  reports: { t: number; at: string; format: 'pdf' }[];
  dedupeKey: string;
  source: RecordSource;
  /** Detected during the pre-rolled history (before this demo session began). */
  historical: boolean;
  /** Set when this event is a consequence of another (e.g. kiln starved because a conveyor stopped). */
  consequenceOf?: string;
  /**
   * Impact accumulated minute by minute while the condition is active (see src/sim/impact.ts):
   * asset-level losses, minutes the line constraint was held up because of this event, and the
   * quality / logistics quantities of the event window.
   */
  acc: EventAccumulators;
};

export type EventAccumulators = {
  minutes: number;
  /** Tiles the affected asset did not make vs its typical rate. */
  assetLostTiles: number;
  /** Minutes the kiln (line constraint) was down / starved / blocked because of this event. */
  constraintMin: number;
  /** Kiln output lost in those minutes vs its typical rate (tiles) — the line-level production loss. */
  constraintLostTiles: number;
  /** Kiln typical rate (tiles/min) used for the line-level loss, frozen at detection. */
  kilnTypicalRate: number;
  inspected: number;
  rejects: number;
  /** Reject rate of the 24 h before detection (reference for excess rejects). */
  referenceRejectRate: number | null;
  waitMin: number;
};

export type EvidenceKind =
  | 'state-transition'
  | 'signal-series'
  | 'counter-series'
  | 'camera-snapshot'
  | 'video-ref'
  | 'inspection-image'
  | 'vehicle-timeline'
  | 'metrics'
  | 'related-events';

export type EvidenceSeries = {
  id: string;
  label: string;
  unit: string;
  /** Plant minutes. */
  t: number[];
  v: (number | null)[];
  expected?: (number | null)[];
  limit?: { label: string; value: number };
};

export type Evidence = {
  id: string;
  eventId: string;
  kind: EvidenceKind;
  title: string;
  /** Plant minute the evidence was captured / frozen. */
  capturedAt: number;
  provenance: {
    origin: 'simulation' | 'scenario' | 'digital-twin-render' | 'live-camera' | 'user';
    sourceId: string;
    label: string;
  };
  status: 'available' | 'pending' | 'unavailable';
  unavailableReason?: string;
  series?: EvidenceSeries[];
  transitions?: { t: number; from: string; to: string; note?: string }[];
  image?: { key: string; width: number; height: number; frameTime: number; annotated?: boolean };
  /** Camera responsible for a snapshot / video reference. */
  cameraId?: string;
  inspectionId?: string;
  milestones?: { label: string; t: number | null; note?: string }[];
  metrics?: EventValue[];
  eventIds?: string[];
  /** Video reference window (plant minutes) for 'video-ref' evidence. */
  window?: { from: number; to: number | null };
};

/** Thresholds of the detection rules (editable; take effect from the next simulated minute). */
export type EventRules = {
  belowRateFactor: number;
  belowRateMinutes: number;
  starvedMinutesConstraint: number;
  starvedMinutes: number;
  counterInactiveMinutes: number;
  rejectRateMax: number;
  defectCount30Max: number;
  defectRepeatRecords: number;
  deteriorationRatio: number;
  truckWaitMax: number;
  dockStayMax: number;
  yardQueueMax: number;
  turnaroundMax: number;
  energyDeviationMax: number;
  ioImbalanceMax: number;
};
