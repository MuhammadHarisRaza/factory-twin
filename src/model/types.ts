/**
 * Shared operational data model.
 *
 * Every workspace (Factory Twin, Production & OEE, Quality, Fleet & Logistics,
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
  | 'prolonged-dock-stay';

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
  count?: number;
  label: string;
};
