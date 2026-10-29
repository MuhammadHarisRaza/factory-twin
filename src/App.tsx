import { Suspense, lazy, useEffect, useRef, useState, type ComponentType } from 'react';
import { Expand, Presentation, RotateCcw } from 'lucide-react';
import { useTwin } from './store';
import { PERIOD_WORKSPACES, WORKSPACE_BY_ID, useApp, type WorkspaceId } from './app/store';
import { Header, Sidebar } from './app/Shell';
import { ScenarioDrawer } from './app/ScenarioDrawer';
import { CopilotDrawer } from './app/CopilotDrawer';
import { EvidenceCapture } from './app/EvidenceCapture';
import { SceneFailureFlag, useFollowSlot, useTwinHost } from './app/twinHost';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { Loader, PresentationExit, SceneErrorBoundary } from './ui/Overlays';
import { TwinOverlays } from './ui/twin/TwinOverlays';
import { TwinSearch } from './ui/twin/Search';
// The 3D scene (three.js + all geometry) loads as its own chunk so the shell paints first.
const Scene = lazy(() => import('./scene/Scene'));

// Workspaces load on first visit (each in its own chunk); the 3D scene is always mounted.
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
      <button className="btn ghost" onClick={reset} title="Return to the whole factory and clear the selection (R)" aria-label="Whole factory">
        <RotateCcw size={14} />
        <span className="btn-label">Whole factory</span>
      </button>
      <button className="btn ghost" onClick={() => setUiHidden(true)} title="Presentation mode — hide the interface; the demo mark stays visible (H, Esc to leave)" aria-label="Present">
        <Presentation size={14} />
        <span className="btn-label">Present</span>
      </button>
    </div>
  );
}

type TwinMode = 'full' | 'embedded' | 'hidden';

/**
 * The one 3D factory. Full size in the Factory Twin, embedded over a page's <TwinSlot/> (the
 * Overview), hidden — but kept alive, with rendering paused — everywhere else.
 */
function TwinWorkspace({ mode }: { mode: TwinMode }) {
  const uiHidden = useTwin((s) => s.uiHidden);
  const slot = useTwinHost((s) => s.slot);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useFollowSlot(mode === 'embedded' ? host : null, slot);
  const active = mode !== 'hidden';
  return (
    <div ref={setHost} className={`twin ${mode === 'embedded' ? 'embedded' : ''}`} style={{ visibility: active ? 'visible' : 'hidden' }} aria-hidden={!active}>
      <div className="stage">
        <SceneErrorBoundary>
          <SceneFailureFlag>
            <Suspense fallback={null}>
              <Scene active={active} />
            </Suspense>
          </SceneFailureFlag>
        </SceneErrorBoundary>
      </div>
      {mode === 'full' && !uiHidden && <TwinOverlays />}
      {mode === 'full' && <PresentationExit />}
    </div>
  );
}

const PAGES: Record<Exclude<WorkspaceId, 'twin'>, ComponentType> = {
  overview: page(() => import('./pages/OverviewPage'), 'OverviewPage'),
  production: page(() => import('./pages/ProductionPage'), 'ProductionPage'),
  quality: page(() => import('./pages/QualityPage'), 'QualityPage'),
  fleet: page(() => import('./pages/FleetPage'), 'FleetPage'),
  events: page(() => import('./pages/EventsPage'), 'EventsPage'),
  compliance: page(() => import('./pages/CompliancePage'), 'CompliancePage'),
  copilot: page(() => import('./pages/CopilotPage'), 'CopilotPage'),
};

export default function App() {
  useKeyboardShortcuts();
  const workspace = useApp((s) => s.workspace);
  const collapsed = useApp((s) => s.navCollapsed);
  const presenting = useTwin((s) => s.uiHidden);
  const slot = useTwinHost((s) => s.slot);
  const sceneFailed = useTwinHost((s) => s.sceneError != null);
  const twin = workspace === 'twin';
  const Page = twin ? null : PAGES[workspace];
  const mode: TwinMode = twin ? 'full' : slot ? 'embedded' : 'hidden';
  // Each workspace opens at its top (the content area is shared, so it would keep the last scroll position).
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [workspace]);

  return (
    <div className={`shell ${collapsed ? 'nav-collapsed' : ''} ${presenting ? 'presenting' : ''}`}>
      <Sidebar />
      <div className="main">
        <Header title={WORKSPACE_BY_ID[workspace].title} showTitle={twin} period={PERIOD_WORKSPACES.includes(workspace)} actions={twin ? <TwinActions /> : undefined} />
        <main ref={content} className={`content ${twin ? 'immersive' : ''}`}>
          {Page && (
            <Suspense fallback={<div className="page-loading" role="status">Loading workspace…</div>}>
              <Page />
            </Suspense>
          )}
          {/* After the page in DOM order, so keyboard focus reaches the page title and KPIs before in-scene labels
              (the embedded scene is positioned over its slot; stacking is set in CSS). */}
          <TwinWorkspace mode={mode} />
        </main>
      </div>
      <ScenarioDrawer />
      <CopilotDrawer />
      <EvidenceCapture />
      {/* The full-size loader would cover the scene's error message. */}
      {!sceneFailed && <Loader />}
    </div>
  );
}
