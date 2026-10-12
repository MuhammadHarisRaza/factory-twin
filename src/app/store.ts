/**
 * Application navigation. Seven workspaces are views over the one simulation state, so
 * switching never resets anything; cross-workspace links (event → report, event → machine,
 * inspection → station, vehicle → site position, stage → production view) go through the
 * helpers here.
 *
 * Routes: #/<workspace>[/<id>][?tab=<tab>]
 *   #/overview · #/twin[/<equipment id>] · #/production[/<stage id>][?tab=oee] ·
 *   #/quality[/<event id>] · #/fleet[/<vehicle id>] · #/events[/<event id>][?tab=reports] · #/copilot
 * Addresses of retired workspaces redirect to their new home (#/monitoring/KILN → #/production/KILN,
 * #/command and #/energy → #/overview, #/health and #/assets → #/twin, #/scenarios → #/overview with
 * the scenario panel open).
 *
 * Browser history: a user step (workspace, stage, tab or record opened by a click or link) adds a
 * history entry, so Back / Forward move between them; automatic corrections (the newest event
 * opened on arrival, arrow-key moves, the post-reset clear, a 3D pick in the twin) rewrite the
 * current entry instead.
 */
import { create } from 'zustand';
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { INSPECTION_STATIONS, MONITORED_STAGE_BY_ID } from '../model/plant';
import type { MonitoredStageId } from '../model/types';
import type { PeriodKey } from '../sim/metrics';
import { DEFAULT_TARIFFS, type Tariffs } from '../sim/energy';
import { DEFAULT_FINANCE, type FinanceAssumptions } from '../sim/finance';
import { useSim } from '../sim/store';
import { useTwin } from '../store';

/** How a navigation is recorded: 'push' adds a browser-history entry (user step), 'replace' rewrites the current one (automatic correction). */
export type NavMode = 'push' | 'replace';

export type WorkspaceId = 'overview' | 'twin' | 'production' | 'quality' | 'fleet' | 'events' | 'copilot';

/** Workspaces of earlier releases; their links and addresses redirect (see LEGACY_REDIRECTS). */
export type LegacyWorkspaceId = 'monitoring' | 'command' | 'health' | 'energy' | 'scenarios' | 'assets';

export const LEGACY_REDIRECTS: Record<LegacyWorkspaceId, WorkspaceId> = {
  monitoring: 'production',
  command: 'overview',
  health: 'twin',
  energy: 'overview',
  scenarios: 'overview',
  assets: 'twin',
};

const isLegacy = (w: string): w is LegacyWorkspaceId => Object.prototype.hasOwnProperty.call(LEGACY_REDIRECTS, w);

export const WORKSPACES: { id: WorkspaceId; title: string; short: string; question: string }[] = [
  { id: 'overview', title: 'Overview', short: 'Overview', question: 'What is happening, and what needs attention?' },
  { id: 'twin', title: 'Factory Twin', short: 'Twin', question: 'Where is it happening, and what state is the equipment in?' },
  { id: 'production', title: 'Production', short: 'Production', question: 'Are we producing what we planned, and where is output lost?' },
  { id: 'quality', title: 'Quality & Defects', short: 'Quality', question: 'What quality problems are occurring, and where?' },
  { id: 'fleet', title: 'Fleet & Movement', short: 'Fleet', question: 'Where are vehicles and materials, and what is delaying movement?' },
  { id: 'events', title: 'Events & Reports', short: 'Events', question: 'What happened, what was the impact, and what was done?' },
  { id: 'copilot', title: 'Copilot', short: 'Copilot', question: 'Ask about the current state of the factory.' },
];

export const WORKSPACE_BY_ID = Object.fromEntries(WORKSPACES.map((w) => [w.id, w])) as Record<WorkspaceId, (typeof WORKSPACES)[number]>;

/** Workspaces that use the shared reporting-period selector in the header. */
export const PERIOD_WORKSPACES: WorkspaceId[] = ['production', 'quality', 'fleet'];

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

