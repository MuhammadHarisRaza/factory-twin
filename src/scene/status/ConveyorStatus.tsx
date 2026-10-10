/**
 * Operational conveyors (E-COL, D-BELT, CV-*) marked along their run when they are not simply
 * running: a restrained red edge around a stopped or faulted conveyor (slow pulse, like the red
 * beacons) with a small "Stopped" tag, amber while it runs but accumulates because the receiving
 * stage cannot take tiles, grey on a planned stop. Derived once per simulated minute from
 * `operationalState`; the outline geometry is static per conveyor (built once), and the pulse and
 * relevance fade are written in the render loop — no per-frame React state.
 */
import { createRef, useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { CalendarClock, CircleSlash, OctagonX, type LucideIcon } from 'lucide-react';
import type { Line2, LineMaterial } from 'three-stdlib';
import type { Vec3 } from '../../data/types';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { OP_COLOR_HEX, type OpColor, type Tone } from '../../ui/kit/Status';
import { CONVEYOR_GEOMETRY } from '../Conveyors';
import { conveyorTagAnchor, outlineLoop, sharedConveyorRuns, type ConveyorMark, type ConveyorRun } from './model';
import { useRelevanceFade } from './shared';

const MARK: Record<ConveyorMark, { color: OpColor; tone: Tone; label: string; icon: LucideIcon }> = {
  stopped: { color: 'red', tone: 'critical', label: 'Stopped', icon: OctagonX },
  blocked: { color: 'amber', tone: 'warning', label: 'Accumulating', icon: CircleSlash },
  planned: { color: 'grey', tone: 'neutral', label: 'Planned stop', icon: CalendarClock },
};

/** Static outline (just outside the side rails, slightly above the belt) and tag anchor per conveyor. */
const RUNS: Record<string, { outline: Vec3[]; tag: Vec3 }> = Object.fromEntries(
  Object.entries(CONVEYOR_GEOMETRY).map(([id, g]) => [id, { outline: outlineLoop(g.pts, g.w / 2 + 0.16, 0.1, 0.2), tag: conveyorTagAnchor(g.pts) }]),
);

function runTitle(r: ConveyorRun) {
  const name = `${r.id} ${EQUIPMENT_BY_ID[r.id]?.name ?? ''}`.trim();
  const since = formatClock(r.since);
  if (r.mark === 'blocked')
    return `${name}: running but accumulating since ${since} — the receiving stage cannot take tiles, so they queue on the belt. Simulated state.`;
  const why = r.reason ? ` — ${r.reason}${r.op === 'fault' ? ' (fault alarm)' : ''}` : '';
  const what = r.mark === 'planned' ? 'planned stop' : 'stopped';
  return `${name}: ${what} since ${since}${why}${r.scenario ? ' · demo scenario' : ''}. Tiles on it stand still; the stages it feeds receive nothing. Simulated state.`;
}

export function ConveyorStatus() {
  const visible = useTwin((s) => s.layers.status && s.layers.conveyors);
  const selected = useTwin((s) => s.selected);
  const runs = useSimValue((s) => sharedConveyorRuns(s)).filter((r) => RUNS[r.id]);

  // One stable element ref per conveyor tag (fade by relevance) and the outline objects (pulse).
  const tags = useRef(new Map<string, RefObject<HTMLButtonElement | null>>());
  const tagRef = (id: string) => {
    let r = tags.current.get(id);
    if (!r) {
      r = createRef<HTMLButtonElement>();
      tags.current.set(id, r);
    }
    return r;
  };
  const lines = useRef(new Map<string, Line2>());

  useRelevanceFade(
    runs.map((r) => ({ el: tagRef(r.id), x: RUNS[r.id].tag[0], z: RUNS[r.id].tag[2] })),
    (i) => runs[i]?.id === selected,
  );

  useFrame(({ clock }) => {
    if (!visible) return;
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 2.4);
    for (const r of runs) {
      const l = lines.current.get(r.id);
      if (l) (l.material as LineMaterial).opacity = r.mark === 'stopped' ? 0.5 + 0.4 * pulse : 0.85;
    }
  });

  if (!visible || !runs.length) return null;
  const select = (id: string) => useTwin.getState().select(id);
  return (
    // Flagged so off-screen renders (simulated camera frames) can leave operator overlays out.
    <group name="overlay:conveyor-status" userData={{ twinOverlay: true }}>
      {runs.map((r) => {
        const spec = MARK[r.mark];
        const g = RUNS[r.id];
        const Icon = spec.icon;
        return (
          <group key={r.id}>
            <Line
              ref={(l) => {
                if (l) lines.current.set(r.id, l as Line2);
                else lines.current.delete(r.id);
              }}
              points={g.outline}
              color={OP_COLOR_HEX[spec.color]}
              lineWidth={2.2}
              transparent
              opacity={0.85}
              renderOrder={8}
            />
            <Html position={g.tag} center zIndexRange={[8, 0]}>
              <div className="ops-pins ops-run">
                <button
                  ref={tagRef(r.id)}
                  className={`status-pin status ${spec.tone} ops-${spec.color}`}
                  onClick={() => select(r.id)}
                  title={runTitle(r)}
                >
                  <Icon size={12} strokeWidth={2.4} aria-hidden />
                  {spec.label}
                  <span className="ops-sub num">since {formatClock(r.since)}</span>
                </button>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
