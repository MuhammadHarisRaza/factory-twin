/**
 * The brief's twelve production stages and how this representative ceramic tile plant maps onto them
 * (equipment ids from src/data/equipment.ts, buffer ids from src/model/plant.ts BUFFERS). This is the
 * single 12-stage registry of the signal catalogue; the engine keeps its own 10 process stages
 * (StageId) and the production views their 9 monitored stages (MonitoredStageId) — `monitoredStage`
 * says under which monitored stage each of the twelve is shown.
 *
 * Two stages do not have a full counterpart in the 3D model: stage 8 (cooling buffer) is played by the
 * kiln outfeed storage and the sorting-line roller conveyor, and stage 9 (polishing & rectification)
 * has no machines at all — its signal catalogue uses the pseudo equipment id `S09` and is flagged for
 * configuration.
 */
import type { ProductionStageDef, ProductionStageNo } from './types';

/** Pseudo equipment id of the stage-9 catalogue entries (no polishing / rectification machine exists). */
export const STAGE9_EQUIPMENT_ID = 'S09';

export const STAGES_12: ProductionStageDef[] = [
  {
    no: 1,
    id: 'S01',
    name: 'Raw-material preparation & milling',
    purpose: 'Receive, store and dose the raw materials to the body recipe, crush them and wet-mill the batch into slip.',
    monitoredStage: 'PREP',
    equipment: ['B-RCV', 'B-BAYS', 'B-LOAD', 'B-FEED', 'B-SILO', 'C-CRS', 'C-BM1', 'C-BM2', 'C-BM3', 'C-SLIP'],
    buffers: ['BUF-SLIP'],
    present: 'yes',
    note:
      'Ball mills and slip tanks are simulated. Receiving, storage bays, dosing and crushing are part of the 3D model without an operating model: raw-material supply never limits the simulated line.',
  },
  {
    no: 2,
    id: 'S02',
    name: 'Spray drying & powder storage',
    purpose: 'Atomise the slip into press powder in the spray dryer and rest it in the powder silos before pressing.',
    monitoredStage: 'SPRAY',
    equipment: ['D-HAG', 'D-TWR', 'D-CYC', 'D-SILO', 'D-BELT'],
    buffers: ['BUF-SILO'],
    present: 'yes',
    note:
      'The simulation counts powder in tile-equivalents; mass flows in t/h are a labelled simulated conversion (KG_PER_TILE). Silo level % is not mass: a silo mass needs a level-to-mass calibration or load cells.',
  },
  {
    no: 3,
    id: 'S03',
    name: 'Pressing',
    purpose: 'Form green tiles from the powder in the hydraulic presses and collect them towards the dryer.',
    monitoredStage: 'PRESS',
    equipment: ['E-PRS1', 'E-PRS2', 'E-PRS3', 'E-COL'],
    buffers: ['BUF-COL'],
    present: 'yes',
    note: 'Strokes per minute assume a two-cavity die (simulated assumption PRESS_CAVITIES).',
  },
  {
    no: 4,
    id: 'S04',
    name: 'Drying',
    purpose: 'Remove the residual moisture of the green tiles in the multi-deck roller dryer and buffer them before glazing.',
    monitoredStage: 'DRY',
    equipment: ['F-DRY', 'F-BUF'],
    buffers: ['BUF-DRY'],
    present: 'yes',
    note: 'Residence time is not modelled: a tile crosses the dryer within one simulated minute.',
  },
  {
    no: 5,
    id: 'S05',
    name: 'Glazing & engobe',
    purpose: 'Prepare the glazes and apply engobe and glaze on the glazing line.',
    monitoredStage: 'GLAZE',
    equipment: ['G-PREP', 'G-LINE', 'CV-GLZ'],
    buffers: ['BUF-GLZ'],
    present: 'yes',
    note: 'Engobe and glaze application are one machine (G-LINE) in the model; glaze preparation (G-PREP) has no operating model.',
  },
  {
    no: 6,
    id: 'S06',
    name: 'Digital printing',
    purpose: 'Print the surface design with the multi-colour inkjet printer.',
    monitoredStage: 'GLAZE',
    equipment: ['G-INK'],
    buffers: [],
    present: 'yes',
    note: 'Shown under the "Glazing & decoration" monitored stage (GLAZE); the printer has its own equipment and signals.',
  },
  {
    no: 7,
    id: 'S07',
    name: 'Kiln firing',
    purpose: 'Fire the tiles in the single-layer roller kiln through pre-heating, firing and cooling zones.',
    monitoredStage: 'KILN',
    equipment: ['H-KILN', 'CV-KIN'],
    buffers: ['BUF-KIN'],
    present: 'yes',
    note: 'Five simulated temperature zones (KILN_ZONES); the firing-cycle time is not modelled.',
  },
  {
    no: 8,
    id: 'S08',
    name: 'Cooling buffer & roller conveyors',
    purpose: 'Hold fired tiles after the kiln exit so that short stops downstream do not stop the kiln, and carry them to sorting.',
    monitoredStage: 'KILN',
    equipment: ['CV-SORT'],
    buffers: ['BUF-KOUT'],
    present: 'partial',
    note:
      'No dedicated cooling-buffer machine in the 3D model: the kiln outfeed storage (BUF-KOUT) and the sorting-line roller conveyor (CV-SORT) play that role, shown under the Kiln monitored stage. The downstream-constraint example "polishing slowdown → cooling buffer fills" is expressed with the next stage that exists: a sorting-line slowdown → kiln outfeed fills → kiln limited by its outfeed.',
  },
  {
    no: 9,
    id: 'S09',
    name: 'Polishing & rectification',
    purpose: 'Polish the tile surface and square / rectify the edges to the nominal size.',
    monitoredStage: null,
    equipment: [],
    buffers: [],
    present: 'no',
    note:
      "No polishing or rectification machines in this representative glazed-tile line's 3D model. The stage's signal catalogue is defined (pseudo equipment id S09, every signal unavailable) and flagged for configuration: map it to a machine to enable it.",
  },
  {
    no: 10,
    id: 'S10',
    name: 'Sorting, grading & inspection',
    purpose: 'Measure, inspect and sort the fired tiles, take QC samples and accumulate them before packing.',
    monitoredStage: 'SORT',
    equipment: ['I-GAUGE', 'I-VIS', 'I-SORT', 'I-QC', 'I-BUF'],
    buffers: ['BUF-SORT'],
    present: 'yes',
    note: 'The simulation sorts accepted / rejected only (no grades). Inspection results are simulated records: no computer vision runs.',
  },
  {
    no: 11,
    id: 'S11',
    name: 'Packing & palletising',
    purpose: 'Count tiles into cartons, pack, palletise and stretch-wrap them.',
    monitoredStage: 'PACK',
    equipment: ['J-CNT', 'J-BOX', 'J-PAL', 'J-WRAP', 'CV-PACK', 'CV-PAL'],
    buffers: ['BUF-PACK'],
    present: 'yes',
    note: 'Palletising is shown under the "Packaging & palletising" monitored stage (PACK).',
  },
  {
    no: 12,
    id: 'S12',
    name: 'Warehouse & internal movement',
    purpose: 'Store the pallets, stage orders, load trucks at the docks and control gate traffic.',
    monitoredStage: 'WH',
    equipment: ['K-RACK', 'K-FLT', 'K-STG', 'K-DOCK', 'A-GATE', 'A-HOLD'],
    buffers: [],
    present: 'yes',
    note: 'Gate, holding area, docks and forklifts are simulated logistics; vehicle zones are simulated positions, not GPS or RTLS. No WMS is connected.',
  },
];

