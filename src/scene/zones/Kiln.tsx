import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Material } from 'three';
import type { Vec2, Vec3 } from '../../data/types';
import { MAT } from '../materials';
import {
  BlobShadow,
  Box,
  ControlCabinet,
  Cyl,
  Instances,
  Motor,
  Railing,
  ROT_Z90,
  Stair,
  type Instance,
} from '../primitives';
import { Selectable } from '../Selectable';

/**
 * Kiln centre line: the machine runs along x from x0 to x1 at z (roller tables included).
 * Tiles enter at the east end (x1) and leave at the west end (x0).
 * The insulated casing itself spans cx0…cx1; the remainder at each end is an open roller table.
 */
const KILN = { x0: -4.5, x1: 70.5, cx0: -2, cx1: 68, z: 15 };
const Z = KILN.z;
/** Top of the steel support structure / underside of the casing. */
const BASE_Y = 0.45;
/** Roller plane (matches the 1 m belt height of the adjoining conveyors). */
const ROLL_Y = 1.0;
/** Casing module length; joints, drives and burners follow this grid. */
const MODULE = 2;

type KilnSection = { name: string; x0: number; x1: number; top: number; w: number; m: Material };

/** Casing sections, east (entry) to west (exit). Height/width/casing type tell them apart. */
const SECTIONS: KilnSection[] = [
  { name: 'Pre-heating', x0: 56, x1: KILN.cx1, top: 3.3, w: 3.5, m: MAT.kilnShell },
  { name: 'Firing', x0: 30, x1: 56, top: 3.85, w: 3.9, m: MAT.insulation },
  { name: 'Rapid cooling', x0: 22, x1: 30, top: 3.3, w: 3.5, m: MAT.kilnShell },
  { name: 'Final cooling', x0: KILN.cx0, x1: 22, top: 2.8, w: 3.2, m: MAT.kilnShell },
];
const FIRING = SECTIONS[1];
const ROOF_CAP = 0.15;

const sectionAt = (x: number) => SECTIONS.find((s) => x >= s.x0 && x <= s.x1) ?? SECTIONS[3];
/** Top of the roof cap at x. */
const roofTop = (x: number) => sectionAt(x).top + ROOF_CAP;

/** Side equipment offsets from the centre line (both sides). */
const SIDE = { drive: 2.15, gas: 2.45, air: 2.62, burnerEnd: 2.7 };
const Y = { burnerLow: 0.72, burnerHigh: 1.6, peep: 2.15, gas: 2.45, air: 2.8 };
/** Roof walkway deck (south half of the roof; ducts and fans use the north half). */
const DECK = { x0: 18.8, x1: 67.6, z0: Z + 0.4, z1: Z + 1.6, y: 4.45 };
/** Stair foot (rises along +x to the walkway landing). */
const STAIR = { x: 13.4, z: Z + 2.9 };
/** Exhaust stacks (A-STK) on the north half of the roof. */
const STACK_Z = 14;

/** Pushes an axis-aligned cylinder segment (pipe / round duct) from a to b, slightly overlapping at the ends. */
function seg(out: Instance[], a: Vec3, b: Vec3, rad: number) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]].map(Math.abs);
  const len = Math.hypot(d[0], d[1], d[2]) + rad * 1.6;
  const rot: Vec3 | undefined =
    d[0] >= d[1] && d[0] >= d[2] ? [0, 0, Math.PI / 2] : d[2] >= d[1] ? [Math.PI / 2, 0, 0] : undefined;
  out.push({ p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], s: [rad, len, rad], r: rot });
}
function route(out: Instance[], pts: Vec3[], rad: number) {
  for (let i = 1; i < pts.length; i++) seg(out, pts[i - 1], pts[i], rad);
}

/** Pulsing glow of the inspection peepholes along both sides of the firing zone (kept restrained). */
function KilnGlow() {
  const material = useMemo(() => MAT.glowHot.clone(), []);
  const ref = useRef(material);
  useFrame(({ clock }) => {
    ref.current.emissiveIntensity = 1.1 + Math.sin(clock.elapsedTime * 1.3) * 0.15;
  });
  const items = useMemo(() => {
    const out: Instance[] = [];
    for (let x = FIRING.x0 + 1; x < FIRING.x1; x += MODULE)
      for (const side of [-1, 1]) out.push({ p: [x, Y.peep, Z + side * (FIRING.w / 2 + 0.02)], s: [0.14, 0.1, 0.03] });
    return out;
  }, []);
  return <Instances items={items} m={material} cast={false} />;
}

