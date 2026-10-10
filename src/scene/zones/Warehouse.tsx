import { useMemo } from 'react';
import type { Vec2 } from '../../data/types';
import { MAT, hash01 } from '../materials';
import { BlobShadow, ControlCabinet, Instances, Railing, type Instance } from '../primitives';
import { Selectable } from '../Selectable';
import { Forklift, PathMover, Truck } from '../vehicles';

/** z centre of each back-to-back double rack row (five aisles between the six rows). */
const RACK_ROWS_Z = [9.6, 16.1, 22.6, 29.1, 35.6, 42.1];
/** x of the first rack upright. */
const RACK_X0 = -128;
/** Bay pitch along x (m). */
const BAY_WIDTH = 2.75;
const BAY_COUNT = 12;
/** x of the last rack upright. */
const RACK_X1 = RACK_X0 + BAY_COUNT * BAY_WIDTH;
/** Pallet support heights: the floor position plus four beam levels (top of beam). */
const RACK_LEVELS = [0, 2.15, 4.15, 6.15, 8.15];
/** Upright frame height. */
const FRAME_H = 9.6;
/** Depth of one upright frame (front to back upright). */
const FRAME_D = 1.1;
/** Flue gap between the two back-to-back frames (clears the building columns on z = 29.1). */
const FLUE = 0.6;
/** Full depth of a double row. */
const ROW_D = 2 * FRAME_D + FLUE;
/** x of each loading dock door. */
const DOCK_X = [-126, -119, -112, -105, -98, -91];
/** Docks with a trailer backed on (their doors are open in Buildings.tsx). */
const DOCKED = new Set([-112, -98]);
/** z of the dock-house front (bumper face); trailers back up to this. */
const DOCK_FRONT = 62.4;
/** Truck origin z so that the trailer rear (local x = −7.2) touches the bumpers. */
const TRUCK_Z = DOCK_FRONT + 0.2 + 7.2;

/** Instance lists for pallets and their loads. */
type LoadSet = {
  deck: Instance[];
  blocks: Instance[];
  carton: Instance[];
  white: Instance[];
  wrap: Instance[];
};

const newLoadSet = (): LoadSet => ({ deck: [], blocks: [], carton: [], white: [], wrap: [] });

/** One empty 1.2 × 1.0 pallet (0.14 m tall) at floor height y; stringers along z unless `alongX`. */
function addPalletBase(set: LoadSet, x: number, y: number, z: number, alongX: boolean) {
  set.deck.push({ p: [x, y + 0.125, z], s: [1.2, 0.03, 1] });
  for (const o of [-1, 0, 1])
    set.blocks.push(
      alongX ? { p: [x, y + 0.055, z + o * 0.42], s: [1.2, 0.11, 0.12] } : { p: [x + o * 0.5, y + 0.055, z], s: [0.12, 0.11, 1] },
    );
}

/**
 * A pallet with a deterministic, varied load: single or two-tier carton blocks (brown or white export
 * cartons), mostly stretch-wrapped, or occasionally a stack of empty pallets. Returns the top height.
 */
function addLoadedPallet(
  set: LoadSet,
  x: number,
  y: number,
  z: number,
  seed: string,
  { alongX = false, maxH = 1.5, minH = 0.85, emptyStacks = false } = {},
) {
  const k = hash01(seed, 'kind');
  if (emptyStacks && k < 0.08) {
    const n = 3 + Math.floor(hash01(seed, 'n') * 5);
    for (let i = 0; i < n; i++) addPalletBase(set, x, y + i * 0.145, z, alongX);
    return y + n * 0.145;
  }
  addPalletBase(set, x, y, z, alongX);
  const jx = (hash01(seed, 'jx') - 0.5) * 0.06;
  const jz = (hash01(seed, 'jz') - 0.5) * 0.04;
  const h = minH + hash01(seed, 'h') * (maxH - minH);
  const list = hash01(seed, 'm') < 0.24 ? set.white : set.carton;
  const base = y + 0.14;
  if (hash01(seed, 'tier') < 0.3) {
    const h1 = h * 0.55;
    const h2 = h - h1;
    const w2 = 0.95 + hash01(seed, 'w2') * 0.15;
    list.push({ p: [x + jx, base + h1 / 2, z + jz], s: [1.16, h1, 0.97] });
    list.push({ p: [x + jx, base + h1 + h2 / 2, z + jz], s: [w2, h2, 0.9] });
  } else {
    const w = 1.08 + hash01(seed, 'w') * 0.08;
    list.push({ p: [x + jx, base + h / 2, z + jz], s: [w, h, 0.96] });
  }
  if (hash01(seed, 'wrap') < 0.65) set.wrap.push({ p: [x + jx, y + 0.11 + (h + 0.04) / 2, z + jz], s: [1.2, h + 0.06, 1.0] });
  return base + h;
}

