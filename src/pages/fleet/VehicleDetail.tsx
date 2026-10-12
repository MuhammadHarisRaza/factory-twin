/**
 * Vehicle detail of Fleet & Movement (route #/fleet/<vehicle id>): the column beside the site layout,
 * or the content of the overlay drawer on the table tabs (VehicleDrawer). Holds the detail-level
 * fields the tables leave out (arrival / gate-in / gate-out times and dock time in the visit
 * timeline and dwell; task, idle time and restricted-zone entries of an internal vehicle).
 * Shows the vehicle's identifier and class, its location WITH the kind of location made explicit ("Simulated position
 * (now)" on site, "Last known (historical) · <time>" once it has left — a stale record never reads
 * as current), movement state, current trip or dock assignment, a correctly scoped dwell (trucks:
 * on site since gate-in, waiting, at the dock; internal vehicles: time at the current stop — zone
 * residency only as "working in <zone> since …"), its events, labelled reference footage for the
 * activity type (never proof of where the vehicle is) and "Follow in 3D".
 */
import { useEffect, useMemo } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Box, Crosshair, ShieldAlert } from 'lucide-react';
import { openEquipment, openVehicle } from '../../app/store';
import type { OpEvent } from '../../model/types';
import { eventsFor } from '../../sim/events';
import type { TruckRuntime } from '../../sim/logistics';
import { useSimValue } from '../../sim/store';
import { dayStart } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { DataTable } from '../../ui/kit/DataTable';
import { Disclosure, EmptyState, Facts, SidePanel, Unavailable } from '../../ui/kit/Page';
import { SourceTag, StatusBadge } from '../../ui/kit/Status';
import { fmtInt } from '../../ui/kit/format';
import { ContextVideo } from '../../video/ContextVideo';
import { IntegrityBadge, LocationKindTag, MovementBadge, TYPE_LABEL, classLabel, dur, makeClock } from './common';
import { DOCK_NAME, GEOFENCE_BY_ID, geofenceName, recentLegs, truckSource, visitTimeline } from './derive';
import {
  internalDwell,
  movementLabel,
  servingTruck,
  truckDwell,
  truckTrip,
  vehicleLocation,
  vehicleMovement,
  videoTopicFor,
  zoneContext,
} from './movement';
import { handlingEvents, legAt, movementState } from './pipeline';

const newestFirst = (xs: OpEvent[]) => [...xs].sort((a, b) => b.start - a.start);

const FOOTAGE_NOTE =
  "Public footage of this kind of operation, picked by the vehicle's class and activity — not this vehicle, not this plant and not evidence of its location.";

function useVehicleInfo(id: string) {
  return useSimValue(
    (s) => {
      const v = s.logistics.vehicles[id];
      if (!v) return null;
      const now = s.minute;
      const clock = makeClock(now);
      const location = vehicleLocation(s, v, clock);
      const movement = vehicleMovement(s, v);
      const base = {
        v,
        now,
        clock,
        location,
        movement,
        events: newestFirst(eventsFor(s, { vehicleId: id })),
        topic: videoTopicFor(s, v),
        zoneEquipment: location.kind === 'simulated' && location.zone ? (GEOFENCE_BY_ID[location.zone]?.equipmentId ?? null) : null,
      };
      if (v.class === 'external') {
        const t = v as TruckRuntime;
        return { ...base, kind: 'external' as const, t, trip: truckTrip(s, t, clock), dwell: truckDwell(s, t), timeline: visitTimeline(s, t), rules: s.rules };
      }
      const leg = legAt(v, now);
      const from = dayStart(now);
      const historyFrom = v.legs[0]?.start ?? now;
      return {
        ...base,
        kind: 'internal' as const,
        dwell: internalDwell(s, v),
        state: movementState(leg, now),
        loaded: !!leg?.loaded,
        serving: servingTruck(s, id),
        handlingFrom: Math.max(now - 60, historyFrom),
        handling: handlingEvents(v, now, now - 60).reverse(),
        restricted: s.logistics.restrictedEvents.filter((r) => r.vehicleId === id && r.time >= from && r.time <= now).reverse(),
        insideRestricted: s.logistics.restrictedOpen[id]?.geofenceId ?? null,
        legs: recentLegs(v, now, 12),
      };
    },
    [id],
  );
}

