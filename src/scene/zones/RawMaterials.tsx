import { useMemo } from 'react';
import { ConeGeometry, type Material } from 'three';
import { MAT } from '../materials';
import { BlobShadow, Box, ControlCabinet, Hopper, Instances, Silo, type Instance } from '../primitives';
import { Selectable } from '../Selectable';

/** X centres of the six covered storage bays. */
const BAY_X = [-115, -109.6, -104.2, -98.8, -93.4, -88];
/** Material stockpiled in each bay. */
const BAY_MATERIALS: Material[] = [MAT.clay, MAT.redClay, MAT.feldspar, MAT.sand, MAT.kaolin, MAT.clay];
const BAY_WIDTH = 5.4;

/** Wheel-loader shuttle loop between the bays and the box feeders. */

/** Stockpile of bulk material: a cone with a slightly irregular base. */
function Stockpile({ x, m, seed }: { x: number; m: Material; seed: number }) {
  const geometry = useMemo(() => {
    const geo = new ConeGeometry(1, 1, 9, 3);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++)
      if (pos.getY(i) < 0.49) {
        const k = 1 + Math.sin(i * 12.9898 + seed) * 0.08;
        pos.setX(i, pos.getX(i) * k);
        pos.setZ(i, pos.getZ(i) * k);
      }
    geo.computeVertexNormals();
    return geo;
  }, [seed]);
  return (
    <mesh geometry={geometry} material={m} position={[x, 1.7, -42]} scale={[2.4, 3.4, 5.2]} castShadow receiveShadow />
  );
}

/** Zone B: truck receiving, storage bays, wheel loader, box feeders and additive silos. */
export function RawMaterials() {
  const bayWalls = useMemo<Instance[]>(
    () => [
      ...[...BAY_X.map((x) => x - BAY_WIDTH / 2), BAY_X[BAY_X.length - 1] + BAY_WIDTH / 2].map(
        (x): Instance => ({ p: [x, 1.9, -42.5], s: [0.5, 3.8, 15] }),
      ),
      { p: [-101.5, 1.9, -49.6], s: [33, 3.8, 0.5] },
    ],
    [],
  );

  return (
    <group>
      <Selectable id="B-RCV">
        {/* Weighbridge with kerbs and the weigh office */}
        <Box p={[-129, 0.18, -28]} s={[19, 0.36, 3.6]} m={MAT.galvanised} />
        <Box p={[-129, 0.4, -29.9]} s={[19, 0.5, 0.2]} m={MAT.safety} />
        <Box p={[-129, 0.4, -26.1]} s={[19, 0.5, 0.2]} m={MAT.safety} />
        <Box p={[-129, 1.4, -32.5]} s={[3.2, 2.8, 2.6]} m={MAT.machine} />
        <Box p={[-129, 1.8, -31.15]} s={[2.4, 1, 0.06]} m={MAT.glass} cast={false} />
      </Selectable>

      <Selectable id="B-BAYS">
        <Instances items={bayWalls} m={MAT.concreteWall} />
        {BAY_X.map((x, i) => (
          <Stockpile key={x} x={x} m={BAY_MATERIALS[i]} seed={i} />
        ))}
      </Selectable>

      <Selectable id="B-LOAD">
        {/* The wheel loader itself is a simulated vehicle (src/scene/SimVehicles.tsx); this
            invisible volume keeps a stable selection box over its working area. */}
        <mesh visible={false} position={[-101, 2, -23.5]} scale={[18, 4, 18]}>
          <boxGeometry />
        </mesh>
      </Selectable>

      <Selectable id="B-FEED">
        {[-112, -106.5, -101, -95.5].map((x) => (
          <group key={x}>
            <Hopper p={[x, 0, -11.5]} w={4} h={3.4} legH={2.2} />
            <Box p={[x, 1.25, -9.2]} s={[1.2, 0.3, 3.4]} m={MAT.belt} />
            <Box p={[x, 0.75, -9.2]} s={[1.4, 0.9, 3.4]} m={MAT.machineBlue} />
            <BlobShadow p={[x, -11]} w={6} d={6} />
          </group>
        ))}
        <ControlCabinet p={[-91, 0, -12]} rot={-Math.PI / 2} />
      </Selectable>

      <Selectable id="B-SILO">
        <Silo p={[-85, 0, -22]} r={1.8} h={6} legH={2.6} />
        <Silo p={[-85, 0, -28]} r={1.8} h={6} legH={2.6} />
        <Box p={[-85, 11.3, -25]} s={[1, 0.4, 7.6]} m={MAT.steel} />
        <BlobShadow p={[-85, -25]} w={7} d={12} />
      </Selectable>
    </group>
  );
}
