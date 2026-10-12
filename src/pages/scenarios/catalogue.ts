/**
 * Scenario catalogue of the Scenarios panel (header → Scenarios):
 * what each scenario does, its parameters, how its activation is built, where its effect
 * shows, and pure helpers for status, parameter summaries, outcomes, linked events and the
 * impact window. No React here (unit-tested in catalogue.test.ts).
 */
import type { WorkspaceId } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID, DOCKS, GEOFENCES, PROCESS_MACHINES, STAGES, STAGE_BY_ID } from '../../model/plant';
import type { MonitoredStageId, OpEvent, ScenarioActivation, ScenarioKind, StageId } from '../../model/types';
import { scenariosActive, type SimState } from '../../sim/engine';
import { HEALTH_ASSETS, HEALTH_BY_ID } from '../../sim/health';
import type { TruckRuntime } from '../../sim/logistics';
import { resolvePeriod, type Period } from '../../sim/metrics';
import { dayStart, formatClock, formatDateTime, formatDuration } from '../../sim/time';

export type ScenarioDef = Omit<ScenarioActivation, 'id' | 'start'>;
export type ParamValue = string | number;
export type ParamOption = { value: ParamValue; label: string };
export type Values = Record<string, ParamValue>;
export type ParamDef = {
  key: string;
  label: string;
  initial: ParamValue;
  options: ParamOption[] | ((s: SimState) => ParamOption[]);
  /** Rendered with the follow-up maintenance action instead of the main parameters. */
  section?: 'maintenance';
  /** Shown only when this returns true for the current values (e.g. a duration only for a stop). */
  visible?: (v: Values) => boolean;
};

/** Where a "Show me" button goes. */
export type ShowTarget =
  | { type: 'equipment'; id: string }
  | { type: 'vehicle'; id: string }
  /** A workspace's line-level view, optionally on a tab (e.g. Production → OEE & losses). */
  | { type: 'workspace'; id: WorkspaceId; tab?: string }
  /** A stage's detail view in Production. */
  | { type: 'stage'; id: MonitoredStageId }
  /** An event's report in Events & Reports. */
  | { type: 'event'; id: string }
  /** The copilot, asked about one event. */
  | { type: 'copilot'; question: string; eventId?: string };

export const targetKey = (t: ShowTarget) => (t.type === 'copilot' ? `copilot:${t.eventId ?? ''}` : `${t.type}:${t.id}`);

export type CatalogueGroup = 'production' | 'quality' | 'logistics';
export const GROUP_TITLE: Record<CatalogueGroup, string> = {
  production: 'Production, equipment & data',
  quality: 'Quality',
  logistics: 'Vehicles & logistics',
};

export type CatalogueEntry = {
  /** Stable key (parameter store, tests). */
  id: string;
  /** Presenter reference number shown on the card. */
  ref: number;
  kind: ScenarioKind;
  group: CatalogueGroup;
  /** What the scenario does. */
  summary: string;
  /** Where the effect becomes visible. */
  effect: string;
  params: ParamDef[];
  /** Injected once (logistics); logged as "applied", nothing to clear. */
  oneOff: boolean;
  build: (v: Values, now: number) => ScenarioDef;
  /** Where in the 3D twin the effect is centred, from an active instance or else the chosen parameters. */
  focus: (v: Values, sc: ScenarioActivation | null, s: SimState) => ShowTarget | null;
  workspaces: WorkspaceId[];
  /** Reason the scenario cannot have an effect right now (Activate is disabled), or null. */
  unavailable?: (v: Values, s: SimState) => string | null;
};

// ── Labels ────────────────────────────────────────────────────────────────────

export const machineLabel = (id: string) => `${id} · ${EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id}`;
export const stageLabel = (id: StageId) => STAGE_BY_ID[id]?.name ?? id;
const pct = (f: number) => `${Math.round(f * 100)} %`;
const plusPct = (f: number) => `+${Math.round((f - 1) * 100)} %`;
export const dockName = (id: string) => DOCKS.find((d) => d.id === id)?.name ?? id;

