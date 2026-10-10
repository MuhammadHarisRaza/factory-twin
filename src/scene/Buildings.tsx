import { useMemo } from 'react';
import { Shape, ShapeGeometry } from 'three';
import { LINK, SPRAY_TOWER } from '../data/layout';
import type { Range, Vec3 } from '../data/types';
import { useTwin } from '../store';
import { BUILDING_FRAMES, type BuildingFrame, type WallMode } from './buildings/frames';
import { MAT } from './materials';
import { Box, Door, Instances, type Instance } from './primitives';

/** Doors in the building envelopes. */
const DOORS: { p: Vec3; w: number; h: number; rot: number; open?: boolean }[] = [
  { p: [-76, 0, -8], w: 4, h: 5, rot: Math.PI / 2, open: true },
  { p: [-76, 0, 19], w: 6, h: 5.5, rot: Math.PI / 2, open: true },
  { p: [-62, 0, -30], w: 5, h: 5, rot: 0 },
  { p: [6, 0, -30], w: 5, h: 5, rot: 0 },
  { p: [76, 0, 10], w: 5, h: 5, rot: Math.PI / 2, open: true },
  { p: [-80, 0, -8], w: 4, h: 5, rot: Math.PI / 2, open: true },
  // Warehouse loading docks
  ...[-126, -119, -112, -105, -98, -91].map((x) => ({
    p: [x, 0, 60] as Vec3,
    w: 3.2,
    h: 4.2,
    rot: 0,
    open: x === -112 || x === -98,
  })),
  { p: [-80, 0, 19], w: 6, h: 5.5, rot: Math.PI / 2, open: true },
  { p: [79, 0, 10], w: 5, h: 5, rot: Math.PI / 2, open: true },
];

/** Vertical cladding pilasters, eave trim and seams for one wall face, instanced. */
function wallTrim(
  axis: 'x' | 'z',
  at: number,
  from: number,
  to: number,
  posts: number[],
  h: number,
  outward: number,
  full: boolean,
): Instance[] {
  const out: Instance[] = [];
  const face = at + outward * 0.13;
  const along = (c: number, y: number, len: number, hh: number, t: number): Instance =>
    axis === 'x' ? { p: [c, y, face], s: [len, hh, t] } : { p: [face, y, c], s: [t, hh, len] };
  for (const c of posts) if (c > from + 0.5 && c < to - 0.5) out.push(along(c, 1.2 + (h - 1.2) / 2, 0.36, h - 1.2, 0.1));
  // Horizontal panel seams.
  for (let y = 3.6; y < h - 1; y += 2.4) out.push(along((from + to) / 2, y, to - from, 0.05, 0.05));
  if (full) out.push(along((from + to) / 2, h - 0.25, to - from + 0.3, 0.5, 0.16));
  return out;
}

/** Long wall running along x at `z`: plinth, cladding, window band (full) or capping (cut). */
function WallX({
  z,
  x0,
  x1,
  mode,
  eave,
  cutH,
  outward,
  posts,
}: {
  z: number;
  x0: number;
  x1: number;
  mode: WallMode;
  eave: number;
  cutH: number;
  /** -1 or 1: which side of the wall faces outside. */
  outward: number;
  /** X positions of the portal frames (pilasters). */
  posts: number[];
}) {
  const full = mode === 'full';
  const h = full ? eave : cutH;
  const trim = useMemo(() => wallTrim('x', z, x0, x1, posts, h, outward, full), [z, x0, x1, posts, h, outward, full]);
  if (mode === 'open') return null;
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  return (
    <group>
      <Box p={[cx, 0.6, z]} s={[len, 1.2, 0.3]} m={MAT.plinth} />
      <Box p={[cx, 1.2 + (h - 1.2) / 2, z]} s={[len, h - 1.2, 0.18]} m={MAT.cladding} />
      {full && <Box p={[cx, eave - 2.6, z + outward * 0.12]} s={[len - 1, 1.4, 0.06]} m={MAT.glass} cast={false} />}
      {full && <Box p={[cx, 1.25, z + outward * 0.1]} s={[len, 0.1, 0.06]} m={MAT.claddingDark} cast={false} />}
      {!full && <Box p={[cx, h + 0.05, z]} s={[len, 0.1, 0.3]} m={MAT.claddingDark} cast={false} />}
      <Instances items={trim} m={MAT.claddingDark} cast={false} />
    </group>
  );
}