/**
 * Centrifugal fan with its axis along x: volute, axial inlet collar on the -dir side,
 * coupling guard and motor on the +dir side, all on a steel skid at baseY.
 */
function Fan({ x, z, baseY, r, dir }: { x: number; z: number; baseY: number; r: number; dir: 1 | -1 }) {
  const t = r * 0.9;
  const y = baseY + 0.16 + r;
  const ml = r * 0.9;
  const mr = r * 0.38;
  const motorX = x + dir * (t / 2 + 0.35 + ml / 2);
  const motorY = baseY + 0.16 + mr * 0.8 + 0.06;
  const skidA = x - dir * (t / 2);
  const skidB = motorX + dir * (ml / 2);
  return (
    <group>
      <Box p={[(skidA + skidB) / 2, baseY + 0.08, z]} s={[Math.abs(skidB - skidA), 0.16, r * 1.7]} m={MAT.steel} />
      <Cyl p={[x, y, z]} r={r} h={t} rot={ROT_Z90} m={MAT.machineBlue} seg={20} />
      <Cyl p={[x - dir * (t / 2 + 0.15), y, z]} r={r * 0.45} h={0.3} rot={ROT_Z90} m={MAT.duct} seg={12} />
      <Box p={[x + dir * (t / 2 + 0.17), motorY, z]} s={[0.34, mr * 1.4, mr * 1.4]} m={MAT.safety} cast={false} />
      <Motor p={[motorX, motorY, z]} r={mr} l={ml} />
    </group>
  );
}

/** Fans: [x, z, baseY, radius, motor side, duty]. */
const FANS: [number, number, number, number, 1 | -1, string][] = [
  [63, STACK_Z, 3.45, 0.85, 1, 'Flue-gas (smoke) extraction'],
  [52.4, STACK_Z, 4.0, 0.7, 1, 'Combustion air'],
  [26, Z - 4, 0, 0.75, 1, 'Rapid-cooling blower'],
  [7, STACK_Z, 2.95, 0.7, 1, 'Final-cooling extraction (west)'],
  [13, STACK_Z, 2.95, 0.7, -1, 'Final-cooling extraction (east)'],
];

const RAILING_PTS: Vec2[] = [
  [DECK.x0, STAIR.z - 0.5],
  [DECK.x0, DECK.z0],
  [DECK.x1, DECK.z0],
  [DECK.x1, DECK.z1],
  [DECK.x0 + 1.4, DECK.z1],
  [DECK.x0 + 1.4, STAIR.z + 0.5],
  [DECK.x0, STAIR.z + 0.5],
];

