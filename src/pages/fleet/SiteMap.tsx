/**
 * 2D site layout of Fleet & Movement — simulated positions on the plant's ground plan, never GPS
 * coordinates. Static layers (roads, yards, buildings, geofences, docks, the numbered movement
 * areas that match the flow strip) re-render once per simulated minute; vehicle glyphs, the selected
 * vehicle's travelled route and the truck → assigned-dock lines are updated from
 * `poseAt(vehicle, simClock.t)` in a requestAnimationFrame loop (~12 fps) that writes SVG
 * attributes directly, so motion is smooth without a React render per frame.
 *
 * Delays and vehicle alerts are marked on the vehicle itself (warning icon + short text), a yard
 * congestion on the holding area and a dock overstay on the dock — never by colour alone.
 *
 * Coordinates are the 3D model's ground plane: x → right, z → down (south, main gate).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { HALL, LINK, PARKING, PAVED, RAW_SHED, ROADS, SPRAY_TOWER, WAREHOUSE, WORKSHOP } from '../../data/layout';
import type { Rect } from '../../data/types';
import { DOCKS, GEOFENCES } from '../../model/plant';
import type { AlertSeverity, OpEvent, Vehicle } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { poseAt, type TruckRuntime } from '../../sim/logistics';
import { simClock, useSim, useSimValue } from '../../sim/store';
import { dockBoard, type DockStatus } from './derive';
import { delayMarker, delayReview, type DelayReview } from './movement';
import { activeVehicleEvents, trail, trailPath } from './pipeline';

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
/** Overflow queue positions on the perimeter-road shoulder (src/sim/logistics.ts OVERFLOW_SLOTS). */
const OVERFLOW_RECT: Rect = { x: [-10, 74], z: [90.5, 95.5] };

/**
 * Numbered movement areas — the same step numbers as the flow strip under the map
 * (1 entry gate · 2 check-in / weighbridge · 3 holding · 4 queue · 5 docks · 6 dispatch staging · 7 exit).
 */
const AREAS: { id: string; steps: number[]; label: string; x: number; z: number; site: boolean; warehouse: boolean }[] = [
  { id: 'gate', steps: [1, 2, 7], label: 'Main gate', x: 95, z: 104.5, site: true, warehouse: false },
  { id: 'weigh', steps: [2], label: 'Weighbridge (inbound)', x: -139, z: -56, site: true, warehouse: false },
  { id: 'hold', steps: [3, 4], label: 'Holding & queue', x: -65, z: 49.6, site: true, warehouse: true },
  { id: 'overflow', steps: [4], label: 'Overflow queue (road shoulder)', x: -9, z: 88.6, site: true, warehouse: false },
  // Docks: the step badge sits beside the D1…D6 labels (no room for text without covering docked trucks).
  { id: 'docks', steps: [5], label: '', x: -134.6, z: 58.4, site: true, warehouse: true },
  { id: 'staging', steps: [6], label: 'Dispatch staging', x: -127, z: 54, site: true, warehouse: true },
];

const DOCK_SHORT: Record<DockStatus, string> = { free: 'Free', reserved: 'Reserved', loading: 'Loading', paperwork: 'Paperwork', held: 'Held' };
const DOCK_X = Object.fromEntries(DOCKS.map((d) => [d.id, d.x]));

const rectProps = (r: Rect) => ({ x: r.x[0], y: r.z[0], width: r.x[1] - r.x[0], height: r.z[1] - r.z[0] });
const deg = (heading: number) => ((-heading * 180) / Math.PI).toFixed(1);

const vehicleClass = (v: Vehicle) =>
  v.type === 'outbound-truck' ? 'veh-out' : v.type === 'inbound-tipper' ? 'veh-in' : v.type === 'wheel-loader' ? 'veh-wl' : 'veh-fl';

// ── Marks (delays, alerts, records to check) ─────────────────────────────────

export type MapFlagTone = 'warning' | 'serious' | 'critical' | 'neutral';
export type MapFlag = { tone: MapFlagTone; text: string; kind: 'delay' | 'event' | 'record' };

const SEV_TONE: Record<AlertSeverity, MapFlagTone> = { info: 'neutral', warning: 'warning', serious: 'serious', critical: 'critical' };

