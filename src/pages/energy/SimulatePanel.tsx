import { useState } from 'react';
import { Zap } from 'lucide-react';
import { CONSUMER_BY_ID } from '../../sim/energy';
import { scenariosActive } from '../../sim/engine';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { Panel } from '../../ui/kit/Panel';
import { ANOMALY_CONSUMERS, ANOMALY_FACTORS, anomalyLabel } from './derive';

/** Presenter control: inject a consumption drift on one consumer (simulation only). */
export function SimulatePanel({ onActivated }: { onActivated: (id: string) => void }) {
  const [id, setId] = useState(ANOMALY_CONSUMERS[0].id);
  const [factor, setFactor] = useState(1.2);
  const d = useSimValue((s) => ({ minute: s.minute, active: scenariosActive(s).filter((sc) => sc.kind === 'energy-anomaly') }));
  const existing = d.active.find((sc) => sc.equipmentId === id);

  const run = () => {
    const sim = useSim.getState();
    // One drift per consumer: a new setting replaces the previous one instead of compounding it.
    if (existing) sim.clear(existing.id);
    sim.activate({ kind: 'energy-anomaly', equipmentId: id, factor, end: null, label: anomalyLabel(id, factor) });
    onActivated(id);
  };

  return (
    <Panel
      title="Simulate an energy anomaly"
      subtitle="Scenario input for the demo"
      actions={<span className="tag sim">Simulated input</span>}
      footer={
        <span>
          Energy is accounted per hour, so the deviation shows in "last hour" within minutes and builds up in the period figures. Production is unchanged —
          only energy, cost and CO₂e move.
        </span>
      }
    >
      <div className="en-sim">
        <p className="en-note">
          Raises the chosen consumer's actual consumption above the energy model from the current plant time ({formatClock(d.minute)}) until cleared. Nothing is
          sent to equipment.
        </p>
        <div className="en-sim-row">
          <label className="field">
            Consumer
            <select className="select" value={id} onChange={(e) => setId(e.target.value)}>
              {ANOMALY_CONSUMERS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} · {CONSUMER_BY_ID[c.id].label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Drift
            <select className="select" value={String(factor)} onChange={(e) => setFactor(Number(e.target.value))}>
              {ANOMALY_FACTORS.map((f) => (
                <option key={f} value={String(f)}>
                  +{Math.round((f - 1) * 100)} %
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="en-sim-cause">
          <span className="muted">Scenario:</span> {anomalyLabel(id, factor)}
        </div>
        <div className="en-actions-row">
          <button className="btn primary" onClick={run} title={existing ? `Replaces the active anomaly on ${id}` : undefined}>
            <Zap size={14} aria-hidden />
            Simulate energy anomaly
          </button>
          {existing && <span className="muted en-hint">Replaces the active drift on {id}</span>}
        </div>

        {d.active.length > 0 && (
          <div className="en-active" aria-label="Active energy anomaly scenarios">
            <div className="en-active-h">Active energy scenarios</div>
            {d.active.map((sc) => (
              <div key={sc.id} className="en-active-row">
                <span className="tag scenario">Scenario</span>
                <span className="en-active-label" title={sc.label}>
                  {sc.label}
                  <span className="muted"> · since {formatClock(sc.start)}</span>
                </span>
                <button className="btn sm" onClick={() => useSim.getState().clear(sc.id)}>
                  Clear
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