/** Zone H: single-layer roller kiln with roof walkway, fans and burners; plus the kiln exhaust stacks (A-STK). */
export function Kiln() {
  const parts = useMemo(() => {
    const steel: Instance[] = [];
    const frame: Instance[] = [];
    const dark: Instance[] = [];
    const rollers: Instance[] = [];
    const blueBox: Instance[] = [];
    const blueCyl: Instance[] = [];
    const burners: Instance[] = [];
    const gas: Instance[] = [];
    const valves: Instance[] = [];
    const ductCyl: Instance[] = [];
    const ductBox: Instance[] = [];
    const galvCyl: Instance[] = [];
    const galvBox: Instance[] = [];
    const markers: Instance[] = [];
    const { cx0, cx1 } = KILN;
    const len = cx1 - cx0;
    const mid = (cx0 + cx1) / 2;

    // --- Continuous steel support structure ---
    for (let x = cx0; x <= cx1 + 0.01; x += MODULE) {
      for (const side of [-1, 1]) steel.push({ p: [x, BASE_Y / 2, Z + side * 1.4], s: [0.2, BASE_Y, 0.2] });
      steel.push({ p: [x, 0.07, Z], s: [0.14, 0.14, 2.95] });
    }
    for (const side of [-1, 1]) steel.push({ p: [mid, BASE_Y - 0.07, Z + side * 1.4], s: [len, 0.14, 0.22] });

    // --- Casing: roof caps, module joints, section frames, roller slot lines ---
    for (const sec of SECTIONS) {
      const l = sec.x1 - sec.x0;
      const cx = (sec.x0 + sec.x1) / 2;
      frame.push({ p: [cx, sec.top + ROOF_CAP / 2, Z], s: [l + 0.04, ROOF_CAP, sec.w + 0.12] });
      for (let x = sec.x0 + MODULE; x < sec.x1 - 0.1; x += MODULE)
        frame.push({ p: [x, (BASE_Y + sec.top) / 2, Z], s: [0.1, sec.top - BASE_Y + 0.02, sec.w + 0.06] });
      for (const side of [-1, 1])
        dark.push({ p: [cx, ROLL_Y, Z + side * (sec.w / 2 + 0.005)], s: [l, 0.06, 0.02] });
    }
    // Heavier portal frames at section boundaries and the kiln ends.
    for (const x of [cx0, 22, 30, 56, cx1]) {
      const a = sectionAt(x - 0.01);
      const b = sectionAt(x + 0.01);
      const top = Math.max(a.top, b.top) + ROOF_CAP + 0.08;
      const w = Math.max(a.w, b.w) + 0.18;
      frame.push({ p: [x, (BASE_Y - 0.05 + top) / 2, Z], s: [0.3, top - BASE_Y + 0.05, w] });
    }

    // --- Roller ends + bearing bar (north) and drive side (south) ---
    for (let x = cx0 + 0.15; x < cx1; x += 0.3) {
      const hw = sectionAt(x).w / 2;
      const north = 2.04 - hw;
      rollers.push({ p: [x, ROLL_Y, Z - hw - north / 2], s: [0.03, north, 0.03], r: [Math.PI / 2, 0, 0] });
      const south = 1.95 - hw;
      if (south > 0.05)
        rollers.push({ p: [x, ROLL_Y, Z + hw + south / 2], s: [0.03, south, 0.03], r: [Math.PI / 2, 0, 0] });
    }
    dark.push({ p: [mid, ROLL_Y, Z - 2.08], s: [len, 0.14, 0.12] });
    // Chain guard / drive-shaft housing along the full south side, with access-cover seams.
    blueBox.push({ p: [mid, 1.025, Z + SIDE.drive], s: [len, 0.35, 0.4] });
    for (let x = cx0 + 1; x < cx1; x += MODULE) dark.push({ p: [x, 1.025, Z + SIDE.drive + 0.205], s: [0.04, 0.33, 0.02] });
    // One gearmotor per module, hung under the housing.
    for (let x = cx0 + 2; x < cx1 - 0.5; x += MODULE) {
      dark.push({ p: [x, 0.63, Z + SIDE.drive], s: [0.24, 0.42, 0.28] });
      blueCyl.push({ p: [x + 0.32, 0.55, Z + SIDE.drive], s: [0.12, 0.36, 0.12], r: [0, 0, Math.PI / 2] });
    }

    // --- Firing zone: two staggered burner rows per side with gas and combustion-air drops ---
    const burnerAt = (x: number, y: number, side: number) => {
      const wall = FIRING.w / 2;
      const l = SIDE.burnerEnd - wall;
      burners.push({ p: [x, y, Z + side * (wall + l / 2)], s: [0.055, l, 0.055], r: [Math.PI / 2, 0, 0] });
      dark.push({ p: [x, y, Z + side * 2.55], s: [0.34, 0.14, 0.14] });
      gas.push({ p: [x - 0.12, (Y.gas + y) / 2, Z + side * SIDE.gas], s: [0.022, Y.gas - y, 0.022] });
      ductCyl.push({ p: [x + 0.12, (Y.air + y) / 2, Z + side * SIDE.air], s: [0.035, Y.air - y, 0.035] });
    };
    for (const side of [-1, 1]) {
      for (let x = FIRING.x0 + 0.5; x < FIRING.x1; x += 1) burnerAt(x, Y.burnerHigh, side);
      for (let x = FIRING.x0 + 1; x < FIRING.x1; x += MODULE) burnerAt(x, Y.burnerLow, side);
      // Gas header with zone control valve trains; combustion-air header.
      seg(gas, [FIRING.x0 + 0.2, Y.gas, Z + side * SIDE.gas], [56.3, Y.gas, Z + side * SIDE.gas], 0.05);
      for (let x = FIRING.x0 + 2; x < FIRING.x1; x += 4) valves.push({ p: [x, Y.gas, Z + side * SIDE.gas], s: [0.26, 0.2, 0.2] });
      seg(ductCyl, [FIRING.x0 + 0.2, Y.air, Z + side * SIDE.air], [55.2, Y.air, Z + side * SIDE.air], 0.16);
    }

    // --- Gas train skid (north floor) and supply risers ---
    const skidZ = Z - 3.8;
    seg(gas, [54.9, 0.9, skidZ], [58.1, 0.9, skidZ], 0.06);
    seg(gas, [58.1, 0.16, skidZ], [58.1, 0.9, skidZ], 0.06);
    for (const x of [55.2, 56.9, 57.5]) valves.push({ p: [x, 0.9, skidZ], s: [0.3, 0.26, 0.24] });
    route(gas, [[55.6, 0.9, skidZ], [55.6, Y.gas, skidZ], [55.6, Y.gas, Z - SIDE.gas]], 0.05);
    route(gas, [[56.3, 0.9, skidZ], [56.3, 4.15, skidZ], [56.3, 4.15, Z + SIDE.gas], [56.3, Y.gas, Z + SIDE.gas]], 0.05);
    for (const x of [55.3, 57.8]) steel.push({ p: [x, 0.5, skidZ], s: [0.12, 0.7, 0.12] });

    // --- Combustion air: hot-air recovery duct from the rapid-cooling zone to the combustion-air fan ---
    const recY = 4.86;
    route(ductCyl, [[23, 3.45, STACK_Z], [23, recY, STACK_Z], [51.8, recY, STACK_Z]], 0.3);
    for (const x of [26, 29, 33, 37, 41, 45, 49]) {
      const top = roofTop(x);
      steel.push({ p: [x, (top + recY - 0.3) / 2, STACK_Z], s: [0.14, recY - 0.3 - top, 0.14] });
      steel.push({ p: [x, recY - 0.34, STACK_Z], s: [0.14, 0.08, 0.7] });
    }
    // Fan outlet down to the north header, and a roof crossover feeding the south header.
    route(ductCyl, [[52.4, 4.6, STACK_Z - 0.4], [52.4, 4.6, Z - SIDE.air], [52.4, Y.air, Z - SIDE.air]], 0.17);
    route(ductCyl, [[55, Y.air, Z - SIDE.air], [55, 4.2, Z - SIDE.air], [55, 4.2, Z + SIDE.air], [55, Y.air, Z + SIDE.air]], 0.17);

    // --- Rapid cooling: floor blower, side blowing manifolds with nozzle stubs ---
    const rapid = SECTIONS[2];
    const rhw = rapid.w / 2;
    const rz = rhw + 0.3;
    for (const side of [-1, 1]) {
      seg(ductCyl, [rapid.x0 + 0.4, 2.55, Z + side * rz], [rapid.x1 - 0.4, 2.55, Z + side * rz], 0.15);
      for (let x = rapid.x0 + 0.5; x < rapid.x1; x += 0.5)
        ductCyl.push({ p: [x, 2.55, Z + side * (rhw + 0.15)], s: [0.05, 0.3, 0.05], r: [Math.PI / 2, 0, 0] });
    }
    route(ductCyl, [[26, 1.4, Z - 4], [26, 2.55, Z - 4], [26, 2.55, Z - rz]], 0.2);
    route(ductCyl, [[27.6, 2.55, Z - rz], [27.6, 3.7, Z - rz], [27.6, 3.7, Z + rz], [27.6, 2.55, Z + rz]], 0.2);
    galvBox.push({ p: [24.9, 0.9, Z - 4], s: [0.9, 1.5, 1.5] }); // intake filter box

    // --- Final cooling: indirect cooling tube bundles + roof extraction headers ---
    const fin = SECTIONS[3];
    for (const side of [-1, 1])
      for (const y of [1.55, 2.05])
        seg(galvCyl, [0, y, Z + side * (fin.w / 2 + 0.1)], [21, y, Z + side * (fin.w / 2 + 0.1)], 0.07);
    for (let x = 1; x < 21; x += 4) for (const side of [-1, 1]) for (const y of [1.55, 2.05])
      steel.push({ p: [x, y, Z + side * (fin.w / 2 + 0.05)], s: [0.06, 0.06, 0.12] });
    ductBox.push({ p: [2.5, 3.3, STACK_Z], s: [8, 0.7, 0.7] });
    ductBox.push({ p: [17.5, 3.3, STACK_Z], s: [8, 0.7, 0.7] });
    ductBox.push({ p: [8.225, 4.27, STACK_Z], s: [2.45, 0.5, 0.6] });
    ductBox.push({ p: [11.775, 4.27, STACK_Z], s: [2.45, 0.5, 0.6] });

    // --- Pre-heating: smoke extraction header to the flue-gas fan, outlet into stack ---
    ductBox.push({ p: [59.525, 3.95, STACK_Z], s: [5.85, 1.0, 0.8] });
    ductBox.push({ p: [64.425, 5.05, STACK_Z], s: [3.05, 0.5, 0.6] });
    for (const x of [57.5, 60.5]) frame.push({ p: [x, 3.95, STACK_Z], s: [0.08, 1.06, 0.86] }); // header flanges

    // --- Roof walkway: deck, landing, posts; landing legs to the floor ---
    galvBox.push({ p: [(DECK.x0 + DECK.x1) / 2, DECK.y, (DECK.z0 + DECK.z1) / 2], s: [DECK.x1 - DECK.x0, 0.06, DECK.z1 - DECK.z0] });
    const landZ0 = DECK.z1;
    const landZ1 = STAIR.z + 0.5;
    galvBox.push({ p: [DECK.x0 + 0.7, DECK.y, (landZ0 + landZ1) / 2], s: [1.4, 0.06, landZ1 - landZ0] });
    for (let x = 21; x < DECK.x1; x += MODULE)
      for (const z of [DECK.z0 + 0.1, DECK.z1 - 0.1]) {
        const top = roofTop(x);
        galvBox.push({ p: [x, (top + DECK.y) / 2, z], s: [0.08, DECK.y - top, 0.08] });
      }
    for (const x of [DECK.x0 + 0.1, DECK.x0 + 1.3]) steel.push({ p: [x, DECK.y / 2, landZ1 - 0.1], s: [0.1, DECK.y, 0.1] });

    // --- Thermocouple heads along the roof (north edge of firing and pre-heating) ---
    for (let x = 34; x <= 66; x += 4) markers.push({ p: [x, roofTop(x) + 0.17, Z - 1.7], s: [0.07, 0.34, 0.07] });

    // --- Entry / exit roller tables meeting the conveyors at 1 m ---
    const tables: [number, number][] = [
      [KILN.cx1 + 0.15, KILN.x1],
      [KILN.x0, KILN.cx0 - 0.15],
    ];
    for (const [a, b] of tables) {
      const l = b - a;
      for (const side of [-1, 1]) {
        blueBox.push({ p: [(a + b) / 2, ROLL_Y - 0.08, Z + side * 0.95], s: [l, 0.2, 0.07] });
        for (const x of [a + 0.25, b - 0.2]) steel.push({ p: [x, 0.41, Z + side * 0.9], s: [0.08, 0.82, 0.08] });
      }
      for (let x = a + 0.1; x < b; x += 0.2)
        rollers.push({ p: [x, ROLL_Y - 0.03, Z], s: [0.045, 1.8, 0.045], r: [Math.PI / 2, 0, 0] });
    }

    return { steel, frame, dark, rollers, blueBox, blueCyl, burners, gas, valves, ductCyl, ductBox, galvCyl, galvBox, markers };
  }, []);

  return (
    <group>
      <Selectable id="H-KILN">
        {SECTIONS.map((sec) => (
          <Box
            key={sec.name}
            p={[(sec.x0 + sec.x1) / 2, (BASE_Y + sec.top) / 2, Z]}
            s={[sec.x1 - sec.x0, sec.top - BASE_Y, sec.w]}
            m={sec.m}
          />
        ))}
        {/* Kiln mouths (entry east, exit west) */}
        {[KILN.cx1 + 0.16, KILN.cx0 - 0.16].map((x) => (
          <Box key={x} p={[x, ROLL_Y + 0.12, Z]} s={[0.02, 0.26, 2.4]} m={MAT.rubber} cast={false} />
        ))}
        <Instances items={parts.steel} m={MAT.steel} />
        <Instances items={parts.frame} m={MAT.kilnFrame} />
        <Instances items={parts.dark} m={MAT.machineDark} cast={false} />
        <Instances items={parts.rollers} m={MAT.roller} cyl cast={false} />
        <Instances items={parts.blueBox} m={MAT.machineBlue} />
        <Instances items={parts.blueCyl} m={MAT.machineBlue} cyl cast={false} />
        <Instances items={parts.burners} m={MAT.steelLight} cyl cast={false} />
        <Instances items={parts.gas} m={MAT.pipeYellow} cyl cast={false} />
        <Instances items={parts.valves} m={MAT.pipeYellow} cast={false} />
        <Instances items={parts.ductCyl} m={MAT.duct} cyl />
        <Instances items={parts.ductBox} m={MAT.duct} />
        <Instances items={parts.galvCyl} m={MAT.galvanised} cyl cast={false} />
        <Instances items={parts.galvBox} m={MAT.galvanised} />
        <Instances items={parts.markers} m={MAT.marker} cyl cast={false} />
        <KilnGlow />

        {FANS.map(([x, z, baseY, r, dir, duty]) => (
          <Fan key={duty} x={x} z={z} baseY={baseY} r={r} dir={dir} />
        ))}

        {/* Gas train skid: base, pressure regulator, safety shut-off valve */}
        <Box p={[56.5, 0.08, Z - 3.8]} s={[3.4, 0.16, 1.0]} m={MAT.steel} />
        <Box p={[56.2, 1.05, Z - 3.8]} s={[0.45, 0.5, 0.45]} m={MAT.machineDark} />
        <Box p={[57.85, 1.0, Z - 3.8]} s={[0.22, 0.34, 0.3]} m={MAT.safetyRed} cast={false} />

        {/* Roof walkway railing and stair access from the south floor */}
        <group position={[0, DECK.y + 0.03, 0]}>
          <Railing pts={RAILING_PTS} />
        </group>
        <Stair p={[STAIR.x, 0, STAIR.z]} h={DECK.y} dir={0} />

        {/* Kiln control cabinets on the operator (south) side */}
        <ControlCabinet p={[40, 0, Z + 4.8]} w={6} rot={Math.PI} />
        <ControlCabinet p={[61, 0, Z + 4.6]} w={2.4} rot={Math.PI} />
        <ControlCabinet p={[4, 0, Z + 4.6]} w={2.4} rot={Math.PI} />

        <BlobShadow p={[33, Z]} w={78} d={8} />
      </Selectable>

      <Selectable id="A-STK">
        {/* Flue-gas stack (pre-heating smoke fan) */}
        <Box p={[66.5, 4.525, STACK_Z]} s={[1.1, 2.15, 1.1]} m={MAT.galvanised} />
        <Cyl p={[66.5, 14.275, STACK_Z]} r={0.72} h={17.45} m={MAT.galvanised} />
        <Cyl p={[66.5, 13.35, STACK_Z]} r={0.97} h={0.3} m={MAT.steel} />
        <Cyl p={[66.5, 23.05, STACK_Z]} r={0.82} h={0.2} m={MAT.steel} />
        {/* Cooling-air stack (final-cooling extraction fans) */}
        <Box p={[10, 3.925, STACK_Z]} s={[1.1, 1.95, 1.1]} m={MAT.galvanised} />
        <Cyl p={[10, 12.925, STACK_Z]} r={0.6} h={16.15} m={MAT.galvanised} />
        <Cyl p={[10, 13.35, STACK_Z]} r={0.85} h={0.3} m={MAT.steel} />
        <Cyl p={[10, 21.05, STACK_Z]} r={0.7} h={0.2} m={MAT.steel} />
      </Selectable>
    </group>
  );
}
