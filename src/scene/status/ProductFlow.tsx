/**
 * Product moving along the main conveyors — green tiles from the presses over the collector
 * into the dryer and along the glaze line to the kiln, fired tiles from the kiln exit through
 * inspection and sorting to packing. One InstancedMesh per conveyor segment; items are
 * emitted at a rate proportional to the live output of the machine feeding the segment and
 * travel with its belt, which stands still while that machine is down, starved or blocked
 * (or the simulation is paused). Tiles diverted onto the sorter's reject branch are tinted
 * red while a quality exception is active ("affected products").
 */
import { memo, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { InstancedMesh, MeshStandardMaterial, Object3D, type Material } from 'three';
import type { Vec3 } from '../../data/types';
import { useSim, useSimValue } from '../../sim/store';
import { useTwin } from '../../store';
import { MAT, UNIT_BOX } from '../materials';
import { PRESS_X } from '../zones/PressingDrying';
import { createBelt, groupFlow, pointAt, polyline, seedBelt, sharedQualityStatus, stepBelt, type PolylinePoint } from './model';

type Item = 'tile' | 'stack' | 'carton';

const ITEM: Record<Item, { size: Vec3; spacing: number; gap: number }> = {
  // Slightly smaller than the static product modelled on the belts, so the two never z-fight.
  tile: { size: [0.58, 0.024, 0.58], spacing: 1.25, gap: 0.75 },
  stack: { size: [0.58, 0.3, 0.58], spacing: 1.8, gap: 0.9 },
  carton: { size: [0.88, 0.34, 0.58], spacing: 1.5, gap: 1.1 },
};

/** Belt speed at full rate (m/s, visual — independent of the demo speed). */
const V0 = 0.8;
/** Visual gain on the reject share so the baseline (~2.5 %) still shows the occasional tile. */
const REJECT_GAIN = 5;

const REJECT_MATERIAL = new MeshStandardMaterial({ color: '#c4524a', emissive: '#4a120e', roughness: 0.45, metalness: 0.05 });

type Segment = {
  key: string;
  pts: Vec3[];
  item: Item;
  material: Material;
  /** Machines whose output feeds the segment. */
  feed: string[];
  /** Share of the feed travelling on this segment (grade branches). */
  share?: number;
  /** The sorter's reject branch. */
  reject?: boolean;
};

const TILE_Y = 1.04;
const BELT_TILE_Y = 1.03;

const SEGMENTS: Segment[] = [
  // Press outfeed roller tables onto the collector.
  ...PRESS_X.map(
    (x, i): Segment => ({
      key: `press-${i + 1}`,
      pts: [
        [x, TILE_Y, -17.9],
        [x, TILE_Y, -12.7],
      ],
      item: 'tile',
      material: MAT.greenTile,
      feed: [`E-PRS${i + 1}`],
    }),
  ),
  {
    key: 'collector',
    pts: [
      [-18, TILE_Y, -12],
      [0.6, TILE_Y, -12],
    ],
    item: 'tile',
    material: MAT.greenTile,
    feed: ['E-PRS1', 'E-PRS2', 'E-PRS3'],
  },
  {
    key: 'dryer-exit',
    pts: [
      [24.8, TILE_Y, -12],
      [27.9, TILE_Y, -12],
    ],
    item: 'tile',
    material: MAT.greenTile,
    feed: ['F-DRY'],
  },
  {
    key: 'glaze-in',
    pts: [
      [28.3, BELT_TILE_Y, -12],
      [38.4, BELT_TILE_Y, -12],
    ],
    item: 'tile',
    material: MAT.greenTile,
    feed: ['G-LINE'],
  },
  {
    key: 'glaze-out',
    pts: [
      [38.6, BELT_TILE_Y, -12],
      [51.4, BELT_TILE_Y, -12],
    ],
    item: 'tile',
    material: MAT.glazedTile,
    feed: ['G-LINE'],
  },
  {
    key: 'decoration-out',
    pts: [
      [59.8, BELT_TILE_Y, -12],
      [70.9, BELT_TILE_Y, -12],
    ],
    item: 'tile',
    material: MAT.glazedTile,
    feed: ['G-INK'],
  },
  {
    key: 'kiln-infeed',
    pts: [
      [71.2, TILE_Y, -12],
      [73.5, TILE_Y, -12],
      [73.5, TILE_Y, 15],
      [70.8, TILE_Y, 15],
    ],
    item: 'tile',
    material: MAT.glazedTile,
    feed: ['G-INK'],
  },
  // Kiln exit → planarity gauge → vision tunnel → grade marking → diverters.
  {
    key: 'sorting',
    pts: [
      [-4.8, TILE_Y, 15],
      [-22.5, TILE_Y, 15],
    ],
    item: 'tile',
    material: MAT.glazedTile,
    feed: ['I-SORT'],
  },
  {
    key: 'reject',
    pts: [
      [-22.5, TILE_Y, 14.0],
      [-22.5, TILE_Y, 9.4],
    ],
    item: 'tile',
    material: MAT.glazedTile,
    feed: ['I-SORT'],
    reject: true,
  },
  {
    key: 'sorted',
    pts: [
      [-22.7, TILE_Y, 15],
      [-38.3, TILE_Y, 15],
    ],
    item: 'tile',
    material: MAT.glazedTile,
    feed: ['I-SORT'],
  },
  ...[-24.5, -28, -31.5].map(
    (x, i): Segment => ({
      key: `grade-${i + 1}`,
      pts: [
        [x, TILE_Y, 15.9],
        [x, TILE_Y, 20.8],
      ],
      item: 'tile',
      material: MAT.glazedTile,
      feed: ['I-SORT'],
      share: 0.14,
    }),
  ),
  // Counted stacks into the carton packer, closed cartons towards the palletiser.
  {
    key: 'stacks',
    pts: [
      [-41.8, 1.265, 15],
      [-45.4, 1.265, 15],
    ],
    item: 'stack',
    material: MAT.glazedTile,
    feed: ['J-BOX'],
  },
  {
    key: 'cartons',
    pts: [
      [-51.2, 1.29, 15],
      [-60.8, 1.29, 15],
    ],
    item: 'carton',
    material: MAT.carton,
    feed: ['J-BOX'],
  },
];

type QualityRef = MutableRefObject<{ rejectRate: number; affected: boolean }>;

const FlowSegment = memo(function FlowSegment({ seg, quality }: { seg: Segment; quality: QualityRef }) {
  const ref = useRef<InstancedMesh>(null);
  const spec = ITEM[seg.item];
  const line = useMemo(() => polyline(seg.pts), [seg]);
  const max = Math.ceil(line.length / spec.gap) + 2;
  const belt = useMemo(() => createBelt(max), [max]);
  const seeded = useRef(false);
  const dummy = useMemo(() => new Object3D(), []);
  const at = useMemo<PolylinePoint>(() => ({ x: 0, y: 0, z: 0, yaw: 0 }), []);

  useFrame((_, frameDt) => {
    const mesh = ref.current;
    if (!mesh || !useTwin.getState().layers.conveyors) return;
    const dt = Math.min(frameDt, 0.1);
    const { sim, running } = useSim.getState();
    const f = groupFlow(sim, seg.feed);
    const q = quality.current;
    const share = seg.reject ? Math.min(1, q.rejectRate * REJECT_GAIN) : (seg.share ?? 1);
    const rate = Math.min(1, f.rate);
    // Belt speed eases with the rate; item spacing carries the rest of the rate change.
    const speed = V0 * (0.6 + 0.4 * rate);

    if (!seeded.current) {
      seeded.current = true;
      const spacing = (spec.spacing / Math.max(0.05, share)) * ((0.6 + 0.4 * rate) / Math.max(0.3, rate));
      seedBelt(belt, line.length, Math.max(spec.gap, spacing), spec.spacing * 0.37);
    }
    const moving = running && f.moving;
    stepBelt(belt, dt, {
      length: line.length,
      targetSpeed: moving ? speed : 0,
      emitPerSec: moving ? (V0 / spec.spacing) * rate * share : 0,
      minGap: spec.gap,
    });

    const [sx, sy, sz] = spec.size;
    for (let i = 0; i < belt.n; i++) {
      const p = belt.pos[i];
      pointAt(line, p, at);
      // Grow in at the start and shrink out at the end instead of popping.
      const k = Math.min(1, Math.max(0.12, Math.min(p, line.length - p) / 0.3));
      dummy.position.set(at.x, at.y, at.z);
      dummy.rotation.set(0, at.yaw, 0);
      dummy.scale.set(sx * k, sy * k, sz * k);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = belt.n;
    mesh.instanceMatrix.needsUpdate = true;
    if (seg.reject) {
      const m = q.affected ? REJECT_MATERIAL : seg.material;
      if (mesh.material !== m) mesh.material = m;
    }
  });

  return <instancedMesh ref={ref} args={[UNIT_BOX, seg.material, max]} frustumCulled={false} receiveShadow />;
});

export function ProductFlow() {
  const visible = useTwin((s) => s.layers.conveyors);
  const q = useSimValue((s) => {
    const st = sharedQualityStatus(s);
    return { rejectRate: st.rate ?? 0, affected: st.exception };
  });
  const quality = useRef(q);
  quality.current = q;
  return (
    <group visible={visible}>
      {SEGMENTS.map((seg) => (
        <FlowSegment key={seg.key} seg={seg} quality={quality} />
      ))}
    </group>
  );
}
