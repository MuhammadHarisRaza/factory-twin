/**
 * Scenarios panel (header → Scenarios, on every workspace; #/scenarios redirects here). Everything a
 * presenter needs to drive the simulation, in tabs:
 *   Guided demos     — the end-to-end demonstrations A–D (one click sets each up and follows it to the
 *                      event it produces) and card E, Reset demo with its after-reset checks;
 *   Catalogue        — every scenario input with its parameters, Activate / Replace / Clear and "Show me";
 *   Active & log     — what is in effect now (Clear, Clear all, Skip) and every scenario since the last
 *                      reset with its outcome and events;
 *   Impact           — the plant against its no-scenario baseline over a chosen window;
 *   Presenter guide  — the suggested path through the workspaces, with clock controls.
 * Scenarios change the simulation only; every workspace, 3D state, event, report and KPI reads the
 * same changed state. "Show me" targets are always one of the seven workspaces.
 */
import { useEffect, useRef } from 'react';
import { FlaskConical, RotateCcw, X } from 'lucide-react';
import { useSim, useSimValue } from '../sim/store';
import { formatClock } from '../sim/time';
import { ProvenanceBadge, Tabs } from '../ui/kit/Page';
import { Segmented } from '../ui/kit/Panel';
import { ActiveScenarios } from '../pages/scenarios/ActiveScenarios';
import { CATALOGUE, GROUP_TITLE, isClearable, scenarioStatus, type CatalogueGroup, type WindowMode } from '../pages/scenarios/catalogue';
import { DemoCard } from '../pages/scenarios/DemoCard';
import { DEMOS } from '../pages/scenarios/demos';
import { useScenarioDrawer, type ScenarioTab } from '../pages/scenarios/drawerState';
import { ImpactBand } from '../pages/scenarios/ImpactBand';
import { PresenterGuide } from '../pages/scenarios/PresenterGuide';
import { RESET_CARD_ID, ResetDemo } from '../pages/scenarios/ResetDemo';
import { ScenarioCard } from '../pages/scenarios/ScenarioCard';
import { ScenarioLog } from '../pages/scenarios/ScenarioLog';
// Also registers the truck-delay watcher and the after-reset check (module side effect, loaded with the shell).
import '../pages/scenarios/actions';
import '../pages/scenarios/scenarios.css';
import { useApp } from './store';

const GROUPS: CatalogueGroup[] = ['production', 'quality', 'logistics'];

const WINDOWS: { value: WindowMode; label: string }[] = [
  { value: 'scenario', label: 'Since scenario start' },
  { value: 'shift', label: 'Current shift' },
  { value: 'today', label: 'Today' },
];

export function ScenarioDrawer() {
  const open = useApp((s) => s.scenariosOpen);
  if (!open) return null;
  return <ScenarioPanel />;
}

