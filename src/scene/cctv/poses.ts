/**
 * Virtual CCTV positions of the digital twin — one per camera in src/model/plant.ts CAMERAS.
 *
 * Each pose is a camera mounted the way a real one would be: indoors on the hall's central column
 * line or inside the south wall at 7.5 m (under the 8.4 m cable trays), outdoors on a 11–13 m pole,
 * looking down at the equipment the camera covers. Mounts and fallback aim points follow the plant
 * layout (src/data/layout.ts zone rects, view presets and the material-flow route that is traced along
 * the real machine positions). When the 3D scene has registered the bounds of the focus equipment
 * (src/store.ts equipmentBounds), the camera aims at their centre instead — but only when that lies
 * within FOCUS_MAX_SHIFT of the layout aim point, so a camera never swings away from its zone.
 */
import type { Vec3 } from '../../data/types';

/** Vertical field of view of the virtual cameras (wide CCTV lens). */
export const CCTV_FOV = 50;
export const CCTV_NEAR = 0.3;
export const CCTV_FAR = 700;
/** Largest distance (m) between the layout aim point and the focus-bounds centre that is accepted. */
export const FOCUS_MAX_SHIFT = 20;
/** Height band (m) of the aim point: machines' working height, not their roofs or stacks. */
export const AIM_Y: [number, number] = [0.8, 4];

export type CctvPose = {
  /** Mount point (world metres, y up). */
  position: Vec3;
  /** Aim point from the layout. */
  target: Vec3;
  /** Equipment whose registered bounds refine the aim (centre of their union). */
  focus?: string[];
  fov?: number;
  mount: 'column' | 'wall' | 'pole';
};

export const CCTV_POSES: Record<string, CctvPose> = {
  // Pole beside the perimeter road east of the holding area: trucks arriving and queueing for a dock.
  'CAM-A1': { position: [2, 12, 94], target: [-38, 0.5, 70], focus: ['A-HOLD'], mount: 'pole' },
  // Pole at the south end of the receiving yard: weighbridge, tipping and the open west side of the shed.
  'CAM-B1': { position: [-138, 11, -3], target: [-112, 1, -30], focus: ['B-RCV', 'B-BAYS'], mount: 'pole' },
  // Hall column line at x −45.6: the ball mills, crusher and slip tanks of zone C.
  'CAM-C1': { position: [-46.5, 7.5, -1.2], target: [-58.5, 1.5, -17.5], focus: ['C-BM1', 'C-BM2', 'C-BM3'], mount: 'column' },
  // Pole on the utilities apron north-east of the tower: tower discharge, hot-air generator, powder belt into the hall.
  'CAM-D1': { position: [-12, 13, -63], target: [-35, 4, -44], focus: ['D-TWR'], mount: 'pole' },
  // Hall column at x 0: the three presses and the green-tile collector.
  'CAM-E1': { position: [-1.2, 7.5, -1.2], target: [-11, 1.5, -19], focus: ['E-PRS1', 'E-PRS2', 'E-PRS3'], mount: 'column' },
  // East end of the hall looking west along the glaze line towards the dryer.
  'CAM-G1': { position: [74, 7.5, -1.5], target: [40, 1.5, -12], focus: ['G-LINE', 'G-INK'], mount: 'column' },
  // Inside the south wall at the kiln entry: infeed roller transfer and the kiln's loading end.
  'CAM-H1': { position: [60, 7.5, 28.5], target: [71, 1.5, 12], mount: 'wall' },
  // Inside the south wall at the zone H / I boundary: kiln exit, gauge, vision tunnel and grade diverters.
  'CAM-I1': { position: [-6.5, 7.5, 28.5], target: [-22, 1.5, 15], focus: ['I-GAUGE', 'I-VIS', 'I-SORT'], mount: 'wall' },
  // Inside the south wall at the zone I / J boundary: packing, palletiser cell and the hall walkway.
  'CAM-J1': { position: [-39.5, 7.5, 28.5], target: [-57, 1.5, 14], focus: ['J-BOX', 'J-PAL', 'J-WRAP'], mount: 'wall' },
  // Pole on the dispatch yard's east edge: the six loading docks, trucks at the docks and the yard.
  'CAM-K1': { position: [-79, 12.5, 90], target: [-108, 2, 56], focus: ['K-DOCK'], mount: 'pole' },
};

/** Minimal box shape (three.js Box3 satisfies it) so this module stays free of three. */
export type BoundsLike = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

export type ResolvedPose = { position: Vec3; target: Vec3; fov: number; aimedAtBounds: boolean };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pose of a camera, aimed at its focus equipment when their bounds are known and plausible; null for an unknown camera. */
export function resolvePose(cameraId: string, bounds?: { get(id: string): BoundsLike | undefined }): ResolvedPose | null {
  const p = CCTV_POSES[cameraId];
  if (!p) return null;
  const base: ResolvedPose = { position: p.position, target: p.target, fov: p.fov ?? CCTV_FOV, aimedAtBounds: false };
  if (!bounds || !p.focus?.length) return base;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let n = 0;
  for (const id of p.focus) {
    const b = bounds.get(id);
    if (!b || !Number.isFinite(b.min.x) || !Number.isFinite(b.max.x)) continue;
    n++;
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    minZ = Math.min(minZ, b.min.z);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
    maxZ = Math.max(maxZ, b.max.z);
  }
  if (!n) return base;
  const c: Vec3 = [(minX + maxX) / 2, clamp((minY + maxY) / 2, AIM_Y[0], AIM_Y[1]), (minZ + maxZ) / 2];
  const shift = Math.hypot(c[0] - p.target[0], c[2] - p.target[2]);
  return shift <= FOCUS_MAX_SHIFT ? { ...base, target: c, aimedAtBounds: true } : base;
}
