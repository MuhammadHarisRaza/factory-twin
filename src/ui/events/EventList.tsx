/**
 * Compact list of event records — used by every workspace (stage, vehicle, quality views) and by
 * Events & Reports. Each row is the same OpEvent record the report and the PDF are built from;
 * selecting one opens its full report (or calls `onSelect` when the host shows the report itself).
 */
import { CircleCheck, CircleDot } from 'lucide-react';
import { useApp } from '../../app/store';
import type { OpEvent } from '../../model/types';
import { EVENT_CATEGORY_LABEL } from '../../sim/events';
import { useSim, useSimMinute } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { EventStatusBadge, SeverityBadge } from '../kit/Status';
import { eventAssetLabel, eventDurationLabel, eventStartLabel } from './labels';
import { openEventRecord } from './open';
import './events.css';

export type EventListProps = {
  events: OpEvent[];
  /** Max rows (default all). */
  limit?: number;
  /** Hide the asset column (when the list is already about one asset). */
  hideAsset?: boolean;
  empty?: string;
  /** Highlighted row (Events & Reports). */
  selectedId?: string | null;
  /** Called instead of opening the report in Events & Reports. */
  onSelect?: (ev: OpEvent) => void;
};

export function EventList({ events, limit, hideAsset = false, empty = 'No events', selectedId = null, onSelect }: EventListProps) {
  const now = useSimMinute();
  const vehicles = useSim((s) => s.sim.logistics.vehicles);
  const rows = limit ? events.slice(0, limit) : events;
  if (!rows.length) return <div className="evl-empty">{empty}</div>;
  const vehicleLabel = (id: string) => vehicles[id]?.label;
  const more = limit ? events.length - rows.length : 0;
  return (
    <div className="evl-wrap">
      <ul className="evl">
        {rows.map((ev) => (
          <li key={ev.id}>
            <EventRow ev={ev} now={now} hideAsset={hideAsset} selected={ev.id === selectedId} vehicleLabel={vehicleLabel} onClick={() => (onSelect ? onSelect(ev) : openEventRecord(ev.id))} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button
          className="row-link evl-more"
          onClick={() => {
            useApp.getState().setTab('events', null);
            useApp.getState().go('events');
          }}
        >
          {more} more — open Events & Reports
        </button>
      )}
    </div>
  );
}

export function EventRow({
  ev,
  now,
  hideAsset = false,
  selected = false,
  vehicleLabel,
  onClick,
}: {
  ev: OpEvent;
  now: number;
  hideAsset?: boolean;
  selected?: boolean;
  vehicleLabel?: (id: string) => string | undefined;
  onClick: () => void;
}) {
  const active = ev.end == null;
  return (
    <button className={`evl-row ${selected ? 'sel' : ''}`} onClick={onClick} aria-current={selected ? 'true' : undefined} data-ev={ev.id} title={`${ev.id} — open the event report`}>
      <span className="evl-l1">
        <span className="evl-id mono">{ev.id}</span>
        <span className="evl-title">{ev.title}</span>
        <span className="evl-time num">{eventStartLabel(ev, now)}</span>
      </span>
      <span className="evl-l2">
        <SeverityBadge severity={ev.severity} />
        <EventStatusBadge status={ev.status} />
        {active ? (
          <span className="status warning evl-cond">
            <CircleDot size={13} strokeWidth={2.2} aria-hidden />
            Condition active
          </span>
        ) : (
          <span className="status good evl-cond">
            <CircleCheck size={13} strokeWidth={2.2} aria-hidden />
            Cleared {formatClock(ev.end!)}
          </span>
        )}
        <span className="evl-meta">
          {EVENT_CATEGORY_LABEL[ev.category]}
          {!hideAsset && <> · {eventAssetLabel(ev, vehicleLabel)}</>}
        </span>
        <span className="evl-dur num">{eventDurationLabel(ev, now)}</span>
        {ev.source === 'scenario' && <span className="tag scenario">Scenario</span>}
        {ev.historical && <span className="tag" title="Detected in the pre-rolled history, before this demo session started">History</span>}
      </span>
    </button>
  );
}
