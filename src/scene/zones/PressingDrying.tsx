import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { BlobShadow, Box, ControlCabinet, Cyl, Hopper, Instances, Motor, Railing, type Instance } from '../primitives';
import { MAT } from '../materials';
import { Selectable } from '../Selectable';

/** X positions of the three hydraulic presses. */
export const PRESS_X = [-18, -11, -4];
/** Z position of the press line. */
export const PRESS_Z = -20;

/** Hydraulic tile press with a cycling ram and a sliding powder-feed carriage. */
function Press({ x, phase }: { x: number; phase: number }) {
  const ram = useRef<Group>(null);
  const feeder = useRef<Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime * 0.9 + phase;
    const stroke = Math.sin(t);
    if (ram.current) ram.current.position.y = 3.6 - Math.max(0, stroke) * 0.8;
    if (feeder.current) feeder.current.position.z = -1.6 + Math.max(0, -stroke) * 1.2;
  });
  return (
    <group position={[x, 0, PRESS_Z]}>
      <Box p={[0, 0.8, 0]} s={[3.8, 1.6, 3.2]} m={MAT.machineBlue} />
      <Box p={[0, 1.75, 0.2]} s={[2.8, 0.3, 2.4]} m={MAT.stainless} />
      {[-1.5, 1.5].map((cx) =>
        [-1.1, 1.1].map((cz) => <Cyl key={`${cx}${cz}`} p={[cx, 3.6, cz]} r={0.26} h={4} m={MAT.stainless} />),
      )}
      <Box p={[0, 6.2, 0]} s={[4, 1.4, 3.4]} m={MAT.machineBlue} />
      <Cyl p={[0, 7.3, 0]} r={1.2} h={0.9} m={MAT.machineDark} />
      <group ref={ram} position={[0, 3.6, 0]}>
        <Box p={[0, 0.5, 0]} s={[3, 1, 2.6]} m={MAT.machine} />
      </group>
      <group ref={feeder} position={[0, 0, -1.6]}>
        <Box p={[0, 2, 0]} s={[2.6, 0.4, 1.2]} m={MAT.machineDark} />
      </group>
      <Hopper p={[0, 0, -2.6]} w={2.2} h={2.6} legH={5.3} />
      <Box p={[2.9, 0.9, -1.2]} s={[1.4, 1.8, 2.4]} m={MAT.machineDark} />
      <Motor p={[2.9, 2.1, -1.2]} r={0.3} l={0.8} />
      <ControlCabinet p={[-2.8, 0, 1.4]} w={1} rot={Math.PI / 2} />
      <Railing
        pts={[
          [-3.6, -4.2],
          [3.6, -4.2],
          [3.6, 1],
        ]}
      />
      <BlobShadow p={[0, -0.6]} w={8} d={8} />
    </group>
  );
}

/** Roller-deck tiers and burner boxes of the multi-level dryer (instanced). */
function DryerDecks() {
  const items = useMemo(() => {
    const out: Instance[] = [];
    for (let tier = 0; tier < 5; tier++)
      for (const side of [-1, 1])
        out.push({
          p: [13, 1.2 + tier * 0.85, -12 + side * 1.92],
          s: [21.6, 0.08, 0.06],
        });
    for (let i = 0; i < 6; i++) out.push({ p: [4 + i * 3.6, 5.5, -12], s: [2.2, 0.9, 2.6] });
    return out;
  }, []);
  return <Instances items={items} m={MAT.machineDark} cast={false} />;
}

/** The three hydraulic presses. */
export function Presses() {
  return (
    <group>
      {PRESS_X.map((x, i) => (
        <Selectable key={x} id={`E-PRS${i + 1}`}>
          <Press x={x} phase={i * 2.1} />
        </Selectable>
      ))}
    </group>
  );
}

/** Horizontal multi-deck dryer plus the green-tile buffer rack after it. */
export function Dryer() {
  return (
    <group>
      <Selectable id="F-DRY">
        <Box p={[13, 0.35, -12]} s={[22.4, 0.7, 4]} m={MAT.machineDark} />
        <Box p={[13, 2.9, -12]} s={[22, 4.4, 3.8]} m={MAT.machine} />
        <DryerDecks />
        {[5, 13, 21].map((x) => (
          <group key={x}>
            <Cyl p={[x, 6.4, -12.8]} r={0.5} h={0.9} m={MAT.machineBlue} />
            <Cyl p={[x, 9.3, -12.8]} r={0.32} h={5} m={MAT.galvanised} />
          </group>
        ))}
        <Box p={[1.4, 2.2, -12]} s={[0.8, 3.6, 3.6]} m={MAT.machineBlue} />
        <Box p={[24.6, 2.2, -12]} s={[0.8, 3.6, 3.6]} m={MAT.machineBlue} />
        <ControlCabinet p={[13, 0, -15.6]} w={2} rot={Math.PI} />
        <BlobShadow p={[13, -12]} w={26} d={8} />
      </Selectable>
      <Selectable id="F-BUF">
        <group position={[26.5, 0, -21]}>
          {[-2, 2].map((x) =>
            [-2.4, 2.4].map((z) => <Box key={`${x}${z}`} p={[x, 2.8, z]} s={[0.2, 5.6, 0.2]} m={MAT.machineBlue} />),
          )}
          {[0.8, 1.7, 2.6, 3.5, 4.4].map((y) => (
            <Box key={y} p={[0, y, 0]} s={[3.8, 0.12, 4.6]} m={MAT.galvanised} />
          ))}
          {[0.95, 1.85, 2.75, 3.65].map((y) => (
            <Box key={'t' + y} p={[0, y, 0]} s={[3.2, 0.12, 4]} m={MAT.greenTile} cast={false} />
          ))}
          <Box p={[0, 5.7, 0]} s={[4.2, 0.3, 5]} m={MAT.machineDark} />
          <BlobShadow p={[0, 0]} w={7} d={8} />
        </group>
      </Selectable>
    </group>
  );
}
