/**
 * Static configuration of the reference plant: line, stages, buffers, equipment
 * operational metadata, signals, downtime reasons, inspection stations, docks,
 * geofences and data sources. Equipment ids are the same ids as the 3D model's
 * <Selectable> objects (src/data/equipment.ts), so every record maps to geometry.
 */
import { EQUIPMENT } from '../data/equipment';
import type {
  BufferDef,
  DataSource,
  DefectCategory,
  Dock,
  DowntimeReason,
  EquipmentCategory,
  EquipmentOps,
  Factory,
  Geofence,
  InspectionStation,
  MaterialFlowConnection,
  ProcessStage,
  Product,
  ProductionLine,
  ProductionTarget,
  ScenarioKind,
  SignalDef,
  StageId,
  ZoneId,
} from './types';

export const FACTORY: Factory = {
  id: 'PLANT-01',
  name: 'Ceramic Tile Plant · Reference facility',
  reference: 'Representative ceramic tile plant; reference context Ghani Ceramics. Not a reproduction of any real site.',
  timezoneLabel: 'Plant time',
};

export const PRODUCTS: Product[] = [
  { sku: 'FT-6060-BEI-M', name: 'Floor tile 60×60 · Beige matt', format: '60×60 cm', m2PerTile: 0.36 },
  { sku: 'FT-6060-GRY-P', name: 'Floor tile 60×60 · Grey polished', format: '60×60 cm', m2PerTile: 0.36 },
  { sku: 'FT-6060-WOD-S', name: 'Floor tile 60×60 · Wood-look satin', format: '60×60 cm', m2PerTile: 0.36 },
];
/** All products share one format, so tiles ↔ m² is a single factor. */
export const M2_PER_TILE = 0.36;
/** Finished pallet: 40 cartons × 6 tiles. */
export const TILES_PER_PALLET = 240;

export const LINE: ProductionLine = {
  id: 'LINE-1',
  name: 'Tile line 1',
  stages: ['PREP', 'SPRAY', 'PRESS', 'DRY', 'GLAZE', 'DECOR', 'KILN', 'SORT', 'PACK', 'PAL'],
  outputStage: 'SORT',
  designConstraint: 'KILN',
};

export const BUFFERS: BufferDef[] = [
  { id: 'BUF-SLIP', name: 'Slip tanks', equipmentId: 'C-SLIP', capacity: 6000, initialFill: 0.55 },
  { id: 'BUF-SILO', name: 'Powder silos', equipmentId: 'D-SILO', capacity: 12000, initialFill: 0.6 },
  { id: 'BUF-COL', name: 'Green-tile collector', equipmentId: 'E-COL', capacity: 120, initialFill: 0.3 },
  { id: 'BUF-DRY', name: 'Tile buffer storage', equipmentId: 'F-BUF', capacity: 1800, initialFill: 0.4 },
  { id: 'BUF-GLZ', name: 'Glaze → decoration transfer', equipmentId: null, capacity: 180, initialFill: 0.5 },
  { id: 'BUF-KIN', name: 'Kiln infeed', equipmentId: null, capacity: 700, initialFill: 0.7 },
  { id: 'BUF-KOUT', name: 'Kiln outfeed', equipmentId: null, capacity: 150, initialFill: 0.3 },
  { id: 'BUF-SORT', name: 'Accumulation buffer', equipmentId: 'I-BUF', capacity: 1500, initialFill: 0.3 },
  { id: 'BUF-PACK', name: 'Carton transfer', equipmentId: null, capacity: 120, initialFill: 0.3 },
];