/** Map marks per vehicle: past a limit (minutes vs limit), an active vehicle event, or a visit record to check. */
export function mapFlags(s: SimState, review: DelayReview = delayReview(s), alerts: Map<string, OpEvent> = activeVehicleEvents(s)): Map<string, MapFlag> {
  const out = new Map<string, MapFlag>();
  for (const r of review.incomplete) out.set(r.id, { tone: 'neutral', text: 'Record incomplete?', kind: 'record' });
  for (const r of review.delayed) out.set(r.id, { tone: r.event ? SEV_TONE[r.event.severity] : 'warning', text: delayMarker(r), kind: 'delay' });
  for (const [id, e] of alerts) if (!out.has(id)) out.set(id, { tone: SEV_TONE[e.severity], text: EVENT_TYPE_LABEL[e.type], kind: 'event' });
  return out;
}

function mapState(s: SimState) {
  const L = s.logistics;
  const review = delayReview(s);
  const overstay = new Set<string>();
  let congestion: OpEvent | null = null;
  for (const e of s.events) {
    if (e.end != null) continue;
    if (e.type === 'dock-overstay' && e.asset.dockId) overstay.add(e.asset.dockId);
    if (e.type === 'yard-congestion') congestion = e;
  }
  const restricted = new Set(Object.values(L.restrictedOpen).map((o) => o?.geofenceId).filter((x): x is string => !!x));
  const queuePos = new Map(L.queue.map((id, i) => [id, i + 1]));
  return {
    vehicles: L.active.map((id) => L.vehicles[id]),
    docks: dockBoard(s),
    flags: mapFlags(s, review),
    overstay,
    congestion,
    restricted,
    queuePos,
  };
}

const TRI = 'M0,-1 L0.92,0.62 L-0.92,0.62 Z';

/** Warning triangle + text, drawn in user units at size `u`. */
function FlagMark({ flag, u, y, anchor = 'middle' }: { flag: MapFlag; u: number; y: number; anchor?: 'middle' | 'start' }) {
  const text = flag.text;
  const w = u * (1.6 + text.length * 0.56);
  const x0 = anchor === 'middle' ? -w / 2 : 0;
  return (
    <g className={`fm-flag ${flag.tone} ${flag.kind}`} transform={`translate(${x0.toFixed(2)} ${y.toFixed(2)})`} aria-hidden>
      <rect className="bg" x={0} y={-u * 0.85} width={w} height={u * 1.7} rx={u * 0.3} />
      <path className="ic" d={TRI} transform={`translate(${(u * 0.85).toFixed(2)} ${(u * 0.05).toFixed(2)}) scale(${(u * 0.55).toFixed(3)})`} />
      <text className="tx" x={u * 1.55} y={u * 0.36} fontSize={u * 1.02}>
        {text}
      </text>
    </g>
  );
}

function StepBadges({ steps, x, z, u }: { steps: number[]; x: number; z: number; u: number }) {
  return (
    <>
      {steps.map((n, i) => (
        <g key={n} className="fm-step" transform={`translate(${(x + u * 0.62 + i * u * 1.42).toFixed(2)} ${z.toFixed(2)})`}>
          <circle r={u * 0.62} />
          <text y={u * 0.3} fontSize={u * 0.85} textAnchor="middle">
            {n}
          </text>
        </g>
      ))}
    </>
  );
}

