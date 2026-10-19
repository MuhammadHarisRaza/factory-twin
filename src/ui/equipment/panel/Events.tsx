/**
 * Recent events of the subject, compact: open ones first, then the newest resolved (repeated types
 * collapsed, "+N earlier"). Each row shows severity (icon and word), title, time, status and one impact
 * line; it expands in place to the record's facts, cause and recommendation with "Open report". A row
 * whose event an insight already presents above (its title and impact) is collapsed to title, time and
 * status. "View all" opens Events & Reports filtered to the subject for all recorded time (the count is
 * that list's). The Events & alarms section adds the log (LogList): alarm codes and condition alerts, state transitions
 * (stops and restarts with durations and reasons) and data-quality entries, each with severity, time and source, under
 * a small type filter (eventFilterOptions / filterLog).
 */
import { memo } from 'react';
import { ChevronDown, FileText, ListFilter } from 'lucide-react';
import type { OpEvent } from '../../../model/types';
import { EVENT_TYPE_LABEL } from '../../../sim/events';
import { formatDuration } from '../../../sim/time';
import { clockLabel } from '../../../intel/summary';
import { openEventRecord } from '../../events/open';
import { EVENT_STATUS, SEVERITY } from '../../kit/Status';
import { deepEqual } from '../../kit/equal';
import type { IntelEvents, IntelLogEntry, IntelLogKind } from '../intel/types';

const when = (e: OpEvent, now: number) =>
  e.end == null ? `${clockLabel(e.start, now)} · ongoing ${formatDuration(now - e.start)}` : `${clockLabel(e.start, now)}–${clockLabel(e.end, now).replace(/^.* /, '')}`;

const CONFIDENCE: Record<string, string> = { confirmed: 'Cause', likely: 'Likely cause', possible: 'Possible contributing factor' };