function LoadMeshes({ set }: { set: LoadSet }) {
  return (
    <>
      <Instances items={set.deck} m={MAT.pallet} cast={false} />
      <Instances items={set.blocks} m={MAT.pallet} cast={false} />
      <Instances items={set.carton} m={MAT.carton} />
      <Instances items={set.white} m={MAT.kaolin} />
      <Instances items={set.wrap} m={MAT.wrap} cast={false} />
    </>
  );
}

/** Instance lists for the selective racking, its stored pallets, floor markings and the put-away station. */
function buildRacking() {
  const uprights: Instance[] = [];
  const lacing: Instance[] = [];
  const basePlates: Instance[] = [];
  const beams: Instance[] = [];
  const decks: Instance[] = [];
  const guards: Instance[] = [];
  const yellowLines: Instance[] = [];
  const whiteLines: Instance[] = [];
  const signs: Instance[] = [];
  const signBars: Instance[] = [];
  const hangers: Instance[] = [];
  const loads = newLoadSet();

  const nodes = Array.from({ length: 8 }, (_, k) => 0.25 + (k * (FRAME_H - 0.5)) / 7);

  RACK_ROWS_Z.forEach((rowZ, row) => {
    for (const s of [-1, 1]) {
      const zi = rowZ + (s * FLUE) / 2;
      const zo = rowZ + s * (FLUE / 2 + FRAME_D);
      const zc = (zi + zo) / 2;
      for (let bay = 0; bay <= BAY_COUNT; bay++) {
        const x = RACK_X0 + bay * BAY_WIDTH;
        for (const z of [zi, zo]) {
          uprights.push({ p: [x, FRAME_H / 2, z], s: [0.1, FRAME_H, 0.09] });
          basePlates.push({ p: [x, 0.012, z], s: [0.22, 0.024, 0.2] });
        }
        // Frame lacing: horizontals at each node with zig-zag diagonals between them.
        nodes.forEach((y, k) => {
          lacing.push({ p: [x, y, zc], s: [0.04, 0.04, FRAME_D] });
          if (k === nodes.length - 1) return;
          const za = k % 2 ? zi : zo;
          const zb = k % 2 ? zo : zi;
          const dy = nodes[k + 1] - y;
          const dz = zb - za;
          lacing.push({
            p: [x, y + dy / 2, (za + zb) / 2],
            s: [0.035, Math.hypot(dy, dz), 0.035],
            r: [Math.atan2(dz, dy), 0, 0],
          });
        });
        // Upright protector on the aisle-facing leg.
        guards.push({ p: [x, 0.3, zo + s * 0.03], s: [0.2, 0.6, 0.16] });
      }
      for (let bay = 0; bay < BAY_COUNT; bay++) {
        const x0 = RACK_X0 + bay * BAY_WIDTH;
        const cx = x0 + BAY_WIDTH / 2;
        RACK_LEVELS.forEach((lvl, level) => {
          if (level > 0) {
            for (const z of [zi, zo]) beams.push({ p: [cx, lvl - 0.065, z], s: [BAY_WIDTH - 0.1, 0.13, 0.05] });
            decks.push({ p: [cx, lvl - 0.02, zc], s: [BAY_WIDTH - 0.14, 0.025, FRAME_D - 0.04] });
          }
          // A few whole bays are empty (picked out), plus random single empty slots.
          const bayEmpty = hash01('bay', row, s, bay, level) < 0.05;
          for (let slot = 0; slot < 2; slot++) {
            const seed = `r${row}s${s}b${bay}l${level}p${slot}`;
            if (bayEmpty || hash01(seed, 'empty') < (level === 0 ? 0.1 : 0.15)) continue;
            addLoadedPallet(loads, x0 + 0.735 + slot * 1.28, lvl, zc, seed, { maxH: 1.55, emptyStacks: level === 0 });
          }
        });
      }
      // Yellow line along the rack face.
      yellowLines.push({ p: [(RACK_X0 + RACK_X1) / 2, 0.052, rowZ + s * (ROW_D / 2 + 0.14)], s: [RACK_X1 - RACK_X0 + 0.8, 0.01, 0.1] });
    }
    // Row spacers across the flue.
    for (let bay = 0; bay <= BAY_COUNT; bay++)
      for (const y of [3.1, 6.2, 9.3])
        lacing.push({ p: [RACK_X0 + bay * BAY_WIDTH, y, rowZ], s: [0.05, 0.05, FLUE] });
    // End-of-aisle barriers at both row ends.
    for (const [ex, dir] of [
      [RACK_X0 - 0.45, -1],
      [RACK_X1 + 0.45, 1],
    ]) {
      guards.push({ p: [ex, 0.36, rowZ], s: [0.14, 0.26, ROW_D + 0.3] });
      for (const zs of [-1, 1]) {
        const z = rowZ + zs * (ROW_D / 2 + 0.15);
        guards.push({ p: [ex, 0.3, z], s: [0.14, 0.6, 0.14] });
        guards.push({ p: [ex - (dir * 0.45) / 2, 0.36, z], s: [0.45, 0.26, 0.1] });
      }
    }
  });

  // Aisle number signs hung at the cross-aisle end of each aisle.
  for (let a = 0; a < RACK_ROWS_Z.length - 1; a++) {
    const z = (RACK_ROWS_Z[a] + RACK_ROWS_Z[a + 1]) / 2;
    const x = RACK_X1 + 0.6;
    signs.push({ p: [x, 10.4, z], s: [0.06, 0.75, 1.5] });
    for (let n = 0; n <= a; n++)
      for (const sx of [-1, 1]) signBars.push({ p: [x + sx * 0.035, 10.4, z - a * 0.09 + n * 0.18], s: [0.02, 0.42, 0.08] });
    for (const dz of [-0.6, 0.6]) hangers.push({ p: [x, 11.6, z + dz], s: [0.025, 1.7, 0.025] });
  }

  // Cross-aisle edge lines and the put-away / receiving floor layout.
  yellowLines.push({ p: [-89.6, 0.052, 26], s: [0.1, 0.01, 36] });
  yellowLines.push({ p: [-94.15, 0.052, 26], s: [0.1, 0.01, 36] });
  const box = (x: number, z: number, w: number, d: number) => {
    whiteLines.push({ p: [x, 0.054, z - d / 2], s: [w, 0.01, 0.08] });
    whiteLines.push({ p: [x, 0.054, z + d / 2], s: [w, 0.01, 0.08] });
    whiteLines.push({ p: [x - w / 2, 0.054, z], s: [0.08, 0.01, d] });
    whiteLines.push({ p: [x + w / 2, 0.054, z], s: [0.08, 0.01, d] });
  };
  // Inbound buffer: pallets from the link conveyor waiting for put-away.
  [-87.3, -85.7, -84.1].forEach((x, i) =>
    [10.6, 13.1].forEach((z, j) => {
      box(x, z, 1.45, 1.25);
      if (hash01('buf', i, j) < 0.7) addLoadedPallet(loads, x, 0, z, `buf${i}${j}`, { alongX: true });
    }),
  );
  // Empty-pallet return stacks.
  [-87.3, -85.7].forEach((x, i) => {
    box(x, 25.6, 1.45, 1.25);
    const n = 5 + i * 3;
    for (let k = 0; k < n; k++) addPalletBase(loads, x, k * 0.145, 25.6, true);
  });
  // Pallet drop / pick station at the end of the finished-goods conveyor (belt top ≈ 0.52).
  addLoadedPallet(loads, -88.1, 0.52, 20, 'pick', { alongX: true, maxH: 1.3 });
  addLoadedPallet(loads, -83.6, 0.52, 20, 'inbound', { alongX: true, maxH: 1.3 });
  // Hatched keep-clear area in front of the station mouth.
  for (let j = 0; j < 5; j++)
    yellowLines.push({ p: [-90.6, 0.053, 18.8 + j * 0.6], s: [0.1, 0.01, 1.4], r: [0, Math.PI / 4, 0] });

  const station = {
    frames: [-0.78, 0.78].map((dz): Instance => ({ p: [-87.45, 0.42, 20 + dz], s: [2.9, 0.22, 0.07] })),
    rollers: Array.from({ length: 7 }, (_, i): Instance => ({ p: [-86.25 - i * 0.42, 0.47, 20], s: [0.05, 1.45, 0.05], r: [Math.PI / 2, 0, 0] })),
    legs: [-86.2, -88.7].flatMap((x) => [-0.7, 0.7].map((dz): Instance => ({ p: [x, 0.16, 20 + dz], s: [0.08, 0.32, 0.08] }))),
    stops: [-0.62, 0.62].map((dz): Instance => ({ p: [-88.85, 0.6, 20 + dz], s: [0.1, 0.2, 0.14] })),
    curtain: [-0.95, 0.95].map((dz): Instance => ({ p: [-89.15, 0.85, 20 + dz], s: [0.06, 1.7, 0.06] })),
  };

  return { uprights, lacing, basePlates, beams, decks, guards, yellowLines, whiteLines, signs, signBars, hangers, loads, station };
}

