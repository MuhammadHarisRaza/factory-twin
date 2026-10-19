/**
 * Factory Twin interface derivations. Pure functions over the one simulation state —
 * line status per process stage (with the conveyors between stages), a truck's visit
 * milestones, the shift timeline of operational events, the event lists of the live list
 * and the inspector, global search and quick-view targets. Every figure comes from src/sim
 * (metrics, events, health, logistics); this file only shapes it for the overlays.
 */
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONES, ZONE_BY_ID } from '../../data/layout';
import {
  CONVEYOR_BY_ID,
  DOCKS,
  GEOFENCES,
  INSPECTION_STATIONS,
  MONITORED_STAGES,
  PRODUCTS,
  REASON_BY_CODE,
  SCENARIO_KIND_LABELS,
  STAGE_BY_ID,
  cameraFor,
} from '../../model/plant';
import type {
  AlertSeverity,
  CameraDef,
  EventCategory,
  EventStatus,
  MachineState,
  MonitoredStageId,
  OpEvent,
  OperationalState,
  ProductionBatch,
  RecordSource,
  StageId,
  Vehicle,
} from '../../model/types';
import { findDowntime, type SimState } from '../../sim/engine';
import { EVENT_STATUS_LABEL, EVENT_TYPE_LABEL } from '../../sim/events';
import type { HealthAssessment, HealthLevel } from '../../sim/health';
import { phaseLabel, type TruckRuntime } from '../../sim/logistics';
import { operationalState } from '../../sim/metrics';
import { formatClock, formatDuration, shiftAt } from '../../sim/time';
import { constraintMarker, type ConstraintMarker } from './constraint';

// ── Production-line status strip ─────────────────────────────────────────────

export type LineStageDef = {
  key: string;
  /** Short chip caption. */
  label: string;
  name: string;
  /** Simulated process stages covered by the chip (empty = storage end of the line, no machine state). */
  stages: StageId[];
  zone: string;
  /** Production stage the chip highlights in the model (useTwin.selectStage); null = no production stage (raw materials). */
  monitored: MonitoredStageId | null;
};

/** The line as the presenter tells it: Raw → … → Warehouse (packing & palletising share one chip). */
export const LINE_STAGES: LineStageDef[] = [
  { key: 'RAW', label: 'Raw', name: 'Raw materials', stages: [], zone: 'B', monitored: null },
  { key: 'PREP', label: 'Prep', name: 'Body preparation', stages: ['PREP'], zone: 'C', monitored: 'PREP' },
  { key: 'SPRAY', label: 'Spray', name: 'Spray drying', stages: ['SPRAY'], zone: 'D', monitored: 'SPRAY' },
  { key: 'PRESS', label: 'Press', name: 'Pressing', stages: ['PRESS'], zone: 'E', monitored: 'PRESS' },
  { key: 'DRY', label: 'Dry', name: 'Drying', stages: ['DRY'], zone: 'F', monitored: 'DRY' },
  { key: 'GLAZE', label: 'Glaze', name: 'Glazing', stages: ['GLAZE'], zone: 'G', monitored: 'GLAZE' },
  { key: 'DECOR', label: 'Decor', name: 'Digital decoration', stages: ['DECOR'], zone: 'G', monitored: 'GLAZE' },
  { key: 'KILN', label: 'Kiln', name: 'Firing', stages: ['KILN'], zone: 'H', monitored: 'KILN' },
  { key: 'SORT', label: 'Sort', name: 'Sorting & inspection', stages: ['SORT'], zone: 'I', monitored: 'SORT' },
  { key: 'PACK', label: 'Pack', name: 'Packing & palletising', stages: ['PACK', 'PAL'], zone: 'J', monitored: 'PACK' },
  { key: 'WH', label: 'Warehouse', name: 'Finished-goods warehouse', stages: [], zone: 'K', monitored: 'WH' },
];

