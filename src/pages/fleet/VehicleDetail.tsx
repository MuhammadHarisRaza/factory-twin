/**
 * Selected vehicle. Trucks: stage, zone (simulated, zone level), visit timestamps, loading state,
 * durations, the visit timeline as a stepper and the truck's events. Internal vehicles: zone,
 * movement, task, pickups / drop-offs, dwell, safety (restricted-zone entries) and movement history.
 */
import { ArrowDownToLine, ArrowUpFromLine, Crosshair, ShieldAlert } from 'lucide-react';
import { openEquipment, openVehicle } from '../../app/store';
import { eventsFor } from '../../sim/events';
import type { TruckRuntime } from '../../sim/logistics';
import { useSimValue } from '../../sim/store';
import { dayStart } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { DataTable } from '../../ui/kit/DataTable';
import { Empty, Panel } from '../../ui/kit/Panel';
import { SourceTag, StatusBadge } from '../../ui/kit/Status';
import { fmtInt } from '../../ui/kit/format';
import { MovementBadge, PositionTag, TYPE_LABEL, dur, type Clock } from './common';
import { DOCK_NAME, GEOFENCE_BY_ID, currentZone, geofenceName, internalRows, liveDurations, recentLegs, truckSource, visitTimeline } from './derive';
import { SAFETY_ZONES, STAGE_BY_KEY, handlingEvents, legAt, loadState, movementState, truckPlace } from './pipeline';

const newestFirst = <T extends { start: number }>(xs: T[]) => [...xs].sort((a, b) => b.start - a.start);

function useVehicleInfo(id: string | null) {
  return useSimValue(
    (s) => {
      if (!id) return null;
      const v = s.logistics.vehicles[id];
      if (!v) return null;
      const now = s.minute;
      const active = s.logistics.active.includes(id);
      const onSite = active && v.spawned <= now;
      const zone = onSite ? currentZone(v, now) : null;
      const events = newestFirst(eventsFor(s, { vehicleId: id }));
      if (v.class === 'external') {
        const t = v as TruckRuntime;
        const done = s.logistics.dockEvents.find((e) => e.vehicleId === id && e.kind === 'loading-complete')?.time ?? null;
        return {
          kind: 'external' as const,
          v: t,
          now,
          active,
          onSite,
          zone,
          events,
          place: active ? truckPlace(t, now, done) : null,
          load: loadState(t, now, done),
          loading: done != null && t.visit!.dockStart != null && done <= now ? done - t.visit!.dockStart : null,
          d: liveDurations(t, now),
          timeline: visitTimeline(s, t),
          gate: s.logistics.gateEvents.filter((g) => g.vehicleId === id),
        };
      }
      const from = dayStart(now);
      const leg = legAt(v, now);
      const historyFrom = v.legs[0]?.start ?? now;
      return {
        kind: 'internal' as const,
        v,
        now,
        active,
        onSite,
        zone,
        events,
        row: internalRows(s).find((r) => r.id === id) ?? null,
        movement: movementState(leg, now),
        loaded: !!leg?.loaded,
        legs: recentLegs(v, now, 12),
        /** Start of the handling window: last 60 min, or the oldest retained movement if later. */
        handlingFrom: Math.max(now - 60, historyFrom),
        handling: handlingEvents(v, now, now - 60).reverse(),
        restricted: s.logistics.restrictedEvents.filter((r) => r.vehicleId === id && r.time >= from && r.time <= now).reverse(),
      };
    },
    [id],
  );
}

