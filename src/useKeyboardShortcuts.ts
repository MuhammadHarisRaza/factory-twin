import { useEffect } from 'react';
import { useTwin } from './store';
import { VIEW_ORDER } from './data/layout';

/**
 * 1–9, 0  camera views
 * Esc     exit presentation → deselect machine → clear zone
 * M flow mode · H hide UI · R reset · F fit · L labels
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useTwin.getState();
      const key = e.key.toLowerCase();

      if (/^[0-9]$/.test(key)) {
        s.preset(VIEW_ORDER[key === '0' ? 9 : Number(key) - 1]);
      } else if (key === 'escape') {
        if (s.uiHidden) s.setUiHidden(false);
        else if (s.selected) s.select(null);
        else s.selectZone(null);
      } else if (key === 'm') s.toggle('flow');
      else if (key === 'h') s.setUiHidden(!s.uiHidden);
      else if (key === 'r') s.reset();
      else if (key === 'f') s.fit();
      else if (key === 'l') s.toggle('labels');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
