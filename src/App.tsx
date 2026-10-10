import { Suspense, lazy, type ComponentType } from 'react';
import { Expand, Presentation, RotateCcw } from 'lucide-react';
import { useTwin } from './store';
import { PERIOD_WORKSPACES, WORKSPACES, useApp } from './app/store';
import { Header, Sidebar } from './app/Shell';
import { ScenarioDrawer } from './app/ScenarioDrawer';
import { CopilotDrawer } from './app/CopilotDrawer';
import { EvidenceCapture } from './app/EvidenceCapture';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { Loader, PresentationExit, SceneErrorBoundary } from './ui/Overlays';
import { TwinOverlays } from './ui/twin/TwinOverlays';
import { TwinSearch } from './ui/twin/Search';
// The 3D scene (three.js + all geometry) loads as its own chunk so the shell paints first.
const Scene = lazy(() => import('./scene/Scene'));

// Workspaces load on first visit (each in its own chunk); the Factory Twin is always mounted.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));

/** Header actions of the Factory Twin: global search, fit, overview and presentation mode. */
function TwinActions() {
  const fit = useTwin((s) => s.fit);
  const reset = useTwin((s) => s.reset);
  const setUiHidden = useTwin((s) => s.setUiHidden);
  const uiHidden = useTwin((s) => s.uiHidden);
  return (
    <div className="tw-actions">
      {!uiHidden && <TwinSearch />}
      <button className="btn ghost" onClick={fit} title="Fit the whole site in view (F)" aria-label="Fit site">
        <Expand size={14} />
        <span className="btn-label">Fit</span>
      </button>
      <button className="btn ghost" onClick={reset} title="Return to the factory overview and clear selection (R)" aria-label="Overview">
        <RotateCcw size={14} />
        <span className="btn-label">Overview</span>
      </button>
      <button className="btn ghost" onClick={() => setUiHidden(true)} title="Presentation mode — hide the interface; the demo mark stays visible (H, Esc to leave)" aria-label="Present">
        <Presentation size={14} />
        <span className="btn-label">Present</span>
      </button>
    </div>
  );
}

/** Immersive Factory Twin: the scene stays mounted while other workspaces are open. */
function TwinWorkspace({ active }: { active: boolean }) {
  const uiHidden = useTwin((s) => s.uiHidden);
  return (
    <div className="twin" style={{ visibility: active ? 'visible' : 'hidden' }} aria-hidden={!active}>
      <div className="stage">
        <SceneErrorBoundary>
          <Suspense fallback={null}>
            <Scene active={active} />
          </Suspense>
        </SceneErrorBoundary>
      </div>
      {active && !uiHidden && <TwinOverlays />}
      {active && <PresentationExit />}
    </div>
  );
}

const PAGES = {
  monitoring: page(() => import('./pages/MonitoringPage'), 'MonitoringPage'),
  events: page(() => import('./pages/EventsPage'), 'EventsPage'),
  copilot: page(() => import('./pages/CopilotPage'), 'CopilotPage'),
  production: page(() => import('./pages/ProductionPage'), 'ProductionPage'),
  quality: page(() => import('./pages/QualityPage'), 'QualityPage'),
  health: page(() => import('./pages/MachineHealthPage'), 'MachineHealthPage'),
  energy: page(() => import('./pages/EnergyPage'), 'EnergyPage'),
  command: page(() => import('./pages/CommandCenterPage'), 'CommandCenterPage'),
  scenarios: page(() => import('./pages/ScenarioSimulatorPage'), 'ScenarioSimulatorPage'),
  fleet: page(() => import('./pages/FleetPage'), 'FleetPage'),
  assets: page(() => import('./pages/AssetsPage'), 'AssetsPage'),
} as const;

export default function App() {
  useKeyboardShortcuts();
  const workspace = useApp((s) => s.workspace);
  const collapsed = useApp((s) => s.navCollapsed);
  const presenting = useTwin((s) => s.uiHidden);
  const twin = workspace === 'twin';
  const Page = twin ? null : PAGES[workspace];
  const title = WORKSPACES.find((w) => w.id === workspace)!.title;

  return (
    <div className={`shell ${collapsed ? 'nav-collapsed' : ''} ${presenting ? 'presenting' : ''}`}>
      <Sidebar />
      <div className="main">
        <Header title={title} period={PERIOD_WORKSPACES.includes(workspace)} actions={twin ? <TwinActions /> : undefined} />
        <main className={`content ${twin ? 'immersive' : ''}`}>
          <TwinWorkspace active={twin} />
          {Page && (
            <Suspense fallback={<div className="page-loading" role="status">Loading workspace…</div>}>
              <Page />
            </Suspense>
          )}
        </main>
      </div>
      <ScenarioDrawer />
      <CopilotDrawer />
      <EvidenceCapture />
      <Loader />
    </div>
  );
}