/**
 * Conveyors drawn between two chips (`FROM>TO` chip keys). The glaze-line belt runs through
 * glazing and decoration, so it links both gaps; the carton conveyor CV-PAL sits inside the
 * packing & palletising chip. Raw → prep → spray (slip pumps) and pack → warehouse (forklifts)
 * have no modelled conveyor.
 */
export const LINE_CONVEYORS_BETWEEN: Record<string, string[]> = {
  'SPRAY>PRESS': ['D-BELT'],
  'PRESS>DRY': ['E-COL'],
  'DRY>GLAZE': ['CV-GLZ'],
  'GLAZE>DECOR': ['CV-GLZ'],
  'DECOR>KILN': ['CV-KIN'],
  'KILN>SORT': ['CV-SORT'],
  'SORT>PACK': ['CV-PACK'],
};
export const LINE_CONVEYORS_WITHIN: Record<string, string[]> = { PACK: ['CV-PAL'] };

/**
 * Order used to pick a chip's worst state, in the operational-state model the product shows:
 * a stale feed ('unknown') outranks normal running but never hides a stop or a fault.
 */
export const OP_RANK: Record<OperationalState, number> = {
  running: 1,
  idle: 2,
  planned: 3,
  changeover: 3.5,
  disconnected: 4,
  unknown: 5,
  starved: 6,
  blocked: 7,
  reduced: 8,
  stopped: 9,
  fault: 10,
};

/** One tracked asset (process machine or conveyor) as the twin shows it. */
export type AssetStatus = {
  id: string;
  name: string;
  /** Simulated machine state (engine truth; used only for timing and reasons). */
  state: MachineState;
  /** What the product shows: fault / stopped / planned / starved … or unknown while the feed is stale. */
  op: OperationalState;
  since: number;
  /** Reason of the active stop (alarm code label), null while not stopped. */
  reason: string | null;
  /** Rate as reported by the feed (the last value received while it is stale), tiles/h. */
  rate: number;
  /** Minute the data feed went stale, null while it updates. */
  staleSince: number | null;
};

export type LineStageStatus = {
  def: LineStageDef;
  machines: AssetStatus[];
  /** Conveyors inside the chip (CV-PAL in packing & palletising). */
  conveyors: AssetStatus[];
  /** Worst operational state of the chip's machines and internal conveyors; null where no machine state is modelled. */
  worst: OperationalState | null;
  /** Asset to locate on click: the one in the worst state (first machine when all are equal). */
  focusId: string | null;
  /** The line-constraint marker sits on this chip (constraintClaim — "constraining" only when `constraint.active`). */
  constraint: ConstraintMarker | null;
};

/** Link between two consecutive chips; `conveyors` is empty where no conveyor is modelled. */
export type LineConnector = { key: string; from: string; to: string; conveyors: AssetStatus[] };

const reasonOf = (s: SimState, id: string) => {
  const m = s.machines[id];
  const dt = m?.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
  return dt ? REASON_BY_CODE[dt.reasonCode].label : null;
};

/**
 * Status of a tracked asset from its signals: while the feed is stale the product only knows the
 * last values received, so the state reads 'unknown', the rate is the frozen last rate and no
 * stop reason is claimed.
 */
export function assetStatus(s: SimState, id: string): AssetStatus {
  const m = s.machines[id];
  const f = s.feeds[id];
  const stale = f?.status === 'stale';
  return {
    id,
    name: CONVEYOR_BY_ID[id]?.name ?? EQUIPMENT_BY_ID[id]?.name ?? id,
    state: m.state,
    op: operationalState(s, id),
    since: stale ? f.since : m.since,
    reason: stale ? null : reasonOf(s, id),
    rate: stale ? (f.lastRate ?? 0) : m.ratePerHour,
    staleSince: stale ? f.since : null,
  };
}

/** The asset in the worst operational state (first one on ties). */
export function worstOf<T extends { op: OperationalState }>(list: T[]): T | undefined {
  let w: T | undefined;
  for (const a of list) if (!w || OP_RANK[a.op] > OP_RANK[w.op]) w = a;
  return w;
}

