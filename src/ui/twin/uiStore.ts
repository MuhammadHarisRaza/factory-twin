/**
 * View state of the Factory Twin overlays that outlives a single component (the workspace section
 * a quick view or an event link asks to show, the live list's tab and fold state, the floating
 * camera view, the panel’s width and chart time range). Scene selection, stage highlight, alert filter and camera stay
 * in src/store.ts.
 */
import { create } from 'zustand';
import { RANGE_BY_KEY, type RangeKey } from '../../model/telemetry';

/** The viewer's panel width choice, kept in this browser (wide unless they chose compact). */
const WIDTH_KEY = 'twin.panelWidth';
function storedWide(): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(WIDTH_KEY) !== 'compact';
  } catch {
    return true;
  }
}
/** The viewer's width choice for this visit (also when storage is blocked). */
let chosenWide = storedWide();
function storeWide(wide: boolean) {
  try {
    localStorage.setItem(WIDTH_KEY, wide ? 'wide' : 'compact');
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
}

/** The viewer's chart time range of the equipment / stage panels, kept in this browser (default 8 h). */
const RANGE_KEY = 'twin.panelRange';
export const DEFAULT_PANEL_RANGE: RangeKey = '8h';
function storedRange(): RangeKey {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(RANGE_KEY);
    return v && Object.hasOwn(RANGE_BY_KEY, v) ? (v as RangeKey) : DEFAULT_PANEL_RANGE;
  } catch {
    return DEFAULT_PANEL_RANGE;
  }
}
function storeRange(key: RangeKey) {
  try {
    localStorage.setItem(RANGE_KEY, key);
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
  /** `remember` false: for this visit only (the rail's zone-list button), the saved choice stays. */
  setPanelWide: (wide: boolean, remember?: boolean) => void;
  /** Back to the width the viewer chose with the header's button (or the default, wide). */
  restorePanelWidth: () => void;
  /** The panels' chart time range (15 min … 7 days), remembered in this browser. */
  panelRange: RangeKey;
  setPanelRange: (key: RangeKey) => void;
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
  panelWide: chosenWide,
  setPanelWide: (panelWide, remember = true) => {
    if (remember) {
      chosenWide = panelWide;
      storeWide(panelWide);
    }
    set({ panelWide });
  },
  restorePanelWidth: () => set({ panelWide: chosenWide }),
  panelRange: storedRange(),
  setPanelRange: (panelRange) => {
    storeRange(panelRange);
    set({ panelRange });
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
