import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, Material } from 'three';
import type { Vec2, Vec3 } from '../data/types';
import { MAT } from './materials';
import { Box, Cyl } from './primitives';

/** Wheels at [x, z] offsets, axles along z. */
export function Wheels({ pts, r = 0.5, w = 0.4 }: { pts: Vec2[]; r?: number; w?: number }) {
  return (
    <>
      {pts.map(([x, z], i) => (
        <Cyl key={i} p={[x, r, z]} r={r} h={w} m={MAT.rubber} rot={[Math.PI / 2, 0, 0]} seg={14} />
      ))}
    </>
  );
}

export type TruckKind = 'flat' | 'box' | 'tipper';

/** Articulated truck, cab facing +x. */
export function Truck({
  p,
  rot = 0,
  kind = 'flat',
  cab = MAT.truckCab,
}: {
  p: Vec3;
  rot?: number;
  kind?: TruckKind;
  cab?: Material;
}) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <Box p={[6.2, 1.95, 0]} s={[2.2, 2.3, 2.45]} m={cab} />
      <Box p={[7.25, 2.4, 0]} s={[0.1, 1, 2.1]} m={MAT.glass} cast={false} />
      <Box p={[5.4, 0.9, 0]} s={[3.8, 0.5, 2.3]} m={MAT.machineDark} />
      <Wheels
        pts={[
          [6.6, 1.05],
          [6.6, -1.05],
          [4.4, 1.05],
          [4.4, -1.05],
        ]}
      />
      <Box p={[-1.2, 1.15, 0]} s={[12, 0.35, 2.5]} m={MAT.machineDark} />
      {kind === 'box' && <Box p={[-1.2, 2.75, 0]} s={[12, 2.9, 2.5]} m={MAT.trailer} />}
      {kind === 'tipper' && (
        <>
          <Box p={[-1.2, 2.2, 0]} s={[11, 1.8, 2.45]} m={MAT.machineBlue} />
          <Box p={[-1.2, 2.85, 0]} s={[10.6, 0.6, 2.2]} m={MAT.clay} />
        </>
      )}
      {kind === 'flat' &&
        [-4.5, -1.5, 1.5].map((x) => (
          <group key={x}>
            <Box p={[x, 1.42, 0]} s={[1.2, 0.14, 1]} m={MAT.pallet} />
            <Box p={[x, 2, 0]} s={[1.15, 1, 0.95]} m={MAT.carton} />
          </group>
        ))}
      <Wheels
        pts={[
          [-5.2, 1.05],
          [-5.2, -1.05],
          [-6.6, 1.05],
          [-6.6, -1.05],
        ]}
      />
    </group>
  );
}

/** Counterbalance forklift, forks facing +x, optionally carrying a pallet. */
export function Forklift({ p, rot = 0, load = true }: { p: Vec3; rot?: number; load?: boolean }) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <Box p={[0, 0.75, 0]} s={[2.2, 0.9, 1.15]} m={MAT.forklift} />
      <Box p={[-0.75, 0.95, 0]} s={[0.7, 1, 1.05]} m={MAT.machineDark} />
      <Box p={[0.05, 1.7, 0]} s={[1.2, 0.08, 1.1]} m={MAT.machineDark} />
      {[-0.5, 0.5].map((z) => (
        <Box key={z} p={[0.6, 1.2, z]} s={[0.06, 1, 0.06]} m={MAT.machineDark} />
      ))}
      {[-0.5, 0.5].map((z) => (
        <Box key={'r' + z} p={[-0.4, 1.2, z]} s={[0.06, 1, 0.06]} m={MAT.machineDark} />
      ))}
      {[-0.32, 0.32].map((z) => (
        <Box key={'m' + z} p={[1.2, 1.25, z]} s={[0.1, 2.5, 0.1]} m={MAT.machineDark} />
      ))}
      {[-0.3, 0.3].map((z) => (
        <Box key={'f' + z} p={[1.85, 0.12, z]} s={[1.2, 0.06, 0.12]} m={MAT.steel} />
      ))}
      {load && (
        <>
          <Box p={[1.85, 0.22, 0]} s={[1.2, 0.14, 1]} m={MAT.pallet} />
          <Box p={[1.85, 0.75, 0]} s={[1.15, 0.9, 0.95]} m={MAT.carton} />
        </>
      )}
      <Wheels
        pts={[
          [0.7, 0.55],
          [0.7, -0.55],
          [-0.7, 0.55],
          [-0.7, -0.55],
        ]}
        r={0.32}
        w={0.25}
      />
    </group>
  );
}