/**
 * The line strip: chips per process stage with their worst state, the conveyors between them, and
 * the constraint marker on the chip of the stage the constraint claim names (constraintClaim — the
 * Overview's wording: "constraining output" only with traced evidence, otherwise the kiln as the
 * modeled design constraint).
 */
export function lineStatus(s: SimState) {
  const constraint = constraintMarker(s);
  const stages: LineStageStatus[] = LINE_STAGES.map((def) => {
    const machines = def.stages.flatMap((st) => STAGE_BY_ID[st].machines).map((id) => assetStatus(s, id));
    const conveyors = (LINE_CONVEYORS_WITHIN[def.key] ?? []).map((id) => assetStatus(s, id));
    const w = worstOf([...machines, ...conveyors]);
    return { def, machines, conveyors, worst: w?.op ?? null, focusId: w?.id ?? null, constraint: def.stages.includes(constraint.processStage) ? constraint : null };
  });
  const connectors: LineConnector[] = LINE_STAGES.slice(1).map((to, i) => {
    const from = LINE_STAGES[i];
    const key = `${from.key}>${to.key}`;
    return { key, from: from.key, to: to.key, conveyors: (LINE_CONVEYORS_BETWEEN[key] ?? []).map((id) => assetStatus(s, id)) };
  });
  return { stages, connectors, constraint };
}

// ── Truck visit stepper ──────────────────────────────────────────────────────

export type VisitStep = { key: string; label: string; time: number | null; note?: string };

/** Visit milestones with timestamps (null = not reached yet; never a future time). */
export function visitSteps(s: SimState, v: TruckRuntime): VisitStep[] {
  const now = s.minute;
  const vis = v.visit!;
  const past = (t: number | null | undefined) => (t != null && t <= now ? t : null);
  const dock = vis.dockId ? DOCKS.find((d) => d.id === vis.dockId)?.name : undefined;
  if (vis.direction === 'inbound') {
    const weigh = v.legs.find((l) => l.activity.startsWith('Weighing'));
    return [
      { key: 'gate-in', label: 'Gate in', time: past(vis.gateIn) },
      { key: 'weigh', label: 'Weighbridge', time: past(weigh?.start) },
      { key: 'unload', label: 'Unloading', time: past(vis.dockStart), note: vis.material },
      { key: 'unloaded', label: 'Unloading complete', time: past(vis.dockEnd) },
      { key: 'gate-out', label: 'Gate out', time: past(vis.gateOut) },
    ];
  }
  const loaded = s.logistics.dockEvents.find((e) => e.vehicleId === v.id && e.kind === 'loading-complete')?.time;
  return [
    { key: 'gate-in', label: 'Gate in', time: past(vis.gateIn) },
    { key: 'holding', label: 'Holding', time: past(v.queuedAt) },
    { key: 'assigned', label: 'Dock assigned', time: past(vis.dockAssigned), note: dock },
    { key: 'docked', label: 'Docked / loading', time: past(vis.dockStart) },
    { key: 'loaded', label: 'Loading complete', time: past(loaded), note: `${vis.load} pallets` },
    { key: 'gate-out', label: 'Gate out', time: past(vis.gateOut) },
  ];
}

/** Index of the step in progress (first not reached), or steps.length when the visit is complete. */
export const currentStep = (steps: VisitStep[]) => {
  const i = steps.findIndex((st) => st.time == null);
  return i < 0 ? steps.length : i;
};

// ── Live vehicle phase ───────────────────────────────────────────────────────

export type PhaseTone = 'good' | 'warning' | 'neutral';

