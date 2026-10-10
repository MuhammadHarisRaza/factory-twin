import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Euler, Quaternion, Vector3, type Group, type Material } from 'three';
import type { Vec2, Vec3 } from '../../data/types';
import { MAT } from '../materials';
import { BlobShadow, Box, ControlCabinet, Cyl, Instances, Pallet, type Instance } from '../primitives';
import { Selectable } from '../Selectable';
import { Forklift } from '../vehicles';

/** z of the sorting / packaging line centreline. */
const LINE_Z = 15;

// ---------------------------------------------------------------------------------------------
// Instanced "kit" builder: static parts are collected per material and drawn as one
// instanced mesh per material, which keeps the mesh count of these detailed zones low.
// ---------------------------------------------------------------------------------------------

type Bucket = { m: Material; cyl: boolean; cast: boolean; items: Instance[] };

const ALONG_X: Vec3 = [0, 0, Math.PI / 2];
const ALONG_Z: Vec3 = [Math.PI / 2, 0, 0];
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);

class Kit {
  readonly buckets: Bucket[] = [];

  private put(m: Material, cyl: boolean, cast: boolean, it: Instance) {
    let b = this.buckets.find((x) => x.m === m && x.cyl === cyl && x.cast === cast);
    if (!b) {
      b = { m, cyl, cast, items: [] };
      this.buckets.push(b);
    }
    b.items.push(it);
  }

  private orient(axis: Vector3, a: Vec3, b: Vec3) {
    const d = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length();
    const e = new Euler().setFromQuaternion(new Quaternion().setFromUnitVectors(axis, d.normalize()), 'XYZ');
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return { len, mid, r: [e.x, e.y, e.z] as Vec3 };
  }

  box(m: Material, p: Vec3, s: Vec3, r?: Vec3, cast = true) {
    this.put(m, false, cast, r ? { p, s, r } : { p, s });
    return this;
  }

  /** Low-poly cylinder standing on y (or rotated by `rot`). */
  cyl(m: Material, p: Vec3, r: number, h: number, rot?: Vec3, cast = true) {
    this.put(m, true, cast, rot ? { p, s: [r, h, r], r: rot } : { p, s: [r, h, r] });
    return this;
  }

  cylX(m: Material, p: Vec3, r: number, len: number, cast = true) {
    return this.cyl(m, p, r, len, ALONG_X, cast);
  }

  cylZ(m: Material, p: Vec3, r: number, len: number, cast = true) {
    return this.cyl(m, p, r, len, ALONG_Z, cast);
  }

  /** Rectangular member from a to b (t = height, d = depth of the section). */
  beam(m: Material, a: Vec3, b: Vec3, t: number, d = t, cast = true) {
    const o = this.orient(AXIS_X, a, b);
    this.put(m, false, cast, { p: o.mid, s: [o.len, t, d], r: o.r });
    return this;
  }

  /** Round bar / pipe / hose from a to b. */
  rod(m: Material, a: Vec3, b: Vec3, r: number, cast = true) {
    const o = this.orient(AXIS_Y, a, b);
    this.put(m, true, cast, { p: o.mid, s: [r, o.len, r], r: o.r });
    return this;
  }
}

function KitMesh({ kit }: { kit: Kit }) {
  return (
    <>
      {kit.buckets.map((b, i) => (
        <Instances key={i} items={b.items} m={b.m} cyl={b.cyl} cast={b.cast} />
      ))}
    </>
  );
}

/** Small three-lamp stack light (unlit colours only). */
function stackLight(k: Kit, x: number, y: number, z: number) {
  k.cyl(MAT.machineDark, [x, y + 0.1, z], 0.04, 0.2);
  k.cyl(MAT.machineGreen, [x, y + 0.25, z], 0.06, 0.1);
  k.cyl(MAT.safety, [x, y + 0.35, z], 0.06, 0.1);
  k.cyl(MAT.safetyRed, [x, y + 0.45, z], 0.06, 0.1);
  k.cyl(MAT.machineDark, [x, y + 0.52, z], 0.05, 0.04);
}

/** Thin yellow floor-marking line from a to b (axis aligned). */
function floorLine(k: Kit, a: Vec2, b: Vec2, y = 0.052) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
  k.box(
    MAT.marking,
    [(a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2],
    alongX ? [len, 0.01, 0.1] : [0.1, 0.01, len],
    undefined,
    false,
  );
}

function floorRect(k: Kit, x0: number, x1: number, z0: number, z1: number, y = 0.052) {
  floorLine(k, [x0, z0], [x1, z0], y);
  floorLine(k, [x0, z1], [x1, z1], y);
  floorLine(k, [x0, z0], [x0, z1], y);
  floorLine(k, [x1, z0], [x1, z1], y);
}

// ---------------------------------------------------------------------------------------------
// Zone I — sorting & inspection
// ---------------------------------------------------------------------------------------------

/** Tiles travelling on the main line and the branch routes. */
function buildLineTiles() {
  const k = new Kit();
  const tile = (x: number, z: number) => k.box(MAT.glazedTile, [x, 1.04, z], [0.6, 0.03, 0.6], undefined, false);
  for (const x of [-6.2, -7.4, -9.3, -11.4, -14.4, -15.8, -18.2, -19.4, -26.2, -29.8, -33.2, -36.8]) tile(x, LINE_Z);
  tile(-24.5, 17.6);
  tile(-24.5, 19.6);
  tile(-28, 18.4);
  tile(-31.5, 17.2);
  tile(-31.5, 19.8);
  tile(-22.5, 12.2);
  tile(-34.5, 12.8);
  return k;
}

/** Planarity gauge: double portal with two laser sensor bars straddling the line. Local to (−9, 0, 15). */
function buildGauge() {
  const k = new Kit();
  const B = MAT.machineBlue;
  for (const x of [-0.8, 0.8])
    for (const z of [-1.25, 1.25]) {
      k.box(B, [x, 1.3, z], [0.2, 2.6, 0.2]);
      k.box(MAT.steel, [x, 0.03, z], [0.42, 0.06, 0.42]);
    }
  for (const x of [-0.8, 0.8]) k.box(B, [x, 2.72, 0], [0.26, 0.28, 2.76]);
  for (const z of [-1.25, 1.25]) k.box(B, [0, 2.72, z], [1.86, 0.24, 0.22]);
  k.box(MAT.machine, [0, 3.0, 0], [2.1, 0.3, 2.95]);
  k.box(MAT.machineDark, [0.45, 3.3, 0.55], [0.7, 0.3, 0.6]);
  for (const x of [-0.42, 0.42]) {
    k.box(MAT.machineDark, [x, 1.72, 0], [0.2, 0.16, 2.3]);
    for (const z of [-0.9, 0.9]) k.box(MAT.steel, [x, 2.19, z], [0.05, 0.78, 0.05]);
    for (let i = 0; i < 7; i++) k.box(MAT.machine, [x, 1.56, -1.02 + i * 0.34], [0.12, 0.18, 0.12]);
  }
  for (const z of [-1.25, 1.25]) {
    k.box(MAT.polycarbonate, [0, 1.75, z], [1.4, 1.5, 0.02], undefined, false);
    k.box(MAT.machineDark, [0, 0.62, z * 0.78], [1.7, 0.6, 0.04]);
  }
  k.rod(MAT.machineDark, [0.3, 3.0, 1.45], [0.3, 3.0, 2.6], 0.04);
  k.rod(MAT.machineDark, [0.3, 3.0, 2.6], [0.3, 1.95, 2.6], 0.04);
  stackLight(k, 0.85, 3.15, -1.3);
  return k;
}

