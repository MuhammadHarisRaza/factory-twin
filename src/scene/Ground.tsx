import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import { Color, MeshStandardMaterial, type CanvasTexture, type Material } from 'three';
import {
  HALL,
  LINK,
  PARKING,
  PAVED,
  RAW_SHED,
  ROADS,
  SITE,
  SPRAY_TOWER,
  WAREHOUSE,
  WORKSHOP,
  ZONES,
} from '../data/layout';
import type { Rect } from '../data/types';
import { useTwin } from '../store';
import { MAT, asphaltTexture, concreteTexture, floorTexture, grassTexture } from './materials';
import { Instances, type Instance } from './primitives';

const centerX = (r: Rect) => (r.x[0] + r.x[1]) / 2;
const centerZ = (r: Rect) => (r.z[0] + r.z[1]) / 2;
const width = (r: Rect) => r.x[1] - r.x[0];
const depth = (r: Rect) => r.z[1] - r.z[0];

/** Flat textured rectangle on the ground at height `y`. */
function Slab({ r, mat, y = 0.02 }: { r: Rect; mat: Material; y?: number }) {
  return (
    <mesh material={mat} position={[centerX(r), y, centerZ(r)]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[width(r), depth(r)]} />
    </mesh>
  );
}

const textureCache = new Map<() => CanvasTexture, CanvasTexture>();

/**
 * Surface material whose texture repeats every `tile` metres over the rect. The canvas
 * is drawn once per texture kind; each surface gets a clone that shares the image.
 */
function surfaceMaterial(texture: () => CanvasTexture, r: Rect, tile: number, color = '#ffffff', roughness = 0.85) {
  let base = textureCache.get(texture);
  if (!base) {
    base = texture();
    textureCache.set(texture, base);
  }
  const map = base.clone();
  map.repeat.set(width(r) / tile, depth(r) / tile);
  // Offset each slab so joints and stains don't line up between buildings.
  map.offset.set((r.x[0] * 0.037) % 1, (r.z[0] * 0.053) % 1);
  return new MeshStandardMaterial({ map, color, roughness, metalness: 0.02 });
}

/** Dashed road centre lines and parking-bay lines. */
function RoadMarkings() {
  const items = useMemo(() => {
    const out: Instance[] = [];
    for (const road of ROADS) {
      const alongX = width(road) > depth(road);
      const len = alongX ? width(road) : depth(road);
      for (let d = 3; d < len - 3; d += 9) {
        out.push(
          alongX
            ? { p: [road.x[0] + d, 0.06, centerZ(road)], s: [4, 0.02, 0.18] }
            : { p: [centerX(road), 0.06, road.z[0] + d], s: [0.18, 0.02, 4] },
        );
      }
    }
    for (let z = PARKING.z[0] + 2; z <= PARKING.z[1] - 2; z += 2.6) {
      out.push({ p: [PARKING.x[0] + 3, 0.06, z], s: [5, 0.02, 0.12] });
      out.push({ p: [PARKING.x[1] - 3, 0.06, z], s: [5, 0.02, 0.12] });
    }
    return out;
  }, []);
  return <Instances items={items} m={MAT.markingWhite} cast={false} />;
}

/** Yellow aisle lines and green pedestrian walkways on the factory floors. */
function FloorMarkings() {
  const lines = useMemo<Instance[]>(
    () => [
      { p: [0, 0.05, -3.6], s: [150, 0.02, 0.15] },
      { p: [0, 0.05, 3.6], s: [150, 0.02, 0.15] },
      { p: [-88, 0.05, 30], s: [14, 0.02, 0.15] },
      { p: [-110, 0.05, 45.5], s: [42, 0.02, 0.15] },
      // Warehouse dock lanes
      ...[-126, -119, -112, -105, -98, -91].flatMap((x): Instance[] => [
        { p: [x - 1.6, 0.05, 52], s: [0.12, 0.02, 12] },
        { p: [x + 1.6, 0.05, 52], s: [0.12, 0.02, 12] },
      ]),
    ],
    [],
  );
  const walkways = useMemo<Instance[]>(
    () => [
      { p: [0, 0.045, 5.2], s: [150, 0.015, 1.2] },
      { p: [-74.4, 0.045, 0], s: [1.2, 0.015, 58] },
      { p: [74.4, 0.045, 0], s: [1.2, 0.015, 58] },
    ],
    [],
  );
  return (
    <>
      <Instances items={lines} m={MAT.marking} cast={false} />
      <Instances items={walkways} m={MAT.greenWalk} cast={false} />
    </>
  );
}