/** Current activity of any vehicle (phase for trucks, leg activity for internal vehicles). */
export function vehicleActivity(v: Vehicle, now: number): { label: string; tone: PhaseTone } {
  if (v.class === 'external') {
    if (v.visit && v.visit.gateIn > now) return { label: 'Approaching', tone: 'neutral' };
    const p = v.phase ?? 'approaching';
    return { label: phaseLabel[p], tone: p === 'waiting' ? 'warning' : p === 'loading' || p === 'unloading' ? 'good' : 'neutral' };
  }
  const leg = [...v.legs].reverse().find((l) => l.start <= now);
  const label = leg?.activity ?? v.task ?? 'Idle';
  return { label, tone: /idle|waiting|available/i.test(label) ? 'neutral' : 'good' };
}

/** Geofence a vehicle is in now (simulated position, zone level). */
export function vehicleGeofence(s: SimState, id: string) {
  const v = s.logistics.vehicles[id];
  if (!v) return undefined;
  const leg = [...v.legs].reverse().find((l) => l.start <= s.minute) ?? v.legs[0];
  return GEOFENCES.find((g) => g.id === leg?.zone);
}

/** Camera covering the twin selection: the asset itself, or the geofence a selected vehicle is in. */
export function selectionCamera(s: SimState, sel: { equipmentId?: string | null; vehicleId?: string | null }): CameraDef | null {
  if (sel.vehicleId) return cameraFor(vehicleGeofence(s, sel.vehicleId)?.id);
  return cameraFor(sel.equipmentId);
}

/** Production stage of an asset (Production workspace); a conveyor counts for the stage it delivers to. */
export function monitoredStageOf(id: string): MonitoredStageId | null {
  const cv = CONVEYOR_BY_ID[id];
  if (cv) return (MONITORED_STAGES.find((m) => m.conveyors.includes(id) && m.id === cv.to) ?? MONITORED_STAGES.find((m) => m.conveyors.includes(id)))?.id ?? null;
  if (INSPECTION_STATIONS.some((st) => st.equipmentId === id)) return 'SORT';
  return MONITORED_STAGES.find((m) => m.equipment.includes(id))?.id ?? null;
}

// ── Operational events (live list, inspector) ────────────────────────────────

export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };
const FLOW_TYPES = new Set<OpEvent['type']>(['starvation', 'blockage']);

/**
 * Active conditions first (most severe, then newest), then events still open after their
 * condition cleared, then resolved ones — both newest first.
 */
export function sortEvents(list: OpEvent[]): OpEvent[] {
  const group = (e: OpEvent) => (e.end == null ? 0 : e.status !== 'resolved' ? 1 : 2);
  return [...list].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 0) return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.start - a.start;
    return (b.end ?? b.lastUpdate) - (a.end ?? a.lastUpdate) || b.start - a.start;
  });
}

/** Events for the live list: every active condition and every open event, plus those cleared in the last `windowMin`. */
export function liveEvents(s: SimState, windowMin = 240, limit = 60): OpEvent[] {
  const from = s.minute - windowMin;
  return sortEvents(s.events.filter((e) => e.end == null || e.status !== 'resolved' || e.end >= from)).slice(0, limit);
}

/**
 * Events concerning one asset: its own (eventsFor equipmentId), the stage-level starvation /
 * blockage event of the stage it belongs to (raised once per stage), and logistics events in
 * the geofences / docks that belong to it. Open events always; others from the last `windowMin`.
 */
export function assetEvents(s: SimState, id: string, windowMin = 1440): OpEvent[] {
  const from = s.minute - windowMin;
  const fences = new Set(GEOFENCES.filter((g) => g.equipmentId === id).map((g) => g.id));
  const inStage = (stage: string | undefined) => !!stage && !!STAGE_BY_ID[stage as StageId]?.machines.includes(id);
  return sortEvents(
    s.events.filter(
      (e) =>
        (e.end == null || e.status !== 'resolved' || e.end >= from) &&
        (e.asset.equipmentId === id ||
          (FLOW_TYPES.has(e.type) && inStage(e.asset.stage)) ||
          (!!e.asset.geofenceId && fences.has(e.asset.geofenceId)) ||
          (id === 'K-DOCK' && !!e.asset.dockId)),
    ),
  );
}

