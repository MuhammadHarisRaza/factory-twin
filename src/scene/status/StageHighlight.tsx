/**
 * The production stage highlighted in the model (useTwin.stage — set from the line strip, the
 * Overview flow strip, Production or a quick view): a subtle accent tint on the floor under each of
 * the stage's machines, a thin dashed accent outline around them and along its conveyors, and one
 * small stage label that opens the stage panel. Everything else is left unchanged (no geometry,
 * material or layout is altered). Distinct from the selection (solid cyan brackets and footprint)
 * and the line-constraint marker (grey or amber dashes).
 */
import { useMemo, useRef } from 'react';
import { Html, Line } from '@react-three/drei';
import { Layers } from 'lucide-react';
import { MONITORED_STAGES, MONITORED_STAGE_BY_ID } from '../../model/plant';
import { equipmentBounds, useTwin } from '../../store';
import { CONVEYOR_GEOMETRY } from '../Conveyors';
import { useSceneTabIndex } from '../embedded';
import { outlineLoop } from './model';
import { unionBounds, useBoundsCount, useRelevanceFade } from './shared';

/** Restrained accent of the stage highlight (the steel-teal navigation accent, softer than the selection). */
const STAGE_COLOR = '#79bdd6';
const PAD = 0.9;
const ALL_IDS = [...new Set(MONITORED_STAGES.flatMap((m) => [...m.equipment, ...m.conveyors]))];

type Rect = { cx: number; cz: number; w: number; d: number; loop: [number, number, number][] };

export function StageHighlight() {
  const stage = useTwin((s) => s.stage);
  const selected = useTwin((s) => s.selected);
  const ready = useBoundsCount(ALL_IDS);
  const tabIndex = useSceneTabIndex();

  const geo = useMemo(() => {
    if (!stage) return null;
    const ms = MONITORED_STAGE_BY_ID[stage];
    if (!ms) return null;
    const rects: Rect[] = [];
    const runs: [number, number, number][][] = [];
    for (const id of [...ms.equipment, ...ms.conveyors]) {
      const g = CONVEYOR_GEOMETRY[id];
      if (g) {
        runs.push(outlineLoop(g.pts, g.w / 2 + 0.4, 0.14, 0.3) as [number, number, number][]);
        continue;
      }
      const b = equipmentBounds.get(id);
      if (!b || b.isEmpty()) continue;
      const x0 = b.min.x - PAD;
      const x1 = b.max.x + PAD;
      const z0 = b.min.z - PAD;
      const z1 = b.max.z + PAD;
      const y = 0.13;
      rects.push({
        cx: (x0 + x1) / 2,
        cz: (z0 + z1) / 2,
        w: x1 - x0,
        d: z1 - z0,
        loop: [
          [x0, y, z0],
          [x1, y, z0],
          [x1, y, z1],
          [x0, y, z1],
          [x0, y, z0],
        ],
      });
    }
    const u = unionBounds(ms.equipment.length ? ms.equipment : ms.conveyors);
    const label = u && !u.isEmpty() ? ([(u.min.x + u.max.x) / 2, 0.3, u.max.z + PAD + 2.2] as [number, number, number]) : null;
    return { ms, rects, runs, label };
    // `ready` re-reads the bounds once the assets have registered them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, ready]);

  const labelRef = useRef<HTMLButtonElement>(null);
  const at = geo?.label;
  useRelevanceFade(at ? [{ el: labelRef, x: at[0], z: at[2] }] : [], () => true);

  if (!geo) return null;
  const { ms } = geo;
  return (
    <group name="overlay:stage-highlight" userData={{ twinOverlay: true }}>
      {geo.rects.map((r, i) => (
        <group key={`r${i}`}>
          <mesh position={[r.cx, 0.08, r.cz]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={7}>
            <planeGeometry args={[r.w, r.d]} />
            <meshBasicMaterial color={STAGE_COLOR} transparent opacity={0.1} depthWrite={false} />
          </mesh>
          <Line points={r.loop} color={STAGE_COLOR} lineWidth={1.6} dashed dashSize={0.9} gapSize={0.5} transparent opacity={0.9} renderOrder={8} />
        </group>
      ))}
      {geo.runs.map((pts, i) => (
        <Line key={`c${i}`} points={pts} color={STAGE_COLOR} lineWidth={1.6} dashed dashSize={0.9} gapSize={0.5} transparent opacity={0.85} renderOrder={8} />
      ))}
      {geo.label && (
        <Html position={geo.label} center zIndexRange={[7, 0]}>
          <button
            ref={labelRef}
            className="ops-chip ops-stage"
            onClick={() => {
              const tw = useTwin.getState();
              if (tw.vehicle) tw.selectVehicle(null);
              if (tw.selected) tw.select(null);
            }}
            title={`Stage highlighted: ${ms.name}${selected ? ' — click to show the stage panel' : ''}`}
            tabIndex={tabIndex}
          >
            <Layers size={12} strokeWidth={2.3} aria-hidden />
            Stage {ms.step}
            <span className="ops-sub">{ms.name}</span>
          </button>
        </Html>
      )}
    </group>
  );
}
