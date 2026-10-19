/**
 * Scenario catalogue of the Scenarios panel (header → Scenarios):
 * what each scenario does, its parameters, how its activation is built, where its effect
 * shows, and pure helpers for status, parameter summaries, outcomes, linked events and the
 * impact window. No React here (unit-tested in catalogue.test.ts).
 */
import type { WorkspaceId } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID, DEFECTS, DEFECT_ORDER, DOCKS, GEOFENCES, PROCESS_MACHINES, STAGES, STAGE_BY_ID } from '../../model/plant';
import { PROCESS_SIGNAL_BY_ID } from '../../model/catalog/process';
import type { DataQualityMode, MonitoredStageId, OpEvent, ScenarioActivation, ScenarioKind, StageId } from '../../model/types';
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

export const targetKey = (t: ShowTarget) =>
  t.type === 'copilot' ? `copilot:${t.eventId ?? ''}` : t.type === 'workspace' && t.tab ? `${t.type}:${t.id}:${t.tab}` : `${t.type}:${t.id}`;

export type CatalogueGroup = 'production' | 'quality' | 'logistics';
export const GROUP_TITLE: Record<CatalogueGroup, string> = {
  production: 'Production, equipment & data quality',
  quality: 'Quality & process deviations',
  logistics: 'Vehicles & logistics',
};

/** "Show me" targets of the views the new scenarios show in (tab ids as the workspaces define them). */
export const VIEW = {
  material: { type: 'workspace', id: 'production', tab: 'material' },
  compare: { type: 'workspace', id: 'quality', tab: 'compare' },
  reliability: { type: 'workspace', id: 'events', tab: 'reliability' },
  data: { type: 'workspace', id: 'events', tab: 'data' },
} as const satisfies Record<string, ShowTarget>;

