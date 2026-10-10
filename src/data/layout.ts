import type { CameraView, FlowPath, FlowStage, PresetId, Range, Rect, Vec2, Zone } from './types';

/** Site boundary used for the minimap, camera clamping and "fit". */
export const SITE: Rect = { x: [-148, 122], z: [-76, 104] };

/** Main production hall: pressing, drying, glazing, kiln, sorting, packaging. */
export const HALL = {
  rect: { x: [-76, 76], z: [-30, 30] } as Rect,
  eave: 12,
  ridge: 14.5,
  bayLine: 0,
};
export const RAW_SHED = { rect: { x: [-118, -80], z: [-50, -4] } as Rect, eave: 11, ridge: 13 };
export const WAREHOUSE = { rect: { x: [-132, -80], z: [4, 60] } as Rect, eave: 13, ridge: 15 };
export const SPRAY_TOWER = { rect: { x: [-47, -23], z: [-57, -31] } as Rect, height: 30 };
export const WORKSHOP = { rect: { x: [79, 104], z: [-8, 30] } as Rect, eave: 7, ridge: 8.5 };
/** Covered link between the hall and the warehouse. */
export const LINK = { rect: { x: [-80, -76], z: [12, 26] } as Rect, eave: 6 };

/** X positions of the hall's portal frames (11 bays of 15.2 m). */
export const HALL_FRAMES = Array.from({ length: 11 }, (_, i) => -76 + i * 15.2);

