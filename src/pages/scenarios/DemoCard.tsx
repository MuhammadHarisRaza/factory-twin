import { Activity, CircleDashed, ClipboardList, FastForward, Hourglass, Play, RefreshCw, X } from 'lucide-react';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { EventStatusBadge, SeverityBadge } from '../../ui/kit/Status';
import { paramOptions, resolveValues, targetKey } from './catalogue';
import { DEMO_BY_ID, USE_CASE_LABEL, demoKey, demoView, type DemoId } from './demos';
import { clearDemo, currentRun, setupDemo, useDemoRuns, useScenarioParams } from './actions';
import { ParamSelect, ScenarioState, ShowButton } from './ui';
import './scenarios.css';

/**
 * Presenter card of one end-to-end demonstration (Scenarios panel → Guided demos): parameters,
 * one-click set-up, what the scenario is doing, the operational event it produced (the same record
 * as Events & Reports, the PDF and the copilot) and the "Show me" steps in presentation order —
 * each into one of the seven workspaces.
 */
export function DemoCard({ id, onNavigate }: { id: DemoId; onNavigate?: () => void }) {
  const def = DEMO_BY_ID[id];
  const key = demoKey(id);
  const values = useScenarioParams((s) => s.values[key]);
  const setParam = useScenarioParams((s) => s.set);
  const runs = useDemoRuns((s) => s.runs);
  const resets = useSim((s) => s.resets);
  const resetting = useSim((s) => s.resetting);
  const run = currentRun(runs, id, resets);

  const d = useSimValue(
    (s) => {
      const v = resolveValues(def, values, s);
      const view = demoView(s, def, v, run);
      return {
        now: s.minute,
        v,
        view,
        options: def.params.map((p) => paramOptions(p, s)),
      };
    },
    [def, values, run],
  );
  const { view } = d;
  const params = def.params.map((p, i) => ({ p, i })).filter(({ p }) => !p.visible || p.visible(d.v));
  const ev = view.primary;

  return (
    <article className={`scnp-card scnp-demo ${view.active ? 'on' : ''}`} aria-label={`Demonstration ${id}: ${def.title}`}>
      <header className="scnp-card-h">
        <span className="scnp-letter" aria-hidden>
          {id}
        </span>
        <h3>{def.title}</h3>
        <span className="scnp-uc">{USE_CASE_LABEL[def.useCase]}</span>
        <div className="spacer" />
        {view.active ? (
          <span className="scnp-state on">
            <Activity size={13} strokeWidth={2.2} aria-hidden />
            Running
          </span>
        ) : view.run ? (
          view.scenarios[0] ? <ScenarioState st={view.scenarios[0].st} now={d.now} /> : <span className="scnp-state">Set up {formatClock(view.run.at)}</span>
        ) : (
          <span className="scnp-state">Not set up</span>
        )}
      </header>

      <p className="scnp-what">{def.summary}</p>

      <div className="scnp-row">
        {params.map(({ p, i }) => (
          <ParamSelect key={p.key} label={p.label} value={d.v[p.key]} options={d.options[i]} onChange={(val) => setParam(key, p.key, val)} />
        ))}
        <div className="spacer" />
        {view.clearable && (
          <button className="btn" onClick={() => clearDemo(id)} title="End this demonstration's scenarios now (and a pending truck-delay hold)">
            <X size={14} aria-hidden />
            Clear
          </button>
        )}
        <button
          className="btn primary"
          disabled={resetting}
          onClick={() => setupDemo(id, d.v)}
          title={resetting ? 'Resetting the demo…' : view.active ? 'Replace the running set-up with these parameters, from the current plant time' : 'Activate the scenario at the current plant time'}
        >
          {view.run ? <RefreshCw size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          {view.run ? 'Set up again' : 'Set up'}
        </button>
      </div>

      {view.run && (
        <div className="scnp-demo-s">
          <p className="scnp-demo-l" title={view.status}>
            <CircleDashed size={13} aria-hidden />
            <span>{view.status}</span>
          </p>
          {ev ? (
            <div className="scnp-demo-ev">
              <ClipboardList size={13} aria-hidden />
              <span className="mono">{ev.id}</span>
              <SeverityBadge severity={ev.severity} />
              <EventStatusBadge status={ev.status} />
              <span className="scnp-demo-evt" title={ev.title}>
                {ev.title}
              </span>
              <span className="muted">
                {ev.end == null ? 'condition active' : `cleared ${formatClock(ev.end)}`}
                {view.events.length > 1 ? ` · ${view.events.length - 1} related` : ''}
              </span>
            </div>
          ) : (
            <p className="scnp-demo-l wait">
              <Hourglass size={13} aria-hidden />
              <span>{view.eventLine}</span>
              {view.skip != null && (
                <button
                  className="btn sm"
                  disabled={resetting}
                  onClick={() => useSim.getState().skip(view.skip!)}
                  title={`Simulate the next ${view.skip} min at once (the clock jumps; nothing else changes)`}
                >
                  <FastForward size={12} aria-hidden />
                  Skip {view.skip} min
                </button>
              )}
            </p>
          )}
        </div>
      )}

      <footer className="scnp-card-f">
        <span className="scnp-show-l">Show me</span>
        {view.steps.map((st) =>
          st.target ? (
            <ShowButton key={targetKey(st.target)} target={st.target} label={st.label} onNavigate={onNavigate} primary={st.key === 'event'} />
          ) : (
            <button key={st.key} className="btn sm" disabled title={st.hint ?? undefined}>
              {st.label}
            </button>
          ),
        )}
      </footer>
    </article>
  );
}