/** Optical inspection tunnel: windowed hood with camera and light bars inside. Local to (−15, 0, 15). */
function buildVision() {
  const k = new Kit();
  const D = MAT.machineDark;
  const M = MAT.machine;
  for (const x of [-2.0, 0, 2.0])
    for (const z of [-1.25, 1.25]) k.box(D, [x, 0.58, z], [0.14, 1.16, 0.14]);
  for (const z of [-1.25, 1.25]) k.box(D, [0, 1.2, z], [4.5, 0.14, 0.16]);
  for (const x of [-2.2, -0.73, 0.73, 2.2])
    for (const z of [-1.35, 1.35]) k.box(D, [x, 2.08, z], [0.1, 1.76, 0.1]);
  for (const cx of [-1.465, 0, 1.465])
    for (const z of [-1.35, 1.35]) {
      k.box(M, [cx, 1.45, z], [1.37, 0.42, 0.05]);
      k.box(MAT.polycarbonate, [cx, 2.05, z], [1.37, 0.78, 0.03], undefined, false);
      k.box(M, [cx, 2.7, z], [1.37, 0.52, 0.05]);
    }
  for (const x of [-2.2, 2.2]) {
    k.box(M, [x, 2.25, 0], [0.05, 1.42, 2.7]);
    for (const z of [-1.12, 1.12]) k.box(M, [x, 1.38, z], [0.05, 0.32, 0.46]);
    for (let i = 0; i < 9; i++) k.box(MAT.rubber, [x, 1.3, -0.8 + i * 0.2], [0.02, 0.46, 0.18], undefined, false);
  }
  // Roof, raised camera ridge and cooling unit
  k.box(M, [0, 3.02, 0], [4.6, 0.12, 2.85]);
  k.box(M, [0.3, 3.32, 0.2], [3.4, 0.48, 1.0]);
  k.box(D, [-1.75, 3.32, -0.8], [0.8, 0.5, 0.75]);
  k.cyl(MAT.duct, [-1.75, 3.6, -0.8], 0.26, 0.08);
  // Camera bars, cameras and angled LED light bars inside the hood
  for (const x of [-0.8, 0.8]) {
    k.box(D, [x, 2.72, 0], [0.22, 0.22, 2.5]);
    for (const z of [-0.9, -0.3, 0.3, 0.9]) k.box(D, [x, 2.52, z], [0.14, 0.2, 0.14]);
    for (const s of [-1, 1]) {
      k.box(D, [x + s * 0.5, 2.46, 0], [0.14, 0.08, 2.4], [0, 0, s * 0.7]);
      k.box(MAT.lamp, [x + s * 0.47, 2.42, 0], [0.07, 0.04, 2.3], [0, 0, s * 0.7], false);
    }
  }
  // Operator console (aisle side)
  k.box(M, [0.6, 0.5, -2.4], [1.6, 1, 0.8]);
  k.box(D, [0.6, 1.04, -2.4], [1.64, 0.08, 0.84]);
  k.box(MAT.screen, [0.6, 1.42, -2.55], [1.0, 0.62, 0.05], [0.3, 0, 0], false);
  // Conduit from the hood down to the cabinet
  k.rod(D, [-1.5, 3.08, -1.2], [-1.5, 3.08, -2.4], 0.05);
  k.rod(D, [-1.5, 3.08, -2.4], [-1.5, 2.1, -2.4], 0.05);
  stackLight(k, 2.1, 3.08, -1.25);
  return k;
}

/** Branch points: reject (north), three grades (south), buffer (north). */
const DIVERTERS: { x: number; dir: 1 | -1 }[] = [
  { x: -22.5, dir: -1 },
  { x: -24.5, dir: 1 },
  { x: -28, dir: 1 },
  { x: -31.5, dir: 1 },
  { x: -34.5, dir: -1 },
];

/** Stacker bays at the ends of the grade branches; `stack` is the current stack height. */
const BAYS = [
  { x: -24.5, grade: 1, stack: 0.85 },
  { x: -28, grade: 2, stack: 0.6 },
  { x: -31.5, grade: 3, stack: 0.35 },
];