export type CatalogueEntry = {
  /** Stable key (parameter store, tests). */
  id: string;
  /** Presenter reference number shown on the card. */
  ref: number;
  kind: ScenarioKind;
  group: CatalogueGroup;
  /** Card title when several entries share one scenario kind (default: the kind's label). */
  title?: string;
  /**
   * Which logged activations belong to this entry, when several entries share one kind (process deviations and
   * data-quality faults differ by signal / mode / asset). Default: every activation of the kind.
   */
  matches?: (sc: ScenarioActivation) => boolean;
  /** Rule ids (src/intel/rules) whose findings detect the effect. */
  detectedBy?: string[];
  /** Extra "Show me" targets, e.g. a workspace tab (Events › Data & connectivity). */
  views?: ShowTarget[];
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

// ── Process deviations and data-quality faults (simulated) ────────────────────

/** Minutes over which a catalogue process deviation ramps in. */
export const DEVIATION_RAMP_MIN = 10;

/** Process stage of a machine. */
export const stageOfMachine = (equipmentId: string): StageId | null => STAGES.find((st) => st.machines.includes(equipmentId))?.id ?? null;

/** Defect categories that originate at the machine's stage (what a deviation there can raise in the simulation). */
export const defectsOriginatingAt = (equipmentId: string) => {
  const stage = stageOfMachine(equipmentId);
  return DEFECT_ORDER.filter((d) => DEFECTS[d].origin === stage);
};

const MINUS = '−';
/** Signed engineering value with its unit, true minus sign ("+35 °C", "−25 bar", "+1.0 %"). */
export function signedValue(v: number, unit: string, digits = 0) {
  const txt = `${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`;
  return `${v < 0 ? MINUS : '+'}${txt}`;
}
const plain = (v: number, unit: string, digits = 0) => `${v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`;

/** Short name of a process value without the " · actual" suffix. */
const pvName = (signalId: string) => (PROCESS_SIGNAL_BY_ID[signalId]?.name ?? signalId).replace(/ · actual$/, '');

type DeviationSpec = {
  id: string;
  ref: number;
  signalId: string;
  title: string;
  offsets: number[];
  views: ShowTarget[];
  workspaces: WorkspaceId[];
};

/** A catalogue process deviation: the PV runs beyond its alarm band; the text states what the simulation couples to it. */
function deviationEntry(o: DeviationSpec): CatalogueEntry {
  const spec = PROCESS_SIGNAL_BY_ID[o.signalId];
  const eqId = spec?.equipmentId ?? o.signalId.split('.')[0];
  const unit = spec?.unit ?? '';
  const digits = spec?.digits ?? 0;
  const sp = spec?.nominal ?? 0;
  const alarm = spec?.alarmHigh != null ? spec.alarmHigh - sp : spec?.alarmLow != null ? sp - spec.alarmLow : null;
  const warn = spec?.warningHigh != null ? spec.warningHigh - sp : spec?.warningLow != null ? sp - spec.warningLow : null;
  const stage = stageOfMachine(eqId);
  const defects = defectsOriginatingAt(eqId);
  const coupled = defects.length > 0;
  const dir = o.offsets[0] >= 0 ? 'above' : 'below';
  const name = pvName(o.signalId);
  const band = alarm != null ? ` its ±${plain(alarm, unit, digits)} alarm band (setpoint ${plain(sp, unit, digits)}${warn != null ? `, warning ±${plain(warn, unit, digits)}` : ''})` : ' its alarm band';
  const coupling = coupled
    ? `Beyond the warning band the simulation raises the rejects of defects that originate at ${stage ? stageLabel(stage).toLowerCase() : eqId} (${defects.map((d) => DEFECTS[d].label.toLowerCase()).join(', ')}); tiles made during it can show a higher reject rate — an association to investigate, not a demonstrated cause.`
    : `No defect category originates at ${stage ? stageLabel(stage).toLowerCase() : eqId} in this simulation, so only the value moves: no reject effect is simulated.`;
  const detectedBy = ['PC-LIMIT', 'PC-SETPOINT', ...(coupled ? ['QL-PROCESS-ASSOCIATION'] : [])];
  return {
    id: o.id,
    ref: o.ref,
    kind: 'process-deviation',
    group: 'quality',
    title: o.title,
    matches: (sc) => sc.kind === 'process-deviation' && sc.signalId === o.signalId,
    summary: `Simulated scenario: ${o.signalId} (${name.toLowerCase()}) ramps ${dir} its setpoint over ${DEVIATION_RAMP_MIN} min to beyond${band}. ${coupling}`,
    effect: `Actual against setpoint and the process findings in the ${eqId} equipment panel (Factory Twin)${coupled ? '; the affected batch and its reject rate in Quality › Compare' : ''}.`,
    detectedBy,
    views: o.views,
    params: [
      { key: 'offset', label: 'Deviation', initial: o.offsets[0], options: o.offsets.map((v) => ({ value: v, label: `${signedValue(v, unit, digits)} from setpoint` })) },
      { key: 'duration', label: 'Duration', initial: 0, options: DURATIONS },
    ],
    oneOff: false,
    build: (v, now) => ({
      kind: 'process-deviation',
      signalId: o.signalId,
      offset: num(v.offset),
      rampMin: DEVIATION_RAMP_MIN,
      end: num(v.duration) > 0 ? now + num(v.duration) : null,
      label: `${o.title} · ${signedValue(num(v.offset), unit, digits)} (simulated)`,
    }),
    focus: () => ({ type: 'equipment', id: eqId }),
    workspaces: o.workspaces,
    unavailable: () => (spec ? null : `${o.signalId} is not in the process signal catalogue.`),
  };
}

export const DQ_MODE_LABEL: Record<DataQualityMode, string> = {
  'bad-quality': 'bad-quality flag',
  frozen: 'frozen value',
  'counter-reset': 'counter reset',
  spike: 'implausible spike',
  gap: 'missing samples',
  'command-no-feedback': 'command without running feedback',
};

type DataQualitySpec = {
  id: string;
  ref: number;
  mode: DataQualityMode;
  equipmentId: string;
  /** The signal affected; a 'signals' parameter with these options instead lets the presenter choose (value '' = every signal of the asset). */
  signalId?: string;
  signalOptions?: ParamOption[];
  title: string;
  summary: string;
  effect: string;
  detectedBy: string[];
  views: ShowTarget[];
  oneOff?: boolean;
};

/** A catalogue data-quality fault: only the telemetry changes (except a command without feedback, which holds the machine stopped). */
function dataQualityEntry(o: DataQualitySpec): CatalogueEntry {
  const params: ParamDef[] = [];
  if (o.signalOptions) params.push({ key: 'signal', label: 'Signals', initial: o.signalOptions[0].value, options: o.signalOptions });
  if (!o.oneOff) params.push({ key: 'duration', label: 'Duration', initial: 0, options: DURATIONS });
  const signalOf = (v: Values) => (o.signalOptions ? str(v.signal ?? o.signalOptions[0].value) || undefined : o.signalId);
  return {
    id: o.id,
    ref: o.ref,
    kind: 'data-quality',
    group: 'production',
    title: o.title,
    matches: (sc) => sc.kind === 'data-quality' && sc.mode === o.mode && sc.equipmentId === o.equipmentId,
    summary: `Simulated scenario: ${o.summary}`,
    effect: o.effect,
    detectedBy: o.detectedBy,
    views: o.views,
    params,
    oneOff: !!o.oneOff,
    build: (v, now) => {
      const sig = signalOf(v);
      return {
        kind: 'data-quality',
        mode: o.mode,
        equipmentId: o.equipmentId,
        ...(sig ? { signalId: sig } : {}),
        end: !o.oneOff && num(v.duration ?? 0) > 0 ? now + num(v.duration) : null,
        label: `${o.title}${sig ? ` · ${sig}` : ` · every ${o.equipmentId} ${o.mode === 'counter-reset' ? 'counter' : 'signal'}`} (simulated)`,
      };
    },
    focus: () => ({ type: 'equipment', id: o.equipmentId }),
    workspaces: [],
  };
}
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
  // ── Process deviations (simulated) ──
  deviationEntry({
    id: 'dev-kiln-z3',
    ref: 12,
    signalId: 'H-KILN.zone3_temp_pv',
    title: 'Kiln zone 3 temperature high',
    offsets: [35, 25],
    views: [VIEW.compare],
    workspaces: [],
  }),
  deviationEntry({
    id: 'dev-spray-moisture',
    ref: 13,
    signalId: 'D-TWR.powder_moisture_pv',
    title: 'Spray-dryer powder moisture high',
    offsets: [1, 1.5],
    views: [VIEW.material],
    workspaces: [],
  }),
  deviationEntry({
    id: 'dev-dryer-z2',
    ref: 14,
    signalId: 'F-DRY.zone2_temp_pv',
    title: 'Dryer zone 2 temperature low',
    offsets: [-20, -30],
    views: [],
    workspaces: [],
  }),
  deviationEntry({
    id: 'dev-press2-pressure',
    ref: 15,
    signalId: 'E-PRS2.press_pressure_pv',
    title: 'Press 2 pressing pressure low',
    offsets: [-25, -40],
    views: [VIEW.compare],
    workspaces: [],
  }),
  // ── Data-quality faults (simulated telemetry) ──
  dataQualityEntry({
    id: 'dq-frozen-prs2',
    ref: 16,
    mode: 'frozen',
    equipmentId: 'E-PRS2',
    signalId: 'E-PRS2.count_total',
    title: 'Frozen counter · E-PRS2',
    summary:
      'the production counter of press 2 (E-PRS2.count_total) stops updating — value and timestamp freeze while the press keeps pressing. Production is unchanged; only the telemetry is wrong.',
    effect: 'The counter reads as stale in the E-PRS2 equipment panel; counter and output rules are “not evaluated” instead of guessing; Events › Data & connectivity.',
    detectedBy: ['DQ-FROZEN', 'DQ-STALE'],
    views: [VIEW.data],
  }),
  dataQualityEntry({
    id: 'dq-bad-kiln',
    ref: 17,
    mode: 'bad-quality',
    equipmentId: 'H-KILN',
    signalId: 'H-KILN.zone1_temp_pv',
    title: 'Bad-quality kiln zone sensor',
    summary:
      'the kiln zone 1 thermocouple (H-KILN.zone1_temp_pv) reports quality “bad”. The reading keeps its value but is not trusted, so the setpoint and limit checks of that zone are not evaluated; the other zones still are.',
    effect: 'Bad-quality flag on the zone 1 reading in the H-KILN equipment panel; Events › Data & connectivity.',
    detectedBy: ['DQ-BAD-QUALITY', 'PC-MEASUREMENT'],
    views: [VIEW.data],
  }),
  dataQualityEntry({
    id: 'dq-reset-jbox',
    ref: 18,
    mode: 'counter-reset',
    equipmentId: 'J-BOX',
    signalOptions: [
      { value: 'J-BOX.carton_count', label: 'Carton counter' },
      { value: '', label: 'Every J-BOX counter' },
    ],
    title: 'Carton counter reset · J-BOX',
    summary:
      'the carton counter of the packaging machine (J-BOX.carton_count, or every J-BOX counter) restarts from 0 once — as after a PLC restart. The machine keeps packing; the step backwards is classified as a reset, not counted as negative output.',
    effect: 'Counter step in the J-BOX equipment panel; Events › Data & connectivity.',
    detectedBy: ['DQ-COUNTER-RESET'],
    views: [VIEW.data],
    oneOff: true,
  }),
  dataQualityEntry({
    id: 'dq-spike-dtwr',
    ref: 19,
    mode: 'spike',
    equipmentId: 'D-TWR',
    signalId: 'D-TWR.outlet_temp_pv',
    title: 'Implausible spike · spray-dryer outlet',
    summary:
      'the spray-dryer outlet air temperature (D-TWR.outlet_temp_pv) delivers one reading outside its engineering range every 10 min. It is a measurement problem, not a process deviation.',
    effect: 'Out-of-range samples in the D-TWR equipment panel trend; Events › Data & connectivity.',
    detectedBy: ['DQ-IMPLAUSIBLE', 'PC-MEASUREMENT'],
    views: [VIEW.data],
  }),
  dataQualityEntry({
    id: 'dq-gap-fdry',
    ref: 20,
    mode: 'gap',
    equipmentId: 'F-DRY',
    signalOptions: [
      { value: 'F-DRY.zone1_temp_pv', label: 'Zone 1 temperature only' },
      { value: '', label: 'Every F-DRY signal' },
    ],
    title: 'Missing samples · F-DRY',
    summary:
      'the dryer (F-DRY) delivers no samples for the chosen signals: holes in the history, nothing invented to fill them. With every signal missing the whole source counts as interrupted.',
    effect: 'Gaps (not zeros) in the F-DRY equipment panel trends; dependent rules “not evaluated”; Events › Data & connectivity.',
    detectedBy: ['DQ-GAP', 'DQ-SOURCE'],
    views: [VIEW.data],
  }),
  dataQualityEntry({
    id: 'dq-cmd-prs1',
    ref: 21,
    mode: 'command-no-feedback',
    equipmentId: 'E-PRS1',
    title: 'Command without running feedback · E-PRS1',
    summary:
      'press 1 (E-PRS1) gets its run command but never reports running: the command stays on while the machine is held stopped (stop reason: no feedback, electrical & control).',
    effect: 'Stopped press with run command on in the E-PRS1 equipment panel; the stop in Production; Events › Reliability.',
    detectedBy: ['RL-COMMAND-FEEDBACK'],
    views: [VIEW.reliability],
  }),
];

