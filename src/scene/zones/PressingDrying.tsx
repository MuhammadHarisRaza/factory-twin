import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Euler, Quaternion, Vector3, type Group, type Material } from 'three';
import type { Vec2, Vec3 } from '../../data/types';
import { BlobShadow, ControlCabinet, Cyl, Instances, Railing, ROT_Z90, type Instance } from '../primitives';
import { MAT } from '../materials';
import { Selectable } from '../Selectable';
import { machineAnimationRate } from '../status/shared';

/** X positions of the three hydraulic presses. */
export const PRESS_X = [-18, -11, -4];
/** Z position of the press line. */
export const PRESS_Z = -20;

// ---------------------------------------------------------------------------
// Kit: collects static boxes / cylinders per material and draws each material
// as one instanced mesh, so detailed machines stay cheap.
// ---------------------------------------------------------------------------

const NO_CAST = new Set<Material>([MAT.polycarbonate, MAT.glass, MAT.wrap, MAT.screen]);
const UP = new Vector3(0, 1, 0);
const ROT_X90: Vec3 = [Math.PI / 2, 0, 0];

type KitGroup = { m: Material; cyl: boolean; items: Instance[] };

class Kit {
  readonly groups: KitGroup[] = [];
  private add(m: Material, cyl: boolean, it: Instance) {
    let g = this.groups.find((x) => x.m === m && x.cyl === cyl);
    if (!g) {
      g = { m, cyl, items: [] };
      this.groups.push(g);
    }
    g.items.push(it);
    return this;
  }
  box(m: Material, p: Vec3, s: Vec3, r?: Vec3) {
    return this.add(m, false, r ? { p, s, r } : { p, s });
  }
  cyl(m: Material, p: Vec3, r: number, h: number, rot?: Vec3) {
    return this.add(m, true, rot ? { p, s: [r, h, r], r: rot } : { p, s: [r, h, r] });
  }
  /** Round bar / pipe between two points. */
  pipe(m: Material, a: Vec3, b: Vec3, r: number) {
    const va = new Vector3(...a);
    const dir = new Vector3(...b).sub(va);
    const len = dir.length();
    const q = new Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
    const e = new Euler().setFromQuaternion(q, 'XYZ');
    const mid = va.addScaledVector(dir, 0.5);
    return this.add(m, true, { p: [mid.x, mid.y, mid.z], s: [r, len, r], r: [e.x, e.y, e.z] });
  }
  run(m: Material, pts: Vec3[], r: number) {
    for (let i = 1; i < pts.length; i++) this.pipe(m, pts[i - 1], pts[i], r);
    return this;
  }
  /** Guard fence: safety-yellow posts and rails with polycarbonate panels along a polyline of [x, z]. */
  fence(pts: Vec2[], h = 2.2) {
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = -Math.atan2(z1 - z0, x1 - x0);
      const n = Math.max(1, Math.ceil(len / 1.5));
      for (let j = 0; j <= n; j++) {
        const f = j / n;
        this.box(MAT.safety, [x0 + (x1 - x0) * f, h / 2, z0 + (z1 - z0) * f], [0.08, h, 0.08]);
      }
      for (let j = 0; j < n; j++) {
        const f = (j + 0.5) / n;
        this.box(
          MAT.polycarbonate,
          [x0 + (x1 - x0) * f, 0.25 + (h - 0.35) / 2, z0 + (z1 - z0) * f],
          [len / n - 0.1, h - 0.35, 0.03],
          [0, yaw, 0],
        );
      }
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      this.box(MAT.safety, [mx, h - 0.03, mz], [len, 0.06, 0.06], [0, yaw, 0]);
      this.box(MAT.machineDark, [mx, 0.1, mz], [len, 0.2, 0.03], [0, yaw, 0]);
    }
    return this;
  }
  /** Vertical rung ladder (rails along y, rungs along z) at x, from y0 to y1, centred on z. */
  ladder(x: number, z: number, y0: number, y1: number) {
    for (const dz of [-0.25, 0.25]) this.box(MAT.galvanised, [x, (y0 + y1) / 2, z + dz], [0.06, y1 - y0, 0.06]);
    for (let y = y0 + 0.3; y < y1 - 0.1; y += 0.3) this.cyl(MAT.galvanised, [x, y, z], 0.018, 0.5, ROT_X90);
    return this;
  }
}

