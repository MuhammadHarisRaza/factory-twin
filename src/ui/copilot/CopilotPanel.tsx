/**
 * Copilot conversation: question bubbles and answer blocks split into what the data shows
 * (Observed), what is inferred from it (Inferred, with a confidence), what is estimated (Estimate,
 * with its assumptions) and how it was computed (How) — plus the facts used, links to inspect them
 * and follow-up questions. One conversation store backs the Factory Copilot page, the Command Center
 * dock and the global drawer. Answers come from the rule-based copilot (src/intel/copilot.ts) —
 * no language model.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, ChevronRight, Crosshair, Eraser, MessageSquareText, SendHorizontal, X } from 'lucide-react';
import { useApp } from '../../app/store';
import { EVENT_QUESTIONS, QUESTION_GROUPS, type CopilotAnswer, type CopilotSection } from '../../intel/copilot';
import { eventById } from '../../sim/events';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDay } from '../../sim/time';
import { SeverityBadge } from '../kit/Status';
import { LinkButton } from './links';
import { SECTION_LABEL, groupSections, lineBlocks, type SectionKind } from './sections';
import { setCopilotContext, useCopilot, type CopilotTurn } from './store';
import './copilot.css';

export const COPILOT_LABEL = 'Rule-based on the current demo state — no language model';

type Variant = 'dock' | 'drawer' | 'page';

export function CopilotPanel({
  variant,
  onClose,
  onNavigate,
  autoFocus = false,
  suggestions = true,
}: {
  variant: Variant;
  /** Shows a close button (drawer). */
  onClose?: () => void;
  /** Called after a link took the user to another view. */
  onNavigate?: () => void;
  autoFocus?: boolean;
  /** Show suggested questions inside the panel (the page shows them beside it when there is room). */
  suggestions?: boolean;
}) {
  const turns = useCopilot((s) => s.turns);
  const ask = useCopilot((s) => s.ask);
  const clear = useCopilot((s) => s.clear);
  const focusTick = useCopilot((s) => s.focusTick);
  const [draft, setDraft] = useState('');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  const seenTick = useRef(focusTick);

  // Bring the newest question to the top of the log so its whole answer reads from the start.
  const lastId = turns.at(-1)?.id;
  useLayoutEffect(() => {
    const log = logRef.current;
    const last = lastRef.current;
    if (log && last) log.scrollTop = Math.max(0, last.offsetTop - 12);
  }, [lastId]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // Focus requests routed to an embedded panel (header Copilot button while it is on screen).
  useEffect(() => {
    if (variant === 'drawer' || focusTick === seenTick.current) return;
    seenTick.current = focusTick;
    inputRef.current?.focus({ preventScroll: true });
  }, [focusTick, variant]);

  const submit = (q: string) => {
    if (!q.trim()) return;
    ask(q);
    setDraft('');
    setSuggestOpen(false);
  };

  return (
    <section className={`cp cp-${variant}`} aria-label={`Copilot · ${COPILOT_LABEL}`}>
      <header className="cp-h">
        <MessageSquareText size={16} className="cp-h-icon" aria-hidden />
        <div className="cp-titles">
          <h2>{variant === 'page' ? 'Conversation' : 'Copilot'}</h2>
          <p>{COPILOT_LABEL}</p>
        </div>
        <div className="spacer" />
        {turns.length > 0 && (
          <button type="button" className="btn ghost sm" onClick={clear} title="Clear the conversation">
            <Eraser size={13} aria-hidden />
            Clear
          </button>
        )}
        {onClose && (
          <button type="button" className="btn ghost icon" onClick={onClose} title="Close (Esc)" aria-label="Close the copilot">
            <X size={16} />
          </button>
        )}
      </header>

      <div className="cp-log" ref={logRef} aria-live="polite">
        {turns.length === 0 ? (
          <Intro onAsk={submit} grouped={suggestions} variant={variant} />
        ) : (
          turns.map((t, i) => <Turn key={t.id} turn={t} onAsk={submit} onNavigate={onNavigate} variant={variant} ref={i === turns.length - 1 ? lastRef : undefined} />)
        )}
      </div>

      <footer className="cp-f">
        <ContextBar onAsk={submit} />
        {suggestions && turns.length > 0 && (
          <>
            <button type="button" className="cp-sugg-toggle" aria-expanded={suggestOpen} onClick={() => setSuggestOpen(!suggestOpen)}>
              {suggestOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
              Suggested questions
            </button>
            {suggestOpen && (
              <div className="cp-sugg">
                <QuestionGroups onAsk={submit} />
              </div>
            )}
          </>
        )}
        <form
          className="cp-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
        >
          <input
            ref={inputRef}
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about output, OEE, losses, defects, trucks or an event id…"
            aria-label="Question for the copilot"
            autoComplete="off"
          />
          <button type="submit" className="btn primary" disabled={!draft.trim()} title="Ask (Enter)">
            <SendHorizontal size={14} aria-hidden />
            Ask
          </button>
        </form>
      </footer>
    </section>
  );
}

/** The event the conversation is about, with its questions; questions typed now are asked in this context. */
function ContextBar({ onAsk }: { onAsk: (q: string) => void }) {
  const id = useApp((s) => s.copilotEventId);
  const ev = useSimValue((s) => {
    const e = id ? eventById(s, id) : undefined;
    return e ? { id: e.id, title: e.title, severity: e.severity, active: e.end == null } : null;
  }, [id]);
  if (!ev) return null;
  return (
    <div className="cp-ctx" role="group" aria-label={`Event context ${ev.id}`}>
      <div className="cp-ctx-h">
        <Crosshair size={13} className="cp-ctx-icon" aria-hidden />
        <span className="cp-ctx-l">Asking about</span>
        <b className="num">{ev.id}</b>
        <span className="cp-ctx-t" title={ev.title}>
          {ev.title}
        </span>
        <SeverityBadge severity={ev.severity} />
        <button type="button" className="btn ghost sm icon" onClick={() => setCopilotContext(null)} title="Clear the event context — ask plant-wide" aria-label="Clear the event context">
          <X size={13} />
        </button>
      </div>
      <div className="cp-chips">
        {EVENT_QUESTIONS.map((q) => (
          <Chip key={q} onClick={() => onAsk(q)}>
            {q}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button type="button" className="cp-chip" onClick={onClick} title={title}>
      {children}
    </button>
  );
}

/** Suggested questions grouped by the use case they demonstrate. */
export function QuestionGroups({ onAsk, layout = 'list' }: { onAsk: (q: string) => void; layout?: 'list' | 'grid' }) {
  return (
    <div className={`cp-groups cp-groups-${layout}`}>
      {QUESTION_GROUPS.map((g) => (
        <div key={g.id} className="cp-group">
          <div className="cp-group-h">{g.label}</div>
          <div className="cp-chips cp-chips-list">
            {g.questions.map((q) => (
              <Chip key={q} onClick={() => onAsk(q)}>
                {q}
              </Chip>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Intro({ onAsk, grouped, variant }: { onAsk: (q: string) => void; grouped: boolean; variant: Variant }) {
  return (
    <div className="cp-intro">
      <p>
        Ask about the simulated plant — output against target, conveyor stops, downtime losses, OEE and theoretical capacity, the cost of losses, defects,
        truck turnaround, what to investigate first, or one event by its id. Each answer separates what the data shows from what is inferred and what is
        estimated, with the facts it used and links to inspect them.
      </p>
      {grouped ? (
        <>
          <div className="cp-intro-h">Suggested questions</div>
          <QuestionGroups onAsk={onAsk} layout={variant === 'page' ? 'grid' : 'list'} />
        </>
      ) : (
        <p className="cp-intro-hint">Pick a suggested question, investigate an active event, or type your own question below.</p>
      )}
    </div>
  );
}

function Turn({
  turn,
  onAsk,
  onNavigate,
  variant,
  ref,
}: {
  turn: CopilotTurn;
  onAsk: (q: string) => void;
  onNavigate?: () => void;
  variant: Variant;
  ref?: Ref<HTMLDivElement>;
}) {
  const a = turn.answer;
  // "about EV-…" only when the answer really is about the event (plant-wide questions stay plant-wide in a context).
  const about = a.intent.startsWith('event-') || (turn.contextEventId && a.eventId === turn.contextEventId) ? a.eventId : null;
  const current = useApp((s) => s.copilotEventId);
  // A plant-wide answer that points to one event offers to make it the context (unless it already is).
  const pointsTo = !a.intent.startsWith('event-') && a.eventId && a.eventId !== turn.contextEventId && a.eventId !== current ? a.eventId : null;
  return (
    <div className="cp-turn" ref={ref}>
      <div className="cp-q">{turn.question}</div>
      <div className="cp-a">
        <div className="cp-meta" title={`Computed from the demo state at ${formatDay(turn.minute)} ${formatClock(turn.minute)} plant time`}>
          Answer at {formatClock(turn.minute)} plant time
          {a.periodLabel && a.periodLabel !== '—' && <> · {a.periodLabel}</>}
          {about && <span className="tag cp-about">about {about}</span>}
        </div>
        {a.sections?.length ? <Sections sections={a.sections} /> : <Paragraphs lines={a.text} />}
        {a.facts.length > 0 && <Facts facts={a.facts} open={variant === 'page'} />}
        {(a.links.length > 0 || pointsTo) && (
          <div className="cp-links">
            {a.links.map((l, i) => (
              <LinkButton key={`${l.kind}:${l.id}:${i}`} link={l} onFollow={onNavigate} />
            ))}
            {pointsTo && (
              <button type="button" className="btn sm" onClick={() => setCopilotContext(pointsTo)} title={`Ask the next questions about ${pointsTo}`}>
                <Crosshair size={12} aria-hidden />
                Investigate {pointsTo}
              </button>
            )}
          </div>
        )}
        {a.followUps.length > 0 && (
          <div className="cp-follow">
            <span className="cp-follow-h">Follow-up</span>
            {a.followUps.map((q) => (
              <Chip key={q} onClick={() => onAsk(q)}>
                {q}
              </Chip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Sections({ sections }: { sections: CopilotSection[] }) {
  return (
    <div className="cp-secs">
      {groupSections(sections).map((g, i) => (
        <div key={`${g.kind}:${i}`} className={`cp-sec cp-sec-${g.kind}`}>
          <div className="cp-sec-h" title={SECTION_LABEL[g.kind].hint}>
            {SECTION_LABEL[g.kind].label}
            {SECTION_LABEL[g.kind].note && <small>{SECTION_LABEL[g.kind].note}</small>}
          </div>
          <div className="cp-sec-b">
            <Lines lines={g.lines} kind={g.kind} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Lines of one section; consecutive "1. …" lines become an ordered list, confidences become tags. */
function Lines({ lines, kind }: { lines: string[]; kind: SectionKind }) {
  return (
    <>
      {lineBlocks(lines, kind).map((b, i) =>
        b.kind === 'ol' ? (
          <ol key={i}>
            {b.items.map((x, j) => (
              <li key={j}>{x}</li>
            ))}
          </ol>
        ) : b.confidence ? (
          <p key={i}>
            <span
              className={`cp-conf cp-conf-${b.confidence.toLowerCase()}`}
              title={b.confidence === 'Confirmed' ? 'Directly observed or a scenario input' : 'Inferred from correlated evidence — a hypothesis to check'}
            >
              {b.confidence}
            </span>
            {b.text}
          </p>
        ) : (
          <p key={i} className={b.assumptions ? 'cp-assume' : undefined}>
            {b.text}
          </p>
        ),
      )}
    </>
  );
}

/** Plain paragraphs (answers without sections). */
function Paragraphs({ lines }: { lines: string[] }) {
  return (
    <div className="cp-text">
      <Lines lines={lines} kind="observed" />
    </div>
  );
}

/** Label → value rows; long values (sentences) drop below their label. */
function Facts({ facts, open }: { facts: CopilotAnswer['facts']; open: boolean }) {
  return (
    <details className="cp-facts" open={open}>
      <summary>Facts used ({facts.length})</summary>
      <dl>
        {facts.map((f, i) => (
          <div key={`${f.label}:${i}`} className={`cp-fact ${f.value.length > 28 ? 'long' : ''}`}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

