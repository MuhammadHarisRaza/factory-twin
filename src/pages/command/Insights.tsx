/** Operational insights feed and the prioritised next-actions checklist. */
import { useState } from 'react';
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import type { Insight } from '../../intel/insights';
import { Empty, Panel } from '../../ui/kit/Panel';
import { LinkButton } from '../../ui/copilot/links';
import { INSIGHT_KIND, INSIGHT_SEVERITY, InsightBadge } from './badges';

const FEED_INITIAL = 5;
/** Links back to this workspace add nothing on the Command Center itself. */
const visibleLinks = (i: Insight) => i.links.filter((l) => !(l.kind === 'workspace' && l.id === 'command'));

export function InsightsFeed({ items }: { items: Insight[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FEED_INITIAL);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const actionable = items.filter((i) => i.severity === 'critical' || i.severity === 'serious' || i.severity === 'warning').length;

  return (
    <Panel
      title="Operational insights"
      subtitle={`Rule-based on the current demo state · ${items.length} ${items.length === 1 ? 'insight' : 'insights'}, ${actionable} need attention · most important first`}
      footer={
        items.length > FEED_INITIAL ? (
          <button type="button" className="btn ghost sm" onClick={() => setAll(!all)}>
            {all ? 'Show the top 5' : `Show all ${items.length} insights`}
          </button>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <Empty title="No insights right now">The rules found nothing unusual in the current demo state.</Empty>
      ) : (
        <div className="cc-feed">
          {shown.map((i) => (
            <InsightCard key={i.id} insight={i} open={expanded.has(i.id)} onToggle={() => toggle(i.id)} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function InsightCard({ insight: i, open, onToggle }: { insight: Insight; open: boolean; onToggle: () => void }) {
  const links = visibleLinks(i);
  const evId = `cc-ev-${i.id}`;
  return (
    <article className={`cc-ins ${INSIGHT_SEVERITY[i.severity].tone}`}>
      <div className="cc-ins-top">
        <InsightBadge severity={i.severity} />
        <span className="cc-ins-kind">{INSIGHT_KIND[i.kind]}</span>
      </div>
      <h3>{i.title}</h3>
      <p className="cc-ins-sum">{i.summary}</p>
      {(i.impact || i.recommendation) && (
        <dl className="cc-ins-dl">
          {i.impact && (
            <>
              <dt>Impact</dt>
              <dd>{i.impact}</dd>
            </>
          )}
          {i.recommendation && (
            <>
              <dt>Recommendation</dt>
              <dd>{i.recommendation}</dd>
            </>
          )}
        </dl>
      )}
      <div className="cc-ins-f">
        {i.evidence.length > 0 && (
          <button type="button" className="btn ghost sm cc-ev-toggle" aria-expanded={open} aria-controls={evId} onClick={onToggle}>
            {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            Evidence ({i.evidence.length})
          </button>
        )}
        <div className="spacer" />
        {links.map((l, k) => (
          <LinkButton key={`${l.kind}:${l.id}:${k}`} link={l} />
        ))}
      </div>
      {open && i.evidence.length > 0 && (
        <ul className="cc-ev" id={evId}>
          {i.evidence.map((e, k) => (
            <li key={k}>{e}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function NextActions({ items }: { items: Insight[] }) {
  // Acknowledgement is view state only: it is not saved anywhere and resets with the page.
  const [ack, setAck] = useState<Set<string>>(() => new Set());
  const done = items.filter((i) => ack.has(i.id)).length;
  const toggle = (id: string) =>
    setAck((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Panel
      title="Recommended next actions"
      subtitle={items.length ? `Priority order · ${done} of ${items.length} acknowledged` : 'Priority order'}
      actions={
        done > 0 ? (
          <button type="button" className="btn ghost sm" onClick={() => setAck(new Set())}>
            Reset
          </button>
        ) : undefined
      }
      footer={<span>Rule-based recommendations from the current demo state. Acknowledgement is local to this view and is not saved or sent anywhere.</span>}
    >
      {items.length === 0 ? (
        <div className="empty">
          <ListChecks size={22} aria-hidden />
          <b>Nothing needs intervention</b>
          No stoppages, health warnings, quality or energy exceptions are active.
        </div>
      ) : (
        <ol className="cc-acts">
          {items.map((i, n) => {
            const on = ack.has(i.id);
            const link = visibleLinks(i)[0];
            return (
              <li key={i.id} className={on ? 'ack' : undefined}>
                <label className="cc-act-check" title={on ? 'Mark as not acknowledged' : 'Mark as acknowledged'}>
                  <input type="checkbox" checked={on} onChange={() => toggle(i.id)} aria-label={`Acknowledge: ${i.title}`} />
                  <span className="cc-act-n">{n + 1}</span>
                </label>
                <div className="cc-act-b">
                  <div className="cc-act-t">
                    <b>{i.title}</b>
                  </div>
                  <p>{i.recommendation}</p>
                  <div className="cc-act-meta">
                    <InsightBadge severity={i.severity} />
                    {i.impact && <span className="cc-act-impact">{i.impact}</span>}
                  </div>
                </div>
                {link && (
                  <div className="cc-act-link">
                    <LinkButton link={link} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