/** Workspaces whose route carries a record id (#/<workspace>/<id>). */
type DetailWorkspace = 'twin' | 'production' | 'quality' | 'fleet' | 'events';

type Route = { workspace: WorkspaceId; id: string | null; tab: string | null; legacy: LegacyWorkspaceId | null };

const validId = (ws: WorkspaceId, id: string | null): string | null => {
  if (!id) return null;
  if (ws === 'production') return MONITORED_STAGE_BY_ID[id as MonitoredStageId] ? id : null;
  if (ws === 'twin') return EQUIPMENT_BY_ID[id] ? id : null;
  if (ws === 'events' || ws === 'quality' || ws === 'fleet') return id;
  return null;
};

export const parseHash = (hash: string): Route => {
  const raw = hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [first = '', second] = path.split('/');
  const tab = new URLSearchParams(query).get('tab');
  const legacy = isLegacy(first) ? first : null;
  const workspace: WorkspaceId = legacy ? LEGACY_REDIRECTS[legacy] : (WORKSPACES.find((w) => w.id === first)?.id ?? 'overview');
  // A retired workspace keeps its record only where the new home shows the same thing (a monitoring stage).
  const id = legacy && legacy !== 'monitoring' ? null : validId(workspace, second ? decodeURIComponent(second) : null);
  return { workspace, id, tab: legacy ? null : tab || null, legacy };
};

const hashFor = (r: { workspace: WorkspaceId; id: string | null; tab: string | null }) =>
  `#/${r.workspace}${r.id ? `/${encodeURIComponent(r.id)}` : ''}${r.tab ? `?tab=${encodeURIComponent(r.tab)}` : ''}`;

type AppState = {
  workspace: WorkspaceId;
  /** Event shown in Events & Reports (#/events/<id>). */
  selectedEventId: string | null;
  /** Stage open in Production (#/production/<stage>). */
  productionStage: MonitoredStageId | null;
  /** Defect event (or inspection record id) open in Quality & Defects (#/quality/<id>). */
  qualityEventId: string | null;
  /** Vehicle open in Fleet & Movement (#/fleet/<vehicle id>). */
  fleetVehicleId: string | null;
  /** Sub-view per workspace (?tab=…); absent = the workspace's default view. */
  tabs: Partial<Record<WorkspaceId, string>>;
  navCollapsed: boolean;
  /** Reporting period shared by the analytical workspaces. */
  period: PeriodKey;
  scenariosOpen: boolean;
  /** Illustrative energy tariffs (used where an energy cost enters a loss estimate). */
  tariffs: Tariffs;
  /** Financial assumptions for loss estimates (editable in Production → Analysis → Assumptions & what-ifs). */
  finance: FinanceAssumptions;
  /** User-configured live camera streams by camera id (persisted in this browser only). */
  cameraSources: Record<string, CameraSource>;
  copilotOpen: boolean;
  /** Question to ask when the copilot opens (from a link). */
  copilotPrompt: string | null;
  /** Event the copilot conversation is about (event-specific investigation). */
  copilotEventId: string | null;
  /** Opens a workspace (a user step by default: Back returns to the previous one). Retired ids redirect. */
  go: (w: WorkspaceId | LegacyWorkspaceId, mode?: NavMode) => void;
  /** Switches the sub-view of a workspace (null = default view). Records a history step by default. */
  setTab: (w: WorkspaceId, tab: string | null, mode?: NavMode) => void;
  setTariffs: (t: Partial<Tariffs>) => void;
  setFinance: (f: Partial<FinanceAssumptions>) => void;
  resetFinance: () => void;
  setCameraSource: (cameraId: string, src: CameraSource | null) => void;
  openCopilot: (prompt?: string, ctx?: { eventId?: string }) => void;
  closeCopilot: () => void;
  setNavCollapsed: (v: boolean) => void;
  setPeriod: (p: PeriodKey) => void;
  setScenariosOpen: (v: boolean) => void;
  /** Selects the event of Events & Reports. 'push' (default) for a user's pick; 'replace' for automatic selections. */
  selectEvent: (id: string | null, mode?: NavMode) => void;
  /** Opens a stage in Production (null = all stages). 'push' (default) for a user's pick. */
  selectStage: (id: MonitoredStageId | null, mode?: NavMode) => void;
  /** Opens a defect event in Quality & Defects (null = none). */
  selectQualityEvent: (id: string | null, mode?: NavMode) => void;
  /** Opens a vehicle in Fleet & Movement (null = none). */
  selectFleetVehicle: (id: string | null, mode?: NavMode) => void;
};

