import { MAT } from '../materials';
import {
  BlobShadow,
  Box,
  ControlCabinet,
  Cyl,
  Motor,
  PipeRun,
  ROT_Z90,
  Silo,
  Stair,
} from '../primitives';
import { Selectable } from '../Selectable';

/** Spray-dryer tower centre on the ground plane. */
const TOWER_X = -35;
const TOWER_Z = -44;
/** Powder silo grid. */
const SILO_X = [-41, -35, -29];
const SILO_Z = [-24, -17];

/** Bucket elevator: tall casing with a motorised head and a boot at the bottom. */
function BucketElevator({ x, z, h }: { x: number; z: number; h: number }) {
  return (
    <group position={[x, 0, z]}>
      <Box p={[0, h / 2, 0]} s={[0.9, h, 1.6]} m={MAT.machineBlue} />
      <Box p={[0, h + 0.6, 0]} s={[1.3, 1.2, 2]} m={MAT.machineBlue} />
      <Motor p={[0.9, h + 0.6, 0]} r={0.3} l={0.7} rot={[0, Math.PI / 2, 0]} />
      <Box p={[0, 0.6, 0]} s={[1.4, 1.2, 2.2]} m={MAT.machineDark} />
    </group>
  );
}

/** Zone D: spray-dryer tower, hot-air generator, cyclones + bag filter + stack, and powder silos. */
export function SprayDrying() {
  return (
    <group>
      <Selectable id="D-TWR">
        <group position={[TOWER_X, 0, TOWER_Z]}>
          {/* Cone bottom, cylindrical chamber and roof cone */}
          <Cyl p={[0, 6.2, 0]} r={0.7} rt={4.6} h={6.4} m={MAT.stainless} />
          <Cyl p={[0, 15, 0]} r={4.6} h={11.2} m={MAT.stainless} />
          <Cyl p={[0, 21.3, 0]} r={4.6} rt={1.6} h={1.4} m={MAT.stainless} />
          {[11, 15.5, 20].map((y) => (
            <Cyl key={y} p={[0, y, 0]} r={4.66} h={0.14} m={MAT.steel} />
          ))}
          <Cyl p={[0, 22.6, 0]} r={1.6} h={1.2} m={MAT.machine} />
          <Box p={[-2.8, 23.2, 2.4]} s={[4.6, 1.6, 1.6]} m={MAT.machine} />
          <Cyl p={[0, 2.5, 0]} r={0.5} h={1.2} m={MAT.machineDark} />
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const a = (i / 6) * Math.PI * 2;
            return <Box key={i} p={[Math.cos(a) * 4.2, 4.6, Math.sin(a) * 4.2]} s={[0.4, 9.2, 0.4]} m={MAT.steel} />;
          })}
          <Cyl p={[0, 9.3, 0]} r={4.9} h={0.35} m={MAT.steel} />
          <BlobShadow p={[0, 0]} w={12} d={12} />
        </group>
        <Stair p={[-45, 0, -54]} h={8} dir={0} />
      </Selectable>

      <Selectable id="D-HAG">
        <group position={[-42.5, 0, -35.5]}>
          <Cyl p={[0, 1.8, 0]} r={1.5} h={5.5} m={MAT.machine} rot={ROT_Z90} />
          <Box p={[-3.3, 1.6, 0]} s={[1.4, 2.2, 2]} m={MAT.machineBlue} />
          <Cyl p={[3, 1.8, 0]} r={1} h={0.8} m={MAT.machineDark} rot={ROT_Z90} />
          {/* Hot-air duct up to the tower roof */}
          <Box p={[3.4, 12, 0]} s={[1.4, 20, 1.4]} m={MAT.galvanised} />
          <Box p={[4.4, 22.3, -3.4]} s={[1.4, 1.4, 8]} m={MAT.galvanised} />
          <PipeRun
            pts={[
              [-3.3, 0.3, 1.2],
              [-3.3, 0.3, 5],
            ]}
            r={0.12}
            m={MAT.pipeYellow}
          />
          <BlobShadow p={[0, 0]} w={9} d={5} />
        </group>
      </Selectable>

      <Selectable id="D-CYC">
        {[-50.5, -53.5].map((z) => (
          <group key={z} position={[-27.5, 0, z]}>
            <Cyl p={[0, 13, 0]} r={1.2} h={3.4} m={MAT.stainless} />
            <Cyl p={[0, 9.8, 0]} r={0.2} rt={1.2} h={3} m={MAT.stainless} />
            {[-0.9, 0.9].map((x) => (
              <Box key={x} p={[x, 6.5, 0]} s={[0.15, 13, 0.15]} m={MAT.steel} />
            ))}
          </group>
        ))}
        <Box p={[-31, 21.5, -52]} s={[7, 1.2, 1.2]} m={MAT.galvanised} />
        {/* Bag filter */}
        <group position={[-28, 0, -38]}>
          <Box p={[0, 8.5, 0]} s={[5, 5, 4.2]} m={MAT.machine} />
          {[-1.3, 1.3].map((x) => (
            <Cyl key={x} p={[x, 5.2, 0]} r={0.2} rt={1.4} h={1.8} m={MAT.machine} rot={[0, Math.PI / 4, 0]} seg={4} />
          ))}
          {[-2.2, 2.2].map((x) =>
            [-1.8, 1.8].map((z) => <Box key={`${x}${z}`} p={[x, 3, z]} s={[0.2, 6, 0.2]} m={MAT.steel} />),
          )}
          <Box p={[0, 11.4, 0]} s={[5.4, 0.8, 4.6]} m={MAT.machineDark} />
        </group>
        {/* Exhaust fan and stack */}
        <Box p={[-25.2, 1.3, -33.6]} s={[2.2, 2.6, 2.2]} m={MAT.machineBlue} />
        <Cyl p={[-25.2, 18, -33.6]} r={0.9} h={36} m={MAT.galvanised} />
        <Cyl p={[-25.2, 35.8, -33.6]} r={1} h={0.4} m={MAT.steel} />
      </Selectable>

      <Selectable id="D-SILO">
        {SILO_X.flatMap((x) => SILO_Z.map((z) => <Silo key={`${x}${z}`} p={[x, 0, z]} r={1.6} h={6.6} legH={2.4} />))}
        <BucketElevator x={-35} z={-29} h={14} />
        <BucketElevator x={-25} z={-22.6} h={9.6} />
        <ControlCabinet p={[-44.5, 0, -10]} rot={Math.PI / 2} />
        <BlobShadow p={[-35, -20.5]} w={16} d={14} />
      </Selectable>
    </group>
  );
}
