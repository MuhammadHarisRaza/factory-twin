import { useMemo } from 'react';
import { DoubleSide } from 'three';
import { BlobShadow, Box, ControlCabinet, Cyl, Instances, Motor, PipeRun, ROT_Z90, Tank, type Instance } from '../primitives';
import { MAT } from '../materials';
import { Selectable } from '../Selectable';

/** Z position of the glazing line centre. */
const LINE_Z = -12;

/** Glaze bell (curtain applicator): reservoir over a translucent glaze curtain on a gantry. */
function GlazeBell({ x }: { x: number }) {
  return (
    <group position={[x, 0, LINE_Z]}>
      {[-1.4, 1.4].map((z) => (
        <Box key={z} p={[0, 1.6, z]} s={[0.15, 3.2, 0.15]} m={MAT.steel} />
      ))}
      <Box p={[0, 3.25, 0]} s={[0.4, 0.2, 3]} m={MAT.steel} />
      <Cyl p={[0, 3.9, 0]} r={0.55} h={1.1} m={MAT.stainless} />
      <Cyl p={[0, 2.7, 0]} r={0.75} rt={0.15} h={0.5} m={MAT.stainless} />
      <mesh position={[0, 1.7, 0]}>
        <cylinderGeometry args={[0.72, 0.72, 1.4, 20, 1, true]} />
        <meshStandardMaterial color="#eef3f4" transparent opacity={0.4} side={DoubleSide} />
      </mesh>
      <Box p={[0, 0.6, 1]} s={[1.6, 0.25, 0.9]} m={MAT.stainless} />
    </group>
  );
}

/** Enclosed spray booth with a glass hood and optional extraction duct and fan. */
function SprayBooth({ x, l = 2.4, duct = true }: { x: number; l?: number; duct?: boolean }) {
  return (
    <group position={[x, 0, LINE_Z]}>
      <Box p={[0, 1, 0]} s={[l, 2, 2.2]} m={MAT.machine} />
      <Box p={[0, 2.3, 0]} s={[l * 0.9, 0.6, 1.6]} m={MAT.glass} cast={false} />
      {duct && (
        <>
          <Cyl p={[0, 4.2, -0.4]} r={0.28} h={3.4} m={MAT.galvanised} seg={12} />
          <Motor p={[0, 2.8, -0.9]} r={0.22} l={0.5} />
        </>
      )}
    </group>
  );
}

const GLAZE_PREP_X = [33, 38, 43, 48, 53, 58];

/** Glazing line, digital inkjet decorator and the glaze preparation area behind them. */
export function Glazing() {
  const pipeRackPosts = useMemo(
    () =>
      Array.from(
        { length: 8 },
        (_, i): Instance => ({
          p: [31 + i * 5, 2.5, -20],
          s: [0.25, 5, 0.25],
        }),
      ),
    [],
  );
  return (
    <group>
      <Selectable id="G-LINE">
        <group position={[31, 0, LINE_Z]}>
          <Box p={[0, 1.4, 0]} s={[1.8, 1, 2.2]} m={MAT.machineBlue} />
          <Cyl p={[0, 1.1, 0]} r={0.25} h={2} m={MAT.rubber} rot={[Math.PI / 2, 0, 0]} />
        </group>
        <SprayBooth x={34.6} l={2} duct={false} />
        <GlazeBell x={38.8} />
        <GlazeBell x={43.4} />
        <SprayBooth x={48.2} l={3} />
        <BlobShadow p={[40, LINE_Z]} w={22} d={6} />
      </Selectable>
      <Selectable id="G-INK">
        <group position={[56.5, 0, LINE_Z]}>
          <Box p={[0, 0.5, 0]} s={[7.2, 1, 3.2]} m={MAT.machineDark} />
          <Box p={[0, 1.75, 0]} s={[7, 1.5, 3]} m={MAT.machine} />
          <Box p={[0, 1.8, 1.52]} s={[5.6, 0.5, 0.04]} m={MAT.screen} cast={false} />
          <Box p={[0, 2.75, 0]} s={[6.8, 0.5, 2.6]} m={MAT.machineBlue} />
          {[-2.4, -0.8, 0.8, 2.4].map((x) => (
            <Box key={x} p={[x, 0.9, -2.2]} s={[1.2, 1.8, 0.8]} m={MAT.machine} />
          ))}
          <ControlCabinet p={[4.6, 0, 1.6]} w={1.2} rot={-Math.PI / 2} />
        </group>
        <SprayBooth x={64.5} l={2.6} />
        <BlobShadow p={[58, LINE_Z]} w={16} d={7} />
      </Selectable>
      <Selectable id="G-PREP">
        {GLAZE_PREP_X.map((x) => (
          <group key={x} position={[x, 0, -26]}>
            <Box p={[0, 0.5, 0]} s={[2.6, 1, 2.6]} m={MAT.steel} />
            <Tank p={[0, 1, 0]} r={1.15} h={1.8} />
          </group>
        ))}
        <group position={[66, 0, -25.5]}>
          <Cyl p={[0, 1.8, 0]} r={1.1} h={3.6} m={MAT.machine} rot={ROT_Z90} />
          {[-1.9, 1.9].map((x) => (
            <Box key={x} p={[x, 0.9, 0]} s={[0.6, 1.8, 2]} m={MAT.concreteWall} />
          ))}
          <Motor p={[2.8, 1, 0]} />
        </group>
        <Instances items={pipeRackPosts} m={MAT.steel} />
        <Box p={[48.5, 5.1, -20]} s={[36, 0.3, 1]} m={MAT.steel} />
        <PipeRun
          pts={[
            [31, 5.4, -19.8],
            [66, 5.4, -19.8],
          ]}
          r={0.09}
          m={MAT.pipeBlue}
        />
        <PipeRun
          pts={[
            [31, 5.6, -20.2],
            [66, 5.6, -20.2],
          ]}
          r={0.09}
          m={MAT.pipeGrey}
        />
        {[38.8, 43.4, 48.2, 64.5].map((x) => (
          <PipeRun
            key={x}
            pts={[
              [x, 5.4, -19.8],
              [x, 5.4, -13.5],
              [x, 4.4, -13.5],
            ]}
            r={0.06}
            m={MAT.pipeBlue}
          />
        ))}
        {GLAZE_PREP_X.map((x) => (
          <PipeRun
            key={'v' + x}
            pts={[
              [x, 3.2, -24.8],
              [x, 5.4, -20.2],
            ]}
            r={0.06}
            m={MAT.pipeGrey}
          />
        ))}
        <BlobShadow p={[48, -25.5]} w={40} d={6} />
      </Selectable>
    </group>
  );
}