/** Grade marking portal, diverters, stacker bays and reject bin. World coordinates. */
function buildSorter() {
  const k = new Kit();
  const B = MAT.machineBlue;
  const D = MAT.machineDark;

  // Ink-jet grade marking portal ahead of the diverters
  for (const z of [13.75, 16.25]) {
    k.box(B, [-21, 1.15, z], [0.16, 2.3, 0.16]);
    k.box(MAT.steel, [-21, 0.03, z], [0.36, 0.06, 0.36]);
  }
  k.box(B, [-21, 2.36, LINE_Z], [0.24, 0.22, 2.8]);
  k.box(MAT.machine, [-21, 1.62, LINE_Z], [0.35, 0.3, 1.8]);
  for (const dz of [-0.6, -0.2, 0.2, 0.6]) k.box(D, [-21, 1.4, LINE_Z + dz], [0.12, 0.16, 0.12]);
  for (const dz of [-0.6, 0.6]) k.rod(MAT.steel, [-21, 1.77, LINE_Z + dz], [-21, 2.25, LINE_Z + dz], 0.035);
  k.box(MAT.machine, [-21, 0.6, 17.3], [0.7, 1.2, 0.6]);
  k.cyl(MAT.stainless, [-21, 1.4, 17.3], 0.17, 0.4);
  k.rod(D, [-21, 1.2, 17.0], [-21, 2.36, 16.4], 0.03);

  // Diverters: pop-up strip-belt transfer under the rollers plus a pneumatic pusher paddle
  for (const { x, dir } of DIVERTERS) {
    const zf = LINE_Z - dir * 1.2;
    k.box(D, [x, 0.5, LINE_Z], [1.3, 0.55, 1.5]);
    k.cylX(B, [x + 0.95, 0.5, LINE_Z - dir * 0.4], 0.14, 0.5);
    k.box(D, [x + 0.62, 0.5, LINE_Z - dir * 0.4], [0.24, 0.3, 0.3]);
    for (const dx of [-0.32, 0, 0.32]) k.box(MAT.belt, [x + dx, 1.0, LINE_Z], [0.07, 0.04, 1.55], undefined, false);
    k.box(B, [x, 0.75, zf], [0.16, 1.5, 0.16]);
    k.box(MAT.steel, [x, 0.03, zf], [0.36, 0.06, 0.36]);
    k.cylZ(MAT.stainless, [x, 1.3, zf + dir * 0.32], 0.08, 0.5);
    k.cylZ(MAT.steelLight, [x, 1.25, zf + dir * 0.56], 0.025, 0.3);
    k.box(MAT.safety, [x, 1.22, LINE_Z - dir * 0.63], [1.3, 0.16, 0.05]);
    // Photo-eye on the branch side
    k.box(D, [x + 0.95, 0.65, LINE_Z + dir * 1.0], [0.06, 1.3, 0.06]);
    k.box(MAT.machine, [x + 0.95, 1.2, LINE_Z + dir * 0.94], [0.1, 0.1, 0.1]);
  }

  // Grade stacker bays
  for (const { x, grade, stack } of BAYS) {
    const z0 = 21.2;
    const z1 = 23.8;
    const zc = (z0 + z1) / 2;
    // Infeed roller table from the branch conveyor
    for (const dx of [-0.62, 0.62]) k.box(D, [x + dx, 0.92, 21.35], [0.06, 0.14, 0.9]);
    for (let i = 0; i < 3; i++) k.cylX(MAT.roller, [x, 0.97, 21.05 + i * 0.3], 0.045, 1.2, false);
    // Four-post frame
    for (const px of [-1, 1])
      for (const pz of [z0, z1]) {
        k.box(B, [x + px, 1.65, pz], [0.14, 3.3, 0.14]);
        k.box(MAT.steel, [x + px, 0.03, pz], [0.32, 0.06, 0.32]);
      }
    for (const px of [-1, 1]) k.box(B, [x + px, 3.35, zc], [0.16, 0.2, z1 - z0 + 0.16]);
    for (const pz of [z0, z1]) k.box(B, [x, 3.35, pz], [2.14, 0.2, 0.16]);
    // Lift carriage with vacuum head
    const hc = 1.55 + stack;
    k.box(D, [x, hc + 0.25, zc], [2.0, 0.16, 0.2]);
    k.box(MAT.machine, [x, hc, zc], [0.72, 0.14, 0.72]);
    for (const sx of [-0.22, 0.22])
      for (const sz of [-0.22, 0.22]) k.cyl(MAT.rubber, [x + sx, hc - 0.11, zc + sz], 0.06, 0.08);
    k.rod(MAT.steel, [x - 0.3, hc + 0.33, zc], [x - 0.3, 3.25, zc], 0.025);
    k.rod(MAT.steel, [x + 0.3, hc + 0.33, zc], [x + 0.3, 3.25, zc], 0.025);
    // Lift drive on top
    k.cylX(B, [x + 0.35, 3.62, z1], 0.16, 0.5);
    k.box(D, [x - 0.1, 3.62, z1], [0.32, 0.32, 0.32]);
    // Stacking table and the growing stack
    k.box(D, [x, 0.4, 22.8], [1.1, 0.8, 1.1]);
    k.box(MAT.roller, [x, 0.82, 22.8], [1.0, 0.04, 1.0]);
    k.box(MAT.glazedTile, [x, 0.84 + stack / 2, 22.8], [0.62, stack, 0.62]);
    // Guarding: polycarbonate sides and back, dark kick plates
    for (const px of [-1.02, 1.02]) {
      k.box(MAT.polycarbonate, [x + px, 1.6, zc], [0.02, 2.2, 2.5], undefined, false);
      k.box(D, [x + px, 0.25, zc], [0.04, 0.4, 2.5]);
    }
    k.box(MAT.polycarbonate, [x, 1.6, z1 + 0.02], [1.9, 2.2, 0.02], undefined, false);
    // Grade plate: one to three white bars
    k.box(D, [x, 3.0, z0 - 0.09], [0.9, 0.36, 0.03]);
    for (let i = 0; i < grade; i++)
      k.box(MAT.glazedTile, [x + (i - (grade - 1) / 2) * 0.18, 3.0, z0 - 0.11], [0.08, 0.24, 0.02], undefined, false);
    // Floor marking: one lane per grade route plus the bay outline
    floorLine(k, [x - 0.9, 16.6], [x - 0.9, 20.7]);
    floorLine(k, [x + 0.9, 16.6], [x + 0.9, 20.7]);
    floorRect(k, x - 1.35, x + 1.35, 20.7, 24.3);
  }

  // Reject route end: chute into a cullet skip
  const bx = -22.5;
  const bz = 7.85;
  for (const dx of [-0.7, 0.7]) k.box(D, [bx + dx, 0.06, bz], [0.25, 0.12, 1.7]);
  k.box(MAT.steel, [bx, 0.16, bz], [2.3, 0.08, 1.7]);
  for (const dz of [-0.83, 0.83]) k.box(MAT.steel, [bx, 0.5, bz + dz], [2.3, 0.7, 0.05]);
  for (const dx of [-1.13, 1.13]) k.box(MAT.steel, [bx + dx, 0.5, bz], [0.05, 0.7, 1.7]);
  for (const dz of [-0.85, 0.85]) k.box(MAT.safetyRed, [bx, 0.87, bz + dz], [2.36, 0.06, 0.08]);
  for (const dx of [-1.16, 1.16]) k.box(MAT.safetyRed, [bx + dx, 0.87, bz], [0.08, 0.06, 1.74]);
  const shards: [number, number, number, number][] = [
    [-0.7, 0.42, -0.3, 0.4],
    [-0.3, 0.5, 0.2, -0.6],
    [0.2, 0.45, -0.4, 0.9],
    [0.6, 0.55, 0.3, -0.3],
    [-0.5, 0.6, 0.45, 1.2],
    [0.1, 0.62, 0.05, 0.2],
    [0.8, 0.4, -0.5, -1.0],
    [-0.9, 0.52, 0.5, 0.7],
  ];
  shards.forEach(([dx, y, dz, a], i) =>
    k.box(i % 3 ? MAT.glazedTile : MAT.greenTile, [bx + dx, y, bz + dz], [0.45, 0.03, 0.32], [a * 0.5, a, a * 0.3], false),
  );
  k.beam(MAT.galvanised, [bx, 0.95, 9.25], [bx, 0.8, 8.3], 0.03, 1.1);
  for (const dx of [-0.56, 0.56]) k.beam(MAT.galvanised, [bx + dx, 1.07, 9.25], [bx + dx, 0.92, 8.3], 0.25, 0.03);
  return k;
}

