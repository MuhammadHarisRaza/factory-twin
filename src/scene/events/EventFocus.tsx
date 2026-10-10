/**
 * Event focus in the 3D twin (set by `focusEventInTwin`, ./focus.ts): while the focused event is
 * the selected event, a ring pulses for ~10 s around what it affects — the vehicle (following it
 * while it is on site), the geofence / dock it happened in, or the asset's footprint (a conveyor's
 * own run) — and a compact pin "EV-… · <type>" links back to the event record. The ring is
 * animated in the render loop through refs; React re-renders only when the focus or the
 * simulated minute changes.
 */
import { useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { X } from 'lucide-react';
import type { Group } from 'three';
import type { Line2, LineMaterial } from 'three-stdlib';
import { openEvent, useApp } from '../../app/store';
import { CONVEYOR_BY_ID } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { EVENT_STATUS_LABEL, EVENT_TYPE_LABEL, eventById } from '../../sim/events';
import { poseAt } from '../../sim/logistics';
import { simClock, useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { equipmentBounds } from '../../store';
import { SEVERITY } from '../../ui/kit/Status';
import { CONVEYOR_GEOMETRY } from '../Conveyors';
import { pinAnchor } from '../status/AssetPins';
import { outlineLoop } from '../status/model';
import { useBoundsCount } from '../status/shared';
import { clearEventFocus, isFocusCurrent, useEventFocus } from './focus';
import { centredLoop, circleLoop, focusPlan, growScale, rectLoop, ringPhase, rippleReach, type FocusArea, type FocusPlan, type Loop } from './model';
import './events.css';

/** The twin's selection accent (vehicle ring, selection brackets, planned route). */
const ACCENT = '#46c4dc';
const RING_Y = 0.16;

/** Start of the ring animation: the first rendered frame after the focus (the twin may be hidden until then). */
type Start = MutableRefObject<number | null>;
const elapsed = (start: Start, now: number) => {
  if (start.current == null) start.current = now;
  return now - start.current;
};

/** Steady loop plus a ripple growing outwards from it, for RING_SECONDS; hidden afterwards. */
function FocusLoop({ loop, start, y = RING_Y, dim = 1 }: { loop: Loop; start: Start; y?: number; dim?: number }) {
  const group = useRef<Group>(null);
  const steady = useRef<Line2>(null);
  const ripple = useRef<Line2>(null);
  const points = useMemo(() => loop.pts.map(([x, z]) => [x, 0, z] as [number, number, number]), [loop]);
  const reach = rippleReach(loop);
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const ph = ringPhase(elapsed(start, clock.elapsedTime), reach);
    g.visible = ph != null;
    if (!ph) return;
    if (steady.current) (steady.current.material as LineMaterial).opacity = ph.opacity * dim;
    if (ripple.current) {
      const [kx, kz] = growScale(loop, ph.grow);
      ripple.current.scale.set(kx, 1, kz);
      (ripple.current.material as LineMaterial).opacity = ph.rippleOpacity * dim;
    }
  });
  return (
    <group ref={group} position={[0, y, 0]}>
      <Line ref={steady} points={points} color={ACCENT} lineWidth={3} transparent opacity={0} depthTest={false} renderOrder={12} />
      <Line ref={ripple} points={points} color={ACCENT} lineWidth={2} transparent opacity={0} depthTest={false} renderOrder={12} />
    </group>
  );
}

function EventPin({ ev, plan, lift }: { ev: OpEvent; plan: FocusPlan; lift: 0 | 1 | 2 }) {
  const sev = SEVERITY[ev.severity];
  const Icon = sev.icon;
  const state =
    ev.end != null ? `condition cleared ${formatClock(ev.end)}` : `condition present since ${formatClock(ev.start)}`;
  const d = plan.departed;
  const title = [
    `${ev.id} · ${ev.title}`,
    `${sev.label} · ${EVENT_STATUS_LABEL[ev.status]} · ${state}`,
    d ? `${d.vehicleId} has left the site${d.at != null ? ` (${formatClock(d.at)})` : ''} — marking where the event happened.` : null,
    'Open the event record (evidence, impact, report).',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className={`ev-pin sev-${sev.tone} lift-${lift}`}>
      <button className="ev-pin-open" onClick={() => openEvent(ev.id)} title={title}>
        <Icon size={12} strokeWidth={2.4} aria-hidden />
        <span className="num">{ev.id}</span>
        <span className="ev-pin-type">· {EVENT_TYPE_LABEL[ev.type]}</span>
      </button>
      <button className="ev-pin-close" onClick={clearEventFocus} aria-label={`Dismiss the marker for ${ev.id}`} title="Dismiss marker">
        <X size={11} strokeWidth={2.4} aria-hidden />
      </button>
    </div>
  );
}

/** Ring and pin following a vehicle on site. */
function VehicleFocus({ id, ev, plan, start }: { id: string; ev: OpEvent; plan: FocusPlan; start: Start }) {
  const group = useRef<Group>(null);
  const pin = useRef<HTMLDivElement>(null);
  const external = useSimValue((s) => s.logistics.vehicles[id]?.class === 'external', [id]);
  const loop = useMemo(() => circleLoop(external ? 9.4 : 3.3), [external]);
  // Initial position only (stable array); the render loop moves the group from then on.
  const initial = useMemo(() => {
    const v = useSim.getState().sim.logistics.vehicles[id];
    const p = v ? poseAt(v, simClock.t) : null;
    return [p?.x ?? 0, 0, p?.z ?? 0] as [number, number, number];
  }, [id]);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const v = useSim.getState().sim.logistics.vehicles[id];
    const p = v ? poseAt(v, simClock.t) : null;
    g.visible = p != null;
    if (pin.current) pin.current.style.visibility = p ? '' : 'hidden';
    if (p) g.position.set(p.x, 0, p.z);
  });
  return (
    <group ref={group} position={initial}>
      <FocusLoop loop={loop} start={start} />
      <Html position={[0, external ? 5.2 : 3.4, 0]} center zIndexRange={[10, 0]}>
        <div ref={pin}>
          <EventPin ev={ev} plan={plan} lift={1} />
        </div>
      </Html>
    </group>
  );
}