export const STAGES: ProcessStage[] = [
  { id: 'PREP', name: 'Body preparation', step: 2, zone: 'C', machines: ['C-BM1', 'C-BM2', 'C-BM3'], inputBuffer: null },
  { id: 'SPRAY', name: 'Spray drying', step: 3, zone: 'D', machines: ['D-TWR'], inputBuffer: 'BUF-SLIP' },
  { id: 'PRESS', name: 'Pressing', step: 4, zone: 'E', machines: ['E-PRS1', 'E-PRS2', 'E-PRS3'], inputBuffer: 'BUF-SILO' },
  { id: 'DRY', name: 'Drying', step: 5, zone: 'F', machines: ['F-DRY'], inputBuffer: 'BUF-COL' },
  { id: 'GLAZE', name: 'Glazing', step: 6, zone: 'G', machines: ['G-LINE'], inputBuffer: 'BUF-DRY' },
  { id: 'DECOR', name: 'Digital decoration', step: 6, zone: 'G', machines: ['G-INK'], inputBuffer: 'BUF-GLZ' },
  { id: 'KILN', name: 'Firing', step: 7, zone: 'H', machines: ['H-KILN'], inputBuffer: 'BUF-KIN' },
  { id: 'SORT', name: 'Sorting & inspection', step: 8, zone: 'I', machines: ['I-SORT'], inputBuffer: 'BUF-KOUT' },
  { id: 'PACK', name: 'Packing', step: 9, zone: 'J', machines: ['J-BOX'], inputBuffer: 'BUF-SORT' },
  { id: 'PAL', name: 'Palletising', step: 9, zone: 'J', machines: ['J-PAL'], inputBuffer: 'BUF-PACK' },
];
export const STAGE_BY_ID = Object.fromEntries(STAGES.map((s) => [s.id, s])) as Record<StageId, ProcessStage>;

/** Output buffer of each stage (the next stage's input buffer). */
export const OUTPUT_BUFFER: Record<StageId, string | null> = Object.fromEntries(
  STAGES.map((s, i) => [s.id, STAGES[i + 1]?.inputBuffer ?? null]),
) as Record<StageId, string | null>;

export const TARGET: ProductionTarget = { lineId: 'LINE-1', goodPerHour: Math.round(1250 * 0.88), oeeTarget: 0.88 };

/** Display names of scenario kinds (shared by every workspace). */
export const SCENARIO_KIND_LABELS: Record<ScenarioKind, string> = {
  'machine-stop': 'Machine breakdown',
  'reduced-rate': 'Reduced production rate',
  bottleneck: 'Production bottleneck',
  'quality-deterioration': 'Quality deterioration',
  'truck-arrival': 'Truck arrival',
  'yard-congestion': 'Yard congestion',
  'prolonged-dock-stay': 'Prolonged dock stay',
  'energy-anomaly': 'Energy anomaly',
  degradation: 'Developing machine fault',
  maintenance: 'Condition-based maintenance',
};

