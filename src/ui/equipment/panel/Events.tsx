/**
 * Recent events of the subject, compact: open ones first, then the newest resolved (repeated types
 * collapsed, "+N earlier"). Each row shows severity (icon and word), title, time, status and one impact
 * line; it expands in place to the record's facts, cause and recommendation with "Open report". A row
 * whose event an insight already presents above (its title and impact) is collapsed to title, time and
 * status. "View all" opens Events & Reports filtered to the subject for all recorded time (the count is
 * that list's).
 */
import { ChevronDown, FileText, ListFilter } from 'lucide-react';
import type { OpEvent } from '../../../model/types';
import { EVENT_TYPE_LABEL } from '../../../sim/events';
import { formatDuration } from '../../../sim/time';
import { clockLabel } from '../../../intel/summary';
import { openEventRecord } from '../../events/open';
import { EVENT_STATUS, SEVERITY } from '../../kit/Status';
import type { IntelEvents } from '../intel/types';

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
            const sev = SEVERITY[e.severity];
            const SevIcon = sev.icon;
            const st = EVENT_STATUS[e.status];
            const StIcon = st.icon;
            const isOpen = open === e.id;
            const above = shownAbove?.has(e.id) ?? false;
            return (
              <li key={e.id} className={`eqp-ev ${isOpen ? 'open' : ''} ${e.status === 'resolved' ? 'done' : ''}`} data-event={e.id}>
                <button type="button" className="eqp-ev-h" aria-expanded={isOpen} onClick={() => onToggle(e.id)}>
                  <span className={`status ${sev.tone} sev`} aria-hidden>
                    <SevIcon size={13} strokeWidth={2.2} />
                  </span>
                  <span className="m">
                    <span className="t">{e.title}</span>
                    <span className="w num">
                      {/* Severity in words, never colour alone (warning and serious share an icon shape). */}
                      <span className={`sevw ${sev.tone}`}>{sev.label}</span>
                      {when(e, now)}
                      <span className={`status ${st.tone} st`}>
                        <StIcon size={11} strokeWidth={2.2} aria-hidden />
                        {st.label}
                      </span>
                      {earlier ? <span className="more">+{earlier} earlier</span> : null}
                    </span>
                    {impact && !above && <span className="imp">{impact}</span>}
                  </span>
                  <ChevronDown size={14} className="chev" aria-hidden />
                </button>
                {isOpen && <Detail e={e} />}
              </li>
            );
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
