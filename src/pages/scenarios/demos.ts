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
import { FINDING_STATUS_LABEL, findingsFor, type RuleFinding, type RuleScope } from '../../intel/rules';
import { readSignal } from '../../sim/telemetry';
import { formatClock, formatDuration } from '../../sim/time';
import {
  DEVIATION_RAMP_MIN,
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
  when,
} from './catalogue';

export type DemoId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
export type UseCaseId = 'production' | 'oee' | 'defects' | 'vehicles' | 'flow' | 'process' | 'data';

export const USE_CASE_LABEL: Record<UseCaseId, string> = {
  production: 'Production',
  oee: 'OEE & losses',
  defects: 'Quality & defects',
  vehicles: 'Fleet & movement',
  flow: 'Material flow',
  process: 'Process & quality',
  data: 'Data quality',
};

/**
 * A rule finding a demonstration watches (src/intel/rules): the 'primary' findings carry the demonstration, a
 * 'chain' finding is a step on the way, and a 'dependent' rule is expected to be "not evaluated" because the data it
 * needs is not trustworthy. A finding matches when its key starts with one of `match` within one of the scopes.
 */
export type DemoFindingSpec = {
  key: string;
  label: string;
  role: 'primary' | 'chain' | 'dependent';
  scopes: RuleScope[];
  match: string[];
};

/** What the card shows for one watched finding. */
export type DemoFindingRow = {
  key: string;
  label: string;
  role: DemoFindingSpec['role'];
  finding: RuleFinding | null;
  /** 'cleared': it fired after the set-up and has resolved since; 'none': no such finding in scope. */
  state: 'detected' | 'cleared' | 'clear' | 'not-evaluated' | 'none';
  /** Detected: since (firstSeen); cleared: when it resolved. */
  at: number | null;
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

export type DemoCtx = {
  s: SimState;
  v: Values;
  run: DemoRun | null;
  primary: OpEvent | null;
  scenarios: ScenarioActivation[];
  /** Watched findings (demos E–H; empty otherwise). */
  rows: DemoFindingRow[];
};

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
  /**
   * Rule findings that carry the demonstration instead of an operational event (demos E–H). The demonstration is
   * complete when every 'primary' finding is detected after the set-up.
   */
  findings?: DemoFindingSpec[];
  /** One line about the detected primary finding (e.g. the aligned timestamps of a chain), or null. */
  detail?: (f: RuleFinding, s: SimState) => string | null;
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

// ── Finding-based demonstrations (E–H) ────────────────────────────────────────

const eqScope = (equipmentId: string): RuleScope => ({ kind: 'equipment', equipmentId });
const PRESSES = ['E-PRS1', 'E-PRS2', 'E-PRS3'];
const ZONE1 = 'H-KILN.zone1_temp_pv';
const ZONE3 = 'H-KILN.zone3_temp_pv';
/** The powder chain's "low" silo level (F-POWDER-STARVATION condition 2). */
export const SILO_LOW_PCT = 10;

const measure = (f: RuleFinding | null | undefined, label: string) => {
  const v = f?.measurements.find((m) => m.label === label)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const rowOf = (rows: DemoFindingRow[], key: string) => rows.find((r) => r.key === key) ?? null;
/** The silos have started to fall: the balance or trend finding is (or was) detected, or the first hour is over. */
const started = (rows: DemoFindingRow[], s: SimState, run: DemoRun | null) =>
  (run != null && s.minute - run.at >= 60) ||
  ['balance', 'trend'].some((k) => {
    const r = rowOf(rows, k);
    return r?.state === 'detected' || r?.state === 'cleared';
  });
/** Current powder silo level in % (null when the reading is missing or not trustworthy). */
function siloNow(s: SimState) {
  const r = readSignal(s, 'D-SILO.level');
  return typeof r.value === 'number' && r.quality !== 'bad' ? r.value : null;
}
/** The silo trend (%/h) the trend rule measured over its window, or null. */
const siloSlope = (rows: DemoFindingRow[]) => measure(rowOf(rows, 'trend')?.finding, 'Level trend');

/** "1 · … from 10:12 · 2 · … from 21:40 …": when each numbered link of a chain finding began (aligned timestamps). */
function chainTimes(f: RuleFinding, s: SimState): string | null {
  const first = new Map<string, { label: string; at: number }>();
  for (const e of f.evidence) {
    const n = /^(\d) · /.exec(e.label)?.[1];
    if (!n || !e.window) continue;
    const cur = first.get(n);
    if (!cur || e.window.from < cur.at) first.set(n, { label: e.label, at: e.window.from });
  }
  if (!first.size) return null;
  return [...first.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, x]) => `${x.label} from ${when(x.at, s.minute)}`)
    .join(' · ');
}

