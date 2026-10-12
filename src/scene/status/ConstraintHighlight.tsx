/**
 * The line constraint marked on the floor, in the wording of the Overview's summary and flow strip
 * (constraintMarker over constraintClaim, src/intel/summary.ts): a dashed outline around each
 * machine of the stage the claim names and one small label at the front of the stage, which selects
 * its first machine. Amber and "Constraining output" only while the evidence supports it (the kiln
 * stopped or slowed now, or the stage its starvation / blockage was traced to); otherwise a neutral
 * grey "Design constraint (modeled)" — never "Bottleneck" by default. The tooltip carries the
 * evidence.
 */
import { useMemo, useRef } from 'react';
import { Html, Line } from '@react-three/drei';
import { Hourglass } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { STAGE_BY_ID } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { equipmentBounds, useTwin } from '../../store';
import { OP_COLOR_HEX } from '../../ui/kit/Status';
import { constraintMarker } from '../../ui/twin/constraint';
import { useSceneTabIndex } from '../embedded';
import { constraintChipTitle } from './model';
import { unionBounds, useBoundsCount, useRelevanceFade } from './shared';

const PAD = 1.0;
const ALL_STAGE_MACHINES = Object.values(STAGE_BY_ID).flatMap((s) => s.machines);

export function ConstraintHighlight() {
  const visible = useTwin((s) => s.layers.status);
  const marker = useSimValue((s) => constraintMarker(s));
  const stage = marker.processStage;
  const ready = useBoundsCount(ALL_STAGE_MACHINES);
  const tabIndex = useSceneTabIndex();

  const geometry = useMemo(() => {
    const machines = STAGE_BY_ID[stage].machines;
    const outlines = machines
      .map((id) => equipmentBounds.get(id))
      .filter((b) => b != null)
      .map((b): [number, number, number][] => [
        [b.min.x - PAD, 0.11, b.min.z - PAD],
        [b.max.x + PAD, 0.11, b.min.z - PAD],
        [b.max.x + PAD, 0.11, b.max.z + PAD],
        [b.min.x - PAD, 0.11, b.max.z + PAD],
        [b.min.x - PAD, 0.11, b.min.z - PAD],
      ]);
    const u = unionBounds(machines);
    const label = u ? ([(u.min.x + u.max.x) / 2, 0.3, u.max.z + PAD + 0.9] as [number, number, number]) : null;
    return { outlines, label };
    // `ready` re-reads the bounds once the machines have registered them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, ready]);

  const labelRef = useRef<HTMLButtonElement>(null);
  const selectedHere = useTwin((s) => s.selected != null && marker.machines.includes(s.selected));
  const at = geometry.label;
  useRelevanceFade(at ? [{ el: labelRef, x: at[0], z: at[2] }] : [], () => selectedHere);

  if (!visible) return null;
  const target = marker.machines[0];
  const title = constraintChipTitle(marker, EQUIPMENT_BY_ID[target]?.name ?? target);
  const color = marker.active ? OP_COLOR_HEX.amber : OP_COLOR_HEX.grey;
  return (
    <group name="overlay:constraint" userData={{ twinOverlay: true }}>
      {geometry.outlines.map((pts, i) => (
        <Line
          key={`${stage}-${i}`}
          points={pts}
          color={color}
          lineWidth={marker.active ? 2 : 1.4}
          dashed
          dashSize={1.1}
          gapSize={0.6}
          transparent
          opacity={marker.active ? 0.9 : 0.7}
          renderOrder={8}
        />
      ))}
      {geometry.label && (
        <Html position={geometry.label} center zIndexRange={[7, 0]}>
          <button
            ref={labelRef}
            className={`ops-chip ${marker.active ? 'ops-amber' : 'ops-design'}`}
            onClick={() => useTwin.getState().select(target)}
            title={title}
            aria-label={`${marker.label}: ${marker.name}. Select ${EQUIPMENT_BY_ID[target]?.name ?? target}`}
            tabIndex={tabIndex}
          >
            <Hourglass size={12} strokeWidth={2.3} aria-hidden />
            {marker.label}
            <span className="ops-sub">{marker.name}</span>
          </button>
        </Html>
      )}
    </group>
  );
}
