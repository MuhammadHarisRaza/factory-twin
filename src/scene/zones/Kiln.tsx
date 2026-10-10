import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Material } from 'three';
import { MAT } from '../materials';
import {
  BlobShadow,
  Box,
  ControlCabinet,
  Cyl,
  Instances,
  Motor,
  Railing,
  Stair,
  type Instance,
} from '../primitives';
import { Selectable } from '../Selectable';

/** Kiln centre line: runs along x from x0 to x1 at z. */
const KILN = { x0: -4, x1: 70, z: 15 };

type KilnSection = { name: string; x0: number; x1: number; h: number; w: number; m: Material };

const KILN_SECTIONS: KilnSection[] = [
  { name: 'Pre-heating', x0: 56, x1: 70, h: 3.5, w: 3.6, m: MAT.insulation },
  { name: 'Firing', x0: 30, x1: 56, h: 3.9, w: 3.8, m: MAT.insulation },
  { name: 'Rapid cooling', x0: 22, x1: 30, h: 3.5, w: 3.6, m: MAT.insulation },
  { name: 'Final cooling', x0: -4, x1: 22, h: 3.1, w: 3.3, m: MAT.kilnFrame },
];

/** Exhaust / combustion-air / cooling fans on the kiln roof: [x, duty]. */
const KILN_FANS: [number, string][] = [
  [66.5, 'smoke'],
  [52, 'air'],
  [27, 'cool'],
  [10, 'cool2'],
];

/** Pulsing glow of the inspection peepholes along the firing zone and at the kiln entry. */
function KilnGlow() {
  const material = useMemo(() => MAT.glowHot.clone(), []);
  const ref = useRef(material);
  useFrame(({ clock }) => {
    ref.current.emissiveIntensity = 1.35 + Math.sin(clock.elapsedTime * 1.7) * 0.25;
  });
  const items = useMemo(() => {
    const out: Instance[] = [];
    for (let x = 31.5; x < 55.5; x += 2.2)
      for (const side of [-1, 1]) out.push({ p: [x, 2.5, KILN.z + side * 1.93], s: [0.5, 0.22, 0.04] });
    out.push({ p: [70.05, 1.6, KILN.z], s: [0.04, 0.35, 2.6] });
    return out;
  }, []);
  return <Instances items={items} m={material} cast={false} />;
}

