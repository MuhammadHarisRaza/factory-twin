import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { MeshStandardMaterial, type Group } from 'three';
import type { Vec2, Vec3 } from '../../data/types';
import { MAT } from '../materials';
import { BlobShadow, Box, ControlCabinet, Cyl, Instances, Pallet, Railing, type Instance } from '../primitives';
import { Selectable } from '../Selectable';
import { Forklift } from '../vehicles';

/** z of the sorting / packaging line centreline. */
const LINE_Z = 15;

/** Grade-sorting stacker bay: four-post frame over a growing tile stack. */
function StackerBay({ x, z, grade }: { x: number; z: number; grade: number }) {
  return (
    <group position={[x, 0, z]}>
      {[-0.9, 0.9].map((px) =>
        [-0.9, 0.9].map((pz) => (
          <Box key={`${px}${pz}`} p={[px, 1.4, pz]} s={[0.12, 2.8, 0.12]} m={MAT.machineBlue} />
        )),
      )}
      <Box p={[0, 2.85, 0]} s={[2, 0.2, 2]} m={MAT.machineBlue} />
      <Box p={[0, 0.4 + grade * 0.15, 0]} s={[0.62, 0.8 + grade * 0.3, 0.62]} m={MAT.glazedTile} />
      <Box p={[0, 0.1, 0]} s={[1.8, 0.2, 1.8]} m={MAT.machineDark} />
    </group>
  );
}

/** Translucent safety-mesh fence (1.5 m panels) around a robot cell, with an optional opening on the x sides. */
function SafetyCell({
  x0,
  x1,
  z0,
  z1,
  gapZ,
}: {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  gapZ?: Vec2;
}) {
  const panels = useMemo(() => {
    const out: Instance[] = [];
    const h = 2.2;
    const alongX = (z: number) => {
      for (let x = x0; x < x1 - 0.01; x += 1.5) out.push({ p: [x + 0.75, h / 2, z], s: [1.45, h, 0.03] });
    };
    const alongZ = (x: number) => {
      for (let z = z0; z < z1 - 0.01; z += 1.5) {
        if (gapZ && z + 0.75 > gapZ[0] && z + 0.75 < gapZ[1]) continue;
        out.push({ p: [x, h / 2, z + 0.75], s: [0.03, h, 1.45] });
      }
    };
    alongX(z0);
    alongX(z1);
    alongZ(x0);
    alongZ(x1);
    return out;
  }, [x0, x1, z0, z1, gapZ]);
  const mesh = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#d9a62a',
        transparent: true,
        opacity: 0.35,
        metalness: 0.4,
        roughness: 0.5,
      }),
    [],
  );
  return (
    <>
      <Instances items={panels} m={mesh} cast={false} />
      <Railing
        pts={[
          [x0, z0],
          [x1, z0],
          [x1, z1],
          [x0, z1],
          [x0, z0],
        ]}
        h={2.2}
      />
    </>
  );
}

/** Palletising robot swinging between the line and two pallets. */
function PalletisingRobot() {
  const arm = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (arm.current) arm.current.rotation.y = Math.sin(clock.elapsedTime * 0.8) * 1.4;
  });
  return (
    <group position={[-63.5, 0, LINE_Z]}>
      <Cyl p={[0, 0.5, 0]} r={0.7} h={1} m={MAT.machineDark} />
      <group ref={arm} position={[0, 1, 0]}>
        <Cyl p={[0, 0.6, 0]} r={0.5} h={1.2} m={MAT.safety} />
        <Box p={[0.3, 2, 0]} s={[0.5, 2.4, 0.5]} r={[0, 0, -0.3]} m={MAT.safety} />
        <Box p={[1.6, 3, 0]} s={[2.8, 0.42, 0.42]} r={[0, 0, 0.12]} m={MAT.safety} />
        <Box p={[2.9, 2.2, 0]} s={[0.25, 1.4, 0.25]} m={MAT.steel} />
        <Box p={[2.9, 1.45, 0]} s={[1.2, 0.2, 0.9]} m={MAT.machineDark} />
      </group>
      <Pallet p={[0, 0, -2.9]} cartons={4} />
      <Pallet p={[0, 0, 2.9]} cartons={2} />
      <Box p={[-3, 0.9, 2.9]} s={[1.3, 1.8, 1.1]} m={MAT.pallet} />
    </group>
  );
}