export const DOWNTIME_REASONS: DowntimeReason[] = [
  { code: 'MECH_HYD', label: 'Hydraulic pressure fault', category: 'Mechanical', planned: false },
  { code: 'MECH_DIE', label: 'Die / punch damage', category: 'Mechanical', planned: false },
  { code: 'MECH_ROLLER', label: 'Roller jam', category: 'Mechanical', planned: false },
  { code: 'MECH_BELT', label: 'Belt misalignment', category: 'Mechanical', planned: false },
  { code: 'MECH_BEARING', label: 'Bearing overheating', category: 'Mechanical', planned: false },
  { code: 'MECH_CARTON', label: 'Carton jam', category: 'Mechanical', planned: false },
  { code: 'MECH_GRIPPER', label: 'Gripper fault', category: 'Mechanical', planned: false },
  { code: 'MECH_NOZZLE', label: 'Atomiser nozzle wear', category: 'Mechanical', planned: false },
  { code: 'ELEC_DRIVE', label: 'Drive fault', category: 'Electrical & control', planned: false },
  { code: 'ELEC_SENSOR', label: 'Sensor fault', category: 'Electrical & control', planned: false },
  { code: 'ELEC_BURNER', label: 'Burner flame failure', category: 'Electrical & control', planned: false },
  { code: 'ELEC_PRINTHEAD', label: 'Printhead fault', category: 'Electrical & control', planned: false },
  { code: 'ELEC_ROBOT', label: 'Robot controller fault', category: 'Electrical & control', planned: false },
  { code: 'PROC_MOISTURE', label: 'Powder moisture out of spec', category: 'Process', planned: false },
  { code: 'PROC_DENSITY', label: 'Slip density out of spec', category: 'Process', planned: false },
  { code: 'PROC_VISCOSITY', label: 'Glaze viscosity adjustment', category: 'Process', planned: false },
  { code: 'PROC_INK', label: 'Ink supply interruption', category: 'Process', planned: false },
  { code: 'PROC_TEMP', label: 'Temperature deviation', category: 'Process', planned: false },
  { code: 'CHG_PRODUCT', label: 'Product changeover', category: 'Changeover', planned: false },
  { code: 'STARVED', label: 'Starved — no input', category: 'Starved', planned: false },
  { code: 'BLOCKED', label: 'Blocked — output full', category: 'Blocked', planned: false },
  { code: 'PLN_CLEAN', label: 'Planned cleaning', category: 'Planned', planned: true },
  { code: 'PLN_MAINT', label: 'Condition-based maintenance', category: 'Planned', planned: true },
  { code: 'SCN_STOP', label: 'Simulated breakdown (scenario)', category: 'Mechanical', planned: false },
];
export const REASON_BY_CODE = Object.fromEntries(DOWNTIME_REASONS.map((r) => [r.code, r]));

const r = (mtbf: number, repairMin: number, repairMax: number, reasons: string[]) => ({
  mtbf,
  repairMin,
  repairMax,
  reasons,
});

/** Process-machine operational parameters (rates in tiles/hour). */
const PROCESS: Record<string, { stage: StageId; rate: number; rel: ReturnType<typeof r> }> = {
  'C-BM1': { stage: 'PREP', rate: 490, rel: r(1400, 20, 60, ['MECH_BEARING', 'ELEC_DRIVE', 'PROC_DENSITY']) },
  'C-BM2': { stage: 'PREP', rate: 490, rel: r(1400, 20, 60, ['MECH_BEARING', 'ELEC_DRIVE', 'PROC_DENSITY']) },
  'C-BM3': { stage: 'PREP', rate: 490, rel: r(1400, 20, 60, ['MECH_BEARING', 'ELEC_DRIVE', 'PROC_DENSITY']) },
  'D-TWR': { stage: 'SPRAY', rate: 1440, rel: r(1600, 25, 70, ['PROC_MOISTURE', 'MECH_NOZZLE', 'ELEC_BURNER']) },
  'E-PRS1': { stage: 'PRESS', rate: 470, rel: r(420, 6, 28, ['MECH_HYD', 'MECH_DIE', 'ELEC_SENSOR']) },
  'E-PRS2': { stage: 'PRESS', rate: 470, rel: r(420, 6, 28, ['MECH_HYD', 'MECH_DIE', 'ELEC_SENSOR']) },
  'E-PRS3': { stage: 'PRESS', rate: 470, rel: r(420, 6, 28, ['MECH_HYD', 'MECH_DIE', 'ELEC_SENSOR']) },
  'F-DRY': { stage: 'DRY', rate: 1420, rel: r(1100, 10, 40, ['MECH_ROLLER', 'ELEC_DRIVE', 'PROC_TEMP']) },
  'G-LINE': { stage: 'GLAZE', rate: 1400, rel: r(520, 5, 25, ['PROC_VISCOSITY', 'MECH_BELT', 'MECH_ROLLER']) },
  'G-INK': { stage: 'DECOR', rate: 1400, rel: r(460, 5, 22, ['ELEC_PRINTHEAD', 'PROC_INK', 'ELEC_SENSOR']) },
  'H-KILN': { stage: 'KILN', rate: 1250, rel: r(2600, 15, 45, ['MECH_ROLLER', 'ELEC_BURNER', 'PROC_TEMP']) },
  'I-SORT': { stage: 'SORT', rate: 1360, rel: r(650, 4, 18, ['MECH_BELT', 'ELEC_SENSOR', 'MECH_ROLLER']) },
  'J-BOX': { stage: 'PACK', rate: 1380, rel: r(380, 4, 20, ['MECH_CARTON', 'ELEC_SENSOR', 'MECH_BELT']) },
  'J-PAL': { stage: 'PAL', rate: 1400, rel: r(520, 5, 25, ['ELEC_ROBOT', 'MECH_GRIPPER', 'ELEC_SENSOR']) },
};
export const PROCESS_MACHINES = Object.keys(PROCESS);

