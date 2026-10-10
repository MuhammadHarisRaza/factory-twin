/**
 * Operational events on the Command Center: the open events (the same records as Events &
 * Reports — unacknowledged first) and the next actions they call for, with the lifecycle step
 * (acknowledge / start investigating) taken from here on the shared record.
 */
import { useState } from 'react';
import { ArrowRight, Check, ClipboardList, ListChecks, Locate, Search } from 'lucide-react';
import { openEvent, openEventInTwin, useApp } from '../../app/store';
import { EVENT_CATEGORY_LABEL } from '../../sim/events';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock, formatDuration } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { Panel, Segmented } from '../../ui/kit/Panel';
import { EventStatusBadge, SeverityBadge } from '../../ui/kit/Status';
import { eventActions, eventCounts, prioritisedEvents, type EventScope } from './derive';

const LIST_LIMIT = 12;

export function ActiveEvents() {
  const go = useApp((s) => s.go);
  const [scope, setScope] = useState<EventScope>('open');
  const d = useSimValue((s) => {
    const open = prioritisedEvents(s, 'open');
    return { counts: eventCounts(open), rows: scope === 'open' ? open : prioritisedEvents(s, scope) };
  }, [scope]);
  const c = d.counts;
  const cats = (Object.keys(c.byCategory) as (keyof typeof c.byCategory)[]).filter((k) => c.byCategory[k] > 0);
  return (
    <Panel
      title="Active events"
      subtitle={`${c.open} open · ${c.unacknowledged} unacknowledged · ${c.conditionActive} condition active${cats.length ? ` · ${cats.map((k) => `${c.byCategory[k]} ${EVENT_CATEGORY_LABEL[k].toLowerCase()}`).join(', ')}` : ''} · unacknowledged first`}
      actions={
        <Segmented<EventScope>
          label="Event scope"
          value={scope}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'unacknowledged', label: 'Unacknowledged' },
            { value: 'condition', label: 'Condition active' },
          ]}
          onChange={setScope}
        />
      }
      footer={
        <>
          <span>Detected by rules on simulated signals and records. Each row opens the event report — the same record, evidence and impact as the PDF.</span>
          <div className="spacer" />
          <button type="button" className="btn ghost sm" onClick={() => go('events')} title="Open Events & Reports">
            All events
            <ArrowRight size={12} aria-hidden />
          </button>
        </>
      }
    >
      <EventList
        events={d.rows}
        limit={LIST_LIMIT}
        empty={scope === 'unacknowledged' ? 'Every open event has been acknowledged' : scope === 'condition' ? 'No event condition is active right now' : 'No open events — the plant is running without exceptions'}
      />
      {d.rows.length > LIST_LIMIT && (
        <p className="cc-more">
          Showing {LIST_LIMIT} of {d.rows.length} ·{' '}
          <button type="button" className="row-link" onClick={() => go('events')}>
            see all in Events &amp; Reports
          </button>
        </p>
      )}
    </Panel>
  );
}

const ACTIONS_INITIAL = 6;

/** Next actions from open events: what the record recommends and the next lifecycle step. */
export function EventActions() {
  const acknowledge = useSim((s) => s.acknowledge);
  const investigate = useSim((s) => s.investigate);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const d = useSimValue((s) => ({ now: s.minute, items: eventActions(s) }));
  const shown = all ? d.items : d.items.slice(0, ACTIONS_INITIAL);
  const pending = d.items.filter((a) => a.next === 'acknowledge').length;

  const step = (id: string, fn: (id: string) => { ok: boolean; reason?: string }) => {
    const r = fn(id);
    setError(r.ok ? null : { id, text: r.reason ?? 'Not possible' });
  };

  return (
    <Panel
      title="Next actions"
      subtitle={d.items.length ? `From ${d.items.length} open ${d.items.length === 1 ? 'event' : 'events'} · ${pending} to acknowledge · priority order` : 'From open events · priority order'}
      footer={
        d.items.length > ACTIONS_INITIAL ? (
          <button type="button" className="btn ghost sm" onClick={() => setAll(!all)}>
            {all ? `Show the top ${ACTIONS_INITIAL}` : `Show all ${d.items.length}`}
          </button>
        ) : (
          <span>Recommendations are rule-based on the event record. Acknowledging here changes the shared record (history shows who and when).</span>
        )
      }
    >
      {d.items.length === 0 ? (
        <div className="empty">
          <ListChecks size={22} aria-hidden />
          <b>Nothing needs intervention</b>
          No open event: stops, data-feed, condition, quality, vehicle and energy rules are all clear.
        </div>
      ) : (
        <ol className="cc-acts">
          {shown.map(({ ev, action, next }, n) => (
            <li key={ev.id} className={next === 'acknowledge' ? undefined : 'ack'}>
              <span className="cc-act-n" aria-hidden>
                {n + 1}
              </span>
              <div className="cc-act-b">
                <div className="cc-act-t">
                  <b>{ev.title}</b>
                </div>
                <p>{action}</p>
                <div className="cc-act-meta">
                  <SeverityBadge severity={ev.severity} />
                  <EventStatusBadge status={ev.status} />
                  <span className="cc-act-impact">
                    <span className="mono">{ev.id}</span> · {ev.end == null ? `since ${formatClock(ev.start)} · ${formatDuration(d.now - ev.start)}` : `cleared ${formatClock(ev.end)}`}
                    {ev.owner ? ` · owner ${ev.owner}` : ''}
                  </span>
                  {ev.source === 'scenario' && <span className="tag scenario">Scenario</span>}
                </div>
                {error?.id === ev.id && <p className="cc-act-err">{error.text}</p>}
              </div>
              <div className="cc-act-link">
                {next === 'acknowledge' ? (
                  <button type="button" className="btn sm primary" onClick={() => step(ev.id, acknowledge)} title="Acknowledge this event (you become its owner if it has none)">
                    <Check size={12} aria-hidden />
                    Acknowledge
                  </button>
                ) : next === 'investigate' ? (
                  <button type="button" className="btn sm" onClick={() => step(ev.id, investigate)} title="Mark the event as under investigation">
                    <Search size={12} aria-hidden />
                    Investigate
                  </button>
                ) : null}
                <button type="button" className="btn sm" onClick={() => openEvent(ev.id)} title={next === 'resolve' ? 'Open the report to resolve the event' : 'Open the event report'}>
                  <ClipboardList size={12} aria-hidden />
                  {next === 'resolve' ? 'Resolve…' : 'Report'}
                </button>
                <button type="button" className="btn sm ghost icon" onClick={() => openEventInTwin(ev)} title="Show in the Factory Twin" aria-label={`Show ${ev.id} in the Factory Twin`}>
                  <Locate size={12} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
