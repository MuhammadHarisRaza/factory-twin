import { Euler, Quaternion, Vector3, type Material } from 'three';
import type { Vec2, Vec3 } from '../../data/types';
import { BlobShadow, ControlCabinet, Cyl, Instances, Railing, ROT_Z90, Stair, type Instance } from '../primitives';
import { MAT } from '../materials';
import { Selectable } from '../Selectable';

/** Z position of the glazing line centre. */
const LINE_Z = -12;
const Z = LINE_Z;
/** Rack pipe height and runs (blue = water, grey = glaze supply). */
const RACK_Y = 5.42;
const BLUE_Z = -19.8;
const GREY_Z = -20.2;

// ---------------------------------------------------------------------------
// Kit: collects static boxes / cylinders per material and draws each material
// as one instanced mesh.
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
  pipe(m: Material, a: Vec3, b: Vec3, r: number) {
    const va = new Vector3(...a);
    const dir = new Vector3(...b).sub(va);
    const len = dir.length();
    const q = new Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
    const e = new Euler().setFromQuaternion(q, 'XYZ');
    const mid = va.addScaledVector(dir, 0.5);
    return this.add(m, true, { p: [mid.x, mid.y, mid.z], s: [r, len, r], r: [e.x, e.y, e.z] });
  }
  /** Pipe through points, with a small joint at every bend. */
  run(m: Material, pts: Vec3[], r: number) {
    for (let i = 1; i < pts.length; i++) this.pipe(m, pts[i - 1], pts[i], r);
    for (let i = 1; i < pts.length - 1; i++) this.box(m, pts[i], [r * 2.2, r * 2.2, r * 2.2]);
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

/** Thin tiles riding the belt (top of belt ≈ 1.01 m). */
function addTiles(k: Kit, x0: number, x1: number, m: Material) {
  for (let x = x0; x <= x1; x += 1.1) k.box(m, [x, 1.03, Z], [0.6, 0.025, 0.6]);
}

/** Enclosed airless spray booth with window, water-wash base, extraction hood, fan and duct to the roof. */
function addSprayBooth(k: Kit, cx: number, l: number) {
  k.box(MAT.machineDark, [cx, 0.35, Z], [l + 0.1, 0.5, 2.5]);
  k.box(MAT.machine, [cx, 1.6, Z], [l, 2.0, 2.4]);
  k.box(MAT.machineBlue, [cx, 2.62, Z], [l + 0.04, 0.1, 2.44]);
  k.box(MAT.machineDark, [cx, 1.85, Z + 1.21], [l - 0.6, 0.8, 0.02]);
  k.box(MAT.polycarbonate, [cx, 1.85, Z + 1.23], [l - 0.5, 0.9, 0.03]);
  k.box(MAT.machineDark, [cx + l / 2 - 0.25, 1.6, Z + 1.22], [0.05, 0.25, 0.04]);
  for (const s of [-1, 1]) k.box(MAT.machineDark, [cx + s * (l / 2 + 0.01), 1.12, Z], [0.03, 0.25, 1.8]);
  // Extraction: hood, riser, fan with motor, duct back to the wall and up to the roof.
  k.box(MAT.duct, [cx, 2.9, Z - 0.3], [l * 0.6, 0.5, 1.2]);
  k.cyl(MAT.duct, [cx, 4.7, Z - 0.3], 0.3, 3.2);
  k.cyl(MAT.machine, [cx, 6.6, Z - 0.3], 0.55, 0.6);
  k.cyl(MAT.machineBlue, [cx, 7.15, Z - 0.3], 0.2, 0.5);
  k.run(
    MAT.duct,
    [
      [cx, 6.6, Z - 0.8],
      [cx, 6.6, -19.4],
      [cx, 12.8, -19.4],
    ],
    0.25,
  );
  // Airless pump unit and slip tank beside the booth.
  k.cyl(MAT.stainless, [cx - 0.6, 0.45, Z - 1.95], 0.35, 0.9);
  k.box(MAT.machineBlue, [cx + 0.5, 0.4, Z - 1.85], [0.5, 0.8, 0.4]);
  k.run(
    MAT.rubber,
    [
      [cx + 0.5, 0.8, Z - 1.65],
      [cx + 0.5, 1.6, Z - 1.65],
      [cx + 0.5, 1.6, Z - 1.2],
    ],
    0.04,
  );
}

// ---------------------------------------------------------------------------
// G-LINE: cleaning / brushing, water spray, engobe bell, glaze bell, spray booth.
// ---------------------------------------------------------------------------

const CLEAN_X = 30.4;
const HUMID_X = 33.2;
const BELL_X = [36.6, 40.6];
const BOOTH_X = 44.8;
const INK_BOOTH_X = 64.5;

const LINE_KIT = (() => {
  const k = new Kit();
  // Cleaning / brushing unit with dust hood and extraction duct.
  {
    const cx = CLEAN_X;
    for (const sx of [-1.15, 1.15])
      for (const sz of [-1.05, 1.05]) k.box(MAT.steel, [cx + sx, 0.4, Z + sz], [0.12, 0.8, 0.12]);
    k.box(MAT.machineDark, [cx, 0.45, Z], [2.4, 0.3, 2.0]);
    k.box(MAT.machine, [cx, 1.575, Z], [2.6, 1.65, 2.3]);
    k.box(MAT.machineBlue, [cx, 2.45, Z], [2.64, 0.1, 2.34]);
    k.box(MAT.machineDark, [cx, 1.75, Z + 1.16], [1.8, 0.6, 0.02]);
    k.box(MAT.polycarbonate, [cx, 1.75, Z + 1.18], [1.9, 0.7, 0.03]);
    for (const s of [-1, 1]) k.box(MAT.machineDark, [cx + s * 1.31, 1.12, Z], [0.03, 0.22, 1.7]);
    for (const bx of [cx - 0.65, cx + 0.65]) {
      k.cyl(MAT.machineDark, [bx, 2.54, Z + 0.3], 0.26, 0.08);
      k.cyl(MAT.machineBlue, [bx, 2.8, Z + 0.3], 0.2, 0.5);
    }
    k.box(MAT.duct, [cx, 2.7, Z - 0.75], [1.2, 0.4, 0.6]);
    k.run(
      MAT.duct,
      [
        [cx, 2.9, Z - 0.75],
        [cx, 6.8, Z - 0.75],
        [cx, 6.8, -19.6],
        [cx, 12.8, -19.6],
      ],
      0.22,
    );
  }
  // Water-spray (humidifying) hood fed from the water main on the rack.
  {
    const cx = HUMID_X;
    for (const sx of [-0.6, 0.6])
      for (const sz of [-1.0, 1.0]) k.box(MAT.steel, [cx + sx, 0.45, Z + sz], [0.1, 0.9, 0.1]);
    k.box(MAT.machine, [cx, 1.5, Z], [1.4, 1.1, 2.1]);
    k.box(MAT.machineBlue, [cx, 2.08, Z], [1.44, 0.08, 2.14]);
    k.box(MAT.machineDark, [cx, 1.6, Z + 1.06], [0.9, 0.45, 0.02]);
    k.box(MAT.stainless, [cx, 0.62, Z], [1.6, 0.12, 2.0]);
    k.run(
      MAT.pipeBlue,
      [
        [cx, 2.1, Z - 0.6],
        [cx, RACK_Y, Z - 0.6],
        [cx, RACK_Y, BLUE_Z],
      ],
      0.05,
    );
  }
  // Waterfall bells (engobe, then glaze): gantry, reservoir, catch tray, tank, pump and hoses.
  for (const cx of BELL_X) {
    for (const sx of [-0.55, 0.55])
      for (const sz of [-1.3, 1.3]) k.box(MAT.steel, [cx + sx, 1.5, Z + sz], [0.14, 3.0, 0.14]);
    for (const sz of [-1.3, 1.3]) {
      k.box(MAT.steel, [cx, 0.1, Z + sz], [1.4, 0.2, 0.25]);
      k.box(MAT.machineBlue, [cx, 3.1, Z + sz], [1.3, 0.3, 0.25]);
    }
    k.box(MAT.machineBlue, [cx, 3.1, Z], [0.4, 0.3, 2.85]);
    k.cyl(MAT.stainless, [cx, 2.75, Z], 0.1, 0.6);
    k.cyl(MAT.stainless, [cx, 3.6, Z], 0.4, 0.7);
    k.cyl(MAT.steel, [cx, 3.98, Z], 0.43, 0.06);
    k.box(MAT.stainless, [cx, 0.62, Z], [2.2, 0.14, 2.3]);
    k.run(
      MAT.pipeGrey,
      [
        [cx, 0.55, Z - 1.15],
        [cx, 0.55, Z - 2.1],
      ],
      0.06,
    );
    // Glaze tank with agitator, and circulation pump.
    for (const [lx, lz] of [
      [-0.3, -0.3],
      [0.3, -0.3],
      [0, 0.35],
    ])
      k.box(MAT.steel, [cx + lx, 0.15, Z - 2.5 + lz], [0.08, 0.3, 0.08]);
    k.cyl(MAT.stainless, [cx, 0.75, Z - 2.5], 0.45, 0.9);
    k.cyl(MAT.steel, [cx, 1.22, Z - 2.5], 0.47, 0.05);
    k.cyl(MAT.machineBlue, [cx, 1.4, Z - 2.5], 0.12, 0.3);
    k.box(MAT.machineDark, [cx + 0.75, 0.06, Z - 2.5], [0.75, 0.12, 0.35]);
    k.cyl(MAT.machineBlue, [cx + 0.9, 0.33, Z - 2.5], 0.15, 0.45, ROT_Z90);
    k.cyl(MAT.machineDark, [cx + 0.5, 0.33, Z - 2.5], 0.12, 0.25, ROT_Z90);
    k.run(
      MAT.rubber,
      [
        [cx + 0.4, 0.45, Z - 2.5],
        [cx + 0.4, 4.3, Z - 2.5],
        [cx + 0.2, 4.3, Z],
        [cx + 0.2, 3.95, Z],
      ],
      0.05,
    );
  }
  addSprayBooth(k, BOOTH_X, 3.0);
  // Cable tray above and behind the line, hung from the roof steel.
  k.box(MAT.cableTray, [48.5, 4.8, -14.0], [39, 0.06, 0.5]);
  for (const dz of [-0.25, 0.25]) k.box(MAT.cableTray, [48.5, 4.86, -14.0 + dz], [39, 0.12, 0.03]);
  for (let x = 31; x <= 67; x += 4) k.box(MAT.steel, [x, 8.8, -14.0], [0.03, 8.0, 0.03]);
  addTiles(k, 28.6, 36.0, MAT.greenTile);
  addTiles(k, 38.2, 50.4, MAT.glazedTile);
  return k;
})();

// ---------------------------------------------------------------------------
// G-INK: digital inkjet printer and protective spray booth.
// ---------------------------------------------------------------------------

const PX0 = 51.6;
const PX1 = 59.6;
const PCX = (PX0 + PX1) / 2;
const PL = PX1 - PX0;

const INK_KIT = (() => {
  const k = new Kit();
  // Base, lower body (belt inside), solid end panels.
  k.box(MAT.machineDark, [PCX, 0.2, Z], [PL + 0.2, 0.4, 3.4]);
  k.box(MAT.machine, [PCX, 0.85, Z], [PL, 0.9, 3.2]);
  for (const x of [PX0 + 0.15, PX1 - 0.15]) k.box(MAT.machine, [x, 1.9, Z], [0.3, 1.2, 3.2]);
  // Window frames with polycarbonate panels on both long sides.
  for (const s of [-1, 1]) {
    const z = Z + s * 1.58;
    for (let i = 0; i <= 5; i++) k.box(MAT.machine, [PX0 + 0.3 + (i * (PL - 0.6)) / 5, 1.9, z], [0.1, 1.2, 0.06]);
    for (const y of [1.35, 2.45]) k.box(MAT.machine, [PCX, y, z], [PL, 0.1, 0.08]);
    k.box(MAT.polycarbonate, [PCX, 1.9, z], [PL - 0.6, 1.1, 0.03]);
  }
  // Interior: belt, colour bars and carriage beams visible through the windows.
  k.box(MAT.belt, [PCX, 1.31, Z], [PL - 0.6, 0.02, 1.6]);
  for (let i = 0; i < 6; i++) k.box(MAT.machineDark, [PCX - 2.5 + i, 2.05, Z], [0.55, 0.7, 2.4]);
  for (const s of [-1, 1]) k.box(MAT.stainless, [PCX, 2.35, Z + s * 1.25], [PL - 0.8, 0.12, 0.12]);
  for (let x = PX0 + 0.6; x < PX1 - 0.4; x += 1.1) k.box(MAT.glazedTile, [x, 1.335, Z], [0.6, 0.025, 0.6]);
  // Top cover with band, chiller / air-conditioning unit.
  k.box(MAT.machine, [PCX, 2.75, Z], [PL + 0.1, 0.5, 3.3]);
  k.box(MAT.machineBlue, [PCX, 2.56, Z], [PL + 0.14, 0.12, 3.34]);
  k.box(MAT.machine, [PX1 - 1.4, 3.35, Z - 0.4], [1.8, 0.7, 1.6]);
  k.box(MAT.machineDark, [PX1 - 1.4, 3.35, Z + 0.41], [1.4, 0.5, 0.02]);
  k.cyl(MAT.duct, [PX0 + 1.2, 3.4, Z - 0.6], 0.2, 0.8);
  // Infeed / outfeed slots.
  for (const x of [PX0 - 0.11, PX1 + 0.11]) k.box(MAT.machineDark, [x, 1.1, Z], [0.03, 0.25, 1.8]);
  // Operator HMI on a pedestal at the front.
  k.box(MAT.machineDark, [PX0 + 1.0, 0.03, Z + 2.2], [0.5, 0.06, 0.5]);
  k.cyl(MAT.steel, [PX0 + 1.0, 0.7, Z + 2.2], 0.06, 1.3);
  k.box(MAT.machine, [PX0 + 1.0, 1.45, Z + 2.2], [0.8, 0.55, 0.12], [-0.3, 0, 0]);
  k.box(MAT.screen, [PX0 + 1.0, 1.47, Z + 2.265], [0.66, 0.42, 0.02], [-0.3, 0, 0]);
  // Ink cabinets behind the printer, with tray carrying the ink lines.
  for (let i = 0; i < 4; i++) {
    const x = PCX - 2.4 + i * 1.6;
    k.box(MAT.machine, [x, 0.95, Z - 2.7], [1.3, 1.9, 0.8]);
    k.box(MAT.machineBlue, [x, 1.92, Z - 2.7], [1.32, 0.06, 0.82]);
    k.box(MAT.machineDark, [x, 1.4, Z - 2.29], [0.8, 0.5, 0.02]);
    k.box(MAT.machineDark, [x, 0.95, Z - 2.29], [0.02, 1.7, 0.02]);
  }
  k.box(MAT.cableTray, [PCX, 2.1, Z - 1.95], [6.0, 0.08, 0.7]);
  addSprayBooth(k, INK_BOOTH_X, 2.6);
  addTiles(k, 60.6, 70.5, MAT.glazedTile);
  return k;
})();

// ---------------------------------------------------------------------------
// G-PREP: agitated glaze vats with pumps, operator platform, glaze ball mill,
// pipe rack and supply drops to the line stations.
// ---------------------------------------------------------------------------

const GLAZE_PREP_X = [33, 38, 43, 48, 53, 58];
const VAT_Z = -26;
const PLAT_Z = -24.3;
const PLAT_X0 = 32;
const PLAT_X1 = 59.5;
const PLAT_H = 2.6;
const MILL_X = 66;
const MILL_Z = -25.5;

const PREP_KIT = (() => {
  const k = new Kit();
  for (const x of GLAZE_PREP_X) {
    for (const sx of [-0.9, 0.9])
      for (const sz of [-0.9, 0.9]) k.box(MAT.steel, [x + sx, 0.5, VAT_Z + sz], [0.14, 1.0, 0.14]);
    k.box(MAT.steel, [x, 0.95, VAT_Z], [2.2, 0.12, 2.2]);
    // Agitator bridge, gearbox and motor.
    k.box(MAT.steel, [x, 3.02, VAT_Z], [2.4, 0.22, 0.4]);
    k.cyl(MAT.machineDark, [x, 3.3, VAT_Z], 0.22, 0.35);
    k.cyl(MAT.machineBlue, [x, 3.8, VAT_Z], 0.26, 0.65);
    // Bottom outlet, transfer pump, discharge up to the glaze main.
    k.run(
      MAT.pipeGrey,
      [
        [x, 1.0, VAT_Z],
        [x, 0.4, VAT_Z],
        [x, 0.4, -23.15],
      ],
      0.06,
    );
    k.box(MAT.machineDark, [x, 0.08, -22.8], [0.5, 0.16, 1.0]);
    k.cyl(MAT.machineDark, [x, 0.4, -23.0], 0.16, 0.3, ROT_X90);
    k.cyl(MAT.machineBlue, [x, 0.4, -22.55], 0.2, 0.55, ROT_X90);
    k.run(
      MAT.pipeGrey,
      [
        [x, 0.4, -23.0],
        [x + 0.3, 0.4, -23.0],
        [x + 0.3, RACK_Y, -23.0],
        [x + 0.3, RACK_Y, GREY_Z],
      ],
      0.05,
    );
  }
  // Operator platform along the vat tops.
  k.box(MAT.galvanised, [(PLAT_X0 + PLAT_X1) / 2, PLAT_H, PLAT_Z], [PLAT_X1 - PLAT_X0, 0.08, 0.9]);
  for (const sz of [-0.42, 0.42]) {
    k.box(MAT.steel, [(PLAT_X0 + PLAT_X1) / 2, PLAT_H - 0.12, PLAT_Z + sz], [PLAT_X1 - PLAT_X0, 0.15, 0.08]);
    for (const x of [PLAT_X0 + 0.1, 35.5, 40.5, 45.5, 50.5, 55.5, PLAT_X1 - 0.1])
      k.box(MAT.steel, [x, PLAT_H / 2, PLAT_Z + sz], [0.1, PLAT_H, 0.1]);
  }
  // Glaze ball mill: drum heads, trunnions, pedestals, coupling guard, gearbox, motor.
  for (const s of [-1, 1]) {
    k.cyl(MAT.stainless, [MILL_X + s * 2.1, 1.8, MILL_Z], 0.25, 0.4, ROT_Z90);
    k.box(MAT.concreteWall, [MILL_X + s * 2.3, 0.775, MILL_Z], [0.6, 1.55, 1.6]);
  }
  k.box(MAT.machineDark, [MILL_X, 2.95, MILL_Z], [0.6, 0.12, 0.6]);
  k.box(MAT.safety, [MILL_X + 2.9, 1.8, MILL_Z], [0.5, 0.5, 0.5]);
  k.box(MAT.machineBlue, [MILL_X + 3.6, 1.5, MILL_Z], [0.8, 0.9, 0.9]);
  k.cyl(MAT.machineBlue, [MILL_X + 4.6, 1.5, MILL_Z], 0.38, 1.0, ROT_Z90);
  k.box(MAT.concreteWall, [MILL_X + 4.1, 0.52, MILL_Z], [2.3, 1.04, 1.2]);
  k.box(MAT.stainless, [MILL_X, 0.4, -23.3], [1.0, 0.8, 0.8]);
  // Pipe rack: posts with arms, longitudinal channels, water and glaze mains.
  for (let i = 0; i < 8; i++) {
    const x = 31 + i * 5;
    k.box(MAT.steel, [x, 2.6, -20], [0.25, 5.2, 0.25]);
    k.box(MAT.steel, [x, 5.2, -20], [0.2, 0.2, 1.4]);
  }
  for (const z of [-19.6, -20.4]) k.box(MAT.steel, [48.5, 5.2, z], [36, 0.2, 0.12]);
  k.cyl(MAT.pipeBlue, [48.5, RACK_Y, BLUE_Z], 0.09, 35, ROT_Z90);
  k.cyl(MAT.pipeGrey, [48.5, RACK_Y, GREY_Z], 0.09, 35, ROT_Z90);
  // Glaze supply drops from the rack to the bell tanks and spray booths.
  for (const bx of BELL_X)
    k.run(
      MAT.pipeGrey,
      [
        [bx - 0.2, RACK_Y, GREY_Z],
        [bx - 0.2, 5.9, GREY_Z],
        [bx - 0.2, 5.9, Z - 2.5],
        [bx - 0.2, 1.25, Z - 2.5],
      ],
      0.06,
    );
  for (const bx of [BOOTH_X, INK_BOOTH_X])
    k.run(
      MAT.pipeGrey,
      [
        [bx + 0.8, RACK_Y, GREY_Z],
        [bx + 0.8, 5.9, GREY_Z],
        [bx + 0.8, 5.9, Z - 1.05],
        [bx + 0.8, 2.6, Z - 1.05],
      ],
      0.06,
    );
  return k;
})();

const PLAT_RAIL: Vec2[] = [
  [PLAT_X0 + 0.9, PLAT_Z + 0.45],
  [PLAT_X1, PLAT_Z + 0.45],
  [PLAT_X1, PLAT_Z - 0.45],
];

/** Glazing line, digital inkjet decorator and the glaze preparation area behind them. */
export function Glazing() {
  return (
    <group>
      <Selectable id="G-LINE">
        <KitMesh kit={LINE_KIT} />
        {BELL_X.map((x) => (
          <group key={x}>
            {/* Bell dome and translucent glaze curtain falling into the catch tray. */}
            <Cyl p={[x, 2.25, Z]} r={0.95} rt={0.18} h={0.4} m={MAT.stainless} />
            <Cyl p={[x, 1.37, Z]} r={0.92} h={1.36} m={MAT.wrap} cast={false} />
          </group>
        ))}
        <ControlCabinet p={[33.6, 0, -15.2]} w={1.2} />
        <BlobShadow p={[37, Z]} w={20} d={7} />
      </Selectable>
      <Selectable id="G-INK">
        <KitMesh kit={INK_KIT} />
        <ControlCabinet p={[61, 0, Z - 2.7]} w={1.2} />
        <BlobShadow p={[58, Z]} w={17} d={8} />
      </Selectable>
      <Selectable id="G-PREP">
        <KitMesh kit={PREP_KIT} />
        {GLAZE_PREP_X.map((x) => (
          <group key={x}>
            <Cyl p={[x, 1.9, VAT_Z]} r={1.15} h={1.8} m={MAT.stainless} />
            <Cyl p={[x, 2.85, VAT_Z]} r={1.2} h={0.1} m={MAT.steel} />
          </group>
        ))}
        <Cyl p={[MILL_X, 1.8, MILL_Z]} r={1.1} h={3.6} m={MAT.machine} rot={ROT_Z90} />
        {[-1, 1].map((s) => (
          <Cyl key={s} p={[MILL_X + s * 1.85, 1.8, MILL_Z]} r={1.0} h={0.14} m={MAT.machineDark} rot={ROT_Z90} />
        ))}
        <group position={[0, PLAT_H, 0]}>
          <Railing pts={PLAT_RAIL} />
        </group>
        <Stair p={[28.8, 0, PLAT_Z]} h={PLAT_H} w={0.85} />
        <BlobShadow p={[48, -24.5]} w={44} d={8} />
      </Selectable>
    </group>
  );
}
