/**
 * End-to-end demonstration scenarios — one per use case — for the presenter cards: one-click
 * set-up from the same scenario inputs as the catalogue, the operational event each one produces
 * (the same OpEvent record as Events & Reports, the PDF and the copilot), and "Show me" steps that
 * open each place the effect is visible. Pure functions only (unit-tested in demos.test.ts).
 */
import { CONVEYOR_BY_ID, DEFECTS, DEFECT_ORDER, MONITORED_STAGE_BY_ID, PROCESS_MACHINES } from '../../model/plant';
import type { EventType, MonitoredStageId, OpEvent, ScenarioActivation, StageId } from '../../model/types';
import { TRACKED_ASSETS, type SimState } from '../../sim/engine';
import { EVENT_STATUS_LABEL } from '../../sim/events';
import { phaseLabel, type TruckRuntime } from '../../sim/logistics';
import { formatClock } from '../../sim/time';
import {
  dockName,
  machineLabel,
  num,
  scenarioStatus,
  stageLabel,
  str,
  type ParamDef,
  type ParamOption,
  type ScenarioDef,
  type ScenarioStatus,
  type ShowTarget,
  type Values,
} from './catalogue';

export type DemoId = 'A' | 'B' | 'C' | 'D';
export type UseCaseId = 'production' | 'oee' | 'defects' | 'vehicles';

export const USE_CASE_LABEL: Record<UseCaseId, string> = {
  production: 'Production',
  oee: 'OEE & losses',
  defects: 'Quality & defects',
  vehicles: 'Fleet & movement',
};

/** Truck-delay watcher: the hold is applied automatically when the injected truck docks. */
export type HoldWatch = {
  truckId: string;
  truckLabel: string;
  hold: number;
  state: 'waiting' | 'applied' | 'missed' | 'cancelled';
  dockId: string | null;
  holdScenarioId: string | null;
  /** Minute the hold was applied / the watch ended. */
  at: number | null;
  note: string | null;
};

/** The latest set-up of a demonstration card (scenario ids restart after Reset Demo, hence the epoch). */
export type DemoRun = {
  demo: DemoId;
  epoch: number;
  at: number;
  scenarioIds: string[];
  watch?: HoldWatch;
};

export type DemoStep = {
  key: string;
  label: string;
  /** null while the step is not available yet; `hint` says what it waits for. */
  target: ShowTarget | null;
  hint: string | null;
};

export type DemoCtx = { s: SimState; v: Values; run: DemoRun | null; primary: OpEvent | null; scenarios: ScenarioActivation[] };

export type DemoDef = {
  id: DemoId;
  useCase: UseCaseId;
  title: string;
  summary: string;
  params: ParamDef[];
  /** Scenario inputs activated by Set up (the truck delay adds its dock hold when the truck docks). */
  build: (v: Values, now: number) => ScenarioDef[];
  /** Event types that carry the demonstration, in order of preference. */
  primaryTypes: EventType[];
  steps: (c: DemoCtx) => DemoStep[];
  /** What the presenter should expect while the event is not there yet. */
  waiting: (c: DemoCtx) => string;
  /** Minutes to skip ahead to reach the event while waiting for it (null = nothing to wait for). */
  skip: (c: DemoCtx) => number | null;
};

// ── Parameters ────────────────────────────────────────────────────────────────

/** Conveyors offered by the stoppage demo (CV-PACK first: packing starves within minutes, the kiln keeps running). */
export const DEMO_CONVEYORS = ['CV-PACK', 'CV-KIN', 'CV-SORT', 'CV-GLZ', 'D-BELT', 'E-COL', 'CV-PAL'];
const conveyorOptions: ParamOption[] = DEMO_CONVEYORS.map((id) => ({ value: id, label: `${id} · ${CONVEYOR_BY_ID[id]?.name ?? id}` }));
const stopDurations: ParamOption[] = [
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 h' },
  { value: 0, label: 'Until cleared' },
];
const pct = (f: number) => `${Math.round(f * 100)} %`;
const durLabel = (min: number) => (min > 0 ? (min >= 60 ? `${min / 60} h` : `${min} min`) : 'until cleared');

