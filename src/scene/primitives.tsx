/**
 * Procedural building blocks for the factory model.
 *
 * Prop shorthand used throughout the scene:
 *   p = position, s = scale (size), m = material, r = rotation (Box) or radius (Cyl/Pipe),
 *   h = height, w = width, d = depth, rot = rotation.
 * Everything is in metres, y up; the ground plane is x/z.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type EulerOrder,
  type InstancedMesh,
  type Material,
} from 'three';
import type { Vec2, Vec3 } from '../data/types';
import { MAT, UNIT_BOX, UNIT_CYLINDER, UNIT_CYLINDER_LOW, blobShadowTexture } from './materials';

/** Rotates a y-up cylinder to lie along x. */
export const ROT_Z90: Vec3 = [0, 0, Math.PI / 2];

type BoxProps = { p: Vec3; s: Vec3; m: Material; r?: Vec3; cast?: boolean };

export function Box({ p, s, m, r, cast = true }: BoxProps) {
  return (
    <mesh
      geometry={UNIT_BOX}
      material={m}
      position={p}
      scale={s}
      rotation={r}
      castShadow={cast}
      receiveShadow
    />
  );
}

type CylProps = {
  p: Vec3;
  /** Radius (bottom radius when `rt` is set). */
  r: number;
  h: number;
  m: Material;
  rot?: Vec3;
  /** Top radius; when given, a tapered cylinder is built instead of the shared unit one. */
  rt?: number;
  seg?: number;
  cast?: boolean;
};

export function Cyl({ p, r, h, m, rot, rt, seg = 24, cast = true }: CylProps) {
  if (rt == null) {
    return (
      <mesh
        geometry={seg <= 12 ? UNIT_CYLINDER_LOW : UNIT_CYLINDER}
        material={m}
        position={p}
        scale={[r, h, r]}
        rotation={rot}
        castShadow={cast}
        receiveShadow
      />
    );
  }
  return (
    <mesh material={m} position={p} rotation={rot} castShadow={cast} receiveShadow>
      <cylinderGeometry args={[rt, r, h, seg]} />
    </mesh>
  );
}

/** Straight pipe between two points. */
export function Pipe({ a, b, r = 0.12, m = MAT.pipeGrey }: { a: Vec3; b: Vec3; r?: number; m?: Material }) {
  const { pos, quat, len } = useMemo(() => {
    const va = new Vector3(...a);
    const vb = new Vector3(...b);
    const dir = vb.clone().sub(va);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
    return { pos: va.add(vb).multiplyScalar(0.5), quat: q, len: dir.length() };
  }, [a, b]);
  return (
    <mesh
      geometry={UNIT_CYLINDER_LOW}
      material={m}
      position={pos}
      quaternion={quat}
      scale={[r, len, r]}
      castShadow
    />
  );
}

/** Pipe through a list of points. */
export function PipeRun({ pts, r = 0.12, m = MAT.pipeGrey }: { pts: Vec3[]; r?: number; m?: Material }) {
  return (
    <>
      {pts.slice(1).map((b, i) => (
        <Pipe key={i} a={pts[i]} b={b} r={r} m={m} />
      ))}
    </>
  );
}

export type Instance = { p: Vec3; s: Vec3; r?: Vec3; /** Euler order */ o?: EulerOrder };

/** Many boxes (or cylinders) with one material in a single draw call. */
export function Instances({
  items,
  m,
  cyl = false,
  cast = true,
}: {
  items: Instance[];
  m: Material;
  cyl?: boolean;
  cast?: boolean;
}) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new Object3D();
    items.forEach((it, i) => {
      dummy.position.set(...it.p);
      dummy.scale.set(...it.s);
      if (it.r) dummy.rotation.set(it.r[0], it.r[1], it.r[2], it.o ?? 'XYZ');
      else dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[cyl ? UNIT_CYLINDER_LOW : UNIT_BOX, m, items.length]}
      castShadow={cast}
      receiveShadow
    />
  );
}

