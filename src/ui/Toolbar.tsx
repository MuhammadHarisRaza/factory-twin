import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  BrickWall,
  Camera,
  Cog,
  Construction,
  Forklift,
  House,
  Map as MapIcon,
  PanelLeftClose,
  PanelLeftOpen,
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
import { QUICK_VIEWS } from './twin/quickViews';
import { useTip } from './twin/Tip';

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

/** Display names in the rail (consistent with the scene's legends). */
const NAMES: Partial<Record<LayerId, string>> = {
  walls: 'Walls',
  internal: 'Forklifts',
  external: 'Trucks',
};
const KEYS: Partial<Record<LayerId, string>> = { flow: 'M', labels: 'L' };

const GROUPS: { label: string; layers: LayerId[] }[] = [
  { label: 'Building', layers: ['roof', 'walls', 'structure'] },
  { label: 'Production', layers: ['equipment', 'conveyors', 'status', 'flow'] },
  { label: 'Logistics', layers: ['internal', 'external'] },
  { label: 'Overlays', layers: ['labels', 'minimap'] },
];

type TipKey = 'zones' | 'views' | LayerId;

/** Camera views + quick views, opened beside the rail (portal, so the rail can scroll). */
function ViewsMenu({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const preset = useTwin((s) => s.preset);
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchor.top, window.innerHeight - h - 8)));
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Defer so the click that opened the menu does not close it.
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
  }, []);
  return createPortal(
    <div ref={ref} className="tw-views-pop overlay-panel" style={{ left: anchor.right + 8, top }} role="menu" aria-label="Camera views">
      <div className="tw-pop-h">Camera views</div>
      {VIEW_ORDER.map((id, i) => (
        <button
          key={id}
          role="menuitem"
          onClick={() => {
            preset(id);
            onClose();
          }}
        >
          <kbd>{viewShortcut(i)}</kbd>
          {VIEWS[id].label}
        </button>
      ))}
      <div className="tw-pop-h">Quick views · from the current state</div>
      {QUICK_VIEWS.map((q) => {
        const Icon = q.icon;
        return (
          <button
            key={q.id}
            role="menuitem"
            title={q.hint}
            onClick={() => {
              q.run();
              onClose();
            }}
          >
            <Icon size={14} aria-hidden />
            {q.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** Vertical view & layer rail at the left edge of the scene. */
export function Toolbar() {
  const layers = useTwin((s) => s.layers);
  const toggle = useTwin((s) => s.toggle);
  const zonePanel = useTwin((s) => s.zonePanel);
  const setZonePanel = useTwin((s) => s.setZonePanel);
  const [views, setViews] = useState<DOMRect | null>(null);
  const tip = useTip<TipKey>();

  return (
    <div className="tw-rail overlay-panel" role="toolbar" aria-orientation="vertical" aria-label="View and layer controls">
      <button
        className={`tw-tool ${zonePanel ? 'on' : ''}`}
        onClick={() => setZonePanel(!zonePanel)}
        aria-pressed={zonePanel}
        aria-label={zonePanel ? 'Hide zones & views panel' : 'Show zones & views panel'}
        {...tip.bind('zones', 'right')}
      >
        {zonePanel ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
      </button>
      <button
        className={`tw-tool ${views ? 'on' : ''}`}
        onClick={(e) => {
          tip.hide();
          setViews(views ? null : e.currentTarget.getBoundingClientRect());
        }}
        aria-expanded={!!views}
        aria-haspopup="menu"
        aria-label="Camera views"
        {...tip.bind('views', 'right')}
      >
        <Camera size={17} />
      </button>
      {views && <ViewsMenu anchor={views} onClose={() => setViews(null)} />}
      {GROUPS.map((g) => (
        <div key={g.label} className="tw-rail-g" role="group" aria-label={g.label}>
          {g.layers.map((layer) => {
            const Icon = LAYER_ICONS[layer];
            const on = layers[layer];
            return (
              <button
                key={layer}
                className={`tw-tool ${on ? 'on' : 'off'}`}
                onClick={() => toggle(layer)}
                aria-pressed={on}
                aria-label={`${NAMES[layer] ?? LAYER_LABELS[layer]}${KEYS[layer] ? ` (${KEYS[layer]})` : ''}`}
                {...tip.bind(layer, 'right')}
              >
                <Icon size={17} />
              </button>
            );
          })}
        </div>
      ))}
      {tip.render((key) => {
        if (key === 'zones') return <b>{zonePanel ? 'Hide' : 'Show'} zones & views panel</b>;
        if (key === 'views') return <b>Camera views · keys 1–0</b>;
        const on = layers[key];
        const group = GROUPS.find((g) => g.layers.includes(key))!.label;
        return (
          <>
            <b>
              {NAMES[key] ?? LAYER_LABELS[key]}
              {KEYS[key] ? ` · ${KEYS[key]}` : ''}
            </b>
            <div className="tw-tip-row">
              {group} layer · {on ? 'shown — click to hide' : 'hidden — click to show'}
            </div>
          </>
        );
      })}
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
