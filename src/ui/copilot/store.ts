/**
 * Copilot conversation, shared by every place the copilot appears — the Copilot workspace and the
 * global drawer — so both show the same exchange. Each answer is computed once, from the simulation
 * state at the moment of asking, with the financial assumptions then in force, and kept with that
 * plant time and the context it was asked in.
 *
 * Context (shown as chips above the question field, each removable):
 *   - period: the reporting period of the workspace the question is asked from (the header period
 *     on Production, Quality and Fleet; the current shift elsewhere, as the Overview) — so plant-wide
 *     figures equal the KPI cards on screen;
 *   - event: `useApp.copilotEventId` (set by openCopilot(prompt, {eventId}) or the incident picker),
 *     else the event open in Events & Reports or Quality & Defects;
 *   - equipment: the item selected in the Factory Twin; vehicle: the vehicle selected there; stage: the
 *     stage open in Production.
 * A context the user removed stays removed for that record (until another record is selected).
 *
 * Answers: the question goes to the AI agent (/api/copilot, src/ui/copilot/agent.ts) with the
 * rule-based analysis of the simulated plant (src/intel/copilot.ts) as the figures to answer from; only
 * the agent's reply is shown. Without an agent, or when it fails, the turn says why.
 */
import { create } from 'zustand';
import { PERIOD_WORKSPACES, useApp, type WorkspaceId } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity, MonitoredStageId } from '../../model/types';
import { ask as askCopilot, SUGGESTED_QUESTIONS, type CopilotAnswer } from '../../intel/copilot';
import type { SimState } from '../../sim/engine';
import { eventById } from '../../sim/events';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSim, useSimValue } from '../../sim/store';
import { useTwin } from '../../store';
import { agentAvailable, agentContext, askAgent, newSessionId } from './agent';

// ── Context ───────────────────────────────────────────────────────────────────

export type ContextSource = 'copilot' | 'events' | 'quality';

export type CopilotContextView = {
  workspace: WorkspaceId;
  period: PeriodKey;
  periodLabel: string;
  /** The period comes from the header selector (else it is the current shift). */
  periodFromHeader: boolean;
  event: { id: string; title: string; severity: AlertSeverity; active: boolean; source: ContextSource } | null;
  equipmentId: string | null;
  stageId: MonitoredStageId | null;
  /** The vehicle selected in the Factory Twin ("this vehicle / truck"). */
  vehicleId?: string | null;
};

export type ContextInputs = {
  workspace: WorkspaceId;
  period: PeriodKey;
  copilotEventId: string | null;
  selectedEventId: string | null;
  qualityEventId: string | null;
  productionStage: MonitoredStageId | null;
  twinSelected: string | null;
  /** The vehicle selected in the Factory Twin. */
  twinVehicle?: string | null;
  /** Context keys the user removed ("event:EV-00012", "equipment:H-KILN", "stage:GLAZE"). */
  dismissed: string[];
};

export const SOURCE_LABEL: Record<ContextSource, string> = {
  copilot: 'chosen for the copilot',
  events: 'open in Events & Reports',
  quality: 'open in Quality & Defects',
};

/** The context a question is asked in, from the app state (pure — unit-tested). */
export function deriveContext(sim: SimState, i: ContextInputs): CopilotContextView {
  const fromHeader = PERIOD_WORKSPACES.includes(i.workspace);
  const period: PeriodKey = fromHeader ? i.period : 'shift';
  const off = (k: string) => i.dismissed.includes(k);
  const candidates: [string | null, ContextSource][] = [
    [i.copilotEventId, 'copilot'],
    [i.workspace === 'events' ? i.selectedEventId : null, 'events'],
    [i.workspace === 'quality' ? i.qualityEventId : null, 'quality'],
  ];
  let event: CopilotContextView['event'] = null;
  for (const [id, source] of candidates) {
    if (!id || (source !== 'copilot' && off(`event:${id}`))) continue;
    const e = eventById(sim, id);
    if (!e) continue;
    event = { id: e.id, title: e.title, severity: e.severity, active: e.end == null, source };
    break;
  }
  const eq = i.workspace === 'twin' && i.twinSelected && EQUIPMENT_BY_ID[i.twinSelected] && !off(`equipment:${i.twinSelected}`) ? i.twinSelected : null;
  const vehicleId = i.workspace === 'twin' && i.twinVehicle && sim.logistics.vehicles[i.twinVehicle] ? i.twinVehicle : null;
  const st = i.workspace === 'production' && i.productionStage && MONITORED_STAGE_BY_ID[i.productionStage] && !off(`stage:${i.productionStage}`) ? i.productionStage : null;
  return {
    workspace: i.workspace,
    period,
    periodLabel: resolvePeriod(period, sim.minute).label,
    periodFromHeader: fromHeader,
    event,
    equipmentId: eq,
    stageId: st,
    vehicleId,
  };
}

