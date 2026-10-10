import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, Minimize2, MousePointerClick, TriangleAlert } from 'lucide-react';
import { useTwin } from '../store';
import { useApp } from '../app/store';

/** Full-screen loader that fades out once the scene has rendered a few frames. */
export function Loader() {
  const ready = useTwin((s) => s.ready);
  // The 3D canvas only renders frames while the Factory Twin is open, so other workspaces never wait for it.
  const twin = useApp((s) => s.workspace === 'twin');
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setGone(true), 600);
    return () => clearTimeout(t);
  }, [ready]);

  if (gone || !twin) return null;
  return (
    <div className={`loader ${ready ? 'fade' : ''}`} role="status">
      <LoaderCircle className="spin" size={28} />
      <div>Building the factory model…</div>
      <small>Procedural geometry · no external assets</small>
    </div>
  );
}

/** Controls hint; disappears 2.5 s after the first interaction. */
export function Hint() {
  const [visible, setVisible] = useState(true);
  const interacted = useRef(false);

  useEffect(() => {
    const onInteract = () => {
      if (interacted.current) return;
      interacted.current = true;
      setTimeout(() => setVisible(false), 2500);
    };
    window.addEventListener('pointerdown', onInteract);
    window.addEventListener('wheel', onInteract);
    return () => {
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('wheel', onInteract);
    };
  }, []);

  if (!visible) return null;
  return (
    <div className="hint overlay-panel">
      <MousePointerClick size={15} />
      <span>
        <b>Drag</b> to orbit · <b>Right-drag</b> to pan · <b>Scroll</b> to zoom · <b>Click</b> a machine to inspect · keys{' '}
        <b>/</b> search, <b>1–0</b> views, <b>M</b> flow, <b>H</b> hide UI
      </span>
    </div>
  );
}

export function PresentationExit() {
  const uiHidden = useTwin((s) => s.uiHidden);
  const setUiHidden = useTwin((s) => s.setUiHidden);
  if (!uiHidden) return null;
  return (
    <button className="btn present-exit" onClick={() => setUiHidden(false)} title="Show the interface (H)">
      <Minimize2 size={15} />
      Exit presentation
    </button>
  );
}

/** Catches WebGL start-up failures and explains them instead of a blank page. */
export class SceneErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || 'Unknown error' };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="scene-error" role="alert">
        <TriangleAlert size={28} />
        <h2>The 3D view could not start</h2>
        <p>
          This usually means WebGL is turned off or unavailable in this browser. Try a current version of Chrome, Edge or
          Firefox with hardware acceleration enabled, then reload.
        </p>
        <code>{this.state.error}</code>
      </div>
    );
  }
}
