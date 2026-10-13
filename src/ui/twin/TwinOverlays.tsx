import { useLayoutEffect, useRef } from 'react';
import { useTwin } from '../../store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
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
import { useWidePanel } from './panelWidth';
import { useTwinUi } from './uiStore';
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
 */
export function TwinOverlays() {
  const zonePanel = useTwin((s) => s.zonePanel);
  const selected = useTwin((s) => s.selected);
  const vehicle = useTwin((s) => s.vehicle);
  const stage = useTwin((s) => s.stage);
  // The subjects the Inspector shows in the panel shell (a zone alone keeps its compact summary).
  const subject = !!(vehicle || (selected && EQUIPMENT_BY_ID[selected]) || (stage && MONITORED_STAGE_BY_ID[stage]));
  const wide = useWidePanel() && subject;
  const layout = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);

  // The grid's inner width (whether the wide panel fits), kept current on resize.
  useLayoutEffect(() => {
    const box = layout.current;
    if (!box) return;
    const measure = () => {
      const cs = getComputedStyle(box);
      useTwinUi.getState().setViewW(Math.max(0, Math.round(box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))));
    };
    measure();
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