/** Monitored stage a conveyor feeds (Production groups glazing + decoration and packing + palletising). */
export function conveyorStage(id: string): MonitoredStageId {
  const fed = CONVEYOR_BY_ID[id]?.blocksInputOf[0] ?? CONVEYOR_BY_ID[id]?.to ?? 'PACK';
  if (fed === 'DECOR') return 'GLAZE';
  if (fed === 'PAL') return 'PACK';
  return fed as MonitoredStageId;
}

const COPILOT_Q = (what: string) => `What happened at ${what}, why, and what is the impact?`;

// ── Demonstrations ────────────────────────────────────────────────────────────

export const DEMOS: DemoDef[] = [
  {
    id: 'A',
    useCase: 'production',
    title: 'Conveyor stoppage',
    summary:
      'Stops a conveyor between two stages. The receiving stage starves once its buffer runs out, the stop is raised as an event with its state transition, counters and twin snapshot, and the copilot explains it from that record.',
    params: [
      { key: 'conveyor', label: 'Conveyor', initial: 'CV-PACK', options: conveyorOptions },
      { key: 'duration', label: 'Duration', initial: 30, options: stopDurations },
    ],
    build: (v, now) => {
      const id = str(v.conveyor);
      const d = num(v.duration);
      return [{ kind: 'conveyor-stop', equipmentId: id, end: d > 0 ? now + d : null, label: `Conveyor stoppage ${machineLabel(id)} · ${durLabel(d)}` }];
    },
    primaryTypes: ['conveyor-stop'],
    steps: ({ v, run, primary, scenarios }) => {
      const id = scenarios[0]?.equipmentId ?? str(v.conveyor);
      const stage = conveyorStage(id);
      const need = run ? 'Waiting for the stop event' : 'Set up first';
      return [
        { key: 'twin', label: `Factory Twin · ${id}`, target: { type: 'equipment', id }, hint: null },
        { key: 'stage', label: `Production · ${MONITORED_STAGE_BY_ID[stage]?.name ?? stage}`, target: { type: 'stage', id: stage }, hint: null },
        { key: 'event', label: 'Event report', target: primary ? { type: 'event', id: primary.id } : null, hint: need },
        { key: 'copilot', label: 'Ask the copilot', target: primary ? { type: 'copilot', question: COPILOT_Q(id), eventId: primary.id } : null, hint: need },
      ];
    },
    waiting: () => 'The conveyor-stop rule fires on the next simulated minute.',
    skip: () => 1,
  },
  {
    id: 'B',
    useCase: 'oee',
    title: 'OEE loss',
    summary:
      'Slows a machine below its ideal rate (a performance loss) or stops it (an availability loss). Production shows the OEE drop, the capacity gap and its estimated value (assumptions shown); the loss is carried by one event.',
    params: [
      {
        key: 'mode',
        label: 'Loss',
        initial: 'rate',
        options: [
          { value: 'rate', label: 'Reduced rate (performance)' },
          { value: 'stop', label: 'Downtime (availability)' },
        ],
      },
      { key: 'machine', label: 'Machine', initial: 'H-KILN', options: PROCESS_MACHINES.map((id) => ({ value: id, label: machineLabel(id) })) },
      { key: 'factor', label: 'Rate', initial: 0.6, options: [0.8, 0.6, 0.4].map((f) => ({ value: f, label: `${pct(f)} of ideal` })), visible: (v) => str(v.mode) === 'rate' },
      { key: 'duration', label: 'Duration', initial: 30, options: stopDurations, visible: (v) => str(v.mode) === 'stop' },
    ],
    build: (v, now) => {
      const id = str(v.machine);
      if (str(v.mode) === 'stop') {
        const d = num(v.duration);
        return [{ kind: 'machine-stop', equipmentId: id, end: d > 0 ? now + d : null, label: `OEE loss · ${machineLabel(id)} downtime · ${durLabel(d)}` }];
      }
      return [{ kind: 'reduced-rate', equipmentId: id, factor: num(v.factor), end: null, label: `OEE loss · ${machineLabel(id)} at ${pct(num(v.factor))} rate` }];
    },
    primaryTypes: ['below-rate', 'machine-stop', 'machine-fault'],
    steps: ({ v, run, primary, scenarios }) => {
      const id = scenarios[0]?.equipmentId ?? str(v.machine);
      return [
        { key: 'oee', label: 'Production · OEE & losses', target: { type: 'workspace', id: 'production', tab: 'oee' }, hint: null },
        { key: 'event', label: 'Event report', target: primary ? { type: 'event', id: primary.id } : null, hint: run ? 'Waiting for the event' : 'Set up first' },
        { key: 'twin', label: `Factory Twin · ${id}`, target: { type: 'equipment', id }, hint: null },
      ];
    },
    waiting: ({ s, run, scenarios }) => {
      const sc = scenarios[0];
      if (sc?.kind === 'machine-stop') return 'The stop rule fires on the next simulated minute.';
      const n = Math.max(3, Math.round(s.rules.belowRateMinutes));
      const at = run ? ` (≈ ${formatClock(run.at + n)})` : '';
      return `The below-rate rule fires after ${n} min under ${pct(s.rules.belowRateFactor)} of the ideal rate${at}.`;
    },
    skip: ({ s, run, scenarios }) => {
      if (!run || scenarios[0]?.kind === 'machine-stop') return 1;
      return Math.max(1, run.at + Math.max(3, Math.round(s.rules.belowRateMinutes)) + 1 - s.minute);
    },
  },
  {
    id: 'C',
    useCase: 'defects',
    title: 'Defect deterioration',
    summary:
      'Raises the defects that originate at one stage. Inspection records (illustrative frames, simulated classification) pile up in that category and the quality rules raise an event with the frames and counts as evidence.',
    params: [
      { key: 'stage', label: 'Defect origin', initial: 'GLAZE', options: (['PRESS', 'GLAZE', 'DECOR', 'KILN'] as StageId[]).map((id) => ({ value: id, label: stageLabel(id) })) },
      { key: 'factor', label: 'Severity', initial: 6, options: [2, 4, 6].map((f) => ({ value: f, label: `×${f} reject rate` })) },
    ],
    build: (v) => [
      {
        kind: 'quality-deterioration',
        stage: str(v.stage) as StageId,
        factor: num(v.factor),
        end: null,
        label: `Defect deterioration · ${stageLabel(str(v.stage) as StageId)} defects ×${num(v.factor)}`,
      },
    ],
    primaryTypes: ['defect-count', 'defect-repeat', 'defect-rate', 'defect-deterioration'],
    steps: ({ run, primary }) => [
      { key: 'quality', label: 'Quality & Defects', target: { type: 'workspace', id: 'quality' }, hint: null },
      { key: 'event', label: 'Quality event report', target: primary ? { type: 'event', id: primary.id } : null, hint: run ? 'Waiting for a quality event' : 'Set up first' },
      { key: 'twin', label: 'Factory Twin · I-VIS', target: { type: 'equipment', id: 'I-VIS' }, hint: null },
    ],
    waiting: ({ s, v, scenarios }) => {
      const stage = (scenarios[0]?.stage ?? str(v.stage)) as StageId;
      const cats = DEFECT_ORDER.filter((d) => DEFECTS[d].origin === stage).map((d) => DEFECTS[d].label.toLowerCase());
      const f = scenarios[0]?.factor ?? num(v.factor);
      return `Quality rules run every 5 min on the inspection records (${cats.join(', ')}): more than ${s.rules.defectCount30Max} rejects of one category in 30 min, ${s.rules.defectRepeatRecords} consecutive records of it, or ${s.rules.deteriorationRatio}× its 24 h rate over ≈ 2 h raise an event — ${f >= 6 ? 'at ×6 typically within about 30 simulated min' : 'at this severity after about an hour of simulated time'} (tiles reach inspection after firing).`;
    },
    skip: () => 15,
  },
  {
    id: 'D',
    useCase: 'vehicles',
    title: 'Truck delay',
    summary:
      'An extra outbound truck arrives at the gate, checks in, waits in holding and docks. When it docks a documentation hold is added automatically, so the dock stay runs past the threshold and a dock event is raised with the visit timeline.',
    params: [{ key: 'hold', label: 'Hold at dock', initial: 75, options: [45, 75, 120].map((n) => ({ value: n, label: `+${n} min` })) }],
    build: () => [{ kind: 'truck-arrival', end: null, label: 'Truck delay · additional truck arrival' }],
    primaryTypes: ['dock-overstay', 'truck-waiting', 'turnaround-exceeded'],
    steps: ({ s, run, primary }) => {
      const w = run?.watch;
      const v = w ? s.logistics.vehicles[w.truckId] : undefined;
      const onSite = !!v && s.logistics.active.includes(v.id) && v.spawned <= s.minute;
      return [
        { key: 'fleet', label: 'Fleet & Movement', target: { type: 'workspace', id: 'fleet' }, hint: null },
        {
          key: 'truck',
          label: w ? `Follow ${w.truckLabel}` : 'Follow the truck',
          target: onSite ? { type: 'vehicle', id: v!.id } : null,
          hint: !run ? 'Set up first' : v ? 'The truck has left the site' : 'Truck not on site',
        },
        { key: 'event', label: 'Dock event report', target: primary ? { type: 'event', id: primary.id } : null, hint: run ? 'Waiting for the dock event' : 'Set up first' },
      ];
    },
    waiting: ({ s, run }) => {
      const w = run?.watch;
      if (!w) return 'Set up first.';
      const v = s.logistics.vehicles[w.truckId] as TruckRuntime | undefined;
      if (w.state === 'waiting') return `${w.truckLabel}: ${v?.phase ? phaseLabel[v.phase].toLowerCase() : 'on its way'} — the +${w.hold} min hold is added when it docks.`;
      if (w.state === 'applied' && v?.visit?.dockStart != null) {
        const due = v.visit.dockStart + s.rules.dockStayMax;
        return `Docked at ${dockName(w.dockId ?? '')} since ${formatClock(v.visit.dockStart)}; the dock-stay rule fires at ${s.rules.dockStayMax} min (≈ ${formatClock(due)}).`;
      }
      return w.note ?? 'Waiting for the dock event.';
    },
    skip: ({ s, run }) => {
      const w = run?.watch;
      if (!w) return null;
      if (w.state === 'waiting') return 5;
      const v = s.logistics.vehicles[w.truckId] as TruckRuntime | undefined;
      if (w.state === 'applied' && v?.visit?.dockStart != null) return Math.max(1, v.visit.dockStart + s.rules.dockStayMax + 1 - s.minute);
      return null;
    },
  },
];

