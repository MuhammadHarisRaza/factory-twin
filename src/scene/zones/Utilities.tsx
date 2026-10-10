import { useMemo } from 'react';
import { DoubleSide, MeshStandardMaterial, type Material } from 'three';
import type { Vec2, Vec3 } from '../../data/types';
import { MAT } from '../materials';
import { BlobShadow, Box, Cyl, Instances, PipeRun, type Instance } from '../primitives';
import { Selectable } from '../Selectable';

/**
 * Mesh security fence with posts every ~3 m along a polyline of [x, z] points.
 * Panels whose midpoint falls inside `gap` ([x0, x1, z0, z1]) are left out (gate openings).
 */
export function Fence({
  pts,
  h = 2.4,
  gap,
}: {
  pts: Vec2[];
  h?: number;
  gap?: [number, number, number, number];
}) {
  const { posts, mesh } = useMemo(() => {
    const posts: Instance[] = [];
    const mesh: Instance[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const panels = Math.max(1, Math.round(len / 3));
      const yaw = -Math.atan2(z1 - z0, x1 - x0);
      for (let j = 0; j < panels; j++) {
        const t0 = j / panels;
        const t1 = (j + 1) / panels;
        const ax = x0 + (x1 - x0) * t0;
        const az = z0 + (z1 - z0) * t0;
        const bx = x0 + (x1 - x0) * t1;
        const bz = z0 + (z1 - z0) * t1;
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        if (gap && mx > gap[0] && mx < gap[1] && mz > gap[2] && mz < gap[3]) continue;
        posts.push({ p: [ax, h / 2, az], s: [0.08, h, 0.08] });
        mesh.push({ p: [mx, h / 2, mz], s: [len / panels, h, 0.02], r: [0, yaw, 0] });
      }
    }
    return { posts, mesh };
  }, [pts, h, gap]);
  const meshMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#7f8a93',
        transparent: true,
        opacity: 0.28,
        metalness: 0.5,
        roughness: 0.6,
        side: DoubleSide,
      }),
    [],
  );
  return (
    <>
      <Instances items={posts} m={MAT.galvanised} cast={false} />
      <Instances items={mesh} m={meshMaterial} cast={false} />
    </>
  );
}

/** Small single-storey plant building with a roof overhang, plinth strip and contact shadow. */
function PlantHouse({ p, w, d, h, m = MAT.cladding }: { p: Vec3; w: number; d: number; h: number; m?: Material }) {
  return (
    <group position={p}>
      <Box p={[0, h / 2, 0]} s={[w, h, d]} m={m} />
      <Box p={[0, h + 0.15, 0]} s={[w + 0.4, 0.3, d + 0.4]} m={MAT.roof} />
      <Box p={[0, 0.3, d / 2 + 0.02]} s={[w, 0.6, 0.04]} m={MAT.plinth} cast={false} />
      <BlobShadow p={[0, 0]} w={w + 4} d={d + 4} o={0.7} />
    </group>
  );
}

/** Oil-filled power transformer on a concrete pad, with radiators, bushings and a cooling fan. */
function Transformer({ p }: { p: Vec3 }) {
  return (
    <group position={p}>
      <Box p={[0, 0.3, 0]} s={[4, 0.6, 3]} m={MAT.concreteWall} />
      <Box p={[0, 1.9, 0]} s={[2.8, 2.6, 2]} m={MAT.machineDark} />
      {[-1, 1].map((side) => (
        <Box key={side} p={[0, 1.8, side * 1.25]} s={[2.4, 2.2, 0.5]} m={MAT.steel} />
      ))}
      {[-0.8, 0, 0.8].map((x) => (
        <Cyl key={x} p={[x, 3.6, 0]} r={0.12} h={0.9} m={MAT.machine} seg={10} />
      ))}
      <Cyl p={[1.1, 3.6, -0.6]} r={0.35} h={1} m={MAT.machineDark} rot={[0, 0, Math.PI / 2]} seg={12} />
    </group>
  );
}

