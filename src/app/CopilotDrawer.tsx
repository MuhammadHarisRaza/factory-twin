/**
 * Global copilot drawer, opened from the header on every workspace or from links via
 * useApp.openCopilot(prompt?, {eventId?}). It uses the same engine and conversation as the Copilot
 * workspace, in the context of the workspace it is opened from — its reporting period, the incident
 * open there (or chosen for the copilot), the equipment selected in the twin, the stage open in
 * Production — shown as chips above the question field. While the Copilot workspace is on screen,
 * opening the copilot asks there and focuses it instead of covering the page.
 *
 * openCopilot(prompt, {eventId}) asks the prompt exactly once, in that event's context; the
 * context then stays shown until it is removed.
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
      useCopilot.getState().ask(q, copilotEventId ? { eventId: copilotEventId } : undefined);
    }
    if (toDock) {
      useCopilot.getState().focusDock();
      useApp.getState().closeCopilot();
    }
  }, [open, prompt, toDock]);

  useEffect(() => {
    if (!open || toDock) return;
    // Capture phase + preventDefault: this Esc is the drawer's (panels behind it skip default-prevented keys).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    // Return focus to where the user was when the drawer closes.
    const before = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    return () => {
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.({ preventScroll: true });
    };
  }, [open, toDock, close]);

  if (!open || toDock) return null;
  return (
    <>
      <div className="drawer-scrim" onClick={close} />
      <aside className="drawer cp-drawer" role="dialog" aria-modal="true" aria-label="Copilot">
        <CopilotPanel variant="drawer" onClose={close} onNavigate={close} autoFocus />
      </aside>
    </>
  );
}
