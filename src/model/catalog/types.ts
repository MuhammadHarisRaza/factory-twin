/**
 * The typed equipment / signal catalogue (brief §4–§5): what a PLC, controller or connected system
 * COULD provide for each piece of equipment, how likely it is to exist, and what this demo actually
 * has. Nothing here claims plant connectivity: every signal's `availabilityStatus` says whether the
 * demo simulation produces a value ('simulated'), has no model for it ('not-modelled'), or would need
 * an instrument / integration that is not configured ('unavailable'). 'connected' is reserved for a
 * real, verified integration — no signal in this release has it.
 *
 * The catalogue keeps the existing signal ids (src/model/plant.ts SIGNALS: `<equipmentId>.<name>`)
 * and adds the process / command signals of src/model/catalog/process.ts and documented
 * not-modelled / unavailable entries, so coverage can be shown honestly per equipment and stage.
 */
import type { MonitoredStageId } from '../types';

/**
 * How likely a real controller is to expose the signal (never a statement of connectivity):
 * - core: commonly useful and commonly available, still to be confirmed on the actual machine;
 * - conditional: only when the relevant controller / sensor / drive / system supports it;
 * - external: normally from another system (MES, historian, SCADA, QMS, WMS, barcode/RFID, CMMS, vision).
 */
export type AvailabilityClass = 'core' | 'conditional' | 'external';

export const AVAILABILITY_CLASS_LABEL: Record<AvailabilityClass, string> = {
  core: 'Core candidate',
  conditional: 'Conditional',
  external: 'External integration',
};

export const AVAILABILITY_CLASS_HINT: Record<AvailabilityClass, string> = {
  core: 'Commonly useful and commonly exposed by the machine controller — still to be confirmed on the actual machine.',
  conditional: 'Available only when the relevant controller program, sensor, drive or connected system supports it.',
  external: 'Normally comes from another system (MES, historian, SCADA, QMS, WMS, barcode/RFID, CMMS or computer vision).',
};

/** What this demo has for the signal. */
export type AvailabilityStatus = 'simulated' | 'not-modelled' | 'unavailable' | 'connected' | 'reference';

export const AVAILABILITY_STATUS_LABEL: Record<AvailabilityStatus, string> = {
  simulated: 'Simulated',
  'not-modelled': 'Not modelled',
  unavailable: 'Unavailable',
  connected: 'Connected',
  reference: 'Reference',
};

/** Functional category used for filtering and grouping. */
export type SignalCategory =
  | 'state'
  | 'command'
  | 'production'
  | 'process'
  | 'setpoint'
  | 'drive'
  | 'condition'
  | 'material'
  | 'quality'
  | 'alarm'
  | 'recipe'
  | 'logistics'
  | 'communication'
  | 'energy';

export const SIGNAL_CATEGORY_LABEL: Record<SignalCategory, string> = {
  state: 'State',
  command: 'Command',
  production: 'Production',
  process: 'Process',
  setpoint: 'Setpoint',
  drive: 'Drive',
  condition: 'Condition',
  material: 'Material',
  quality: 'Quality',
  alarm: 'Alarm',
  recipe: 'Recipe / batch',
  logistics: 'Logistics',
  communication: 'Communication',
  energy: 'Energy',
};

export type SignalDataType = 'boolean' | 'enum' | 'integer' | 'float' | 'string' | 'timestamp';

/** The kind of system that would provide the signal in a real plant (documentation, not a connection). */
export type SourceSystem = 'PLC' | 'SCADA' | 'historian' | 'MES' | 'QMS' | 'WMS' | 'vision' | 'telematics' | 'CMMS' | 'simulated' | 'reference';

export const SOURCE_SYSTEM_LABEL: Record<SourceSystem, string> = {
  PLC: 'PLC / machine controller',
  SCADA: 'SCADA',
  historian: 'Historian',
  MES: 'MES',
  QMS: 'QMS / lab',
  WMS: 'WMS',
  vision: 'Vision system',
  telematics: 'Telematics / RTLS',
  CMMS: 'CMMS',
  simulated: 'Demo simulation',
  reference: 'Reference data',
};

/** The brief's twelve production stages. */
export type ProductionStageNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type SignalDefinition = {
  signalId: string;
  equipmentId: string;
  name: string;
  description: string;
  category: SignalCategory;
  /** Engineering unit (null for states, events and identifiers). */
  unit: string | null;
  dataType: SignalDataType;
  /** Allowed values of an enum signal. */
  enumValues?: string[];
  /** The system that would provide it in a real plant. */
  sourceSystem: SourceSystem;
  /**
   * The controller tag / address. Always null in this release: real tags are mapped at integration
   * time — the demo never invents PLC addresses.
   */
  sourceTag: null;
  availabilityClass: AvailabilityClass;
  availabilityStatus: AvailabilityStatus;
  /** Why the status is what it is (shown in the signal detail), e.g. "No online moisture analyser in the model". */
  statusNote?: string;
  /** Expected update interval in seconds (null for event-driven or not-modelled signals). */
  expectedUpdateIntervalS: number | null;
  engineeringMin?: number;
  engineeringMax?: number;
  warningLow?: number;
  warningHigh?: number;
  alarmLow?: number;
  alarmHigh?: number;
  /** The setpoint signal this process value is controlled to. */
  setpointSignalId?: string;
  /** Counter semantics: where it rolls over (null = no rollover modelled) and what resets it. */
  counter?: { rolloverAt: number | null; resetOn?: string };
  /** Production stage (1–12) this signal belongs to; null for site utilities and support assets. */
  stage: ProductionStageNo | null;
  /** Free metadata (e.g. { zone: 3, role: 'firing' }). */
  metadata?: Record<string, string | number | boolean>;
};

/** One of the brief's twelve production stages and how this representative plant maps onto it. */
export type ProductionStageDef = {
  no: ProductionStageNo;
  /** Short stable id, e.g. 'S07'. */
  id: string;
  name: string;
  purpose: string;
  /** The existing monitored stage it is shown under (production views, filters), if any. */
  monitoredStage: MonitoredStageId | null;
  /** Existing equipment ids (src/data/equipment.ts) that belong to the stage. */
  equipment: string[];
  /** Buffers (src/model/plant.ts BUFFERS ids) that belong to the stage. */
  buffers: string[];
  /** Whether the representative 3D plant has equipment for this stage. */
  present: 'yes' | 'partial' | 'no';
  /** Mapping notes, e.g. why a stage has no 3D equipment and what to configure. */
  note: string;
};
