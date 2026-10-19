import { useEffect, useLayoutEffect, useRef } from 'react';
import { focusShift, lastFocusPose, useTwin } from '../../store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZonePanel } from '../ZonePanel';
import { Inspector } from '../Inspector';
import { FlowLegend, Toolbar } from '../Toolbar';
import { Minimap } from '../Minimap';
import { Hint } from '../Overlays';
import { TwinStatusBar } from '../TwinStatusBar';
import { ContextBar } from './ContextBar';
import { LineStrip } from './LineStrip';
import { Timeline } from './Timeline';
import { LiveList } from './LiveList';
import { CameraWindow } from './CameraWindow';
import { useTwinUi } from './uiStore';
import { useWideSubjectPanel } from './wideSubject';
import './twin.css';

/**
 * Interface layered over the 3D factory (hidden in presentation mode). One grid places every
 * panel in its own region so nothing overlaps; the empty centre stays the model:
 *
 *   context crumbs · status chips (4, the Overview's KPIs) ─────────────
 *   zones │ rail  [flow legend]        [camera] │ equipment / stage panel
 *         │            3D                       │
 *         │       [hint]            [site plan] │
 *   line status / visit stepper  ·  timeline     │ live list (folds while a panel is open)
 *
 * A wide subject panel (equipment, vehicle or stage — src/ui/twin/panelWidth.ts) takes 70 % of the screen
 * width: the zone list and the live list fold away, the bottom strips run under the whole width, and
 * the width the panel covers is published so the scene centres its view in the strip left beside it.
 * A keyboard user who opened the panel from one of those lists gets focus in the panel, not on <body>.
 */
export function TwinOverlays() {
  const zonePanel = useTwin((s) => s.zonePanel);
  const wide = useWideSubjectPanel();
  const layout = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  // Whether focus was last in the zone list or the live list (both fold away beside the wide panel).
  const inList = useRef(false);
  const wasWide = useRef(false);

  // Tracked on the document: focus anywhere else, or a pointer press outside the lists (the 3D model, a
  // label in the scene), clears it — the hand-over is for a keyboard user leaving a list, nothing else.
  useEffect(() => {
    const inLists = (t: EventTarget | null) => t instanceof Element && !!t.closest('.tw-left, .tw-live');
    const onFocus = (e: FocusEvent) => {
      inList.current = inLists(e.target);
    };
    const onDown = (e: PointerEvent) => {
      if (!inLists(e.target)) inList.current = false;
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, []);

  // The panel turned wide while focus was in a list that now folds away (unmounted: focus fell to <body>;
  // the live list is hidden after this commit): focus moves to the panel.
  useLayoutEffect(() => {
    const opened = wide && !wasWide.current;
    wasWide.current = wide;
    if (!opened || !inList.current || typeof document === 'undefined') return;
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('.tw-live')) {
      right.current?.querySelector<HTMLElement>('.inspector .eqp-b')?.focus({ preventScroll: true });
      inList.current = false;
    }
  }, [wide]);

  // The grid's inner width (whether the wide panel fits), kept current on resize. The first measurement of
  // the visit re-frames a subject framed before the twin was shown (on the Overview's embedded model) with
  // the compact shift, when the panel turns out wide (src/store.ts focusShift) — nothing else.
  useLayoutEffect(() => {
    const box = layout.current;
    if (!box) return;
    const measure = () => {
      const cs = getComputedStyle(box);
      useTwinUi.getState().setViewW(Math.max(0, Math.round(box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))));
    };
    const first = useTwinUi.getState().viewW === 0;
    measure();
    if (first && useTwinUi.getState().viewW > 0)
      requestAnimationFrame(() => {
        if (focusShift() !== 0) return; // compact panel: the earlier pose is already right
        const t = useTwin.getState();
        const f = lastFocusPose();
        // No pose for this subject (a highlight without framing), already wide-framed, or the camera went elsewhere since.
        if (!f || f.shift === 0 || f.nonce !== t.camera.nonce) return;
        if (t.selected === f.id && EQUIPMENT_BY_ID[f.id]) t.focusEquipment(f.id);
        else if (t.stage === f.id && !t.vehicle) t.selectStage(t.stage);
      });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(box);
    return () => ro?.disconnect();
  }, []);

  // The width the wide panel covers at the right of the view (from its column's left edge), kept current on resize.
  useLayoutEffect(() => {
    const set = useTwinUi.getState().setInsetRight;
    const box = layout.current;
    const col = right.current;
    if (!wide || !box || !col) {
      set(0);
      return;
    }
    const measure = () => set(Math.max(0, Math.round(box.getBoundingClientRect().right - col.getBoundingClientRect().left)));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(box);
    ro?.observe(col);
    return () => {
      ro?.disconnect();
      set(0);
    };
  }, [wide]);

  return (
    <div ref={layout} className={`tw-layout ${zonePanel && !wide ? '' : 'no-left'} ${wide ? 'panel-wide' : ''}`}>
      <div className="tw-top">
        <ContextBar />
        <TwinStatusBar />
      </div>
      {zonePanel && !wide && (
        <div className="tw-left">
          <ZonePanel />
        </div>
      )}
      <div className="tw-mid">
        <Toolbar />
        <FlowLegend />
        <CameraWindow />
        <Hint />
        <Minimap />
      </div>
      <div className="tw-right" ref={right}>
        <Inspector />
        <LiveList />
      </div>
      <div className="tw-bottom">
        <LineStrip />
        <Timeline />
      </div>
    </div>
  );
}
