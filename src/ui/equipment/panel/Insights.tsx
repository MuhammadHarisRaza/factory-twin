/**
 * "What matters": one to three interpretations of the subject's data, most important first. Each card
 * shows, by default, its severity (icon and word), its title, a short headline of what was observed,
 * the evidence (an event chip opens the event, a signal chip brings its row into view — named, not
 * restating the value the text gives), the next step and what the insight rests on (a configured rule,
 * a scenario input or an event rule — never a prediction). The rest of the observation and why it
 * matters open with "Details", so the panel reads in seconds and never shows a wall of text.
 */
import { memo, useState } from 'react';
import { sameProps } from '../../kit/equal';

import { Activity, ArrowRight, ChevronDown, FileText, Gauge, ListChecks } from 'lucide-react';
import type { IntelEvidence, IntelInsight } from '../intel/types';
import { SEVERITY_META } from './tone';

const CERTAINTY: Record<IntelInsight['certainty'], string> = {
  observed: 'Observed in the simulated data.',
  likely: 'Likely: traced through the line model, not confirmed.',
  possible: 'Possible contributing factor: requires investigation.',
};

const BASIS: Record<IntelInsight['basis'], string> = {
  rule: 'A configured, deterministic rule evaluated on the simulated signals — not a prediction or a trained model.',
  scenario: 'Caused by a scenario input the presenter started; detected by the event rule named here.',
  event: 'From the event record raised by the event engine rule named here.',
};

const EV_ICON = { signal: Activity, event: FileText, metric: Gauge, rule: ListChecks } as const;

/** Longest headline shown before "Details" (characters). */
const HEADLINE_MAX = 150;

/**
 * The observation split into a headline (its first sentence, or about 140 characters cut at a word)
 * and the rest. A sentence ends at ". ", "! " or "? " before a capital letter, a digit or an id.
 */
export function splitObserved(text: string): { head: string; rest: string; cut: boolean } {
  const m = /^(.+?[.!?])\s+(?=[A-Z0-9“"(])/.exec(text);
  const first = m ? m[1] : text;
  if (first.length <= HEADLINE_MAX) return { head: first, rest: text.slice(first.length).trim(), cut: false };
  const at = text.lastIndexOf(' ', 140);
  return { head: `${text.slice(0, at > 60 ? at : 140).replace(/[,;:—–\s]+$/, '')} …`, rest: text, cut: true };
}

function Evidence({ e, onSignal, onEvent, hasSignal }: { e: IntelEvidence; onSignal: (id: string) => void; onEvent: (id: string) => void; hasSignal: (id: string) => boolean }) {
  const Icon = EV_ICON[e.kind];
  if (e.kind === 'event' && e.ref) {
    const ref = e.ref;
    return (
      <li>
        <button type="button" className="eqp-chip link" onClick={() => onEvent(ref)} title={`Open ${ref}`}>
          <Icon size={11} aria-hidden />
          {e.label}
        </button>
      </li>
    );
  }
  if (e.kind === 'signal' && e.ref && hasSignal(e.ref)) {
    const ref = e.ref;
    // A link to the signal row: named by the signal; the value is in the text and in the row.
    return (
      <li>
        <button type="button" className="eqp-chip link" onClick={() => onSignal(ref)} title={`Show the signal ${ref} — ${e.label}`}>
          <Icon size={11} aria-hidden />
          {e.short ?? e.label}
        </button>
      </li>
    );
  }
  return (
    <li>
      <span className="eqp-chip" title={e.ref ? `Signal ${e.ref}` : undefined}>
        <Icon size={11} aria-hidden />
        {e.label}
      </span>
    </li>
  );
}

const Card = memo(function Card({
  i,
  onSignal,
  onEvent,
  hasSignal,
}: {
  i: IntelInsight;
  onSignal: (id: string) => void;
  onEvent: (id: string) => void;
  hasSignal: (id: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const m = SEVERITY_META[i.severity];
  const Icon = m.icon;
  const { head, rest, cut } = splitObserved(i.observed);
  const more = rest.length > 0 || i.why.length > 0;
  const detailsId = `eqp-ins-d-${i.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <article className={`eqp-ins ${m.tone}`} data-insight={i.id} aria-label={`${m.label}: ${i.title}`}>
      <header className="eqp-ins-h">
        <span className={`status ${m.tone} eqp-sev`}>
          <Icon size={13} strokeWidth={2.2} aria-hidden />
          {m.label}
        </span>
        <h4>{i.title}</h4>
        <span className="eqp-basis" title={`${i.basisLabel} — ${BASIS[i.basis]} ${CERTAINTY[i.certainty]}`}>
          {i.basisLabel}
        </span>
      </header>
      <p className="obs">{head}</p>
      {more && (
        // In the document but hidden until "Details" (aria-controls always points at it).
        <div className="eqp-ins-d" id={detailsId} hidden={!open}>
          {rest && <p className="obs">{cut ? i.observed : rest}</p>}
          {i.why && <p className="why">{i.why}</p>}
        </div>
      )}
      {i.evidence.length > 0 && (
        <ul className="eqp-chips" aria-label="Evidence">
          {i.evidence.map((e, n) => (
            <Evidence key={`${e.kind}:${e.ref ?? e.label}:${n}`} e={e} onSignal={onSignal} onEvent={onEvent} hasSignal={hasSignal} />
          ))}
        </ul>
      )}
      {i.next && (
        <p className="next">
          <ArrowRight size={13} aria-hidden />
          <span>
            <b>Next step</b> {i.next}
          </span>
        </p>
      )}
      {more && (
        <button type="button" className="eqp-ins-more" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'Details · why it matters'}
          <ChevronDown size={12} aria-hidden className="chev" />
        </button>
      )}
    </article>
  );
}, sameProps);

export function Insights({
  insights,
  onSignal,
  onEvent,
  hasSignal,
}: {
  insights: IntelInsight[];
  onSignal: (id: string) => void;
  onEvent: (id: string) => void;
  hasSignal: (id: string) => boolean;
}) {
  return (
    <div className="eqp-ins-list">
      {insights.map((i) => (
        <Card key={i.id} i={i} onSignal={onSignal} onEvent={onEvent} hasSignal={hasSignal} />
      ))}
    </div>
  );
}