export const DEMO_BY_ID = Object.fromEntries(DEMOS.map((d) => [d.id, d])) as Record<DemoId, DemoDef>;

/** Parameter-store key of a demonstration card. */
export const demoKey = (id: DemoId) => `demo-${id}`;
export const demoInitialValues = (): Record<string, Values> =>
  Object.fromEntries(DEMOS.map((d) => [demoKey(d.id), Object.fromEntries(d.params.map((p) => [p.key, p.initial]))]));

// ── Linked events and the card view ───────────────────────────────────────────

/**
 * Events the demonstration produced: events tagged with one of its scenario ids or carrying a
 * downtime record the scenario opened (a stop on an asset that was already stopped continues
 * the open stop event), plus the consequences traced to them (e.g. packing starved because its
 * conveyor stopped). Oldest first.
 */
export function demoEvents(s: SimState, scenarioIds: string[]): OpEvent[] {
  if (!scenarioIds.length) return [];
  const ids = new Set(scenarioIds);
  const stops = new Set(s.downtime.filter((d) => d.scenarioId != null && ids.has(d.scenarioId)).map((d) => d.id));
  const direct = s.events.filter((e) => (e.refs.scenarioId != null && ids.has(e.refs.scenarioId)) || (e.refs.downtimeId != null && stops.has(e.refs.downtimeId)));
  const roots = new Set(direct.map((e) => e.id));
  const consequences = s.events.filter((e) => e.consequenceOf != null && roots.has(e.consequenceOf) && !roots.has(e.id));
  return [...direct, ...consequences].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}