/**
 * History entries carry the Reset Demo epoch they were written in: event ids restart after a
 * reset, so an older entry's event id would name a different (or no) event.
 */
type HistoryState = { waiEpoch: number };
const epoch = () => useSim.getState().resets;
const hasHistory = () => typeof location !== 'undefined' && typeof history !== 'undefined';

/** The record id the current state shows in a workspace's route. */
function routeId(s: Pick<AppState, 'selectedEventId' | 'productionStage' | 'qualityEventId' | 'fleetVehicleId'>, ws: WorkspaceId): string | null {
  switch (ws) {
    case 'events':
      return s.selectedEventId;
    case 'production':
      return s.productionStage;
    case 'quality':
      return s.qualityEventId;
    case 'fleet':
      return s.fleetVehicleId;
    case 'twin':
      return useTwin.getState().selected;
    default:
      return null;
  }
}

const writeHash = (ws: WorkspaceId, mode: NavMode) => {
  if (!hasHistory()) return;
  const s = useApp.getState();
  const h = hashFor({ workspace: ws, id: routeId(s, ws), tab: s.tabs[ws] ?? null });
  if (location.hash === h) return;
  const state: HistoryState = { waiEpoch: epoch() };
  if (mode === 'push') history.pushState(state, '', h);
  else history.replaceState(state, '', h);
};

const initial = parseHash(typeof location !== 'undefined' ? location.hash : '');

export const useApp = create<AppState>((set, get) => ({
  workspace: initial.workspace,
  selectedEventId: initial.workspace === 'events' ? initial.id : null,
  productionStage: initial.workspace === 'production' ? (initial.id as MonitoredStageId | null) : null,
  qualityEventId: initial.workspace === 'quality' ? initial.id : null,
  fleetVehicleId: initial.workspace === 'fleet' ? initial.id : null,
  tabs: initial.tab ? { [initial.workspace]: initial.tab } : {},
  navCollapsed: false,
  period: 'shift',
  scenariosOpen: initial.legacy === 'scenarios',
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
  go: (target, mode = 'push') => {
    const workspace = isLegacy(target) ? LEGACY_REDIRECTS[target] : target;
    if (target === 'scenarios') set({ scenariosOpen: true });
    set({ workspace });
    writeHash(workspace, mode);
  },
  setTab: (w, tab, mode = 'push') => {
    set((s) => {
      const tabs = { ...s.tabs };
      if (tab) tabs[w] = tab;
      else delete tabs[w];
      return { tabs };
    });
    if (get().workspace === w) writeHash(w, mode);
  },
  setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
  setPeriod: (period) => set({ period }),
  setScenariosOpen: (scenariosOpen) => set({ scenariosOpen }),
  selectEvent: (selectedEventId, mode = 'push') => {
    set({ selectedEventId });
    if (get().workspace === 'events') writeHash('events', mode);
  },
  selectStage: (productionStage, mode = 'push') => {
    set({ productionStage });
    if (get().workspace === 'production') writeHash('production', mode);
  },
  selectQualityEvent: (qualityEventId, mode = 'push') => {
    set({ qualityEventId });
    if (get().workspace === 'quality') writeHash('quality', mode);
  },
  selectFleetVehicle: (fleetVehicleId, mode = 'push') => {
    set({ fleetVehicleId });
    if (get().workspace === 'fleet') writeHash('fleet', mode);
  },
}));

