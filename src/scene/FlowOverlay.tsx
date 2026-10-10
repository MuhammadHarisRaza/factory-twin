import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { ConeGeometry, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { Line2, LineMaterial } from 'three-stdlib';
import { useTwin } from '../store';
import { FLOW_COLORS, FLOW_PATHS, FLOW_STAGES } from '../data/layout';
import type { FlowPath } from '../data/types';

const ARROW_GEOMETRY = new ConeGeometry(0.6, 1.6, 12);

/** One route: soft glow line, marching dashed line and direction arrows every 16 m. */
function FlowRoute({ pts, y, kind }: FlowPath) {
  const dashed = useRef<Line2>(null);
  const points = useMemo(() => pts.map(([x, z]) => new Vector3(x, y, z)), [pts, y]);

  useFrame((_, dt) => {
    if (dashed.current) (dashed.current.material as LineMaterial).dashOffset -= dt * 4;
  });

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
      <Line
        ref={dashed}
        points={points}
        color={FLOW_COLORS[kind]}
        lineWidth={3}
        dashed
        dashSize={3.2}
        gapSize={1.8}
        depthTest={false}
        renderOrder={21}
      />
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
