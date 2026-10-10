/**
 * Compact pins above assets that need attention: machine health (rule-based condition
 * monitoring above "normal"), energy (last-hour consumption > 8 % above the energy model) and
 * data freshness (the asset's simulated PLC / gateway feed is stale, so its state is unknown and
 * its figures are frozen at the last values received). One drei Html per flagged asset only;
 * clicking a pin selects the asset.
 */
import { createRef, useMemo, type RefObject } from 'react';
import { Html } from '@react-three/drei';
import { CircleHelp, HeartPulse, Zap } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID } from '../../model/plant';
import { TRACKED_ASSETS } from '../../sim/engine';
import { CONSUMERS } from '../../sim/energy';
import { HEALTH_ASSETS } from '../../sim/health';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { MACHINE_STATE } from '../../ui/kit/Status';
import { CONVEYOR_GEOMETRY } from '../Conveyors';
import { conveyorTagAnchor, energyFlags, healthFlags, sharedStaleFeeds, type EnergyFlag, type HealthFlag, type StaleFeed } from './model';
import { topCenter, useBoundsCount, useRelevanceFade } from './shared';

const LEVEL_LABEL: Record<HealthFlag['level'], string> = { watch: 'Health watch', warning: 'Abnormal trend', alarm: 'Alarm limit' };
const PIN_IDS = [...new Set([...HEALTH_ASSETS.map((a) => a.id), ...CONSUMERS.map((c) => c.id), ...TRACKED_ASSETS])].filter(
  (id) => EQUIPMENT_BY_ID[id],
);

/** Where an asset's pins sit: above its bounds, or above the middle of a conveyor's run. */
export function pinAnchor(id: string): [number, number, number] | null {
  const g = CONVEYOR_BY_ID[id] ? CONVEYOR_GEOMETRY[id] : undefined;
  if (g) return conveyorTagAnchor(g.pts);
  const c = topCenter(id, 1.2);
  return c ? [c.x, c.y, c.z] : null;
}

type AssetPin = {
  id: string;
  health?: HealthFlag;
  energy?: EnergyFlag;
  stale?: StaleFeed;
  at: [number, number, number];
  el: RefObject<HTMLDivElement | null>;
};

export function AssetPins() {
  const visible = useTwin((s) => s.layers.status);
  const selected = useTwin((s) => s.selected);
  const health = useSimValue((s) => healthFlags(s));
  const energy = useSimValue((s) => energyFlags(s));
  const stale = useSimValue((s) => sharedStaleFeeds(s));
  const ready = useBoundsCount(PIN_IDS);

  const pins = useMemo(() => {
    const by = new Map<string, AssetPin>();
    const get = (id: string) => {
      let p = by.get(id);
      if (!p) {
        const at = pinAnchor(id);
        if (!at) return null;
        p = { id, at, el: createRef<HTMLDivElement>() };
        by.set(id, p);
      }
      return p;
    };
    for (const h of health) {
      const p = get(h.id);
      if (p) p.health = h;
    }
    for (const e of energy) {
      const p = get(e.id);
      if (p) p.energy = e;
    }
    for (const f of stale) {
      if (!EQUIPMENT_BY_ID[f.id]) continue;
      const p = get(f.id);
      if (p) p.stale = f;
    }
    return [...by.values()];
    // `ready` re-reads the bounds once the assets have registered them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, energy, stale, ready]);

  useRelevanceFade(
    pins.map((p) => ({ el: p.el, x: p.at[0], z: p.at[2] })),
    (i) => pins[i]?.id === selected,
  );

  if (!visible || !pins.length) return null;
  const select = (id: string) => useTwin.getState().select(id);
  return (
    <>
      {pins.map((p) => {
        const name = EQUIPMENT_BY_ID[p.id].name;
        return (
          <Html key={p.id} position={p.at} center zIndexRange={[8, 0]}>
            <div ref={p.el} className="ops-pins">
              {p.stale && (
                <button
                  className="status-pin status neutral ops-grey ops-stale"
                  onClick={() => select(p.id)}
                  title={`${name}: no new data from its (simulated) PLC / gateway feed since ${formatClock(p.stale.since)} — current state unknown${
                    p.stale.lastState ? `; last reported ${MACHINE_STATE[p.stale.lastState].label.toLowerCase()}` : ''
                  }. Its counters and rate are frozen at the last values received.`}
                >
                  <CircleHelp size={12} strokeWidth={2.4} aria-hidden />
                  Data stale
                  <span className="ops-sub num">since {formatClock(p.stale.since)}</span>
                </button>
              )}
              {p.health && (
                <button
                  className={`status-pin status ${p.health.level === 'alarm' ? 'critical' : 'warning'}`}
                  onClick={() => select(p.id)}
                  title={`${name}: ${LEVEL_LABEL[p.health.level].toLowerCase()} — health score ${p.health.score}/100. Rule-based detection on simulated signals; no trained model or physical sensors.`}
                >
                  <HeartPulse size={12} strokeWidth={2.4} aria-hidden />
                  <span className="num">{p.health.score}</span>
                  <span className="ops-sub">{LEVEL_LABEL[p.health.level]}</span>
                </button>
              )}
              {p.energy && (
                <button
                  className="status-pin status warning"
                  onClick={() => select(p.id)}
                  title={`${p.energy.label}: ${Math.round(p.energy.actual).toLocaleString('en-GB')} kWh against ${Math.round(p.energy.expected).toLocaleString('en-GB')} kWh expected by the energy model since the start of the previous hour. Illustrative model; tariffs are assumptions.`}
                >
                  <Zap size={12} strokeWidth={2.4} aria-hidden />
                  Energy <span className="num">+{Math.round(p.energy.deviation * 100)} %</span>
                </button>
              )}
            </div>
          </Html>
        );
      })}
    </>
  );
}
