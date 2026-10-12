/**
 * Showing and hiding the drei Html labels of the 3D twin (pins, chips, zone tags) by opacity in the
 * render loop, without React state. three.js-free, so it is unit-tested without a renderer.
 */

const lastOpacity = new WeakMap<HTMLElement, number>();

/** Below this opacity a label counts as faded out: it no longer catches clicks or keyboard focus. */
export const PIN_HIDDEN_BELOW = 0.3;

/**
 * Shows/hides a pin or label element by opacity without React state. A faded-out element (and
 * every button inside it) neither catches clicks nor keyboard focus — `inert` takes it out of the
 * tab order and the accessibility tree — so Tab never lands on an invisible label (WCAG 2.4.7).
 */
export function setPinOpacity(el: HTMLElement | null, o: number) {
  if (!el) return;
  const v = Math.round(o * 50) / 50;
  if (lastOpacity.get(el) === v) return;
  lastOpacity.set(el, v);
  const hidden = v < PIN_HIDDEN_BELOW;
  el.style.opacity = String(v);
  el.style.pointerEvents = hidden ? 'none' : '';
  el.style.visibility = v === 0 ? 'hidden' : '';
  el.inert = hidden;
}
