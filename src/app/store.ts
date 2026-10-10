/**
 * Application navigation. Workspaces are views over the one simulation state, so
 * switching never resets anything; cross-workspace links (event → machine, inspection →
 * station, vehicle → site position) go through the helpers here.
 */
import { create } from 'zustand';
import { INSPECTION_STATIONS } from '../model/plant';
import type { PeriodKey } from '../sim/metrics';
import { useTwin } from '../store';

export type WorkspaceId = 'twin' | 'production' | 'quality' | 'fleet' | 'assets';

export const WORKSPACES: { id: WorkspaceId; title: string; short: string }[] = [
  { id: 'twin', title: 'Factory Twin', short: 'Twin' },
  { id: 'production', title: 'Production & OEE', short: 'Production' },
  { id: 'quality', title: 'Quality Intelligence', short: 'Quality' },
  { id: 'fleet', title: 'Fleet & Logistics', short: 'Fleet' },
  { id: 'assets', title: 'Assets & Data', short: 'Assets' },
];

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
  go: (w: WorkspaceId) => void;
  setNavCollapsed: (v: boolean) => void;
  setPeriod: (p: PeriodKey) => void;
  setScenariosOpen: (v: boolean) => void;
};

export const useApp = create<AppState>((set) => ({
  workspace: fromHash(),
  navCollapsed: false,
  period: 'shift',
  scenariosOpen: false,
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
