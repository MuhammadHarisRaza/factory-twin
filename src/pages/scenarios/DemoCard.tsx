import {
  Activity,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleMinus,
  ClipboardList,
  FastForward,
  Hourglass,
  ListChecks,
  Play,
  RefreshCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import { CLASSIFICATION_LABEL } from '../../intel/rules';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { EventStatusBadge, SeverityBadge } from '../../ui/kit/Status';
import { paramOptions, resolveValues, targetKey, when } from './catalogue';
import { DEMO_BY_ID, FINDING_ROW_LABEL, USE_CASE_LABEL, demoKey, demoView, type DemoFindingRow, type DemoId } from './demos';
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
          {def.findings ? (
            <FindingBlock view={view} now={d.now} resetting={resetting} />
          ) : ev ? (
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

const ROW_ICON: Record<DemoFindingRow['state'], LucideIcon> = {
  detected: CircleAlert,
  cleared: CircleDot,
  clear: CircleCheck,
  'not-evaluated': CircleHelp,
  none: CircleMinus,
};

/** The rule findings of a finding-based demonstration (E–H): the detected primary finding, or what it waits for, and each watched rule with its status (icon + words). */
function FindingBlock({ view, now, resetting }: { view: ReturnType<typeof demoView>; now: number; resetting: boolean }) {
  const f = view.complete ? view.finding : null;
  return (
    <>
      {f ? (
        <div className="scnp-demo-ev">
          <ListChecks size={13} aria-hidden />
          <span className="mono">{f.ruleId}</span>
          <SeverityBadge severity={f.severity} />
          <span className="tag" title="How the finding is decided (thresholds or a significance test), on simulated data">
            {CLASSIFICATION_LABEL[f.classification]}
          </span>
          <span className="scnp-demo-evt" title={f.title}>
            {f.title}
          </span>
          {f.firstSeen != null && <span className="muted">since {when(f.firstSeen, now)}</span>}
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
              Skip {formatSkip(view.skip)}
            </button>
          )}
        </p>
      )}
      {view.detail && <p className="scnp-demo-l">{view.detail}</p>}
      <ul className="scnp-demo-fl" aria-label="Rule findings of this demonstration (simulated data)">
        {view.rows.map((r) => {
          const Icon = ROW_ICON[r.state];
          return (
            <li key={r.key} className={`scnp-demo-f ${r.state}`} title={r.finding?.explanation ?? 'This rule has no finding for this item.'}>
              <Icon size={12} aria-hidden />
              <span className="scnp-demo-fs">{FINDING_ROW_LABEL[r.state]}</span>
              <span className="scnp-demo-fn">{r.label}</span>
              {r.at != null && <span className="muted num">{r.state === 'cleared' ? 'cleared ' : 'since '}{when(r.at, now)}</span>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** "Skip 45 min", "Skip 14 h 20 min". */
const formatSkip = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`);