/** The event that carries the demonstration: first by preferred type, then the earliest linked one. */
export function primaryEvent(events: OpEvent[], types: EventType[]): OpEvent | null {
  for (const t of types) {
    const hit = events.find((e) => e.type === t);
    if (hit) return hit;
  }
  return events.find((e) => !e.consequenceOf) ?? events[0] ?? null;
}

export type DemoView = {
  run: DemoRun | null;
  scenarios: { sc: ScenarioActivation; st: ScenarioStatus }[];
  /** Something of this run is still in effect (a scenario, the truck-delay watcher, or the held truck still on site). */
  active: boolean;
  /** Something the Clear button can end (an active scenario or a pending watcher). */
  clearable: boolean;
  events: OpEvent[];
  primary: OpEvent | null;
  steps: DemoStep[];
  /** One line: what the scenario is doing. */
  status: string;
  /** One line: the event, or what the presenter is waiting for. */
  eventLine: string;
  /** While waiting for the event: minutes a "skip ahead" should advance (null = none). */
  skip: number | null;
};

export function demoView(s: SimState, def: DemoDef, v: Values, run: DemoRun | null): DemoView {
  const scenarios = run ? run.scenarioIds.map((id) => s.scenarios.find((x) => x.id === id)).filter((x): x is ScenarioActivation => !!x) : [];
  const rows = scenarios.map((sc) => ({ sc, st: scenarioStatus(s, sc) }));
  const events = run ? demoEvents(s, run.scenarioIds) : [];
  const primary = primaryEvent(events, def.primaryTypes);
  const ctx: DemoCtx = { s, v, run, primary, scenarios };
  const w = run?.watch;
  const watching = w?.state === 'waiting';
  const held = w?.state === 'applied' && s.logistics.active.includes(w.truckId);
  const clearable = watching || rows.some((r) => r.st.key === 'active' && r.sc.kind !== 'maintenance');
  const active = clearable || held;
  let status = 'Not set up';
  if (run) {
    const main = rows[0];
    if (def.id === 'D') {
      status = !w
        ? 'Truck could not be injected'
        : w.state === 'waiting'
          ? `${w.truckLabel} injected at ${formatClock(run.at)} · hold pending`
          : w.state === 'applied'
            ? `${w.truckLabel} held +${w.hold} min at ${dockName(w.dockId ?? '')} (since ${formatClock(w.at ?? run.at)})`
            : `${w.truckLabel} · hold ${w.state === 'cancelled' ? 'cancelled' : 'not applied'}${w.note ? ` — ${w.note}` : ''}`;
    } else if (main) {
      status = `${main.st.label} · ${main.sc.label}${main.st.note ? ` · ${main.st.note}` : ''}`;
    }
  }
  const eventLine = primary
    ? `${primary.id} · ${EVENT_STATUS_LABEL[primary.status]}${primary.end == null ? ' · condition active' : ' · condition cleared'} · from ${formatClock(primary.start)}${events.length > 1 ? ` · ${events.length - 1} related` : ''}`
    : run
      ? def.waiting(ctx)
      : 'Set up to create the scenario; its event appears here.';
  const raw = run && !primary && active ? def.skip(ctx) : null;
  // Whole simulated minutes (the clock advances by minutes; labels must not show float noise).
  const skip = raw == null ? null : Math.max(1, Math.ceil(raw - 1e-6));
  return { run, scenarios: rows, active, clearable, events, primary, steps: def.steps(ctx), status, eventLine, skip };
}