export const ZONES: Zone[] = [
  {
    id: 'A',
    name: 'External site & utilities',
    short: 'Site & utilities',
    stage: 'Support',
    color: '#8a95a3',
    rects: [
      { x: [-74, -56], z: [-44, -32] },
      { x: [-8, 66], z: [-58, -33] },
      { x: [20, 110], z: [46, 90] },
      { x: [-66, -14], z: [52, 86] },
    ],
    label: [20, -48],
    preset: 'site',
    summary:
      'Gate, roads, parking, dust collection, compressed air, electrical substation, water and gas utilities, kiln exhaust stacks.',
  },
  {
    id: 'B',
    name: 'Raw-material receiving & storage',
    short: 'Raw materials',
    stage: '1 · Receiving',
    color: '#b07a4a',
    rects: [RAW_SHED.rect, { x: [-140, -119], z: [-50, -6] }],
    label: [-100, -40],
    preset: 'raw',
    summary:
      'Truck receiving and weighbridge, covered storage bays for clays, feldspar and sand, box feeders and additive silos.',
  },
  {
    id: 'C',
    name: 'Raw-material preparation',
    short: 'Preparation',
    stage: '2 · Body preparation',
    color: '#c49a5a',
    rects: [{ x: [-76, -46], z: [-30, -2] }],
    label: [-61, -4],
    preset: 'raw',
    summary:
      'Crushing and screening, continuous wet ball mills and agitated slip tanks feeding the spray dryer.',
  },
  {
    id: 'D',
    name: 'Spray drying & powder preparation',
    short: 'Spray drying',
    stage: '3 · Atomisation',
    color: '#d6b46a',
    rects: [SPRAY_TOWER.rect, { x: [-46, -24], z: [-30, -2] }],
    label: [-35, -4],
    preset: 'raw',
    summary:
      'Spray dryer tower with hot-air generator, cyclones and bag filter; powder silos feeding the presses.',
  },
  {
    id: 'E',
    name: 'Pressing & tile forming',
    short: 'Pressing',
    stage: '4 · Forming',
    color: '#5a8fc4',
    rects: [{ x: [-24, -1], z: [-30, -2] }],
    label: [-12, -4],
    preset: 'pressglaze',
    summary:
      'Three hydraulic presses with powder feed, die sets and a collector conveyor for green tiles.',
  },
  {
    id: 'F',
    name: 'Drying',
    short: 'Drying',
    stage: '5 · Drying',
    color: '#4fa3b8',
    rects: [{ x: [-1, 28], z: [-30, -2] }],
    label: [13, -4],
    preset: 'pressglaze',
    summary:
      'Multi-deck horizontal roller dryer with infeed/outfeed and a tile buffer storage unit.',
  },
  {
    id: 'G',
    name: 'Glazing & surface treatment',
    short: 'Glazing',
    stage: '6 · Glazing & decoration',
    color: '#4cb8a0',
    rects: [{ x: [28, 76], z: [-30, -2] }],
    label: [52, -4],
    preset: 'pressglaze',
    summary:
      'Continuous glaze line: cleaning, engobe and glaze bells, spray booth, digital inkjet decoration, glaze preparation.',
  },
  {
    id: 'H',
    name: 'Kiln firing & cooling',
    short: 'Kiln',
    stage: '7 · Firing',
    color: '#e07a3a',
    rects: [{ x: [-6, 76], z: [2, 30] }],
    label: [33, 28],
    preset: 'kiln',
    summary:
      'Single-layer roller kiln: pre-heating, firing and cooling sections with exhaust and cooling-air systems.',
  },
  {
    id: 'I',
    name: 'Sorting & quality inspection',
    short: 'Sorting',
    stage: '8 · Sorting & inspection',
    color: '#9b7fd1',
    rects: [{ x: [-38, -6], z: [2, 30] }],
    label: [-22, 28],
    preset: 'sorting',
    summary:
      'Planarity gauge, optical inspection tunnel, diverters, grade stackers, reject route and QC bench.',
  },
  {
    id: 'J',
    name: 'Packaging & palletising',
    short: 'Packaging',
    stage: '9 · Packing',
    color: '#c46a9b',
    rects: [{ x: [-76, -38], z: [2, 30] }],
    label: [-57, 28],
    preset: 'packaging',
    summary:
      'Stack counting, carton packaging, box conveyors, robotic palletiser, stretch wrapper and forklift staging.',
  },
  {
    id: 'K',
    name: 'Finished-goods warehouse & dispatch',
    short: 'Warehouse',
    stage: '10–11 · Storage & dispatch',
    color: '#6fae5a',
    rects: [WAREHOUSE.rect, { x: [-136, -80], z: [60, 92] }],
    label: [-106, 8],
    preset: 'warehouse',
    summary:
      'Selective pallet racking in five aisles, put-away and staging areas, six loading docks and the dispatch yard.',
  },
  {
    id: 'L',
    name: 'Maintenance & production support',
    short: 'Maintenance',
    stage: 'Support',
    color: '#d1b347',
    rects: [WORKSHOP.rect],
    label: [91, -6],
    preset: 'utilities',
    summary:
      'Maintenance workshop, machine tools, spare-parts store, tool benches and engineering office.',
  },
];

export const ZONE_BY_ID: Record<string, Zone> = Object.fromEntries(ZONES.map((z) => [z.id, z]));

export const VIEWS: Record<PresetId, CameraView> = {
  full: { label: 'Full factory', pos: [96, 168, 222], target: [-34, 0, 6] },
  hall: { label: 'Production hall', pos: [34, 74, 96], target: [-6, 0, -2] },
  raw: { label: 'Raw materials', pos: [-58, 34, 24], target: [-92, 2, -24] },
  pressglaze: { label: 'Pressing & glazing', pos: [46, 8.5, -1], target: [4, 2.5, -17] },
  kiln: { label: 'Kiln & cooling', pos: [80, 11, 46], target: [28, 2, 15] },
  sorting: { label: 'Quality & sorting', pos: [2, 10.5, 40], target: [-24, 1.5, 14] },
  packaging: { label: 'Packaging', pos: [-34, 10.5, 40], target: [-60, 1.5, 15] },
  warehouse: { label: 'Warehouse', pos: [-80, 15, 82], target: [-110, 3, 30] },
  utilities: { label: 'Utilities & maintenance', pos: [104, 58, -98], target: [50, 2, -24] },
  site: { label: 'External site', pos: [176, 92, 196], target: [30, 0, 62] },
};

