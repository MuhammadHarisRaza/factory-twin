/**
 * The current production bottleneck (active-period method, src/sim/metrics.ts) marked on
 * the floor: an amber dashed outline around each machine of the constraining stage and one
 * small "Bottleneck" label at the front of the stage, which selects the machine.
 */
import { useMemo, useRef } from 'react';
import { Html, Line } from '@react-three/drei';
import { Hourglass } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { STAGE_BY_ID } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { equipmentBounds, useTwin } from '../../store';
import { OP_COLOR_HEX } from '../../ui/kit/Status';
import { bottleneckInfo, bottleneckTitle } from './model';
import { unionBounds, useBoundsCount, useRelevanceFade } from './shared';

const PAD = 1.0;
const ALL_STAGE_MACHINES = Object.values(STAGE_BY_ID).flatMap((s) => s.machines);

export function BottleneckHighlight() {
  const visible = useTwin((s) => s.layers.status);
  const info = useSimValue((s) => bottleneckInfo(s));
  const stage = info?.stage ?? null;
  const ready = useBoundsCount(ALL_STAGE_MACHINES);

  const geometry = useMemo(() => {
    if (!stage) return null;
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
  const selectedHere = useTwin((s) => s.selected != null && info != null && info.machines.includes(s.selected));
  const at = geometry?.label;
  useRelevanceFade(at ? [{ el: labelRef, x: at[0], z: at[2] }] : [], () => selectedHere);

  if (!visible || !info || !geometry) return null;
  const target = info.machines[0];
  const title = bottleneckTitle(info, EQUIPMENT_BY_ID[target]?.name ?? target);
  return (
    <group name="overlay:bottleneck" userData={{ twinOverlay: true }}>
      {geometry.outlines.map((pts, i) => (
        <Line
          key={`${info.stage}-${i}`}
          points={pts}
          color={OP_COLOR_HEX.amber}
          lineWidth={2}
          dashed
          dashSize={1.1}
          gapSize={0.6}
          transparent
          opacity={0.9}
          renderOrder={8}
        />
      ))}
      {geometry.label && (
        <Html position={geometry.label} center zIndexRange={[7, 0]}>
          <button ref={labelRef} className="ops-chip ops-amber" onClick={() => useTwin.getState().select(target)} title={title}>
            <Hourglass size={12} strokeWidth={2.3} aria-hidden />
            Bottleneck
            <span className="ops-sub">{info.name}</span>
          </button>
        </Html>
      )}
    </group>
  );
}
