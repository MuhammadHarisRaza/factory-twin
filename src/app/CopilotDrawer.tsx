/**
 * Global copilot drawer (opened from the header or from links via useApp.openCopilot).
 * It shares one conversation with the panel docked in the Command Center; while that
 * dock is on screen, opening the copilot focuses the dock instead of covering the page.
 */
import { useEffect } from 'react';
import { CopilotPanel } from '../ui/copilot/CopilotPanel';
import { useCopilot } from '../ui/copilot/store';
import { useApp } from './store';

export function CopilotDrawer() {
  const open = useApp((s) => s.copilotOpen);
  const prompt = useApp((s) => s.copilotPrompt);
  const workspace = useApp((s) => s.workspace);
  const close = useApp((s) => s.closeCopilot);
  const docks = useCopilot((s) => s.docks);
  const toDock = docks > 0 && workspace === 'command';

  useEffect(() => {
    if (!open) return;
    // Read the live value so a prompt is asked exactly once (StrictMode re-runs effects).
    const q = useApp.getState().copilotPrompt;
    if (q) {
      useApp.setState({ copilotPrompt: null });
      useCopilot.getState().ask(q);
    }
    if (toDock) {
      useCopilot.getState().focusDock();
      useApp.getState().closeCopilot();
    }
  }, [open, prompt, toDock]);

  useEffect(() => {
    if (!open || toDock) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, toDock, close]);

  if (!open || toDock) return null;
  return (
    <>
      <div className="drawer-scrim" onClick={close} />
      <aside className="drawer cp-drawer" role="dialog" aria-label="Copilot">
        <CopilotPanel variant="drawer" onClose={close} onNavigate={close} autoFocus />
      </aside>
    </>
  );
}
