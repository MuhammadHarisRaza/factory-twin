/**
 * The one 3D scene is shown either as the full Factory Twin or embedded in a page (the Overview
 * hosts it over its <TwinSlot/>, src/app/twinHost.tsx). Embedded, the scene behaves as part of a
 * scrolling page:
 *  - the mouse wheel scrolls the page; the model zooms only with Ctrl / ⌘ held (or a pinch);
 *  - the in-scene label buttons (zone tags, pins, chips) stay clickable but leave the keyboard tab
 *    order — the page offers the keyboard equivalents (zone select, flow strip, "Show in model").
 * The full Factory Twin keeps the default behaviour (wheel zooms, every label is a tab stop).
 * Small and three.js-free, so it can be read outside the scene chunk.
 */
import { useApp } from '../app/store';
import { useTwinHost } from '../app/twinHost';

/** The scene is embedded when a page other than the Factory Twin hosts it. */
export const isEmbedded = (workspace: string, slot: HTMLElement | null) => workspace !== 'twin' && slot != null;

/** Whether the scene is embedded now (for render loops and event handlers). */
export const sceneEmbedded = () => isEmbedded(useApp.getState().workspace, useTwinHost.getState().slot);

/** Whether the scene is embedded (re-renders the caller when that changes). */
export function useSceneEmbedded(): boolean {
  const workspace = useApp((a) => a.workspace);
  const hosted = useTwinHost((h) => h.slot != null);
  return workspace !== 'twin' && hosted;
}

/** tabIndex of an in-scene Html button: out of the tab order while the scene is embedded (mouse clicks still work). */
export const sceneTabIndex = (embedded: boolean): number | undefined => (embedded ? -1 : undefined);

/** `sceneTabIndex` for the current mode, as a hook. */
export const useSceneTabIndex = () => sceneTabIndex(useSceneEmbedded());

/**
 * What a wheel event over the scene does: in the full twin the orbit controls zoom as usual
 * ('controls'); embedded, a plain wheel scrolls the page ('page') and only Ctrl / ⌘ + wheel — also a
 * trackpad pinch, which browsers send as a Ctrl + wheel — zooms the model ('zoom-in' / 'zoom-out').
 */
export function wheelAction(embedded: boolean, e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaY'>): 'controls' | 'page' | 'zoom-in' | 'zoom-out' | 'none' {
  if (!embedded) return 'controls';
  if (!(e.ctrlKey || e.metaKey)) return 'page';
  return e.deltaY < 0 ? 'zoom-in' : e.deltaY > 0 ? 'zoom-out' : 'none';
}
