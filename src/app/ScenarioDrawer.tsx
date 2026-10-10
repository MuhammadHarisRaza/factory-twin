import { useEffect } from 'react';
import { ArrowRight, FlaskConical, X } from 'lucide-react';
import { SCENARIO_KIND_LABELS } from '../model/plant';
import { useSim, useSimValue } from '../sim/store';
import { formatClock } from '../sim/time';
import { CATALOGUE, GROUP_TITLE, isClearable, scenarioStatus, when, type CatalogueGroup } from '../pages/scenarios/catalogue';
import { DemoCard } from '../pages/scenarios/DemoCard';
import { DEMOS } from '../pages/scenarios/demos';
import { ResetDemo } from '../pages/scenarios/ResetDemo';
import { ScenarioCard } from '../pages/scenarios/ScenarioCard';
// Also registers the truck-delay watcher and the after-reset check (module side effect, loaded with the shell).
import '../pages/scenarios/actions';
import { useApp } from './store';

const GROUPS: CatalogueGroup[] = ['production', 'quality', 'logistics'];

/**
 * Quick scenario access from any workspace: what is running now (only scenarios still in effect —
 * a fault that broke down or was removed is over), the demonstration cards and the catalogue in
 * compact form, and Reset Demo.
 */
export function ScenarioDrawer() {
  const open = useApp((s) => s.scenariosOpen);
  if (!open) return null;
  return <DrawerPanel />;
}

function DrawerPanel() {
  const setOpen = useApp((s) => s.setScenariosOpen);
  const clear = useSim((s) => s.clear);
  const close = () => setOpen(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const d = useSimValue((s) => ({
    now: s.minute,
    running: s.scenarios
      .map((sc) => ({ sc, st: scenarioStatus(s, sc), clearable: isClearable(s, sc) }))
      .filter(({ st }) => st.key === 'active'),
  }));
  const clearable = d.running.filter((r) => r.clearable);

  return (
    <>
      <div className="drawer-scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-label="Scenarios">
        <div className="drawer-h">
          <h2>Scenarios</h2>
          <span className="tag sim">Simulated inputs</span>
          <div className="spacer" />
          <button className="btn ghost icon" onClick={close} title="Close (Esc)" aria-label="Close scenarios">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-b">
          <div className="notice">
            <FlaskConical size={14} aria-hidden />
            <span>
              Scenarios change the <b>simulation only</b> and start at the current plant time ({formatClock(d.now)}). Nothing is sent to equipment. Every affected
              metric, event and 3D state derives from the same simulated state.
            </span>
          </div>

          <button
            className="btn scnd-open"
            onClick={() => {
              close();
              useApp.getState().go('scenarios');
            }}
            title="Impact vs baseline, scenario log, presenter guide"
          >
            <span>
              <FlaskConical size={14} aria-hidden />
              Open Scenario Simulator
            </span>
            <ArrowRight size={14} aria-hidden />
          </button>

          {d.running.length > 0 && (
            <section className="scnd-active" aria-label="Running scenarios">
              <h3>Running now</h3>
              <ul className="scnp-inst">
                {d.running.map(({ sc, clearable: canClear }) => (
                  <li key={sc.id}>
                    <span className="scnp-inst-l" title={`${SCENARIO_KIND_LABELS[sc.kind]} · ${sc.label}`}>
                      {sc.label}
                    </span>
                    <span className="scnp-inst-m">since {when(sc.start, d.now)}</span>
                    {canClear ? (
                      <button className="btn sm" onClick={() => clear(sc.id)}>
                        Clear
                      </button>
                    ) : (
                      <span className="scnp-inst-m">until {formatClock(sc.end ?? d.now)}</span>
                    )}
                  </li>
                ))}
              </ul>
              {clearable.length > 1 && (
                <div className="scnd-active-a">
                  <button className="btn sm" onClick={() => clearable.forEach(({ sc }) => clear(sc.id))}>
                    Clear all ({clearable.length})
                  </button>
                </div>
              )}
            </section>
          )}

          <h3 className="scnp-group">Demonstrations · four use cases</h3>
          {DEMOS.map((x) => (
            <DemoCard key={x.id} id={x.id} compact onNavigate={close} />
          ))}
          {GROUPS.map((g) => (
            <section key={g} className="scnd-group" aria-label={GROUP_TITLE[g]}>
              <h3 className="scnp-group">{GROUP_TITLE[g]}</h3>
              {CATALOGUE.filter((e) => e.group === g).map((e) => (
                <ScenarioCard key={e.id} entry={e} origin="drawer" compact onNavigate={close} />
              ))}
            </section>
          ))}

          <ResetDemo variant="compact" />
        </div>
      </aside>
    </>
  );
}