/** Accumulation buffer: five-level roller rack with a lift at the line end. Local to (−34.5, 0, 8.2). */
const BUF_LEVELS = [1.0, 1.9, 2.8, 3.7, 4.6];

function buildBuffer() {
  const k = new Kit();
  const B = MAT.machineBlue;
  for (const x of [-1.7, 1.7]) {
    for (const z of [-2, 0, 2]) {
      k.box(B, [x, 2.7, z], [0.16, 5.4, 0.16]);
      k.box(MAT.steel, [x, 0.03, z], [0.34, 0.06, 0.34]);
    }
    k.box(B, [x, 2.9, 3.4], [0.18, 5.8, 0.18]);
    k.box(MAT.steel, [x, 0.03, 3.4], [0.36, 0.06, 0.36]);
    k.box(B, [x, 5.45, 0.7], [0.18, 0.18, 5.6]);
    // Cross bracing on the outer faces
    k.beam(MAT.steel, [x * 1.06, 0.3, -2], [x * 1.06, 2.6, 0], 0.06);
    k.beam(MAT.steel, [x * 1.06, 0.3, 0], [x * 1.06, 2.6, -2], 0.06);
    k.beam(MAT.steel, [x * 1.06, 2.8, 0], [x * 1.06, 5.2, 2], 0.06);
    k.beam(MAT.steel, [x * 1.06, 2.8, 2], [x * 1.06, 5.2, 0], 0.06);
    // Lift guards and chains
    k.box(MAT.polycarbonate, [x * 1.05, 2.85, 2.7], [0.02, 5.1, 1.4], undefined, false);
    k.rod(MAT.steel, [x * 0.91, 0.3, 2.7], [x * 0.91, 5.55, 2.7], 0.03);
  }
  for (const z of [-2, 2, 3.4]) k.box(B, [0, 5.45, z], [3.56, 0.18, 0.18]);
  const fill = [4, 4, 3, 3, 2];
  BUF_LEVELS.forEach((y, li) => {
    for (const x of [-1.6, 1.6]) k.box(B, [x, y - 0.1, 0], [0.1, 0.16, 4.1]);
    for (let i = 0; i < 10; i++) k.cylX(MAT.roller, [0, y - 0.05, -1.85 + i * 0.41], 0.04, 3.1, false);
    for (let r = 0; r < fill[li]; r++)
      for (const x of [-0.85, 0, 0.85]) k.box(MAT.glazedTile, [x, y + 0.05, -1.55 + r * 0.95], [0.62, 0.12, 0.62]);
  });
  // Lift head: header, drive and front guard above the infeed
  k.box(MAT.machine, [0, 5.75, 2.7], [3.5, 0.3, 1.4]);
  k.box(MAT.machineDark, [0.4, 6.1, 2.7], [0.4, 0.4, 0.4]);
  k.cylX(B, [1.0, 6.1, 2.7], 0.2, 0.6);
  k.box(MAT.polycarbonate, [0, 3.5, 3.45], [3.3, 3.8, 0.02], undefined, false);
  return k;
}

function buildBufferCarriage() {
  const k = new Kit();
  k.box(MAT.machineDark, [0, -0.12, 2.7], [3.0, 0.1, 1.3]);
  for (const x of [-1.52, 1.52]) k.box(MAT.machineBlue, [x, 0.08, 2.7], [0.1, 0.3, 1.3]);
  for (const z of [2.25, 2.7, 3.15]) k.cylX(MAT.roller, [0, 0, z], 0.04, 2.95, false);
  return k;
}

/** QC bench with lit hood, reference tiles and a sample trolley. Local to (−13, 0, 24). */
function buildQC() {
  const k = new Kit();
  k.box(MAT.stainless, [0, 0.9, 0], [3.2, 0.08, 1.6]);
  for (const x of [-1.5, 1.5]) for (const z of [-0.7, 0.7]) k.box(MAT.steel, [x, 0.45, z], [0.08, 0.9, 0.08]);
  k.box(MAT.galvanised, [-0.4, 0.25, 0], [2.2, 0.04, 1.4]);
  k.box(MAT.machine, [1.0, 0.49, 0], [0.9, 0.74, 1.4]);
  for (const y of [0.3, 0.55, 0.78]) k.box(MAT.machineDark, [1.0, y, 0.71], [0.3, 0.03, 0.02], undefined, false);
  // Back panel with reference tiles
  k.box(MAT.machine, [0, 1.71, -0.76], [3.2, 1.55, 0.05]);
  for (let i = 0; i < 4; i++) k.box(MAT.glazedTile, [-1.2 + i * 0.8, 1.75, -0.72], [0.55, 0.55, 0.02], undefined, false);
  for (const x of [-1.55, 1.55]) k.box(MAT.steel, [x, 1.7, -0.7], [0.06, 1.6, 0.06]);
  // Light hood
  k.box(MAT.machine, [0, 2.55, -0.15], [3.2, 0.12, 1.3]);
  k.box(MAT.lamp, [0, 2.48, -0.15], [3, 0.03, 1.1], undefined, false);
  // Samples, straight edge and monitor
  for (const x of [-0.9, 0, 0.9]) k.box(MAT.glazedTile, [x, 0.955, 0.15], [0.6, 0.02, 0.6], undefined, false);
  k.box(MAT.steel, [-0.3, 0.975, 0.55], [1.2, 0.02, 0.06], undefined, false);
  k.rod(MAT.steel, [1.3, 0.94, -0.5], [1.3, 1.32, -0.5], 0.03);
  k.box(MAT.machineDark, [1.3, 1.5, -0.47], [0.64, 0.42, 0.03]);
  k.box(MAT.screen, [1.3, 1.5, -0.45], [0.58, 0.36, 0.01], undefined, false);
  // Mat and stool
  k.box(MAT.rubber, [0, 0.015, 1.25], [3.0, 0.03, 0.9], undefined, false);
  k.cyl(MAT.steel, [-0.6, 0.36, 1.1], 0.04, 0.7);
  k.cyl(MAT.machineDark, [-0.6, 0.73, 1.1], 0.2, 0.06);
  // Sample trolley
  for (const y of [0.3, 0.85]) k.box(MAT.galvanised, [-2.5, y, 0], [0.8, 0.04, 0.7]);
  for (const x of [-0.35, 0.35]) for (const z of [-0.3, 0.3]) k.box(MAT.steel, [-2.5 + x, 0.45, z], [0.04, 0.9, 0.04]);
  k.box(MAT.glazedTile, [-2.5, 1.0, 0], [0.62, 0.26, 0.62]);
  k.rod(MAT.steel, [-2.15, 0.85, -0.3], [-2.15, 1.15, 0.3], 0.02);
  return k;
}