/** Rows of a demonstration's watched findings (findings are memoised per minute by the rule engine). */
export function demoFindingRows(s: SimState, specs: DemoFindingSpec[], run: DemoRun | null): DemoFindingRow[] {
  const cache = new Map<string, RuleFinding[]>();
  const inScope = (sc: RuleScope) => {
    const k = JSON.stringify(sc);
    let fs = cache.get(k);
    if (!fs) cache.set(k, (fs = findingsFor(s, sc)));
    return fs;
  };
  return specs.map((sp) => {
    const all = sp.scopes.flatMap(inScope).filter((f) => sp.match.some((m) => f.key.startsWith(m)));
    const f = all.find((x) => x.status === 'fired') ?? all.find((x) => x.status === 'insufficient-data') ?? all[0] ?? null;
    let state: DemoFindingRow['state'] = 'none';
    let at: number | null = null;
    if (f?.status === 'fired') {
      state = 'detected';
      at = f.firstSeen;
    } else if (f?.status === 'insufficient-data') state = 'not-evaluated';
    else if (f) {
      const resolved = all.map((x) => x.resolvedAt ?? null).filter((x): x is number => x != null && run != null && x >= run.at);
      state = resolved.length ? 'cleared' : 'clear';
      at = resolved.length ? Math.max(...resolved) : null;
    }
    return { key: sp.key, label: sp.label, role: sp.role, finding: f, state, at };
  });
}