const machineOptions: ParamOption[] = PROCESS_MACHINES.map((id) => ({ value: id, label: machineLabel(id) }));
const stageOptions: ParamOption[] = STAGES.map((s) => ({ value: s.id, label: s.name }));

export const PROGRESSION: Record<string, { label: string; factor: number | undefined }> = {
  typical: { label: 'Typical progression', factor: undefined },
  fast: { label: 'Fast progression', factor: 0.012 },
  slow: { label: 'Slow progression', factor: 0.004 },
};
const progressionOf = (factor: number | undefined) =>
  Object.values(PROGRESSION).find((p) => p.factor === factor)?.label ?? (factor == null ? PROGRESSION.typical.label : 'Custom progression');

export const DURATIONS: ParamOption[] = [
  { value: 0, label: 'Until cleared' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 h' },
  { value: 120, label: '2 h' },
];

/** Docked trucks a prolonged stay can hold (the engine only affects a dock with a truck on it or reserved). */
export function dockOptions(s: SimState): ParamOption[] {
  const docks = s.logistics.docks;
  const docked = DOCKS.filter((d) => docks[d.id]?.vehicleId);
  const reserved = DOCKS.filter((d) => !docks[d.id]?.vehicleId && docks[d.id]?.reservedBy);
  return [
    { value: 'auto', label: docked.length ? 'First docked truck' : 'First docked truck (none docked)' },
    ...docked.map((d) => ({ value: d.id, label: `${d.name} · ${s.logistics.vehicles[docks[d.id].vehicleId!]?.label ?? 'truck'}` })),
    ...reserved.map((d) => ({ value: d.id, label: `${d.name} · reserved` })),
  ];
}

export const str = (v: ParamValue) => String(v);
export const num = (v: ParamValue) => Number(v);

/** Trucks injected or affected by a scenario. */
export const scenarioTrucks = (s: SimState, scenarioId: string) =>
  Object.values(s.logistics.vehicles).filter((v): v is TruckRuntime => v.class === 'external' && v.visit?.scenarioId === scenarioId);

/**
 * Trucks a scenario injected or holds. A later dock hold re-tags the truck it holds with its own
 * scenario id, so an arrival also finds its truck through such a hold.
 */
export function injectedTrucks(s: SimState, sc: ScenarioActivation): TruckRuntime[] {
  const direct = scenarioTrucks(s, sc.id);
  if (sc.kind !== 'truck-arrival' || direct.length) return direct;
  const holds = new Set(s.scenarios.filter((x) => x.kind === 'prolonged-dock-stay' && x.start >= sc.start).map((x) => x.id));
  return Object.values(s.logistics.vehicles).filter(
    (v): v is TruckRuntime => v.class === 'external' && v.visit?.arrival === sc.start && !!v.visit.scenarioId && holds.has(v.visit.scenarioId),
  );
}

/** A scenario truck currently visible on site (to follow in the twin). */
function truckOnSite(s: SimState, sc: ScenarioActivation | null) {
  if (!sc) return null;
  return injectedTrucks(s, sc).find((v) => s.logistics.active.includes(v.id) && v.spawned <= s.minute) ?? null;
}

/** Forklift a restricted-zone entry scenario forces across the walkway. */
export const RESTRICTED_FORKLIFT = 'FL-05';

// ── Catalogue ─────────────────────────────────────────────────────────────────

export const CATALOGUE: CatalogueEntry[] = [
  {
    id: 'bottleneck',
    ref: 1,
    kind: 'bottleneck',
    group: 'production',
    summary: 'Cuts the capacity of one stage. Downstream stages starve once the buffer between them drains, and the line constraint can shift away from the kiln.',
    effect: 'Production: the stage constraining output and the stage view; output vs baseline; amber reduced-rate machines in the twin; below-rate and starvation events.',
    params: [
      { key: 'stage', label: 'Stage', initial: 'GLAZE', options: stageOptions },
      { key: 'factor', label: 'Capacity', initial: 0.45, options: [0.7, 0.55, 0.45, 0.3].map((f) => ({ value: f, label: pct(f) })) },
    ],
    oneOff: false,
    build: (v) => ({ kind: 'bottleneck', stage: str(v.stage) as StageId, factor: num(v.factor), end: null, label: `${stageLabel(str(v.stage) as StageId)} at ${pct(num(v.factor))} capacity` }),
    focus: (v, sc) => ({ type: 'equipment', id: STAGE_BY_ID[(sc?.stage ?? str(v.stage)) as StageId].machines[0] }),
    workspaces: ['production'],
  },
  {
    id: 'breakdown',
    ref: 2,
    kind: 'machine-stop',
    group: 'production',
    summary: 'Stops a machine with an unplanned downtime event. Availability and OEE fall; buffers absorb the loss for a while or pass it on to the line.',
    effect: 'Red machine in the twin, stop event and report, downtime Pareto in Production, an issue requiring attention on the Overview.',
    params: [
      { key: 'machine', label: 'Machine', initial: 'H-KILN', options: machineOptions },
      { key: 'duration', label: 'Duration', initial: 30, options: DURATIONS },
    ],
    oneOff: false,
    build: (v, now) => ({
      kind: 'machine-stop',
      equipmentId: str(v.machine),
      end: num(v.duration) > 0 ? now + num(v.duration) : null,
      label: `Breakdown ${machineLabel(str(v.machine))}${num(v.duration) > 0 ? ` · ${formatDuration(num(v.duration))}` : ''}`,
    }),
    focus: (v, sc) => ({ type: 'equipment', id: sc?.equipmentId ?? str(v.machine) }),
    workspaces: ['production', 'overview'],
  },
  {
    id: 'rate',
    ref: 3,
    kind: 'reduced-rate',
    group: 'production',
    summary: 'Runs one machine below its ideal rate. It stays available, so the loss shows as performance, not downtime.',
    effect: 'Amber reduced-rate state in the twin, below-rate event, performance and output in Production.',
    params: [
      { key: 'machine', label: 'Machine', initial: 'H-KILN', options: machineOptions },
      { key: 'factor', label: 'Rate', initial: 0.6, options: [0.8, 0.6, 0.4].map((f) => ({ value: f, label: `${pct(f)} of ideal` })) },
    ],
    oneOff: false,
    build: (v) => ({ kind: 'reduced-rate', equipmentId: str(v.machine), factor: num(v.factor), end: null, label: `${machineLabel(str(v.machine))} at ${pct(num(v.factor))} rate` }),
    focus: (v, sc) => ({ type: 'equipment', id: sc?.equipmentId ?? str(v.machine) }),
    workspaces: ['production'],
  },
  {
    id: 'fault',
    ref: 4,
    kind: 'degradation',
    group: 'production',
    summary:
      'Starts a developing component fault. Simulated vibration and bearing temperature drift upward; rule-based detection flags it before it fails. Untreated, a typical fault ends in an unplanned breakdown about 1½–2 h later.',
    effect: 'Condition level and signal trends in the Factory Twin equipment panel, a condition event and its recommendation; then either a breakdown or a short planned stop.',
    params: [
      {
        key: 'asset',
        label: 'Asset',
        initial: 'E-PRS2',
        options: HEALTH_ASSETS.map((a) => ({ value: a.id, label: `${machineLabel(a.id)} — ${a.component.split(' · ')[0]}` })),
      },
      { key: 'progression', label: 'Progression', initial: 'typical', options: Object.entries(PROGRESSION).map(([value, p]) => ({ value, label: p.label })) },
      { key: 'cbm', label: 'Planned stop', initial: 45, options: [30, 45, 60].map((m) => ({ value: m, label: `${m} min` })), section: 'maintenance' },
    ],
    oneOff: false,
    build: (v) => {
      const id = str(v.asset);
      const factor = PROGRESSION[str(v.progression)]?.factor;
      return {
        kind: 'degradation',
        equipmentId: id,
        ...(factor != null ? { factor } : {}),
        end: null,
        label: `Developing fault ${id} · ${HEALTH_BY_ID[id]?.component ?? 'component'}`,
      };
    },
    focus: (v, sc) => ({ type: 'equipment', id: sc?.equipmentId ?? str(v.asset) }),
    workspaces: ['twin', 'overview'],
    unavailable: (v, s) => {
      const id = str(v.asset);
      if (s.scenarios.some((sc) => sc.kind === 'degradation' && sc.equipmentId === id && scenarioStatus(s, sc).key === 'active'))
        return `A fault is already developing on ${id}.`;
      return null;
    },
  },
  {
    id: 'feed',
    ref: 5,
    kind: 'signal-loss',
    group: 'production',
    summary:
      'Cuts the simulated PLC / gateway link of one machine. Its counter, state and rate freeze at the last value; the machine keeps producing, but its status becomes unknown until data resumes.',
    effect: 'Unknown — data stale status in the twin, Production and the Overview; counter-inactivity (data quality) event; line output still counted at sorting.',
    params: [
      { key: 'machine', label: 'Machine', initial: 'E-PRS1', options: machineOptions },
      { key: 'duration', label: 'Duration', initial: 30, options: DURATIONS },
    ],
    oneOff: false,
    build: (v, now) => ({
      kind: 'signal-loss',
      equipmentId: str(v.machine),
      end: num(v.duration) > 0 ? now + num(v.duration) : null,
      label: `Data feed loss ${machineLabel(str(v.machine))}${num(v.duration) > 0 ? ` · ${formatDuration(num(v.duration))}` : ''}`,
    }),
    focus: (v, sc) => ({ type: 'equipment', id: sc?.equipmentId ?? str(v.machine) }),
    workspaces: ['production', 'overview'],
  },
  {
    id: 'quality',
    ref: 6,
    kind: 'quality-deterioration',
    group: 'quality',
    summary: 'Raises the reject rate for defects that originate at the chosen stage. Rejects are detected at inspection; quality rate and OEE fall.',
    effect: 'Quality & Defects: defect Pareto and trend, inspection records (simulated classification), quality events; the OEE quality factor in Production.',
    params: [
      { key: 'stage', label: 'Defect origin', initial: 'GLAZE', options: (['PRESS', 'GLAZE', 'DECOR', 'KILN'] as StageId[]).map((id) => ({ value: id, label: stageLabel(id) })) },
      { key: 'factor', label: 'Severity', initial: 4, options: [2, 4, 6].map((f) => ({ value: f, label: `×${f} reject rate` })) },
    ],
    oneOff: false,
    build: (v) => ({
      kind: 'quality-deterioration',
      stage: str(v.stage) as StageId,
      factor: num(v.factor),
      end: null,
      label: `${stageLabel(str(v.stage) as StageId)} defects ×${num(v.factor)}`,
    }),
    focus: (v, sc) => ({ type: 'equipment', id: STAGE_BY_ID[(sc?.stage ?? str(v.stage)) as StageId].machines[0] }),
    workspaces: ['quality', 'production'],
  },
  {
    id: 'truck',
    ref: 8,
    kind: 'truck-arrival',
    group: 'logistics',
    summary: 'An additional outbound truck arrives at the gate now, waits for a dock, loads and departs.',
    effect: 'Fleet & Movement: vehicle list, gate events and dock board; the truck drives through the twin.',
    params: [],
    oneOff: true,
    build: () => ({ kind: 'truck-arrival', end: null, label: 'Additional truck arrival' }),
    focus: (_v, sc, s) => {
      const t = truckOnSite(s, sc);
      return t ? { type: 'vehicle', id: t.id } : { type: 'equipment', id: 'A-GATE' };
    },
    workspaces: ['fleet'],
  },
  {
    id: 'congestion',
    ref: 9,
    kind: 'yard-congestion',
    group: 'logistics',
    summary: 'A burst of outbound trucks arrives two minutes apart. The holding area fills, waiting time and turnaround rise.',
    effect: 'Fleet & Movement: waiting time, holding area and turnaround; yard-congestion and truck-waiting events; queued trucks in the twin.',
    params: [{ key: 'count', label: 'Trucks', initial: 10, options: [6, 10, 14].map((n) => ({ value: n, label: `${n} trucks` })) }],
    oneOff: true,
    build: (v) => ({ kind: 'yard-congestion', count: num(v.count), end: null, label: `Yard congestion · ${num(v.count)} trucks` }),
    focus: () => ({ type: 'equipment', id: 'A-HOLD' }),
    workspaces: ['fleet'],
  },
  {
    id: 'dock',
    ref: 10,
    kind: 'prolonged-dock-stay',
    group: 'logistics',
    summary: 'Holds a docked truck after loading (documentation hold). Dock time, turnaround and dock utilisation rise; queued trucks wait longer.',
    effect: 'Fleet & Movement: dock board ("Held"), dock time and utilisation; dock-overstay event once the stay passes the threshold.',
    params: [
      { key: 'dock', label: 'Dock', initial: 'auto', options: dockOptions },
      { key: 'count', label: 'Hold', initial: 75, options: [45, 75, 120].map((n) => ({ value: n, label: `+${n} min` })) },
    ],
    oneOff: true,
    build: (v) => {
      const dock = str(v.dock);
      return {
        kind: 'prolonged-dock-stay',
        ...(dock === 'auto' ? {} : { dockId: dock }),
        count: num(v.count),
        end: null,
        label: `Dock hold +${num(v.count)} min${dock === 'auto' ? '' : ` · ${dockName(dock)}`}`,
      };
    },
    focus: (_v, sc, s) => {
      const t = truckOnSite(s, sc);
      return t ? { type: 'vehicle', id: t.id } : { type: 'equipment', id: 'K-DOCK' };
    },
    workspaces: ['fleet'],
    unavailable: (v, s) => {
      const dock = str(v.dock);
      const d = s.logistics.docks;
      const ok = dock === 'auto' ? Object.values(d).some((x) => x.vehicleId) : !!(d[dock]?.vehicleId ?? d[dock]?.reservedBy);
      return ok ? null : 'No truck is at a dock right now, so a hold would have no effect. Try again when one docks.';
    },
  },
  {
    id: 'zone',
    ref: 11,
    kind: 'restricted-entry',
    group: 'logistics',
    summary: `Forklift ${RESTRICTED_FORKLIFT} takes its next empty-pallet run across the hall pedestrian walkway, a no-entry zone. The geofence rule fires on its simulated position (zone level).`,
    effect: 'Fleet & Movement safety events, the forklift route in the twin and the restricted-zone entry event report.',
    params: [],
    oneOff: true,
    build: () => ({ kind: 'restricted-entry', vehicleId: RESTRICTED_FORKLIFT, end: null, label: `Restricted-zone entry · ${RESTRICTED_FORKLIFT}` }),
    focus: (_v, sc, s) => {
      const id = sc?.vehicleId ?? RESTRICTED_FORKLIFT;
      return s.logistics.active.includes(id) ? { type: 'vehicle', id } : { type: 'equipment', id: 'J-PAL' };
    },
    workspaces: ['fleet'],
    unavailable: (_v, s) => (s.logistics.vehicles[RESTRICTED_FORKLIFT] ? null : `Forklift ${RESTRICTED_FORKLIFT} is not in the simulation.`),
  },
];

export const ENTRY_BY_ID = Object.fromEntries(CATALOGUE.map((e) => [e.id, e])) as Record<string, CatalogueEntry>;
export const ENTRY_BY_KIND = Object.fromEntries(CATALOGUE.map((e) => [e.kind, e])) as Partial<Record<ScenarioKind, CatalogueEntry>>;

export const ONE_OFF_KINDS: ScenarioKind[] = CATALOGUE.filter((e) => e.oneOff).map((e) => e.kind);

export const initialValues = (): Record<string, Values> =>
  Object.fromEntries(CATALOGUE.map((e) => [e.id, Object.fromEntries(e.params.map((p) => [p.key, p.initial]))]));

export const paramOptions = (p: ParamDef, s: SimState) => (typeof p.options === 'function' ? p.options(s) : p.options);

/** Values with any option that no longer exists (e.g. a dock that emptied) replaced by the parameter's first option. */
export function resolveValues(e: { params: ParamDef[] }, v: Values | undefined, s: SimState): Values {
  const out: Values = {};
  for (const p of e.params) {
    const opts = paramOptions(p, s);
    const cur = v?.[p.key] ?? p.initial;
    out[p.key] = opts.some((o) => String(o.value) === String(cur)) ? cur : (opts[0]?.value ?? p.initial);
  }
  return out;
}

/** Condition-based maintenance activation (removes a developing fault when the planned stop ends). */
export const maintenanceDef = (equipmentId: string, minutes: number): ScenarioDef => ({
  kind: 'maintenance',
  equipmentId,
  count: minutes,
  end: null,
  label: `Condition-based maintenance ${equipmentId} · ${minutes} min`,
});

/** Same kind and same target: activating again replaces the running instance instead of stacking it. */
export function sameTarget(sc: ScenarioActivation, def: ScenarioDef) {
  if (sc.kind !== def.kind || ONE_OFF_KINDS.includes(sc.kind)) return false;
  return (sc.equipmentId ?? null) === (def.equipmentId ?? null) && (sc.stage ?? null) === (def.stage ?? null);
}

/** Generic "Show me" focus of a logged scenario: its catalogue entry, else its equipment. */
export function scenarioFocus(s: SimState, sc: ScenarioActivation): ShowTarget | null {
  const entry = ENTRY_BY_KIND[sc.kind];
  if (entry) return entry.focus(resolveValues(entry, undefined, s), sc, s);
  if (sc.equipmentId) return { type: 'equipment', id: sc.equipmentId };
  if (sc.stage) return { type: 'equipment', id: STAGE_BY_ID[sc.stage].machines[0] };
  return null;
}

// ── Status, parameters, outcome ───────────────────────────────────────────────

export type StatusKey = 'active' | 'resolved' | 'applied' | 'ended' | 'completed';
export type ScenarioStatus = { key: StatusKey; label: string; at: number | null; note: string | null };

/** Unplanned breakdown that a developing-fault scenario ended in, if any. */
const tripOf = (s: SimState, sc: ScenarioActivation) => s.downtime.find((d) => d.scenarioId === sc.id && d.reasonCode !== 'PLN_MAINT') ?? null;

/** Condition-based maintenance on the same asset after the fault started (latest first). */
export const maintenanceFor = (s: SimState, sc: ScenarioActivation) =>
  s.scenarios.filter((m) => m.kind === 'maintenance' && m.equipmentId === sc.equipmentId && m.start >= sc.start && (sc.end == null || m.start < sc.end)).reverse();

/** Outcome labels of a developing fault that is over (scenarioStatus key 'resolved'). */
export const FAULT_REMOVED = 'Fault removed';
export const FAULT_BROKE_DOWN = 'Broke down';

export function scenarioStatus(s: SimState, sc: ScenarioActivation): ScenarioStatus {
  const now = s.minute;
  if (ONE_OFF_KINDS.includes(sc.kind)) {
    const none = sc.kind === 'prolonged-dock-stay' && !scenarioTrucks(s, sc.id).length;
    return { key: 'applied', label: 'Applied', at: sc.start, note: none ? 'No truck was at a dock — no effect' : null };
  }
  if (sc.kind === 'maintenance') {
    const end = sc.end ?? now;
    if (end > now) return { key: 'active', label: 'In progress', at: sc.start, note: `Planned stop until ${formatClock(end)}` };
    // Cleared before its planned duration: the stop ended early and the fault was not removed.
    if (end < sc.start + (sc.count ?? 45)) return { key: 'ended', label: 'Cancelled', at: end, note: 'Stopped early — the fault was not removed' };
    return { key: 'completed', label: 'Completed', at: end, note: null };
  }
  const ended = sc.end != null && sc.end <= now;
  if (sc.kind === 'degradation') {
    const trip = tripOf(s, sc);
    // The engine closes a developing-fault scenario when its fault trips the machine or is repaired.
    if (trip && (!ended || trip.start <= sc.end!)) return { key: 'resolved', label: FAULT_BROKE_DOWN, at: trip.start, note: `Unplanned breakdown at ${formatClock(trip.start)}` };
    const fix = maintenanceFor(s, sc).find((m) => m.end != null && m.end <= now && m.end >= m.start + (m.count ?? 45));
    if (fix && (!ended || fix.end! <= sc.end!)) return { key: 'resolved', label: FAULT_REMOVED, at: fix.end, note: `Removed by maintenance at ${formatClock(fix.end!)}` };
  }
  if (ended) return { key: 'ended', label: 'Ended', at: sc.end, note: null };
  return { key: 'active', label: 'Active', at: sc.start, note: sc.end != null ? `Until ${formatClock(sc.end)}` : null };
}

/** Whether a scenario can still be cleared (it is in effect; condition-based maintenance is left to complete). */
export const isClearable = (s: SimState, sc: ScenarioActivation) => sc.kind !== 'maintenance' && scenarioStatus(s, sc).key === 'active';

/** Developing faults that are over, by outcome (a breakdown is not a resolved fault). */
export function faultOutcomes(s: SimState) {
  let removed = 0;
  let brokeDown = 0;
  for (const sc of s.scenarios) {
    if (sc.kind !== 'degradation') continue;
    const st = scenarioStatus(s, sc);
    if (st.key !== 'resolved') continue;
    if (st.label === FAULT_REMOVED) removed++;
    else if (st.label === FAULT_BROKE_DOWN) brokeDown++;
  }
  return { removed, brokeDown };
}

/** Human summary of a logged scenario's parameters. */
export function paramSummary(sc: ScenarioActivation): string {
  const f = sc.factor;
  switch (sc.kind) {
    case 'machine-stop':
      return machineLabel(sc.equipmentId ?? '—');
    case 'reduced-rate':
      return `${machineLabel(sc.equipmentId ?? '—')} · ${pct(f ?? 0.6)} of ideal rate`;
    case 'bottleneck':
      return `${sc.stage ? stageLabel(sc.stage) : '—'} · ${pct(f ?? 0.55)} capacity`;
    case 'quality-deterioration':
      return `Origin ${sc.stage ? stageLabel(sc.stage) : '—'} · ×${f ?? '—'} reject rate`;
    case 'energy-anomaly':
      // Retired scenario kind (energy is no longer a product module); kept so older logs still read.
      return `${sc.equipmentId ?? '—'} · ${plusPct(f ?? 1.2)}`;
    case 'degradation':
      return `${machineLabel(sc.equipmentId ?? '—')} · ${progressionOf(f).toLowerCase()}`;
    case 'maintenance':
      return `${machineLabel(sc.equipmentId ?? '—')} · ${sc.count ?? 45} min planned stop`;
    case 'truck-arrival':
      return 'One outbound truck';
    case 'yard-congestion':
      return `${sc.count ?? 6} outbound trucks, 2 min apart`;
    case 'prolonged-dock-stay':
      return `${sc.dockId ? dockName(sc.dockId) : 'First docked truck'} · +${sc.count ?? 75} min hold`;
    case 'conveyor-stop':
      return machineLabel(sc.equipmentId ?? '—');
    case 'signal-loss':
      return `${machineLabel(sc.equipmentId ?? '—')} · data feed stale`;
    case 'restricted-entry':
      return `${sc.vehicleId ?? RESTRICTED_FORKLIFT} · forced walkway crossing`;
  }
}

const stoppedFor = (s: SimState, sc: ScenarioActivation) =>
  s.downtime.filter((d) => d.scenarioId === sc.id).reduce((a, d) => a + ((d.end != null ? Math.min(d.end, s.minute) : s.minute) - d.start), 0);

/** Short description of what a scenario has done so far (from records, never from hidden model state). */
export function outcomeOf(s: SimState, sc: ScenarioActivation): string | null {
  const now = s.minute;
  switch (sc.kind) {
    case 'machine-stop':
    case 'conveyor-stop':
      return `Stopped ${formatDuration(Math.max(0, stoppedFor(s, sc)))}`;
    case 'signal-loss': {
      const end = Math.min(sc.end ?? now, now);
      return `Data stale ${formatDuration(Math.max(0, end - sc.start))}`;
    }
    case 'degradation': {
      const st = scenarioStatus(s, sc);
      if (st.note) return st.note;
      const m = maintenanceFor(s, sc).find((x) => x.end == null || x.end > now);
      return m ? `Maintenance in progress until ${formatClock(m.end ?? now)}` : 'Developing — condition level in the Factory Twin';
    }
    case 'maintenance':
      return `Planned stop ${formatClock(sc.start)}–${formatClock(sc.end ?? now)}`;
    case 'truck-arrival':
    case 'yard-congestion': {
      const trucks = injectedTrucks(s, sc);
      const left = trucks.filter((v) => v.despawned != null && v.despawned <= now).length;
      return `${trucks.length} truck${trucks.length === 1 ? '' : 's'} · ${left} departed`;
    }
    case 'prolonged-dock-stay': {
      const t = scenarioTrucks(s, sc.id)[0];
      return t ? `${t.label} held +${sc.count ?? 75} min` : 'No truck was at a dock — no effect';
    }
    case 'restricted-entry': {
      const id = sc.vehicleId ?? RESTRICTED_FORKLIFT;
      const r = s.logistics.restrictedEvents.find((x) => x.vehicleId === id && x.source === 'scenario' && x.time >= sc.start);
      if (!r) return 'Waiting for the next empty-pallet run';
      const gf = GEOFENCES.find((g) => g.id === r.geofenceId);
      return `Entered ${gf?.name ?? r.geofenceId} at ${formatClock(r.time)}`;
    }
    default:
      return null;
  }
}

/**
 * Operational events created by a scenario (the same records as Events & Reports): events that
 * carry its id, plus restricted-zone entries of its forklift, which are keyed by the geofence record.
 */
export function scenarioEvents(s: SimState, sc: ScenarioActivation): OpEvent[] {
  if (sc.kind === 'restricted-entry') {
    const id = sc.vehicleId ?? RESTRICTED_FORKLIFT;
    return s.events.filter((e) => e.type === 'restricted-entry' && e.asset.vehicleId === id && e.source === 'scenario' && e.start >= sc.start);
  }
  return s.events.filter((e) => e.refs.scenarioId === sc.id);
}

/** Duration so far (active) or in total (ended). */
export function scenarioDuration(s: SimState, sc: ScenarioActivation) {
  if (ONE_OFF_KINDS.includes(sc.kind)) return null;
  return Math.max(0, Math.min(sc.end ?? s.minute, s.minute) - sc.start);
}

/** Plant time with the day when it is not today. */
export const when = (minute: number, now: number) => (dayStart(minute) === dayStart(now) ? formatClock(minute) : formatDateTime(minute));

// ── Impact window ─────────────────────────────────────────────────────────────

export type WindowMode = 'scenario' | 'shift' | 'today';

export type ImpactWindow = {
  period: Period;
  /** First currently-active scenario the window is anchored on. */
  anchor: ScenarioActivation | null;
  /** Mode 'scenario' with nothing active: the current shift is shown instead. */
  fallback: boolean;
};

/**
 * Window for the impact comparison. Hourly accounting means a window must start on the
 * hour, so "since the first active scenario" starts at the top of the hour it began in.
 */
export function impactWindow(s: SimState, mode: WindowMode): ImpactWindow {
  const now = s.minute;
  if (mode === 'scenario') {
    const active = scenariosActive(s).filter((sc) => !ONE_OFF_KINDS.includes(sc.kind));
    if (active.length) {
      const first = active.reduce((a, b) => (b.start < a.start ? b : a));
      const from = Math.floor(first.start / 60) * 60;
      return { period: { from, to: now, label: `Since ${when(from, now)}` }, anchor: first, fallback: false };
    }
    return { period: resolvePeriod('shift', now), anchor: null, fallback: true };
  }
  return { period: resolvePeriod(mode, now), anchor: null, fallback: false };
}

// ── Deltas ────────────────────────────────────────────────────────────────────

export type Direction = 'better' | 'worse' | 'same';

/** Whether a delta is an improvement, with a dead band so rounding noise reads as "same". */
export function judge(delta: number | null, eps: number, higherIsBetter: boolean): Direction | null {
  if (delta == null || !Number.isFinite(delta)) return null;
  if (Math.abs(delta) < eps) return 'same';
  return delta > 0 === higherIsBetter ? 'better' : 'worse';
}

/** Signed figure with a true minus sign; values that round to zero carry no sign. */
export function signed(v: number | null, fmt: (n: number) => string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const txt = fmt(Math.abs(v));
  if (!/[1-9]/.test(txt)) return txt;
  return `${v > 0 ? '+' : '−'}${txt}`;
}
