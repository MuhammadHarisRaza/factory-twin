/**
 * The batch the Compare tab should point at when another quality view links to it ("Compare batch").
 * The tab itself is route-bound (#/quality?tab=compare); the focused batch is view state only.
 */
import { create } from 'zustand';
import { openView, useApp } from '../../app/store';

export const useCompareFocus = create<{ batchId: string | null; setBatch: (id: string | null) => void }>((set) => ({
  batchId: null,
  setBatch: (batchId) => set({ batchId }),
}));

/** Open Quality › Compare with one batch highlighted (a history step, so Back returns to the view). */
export function openCompare(batchId: string | null = null) {
  useCompareFocus.getState().setBatch(batchId);
  if (useApp.getState().workspace === 'quality') useApp.getState().setTab('quality', 'compare', 'push');
  else openView('quality', 'compare');
}