/** Events concerning one vehicle (open, or from the last `windowMin`). */
export function vehicleEvents(s: SimState, id: string, windowMin = 1440): OpEvent[] {
  const from = s.minute - windowMin;
  return sortEvents(s.events.filter((e) => e.asset.vehicleId === id && (e.end == null || e.status !== 'resolved' || e.end >= from)));
}

/** Short subject of an event (vehicle, asset, station or zone id). */
export const eventSubject = (e: OpEvent) => e.asset.vehicleId ?? e.asset.equipmentId ?? e.asset.stationId ?? e.asset.dockId ?? e.asset.geofenceId ?? (e.asset.zone ? `Zone ${e.asset.zone}` : '—');

/** "since 10:42 · ongoing 12 min" / "10:42–10:58" for an event's condition. */
export function eventWhen(e: OpEvent, now: number) {
  return e.end == null ? `since ${formatClock(e.start)} · ongoing ${formatDuration(now - e.start)}` : `${formatClock(e.start)}–${formatClock(e.end)}`;
}

// ── Shift timeline ───────────────────────────────────────────────────────────

export type MarkerTone = 'critical' | 'serious' | 'warning' | 'neutral' | 'accent';
export type TimelineLane = 'production' | 'quality' | 'logistics' | 'data' | 'scenario';

/** Event lanes of the time strip (equipment-condition events share the production lane; any other category falls back to it). */
export const TIMELINE_LANES: { id: Exclude<TimelineLane, 'scenario'>; label: string; categories: EventCategory[] }[] = [
  { id: 'production', label: 'Production & equipment', categories: ['production', 'equipment'] },
  { id: 'quality', label: 'Quality', categories: ['quality'] },
  { id: 'logistics', label: 'Vehicles & logistics', categories: ['logistics'] },
  { id: 'data', label: 'Data quality', categories: ['data'] },
];
const LANE_OF = Object.fromEntries(TIMELINE_LANES.flatMap((l) => l.categories.map((c) => [c, l.id]))) as Partial<Record<EventCategory, TimelineLane>>;

export type TimelineMarker = {
  id: string;
  lane: TimelineLane;
  /** Marker position (condition start, clipped to the shift). */
  t: number;
  /** End of the span, clipped to now. */
  end: number;
  /** True while the condition / scenario is still running. */
  open: boolean;
  tone: MarkerTone;
  title: string;
  detail: string;
  /** Operational event the marker opens (all lanes except scenario inputs). */
  eventId?: string;
  status?: EventStatus;
  severity?: AlertSeverity;
  equipmentId?: string;
  vehicleId?: string;
  source: RecordSource;
};

export const SEVERITY_TONE: Record<AlertSeverity, MarkerTone> = { critical: 'critical', serious: 'serious', warning: 'warning', info: 'neutral' };
const SEVERITY_WORD: Record<AlertSeverity, string> = { critical: 'Critical', serious: 'Serious', warning: 'Warning', info: 'Info' };

/** Equipment that best locates a scenario in the 3D model. */
export const scenarioTarget = (sc: SimState['scenarios'][number]) =>
  sc.equipmentId ??
  (sc.stage
    ? STAGE_BY_ID[sc.stage].machines[0]
    : sc.kind === 'truck-arrival'
      ? 'A-GATE'
      : sc.kind === 'yard-congestion'
        ? 'A-HOLD'
        : sc.kind === 'prolonged-dock-stay'
          ? 'K-DOCK'
          : undefined);

