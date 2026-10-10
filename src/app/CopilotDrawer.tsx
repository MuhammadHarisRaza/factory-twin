/**
 * Global copilot drawer, opened from the header on every workspace or from links via
 * useApp.openCopilot(prompt?, {eventId?}). It shares one conversation with the Factory Copilot
 * page and the panel docked in the Command Center; while one of those is on screen, opening the
 * copilot asks there and focuses it instead of covering the page.
 *
 * openCopilot(prompt, {eventId}) asks the prompt exactly once, in that event's context; the
 * context then stays shown above the question field until it is cleared.
 */
import { useEffect } from 'react';
import { CopilotPanel } from '../ui/copilot/CopilotPanel';
import { useCopilot } from '../ui/copilot/store';
import { useApp } from './store';

export function CopilotDrawer() {
  const open = useApp((s) => s.copilotOpen);
  const prompt = useApp((s) => s.copilotPrompt);
  const close = useApp((s) => s.closeCopilot);
  const docks = useCopilot((s) => s.docks);
  const toDock = docks > 0;

  useEffect(() => {
    if (!open) return;
    // Read the live values so a prompt is asked exactly once (StrictMode re-runs effects).
    const { copilotPrompt: q, copilotEventId } = useApp.getState();
    if (q) {
      useApp.setState({ copilotPrompt: null });
      useCopilot.getState().ask(q, { eventId: copilotEventId });
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