export const ENTRY_BY_ID = Object.fromEntries(CATALOGUE.map((e) => [e.id, e])) as Record<string, CatalogueEntry>;
/** The first catalogue entry of each kind (several process-deviation / data-quality entries share a kind: use entryFor). */
export const ENTRY_BY_KIND = Object.fromEntries([...CATALOGUE].reverse().map((e) => [e.kind, e])) as Partial<Record<ScenarioKind, CatalogueEntry>>;

/** Whether a logged activation belongs to a catalogue entry. */
export const entryMatches = (e: CatalogueEntry, sc: ScenarioActivation) => sc.kind === e.kind && (!e.matches || e.matches(sc));

/** The catalogue entry a logged activation belongs to (null: no entry, e.g. maintenance or a retired kind). */
export const entryFor = (sc: ScenarioActivation): CatalogueEntry | null => CATALOGUE.find((e) => entryMatches(e, sc)) ?? null;

/** Kinds whose every activation is injected once (logistics). A data-quality counter reset is one-off too: see isOneOff. */
export const ONE_OFF_KINDS: ScenarioKind[] = [...new Set(CATALOGUE.filter((e) => e.oneOff).map((e) => e.kind))].filter((k) =>
  CATALOGUE.filter((e) => e.kind === k).every((e) => e.oneOff),
);