function Detail({ e }: { e: OpEvent }) {
  const cause = e.causes[0];
  return (
    <div className="eqp-evd">
      {e.facts.length > 0 && (
        <ul className="eqp-evd-facts">
          {e.facts.slice(0, 4).map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {cause && (
        <p>
          <b>{CONFIDENCE[cause.confidence] ?? 'Cause'}</b> {cause.text}
          {cause.confidence !== 'confirmed' ? ' — not confirmed' : ''}
        </p>
      )}
      {e.recommendations[0] && (
        <p>
          <b>Recommended</b> {e.recommendations[0]}
        </p>
      )}
      <div className="eqp-evd-f">
        <span className="muted">
          <span className="mono">{e.id}</span> · {EVENT_TYPE_LABEL[e.type]} · rule {e.trigger.ruleId}
          {e.source === 'scenario' ? ' · scenario' : ''}
          {e.owner ? ` · owner ${e.owner}` : ''}
        </span>
        <button type="button" className="btn sm" onClick={() => openEventRecord(e.id)} title={`Open the report of ${e.id} in Events & Reports (evidence, lifecycle, PDF)`}>
          <FileText size={12} aria-hidden />
          Open report
        </button>
      </div>
    </div>
  );
}

type EventRowProps = {
  e: OpEvent;
  /** What the row shows of the record (the record itself is mutated in place by the simulation). */
  shown: { id: string; severity: OpEvent['severity']; status: OpEvent['status']; title: string; when: string; impact: string | null; earlier: number };
  isOpen: boolean;
  onToggle: (id: string) => void;
};

/** One event row; re-rendered only when what it shows changes (an open row, with the record's detail, every time). */
const EventRow = memo(
  function EventRow({ e, shown, isOpen, onToggle }: EventRowProps) {
    const sev = SEVERITY[shown.severity];
    const SevIcon = sev.icon;
    const st = EVENT_STATUS[shown.status];
    const StIcon = st.icon;
    return (
      <li className={`eqp-ev ${isOpen ? 'open' : ''} ${shown.status === 'resolved' ? 'done' : ''}`} data-event={shown.id}>
        <button type="button" className="eqp-ev-h" aria-expanded={isOpen} onClick={() => onToggle(shown.id)}>
          <span className={`status ${sev.tone} sev`} aria-hidden>
            <SevIcon size={13} strokeWidth={2.2} />
          </span>
          <span className="m">
            <span className="t">{shown.title}</span>
            <span className="w num">
              {/* Severity in words, never colour alone (warning and serious share an icon shape). */}
              <span className={`sevw ${sev.tone}`}>{sev.label}</span>
              {shown.when}
              <span className={`status ${st.tone} st`}>
                <StIcon size={11} strokeWidth={2.2} aria-hidden />
                {st.label}
              </span>
              {shown.earlier ? <span className="more">+{shown.earlier} earlier</span> : null}
            </span>
            {shown.impact && <span className="imp">{shown.impact}</span>}
          </span>
          <ChevronDown size={14} className="chev" aria-hidden />
        </button>
        {isOpen && <Detail e={e} />}
      </li>
    );
  },
  (a, b) => !a.isOpen && !b.isOpen && a.onToggle === b.onToggle && deepEqual(a.shown, b.shown),
);

export function EventList({
  events,
  now,
  open,
  onToggle,
  onViewAll,
  subject,
  empty,
  shownAbove,
}: {
  events: IntelEvents;
  now: number;
  open: string | null;
  onToggle: (id: string) => void;
  onViewAll: () => void;
  subject: string;
  /** What an empty list says (default: no event recorded for the subject); a list of open events only says "No open event …". */
  empty?: string;
  /** Events an insight above already presents: their row shows no impact line. */
  shownAbove?: ReadonlySet<string>;
}) {
  return (
    <>
      {events.rows.length ? (
        <ul className="eqp-evs">
          {events.rows.map(({ event: e, impact, earlier }) => {
            const above = shownAbove?.has(e.id) ?? false;
            const shown = { id: e.id, severity: e.severity, status: e.status, title: e.title, when: when(e, now), impact: impact && !above ? impact : null, earlier: earlier ?? 0 };
            return <EventRow key={e.id} e={e} shown={shown} isOpen={open === e.id} onToggle={onToggle} />;
          })}

        </ul>
      ) : (
        <p className="eqp-empty">{empty ?? `No event recorded for ${subject}.`}</p>
      )}
      {events.total > 0 && (
        <button type="button" className="eqp-more" onClick={onViewAll} title={`Events & Reports, filtered to ${subject} for all recorded time`}>
          <ListFilter size={12} aria-hidden />
          View all {events.total} event{events.total === 1 ? '' : 's'}
        </button>
      )}
    </>
  );
}

// ── Alarms, state transitions and data-quality entries ───────────────────────

export type EventFilter = 'all' | 'alarm' | 'event' | 'state' | 'data';

const FILTER_LABEL: Record<EventFilter, string> = { all: 'All', alarm: 'Alarms', event: 'Events', state: 'State', data: 'Data quality' };

/** The filter options with their counts (a type without entries is still offered, with 0). */
export function eventFilterOptions(events: IntelEvents, log: IntelLogEntry[]): { value: EventFilter; label: string; n: number }[] {
  const n = (k: IntelLogKind) => log.filter((e) => e.kind === k).length;
  const counts: Record<EventFilter, number> = { all: events.rows.length + log.length, alarm: n('alarm'), event: events.rows.length, state: n('state'), data: n('data') };
  return (Object.keys(FILTER_LABEL) as EventFilter[]).map((value) => ({ value, label: FILTER_LABEL[value], n: counts[value] }));
}

/** Log entries a filter shows (newest first; 'all' caps the list, 'events' shows none — the records are listed above). */
export function filterLog(log: IntelLogEntry[], f: EventFilter, max = 8): IntelLogEntry[] {
  if (f === 'event') return [];
  const xs = f === 'all' ? log : log.filter((e) => e.kind === f);
  return f === 'all' ? xs.slice(0, max) : xs.slice(0, 30);
}

const KIND_WORD: Record<IntelLogKind, string> = { alarm: 'Alarm', state: 'State', data: 'Data quality' };

/** One log entry (a derived model, rebuilt each minute): re-rendered only when it or its time text changes. */
const LogRow = memo(
  function LogRow({ e, time, onEvent }: { e: IntelLogEntry; time: string; onEvent?: (id: string) => void }) {
    const sev = SEVERITY[e.severity];
    const SevIcon = sev.icon;
    const body = (
      <span className="m">
        <span className="t">{e.title}</span>
        <span className="w num">
          <span className={`sevw ${sev.tone}`}>{sev.label}</span>
          <span className="kind">{KIND_WORD[e.kind]}</span>
          {time}
        </span>
        {e.detail && <span className="imp">{e.detail}</span>}
        <span className="src">{e.source}</span>
      </span>
    );
    return (
      <li className="eqp-ev eqp-log-r" data-log={e.id}>
        {e.eventId && onEvent ? (
          <button type="button" className="eqp-ev-h" onClick={() => onEvent(e.eventId!)} title={`Open ${e.eventId}`}>
            <span className={`status ${sev.tone} sev`} aria-hidden>
              <SevIcon size={13} strokeWidth={2.2} />
            </span>
            {body}
          </button>
        ) : (
          <div className="eqp-ev-h">
            <span className={`status ${sev.tone} sev`} aria-hidden>
              <SevIcon size={13} strokeWidth={2.2} />
            </span>
            {body}
          </div>
        )}
      </li>
    );
  },
  (a, b) => a.time === b.time && a.onEvent === b.onEvent && deepEqual(a.e, b.e),
);

export function LogList({ entries, now, onEvent, empty }: { entries: IntelLogEntry[]; now: number; onEvent?: (id: string) => void; empty?: string }) {
  if (!entries.length) return empty ? <p className="eqp-empty">{empty}</p> : null;
  return (
    <ul className="eqp-evs eqp-log">
      {entries.map((e) => {
        const time = e.end === undefined ? clockLabel(e.t, now) : e.end == null ? `${clockLabel(e.t, now)} · ongoing ${formatDuration(now - e.t)}` : `${clockLabel(e.t, now)}–${clockLabel(e.end, now).replace(/^.* /, '')}`;
        return <LogRow key={e.id} e={e} time={time} onEvent={onEvent} />;
      })}
    </ul>
  );
}