// ── Truck delay watcher ───────────────────────────────────────────────────────

export type WatchDecision = { action: 'wait' } | { action: 'apply'; dockId: string } | { action: 'missed'; reason: string };

/** What the truck-delay watcher should do now: apply the hold once the truck is at its dock. */
export function watchDecision(s: SimState, w: HoldWatch): WatchDecision {
  const v = s.logistics.vehicles[w.truckId] as TruckRuntime | undefined;
  if (!v || !v.visit) return { action: 'missed', reason: 'The truck is no longer in the simulation' };
  const dockId = v.visit.dockId;
  if (v.visit.dockStart != null && v.visit.dockEnd == null && dockId && s.logistics.docks[dockId]?.vehicleId === v.id) return { action: 'apply', dockId };
  if (v.visit.dockEnd != null || v.despawned != null) return { action: 'missed', reason: 'The truck left the dock before the hold could be added' };
  return { action: 'wait' };
}

/** The dock hold added when the truck docks (same input as the catalogue's prolonged dock stay). */
export const holdDef = (w: HoldWatch, dockId: string): ScenarioDef => ({
  kind: 'prolonged-dock-stay',
  dockId,
  count: w.hold,
  end: null,
  label: `Truck delay · ${w.truckLabel} held +${w.hold} min at ${dockName(dockId)}`,
});

// ── Reset check ───────────────────────────────────────────────────────────────