function ScenarioPanel() {
  const setOpen = useApp((s) => s.setScenariosOpen);
  const tab = useScenarioDrawer((s) => s.tab);
  const setTab = useScenarioDrawer((s) => s.setTab);
  const scrollTo = useScenarioDrawer((s) => s.scrollTo);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  // Esc closes; focus starts on the panel and returns where it was when the panel closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    // Capture phase + preventDefault: this Esc is the drawer's, so panels behind it (which skip
    // default-prevented keys) stay open whatever order their listeners were added in.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.({ preventScroll: true });
    };
  }, [setOpen]);

  // "Go to Reset (E)": the guided-demo tab, scrolled to card E.
  useEffect(() => {
    if (!scrollTo || tab !== 'demos') return;
    const el = document.getElementById(scrollTo);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('flash');
    const t = setTimeout(() => el?.classList.remove('flash'), 1300);
    useScenarioDrawer.getState().setScrollTo(null);
    return () => clearTimeout(t);
  }, [scrollTo, tab]);

  // Each tab starts at its top.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab]);

  const d = useSimValue((s) => ({
    now: s.minute,
    running: s.scenarios.filter((sc) => scenarioStatus(s, sc).key === 'active').length,
    logged: s.scenarios.length,
  }));
  const goToReset = () => {
    setTab('demos');
    useScenarioDrawer.getState().setScrollTo(RESET_CARD_ID);
  };

  const tabs: { value: ScenarioTab; label: string; count?: number | null; title: string }[] = [
    { value: 'demos', label: 'Guided demos', title: 'Demonstrations A–D, end to end, and E · Reset demo' },
    { value: 'catalogue', label: 'Catalogue', title: 'Every scenario input with its parameters' },
    { value: 'active', label: 'Active & log', count: d.running || null, title: 'What is in effect now, and every scenario since the last reset' },
    { value: 'impact', label: 'Impact vs baseline', title: 'The plant against its no-scenario baseline' },
    { value: 'guide', label: 'Presenter guide', title: 'Suggested demo path, with clock controls' },
  ];

  return (
    <>
      <div className="drawer-scrim" onClick={close} />
      <aside className="drawer scn-drawer" role="dialog" aria-modal="true" aria-label="Scenarios">
        <div className="drawer-h">
          <FlaskConical size={16} aria-hidden />
          <h2>Scenarios</h2>
          <ProvenanceBadge kind="scenario" title="Simulated inputs: they change the demo simulation only — nothing is sent to equipment" />
          <span className="scn-clock num">plant time {formatClock(d.now)}</span>
          <div className="spacer" />
          <button type="button" className="btn ghost sm" onClick={goToReset} title="Reset the demo to its seeded start (card E, with confirmation)">
            <RotateCcw size={13} aria-hidden />
            Reset demo…
          </button>
          <button type="button" ref={closeRef} className="btn ghost icon" onClick={close} title="Close (Esc)" aria-label="Close scenarios">
            <X size={16} />
          </button>
        </div>
        <Tabs label="Scenario panel" value={tab} options={tabs} onChange={setTab} />
        <div className="drawer-b" ref={bodyRef} role="tabpanel" aria-label={tabs.find((t) => t.value === tab)?.label}>
          <p className="scn-intro">
            Scenarios are <b>simulated inputs</b> that start at the current plant time. They change only the simulation — nothing is sent to equipment — and every
            workspace, 3D state, event, report and KPI reads the same changed state.
          </p>
          {tab === 'demos' && <DemosTab onNavigate={close} />}
          {tab === 'catalogue' && <CatalogueTab onNavigate={close} />}
          {tab === 'active' && (
            <>
              <ActiveScenarios />
              <h3 className="scnl-title">
                Scenario log <span className="muted num">· {d.logged} since the last reset</span>
              </h3>
              <ScenarioLog onNavigate={close} />
            </>
          )}
          {tab === 'impact' && <ImpactTab />}
          {tab === 'guide' && <PresenterGuide onNavigate={close} onGoToReset={goToReset} />}
        </div>
      </aside>
    </>
  );
}

function DemosTab({ onNavigate }: { onNavigate: () => void }) {
  return (
    <>
      <div className="scn-tab-h">
        <p className="scn-intro">Set up in one click, then follow “Show me” in order — the scenario, its operational event and the report are one record everywhere.</p>
      </div>
      <div className="scnp-demos">
        {DEMOS.map((x) => (
          <DemoCard key={x.id} id={x.id} onNavigate={onNavigate} />
        ))}
        <ResetDemo />
      </div>
    </>
  );
}

function CatalogueTab({ onNavigate }: { onNavigate: () => void }) {
  const clear = useSim((s) => s.clear);
  const resetting = useSim((s) => s.resetting);
  // Only scenarios still in effect can be cleared (finding #24): a fault that broke down or was removed is over.
  const open = useSimValue((s) => s.scenarios.filter((sc) => isClearable(s, sc)).map((sc) => sc.id));
  return (
    <>
      <div className="scn-tab-h">
        <p className="scn-intro">Every scenario input · choose parameters, activate, then use “Show me” to go where the effect is visible.</p>
        {open.length > 0 && (
          <button type="button" className="btn sm" disabled={resetting} onClick={() => open.forEach((id) => clear(id))} title="End every running scenario now (condition-based maintenance is left to complete)">
            <X size={13} aria-hidden />
            Clear all ({open.length})
          </button>
        )}
      </div>
      {GROUPS.map((g) => (
        <section key={g} className="scnp-groupwrap" aria-label={GROUP_TITLE[g]}>
          <h3 className="scnp-group">{GROUP_TITLE[g]}</h3>
          <div className="scnp-grid">
            {CATALOGUE.filter((e) => e.group === g).map((e) => (
              <ScenarioCard key={e.id} entry={e} origin="catalogue" onNavigate={onNavigate} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function ImpactTab() {
  const mode = useScenarioDrawer((s) => s.impactMode);
  const setMode = useScenarioDrawer((s) => s.setImpactMode);
  return (
    <>
      <div className="scn-tab-h">
        <span className="scni-window">
          Window
          <Segmented label="Impact window" value={mode} options={WINDOWS} onChange={setMode} />
        </span>
      </div>
      <ImpactBand mode={mode} />
      <p className="scni-foot">
        Baseline: the same deterministic seed simulated without any scenario and advanced minute by minute alongside the plant — what would have happened. Δ = with
        scenarios − baseline over the window. Hourly accounting, so windows start on the hour.
      </p>
    </>
  );
}