/** Gable-end wall running along z at `x`, with triangular gable infills when full height. */
function WallZ({
  x,
  z0,
  z1,
  mode,
  eave,
  cutH,
  spans,
  rise,
  outward,
}: {
  x: number;
  z0: number;
  z1: number;
  mode: WallMode;
  eave: number;
  cutH: number;
  spans: Range[];
  rise: number;
  outward: number;
}) {
  const gables = useMemo(
    () =>
      spans.map(([a, b]) => {
        const shape = new Shape();
        shape.moveTo(a, 0);
        shape.lineTo(b, 0);
        shape.lineTo((a + b) / 2, rise);
        shape.closePath();
        return new ShapeGeometry(shape);
      }),
    [spans, rise],
  );
  const full = mode === 'full';
  const h = full ? eave : cutH;
  // Gable posts: at span edges and mid-span (under the ridge).
  const posts = useMemo(() => spans.flatMap(([a, b]) => [a, (a + b) / 2, b]), [spans]);
  const trim = useMemo(() => wallTrim('z', x, z0, z1, posts, h, outward, full), [x, z0, z1, posts, h, outward, full]);
  if (mode === 'open') return null;
  const len = z1 - z0;
  const cz = (z0 + z1) / 2;
  return (
    <group>
      <Box p={[x, 0.6, cz]} s={[0.3, 1.2, len]} m={MAT.plinth} />
      <Box p={[x, 1.2 + (h - 1.2) / 2, cz]} s={[0.18, h - 1.2, len]} m={MAT.cladding} />
      {full && <Box p={[x + outward * 0.12, eave - 2.6, cz]} s={[0.06, 1.4, len - 1]} m={MAT.glass} cast={false} />}
      {full &&
        gables.map((geo, i) => (
          <mesh
            key={i}
            geometry={geo}
            material={MAT.cladding}
            position={[x, eave, 0]}
            rotation={[0, -Math.PI / 2, 0]}
            castShadow
            receiveShadow
          />
        ))}
      {!full && <Box p={[x, h + 0.05, cz]} s={[0.3, 0.1, len]} m={MAT.claddingDark} cast={false} />}
      <Instances items={trim} m={MAT.claddingDark} cast={false} />
    </group>
  );
}

/** The four walls of one portal-framed building (cut-away on the sides facing the viewer). */
function BuildingWalls({ b }: { b: BuildingFrame }) {
  const { x, z } = b.rect;
  const mode = (m: WallMode) => m;
  return (
    <group>
      <WallX z={z[0]} x0={x[0]} x1={x[1]} mode={mode(b.walls.n)} eave={b.eave} cutH={b.cutH} outward={-1} posts={b.frames} />
      <WallX z={z[1]} x0={x[0]} x1={x[1]} mode={mode(b.walls.s)} eave={b.eave} cutH={b.cutH} outward={1} posts={b.frames} />
      <WallZ
        x={x[0]}
        z0={z[0]}
        z1={z[1]}
        mode={mode(b.walls.w)}
        eave={b.eave}
        cutH={b.cutH}
        spans={b.spans}
        rise={b.rise}
        outward={-1}
      />
      <WallZ
        x={x[1]}
        z0={z[0]}
        z1={z[1]}
        mode={mode(b.walls.e)}
        eave={b.eave}
        cutH={b.cutH}
        spans={b.spans}
        rise={b.rise}
        outward={1}
      />
    </group>
  );
}