/** Injected once; logged as "applied", nothing to clear. */
export const isOneOff = (sc: Pick<ScenarioActivation, 'kind' | 'mode'>) => ONE_OFF_KINDS.includes(sc.kind) || (sc.kind === 'data-quality' && sc.mode === 'counter-reset');

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
  if (sc.kind !== def.kind || isOneOff(sc) || isOneOff(def)) return false;
  return (
    (sc.equipmentId ?? null) === (def.equipmentId ?? null) &&
    (sc.stage ?? null) === (def.stage ?? null) &&
    // A process deviation is aimed at one signal; a data-quality fault at one asset with one mode.
    (sc.kind !== 'process-deviation' || sc.signalId === def.signalId) &&
    (sc.kind !== 'data-quality' || sc.mode === def.mode)
  );
}

/** Generic "Show me" focus of a logged scenario: its catalogue entry, else its equipment. */
export function scenarioFocus(s: SimState, sc: ScenarioActivation): ShowTarget | null {
  const entry = entryFor(sc);
  if (entry) return entry.focus(resolveValues(entry, undefined, s), sc, s);
  if (sc.equipmentId) return { type: 'equipment', id: sc.equipmentId };
  if (sc.kind === 'process-deviation' && sc.signalId) {
    const eq = PROCESS_SIGNAL_BY_ID[sc.signalId]?.equipmentId;
    if (eq) return { type: 'equipment', id: eq };
  }
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
  if (isOneOff(sc)) {
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
    case 'process-deviation': {
      const spec = sc.signalId ? PROCESS_SIGNAL_BY_ID[sc.signalId] : undefined;
      return `${sc.signalId ?? '—'} · ${signedValue(sc.offset ?? 0, spec?.unit ?? '', spec?.digits ?? 0).trim()} from setpoint${sc.rampMin ? ` (ramp ${sc.rampMin} min)` : ''}`;
    }
    case 'data-quality':
      return `${machineLabel(sc.equipmentId ?? '—')} · ${sc.mode ? DQ_MODE_LABEL[sc.mode] : '—'} · ${sc.signalId ?? 'every signal'}`;
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
    case 'data-quality':
      return sc.mode === 'counter-reset' ? `Counters restarted from 0 at ${formatClock(sc.start)}` : null;
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
  if (isOneOff(sc)) return null;
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
    const active = scenariosActive(s).filter((sc) => !isOneOff(sc));
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
