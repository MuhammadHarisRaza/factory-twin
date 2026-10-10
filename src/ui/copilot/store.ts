/**
 * Copilot conversation, shared by the panel docked in the Command Center and the global
 * copilot drawer so both show the same exchange. Each answer is computed once, from the
 * simulation state at the moment of asking, and kept with that plant time.
 */
import { create } from 'zustand';
import { useApp } from '../../app/store';
import { ask as askCopilot, SUGGESTED_QUESTIONS, type CopilotAnswer } from '../../intel/copilot';
import { useSim } from '../../sim/store';

export type CopilotTurn = {
  id: number;
  question: string;
  answer: CopilotAnswer;
  /** Plant minute the answer was computed at. */
  minute: number;
};

type CopilotState = {
  turns: CopilotTurn[];
  /** Docked panels currently on screen (the drawer routes to one when present). */
  docks: number;
  /** Incremented to ask a docked panel to focus its question field. */
  focusTick: number;
  ask: (question: string) => void;
  clear: () => void;
  /** Registers a docked panel; returns the unregister function. */
  registerDock: () => () => void;
  focusDock: () => void;
};

const MAX_TURNS = 40;
let seq = 0;

/** Answer for a question against the current state; never throws (the demo must not break mid-meeting). */
function answer(question: string): { answer: CopilotAnswer; minute: number } {
  const sim = useSim.getState().sim;
  try {
    return { answer: askCopilot(sim, question, useApp.getState().tariffs), minute: sim.minute };
  } catch {
    return {
      minute: sim.minute,
      answer: {
        intent: 'help',
        text: ['The copilot could not assemble an answer from the current demo state. Try one of the suggested questions.'],
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
  ask: (question) => {
    const q = question.trim();
    if (!q) return;
    const a = answer(q);
    set({ turns: [...get().turns, { id: ++seq, question: q, ...a }].slice(-MAX_TURNS) });
  },
  clear: () => set({ turns: [] }),
  registerDock: () => {
    set((s) => ({ docks: s.docks + 1 }));
    return () => set((s) => ({ docks: Math.max(0, s.docks - 1) }));
  },
  focusDock: () => set((s) => ({ focusTick: s.focusTick + 1 })),
}));

// Reset Demo replays the plant from the start: earlier answers no longer describe it.
useSim.subscribe((s, prev) => {
  if (s.resets !== prev.resets) useCopilot.getState().clear();
});
