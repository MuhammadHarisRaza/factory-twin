import type { OpEvent } from '../../model/types';
import { openEvent } from '../../app/store';
import { SeverityBadge } from '../kit/Status';

/** Compact list of events (placeholder — replaced by the events builder). */
export type EventListProps = {
  events: OpEvent[];
  /** Max rows (default all). */
  limit?: number;
  /** Hide the asset column (when the list is already about one asset). */
  hideAsset?: boolean;
  empty?: string;
};

export function EventList({ events, limit, empty = 'No events' }: EventListProps) {
  const rows = limit ? events.slice(0, limit) : events;
  if (!rows.length) return <div className="muted">{empty}</div>;
  return (
    <ul>
      {rows.map((e) => (
        <li key={e.id}>
          <button className="btn ghost sm" onClick={() => openEvent(e.id)}>
            <SeverityBadge severity={e.severity} /> {e.id} · {e.title}
          </button>
        </li>
      ))}
    </ul>
  );
}
