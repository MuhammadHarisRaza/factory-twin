import { useState } from 'react';
import {
  BrickWall,
  Camera,
  Cog,
  Construction,
  House,
  Map as MapIcon,
  Route,
  Rows3,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { LAYER_LABELS, useTwin, type LayerId } from '../store';
import { FLOW_COLORS, FLOW_LABELS, VIEWS, VIEW_ORDER } from '../data/layout';
import type { FlowKind } from '../data/types';
import { viewShortcut } from './ZonePanel';

const LAYER_ICONS: Record<LayerId, LucideIcon> = {
  roof: House,
  walls: BrickWall,
  structure: Construction,
  equipment: Cog,
  conveyors: Rows3,
  flow: Route,
  labels: Tag,
  minimap: MapIcon,
};

const TOGGLE_LAYERS: LayerId[] = ['roof', 'walls', 'structure', 'equipment', 'conveyors', 'labels', 'minimap'];

/** Bottom toolbar: views pop-up, layer toggles and flow mode. */
export function Toolbar() {
  const layers = useTwin((s) => s.layers);
  const toggle = useTwin((s) => s.toggle);
  const preset = useTwin((s) => s.preset);
  const [viewsOpen, setViewsOpen] = useState(false);

  return (
    <div className="toolbar" role="toolbar" aria-label="View controls">
      <div className="tb-group">
        <button className={`tool ${viewsOpen ? 'on' : ''}`} onClick={() => setViewsOpen(!viewsOpen)} aria-expanded={viewsOpen}>
          <Camera size={17} />
          <span>Views</span>
        </button>
        {viewsOpen && (
          <div className="views-pop" onMouseLeave={() => setViewsOpen(false)}>
            {VIEW_ORDER.map((id, i) => (
              <button
                key={id}
                onClick={() => {
                  preset(id);
                  setViewsOpen(false);
                }}
              >
                <kbd>{viewShortcut(i)}</kbd>
                {VIEWS[id].label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tb-sep" />
      <div className="tb-group">
        {TOGGLE_LAYERS.map((layer) => {
          const Icon = LAYER_ICONS[layer];
          const on = layers[layer];
          return (
            <button
              key={layer}
              className={`tool ${on ? 'on' : 'off'}`}
              onClick={() => toggle(layer)}
              aria-pressed={on}
              title={`${on ? 'Hide' : 'Show'} ${LAYER_LABELS[layer].toLowerCase()}`}
            >
              <Icon size={17} />
              <span>{LAYER_LABELS[layer]}</span>
            </button>
          );
        })}
      </div>
      <div className="tb-sep" />
      <button
        className={`tool flow ${layers.flow ? 'on' : 'off'}`}
        onClick={() => toggle('flow')}
        aria-pressed={layers.flow}
        title="Show the process route from raw materials to dispatch (M)"
      >
        <Route size={17} />
        <span>Flow mode</span>
      </button>
    </div>
  );
}

export function FlowLegend() {
  const flow = useTwin((s) => s.layers.flow);
  if (!flow) return null;
  return (
    <div className="flow-legend">
      <div className="fl-t">Material flow · intended process route</div>
      {(Object.keys(FLOW_COLORS) as FlowKind[]).map((kind) => (
        <div key={kind} className="fl-r">
          <i style={{ background: FLOW_COLORS[kind] }} />
          {FLOW_LABELS[kind]}
        </div>
      ))}
      <div className="fl-n">Numbers mark the 11 process stages. This shows routing, not a production simulation.</div>
    </div>
  );
}