const DETAIL_FIELD: Record<Exclude<DetailWorkspace, 'twin'>, 'selectedEventId' | 'productionStage' | 'qualityEventId' | 'fleetVehicleId'> = {
  events: 'selectedEventId',
  production: 'productionStage',
  quality: 'qualityEventId',
  fleet: 'fleetVehicleId',
};

/**
 * Applies the address bar to the store: Back / Forward (popstate), a typed or followed hash
 * (hashchange; browsers fire both for one traversal, which is harmless — the second is a no-op).
 */
export function applyLocation() {
  const r = parseHash(location.hash);
  const entry = hasHistory() ? (history.state as Partial<HistoryState> | null) : null;
  // An entry written before a Reset Demo: its event id now names a different event (or none).
  const idIsEvent = r.workspace === 'events' || r.workspace === 'quality';
  const stale = idIsEvent && r.id != null && typeof entry?.waiEpoch === 'number' && entry.waiEpoch !== epoch();
  const cur = useApp.getState();
  const next: Partial<AppState> = { workspace: r.workspace };
  if (r.workspace in DETAIL_FIELD) {
    const field = DETAIL_FIELD[r.workspace as keyof typeof DETAIL_FIELD];
    // The address is the record shown: #/production without a stage is the all-stages view, so Back does not strand a stage.
    // A pre-reset event id names a different event now: keep the current selection instead.
    (next as Record<string, unknown>)[field] = stale ? cur[field] : r.id;
  }
  const curTab = cur.tabs[r.workspace] ?? null;
  if (curTab !== r.tab) {
    const tabs = { ...cur.tabs };
    if (r.tab) tabs[r.workspace] = r.tab;
    else delete tabs[r.workspace];
    next.tabs = tabs;
  }
  if (r.legacy === 'scenarios') next.scenariosOpen = true;
  const changed = (Object.keys(next) as (keyof AppState)[]).some((k) => next[k] !== cur[k]);
  if (changed) useApp.setState(next);
  if (r.workspace === 'twin' && r.id && useTwin.getState().selected !== r.id) requestAnimationFrame(() => useTwin.getState().select(r.id));
  // Back onto a bare #/twin entry while something is selected: the address names the selection (as go('twin') does).
  if (r.workspace === 'twin' && !r.id && useTwin.getState().selected) writeHash('twin', 'replace');
  // Retired addresses and pre-reset event ids are rewritten in place to the canonical route.
  if (r.legacy || stale) writeHash(r.workspace, 'replace');
}

if (typeof window !== 'undefined') {
  // Tag the landing entry (deep link or not) with the current epoch; a retired address becomes canonical.
  try {
    if (hasHistory()) {
      if (initial.legacy || !location.hash) history.replaceState({ waiEpoch: epoch() } satisfies HistoryState, '', hashFor({ workspace: initial.workspace, id: initial.id, tab: initial.tab }));
      else history.replaceState({ waiEpoch: epoch() } satisfies HistoryState, '');
    }
  } catch {
    /* history unavailable (sandboxed frame): navigation still works, without Back / Forward */
  }
  window.addEventListener('popstate', applyLocation);
  window.addEventListener('hashchange', applyLocation);
  // A twin deep link (#/twin/<equipment>) selects the equipment once the model can frame it.
  if (initial.workspace === 'twin' && initial.id) {
    const id = initial.id;
    const unsub = useTwin.subscribe((t) => {
      if (!t.ready) return;
      unsub();
      requestAnimationFrame(() => useTwin.getState().select(id));
    });
  }
  // Picking equipment in the Factory Twin keeps the address in step (rewriting the entry, so a click
  // in the model does not add a history step).
  useTwin.subscribe((t, prev) => {
    if (t.selected !== prev.selected && useApp.getState().workspace === 'twin') writeHash('twin', 'replace');
  });
}