/** Order staging lanes in front of each dock door. */
function buildStaging() {
  const loads = newLoadSet();
  const posts: Instance[] = [];
  const plates: Instance[] = [];
  const laneLines: Instance[] = [];
  DOCK_X.forEach((dx, i) => {
    const docked = DOCKED.has(dx);
    for (const c of [-1, 1]) {
      const x = dx + c * 0.68;
      // Lanes at docks being loaded are part-empty; the -112 east column is the forklift's path.
      let n = 3 + Math.floor(hash01('lane', i, c) * 4);
      if (docked) n = c < 0 ? 2 + Math.floor(hash01('dl', i) * 3) : dx === -112 ? 0 : 1;
      for (let k = 0; k < n; k++) {
        const z = 55.8 - k * 1.3;
        const seed = `stg${i}${c}${k}`;
        const top = addLoadedPallet(loads, x, 0, z, seed, { maxH: 1.3, minH: 0.9 });
        if (!docked && hash01(seed, 'dbl') < 0.3) addLoadedPallet(loads, x, top, z, seed + 'u', { maxH: 1.1, minH: 0.8 });
      }
    }
    posts.push({ p: [dx + 1.45, 0.95, 48.6], s: [0.08, 1.9, 0.08] });
    plates.push({ p: [dx + 1.45, 1.95, 48.6], s: [0.7, 0.45, 0.04] });
    laneLines.push({ p: [dx, 0.054, 48.5], s: [3.2, 0.01, 0.1] });
  });
  return { loads, posts, plates, laneLines };
}