function KitMesh({ kit }: { kit: Kit }) {
  return (
    <>
      {kit.groups.map((g, i) => (
        <Instances key={i} items={g.items} m={g.m} cyl={g.cyl} cast={!NO_CAST.has(g.m)} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Hydraulic press (local coordinates: press centre on the floor, +z = outfeed
// side toward the collector conveyor, -z = hopper / feeder / power unit side).
// ---------------------------------------------------------------------------

/** Ram rest height and stroke. */
const RAM_Y = 3.0;
const RAM_TRAVEL = 1.15;
/** Tie-column positions [x, z]. */
const COLUMNS: Vec2[] = [
  [-1.4, -0.95],
  [1.4, -0.95],
  [-1.4, 0.95],
  [1.4, 0.95],
];
/** Hopper centre z (the D-BELT drop chute ends above it at y 7.9). */
const HOPPER_Z = -2.6;

const PRESS_KIT = (() => {
  const k = new Kit();
  // Foundation, lower crosshead, bolster and die set (die top at y 1.0 = conveyor height).
  k.box(MAT.plinth, [0, 0.06, 0], [4.6, 0.12, 3.8]);
  k.box(MAT.machineBlue, [0, 0.5, 0], [3.6, 0.76, 2.6]);
  k.box(MAT.machineDark, [0, 0.86, 0], [2.9, 0.04, 2.0]);
  k.box(MAT.stainless, [0, 0.94, 0], [2.4, 0.12, 1.7]);
  for (const cx of [-0.75, 0, 0.75]) k.box(MAT.machineDark, [cx, 1.003, 0], [0.62, 0.01, 0.62]);
  // Tie columns with collars and crown nuts.
  for (const [cx, cz] of COLUMNS) {
    k.cyl(MAT.stainless, [cx, 3.19, cz], 0.2, 4.62);
    k.cyl(MAT.machineDark, [cx, 0.95, cz], 0.28, 0.14);
    k.cyl(MAT.machineDark, [cx, 7.12, cz], 0.3, 0.24);
  }
  // Crown with a blue band, valve manifold and prefill tank.
  k.box(MAT.machine, [0, 6.25, 0], [3.9, 1.5, 2.8]);
  k.box(MAT.machineBlue, [0, 6.25, 0], [3.94, 0.32, 2.84]);
  k.box(MAT.machineBlue, [1.35, 7.3, 0.4], [0.7, 0.6, 0.9]);
  k.cyl(MAT.stainless, [-0.2, 8.3, 0.2], 0.45, 0.8);
  k.cyl(MAT.steel, [-0.2, 8.74, 0.2], 0.2, 0.1);
  // Ladder to the crown on the -x side, with stand-off brackets.
  k.ladder(-2.1, 0.6, 0, 7.9);
  for (const y of [2.2, 4.6]) k.box(MAT.steel, [-1.82, y, 0.6], [0.5, 0.06, 0.06]);

  // Hopper on its own four-leg frame (legs clear the carriage).
  for (const sx of [-1.2, 1.2])
    for (const sz of [HOPPER_Z - 1, HOPPER_Z + 1]) k.box(MAT.steel, [sx, 3.55, sz], [0.14, 7.1, 0.14]);
  for (const sz of [HOPPER_Z - 1, HOPPER_Z + 1]) k.box(MAT.steel, [0, 5.6, sz], [2.4, 0.12, 0.12]);
  for (const sx of [-1.2, 1.2]) {
    k.box(MAT.steel, [sx, 5.6, HOPPER_Z], [0.12, 0.12, 2.0]);
    k.box(MAT.steel, [sx, 2.4, HOPPER_Z], [0.12, 0.12, 2.0]);
  }
  k.box(MAT.galvanised, [0, 7.5, HOPPER_Z], [2.2, 0.8, 2.2]);
  k.box(MAT.machineDark, [0, 5.55, HOPPER_Z], [0.5, 0.2, 0.5]);
  k.cyl(MAT.rubber, [0, 3.55, HOPPER_Z], 0.18, 4.1);
  // Static powder feed box and carriage rails / drive.
  k.box(MAT.galvanised, [0, 1.25, HOPPER_Z], [2.0, 0.5, 0.9]);
  for (const sx of [-1.1, 1.1]) {
    k.box(MAT.steel, [sx, 0.95, -2.0], [0.1, 0.1, 2.4]);
    k.box(MAT.steel, [sx, 0.45, -3.1], [0.12, 0.9, 0.12]);
  }
  k.cyl(MAT.machineBlue, [0.5, 0.55, -3.45], 0.18, 0.55, ROT_Z90);
  k.box(MAT.machineDark, [0, 0.55, -3.45], [0.45, 0.4, 0.4]);

  // Outfeed transfer table onto the press roller conveyor (starts at local z 1.8).
  k.box(MAT.machineDark, [0, 0.92, 1.35], [1.5, 0.06, 0.95]);
  for (const z of [0.95, 1.25, 1.55]) k.cyl(MAT.roller, [0, 0.98, z], 0.05, 1.4, ROT_Z90);
  for (const x of [-0.36, 0.36]) k.box(MAT.greenTile, [x, 1.045, 1.4], [0.6, 0.03, 0.6]);

  // Hydraulic power unit behind the guard: tank, two motor-pump sets, accumulators, cooler.
  k.box(MAT.machineBlue, [0.4, 0.55, -5.5], [2.6, 1.1, 1.3]);
  k.box(MAT.machineDark, [0.4, 1.13, -5.5], [2.7, 0.06, 1.4]);
  for (const mx of [-0.3, 1.0]) {
    k.box(MAT.machineDark, [mx + 0.15, 1.21, -5.5], [1.0, 0.08, 0.5]);
    k.cyl(MAT.machineBlue, [mx, 1.5, -5.5], 0.26, 0.7, ROT_Z90);
    k.cyl(MAT.machineDark, [mx + 0.5, 1.48, -5.5], 0.18, 0.35, ROT_Z90);
  }
  for (const ax of [-1.35, -1.8]) {
    k.cyl(MAT.machineDark, [ax, 0.95, -5.5], 0.2, 1.7);
    k.cyl(MAT.steel, [ax, 1.88, -5.5], 0.09, 0.16);
  }
  k.box(MAT.machine, [2.1, 0.8, -5.5], [0.4, 1.2, 1.0]);
  k.run(
    MAT.pipeGrey,
    [
      [1.2, 1.2, -5.0],
      [1.65, 1.2, -5.0],
      [1.65, 6.8, -5.0],
      [1.65, 6.8, -1.4],
    ],
    0.06,
  );
  k.run(
    MAT.pipeGrey,
    [
      [1.5, 1.2, -4.7],
      [1.9, 1.2, -4.7],
      [1.9, 6.5, -4.7],
      [1.9, 6.5, -1.4],
    ],
    0.05,
  );

  // Guard fence with polycarbonate panels; gap at the front for the outfeed conveyor.
  k.fence([
    [-0.95, 1.6],
    [-2.9, 1.6],
    [-2.9, -4.3],
    [2.9, -4.3],
    [2.9, 1.6],
    [0.95, 1.6],
  ]);
  for (const x of [-0.88, 0.88]) k.box(MAT.machineDark, [x, 0.95, 1.6], [0.06, 1.5, 0.06]);
  return k;
})();

/** Upper platen, punch and piston rod (moves with the ram). */
const RAM_KIT = (() => {
  const k = new Kit();
  k.box(MAT.machineBlue, [0, 0, 0], [3.3, 0.8, 2.3]);
  k.box(MAT.stainless, [0, -0.575, 0], [2.3, 0.35, 1.6]);
  k.cyl(MAT.stainless, [0, 2.1, 0], 0.5, 3.4);
  for (const [cx, cz] of COLUMNS) k.cyl(MAT.machineDark, [cx, 0, cz], 0.3, 0.9);
  return k;
})();

/** Powder loading carriage (slides between the feed box and the die). */
const FEEDER_KIT = (() => {
  const k = new Kit();
  k.box(MAT.machineDark, [0, 1.18, 0], [2.0, 0.32, 1.1]);
  k.box(MAT.galvanised, [0, 1.4, -0.2], [1.8, 0.12, 0.6]);
  k.box(MAT.steel, [0, 1.05, -0.9], [0.12, 0.1, 0.8]);
  return k;
})();

const CROWN_RAIL: Vec2[] = [
  [-1.9, 0.95],
  [-1.9, 1.35],
  [1.9, 1.35],
  [1.9, -1.35],
  [-1.9, -1.35],
  [-1.9, 0.25],
];

/**
 * Hydraulic tile press with a cycling ram and a sliding powder-feed carriage. The stroke follows the
 * press's simulated state and rate (finding #37): it stands still while the press is down, starved,
 * blocked, on a planned stop or the simulation is paused.
 */
function Press({ id, x, phase }: { id: string; x: number; phase: number }) {
  const ram = useRef<Group>(null);
  const feeder = useRef<Group>(null);
  const t0 = useRef(phase);
  useFrame((_, frameDt) => {
    const dt = Math.min(frameDt, 0.1);
    const { rate, paused } = machineAnimationRate(id);
    if (rate > 0) t0.current += dt * 0.9 * rate;
    else if (!paused) {
      // A stopping press completes its stroke and rests with the ram up and the carriage back.
      const rest = Math.ceil(t0.current / Math.PI) * Math.PI;
      t0.current = Math.min(rest, t0.current + dt * 0.9);
    }
    const t = t0.current;
    const stroke = Math.sin(t);
    if (ram.current) ram.current.position.y = RAM_Y - Math.max(0, stroke) * RAM_TRAVEL;
    if (feeder.current) feeder.current.position.z = -1.6 + Math.max(0, -stroke) * 1.2;
  });
  return (
    <group position={[x, 0, PRESS_Z]}>
      <KitMesh kit={PRESS_KIT} />
      {/* Main cylinder on the crown */}
      <Cyl p={[0, 7.45, 0]} r={1.0} h={0.9} m={MAT.machineDark} />
      {/* Hopper cone */}
      <mesh material={MAT.galvanised} position={[0, 6.4, HOPPER_Z]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <cylinderGeometry args={[1.55, 0.22, 1.4, 4]} />
      </mesh>
      <group ref={ram} position={[0, RAM_Y, 0]}>
        <KitMesh kit={RAM_KIT} />
      </group>
      <group ref={feeder} position={[0, 0, -1.6]}>
        <KitMesh kit={FEEDER_KIT} />
      </group>
      <group position={[0, 7, 0]}>
        <Railing pts={CROWN_RAIL} />
      </group>
      <ControlCabinet p={[2.1, 0, 2.4]} w={1} />
      <BlobShadow p={[0, -1.6]} w={8} d={10} />
    </group>
  );
}

/** The three hydraulic presses. */
export function Presses() {
  return (
    <group>
      {PRESS_X.map((x, i) => (
        <Selectable key={x} id={`E-PRS${i + 1}`}>
          <Press id={`E-PRS${i + 1}`} x={x} phase={i * 2.1} />
        </Selectable>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Multi-deck roller dryer (world coordinates) along z = -12, x 1 … 24.6.
// ---------------------------------------------------------------------------

const DZ = -12;
const DX0 = 2.6;
const DX1 = 23.4;
const DCX = (DX0 + DX1) / 2;
const DLEN = DX1 - DX0;
const DHALF = 1.9;
/** Deck levels (lowest one matches the 1 m conveyor height). */
const DECK_Y = [1.0, 1.8, 2.6, 3.4, 4.2];
/** Infeed and outfeed elevator centre x and width. */
const ELEVATORS: { x: number; w: number; phase: number }[] = [
  { x: 1.8, w: 1.6, phase: 0 },
  { x: 24.0, w: 1.2, phase: 2.4 },
];

const DRYER_KIT = (() => {
  const k = new Kit();
  // Structural base frame.
  for (let i = 0; i < 9; i++) {
    const x = DX0 + 0.2 + (i * (DLEN - 0.4)) / 8;
    for (const sz of [-1.75, 1.75]) k.box(MAT.steel, [x, 0.35, DZ + sz], [0.2, 0.7, 0.2]);
    k.box(MAT.steel, [x, 0.72, DZ], [0.15, 0.15, 3.5]);
  }
  for (const sz of [-1.75, 1.75]) k.box(MAT.steel, [DCX, 0.72, DZ + sz], [DLEN, 0.2, 0.2]);
  // Insulated enclosure with panel ribs, top / bottom edge rails.
  k.box(MAT.insulation, [DCX, 3.0, DZ], [DLEN, 4.4, DHALF * 2]);
  k.box(MAT.kilnShell, [DCX, 0.86, DZ], [DLEN + 0.1, 0.14, DHALF * 2 + 0.1]);
  k.box(MAT.kilnShell, [DCX, 5.22, DZ], [DLEN + 0.1, 0.1, DHALF * 2 + 0.1]);
  for (let i = 0; i <= 16; i++) k.box(MAT.kilnShell, [DX0 + i * 1.3, 3.0, DZ], [0.08, 4.3, DHALF * 2 + 0.06]);
  // Inspection doors with handles and sight windows on both long sides.
  for (let j = 0; j < 8; j++) {
    const x = DX0 + 1.3 + j * 2.6;
    for (const s of [-1, 1]) {
      k.box(MAT.kilnShell, [x, 2.4, DZ + s * (DHALF + 0.02)], [1.0, 1.5, 0.05]);
      k.box(MAT.machineDark, [x + 0.35, 2.4, DZ + s * (DHALF + 0.05)], [0.06, 0.3, 0.05]);
      k.box(MAT.machineDark, [x, 2.85, DZ + s * (DHALF + 0.05)], [0.36, 0.22, 0.02]);
    }
  }
  // Deck openings visible at both ends.
  for (const y of DECK_Y)
    for (const x of [DX0 - 0.01, DX1 + 0.01]) k.box(MAT.machineDark, [x, y + 0.12, DZ], [0.04, 0.32, 3.0]);
  // Roller-deck drives (gearmotors with chain guards) at the outfeed end.
  for (const y of DECK_Y) {
    k.cyl(MAT.machineBlue, [22.4, y + 0.1, DZ - DHALF - 0.35], 0.13, 0.4, ROT_X90);
    k.box(MAT.safety, [22.75, y + 0.1, DZ - DHALF - 0.08], [0.7, 0.3, 0.12]);
  }

  // Roof: recirculation fan units, burner boxes, gas train, recirculation header.
  for (const ux of [5.2, 10.4, 15.6, 20.8]) {
    k.box(MAT.machine, [ux, 5.72, DZ + 0.1], [1.8, 0.9, 1.4]);
    k.box(MAT.machineDark, [ux, 5.27, DZ + 0.1], [1.9, 0.06, 1.5]);
    k.box(MAT.machineDark, [ux + 1.05, 5.45, DZ + 0.1], [0.5, 0.06, 0.5]);
    k.cyl(MAT.machineBlue, [ux + 1.15, 5.72, DZ + 0.1], 0.26, 0.6, ROT_Z90);
    k.box(MAT.machineGreen, [ux - 0.3, 5.58, DZ + 1.4], [0.7, 0.6, 0.6]);
    k.cyl(MAT.machineDark, [ux - 0.3, 5.58, DZ + 1.75], 0.13, 0.12, ROT_X90);
    k.pipe(MAT.pipeYellow, [ux - 0.3, 5.92, DZ + 1.6], [ux - 0.3, 5.92, DZ + 1.8], 0.04);
  }
  k.cyl(MAT.pipeYellow, [12.6, 5.92, DZ + 1.8], 0.05, 18.4, ROT_Z90);
  k.box(MAT.duct, [DCX, 6.42, DZ + 0.1], [17.4, 0.5, 0.6]);
  // Exhaust fans and risers to the roof.
  for (const ex of [7.8, 18.2]) {
    k.cyl(MAT.machine, [ex, 5.65, DZ - 1.3], 0.5, 0.8);
    k.cyl(MAT.machineBlue, [ex + 0.75, 5.6, DZ - 1.3], 0.2, 0.5, ROT_Z90);
    k.cyl(MAT.duct, [ex, 9.4, DZ - 1.3], 0.34, 6.8);
    k.cyl(MAT.duct, [ex, 12.8, DZ - 1.3], 0.42, 0.12);
    k.cyl(MAT.duct, [ex, 7.4, DZ - 1.3], 0.4, 0.12);
  }
  // Access ladder to the roof walkway.
  k.ladder(22.6, DZ + DHALF + 0.15, 0, 6.3);

  // Infeed / outfeed elevator frames (static part).
  for (const { x, w } of ELEVATORS) {
    for (const sx of [-1, 1])
      for (const sz of [-1.15, 1.15]) k.box(MAT.machineBlue, [x + sx * (w / 2 - 0.06), 3.0, DZ + sz], [0.12, 6.0, 0.12]);
    k.box(MAT.machineDark, [x, 0.12, DZ], [w + 0.1, 0.24, 2.5]);
    k.box(MAT.machineBlue, [x, 6.2, DZ], [w + 0.1, 0.4, 2.5]);
    k.cyl(MAT.machineBlue, [x, 6.62, DZ - 0.6], 0.2, 0.55, ROT_X90);
    k.box(MAT.safety, [x, 6.62, DZ + 0.4], [0.5, 0.35, 0.8]);
    for (const sz of [-1.18, 1.18]) k.box(MAT.polycarbonate, [x, 3.15, DZ + sz], [w - 0.15, 5.4, 0.03]);
  }
  // Short transfer table from the collector conveyor into the infeed elevator.
  k.box(MAT.machineDark, [1.05, 0.9, DZ], [0.25, 0.08, 1.7]);
  return k;
})();

/** One elevator cage: five roller shelves on a vertical frame (moves slowly up and down). */
function cageKit(w: number) {
  const k = new Kit();
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) k.box(MAT.steel, [sx * (w / 2 - 0.2), 2.65, sz * 1.0], [0.06, 3.5, 0.06]);
  DECK_Y.forEach((y, i) => {
    k.box(MAT.galvanised, [0, y - 0.07, 0], [w - 0.25, 0.05, 1.95]);
    for (const f of [-0.3, 0, 0.3]) k.cyl(MAT.roller, [f * w, y - 0.02, 0], 0.035, 1.85, ROT_X90);
    if (i % 2 === 0) k.box(MAT.greenTile, [0, y + 0.02, 0], [0.55, 0.025, 0.55]);
  });
  return k;
}
const CAGE_KITS = ELEVATORS.map((e) => cageKit(e.w));

const ROOF_RAIL: Vec2[] = [
  [22.2, DZ + DHALF],
  [DX0, DZ + DHALF],
  [DX0, DZ - DHALF],
  [DX1, DZ - DHALF],
  [DX1, DZ + DHALF],
  [23.0, DZ + DHALF],
];

function ElevatorCage({ i }: { i: number }) {
  const ref = useRef<Group>(null);
  const e = ELEVATORS[i];
  const t0 = useRef(e.phase);
  useFrame((_, frameDt) => {
    // The cages move with the dryer (F-DRY): still while it is stopped, starved or blocked, or paused.
    t0.current += Math.min(frameDt, 0.1) * 0.35 * machineAnimationRate('F-DRY').rate;
    if (ref.current) ref.current.position.y = 0.4 - 0.4 * Math.cos(t0.current);
  });
  return (
    <group ref={ref} position={[e.x, 0, DZ]}>
      <KitMesh kit={CAGE_KITS[i]} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Tile buffer (local coordinates, centred at x 26.5, z -22; infeed at z -18.6).
// ---------------------------------------------------------------------------

const BUF_LEVELS = [0.9, 1.7, 2.5, 3.3, 4.1, 4.9];

const BUFFER_KIT = (() => {
  const k = new Kit();
  for (const sx of [-1.4, 1.4]) {
    for (const sz of [-2.6, 0, 2.6]) k.box(MAT.machineBlue, [sx, 2.75, sz], [0.14, 5.5, 0.14]);
    k.box(MAT.machineBlue, [sx, 5.45, 0], [0.16, 0.16, 5.4]);
    k.box(MAT.polycarbonate, [sx * 1.06, 2.9, 0], [0.03, 4.8, 5.0]);
  }
  for (const sz of [-2.6, 2.6]) k.box(MAT.machineBlue, [0, 5.45, sz], [2.9, 0.16, 0.16]);
  BUF_LEVELS.forEach((y, i) => {
    for (const sx of [-1.3, 1.3]) k.box(MAT.galvanised, [sx, y - 0.06, 0], [0.08, 0.12, 5.2]);
    for (let j = 0; j <= 11; j++) k.cyl(MAT.roller, [0, y, -2.45 + j * 0.445], 0.035, 2.5, ROT_Z90);
    if (i !== 3 && i !== 5) k.box(MAT.greenTile, [0, y + 0.05, 0], [2.3, 0.03, 4.6]);
  });
  // Top drive housing.
  k.box(MAT.machineDark, [0, 5.72, -0.4], [2.9, 0.38, 4.4]);
  k.cyl(MAT.machineBlue, [0.9, 6.05, -1.8], 0.22, 0.6, ROT_Z90);
  // Front lift unit linking the 1 m infeed conveyor to the shelf levels.
  for (const sx of [-1.45, 1.45]) k.box(MAT.machineBlue, [sx, 2.9, 3.0], [0.14, 5.8, 0.14]);
  k.box(MAT.machineBlue, [0, 5.85, 3.0], [3.0, 0.3, 0.4]);
  k.box(MAT.machineDark, [0, 2.5, 3.0], [2.6, 0.12, 0.7]);
  k.cyl(MAT.machineBlue, [0.6, 6.2, 3.0], 0.18, 0.5, ROT_Z90);
  k.box(MAT.safety, [-0.5, 6.2, 3.0], [0.6, 0.3, 0.3]);
  return k;
})();

/** Horizontal multi-deck dryer plus the green-tile buffer rack after it. */
export function Dryer() {
  return (
    <group>
      <Selectable id="F-DRY">
        <KitMesh kit={DRYER_KIT} />
        <ElevatorCage i={0} />
        <ElevatorCage i={1} />
        <group position={[0, 5.25, 0]}>
          <Railing pts={ROOF_RAIL} />
        </group>
        <ControlCabinet p={[13, 0, -15.6]} w={2} rot={Math.PI} />
        <BlobShadow p={[13, -12]} w={27} d={8} />
      </Selectable>
      <Selectable id="F-BUF">
        <group position={[26.5, 0, -22]}>
          <KitMesh kit={BUFFER_KIT} />
          <BlobShadow p={[0, 0]} w={5} d={8} />
        </group>
      </Selectable>
    </group>
  );
}
