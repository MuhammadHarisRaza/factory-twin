/**
 * Context column beside the site layout while no vehicle is selected: dock usage now (each dock's
 * state, its truck and loading progress) and the vehicle alerts whose condition is still active.
 * Selecting a dock's truck or an alert opens that vehicle's detail on this page.
 */
import { MousePointerClick, ShieldAlert } from 'lucide-react';
import { openEvent } from '../../app/store';
import type { OpEvent } from '../../model/types';
import { EventList } from '../../ui/events/EventList';
import { Section } from '../../ui/kit/Page';
import { StatusBadge } from '../../ui/kit/Status';
import { DOCK_STATUS, dur, type Clock } from './common';
import type { DockRow } from './derive';
import { geofenceName } from './derive';

export function SiteNow({
  docks,
  occupied,
  reserved,
  alerts,
  inside,
  now,
  clock,
  selected,
  onSelect,
}: {
  docks: DockRow[];
  occupied: number;
  reserved: number;
  /** Vehicle events whose condition is still active (most recent first). */
  alerts: OpEvent[];
  /** Vehicles inside a restricted geofence now → geofence id. */
  inside: [string, string][];
  now: number;
  clock: Clock;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Section title="Docks & alerts now" subtitle={`Plant time ${clock(now)} · ${occupied} of ${docks.length} docks occupied${reserved ? ` · ${reserved} reserved` : ''}`} className="fl-now">
      <ul className="fl-docks" aria-label="Loading docks now">
        {docks.map((d) => {
          const st = DOCK_STATUS[d.status];
          const body = (
            <>
              <span className="fl-dock-h">
                <b>{d.name}</b>
                <StatusBadge {...st} size={12} />
              </span>
              {d.truck ? (
                <span className="fl-dock-t">
                  <span className="mono">{d.truck.id}</span>
                  <span className="muted">
                    {d.status === 'reserved'
                      ? `on the way · assigned ${d.since != null ? clock(d.since) : '—'}`
                      : `${dur(d.dockTime)} at dock · ${d.loaded ?? 0}/${d.load ?? 0} pallets`}
                  </span>
                </span>
              ) : (
                <span className="fl-dock-t muted">No truck</span>
              )}
            </>
          );
          return (
            <li key={d.id}>
              {d.truck ? (
                <button type="button" className={`fl-dock ${d.status} ${selected === d.truck.id ? 'sel' : ''}`} aria-pressed={selected === d.truck.id} onClick={() => onSelect(d.truck!.id)} title={`Select ${d.truck.id}`}>
                  {body}
                </button>
              ) : (
                <div className={`fl-dock ${d.status}`}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="fl-now-sec">
        <h4>Active vehicle alerts · {alerts.length}</h4>
        <EventList
          events={alerts}
          limit={5}
          empty="No vehicle alert is active — every vehicle rule is within its limit."
          onSelect={(ev) => (ev.asset.vehicleId ? onSelect(ev.asset.vehicleId) : openEvent(ev.id))}
        />
        {inside.length > 0 && (
          <p className="fl-inside">
            <StatusBadge tone="warning" icon={ShieldAlert} label="Inside a restricted zone now" />{' '}
            {inside.map(([id, gf], i) => (
              <span key={id}>
                {i > 0 && ', '}
                <button type="button" className="row-link mono" onClick={() => onSelect(id)}>
                  {id}
                </button>{' '}
                <span className="dim">({geofenceName(gf)})</span>
              </span>
            ))}
          </p>
        )}
      </div>

      <p className="fl-hint">
        <MousePointerClick size={13} aria-hidden /> Select a vehicle on the layout, in the movement flow or in the delay review for its location, movement, dwell, events and reference footage.
      </p>
    </Section>
  );
}