export const FINDING_ROW_LABEL: Record<DemoFindingRow['state'], string> = {
  detected: FINDING_STATUS_LABEL.fired,
  cleared: 'Detected, since cleared',
  clear: FINDING_STATUS_LABEL.clear,
  'not-evaluated': 'Not evaluated',
  none: 'Not applicable',
};

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
  {
    id: 'E',
    useCase: 'flow',
    title: 'Powder shortage',
    summary:
      'The spray dryer’s output falls → the powder silo level falls → the presses run short of powder and their rate falls → “Potential press starvation” (F-POWDER-STARVATION), with the time each link began. The silos start full, so the drawdown takes many simulated hours: Skip jumps ahead using the silos’ own trend.',
    params: [{ key: 'factor', label: 'Spray dryer output', initial: 0.4, options: [0.4, 0.25].map((f) => ({ value: f, label: `${pct(f)} of normal` })) }],
    build: (v) => [
      { kind: 'reduced-rate', equipmentId: 'D-TWR', factor: num(v.factor), end: null, label: `Powder shortage · D-TWR spray dryer at ${pct(num(v.factor))} output (simulated)` },
    ],
    primaryTypes: ['below-rate'],
    findings: [
      { key: 'balance', label: 'Powder silos: inflow below outflow, t/h (F-BALANCE)', role: 'chain', scopes: [eqScope('D-SILO')], match: ['F-BALANCE|eq:D-SILO|'] },
      { key: 'trend', label: 'Powder silo level falling, % (F-BUFFER-TREND)', role: 'chain', scopes: [eqScope('D-SILO')], match: ['F-BUFFER-TREND|eq:D-SILO|'] },
      { key: 'starve', label: 'Presses short of powder, rate down (F-STARVE)', role: 'chain', scopes: PRESSES.map(eqScope), match: ['F-STARVE|eq:E-PRS'] },
      { key: 'chain', label: 'Potential press starvation (F-POWDER-STARVATION)', role: 'primary', scopes: [eqScope('D-SILO')], match: ['F-POWDER-STARVATION|eq:D-SILO'] },
    ],
    detail: (f, s) => chainTimes(f, s),
    steps: () => [
      { key: 'tower', label: 'Factory Twin · D-TWR', target: { type: 'equipment', id: 'D-TWR' }, hint: null },
      { key: 'silo', label: 'Factory Twin · D-SILO', target: { type: 'equipment', id: 'D-SILO' }, hint: null },
      { key: 'flow', label: 'Production › Material flow', target: { type: 'workspace', id: 'production', tab: 'material' }, hint: null },
    ],
    waiting: ({ s, run, rows }) => {
      const silo = siloNow(s);
      const slope = siloSlope(rows);
      if (!started(rows, s, run)) return 'The spray dryer now makes less powder than the presses draw: the silo trend and the t/h balance are reported within about an hour.';
      if (silo == null) return 'The powder silo level is not available right now, so no time to low level is estimated.';
      if (silo > SILO_LOW_PCT && slope != null && slope < 0)
        return `Powder silos at ${silo.toFixed(0)} % and falling ${Math.abs(slope).toFixed(1)} %/h: low (${SILO_LOW_PCT} %) in ≈ ${formatDuration(Math.ceil(((silo - SILO_LOW_PCT) / -slope) * 60))} at this rate (linear extrapolation). The chain needs the presses short of powder too.`;
      return `Powder silos at ${silo.toFixed(0)} %: the chain fires once a press has been short of powder for 10 min with the silos low (it stays reported while the shortage lasts).`;
    },
    skip: ({ s, run, rows }) => {
      if (!run) return null;
      if (!started(rows, s, run)) return Math.max(5, run.at + 60 - s.minute);
      const silo = siloNow(s);
      const slope = siloSlope(rows);
      if (silo != null && silo > SILO_LOW_PCT && slope != null && slope < 0) return Math.min(24 * 60, Math.max(15, Math.ceil(((silo - SILO_LOW_PCT) / -slope) * 60)));
      // Silos low (or no trend to extrapolate): an hour at a time — the chain's own window.
      return 60;
    },
  },
  {
    id: 'F',
    useCase: 'flow',
    title: 'Downstream constraint',
    summary:
      'Sorting slows down → the kiln outfeed fills (stage 8 “cooling buffer” = the kiln outfeed roller storage BUF-KOUT on CV-SORT) → the kiln is limited by its outfeed → “Possible downstream constraint at sorting” (F-DOWNSTREAM-CONSTRAINT). This line has no polishing / rectification stage, so the slowdown is shown at sorting, the next stage after the kiln.',
    params: [{ key: 'factor', label: 'Sorting capacity', initial: 0.55, options: [0.7, 0.55, 0.4].map((f) => ({ value: f, label: pct(f) })) }],
    build: (v) => [{ kind: 'bottleneck', stage: 'SORT', factor: num(v.factor), end: null, label: `Downstream constraint · sorting at ${pct(num(v.factor))} capacity (simulated)` }],
    primaryTypes: ['below-rate'],
    findings: [
      { key: 'outfeed', label: 'Kiln outfeed filling (F-BUFFER-TREND)', role: 'chain', scopes: [eqScope('CV-SORT')], match: ['F-BUFFER-TREND|eq:CV-SORT|'] },
      { key: 'block', label: 'Kiln limited by its outfeed (F-BLOCK)', role: 'chain', scopes: [eqScope('H-KILN')], match: ['F-BLOCK|eq:H-KILN|'] },
      { key: 'constraint', label: 'Possible downstream constraint at sorting (F-DOWNSTREAM-CONSTRAINT)', role: 'primary', scopes: [eqScope('CV-SORT')], match: ['F-DOWNSTREAM-CONSTRAINT|eq:CV-SORT'] },
    ],
    steps: () => [
      { key: 'sort', label: 'Factory Twin · CV-SORT', target: { type: 'equipment', id: 'CV-SORT' }, hint: null },
      { key: 'kiln', label: 'Factory Twin · H-KILN', target: { type: 'equipment', id: 'H-KILN' }, hint: null },
      { key: 'flow', label: 'Production › Material flow', target: { type: 'workspace', id: 'production', tab: 'material' }, hint: null },
    ],
    waiting: () => 'The kiln outfeed fills within about 10–30 min; the constraint rule needs sorting slow, the outfeed high and the kiln limited in the same 30-min window.',
    skip: () => 10,
  },
  {
    id: 'G',
    useCase: 'process',
    title: 'Process deviation → batch → rejects',
    summary:
      'Kiln zone 3 runs above its setpoint beyond the alarm band → the batch made during it is identified → its tiles show a higher reject rate → QL-PROCESS-ASSOCIATION: an association to investigate, not a demonstrated cause (other conditions that changed at the same time can explain it).',
    params: [{ key: 'offset', label: 'Zone 3 deviation', initial: 35, options: [35, 25].map((o) => ({ value: o, label: `+${o} °C from setpoint` })) }],
    build: (v) => [
      {
        kind: 'process-deviation',
        signalId: ZONE3,
        offset: num(v.offset),
        rampMin: DEVIATION_RAMP_MIN,
        end: null,
        label: `Process deviation · kiln zone 3 +${num(v.offset)} °C (simulated)`,
      },
    ],
    primaryTypes: ['defect-count', 'defect-rate', 'defect-deterioration', 'defect-repeat'],
    findings: [
      { key: 'limit', label: 'Zone 3 beyond its alarm band (PC-LIMIT)', role: 'chain', scopes: [eqScope('H-KILN')], match: [`PC-LIMIT|eq:H-KILN|${ZONE3}`] },
      { key: 'setpoint', label: 'Zone 3 away from setpoint (PC-SETPOINT)', role: 'chain', scopes: [eqScope('H-KILN')], match: [`PC-SETPOINT|eq:H-KILN|${ZONE3}`] },
      { key: 'assoc', label: 'Batch made during it: higher reject rate (QL-PROCESS-ASSOCIATION)', role: 'primary', scopes: [{ kind: 'stage', stageNo: 10 }], match: ['QL-PROCESS-ASSOCIATION|stage:10|H-KILN'] },
    ],
    detail: (f) => {
      const batch = /batch (B-[\w-]+)/.exec(f.title)?.[1] ?? null;
      const during = measure(f, 'Reject rate — made during the deviation');
      const outside = measure(f, 'Reject rate — made outside any deviation');
      if (during == null || outside == null) return null;
      return `${batch ? `Batch ${batch}: ` : ''}reject rate ${during.toFixed(1)} % for tiles made during the deviation vs ${outside.toFixed(1)} % outside it — an association to investigate, not a cause.`;
    },
    steps: () => [
      { key: 'kiln', label: 'Factory Twin · H-KILN', target: { type: 'equipment', id: 'H-KILN' }, hint: null },
      { key: 'compare', label: 'Quality › Compare', target: { type: 'workspace', id: 'quality', tab: 'compare' }, hint: null },
    ],
    waiting: ({ v, scenarios }) =>
      `Zone 3 ramps to +${scenarios[0]?.offset ?? num(v.offset)} °C over ${DEVIATION_RAMP_MIN} min: the limit check fires within minutes, the batch association once enough tiles made during the deviation have been inspected (≥ 200, about 15–30 min).`,
    skip: () => 5,
  },
  {
    id: 'H',
    useCase: 'data',
    title: 'Data quality',
    summary:
      'A frozen production counter on press 2 and a bad-quality kiln zone 1 sensor (simulated telemetry faults; production itself is unchanged) → DQ-* findings, and the rules that need those signals report “not evaluated” instead of guessing.',
    params: [],
    build: () => [
      { kind: 'data-quality', mode: 'frozen', equipmentId: 'E-PRS2', signalId: 'E-PRS2.count_total', end: null, label: 'Data quality · E-PRS2 counter frozen (simulated)' },
      { kind: 'data-quality', mode: 'bad-quality', equipmentId: 'H-KILN', signalId: ZONE1, end: null, label: 'Data quality · H-KILN zone 1 sensor bad quality (simulated)' },
    ],
    primaryTypes: ['counter-inactive'],
    findings: [
      { key: 'frozen', label: 'E-PRS2 counter frozen (DQ-FROZEN; DQ-STALE if not running)', role: 'primary', scopes: [eqScope('E-PRS2')], match: ['DQ-FROZEN|eq:E-PRS2', 'DQ-STALE|eq:E-PRS2'] },
      { key: 'bad', label: 'H-KILN zone 1 sensor bad quality (DQ-BAD-QUALITY)', role: 'primary', scopes: [eqScope('H-KILN')], match: ['DQ-BAD-QUALITY|eq:H-KILN'] },
      { key: 'counter', label: 'E-PRS2 counter check (P-COUNTER)', role: 'dependent', scopes: [eqScope('E-PRS2')], match: ['P-COUNTER|eq:E-PRS2'] },
      { key: 'output', label: 'E-PRS2 output check (P-OUTPUT)', role: 'dependent', scopes: [eqScope('E-PRS2')], match: ['P-OUTPUT|eq:E-PRS2'] },
      { key: 'zone1', label: 'Zone 1 setpoint check (PC-SETPOINT)', role: 'dependent', scopes: [eqScope('H-KILN')], match: [`PC-SETPOINT|eq:H-KILN|${ZONE1}`] },
    ],
    steps: () => [
      { key: 'press', label: 'Factory Twin · E-PRS2', target: { type: 'equipment', id: 'E-PRS2' }, hint: null },
      { key: 'kiln', label: 'Factory Twin · H-KILN', target: { type: 'equipment', id: 'H-KILN' }, hint: null },
      { key: 'data', label: 'Events › Data & connectivity', target: { type: 'workspace', id: 'events', tab: 'data' }, hint: null },
    ],
    waiting: () => 'The bad-quality flag is reported on the next minute; the frozen counter once its value is older than the stale age (5 min).',
    skip: ({ s, run }) => (run ? Math.max(1, run.at + 6 - s.minute) : null),
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
  /** Watched rule findings (demos E–H; empty for A–D and before the set-up). */
  rows: DemoFindingRow[];
  /** The first detected primary finding (demos E–H). */
  finding: RuleFinding | null;
  /** One line about it (aligned timestamps, the batch and its reject rates), or null. */
  detail: string | null;
  /** The demonstration has produced what it shows: its event (A–D) or every primary finding (E–H). */
  complete: boolean;
  steps: DemoStep[];
  /** One line: what the scenario is doing. */
  status: string;
  /** One line: the event or finding, or what the presenter is waiting for. */
  eventLine: string;
  /** While waiting for the event: minutes a "skip ahead" should advance (null = none). */
  skip: number | null;
};

