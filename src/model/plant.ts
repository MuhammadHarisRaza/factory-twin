/**
 * Static configuration of the reference plant: line, stages, buffers, equipment
 * operational metadata, signals, downtime reasons, inspection stations, docks,
 * geofences and data sources. Equipment ids are the same ids as the 3D model's
 * <Selectable> objects (src/data/equipment.ts), so every record maps to geometry.
 */
import { EQUIPMENT } from '../data/equipment';
import type {
  BufferDef,
  CameraDef,
  ConveyorDef,
  DataSource,
  DefectCategory,
  Dock,
  DowntimeReason,
  EquipmentCategory,
  EquipmentOps,
  Factory,
  Geofence,
  InspectionStation,
  EventRules,
  MaterialFlowConnection,
  MonitoredStage,
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
  'conveyor-stop': 'Conveyor stoppage',
  'signal-loss': 'Data feed loss (PLC link)',
  'restricted-entry': 'Restricted-zone entry',
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
  { code: 'CNV_JAM', label: 'Tile jam at transfer', category: 'Mechanical', planned: false },
  { code: 'CNV_TRACK', label: 'Belt tracking / slip fault', category: 'Mechanical', planned: false },
  { code: 'CNV_DRIVE', label: 'Conveyor drive trip', category: 'Electrical & control', planned: false },
  { code: 'CNV_PULLCORD', label: 'Safety pull-cord stop', category: 'Electrical & control', planned: false },
  { code: 'SCN_CNV_STOP', label: 'Simulated conveyor stop (scenario)', category: 'Mechanical', planned: false },
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
  chip: { label: 'Chip & edge damage', weight: 0.16, origin: 'KILN', station: 'ST-VIS' },
  surface: { label: 'Surface blemish', weight: 0.2, origin: 'GLAZE', station: 'ST-VIS' },
  glaze: { label: 'Glaze inconsistency', weight: 0.16, origin: 'GLAZE', station: 'ST-VIS' },
  shade: { label: 'Colour (shade) variation', weight: 0.14, origin: 'DECOR', station: 'ST-VIS' },
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
  if (['B-LOAD', 'K-FLT', 'D-BELT', 'B-FEED', 'C-CRS', 'J-CNT', 'J-WRAP', 'I-BUF'].includes(id) || id.startsWith('CV-')) return 'material-handling';
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

const cr = (mtbf: number, repairMin: number, repairMax: number, reasons: string[]) => ({ mtbf, repairMin, repairMax, reasons });

/**
 * Conveyors that carry tiles between stages. D-BELT and E-COL were already selectable assets;
 * the CV-* ids name conveyor runs of the 3D model that now carry operational state.
 */
export const CONVEYORS: ConveyorDef[] = [
  {
    id: 'D-BELT', name: 'Powder feed conveyor', zone: 'D', kind: 'belt', from: 'SPRAY', to: 'PRESS', bufferId: 'BUF-SILO',
    blocksInputOf: ['PRESS'], blocksOutputOf: [], capacityPerHour: 1700, speedMpm: 42,
    reliability: cr(3600, 4, 14, ['CNV_TRACK', 'CNV_DRIVE', 'CNV_PULLCORD']),
  },
  {
    id: 'E-COL', name: 'Green-tile collector conveyor', zone: 'E', kind: 'roller', from: 'PRESS', to: 'DRY', bufferId: 'BUF-COL',
    blocksInputOf: ['DRY'], blocksOutputOf: ['PRESS'], capacityPerHour: 1650, speedMpm: 18,
    reliability: cr(3000, 3, 12, ['CNV_JAM', 'CNV_DRIVE', 'CNV_PULLCORD']),
  },
  {
    id: 'CV-GLZ', name: 'Glaze line belt conveyor', zone: 'G', kind: 'belt', from: 'DRY', to: 'KILN', bufferId: 'BUF-GLZ',
    blocksInputOf: ['GLAZE', 'DECOR'], blocksOutputOf: ['GLAZE', 'DECOR'], capacityPerHour: 1600, speedMpm: 16,
    reliability: cr(3400, 3, 12, ['CNV_TRACK', 'CNV_JAM', 'CNV_DRIVE']),
  },
  {
    id: 'CV-KIN', name: 'Kiln infeed roller transfer', zone: 'H', kind: 'roller', from: 'DECOR', to: 'KILN', bufferId: 'BUF-KIN',
    blocksInputOf: ['KILN'], blocksOutputOf: ['DECOR'], capacityPerHour: 1600, speedMpm: 14,
    reliability: cr(5200, 3, 10, ['CNV_JAM', 'CNV_DRIVE']),
  },
  {
    id: 'CV-SORT', name: 'Sorting line roller conveyor', zone: 'I', kind: 'roller', from: 'KILN', to: 'SORT', bufferId: 'BUF-KOUT',
    blocksInputOf: ['SORT'], blocksOutputOf: [], capacityPerHour: 1600, speedMpm: 20,
    reliability: cr(4200, 3, 10, ['CNV_JAM', 'CNV_DRIVE', 'CNV_PULLCORD']),
  },
  {
    id: 'CV-PACK', name: 'Packing transfer belt', zone: 'J', kind: 'belt', from: 'SORT', to: 'PACK', bufferId: 'BUF-SORT',
    blocksInputOf: ['PACK'], blocksOutputOf: [], capacityPerHour: 1650, speedMpm: 24,
    reliability: cr(3000, 3, 12, ['CNV_JAM', 'CNV_TRACK', 'CNV_PULLCORD']),
  },
  {
    id: 'CV-PAL', name: 'Carton conveyor to palletiser', zone: 'J', kind: 'roller', from: 'PACK', to: 'PAL', bufferId: 'BUF-PACK',
    blocksInputOf: ['PAL'], blocksOutputOf: ['PACK'], capacityPerHour: 1700, speedMpm: 22,
    reliability: cr(3200, 3, 10, ['CNV_JAM', 'CNV_DRIVE']),
  },
];
export const CONVEYOR_BY_ID: Record<string, ConveyorDef> = Object.fromEntries(CONVEYORS.map((c) => [c.id, c]));
export const CONVEYOR_IDS = CONVEYORS.map((c) => c.id);

/**
 * Camera positions. Each has a simulated feed rendered from the digital twin; a real stream is used
 * only when one is configured for it and actually plays. No camera is connected in this release.
 */
export const CAMERAS: CameraDef[] = [
  { id: 'CAM-A1', name: 'Main gate & holding area', zone: 'A', stage: 'YARD', covers: ['A-GATE', 'A-HOLD', 'GF-GATE', 'GF-HOLD'], purpose: 'Gate entries, truck queue' },
  { id: 'CAM-B1', name: 'Raw-material receiving', zone: 'B', stage: 'PREP', covers: ['B-RCV', 'B-BAYS', 'B-LOAD', 'B-FEED', 'GF-RCV', 'GF-SHED'], purpose: 'Tipper unloading, wheel loader' },
  { id: 'CAM-C1', name: 'Ball mill hall', zone: 'C', stage: 'PREP', covers: ['C-CRS', 'C-BM1', 'C-BM2', 'C-BM3', 'C-SLIP'], purpose: 'Mill drives and slip tanks' },
  { id: 'CAM-D1', name: 'Spray dryer & powder feed', zone: 'D', stage: 'SPRAY', covers: ['D-TWR', 'D-HAG', 'D-SILO', 'D-BELT'], purpose: 'Tower discharge, powder belt' },
  { id: 'CAM-E1', name: 'Press line', zone: 'E', stage: 'PRESS', covers: ['E-PRS1', 'E-PRS2', 'E-PRS3', 'E-COL'], purpose: 'Presses and green-tile collector' },
  { id: 'CAM-G1', name: 'Glaze line', zone: 'G', stage: 'GLAZE', covers: ['F-DRY', 'F-BUF', 'G-LINE', 'G-INK', 'CV-GLZ'], purpose: 'Glaze application and decoration' },
  { id: 'CAM-H1', name: 'Kiln entry', zone: 'H', stage: 'KILN', covers: ['H-KILN', 'CV-KIN'], purpose: 'Kiln infeed transfer' },
  { id: 'CAM-I1', name: 'Sorting line', zone: 'I', stage: 'SORT', covers: ['CV-SORT', 'I-GAUGE', 'I-VIS', 'I-SORT', 'I-QC', 'I-BUF'], purpose: 'Kiln exit, gauge, grade diverters' },
  { id: 'CAM-J1', name: 'Packaging & palletising', zone: 'J', stage: 'PACK', covers: ['CV-PACK', 'J-CNT', 'J-BOX', 'CV-PAL', 'J-PAL', 'J-WRAP', 'GF-PACK', 'GF-PALCELL', 'GF-WALK'], purpose: 'Packing, palletiser cell, walkway' },
  { id: 'CAM-K1', name: 'Warehouse & docks', zone: 'K', stage: 'WH', covers: ['K-RACK', 'K-STG', 'K-DOCK', 'K-FLT', 'GF-RACK', 'GF-STG', 'GF-DOCKS', 'GF-PUT', 'GF-YARD'], purpose: 'Racking, staging lanes, docks' },
];
export const CAMERA_BY_ID: Record<string, CameraDef> = Object.fromEntries(CAMERAS.map((c) => [c.id, c]));
/** First camera whose field of view includes the asset / geofence (null = none). */
export const cameraFor = (id: string | undefined | null) => (id ? (CAMERAS.find((c) => c.covers.includes(id)) ?? null) : null);

const cp = (label: string, unit: string, signalId: string | null, note?: string) => ({ label, unit, signalId, measured: signalId != null, note });

/**
 * Production-monitoring registry: what is counted where. Configurable per plant — the counting
 * points below follow this line's signal list (src/model/plant.ts SIGNALS); quantities without a
 * counting point are shown as "not measured" rather than inferred.
 */
export const MONITORED_STAGES: MonitoredStage[] = [
  {
    id: 'PREP', name: 'Raw-material preparation', step: 2, zone: 'C', unit: 'tiles',
    equipment: ['C-BM1', 'C-BM2', 'C-BM3'], conveyors: [], cameras: ['CAM-B1', 'CAM-C1'],
    input: cp('Raw materials dosed', 't', null, 'Box-feeder weighing not integrated; mills are fed continuously'),
    output: cp('Slip to tanks (tile-equivalent)', 'tiles', 'C-BM1.count_total'),
    good: null, rejected: null, wipBufferId: null, oeeMeaningful: true,
  },
  {
    id: 'SPRAY', name: 'Spray drying & powder', step: 3, zone: 'D', unit: 'tiles',
    equipment: ['D-TWR'], conveyors: ['D-BELT'], cameras: ['CAM-D1'],
    input: cp('Slip from tanks', 'tiles', 'D-TWR.count_total', 'Tile-equivalent of slip drawn'),
    output: cp('Powder to silos (tile-equivalent)', 'tiles', 'D-TWR.count_total'),
    good: null, rejected: null, wipBufferId: 'BUF-SLIP', oeeMeaningful: true,
  },
  {
    id: 'PRESS', name: 'Pressing & forming', step: 4, zone: 'E', unit: 'tiles',
    equipment: ['E-PRS1', 'E-PRS2', 'E-PRS3'], conveyors: ['D-BELT', 'E-COL'], cameras: ['CAM-E1'],
    input: cp('Powder from silos', 'tiles', 'D-BELT.tile_count', 'Tile-equivalent of powder fed'),
    output: cp('Green tiles pressed', 'tiles', 'E-PRS1.count_total'),
    good: null, rejected: null, wipBufferId: 'BUF-SILO', oeeMeaningful: true,
  },
  {
    id: 'DRY', name: 'Drying', step: 5, zone: 'F', unit: 'tiles',
    equipment: ['F-DRY'], conveyors: ['E-COL'], cameras: ['CAM-G1'],
    input: cp('Green tiles in', 'tiles', 'E-COL.tile_count'),
    output: cp('Dried tiles out', 'tiles', 'F-DRY.count_total'),
    good: null, rejected: null, wipBufferId: 'BUF-COL', oeeMeaningful: true,
  },
  {
    id: 'GLAZE', name: 'Glazing & decoration', step: 6, zone: 'G', unit: 'tiles',
    equipment: ['G-LINE', 'G-INK'], conveyors: ['CV-GLZ'], cameras: ['CAM-G1'],
    input: cp('Dried tiles from buffer', 'tiles', 'G-LINE.count_total'),
    output: cp('Decorated tiles', 'tiles', 'G-INK.count_total'),
    good: null, rejected: null, wipBufferId: 'BUF-DRY', oeeMeaningful: true,
  },
  {
    id: 'KILN', name: 'Kiln firing & cooling', step: 7, zone: 'H', unit: 'tiles',
    equipment: ['H-KILN'], conveyors: ['CV-KIN'], cameras: ['CAM-H1'],
    input: cp('Tiles into kiln', 'tiles', 'CV-KIN.tile_count'),
    output: cp('Tiles fired', 'tiles', 'H-KILN.count_total'),
    good: null, rejected: null, wipBufferId: 'BUF-KIN', oeeMeaningful: true,
  },
  {
    id: 'SORT', name: 'Sorting & inspection', step: 8, zone: 'I', unit: 'tiles',
    equipment: ['I-SORT'], conveyors: ['CV-SORT'], cameras: ['CAM-I1'],
    input: cp('Tiles inspected', 'tiles', 'I-VIS.count_inspected'),
    output: cp('Tiles sorted', 'tiles', 'I-SORT.count_total'),
    good: cp('First-quality accepted', 'tiles', 'I-SORT.count_good'),
    rejected: cp('Rejected at gauge & vision', 'tiles', 'I-VIS.count_rejected'),
    wipBufferId: 'BUF-KOUT', oeeMeaningful: true,
  },
  {
    id: 'PACK', name: 'Packaging & palletising', step: 9, zone: 'J', unit: 'tiles',
    equipment: ['J-BOX', 'J-PAL'], conveyors: ['CV-PACK', 'CV-PAL'], cameras: ['CAM-J1'],
    input: cp('Tiles to packing', 'tiles', 'CV-PACK.tile_count'),
    output: cp('Tiles palletised', 'tiles', 'J-PAL.count_total'),
    good: null, rejected: null, wipBufferId: 'BUF-SORT', oeeMeaningful: true,
  },
  {
    id: 'WH', name: 'Warehouse transfer', step: 10, zone: 'K', unit: 'pallets',
    equipment: ['K-RACK', 'K-STG', 'K-DOCK'], conveyors: [], cameras: ['CAM-J1', 'CAM-K1'],
    input: cp('Pallets off the wrapper', 'pallets', 'J-PAL.count_total', 'Pallets = palletised tiles ÷ tiles per pallet'),
    output: cp('Pallets dispatched', 'pallets', 'K-DOCK.dock_occupancy', 'Counted at dock loading-complete events'),
    good: null, rejected: null, wipBufferId: null, oeeMeaningful: false,
  },
];
export const MONITORED_STAGE_BY_ID = Object.fromEntries(MONITORED_STAGES.map((m) => [m.id, m])) as Record<MonitoredStage['id'], MonitoredStage>;

/** Default thresholds of the event-detection rules (src/sim/events.ts); editable at runtime. */
export const DEFAULT_EVENT_RULES: EventRules = {
  belowRateFactor: 0.85,
  belowRateMinutes: 10,
  starvedMinutesConstraint: 5,
  starvedMinutes: 10,
  counterInactiveMinutes: 3,
  rejectRateMax: 0.05,
  defectCount30Max: 12,
  defectRepeatRecords: 5,
  deteriorationRatio: 2,
  truckWaitMax: 25,
  dockStayMax: 75,
  yardQueueMax: 4,
  turnaroundMax: 150,
  energyDeviationMax: 0.1,
  ioImbalanceMax: 0.015,
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
  if (CONVEYOR_BY_ID[e.id]) {
    sigs.push(signal(e.id, 'run_state', 'enum', 'state', ['availability', 'downtime']));
    sigs.push(signal(e.id, 'speed', 'm/min', 'analog', []));
    sigs.push(signal(e.id, 'tile_count', 'tiles', 'counter', ['output']));
  }
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
