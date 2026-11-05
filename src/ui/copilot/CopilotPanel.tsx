/**
 * Copilot conversation: question bubbles and answers split into labelled sections — Confirmed facts,
 * Simulated events, Inferred explanation, Unverified hypotheses, Cannot be established, Estimate,
 * Recommended actions, How it was computed — plus the figures used, links into the seven workspaces
 * and follow-up questions. Above the question field, chips show the context the next question is
 * asked in (period, incident, equipment, stage). One conversation store backs the Copilot workspace
 * and the global drawer. Answers are the AI agent's replies (a language model, src/ui/copilot/agent.ts),
 * labelled as such; the rule-based analysis of the simulated plant (src/intel/copilot.ts) is not shown —
 * it is sent to the agent as the figures to answer from. Without an agent the turn says so.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eraser,
  Factory,
  LoaderCircle,
  Locate,
  MessageSquareText,
  SendHorizontal,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { WorkspaceId } from '../../app/store';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import { EVENT_QUESTIONS, INCIDENT_QUESTION, QUESTION_GROUPS } from '../../intel/copilot';
import { formatClock, formatDay } from '../../sim/time';
import { SeverityBadge } from '../kit/Status';
import { SOURCE_LABEL, useCopilot, useCopilotContext, type AgentTurn, type CopilotTurn } from './store';
import './copilot.css';

export const COPILOT_LABEL = 'AI agent (language model) — not configured on this server, so questions cannot be answered';
export const COPILOT_AGENT_LABEL = 'AI agent (language model) given the simulated plant figures — it can be wrong';

/** The header line: what answers the questions here. */
export function useCopilotLabel() {
  return useCopilot((s) => (s.agentConfigured === false ? COPILOT_LABEL : COPILOT_AGENT_LABEL));
}

type Variant = 'drawer' | 'page';