/** Rotary-arm stretch wrapper with a pallet on its turntable. */
function StretchWrapper() {
  const arm = useRef<Group>(null);
  useFrame((_, delta) => {
    if (arm.current) arm.current.rotation.y += delta * 1.2;
  });
  return (
    <group position={[-71, 0, 20]}>
      <Cyl p={[0, 0.25, 0]} r={1.3} h={0.5} m={MAT.machineDark} />
      <group ref={arm}>
        <Box p={[1.5, 3.4, 0]} s={[0.2, 0.2, 0.2]} m={MAT.steel} />
        <Box p={[0, 3.6, 0]} s={[3.2, 0.25, 0.3]} m={MAT.machine} />
        <Box p={[1.55, 1.9, 0]} s={[0.25, 3.2, 0.35]} m={MAT.machine} />
      </group>
      <Pallet p={[0, 0.5, 0]} cartons={4} wrap />
      <Box p={[-1.9, 1.9, -1.9]} s={[0.4, 3.8, 0.4]} m={MAT.machineBlue} />
    </group>
  );
}

/** Sorting zone: planarity gauge, vision inspection, grade sorter, QC table and buffer rack. */
export function Sorting() {
  return (
    <group>
      <Selectable id="I-GAUGE">
        <group position={[-9, 0, LINE_Z]}>
          {[-1.5, 1.5].map((z) => (
            <Box key={z} p={[0, 1.3, z]} s={[0.3, 2.6, 0.3]} m={MAT.machineBlue} />
          ))}
          <Box p={[0, 2.65, 0]} s={[0.6, 0.35, 3.3]} m={MAT.machineBlue} />
          {[-0.8, 0, 0.8].map((z) => (
            <Box key={z} p={[0, 2.25, z]} s={[0.3, 0.4, 0.3]} m={MAT.machineDark} />
          ))}
          <ControlCabinet p={[0, 0, 2.6]} w={0.9} h={1.8} />
        </group>
      </Selectable>
      <Selectable id="I-VIS">
        <group position={[-15, 0, LINE_Z]}>
          <Box p={[0, 1.5, 0]} s={[4, 1.4, 2.6]} m={MAT.machineDark} />
          <Box p={[0, 1.5, 1.31]} s={[3.4, 0.9, 0.04]} m={MAT.glass} cast={false} />
          <Box p={[0, 1.85, 1.27]} s={[3.2, 0.08, 0.04]} m={MAT.lamp} cast={false} />
          <Box p={[0, 2.4, 0]} s={[4.2, 0.4, 2.8]} m={MAT.machine} />
          {[-1.2, 0, 1.2].map((x) => (
            <Box key={x} p={[x, 2.85, 0]} s={[0.45, 0.5, 0.45]} m={MAT.machineDark} />
          ))}
          {[-1.2, 0, 1.2].map((x) => (
            <Cyl key={'l' + x} p={[x, 2.6, 0]} r={0.12} h={0.1} m={MAT.glass} seg={10} />
          ))}
          <group position={[0, 0, -2.4]}>
            <Box p={[0, 0.5, 0]} s={[1.6, 1, 0.8]} m={MAT.machine} />
            <Box p={[0, 1.45, 0]} s={[1, 0.65, 0.06]} r={[-0.3, 0, 0]} m={MAT.screen} />
          </group>
        </group>
      </Selectable>
      <Selectable id="I-SORT">
        {[-20.5, -21.5].map((x) => (
          <Box key={x} p={[x, 1.35, LINE_Z]} s={[0.3, 0.5, 2.4]} m={MAT.machineBlue} />
        ))}
        <StackerBay x={-24.5} z={22} grade={2} />
        <StackerBay x={-28} z={22} grade={1} />
        <StackerBay x={-31.5} z={22} grade={0} />
        <Box p={[-22.5, 0.6, 8]} s={[2.4, 1.2, 1.8]} m={MAT.safetyRed} />
        <Box p={[-22.5, 1, 8]} s={[2.2, 0.4, 1.6]} m={MAT.greenTile} cast={false} />
        <BlobShadow p={[-26, 18]} w={16} d={14} />
      </Selectable>
      <Selectable id="I-QC">
        <group position={[-13, 0, 24]}>
          <Box p={[0, 0.9, 0]} s={[3.2, 0.1, 1.6]} m={MAT.stainless} />
          {[-1.5, 1.5].map((x) =>
            [-0.7, 0.7].map((z) => <Box key={`${x}${z}`} p={[x, 0.45, z]} s={[0.08, 0.9, 0.08]} m={MAT.steel} />),
          )}
          {[-0.9, 0, 0.9].map((x) => (
            <Box key={x} p={[x, 0.97, 0]} s={[0.6, 0.03, 0.6]} m={MAT.glazedTile} cast={false} />
          ))}
          <Box p={[0, 2.5, 0]} s={[3.2, 0.12, 1.2]} m={MAT.machine} />
          <Box p={[0, 2.43, 0]} s={[3, 0.03, 1]} m={MAT.lamp} cast={false} />
          {[-1.5, 1.5].map((x) => (
            <Box key={'p' + x} p={[x, 1.7, -0.7]} s={[0.06, 1.6, 0.06]} m={MAT.steel} />
          ))}
        </group>
      </Selectable>
      <Selectable id="I-BUF">
        <group position={[-34.5, 0, 9]}>
          {[-1.8, 1.8].map((x) =>
            [-2.4, 2.4].map((z) => (
              <Box key={`${x}${z}`} p={[x, 2.6, z]} s={[0.2, 5.2, 0.2]} m={MAT.machineBlue} />
            )),
          )}
          {[0.9, 1.8, 2.7, 3.6, 4.5].map((y) => (
            <Box key={y} p={[0, y, 0]} s={[3.4, 0.12, 4.6]} m={MAT.galvanised} />
          ))}
          {[1, 1.9, 2.8].map((y) => (
            <Box key={'t' + y} p={[0, y, 0]} s={[2.8, 0.12, 4]} m={MAT.glazedTile} cast={false} />
          ))}
          <BlobShadow p={[0, 0]} w={6} d={7} />
        </group>
      </Selectable>
    </group>
  );
}

