import { useMemo } from 'react';
import {
  IcosahedronGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
  type Material,
} from 'three';
import { GATE_X, GUARD_HOUSE_POS, PARKING, SITE } from '../data/layout';
import type { Vec2, Vec3 } from '../data/types';
import { MAT, hash01 } from './materials';
import { Box, Instances, type Instance } from './primitives';
import { Selectable } from './Selectable';
import { Car } from './vehicles';
import { Fence } from './zones/Utilities';

/**
 * Site assets stay clickable whatever layers are hidden: Selectable skips the
 * layer check when `layer` is null (the default would be 'equipment').
 */

/** Rows of trees along the site perimeter and beside the car park. */
function Trees() {
  const { trunks, crowns } = useMemo(() => {
    const spots: Vec2[] = [];
    for (let x = SITE.x[0] + 6; x < SITE.x[1] - 4; x += 9) {
      if (Math.abs(x - GATE_X[0]) > 14) spots.push([x, SITE.z[1] - 2.5]);
      spots.push([x, SITE.z[0] + 2]);
    }
    for (let z = SITE.z[0] + 8; z < SITE.z[1] - 4; z += 10) {
      spots.push([SITE.x[0] + 2, z]);
      spots.push([SITE.x[1] - 1.5, z]);
    }
    for (let z = PARKING.z[0]; z <= PARKING.z[1]; z += 10) spots.push([PARKING.x[0] + 12, z]);
    const trunks: Instance[] = [];
    const crowns: Instance[] = [];
    spots.forEach(([x, z], i) => {
      const height = 3 + hash01(i, 't') * 2;
      const radius = 2 + hash01(i, 'r') * 1.4;
      trunks.push({ p: [x, height / 2, z], s: [0.22, height, 0.22] });
      crowns.push({ p: [x, height + radius * 0.7, z], s: [radius, radius * 1.15, radius] });
    });
    return { trunks, crowns };
  }, []);
  const crownGeometry = useMemo(() => new IcosahedronGeometry(1, 1), []);
  const crownMaterial = useMemo(
    () => new MeshStandardMaterial({ color: '#5f7a4a', roughness: 0.95, flatShading: true }),
    [],
  );
  return (
    <>
      <Instances items={trunks} m={MAT.pallet} cyl cast={false} />
      <GeometryInstances items={crowns} geo={crownGeometry} m={crownMaterial} />
    </>
  );
}

/** Instanced mesh of an arbitrary geometry (position + scale only). */
function GeometryInstances({ items, geo, m }: { items: Instance[]; geo: BufferGeometry; m: Material }) {
  const mesh = useMemo(() => {
    const instanced = new InstancedMesh(geo, m, items.length);
    const dummy = new Object3D();
    items.forEach((it, i) => {
      dummy.position.set(...it.p);
      dummy.scale.set(...it.s);
      dummy.updateMatrix();
      instanced.setMatrixAt(i, dummy.matrix);
    });
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    return instanced;
  }, [items, geo, m]);
  return <primitive object={mesh} />;
}

type ParkedCar = { p: Vec3; rot: number; m: Material };

