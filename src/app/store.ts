/**
 * Application navigation. Workspaces are views over the one simulation state, so
 * switching never resets anything; cross-workspace links (event → report, event → machine,
 * inspection → station, vehicle → site position, stage → monitoring view) go through the
 * helpers here. Deep links: #/events/EV-00012, #/monitoring/KILN.
 */
import { create } from 'zustand';
import { INSPECTION_STATIONS, MONITORED_STAGE_BY_ID } from '../model/plant';
import type { MonitoredStageId } from '../model/types';
import type { PeriodKey } from '../sim/metrics';
import { DEFAULT_TARIFFS, type Tariffs } from '../sim/energy';
import { DEFAULT_FINANCE, type FinanceAssumptions } from '../sim/finance';
import { useTwin } from '../store';

export type WorkspaceId =
  | 'twin'
  | 'monitoring'
  | 'production'
  | 'quality'
  | 'fleet'
  | 'events'
  | 'copilot'
  | 'command'
  | 'health'
  | 'energy'
  | 'scenarios'
  | 'assets';

export type WorkspaceGroup = 'operations' | 'intelligence' | 'platform';

export const WORKSPACE_GROUPS: { id: WorkspaceGroup; label: string }[] = [
  { id: 'operations', label: 'Operations' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'platform', label: 'Platform' },
];

export const WORKSPACES: { id: WorkspaceId; title: string; short: string; group: WorkspaceGroup }[] = [
  { id: 'twin', title: 'Factory Twin', short: 'Twin', group: 'operations' },
  { id: 'monitoring', title: 'Production Monitoring', short: 'Monitoring', group: 'operations' },
  { id: 'production', title: 'OEE & Loss Intelligence', short: 'OEE & Loss', group: 'operations' },
  { id: 'quality', title: 'AI Defect Monitoring', short: 'Defects', group: 'operations' },
  { id: 'fleet', title: 'Vehicle Monitoring', short: 'Vehicles', group: 'operations' },
  { id: 'events', title: 'Events & Reports', short: 'Events', group: 'operations' },
  { id: 'copilot', title: 'Factory Copilot', short: 'Copilot', group: 'operations' },
  { id: 'command', title: 'Command Center', short: 'Command', group: 'intelligence' },
  { id: 'health', title: 'Machine Health', short: 'Health', group: 'intelligence' },
  { id: 'energy', title: 'Energy Intelligence', short: 'Energy', group: 'intelligence' },
  { id: 'scenarios', title: 'Scenario Simulator', short: 'Scenarios', group: 'intelligence' },
  { id: 'assets', title: 'Assets & Data', short: 'Assets', group: 'platform' },
];

/** Workspaces that use the shared reporting-period selector in the header. */
export const PERIOD_WORKSPACES: WorkspaceId[] = ['monitoring', 'production', 'quality', 'energy', 'fleet'];

/** A live camera stream the user configured (browser-playable URL). Nothing is configured by default. */
export type CameraSource = { url: string; kind: 'auto' | 'video' | 'hls' | 'mjpeg' };

const CAMERA_KEY = 'wai.cameraSources';
const loadCameras = (): Record<string, CameraSource> => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CAMERA_KEY) : null;
    return raw ? (JSON.parse(raw) as Record<string, CameraSource>) : {};
  } catch {
    return {};
  }
};
const saveCameras = (v: Record<string, CameraSource>) => {
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: keep in memory only */
  }
};

type Route = { workspace: WorkspaceId; eventId: string | null; stage: MonitoredStageId | null };

const parseHash = (): Route => {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  const [first, second] = h.split('/');
  const ws = (WORKSPACES.find((w) => w.id === first)?.id ?? 'twin') as WorkspaceId;
  return {
    workspace: ws,
    eventId: ws === 'events' && second ? decodeURIComponent(second) : null,
    stage: ws === 'monitoring' && second && MONITORED_STAGE_BY_ID[second as MonitoredStageId] ? (second as MonitoredStageId) : null,
  };
};

const hashFor = (r: Route) => `#/${r.workspace}${r.workspace === 'events' && r.eventId ? `/${encodeURIComponent(r.eventId)}` : r.workspace === 'monitoring' && r.stage ? `/${r.stage}` : ''}`;