/** Ring around a geofence / dock rectangle, with the pin at its centre (or none when `pin` is false). */
function AreaFocus({ area, ev, plan, start, pin, dim }: { area: FocusArea; ev: OpEvent; plan: FocusPlan; start: Start; pin: boolean; dim?: number }) {
  const shape = useMemo(() => {
    const hx = (area.x[1] - area.x[0]) / 2;
    const hz = (area.z[1] - area.z[0]) / 2;
    return { loop: rectLoop(hx, hz), at: [area.x[0] + hx, 0, area.z[0] + hz] as [number, number, number] };
    // The rectangle depends on the area only (plan objects are re-derived every simulated minute).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area.id]);
  return (
    <group position={shape.at}>
      <FocusLoop loop={shape.loop} start={start} dim={dim} />
      {pin && (
        <Html position={[0, 2.4, 0]} center zIndexRange={[10, 0]}>
          <EventPin ev={ev} plan={plan} lift={0} />
        </Html>
      )}
    </group>
  );
}

/** Ring around an asset's footprint (a conveyor: around its own run), pin above it. */
function EquipmentFocus({ id, ev, plan, start }: { id: string; ev: OpEvent; plan: FocusPlan; start: Start }) {
  const ids = useMemo(() => [id], [id]);
  const ready = useBoundsCount(ids);
  const shape = useMemo(() => {
    const cv = CONVEYOR_BY_ID[id] ? CONVEYOR_GEOMETRY[id] : undefined;
    if (cv) {
      const c = centredLoop(outlineLoop(cv.pts, cv.w / 2 + 0.7, 0, 0.6).map(([x, , z]) => [x, z] as [number, number]));
      return { ...c, y: cv.pts[0][1] + 0.12 };
    }
    const b = equipmentBounds.get(id);
    if (!b) return null;
    const pad = 1.1;
    return {
      loop: rectLoop((b.max.x - b.min.x) / 2 + pad, (b.max.z - b.min.z) / 2 + pad),
      cx: (b.min.x + b.max.x) / 2,
      cz: (b.min.z + b.max.z) / 2,
      y: RING_Y,
    };
    // `ready` re-reads the bounds once the asset has registered them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ready]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchor = useMemo(() => pinAnchor(id), [id, ready]);
  return (
    <>
      {shape && (
        <group position={[shape.cx, 0, shape.cz]}>
          <FocusLoop loop={shape.loop} start={start} y={shape.y} />
        </group>
      )}
      {anchor && (
        <Html position={anchor} center zIndexRange={[10, 0]}>
          <EventPin ev={ev} plan={plan} lift={2} />
        </Html>
      )}
    </>
  );
}

/** Ring at a ground point (zone), pin above it. */
function PointFocus({ at, ev, plan, start }: { at: [number, number]; ev: OpEvent; plan: FocusPlan; start: Start }) {
  const loop = useMemo(() => circleLoop(5), []);
  return (
    <group position={[at[0], 0, at[1]]}>
      <FocusLoop loop={loop} start={start} />
      <Html position={[0, 2.4, 0]} center zIndexRange={[10, 0]}>
        <EventPin ev={ev} plan={plan} lift={0} />
      </Html>
    </group>
  );
}

function FocusMarker({ ev, plan }: { ev: OpEvent; plan: FocusPlan }) {
  const start = useRef<number | null>(null);
  switch (plan.primary) {
    case 'vehicle':
      return (
        <>
          <VehicleFocus id={plan.vehicleId!} ev={ev} plan={plan} start={start} />
          {plan.area && <AreaFocus area={plan.area} ev={ev} plan={plan} start={start} pin={false} dim={0.6} />}
        </>
      );
    case 'area':
      return <AreaFocus area={plan.area!} ev={ev} plan={plan} start={start} pin />;
    case 'equipment':
      return <EquipmentFocus id={plan.equipmentId!} ev={ev} plan={plan} start={start} />;
    case 'point':
      return <PointFocus at={plan.point!} ev={ev} plan={plan} start={start} />;
    default:
      return null;
  }
}

export function EventFocus() {
  const focus = useEventFocus((s) => s.focus);
  const selectedEventId = useApp((s) => s.selectedEventId);
  const resets = useSim((s) => s.resets);
  const current = isFocusCurrent(focus, selectedEventId, resets) ? focus : null;
  const id = current?.eventId ?? null;
  const ev = useSimValue((s) => (id ? (eventById(s, id) ?? null) : null), [id]);
  // Re-derived every simulated minute: a vehicle that leaves the site hands the ring to its area.
  const plan = useSimValue((s) => (ev ? focusPlan(s, ev) : null), [ev]);
  if (!current || !ev || !plan?.primary) return null;
  return (
    // Flagged so off-screen renders (simulated camera frames) can leave operator overlays out.
    <group name="overlay:event-focus" userData={{ twinOverlay: true }}>
      <FocusMarker key={current.nonce} ev={ev} plan={plan} />
    </group>
  );
}
