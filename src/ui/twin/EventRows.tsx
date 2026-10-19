/**
 * Operational events (src/sim/events.ts) as compact rows for the twin overlays: the live
 * list and the equipment workspace. Each row opens THE event record (Events & Reports,
 * where its report and PDF live); a secondary action shows the affected object in 3D.
 */
import { memo } from 'react';
import { FileText, LocateFixed } from 'lucide-react';
import { openEvent } from '../../app/store';
import { INSPECTION_STATIONS } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { formatClock, formatDuration } from '../../sim/time';
import { useTwin } from '../../store';
import { EVENT_STATUS, SEVERITY, StatusBadge } from '../kit/Status';
import { eventSubject, eventWhen } from './derive';
import { useTwinUi } from './uiStore';

/** 3D target of an event: a vehicle, else the asset / station, else its zone. */
export function eventTarget(ev: OpEvent): { kind: 'vehicle' | 'equipment' | 'zone'; id: string } | null {
  if (ev.asset.vehicleId) return { kind: 'vehicle', id: ev.asset.vehicleId };
  const eq = ev.asset.equipmentId ?? INSPECTION_STATIONS.find((x) => x.id === ev.asset.stationId)?.equipmentId;
  if (eq) return { kind: 'equipment', id: eq };
  if (ev.asset.zone) return { kind: 'zone', id: ev.asset.zone };
  return null;
}

/** Show the event's object in the 3D factory without leaving the twin; an asset's workspace opens at its events. */
export function locateEvent(ev: OpEvent) {
  const t = eventTarget(ev);
  if (!t) return;
  const tw = useTwin.getState();
  if (t.kind === 'vehicle') tw.selectVehicle(t.id, true);
  else if (t.kind === 'equipment') {
    useTwinUi.getState().focusSection(t.id, 'events');
    tw.select(t.id);
  } else tw.selectZone(t.id);
}

/** Severity + lifecycle status as two small pills (icon + label each). */
export function EventPills({ ev }: { ev: OpEvent }) {
  return (
    <span className="tw-ev-pills">
      <span className="tw-mini">
        <StatusBadge {...SEVERITY[ev.severity]} size={11} />
      </span>
      <span className="tw-mini">
        <StatusBadge {...EVENT_STATUS[ev.status]} size={11} />
      </span>
    </span>
  );
}

/**
 * Everything a live row shows of its event record. The record is mutated in place by the simulation, so the list
 * passes this text and the row re-renders only when it (or the selection mark) changes.
 */
export const liveRowShown = (ev: OpEvent, now: number) =>
  [ev.title, ev.severity, ev.status, eventSubject(ev), ev.end == null ? `ongoing ${formatDuration(now - ev.start)}` : `cleared ${formatClock(ev.end)}`, ev.source, ev.start, eventTarget(ev)?.id ?? ''].join('\n');

/** Live-list row: opens the event; the locate button frames its object in 3D (`onLocate` gets the event). */
export const LiveEventRow = memo(
  function LiveEventRow({ ev, now, on, onLocate }: { ev: OpEvent; now: number; on: boolean; onLocate: (ev: OpEvent) => void; shown: string }) {
    return <LiveEventRowView ev={ev} now={now} on={on} onLocate={() => onLocate(ev)} />;
  },
  (a, b) => a.ev === b.ev && a.shown === b.shown && a.on === b.on && a.onLocate === b.onLocate,
);

function LiveEventRowView({ ev, now, on, onLocate }: { ev: OpEvent; now: number; on: boolean; onLocate: () => void }) {
  const target = eventTarget(ev);

  return (
    <div className={`tw-evrow ${on ? 'on' : ''}`}>
      <button className="tw-row" onClick={() => openEvent(ev.id)} title={`Open ${ev.id} in Events & Reports (report, evidence, lifecycle)`}>
        <span className="tw-row-m">
          <b>{ev.title}</b>
          <span className="tw-ev-meta">
            <EventPills ev={ev} />
            <small className="num">
              {eventSubject(ev)} · {ev.end == null ? `ongoing ${formatDuration(now - ev.start)}` : `cleared ${formatClock(ev.end)}`}
              {ev.source === 'scenario' ? ' · scenario' : ''}
            </small>
          </span>
        </span>
        <span className="tw-row-t num">{formatClock(ev.start)}</span>
      </button>
      <button
        className="btn ghost sm icon tw-loc"
        onClick={onLocate}
        disabled={!target}
        title={target ? `Show ${target.id} in 3D` : 'No location for this event'}
        aria-label={`Show ${ev.id} in 3D`}
      >
        <LocateFixed size={13} />
      </button>
    </div>
  );
}

/** Inspector list: title, type and window, lifecycle status, owner and the report link. */
export function AssetEventList({ events, now, empty }: { events: OpEvent[]; now: number; empty: string }) {
  if (!events.length) return <p className="insp-desc">{empty}</p>;
  return (
    <div className="tw-evl">
      {events.map((ev) => {
        const sev = SEVERITY[ev.severity];
        const Icon = sev.icon;
        return (
          <div key={ev.id} className="tw-evl-r">
            <span className={`status ${sev.tone}`} title={sev.label}>
              <Icon size={13} strokeWidth={2.2} aria-label={sev.label} />
            </span>
            <div className="tw-evl-m">
              <b>{ev.title}</b>
              <small className="num">
                <span className="mono">{ev.id}</span> · {EVENT_TYPE_LABEL[ev.type]} · {eventWhen(ev, now)}
              </small>
              <span className="tw-ev-meta">
                <EventPills ev={ev} />
                {(ev.owner || ev.reports.length > 0 || ev.source === 'scenario') && (
                  <small>
                    {[ev.owner ? `Owner ${ev.owner}` : null, ev.reports.length ? `PDF exported ${ev.reports.length}×` : null, ev.source === 'scenario' ? 'scenario' : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                )}
              </span>
            </div>
            <button className="btn sm tw-evl-rep" onClick={() => openEvent(ev.id)} title={`Open the report of ${ev.id} in Events & Reports`}>
              <FileText size={13} />
              Report
            </button>
          </div>
        );
      })}
    </div>
  );
}
