import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { ConeGeometry, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { Line2, LineMaterial } from 'three-stdlib';
import { useTwin } from '../store';
import { FLOW_COLORS, FLOW_PATHS, FLOW_STAGES } from '../data/layout';
import type { FlowPath, Vec2 } from '../data/types';
import type { StageId } from '../model/types';
import { useSim } from '../sim/store';
import { approach, routeFlow, splitRoute } from './status/model';

const ARROW_GEOMETRY = new ConeGeometry(0.6, 1.6, 12);
/** Dash speed (m/s) at full throughput. */
const DASH_SPEED = 4;

/**
 * Process stages whose throughput drives the material flow from a route vertex onwards.
 * A route is split at each listed vertex; `null` marks a part not driven by the line
 * (warehouse and dispatch). Vertices that are not on a route are ignored.
 */
const BREAKPOINTS: { at: Vec2; stages: StageId[] | null }[] = [
  { at: [-129, -28], stages: ['PREP'] },
  { at: [-55, -17.5], stages: ['PREP'] },
  { at: [-50, -34], stages: ['SPRAY'] },
  { at: [-35, -20.5], stages: ['PRESS'] },
  { at: [1, -12], stages: ['DRY'] },
  { at: [25, -12], stages: ['GLAZE', 'DECOR'] },
  { at: [72, -12], stages: ['DECOR'] },
  { at: [70.5, 15], stages: ['KILN'] },
  { at: [-4.5, 15], stages: ['SORT'] },
  { at: [-38.5, 15], stages: ['PACK'] },
  { at: [-61, 15], stages: ['PAL'] },
  { at: [-86, 20], stages: null },
];

type FlowSegment = { points: Vector3[]; stages: StageId[] | null };

const BREAKS = BREAKPOINTS.map((b) => ({ at: b.at, value: b.stages }));

/** Splits a route into segments that each follow one part of the process. */
function segmentsOf({ pts, y }: FlowPath): FlowSegment[] {
  return splitRoute<StageId[] | null>(pts, BREAKS, null).map((r) => ({
    points: pts.slice(r.from, r.to + 1).map(([x, z]) => new Vector3(x, y, z)),
    stages: r.value,
  }));
}

/**
 * One part of a route: the marching dashes run at a speed proportional to the current
 * throughput of the stage(s) it serves — a bottleneck visibly slows its part of the flow,
 * a stopped kiln stops the kiln section, and a paused simulation stops everything.
 */
function FlowDashes({ points, stages, color }: FlowSegment & { color: string }) {
  const dashed = useRef<Line2>(null);
  const flow = useRef<number | null>(null);
  useFrame((_, dt) => {
    const line = dashed.current;
    if (!line) return;
    const { sim, running } = useSim.getState();
    const target = running ? routeFlow(sim, stages) : 0;
    flow.current = flow.current == null ? target : approach(flow.current, target, Math.min(dt, 0.1), 0.6);
    const m = line.material as LineMaterial;
    m.dashOffset -= Math.min(dt, 0.1) * DASH_SPEED * flow.current;
    // A part that is not flowing reads quieter.
    m.opacity = 0.45 + 0.55 * Math.min(1, flow.current / 0.15);
  });
  return (
    <Line
      ref={dashed}
      points={points}
      color={color}
      lineWidth={3}
      dashed
      dashSize={3.2}
      gapSize={1.8}
      transparent
      depthTest={false}
      renderOrder={21}
    />
  );
}

/** One route: soft glow line, throughput-driven marching dashes and direction arrows every 16 m. */
function FlowRoute({ pts, y, kind }: FlowPath) {
  const points = useMemo(() => pts.map(([x, z]) => new Vector3(x, y, z)), [pts, y]);
  const segments = useMemo(() => segmentsOf({ pts, y, kind }), [pts, y, kind]);

  const arrows = useMemo(() => {
    const out: { p: Vector3; q: Quaternion }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const seg = points[i + 1].clone().sub(a);
      const len = seg.length();
      if (len < 4) continue;
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), seg.clone().normalize());
      for (let t = Math.min(6, len / 2); t < len - 1; t += 16) {
        out.push({ p: a.clone().add(seg.clone().multiplyScalar(t / len)), q });
      }
    }
    return out;
  }, [points]);

  const arrowMaterial = useMemo(
    () => new MeshBasicMaterial({ color: FLOW_COLORS[kind], depthTest: false, transparent: true, opacity: 0.95 }),
    [kind],
  );

  return (
    <group>
      <Line
        points={points}
        color={FLOW_COLORS[kind]}
        lineWidth={8}
        transparent
        opacity={0.18}
        depthTest={false}
        renderOrder={20}
      />
      {segments.map((s, i) => (
        <FlowDashes key={i} {...s} color={FLOW_COLORS[kind]} />
      ))}
      {arrows.map((a, i) => (
        <mesh key={i} geometry={ARROW_GEOMETRY} material={arrowMaterial} position={a.p} quaternion={a.q} renderOrder={22} />
      ))}
    </group>
  );
}

/** Flow mode: the intended material route through the plant with numbered stages. */
export function FlowOverlay() {
  const visible = useTwin((s) => s.layers.flow);
  if (!visible) return null;
  return (
    <group>
      {FLOW_PATHS.map((path, i) => (
        <FlowRoute key={i} {...path} />
      ))}
      {FLOW_STAGES.map((stage) => (
        <Html
          key={stage.n}
          position={[stage.at[0], 9, stage.at[1]]}
          center
          zIndexRange={[10, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="flow-stage">
            <b>{stage.n}</b>
            {stage.label}
          </div>
        </Html>
      ))}
    </group>
  );
}