const LINE_TILES = buildLineTiles();
const GAUGE = buildGauge();
const VISION = buildVision();
const SORTER = buildSorter();
const BUFFER = buildBuffer();
const BUFFER_CARRIAGE = buildBufferCarriage();
const QC = buildQC();

/** Buffer lift carriage moving slowly between the rack levels. */
function BufferLift() {
  const ref = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.y = 2.8 + 1.8 * Math.sin(clock.elapsedTime * 0.25) - 0.05;
  });
  return (
    <group ref={ref} position={[0, 0.95, 0]}>
      <KitMesh kit={BUFFER_CARRIAGE} />
    </group>
  );
}

/** Sorting zone: planarity gauge, vision inspection, grade sorter, QC table and buffer rack. */
export function Sorting() {
  return (
    <group>
      <KitMesh kit={LINE_TILES} />
      <Selectable id="I-GAUGE">
        <group position={[-9, 0, LINE_Z]}>
          <KitMesh kit={GAUGE} />
          <ControlCabinet p={[0, 0, 2.6]} w={0.9} h={1.8} />
        </group>
      </Selectable>
      <Selectable id="I-VIS">
        <group position={[-15, 0, LINE_Z]}>
          <KitMesh kit={VISION} />
          <ControlCabinet p={[-1.5, 0, -2.4]} w={1} h={2} rot={Math.PI} />
          <BlobShadow p={[0, 0]} w={6} d={4.5} />
        </group>
      </Selectable>
      <Selectable id="I-SORT">
        <KitMesh kit={SORTER} />
        <BlobShadow p={[-26, 18]} w={16} d={14} />
      </Selectable>
      <Selectable id="I-QC">
        <group position={[-13, 0, 24]}>
          <KitMesh kit={QC} />
        </group>
      </Selectable>
      <Selectable id="I-BUF">
        <group position={[-34.5, 0, 8.2]}>
          <KitMesh kit={BUFFER} />
          <BufferLift />
          <BlobShadow p={[0, 0.7]} w={6} d={8} />
        </group>
      </Selectable>
    </group>
  );
}

// ---------------------------------------------------------------------------------------------
// Zone J — packaging & palletising
// ---------------------------------------------------------------------------------------------

/** Stack counting & grouping station straddling the belt. Local to (−41, 0, 15). */
function buildCounter() {
  const k = new Kit();
  const B = MAT.machineBlue;
  for (const x of [-1.1, 1.1]) for (const z of [-1.1, 1.1]) k.box(MAT.machineDark, [x, 0.55, z], [0.12, 1.1, 0.12]);
  for (const z of [-0.95, 0.95]) k.box(MAT.machine, [0, 0.62, z], [2.3, 0.85, 0.4]);
  for (const x of [-1.15, 1.15]) for (const z of [-1.15, 1.15]) k.box(B, [x, 1.85, z], [0.08, 1.5, 0.08]);
  for (const z of [-1.15, 1.15]) k.box(MAT.polycarbonate, [0, 1.85, z], [2.22, 1.42, 0.02], undefined, false);
  for (const x of [-1.15, 1.15]) {
    k.box(MAT.polycarbonate, [x, 2.1, 0], [0.02, 0.95, 2.22], undefined, false);
    for (const z of [-0.92, 0.92]) k.box(MAT.machine, [x, 1.35, z], [0.03, 0.5, 0.46]);
  }
  k.box(MAT.machine, [0, 2.75, 0], [2.45, 0.3, 2.45]);
  k.box(MAT.machineDark, [-0.5, 3.05, 0], [0.8, 0.3, 0.8]);
  // Stacking guides, tile stack and hold-down
  for (const x of [-0.36, 0.36])
    for (const z of [-0.36, 0.36]) k.rod(MAT.steel, [x, 1.15, z], [x, 2.6, z], 0.025);
  k.box(MAT.glazedTile, [0, 1.36, 0], [0.6, 0.5, 0.6]);
  k.box(MAT.machineDark, [0, 1.78, 0], [0.62, 0.05, 0.62]);
  k.rod(MAT.stainless, [0, 1.8, 0], [0, 2.3, 0], 0.03);
  k.cyl(MAT.stainless, [0, 2.4, 0], 0.08, 0.4);
  // Counting photo-eye bar at the infeed
  k.box(MAT.machineDark, [0.85, 1.45, 0], [0.12, 0.12, 1.5]);
  for (const z of [-0.4, 0, 0.4]) k.box(MAT.machine, [0.85, 1.36, z], [0.08, 0.08, 0.08]);
  // HMI on a swing arm
  k.rod(MAT.steel, [1.15, 2.4, 1.15], [1.15, 2.4, 1.6], 0.035);
  k.rod(MAT.steel, [1.15, 2.4, 1.6], [1.15, 1.8, 1.6], 0.035);
  k.box(MAT.machineDark, [1.15, 1.55, 1.65], [0.55, 0.42, 0.08]);
  k.box(MAT.screen, [1.15, 1.55, 1.695], [0.47, 0.34, 0.01], undefined, false);
  stackLight(k, 1.0, 2.9, -1.0);
  // Grouped stack leaving towards the carton packer, single tile arriving
  k.box(MAT.glazedTile, [-2.4, 1.27, 0], [0.6, 0.32, 0.6]);
  k.box(MAT.glazedTile, [1.8, 1.13, 0], [0.6, 0.03, 0.6], undefined, false);
  return k;
}