/** Front wheel loader, bucket facing +x. */
export function WheelLoader({ p, rot = 0 }: { p: Vec3; rot?: number }) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <Box p={[-0.8, 1.6, 0]} s={[3.6, 1.4, 2.2]} m={MAT.loader} />
      <Box p={[0.2, 2.9, 0]} s={[1.6, 1.5, 1.7]} m={MAT.loader} />
      <Box p={[0.25, 3, 0]} s={[1.5, 1, 1.75]} m={MAT.glass} cast={false} />
      <Box p={[2.2, 1.8, 0]} s={[1.6, 0.4, 0.5]} m={MAT.machineDark} />
      <Box p={[3.3, 1, 0]} s={[1, 1.2, 2.8]} m={MAT.machineDark} />
      <Wheels
        pts={[
          [1.6, 1.2],
          [1.6, -1.2],
          [-1.8, 1.2],
          [-1.8, -1.2],
        ]}
        r={0.85}
        w={0.6}
      />
    </group>
  );
}

/** Parked car, bonnet facing +x. */
export function Car({ p, rot = 0, m }: { p: Vec3; rot?: number; m: Material }) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <Box p={[0, 0.6, 0]} s={[4.4, 0.75, 1.8]} m={m} />
      <Box p={[-0.2, 1.2, 0]} s={[2.3, 0.6, 1.6]} m={MAT.glass} cast={false} />
      <Box p={[-0.2, 1.52, 0]} s={[2.1, 0.06, 1.55]} m={m} cast={false} />
    </group>
  );
}

/**
 * Moves its children around a closed loop of [x, z] points at `speed` m/s,
 * turning smoothly to face the direction of travel.
 */
export function PathMover({
  pts,
  speed,
  y = 0,
  children,
  offset = 0,
}: {
  pts: Vec2[];
  speed: number;
  y?: number;
  children: ReactNode;
  /** Start distance along the loop (m). */
  offset?: number;
}) {
  const ref = useRef<Group>(null);
  const path = useMemo(() => {
    const segs: { a: Vec2; b: Vec2; len: number; start: number }[] = [];
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      segs.push({ a, b, len, start: total });
      total += len;
    }
    return { segs, total };
  }, [pts]);
  const distance = useRef(offset);

  useLayoutEffect(() => {
    // Moving objects would invalidate the static shadow map every frame.
    ref.current?.traverse((o) => {
      o.castShadow = false;
    });
  }, []);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    distance.current = (distance.current + speed * Math.min(dt, 0.1)) % path.total;
    const seg = path.segs.find((s) => distance.current <= s.start + s.len) ?? path.segs[0];
    const t = (distance.current - seg.start) / seg.len;
    g.position.set(seg.a[0] + (seg.b[0] - seg.a[0]) * t, y, seg.a[1] + (seg.b[1] - seg.a[1]) * t);
    let turn = -Math.atan2(seg.b[1] - seg.a[1], seg.b[0] - seg.a[0]) - g.rotation.y;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    g.rotation.y += turn * Math.min(1, dt * 4);
  });

  return (
    <group ref={ref} position={[pts[0][0], y, pts[0][1]]}>
      {children}
    </group>
  );
}
