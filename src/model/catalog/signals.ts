/**
 * The signal catalogue (brief §4–§5) as typed SignalDefinitions:
 *  (a) every signal of the plant registry (src/model/plant.ts SIGNALS, ids kept), described per
 *      equipment with its class, status, engineering range and condition limits;
 *  (b) every simulated process / setpoint / derived / command signal (./process.ts PROCESS_SIGNALS);
 *  (c) the documented not-modelled / unavailable / external signals of the twelve stages
 *      (./stages/s01.ts … s12.ts), so every stage has a credible catalogue.
 *
 * Built at import time from SIGNALS, so it follows changes of the registry. A process spec wins over
 * a registry entry with the same id, and both win over a documented entry — except a stage entry that
 * describes a registry signal as simulated (the level signals of the buffers without equipment). Nothing here is a
 * connection: simulated values are labelled simulated, and `sourceTag` stays null until real tags
 * are mapped at integration (docs/SIGNALS.md).
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { BUFFERS, CONVEYOR_BY_ID, DOCKS, INSPECTION_STATIONS, OPS_BY_ID, SIGNALS } from '../plant';
import type { MachineState, SignalDef } from '../types';
import { CONDITION_LIMITS, temperatureWarning, vibrationWarning } from './condition';
import { KG_PER_TILE, PROCESS_SIGNALS, PROCESS_SIGNAL_BY_ID, type ProcessSignalSpec } from './process';
import { stageOfEquipment } from './stages';
import { DOC_COUNTER } from './stages/doc';
import { S01 } from './stages/s01';
import { S02 } from './stages/s02';
import { S03 } from './stages/s03';
import { S04 } from './stages/s04';
import { S05 } from './stages/s05';
import { S06 } from './stages/s06';
import { S07 } from './stages/s07';
import { S08 } from './stages/s08';
import { S09_SIGNALS } from './stages/s09';
import { S10 } from './stages/s10';
import { S11 } from './stages/s11';
import { S12 } from './stages/s12';
import type { AvailabilityClass, AvailabilityStatus, SignalCategory, SignalDataType, SignalDefinition, SourceSystem } from './types';

/** The simulation produces one value per plant minute for every scanned signal. */
const SCAN_S = 60;

/** Raw values of the registry's `state` / `run_state` signals (the engine's machine states). */
export const MACHINE_STATE_VALUES = ['running', 'reduced', 'starved', 'blocked', 'down', 'planned'] as const satisfies readonly MachineState[];

/** Counter semantics of the simulated registry counters. */
const SIM_COUNTER: SignalDefinition['counter'] = {
  rolloverAt: null,
  resetOn: "Not reset in normal simulation (cumulative from its start); the real counter's reset (shift, changeover, power cycle) is confirmed at integration",
};

/** Registry units that are not engineering units. */
const NON_UNITS = new Set(['enum', 'code', 'in/out', 'zone id', 'pass/fail']);

const TILE_EQ_NOTE = "Simulated in tile-equivalents, the simulation's unit for slip and powder — not tiles.";
const CONDITION_NOTE = 'Simulated condition model (machine load and a hidden degradation severity) — no condition-monitoring sensor is connected.';

/** What each process machine's counter counts. */
const OUTPUT: Record<string, string> = {
  'C-BM1': 'slip milled',
  'C-BM2': 'slip milled',
  'C-BM3': 'slip milled',
  'D-TWR': 'powder spray-dried',
  'E-PRS1': 'green tiles pressed',
  'E-PRS2': 'green tiles pressed',
  'E-PRS3': 'green tiles pressed',
  'F-DRY': 'dried tiles leaving the dryer',
  'G-LINE': 'tiles glazed',
  'G-INK': 'tiles printed',
  'H-KILN': 'fired tiles discharged at the kiln exit',
  'I-SORT': 'tiles sorted (accepted and rejected)',
  'J-BOX': 'tiles packed into cartons',
  'J-PAL': 'tiles palletised',
};

/**
 * Process analogs of the early registry that never had a physical model. Listed as not-modelled
 * (no value), pointing at the simulated replacement where PROCESS_SIGNALS has one.
 */
const PLACEHOLDERS: Record<
  string,
  { name: string; description: string; cls: AvailabilityClass; replacedBy: string[]; missing: string; category?: SignalCategory; source?: SourceSystem }
