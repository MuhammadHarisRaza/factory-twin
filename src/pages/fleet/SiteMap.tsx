/**
 * 2D site map for Vehicle Monitoring (simulated positions, zone level). Static layers (roads,
 * yards, buildings, geofences, docks) re-render once per simulated minute; vehicle glyphs are
 * positioned from `poseAt(vehicle, simClock.t)` in a requestAnimationFrame loop (~12 fps) that
 * writes SVG transforms directly, so motion is smooth without React renders per frame. The
 * selected vehicle's travelled route (trucks: since arrival; internal vehicles: last 15 min) is
 * drawn on the ground in the same loop.
 *
 * Coordinates are the 3D model's ground plane: x → right, z → down (south, main gate).
 */
import { useEffect, useId, useRef } from 'react';
import { HALL, LINK, PARKING, PAVED, RAW_SHED, ROADS, SPRAY_TOWER, WAREHOUSE, WORKSHOP } from '../../data/layout';
import type { Rect } from '../../data/types';
import { GEOFENCES } from '../../model/plant';
import type { Vehicle } from '../../model/types';
import { poseAt } from '../../sim/logistics';
import { simClock, useSim, useSimValue } from '../../sim/store';
import { dockBoard, type DockStatus } from './derive';
import { trail, trailPath } from './pipeline';

/** Route history drawn for a selected internal vehicle (min). */
export const INTERNAL_TRAIL_MIN = 15;

export type MapView = 'site' | 'warehouse';

const VIEWS: Record<MapView, { x: [number, number]; z: [number, number]; fs: number; dot: number }> = {
  site: { x: [-152, 152], z: [-80, 118], fs: 4, dot: 2.1 },
  warehouse: { x: [-146, -30], z: [0, 100], fs: 2, dot: 1.15 },
};

const BUILDINGS: { name: string; rect: Rect; short?: string }[] = [
  { name: 'Production hall', rect: HALL.rect },
  { name: 'Raw-material shed', rect: RAW_SHED.rect, short: 'Raw shed' },
  { name: 'Finished-goods warehouse', rect: WAREHOUSE.rect, short: 'Warehouse' },
  { name: 'Spray dryer', rect: SPRAY_TOWER.rect, short: 'Spray dryer' },
  { name: 'Maintenance workshop', rect: WORKSHOP.rect, short: 'Workshop' },
  { name: '', rect: LINK.rect },
];

/** Rack rows inside the warehouse (centre z), shown at the warehouse scale. */
const RACK_ROWS_Z = [9.6, 16.1, 22.6, 29.1, 35.6, 42.1];
const RACK_X: [number, number] = [-128, -95];
const DOCK_FRONT = 62.4;

const DOCK_SHORT: Record<DockStatus, string> = { free: 'Free', reserved: 'Reserved', loading: 'Loading', paperwork: 'Paperwork', held: 'Held' };

const rectProps = (r: Rect) => ({ x: r.x[0], y: r.z[0], width: r.x[1] - r.x[0], height: r.z[1] - r.z[0] });
const deg = (heading: number) => ((-heading * 180) / Math.PI).toFixed(1);

const vehicleClass = (v: Vehicle) =>
  v.type === 'outbound-truck' ? 'veh-out' : v.type === 'inbound-tipper' ? 'veh-in' : v.type === 'wheel-loader' ? 'veh-wl' : 'veh-fl';

