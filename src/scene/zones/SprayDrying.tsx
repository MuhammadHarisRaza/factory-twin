import { useMemo } from 'react';
import type { Vec2, Vec3 } from '../../data/types';
import { MAT } from '../materials';
import {
  BlobShadow,
  Box,
  ControlCabinet,
  Cyl,
  Instances,
  Motor,
  Pipe,
  PipeRun,
  ROT_Z90,
  Stair,
  type Instance,
} from '../primitives';
import { Selectable } from '../Selectable';

/* ------------------------------------------------------------------------------------------------
 * Zone D layout (world metres). The tower steel (Structure.tsx) frames x -47…-23, z -57…-31 with
 * ring beams at y 8 / 16 / 24 / 30 and access decks along its north and south faces. The dryer
 * chamber stands on its own ring girder and legs in the middle of the tower and is tied back to the
 * tower steel at the 16 m and 24 m levels. Hot air enters the roof disperser from the hot-air
 * generator on the west side; exhaust air leaves the cone to the cyclones and bag filter on the
 * east side; powder drops through a rotary valve onto the belt running south into the hall.
 * ---------------------------------------------------------------------------------------------- */

/** Spray-dryer chamber axis on the ground plane. */
const TOWER_X = -35;
const TOWER_Z = -44;
/** Chamber geometry (local to the chamber axis). */
const CH_R = 5;
const OUT_Y = 4.4;
const CONE_TOP = 14;
const CYL_TOP = 26;
const ROOF_TOP = 27.2;
const LEG_R = 5.45;

/** Powder silo grid and silo proportions. */
const SILO_X = [-41, -35, -29];
const SILO_Z = [-24, -17];
const SILO_R = 1.8;
const SILO_H = 4.3;
const SILO_LEG = 2;
const SILO_CONE = 1.9;
const SILO_TOP = SILO_LEG + SILO_CONE + SILO_H;
/** Belt lines over and under the silos (from Conveyors.tsx). */
const SILO_BELT_Z = -20.5;
const SILO_TOP_BELT_Y = 10;
const SILO_LOW_BELT_Y = 1.1;

/** Cyclone positions and bag-filter centre. */
const CYC_X = -27;
const CYC_Z = [-47.4, -51];
const CYC_R = 1.3;
const BF: Vec2 = [-28.4, -38.2];
/** Exhaust fan and stack. */
const FAN: Vec3 = [-24.4, 2, -37];
const STACK: Vec2 = [-24.4, -41.5];

/** Hot-air generator: combustion chamber axis (along z) and riser position. */
const HAG_X = -42.5;
const HAG_Z = -50.5;
const RISER_Z = -47.3;
const HOT_DUCT_Y = 28.1;

/* ----------------------------------------------------------------------------------- helpers */

/** Guard-rail polyline items (two rails + posts) at height `y`. */
function railItems(pts: Vec2[], y: number, h = 1.1): Instance[] {
  const out: Instance[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = -Math.atan2(z1 - z0, x1 - x0);
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    out.push({ p: [mx, y + h, mz], s: [len, 0.06, 0.06], r: [0, yaw, 0] });
    out.push({ p: [mx, y + h * 0.5, mz], s: [len, 0.05, 0.05], r: [0, yaw, 0] });
    const posts = Math.max(1, Math.round(len / 1.6));
    for (let j = 0; j < posts; j++)
      out.push({ p: [x0 + ((x1 - x0) * j) / posts, y + h / 2, z0 + ((z1 - z0) * j) / posts], s: [0.07, h, 0.07] });
  }
  const [lx, lz] = pts[pts.length - 1];
  out.push({ p: [lx, y + h / 2, lz], s: [0.07, h, 0.07] });
  return out;
}

/** Points on a circular arc in the x/z plane (angles in radians, a = atan2(z, x)). */
function arc(cx: number, cz: number, r: number, a0: number, a1: number, n: number): Vec2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + Math.cos(a) * r, cz + Math.sin(a) * r] as Vec2;
  });
}

/** Instanced cylinder (UNIT_CYLINDER_LOW) between two points lying in a constant-x plane. */
function yzPipe(a: Vec3, b: Vec3, r: number): Instance {
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return {
    p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    s: [r, Math.hypot(dy, dz), r],
    r: [Math.atan2(dz, dy), 0, 0],
  };
}

/* -------------------------------------------------------------------------- static instances */