type AppState = {
  workspace: WorkspaceId;
  /** Event shown in Events & Reports (deep link #/events/<id>). */
  selectedEventId: string | null;
  /** Stage open in Production Monitoring (deep link #/monitoring/<stage>). */
  monitoringStage: MonitoredStageId | null;
  navCollapsed: boolean;
  /** Reporting period shared by the analytical workspaces. */
  period: PeriodKey;
  scenariosOpen: boolean;
  /** Illustrative energy tariffs (editable in Energy Intelligence; used wherever an energy cost is shown). */
  tariffs: Tariffs;
  /** Financial assumptions for loss estimates (editable in OEE & Loss Intelligence). */
  finance: FinanceAssumptions;
  /** User-configured live camera streams by camera id (persisted in this browser only). */
  cameraSources: Record<string, CameraSource>;
  copilotOpen: boolean;
  /** Question to ask when the copilot opens (from a link). */
  copilotPrompt: string | null;
  /** Event the copilot conversation is about (event-specific investigation). */
  copilotEventId: string | null;
  go: (w: WorkspaceId) => void;
  setTariffs: (t: Partial<Tariffs>) => void;
  setFinance: (f: Partial<FinanceAssumptions>) => void;
  resetFinance: () => void;
  setCameraSource: (cameraId: string, src: CameraSource | null) => void;
  openCopilot: (prompt?: string, ctx?: { eventId?: string }) => void;
  closeCopilot: () => void;
  setNavCollapsed: (v: boolean) => void;
  setPeriod: (p: PeriodKey) => void;
  setScenariosOpen: (v: boolean) => void;
  selectEvent: (id: string | null) => void;
  selectStage: (id: MonitoredStageId | null) => void;
};

const writeHash = (r: Route) => {
  if (typeof location === 'undefined') return;
  const h = hashFor(r);
  if (location.hash !== h) history.replaceState(null, '', h);
};

const initial = parseHash();

export const useApp = create<AppState>((set, get) => ({
  workspace: initial.workspace,
  selectedEventId: initial.eventId,
  monitoringStage: initial.stage,
  navCollapsed: false,
  period: 'shift',
  scenariosOpen: false,
  tariffs: DEFAULT_TARIFFS,
  finance: DEFAULT_FINANCE,
  cameraSources: loadCameras(),
  copilotOpen: false,
  copilotPrompt: null,
  copilotEventId: null,
  setTariffs: (t) => set((s) => ({ tariffs: { ...s.tariffs, ...t }, finance: t.currency ? { ...s.finance, currency: t.currency } : s.finance })),
  setFinance: (f) => set((s) => ({ finance: { ...s.finance, ...f }, tariffs: f.currency ? { ...s.tariffs, currency: f.currency } : s.tariffs })),
  resetFinance: () => set((s) => ({ finance: { ...DEFAULT_FINANCE, currency: s.tariffs.currency } })),
  setCameraSource: (cameraId, src) =>
    set((s) => {
      const next = { ...s.cameraSources };
      if (src && src.url.trim()) next[cameraId] = { ...src, url: src.url.trim() };
      else delete next[cameraId];
      saveCameras(next);
      return { cameraSources: next };
    }),
  openCopilot: (prompt, ctx) =>
    set((s) => ({ copilotOpen: true, copilotPrompt: prompt ?? null, copilotEventId: ctx ? (ctx.eventId ?? null) : prompt ? null : s.copilotEventId })),
  closeCopilot: () => set({ copilotOpen: false, copilotPrompt: null }),
  go: (workspace) => {
    set({ workspace });
    const s = get();
    writeHash({ workspace, eventId: s.selectedEventId, stage: s.monitoringStage });
  },
  setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
  setPeriod: (period) => set({ period }),
  setScenariosOpen: (scenariosOpen) => set({ scenariosOpen }),
  selectEvent: (selectedEventId) => {
    set({ selectedEventId });
    const s = get();
    if (s.workspace === 'events') writeHash({ workspace: 'events', eventId: selectedEventId, stage: null });
  },
  selectStage: (monitoringStage) => {
    set({ monitoringStage });
    const s = get();
    if (s.workspace === 'monitoring') writeHash({ workspace: 'monitoring', eventId: null, stage: monitoringStage });
  },
}));

if (typeof window !== 'undefined')
  window.addEventListener('hashchange', () => {
    const r = parseHash();
    useApp.setState({
      workspace: r.workspace,
      ...(r.eventId ? { selectedEventId: r.eventId } : {}),
      // #/monitoring without a stage is the overview — clear the stage so Back does not strand it.
      ...(r.workspace === 'monitoring' ? { monitoringStage: r.stage } : {}),
    });
  });

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

/** Open an event's full report in Events & Reports. */
export function openEvent(id: string) {
  useApp.setState({ selectedEventId: id });
  useApp.getState().go('events');
}

/** Open a stage's detail view in Production Monitoring. */
export function openStage(id: MonitoredStageId) {
  useApp.setState({ monitoringStage: id });
  useApp.getState().go('monitoring');
}

/** Show an event's affected object in the 3D factory (asset, station, vehicle or zone). */
export function openEventInTwin(ev: { asset: { equipmentId?: string; vehicleId?: string; stationId?: string; zone?: string } }) {
  if (ev.asset.vehicleId) return openVehicle(ev.asset.vehicleId);
  if (ev.asset.equipmentId) return openEquipment(ev.asset.equipmentId);
  if (ev.asset.stationId) return openStation(ev.asset.stationId);
  useApp.getState().go('twin');
  if (ev.asset.zone) requestAnimationFrame(() => useTwin.getState().selectZone(ev.asset.zone!));
}