/** Zone H: single-layer roller kiln with roof walkway, fans and burners; plus the kiln exhaust stacks (A-STK). */
export function Kiln() {
  const parts = useMemo(() => {
    const legs: Instance[] = [];
    const joints: Instance[] = [];
    const burners: Instance[] = [];
    const markers: Instance[] = [];
    const rollers: Instance[] = [];
    for (let x = KILN.x0 + 0.5; x <= KILN.x1; x += 2.5)
      for (const side of [-1, 1]) legs.push({ p: [x, 0.45, KILN.z + side * 1.5], s: [0.25, 0.9, 0.25] });
    for (const sec of KILN_SECTIONS)
      for (let x = sec.x0 + 2.2; x < sec.x1 - 0.1; x += 2.2)
        joints.push({ p: [x, 0.9 + sec.h / 2, KILN.z], s: [0.14, sec.h + 0.05, sec.w + 0.08] });
    for (let x = 31; x < 69; x += 1.1)
      for (const side of [-1, 1]) {
        burners.push({ p: [x, 1.65, KILN.z + side * 2.2], s: [0.09, 0.7, 0.09], r: [Math.PI / 2, 0, 0] });
        if (x < 56)
          burners.push({ p: [x + 0.55, 3.2, KILN.z + side * 2.2], s: [0.09, 0.7, 0.09], r: [Math.PI / 2, 0, 0] });
      }
    for (let x = 34; x <= 68; x += 4) markers.push({ p: [x, 5.25, KILN.z + 1.3], s: [0.18, 0.5, 0.18] });
    for (const x of [KILN.x0 - 1.2, KILN.x1 + 1.2])
      for (let dz = -1.3; dz <= 1.3; dz += 0.13)
        rollers.push({ p: [x, 1, KILN.z + dz], s: [0.03, 2.2, 0.03], r: [0, 0, Math.PI / 2] });
    return { legs, joints, burners, markers, rollers };
  }, []);

  const midX = (KILN.x0 + KILN.x1) / 2;
  const length = KILN.x1 - KILN.x0;

  return (
    <group>
      <Selectable id="H-KILN">
        <Instances items={parts.legs} m={MAT.steel} />
        <Box p={[midX, 0.95, KILN.z]} s={[length, 0.2, 3.9]} m={MAT.kilnFrame} />
        {KILN_SECTIONS.map((sec) => (
          <group key={sec.name}>
            <Box p={[(sec.x0 + sec.x1) / 2, 1.05 + sec.h / 2, KILN.z]} s={[sec.x1 - sec.x0, sec.h, sec.w]} m={sec.m} />
            <Box
              p={[(sec.x0 + sec.x1) / 2, 1.05 + sec.h + 0.08, KILN.z]}
              s={[sec.x1 - sec.x0 + 0.1, 0.16, sec.w + 0.2]}
              m={MAT.kilnFrame}
            />
          </group>
        ))}
        <Instances items={parts.joints} m={MAT.kilnFrame} cast={false} />
        <Instances items={parts.burners} m={MAT.steelLight} cyl cast={false} />
        <Instances items={parts.rollers} m={MAT.refractory} cyl cast={false} />
        <KilnGlow />
        {/* Side cable/gas duct */}
        <Box p={[midX, 1.5, KILN.z - 2.2]} s={[length, 0.8, 0.5]} m={MAT.machineDark} />
        {/* Gas manifolds along both sides */}
        {[-1, 1].map((side) => (
          <Cyl
            key={side}
            p={[44, 2.45, KILN.z + side * 2.55]}
            r={0.1}
            h={26}
            m={MAT.pipeYellow}
            rot={[0, 0, Math.PI / 2]}
            seg={10}
          />
        ))}
        {/* Roof walkway */}
        <Box p={[50, 5.15, KILN.z]} s={[38, 0.08, 3.4]} m={MAT.galvanised} />
        <group position={[0, 5.15, 0]}>
          <Railing
            pts={[
              [31, KILN.z + 1.7],
              [69, KILN.z + 1.7],
            ]}
          />
        </group>
        {/* Roof duct */}
        <Box p={[48, 5.9, KILN.z - 0.9]} s={[34, 0.9, 1]} m={MAT.galvanised} />
        {KILN_FANS.map(([x]) => (
          <group key={x} position={[x, 0, KILN.z]}>
            <Cyl p={[0, 6.3, 0.6]} r={0.9} h={0.9} m={MAT.machineBlue} rot={[Math.PI / 2, 0, 0]} />
            <Motor p={[0, 6.3, 1.6]} r={0.35} l={0.8} rot={[0, Math.PI / 2, 0]} />
          </group>
        ))}
        {[27, 10].map((x) => (
          <Box key={x} p={[x, 4.5, KILN.z - 1]} s={[1, 1.2, 1]} m={MAT.galvanised} />
        ))}
        <Instances items={parts.markers} m={MAT.marker} cyl cast={false} />
        <Stair p={[25, 0, KILN.z + 2.6]} h={5.1} dir={0} />
        {[36, 40, 44].map((x) => (
          <ControlCabinet key={x} p={[x, 0, KILN.z + 4.4]} w={1.6} rot={Math.PI} />
        ))}
        <BlobShadow p={[33, KILN.z]} w={80} d={8} />
      </Selectable>

      <Selectable id="A-STK">
        <Box p={[66.5, 9.2, KILN.z - 0.9]} s={[1, 6.6, 1]} m={MAT.galvanised} />
        <Cyl p={[66.5, 17.5, KILN.z - 0.9]} r={0.75} h={11} m={MAT.galvanised} />
        <Cyl p={[66.5, 23.1, KILN.z - 0.9]} r={0.85} h={0.3} m={MAT.steel} />
        <Box p={[10, 9, KILN.z - 1]} s={[1, 6.2, 1]} m={MAT.galvanised} />
        <Cyl p={[10, 16.5, KILN.z - 1]} r={0.65} h={9} m={MAT.galvanised} />
        <Cyl p={[10, 21.1, KILN.z - 1]} r={0.75} h={0.3} m={MAT.steel} />
      </Selectable>
    </group>
  );
}
