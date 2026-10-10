import { Suspense, lazy } from 'react';
import { Expand, Presentation, RotateCcw } from 'lucide-react';
import { useTwin } from './store';
import { PERIOD_WORKSPACES, WORKSPACES, useApp } from './app/store';
import { Header, Sidebar } from './app/Shell';
import { ScenarioDrawer } from './app/ScenarioDrawer';
import { CopilotDrawer } from './app/CopilotDrawer';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { Loader, PresentationExit, SceneErrorBoundary } from './ui/Overlays';
import { TwinOverlays } from './ui/twin/TwinOverlays';
import { ProductionPage } from './pages/ProductionPage';
import { QualityPage } from './pages/QualityPage';
import { MachineHealthPage } from './pages/MachineHealthPage';
import { EnergyPage } from './pages/EnergyPage';
import { CommandCenterPage } from './pages/CommandCenterPage';
import { ScenarioSimulatorPage } from './pages/ScenarioSimulatorPage';
import { FleetPage } from './pages/FleetPage';
import { AssetsPage } from './pages/AssetsPage';

// The 3D scene (three.js + all geometry) loads as its own chunk so the shell paints first.
const Scene = lazy(() => import('./scene/Scene'));

function TwinActions() {
  const fit = useTwin((s) => s.fit);
  const reset = useTwin((s) => s.reset);
  const setUiHidden = useTwin((s) => s.setUiHidden);
  return (
    <>
      <button className="btn ghost" onClick={fit} title="Fit the whole site in view (F)">
        <Expand size={14} />
        <span className="btn-label">Fit</span>
      </button>
      <button className="btn ghost" onClick={reset} title="Return to the factory overview and clear selection (R)">
        <RotateCcw size={14} />
        <span className="btn-label">Overview</span>
      </button>
      <button className="btn ghost" onClick={() => setUiHidden(true)} title="Presentation mode — hide the interface (H)">
        <Presentation size={14} />
        <span className="btn-label">Present</span>
      </button>
    </>
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
  production: ProductionPage,
  quality: QualityPage,
  health: MachineHealthPage,
  energy: EnergyPage,
  command: CommandCenterPage,
  scenarios: ScenarioSimulatorPage,
  fleet: FleetPage,
  assets: AssetsPage,
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
          {Page && <Page />}
        </main>
      </div>
      <ScenarioDrawer />
      <CopilotDrawer />
      <Loader />
    </div>
  );
}
