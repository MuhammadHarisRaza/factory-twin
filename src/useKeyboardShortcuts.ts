import { useEffect } from 'react';
import { useTwin, type AlertFilter } from './store';
import { useApp } from './app/store';
import { VIEW_ORDER } from './data/layout';
import { useTwinUi } from './ui/twin/uiStore';

/**
 * Overlays that handle Esc themselves (drawers, dialogs, the twin's menus and search results, the
 * equipment panel's source details — a disclosure, so the other shortcuts keep working while it is open).
 */
export const OVERLAY_SELECTOR = '[role="dialog"], [aria-modal="true"], .tw-views-pop, .tw-search-pop, .eqp-pop';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

/** Next alert filter for the A key: all → serious & critical → off → all. */
export const nextAlertFilter = (f: AlertFilter): AlertFilter => (f === 'all' ? 'serious' : f === 'serious' ? 'off' : 'all');

/**
 * Esc in the Factory Twin closes the most specific context first:
 * camera view → vehicle → equipment workspace → stage highlight → zone (and back to the whole-site view).
 */
export function escapeTwin() {
  const s = useTwin.getState();
  const ui = useTwinUi.getState();
  if (ui.camera) ui.setCamera(null);
  else if (s.vehicle) s.selectVehicle(null);
  else if (s.selected) s.select(null);
  else if (s.stage) s.selectStage(null);
  // Clearing the zone also flies back to the whole-site view.
  else s.selectZone(null);
}

/**
 * Factory Twin only:
 *   1–9, 0  camera views · M flow · R whole factory · F fit · L labels · A alert markers · H presentation mode
 *   Esc     see escapeTwin
 * Anywhere: Esc or H leave presentation mode (which can only be entered in the twin).
 * Esc does nothing to the twin while a drawer, dialog or menu is open — those close themselves.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const s = useTwin.getState();
      if (s.uiHidden && (key === 'escape' || key === 'h')) {
        s.setUiHidden(false);
        return;
      }
      if (useApp.getState().workspace !== 'twin') return;

      // A modal drawer or dialog takes every key: nothing changes in the model behind it.
      const a = useApp.getState();
      if (a.copilotOpen || a.scenariosOpen || document.querySelector('[aria-modal="true"], [role="dialog"]')) return;
      // Menus and search results close themselves on Esc / H.
      if ((key === 'escape' || key === 'h') && document.querySelector(OVERLAY_SELECTOR)) return;
      if (key === 'escape') escapeTwin();
      else if (/^[0-9]$/.test(key)) s.preset(VIEW_ORDER[key === '0' ? 9 : Number(key) - 1]);
      else if (key === 'm') s.toggle('flow');
      else if (key === 'h') s.setUiHidden(true);
      else if (key === 'r') s.reset();
      else if (key === 'f') s.fit();
      else if (key === 'l') s.toggle('labels');
      else if (key === 'a') s.setAlertFilter(nextAlertFilter(s.alertFilter));
    };
    // Capture phase: runs before a drawer or menu closes itself on the same Esc, so it can see that one was open.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
