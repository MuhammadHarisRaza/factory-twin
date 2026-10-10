/**
 * Where the 3D twin points when an event is opened in it (pure; no three.js): the vehicle while it
 * is still on site, otherwise the geofence / dock the event happened in, the affected asset or
 * inspection station, or the zone. Shared by the focus helper (which camera target to open) and
 * the scene overlay (where the ring and the event pin sit), so both always agree.
 */
import { ZONE_BY_ID } from '../../data/layout';
import { DOCKS, GEOFENCES, INSPECTION_STATIONS } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import type { SimState } from '../../sim/engine';

/** Ground rectangle outlined for an event that happened in an area (geofence or dock). */
export type FocusArea = { id: string; label: string; x: [number, number]; z: [number, number] };

export type FocusPlan = {
  /** What carries the ring and the pin. */
  primary: 'vehicle' | 'area' | 'equipment' | 'point' | null;
  /** Vehicle to follow — only while it is on site. */
  vehicleId: string | null;
  /** Affected asset (directly, through its inspection station, or the area's asset). */
  equipmentId: string | null;
  area: FocusArea | null;
  /** Ground point [x, z] (zone tag) when nothing more specific is known. */
  point: [number, number] | null;
  /** The event's vehicle has left the site since (minute, if known). */
  departed: { vehicleId: string; at: number | null } | null;
  /** What to open in the twin (passed to openEventInTwin). */
  open: { equipmentId?: string; vehicleId?: string; stationId?: string; zone?: string };
};

/** Loading docks sit along the dock geofence (GF-DOCKS); each one is a ~6 m wide bay. */
const DOCK_HALF_WIDTH = 3;
const DOCK_Z: [number, number] = (() => {
  const g = GEOFENCES.find((x) => x.id === 'GF-DOCKS');
  return g ? g.rect.z : [57, 62.5];
})();

export function focusPlan(s: SimState, ev: Pick<OpEvent, 'asset'>): FocusPlan {
  const a = ev.asset;
  const v = a.vehicleId ? s.logistics.vehicles[a.vehicleId] : undefined;
  const onSite = !!v && s.logistics.active.includes(v.id) && (v.despawned == null || v.despawned > s.minute);
  const gf = a.geofenceId && a.geofenceId !== 'GF-SITE' ? GEOFENCES.find((g) => g.id === a.geofenceId) : undefined;
  const dock = a.dockId ? DOCKS.find((d) => d.id === a.dockId) : undefined;
  const area: FocusArea | null = gf
    ? { id: gf.id, label: gf.name, x: gf.rect.x, z: gf.rect.z }
    : dock
      ? { id: dock.id, label: dock.name, x: [dock.x - DOCK_HALF_WIDTH, dock.x + DOCK_HALF_WIDTH], z: DOCK_Z }
      : null;
  const station = a.stationId ? INSPECTION_STATIONS.find((st) => st.id === a.stationId) : undefined;
  const equipmentId = a.equipmentId ?? station?.equipmentId ?? gf?.equipmentId ?? (dock ? dock.equipmentId : null);
  const zone = a.zone ? ZONE_BY_ID[a.zone] : undefined;
  const point: [number, number] | null = zone ? [zone.label[0], zone.label[1]] : null;

  const primary: FocusPlan['primary'] = onSite ? 'vehicle' : area ? 'area' : equipmentId ? 'equipment' : point ? 'point' : null;
  const departed = a.vehicleId && !onSite ? { vehicleId: a.vehicleId, at: v?.despawned ?? v?.visit?.gateOut ?? null } : null;
  const open = onSite
    ? { vehicleId: v!.id }
    : equipmentId
      ? { equipmentId }
      : { stationId: a.stationId, zone: a.zone };
  return { primary, vehicleId: onSite ? v!.id : null, equipmentId, area, point, departed, open };
}

// ── Remembered focus ──────────────────────────────────────────────────────────

export type EventFocus = {
  eventId: string;
  /** Increments on every focus, so focusing the same event again restarts the ring. */
  nonce: number;
  /** Reset counter of the simulation the event belongs to (ids restart after a reset). */
  resets: number;
  /** What the twin was opened on (selecting anything else drops the focus). */
  target: { equipmentId: string | null; vehicleId: string | null };
};

/** Whether a remembered focus still applies: the same event is selected, in the same simulation. */
export const isFocusCurrent = (f: EventFocus | null, selectedEventId: string | null, resets: number): f is EventFocus =>
  !!f && f.eventId === selectedEventId && f.resets === resets;

/**
 * Whether a twin selection change moves away from the focused event: another asset or another
 * vehicle was selected (clearing a selection, or the twin's own selection of the target, keeps it).
 */
export function selectionLeavesFocus(
  f: EventFocus,
  next: { selected: string | null; vehicle: string | null },
  prev: { selected: string | null; vehicle: string | null },
) {
  const otherAsset = next.selected !== prev.selected && next.selected != null && next.selected !== f.target.equipmentId;
  const otherVehicle = next.vehicle !== prev.vehicle && next.vehicle != null && next.vehicle !== f.target.vehicleId;
  return otherAsset || otherVehicle;
}

// ── Focus ring ────────────────────────────────────────────────────────────────

/** Seconds the focus ring pulses after the twin opens on the event. */
export const RING_SECONDS = 10;

/**
 * Ring animation at `elapsed` seconds since the twin showed the event: a steady loop plus a ripple
 * that grows `reach` metres out from it every `period` seconds, all fading out over the last second
 * of RING_SECONDS. Null once the ring is done (the event pin stays).
 */
export function ringPhase(elapsed: number, reach: number, period = 1.6): { grow: number; rippleOpacity: number; opacity: number } | null {
  if (!(elapsed >= 0) || elapsed >= RING_SECONDS) return null;
  const fade = Math.min(1, RING_SECONDS - elapsed);
  const k = (elapsed % period) / period;
  return { grow: reach * k, rippleOpacity: (1 - k) * 0.85 * fade, opacity: 0.95 * fade };
}

/** A closed loop on the ground, relative to its centre (x, z) — the shape the ring follows. */
export type Loop = { pts: [number, number][]; hx: number; hz: number };

export function circleLoop(r: number, n = 48): Loop {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return { pts, hx: r, hz: r };
}

export function rectLoop(hx: number, hz: number): Loop {
  return {
    pts: [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
      [-hx, -hz],
    ],
    hx,
    hz,
  };
}

/** A loop given in world [x, z], re-centred on its bounding-box centre. */
export function centredLoop(world: [number, number][]): { loop: Loop; cx: number; cz: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const [x, z] of world) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  return { loop: { pts: world.map(([x, z]) => [x - cx, z - cz]), hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 }, cx, cz };
}

/** Per-axis scale that moves a loop's outline `grow` metres outwards (same distance on both axes). */
export const growScale = (l: Loop, grow: number): [number, number] => [(l.hx + grow) / Math.max(0.1, l.hx), (l.hz + grow) / Math.max(0.1, l.hz)];

/** How far the ripple travels for a loop of this size (m): visible on a forklift, restrained on a yard. */
export const rippleReach = (l: Loop) => Math.min(6, Math.max(1.6, 0.35 * Math.min(l.hx, l.hz) + 1.2));