> = {
  temp_firing: {
    name: 'Firing temperature (single value)',
    description: 'Single firing-zone temperature of the roller kiln (early registry entry).',
    cls: 'core',
    replacedBy: ['H-KILN.zone2_temp_pv', 'H-KILN.zone3_temp_pv'],
    missing: 'thermal model of the kiln',
  },
  temp_preheat: {
    name: 'Pre-heating temperature (single value)',
    description: 'Single pre-heating-zone temperature of the roller kiln (early registry entry).',
    cls: 'core',
    replacedBy: ['H-KILN.zone1_temp_pv'],
    missing: 'thermal model of the kiln',
  },
  temp_inlet: {
    name: 'Hot-air inlet temperature (single value)',
    description: 'Hot-air temperature at the spray dryer inlet (early registry entry).',
    cls: 'core',
    replacedBy: ['D-TWR.inlet_temp_pv'],
    missing: 'thermal model of the spray dryer',
  },
  powder_moisture: {
    name: 'Powder moisture (single value)',
    description: 'Residual moisture of the spray-dried powder (early registry entry).',
    cls: 'conditional',
    replacedBy: ['D-TWR.powder_moisture_pv'],
    missing: 'drying model',
  },
  temp_deck: {
    name: 'Dryer deck temperature (single value)',
    description: 'Single deck temperature of the roller dryer (early registry entry).',
    cls: 'core',
    replacedBy: ['F-DRY.zone1_temp_pv', 'F-DRY.zone2_temp_pv'],
    missing: 'thermal model of the dryer',
  },
  header_pressure: {
    name: 'Compressed-air header pressure',
    description: 'Pressure in the compressed-air header supplying the presses, glazing and packaging equipment.',
    cls: 'core',
    replacedBy: [],
    missing: 'compressed-air network model',
    source: 'SCADA',
  },
  tank_level: {
    name: 'Water tank level',
    description: 'Level of the process and fire-water storage tanks.',
    cls: 'core',
    replacedBy: [],
    missing: 'water-supply model',
    category: 'material',
    source: 'SCADA',
  },
};
export const PLACEHOLDER_SIGNAL_NAMES = Object.keys(PLACEHOLDERS);

/** Energy signals of the registry: energy metering is not part of this demo's data. */
export const ENERGY_SIGNAL_NAMES = ['energy_kwh', 'active_power', 'gas_flow'];
const ENERGY_NOTE = "Energy metering is not part of this demo's data — the illustrative energy model is not a product data source.";

type RegistrySpec = {
  name: string;
  description: string;
  category: SignalCategory;
  dataType: SignalDataType;
  cls: AvailabilityClass;
  /** Default: PLC. */
  source?: SourceSystem;
  /** Default: the registry unit (null for enum / code / identifier units). */
  unit?: string | null;
  enumValues?: string[];
  /** Default: simulated. */
  status?: AvailabilityStatus;
  note?: string;
  /** Event-driven: no expected update interval. */
  event?: boolean;
  eng?: [number, number];
  limits?: Pick<SignalDefinition, 'warningLow' | 'warningHigh' | 'alarmLow' | 'alarmHigh'>;
  counter?: boolean;
  metadata?: SignalDefinition['metadata'];
};

function make(def: SignalDef, o: RegistrySpec): SignalDefinition {
  const status = o.status ?? 'simulated';
  const d: SignalDefinition = {
    signalId: def.id,
    equipmentId: def.equipmentId,
    name: o.name,
    description: o.description,
    category: o.category,
    unit: o.unit !== undefined ? o.unit : NON_UNITS.has(def.unit) ? null : def.unit,
    dataType: o.dataType,
    sourceSystem: o.source ?? 'PLC',
    sourceTag: null,
    availabilityClass: o.cls,
    availabilityStatus: status,
    expectedUpdateIntervalS: status === 'simulated' && !o.event ? SCAN_S : null,
    stage: stageOfEquipment(def.equipmentId),
    metadata: { registryKind: def.kind, registryUnit: def.unit, ...(def.metrics.length ? { metrics: def.metrics.join(', ') } : {}), ...o.metadata },
  };
  if (o.enumValues) d.enumValues = o.enumValues;
  if (o.note) d.statusNote = o.note;
  if (o.eng) [d.engineeringMin, d.engineeringMax] = o.eng;
  if (o.limits) Object.assign(d, o.limits);
  // A counter the demo does not produce (e.g. an energy meter) has no simulated reset behaviour to describe.
  if (o.counter) d.counter = status === 'simulated' ? SIM_COUNTER : DOC_COUNTER;
  return d;
}