export function SiteMap({ view, selectedId, onSelect }: { view: MapView; selectedId: string | null; onSelect: (id: string) => void }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const vb = VIEWS[view];
  const nodes = useRef(new Map<string, SVGGElement>());
  const trailRef = useRef<SVGPathElement>(null);
  const selRef = useRef(selectedId);
  useEffect(() => {
    selRef.current = selectedId;
  }, [selectedId]);

  const vehicles = useSimValue((s) => s.logistics.active.map((id) => s.logistics.vehicles[id]));
  const docks = useSimValue((s) => dockBoard(s));

  useEffect(() => {
    let raf = 0;
    let last = -1e9;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (ts - last < 75) return;
      last = ts;
      const L = useSim.getState().sim.logistics;
      const t = simClock.t;
      for (const [id, g] of nodes.current) {
        const v = L.vehicles[id];
        const p = v ? poseAt(v, t) : null;
        if (!p) {
          g.setAttribute('visibility', 'hidden');
          continue;
        }
        g.setAttribute('visibility', 'visible');
        g.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.z.toFixed(2)})`);
        (g.firstElementChild as SVGGElement | null)?.setAttribute('transform', `rotate(${deg(p.heading)})`);
      }
      const path = trailRef.current;
      if (path) {
        const v = selRef.current ? L.vehicles[selRef.current] : undefined;
        path.setAttribute('d', v && poseAt(v, t) ? trailPath(trail(v, v.class === 'external' ? v.spawned : t - INTERNAL_TRAIL_MIN, t)) : '');
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const t0 = simClock.t;
  const fs = vb.fs;
  const showAllLabels = view === 'warehouse';
  const hatch = `hatch-${uid}`;
  const hatchR = `hatchr-${uid}`;
  const clip = `clip-${uid}`;

  return (
    <svg
      className="fleet-map"
      viewBox={`${vb.x[0]} ${vb.z[0]} ${vb.x[1] - vb.x[0]} ${vb.z[1] - vb.z[0]}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={view === 'site' ? 'Site map with simulated vehicle positions' : 'Warehouse and dispatch yard with simulated vehicle positions'}
    >
      <defs>
        <pattern id={hatch} patternUnits="userSpaceOnUse" width={fs * 0.9} height={fs * 0.9} patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={fs * 0.9} className="fm-hatch" strokeWidth={fs * 0.12} />
        </pattern>
        <pattern id={hatchR} patternUnits="userSpaceOnUse" width={fs * 0.6} height={fs * 0.6} patternTransform="rotate(-45)">
          <line x1={0} y1={0} x2={0} y2={fs * 0.6} className="fm-hatch-r" strokeWidth={fs * 0.14} />
        </pattern>
        <clipPath id={clip}>
          <rect x={vb.x[0]} y={vb.z[0]} width={vb.x[1] - vb.x[0]} height={vb.z[1] - vb.z[0]} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect className="fm-ground" x={vb.x[0]} y={vb.z[0]} width={vb.x[1] - vb.x[0]} height={vb.z[1] - vb.z[0]} />
        {PAVED.map((r, i) => (
          <rect key={`p${i}`} className="fm-paved" {...rectProps(r)} />
        ))}
        <rect className="fm-paved" {...rectProps(PARKING)} />
        {ROADS.map((r, i) => (
          <rect key={`r${i}`} className="fm-road" {...rectProps(r)} />
        ))}

        {BUILDINGS.map((b, i) => (
          <rect key={`b${i}`} className="fm-bldg" {...rectProps(b.rect)} strokeWidth={fs * 0.08} />
        ))}
        {view === 'warehouse' &&
          RACK_ROWS_Z.map((z) => <rect key={z} className="fm-rack" x={RACK_X[0]} y={z - 1.4} width={RACK_X[1] - RACK_X[0]} height={2.8} />)}
        {BUILDINGS.filter((b) => b.name).map((b) => {
          const cx = (b.rect.x[0] + b.rect.x[1]) / 2;
          const z = view === 'warehouse' && b.rect === WAREHOUSE.rect ? b.rect.z[0] + fs * 1.6 : (b.rect.z[0] + b.rect.z[1]) / 2;
          return (
            <text key={b.name} className="fm-bldg-label" x={cx} y={z} fontSize={fs * 0.95} textAnchor="middle" dominantBaseline="middle">
              {view === 'site' ? (b.short ?? b.name) : b.name}
            </text>
          );
        })}

        {/* Geofences */}
        {GEOFENCES.filter((g) => g.id !== 'GF-SITE').map((g) => {
          const r = rectProps(g.rect);
          const cls =
            g.kind === 'restricted' ? 'gf-restricted' : g.kind === 'holding' ? 'gf-holding' : g.kind === 'dock' ? 'gf-dock' : g.kind === 'gate' ? 'gf-gate' : 'gf-zone';
          const fill = g.kind === 'restricted' ? `url(#${hatchR})` : g.kind === 'holding' ? `url(#${hatch})` : 'none';
          return (
            <rect key={g.id} className={`gf ${cls}`} {...r} fill={fill} strokeWidth={fs * (g.kind === 'zone' ? 0.07 : 0.1)} strokeDasharray={g.kind === 'zone' ? `${fs * 0.5} ${fs * 0.35}` : undefined}>
              <title>{g.name}</title>
            </rect>
          );
        })}
        {GEOFENCES.filter((g) => ['holding', 'gate'].includes(g.kind) || g.id === 'GF-YARD' || g.id === 'GF-RCV' || (view === 'warehouse' && ['GF-STG', 'GF-PUT', 'GF-PACK'].includes(g.id))).map((g) => (
          <text
            key={`l-${g.id}`}
            className="fm-gf-label"
            x={g.rect.x[0] + fs * 0.4}
            y={g.id === 'GF-YARD' ? g.rect.z[1] - fs * 0.5 : g.rect.z[0] + fs * 1.1}
            fontSize={fs * 0.78}
          >
            {g.name}
          </text>
        ))}

        {/* Docks with occupancy */}
        {docks.map((d) => (
          <g key={d.id} className={`fm-dock ${d.status}`}>
            <rect x={d.x - 3} y={WAREHOUSE.rect.z[1]} width={6} height={DOCK_FRONT - WAREHOUSE.rect.z[1]} strokeWidth={fs * 0.09} />
            <text x={d.x} y={WAREHOUSE.rect.z[1] - fs * 0.45} fontSize={fs * 0.72} textAnchor="middle" className="fm-dock-label">
              {view === 'site' ? `D${d.id.slice(5)}` : `D${d.id.slice(5)} · ${DOCK_SHORT[d.status]}`}
            </text>
            <title>{`${d.name}: ${DOCK_SHORT[d.status]}${d.truck ? ` · ${d.truck.id}` : ''}`}</title>
          </g>
        ))}

        {/* Selected vehicle's travelled route (updated in the animation loop) */}
        <path ref={trailRef} className="fm-trail" strokeWidth={fs * 0.22} fill="none" />

        {/* Vehicles */}
        {vehicles.map((v) => {
          const p = poseAt(v, t0);
          const sel = v.id === selectedId;
          const truck = v.class === 'external';
          return (
            <g
              key={v.id}
              ref={(el) => {
                if (!el) return;
                nodes.current.set(v.id, el);
                return () => {
                  nodes.current.delete(v.id);
                };
              }}
              className={`fm-veh ${vehicleClass(v)} ${sel ? 'sel' : ''}`}
              transform={p ? `translate(${p.x.toFixed(2)} ${p.z.toFixed(2)})` : undefined}
              visibility={p ? 'visible' : 'hidden'}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(v.id);
              }}
            >
              <g transform={p ? `rotate(${deg(p.heading)})` : undefined}>
                {truck ? (
                  <>
                    <rect className="hit" x={-8.5} y={-3.2} width={17} height={6.4} />
                    <rect className="body" x={-7.2} y={-1.25} width={12.2} height={2.5} rx={0.3} />
                    <path className="cab" d="M5.2,-1.25 H6.6 L7.4,-0.5 V0.5 L6.6,1.25 H5.2 Z" />
                  </>
                ) : (
                  <>
                    <circle className="hit" r={vb.dot * 2} />
                    <circle className="body" r={vb.dot} />
                    <line className="tick" x1={0} y1={0} x2={vb.dot * 1.7} y2={0} strokeWidth={vb.dot * 0.45} />
                  </>
                )}
              </g>
              {sel && (truck ? <circle className="ring" r={9.5} strokeWidth={fs * 0.16} /> : <circle className="ring" r={vb.dot * 2.3} strokeWidth={fs * 0.16} />)}
              {(sel || showAllLabels) && (
                <text className={`fm-veh-label ${sel ? 'sel' : ''}`} x={truck ? 0 : vb.dot * 1.6} y={truck ? -4 : -vb.dot * 1.6} fontSize={fs * (sel ? 0.85 : 0.7)} textAnchor={truck ? 'middle' : 'start'}>
                  {v.id}
                </text>
              )}
              <title>{`${v.id} · ${v.label}`}</title>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** Map legend (vehicle glyphs and geofence styles). */
export function MapLegend() {
  return (
    <div className="fleet-legend">
      <span>
        <svg width="22" height="10" aria-hidden>
          <rect className="lg-out" x="1" y="2.5" width="16" height="5" rx="1" />
          <rect className="lg-out-cab" x="17" y="2.5" width="4" height="5" rx="1" />
        </svg>
        Outbound truck
      </span>
      <span>
        <svg width="22" height="10" aria-hidden>
          <rect className="lg-in" x="1" y="2.5" width="16" height="5" rx="1" />
          <rect className="lg-out-cab" x="17" y="2.5" width="4" height="5" rx="1" />
        </svg>
        Inbound tipper
      </span>
      <span>
        <svg width="12" height="12" aria-hidden>
          <circle className="lg-fl" cx="6" cy="6" r="4" />
        </svg>
        Forklift
      </span>
      <span>
        <svg width="12" height="12" aria-hidden>
          <circle className="lg-wl" cx="6" cy="6" r="4" />
        </svg>
        Wheel loader
      </span>
      <span className="sep" />
      <span>
        <svg width="16" height="12" aria-hidden>
          <rect className="lg-holding" x="1" y="1" width="14" height="10" />
        </svg>
        Holding area
      </span>
      <span>
        <svg width="16" height="12" aria-hidden>
          <rect className="lg-dockzone" x="1" y="1" width="14" height="10" />
        </svg>
        Dock geofence
      </span>
      <span>
        <svg width="16" height="12" aria-hidden>
          <rect className="lg-zone" x="1" y="1" width="14" height="10" />
        </svg>
        Yard / operating zone
      </span>
      <span>
        <svg width="16" height="12" aria-hidden>
          <rect className="lg-restricted" x="1" y="1" width="14" height="10" />
        </svg>
        Restricted zone
      </span>
      <span className="sep" />
      <span>
        <svg width="16" height="12" aria-hidden>
          <rect className="lg-dock loading" x="1" y="2" width="14" height="8" />
        </svg>
        Dock occupied
      </span>
      <span>
        <svg width="16" height="12" aria-hidden>
          <rect className="lg-dock reserved" x="1" y="2" width="14" height="8" />
        </svg>
        Dock reserved
      </span>
      <span className="sep" />
      <span>
        <svg width="18" height="10" aria-hidden>
          <path className="lg-trail" d="M1,8 L7,3 L17,5" />
        </svg>
        Route travelled (selected)
      </span>
    </div>
  );
}
