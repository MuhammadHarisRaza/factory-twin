import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import type { Vec2, Vec3 } from '../../data/types';
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
  Tank,
  type Instance,
} from '../primitives';
import { MAT } from '../materials';
import { Selectable } from '../Selectable';

/* ------------------------------------------------------------------------------------------------
 * Layout (world metres). The feed belt from the crusher runs north along x = -64.5 at y = 5.6 over
 * the mills' feed ends; the mills discharge east through trommels into sumps, and the slip is
 * pumped into the agitated tanks at x = -48.6. A second main sends slip to the spray dryer.
 * ---------------------------------------------------------------------------------------------- */

/** Z positions of the three ball mills. */
const MILL_Z = [-25, -17.5, -10];
/** Drum centre x, axis height, radius and shell length of the ball mills. */
const MILL_X = -58.8;
const AXIS_Y = 2.75;
const DRUM_R = 1.7;
const DRUM_L = 7;
/** Trunnion bearing centres (feed end west, discharge end east). */
const FEED_BRG_X = -63.3;
const DIS_BRG_X = -54.35;
/** Girth gear plane and the pinion shaft position (y, z offset from the mill axis). */
const GEAR_X = -56.2;
const PINION_Y = 1.9;
const DRIVE_Z = 2.3;
/** Discharge trommel centre. */
const TROMMEL_X = -53.05;
/** Feed belt centre-line x (from Conveyors.tsx). */
const FEED_BELT_X = -64.5;

/** Agitated slip tanks. */
const SLIP_TANK_Z = [-26, -20, -14, -8];
const TANK_X = -48.6;
const TANK_R = 1.9;
const TANK_H = 4.6;
const TANK_BASE = 0.3;
/** Slip pumps stand west of the tanks. */
const PUMP_X = -51;
/** Header collecting mill slip (over the tanks) and the spray-dryer feed main. */
const MILL_HDR: Vec3 = [-49.9, 6, 0];
const FEED_MAIN_Y = 7;

/** Ball-mill feed platform (along the feed ends). */
const WALK = { x: [-67.9, -65.7] as Vec2, z: [-27.4, -9.6] as Vec2, h: 3.6 };

/* ----------------------------------------------------------------------------- static instances */

/** Concrete bearing plinths and drive foundation of one mill (local to the mill group). */
const MILL_PLINTHS: Instance[] = [
  { p: [FEED_BRG_X, 1, 0], s: [1.1, 2, 2.6] },
  { p: [DIS_BRG_X, 1, 0], s: [1.1, 2, 2.6] },
  { p: [-53.9, 0.25, DRIVE_Z], s: [4.8, 0.5, 1.7] },
];

/** Longitudinal liner-bolt strips on the drum shell (local to the drum, rotate with it). */
const DRUM_STRIPS: Instance[] = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2 + 0.2;
  return {
    p: [0, Math.cos(a) * (DRUM_R + 0.02), Math.sin(a) * (DRUM_R + 0.02)] as Vec3,
    s: [DRUM_L - 0.6, 0.05, 0.14] as Vec3,
    r: [a, 0, 0] as Vec3,
  };
});

/** Crusher / screen support posts. */
const CRUSHER_POSTS: Instance[] = [
  ...[-0.8, 0.8].flatMap((z): Instance[] => [
    { p: [-72.2, 1.42, z], s: [0.16, 2.05, 0.16] },
    { p: [-70.6, 1.3, z], s: [0.16, 1.8, 0.16] },
  ]),
  ...[-0.75, 0.75].flatMap((z): Instance[] => [
    { p: [-70.2, 1, z], s: [0.14, 1.2, 0.14] },
    { p: [-69.1, 1, z], s: [0.14, 1.2, 0.14] },
  ]),
];
/** Vibrating-screen spring mounts on top of the screen posts. */
const SCREEN_SPRINGS: Instance[] = [-0.8, 0.8].flatMap((z): Instance[] => [
  { p: [-72.2, 2.57, z], s: [0.12, 0.24, 0.12] },
  { p: [-70.6, 2.32, z], s: [0.12, 0.24, 0.12] },
]);

/** Feed platform legs (every ~3 m along both edges). */
const WALK_LEGS: Instance[] = (() => {
  const out: Instance[] = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const z = WALK.z[0] + 0.15 + ((WALK.z[1] - WALK.z[0] - 0.3) * i) / n;
    for (const x of [WALK.x[0] + 0.1, WALK.x[1] - 0.1]) out.push({ p: [x, WALK.h / 2, z], s: [0.14, WALK.h, 0.14] });
  }
  // Longitudinal edge beams under the grating.
  for (const x of [WALK.x[0] + 0.1, WALK.x[1] - 0.1])
    out.push({ p: [x, WALK.h - 0.15, (WALK.z[0] + WALK.z[1]) / 2], s: [0.12, 0.25, WALK.z[1] - WALK.z[0]] });
  return out;
})();

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