/** Planned cleaning windows: equipment → minutes after shift start, duration. */
export const PLANNED_STOPS: { equipmentId: string; offset: number; duration: number }[] = [
  { equipmentId: 'G-LINE', offset: 240, duration: 20 },
  { equipmentId: 'G-INK', offset: 250, duration: 15 },
];

/** Product changeover every 16 h at the presses (staggered), then line follows. */
export const CHANGEOVER_EVERY_MIN = 960;

export const INSPECTION_STATIONS: InspectionStation[] = [
  {
    id: 'ST-GAUGE',
    equipmentId: 'I-GAUGE',
    name: 'Planarity & caliper gauge',
    method: 'Laser distance sensors (simulated)',
    detects: ['planarity', 'dimension'],
  },
  {
    id: 'ST-VIS',
    equipmentId: 'I-VIS',
    name: 'Optical inspection tunnel',
    method: 'Line-scan cameras (simulated records)',
    detects: ['crack', 'chip', 'surface', 'glaze', 'shade'],
  },
  {
    id: 'ST-QC',
    equipmentId: 'I-QC',
    name: 'QC laboratory bench',
    method: 'Manual sample checks (simulated)',
    detects: [],
  },
];

export const DEFECTS: Record<DefectCategory, { label: string; weight: number; origin: StageId; station: string }> = {
  crack: { label: 'Crack', weight: 0.18, origin: 'PRESS', station: 'ST-VIS' },
  chip: { label: 'Chip / edge damage', weight: 0.16, origin: 'KILN', station: 'ST-VIS' },
  surface: { label: 'Surface blemish', weight: 0.2, origin: 'GLAZE', station: 'ST-VIS' },
  glaze: { label: 'Glaze inconsistency', weight: 0.16, origin: 'GLAZE', station: 'ST-VIS' },
  shade: { label: 'Colour / shade variation', weight: 0.14, origin: 'DECOR', station: 'ST-VIS' },
  planarity: { label: 'Planarity deviation', weight: 0.1, origin: 'KILN', station: 'ST-GAUGE' },
  dimension: { label: 'Dimensional (caliber)', weight: 0.06, origin: 'PRESS', station: 'ST-GAUGE' },
};
export const DEFECT_ORDER = Object.keys(DEFECTS) as DefectCategory[];
/** Baseline reject rate at sorting (fraction of inspected tiles). */
export const BASE_REJECT_RATE = 0.024;

export const DOCKS: Dock[] = [-126, -119, -112, -105, -98, -91].map((x, i) => ({
  id: `DOCK-${i + 1}`,
  name: `Dock ${i + 1}`,
  x,
  equipmentId: 'K-DOCK',
}));

