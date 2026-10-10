/**
 * Application navigation. Workspaces are views over the one simulation state, so
 * switching never resets anything; cross-workspace links (event → machine, inspection →
 * station, vehicle → site position) go through the helpers here.
 */
import { create } from 'zustand';
import { INSPECTION_STATIONS } from '../model/plant';
import type { PeriodKey } from '../sim/metrics';
import { DEFAULT_TARIFFS, type Tariffs } from '../sim/energy';
import { useTwin } from '../store';

export type WorkspaceId = 'twin' | 'production' | 'quality' | 'health' | 'energy' | 'command' | 'scenarios' | 'fleet' | 'assets';

export const WORKSPACES: { id: WorkspaceId; title: string; short: string; group: 'operations' | 'platform' }[] = [
  { id: 'twin', title: 'Factory Twin', short: 'Twin', group: 'operations' },
  { id: 'production', title: 'Production & OEE', short: 'Production', group: 'operations' },
  { id: 'quality', title: 'Quality Intelligence', short: 'Quality', group: 'operations' },
  { id: 'health', title: 'Machine Health', short: 'Health', group: 'operations' },
  { id: 'energy', title: 'Energy Intelligence', short: 'Energy', group: 'operations' },
  { id: 'command', title: 'Command Center', short: 'Command', group: 'operations' },
  { id: 'scenarios', title: 'Scenario Simulator', short: 'Scenarios', group: 'operations' },
  { id: 'fleet', title: 'Fleet & Logistics', short: 'Fleet', group: 'platform' },
  { id: 'assets', title: 'Assets & Data', short: 'Assets', group: 'platform' },
];

/** Workspaces that use the shared reporting-period selector in the header. */
export const PERIOD_WORKSPACES: WorkspaceId[] = ['production', 'quality', 'energy', 'fleet'];

const fromHash = (): WorkspaceId => {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  return (WORKSPACES.find((w) => w.id === h)?.id ?? 'twin') as WorkspaceId;
};

type AppState = {
  workspace: WorkspaceId;
  navCollapsed: boolean;
  /** Reporting period shared by the analytical workspaces. */
  period: PeriodKey;
  scenariosOpen: boolean;
  /** Illustrative energy tariffs (editable in Energy Intelligence; used everywhere costs appear). */
  tariffs: Tariffs;
  copilotOpen: boolean;
  /** Question to pre-fill / ask when the copilot opens (from a link). */
  copilotPrompt: string | null;
  go: (w: WorkspaceId) => void;
  setTariffs: (t: Partial<Tariffs>) => void;
  openCopilot: (prompt?: string) => void;
  closeCopilot: () => void;
  setNavCollapsed: (v: boolean) => void;
  setPeriod: (p: PeriodKey) => void;
  setScenariosOpen: (v: boolean) => void;
};

export const useApp = create<AppState>((set) => ({
  workspace: fromHash(),
  navCollapsed: false,
  period: 'shift',
  scenariosOpen: false,
  tariffs: DEFAULT_TARIFFS,
  copilotOpen: false,
  copilotPrompt: null,
  setTariffs: (t) => set((s) => ({ tariffs: { ...s.tariffs, ...t } })),
  openCopilot: (prompt) => set({ copilotOpen: true, copilotPrompt: prompt ?? null }),
  closeCopilot: () => set({ copilotOpen: false, copilotPrompt: null }),
  go: (workspace) => {
    set({ workspace });
    if (location.hash !== `#/${workspace}`) history.replaceState(null, '', `#/${workspace}`);
  },
  setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
  setPeriod: (period) => set({ period }),
  setScenariosOpen: (scenariosOpen) => set({ scenariosOpen }),
}));

if (typeof window !== 'undefined') window.addEventListener('hashchange', () => useApp.setState({ workspace: fromHash() }));

/** Open the Factory Twin with an equipment item selected and framed. */
export function openEquipment(id: string) {
  useApp.getState().go('twin');
  // Let the twin become visible (and size its canvas) before the camera flight starts.
  requestAnimationFrame(() => useTwin.getState().select(id));
}

/** Open the Factory Twin on an inspection station. */
export function openStation(stationId: string) {
  const st = INSPECTION_STATIONS.find((s) => s.id === stationId);
  if (st) openEquipment(st.equipmentId);
}

/** Open the Factory Twin following a vehicle. */
export function openVehicle(id: string) {
  useApp.getState().go('twin');
  requestAnimationFrame(() => useTwin.getState().selectVehicle(id, true));
}
