/**
 * Issues requiring attention: the priority list of the Overview (attentionEvents — unresolved
 * warning / serious / critical root events, most severe first). Three by default, up to five on
 * request; every other event is one click away in Events & Reports. Each item answers what, where,
 * when, the impact and the next step, and offers the investigation and its place in the model.
 */
import { useState } from 'react';
import { ArrowRight, CircleCheck, ClipboardList, Locate } from 'lucide-react';
import { openEvent, useApp } from '../../app/store';
import { useSimValue } from '../../sim/store';
import { EmptyState, ProvenanceBadge, Section } from '../../ui/kit/Page';
import { EventStatusBadge, SeverityBadge } from '../../ui/kit/Status';
import { ISSUES_ID, showEventInModel } from './actions';
import { ISSUES_MAX, ISSUES_SHOWN, issueRows, type IssueRow } from './derive';

function IssueItem({ r }: { r: IssueRow }) {
  const { ev, where, when, impact } = r;
  const subjects = where.subjects.map((x) => x.name).join(', ');
  return (
    <li className={`ov-is sev-${ev.severity}`}>
      <div className="ov-is-top">
        <SeverityBadge severity={ev.severity} />
        <EventStatusBadge status={ev.status} />
        <ProvenanceBadge kind={r.provenance} />
        <span className="ov-is-id mono">{ev.id}</span>
      </div>
      <h4 className="ov-is-title">{ev.title}</h4>
      <dl className="ov-is-f">
        <div>
          <dt>Where</dt>
          <dd>
            {where.place ?? 'Site'}
            {subjects && <span className="muted"> · {subjects}</span>}
          </dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>
            <span className="num">{when.clock}</span> · {when.ago} · {when.active ? <b className="ov-is-live">condition active</b> : <span>cleared {when.cleared}, not yet resolved</span>}
          </dd>
        </div>
        <div title={impact.basis || undefined}>
          <dt>Impact</dt>
          <dd>
            {impact.text}
            {impact.estimate && <ProvenanceBadge kind="estimate" className="ov-is-est" title={`Estimate — ${impact.basis}`} />}
          </dd>
        </div>
        <div title="Rule-based recommendation from the event record">
          <dt>Next step</dt>
          <dd>{r.next}</dd>
        </div>
      </dl>
      <div className="ov-is-a">
        <button type="button" className="btn sm primary" onClick={() => openEvent(ev.id)} title="Open the full event record — evidence, causes (with confidence), impact and lifecycle — in Events & Reports">
          <ClipboardList size={12} aria-hidden />
          Investigate
        </button>
        <button type="button" className="btn sm" onClick={() => showEventInModel(ev)} title="Select and mark what this event affects in the 3D model on this page">
          <Locate size={12} aria-hidden />
          Show in model
        </button>
      </div>
    </li>
  );
}

export function IssuesPanel() {
  const go = useApp((s) => s.go);
  const [more, setMore] = useState(false);
  const d = useSimValue((s) => issueRows(s, ISSUES_MAX));
  const shown = more ? d.rows : d.rows.slice(0, ISSUES_SHOWN);
  const extra = d.rows.length - ISSUES_SHOWN;
  return (
    <Section
      id={ISSUES_ID}
      className="ov-issues"
      title={
        <>
          Issues requiring attention
          {d.total > 0 && <span className="ov-count num">{d.total}</span>}
        </>
      }
      subtitle="Unresolved warning, serious and critical events · counted once per root cause · most severe first"
      actions={
        <button type="button" className="btn ghost sm" onClick={() => go('events')} title="Open Events & Reports">
          All events
          <ArrowRight size={12} aria-hidden />
        </button>
      }
      flush
    >
      {d.total === 0 ? (
        <EmptyState icon={CircleCheck} title="No issues require attention">
          No unresolved warning, serious or critical event. Detection rules run on the simulated signals and records every plant minute; anything they raise appears here.
        </EmptyState>
      ) : (
        <>
          <ol className="ov-iss">
            {shown.map((r) => (
              <IssueItem key={r.ev.id} r={r} />
            ))}
          </ol>
          {(extra > 0 || d.total > d.rows.length) && (
            <div className="ov-iss-foot">
              {extra > 0 && (
                <button type="button" className="btn ghost sm" onClick={() => setMore(!more)} aria-expanded={more}>
                  {more ? 'Show fewer' : `Show ${extra} more`}
                </button>
              )}
              {d.total > d.rows.length && (
                <span className="muted">
                  {more ? d.rows.length : Math.min(ISSUES_SHOWN, d.rows.length)} of {d.total} shown ·{' '}
                  <button type="button" className="row-link" onClick={() => go('events')}>
                    all in Events &amp; Reports
                  </button>
                </span>
              )}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