/** Feed platform railing with a gap where the stair arrives (west edge, z ≈ -26). */
const WALK_RAIL = railItems(
  [
    [WALK.x[0], -26.6],
    [WALK.x[0], WALK.z[0]],
    [WALK.x[1], WALK.z[0]],
    [WALK.x[1], WALK.z[1]],
    [WALK.x[0], WALK.z[1]],
    [WALK.x[0], -25.4],
  ],
  WALK.h,
);

/** Slip-tank plinths, pump skids and small pipework. */
const TANK_PLINTHS: Instance[] = SLIP_TANK_Z.map((z) => ({
  p: [TANK_X, TANK_BASE / 2, z],
  s: [TANK_R + 0.15, TANK_BASE, TANK_R + 0.15],
}));
const PUMP_BASES: Instance[] = SLIP_TANK_Z.map((z) => ({ p: [PUMP_X, 0.12, z], s: [0.95, 0.24, 0.8] }));
const PUMP_BODIES: Instance[] = SLIP_TANK_Z.map((z) => ({ p: [PUMP_X, 0.6, z], s: [0.5, 0.72, 0.55] }));
/** Twin diaphragm chambers of each air-operated pump. */
const PUMP_DOMES: Instance[] = SLIP_TANK_Z.flatMap((z) =>
  [-0.32, 0.32].map((dx): Instance => ({ p: [PUMP_X + dx, 0.62, z], s: [0.26, 0.16, 0.26], r: [0, 0, Math.PI / 2] })),
);
/** Tank outlet → pump suction, pump discharge risers, and drops from the mill-slip header into the tanks. */
const TANK_PIPES: Instance[] = SLIP_TANK_Z.flatMap((z): Instance[] => [
  { p: [-50.55, 0.5, z], s: [0.11, 0.45, 0.11], r: [0, 0, Math.PI / 2] },
  { p: [PUMP_X, (1 + FEED_MAIN_Y) / 2, z], s: [0.1, FEED_MAIN_Y - 1, 0.1] },
]);
const TANK_DROPS: Instance[] = SLIP_TANK_Z.map((z) => ({
  p: [MILL_HDR[0], (MILL_HDR[1] + TANK_BASE + TANK_H) / 2, z],
  s: [0.11, MILL_HDR[1] - TANK_BASE - TANK_H, 0.11],
}));
/** Pipe-rack posts under the spray-dryer feed main, and stools under the mill-slip header. */
const PIPE_SUPPORTS: Instance[] = [
  ...[-11, -17, -23, -28.6].map((z): Instance => ({ p: [PUMP_X, FEED_MAIN_Y / 2, z], s: [0.12, FEED_MAIN_Y, 0.12] })),
  { p: [-46.3, FEED_MAIN_Y / 2, -28.6], s: [0.12, FEED_MAIN_Y, 0.12] },
  ...SLIP_TANK_Z.map((z): Instance => ({ p: [MILL_HDR[0], 5.65, z + 0.25], s: [0.08, 0.7, 0.08] })),
];

/** Spray-dryer slip main: along the pump row, across the tank row and north into the tower. */
const FEED_MAIN: Vec3[] = [
  [PUMP_X, FEED_MAIN_Y, -8],
  [PUMP_X, FEED_MAIN_Y, -28.6],
  [-46.3, FEED_MAIN_Y, -28.6],
  [-46.3, FEED_MAIN_Y, -36],
];

/* --------------------------------------------------------------------------------- components */

/**
 * Continuous wet ball mill: large drum on two trunnion bearings set on concrete plinths, girth gear
 * under a guard, pinion + gearbox + motor drive train, feed hopper/spout at the west end and a
 * discharge trommel over a slip sump at the east end.
 */
