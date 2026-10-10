import { useState } from 'react';
import {
  Activity,
  BrickWall,
  Camera,
  Cog,
  Construction,
  Forklift,
  House,
  Map as MapIcon,
  Route,
  Rows3,
  Tag,
  Truck,
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
  status: Activity,
  internal: Forklift,
  external: Truck,
};

/** Short toolbar captions (full names in the tooltip). */
const SHORT: Partial<Record<LayerId, string>> = {
  walls: 'Walls',
  flow: 'Flow',
  status: 'Status',
  internal: 'Forklifts',
  external: 'Trucks',
};

const GROUPS: { label: string; layers: LayerId[] }[] = [
  { label: 'Building', layers: ['roof', 'walls', 'structure'] },
  { label: 'Production', layers: ['equipment', 'conveyors', 'status', 'flow'] },
  { label: 'Logistics', layers: ['internal', 'external'] },
  { label: 'Overlays', layers: ['labels', 'minimap'] },
];

/** Bottom toolbar: views pop-up and grouped layer toggles. */
export function Toolbar() {
  const layers = useTwin((s) => s.layers);
  const toggle = useTwin((s) => s.toggle);
  const preset = useTwin((s) => s.preset);
  const [viewsOpen, setViewsOpen] = useState(false);

  return (
    <div className="twin-toolbar overlay-panel" role="toolbar" aria-label="View and layer controls">
      <div className="tb-group">
        <button className={`tool ${viewsOpen ? 'on' : ''}`} onClick={() => setViewsOpen(!viewsOpen)} aria-expanded={viewsOpen} title="Camera views (1–0)">
          <Camera size={17} />
          <span>Views</span>
        </button>
        {viewsOpen && (
          <div className="views-pop overlay-panel" onMouseLeave={() => setViewsOpen(false)}>
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
      {GROUPS.map((g) => (
        <div key={g.label} style={{ display: 'contents' }}>
          <div className="tb-sep" />
          <div className="tb-group" role="group" aria-label={g.label}>
            {g.layers.map((layer) => {
              const Icon = LAYER_ICONS[layer];
              const on = layers[layer];
              return (
                <button
                  key={layer}
                  className={`tool ${on ? 'on' : 'off'}`}
                  onClick={() => toggle(layer)}
                  aria-pressed={on}
                  title={`${on ? 'Hide' : 'Show'} ${LAYER_LABELS[layer].toLowerCase()}${layer === 'flow' ? ' (M)' : layer === 'labels' ? ' (L)' : ''}`}
                >
                  <Icon size={17} />
                  <span>{SHORT[layer] ?? LAYER_LABELS[layer]}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function FlowLegend() {
  const flow = useTwin((s) => s.layers.flow);
  if (!flow) return null;
  return (
    <div className="flow-legend overlay-panel">
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