function inputsNow(): ContextInputs {
  const a = useApp.getState();
  return {
    workspace: a.workspace,
    period: a.period,
    copilotEventId: a.copilotEventId,
    selectedEventId: a.selectedEventId,
    qualityEventId: a.qualityEventId,
    productionStage: a.productionStage,
    twinSelected: useTwin.getState().selected,
    twinVehicle: useTwin.getState().vehicle,
    dismissed: useCopilot.getState().dismissed,
  };
}

/** The context right now (outside React). */
export const currentContext = (): CopilotContextView => deriveContext(useSim.getState().sim, inputsNow());

/** The context, live (chips, page panels). */
export function useCopilotContext(): CopilotContextView {
  const workspace = useApp((s) => s.workspace);
  const period = useApp((s) => s.period);
  const copilotEventId = useApp((s) => s.copilotEventId);
  const selectedEventId = useApp((s) => s.selectedEventId);
  const qualityEventId = useApp((s) => s.qualityEventId);
  const productionStage = useApp((s) => s.productionStage);
  const twinSelected = useTwin((s) => s.selected);
  const twinVehicle = useTwin((s) => s.vehicle);
  const dismissed = useCopilot((s) => s.dismissed);
  return useSimValue(
    (sim) => deriveContext(sim, { workspace, period, copilotEventId, selectedEventId, qualityEventId, productionStage, twinSelected, twinVehicle, dismissed }),
    [workspace, period, copilotEventId, selectedEventId, qualityEventId, productionStage, twinSelected, twinVehicle, dismissed],
  );
}

// ── Conversation ──────────────────────────────────────────────────────────────

export type CopilotTurn = {
  id: number;
  question: string;
  answer: CopilotAnswer;
  /** Plant minute the answer was computed at. */
  minute: number;
  /** Event context the question was asked in (null = plant-wide). */
  contextEventId: string | null;
  /** The rest of the context it was asked in. */
  context: { periodLabel: string; equipmentId: string | null; stageId: MonitoredStageId | null };
  /** The AI agent's reply (null when no agent is configured). */
  agent?: AgentTurn | null;
};

export type AgentTurn = { status: 'loading' } | { status: 'ok'; text: string } | { status: 'error'; error: string };

type CopilotState = {
  turns: CopilotTurn[];
  /** Copilot panels embedded in the current page — the Copilot workspace (the drawer routes to it when present). */
  docks: number;
  /** Incremented to ask an embedded panel to focus its question field. */
  focusTick: number;
  /** Context keys the user removed. */
  dismissed: string[];
  /** Whether the server has an AI agent configured (null = not known yet / not reachable). */
  agentConfigured: boolean | null;
  /** The agent's session for this conversation (renewed by Clear and Reset Demo). */
  sessionId: string;
  conversationId: string | null;
  /** Asks a question in the current context; `eventId` overrides the event context for this one question. */
  ask: (question: string, opts?: { eventId?: string | null }) => void;
  clear: () => void;
  /** Removes one context chip (the event, equipment or stage). */
  dismiss: (key: 'event' | 'equipment' | 'stage') => void;
  /** Registers an embedded panel; returns the unregister function. */
  registerDock: () => () => void;
  focusDock: () => void;
};

const MAX_TURNS = 40;
let seq = 0;

/** Event context for a question: the explicit one, else the current context — only if that event exists. */
export function contextFor(explicit: string | null | undefined): string | null {
  const id = explicit !== undefined ? explicit : (currentContext().event?.id ?? null);
  return id && eventById(useSim.getState().sim, id) ? id : null;
}

/** Answer for a question against the current state; never throws (the demo must not break mid-meeting). */
function answer(question: string, ctx: { eventId: string | null; period: PeriodKey; equipmentId: string | null; stageId: MonitoredStageId | null; vehicleId?: string | null }): { answer: CopilotAnswer; minute: number } {
  const sim = useSim.getState().sim;
  const { tariffs, finance } = useApp.getState();
  try {
    return { answer: askCopilot(sim, question, tariffs, { ...ctx, finance }), minute: sim.minute };
  } catch {
    const text = 'The copilot could not assemble an answer from the current demo state, so nothing can be established for this question. Try one of the suggested questions.';
    return {
      minute: sim.minute,
      answer: {
        intent: 'help',
        text: [text],
        sections: [{ kind: 'unknown', text }],
        facts: [],
        links: [],
        periodLabel: '—',
        followUps: SUGGESTED_QUESTIONS.slice(0, 3),
      },
    };
  }
}