type Info = NonNullable<ReturnType<typeof useVehicleInfo>>;

export function VehicleDetail({
  id,
  onClose,
  onSelect,
  variant = 'side',
}: {
  id: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  /** 'side': a column beside the site layout · 'drawer': inside the overlay drawer of the table tabs (VehicleDrawer). */
  variant?: 'side' | 'drawer';
}) {
  const info = useVehicleInfo(id);
  const panelClass = variant === 'side' ? 'fl-vd fl-side' : 'fl-vd';
  const topic = info?.topic ?? null;
  const videoContext = useMemo(() => ({ topic }), [topic]);

  // Below 1180 px the side column stacks under the work area: bring it into view when a vehicle is picked.
  // (The drawer is always in view.)
  useEffect(() => {
    if (variant !== 'side' || typeof window === 'undefined' || !window.matchMedia?.('(max-width: 1180px)').matches) return;
    const el = document.querySelector<HTMLElement>('.fl-side');
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top > window.innerHeight - 120 || r.bottom < 0) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [id, variant]);

  if (!info)
    return (
      <SidePanel title={id} subtitle="Vehicle detail" onClose={onClose} className={panelClass}>
        <EmptyState title="Vehicle not in this simulation run">
          No vehicle <span className="mono">{id}</span> exists in the current simulation (vehicle ids restart after Reset Demo). Select a vehicle on the site layout.
        </EmptyState>
      </SidePanel>
    );

  const { v, location } = info;
  const onSite = location.kind === 'simulated';
  const dockId = info.kind === 'external' ? info.trip.dockId : null;
  const inspect = onSite && dockId ? { eq: 'K-DOCK', label: `Show ${DOCK_NAME[dockId]} in 3D` } : info.zoneEquipment ? { eq: info.zoneEquipment, label: 'Show zone in 3D' } : null;
  const Dir = info.kind === 'external' ? (v.visit?.direction === 'inbound' ? ArrowDownToLine : ArrowUpFromLine) : null;

  return (
    <SidePanel
      title={v.id}
      className={panelClass}
      subtitle={
        <>
          <span className="fl-cls">
            {Dir && <Dir size={12} aria-hidden />}
            {TYPE_LABEL[v.type]} · {classLabel(v)}
          </span>
          <span>{v.operator}</span>
          <SourceTag source={info.kind === 'external' ? truckSource(v) : 'simulation'} />
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn primary sm"
            disabled={!onSite}
            title={onSite ? 'Open the Factory Twin following this vehicle (simulated route)' : 'The vehicle is not on site — there is no current position to follow'}
            onClick={() => openVehicle(v.id)}
          >
            <Crosshair size={14} aria-hidden />
            Follow in 3D
          </button>
          {inspect && (
            <button type="button" className="btn sm" onClick={() => openEquipment(inspect.eq)} title="Open the Factory Twin on this area">
              <Box size={14} aria-hidden />
              {inspect.label}
            </button>
          )}
        </>
      }
    >
      <div className={`fl-loc ${location.kind}`}>
        <LocationKindTag kind={location.kind} label={location.label} />
        <div className="fl-loc-place">{location.place}</div>
        {location.detail && <div className="fl-loc-detail">{location.detail}</div>}
        <div className="fl-loc-note">
          {location.kind === 'simulated'
            ? 'Zone-level position from the simulated route — not a GPS fix; no tracking system is connected.'
            : location.kind === 'historical'
              ? 'Recorded when the vehicle left. It is no longer on site, so there is no current position.'
              : location.kind === 'not-arrived'
                ? 'The arrival is scheduled by a scenario; the vehicle has no position until it reaches the gate approach.'
                : 'The simulation has not recorded a movement for this vehicle yet.'}
        </div>
      </div>

      {info.kind === 'external' ? <TruckBody info={info} /> : <InternalBody info={info} onSelect={onSelect} />}

      <div className="fl-sp-sec">
        <h4>Events for this vehicle · {info.events.length}</h4>
        <EventList events={info.events} hideAsset limit={5} empty="No events recorded for this vehicle" />
      </div>

      {/* No topic in the heading or the note: the player keeps the clip being watched when the vehicle's
          activity (and so the live topic) changes, and its caption names the clip actually shown. The note
          is hidden by CSS (.cv-none + .fl-video-note) when the player shows its "no reference video" state. */}
      <div className="fl-sp-sec">
        <h4>Reference footage</h4>
        <ContextVideo context={videoContext} compact title="Reference footage" subject={v.id} />
        <p className="fl-video-note">{FOOTAGE_NOTE}</p>
      </div>
    </SidePanel>
  );
}