export const GEOFENCES: Geofence[] = [
  { id: 'GF-GATE', name: 'Main gate', rect: { x: [70, 92], z: [99, 114] }, kind: 'gate', equipmentId: 'A-GATE' },
  { id: 'GF-HOLD', name: 'Truck holding area', rect: { x: [-66, -14], z: [52, 88] }, kind: 'holding', equipmentId: 'A-HOLD' },
  { id: 'GF-YARD', name: 'Dispatch yard', rect: { x: [-138, -78], z: [62.5, 94] }, kind: 'zone', equipmentId: 'K-DOCK' },
  { id: 'GF-DOCKS', name: 'Loading docks', rect: { x: [-130, -87], z: [57, 62.5] }, kind: 'dock', equipmentId: 'K-DOCK' },
  { id: 'GF-RCV', name: 'Receiving yard & weighbridge', rect: { x: [-140, -119], z: [-52, -4] }, kind: 'zone', equipmentId: 'B-RCV' },
  { id: 'GF-SHED', name: 'Raw-material shed', rect: { x: [-118, -80], z: [-50, -4] }, kind: 'zone', equipmentId: 'B-BAYS' },
  { id: 'GF-PUT', name: 'Put-away station', rect: { x: [-91, -80], z: [8, 30] }, kind: 'zone', equipmentId: 'K-RACK' },
  { id: 'GF-RACK', name: 'Racking aisles', rect: { x: [-129, -93], z: [8, 45] }, kind: 'zone', equipmentId: 'K-RACK' },
  { id: 'GF-STG', name: 'Staging lanes', rect: { x: [-129, -88], z: [45, 57] }, kind: 'zone', equipmentId: 'K-STG' },
  { id: 'GF-PACK', name: 'Packaging floor', rect: { x: [-76, -38], z: [2, 30] }, kind: 'zone', equipmentId: 'J-PAL' },
  {
    id: 'GF-WALK',
    name: 'Hall pedestrian walkway',
    rect: { x: [-76, 76], z: [4.4, 6] },
    kind: 'restricted',
  },
  {
    id: 'GF-PALCELL',
    name: 'Palletiser cell (no entry)',
    rect: { x: [-68, -59], z: [10.5, 19.5] },
    kind: 'restricted',
    equipmentId: 'J-PAL',
  },
  { id: 'GF-SITE', name: 'Site roads', rect: { x: [-148, 122], z: [-76, 104] }, kind: 'zone' },
];

export const DATA_SOURCES: DataSource[] = [
  {
    id: 'SIM',
    name: 'Simulation engine',
    kind: 'simulation',
    status: 'simulated',
    protocol: 'In-browser deterministic model',
    description: 'Seeded, reproducible model of machine states, counters, quality, vehicles and gate events.',
    provides: [],
  },
  {
    id: 'PLC',
    name: 'Line PLCs via industrial gateway',
    kind: 'plc',
    status: 'disconnected',
    protocol: 'OPC UA (read-only subscription)',
    description: 'Machine state, counters and alarms per process machine. Read-only — the product never writes to PLCs.',
    provides: [],
  },
  {
    id: 'SCADA',
    name: 'Kiln & dryer SCADA historian',
    kind: 'scada',
    status: 'disconnected',
    protocol: 'OPC UA HDA / historian REST API',
    description: 'Firing-curve temperatures, burner states, dryer temperatures.',
    provides: [],
  },
  {
    id: 'IOT',
    name: 'Utilities IoT gateway',
    kind: 'iot-gateway',
    status: 'disconnected',
    protocol: 'MQTT (Sparkplug B)',
    description: 'Compressed air, power, gas and water metering.',
    provides: [],
  },
  {
    id: 'MES',
    name: 'MES — orders & batches',
    kind: 'mes',
    status: 'disconnected',
    protocol: 'REST / ISA-95 (B2MML)',
    description: 'Production orders, batch genealogy, shift targets.',
    provides: [],
  },
  {
    id: 'ERP',
    name: 'ERP — sales orders & dispatch',
    kind: 'erp',
    status: 'disconnected',
    protocol: 'REST / OData',
    description: 'Dispatch orders and expected truck arrivals.',
    provides: [],
  },
  {
    id: 'WMS',
    name: 'Warehouse management system',
    kind: 'wms',
    status: 'disconnected',
    protocol: 'REST',
    description: 'Pallet locations, put-away and picking tasks.',
    provides: [],
  },
  {
    id: 'TEL',
    name: 'Gate system & vehicle telematics',
    kind: 'telematics',
    status: 'disconnected',
    protocol: 'REST webhooks',
    description: 'Gate entry/exit and vehicle positions. No GPS, ANPR or indoor positioning is connected.',
    provides: [],
  },
  {
    id: 'VISION',
    name: 'Inspection vision system',
    kind: 'vision',
    status: 'disconnected',
    protocol: 'Vendor SDK / REST',
    description: 'Defect classifications from the inspection tunnel. No computer vision runs in this release.',
    provides: [],
  },
];