export const useCopilot = create<CopilotState>((set, get) => ({
  turns: [],
  docks: 0,
  focusTick: 0,
  dismissed: [],
  agentConfigured: null,
  sessionId: newSessionId(),
  conversationId: null,
  ask: (question, opts) => {
    const q = question.trim();
    if (!q) return;
    const ctx = currentContext();
    const contextEventId = contextFor(opts?.eventId !== undefined ? opts.eventId : (ctx.event?.id ?? null));
    const a = answer(q, { eventId: contextEventId, period: ctx.period, equipmentId: ctx.equipmentId, stageId: ctx.stageId, vehicleId: ctx.vehicleId ?? null });
    const configured = get().agentConfigured;
    const inBrowser = typeof window !== 'undefined' && typeof location !== 'undefined' && location.protocol.startsWith('http');
    const useAgent = inBrowser && configured !== false;
    const id = ++seq;
    set({
      turns: [
        ...get().turns,
        { id, question: q, contextEventId, context: { periodLabel: ctx.periodLabel, equipmentId: ctx.equipmentId, stageId: ctx.stageId }, ...a, agent: useAgent ? ({ status: 'loading' } as AgentTurn) : null },
      ].slice(-MAX_TURNS),
    });
    if (!useAgent) return;
    const { sessionId, conversationId } = get();
    const context = agentContext(useSim.getState().sim, a.answer, { ...ctx, eventId: contextEventId });
    void askAgent({ question: q, context, sessionId, conversationId }).then((r) => {
      // A Clear or Reset Demo meanwhile started a new session: this reply belongs to the old one.
      if (get().sessionId !== sessionId) return;
      const agent: AgentTurn = r.ok ? { status: 'ok', text: r.text } : { status: 'error', error: r.error };
      set((st) => ({ turns: st.turns.map((t) => (t.id === id ? { ...t, agent } : t)), conversationId: r.ok ? (r.conversationId ?? st.conversationId) : st.conversationId }));
    });
  },
  clear: () => set({ turns: [], sessionId: newSessionId(), conversationId: null }),
  dismiss: (key) => {
    const ctx = currentContext();
    const add: string[] = [];
    if (key === 'event') {
      const a = useApp.getState();
      if (a.copilotEventId) useApp.setState({ copilotEventId: null });
      // The event open in the workspace would take over: it is removed too.
      for (const id of [a.selectedEventId, a.qualityEventId]) if (id) add.push(`event:${id}`);
    } else if (key === 'equipment' && ctx.equipmentId) add.push(`equipment:${ctx.equipmentId}`);
    else if (key === 'stage' && ctx.stageId) add.push(`stage:${ctx.stageId}`);
    if (add.length) set((s) => ({ dismissed: [...new Set([...s.dismissed, ...add])] }));
  },
  registerDock: () => {
    set((s) => ({ docks: s.docks + 1 }));
    return () => set((s) => ({ docks: Math.max(0, s.docks - 1) }));
  },
  focusDock: () => set((s) => ({ focusTick: s.focusTick + 1 })),
}));

/** Sets (or clears) the event the conversation is about. */
export const setCopilotContext = (eventId: string | null) => {
  useApp.setState({ copilotEventId: eventId });
  if (eventId) useCopilot.setState((s) => ({ dismissed: s.dismissed.filter((k) => k !== `event:${eventId}`) }));
};

// Reset Demo replays the plant from the start: earlier answers and the event context no longer describe it.
useSim.subscribe((s, prev) => {
  if (s.resets !== prev.resets) {
    useCopilot.setState({ turns: [], dismissed: [], sessionId: newSessionId(), conversationId: null });
    setCopilotContext(null);
  }
});

// Ask the server once whether an AI agent is configured (browser only; tests and server rendering skip it).
if (typeof window !== 'undefined' && typeof fetch === 'function' && typeof location !== 'undefined' && location.protocol.startsWith('http'))
  void agentAvailable().then((configured) => useCopilot.setState({ agentConfigured: configured }));