/** Operational events and scenario inputs of the current shift (06/14/22 boundaries), up to now. */
export function shiftTimeline(s: SimState, maxEvents = 160) {
  const now = s.minute;
  const sh = shiftAt(now);
  const from = sh.start;
  const to = sh.end;
  const markers: TimelineMarker[] = [];
  const evs = s.events.filter((e) => e.start <= now && e.start < to && (e.end ?? now) >= from);
  for (const e of evs.slice(-maxEvents)) {
    const end = Math.min(e.end ?? now, now);
    markers.push({
      id: e.id,
      lane: LANE_OF[e.category] ?? 'production',
      t: Math.max(from, e.start),
      end: Math.max(Math.max(from, e.start), end),
      open: e.end == null,
      tone: SEVERITY_TONE[e.severity],
      title: e.title,
      detail: `${EVENT_TYPE_LABEL[e.type]} · ${SEVERITY_WORD[e.severity]} · ${EVENT_STATUS_LABEL[e.status]} · ${e.end == null ? `since ${formatClock(e.start)}, ongoing` : `${formatClock(e.start)}–${formatClock(e.end)}`}`,
      eventId: e.id,
      status: e.status,
      severity: e.severity,
      equipmentId: e.asset.equipmentId,
      vehicleId: e.asset.vehicleId,
      source: e.source,
    });
  }
  for (const sc of s.scenarios) {
    const end = sc.end ?? now;
    if (sc.start >= to || end < from || sc.start > now) continue;
    markers.push({
      id: sc.id,
      lane: 'scenario',
      t: Math.max(from, sc.start),
      end: Math.min(end, now),
      open: sc.end == null || sc.end > now,
      tone: 'accent',
      title: `Scenario · ${sc.label}`,
      detail: `${SCENARIO_KIND_LABELS[sc.kind]} · started ${formatClock(sc.start)}${sc.end != null && sc.end <= now ? `, ended ${formatClock(sc.end)}` : ''}`,
      equipmentId: scenarioTarget(sc),
      vehicleId: sc.vehicleId,
      source: 'scenario',
    });
  }
  return { shift: sh, from, to, now, markers };
}

// ── Production batches ───────────────────────────────────────────────────────

/** Approximate transit from pressing (≈ 2.5 h to glazing, ≈ 3 h to sorting — the same offsets the engine uses). */
const BATCH_PHASES: { upTo: number; label: string; equipmentId: string }[] = [
  { upTo: 150, label: 'pressing, drying & buffer', equipmentId: 'E-PRS1' },
  { upTo: 165, label: 'glazing & decoration', equipmentId: 'G-LINE' },
  { upTo: 180, label: 'kiln', equipmentId: 'H-KILN' },
  { upTo: 200, label: 'sorting & packing', equipmentId: 'I-SORT' },
];

/** Where a batch's most recent tiles are now (approximate), and what to locate. */
export function batchLocation(s: SimState, b: ProductionBatch): { label: string; equipmentId: string; active: boolean } {
  if (b.end == null) return { label: `In production · pressing since ${formatClock(b.start)}`, equipmentId: 'E-PRS1', active: true };
  const age = s.minute - b.end;
  const ph = BATCH_PHASES.find((p) => age < p.upTo);
  if (ph) return { label: `Last tiles at ${ph.label} (approx.)`, equipmentId: ph.equipmentId, active: true };
  return { label: `Completed ${formatClock(b.end)} · finished-goods warehouse`, equipmentId: 'K-RACK', active: false };
}

// ── Global search ────────────────────────────────────────────────────────────

export type SearchKind = 'equipment' | 'zone' | 'vehicle' | 'batch';
export type SearchTarget = { kind: 'equipment' | 'zone' | 'vehicle'; id: string };
export type SearchResult = { key: string; kind: SearchKind; title: string; subtitle: string; target: SearchTarget; zone?: string; score: number };