function TruckBody({ info }: { info: Extract<Info, { kind: 'external' }> }) {
  const { t, trip, dwell, clock, now, rules } = info;
  const vis = t.visit!;
  const out = vis.direction === 'outbound';
  const reachedIdx = info.timeline.reduce((a, st, i) => (st.time != null ? i : a), -1);
  const incomplete = dwell.integrity.kind === 'incomplete';
  return (
    <>
      <Facts
        rows={[
          { label: 'Movement', value: movementLabel(info.movement, clock) },
          { label: 'Visit', value: trip.phase },
          { label: out ? 'Dock' : 'Unloading', value: trip.dock },
          { label: 'Load', value: trip.load },
          { label: 'Visit record', value: <IntegrityBadge integrity={dwell.integrity} /> },
        ]}
      />
      {dwell.integrity.note && <p className="fl-record-note">{dwell.integrity.note}</p>}

      <div className="fl-sp-sec">
        <h4>Dwell</h4>
        <div className="mini-kpis">
          <div className="mini-kpi">
            <span>{dwell.turnaround != null ? 'Turnaround' : 'On site'}</span>
            <b>
              {incomplete ? (
                <Unavailable reason="The visit record has no gate-out far beyond the turnaround limit — the elapsed time is not a reliable dwell.">Not reliable</Unavailable>
              ) : dwell.turnaround != null ? (
                dur(dwell.turnaround)
              ) : dwell.onSite != null ? (
                dur(dwell.onSite)
              ) : (
                <Unavailable reason="Before gate-in: the visit has not started on site">—</Unavailable>
              )}
            </b>
            <em>
              {dwell.gateIn == null
                ? 'not through the gate yet'
                : dwell.turnaround != null
                  ? `${clock(dwell.gateIn)} → ${clock(dwell.gateIn + dwell.turnaround)}`
                  : `since gate-in ${clock(dwell.gateIn)}`}
            </em>
          </div>
          <div className="mini-kpi">
            <span>Waiting for a dock</span>
            <b>{out ? dur(dwell.waiting) : <Unavailable reason="Inbound tippers go straight to the shed bay; they do not queue for a dock">n/a</Unavailable>}</b>
            <em>limit {rules.truckWaitMax} min</em>
          </div>
          <div className="mini-kpi">
            <span>{out ? 'At the dock' : 'At the bay'}</span>
            <b>{dur(dwell.atDock)}</b>
            <em>{out ? `limit ${rules.dockStayMax} min` : 'unloading'}</em>
          </div>
        </div>
      </div>

      <Disclosure title="Visit timeline" defaultOpen meta={vis.gateOut != null && vis.gateOut <= now ? 'completed' : `${reachedIdx + 1} of ${info.timeline.length} steps`}>
        <ol className="fleet-tl">
          {info.timeline.map((st, i) => (
            <li key={st.key} className={st.time == null ? (i === reachedIdx + 1 ? 'pending next' : 'pending') : i === reachedIdx && vis.gateOut == null ? 'cur' : ''}>
              <i aria-hidden />
              <span>
                {st.label}
                {st.note && <span className="note">{st.note}</span>}
              </span>
              <span className="t">{st.time != null ? clock(st.time) : i === reachedIdx + 1 ? 'next' : 'pending'}</span>
            </li>
          ))}
        </ol>
      </Disclosure>
    </>
  );
}