/** Wrap-around carton packer with blank magazine, hot-melt unit and labeller. Local to (−48, 0, 15). */
function buildBoxer() {
  const k = new Kit();
  const B = MAT.machineBlue;
  const D = MAT.machineDark;
  k.box(D, [0, 0.52, 0], [6.4, 0.84, 2.8]);
  for (const x of [-3.2, -1.6, 0, 1.6, 3.2]) for (const z of [-1.4, 1.4]) k.box(B, [x, 1.83, z], [0.1, 1.78, 0.1]);
  for (const cx of [-2.4, -0.8, 0.8, 2.4])
    for (const z of [-1.4, 1.4]) {
      k.box(MAT.polycarbonate, [cx, 1.83, z], [1.5, 1.7, 0.02], undefined, false);
      k.box(D, [cx + 0.6, 1.8, z * 1.025], [0.04, 0.3, 0.04]);
    }
  for (const x of [-3.2, 3.2]) {
    k.box(MAT.machine, [x, 2.15, 0], [0.05, 1.15, 2.75]);
    for (const z of [-0.95, 0.95]) k.box(MAT.machine, [x, 1.26, z], [0.05, 0.64, 0.9]);
  }
  k.box(MAT.machine, [0, 2.85, 0], [6.5, 0.26, 2.9]);
  k.box(B, [0, 3.04, 0.95], [6.0, 0.12, 0.14]);
  k.box(MAT.machine, [1.8, 3.25, -0.6], [0.8, 0.55, 0.6]);
  k.rod(D, [1.4, 3.1, -0.6], [0.6, 2.98, -0.3], 0.03);
  // Folding crossheads and plungers inside
  for (const x of [-1.6, 0, 1.6]) {
    k.box(D, [x, 2.5, 0], [0.2, 0.2, 2.6]);
    for (const z of [-0.35, 0.35]) k.rod(MAT.steel, [x, 1.95, z], [x, 2.4, z], 0.035);
  }
  // Cartons at successive forming stages (flow towards −x)
  k.box(MAT.carton, [2.4, 1.13, 0], [1.0, 0.02, 0.8], undefined, false);
  k.box(MAT.carton, [0.8, 1.27, 0], [0.85, 0.3, 0.6]);
  k.box(MAT.carton, [0.8, 1.52, 0.42], [0.85, 0.02, 0.32], [0.9, 0, 0], false);
  k.box(MAT.carton, [-0.8, 1.29, 0], [0.9, 0.36, 0.6]);
  k.box(MAT.carton, [-2.4, 1.29, 0], [0.9, 0.36, 0.6]);
  // Carton blank magazine (aisle side)
  k.box(MAT.steel, [1.4, 0.35, -2.1], [2.4, 0.7, 1.2]);
  k.box(MAT.carton, [1.4, 1.12, -2.1], [2.1, 0.85, 1.0], [0.12, 0, 0]);
  for (const dx of [-1.12, 1.12]) for (const dz of [-0.55, 0.55]) k.box(B, [1.4 + dx, 1.1, -2.1 + dz], [0.06, 1.4, 0.06]);
  k.beam(D, [1.4, 1.95, -2.1], [1.4, 2.4, -1.42], 0.12);
  // Hot-melt glue unit with hoses
  k.box(MAT.machine, [-1.4, 0.8, -1.9], [0.9, 1.6, 0.8]);
  k.box(D, [-1.4, 1.65, -1.9], [0.95, 0.1, 0.85]);
  k.rod(D, [-1.4, 1.7, -1.9], [-1.4, 2.6, -1.9], 0.03);
  k.rod(D, [-1.4, 2.6, -1.9], [-1.4, 2.6, -1.42], 0.03);
  // Print-and-apply labeller at the outfeed
  k.box(MAT.steel, [-4.2, 0.03, 1.05], [0.4, 0.06, 0.4]);
  k.box(MAT.steel, [-4.2, 0.75, 1.05], [0.1, 1.5, 0.1]);
  k.box(MAT.machine, [-4.2, 1.5, 0.82], [0.45, 0.4, 0.35]);
  k.cylZ(MAT.glazedTile, [-4.2, 1.82, 0.95], 0.15, 0.1);
  return k;
}

const BOX_CONVEYOR_CARTONS: Instance[] = [-53, -54.5, -56, -57.5, -59].map((x) => ({
  p: [x, 1.32, LINE_Z] as Vec3,
  s: [0.9, 0.36, 0.6] as Vec3,
}));

/** One mesh-fence panel between two axis-aligned points (yellow posts are added by `fenceRun`). */
function fencePanel(k: Kit, a: Vec2, b: Vec2) {
  const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
  const len = Math.abs(alongX ? b[0] - a[0] : b[1] - a[1]);
  const cx = (a[0] + b[0]) / 2;
  const cz = (a[1] + b[1]) / 2;
  const S = (l: number, h: number, t: number): Vec3 => (alongX ? [l, h, t] : [t, h, l]);
  const P = (o: number, y: number): Vec3 => (alongX ? [cx + o, y, cz] : [cx, y, cz + o]);
  const inner = len - 0.1;
  k.box(MAT.polycarbonate, P(0, 1.22), S(inner, 1.94, 0.01), undefined, false);
  for (const y of [0.25, 2.2]) k.box(MAT.machineDark, P(0, y), S(inner, 0.04, 0.04), undefined, false);
  const n = Math.max(2, Math.round(inner / 0.25));
  for (let i = 1; i < n; i++) k.box(MAT.steel, P(-inner / 2 + (i * inner) / n, 1.22), S(0.012, 1.94, 0.012), undefined, false);
  for (let y = 0.5; y < 2.1; y += 0.25) k.box(MAT.steel, P(0, y), S(inner, 0.012, 0.012), undefined, false);
}

function fencePost(k: Kit, x: number, z: number) {
  k.box(MAT.safety, [x, 1.15, z], [0.08, 2.3, 0.08]);
  k.box(MAT.machineDark, [x, 0.02, z], [0.2, 0.04, 0.2]);
}

function fenceRun(k: Kit, a: Vec2, b: Vec2, n: number) {
  for (let i = 0; i <= n; i++) fencePost(k, a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n);
  for (let i = 0; i < n; i++)
    fencePanel(
      k,
      [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n],
      [a[0] + ((b[0] - a[0]) * (i + 1)) / n, a[1] + ((b[1] - a[1]) * (i + 1)) / n],
    );
}

function lightCurtainPost(k: Kit, x: number, z: number) {
  k.box(MAT.machineDark, [x, 0.95, z], [0.07, 1.7, 0.07]);
  k.box(MAT.safety, [x, 1.85, z], [0.09, 0.1, 0.09]);
  k.box(MAT.machineDark, [x, 0.02, z], [0.18, 0.04, 0.18]);
}