export function CopilotPanel({
  variant,
  onClose,
  autoFocus = false,
  suggestions = true,
}: {
  variant: Variant;
  /** Shows a close button (drawer). */
  onClose?: () => void;
  /** Called after a link took the user to another view. */
  onNavigate?: () => void;
  autoFocus?: boolean;
  /** Show suggested questions inside the panel (the page shows them beside it). */
  suggestions?: boolean;
}) {
  const turns = useCopilot((s) => s.turns);
  const ask = useCopilot((s) => s.ask);
  const clear = useCopilot((s) => s.clear);
  const focusTick = useCopilot((s) => s.focusTick);
  const ctx = useCopilotContext();
  const label = useCopilotLabel();
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
    <section className={`cp cp-${variant}`} aria-label={`Copilot · ${label}`}>
      <header className="cp-h">
        <MessageSquareText size={16} className="cp-h-icon" aria-hidden />
        <div className="cp-titles">
          <h2>{variant === 'page' ? 'Conversation' : 'Copilot'}</h2>
          <p>{label}</p>
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
          <Intro onAsk={submit} grouped={suggestions} workspace={ctx.workspace} />
        ) : (
          turns.map((t, i) => <Turn key={t.id} turn={t} ref={i === turns.length - 1 ? lastRef : undefined} />)
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
                <QuestionGroups onAsk={submit} workspace={ctx.workspace} />
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
            placeholder="Ask about output, the constraint, OEE losses, defects, vehicles or an incident…"
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

/** The context the next question is asked in, as removable chips; with an incident, its questions. */
export function ContextBar({ onAsk }: { onAsk: (q: string) => void }) {
  const ctx = useCopilotContext();
  const dismiss = useCopilot((s) => s.dismiss);
  return (
    <div className="cp-ctx" role="group" aria-label="Context of the next question">
      <div className="cp-ctx-chips">
        <span className="cp-cchip" title={ctx.periodFromHeader ? 'Plant-wide figures use the reporting period selected in the header — the same as the KPI cards' : 'Plant-wide figures use the current shift, as on the Overview'}>
          <CalendarClock size={12} aria-hidden />
          <span className="cp-cchip-k">{ctx.periodFromHeader ? 'Period' : 'Current shift'}</span>
          <span className="num">{ctx.periodLabel}</span>
        </span>
        {ctx.event && (
          <span className="cp-cchip on" title={`${ctx.event.id} · ${ctx.event.title} — ${SOURCE_LABEL[ctx.event.source]}. Questions about “this incident” are answered from its record.`}>
            <Crosshair size={12} aria-hidden />
            <span className="cp-cchip-k">Incident</span>
            <b className="num">{ctx.event.id}</b>
            <span className="cp-cchip-t">{ctx.event.title}</span>
            <SeverityBadge severity={ctx.event.severity} />
            <button type="button" className="cp-cchip-x" onClick={() => dismiss('event')} aria-label={`Remove the incident context ${ctx.event.id}`} title="Ask plant-wide instead">
              <X size={12} />
            </button>
          </span>
        )}
        {ctx.equipmentId && (
          <span className="cp-cchip" title={`${ctx.equipmentId} is selected in the Factory Twin — “this machine” refers to it`}>
            <Locate size={12} aria-hidden />
            <span className="cp-cchip-k">Equipment</span>
            <b className="num">{ctx.equipmentId}</b>
            <button type="button" className="cp-cchip-x" onClick={() => dismiss('equipment')} aria-label={`Remove the equipment context ${ctx.equipmentId}`} title="Remove">
              <X size={12} />
            </button>
          </span>
        )}
        {ctx.stageId && (
          <span className="cp-cchip" title={`${MONITORED_STAGE_BY_ID[ctx.stageId].name} is open in Production — “this stage” refers to it`}>
            <Factory size={12} aria-hidden />
            <span className="cp-cchip-k">Stage</span>
            <b>{MONITORED_STAGE_BY_ID[ctx.stageId].name}</b>
            <button type="button" className="cp-cchip-x" onClick={() => dismiss('stage')} aria-label={`Remove the stage context ${MONITORED_STAGE_BY_ID[ctx.stageId].name}`} title="Remove">
              <X size={12} />
            </button>
          </span>
        )}
      </div>
      {ctx.event && (
        <div className="cp-chips" aria-label={`Questions about ${ctx.event.id}`}>
          {EVENT_QUESTIONS.map((q) => (
            <Chip key={q} onClick={() => onAsk(q)}>
              {q}
            </Chip>
          ))}
        </div>
      )}
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

/**
 * The suggested questions, grouped by workspace (the current workspace's group first). The incident
 * question is asked about the incident in context; without one the copilot says it cannot tell which
 * and lists the open issues to choose from.
 */
export function QuestionGroups({ onAsk, layout = 'list', workspace }: { onAsk: (q: string) => void; layout?: 'list' | 'grid'; workspace?: WorkspaceId }) {
  const ctx = useCopilotContext();
  const groups = workspace ? [...QUESTION_GROUPS].sort((a, b) => Number(b.workspaces.includes(workspace)) - Number(a.workspaces.includes(workspace))) : QUESTION_GROUPS;
  return (
    <div className={`cp-groups cp-groups-${layout}`}>
      {groups.map((g) => (
        <div key={g.id} className="cp-group">
          <div className="cp-group-h">{g.label}</div>
          <div className="cp-chips cp-chips-list">
            {g.questions.map((q) =>
              q === INCIDENT_QUESTION ? (
                <Chip
                  key={q}
                  onClick={() => onAsk(q)}
                  title={ctx.event ? `Asked about ${ctx.event.id} (${ctx.event.title})` : 'No incident is selected — the answer lists the open issues to choose from'}
                >
                  {q}
                  {ctx.event ? <span className="cp-chip-ctx num"> · {ctx.event.id}</span> : <span className="cp-chip-ctx"> · choose an incident</span>}
                </Chip>
              ) : (
                <Chip key={q} onClick={() => onAsk(q)}>
                  {q}
                </Chip>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Intro({ onAsk, grouped, workspace }: { onAsk: (q: string) => void; grouped: boolean; workspace: WorkspaceId }) {
  return (
    <div className="cp-intro">
      <p>
        Ask about the simulated plant: why output is below target, which stage constrains it, the OEE losses, rising defects, delayed vehicles, an incident, or
        what to investigate first. An AI agent answers from the simulated plant figures sent with each question — it can be wrong, so check the figures in the
        workspaces.
      </p>
      {grouped ? (
        <>
          <div className="cp-intro-h">Suggested questions</div>
          <QuestionGroups onAsk={onAsk} workspace={workspace} />
        </>
      ) : (
        <p className="cp-intro-hint">Pick a suggested question or an incident to investigate, or type your own question below.</p>
      )}
    </div>
  );
}

function Turn({ turn, ref }: { turn: CopilotTurn; ref?: Ref<HTMLDivElement> }) {
  const a = turn.answer;
  // "about EV-…" only when the question really is about the event (plant-wide questions stay plant-wide in a context).
  const about = a.intent.startsWith('event-') && a.intent !== 'event-missing' ? a.eventId : null;
  const scope = [a.periodLabel && a.periodLabel !== '—' ? a.periodLabel : null, turn.context?.equipmentId, turn.context?.stageId ? MONITORED_STAGE_BY_ID[turn.context.stageId]?.name : null].filter(Boolean);
  return (
    <div className="cp-turn" ref={ref}>
      <div className="cp-q">{turn.question}</div>
      <div className="cp-a">
        <div className="cp-meta" title={`Asked with the simulated plant state at ${formatDay(turn.minute)} ${formatClock(turn.minute)} plant time`}>
          <span>Asked at {formatClock(turn.minute)} plant time</span>
          {scope.map((x) => (
            <span key={x as string}>· {x}</span>
          ))}
          {about && <span className="tag cp-about">about {about}</span>}
        </div>
        <AgentAnswer agent={turn.agent ?? { status: 'error', error: 'No AI agent is configured on this server.' }} />
      </div>
    </div>
  );
}

/** The agent's reply, plain text: paragraphs, "- " / "1. " lists and **bold** markers rendered as text. */
function agentBlocks(text: string): ({ kind: 'p'; text: string } | { kind: 'ul' | 'ol'; items: string[] })[] {
  const out: ({ kind: 'p'; text: string } | { kind: 'ul' | 'ol'; items: string[] })[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/, '').trim();
    if (!line) continue;
    const ul = line.match(/^[-*•]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    const kind = ul ? 'ul' : ol ? 'ol' : null;
    const last = out.at(-1);
    if (kind) {
      if (last && last.kind === kind) last.items.push((ul ?? ol)![1]);
      else out.push({ kind, items: [(ul ?? ol)![1]] });
    } else out.push({ kind: 'p', text: line });
  }
  return out;
}

function AgentAnswer({ agent }: { agent: AgentTurn }) {
  return (
    <div className={`cp-agent ${agent.status}`}>
      <div className="cp-agent-h" title="Answered by an AI agent (a language model) through the configured endpoint. It is given the simulated plant figures with each question; it can be wrong.">
        <Sparkles size={12} aria-hidden />
        AI agent
        <small>· language model · simulated plant data · can be wrong</small>
      </div>
      {agent.status === 'loading' ? (
        <p className="cp-agent-wait" role="status">
          <LoaderCircle size={13} className="spin" aria-hidden /> Asking the AI agent…
        </p>
      ) : agent.status === 'error' ? (
        <p className="cp-agent-err" role="status">
          <TriangleAlert size={13} aria-hidden /> AI agent unavailable — {agent.error} No answer could be given; try again in a moment.
        </p>
      ) : (
        <div className="cp-agent-b">
          {agentBlocks(agent.text).map((b, i) =>
            b.kind === 'p' ? (
              <p key={i}>{b.text}</p>
            ) : b.kind === 'ul' ? (
              <ul key={i}>
                {b.items.map((x, j) => (
                  <li key={j}>{x}</li>
                ))}
              </ul>
            ) : (
              <ol key={i}>
                {b.items.map((x, j) => (
                  <li key={j}>{x}</li>
                ))}
              </ol>
            ),
          )}
        </div>
      )}
    </div>
  );
}

