/**
 * View state of the Factory Twin overlays that outlives a single component (the workspace section
 * a quick view or an event link asks to show, the live list's tab and fold state, the floating
 * camera view, the panel's width). Scene selection, stage highlight, alert filter and camera stay
 * in src/store.ts.
 */
import { create } from 'zustand';

/** The viewer's panel width choice, kept in this browser (wide unless they chose compact). */
const WIDTH_KEY = 'twin.panelWidth';
function storedWide(): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(WIDTH_KEY) !== 'compact';
  } catch {
    return true;
  }
}
function storeWide(wide: boolean) {
  try {
    localStorage.setItem(WIDTH_KEY, wide ? 'wide' : 'compact');
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
}

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
  /**
   * The equipment / vehicle / stage panel's width: wide (70 % of the screen, the feed across its top,
   * two columns under it) or compact (one column at the side). Wide only where the window fits it
   * (src/ui/twin/panelWidth.ts).
   */
  panelWide: boolean;
  setPanelWide: (wide: boolean) => void;
  /** Pixels the open wide panel covers at the right of the 3D view (0 otherwise): the scene centres its view in the rest. */
  insetRight: number;
  setInsetRight: (px: number) => void;
  /** Inner width (px) of the overlay grid over the 3D view (0 until measured): whether the wide panel fits. */
  viewW: number;
  setViewW: (px: number) => void;
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
  panelWide: storedWide(),
  setPanelWide: (panelWide) => {
    storeWide(panelWide);
    set({ panelWide });
  },
  insetRight: 0,
  setInsetRight: (insetRight) => {
    if (get().insetRight !== insetRight) set({ insetRight });
  },
  viewW: 0,
  setViewW: (viewW) => {
    if (get().viewW !== viewW) set({ viewW });
  },
}));