const LEG_ANGLES = Array.from({ length: 8 }, (_, i) => ((22.5 + 45 * i) * Math.PI) / 180);

/** Chamber support legs, low-level bracing ring, tie beams to the tower steel, slip-riser clips (chamber-local). */
const TOWER_STEEL: Instance[] = [
  ...LEG_ANGLES.map((a): Instance => ({
    p: [Math.cos(a) * LEG_R, CONE_TOP / 2, Math.sin(a) * LEG_R],
    s: [0.45, CONE_TOP, 0.45],
  })),
  ...Array.from({ length: 8 }, (_, i): Instance => {
    const t = (i * Math.PI) / 4;
    const rc = LEG_R * Math.cos(Math.PI / 8);
    return {
      p: [Math.cos(t) * rc, 4.2, Math.sin(t) * rc],
      s: [2 * LEG_R * Math.sin(Math.PI / 8), 0.3, 0.3],
      r: [0, -t - Math.PI / 2, 0],
    };
  }),
  ...[16, 24].flatMap((y): Instance[] => [
    { p: [8.5, y, 0], s: [7, 0.4, 0.3] },
    { p: [-8.5, y, 0], s: [7, 0.4, 0.3] },
    { p: [0, y, 7.15], s: [0.3, 0.4, 4.3] },
    { p: [0, y, -7.15], s: [0.3, 0.4, 4.3] },
  ]),
  ...[8, 16, 24].map((y): Instance => ({ p: [-11.65, y + 0.25, 8], s: [0.7, 0.12, 0.14] })),
];

/** Circular access galleries at 16 m and 24 m with bridges to the south tower decks (chamber-local). */
const GALLERY_Y = [16.35, 24.35];
const GALLERY_R = 6.3;
const BRIDGES: Instance[] = GALLERY_Y.map((y) => ({ p: [0, y, 7.75], s: [1.2, 0.1, 3.1] }));
const GALLERY_RAIL: Instance[] = (() => {
  const rr = 6.25;
  const d = Math.asin(0.6 / rr);
  const pts: Vec2[] = [[0.6, 9.3], ...arc(0, 0, rr, Math.PI / 2 - d, -1.5 * Math.PI + d, 20), [-0.6, 9.3]];
  return GALLERY_Y.flatMap((y) => railItems(pts, y + 0.05));
})();

/** Hot-air generator saddles, riser expansion bands and riser ties to the tower ring beams (world). */
const HAG_STEEL: Instance[] = [
  ...[HAG_Z - 1.7, HAG_Z + 1.5].map((z): Instance => ({ p: [HAG_X, 0.45, z], s: [2.2, 0.9, 0.45] })),
  ...[9, 18].map((y): Instance => ({ p: [HAG_X, y, RISER_Z], s: [2.15, 0.35, 2.15] })),
  ...[8, 16, 24].map((y): Instance => ({ p: [-45.25, y, RISER_Z], s: [3.5, 0.3, 0.3] })),
];

/** Cyclone legs + frames and bag-filter legs + frames (world). */
const CYC_STEEL: Instance[] = (() => {
  const out: Instance[] = [];
  const o = 0.95;
  for (const z of CYC_Z) {
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) out.push({ p: [CYC_X + sx * o, 5.2, z + sz * o], s: [0.22, 10.4, 0.22] });
    for (const y of [5, 10.3])
      for (const s of [-1, 1]) {
        out.push({ p: [CYC_X, y, z + s * o], s: [2 * o + 0.2, 0.18, 0.16] });
        out.push({ p: [CYC_X + s * o, y, z], s: [0.16, 0.18, 2 * o + 0.2] });
      }
  }
  const [bx, bz] = BF;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) out.push({ p: [bx + sx * 2.3, 3.5, bz + sz * 2.1], s: [0.3, 7, 0.3] });
  for (const s of [-1, 1]) {
    out.push({ p: [bx, 6.9, bz + s * 2.1], s: [4.9, 0.25, 0.2] });
    out.push({ p: [bx + s * 2.3, 6.9, bz], s: [0.2, 0.25, 4.5] });
  }
  return out;
})();
/** Bag-filter hopper rotary valves and pulse-jet headers. */
const BF_VALVES: Instance[] = [-1.2, 1.2].flatMap((dx) =>
  [-1.1, 1.1].map((dz): Instance => ({ p: [BF[0] + dx, 4.45, BF[1] + dz], s: [0.45, 0.4, 0.45] })),
);
const BF_HEADERS: Instance[] = [-1.6, -0.55, 0.55, 1.6].map((dz) => ({
  p: [BF[0], 13.35, BF[1] + dz],
  s: [0.1, 4.6, 0.1],
  r: [0, 0, Math.PI / 2],
}));
/** Bag-filter roof railing and stack sampling-platform railing. */
const CYC_RAIL: Instance[] = [
  ...railItems(
    [
      [BF[0] - 2.5, BF[1] - 2.3],
      [BF[0] + 2.5, BF[1] - 2.3],
      [BF[0] + 2.5, BF[1] + 2.3],
      [BF[0] - 2.5, BF[1] + 2.3],
      [BF[0] - 2.5, BF[1] - 2.3],
    ],
    13.2,
  ),
  ...railItems(arc(STACK[0], STACK[1], 1.55, 0, Math.PI * 2, 12), 32.05),
];

