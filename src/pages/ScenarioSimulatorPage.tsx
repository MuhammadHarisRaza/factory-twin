/**
 * Scenario Simulator — the presenter's workspace. Answers: what is currently injected, what has
 * it changed compared with what would have happened (the no-scenario baseline of the same seed),
 * and what to show next. The end-to-end demonstrations (A–D, one per use case, and E reset) set up
 * a scenario in one click and follow it to the event it produces — the same record in the 3D twin,
 * the workspaces, the event report, the PDF and the copilot. The catalogue below holds every other
 * scenario input. Every scenario is simulated; all workspaces read the one changed state.
 */
import { useState } from 'react';
import { FlaskConical, X } from 'lucide-react';
import { useSim, useSimValue } from '../sim/store';
import { formatClock } from '../sim/time';
import { Panel, Segmented } from '../ui/kit/Panel';
import { CATALOGUE, GROUP_TITLE, isClearable, type CatalogueGroup, type WindowMode } from './scenarios/catalogue';
import { DemoCard } from './scenarios/DemoCard';
import { DEMOS } from './scenarios/demos';
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

const GROUPS: CatalogueGroup[] = ['production', 'quality', 'logistics'];

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
            sent to equipment — and every workspace, 3D state, event, report and KPI reads the same changed state.
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

      <Panel
        className="col-12"
        title="Demonstrations · the four use cases end to end"
        subtitle="Set up in one click, then follow Show me in order — the scenario, its operational event and the report are one record everywhere"
      >
        <div className="scnp-demos">
          {DEMOS.map((d) => (
            <DemoCard key={d.id} id={d.id} />
          ))}
          <ResetDemo />
        </div>
      </Panel>

      <Catalogue />
      <div className="col-4 scnp-side">
        <PresenterGuide key={resets} />
      </div>

      <ScenarioLog />
    </div>
  );
}

function Catalogue() {
  const clear = useSim((s) => s.clear);
  const resetting = useSim((s) => s.resetting);
  // Only scenarios still in effect can be cleared (finding #24): a fault that broke down or was removed is over.
  const open = useSimValue((s) => s.scenarios.filter((sc) => isClearable(s, sc)).map((sc) => sc.id));
  return (
    <Panel
      className="col-8"
      title="Scenario catalogue"
      subtitle="Every scenario input · choose parameters, activate, then use Show me to go where the effect is visible"
      actions={
        open.length > 0 && (
          <button className="btn sm" disabled={resetting} onClick={() => open.forEach((id) => clear(id))} title="End every running scenario now (condition-based maintenance is left to complete)">
            <X size={13} aria-hidden />
            Clear all ({open.length})
          </button>
        )
      }
    >
      {GROUPS.map((g) => (
        <section key={g} className="scnp-groupwrap" aria-label={GROUP_TITLE[g]}>
          <h3 className="scnp-group">{GROUP_TITLE[g]}</h3>
          <div className="scnp-grid">
            {CATALOGUE.filter((e) => e.group === g).map((e) => (
              <ScenarioCard key={e.id} entry={e} origin="simulator" />
            ))}
          </div>
        </section>
      ))}
    </Panel>
  );
}
