import { useMemo } from 'react';
import type { Vec3 } from '../data/types';
import { useTwin } from '../store';
import { Instances, Pipe, type Instance } from './primitives';
import { MAT } from './materials';
import { Selectable } from './Selectable';
import { PRESS_X } from './zones/PressingDrying';

type ConveyorDef = {
  /** Centre-line polyline at belt height. */
  pts: Vec3[];
  /** Belt / roller width. */
  w: number;
  kind: 'belt' | 'roller';
  /** Equipment id when this conveyor is selectable on its own. */
  select?: string;
};

/** Builds instanced side rails, belt surfaces, rollers and legs for a set of conveyors. */
function buildConveyors(defs: ConveyorDef[]) {
  const rails: Instance[] = [];
  const belts: Instance[] = [];
  const rollers: Instance[] = [];
  const legs: Instance[] = [];
  for (const def of defs)
    for (let i = 0; i < def.pts.length - 1; i++) {
      const [x0, y0, z0] = def.pts[i];
      const [x1, y1, z1] = def.pts[i + 1];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      const run = Math.hypot(dx, dz);
      const len = Math.hypot(run, dy);
      const yaw = -Math.atan2(dz, dx);
      const pitch = Math.atan2(dy, run);
      // Horizontal unit normal (perpendicular to the run direction).
      const ux = dx / run;
      const nx = -(dz / run);
      const nz = ux;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const mz = (z0 + z1) / 2;
      for (const side of [-1, 1])
        rails.push({
          p: [mx + nx * side * (def.w / 2 + 0.05), my - 0.08, mz + nz * side * (def.w / 2 + 0.05)],
          s: [len + 0.1, 0.22, 0.07],
          r: [0, yaw, pitch],
        });
      if (def.kind === 'belt') belts.push({ p: [mx, my - 0.02, mz], s: [len + 0.1, 0.06, def.w], r: [0, yaw, pitch] });
      else {
        const count = Math.floor(len / 0.42);
        for (let j = 0; j <= count; j++) {
          const f = j / Math.max(1, count);
          rollers.push({
            p: [x0 + dx * f, y0 + dy * f - 0.03, z0 + dz * f],
            s: [0.05, def.w, 0.05],
            r: [Math.PI / 2, yaw, pitch],
            o: 'YZX',
          });
        }
      }
      const spans = Math.max(1, Math.round(run / 2.6));
      for (let j = 0; j <= spans; j++) {
        const f = j / spans;
        const lx = x0 + dx * f;
        const lz = z0 + dz * f;
        const legH = y0 + dy * f - 0.2;
        if (legH < 0.2) continue;
        for (const side of [-1, 1])
          legs.push({
            p: [lx + nx * side * (def.w / 2), legH / 2, lz + nz * side * (def.w / 2)],
            s: [0.08, legH, 0.08],
          });
      }
    }
  return { rails, belts, rollers, legs };
}

/** A set of conveyors drawn with four instanced meshes. */
function ConveyorSet({ defs }: { defs: ConveyorDef[] }) {
  const parts = useMemo(() => buildConveyors(defs), [defs]);
  return (
    <>
      <Instances items={parts.rails} m={MAT.machineBlue} />
      <Instances items={parts.belts} m={MAT.belt} cast={false} />
      <Instances items={parts.rollers} m={MAT.roller} cyl cast={false} />
      <Instances items={parts.legs} m={MAT.steel} cast={false} />
    </>
  );
}