export function SiteMap({
  view,
  selectedId,
  onSelect,
}: {
  view: MapView;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const vb = VIEWS[view];
  const nodes = useRef(new Map<string, SVGGElement>());
  const trailRef = useRef<SVGPathElement>(null);
  const assignRef = useRef<SVGPathElement>(null);
  const selRef = useRef(selectedId);
  useEffect(() => {
    selRef.current = selectedId;
  }, [selectedId]);

  const m = useSimValue((s) => mapState(s));

  // Text stays legible at any rendered size: labels scale up when the map is drawn small
  // (pixels per ground unit measured from the element; geometry is unchanged).
  const svgRef = useRef<SVGSVGElement>(null);
  const [ppu, setPpu] = useState(4);
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setPpu(Math.min(r.width / (vb.x[1] - vb.x[0]), r.height / (vb.z[1] - vb.z[0])));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vb]);

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
      // Truck → assigned dock: outbound trucks with a dock assigned that have not docked yet.
      const assign = assignRef.current;
      if (assign) {
        let d = '';
        for (const id of L.active) {
          const v = L.vehicles[id] as TruckRuntime;
          const vis = v.visit;
          if (!vis || vis.direction !== 'outbound' || !vis.dockId || (vis.dockStart != null && vis.dockStart <= t)) continue;
          const p = poseAt(v, t);
          const dx = DOCK_X[vis.dockId];
          if (!p || dx == null) continue;
          d += `M${p.x.toFixed(2)},${p.z.toFixed(2)}L${dx.toFixed(2)},${(DOCK_FRONT + 1).toFixed(2)}`;
        }
        assign.setAttribute('d', d);
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
  /** Text scale: vehicle labels (0.7 × ft units) render at ≥ 10.5 px. */
  const ts = Math.min(1.8, Math.max(1, 10.5 / (0.7 * fs * ppu)));
  const ft = fs * ts;
  const u = ft * 0.62;
  const warehouseView = view === 'warehouse';
  const hatch = `hatch-${uid}`;
  const hatchR = `hatchr-${uid}`;
  const clip = `clip-${uid}`;
  const selected = selectedId ? m.vehicles.find((v) => v.id === selectedId) : undefined;
  const targetDock = selected?.class === 'external' ? ((selected as TruckRuntime).visit?.dockId ?? null) : null;

  const keySelect = (id: string) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onSelect(id);
  };

  return (
    <svg
      ref={svgRef}
      className="fleet-map"
      viewBox={`${vb.x[0]} ${vb.z[0]} ${vb.x[1] - vb.x[0]} ${vb.z[1] - vb.z[0]}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={
        view === 'site'
          ? 'Site layout with simulated vehicle positions (not GPS coordinates). Vehicles are buttons: select one for its detail.'
          : 'Warehouse and dispatch yard with simulated vehicle positions (not GPS coordinates).'
      }
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
        {warehouseView && RACK_ROWS_Z.map((z) => <rect key={z} className="fm-rack" x={RACK_X[0]} y={z - 1.4} width={RACK_X[1] - RACK_X[0]} height={2.8} />)}
        {BUILDINGS.filter((b) => b.name).map((b) => {
          const cx = (b.rect.x[0] + b.rect.x[1]) / 2;
          const z = warehouseView && b.rect === WAREHOUSE.rect ? b.rect.z[0] + fs * 1.6 : (b.rect.z[0] + b.rect.z[1]) / 2;
          return (
            <text key={b.name} className="fm-bldg-label" x={cx} y={z} fontSize={ft * 0.95} textAnchor="middle" dominantBaseline="middle">
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
          const busy = (g.kind === 'restricted' && m.restricted.has(g.id)) || (g.kind === 'holding' && m.congestion != null);
          return (
            <rect
              key={g.id}
              className={`gf ${cls} ${busy ? 'alert' : ''}`}
              {...r}
              fill={fill}
              strokeWidth={fs * (g.kind === 'zone' ? 0.07 : busy ? 0.18 : 0.1)}
              strokeDasharray={g.kind === 'zone' ? `${fs * 0.5} ${fs * 0.35}` : undefined}
            >
              <title>{g.name}</title>
            </rect>
          );
        })}
        <rect className="gf gf-overflow" {...rectProps(OVERFLOW_RECT)} fill="none" strokeWidth={fs * 0.07} strokeDasharray={`${fs * 0.4} ${fs * 0.4}`}>
          <title>Overflow queue on the road shoulder (used when the holding area is full)</title>
        </rect>

        {/* Numbered movement areas (same steps as the flow strip) */}
        {AREAS.filter((a) => (warehouseView ? a.warehouse : a.site)).map((a) => (
          <g key={a.id} className="fm-area">
            <StepBadges steps={a.steps} x={a.x} z={a.z} u={u} />
            {a.label && (
              <text className="fm-area-label" x={a.x + a.steps.length * u * 1.42 + u * 0.3} y={a.z + u * 0.36} fontSize={u * 1.05}>
                {a.label}
              </text>
            )}
            <title>{a.id === 'docks' ? 'Step 5 · Loading docks' : `Step ${a.steps.join(' · ')} · ${a.label}`}</title>
          </g>
        ))}
        {m.congestion && (
          <g transform={`translate(${(-65 + u * 13).toFixed(2)} 49.6)`}>
            <FlagMark flag={{ tone: m.congestion.severity === 'info' ? 'neutral' : (m.congestion.severity as MapFlagTone), text: 'Yard congestion', kind: 'event' }} u={u} y={0} anchor="start" />
          </g>
        )}

        {/* Docks with occupancy */}
        {m.docks.map((d) => {
          const over = m.overstay.has(d.id);
          const target = d.id === targetDock;
          return (
            <g
              key={d.id}
              className={`fm-dock ${d.status} ${over ? 'alert' : ''} ${target ? 'target' : ''} ${d.truck ? 'has-truck' : ''}`}
              onClick={d.truck ? () => onSelect(d.truck!.id) : undefined}
            >
              <rect x={d.x - 3} y={WAREHOUSE.rect.z[1]} width={6} height={DOCK_FRONT - WAREHOUSE.rect.z[1]} strokeWidth={fs * (target ? 0.2 : 0.09)} />
              <text x={d.x} y={WAREHOUSE.rect.z[1] - fs * 0.45} fontSize={ft * 0.72} textAnchor="middle" className="fm-dock-label">
                {view === 'site' ? `D${d.id.slice(5)}` : `D${d.id.slice(5)} · ${DOCK_SHORT[d.status]}`}
              </text>
              {over && (
                <path className="fm-dock-alert" d={TRI} transform={`translate(${d.x.toFixed(2)} ${(WAREHOUSE.rect.z[1] - fs * 1.5).toFixed(2)}) scale(${(fs * 0.42).toFixed(3)})`} />
              )}
              <title>{`${d.name}: ${DOCK_SHORT[d.status]}${d.truck ? ` · ${d.truck.id}` : ''}${over ? ' · occupied longer than the dock-stay limit' : ''}${d.truck ? ' — click to select the truck' : ''}`}</title>
            </g>
          );
        })}

        {/* Truck → assigned dock (updated in the animation loop) */}
        <path ref={assignRef} className="fm-assign" strokeWidth={fs * 0.14} strokeDasharray={`${fs * 0.55} ${fs * 0.4}`} fill="none" />
        {/* Selected vehicle's travelled route (updated in the animation loop) */}
        <path ref={trailRef} className="fm-trail" strokeWidth={fs * 0.22} fill="none" />

        {/* Vehicles */}
        {m.vehicles.map((v) => {
          const p = poseAt(v, t0);
          const sel = v.id === selectedId;
          const truck = v.class === 'external';
          const flag = m.flags.get(v.id);
          const q = m.queuePos.get(v.id);
          const showLabel = sel || truck || warehouseView || !!flag;
          const labelText = q != null && truck ? `${v.id} · #${q}` : v.id;
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
              className={`fm-veh ${vehicleClass(v)} ${sel ? 'sel' : ''} ${flag ? `flagged ${flag.tone}` : ''}`}
              transform={p ? `translate(${p.x.toFixed(2)} ${p.z.toFixed(2)})` : undefined}
              visibility={p ? 'visible' : 'hidden'}
              role="button"
              tabIndex={p ? 0 : -1}
              aria-label={`${v.id} · ${v.label}${flag ? ` · ${flag.text}` : ''}${sel ? ' (selected)' : ''}`}
              aria-pressed={sel}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(v.id);
              }}
              onKeyDown={keySelect(v.id)}
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
              {showLabel && (
                <text
                  className={`fm-veh-label ${sel ? 'sel' : ''}`}
                  x={truck ? 0 : vb.dot * 1.6}
                  y={truck ? -(3.2 + ft * 0.2) : -vb.dot * 1.6}
                  fontSize={ft * (sel ? 0.85 : 0.7)}
                  textAnchor={truck ? 'middle' : 'start'}
                >
                  {labelText}
                </text>
              )}
              {flag && <FlagMark flag={flag} u={u * 0.92} y={truck ? 3.4 + u * 0.92 : vb.dot * 1.2 + u * 1.05} anchor={truck ? 'middle' : 'start'} />}
              <title>{`${v.id} · ${v.label}${flag ? ` · ${flag.text}` : ''} — simulated position`}</title>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** Map legend (vehicle glyphs, relationships, marks and area styles). */
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
        <svg width="20" height="10" aria-hidden>
          <path className="lg-assign" d="M1,5 L19,5" />
        </svg>
        Truck → assigned dock
      </span>
      <span>
        <svg width="18" height="10" aria-hidden>
          <path className="lg-trail" d="M1,8 L7,3 L17,5" />
        </svg>
        Route travelled (selected)
      </span>
      <span>
        <svg width="12" height="12" aria-hidden>
          <path className="lg-flag" d="M6,1.5 L11,10.5 L1,10.5 Z" />
        </svg>
        Delay or vehicle alert (with text)
      </span>
      <span>
        <svg width="12" height="12" aria-hidden>
          <circle className="lg-step" cx="6" cy="6" r="5" />
          <text x="6" y="8.6" textAnchor="middle" className="lg-step-t">
            3
          </text>
        </svg>
        Movement step (see flow below)
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
      <span>
        <svg width="16" height="12" aria-hidden>
          <rect className="lg-restricted" x="1" y="1" width="14" height="10" />
        </svg>
        Restricted zone
      </span>
    </div>
  );
}
