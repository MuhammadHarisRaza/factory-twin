import { useEffect } from 'react';
import { useTwin } from './store';
import { useApp } from './app/store';
import { VIEW_ORDER } from './data/layout';
import { useTwinUi } from './ui/twin/uiStore';

/** Overlays that handle Esc themselves (drawers, dialogs, the twin's views menu and search results). */
const OVERLAY_SELECTOR = '[role="dialog"], [aria-modal="true"], .tw-views-pop, .tw-search-pop';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

/**
 * Factory Twin only:
 *   1–9, 0  camera views · M flow · R reset · F fit · L labels · H presentation mode
 *   Esc     close the camera view → deselect vehicle → deselect asset → clear zone
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

      if (key === 'escape' || key === 'h') {
        const a = useApp.getState();
        if (a.copilotOpen || a.scenariosOpen || document.querySelector(OVERLAY_SELECTOR)) return;
      }
      if (key === 'escape') {
        const ui = useTwinUi.getState();
        if (ui.camera) ui.setCamera(null);
        else if (s.vehicle) s.selectVehicle(null);
        else if (s.selected) s.select(null);
        else s.selectZone(null);
      } else if (/^[0-9]$/.test(key)) s.preset(VIEW_ORDER[key === '0' ? 9 : Number(key) - 1]);
      else if (key === 'm') s.toggle('flow');
      else if (key === 'h') s.setUiHidden(true);
      else if (key === 'r') s.reset();
      else if (key === 'f') s.fit();
      else if (key === 'l') s.toggle('labels');
    };
    // Capture phase: runs before a drawer or menu closes itself on the same Esc, so it can see that one was open.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