const CONVEYORS: ConveyorDef[] = [
  {
    pts: [
      [-114, 1.1, -8],
      [-82, 1.1, -8],
      [-72.2, 3.4, -8],
    ],
    w: 1,
    kind: 'belt',
  },
  {
    pts: [
      [-68.6, 1.6, -8],
      [-64.5, 5.6, -8],
      [-64.5, 5.6, -27],
    ],
    w: 0.8,
    kind: 'belt',
  },
  {
    pts: [
      [-35, 1.1, -40],
      [-35, 1.1, -30.2],
    ],
    w: 0.8,
    kind: 'belt',
  },
  {
    pts: [
      [-35, 14.6, -28.4],
      [-35, 14.6, -20.5],
    ],
    w: 0.8,
    kind: 'belt',
  },
  {
    pts: [
      [-43, 14.6, -20.5],
      [-27, 14.6, -20.5],
    ],
    w: 0.8,
    kind: 'belt',
  },
  {
    pts: [
      [-43, 1.1, -20.5],
      [-26.2, 1.1, -20.5],
      [-26.2, 1.1, -22.6],
    ],
    w: 0.8,
    kind: 'belt',
  },
  {
    pts: [
      [-25, 10.4, -22.6],
      [-1.5, 10.4, -22.6],
    ],
    w: 0.8,
    kind: 'belt',
    select: 'D-BELT',
  },
  ...PRESS_X.map(
    (x): ConveyorDef => ({
      pts: [
        [x, 1, -18.2],
        [x, 1, -12.6],
      ],
      w: 1.4,
      kind: 'roller',
    }),
  ),
  {
    pts: [
      [-20.5, 1, -12],
      [1, 1, -12],
    ],
    w: 1.6,
    kind: 'roller',
    select: 'E-COL',
  },
  {
    pts: [
      [24.6, 1, -12],
      [28, 1, -12],
    ],
    w: 1.6,
    kind: 'roller',
  },
  {
    pts: [
      [26.5, 1, -12.8],
      [26.5, 1, -18.6],
    ],
    w: 1.4,
    kind: 'roller',
  },
  {
    pts: [
      [28, 1, -12],
      [71, 1, -12],
    ],
    w: 1.6,
    kind: 'belt',
  },
  {
    pts: [
      [71, 1, -12],
      [73.5, 1, -12],
      [73.5, 1, 15],
      [70.5, 1, 15],
    ],
    w: 1.6,
    kind: 'roller',
  },
  {
    pts: [
      [-4.5, 1, 15],
      [-38.5, 1, 15],
    ],
    w: 1.6,
    kind: 'roller',
  },
  ...[-24.5, -28, -31.5].map(
    (x): ConveyorDef => ({
      pts: [
        [x, 1, 15.8],
        [x, 1, 20.9],
      ],
      w: 1.2,
      kind: 'roller',
    }),
  ),
  {
    pts: [
      [-22.5, 1, 14.2],
      [-22.5, 1, 9.2],
    ],
    w: 1.2,
    kind: 'roller',
  },
  {
    pts: [
      [-34.5, 1, 14.2],
      [-34.5, 1, 11.6],
    ],
    w: 1.4,
    kind: 'roller',
  },
  {
    pts: [
      [-38.5, 1.1, 15],
      [-61, 1.1, 15],
    ],
    w: 1.2,
    kind: 'belt',
  },
  {
    pts: [
      [-63.5, 0.5, 18.6],
      [-63.5, 0.5, 20],
      [-86, 0.5, 20],
    ],
    w: 1.4,
    kind: 'roller',
  },
];

/** Conveyors without an equipment id, merged into one instanced set. */
const PLAIN_CONVEYORS = CONVEYORS.filter((c) => !c.select);
/** Conveyors that are individually selectable. */
const SELECTABLE_CONVEYORS = CONVEYORS.filter((c) => c.select);

/** Every belt and roller conveyor in the plant (toggled by the conveyors layer). */
export function Conveyors() {
  const visible = useTwin((s) => s.layers.conveyors);
  return (
    <group visible={visible}>
      <ConveyorSet defs={PLAIN_CONVEYORS} />
      {SELECTABLE_CONVEYORS.map((c) => (
        <Selectable key={c.select} id={c.select!} layer="conveyors">
          <ConveyorSet defs={[c]} />
          {c.select === 'D-BELT' &&
            PRESS_X.map((x) => <Pipe key={x} a={[x, 10.2, -22.6]} b={[x, 7.9, -22.6]} r={0.22} m={MAT.galvanised} />)}
        </Selectable>
      ))}
    </group>
  );
}