export function VehicleDetail({ id, onClose, clock }: { id: string | null; onClose: () => void; clock: Clock }) {
  const info = useVehicleInfo(id);

  if (!info)
    return (
      <Panel title="Selected vehicle">
        <Empty title="No vehicle selected">Click a truck in the pipeline, a vehicle on the map or a row in the vehicle tables.</Empty>
      </Panel>
    );

  const v = info.v;
  const zoneEquip = info.zone ? GEOFENCE_BY_ID[info.zone]?.equipmentId : undefined;
  const truck = info.kind === 'external' ? info.v : null;
  const dockTarget = truck && truck.visit!.dockId && info.onSite && truck.visit!.direction === 'outbound' ? truck.visit!.dockId : null;
  const inspect = dockTarget ? { eq: 'K-DOCK', label: `Inspect ${DOCK_NAME[dockTarget]}` } : zoneEquip ? { eq: zoneEquip, label: 'Inspect zone' } : null;

  return (
    <Panel
      title="Selected vehicle"
      actions={
        <button className="btn sm ghost" onClick={onClose}>
          Clear
        </button>
      }
    >
      <div className="fleet-detail-h">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="mono">{v.id}</h3>
          <p>{truck ? `${TYPE_LABEL[v.type]} · ${v.operator}` : `${v.label} · ${v.operator}`}</p>
        </div>
        {truck ? <SourceTag source={truckSource(v)} /> : <SourceTag source="simulation" />}
      </div>

      {info.kind === 'external' ? <TruckBody info={info} clock={clock} /> : <InternalBody info={info} clock={clock} />}

      <div className="fleet-detail-sec">
        <h4>Events for this vehicle</h4>
        <EventList events={info.events} hideAsset limit={6} empty="No events recorded for this vehicle" />
      </div>

      <div className="fleet-actions">
        <button className="btn primary" disabled={!info.onSite} title={info.onSite ? 'Open the Factory Twin following this vehicle' : 'The vehicle is not on site'} onClick={() => openVehicle(v.id)}>
          <Crosshair size={14} aria-hidden />
          Follow in Factory Twin
        </button>
        <button
          className="btn"
          disabled={!inspect}
          title={inspect ? undefined : info.onSite ? 'Current zone has no linked equipment' : 'The vehicle is not on site'}
          onClick={() => inspect && openEquipment(inspect.eq)}
        >
          {inspect?.label ?? 'Inspect dock / zone'}
        </button>
      </div>
    </Panel>
  );
}

type Info = NonNullable<ReturnType<typeof useVehicleInfo>>;

function TruckBody({ info, clock }: { info: Extract<Info, { kind: 'external' }>; clock: Clock }) {
  const t = info.v;
  const vis = t.visit!;
  const out = vis.direction === 'outbound';
  const stage = info.place ? STAGE_BY_KEY[info.place.stage] : null;
  const at = (m: number | null | undefined) => (m != null && m <= info.now ? clock(m) : '—');
  const gin = info.gate.find((g) => g.direction === 'in');
  const gout = info.gate.find((g) => g.direction === 'out');
  const reachedIdx = info.timeline.reduce((a, st, i) => (st.time != null ? i : a), -1);
  return (
    <>
      <div className="fv-stagebar">
        {out ? <ArrowUpFromLine size={13} aria-hidden /> : <ArrowDownToLine size={13} aria-hidden />}
        {stage ? (
          <span>
            Stage {stage.step} · <b>{stage.label}</b> — {info.place!.status}
            {info.place!.queuePos != null && ` (#${info.place!.queuePos})`}
          </span>
        ) : (
          <span>
            <b>Left site</b> at {at(vis.gateOut)}
          </span>
        )}
      </div>
      <dl className="dl" style={{ marginTop: 10 }}>
        <dt>Zone</dt>
        <dd>
          {info.onSite ? geofenceName(info.zone) : info.active ? 'Not yet at the gate' : 'Left site'} <PositionTag />
        </dd>
        <dt>Arrival</dt>
        <dd>{at(vis.arrival)}</dd>
        <dt>Gate in</dt>
        <dd>
          {at(vis.gateIn)}
          {gin && <span className="dim"> · {gin.id}</span>}
        </dd>
        <dt>{out ? 'Dock' : 'Unloading'}</dt>
        <dd>{out ? (vis.dockId ? `${DOCK_NAME[vis.dockId]} · assigned ${at(vis.dockAssigned)}` : 'Not assigned yet') : 'Raw-material shed bay'}</dd>
        <dt>{out ? 'Loading' : 'Load'}</dt>
        <dd>
          {info.load.label}
          {t.holdExtra > 0 && <span className="dim"> · hold +{t.holdExtra} min (scenario)</span>}
        </dd>
        <dt>Departure</dt>
        <dd>
          {vis.gateOut != null && vis.gateOut <= info.now ? `Gate out ${clock(vis.gateOut)}` : 'Not departed'}
          {gout && <span className="dim"> · {gout.id}</span>}
        </dd>
      </dl>

      <div className="fleet-detail-sec">
        <h4>Durations</h4>
        <div className="fleet-durs three">
          <div>
            <span>Waiting</span>
            <b>{dur(info.d.waiting)}</b>
          </div>
          <div>
            <span>Gate → dock</span>
            <b>{dur(info.d.gateToDock)}</b>
          </div>
          <div>
            <span>{out ? 'Dock time' : 'Unloading'}</span>
            <b>{dur(info.d.dockTime)}</b>
          </div>
          <div>
            <span>Loading</span>
            <b>{out ? dur(info.loading) : <span className="dim">n/a</span>}</b>
          </div>
          <div>
            <span>Turnaround</span>
            <b>{info.d.turnaround != null ? dur(info.d.turnaround) : vis.gateIn <= info.now ? <span className="dim">{dur(info.now - vis.gateIn)} so far</span> : '—'}</b>
          </div>
          <div>
            <span>Load</span>
            <b>{out ? `${fmtInt(vis.load)} pallets` : `${fmtInt(vis.load)} t`}</b>
          </div>
        </div>
      </div>

      <div className="fleet-detail-sec">
        <h4>Visit timeline</h4>
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
      </div>
    </>
  );
}