/** Static tint and outline over the rects of the currently selected zone. */
function ZoneHighlight() {
  const zoneId = useTwin((s) => s.zone);
  const zone = ZONES.find((z) => z.id === zoneId);
  if (!zone) return null;
  return (
    <group>
      {zone.rects.map((r, i) => (
        <group key={i}>
          <mesh position={[centerX(r), 0.08, centerZ(r)]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[width(r), depth(r)]} />
            <meshBasicMaterial color={zone.color} transparent opacity={0.16} depthWrite={false} />
          </mesh>
          <Line
            points={[
              [r.x[0], 0.12, r.z[0]],
              [r.x[1], 0.12, r.z[0]],
              [r.x[1], 0.12, r.z[1]],
              [r.x[0], 0.12, r.z[1]],
              [r.x[0], 0.12, r.z[0]],
            ]}
            color={zone.color}
            lineWidth={2.5}
          />
        </group>
      ))}
    </group>
  );
}

/** Thin floor outlines of every zone in its colour; part of the labels layer. */
function ZoneBoundaries() {
  const visible = useTwin((s) => s.layers.labels);
  const { points, colors } = useMemo(() => {
    const pts: [number, number, number][] = [];
    const cols: [number, number, number][] = [];
    const c = new Color();
    for (const zone of ZONES) {
      c.set(zone.color);
      for (const r of zone.rects) {
        const corners: [number, number][] = [
          [r.x[0], r.z[0]],
          [r.x[1], r.z[0]],
          [r.x[1], r.z[1]],
          [r.x[0], r.z[1]],
        ];
        for (let i = 0; i < 4; i++) {
          const [ax, az] = corners[i];
          const [bx, bz] = corners[(i + 1) % 4];
          pts.push([ax, 0.07, az], [bx, 0.07, bz]);
          cols.push([c.r, c.g, c.b], [c.r, c.g, c.b]);
        }
      }
    }
    return { points: pts, colors: cols };
  }, []);
  if (!visible) return null;
  return <Line points={points} vertexColors={colors} segments lineWidth={1.2} transparent opacity={0.55} />;
}

/** Grass, hardstanding, roads, parking, building floors, markings and the zone highlight. */
export function Ground() {
  const mats = useMemo(
    () => ({
      ground: new MeshStandardMaterial({
        map: (() => {
          const tex = grassTexture();
          tex.repeat.set(60, 60);
          return tex;
        })(),
        roughness: 1,
      }),
      floors: [HALL.rect, RAW_SHED.rect, WAREHOUSE.rect, WORKSHOP.rect, SPRAY_TOWER.rect, LINK.rect].map((r) => ({
        r,
        // Sealed interior floors: slightly smoother so overhead light picks up a soft sheen.
        m: surfaceMaterial(floorTexture, r, 24, '#ffffff', 0.62),
      })),
      paved: PAVED.map((r) => ({ r, m: surfaceMaterial(concreteTexture, r, 12, '#cfcfcb', 0.95) })),
      roads: ROADS.map((r) => ({ r, m: surfaceMaterial(asphaltTexture, r, 8) })),
      park: surfaceMaterial(asphaltTexture, PARKING, 8, '#bdbdbd'),
    }),
    [],
  );
  return (
    <group>
      <mesh
        material={mats.ground}
        position={[centerX(SITE), -0.02, centerZ(SITE)]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[900, 900]} />
      </mesh>
      {mats.paved.map((s, i) => (
        <Slab key={i} r={s.r} mat={s.m} y={0.01} />
      ))}
      {mats.roads.map((s, i) => (
        <Slab key={i} r={s.r} mat={s.m} y={0.03} />
      ))}
      <Slab r={PARKING} mat={mats.park} y={0.02} />
      {mats.floors.map((s, i) => (
        <Slab key={i} r={s.r} mat={s.m} y={0.04} />
      ))}
      <RoadMarkings />
      <FloorMarkings />
      <ZoneBoundaries />
      <ZoneHighlight />
    </group>
  );
}