export type CheckResult = { key: 'scenarios' | 'events' | 'counters'; label: string; ok: boolean | null; detail: string };

/** What the plant looked like the moment Reset Demo completed (the checks refer to that moment). */
export type ResetSnapshot = { epoch: number; at: number; liveFrom: number; scenarios: number; liveEvents: string[] };

/** Events detected in this demo session (not pre-rolled history). */
const sessionEvents = (s: SimState) => s.events.filter((e) => !e.historical);

export function resetSnapshot(s: SimState, epoch: number): ResetSnapshot {
  return { epoch, at: s.minute, liveFrom: s.liveFrom, scenarios: s.scenarios.length, liveEvents: sessionEvents(s).map((e) => e.id) };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Counters of the live plant against the no-scenario baseline of the same seed at the same minute.
 * null when it cannot be compared (no baseline yet, a different minute, or a scenario was activated).
 */
export function countersCheck(s: SimState, baseline: SimState | null): CheckResult {
  const label = 'Counters at baseline';
  if (s.scenarios.length) return { key: 'counters', label, ok: null, detail: 'Not compared — a scenario has been activated since the reset, so the plant is meant to differ from its baseline.' };
  if (!baseline) return { key: 'counters', label, ok: null, detail: 'Waiting for the baseline run (built in the background)…' };
  if (baseline.minute !== s.minute) return { key: 'counters', label, ok: null, detail: `Not compared — baseline at ${formatClock(baseline.minute)}, plant at ${formatClock(s.minute)}.` };
  const off = TRACKED_ASSETS.filter((id) => !near(s.machines[id].countTotal, baseline.machines[id].countTotal));
  let good = 0;
  let baseGood = 0;
  for (const v of s.lineGood.values()) good += v;
  for (const v of baseline.lineGood.values()) baseGood += v;
  const okGood = near(good, baseGood);
  const okRecords = s.inspections.length === baseline.inspections.length && s.logistics.truckSeq === baseline.logistics.truckSeq;
  const ok = !off.length && okGood && okRecords;
  return {
    key: 'counters',
    label,
    ok,
    detail: ok
      ? `All ${TRACKED_ASSETS.length} machine and conveyor counters, line output, inspection records and truck arrivals match the no-scenario baseline at ${formatClock(s.minute)}.`
      : `Differs from the baseline: ${[...off.slice(0, 4), ...(okGood ? [] : ['line output']), ...(okRecords ? [] : ['records'])].join(', ')}${off.length > 4 ? ` +${off.length - 4}` : ''}.`,
  };
}

/**
 * Checks shown after Reset Demo: nothing injected and nothing detected in the new session at the
 * moment the reset completed, and the counters on the no-scenario baseline (compared live while
 * no scenario has been activated since).
 */
export function resetChecks(snap: ResetSnapshot, s: SimState, baseline: SimState | null): CheckResult[] {
  const since = sessionEvents(s).filter((e) => !snap.liveEvents.includes(e.id));
  const fromScenario = since.filter((e) => e.source === 'scenario').length;
  const later =
    since.length > 0
      ? ` Since then the running simulation has detected ${since.length} event${since.length === 1 ? '' : 's'}${fromScenario ? ` (${fromScenario} from scenarios)` : ' (none from scenarios)'}.`
      : '';
  const added = s.scenarios.length - snap.scenarios;
  return [
    {
      key: 'scenarios',
      label: 'No active scenario',
      ok: snap.scenarios === 0,
      detail:
        (snap.scenarios === 0 ? `The scenario log was empty at ${formatClock(snap.at)}.` : `${snap.scenarios} scenario${snap.scenarios === 1 ? '' : 's'} in the log at ${formatClock(snap.at)}.`) +
        (added > 0 ? ` ${added} activated since.` : ''),
    },
    {
      key: 'events',
      label: 'No events after the session start',
      ok: snap.liveEvents.length === 0,
      detail:
        (snap.liveEvents.length === 0
          ? `Every event was pre-rolled history before ${formatClock(snap.liveFrom)} when the reset completed.`
          : `${snap.liveEvents.length} event${snap.liveEvents.length === 1 ? '' : 's'} after ${formatClock(snap.liveFrom)} (${snap.liveEvents[0]}…).`) + later,
    },
    countersCheck(s, baseline),
  ];
}