// ── Equipment operational metadata & signals ─────────────────────────────────

const categoryFor = (id: string, zone: ZoneId): EquipmentCategory => {
  if (PROCESS[id]) return 'process';
  if (BUFFERS.some((b) => b.equipmentId === id)) return 'buffer';
  if (INSPECTION_STATIONS.some((s) => s.equipmentId === id)) return 'inspection';
  if (['B-LOAD', 'K-FLT', 'D-BELT', 'B-FEED', 'C-CRS', 'J-CNT', 'J-WRAP', 'I-BUF'].includes(id)) return 'material-handling';
  if (['B-BAYS', 'B-SILO', 'K-RACK', 'G-PREP'].includes(id)) return 'storage';
  if (['A-GATE', 'A-HOLD', 'B-RCV', 'K-STG', 'K-DOCK'].includes(id)) return 'logistics';
  if (zone === 'A' || ['D-HAG', 'D-CYC'].includes(id)) return 'utility';
  return 'support';
};

const ANALOG: Record<string, [string, string][]> = {
  'H-KILN': [
    ['temp_firing', '°C'],
    ['temp_preheat', '°C'],
  ],
  'D-TWR': [
    ['temp_inlet', '°C'],
    ['powder_moisture', '%'],
  ],
  'F-DRY': [['temp_deck', '°C']],
  'A-COMP': [
    ['header_pressure', 'bar'],
    ['active_power', 'kW'],
  ],
  'A-SUB': [['active_power', 'kW']],
  'A-GAS': [['gas_flow', 'Nm³/h']],
  'A-WTR': [['tank_level', '%']],
};

/** Assets with (simulated) condition-monitoring sensors — see src/sim/health.ts. */
export const CONDITION_MONITORED = ['C-BM1', 'C-BM2', 'C-BM3', 'D-TWR', 'E-PRS1', 'E-PRS2', 'E-PRS3', 'F-DRY', 'H-KILN', 'J-PAL'];
/** Assets with a (simulated) energy meter — see src/sim/energy.ts. */
export const ENERGY_METERED = ['C-BM1', 'C-BM2', 'C-BM3', 'D-TWR', 'D-HAG', 'E-PRS1', 'E-PRS2', 'E-PRS3', 'F-DRY', 'G-LINE', 'G-INK', 'H-KILN', 'I-SORT', 'J-BOX', 'J-PAL', 'A-COMP', 'A-SUB'];

export const SIGNALS: SignalDef[] = [];
const signal = (equipmentId: string, name: string, unit: string, kind: SignalDef['kind'], metrics: SignalDef['metrics']) => {
  const s: SignalDef = { id: `${equipmentId}.${name}`, equipmentId, name, unit, kind, metrics, sourceId: 'SIM' };
  SIGNALS.push(s);
  return s.id;
};

