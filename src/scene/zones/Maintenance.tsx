import { useMemo } from 'react';
import type { Vec3 } from '../../data/types';
import { MAT, hash01 } from '../materials';
import { BlobShadow, Box, ControlCabinet, Cyl, Instances, ROT_Z90, type Instance } from '../primitives';
import { Selectable } from '../Selectable';

/** Workbench with a blue base, back tool panel and a bench vice. */
function Workbench({ p, rot = 0 }: { p: Vec3; rot?: number }) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <Box p={[0, 0.9, 0]} s={[2.4, 0.08, 0.9]} m={MAT.pallet} />
      <Box p={[0, 0.45, 0]} s={[2.3, 0.9, 0.8]} m={MAT.machineBlue} />
      <Box p={[0, 1.6, -0.42]} s={[2.4, 1.3, 0.05]} m={MAT.galvanised} />
      <Box p={[0.8, 1.05, 0.1]} s={[0.25, 0.2, 0.3]} m={MAT.machineDark} />
    </group>
  );
}

/** Zone L: maintenance workshop (machine tools, benches, crane) and the spare-parts store. */
export function Maintenance() {
  const shelving = useMemo(() => {
    const frames: Instance[] = [];
    const decks: Instance[] = [];
    const boxes: Instance[] = [];
    for (const z of [-5, -1, 3])
      for (let i = 0; i < 4; i++) {
        const x = 86 + i * 2.2;
        for (const dz of [-0.5, 0.5]) frames.push({ p: [x - 1.1, 1.4, z + dz], s: [0.06, 2.8, 0.06] });
        for (const y of [0.3, 1.1, 1.9, 2.7]) {
          decks.push({ p: [x, y, z], s: [2.2, 0.04, 1] });
          for (let k = 0; k < 3; k++)
            if (hash01(z, i, y, k) > 0.3)
              boxes.push({ p: [x - 0.7 + k * 0.7, y + 0.2, z], s: [0.55, 0.36, 0.7] });
        }
      }
    return { frames, decks, boxes };
  }, []);

  /** Refractory rollers stored horizontally on a vertical rack. */
  const rollers = useMemo<Instance[]>(
    () =>
      Array.from({ length: 9 }, (_, i) => ({
        p: [96, 0.6 + i * 0.18, -5],
        s: [0.06, 3.6, 0.06],
        r: ROT_Z90,
      })),
    [],
  );

  return (
    <group>
      <Selectable id="L-WS">
        {/* Lathe */}
        <group position={[88, 0, 22]}>
          <Box p={[0, 0.5, 0]} s={[3.4, 1, 1]} m={MAT.machineDark} />
          <Box p={[0, 1.15, 0]} s={[3, 0.3, 0.7]} m={MAT.machine} />
          <Box p={[-1.3, 1.5, 0]} s={[0.7, 0.7, 0.8]} m={MAT.machineBlue} />
        </group>
        {/* Pillar drill */}
        <group position={[93, 0, 22]}>
          <Box p={[0, 0.6, 0]} s={[1, 1.2, 1]} m={MAT.machineDark} />
          <Cyl p={[0, 1.6, 0]} r={0.12} h={2} m={MAT.steel} seg={10} />
          <Box p={[0, 2.4, 0.2]} s={[0.6, 0.6, 0.9]} m={MAT.machineBlue} />
        </group>
        {/* Milling machine */}
        <group position={[98, 0, 22]}>
          <Box p={[0, 0.7, 0]} s={[1.6, 1.4, 1.4]} m={MAT.machineBlue} />
          <Box p={[0, 1.9, -0.2]} s={[0.8, 1, 0.8]} m={MAT.machineDark} />
        </group>
        {/* Welding bay with red screens */}
        <group position={[99, 0, 15]}>
          {[-1.5, 1.5].map((x) => (
            <Box key={x} p={[x, 1, 0]} s={[0.05, 2, 3]} m={MAT.safetyRed} />
          ))}
          <Box p={[0, 1, -1.5]} s={[3, 2, 0.05]} m={MAT.safetyRed} />
          <Box p={[0, 0.45, 0]} s={[1.8, 0.9, 1]} m={MAT.steel} />
        </group>
        <Workbench p={[85, 0, 14]} />
        <Workbench p={[89, 0, 14]} />
        <Workbench p={[93, 0, 14]} />
        <ControlCabinet p={[81, 0, 26]} w={1.6} rot={Math.PI / 2} />
        <ControlCabinet p={[81, 0, 23]} w={1.6} rot={Math.PI / 2} />
        {/* Overhead crane girder and hoist */}
        <Box p={[91.5, 6.3, 18.5]} s={[24, 0.5, 0.4]} m={MAT.safety} />
        <Box p={[91.5, 6.6, 18.5]} s={[0.8, 0.4, 0.8]} m={MAT.machineDark} />
        <BlobShadow p={[92, 19]} w={24} d={14} />
      </Selectable>

      <Selectable id="L-SP">
        <Instances items={shelving.frames} m={MAT.rackUpright} cast={false} />
        <Instances items={shelving.decks} m={MAT.galvanised} />
        <Instances items={shelving.boxes} m={MAT.machineBlue} />
        <Box p={[96, 1.4, -5.6]} s={[0.2, 2.8, 0.2]} m={MAT.rackUpright} />
        <Instances items={rollers} m={MAT.refractory} cyl />
        {/* Engineering office */}
        <group position={[99.5, 0, 5]}>
          <Box p={[0, 1.4, 0]} s={[6, 2.8, 5]} m={MAT.machine} />
          <Box p={[-3.02, 1.6, 0]} s={[0.05, 1, 3.6]} m={MAT.glass} cast={false} />
          <Box p={[0, 2.9, 0]} s={[6.2, 0.2, 5.2]} m={MAT.machineDark} />
        </group>
        <BlobShadow p={[91, 0]} w={20} d={14} />
      </Selectable>
    </group>
  );
}