function InternalBody({ info, clock }: { info: Extract<Info, { kind: 'internal' }>; clock: Clock }) {
  const r = info.row;
  return (
    <>
      <div className="fv-stagebar">
        <PositionTag long />
      </div>
      <dl className="dl" style={{ marginTop: 10 }}>
        <dt>Zone</dt>
        <dd>{geofenceName(info.zone)}</dd>
        <dt>Movement</dt>
        <dd>
          <MovementBadge state={info.movement} />
          <span className="dim"> · {info.loaded ? 'carrying a load' : 'empty'}</span>
        </dd>
        <dt>Task</dt>
        <dd>{info.v.task ?? '—'}</dd>
        <dt>Activity</dt>
        <dd>{r?.activity ?? '—'}</dd>
      </dl>
      <div className="fleet-detail-sec">
        <h4>Dwell & idle</h4>
        <div className="fleet-durs three">
          <div>
            <span>Dwell in zone</span>
            <b>{dur(r?.dwell)}</b>
          </div>
          <div>
            <span>Idle, last hour</span>
            <b>{r?.idleLastHour == null ? <span className="dim">—</span> : dur(r.idleLastHour)}</b>
          </div>
          <div>
            <span title={`Pickups + drop-offs since ${clock(info.handlingFrom)}`}>Handling, last hour</span>
            <b>{fmtInt(info.handling.length)}</b>
          </div>
        </div>
      </div>

      <div className="fleet-detail-sec">
        <h4>
          Pickups & drop-offs · since {clock(info.handlingFrom)}
          {info.handlingFrom > info.now - 60 && <span className="fv-h4-note"> (oldest retained movement)</span>}
        </h4>
        {info.handling.length ? (
          <ul className="fv-list">
            {info.handling.slice(0, 6).map((h) => (
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
      </div>

      <div className="fleet-detail-sec">
        <h4>Safety · configured restricted zones</h4>
        <p className="fv-muted">
          {SAFETY_ZONES.map((g) => g.name).join(' · ')} — no-entry rules checked against the simulated route every simulated minute.
        </p>
        {info.restricted.length ? (
          <ul className="fv-list">
            {info.restricted.slice(0, 4).map((x) => (
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
          <p className="fv-muted">No restricted-zone entry today.</p>
        )}
      </div>

      <div className="fleet-detail-sec">
        <h4>Movement history</h4>
        <DataTable
          columns={[
            { key: 'a', header: 'Activity', render: (l) => l.activity },
            { key: 'z', header: 'Zone', render: (l) => <span className="dim">{geofenceName(l.zone)}</span> },
            { key: 's', header: 'Start', numeric: true, render: (l) => clock(l.start) },
            { key: 'd', header: 'Duration', numeric: true, render: (l) => (l.open ? <span className="dim">{dur(l.duration)} …</span> : dur(l.duration)) },
          ]}
          rows={info.legs}
          rowKey={(l) => `${l.start}-${l.activity}`}
          maxHeight={210}
          empty="No movements recorded yet"
        />
      </div>
    </>
  );
}
