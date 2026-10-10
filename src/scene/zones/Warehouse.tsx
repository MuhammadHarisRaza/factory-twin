import { useMemo } from 'react';
import type { Vec2, Vec3 } from '../../data/types';
import { MAT, hash01 } from '../materials';
import { BlobShadow, Box, Instances, Pallet, type Instance } from '../primitives';
import { Selectable } from '../Selectable';
import { Forklift, PathMover, Truck } from '../vehicles';

/** z centre of each back-to-back double rack row. */
const RACK_ROWS_Z = [9.6, 16.1, 22.6, 29.1, 35.6, 42.1];
/** x of the first rack upright. */
const RACK_X0 = -128;
/** Bay pitch along x (m). */
const BAY_WIDTH = 2.75;
const BAY_COUNT = 12;
/** Height of each pallet level (the first is the floor position). */
const RACK_LEVELS = [0.15, 2.15, 4.15, 6.15, 8.15];
/** x of each loading dock door. */
const DOCK_X = [-126, -119, -112, -105, -98, -91];

/** Instance lists for the pallet racking: uprights, ties, beams and the (randomly gapped) stored pallets. */
function useRacking() {
  return useMemo(() => {
    const uprights: Instance[] = [];
    const beams: Instance[] = [];
    const pallets: Instance[] = [];
    const cartons: Instance[] = [];
    const ties: Instance[] = [];
    const rackLength = BAY_WIDTH * BAY_COUNT;
    RACK_ROWS_Z.forEach((rowZ, row) => {
      const frameZ = [rowZ - 1.3, rowZ - 0.2, rowZ + 0.2, rowZ + 1.3];
      for (let bay = 0; bay <= BAY_COUNT; bay++) {
        const x = RACK_X0 + bay * BAY_WIDTH;
        for (const z of frameZ) uprights.push({ p: [x, 4.8, z], s: [0.1, 9.6, 0.08] });
        for (const [z0, z1] of [
          [frameZ[0], frameZ[1]],
          [frameZ[2], frameZ[3]],
        ])
          for (const y of [1.2, 3.6, 6, 8.4]) ties.push({ p: [x, y, (z0 + z1) / 2], s: [0.05, 0.05, z1 - z0] });
      }
      for (const y of RACK_LEVELS.slice(1))
        for (const z of frameZ) beams.push({ p: [-111.5, y, z], s: [rackLength, 0.14, 0.06] });
      for (let bay = 0; bay < BAY_COUNT; bay++)
        for (let level = 0; level < RACK_LEVELS.length; level++)
          for (const [side, z] of [
            [0, rowZ - 0.75],
            [1, rowZ + 0.75],
          ])
            for (let slot = 0; slot < 2; slot++) {
              if (hash01(row, bay, level, side, slot) < 0.18) continue;
              const x = RACK_X0 + bay * BAY_WIDTH + 0.72 + slot * 1.32;
              const y = RACK_LEVELS[level] + (level === 0 ? -0.1 : 0.07);
              pallets.push({ p: [x, y + 0.07, z], s: [1.2, 0.14, 1] });
              const loadH = 0.9 + hash01(row, bay, level, side, slot, 9) * 0.6;
              cartons.push({ p: [x, y + 0.14 + loadH / 2, z], s: [1.14, loadH, 0.95] });
            }
    });
    return { uprights, beams, pallets, cartons, ties };
  }, []);
}

const FORKLIFT_ROUTES: { pts: Vec2[]; speed: number; offset?: number; load?: boolean }[] = [
  {
    pts: [
      [-92, 8],
      [-92, 44],
    ],
    speed: 2.4,
  },
  {
    pts: [
      [-96, 19.4],
      [-126, 19.4],
    ],
    speed: 1.6,
    offset: 10,
    load: false,
  },
  {
    pts: [
      [-90, 47],
      [-122, 47],
    ],
    speed: 2,
    offset: 5,
  },
];

/** Finished-goods warehouse: high-bay racking, forklifts, dispatch staging and loading docks with trucks. */
export function Warehouse() {
  const racking = useRacking();
  const staged = useMemo(() => {
    const out: { p: Vec3; c: number }[] = [];
    DOCK_X.forEach((x, i) => {
      for (let j = 0; j < 4; j++)
        if (hash01(i, j, 3) > 0.3)
          out.push({ p: [x + (j % 2 ? 0.7 : -0.7), 0, 49 + Math.floor(j / 2) * 2.4], c: 3 + (j % 2) });
    });
    return out;
  }, []);
  const receiving = useMemo<Vec2[]>(
    () => [
      [-88, 14],
      [-86.5, 14],
      [-88, 24.5],
      [-86.5, 24.5],
      [-85, 24.5],
    ],
    [],
  );
  return (
    <group>
      <Selectable id="K-RACK">
        <Instances items={racking.uprights} m={MAT.rackUpright} />
        <Instances items={racking.ties} m={MAT.rackUpright} cast={false} />
        <Instances items={racking.beams} m={MAT.rackBeam} />
        <Instances items={racking.pallets} m={MAT.pallet} cast={false} />
        <Instances items={racking.cartons} m={MAT.carton} />
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
        {staged.map((pallet, i) => (
          <Pallet key={i} p={pallet.p} cartons={pallet.c} wrap />
        ))}
        {receiving.map(([x, z], i) => (
          <Pallet key={'r' + i} p={[x, 0, z]} cartons={4} wrap />
        ))}
      </Selectable>
      <Selectable id="K-DOCK">
        {DOCK_X.map((x) => (
          <group key={x}>
            <Box p={[x, 0.6, 60.9]} s={[3, 1.2, 1.6]} m={MAT.concreteWall} />
            <Box p={[x, 1.22, 60.9]} s={[2.4, 0.06, 1.4]} m={MAT.galvanised} />
            <Box p={[x, 2.6, 61.1]} s={[3.8, 4.6, 0.5]} m={MAT.rubber} />
            <Box p={[x, 2.6, 61.2]} s={[2.8, 3.6, 0.52]} m={MAT.door} />
          </group>
        ))}
        <Truck p={[-119, 0, 68.6]} rot={-Math.PI / 2} kind="box" />
        <Truck p={[-105, 0, 68.6]} rot={-Math.PI / 2} kind="flat" cab={MAT.truckCabBlue} />
        <Truck p={[-91, 0, 68.6]} rot={-Math.PI / 2} kind="box" cab={MAT.truckCabBlue} />
        <BlobShadow p={[-108, 66]} w={44} d={14} />
      </Selectable>
    </group>
  );
}
