import { useTwin } from '../../store';
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
 */
export function TwinOverlays() {
  const zonePanel = useTwin((s) => s.zonePanel);
  return (
    <div className={`tw-layout ${zonePanel ? '' : 'no-left'}`}>
      <div className="tw-top">
        <ContextBar />
        <TwinStatusBar />
      </div>
      {zonePanel && (
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
      <div className="tw-right">
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