/** View presets in keyboard-shortcut order (1–9, then 0). */
export const VIEW_ORDER: PresetId[] = [
  'full',
  'hall',
  'raw',
  'pressglaze',
  'kiln',
  'sorting',
  'packaging',
  'warehouse',
  'utilities',
  'site',
];

/** Asphalt roads. */
export const ROADS: Rect[] = [
  { x: [-146, 120], z: [-72, -64] },
  { x: [112, 120], z: [-72, 104] },
  { x: [-146, -138], z: [-72, 104] },
  { x: [-146, 120], z: [92, 100] },
  { x: [76, 84], z: [100, 106] },
  { x: [-170, 150], z: [106, 114] },
  { x: [-78, 112], z: [36, 44] },
  { x: [-78, -70], z: [36, 62] },
];

/** Concrete hardstanding: yards, aprons and service areas. */
export const PAVED: Rect[] = [
  { x: [-138, -119], z: [-52, -4] },
  { x: [-138, -78], z: [60, 94] },
  { x: [-82, 110], z: [30, 36] },
  { x: [-80, 110], z: [-64, -30] },
  { x: [76, 112], z: [-30, 36] },
  { x: [-66, -14], z: [52, 86] },
  { x: [-46, -38], z: [44, 52] },
  { x: [22, 60], z: [48, 84] },
];

export const PARKING: Rect = { x: [86, 110], z: [48, 88] };
/** Main gate reference point; [0] is the gate centre x on the south perimeter. */
export const GATE_X: Range = [80, 104];
/** Guard house position [x, z] beside the main gate. */
export const GUARD_HOUSE_POS: Vec2 = [70, 102];

export const FLOW_PATHS: FlowPath[] = [
  {
    kind: 'raw',
    y: 3,
    pts: [
      [-130, -28],
      [-112, -28],
      [-104, -36],
      [-100, -20],
      [-104, -8],
      [-71, -8],
      [-67, -8],
      [-67, -17],
      [-60, -17],
    ],
  },
  {
    kind: 'intermediate',
    y: 4.5,
    pts: [
      [-55, -17],
      [-50, -17],
      [-50, -27],
      [-41, -33],
      [-35, -44],
      [-35, -30],
      [-35, -20],
      [-30, -20],
      [-11, -20],
      [-11, -12],
      [2, -12],
      [26, -12],
      [72, -12],
      [72, 15],
      [70, 15],
    ],
  },
  {
    kind: 'intermediate',
    y: 5.5,
    pts: [
      [70, 15],
      [-4, 15],
    ],
  },
  {
    kind: 'finished',
    y: 3.5,
    pts: [
      [-4, 15],
      [-36, 15],
      [-62, 15],
      [-69, 20],
      [-86, 20],
      [-112, 20],
      [-112, 50],
      [-112, 62],
      [-112, 84],
      [-100, 96],
      [80, 96],
      [80, 110],
    ],
  },
];

export const FLOW_STAGES: FlowStage[] = [
  { n: 1, label: 'Raw materials', at: [-104, -30] },
  { n: 2, label: 'Preparation', at: [-62, -17] },
  { n: 3, label: 'Spray drying', at: [-35, -44] },
  { n: 4, label: 'Pressing', at: [-11, -20] },
  { n: 5, label: 'Drying', at: [13, -12] },
  { n: 6, label: 'Glazing', at: [50, -12] },
  { n: 7, label: 'Kiln', at: [33, 15] },
  { n: 8, label: 'Sorting', at: [-20, 15] },
  { n: 9, label: 'Packaging', at: [-55, 15] },
  { n: 10, label: 'Warehouse', at: [-112, 30] },
  { n: 11, label: 'Dispatch', at: [-112, 76] },
];

export const FLOW_COLORS: Record<FlowPath['kind'], string> = {
  raw: '#e0913f',
  intermediate: '#35c0dc',
  finished: '#4fd18b',
};

export const FLOW_LABELS: Record<FlowPath['kind'], string> = {
  raw: 'Raw materials',
  intermediate: 'Intermediate product',
  finished: 'Finished goods',
};