// Reset Demo replays the plant and event ids restart: a kept selection would later open a different
// event under the reused id. Clear event selections on every completed reset, whichever workspace is
// open; the address is rewritten in place where it shows one of them.
useSim.subscribe((s, prev) => {
  if (s.resets === prev.resets) return;
  const a = useApp.getState();
  if (a.selectedEventId != null) a.selectEvent(null, 'replace');
  if (a.qualityEventId != null) a.selectQualityEvent(null, 'replace');
  // Truck ids restart after a reset too (internal vehicles keep theirs).
  if (a.fleetVehicleId != null && s.sim.logistics.vehicles[a.fleetVehicleId]?.class !== 'internal') a.selectFleetVehicle(null, 'replace');
});

/** Open the Factory Twin with an equipment item selected and framed. */
export function openEquipment(id: string) {
  useApp.getState().go('twin');
  // Let the twin become visible (and size its canvas) before the camera flight starts.
  requestAnimationFrame(() => {
    useTwin.getState().select(id);
    writeHash('twin', 'replace');
  });
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

/** Open a vehicle's detail in Fleet & Movement. */
export function openFleetVehicle(id: string) {
  useApp.setState({ fleetVehicleId: id });
  useApp.getState().go('fleet');
}

/** Open an event's full report in Events & Reports. */
export function openEvent(id: string) {
  // An event link opens the event itself (the Events tab), whatever tab Events & Reports showed last.
  useApp.setState((s) => {
    const tabs = { ...s.tabs };
    delete tabs.events;
    return { selectedEventId: id, tabs };
  });
  useApp.getState().go('events');
}

/** Open a defect event's evidence in Quality & Defects. */
export function openDefect(eventId: string) {
  // A defect link opens its evidence (the investigation tab), whatever tab Quality showed last.
  useApp.setState((s) => {
    const tabs = { ...s.tabs };
    delete tabs.quality;
    return { qualityEventId: eventId, tabs };
  });
  useApp.getState().go('quality');
}

/** Open a stage in Production (and highlight it in the 3D model). */
export function openStage(id: MonitoredStageId) {
  // A stage link opens the stage's own view (the default tab), whatever tab Production showed last.
  useApp.setState((s) => {
    const tabs = { ...s.tabs };
    delete tabs.production;
    return { productionStage: id, tabs };
  });
  useTwin.getState().selectStage(id, { frame: false });
  useApp.getState().go('production');
}

/**
 * Open a workspace's line-level view on a given tab (null = its default view): Production opens on all
 * stages, not on the stage it showed last. Used by KPI chips and "show me" links that name a view.
 */
export function openView(ws: WorkspaceId, tab: string | null = null) {
  useApp.setState((s) => {
    const tabs = { ...s.tabs };
    if (tab) tabs[ws] = tab;
    else delete tabs[ws];
    return ws === 'production' ? { tabs, productionStage: null } : { tabs };
  });
  useApp.getState().go(ws);
}

/** Open the report builder of Events & Reports. */
export function openReports() {
  useApp.setState((s) => ({ tabs: { ...s.tabs, events: 'reports' } }));
  useApp.getState().go('events');
}

/** Show an event's affected object in the 3D factory (asset, station, vehicle or zone). */
export function openEventInTwin(ev: { asset: { equipmentId?: string; vehicleId?: string; stationId?: string; zone?: string } }) {
  if (ev.asset.vehicleId) return openVehicle(ev.asset.vehicleId);
  if (ev.asset.equipmentId) return openEquipment(ev.asset.equipmentId);
  if (ev.asset.stationId) return openStation(ev.asset.stationId);
  useApp.getState().go('twin');
  if (ev.asset.zone) requestAnimationFrame(() => useTwin.getState().selectZone(ev.asset.zone!));
}
