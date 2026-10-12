/**
 * View state of the Factory Twin overlays that outlives a single component (the workspace section
 * a quick view or an event link asks to show, the live list's tab and fold state, the floating
 * camera view). Scene selection, stage highlight, alert filter and camera stay in src/store.ts.
 */
import { create } from 'zustand';

/** Sections of the equipment workspace a link can bring into view. */
export type WorkspaceSection = 'overview' | 'condition' | 'events' | 'next';
export type LiveTab = 'events' | 'machines' | 'vehicles';

type TwinUiState = {
  /** Section requested for one asset (a new nonce scrolls to it again); any other selection opens at the top. */
  focusFor: { id: string; section: WorkspaceSection; nonce: number } | null;
  focusSection: (id: string, section: WorkspaceSection) => void;
  liveTab: LiveTab;
  setLiveTab: (tab: LiveTab) => void;
  liveOpen: boolean;
  setLiveOpen: (open: boolean) => void;
  /** Camera shown in the floating camera view (closes when the selection leaves its field of view). */
  camera: string | null;
  setCamera: (id: string | null) => void;
};

export const useTwinUi = create<TwinUiState>((set, get) => ({
  focusFor: null,
  focusSection: (id, section) => set({ focusFor: { id, section, nonce: (get().focusFor?.nonce ?? 0) + 1 } }),
  liveTab: 'events',
  setLiveTab: (liveTab) => set({ liveTab }),
  liveOpen: true,
  setLiveOpen: (liveOpen) => set({ liveOpen }),
  camera: null,
  setCamera: (camera) => set({ camera }),
}));
