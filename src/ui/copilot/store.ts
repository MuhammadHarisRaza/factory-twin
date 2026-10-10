/**
 * Copilot conversation, shared by every place the copilot appears — the Factory Copilot page,
 * the panel docked in the Command Center and the global drawer — so all show the same exchange.
 * Each answer is computed once, from the simulation state at the moment of asking, with the
 * financial assumptions and tariffs then in force, and kept with that plant time.
 *
 * Event context: `useApp.copilotEventId` is the event the conversation is about (set by
 * openCopilot(prompt, {eventId}) or the page's event picker). A question is asked in that
 * context unless the caller passes another one.
 */
import { create } from 'zustand';
import { useApp } from '../../app/store';
import { ask as askCopilot, SUGGESTED_QUESTIONS, type CopilotAnswer } from '../../intel/copilot';
import { eventById } from '../../sim/events';
import { useSim } from '../../sim/store';

export type CopilotTurn = {
  id: number;
  question: string;
  answer: CopilotAnswer;
  /** Plant minute the answer was computed at. */
  minute: number;
  /** Event context the question was asked in (null = plant-wide). */
  contextEventId: string | null;
};

type CopilotState = {
  turns: CopilotTurn[];
  /** Copilot panels embedded in the current page (the drawer routes to one when present). */
  docks: number;
  /** Incremented to ask an embedded panel to focus its question field. */
  focusTick: number;
  /** Asks a question; `eventId` overrides the shared event context for this one question. */
  ask: (question: string, opts?: { eventId?: string | null }) => void;
  clear: () => void;
  /** Registers an embedded panel; returns the unregister function. */
  registerDock: () => () => void;
  focusDock: () => void;
};

const MAX_TURNS = 40;
let seq = 0;

/** Event context for a question: the explicit one, else the shared context — only if that event exists. */
export function contextFor(explicit: string | null | undefined): string | null {
  const id = explicit !== undefined ? explicit : useApp.getState().copilotEventId;
  return id && eventById(useSim.getState().sim, id) ? id : null;
}

/** Answer for a question against the current state; never throws (the demo must not break mid-meeting). */
function answer(question: string, eventId: string | null): { answer: CopilotAnswer; minute: number } {
  const sim = useSim.getState().sim;
  const { tariffs, finance } = useApp.getState();
  try {
    return { answer: askCopilot(sim, question, tariffs, { eventId, finance }), minute: sim.minute };
  } catch {
    return {
      minute: sim.minute,
      answer: {
        intent: 'help',
        text: ['The copilot could not assemble an answer from the current demo state. Try one of the suggested questions.'],
        sections: [{ kind: 'observed', text: 'The copilot could not assemble an answer from the current demo state. Try one of the suggested questions.' }],
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
  ask: (question, opts) => {
    const q = question.trim();
    if (!q) return;
    const contextEventId = contextFor(opts?.eventId);
    const a = answer(q, contextEventId);
    set({ turns: [...get().turns, { id: ++seq, question: q, contextEventId, ...a }].slice(-MAX_TURNS) });
  },
  clear: () => set({ turns: [] }),
  registerDock: () => {
    set((s) => ({ docks: s.docks + 1 }));
    return () => set((s) => ({ docks: Math.max(0, s.docks - 1) }));
  },
  focusDock: () => set((s) => ({ focusTick: s.focusTick + 1 })),
}));

/** Sets (or clears) the event the conversation is about. */
export const setCopilotContext = (eventId: string | null) => useApp.setState({ copilotEventId: eventId });

// Reset Demo replays the plant from the start: earlier answers and the event context no longer describe it.
useSim.subscribe((s, prev) => {
  if (s.resets !== prev.resets) {
    useCopilot.getState().clear();
    setCopilotContext(null);
  }
});