/** Fake soft contact shadow on the floor. `p` is [x, z]. */
export function BlobShadow({ p, w, d, o = 1 }: { p: Vec2; w: number; d: number; o?: number }) {
  const material = useMemo(
    () => new MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: o }),
    [o],
  );
  return (
    <mesh material={material} position={[p[0], 0.03, p[1]]} rotation={[-Math.PI / 2, 0, 0]} scale={[w, d, 1]}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

/** Two-rail guard railing with posts along a polyline of [x, z] points. */
export function Railing({ pts, h = 1.1, m = MAT.safety }: { pts: Vec2[]; h?: number; m?: Material }) {
  const items = useMemo(() => {
    const out: Instance[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = -Math.atan2(z1 - z0, x1 - x0);
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      out.push({ p: [mx, h, mz], s: [len, 0.06, 0.06], r: [0, yaw, 0] });
      out.push({ p: [mx, h * 0.5, mz], s: [len, 0.05, 0.05], r: [0, yaw, 0] });
      const posts = Math.max(1, Math.round(len / 1.6));
      for (let j = 0; j <= posts; j++) {
        out.push({
          p: [x0 + ((x1 - x0) * j) / posts, h / 2, z0 + ((z1 - z0) * j) / posts],
          s: [0.07, h, 0.07],
        });
      }
    }
    return out;
  }, [pts, h]);
  return <Instances items={items} m={m} cast={false} />;
}

/** Steel stair rising `h` along +x (before `dir` yaw). */
export function Stair({ p, h, w = 1, dir = 0 }: { p: Vec3; h: number; w?: number; dir?: number }) {
  const steps = Math.max(3, Math.round(h / 0.22));
  const run = steps * 0.27;
  const treads = useMemo(
    () =>
      Array.from({ length: steps }, (_, i) => ({
        p: [i * 0.27 + 0.13, (i + 1) * (h / steps) - 0.03, 0] as Vec3,
        s: [0.27, 0.05, w] as Vec3,
      })),
    [steps, h, w],
  );
  const pitch = Math.atan2(h, run);
  return (
    <group position={p} rotation={[0, dir, 0]}>
      <Instances items={treads} m={MAT.galvanised} cast={false} />
      {[-w / 2, w / 2].map((z) => (
        <Box key={z} p={[run / 2, h / 2, z]} s={[Math.hypot(run, h), 0.18, 0.05]} r={[0, 0, pitch]} m={MAT.steel} cast={false} />
      ))}
      {[-w / 2, w / 2].map((z) => (
        <Box
          key={'h' + z}
          p={[run / 2, h / 2 + 1, z]}
          s={[Math.hypot(run, h), 0.05, 0.05]}
          r={[0, 0, pitch]}
          m={MAT.safety}
          cast={false}
        />
      ))}
    </group>
  );
}

/** Raised steel platform on four legs with a perimeter railing. */
export function Platform({ p, w, d, h }: { p: Vec3; w: number; d: number; h: number }) {
  const legs = useMemo(() => {
    const out: Instance[] = [];
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) out.push({ p: [sx * (w / 2 - 0.1), h / 2, sz * (d / 2 - 0.1)], s: [0.15, h, 0.15] });
    return out;
  }, [w, d, h]);
  return (
    <group position={p}>
      <Box p={[0, h, 0]} s={[w, 0.08, d]} m={MAT.galvanised} />
      <Instances items={legs} m={MAT.steel} />
      <group position={[0, h, 0]}>
        <Railing
          pts={[
            [-w / 2, -d / 2],
            [w / 2, -d / 2],
            [w / 2, d / 2],
            [-w / 2, d / 2],
            [-w / 2, -d / 2],
          ]}
        />
      </group>
    </group>
  );
}

/** Electrical control cabinet with a glowing HMI screen. */
export function ControlCabinet({
  p,
  w = 1.2,
  h = 2.1,
  d = 0.6,
  rot = 0,
}: {
  p: Vec3;
  w?: number;
  h?: number;
  d?: number;
  rot?: number;
}) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <Box p={[0, h / 2, 0]} s={[w, h, d]} m={MAT.machine} />
      <Box p={[0, h * 0.68, d / 2 + 0.01]} s={[w * 0.5, h * 0.18, 0.02]} m={MAT.screen} cast={false} />
      <Box p={[0, h + 0.05, 0]} s={[w + 0.04, 0.1, d + 0.04]} m={MAT.machineDark} cast={false} />
    </group>
  );
}

/** Horizontal electric motor on a base plate. */
export function Motor({ p, r = 0.35, l = 0.9, rot }: { p: Vec3; r?: number; l?: number; rot?: Vec3 }) {
  return (
    <group position={p} rotation={rot}>
      <Cyl p={[0, 0, 0]} r={r} h={l} m={MAT.machineBlue} rot={ROT_Z90} seg={16} />
      <Box p={[0, -r * 0.8, 0]} s={[l * 0.8, 0.12, r * 1.6]} m={MAT.machineDark} />
    </group>
  );
}