export function demoView(s: SimState, def: DemoDef, v: Values, run: DemoRun | null): DemoView {
  const scenarios = run ? run.scenarioIds.map((id) => s.scenarios.find((x) => x.id === id)).filter((x): x is ScenarioActivation => !!x) : [];
  const states = scenarios.map((sc) => ({ sc, st: scenarioStatus(s, sc) }));
  const events = run ? demoEvents(s, run.scenarioIds) : [];
  const primary = primaryEvent(events, def.primaryTypes);
  const rows = run && def.findings ? demoFindingRows(s, def.findings, run) : [];
  const ctx: DemoCtx = { s, v, run, primary, scenarios, rows };
  const w = run?.watch;
  const watching = w?.state === 'waiting';
  const held = w?.state === 'applied' && s.logistics.active.includes(w.truckId);
  const clearable = watching || states.some((r) => r.st.key === 'active' && r.sc.kind !== 'maintenance');
  const active = clearable || held;
  const primaries = rows.filter((r) => r.role === 'primary');
  const finding = primaries.find((r) => r.state === 'detected')?.finding ?? null;
  const complete = def.findings ? primaries.length > 0 && primaries.every((r) => r.state === 'detected') : !!primary;
  let status = 'Not set up';
  if (run) {
    const main = states[0];
    if (def.id === 'D') {
      status = !w
        ? 'Truck could not be injected'
        : w.state === 'waiting'
          ? `${w.truckLabel} injected at ${formatClock(run.at)} · hold pending`
          : w.state === 'applied'
            ? `${w.truckLabel} held +${w.hold} min at ${dockName(w.dockId ?? '')} (since ${formatClock(w.at ?? run.at)})`
            : `${w.truckLabel} · hold ${w.state === 'cancelled' ? 'cancelled' : 'not applied'}${w.note ? ` — ${w.note}` : ''}`;
    } else if (main) {
      status = `${main.st.label} · ${main.sc.label}${main.st.note ? ` · ${main.st.note}` : ''}${states.length > 1 ? ` · +${states.length - 1} more` : ''}`;
    }
  }
  let eventLine: string;
  if (def.findings) {
    eventLine =
      complete && finding
        ? `${finding.ruleId} · ${FINDING_STATUS_LABEL.fired} · ${finding.title}${finding.firstSeen != null ? ` · since ${when(finding.firstSeen, s.minute)}` : ''}`
        : run
          ? def.waiting(ctx)
          : 'Set up to create the scenario; the rule findings it produces appear here.';
  } else {
    eventLine = primary
      ? `${primary.id} · ${EVENT_STATUS_LABEL[primary.status]}${primary.end == null ? ' · condition active' : ' · condition cleared'} · from ${formatClock(primary.start)}${events.length > 1 ? ` · ${events.length - 1} related` : ''}`
      : run
        ? def.waiting(ctx)
        : 'Set up to create the scenario; its event appears here.';
  }
  const raw = run && !complete && active ? def.skip(ctx) : null;
  // Whole simulated minutes (the clock advances by minutes; labels must not show float noise).
  const skip = raw == null ? null : Math.max(1, Math.ceil(raw - 1e-6));
  const detail = finding && def.detail ? def.detail(finding, s) : null;
  return { run, scenarios: states, active, clearable, events, primary, rows, finding, detail, complete, steps: def.steps(ctx), status, eventLine, skip };
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