/** Silo legs and ties, outlet gates, and the chutes from / to the belts (world). */
const SILO_POS: Vec2[] = SILO_X.flatMap((x) => SILO_Z.map((z): Vec2 => [x, z]));
const SILO_STEEL: Instance[] = SILO_POS.flatMap(([x, z]) => {
  const out: Instance[] = [];
  const o = SILO_R * 0.72;
  const legH = SILO_LEG + SILO_CONE;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) out.push({ p: [x + sx * o, legH / 2, z + sz * o], s: [0.2, legH, 0.2] });
  for (const s of [-1, 1]) {
    out.push({ p: [x, SILO_LEG, z + s * o], s: [2 * o, 0.16, 0.14] });
    out.push({ p: [x + s * o, SILO_LEG, z], s: [0.14, 0.16, 2 * o] });
  }
  return out;
});
const SILO_GATES: Instance[] = SILO_POS.map(([x, z]) => ({ p: [x, SILO_LEG - 0.15, z], s: [0.5, 0.3, 0.5] }));
const SILO_CHUTES: Instance[] = SILO_POS.flatMap(([x, z]) => {
  const side = Math.sign(z - SILO_BELT_Z);
  return [
    yzPipe([x, SILO_LEG - 0.3, z], [x, SILO_LOW_BELT_Y + 0.35, SILO_BELT_Z + side * 0.3], 0.16),
    yzPipe([x, SILO_TOP_BELT_Y - 0.3, SILO_BELT_Z + side * 0.25], [x, SILO_TOP + 0.4, z - side * 0.9], 0.18),
  ];
});

/* -------------------------------------------------------------------------------- components */

/** Powder silo shell: cone, cylinder and roof (legs are instanced separately). */
function PowderSilo({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Cyl p={[0, SILO_LEG + SILO_CONE / 2, 0]} r={0.25} rt={SILO_R} h={SILO_CONE} m={MAT.galvanised} />
      <Cyl p={[0, SILO_LEG + SILO_CONE + SILO_H / 2, 0]} r={SILO_R} h={SILO_H} m={MAT.galvanised} />
      <Cyl p={[0, SILO_TOP + 0.25, 0]} r={SILO_R} rt={0.5} h={0.5} m={MAT.galvanised} />
    </group>
  );
}

/** Bucket elevator: twin casing trunks between boot and head, head drive and a side ladder. */
function BucketElevator({ x, z, h, ladder }: { x: number; z: number; h: number; ladder: 'west' | 'north' }) {
  const steel = useMemo(() => {
    const out: Instance[] = [];
    // Casing flanges
    for (let y = 2.6; y < h - 0.5; y += 2.4) out.push({ p: [0, y, 0], s: [0.95, 0.1, 1.5] });
    // Ladder stiles and rungs
    const west = ladder === 'west';
    const off = west ? -0.78 : -1.2;
    for (const s of [-0.25, 0.25])
      out.push({ p: west ? [off, h / 2, s] : [s, h / 2, off], s: [0.06, h, 0.06] });
    for (let y = 0.4; y < h; y += 0.3)
      out.push({ p: west ? [off, y, 0] : [0, y, off], s: west ? [0.04, 0.04, 0.5] : [0.5, 0.04, 0.04] });
    return out;
  }, [h, ladder]);
  return (
    <group position={[x, 0, z]}>
      <Box p={[0, 0.7, 0]} s={[1.4, 1.4, 2.2]} m={MAT.machineDark} />
      {[-0.45, 0.45].map((dz) => (
        <Box key={dz} p={[0, (1.4 + h) / 2, dz]} s={[0.8, h - 1.4, 0.65]} m={MAT.machine} />
      ))}
      <Box p={[0, h + 0.7, 0]} s={[1.3, 1.4, 2]} m={MAT.machine} />
      <Box p={[0.95, h + 0.8, 0]} s={[0.6, 0.7, 0.6]} m={MAT.machineGreen} />
      <Motor p={[0.95, h + 0.8, 0.8]} r={0.28} l={0.7} rot={[0, Math.PI / 2, 0]} />
      <Instances items={steel} m={MAT.steel} cast={false} />
    </group>
  );
}

