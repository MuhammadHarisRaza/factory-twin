/**
 * Operations copilot conversation: question bubbles, answer blocks (paragraphs, the facts
 * used, links to inspect them, follow-up questions), suggested questions and the input.
 * Answers come from the rule-based copilot (src/intel/copilot.ts) — no language model.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, ChevronRight, Eraser, MessageSquareText, SendHorizontal, X } from 'lucide-react';
import { SUGGESTED_QUESTIONS, type CopilotAnswer } from '../../intel/copilot';
import { formatClock, formatDay } from '../../sim/time';
import { LinkButton } from './links';
import { useCopilot, type CopilotTurn } from './store';
import './copilot.css';

export const COPILOT_LABEL = 'Rule-based on the current demo state — no language model connected';

export function CopilotPanel({
  variant,
  onClose,
  onNavigate,
  autoFocus = false,
}: {
  variant: 'dock' | 'drawer';
  /** Shows a close button (drawer). */
  onClose?: () => void;
  /** Called after a link took the user to another view. */
  onNavigate?: () => void;
  autoFocus?: boolean;
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

  // Focus requests routed to the docked panel (header Copilot button on this page).
  useEffect(() => {
    if (variant !== 'dock' || focusTick === seenTick.current) return;
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
          <h2>Copilot</h2>
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
          <button type="button" className="btn ghost icon" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        )}
      </header>

      <div className="cp-log" ref={logRef} aria-live="polite">
        {turns.length === 0 ? (
          <Intro onAsk={submit} />
        ) : (
          turns.map((t, i) => <Turn key={t.id} turn={t} onAsk={submit} onNavigate={onNavigate} ref={i === turns.length - 1 ? lastRef : undefined} />)
        )}
      </div>

      <footer className="cp-f">
        {turns.length > 0 && (
          <>
            <button type="button" className="cp-sugg-toggle" aria-expanded={suggestOpen} onClick={() => setSuggestOpen(!suggestOpen)}>
              {suggestOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
              Suggested questions
            </button>
            {suggestOpen && (
              <div className="cp-chips">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <Chip key={q} onClick={() => submit(q)}>
                    {q}
                  </Chip>
                ))}
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
            placeholder="Ask about output, downtime, quality, energy…"
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

function Chip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="cp-chip" onClick={onClick}>
      {children}
    </button>
  );
}

function Intro({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div className="cp-intro">
      <p>
        Ask about the simulated plant — output against target, the bottleneck, downtime, the kiln, defects, machine health, energy, logistics or a specific
        machine. Each answer is assembled from the same figures as the dashboards, with the facts it used and links to inspect them.
      </p>
      <div className="cp-intro-h">Suggested questions</div>
      <div className="cp-chips cp-chips-list">
        {SUGGESTED_QUESTIONS.map((q) => (
          <Chip key={q} onClick={() => onAsk(q)}>
            {q}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Turn({ turn, onAsk, onNavigate, ref }: { turn: CopilotTurn; onAsk: (q: string) => void; onNavigate?: () => void; ref?: Ref<HTMLDivElement> }) {
  const a = turn.answer;
  return (
    <div className="cp-turn" ref={ref}>
      <div className="cp-q">{turn.question}</div>
      <div className="cp-a">
        <div className="cp-meta" title={`Computed from the demo state at ${formatDay(turn.minute)} ${formatClock(turn.minute)} plant time`}>
          Answer at {formatClock(turn.minute)} plant time
          {a.periodLabel && a.periodLabel !== '—' && <> · {a.periodLabel}</>}
        </div>
        <AnswerText lines={a.text} />
        {a.facts.length > 0 && <Facts facts={a.facts} />}
        {a.links.length > 0 && (
          <div className="cp-links">
            {a.links.map((l, i) => (
              <LinkButton key={`${l.kind}:${l.id}:${i}`} link={l} onFollow={onNavigate} />
            ))}
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

/** Paragraphs; consecutive "1. …" lines become an ordered list. */
function AnswerText({ lines }: { lines: CopilotAnswer['text'] }) {
  const blocks: ({ kind: 'p'; text: string } | { kind: 'ol'; items: string[] })[] = [];
  for (const line of lines) {
    const m = /^\d+\.\s+(.*)$/.exec(line);
    const prev = blocks.at(-1);
    if (m) {
      if (prev?.kind === 'ol') prev.items.push(m[1]);
      else blocks.push({ kind: 'ol', items: [m[1]] });
    } else blocks.push({ kind: 'p', text: line });
  }
  return (
    <div className="cp-text">
      {blocks.map((b, i) =>
        b.kind === 'p' ? (
          <p key={i}>{b.text}</p>
        ) : (
          <ol key={i}>
            {b.items.map((x, j) => (
              <li key={j}>{x}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}

/** Label → value rows; long values (sentences) drop below their label. */
function Facts({ facts }: { facts: CopilotAnswer['facts'] }) {
  return (
    <div className="cp-facts">
      <div className="cp-facts-h">Facts used</div>
      <dl>
        {facts.map((f, i) => (
          <div key={`${f.label}:${i}`} className={`cp-fact ${f.value.length > 28 ? 'long' : ''}`}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