const BOX_CONVEYOR_CARTONS: Instance[] = [-53, -54.5, -56, -57.5, -59].map((x) => ({
  p: [x, 1.32, LINE_Z] as Vec3,
  s: [0.9, 0.36, 0.6] as Vec3,
}));

const PALLET_CELL_GAP: Vec2 = [13.5, 16.5];

/** Packaging zone: counter, boxing machine, palletising cell, stretch wrapper and outfeed staging. */
export function Packaging() {
  return (
    <group>
      <Selectable id="J-CNT">
        <group position={[-41, 0, LINE_Z]}>
          <Box p={[0, 1.2, 0]} s={[2.4, 1.4, 2.4]} m={MAT.machine} />
          <Box p={[0, 2.1, 0]} s={[2, 0.4, 2]} m={MAT.glass} cast={false} />
          <Box p={[0, 1.2, 1.25]} s={[0.8, 0.5, 0.04]} m={MAT.screen} cast={false} />
        </group>
      </Selectable>
      <Selectable id="J-BOX">
        <group position={[-48, 0, LINE_Z]}>
          <Box p={[0, 0.6, 0]} s={[6.4, 1.2, 2.8]} m={MAT.machineDark} />
          <Box p={[0, 1.9, 0]} s={[6.2, 1.4, 2.6]} m={MAT.machine} />
          <Box p={[0, 1.9, 1.32]} s={[5.6, 1, 0.04]} m={MAT.glass} cast={false} />
          <Box p={[0, 2.75, 0]} s={[6.4, 0.3, 2.8]} m={MAT.machineBlue} />
          <Box p={[-1.5, 1, -2.3]} s={[2.2, 2, 1.4]} m={MAT.carton} />
          <Box p={[2.4, 1.2, -2]} s={[0.9, 1.6, 0.8]} m={MAT.machine} />
          <ControlCabinet p={[3.9, 0, 1.6]} w={1} rot={-Math.PI / 2} />
          <BlobShadow p={[0, 0]} w={10} d={7} />
        </group>
        <Instances items={BOX_CONVEYOR_CARTONS} m={MAT.carton} />
      </Selectable>
      <Selectable id="J-PAL">
        <PalletisingRobot />
        <SafetyCell x0={-68} x1={-59} z0={10.5} z1={19.5} gapZ={PALLET_CELL_GAP} />
      </Selectable>
      <Selectable id="J-WRAP">
        <StretchWrapper />
      </Selectable>
      <group>
        <Box p={[-52, 0.05, 25]} s={[14, 0.02, 6]} m={MAT.plinth} cast={false} />
        <Pallet p={[-56, 0, 24]} cartons={4} wrap />
        <Pallet p={[-54.4, 0, 24]} cartons={4} wrap />
        <Pallet p={[-52.8, 0, 24]} cartons={3} wrap />
        <Forklift p={[-48.5, 0, 25.5]} rot={Math.PI} />
      </group>
    </group>
  );
}
