/**
 * Compact pins above assets that need attention: machine health (rule-based condition
 * monitoring above "normal") and energy (last-hour consumption > 8 % above the energy
 * model). One drei Html per flagged asset only; clicking a pin selects the asset.
 */
import { createRef, useMemo, type RefObject } from 'react';
import { Html } from '@react-three/drei';
import { HeartPulse, Zap } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONSUMERS } from '../../sim/energy';
import { HEALTH_ASSETS } from '../../sim/health';
import { useSimValue } from '../../sim/store';
import { useTwin } from '../../store';
import { energyFlags, healthFlags, type EnergyFlag, type HealthFlag } from './model';
import { topCenter, useBoundsCount, useRelevanceFade } from './shared';

const LEVEL_LABEL: Record<HealthFlag['level'], string> = { watch: 'Health watch', warning: 'Abnormal trend', alarm: 'Alarm limit' };
const PIN_IDS = [...new Set([...HEALTH_ASSETS.map((a) => a.id), ...CONSUMERS.map((c) => c.id)])].filter((id) => EQUIPMENT_BY_ID[id]);

type AssetPin = { id: string; health?: HealthFlag; energy?: EnergyFlag; at: [number, number, number]; el: RefObject<HTMLDivElement | null> };

export function AssetPins() {
  const visible = useTwin((s) => s.layers.status);
  const selected = useTwin((s) => s.selected);
  const health = useSimValue((s) => healthFlags(s));
  const energy = useSimValue((s) => energyFlags(s));
  const ready = useBoundsCount(PIN_IDS);

  const pins = useMemo(() => {
    const by = new Map<string, AssetPin>();
    const get = (id: string) => {
      let p = by.get(id);
      if (!p) {
        const c = topCenter(id, 1.2);
        if (!c) return null;
        p = { id, at: [c.x, c.y, c.z], el: createRef<HTMLDivElement>() };
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
    return [...by.values()];
    // `ready` re-reads the bounds once the assets have registered them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, energy, ready]);

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