/** Robot cell: fence, gate post, light curtains, pallet stations, pick table, magazines. World coords. */
function buildCell() {
  const k = new Kit();
  const D = MAT.machineDark;
  // Fence: x −68…−59, z 10.5…19.5 with the gate on the aisle side, belt infeed east, pallet outfeed south.
  fenceRun(k, [-68, 10.5], [-66.5, 10.5], 1);
  fenceRun(k, [-65, 10.5], [-59, 10.5], 4);
  fenceRun(k, [-59, 10.5], [-59, 14.1], 2);
  fenceRun(k, [-59, 15.9], [-59, 19.5], 2);
  fenceRun(k, [-68, 19.5], [-64.6, 19.5], 2);
  fenceRun(k, [-62.4, 19.5], [-59, 19.5], 2);
  fenceRun(k, [-68, 10.5], [-68, 19.5], 5);
  k.box(MAT.safetyRed, [-65.08, 1.1, 10.42], [0.1, 0.16, 0.08]);
  // Light curtains at the infeed and outfeed openings
  lightCurtainPost(k, -58.85, 14.25);
  lightCurtainPost(k, -58.85, 15.75);
  lightCurtainPost(k, -64.45, 19.65);
  lightCurtainPost(k, -62.55, 19.65);
  // Infeed tunnel guard over the carton belt
  for (const z of [14.15, 15.85]) {
    k.box(MAT.polycarbonate, [-58.2, 1.25, z], [1.6, 1.3, 0.02], undefined, false);
    k.box(D, [-58.2, 1.9, z], [1.6, 0.04, 0.04], undefined, false);
    k.box(D, [-57.42, 1.25, z], [0.05, 1.3, 0.05]);
  }
  k.box(MAT.polycarbonate, [-58.2, 1.9, 15], [1.6, 0.02, 1.7], undefined, false);
  // Floor plate inside the cell
  k.box(MAT.plinth, [-63.5, 0.02, 15], [8.9, 0.02, 8.9], undefined, false);
  // Robot pedestal
  k.box(MAT.steel, [-63.5, 0.32, 15], [1.1, 0.64, 1.1]);
  k.box(D, [-63.5, 0.02, 15], [1.5, 0.04, 1.5]);
  // Carton pick table at the belt end
  for (const z of [-0.62, 0.62]) k.box(D, [-61.7, 1.0, 15 + z], [1.4, 0.16, 0.06]);
  for (let i = 0; i < 4; i++) k.cylZ(MAT.roller, [-61.15 - i * 0.37, 1.06, 15], 0.045, 1.2, false);
  for (const x of [-61.2, -62.2]) for (const z of [-0.6, 0.6]) k.box(MAT.steel, [x, 0.48, 15 + z], [0.06, 0.95, 0.06]);
  k.box(MAT.machineBlue, [-62.45, 1.25, 15], [0.06, 0.3, 1.2]);
  k.box(MAT.carton, [-61.75, 1.29, 15], [0.9, 0.36, 0.6]);
  // Pallet roller stations (south feeds the warehouse conveyor at z 18.6)
  const stations: { zc: number; layers: number }[] = [
    { zc: 17.75, layers: 4 },
    { zc: 12.1, layers: 2 },
  ];
  for (const { zc, layers } of stations) {
    for (const dx of [-0.72, 0.72]) k.box(D, [-63.5 + dx, 0.36, zc], [0.1, 0.26, 1.7]);
    for (let i = 0; i < 7; i++) k.cylX(MAT.roller, [-63.5, 0.45, zc - 0.75 + i * 0.25], 0.05, 1.4, false);
    for (const dx of [-0.72, 0.72]) for (const dz of [-0.75, 0.75]) k.box(MAT.steel, [-63.5 + dx, 0.12, zc + dz], [0.08, 0.24, 0.08]);
    k.cylZ(MAT.machineBlue, [-64.45, 0.32, zc], 0.12, 0.4);
    const pz = zc === 12.1 ? 12.1 : 17.9;
    k.box(MAT.pallet, [-63.5, 0.57, pz], [1.2, 0.14, 1]);
    for (let l = 0; l < layers; l++)
      for (const dx of [-0.3, 0.3])
        for (const dz of [-0.25, 0.25]) k.box(MAT.carton, [-63.5 + dx, 0.79 + l * 0.3, pz + dz], [0.59, 0.29, 0.49]);
  }
  k.box(MAT.carton, [-63.8, 1.39, 12.1 - 0.25], [0.59, 0.29, 0.49]);
  // Empty-pallet magazine
  for (let i = 0; i < 7; i++) k.box(MAT.pallet, [-66.5, 0.07 + i * 0.15, 17.9], [1.2, 0.13, 1]);
  for (const dx of [-0.68, 0.68])
    for (const dz of [-0.58, 0.58]) k.box(MAT.machineBlue, [-66.5 + dx, 1.0, 17.9 + dz], [0.07, 2.0, 0.07]);
  // Slip-sheet stack
  k.box(MAT.pallet, [-66.5, 0.07, 12.1], [1.2, 0.14, 1]);
  k.box(MAT.carton, [-66.5, 0.32, 12.1], [1.15, 0.35, 0.95]);
  // Operator panel at the gate
  k.box(MAT.steel, [-64.3, 0.6, 10.1], [0.12, 1.2, 0.12]);
  k.box(MAT.machine, [-64.3, 1.3, 10.1], [0.45, 0.4, 0.2]);
  k.box(MAT.screen, [-64.3, 1.32, 9.99], [0.32, 0.22, 0.01], undefined, false);
  return k;
}

/** Hinged access gate panel; hinge at local origin, panel towards −x. */
function buildGate() {
  const k = new Kit();
  fencePanel(k, [-1.45, 0], [-0.05, 0]);
  k.box(MAT.safety, [-1.45, 1.15, 0], [0.06, 2.1, 0.06]);
  k.box(MAT.machineDark, [-1.3, 1.1, -0.04], [0.04, 0.25, 0.04]);
  return k;
}

/** Rotating part of the palletising robot (turret, parallelogram arm, clamp gripper). */
function buildRobotArm() {
  const k = new Kit();
  const M = MAT.machine;
  const D = MAT.machineDark;
  k.box(M, [0, 0.32, 0], [1.0, 0.5, 0.9]);
  k.box(D, [-0.62, 0.55, 0], [0.45, 0.55, 0.62]);
  for (const z of [-0.36, 0.36]) k.box(M, [0.15, 0.85, z], [0.6, 0.8, 0.1]);
  k.cylZ(D, [0.18, 1.05, 0], 0.2, 0.9);
  k.cylZ(D, [0.18, 1.05, -0.55], 0.18, 0.22);
  k.beam(M, [0.18, 1.05, 0], [0.45, 2.55, 0], 0.34, 0.32);
  k.rod(D, [-0.42, 0.75, 0.25], [-0.42, 2.62, 0.25], 0.05);
  k.beam(M, [-0.5, 2.62, 0], [2.5, 2.42, 0], 0.32, 0.3);
  k.cylZ(D, [0.45, 2.56, 0], 0.19, 0.45);
  k.cylZ(D, [-0.42, 2.62, -0.3], 0.17, 0.3);
  k.box(D, [2.5, 2.3, 0], [0.32, 0.42, 0.32]);
  k.cyl(D, [2.5, 1.98, 0], 0.13, 0.22);
  k.box(D, [2.5, 1.82, 0], [0.95, 0.1, 0.75]);
  for (const z of [-0.36, 0.36]) k.box(MAT.steel, [2.5, 1.58, z], [0.9, 0.4, 0.03]);
  k.box(MAT.machineBlue, [2.5, 1.92, 0], [0.5, 0.12, 0.4]);
  k.box(MAT.carton, [2.5, 1.56, 0], [0.6, 0.32, 0.5]);
  k.rod(D, [0.0, 0.6, -0.4], [0.3, 2.45, -0.2], 0.035);
  return k;
}