function BallMill({ z }: { z: number }) {
  const drum = useRef<Group>(null);
  useFrame((_, delta) => {
    if (drum.current) drum.current.rotation.x += delta * 0.3;
  });
  return (
    <group position={[0, 0, z]}>
      <Instances items={MILL_PLINTHS} m={MAT.plinth} />
      {/* Trunnion bearings and trunnions */}
      {[FEED_BRG_X, DIS_BRG_X].map((x) => (
        <Cyl key={x} p={[x, AXIS_Y, 0]} r={0.75} h={0.9} m={MAT.machineDark} rot={ROT_Z90} />
      ))}
      <Cyl p={[-63.2, AXIS_Y, 0]} r={0.55} h={1.1} m={MAT.steelLight} rot={ROT_Z90} seg={12} />
      <Cyl p={[-54.45, AXIS_Y, 0]} r={0.55} h={1.3} m={MAT.steelLight} rot={ROT_Z90} seg={12} />

      {/* Rotating drum */}
      <group ref={drum} position={[MILL_X, AXIS_Y, 0]}>
        <Cyl p={[0, 0, 0]} r={DRUM_R} h={DRUM_L} m={MAT.machine} rot={ROT_Z90} />
        <Cyl p={[-DRUM_L / 2 - 0.25, 0, 0]} r={DRUM_R} rt={0.62} h={0.5} m={MAT.machine} rot={ROT_Z90} />
        <Cyl p={[DRUM_L / 2 + 0.25, 0, 0]} r={DRUM_R} rt={0.62} h={0.5} m={MAT.machine} rot={[0, 0, -Math.PI / 2]} />
        {[-DRUM_L / 2 + 0.1, DRUM_L / 2 - 0.1].map((x) => (
          <Cyl key={x} p={[x, 0, 0]} r={DRUM_R + 0.07} h={0.2} m={MAT.machineDark} rot={ROT_Z90} />
        ))}
        <Box p={[-1.4, DRUM_R + 0.04, 0]} s={[1, 0.14, 0.75]} m={MAT.machineDark} />
        <Instances items={DRUM_STRIPS} m={MAT.machineDark} cast={false} />
      </group>

      {/* Girth gear guard and drive train */}
      <Cyl p={[GEAR_X, AXIS_Y, 0]} r={2.2} h={0.7} m={MAT.machineGreen} rot={ROT_Z90} />
      <Box p={[GEAR_X, PINION_Y, DRIVE_Z - 0.1]} s={[0.9, 1.2, 1]} m={MAT.safety} />
      <Cyl p={[-55.2, PINION_Y, DRIVE_Z]} r={0.15} h={1.4} m={MAT.steel} rot={ROT_Z90} seg={12} />
      <Box p={[-54, 1.3, DRIVE_Z]} s={[1.1, 1.6, 1.2]} m={MAT.machineGreen} />
      <Cyl p={[-53.15, 0.95, DRIVE_Z]} r={0.26} h={0.5} m={MAT.safety} rot={ROT_Z90} seg={12} />
      <Motor p={[-52.2, 0.95, DRIVE_Z]} r={0.48} l={1.3} />

      {/* Feed end: chute from the belt plough, hopper and spout into the feed trunnion */}
      <Box p={[FEED_BELT_X, 5, 0]} s={[0.55, 0.8, 0.55]} m={MAT.galvanised} />
      <Cyl p={[FEED_BELT_X, 4.15, 0]} r={0.3} rt={0.75} h={0.9} m={MAT.galvanised} rot={[0, Math.PI / 4, 0]} seg={4} />
      <Pipe a={[FEED_BELT_X, 3.75, 0]} b={[-63.6, AXIS_Y, 0]} r={0.32} m={MAT.galvanised} />

      {/* Discharge end: trommel under a hood, slip sump and pump-out to the tank header */}
      <Cyl p={[TROMMEL_X, AXIS_Y, 0]} r={0.8} h={1.5} m={MAT.galvanised} rot={ROT_Z90} seg={12} />
      <Box p={[TROMMEL_X + 0.05, AXIS_Y + 0.65, 0]} s={[1.5, 1, 2]} m={MAT.machine} />
      <Box p={[TROMMEL_X + 0.05, 0.85, 0]} s={[1.6, 1.7, 2]} m={MAT.stainless} />
      <PipeRun
        pts={[
          [-52.3, 0.9, 0.4],
          [-51.9, 0.9, 0.4],
          [-51.9, MILL_HDR[1], 0.4],
          [MILL_HDR[0], MILL_HDR[1], 0.4],
        ]}
        r={0.13}
        m={MAT.stainless}
      />
      <BlobShadow p={[-58.5, 0.6]} w={13} d={7} />
    </group>
  );
}

