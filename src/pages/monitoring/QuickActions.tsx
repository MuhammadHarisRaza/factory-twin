/**
 * Presenter quick actions on a stage: start one of the stage-relevant scenarios on one of its assets
 * (machine stop, conveyor stop, reduced rate, data-feed loss) — the same scenario definitions the
 * Scenario Simulator uses, acting on the one shared simulation state. Clearly labelled "Simulate".
 */
import { useState } from 'react';
import { FlaskConical, Hourglass, Play, Truck, X } from 'lucide-react';
import { useApp } from '../../app/store';
import { DOCKS, SCENARIO_KIND_LABELS } from '../../model/plant';
import type { MonitoredStage } from '../../model/types';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { Panel } from '../../ui/kit/Panel';
import {
  QUICK_HINT,
  WH_HOLD_DEF,
  WH_HOLD_MIN,
  WH_TRUCK_DEF,
  assetName,
  quickDef,
  quickKindsFor,
  runningScenario,
  stageAssetIds,
  stageScenarios,
  type QuickKind,
  type ScenarioDef,
} from './derive';

const DURATIONS = [
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 h' },
  { value: 0, label: 'Until cleared' },
];

type Feedback = { ok: boolean; text: string };

export function QuickActions({ ms }: { ms: MonitoredStage }) {
  const assets = stageAssetIds(ms).filter((id) => quickKindsFor(id).length > 0);
  const [picked, setPicked] = useState<string>(assets[0] ?? '');
  const asset = assets.includes(picked) ? picked : (assets[0] ?? '');
  const kinds = asset ? quickKindsFor(asset) : [];
  const [kindPick, setKind] = useState<QuickKind>(kinds[0] ?? 'machine-stop');
  const kind = kinds.includes(kindPick) ? kindPick : (kinds[0] ?? 'machine-stop');
  const [duration, setDuration] = useState(30);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const resetting = useSim((s) => s.resetting);

  const d = useSimValue(
    (s) => ({
      now: s.minute,
      inEffect: stageScenarios(s, ms),
      running: asset ? runningScenario(s, kind, asset) : null,
      docked: DOCKS.find((k) => s.logistics.docks[k.id]?.vehicleId) ?? null,
    }),
    [ms.id, asset, kind],
  );

  const start = (def: ScenarioDef) => {
    const sc = useSim.getState().activate(def);
    setFeedback({ ok: true, text: `Started ${sc.id} at ${formatClock(sc.start)} — ${sc.label}. States, counts and events of this stage follow from the next simulated minute.` });
  };

  const isWh = ms.id === 'WH';
  const blocked = resetting ? 'Demo is resetting' : d.running ? `Already running (${d.running.id}) — clear it first` : null;

  return (
    <Panel
      title="Simulate on this stage"
      subtitle="Presenter quick actions · scenario inputs, not plant data"
      actions={
        <button className="btn sm ghost" onClick={() => useApp.getState().setScenariosOpen(true)} title="All scenarios, with their impact vs the no-scenario baseline">
          <FlaskConical size={13} aria-hidden /> All scenarios
        </button>
      }
    >
      {isWh ? (
        <div className="mon-qa-row">
          <button className="btn" disabled={resetting} onClick={() => start(WH_TRUCK_DEF)} title="An outbound truck arrives at the gate now">
            <Truck size={14} aria-hidden /> Simulate truck arrival
          </button>
          <button
            className="btn"
            disabled={resetting || !d.docked}
            title={d.docked ? `Holds the truck at ${d.docked.name} for an extra ${WH_HOLD_MIN} min` : 'No truck is at a dock — nothing to hold'}
            onClick={() => d.docked && start({ ...WH_HOLD_DEF, dockId: d.docked.id, label: `${WH_HOLD_DEF.label} · ${d.docked.name}` })}
          >
            <Hourglass size={14} aria-hidden /> Simulate dock hold{d.docked ? ` · ${d.docked.name}` : ''}
          </button>
          {!d.docked && <span className="muted">No dock occupied</span>}
        </div>
      ) : !assets.length ? (
        <p className="muted">No asset of this stage supports a quick scenario.</p>
      ) : (
        <div className="mon-qa">
          <label className="field">
            <span>Asset</span>
            <select className="select" value={asset} onChange={(e) => setPicked(e.target.value)}>
              {assets.map((id) => (
                <option key={id} value={id}>
                  {id} · {assetName(id)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Scenario</span>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as QuickKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {SCENARIO_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Duration</span>
            <select className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mon-qa-hint muted">{QUICK_HINT[kind]}</p>
          <div className="mon-qa-row">
            <button
              className="btn primary"
              disabled={!!blocked}
              title={blocked ?? `Simulate ${SCENARIO_KIND_LABELS[kind].toLowerCase()} on ${asset}`}
              onClick={() => start(quickDef(kind, asset, duration, d.now))}
            >
              <Play size={13} aria-hidden /> Simulate {SCENARIO_KIND_LABELS[kind].toLowerCase()}
            </button>
            {blocked && <span className="muted">{blocked}</span>}
          </div>
        </div>
      )}

      {feedback && (
        <p className={`mon-msg ${feedback.ok ? '' : 'err'}`} role="status">
          {feedback.text}
        </p>
      )}

      <div className="mon-qa-list">
        <div className="kpi-label">In effect on this stage</div>
        {d.inEffect.length ? (
          <ul>
            {d.inEffect.map((sc) => (
              <li key={sc.id}>
                <span className="tag scenario">Simulated</span>
                <span className="mon-qa-label" title={`${sc.id} · since ${formatClock(sc.start)}${sc.end != null ? ` · until ${formatClock(sc.end)}` : ' · until cleared'}`}>
                  {sc.label}
                </span>
                <span className="muted num">{sc.end != null ? `until ${formatClock(sc.end)}` : 'until cleared'}</span>
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    useSim.getState().clear(sc.id);
                    setFeedback({ ok: true, text: `Cleared ${sc.id} — ${sc.label}.` });
                  }}
                  title="End this scenario now"
                >
                  <X size={12} aria-hidden /> Clear
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No scenario in effect on this stage’s assets.</p>
        )}
      </div>
    </Panel>
  );
}