const KIND_ORDER: Record<SearchKind, number> = { equipment: 0, zone: 1, vehicle: 2, batch: 3 };
const norm = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** 0 exact · 1 prefix · 2 word prefix · 3 substring · -1 no match (best over the fields). */
function tokenScore(token: string, fields: string[]) {
  let best = -1;
  for (const raw of fields) {
    const f = norm(raw);
    let sc = -1;
    if (f === token) sc = 0;
    else if (f.startsWith(token)) sc = 1;
    else if (f.split(/[^a-z0-9]+/).some((w) => w.startsWith(token))) sc = 2;
    // Single characters only match the start of a word (no "a" anywhere in a name).
    else if (token.length > 1 && f.includes(token)) sc = 3;
    if (sc >= 0 && (best < 0 || sc < best)) best = sc;
  }
  return best;
}

/** Every token must match one of the fields; lower is better, null = no match. */
function score(tokens: string[], fields: string[]) {
  let total = 0;
  for (const t of tokens) {
    const sc = tokenScore(t, fields);
    if (sc < 0) return null;
    total += sc;
  }
  return total;
}

/** Search equipment (id/name), zones, vehicles on site and production batches. */
export function searchTwin(s: SimState, query: string, limit = 10): SearchResult[] {
  const tokens = norm(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const now = s.minute;
  const out: SearchResult[] = [];
  for (const e of EQUIPMENT) {
    const sc = score(tokens, [e.id, e.name, e.stage]);
    if (sc != null)
      out.push({ key: `e:${e.id}`, kind: 'equipment', title: e.name, subtitle: `${e.id} · ${ZONE_BY_ID[e.zone].short}`, target: { kind: 'equipment', id: e.id }, zone: e.zone, score: sc });
  }
  for (const z of ZONES) {
    // "h" or "zone h" find zone H; the letter alone only matches exactly.
    const letter = tokens.length === 1 && tokens[0] === z.id.toLowerCase() ? 0 : null;
    const sc = letter ?? score(tokens.filter((t) => t !== 'zone'), [z.name, z.short, z.stage, `zone ${z.id}`]);
    const zoneOnly = tokens.every((t) => t === 'zone');
    if (sc != null && !zoneOnly)
      out.push({ key: `z:${z.id}`, kind: 'zone', title: `Zone ${z.id} · ${z.name}`, subtitle: z.stage, target: { kind: 'zone', id: z.id }, zone: z.id, score: sc });
  }
  for (const id of s.logistics.active) {
    const v = s.logistics.vehicles[id];
    if (v.spawned > now) continue;
    const kind = v.class === 'external' ? (v.visit?.direction === 'inbound' ? 'inbound truck tipper' : 'outbound truck') : v.type.replace('-', ' ');
    const sc = score(tokens, [v.id, v.label, v.operator, kind, v.class === 'external' ? 'truck vehicle' : 'vehicle']);
    if (sc != null)
      out.push({
        key: `v:${id}`,
        kind: 'vehicle',
        title: v.label,
        subtitle: `${kind} · ${vehicleActivity(v, now).label}`,
        target: { kind: 'vehicle', id },
        score: sc,
      });
  }
  for (const b of s.batches) {
    const product = PRODUCTS.find((p) => p.sku === b.sku);
    const sc = score(tokens, [b.id, b.sku, product?.name ?? '', 'batch']);
    if (sc != null) {
      const loc = batchLocation(s, b);
      out.push({
        key: `b:${b.id}`,
        kind: 'batch',
        title: `Batch ${b.id}`,
        subtitle: `${product?.name ?? b.sku} · ${loc.label}`,
        target: { kind: 'equipment', id: loc.equipmentId },
        score: sc + (loc.active ? 0 : 0.5),
      });
    }
  }
  return out.sort((a, b) => a.score - b.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title)).slice(0, limit);
}

// ── Quick views ──────────────────────────────────────────────────────────────

export const LEVEL_RANK: Record<HealthLevel, number> = { offline: 0, normal: 1, watch: 2, warning: 3, alarm: 4 };

/** The assessed asset in the worst condition: highest level first, then lowest score (running assets before offline ones). */
export function worstHealth(list: HealthAssessment[]): HealthAssessment | null {
  if (!list.length) return null;
  return [...list].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.score - b.score)[0];
}
