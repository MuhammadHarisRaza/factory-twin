/**
 * Width of the Factory Twin's subject panel (equipment, vehicle, production stage). Wide: 70 % of the
 * screen width — the feed (video or camera view) across the panel's top, the details in two columns
 * under it — with the zone list and live list folded away and the scene's view centred in the strip of
 * the 3D view left beside it (src/scene/Scene.tsx ViewInset); at least SCENE_MIN_PX of the view always
 * stays. Compact: the one column at the side. Wide is the default; the header's width button switches
 * and the choice is remembered (src/ui/twin/uiStore.ts). Where the wide panel would be narrower than
 * WIDE_PANEL_MIN_PX (small windows, phones) the panel is compact.
 *
 * The CSS width (src/ui/twin/twin.css `.panel-wide`) is the same formula: min(70vw, 100% − 200px).
 */
import { useEffect, useState } from 'react';
import { useTwinUi } from './uiStore';

/** Share of the screen width the wide panel takes. */
export const WIDE_PANEL_SHARE = 0.7;
/** Width of the 3D view (toolbar and a strip of the model) that always stays beside the wide panel. */
export const SCENE_MIN_PX = 200;
/** Narrowest wide panel (two columns of ~360 px); below it the panel is compact. */
export const WIDE_PANEL_MIN_PX = 720;

/** The wide panel's width in a window `screenW` wide whose overlay grid is `viewW` wide inside. */
export const widePanelWidth = (screenW: number, viewW: number) => Math.min(screenW * WIDE_PANEL_SHARE, viewW - SCENE_MIN_PX);

/** Whether the wide panel fits: two readable columns and a strip of the 3D view beside it. */
export const widePanelFits = (screenW: number, viewW: number) => viewW > 0 && widePanelWidth(screenW, viewW) >= WIDE_PANEL_MIN_PX;

/** Window width, following resizes (0 when rendered on the server). */
function useScreenWidth() {
  const [w, setW] = useState(() => (typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 0));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const on = () => setW(window.innerWidth);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/** Whether the wide panel fits the window now (the width button is only offered then). */
export function useWidePanelFits() {
  const viewW = useTwinUi((s) => s.viewW);
  const screenW = useScreenWidth();
  return widePanelFits(screenW, viewW);
}

/** Whether the subject panel is shown wide now: the viewer's choice, where the window fits it. */
export function useWidePanel() {
  const want = useTwinUi((s) => s.panelWide);
  const fits = useWidePanelFits();
  return want && fits;
}