/** Dock houses (plinth, leveller, shelter, bumpers) outside the south wall, plus yard and door furniture. */
function buildDocks() {
  const concrete: Instance[] = [];
  const steelPlate: Instance[] = [];
  const walls: Instance[] = [];
  const roofs: Instance[] = [];
  const rubber: Instance[] = [];
  const yellow: Instance[] = [];
  const bollards: Instance[] = [];
  const boxes: Instance[] = [];
  const white: Instance[] = [];
  const back = 60.2;
  const depth = DOCK_FRONT - back;
  const cz = (back + DOCK_FRONT) / 2;
  for (const dx of DOCK_X) {
    const docked = DOCKED.has(dx);
    concrete.push({ p: [dx, 0.6, cz], s: [3.8, 1.2, depth] });
    // Dock leveller deck and lip (lip resting on the trailer bed, or hanging when idle).
    steelPlate.push({ p: [dx, 1.23, cz], s: [2.1, 0.06, depth - 0.2] });
    if (docked) steelPlate.push({ p: [dx, 1.3, DOCK_FRONT + 0.15], s: [2.1, 0.04, 0.45], r: [0.12, 0, 0] });
    else steelPlate.push({ p: [dx, 1.02, DOCK_FRONT + 0.02], s: [2.1, 0.4, 0.04] });
    yellow.push({ p: [dx, 1.21, DOCK_FRONT - 0.12], s: [2.14, 0.05, 0.05] });
    // Dock-house walls and roof.
    for (const sx of [-1, 1]) walls.push({ p: [dx + sx * 1.85, 3.05, cz], s: [0.1, 3.7, depth] });
    roofs.push({ p: [dx, 4.96, cz + 0.15], s: [3.9, 0.12, depth + 0.3] });
    // Shelter: side curtains with guide stripes, top header.
    for (const sx of [-1, 1]) {
      rubber.push({ p: [dx + sx * 1.55, 2.95, DOCK_FRONT + 0.2], s: [0.6, 3.3, 0.4] });
      yellow.push({ p: [dx + sx * 1.42, 2.8, DOCK_FRONT + 0.41], s: [0.08, 2.6, 0.02] });
      // Bumpers on the plinth face.
      rubber.push({ p: [dx + sx * 1.1, 1.0, DOCK_FRONT + 0.08], s: [0.28, 0.42, 0.16] });
      // Trailer wheel guides.
      yellow.push({ p: [dx + sx * 1.75, 0.08, DOCK_FRONT + 3.8], s: [0.2, 0.16, 6.6] });
      // Bollards protecting the door jambs inside.
      bollards.push({ p: [dx + sx * 2.05, 0.6, 59.4], s: [0.11, 1.2, 0.11] });
    }
    rubber.push({ p: [dx, 4.55, DOCK_FRONT + 0.2], s: [3.7, 0.7, 0.4] });
    // Leveller / door control box beside each door.
    boxes.push({ p: [dx + 2.4, 1.5, 59.72], s: [0.4, 0.55, 0.18] });
    // Hatched keep-clear zone inside each door.
    for (let j = 0; j < 5; j++) yellow.push({ p: [dx - 1 + j * 0.5, 0.053, 58.4], s: [0.1, 0.01, 1.6], r: [0, Math.PI / 4, 0] });
    if (docked)
      for (const sx of [-1, 1]) yellow.push({ p: [dx + sx * 1.05, 0.16, TRUCK_Z - 5.2 + 0.62], s: [0.32, 0.32, 0.3] });
  }
  // Yard bay lines between the docks.
  for (let i = 0; i <= DOCK_X.length; i++) white.push({ p: [-129.5 + i * 7, 0.06, 71], s: [0.15, 0.02, 16] });
  return { concrete, steelPlate, walls, roofs, rubber, yellow, bollards, boxes, white };
}