/** Primary crusher with a vibrating scalping screen fed by the raw-material belt. */
function Crusher() {
  return (
    <group position={[0, 0, -8]}>
      <Box p={[-70.6, 0.2, 0.45]} s={[4, 0.4, 3.6]} m={MAT.plinth} />
      <Instances items={CRUSHER_POSTS} m={MAT.steel} />
      <Instances items={SCREEN_SPRINGS} m={MAT.machineDark} cyl />
      {/* Inclined vibrating screen with unbalance motors */}
      <Box p={[-71.3, 2.8, 0]} s={[2.2, 0.45, 1.5]} r={[0, 0, -0.15]} m={MAT.machine} />
      {[-0.86, 0.86].map((dz) => (
        <Cyl key={dz} p={[-71.4, 2.95, dz]} r={0.18} h={0.3} m={MAT.machineBlue} rot={[Math.PI / 2, 0, 0]} seg={12} />
      ))}
      <Cyl p={[-71.4, 2.15, 0]} r={0.25} rt={0.8} h={0.55} m={MAT.galvanised} rot={[0, Math.PI / 4, 0]} seg={4} />
      <Pipe a={[-71.4, 1.9, 0]} b={[-69.1, 1.5, -0.25]} r={0.18} m={MAT.galvanised} />
      {/* Hammer crusher: housing, rotor shaft, feed throat, V-belt guard and motor */}
      <Box p={[-69.65, 2.15, 0]} s={[1.3, 1.1, 1.7]} m={MAT.machine} />
      <Cyl p={[-69.65, 2.15, 0]} r={0.32} h={2.1} m={MAT.machineDark} rot={[Math.PI / 2, 0, 0]} seg={12} />
      <Box p={[-69.95, 2.9, 0]} s={[0.7, 0.4, 1.2]} m={MAT.galvanised} />
      <Box p={[-70.1, 1.5, 1.15]} s={[1.6, 1.7, 0.2]} m={MAT.safety} />
      <Motor p={[-70.6, 0.75, 1.75]} r={0.36} l={0.9} rot={[0, Math.PI / 2, 0]} />
      <Box p={[-68.95, 1.6, 0]} s={[0.8, 0.3, 0.9]} r={[0, 0, -0.35]} m={MAT.galvanised} />
      <BlobShadow p={[-70.6, 0.3]} w={6} d={5} />
    </group>
  );
}

/** Body preparation: crusher & screen, ball mills with feed platform, and agitated slip tanks. */
export function Preparation() {
  return (
    <group>
      <Selectable id="C-CRS">
        <Crusher />
      </Selectable>
      {MILL_Z.map((z, i) => (
        <Selectable key={z} id={`C-BM${i + 1}`}>
          <BallMill z={z} />
        </Selectable>
      ))}

      {/* Feed-end access platform along the mill row, with stair */}
      <Box
        p={[(WALK.x[0] + WALK.x[1]) / 2, WALK.h, (WALK.z[0] + WALK.z[1]) / 2]}
        s={[WALK.x[1] - WALK.x[0], 0.08, WALK.z[1] - WALK.z[0]]}
        m={MAT.galvanised}
      />
      <Instances items={WALK_LEGS} m={MAT.steel} />
      <Instances items={WALK_RAIL} m={MAT.safety} cast={false} />
      <Stair p={[-71.4, 0, -26]} h={WALK.h} dir={0} />

      <Selectable id="C-SLIP">
        <Instances items={TANK_PLINTHS} m={MAT.plinth} cyl />
        {SLIP_TANK_Z.map((z) => (
          <Tank key={z} p={[TANK_X, TANK_BASE, z]} r={TANK_R} h={TANK_H} />
        ))}
        {/* Diaphragm pumps */}
        <Instances items={PUMP_BASES} m={MAT.machineDark} />
        <Instances items={PUMP_BODIES} m={MAT.machineBlue} />
        <Instances items={PUMP_DOMES} m={MAT.machine} cyl />
        {/* Mill-slip header over the tanks, pump risers and spray-dryer slip main */}
        <Pipe a={[MILL_HDR[0], MILL_HDR[1], -26.2]} b={[MILL_HDR[0], MILL_HDR[1], -8]} r={0.14} m={MAT.stainless} />
        <Instances items={TANK_DROPS} m={MAT.stainless} cyl />
        <Instances items={TANK_PIPES} m={MAT.pipeBlue} cyl />
        <PipeRun pts={FEED_MAIN} r={0.15} m={MAT.pipeBlue} />
        <Instances items={PIPE_SUPPORTS} m={MAT.steel} />
        <ControlCabinet p={[-55, 0, -2.8]} />
        <BlobShadow p={[TANK_X - 0.8, -17]} w={7} d={24} />
      </Selectable>
    </group>
  );
}
