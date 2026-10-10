/**
 * View state of the Factory Twin overlays that outlives a single component (the
 * inspector tab requested by a quick view, the live list's tab and fold state). Scene
 * selection and camera stay in src/store.ts.
 */
import { create } from 'zustand';

export type InspectorTab = 'overview' | 'health' | 'events' | 'recs';
export type LiveTab = 'alerts' | 'machines' | 'vehicles';

type TwinUiState = {
  /** Tab chosen for one asset; any other selection opens on Overview. */
  tabFor: { id: string; tab: InspectorTab } | null;
  setTab: (id: string, tab: InspectorTab) => void;
  liveTab: LiveTab;
  setLiveTab: (tab: LiveTab) => void;
  liveOpen: boolean;
  setLiveOpen: (open: boolean) => void;
};

export const useTwinUi = create<TwinUiState>((set) => ({
  tabFor: null,
  setTab: (id, tab) => set({ tabFor: { id, tab } }),
  liveTab: 'alerts',
  setLiveTab: (liveTab) => set({ liveTab }),
  liveOpen: true,
  setLiveOpen: (liveOpen) => set({ liveOpen }),
}));
