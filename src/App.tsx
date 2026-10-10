import { Suspense, lazy } from 'react';
import { useTwin } from './store';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { TopBar } from './ui/TopBar';
import { ZonePanel } from './ui/ZonePanel';
import { Inspector } from './ui/Inspector';
import { FlowLegend, Toolbar } from './ui/Toolbar';
import { Minimap } from './ui/Minimap';
import { Hint, Loader, PresentationExit, SceneErrorBoundary } from './ui/Overlays';

// The 3D scene (three.js + all geometry) loads as its own chunk so the UI shell paints first.
const Scene = lazy(() => import('./scene/Scene'));

export default function App() {
  useKeyboardShortcuts();
  const uiHidden = useTwin((s) => s.uiHidden);

  return (
    <div className={`app ${uiHidden ? 'ui-hidden' : ''}`}>
      <div className="stage">
        <SceneErrorBoundary>
          <Suspense fallback={null}>
            <Scene />
          </Suspense>
        </SceneErrorBoundary>
      </div>
      {!uiHidden && (
        <>
          <TopBar />
          <ZonePanel />
          <Inspector />
          <Toolbar />
          <Minimap />
          <FlowLegend />
          <Hint />
        </>
      )}
      <PresentationExit />
      <Loader />
    </div>
  );
}