const FORKLIFT_ROUTES: { pts: Vec2[]; speed: number; offset?: number; load?: boolean }[] = [
  // Cross-aisle between the rack ends and the put-away station.
  {
    pts: [
      [-92, 8],
      [-92, 44],
    ],
    speed: 2.4,
  },
  // Aisle 2.
  {
    pts: [
      [-96, 19.35],
      [-126, 19.35],
    ],
    speed: 1.6,
    offset: 10,
    load: false,
  },
  // Front cross-aisle between racks and staging lanes.
  {
    pts: [
      [-90, 47],
      [-122, 47],
    ],
    speed: 2,
    offset: 5,
  },
  // Loading lane at the -112 dock.
  {
    pts: [
      [-111.1, 50.2],
      [-111.1, 57.6],
    ],
    speed: 1.1,
    offset: 2,
  },
];

/** Finished-goods warehouse: selective racking, forklifts, put-away, dispatch staging and loading docks. */
export function Warehouse() {
  const racking = useMemo(buildRacking, []);
  const staging = useMemo(buildStaging, []);
  const docks = useMemo(buildDocks, []);
  return (
    <group>
      <Selectable id="K-RACK">
        <Instances items={racking.uprights} m={MAT.rackUpright} />
        <Instances items={racking.lacing} m={MAT.rackUpright} cast={false} />
        <Instances items={racking.basePlates} m={MAT.steel} cast={false} />
        <Instances items={racking.beams} m={MAT.rackBeam} />
        <Instances items={racking.decks} m={MAT.cableTray} cast={false} />
        <Instances items={racking.guards} m={MAT.safety} cast={false} />
        <Instances items={racking.signs} m={MAT.machineBlue} cast={false} />
        <Instances items={racking.signBars} m={MAT.markingWhite} cast={false} />
        <Instances items={racking.hangers} m={MAT.steel} cast={false} />
        <Instances items={racking.yellowLines} m={MAT.marking} cast={false} />
        <Instances items={racking.whiteLines} m={MAT.markingWhite} cast={false} />
        <LoadMeshes set={racking.loads} />
        {/* Put-away station where the link conveyor arrives. */}
        <Instances items={racking.station.frames} m={MAT.machineBlue} />
        <Instances items={racking.station.rollers} m={MAT.roller} cyl cast={false} />
        <Instances items={racking.station.legs} m={MAT.steel} cast={false} />
        <Instances items={racking.station.stops} m={MAT.safety} cast={false} />
        <Instances items={racking.station.curtain} m={MAT.machineDark} cast={false} />
        <Railing
          pts={[
            [-89.2, 21.4],
            [-82.2, 21.4],
          ]}
          h={1.4}
        />
        <Railing
          pts={[
            [-89.2, 18.6],
            [-82.2, 18.6],
          ]}
          h={1.4}
        />
        <ControlCabinet p={[-88, 0, 22.4]} w={0.8} h={1.6} d={0.5} rot={Math.PI} />
      </Selectable>
      <Selectable id="K-FLT">
        {FORKLIFT_ROUTES.map((route, i) => (
          <PathMover key={i} pts={route.pts} speed={route.speed} offset={route.offset}>
            <Forklift p={[0, 0, 0]} load={route.load} />
          </PathMover>
        ))}
        {/* Invisible volume so the moving fleet has a stable selection box. */}
        <mesh visible={false} position={[-108, 1.5, 28]} scale={[38, 3, 42]}>
          <boxGeometry />
        </mesh>
      </Selectable>
      <Selectable id="K-STG">
        <LoadMeshes set={staging.loads} />
        <Instances items={staging.posts} m={MAT.steel} cast={false} />
        <Instances items={staging.plates} m={MAT.machineBlue} cast={false} />
        <Instances items={staging.laneLines} m={MAT.markingWhite} cast={false} />
      </Selectable>
      <Selectable id="K-DOCK">
        <Instances items={docks.concrete} m={MAT.concreteWall} />
        <Instances items={docks.steelPlate} m={MAT.galvanised} cast={false} />
        <Instances items={docks.walls} m={MAT.cladding} />
        <Instances items={docks.roofs} m={MAT.claddingDark} />
        <Instances items={docks.rubber} m={MAT.rubber} />
        <Instances items={docks.yellow} m={MAT.safety} cast={false} />
        <Instances items={docks.bollards} m={MAT.safety} cyl cast={false} />
        <Instances items={docks.boxes} m={MAT.machine} cast={false} />
        <Instances items={docks.white} m={MAT.markingWhite} cast={false} />
        <Truck p={[-112, 0, TRUCK_Z]} rot={-Math.PI / 2} kind="box" />
        <Truck p={[-98, 0, TRUCK_Z]} rot={-Math.PI / 2} kind="box" cab={MAT.truckCabBlue} />
        {[-112, -98].map((x) => (
          <BlobShadow key={x} p={[x, TRUCK_Z + 0.5]} w={3.6} d={15.5} />
        ))}
      </Selectable>
    </group>
  );
}