/** Static part of the stretch wrapper (mast, foot, cap). Local to (−71, 0, 20). */
function buildWrapper() {
  const k = new Kit();
  const D = MAT.machineDark;
  k.box(D, [0, 0.04, 0], [2.9, 0.08, 2.9]);
  k.box(D, [0, 0.18, -2.0], [0.8, 0.36, 0.7]);
  k.box(MAT.machine, [0, 1.95, -2.0], [0.32, 3.2, 0.32]);
  k.box(D, [0, 1.95, -1.83], [0.12, 3.1, 0.02]);
  k.box(D, [0, 3.62, -2.0], [0.42, 0.14, 0.42]);
  k.cyl(MAT.machineBlue, [0, 3.84, -2.0], 0.12, 0.3);
  k.rod(D, [0.2, 3.5, -2.1], [0.2, 0.4, -2.1], 0.03);
  for (const [x, z] of [
    [-1.6, -1.6],
    [1.6, -1.6],
    [-1.6, 1.6],
    [1.6, 1.6],
  ] as Vec2[])
    k.box(MAT.safety, [x, 0.5, z], [0.1, 1.0, 0.1]);
  floorRect(k, -1.75, 1.75, -1.4, 1.75);
  return k;
}

function buildFilmCarriage() {
  const k = new Kit();
  k.box(MAT.machine, [0, 0, -1.68], [0.55, 0.6, 0.3]);
  k.cyl(MAT.wrap, [0.18, 0, -1.42], 0.13, 0.5);
  for (const x of [-0.08, -0.2]) k.cyl(MAT.roller, [x, 0, -1.47], 0.04, 0.5, undefined, false);
  k.box(MAT.safety, [0, -0.32, -1.5], [0.55, 0.04, 0.3]);
  k.box(MAT.safety, [0, 0.32, -1.5], [0.55, 0.04, 0.3]);
  return k;
}

const COUNTER = buildCounter();
const BOXER = buildBoxer();
const CELL = buildCell();
const GATE = buildGate();
const ROBOT_ARM = buildRobotArm();
const WRAPPER = buildWrapper();
const FILM_CARRIAGE = buildFilmCarriage();

const STAGING = (() => {
  const k = new Kit();
  floorRect(k, -58.8, -45.2, 22.2, 27.8, 0.066);
  for (const x of [-57.4, -55.8, -54.2, -52.6, -51]) floorLine(k, [x, 22.6], [x, 25.2], 0.066);
  return k;
})();

/** Palletising robot on its pedestal; the turret swings between the pick table and the two pallets. */
function PalletisingRobot() {
  const arm = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (arm.current) arm.current.rotation.y = (Math.PI / 2) * Math.sin(clock.elapsedTime * 0.4);
  });
  return (
    <group position={[-63.5, 0, LINE_Z]}>
      <Cyl p={[0, 0.8, 0]} r={0.5} h={0.32} m={MAT.machineDark} seg={20} />
      <group ref={arm} position={[0, 0.96, 0]}>
        <Cyl p={[0, 0.03, 0]} r={0.46} h={0.08} m={MAT.machine} seg={20} />
        <KitMesh kit={ROBOT_ARM} />
      </group>
    </group>
  );
}

/** Turntable stretch wrapper with mast and rising film carriage. */
function StretchWrapper() {
  const table = useRef<Group>(null);
  const carriage = useRef<Group>(null);
  useFrame(({ clock }, delta) => {
    if (table.current) table.current.rotation.y += delta * 0.6;
    if (carriage.current) carriage.current.position.y = 1.5 + 0.7 * Math.sin(clock.elapsedTime * 0.35);
  });
  return (
    <group position={[-71, 0, 20]}>
      <KitMesh kit={WRAPPER} />
      <group ref={table}>
        <Cyl p={[0, 0.18, 0]} r={1.35} h={0.2} m={MAT.machineDark} />
        <Cyl p={[0, 0.3, 0]} r={1.4} h={0.05} m={MAT.machine} />
        <Pallet p={[0, 0.54, 0]} cartons={4} wrap />
      </group>
      <group ref={carriage} position={[0, 1.5, 0]}>
        <KitMesh kit={FILM_CARRIAGE} />
      </group>
      <ControlCabinet p={[-1.6, 0, -2.0]} w={0.7} h={1.6} />
      <BlobShadow p={[0, -0.3]} w={4} d={5} />
    </group>
  );
}

/** Packaging zone: counter, boxing machine, palletising cell, stretch wrapper and outfeed staging. */
export function Packaging() {
  return (
    <group>
      <Selectable id="J-CNT">
        <group position={[-41, 0, LINE_Z]}>
          <KitMesh kit={COUNTER} />
        </group>
      </Selectable>
      <Selectable id="J-BOX">
        <group position={[-48, 0, LINE_Z]}>
          <KitMesh kit={BOXER} />
          <ControlCabinet p={[3.9, 0, 1.6]} w={1} rot={-Math.PI / 2} />
          <BlobShadow p={[0, 0]} w={10} d={7} />
        </group>
        <Instances items={BOX_CONVEYOR_CARTONS} m={MAT.carton} />
      </Selectable>
      <Selectable id="J-PAL">
        <KitMesh kit={CELL} />
        <group position={[-65, 0, 10.5]} rotation={[0, -0.5, 0]}>
          <KitMesh kit={GATE} />
        </group>
        <PalletisingRobot />
        <ControlCabinet p={[-57.6, 0, 11.2]} w={0.9} h={1.9} />
      </Selectable>
      <Selectable id="J-WRAP">
        <StretchWrapper />
      </Selectable>
      <group>
        <Pallet p={[-66.5, 0.54, 20]} cartons={4} />
        <Pallet p={[-74.9, 0.54, 20]} cartons={4} wrap />
        <Box p={[-52, 0.05, 25]} s={[14, 0.02, 6]} m={MAT.plinth} cast={false} />
        <KitMesh kit={STAGING} />
        <Pallet p={[-56.6, 0, 24]} cartons={4} wrap />
        <Pallet p={[-55, 0, 24]} cartons={4} wrap />
        <Pallet p={[-53.4, 0, 24]} cartons={3} wrap />
        <Pallet p={[-51.8, 0, 24]} cartons={4} wrap />
        <Forklift p={[-48.5, 0, 25.5]} rot={Math.PI} />
      </group>
    </group>
  );
}