/** Zone D: spray-dryer tower, hot-air generator, cyclones + bag filter + stack, and powder silos. */
export function SprayDrying() {
  return (
    <group>
      <Selectable id="D-TWR">
        <group position={[TOWER_X, 0, TOWER_Z]}>
          {/* Chamber: cone, cylinder, roof cone with stiffening rings */}
          <Cyl p={[0, (OUT_Y + CONE_TOP) / 2, 0]} r={0.6} rt={CH_R} h={CONE_TOP - OUT_Y} m={MAT.stainless} />
          <Cyl p={[0, (CONE_TOP + CYL_TOP) / 2, 0]} r={CH_R} h={CYL_TOP - CONE_TOP} m={MAT.stainless} />
          <Cyl p={[0, (CYL_TOP + ROOF_TOP) / 2, 0]} r={CH_R} rt={1.9} h={ROOF_TOP - CYL_TOP} m={MAT.stainless} />
          {[18, 22, CYL_TOP - 0.1].map((y) => (
            <Cyl key={y} p={[0, y, 0]} r={CH_R + 0.07} h={0.18} m={MAT.steel} />
          ))}
          <Box p={[0, 19.5, CH_R + 0.03]} s={[1, 1.4, 0.12]} m={MAT.machineDark} />
          {/* Ring girder, legs, bracing and ties to the tower steel */}
          <Cyl p={[0, CONE_TOP, 0]} r={CH_R + 0.4} h={0.6} m={MAT.machineDark} />
          <Instances items={TOWER_STEEL} m={MAT.steel} />
          {/* Galleries */}
          {GALLERY_Y.map((y) => (
            <Cyl key={y} p={[0, y, 0]} r={GALLERY_R} h={0.1} m={MAT.galvanised} cast={false} />
          ))}
          <Instances items={BRIDGES} m={MAT.galvanised} cast={false} />
          <Instances items={GALLERY_RAIL} m={MAT.safety} cast={false} />
          {/* Roof air disperser and atomiser drive */}
          <Cyl p={[0, 28, 0]} r={1.9} h={1.6} m={MAT.duct} />
          <Cyl p={[0, 29.15, 0]} r={0.55} h={0.7} m={MAT.machineBlue} seg={12} />
          <Cyl p={[0, 29.6, 0]} r={0.3} h={0.2} m={MAT.machineDark} seg={12} />
          {/* Powder outlet: flange, rotary valve and chute to the powder belt */}
          <Cyl p={[0, OUT_Y - 0.1, 0]} r={0.75} h={0.2} m={MAT.machineDark} seg={12} />
          <Box p={[0, 3.8, 0]} s={[1, 0.8, 1]} m={MAT.machineDark} />
          <Motor p={[0.85, 3.8, 0]} r={0.22} l={0.6} />
          <Pipe a={[0, 3.4, 0.2]} b={[0, 1.7, 3.7]} r={0.3} m={MAT.galvanised} />
          <BlobShadow p={[0, 0]} w={14} d={14} />
        </group>
        {/* Slip feed: riser from the slip main up the west side to the atomiser */}
        <PipeRun
          pts={[
            [-46.3, 7, -36],
            [-46.3, 29.3, -36],
            [TOWER_X, 29.3, -36],
            [TOWER_X, 29.3, TOWER_Z + 0.55],
          ]}
          r={0.15}
          m={MAT.pipeBlue}
        />
        {/* Scissor stair to the 8, 16 and 24 m decks */}
        <Stair p={[-45, 0, -55.6]} h={8.25} dir={0} />
        <Stair p={[-35.28, 8.25, -54.4]} h={8} dir={Math.PI} />
        <Stair p={[-45, 16.25, -55.6]} h={8} dir={0} />
      </Selectable>

      <Selectable id="D-HAG">
        {/* Combustion chamber on saddles, burner, combustion-air fan, gas train */}
        <Cyl p={[HAG_X, 2.1, HAG_Z]} r={1.4} h={5} m={MAT.kilnShell} rot={[Math.PI / 2, 0, 0]} />
        <Box p={[HAG_X, 2.1, HAG_Z - 2.9]} s={[1.5, 1.5, 0.8]} m={MAT.machineBlue} />
        <Cyl p={[HAG_X, 2.1, HAG_Z - 3.5]} r={0.35} h={0.5} m={MAT.machineDark} rot={[Math.PI / 2, 0, 0]} seg={12} />
        <Cyl p={[-45.3, 1.25, -52.4]} r={0.85} h={0.55} m={MAT.machine} rot={ROT_Z90} />
        <Motor p={[-46.2, 0.95, -52.4]} r={0.32} l={0.75} />
        <Pipe a={[-45, 1.9, -52.9]} b={[-43.25, 2.1, -53.4]} r={0.28} m={MAT.duct} />
        <PipeRun
          pts={[
            [-41.75, 1.5, -53.5],
            [-40.6, 1.5, -53.5],
            [-40.6, 0.35, -53.5],
            [-40.6, 0.35, -56.9],
          ]}
          r={0.1}
          m={MAT.pipeYellow}
        />
        {/* Mixing box, insulated riser up the west side and roof duct into the air disperser */}
        <Box p={[HAG_X, 1.9, RISER_Z]} s={[2.4, 3, 2.4]} m={MAT.kilnShell} />
        <Box p={[HAG_X, (3.4 + HOT_DUCT_Y) / 2, RISER_Z]} s={[2, HOT_DUCT_Y - 3.4, 2]} m={MAT.duct} />
        <Box p={[HAG_X, HOT_DUCT_Y, -45.65]} s={[2, 2, 5.3]} m={MAT.duct} />
        <Cyl p={[(HAG_X + TOWER_X - 1.9) / 2, HOT_DUCT_Y, TOWER_Z]} r={0.95} h={TOWER_X - 1.9 - HAG_X} m={MAT.duct} rot={ROT_Z90} />
        <Instances items={HAG_STEEL} m={MAT.steel} />
        <ControlCabinet p={[-38.5, 0, -52.5]} />
        <BlobShadow p={[HAG_X, HAG_Z]} w={5} d={8} />
      </Selectable>

      <Selectable id="D-CYC">
        {/* Exhaust duct from the chamber cone to the cyclone inlet manifold */}
        <Cyl p={[-29.8, 12.6, TOWER_Z]} r={0.65} h={1.6} m={MAT.duct} rot={ROT_Z90} seg={12} />
        <Cyl p={[-29, 12.6, -47.8]} r={0.6} h={7.6} m={MAT.duct} rot={[Math.PI / 2, 0, 0]} seg={12} />
        {/* Twin cyclones */}
        {CYC_Z.map((z) => (
          <group key={z} position={[CYC_X, 0, z]}>
            <Cyl p={[0, 12.5, 0]} r={CYC_R} h={4.2} m={MAT.stainless} />
            <Cyl p={[0, 8.6, 0]} r={0.25} rt={CYC_R} h={3.6} m={MAT.stainless} />
            <Cyl p={[0, 15.9, 0]} r={0.5} h={2.6} m={MAT.duct} seg={12} />
            <Box p={[-1.4, 12.6, -0.6]} s={[1.2, 1.1, 0.8]} m={MAT.duct} />
            <Box p={[0, 6.55, 0]} s={[0.6, 0.5, 0.6]} m={MAT.machineDark} />
          </group>
        ))}
        <Instances items={CYC_STEEL} m={MAT.steel} />
        {/* Fines return from the cyclones to the powder belt */}
        <PipeRun
          pts={[
            [CYC_X, 6.3, CYC_Z[1]],
            [CYC_X, 2.6, CYC_Z[1]],
            [CYC_X, 2.6, CYC_Z[0]],
          ]}
          r={0.12}
          m={MAT.galvanised}
        />
        <PipeRun
          pts={[
            [CYC_X, 6.3, CYC_Z[0]],
            [CYC_X, 2.6, CYC_Z[0]],
            [-34.3, 1.7, -40.8],
          ]}
          r={0.12}
          m={MAT.galvanised}
        />
        {/* Clean-gas collector from the cyclone outlets to the bag filter */}
        <Cyl p={[CYC_X, 17.2, (CYC_Z[1] + BF[1]) / 2]} r={0.55} h={BF[1] - CYC_Z[1]} m={MAT.duct} rot={[Math.PI / 2, 0, 0]} seg={12} />
        <Cyl p={[CYC_X, 15.2, BF[1]]} r={0.55} h={4} m={MAT.duct} seg={12} />
        {/* Pulse-jet bag filter: casing, plenum, hoppers, valves, fines trough */}
        <Box p={[BF[0], 9.7, BF[1]]} s={[4.8, 5.4, 4.4]} m={MAT.machine} />
        <Box p={[BF[0], 12.8, BF[1]]} s={[5, 0.8, 4.6]} m={MAT.machineDark} />
        <Instances items={BF_HEADERS} m={MAT.pipeGrey} cyl cast={false} />
        {[-1.2, 1.2].flatMap((dx) =>
          [-1.1, 1.1].map((dz) => (
            <Cyl
              key={`${dx}${dz}`}
              p={[BF[0] + dx, 5.9, BF[1] + dz]}
              r={0.2}
              rt={1.55}
              h={2.2}
              m={MAT.machine}
              rot={[0, Math.PI / 4, 0]}
              seg={4}
            />
          )),
        )}
        <Instances items={BF_VALVES} m={MAT.machineDark} />
        <Box p={[BF[0], 3.8, BF[1]]} s={[5, 0.55, 2.6]} m={MAT.machine} />
        <Pipe a={[BF[0] - 2.5, 3.8, BF[1] + 1]} b={[-34.5, 1.8, -37.4]} r={0.18} m={MAT.galvanised} />
        <Instances items={CYC_RAIL} m={MAT.safety} cast={false} />
        {/* Clean-air downcomer to the exhaust fan, fan, outlet duct and stack */}
        <Box p={[-25.4, 7.6, -38.7]} s={[0.9, 11.2, 0.9]} m={MAT.duct} />
        <Box p={[-24.9, 2, -38.7]} s={[1.4, 0.9, 0.9]} m={MAT.duct} />
        <Cyl p={[FAN[0], FAN[1], -37.85]} r={0.55} rt={0.4} h={0.8} m={MAT.duct} rot={[Math.PI / 2, 0, 0]} seg={12} />
        <Box p={[FAN[0], 0.42, -36.5]} s={[2.4, 0.84, 2.6]} m={MAT.plinth} />
        <Cyl p={FAN} r={1.15} h={0.9} m={MAT.machine} rot={[Math.PI / 2, 0, 0]} />
        <Motor p={[FAN[0], 1.2, -35.9]} r={0.4} l={1} rot={[0, Math.PI / 2, 0]} />
        <Box p={[-23.7, 3.6, FAN[2]]} s={[0.8, 1.6, 0.8]} m={MAT.duct} />
        <Box p={[-23.7, 4, -39.3]} s={[0.8, 0.8, 4.2]} m={MAT.duct} />
        <Box p={[STACK[0], 0.3, STACK[1]]} s={[2.2, 0.6, 2.2]} m={MAT.plinth} />
        <Cyl p={[STACK[0], 18.2, STACK[1]]} r={0.85} h={36.4} m={MAT.galvanised} />
        <Cyl p={[STACK[0], 36.3, STACK[1]]} r={0.95} h={0.3} m={MAT.steel} />
        <Cyl p={[STACK[0], 32, STACK[1]]} r={1.6} h={0.1} m={MAT.galvanised} cast={false} />
        <BlobShadow p={[-27, -44.5]} w={7} d={16} />
      </Selectable>

      <Selectable id="D-SILO">
        {SILO_POS.map(([x, z]) => (
          <PowderSilo key={`${x}${z}`} x={x} z={z} />
        ))}
        <Instances items={SILO_STEEL} m={MAT.steel} />
        <Instances items={SILO_GATES} m={MAT.machineDark} />
        <Instances items={SILO_CHUTES} m={MAT.galvanised} cyl />
        <BucketElevator x={-35} z={-29} h={9.4} ladder="west" />
        <BucketElevator x={-25} z={-22.6} h={9.2} ladder="north" />
        <ControlCabinet p={[-44.5, 0, -10]} rot={Math.PI / 2} />
        <BlobShadow p={[-35, -20.5]} w={16} d={14} />
      </Selectable>
    </group>
  );
}
