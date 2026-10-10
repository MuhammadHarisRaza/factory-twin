import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import {
  BlobShadow,
  Box,
  ControlCabinet,
  Cyl,
  Motor,
  Pipe,
  PipeRun,
  Platform,
  ROT_Z90,
  Stair,
  Tank,
} from '../primitives';
import { MAT } from '../materials';
import { Selectable } from '../Selectable';

/** Z positions of the three ball mills. */
const MILL_Z = [-25, -17.5, -10];
/** X position of the ball-mill line. */
const MILL_X = -59.5;
/** Z positions of the agitated slip tanks. */
const SLIP_TANK_Z = [-26, -20, -14, -8];

/** Continuous wet ball mill: rotating drum on concrete piers with girth gear and drive. */
function BallMill({ z }: { z: number }) {
  const drum = useRef<Group>(null);
  useFrame((_, delta) => {
    if (drum.current) drum.current.rotation.x += delta * 0.35;
  });
  return (
    <group position={[MILL_X, 0, z]}>
      {[-4.6, 4.6].map((x) => (
        <Box key={x} p={[x, 1.2, 0]} s={[1.4, 2.4, 3]} m={MAT.concreteWall} />
      ))}
      <group ref={drum} position={[0, 2.8, 0]}>
        <Cyl p={[0, 0, 0]} r={1.8} h={8.4} m={MAT.machine} rot={ROT_Z90} />
        {[-3.4, -1.1, 1.1, 3.4].map((x) => (
          <Cyl key={x} p={[x, 0, 0]} r={1.86} h={0.18} m={MAT.machineDark} rot={ROT_Z90} />
        ))}
        <Box p={[0.6, 1.82, 0]} s={[1, 0.16, 0.8]} m={MAT.steel} />
      </group>
      <Cyl p={[-4.6, 2.8, 0]} r={0.9} rt={1.4} h={0.8} m={MAT.machineDark} rot={[0, 0, -Math.PI / 2]} />
      <Cyl p={[4.8, 2.8, 0]} r={0.6} h={1.2} m={MAT.galvanised} rot={ROT_Z90} />
      <Cyl p={[2.2, 2.8, 0]} r={2.15} h={0.6} m={MAT.safety} rot={ROT_Z90} />
      <Box p={[2.2, 1, 2.6]} s={[1.4, 1.4, 1.6]} m={MAT.machineDark} />
      <Motor p={[2.2, 1, 3.8]} r={0.45} l={1.1} rot={[0, Math.PI / 2, 0]} />
      <BlobShadow p={[0, 0]} w={12} d={6} />
    </group>
  );
}

/** Body preparation: crusher, ball mills with feed platform, and agitated slip tanks. */
export function Preparation() {
  return (
    <group>
      <Selectable id="C-CRS">
        <group position={[-70.5, 0, -8]}>
          <Box p={[0, 1.4, 0]} s={[2.6, 2.8, 2.4]} m={MAT.machineBlue} />
          <Box p={[0, 3.2, 0]} s={[2, 0.8, 1.6]} m={MAT.galvanised} />
          <Motor p={[0, 1.2, 1.9]} rot={[0, Math.PI / 2, 0]} />
          <Box p={[0, 2.3, -3.4]} s={[2.4, 0.5, 3.2]} r={[0.18, 0, 0]} m={MAT.machine} />
          {[-1, 1].map((x) =>
            [-2.2, -4.6].map((z) => <Box key={`${x}${z}`} p={[x, 1, z]} s={[0.15, 2, 0.15]} m={MAT.steel} />),
          )}
          <BlobShadow p={[0, -1.5]} w={6} d={9} />
        </group>
      </Selectable>
      {MILL_Z.map((z, i) => (
        <Selectable key={z} id={`C-BM${i + 1}`}>
          <BallMill z={z} />
        </Selectable>
      ))}
      <Platform p={[-66.8, 0, -17.5]} w={2.2} d={18} h={3.6} />
      <Stair p={[-71.4, 0, -26]} h={3.6} dir={0} />
      {MILL_Z.map((z) => (
        <Pipe key={z} a={[-64.5, 5.4, z]} b={[-64.2, 3.4, z]} r={0.3} m={MAT.galvanised} />
      ))}
      <Selectable id="C-SLIP">
        {SLIP_TANK_Z.map((z) => (
          <group key={z}>
            <Tank p={[-49.5, 0, z]} r={2.1} h={4.4} />
            <group position={[-53, 0, z + 1.6]}>
              <Box p={[0, 0.45, 0]} s={[1.2, 0.9, 0.7]} m={MAT.machineBlue} />
              <Motor p={[0, 0.5, -0.9]} r={0.25} l={0.6} rot={[0, Math.PI / 2, 0]} />
            </group>
            <PipeRun
              pts={[
                [-54.8, 1.4, z],
                [-54.8, 4.9, z],
                [-51.4, 4.9, z],
              ]}
              r={0.14}
              m={MAT.pipeGrey}
            />
            <PipeRun
              pts={[
                [-53, 0.9, z + 1.6],
                [-53, 6.2, z + 1.6],
                [-47, 6.2, z + 1.6],
              ]}
              r={0.1}
              m={MAT.pipeBlue}
            />
            <BlobShadow p={[-49.5, z]} w={6} d={6} />
          </group>
        ))}
        <PipeRun
          pts={[
            [-47, 6.2, -6.4],
            [-47, 6.2, -38],
            [-40.5, 6.2, -38],
            [-40.5, 10, -40],
          ]}
          r={0.16}
          m={MAT.pipeBlue}
        />
        {[-6.4, -14, -22, -29].map((z) => (
          <Pipe key={z} a={[-47, 0, z]} b={[-47, 6.2, z]} r={0.08} m={MAT.steel} />
        ))}
        <ControlCabinet p={[-55, 0, -2.8]} />
      </Selectable>
    </group>
  );
}
