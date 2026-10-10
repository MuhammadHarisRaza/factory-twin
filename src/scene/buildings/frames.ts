import { HALL, HALL_FRAMES, RAW_SHED, WAREHOUSE, WORKSHOP } from '../../data/layout';
import type { Range, Rect } from '../../data/types';

/** `n + 1` evenly spaced values from `a` to `b` inclusive. */
export const linspace = (a: number, b: number, n: number) =>
  Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

/** full = wall up to the eave, cut = cut-away low wall (to see inside), open = no wall. */
export type WallMode = 'full' | 'cut' | 'open';

/** Portal-framed shed: duo-pitch spans across z, frames along x. */
export type BuildingFrame = {
  id: string;
  rect: Rect;
  /** Z ranges of each gabled span. */
  spans: Range[];
  eave: number;
  /** Ridge height above the eave. */
  rise: number;
  /** X positions of the portal frames. */
  frames: number[];
  /** Wall treatment per side (n = -z, s = +z, w = -x, e = +x). */
  walls: { n: WallMode; s: WallMode; e: WallMode; w: WallMode };
  /** Height of the cut-away walls. */
  cutH: number;
  /** Lattice trusses (true) or plain rafters (false). */
  trussed: boolean;
};

export const BUILDING_FRAMES: BuildingFrame[] = [
  {
    id: 'hall',
    rect: HALL.rect,
    spans: [
      [-30, 0],
      [0, 30],
    ],
    eave: HALL.eave,
    rise: HALL.ridge - HALL.eave,
    frames: HALL_FRAMES,
    walls: { n: 'full', s: 'cut', e: 'cut', w: 'cut' },
    cutH: 2.6,
    trussed: true,
  },
  {
    id: 'raw',
    rect: RAW_SHED.rect,
    spans: [
      [-50, -27],
      [-27, -4],
    ],
    eave: RAW_SHED.eave,
    rise: RAW_SHED.ridge - RAW_SHED.eave,
    frames: linspace(-118, -80, 5),
    walls: { n: 'full', s: 'cut', e: 'cut', w: 'open' },
    cutH: 2.6,
    trussed: false,
  },
  {
    id: 'warehouse',
    rect: WAREHOUSE.rect,
    spans: [
      [4, 29.1],
      [29.1, 60],
    ],
    eave: WAREHOUSE.eave,
    rise: WAREHOUSE.ridge - WAREHOUSE.eave,
    frames: linspace(-132, -80, 6),
    walls: { n: 'full', s: 'cut', e: 'cut', w: 'full' },
    cutH: 6.2,
    trussed: true,
  },
  {
    id: 'maint',
    rect: WORKSHOP.rect,
    spans: [
      [-8, 11],
      [11, 30],
    ],
    eave: WORKSHOP.eave,
    rise: WORKSHOP.ridge - WORKSHOP.eave,
    frames: linspace(79, 104, 4),
    walls: { n: 'full', s: 'cut', e: 'cut', w: 'full' },
    cutH: 2.4,
    trussed: false,
  },
];