/** Outdoor utilities south of the hall: dust collection, compressed air, substation, water and gas. */
export function Utilities() {
  return (
    <group>
      <Selectable id="A-DUST">
        {[-70, -61.5].map((x) => (
          <group key={x} position={[x, 0, -37.5]}>
            <Box p={[0, 6.5, 0]} s={[4.6, 4.4, 3.4]} m={MAT.machine} />
            {[-1.15, 1.15].map((hx) => (
              <Cyl
                key={hx}
                p={[hx, 3.6, 0]}
                r={0.2}
                rt={1.3}
                h={1.6}
                m={MAT.machine}
                rot={[0, Math.PI / 4, 0]}
                seg={4}
              />
            ))}
            {[-2, 2].map((lx) =>
              [-1.4, 1.4].map((lz) => (
                <Box key={`${lx}${lz}`} p={[lx, 2.4, lz]} s={[0.2, 4.8, 0.2]} m={MAT.steel} />
              )),
            )}
            <Box p={[0, 8.9, 0]} s={[4.8, 0.4, 3.6]} m={MAT.machineDark} />
            <Box p={[0, 8.2, 3.6]} s={[1.2, 1.2, 4]} m={MAT.galvanised} />
          </group>
        ))}
        <Box p={[-56.5, 1.3, -37.5]} s={[2.4, 2.6, 2.4]} m={MAT.machineBlue} />
        <Cyl p={[-56.5, 7, -37.5]} r={0.6} h={11} m={MAT.galvanised} />
        <BlobShadow p={[-65, -37.5]} w={20} d={8} />
      </Selectable>

      <Selectable id="A-COMP">
        <PlantHouse p={[1, 0, -40]} w={14} d={10} h={5.2} />
        {[-4, -1].map((x) => (
          <Cyl key={x} p={[x, 2.2, -33.3]} r={0.8} h={4.4} m={MAT.machine} />
        ))}
        {[-4, -1, 2, 5].map((x) => (
          <Box key={x} p={[x, 3.2, -34.96]} s={[1.8, 1.2, 0.05]} m={MAT.claddingDark} cast={false} />
        ))}
      </Selectable>

      <Selectable id="A-SUB">
        <Fence
          pts={[
            [13, -52],
            [35, -52],
            [35, -36],
            [13, -36],
            [13, -52],
          ]}
        />
        <Transformer p={[18, 0, -47]} />
        <Transformer p={[18, 0, -41]} />
        <PlantHouse p={[29, 0, -44]} w={8} d={12} h={4.2} m={MAT.concreteWall} />
        <Box p={[23.5, 0.15, -44]} s={[1.2, 0.3, 12]} m={MAT.plinth} />
      </Selectable>

      <Selectable id="A-WTR">
        {[44, 54].map((x) => (
          <group key={x}>
            <Cyl p={[x, 3.6, -48]} r={4} h={7.2} m={MAT.galvanised} />
            <Cyl p={[x, 7.45, -48]} r={4.05} rt={0.6} h={0.5} m={MAT.galvanised} />
            {[0, 1, 2, 3, 4, 5].map((a) => (
              <Box
                key={a}
                p={[x + Math.cos(a) * 4.02, 3.6, -48 + Math.sin(a) * 4.02]}
                s={[0.12, 7.2, 0.12]}
                r={[0, -a, 0]}
                m={MAT.steel}
              />
            ))}
            <BlobShadow p={[x, -48]} w={11} d={11} />
          </group>
        ))}
        <PlantHouse p={[49, 0, -38.5]} w={8} d={5} h={3.6} />
        <PipeRun
          pts={[
            [44, 0.6, -44],
            [44, 0.6, -38.5],
            [45, 0.6, -38.5],
          ]}
          r={0.18}
          m={MAT.pipeBlue}
        />
        <PipeRun
          pts={[
            [54, 0.6, -44],
            [54, 0.6, -38.5],
            [53, 0.6, -38.5],
          ]}
          r={0.18}
          m={MAT.pipeBlue}
        />
        <PipeRun
          pts={[
            [49, 0.6, -36],
            [49, 0.6, -31],
            [49, 6, -31],
          ]}
          r={0.14}
          m={MAT.pipeBlue}
        />
      </Selectable>

      <Selectable id="A-GAS">
        <Fence
          pts={[
            [60, -44],
            [68, -44],
            [68, -36],
            [60, -36],
            [60, -44],
          ]}
          h={2}
        />
        <PipeRun
          pts={[
            [61, 0.9, -40],
            [67, 0.9, -40],
          ]}
          r={0.2}
          m={MAT.pipeYellow}
        />
        {[62.5, 65].map((x) => (
          <Box key={x} p={[x, 0.9, -40]} s={[0.9, 0.9, 0.9]} m={MAT.pipeYellow} />
        ))}
        <Box p={[64, 0.75, -42.5]} s={[2, 1.5, 1]} m={MAT.machine} />
        <PipeRun
          pts={[
            [67, 0.9, -40],
            [70, 0.9, -40],
            [70, 0.9, -31],
            [70, 7, -31],
          ]}
          r={0.14}
          m={MAT.pipeYellow}
        />
      </Selectable>
    </group>
  );
}