export const EQUIPMENT_OPS: EquipmentOps[] = EQUIPMENT.map((e) => {
  const zone = e.zone as ZoneId;
  const proc = PROCESS[e.id];
  const sigs: string[] = [];
  if (proc) {
    sigs.push(signal(e.id, 'state', 'enum', 'state', ['availability', 'downtime']));
    sigs.push(signal(e.id, 'count_total', 'tiles', 'counter', ['performance', 'quality', 'output']));
    sigs.push(signal(e.id, 'rate', 'tiles/h', 'analog', ['performance']));
    sigs.push(signal(e.id, 'alarm', 'code', 'event', ['downtime']));
  }
  const buf = BUFFERS.find((b) => b.equipmentId === e.id);
  if (buf) sigs.push(signal(e.id, 'level', '%', 'analog', ['buffer-level']));
  const st = INSPECTION_STATIONS.find((s) => s.equipmentId === e.id);
  if (st && st.detects.length) {
    sigs.push(signal(e.id, 'count_inspected', 'tiles', 'counter', ['quality']));
    sigs.push(signal(e.id, 'count_rejected', 'tiles', 'counter', ['quality', 'rejects']));
  }
  if (st && !st.detects.length) sigs.push(signal(e.id, 'sample_result', 'pass/fail', 'event', ['quality']));
  if (e.id === 'I-SORT') sigs.push(signal(e.id, 'count_good', 'tiles', 'counter', ['quality', 'output']));
  if (e.id === 'A-GATE') sigs.push(signal(e.id, 'gate_event', 'in/out', 'event', ['turnaround']));
  if (e.id === 'K-DOCK') sigs.push(signal(e.id, 'dock_occupancy', 'docks', 'analog', ['turnaround']));
  if (e.id === 'K-FLT' || e.id === 'B-LOAD') sigs.push(signal(e.id, 'vehicle_zone', 'zone id', 'event', []));
  for (const [name, unit] of ANALOG[e.id] ?? []) sigs.push(signal(e.id, name, unit, 'analog', ['energy']));
  if (CONDITION_MONITORED.includes(e.id)) {
    sigs.push(signal(e.id, 'vibration', 'mm/s RMS', 'analog', ['health']));
    sigs.push(signal(e.id, 'temperature', '°C', 'analog', ['health']));
    sigs.push(signal(e.id, 'motor_current', 'A', 'analog', ['health']));
  }
  if (ENERGY_METERED.includes(e.id) && !(ANALOG[e.id] ?? []).some(([n]) => n === 'active_power'))
    sigs.push(signal(e.id, 'energy_kwh', 'kWh', 'counter', ['energy']));
  return {
    id: e.id,
    category: categoryFor(e.id, zone),
    zone,
    lineId: proc || buf || st ? LINE.id : null,
    stage: proc?.stage ?? null,
    idealRatePerHour: proc?.rate ?? null,
    reliability: proc?.rel,
    signals: sigs,
    sourceId: 'SIM',
  };
});
export const OPS_BY_ID: Record<string, EquipmentOps> = Object.fromEntries(EQUIPMENT_OPS.map((o) => [o.id, o]));
DATA_SOURCES[0].provides = SIGNALS.map((s) => s.id);

/** Process-machine signals a future PLC gateway would replace (documentation of the boundary). */
DATA_SOURCES[1].provides = SIGNALS.filter((s) => OPS_BY_ID[s.equipmentId].category === 'process').map((s) => s.id);

export const MATERIAL_FLOW: MaterialFlowConnection[] = [
  { id: 'MF-01', from: 'B-FEED', to: 'C-CRS', via: null, material: 'raw' },
  { id: 'MF-02', from: 'C-CRS', to: 'C-BM1', via: null, material: 'raw' },
  ...STAGES.slice(0, -1).map((s, i): MaterialFlowConnection => ({
    id: `MF-${String(i + 3).padStart(2, '0')}`,
    from: s.machines[0],
    to: STAGES[i + 1].machines[0],
    via: BUFFERS.find((b) => b.id === STAGES[i + 1].inputBuffer)?.equipmentId ?? null,
    material: 'intermediate',
  })),
  { id: 'MF-20', from: 'J-PAL', to: 'K-RACK', via: 'J-WRAP', material: 'finished' },
  { id: 'MF-21', from: 'K-RACK', to: 'K-STG', via: 'K-FLT', material: 'finished' },
  { id: 'MF-22', from: 'K-STG', to: 'K-DOCK', via: 'K-FLT', material: 'finished' },
];
