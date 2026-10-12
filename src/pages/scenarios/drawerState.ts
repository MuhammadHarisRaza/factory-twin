/**
 * View state of the Scenarios panel that must survive closing and reopening it (and switching its
 * tabs): the open tab, the impact window, and the presenter-guide steps already shown.
 */
import { create } from 'zustand';
import { useSim } from '../../sim/store';
import type { WindowMode } from './catalogue';

export type ScenarioTab = 'demos' | 'catalogue' | 'active' | 'impact' | 'guide';
export const SCENARIO_TABS: ScenarioTab[] = ['demos', 'catalogue', 'active', 'impact', 'guide'];

type DrawerState = {
  tab: ScenarioTab;
  setTab: (t: ScenarioTab) => void;
  impactMode: WindowMode;
  setImpactMode: (m: WindowMode) => void;
  /** Presenter-guide steps already shown (navigation steps have no other trace). */
  visited: Record<string, boolean>;
  visit: (key: string) => void;
  /** Set to scroll the guided-demo tab to a card once it is shown (the Reset card). */
  scrollTo: string | null;
  setScrollTo: (id: string | null) => void;
};

export const useScenarioDrawer = create<DrawerState>((set) => ({
  tab: 'demos',
  setTab: (tab) => set({ tab }),
  impactMode: 'scenario',
  setImpactMode: (impactMode) => set({ impactMode }),
  visited: {},
  visit: (key) => set((s) => ({ visited: { ...s.visited, [key]: true } })),
  scrollTo: null,
  setScrollTo: (scrollTo) => set({ scrollTo }),
}));

// A new demo session starts the presenter guide again.
useSim.subscribe((s, prev) => {
  if (s.resets !== prev.resets) useScenarioDrawer.setState({ visited: {} });
});