/** Lower-cases the first letter of a name unless it starts with an acronym ("QC inspection bench"). */
const lower = (name: string) => (/^[A-Z]{2}/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1));

/** Stages 1–2 count slip and powder in tile-equivalents. */
const isTileEq = (equipmentId: string) => {
  const st = stageOfEquipment(equipmentId);
  return st === 1 || st === 2;
};
const tileEqUnit = (unit: string) => (unit === 'tiles' ? 'tile-eq' : unit === 'tiles/h' ? 'tile-eq/h' : unit);
/** The simulated mass flow (t/h) of a slip / powder machine, if PROCESS_SIGNALS has one. */
const massFlowOf = (equipmentId: string) => PROCESS_SIGNALS.find((p) => p.equipmentId === equipmentId && p.unit === 't/h') ?? null;
const tileEqNote = (equipmentId: string) => {
  const flow = massFlowOf(equipmentId);
  return flow ? `${TILE_EQ_NOTE} The mass flow is ${flow.id} (simulated conversion).` : TILE_EQ_NOTE;
};

/** (a) A registry signal as a SignalDefinition. */
function fromRegistry(def: SignalDef): SignalDefinition {
  const id = def.equipmentId;
  const label = EQUIPMENT_BY_ID[id]?.name ?? id;
  const the = `the ${lower(label)}`;
  const teq = isTileEq(id);
  const placeholder = Object.hasOwn(PLACEHOLDERS, def.name) ? PLACEHOLDERS[def.name] : undefined;
  if (placeholder) {
    const replacements = placeholder.replacedBy.filter((r) => PROCESS_SIGNAL_BY_ID[r]);
    return make(def, {
      name: placeholder.name,
      description: placeholder.description,
      category: placeholder.category ?? 'process',
      dataType: 'float',
      cls: placeholder.cls,
      source: placeholder.source,
      status: 'not-modelled',
      note: replacements.length
        ? `Placeholder without a physical model — no value is shown. Superseded by the simulated ${replacements.join(' / ')}.`
        : `Placeholder without a physical model — no value is shown (the demo has no ${placeholder.missing}).`,
    });
  }
  if (ENERGY_SIGNAL_NAMES.includes(def.name)) {
    const energy =
      def.name === 'energy_kwh'
        ? { name: 'Energy consumption', description: `Cumulative energy consumption of ${the} (sub-meter).` }
        : def.name === 'gas_flow'
          ? { name: 'Gas flow', description: 'Natural-gas flow through the metering skid (spray dryer hot-air generator, dryer and kiln).' }
          : id === 'A-SUB'
            ? { name: 'Site active power', description: 'Site electrical demand at the incoming substation.' }
            : { name: 'Active power', description: `Electrical active power of ${the}.` };
    return make(def, {
      ...energy,
      category: 'energy',
      dataType: 'float',
      cls: 'conditional',
      source: 'SCADA',
      status: 'unavailable',
      note: ENERGY_NOTE,
      counter: def.kind === 'counter',
    });
  }

  const ops = OPS_BY_ID[id];
  const what = OUTPUT[id] ?? 'units produced';
  const cond = CONDITION_LIMITS[id];
  switch (def.name) {
    case 'state':
      return make(def, {
        name: 'Machine state',
        description: `Machine state of ${the}: running, reduced rate, starved (no input), blocked (output full), down (unplanned stop) or planned stop.`,
        category: 'state',
        dataType: 'enum',
        enumValues: [...MACHINE_STATE_VALUES],
        cls: 'core',
      });
    case 'count_total':
      return make(def, {
        name: teq ? 'Output counter · tile-equivalent' : 'Output counter',
        description: teq
          ? `Cumulative ${what} by ${the}, in tile-equivalents. A real line meters slip and powder by mass flow, not with a unit counter.`
          : `Cumulative count of ${what} by ${the}.`,
        category: 'production',
        dataType: 'integer',
        unit: teq ? tileEqUnit(def.unit) : def.unit,
        cls: 'core',
        counter: true,
        note: teq ? tileEqNote(id) : undefined,
      });
    case 'rate': {
      const ideal = ops?.idealRatePerHour ?? null;
      const unit = teq ? tileEqUnit(def.unit) : def.unit;
      return make(def, {
        name: teq ? 'Output rate · tile-equivalent' : 'Output rate',
        description: `Current output rate of ${the} (${what} per hour)${ideal ? `; ideal rate ${ideal.toLocaleString('en-GB')} ${unit}` : ''}.`,
        category: 'production',
        dataType: 'float',
        unit,
        cls: 'core',
        eng: ideal ? [0, Math.round(ideal * 1.25)] : undefined,
        note: teq ? tileEqNote(id) : undefined,
        metadata: ideal ? { idealRatePerHour: ideal } : undefined,
      });
    }
    case 'alarm': {
      const reasons = ops?.reliability?.reasons ?? [];
      return make(def, {
        name: 'Active alarm / stop code',
        description: `Active alarm or unplanned stop reason code of ${the}${reasons.length ? ` (e.g. ${reasons.join(', ')})` : ''}; "none" without an unplanned stop.`,
        category: 'alarm',
        dataType: 'string',
        cls: 'core',
        event: true,
      });
    }
    case 'level': {
      const b = BUFFERS.find((x) => x.equipmentId === id);
      const capacity = b ? `; 100 % = ${b.capacity.toLocaleString('en-GB')} ${teq ? 'tile-equivalents' : 'tiles'}` : '';
      const silo = id === 'D-SILO' ? ' Level is not mass: the silo mass needs a level-to-mass calibration or load cells (D-SILO.powder_mass).' : '';
      return make(def, {
        name: 'Level',
        description: `Fill level of the ${lower(b?.name ?? label)} as a share of the buffer capacity${capacity}.${silo}`,
        category: 'material',
        dataType: 'float',
        unit: '%',
        // E-COL is a conveyor: its "level" is an accumulation estimate from photo-eyes, not a level sensor.
        cls: CONVEYOR_BY_ID[id] ? 'conditional' : 'core',
        eng: [0, 100],
        note: teq ? `${TILE_EQ_NOTE} The level % is simulated from the buffer content.` : undefined,
        metadata: b ? { bufferId: b.id, capacity: b.capacity } : undefined,
      });
    }
    case 'count_inspected':
    case 'count_rejected': {
      const st = INSPECTION_STATIONS.find((x) => x.equipmentId === id);
      const vision = !!st && /camera/i.test(st.method);
      const inspected = def.name === 'count_inspected';
      return make(def, {
        name: inspected ? 'Tiles inspected' : 'Tiles rejected',
        description: inspected
          ? `Tiles checked by ${the}, cumulative.`
          : `Tiles rejected by ${the}${st?.detects.length ? ` (${st.detects.join(', ')})` : ''}, cumulative.`,
        category: 'quality',
        dataType: 'integer',
        cls: vision ? 'external' : 'conditional',
        source: vision ? 'vision' : 'PLC',
        counter: true,
        note: vision
          ? 'Simulated inspection records — no computer vision runs; a connected vision system would provide these counts.'
          : 'Simulated inspection records (pass / reject), not gauge measurements.',
      });
    }
    case 'sample_result':
      return make(def, {
        name: 'Last QC sample result',
        description: `Result of the latest sample check at ${the} against reference tiles.`,
        category: 'quality',
        dataType: 'enum',
        enumValues: ['pass', 'fail'],
        cls: 'external',
        source: 'QMS',
        event: true,
        note: 'Simulated sample records; no QMS is connected.',
      });
    case 'count_good':
      return make(def, {
        name: 'Good tiles (accepted)',
        description: `Tiles accepted at ${the} (the line's good output; the simulation does not grade), cumulative.`,
        category: 'production',
        dataType: 'integer',
        cls: 'core',
        counter: true,
      });
    case 'gate_event':
      return make(def, {
        name: 'Gate event',
        description: `Latest passage at ${the}: direction (in / out) and vehicle.`,
        category: 'logistics',
        dataType: 'enum',
        enumValues: ['in', 'out'],
        cls: 'external',
        source: 'telematics',
        event: true,
        note: 'Simulated gate events from the logistics model; no gate system is connected.',
      });
    case 'dock_occupancy':
      return make(def, {
        name: 'Docks occupied',
        description: `Number of the ${DOCKS.length} dock doors occupied by a truck.`,
        category: 'logistics',
        dataType: 'integer',
        cls: 'external',
        source: 'WMS',
        eng: [0, DOCKS.length],
        note: 'Simulated dock occupancy from the logistics model; no dock sensors or WMS are connected.',
      });
    case 'vehicle_zone':
      return make(def, {
        name: 'Vehicle zone',
        description: id === 'K-FLT' ? 'Zone (geofence) of each active forklift.' : `Zone (geofence) of ${the}.`,
        category: 'logistics',
        dataType: 'string',
        cls: 'external',
        source: 'telematics',
        event: true,
        note: 'Simulated positions from the logistics model, reduced to a zone — not GPS, RTLS or telematics.',
      });
    case 'run_state':
      return make(def, {
        name: 'Run state',
        description: `Run state of ${the}: running, running empty (starved), accumulating (blocked), stopped, or stopped for a planned stop.`,
        category: 'state',
        dataType: 'enum',
        enumValues: [...MACHINE_STATE_VALUES],
        cls: 'core',
      });
    case 'speed': {
      const c = CONVEYOR_BY_ID[id];
      return make(def, {
        name: 'Speed',
        description: c
          ? `${c.kind === 'belt' ? 'Belt' : 'Roller'} speed of ${the} (nominal ${c.speedMpm} m/min), from the drive.`
          : `Speed of ${the}, from the drive.`,
        category: 'drive',
        dataType: 'float',
        cls: 'conditional',
        eng: c ? [0, Math.ceil(c.speedMpm * 1.5)] : undefined,
        metadata: c ? { nominal: c.speedMpm } : undefined,
      });
    }
    case 'tile_count':
      return make(def, {
        name: teq ? 'Material counter · tile-equivalent' : 'Tile counter',
        description: teq
          ? `Powder moved by ${the} to the press hoppers, in tile-equivalents, cumulative.`
          : `Tiles moved by ${the} (photo-eye count), cumulative.`,
        category: 'production',
        dataType: 'integer',
        unit: teq ? tileEqUnit(def.unit) : def.unit,
        cls: 'core',
        counter: true,
        note: teq ? TILE_EQ_NOTE : undefined,
      });
    case 'vibration':
      return make(def, {
        name: 'Vibration',
        description: cond
          ? `Vibration velocity at the ${cond.component.toLowerCase()} of ${the} (healthy at full load ≈ ${cond.vib.full} mm/s RMS).`
          : `Vibration velocity of ${the}.`,
        category: 'condition',
        dataType: 'float',
        cls: 'conditional',
        note: CONDITION_NOTE,
        eng: cond ? [0, Math.ceil(cond.vib.trip * 1.5)] : undefined,
        limits: cond ? { warningHigh: vibrationWarning(cond), alarmHigh: cond.vib.alarm } : undefined,
        metadata: cond ? { component: cond.component, healthyFullLoad: cond.vib.full, tripLimit: cond.vib.trip } : undefined,
      });
    case 'temperature':
      return make(def, {
        name: 'Bearing / oil temperature',
        description: cond
          ? `Temperature at the ${cond.component.toLowerCase()} of ${the} (healthy at full load ≈ ${cond.temp.full} °C).`
          : `Bearing / oil temperature of ${the}.`,
        category: 'condition',
        dataType: 'float',
        cls: 'conditional',
        note: CONDITION_NOTE,
        eng: [0, 150],
        limits: cond ? { warningHigh: temperatureWarning(cond), alarmHigh: cond.temp.alarm } : undefined,
        metadata: cond ? { component: cond.component, healthyFullLoad: cond.temp.full, tripLimit: cond.temp.trip } : undefined,
      });
    case 'motor_current':
      return make(def, {
        name: 'Motor current',
        description: cond ? `Main drive motor current of ${the} (rated ${cond.currentRated} A).` : `Main drive motor current of ${the}.`,
        category: 'condition',
        dataType: 'float',
        cls: 'conditional',
        note: CONDITION_NOTE,
        eng: cond ? [0, Math.ceil(cond.currentRated * 1.5)] : undefined,
        metadata: cond ? { ratedCurrentA: cond.currentRated } : undefined,
      });
    default:
      // A registry signal this catalogue does not know yet: described generically, still simulated.
      return make(def, {
        name: def.name.replace(/_/g, ' '),
        description: `${def.name.charAt(0).toUpperCase()}${def.name.slice(1).replace(/_/g, ' ')} of ${the} (registry signal).`,
        category: def.kind === 'state' ? 'state' : def.kind === 'counter' ? 'production' : def.kind === 'event' ? 'alarm' : 'process',
        dataType: def.kind === 'state' ? 'enum' : def.kind === 'counter' ? 'integer' : def.kind === 'event' ? 'string' : 'float',
        cls: 'core',
        event: def.kind === 'event',
        counter: def.kind === 'counter',
      });
  }
}