export const STAGE_BY_NO = Object.fromEntries(STAGES_12.map((s) => [s.no, s])) as Record<ProductionStageNo, ProductionStageDef>;

/** Site utilities and support assets: part of the 3D plant, not of any production stage. */
export const SUPPORT_EQUIPMENT: string[] = ['A-PARK', 'A-ADMIN', 'A-DUST', 'A-COMP', 'A-SUB', 'A-WTR', 'A-GAS', 'A-STK', 'L-WS', 'L-SP'];

const STAGE_OF_EQUIPMENT: Record<string, ProductionStageNo> = Object.fromEntries(STAGES_12.flatMap((s) => s.equipment.map((id) => [id, s.no])));
const STAGE_OF_BUFFER: Record<string, ProductionStageNo> = Object.fromEntries(STAGES_12.flatMap((s) => s.buffers.map((id) => [id, s.no])));

/** Production stage of an equipment id (null for support assets and unknown ids, including inherited keys such as 'constructor'). */
export const stageOfEquipment = (equipmentId: string): ProductionStageNo | null =>
  Object.hasOwn(STAGE_OF_EQUIPMENT, equipmentId) ? STAGE_OF_EQUIPMENT[equipmentId] : null;

/** Production stage of a buffer id (src/model/plant.ts BUFFERS; null for unknown ids). */
export const stageOfBuffer = (bufferId: string): ProductionStageNo | null => (Object.hasOwn(STAGE_OF_BUFFER, bufferId) ? STAGE_OF_BUFFER[bufferId] : null);
