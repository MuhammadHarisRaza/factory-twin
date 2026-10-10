import { Suspense, lazy } from 'react';
import { Expand, Presentation, RotateCcw } from 'lucide-react';
import { useTwin } from './store';
import { useApp } from './app/store';
import { Header, Sidebar } from './app/Shell';
import { ScenarioDrawer } from './app/ScenarioDrawer';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { ZonePanel } from './ui/ZonePanel';
import { Inspector } from './ui/Inspector';
import { FlowLegend, Toolbar } from './ui/Toolbar';
import { Minimap } from './ui/Minimap';
import { Hint, Loader, PresentationExit, SceneErrorBoundary } from './ui/Overlays';
import { TwinStatusBar } from './ui/TwinStatusBar';
import { ProductionPage } from './pages/ProductionPage';
import { QualityPage } from './pages/QualityPage';
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
      <button className="btn ghost" onClick={reset} title="Return to the full-factory view and clear selection (R)">
        <RotateCcw size={14} />
        <span className="btn-label">Full factory</span>
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
      {active && !uiHidden && (
        <>
          <ZonePanel />
          <TwinStatusBar />
          <Inspector />
          <Toolbar />
          <Minimap />
          <FlowLegend />
          <Hint />
        </>
      )}
      {active && <PresentationExit />}
    </div>
  );
}

const TITLES = {
  twin: 'Factory Twin',
  production: 'Production & OEE',
  quality: 'Quality Intelligence',
  fleet: 'Fleet & Logistics',
  assets: 'Assets & Data',
} as const;

export default function App() {
  useKeyboardShortcuts();
  const workspace = useApp((s) => s.workspace);
  const collapsed = useApp((s) => s.navCollapsed);
  const presenting = useTwin((s) => s.uiHidden);
  const twin = workspace === 'twin';

  return (
    <div className={`shell ${collapsed ? 'nav-collapsed' : ''} ${presenting ? 'presenting' : ''}`}>
      <Sidebar />
      <div className="main">
        <Header title={TITLES[workspace]} period={workspace !== 'twin' && workspace !== 'assets'} actions={twin ? <TwinActions /> : undefined} />
        <main className={`content ${twin ? 'immersive' : ''}`}>
          <TwinWorkspace active={twin} />
          {workspace === 'production' && <ProductionPage />}
          {workspace === 'quality' && <QualityPage />}
          {workspace === 'fleet' && <FleetPage />}
          {workspace === 'assets' && <AssetsPage />}
        </main>
      </div>
      <ScenarioDrawer />
      <Loader />
    </div>
  );
}