/** Duo-pitch roof per span with two skylight strips per slope and a ridge vent. */
function BuildingRoof({ b }: { b: BuildingFrame }) {
  const { x } = b.rect;
  const width = x[1] - x[0];
  const cx = (x[0] + x[1]) / 2;
  return (
    <group>
      {b.spans.map(([z0, z1], i) => {
        const half = (z1 - z0) / 2;
        const ridgeZ = (z0 + z1) / 2;
        const slope = Math.hypot(half, b.rise);
        const pitch = Math.atan2(b.rise, half);
        return (
          <group key={i}>
            {[-1, 1].map((side) => {
              const z = side < 0 ? (z0 + ridgeZ) / 2 : (ridgeZ + z1) / 2;
              const tilt = side < 0 ? -pitch : pitch;
              return (
                <group key={side} position={[cx, b.eave + b.rise / 2 + 0.25, z]} rotation={[tilt, 0, 0]}>
                  <Box p={[0, 0, 0]} s={[width + 1, 0.14, slope + 0.5]} m={MAT.roof} />
                  {[-0.22, 0.22].map((f) => (
                    <Box key={f} p={[0, 0.09, f * slope]} s={[width - 4, 0.04, 1.4]} m={MAT.skylight} cast={false} />
                  ))}
                </group>
              );
            })}
            <Box p={[cx, b.eave + b.rise + 0.45, ridgeZ]} s={[width - 6, 0.5, 1.2]} m={MAT.claddingDark} />
          </group>
        );
      })}
      {/* Eave and valley gutters along every column line. */}
      {[...new Set(b.spans.flat())].map((z) => (
        <Box key={'g' + z} p={[cx, b.eave + 0.2, z]} s={[width + 1.2, 0.35, 0.45]} m={MAT.claddingDark} cast={false} />
      ))}
    </group>
  );
}

/** Partial cladding (north and west faces) and roof of the spray-dryer tower structure. */
function SprayTowerCladding() {
  const { x, z } = SPRAY_TOWER.rect;
  const h = SPRAY_TOWER.height;
  return (
    <group>
      <Box p={[(x[0] + x[1]) / 2, h / 2 + 6, z[0]]} s={[x[1] - x[0], h - 12, 0.18]} m={MAT.cladding} />
      <Box p={[x[0], h / 2 + 6, (z[0] + z[1]) / 2]} s={[0.18, h - 12, z[1] - z[0]]} m={MAT.cladding} />
      <Box
        p={[(x[0] + x[1]) / 2, h + 0.1, (z[0] + z[1]) / 2]}
        s={[x[1] - x[0] + 0.4, 0.2, z[1] - z[0] + 0.4]}
        m={MAT.roof}
      />
    </group>
  );
}

/** Building envelopes: walls and doors (walls layer), roofs (roof layer) and the hall–warehouse link. */
export function Buildings() {
  const wallsOn = useTwin((s) => s.layers.walls);
  const roofOn = useTwin((s) => s.layers.roof);
  return (
    <group>
      <group visible={wallsOn}>
        {BUILDING_FRAMES.map((b) => (
          <BuildingWalls key={b.id} b={b} />
        ))}
        {DOORS.map((d, i) => (
          <Door key={i} p={d.p} w={d.w} h={d.h} rot={d.rot} open={d.open} />
        ))}
        <SprayTowerCladding />
        <Box
          p={[(LINK.rect.x[0] + LINK.rect.x[1]) / 2, LINK.eave / 2, LINK.rect.z[0]]}
          s={[4, LINK.eave, 0.18]}
          m={MAT.cladding}
        />
      </group>
      <group visible={roofOn}>
        {BUILDING_FRAMES.map((b) => (
          <BuildingRoof key={b.id} b={b} />
        ))}
      </group>
      {/* Link roof stays visible regardless of the roof layer. */}
      <Box
        p={[(LINK.rect.x[0] + LINK.rect.x[1]) / 2, LINK.eave, (LINK.rect.z[0] + LINK.rect.z[1]) / 2]}
        s={[4.6, 0.2, LINK.rect.z[1] - LINK.rect.z[0]]}
        m={MAT.roof}
      />
    </group>
  );
}