/** Square pyramid hopper on legs. */
export function Hopper({ p, w, h, legH = 3 }: { p: Vec3; w: number; h: number; legH?: number }) {
  return (
    <group position={p}>
      <mesh material={MAT.galvanised} position={[0, legH + h * 0.35, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <cylinderGeometry args={[w * 0.71, w * 0.2, h * 0.7, 4]} />
      </mesh>
      <Box p={[0, legH + h * 0.85, 0]} s={[w, h * 0.3, w]} m={MAT.galvanised} />
      {[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => (
          <Box
            key={`${sx}${sz}`}
            p={[sx * w * 0.42, (legH + h * 0.5) / 2, sz * w * 0.42]}
            s={[0.18, legH + h * 0.5, 0.18]}
            m={MAT.steel}
          />
        )),
      )}
    </group>
  );
}

/** Cylindrical silo with a cone bottom on four legs. */
export function Silo({
  p,
  r,
  h,
  legH = 3,
  m = MAT.galvanised,
}: {
  p: Vec3;
  r: number;
  h: number;
  legH?: number;
  m?: Material;
}) {
  const cone = r * 1.1;
  return (
    <group position={p}>
      <Cyl p={[0, legH + cone / 2, 0]} r={0.25} rt={r} h={cone} m={m} />
      <Cyl p={[0, legH + cone + h / 2, 0]} r={r} h={h} m={m} />
      <Cyl p={[0, legH + cone + h + 0.25, 0]} r={r} rt={r * 0.3} h={0.5} m={m} />
      {[0, 1, 2, 3].map((i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        return (
          <Box
            key={i}
            p={[Math.cos(a) * r * 0.85, (legH + cone) / 2, Math.sin(a) * r * 0.85]}
            s={[0.2, legH + cone, 0.2]}
            m={MAT.steel}
          />
        );
      })}
    </group>
  );
}

/** Vertical tank, optionally with a top-mounted agitator drive. */
export function Tank({
  p,
  r,
  h,
  m = MAT.stainless,
  agitator = true,
}: {
  p: Vec3;
  r: number;
  h: number;
  m?: Material;
  agitator?: boolean;
}) {
  return (
    <group position={p}>
      <Cyl p={[0, h / 2, 0]} r={r} h={h} m={m} />
      <Cyl p={[0, h + 0.06, 0]} r={r + 0.05} h={0.12} m={MAT.steel} />
      {agitator && (
        <>
          <Box p={[0, h + 0.3, 0]} s={[r * 2.1, 0.25, 0.4]} m={MAT.steel} />
          <Cyl p={[0, h + 0.75, 0]} r={0.28} h={0.7} m={MAT.machineBlue} seg={12} />
          <Cyl p={[0, h + 1.25, 0]} r={0.2} h={0.4} m={MAT.machineDark} seg={12} />
        </>
      )}
    </group>
  );
}

/** Wooden pallet with an optional stack of cartons and stretch wrap. */
export function Pallet({ p, cartons = 3, wrap = false }: { p: Vec3; cartons?: number; wrap?: boolean }) {
  return (
    <group position={p}>
      <Box p={[0, 0.07, 0]} s={[1.2, 0.14, 1]} m={MAT.pallet} />
      {cartons > 0 && <Box p={[0, 0.14 + cartons * 0.15, 0]} s={[1.15, cartons * 0.3, 0.95]} m={MAT.carton} />}
      {wrap && cartons > 0 && (
        <Box p={[0, 0.14 + cartons * 0.15, 0]} s={[1.19, cartons * 0.3 + 0.02, 0.99]} m={MAT.wrap} cast={false} />
      )}
    </group>
  );
}

/** Industrial roller door in a steel frame; `open` shows it rolled up. */
export function Door({ p, w, h, rot = 0, open = false }: { p: Vec3; w: number; h: number; rot?: number; open?: boolean }) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      {[-w / 2 - 0.15, w / 2 + 0.15].map((x) => (
        <Box key={x} p={[x, h / 2, 0]} s={[0.3, h, 0.4]} m={MAT.doorFrame} />
      ))}
      <Box p={[0, h + 0.35, 0]} s={[w + 0.6, 0.7, 0.6]} m={MAT.doorFrame} />
      {!open && <Box p={[0, h / 2, 0.05]} s={[w, h, 0.08]} m={MAT.door} />}
      {open && <Box p={[0, h - 0.4, 0.05]} s={[w, 0.8, 0.08]} m={MAT.door} />}
    </group>
  );
}