function InternalBody({ info, onSelect }: { info: Extract<Info, { kind: 'internal' }>; onSelect: (id: string) => void }) {
  const { dwell, clock } = info;
  const context = zoneContext(dwell, clock);
  return (
    <>
      <Facts
        rows={[
          { label: 'Movement', value: movementLabel(info.movement, clock) },
          { label: 'State', value: info.movement.state === 'off-site' ? '—' : <MovementBadge state={info.state} /> },
          { label: 'Task', value: info.v.task ?? '—' },
          {
            label: 'Assignment',
            value: info.serving ? (
              <span>
                Loading{' '}
                <button type="button" className="row-link mono" onClick={() => onSelect(info.serving!.truckId)}>
                  {info.serving.truckId}
                </button>
                {info.serving.dock ? ` at ${info.serving.dock}` : ''}
              </span>
            ) : (
              (info.movement.activity ?? '—')
            ),
          },
          { label: 'Load', value: info.loaded ? 'Carrying a load' : 'Empty' },
        ]}
      />

      <div className="fl-sp-sec">
        <h4>Dwell</h4>
        <div className="mini-kpis">
          <div className="mini-kpi">
            <span>At current stop</span>
            <b>{dwell.moving ? '0 min' : dur(dwell.atStop)}</b>
            <em>{dwell.moving ? 'moving now' : dwell.stopSince != null ? `since ${clock(dwell.stopSince)}` : '—'}</em>
          </div>
          <div className="mini-kpi">
            <span>Idle, last hour</span>
            <b>{dwell.idleLastHour == null ? <Unavailable reason="Less than one hour of movement history is retained for this vehicle">—</Unavailable> : dur(dwell.idleLastHour)}</b>
            <em>stationary, idle / waiting</em>
          </div>
          <div className="mini-kpi">
            <span>Pickups & drop-offs</span>
            <b>{fmtInt(info.handling.length)}</b>
            <em>since {clock(info.handlingFrom)}</em>
          </div>
        </div>
        {context && <p className="fl-zone-ctx">{context} — zone residency, shown as context; it is not a dwell.</p>}
        {info.insideRestricted && (
          <p className="fl-zone-ctx">
            <StatusBadge tone="warning" icon={ShieldAlert} label={`In restricted zone now: ${geofenceName(info.insideRestricted)}`} />
          </p>
        )}
      </div>

      <Disclosure title="Pickups & drop-offs" meta={`since ${clock(info.handlingFrom)}${info.handlingFrom > info.now - 60 ? ' (oldest retained movement)' : ''}`}>
        {info.handling.length ? (
          <ul className="fv-list">
            {info.handling.slice(0, 8).map((h) => (
              <li key={h.id}>
                <span className="t">{clock(h.time)}</span>
                <span className={`fv-kind ${h.kind}`}>{h.kind === 'pickup' ? 'Pickup' : 'Drop-off'}</span>
                <span className="a">
                  {h.activity}
                  <span className="dim"> · {h.dock ?? geofenceName(h.zone)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fv-muted">No pickup or drop-off since {clock(info.handlingFrom)}.</p>
        )}
      </Disclosure>

      <Disclosure title="Restricted-zone entries today" meta={String(info.restricted.length)}>
        {info.restricted.length ? (
          <ul className="fv-list">
            {info.restricted.slice(0, 6).map((x) => (
              <li key={x.id}>
                <span className="t">{clock(x.time)}</span>
                <StatusBadge tone="warning" icon={ShieldAlert} label="Entry" />
                <span className="a">
                  {geofenceName(x.geofenceId)}
                  <span className="dim"> · {x.durationMin} min · {x.source === 'scenario' ? 'scenario' : 'simulated'}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fv-muted">No restricted-zone entry today (checked against the simulated route every simulated minute).</p>
        )}
      </Disclosure>

      <Disclosure title="Movement history" meta={`last ${info.legs.length} movements`}>
        <DataTable
          columns={[
            { key: 'a', header: 'Activity', render: (l) => l.activity },
            { key: 'z', header: 'Zone', render: (l) => <span className="dim">{geofenceName(l.zone)}</span> },
            { key: 's', header: 'Start', numeric: true, render: (l) => clock(l.start) },
            { key: 'd', header: 'Duration', numeric: true, render: (l) => (l.open ? <span className="dim">{dur(l.duration)} …</span> : dur(l.duration)) },
          ]}
          rows={info.legs}
          rowKey={(l) => `${l.start}-${l.activity}`}
          maxHeight={220}
          empty="No movements recorded yet"
        />
      </Disclosure>
    </>
  );
}