/** Perimeter fence, trees, gate, car park, admin block, truck holding area and circulating trucks. */
export function SiteDetails() {
  const cars = useMemo(() => {
    const out: ParkedCar[] = [];
    for (let z = PARKING.z[0] + 3.3; z < PARKING.z[1] - 1; z += 2.6) {
      for (const [x, rot] of [
        [PARKING.x[0] + 3, 0],
        [PARKING.x[1] - 3, Math.PI],
      ]) {
        if (hash01(x, z) < 0.62) {
          out.push({ p: [x, 0, z], rot, m: MAT.car[Math.floor(hash01(z, x, 'c') * MAT.car.length)] });
        }
      }
    }
    return out;
  }, []);
  const { x, z } = SITE;
  return (
    <group>
      <Fence
        pts={[
          [x[0], z[0]],
          [x[1], z[0]],
          [x[1], z[1]],
          [x[0], z[1]],
          [x[0], z[0]],
        ]}
        gap={[GATE_X[0] - 5, GATE_X[0] + 5, z[1] - 1, z[1] + 1]}
      />
      <Trees />

      <Selectable id="A-GATE" layer={null}>
        {/* Guard house */}
        <group position={[GUARD_HOUSE_POS[0], 0, GUARD_HOUSE_POS[1]]}>
          <Box p={[0, 1.5, 0]} s={[4.5, 3, 3.2]} m={MAT.machine} />
          <Box p={[0, 1.8, 1.62]} s={[3.6, 1.2, 0.05]} m={MAT.glass} cast={false} />
          <Box p={[0, 3.15, 0]} s={[5.6, 0.3, 4.2]} m={MAT.machineDark} />
        </group>
        {[GATE_X[0] - 4.6, GATE_X[0] + 4.6].map((gx) => (
          <Box key={gx} p={[gx, 1.4, z[1]]} s={[0.8, 2.8, 0.8]} m={MAT.concreteWall} />
        ))}
        {/* Barriers: one lowered, one raised */}
        <Box p={[GATE_X[0] - 1.8, 1, z[1] - 0.6]} s={[4.4, 0.12, 0.12]} m={MAT.safetyRed} />
        <Box p={[GATE_X[0] + 1.8, 2.6, z[1] + 0.6]} s={[0.12, 3.6, 0.12]} m={MAT.safetyRed} />
        <Box p={[GATE_X[0] - 4.1, 0.6, z[1] - 0.6]} s={[0.4, 1.2, 0.4]} m={MAT.machine} />
        <Box p={[GATE_X[0] + 4.1, 0.6, z[1] + 0.6]} s={[0.4, 1.2, 0.4]} m={MAT.machine} />
      </Selectable>

      <Selectable id="A-PARK" layer={null}>
        {cars.map((car, i) => (
          <Car key={i} p={car.p} rot={car.rot} m={car.m} />
        ))}
      </Selectable>

      <Selectable id="A-ADMIN" layer={null}>
        <group position={[41, 0, 64]}>
          <Box p={[0, 4, 0]} s={[34, 8, 14]} m={MAT.machine} />
          {[2.2, 5.4].map((y) => (
            <Box key={y} p={[0, y, 7.03]} s={[32, 1.6, 0.06]} m={MAT.curtainGlass} cast={false} />
          ))}
          <Box p={[0, 8.2, 0]} s={[34.6, 0.4, 14.6]} m={MAT.machineDark} />
          {/* Entrance canopy */}
          <Box p={[-11, 2, 8.4]} s={[8, 0.3, 3]} m={MAT.machineDark} />
          <Box p={[-11, 1, 7.2]} s={[5, 2, 0.06]} m={MAT.glass} cast={false} />
          {[-14, -8].map((cx) => (
            <Box key={cx} p={[cx, 1, 9.8]} s={[0.25, 2, 0.25]} m={MAT.steel} />
          ))}
        </group>
      </Selectable>

      <Selectable id="A-HOLD" layer={null}>
        {/* Waiting trucks are simulated vehicles (src/scene/SimVehicles.tsx). Bay lines match the
            eight simulated holding slots; the volume keeps the area selectable when empty. */}
        {[52.75, 57.25, 61.75, 66.25, 70.75, 75.25, 79.75, 84.25, 88.75].map((z) => (
          <Box key={z} p={[-40, 0.06, z]} s={[17, 0.02, 0.14]} m={MAT.markingWhite} cast={false} />
        ))}
        <mesh visible={false} position={[-40, 1.5, 70]} scale={[50, 3, 34]}>
          <boxGeometry />
        </mesh>
        {[-60, -20].map((lx) => (
          <Box key={lx} p={[lx, 0.06, 69]} s={[0.2, 0.02, 32]} m={MAT.markingWhite} cast={false} />
        ))}
      </Selectable>

    </group>
  );
}
