/**
 * Scenario Simulator — the presenter's workspace. Answers: what is currently injected,
 * what has it changed compared with what would have happened (the no-scenario baseline
 * of the same seed), and what to show next. Every scenario is a simulated input; all
 * workspaces read the one changed state.
 */
import { useState } from 'react';
import { FlaskConical, X } from 'lucide-react';
import { useSim, useSimValue } from '../sim/store';
import { formatClock } from '../sim/time';
import { Panel, Segmented } from '../ui/kit/Panel';
import { CATALOGUE, scenarioStatus, type WindowMode } from './scenarios/catalogue';
import { ImpactBand } from './scenarios/ImpactBand';
import { PresenterGuide } from './scenarios/PresenterGuide';
import { ResetDemo } from './scenarios/ResetDemo';
import { ScenarioCard } from './scenarios/ScenarioCard';
import { ScenarioLog } from './scenarios/ScenarioLog';
import './scenarios.css';

const WINDOWS: { value: WindowMode; label: string }[] = [
  { value: 'scenario', label: 'Since scenario start' },
  { value: 'shift', label: 'Current shift' },
  { value: 'today', label: 'Today' },
];

export function ScenarioSimulatorPage() {
  const [mode, setMode] = useState<WindowMode>('scenario');
  const resets = useSim((s) => s.resets);
  const minute = useSimValue((s) => s.minute);

  return (
    <div className="page scnp">
      <div className="toolbar-row scnp-toolbar">
        <div className="notice">
          <FlaskConical size={14} aria-hidden />
          <span>
            Scenarios are <b>simulated inputs</b> that start at the current plant time ({formatClock(minute)}). They change only the simulation — nothing is
            sent to equipment — and every workspace, 3D state, event and KPI reads the same changed state.
          </span>
        </div>
        <div className="scnp-window">
          <span>Impact window</span>
          <Segmented label="Impact window" value={mode} options={WINDOWS} onChange={setMode} />
        </div>
      </div>

      <ImpactBand mode={mode} />
      <p className="scnp-foot">
        Baseline: the same deterministic seed simulated without any scenario and advanced minute by minute alongside the plant — what would have happened.
        Δ = with scenarios − baseline over the window. Hourly accounting, so windows start on the hour; energy cost uses the illustrative tariffs.
      </p>

      <Catalogue />
      <div className="col-4 scnp-side">
        <PresenterGuide key={resets} />
        <ResetDemo />
      </div>

      <ScenarioLog />
    </div>
  );
}

function Catalogue() {
  const clear = useSim((s) => s.clear);
  const open = useSimValue((s) =>
    s.scenarios
      .filter((sc) => sc.kind !== 'maintenance')
      .filter((sc) => {
        const k = scenarioStatus(s, sc).key;
        return k === 'active' || k === 'resolved';
      })
      .map((sc) => sc.id),
  );
  const groups = [
    { key: 'core', title: 'Core demo scenarios', entries: CATALOGUE.filter((e) => e.group === 'core') },
    { key: 'more', title: 'Production rate & logistics', entries: CATALOGUE.filter((e) => e.group === 'more') },
  ];
  return (
    <Panel
      className="col-8"
      title="Scenario catalogue"
      subtitle="Choose parameters, activate, then use Show me to go where the effect is visible"
      actions={
        open.length > 0 && (
          <button className="btn sm" onClick={() => open.forEach((id) => clear(id))} title="End every running scenario now">
            <X size={13} aria-hidden />
            Clear all ({open.length})
          </button>
        )
      }
    >
      {groups.map((g) => (
        <section key={g.key} className="scnp-groupwrap" aria-label={g.title}>
          <h3 className="scnp-group">{g.title}</h3>
          <div className="scnp-grid">
            {g.entries.map((e) => (
              <ScenarioCard key={e.id} entry={e} origin="simulator" />
            ))}
          </div>
        </section>
      ))}
    </Panel>
  );
}