const isProcessCounter = (p: ProcessSignalSpec) => p.role === 'derived' && /_count$/.test(p.id);

function processNote(p: ProcessSignalSpec): string {
  switch (p.role) {
    case 'command':
      return 'Simulated: on while the machine is enabled (not in a planned stop and not down); the running feedback is its state signal.';
    case 'sp':
      return 'Simulated recipe / operator setpoint (nominal value).';
    case 'pv':
      return p.pairId
        ? 'Simulated process model: follows its setpoint with deterministic noise and responds to machine stops and process-deviation scenarios — not plant telemetry.'
        : 'Simulated process model with deterministic noise that responds to machine stops — not plant telemetry.';
    case 'derived':
      if (p.unit === 't/h')
        return `Derived from the simulated production rate with the simulated conversion ${KG_PER_TILE.toFixed(2)} kg per tile (KG_PER_TILE) — not a measured mass flow.`;
      return isProcessCounter(p) ? 'Derived from the simulated tile counters.' : 'Derived from the simulated production state.';
  }
}

/** (b) A simulated process / setpoint / derived / command signal as a SignalDefinition. */
function fromProcess(p: ProcessSignalSpec): SignalDefinition {
  const counter = isProcessCounter(p);
  const d: SignalDefinition = {
    signalId: p.id,
    equipmentId: p.equipmentId,
    name: p.name,
    description: p.description,
    category: p.category,
    unit: p.unit,
    dataType: p.role === 'command' ? 'boolean' : counter ? 'integer' : 'float',
    sourceSystem: p.sourceSystem,
    sourceTag: null,
    availabilityClass: p.availabilityClass,
    availabilityStatus: 'simulated',
    statusNote: processNote(p),
    expectedUpdateIntervalS: SCAN_S,
    stage: stageOfEquipment(p.equipmentId),
    metadata: {
      role: p.role,
      digits: p.digits,
      ...(p.nominal != null && !counter ? { nominal: p.nominal } : {}),
      ...(p.stopped ? { whenStopped: p.stopped.kind } : {}),
      ...(p.role === 'sp' && p.pairId ? { pvSignalId: p.pairId } : {}),
      ...p.metadata,
    },
  };
  if (p.engineeringMin != null) d.engineeringMin = p.engineeringMin;
  if (p.engineeringMax != null) d.engineeringMax = p.engineeringMax;
  if (p.warningLow != null) d.warningLow = p.warningLow;
  if (p.warningHigh != null) d.warningHigh = p.warningHigh;
  if (p.alarmLow != null) d.alarmLow = p.alarmLow;
  if (p.alarmHigh != null) d.alarmHigh = p.alarmHigh;
  if (p.role === 'pv' && p.pairId) d.setpointSignalId = p.pairId;
  if (counter) d.counter = SIM_COUNTER;
  return d;
}

/** (c) Documented entries of the twelve stages. */
const DOCUMENTED: SignalDefinition[] = [...S01, ...S02, ...S03, ...S04, ...S05, ...S06, ...S07, ...S08, ...S09_SIGNALS, ...S10, ...S11, ...S12];

const PROCESS_IDS = new Set(PROCESS_SIGNALS.map((p) => p.id));
/**
 * Registry signals a stage file describes itself as simulated (the hosted buffer levels, stages/doc.ts
 * bufferLevel): the stage entry keeps its name, description and class, so the registry copy is not built.
 */
const DESCRIBED = new Set(DOCUMENTED.filter((d) => d.availabilityStatus === 'simulated' && SIGNALS.some((s) => s.id === d.signalId)).map((d) => d.signalId));
const REGISTRY = SIGNALS.filter((s) => !PROCESS_IDS.has(s.id) && !DESCRIBED.has(s.id)).map(fromRegistry);
const KNOWN = new Set([...REGISTRY.map((d) => d.signalId), ...PROCESS_IDS]);

/** The whole catalogue: registry signals, simulated process signals, documented (and stage-described simulated) entries. */
export const CATALOG: SignalDefinition[] = [...REGISTRY, ...PROCESS_SIGNALS.map(fromProcess), ...DOCUMENTED.filter((d) => !KNOWN.has(d.signalId))];
