/**
 * Material-flow rules (brief §7): buffer level trends with time to empty / full (linear extrapolation, never a
 * forecast), the inflow / outflow balance around a buffer, starvation and blockage through a buffer, and the two
 * chains the brief names — spray dryer → powder silos → presses ("Potential press starvation") and sorting →
 * kiln outfeed → kiln ("Possible downstream constraint at sorting"). Every verdict reads the signals through the
 * rule context: level signals (% of capacity), rate and counter signals, the simulated mass flows of stages 1–2
 * (t/h) and the state timelines — never the simulation's buffer contents.
 *
 * - Scope. Buffer rules (F-BUFFER-TREND, F-BALANCE and the two chains) are evaluated for the equipment item that
 *   holds the buffer: its own equipment (C-SLIP, D-SILO, E-COL, F-BUF, I-BUF) or the conveyor that carries a buffer
 *   without equipment (CV-GLZ, CV-KIN, CV-SORT — the kiln outfeed, stage 8 — and CV-PAL); F-STARVE / F-BLOCK for
 *   each process machine next to a buffer, so a neighbour's panel shows them. Stage and plant views get them through
 *   the engine's scope expansion (every item of a stage), each finding once.
 * - Side of the kiln (the line constraint), as src/ui/equipment/kpis.ts bufferLevelBand reads a level: ahead of the
 *   kiln an empty buffer is the concern and a full one is normal balancing (the stage filling it has spare
 *   capacity); behind the kiln a full buffer is the concern and a low one is normal (the stages after the kiln are
 *   faster). Severities follow the panel's flow / buffer insights (src/ui/equipment/intel/derive.ts).
 * - Units. Levels are % only. A silo or tank level is never turned into a mass or a tile count: no level-to-mass
 *   calibration is configured (src/calc massFromLevel). Stage 1–2 flows are t/h from the simulated mass-flow
 *   signals (a labelled conversion of tile-equivalents, KG_PER_TILE) — never tiles/h for slip or powder.
 * - Now, not only over the window. A window figure (a least-squares trend, a mean rate) keeps an earlier episode in it
 *   for as long as the window lasts — e.g. the kiln infeed drawn down during a planned clean of the glaze line keeps a
 *   "falling" 60-min slope for half an hour after the printer restarted and the infeed refills. Each rule therefore
 *   also checks the trailing recent window (F-BUFFER-TREND recentMin / recentMinTransfer): the level still moving that
 *   way (or stopped at empty / full), the neighbour still stopped or below rate, the machine still short of material.
 *   An episode that no longer holds is 'clear' (with the turn / end where the history shows it).
 * - Not the event engine (src/sim/events.ts R-STARVE / R-BLOCK / R-IO): findings are recomputed from the data;
 *   the stop events of the neighbours are linked as evidence. A stopped or slowed neighbour is named as the likely
 *   source, inferred from states, rates and levels — to investigate, never a confirmed cause.
 *
 * Ids: the F- prefix of the build plan's flow rules (F-BUFFER-TREND …, as the authoring note in src/intel/rules/types.ts
 * says); it does not collide with an event-engine id. All six are threshold rules ('rule-based').
 * The thresholds the event engine also has (R-RATE below 85 % of the planned rate; R-STARVE 10 min, 5 min at the
 * kiln) mirror the configured event rules.
 */
import { convert, counterRate, flowBalance, massFromLevel, timeToEmpty, timeToFull, trendSlope, usableValue, type Sample, type Window } from '../../../calc';
import { KG_PER_TILE, definitionOf, stageOfBuffer, type ProductionStageNo } from '../../../model/catalog';
import { BUFFER_LEVEL_SIGNAL, BUFFERS, CONVEYOR_BY_ID, CONVEYORS, DEFAULT_EVENT_RULES, LINE, OPS_BY_ID, OUTPUT_BUFFER, STAGES, STAGE_BY_ID } from '../../../model/plant';
import type { BufferDef, ConveyorDef, ProcessStage } from '../../../model/types';
import { OPERATIONAL_STATE_LABEL } from '../../../sim/metrics';
import type { RuleContext, RuleStop } from '../context';
import { CHART, type Evidence, type Measurement, type MissingSignal, type RuleDef, type RuleEvaluation, type RuleParam, type RuleScope, type Severity } from '../types';
import {
  clock,
  counterSignalOf,
  duration,
  equipmentName,
  idealRateOf,
  inCatalog,
  list,
  minutesWhere,
  num,
  pct,
  signalName,
  signalUnit,
  span,
  stateLookup,
  stateSignalOf,
  trailingRunStart,
  type EquipmentState,
} from '../util';
import { plannedRateOf } from './production';

// ── Line topology ────────────────────────────────────────────────────────────

const KILN_INDEX = STAGES.findIndex((st) => st.id === LINE.designConstraint);

/** A buffer with a level signal, its neighbours and how its level is read. */
export type FlowBuffer = {
  buf: BufferDef;
  /** Level signal (% of capacity): `<equipment>.level`, or the hosted level signal on its conveyor. */
  level: string;
  /** Equipment item whose scope carries the buffer's findings (its own equipment, or the conveyor holding it). */
  holder: string;
  /** Stage filling it / stage drawing from it. */
  up: ProcessStage | null;
  down: ProcessStage | null;
  /** Conveyors carrying the transfer through it (a stopped one cuts the transfer). */
  transfer: ConveyorDef[];
  /** Feeds a stage at or before the kiln: running empty is the concern, full is normal balancing. */
  ahead: boolean;
  feedsKiln: boolean;
  fedByKiln: boolean;
  /** Slip tanks (stage 1) and powder silos (stage 2): level % only, flows in t/h. */
  bulk: 'tank' | 'silo' | null;
  /** An accumulation on a conveyor (small, changes fast) rather than a storage. */
  accumulation: boolean;
  stageNo: ProductionStageNo | null;
};

function flowBuffer(b: BufferDef): FlowBuffer | null {
  const level = BUFFER_LEVEL_SIGNAL[b.id];
  if (!level) return null;
  const i = STAGES.findIndex((st) => st.inputBuffer === b.id);
  const up = i > 0 ? STAGES[i - 1] : null;
  const down = i >= 0 ? STAGES[i] : null;
  const holder = level.slice(0, level.indexOf('.'));
  const stageNo = stageOfBuffer(b.id);
  return {
    buf: b,
    level,
    holder,
    up,
    down,
    transfer: CONVEYORS.filter((c) => c.bufferId === b.id),
    ahead: down != null && i <= KILN_INDEX,
    feedsKiln: down?.id === LINE.designConstraint,
    fedByKiln: up?.id === LINE.designConstraint,
    bulk: stageNo === 1 ? 'tank' : stageNo === 2 ? 'silo' : null,
    accumulation: !!CONVEYOR_BY_ID[holder],
    stageNo,
  };
}

/** Every buffer with a level signal, in line order. */
export const FLOW_BUFFERS: FlowBuffer[] = BUFFERS.map(flowBuffer).filter((x): x is FlowBuffer => x != null);
const BY_HOLDER = new Map(FLOW_BUFFERS.map((b) => [b.holder, b]));
const BY_BUFFER = new Map(FLOW_BUFFERS.map((b) => [b.buf.id, b]));

/** The buffer whose findings an equipment scope carries (null for anything that holds no buffer). */
export const bufferHeldBy = (equipmentId: string): FlowBuffer | null => BY_HOLDER.get(equipmentId) ?? null;
/** The buffer feeding a process machine's stage (null without a level signal). */
export function inputBufferOf(id: string): FlowBuffer | null {
  const stage = OPS_BY_ID[id]?.stage;
  const b = stage ? STAGE_BY_ID[stage].inputBuffer : null;
  return b ? (BY_BUFFER.get(b) ?? null) : null;
}
/** The buffer a process machine's stage feeds (null without a level signal). */
export function outputBufferOf(id: string): FlowBuffer | null {
  const stage = OPS_BY_ID[id]?.stage;
  const b = stage ? OUTPUT_BUFFER[stage] : null;
  return b ? (BY_BUFFER.get(b) ?? null) : null;
}

/** The buffer of the brief's powder chain (spray dryer → powder silos → presses) and the kiln outfeed (stage 8). */
const POWDER_SILO = BY_BUFFER.get(STAGE_BY_ID.PRESS.inputBuffer ?? '') ?? null;
const KILN_OUTFEED = FLOW_BUFFERS.find((b) => b.fedByKiln) ?? null;

// ── Words ────────────────────────────────────────────────────────────────────

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const idOf = (scope: RuleScope) => (scope.kind === 'equipment' ? scope.equipmentId : '');
/** "the powder silos (D-SILO.level)". */
const bufferWords = (b: FlowBuffer) => `the ${lowerFirst(b.buf.name)} (${b.level})`;
/** Verb agreement with a buffer's name ("the powder silos are", "the kiln outfeed is"). */
const plural = (b: FlowBuffer) => /s$/.test(b.buf.name);
const is = (b: FlowBuffer) => (plural(b) ? 'are' : 'is');
const runs = (b: FlowBuffer) => (plural(b) ? 'run' : 'runs');
const covers = (b: FlowBuffer) => (plural(b) ? 'cover' : 'covers');
/** "pressing (E-PRS1, E-PRS2, E-PRS3)" / "Spray dryer tower (D-TWR)". */
const stageWho = (st: ProcessStage) => (st.machines.length > 1 ? `${lowerFirst(st.name)} (${st.machines.join(', ')})` : `${equipmentName(st.machines[0])} (${st.machines[0]})`);
const stateWord = (st: EquipmentState) => lowerFirst(OPERATIONAL_STATE_LABEL[st]);
/** A signed figure with its unit ("+12.0 %/h", "−0.8 t/h"). */
const signed = (v: number, digits: number, unit: string) => `${v >= 0 ? '+' : '−'}${num(Math.abs(v), digits)} ${unit}`;
/** Display decimals of a flow unit (t/h with one decimal, counts as integers). */
const digitsOf = (unit: string) => (unit === 't/h' ? 1 : 0);
const round = (v: number, digits: number) => Number(v.toFixed(digits));

/** "The level is a share of the silo volume: no level-to-mass calibration configured …" for silos and tanks. */
function bulkNote(b: FlowBuffer): string {
  if (!b.bulk) return '';
  const mass = massFromLevel(null, null);
  const why = mass.status === 'ok' ? '' : mass.reason;
  // A mass signal the catalogue lists without a model behind it (e.g. D-SILO.powder_mass: needs load cells or a calibration).
  const massSignal = [`${b.buf.equipmentId}.powder_mass`, `${b.buf.equipmentId}.slip_mass`].find((id) => {
    const st = definitionOf(id)?.availabilityStatus;
    return st != null && st !== 'simulated' && st !== 'connected';
  });
  return ` The level is a share of the ${b.bulk} volume: ${lowerFirst(why)}, so no mass or tile quantity is derived from it${massSignal ? ` (${massSignal} is unavailable)` : ''} — figures stay in % and %/h.`;
}

/** What the level means on this side of the kiln (bufferLevelBand semantics), for a falling or rising buffer. */
function sideWords(b: FlowBuffer, direction: 'falling' | 'rising'): string {
  const up = b.up ? stageWho(b.up) : 'the stage filling it';
  const down = b.down ? stageWho(b.down) : 'the next stage';
  if (b.ahead && direction === 'falling')
    return `Ahead of the kiln an empty buffer starves ${down}${b.feedsKiln ? ' — the kiln, the line constraint, so that is lost line output' : '; the kiln (line constraint) follows once the buffers after it run down'}.`;
  if (b.ahead) return `Ahead of the kiln a full buffer is normal balancing: ${up} has spare capacity and is then paced by ${down}.`;
  if (direction === 'rising')
    return `Behind the kiln a full buffer blocks ${up}${b.fedByKiln ? ' — the kiln, the line constraint, so line output is lost' : ' and the blockage moves towards the kiln'}.`;
  return `Behind the kiln a low buffer is normal: ${down} is faster than ${up} and waits for tiles — no line output is lost.`;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A current reading usable as a figure (good / uncertain number), else null. */
function valueNow(ctx: RuleContext, signalId: string): number | null {
  const r = ctx.read(signalId);
  return typeof r.value === 'number' && (r.quality === 'good' || r.quality === 'uncertain') ? r.value : null;
}

const usableOf = (xs: Sample[]) => xs.filter((x) => usableValue(x) !== null);
/** Level samples of a window by minute (usable values; null otherwise). */
const levelsAt = (ctx: RuleContext, signalId: string, win: Window) => new Map(ctx.samples(signalId, win).map((x) => [x.t, usableValue(x)]));

/** At least this share of the window's minute samples must be usable for a figure over the window. */
const MIN_COVERAGE = 0.8;

type LevelTrend = {
  ok: true;
  /** Least-squares slope, %/h. */
  slope: number;
  samples: Sample[];
  first: Sample;
  last: Sample;
  /** Minute of the (last) highest / lowest level in the window: where the current fall / rise started. */
  maxAt: number;
  minAt: number;
  /** The highest / lowest level in the window (%). */
  max: number;
  min: number;
};

/** Level trend over the window (src/calc trendSlope, %/h) with its first / last / extreme samples. */
function levelTrend(ctx: RuleContext, signalId: string, win: Window): LevelTrend | { ok: false; reason: string; n: number } {
  const xs = ctx.samples(signalId, win);
  const good = usableOf(xs);
  const minutes = win.to - win.from;
  const t = trendSlope(xs, { minSamples: Math.max(5, Math.ceil(minutes * MIN_COVERAGE)), minSpanMin: minutes / 2 });
  if (t.status !== 'ok') return { ok: false, reason: t.reason, n: good.length };
  let max = good[0];
  let min = good[0];
  for (const x of good) {
    if ((x.v as number) >= (max.v as number)) max = x;
    if ((x.v as number) <= (min.v as number)) min = x;
  }
  return { ok: true, slope: t.value, samples: good, first: good[0], last: good[good.length - 1], maxAt: max.t, minAt: min.t, max: max.v as number, min: min.v as number };
}

/** "Rising / falling faster than" threshold of a buffer (F-BUFFER-TREND's, shared by the other flow rules). */
const trendLimit = (ctx: RuleContext, b: FlowBuffer) => ctx.param(TREND_ID, b.accumulation ? 'slopePctTransfer' : 'slopePct', b.holder);

/**
 * The trailing part of a rule window that the flow rules read as "now" for a buffer: F-BUFFER-TREND's recent window
 * for its kind (a few minutes for a conveyor accumulation, longer for a storage), never longer than the rule window.
 */
function recentOf(ctx: RuleContext, b: FlowBuffer, win: Window): Window {
  const R = Math.round(ctx.param(TREND_ID, b.accumulation ? 'recentMinTransfer' : 'recentMin', b.holder));
  return { from: Math.max(win.from, ctx.now - R), to: ctx.now };
}

/** A level that has stopped moving within this of empty (or full) is still empty (full) — not a recovery. */
const BOUND_PCT = 5;

type TrendNow = {
  /** The window trend still holds at the end of the window. */
  holds: boolean;
  /** Over the recent window the level moves the other way (refilling after a fall, drawing down after a rise). */
  reversed: boolean;
  /** Least-squares slope over the recent window, %/h (null with too few usable samples — the trend is then not gated). */
  slope: number | null;
  win: Window;
};

/**
 * Whether a window trend beyond the threshold still holds now: over the recent window the level still moves the same
 * way by at least half the threshold, or it has stopped at the empty / full end. A fall that has turned into a refill
 * (the stage filling it restarted) or levelled off part-way is no longer a fall, whatever the least-squares slope of
 * the whole window — which keeps the earlier drawdown in it for as long as the window lasts.
 */
function trendNow(ctx: RuleContext, b: FlowBuffer, win: Window, slope: number, level: number, thr: number): TrendNow {
  const w = recentOf(ctx, b, win);
  const minutes = w.to - w.from;
  const t = trendSlope(ctx.samples(b.level, w), { minSamples: Math.max(3, Math.ceil(minutes * MIN_COVERAGE)), minSpanMin: minutes / 2 });
  if (t.status !== 'ok') return { holds: true, reversed: false, slope: null, win: w };
  const dir = slope < 0 ? -1 : 1;
  const reversed = -t.value * dir >= thr / 2;
  const atBound = dir < 0 ? level <= BOUND_PCT : level >= 100 - BOUND_PCT;
  return { holds: t.value * dir >= thr / 2 || (!reversed && atBound), reversed, slope: t.value, win: w };
}

/** Mean of a machine's rate signal over a (recent) window, null without enough usable samples. */
function rateOver(m: MachineWindow, w: Window): number | null {
  let sum = 0;
  let n = 0;
  for (let t = w.from; t < w.to; t++) {
    const v = m.rates.get(t);
    if (v == null) continue;
    sum += v;
    n++;
  }
  return n > 0 && n >= (w.to - w.from) * MIN_COVERAGE ? sum / n : null;
}
/** Σ of the machines' rates over a (recent) window (null when one has no usable rate). */
const stageRateOver = (ms: MachineWindow[], w: Window) => {
  const xs = ms.map((m) => rateOver(m, w));
  return xs.every((x) => x != null) ? xs.reduce<number>((a, x) => a + (x as number), 0) : null;
};

/** States of an own stop (not production time; a stopped neighbour). */
const OWN_STOP: ReadonlySet<EquipmentState> = new Set<EquipmentState>(['fault', 'stopped', 'planned', 'changeover']);
/** Minutes left out of a machine's production time. */
const NOT_PRODUCTION: ReadonlySet<EquipmentState> = new Set<EquipmentState>(['fault', 'stopped', 'planned', 'changeover', 'unknown', 'disconnected']);
/** Waiting for material (a conveyor running empty is 'idle'). */
const WAITING: ReadonlySet<EquipmentState> = new Set<EquipmentState>(['starved', 'idle']);

/** A machine over a window: state minutes and its rate signal (mean over all minutes / over production time). */
type MachineWindow = {
  id: string;
  /** Start of the window (a state segment starting here may have begun earlier). */
  from: number;
  /** Catalogue unit of its rate signal. */
  unit: string;
  /** Minutes of production time (not an own stop, state known). */
  prodMin: number;
  waitMin: number;
  /** Mean rate over the window's usable samples (null without enough of them). */
  rate: number | null;
  /** Mean rate over the production minutes. */
  prodRate: number | null;
  /** State in the last minute and since when (clipped to the window). */
  now: EquipmentState | null;
  nowSince: number | null;
  /** The own stop open at the end of the window, if any. */
  stop: RuleStop | null;
  /** Own stops (planned, changeover, unplanned) overlapping the window, oldest first. */
  stops: RuleStop[];
  lookup: ReturnType<typeof stateLookup>;
  rates: Map<number, number | null>;
};

function machineWindow(ctx: RuleContext, id: string, win: Window): MachineWindow {
  const segs = ctx.states(id, win);
  const lookup = stateLookup(segs);
  const rateSig = `${id}.rate`;
  const xs = inCatalog(rateSig) ? ctx.samples(rateSig, win) : [];
  const rates = new Map(xs.map((x) => [x.t, usableValue(x)]));
  let sum = 0;
  let n = 0;
  let pSum = 0;
  let pN = 0;
  for (const x of xs) {
    const v = usableValue(x);
    if (v == null) continue;
    sum += v;
    n++;
    const st = lookup(x.t)?.state;
    if (st && !NOT_PRODUCTION.has(st)) {
      pSum += v;
      pN++;
    }
  }
  const last = lookup(win.to - 1);
  const stops = ctx.stops(id, win);
  const stop = stops.find((x) => x.start < win.to && (x.end == null || x.end >= win.to)) ?? null;
  return {
    id,
    from: win.from,
    unit: signalUnit(rateSig) ?? 'tiles/h',
    prodMin: minutesWhere(segs, win, (st) => !NOT_PRODUCTION.has(st)),
    waitMin: minutesWhere(segs, win, (st) => WAITING.has(st)),
    rate: n >= (win.to - win.from) * MIN_COVERAGE ? sum / n : null,
    prodRate: pN ? pSum / pN : null,
    now: last?.state ?? null,
    nowSince: last?.from ?? null,
    stop: stop && last && OWN_STOP.has(last.state) ? stop : null,
    stops,
    lookup,
    rates,
  };
}

/** "stopped (Hydraulic pressure fault since 10:12)" / "running throughout the window" / "blocked since 10:20". */
function machineWords(m: MachineWindow): string {
  if (m.stop) return `${m.stop.kind === 'planned' ? 'in a planned stop' : m.stop.kind === 'changeover' ? 'in a product changeover' : 'stopped'} (${m.stop.reasonLabel} since ${clock(m.stop.start)})`;
  if (!m.now) return 'without a known state';
  return `${stateWord(m.now)}${m.nowSince != null && m.nowSince > m.from ? ` since ${clock(m.nowSince)}` : ' throughout the window'}`;
}
/** Own stops of the machines that ended inside the window: "G-INK in a planned stop (Planned cleaning, 18:10–18:25)". */
function endedStops(ms: MachineWindow[], win: Window): string[] {
  const kind = (x: RuleStop) => (x.kind === 'planned' ? 'in a planned stop' : x.kind === 'changeover' ? 'in a product changeover' : 'stopped');
  return ms.flatMap((m) =>
    m.stops.filter((x) => x.end != null && x.end > win.from && x.end <= win.to).map((x) => `${m.id} ${kind(x)} (${x.reasonLabel}, ${clock(x.start)}–${clock(x.end as number)})`),
  );
}

/** The machines in an own stop now when every one of them is a planned stop or a product changeover (else null). */
function plannedNow(ms: MachineWindow[]): MachineWindow[] | null {
  const stopped = ms.filter((m) => m.stop);
  return stopped.length && stopped.every((m) => m.stop!.kind === 'planned' || m.stop!.kind === 'changeover') ? stopped : null;
}
/** "G-INK is in a planned stop (Planned cleaning since 18:10)". */
const plannedWords = (ms: MachineWindow[]) =>
  list(ms.map((m) => `${m.id} is in ${m.stop!.kind === 'planned' ? 'a planned stop' : 'a product changeover'} (${m.stop!.reasonLabel} since ${clock(m.stop!.start)})`));

/** "E-PRS1 starved since 11:39, E-PRS2 … and E-PRS3 …". */
const statesOf = (ms: MachineWindow[]) => list(ms.map((m) => `${m.id} ${machineWords(m)}`));

/**
 * Minutes of [from, to) a machine was short of material from a low input buffer: waiting for material, or running
 * below `limit` — each with the input buffer at or below `lowPct` that minute. A below-rate minute with the
 * machine's output buffer at or above `fullPct` is left out: it was held at its discharge, not at its supply.
 */
function shortMinutes(
  m: MachineWindow,
  from: number,
  to: number,
  inLevel: Map<number, number | null>,
  lowPct: number,
  limit: number,
  outLevel: Map<number, number | null> | null,
  fullPct: number,
): { n: number; first: number | null; last: number | null } {
  let n = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (let t = from; t < to; t++) {
    const lv = inLevel.get(t);
    const st = m.lookup(t)?.state;
    if (lv == null || lv > lowPct || !st) continue;
    const r = m.rates.get(t);
    const out = outLevel?.get(t);
    const below = (st === 'running' || st === 'reduced') && r != null && r < limit && !(out != null && out >= fullPct);
    if (WAITING.has(st) || below) {
      n++;
      first ??= t;
      last = t;
    }
  }
  return { n, first, last };
}

/** Planned rate of a stage (Σ its machines' planned rates: the ideal, capped at the line pace set by the kiln). */
const stagePlanned = (st: ProcessStage) => st.machines.reduce((a, m) => a + (plannedRateOf(m)?.rate ?? 0), 0);
const stageIdeal = (st: ProcessStage) => st.machines.reduce((a, m) => a + (idealRateOf(m) ?? 0), 0);
/** Σ of the machines' window rates (null when one has no usable rate). */
const stageRate = (ms: MachineWindow[]) => (ms.every((m) => m.rate != null) ? ms.reduce((a, m) => a + (m.rate as number), 0) : null);
/** Catalogue unit of a stage's rate signals (tile-eq/h for slip and powder, tiles/h otherwise). */
const stageUnit = (st: ProcessStage) => signalUnit(`${st.machines[0]}.rate`) ?? 'tiles/h';

/** The transfer conveyors of a buffer that are in an own stop at the end of the window. */
function stoppedTransfer(ctx: RuleContext, b: FlowBuffer, win: Window): { c: ConveyorDef; m: MachineWindow }[] {
  return b.transfer.map((c) => ({ c, m: machineWindow(ctx, c.id, win) })).filter((x) => x.m.stop != null);
}

/** Event types of a neighbour that explain a flow problem: its stop, fault or reduced rate. */
const ROOT_EVENT_TYPES: ReadonlySet<string> = new Set(['machine-fault', 'machine-stop', 'conveyor-stop', 'below-rate']);

/** Up to three stop / fault / below-rate events of the given items in the window (evidence; the event engine owns them). */
const eventEvidence = (ctx: RuleContext, ids: string[], w: Window): Evidence[] =>
  ids
    .flatMap((id) => ctx.events(id, w))
    .filter((e) => ROOT_EVENT_TYPES.has(e.type))
    .slice(0, 3)
    .map((e) => ({ kind: 'event', label: e.title, ref: e.id, window: { from: e.start, to: e.end ?? ctx.now } }));

const levelEvidence = (b: FlowBuffer, w: Window): Evidence[] => [
  { kind: 'signal', label: `${b.buf.name} level`, ref: b.level, window: w },
  { kind: 'chart', label: `${b.buf.name} level`, ref: CHART.buffer(b.level), window: w },
];

/** A minute history that is too short or has gaps: insufficient data naming the signal. */
function shortHistory(ruleId: string, signalId: string, what: string, reason: string): RuleEvaluation {
  const missing: MissingSignal = { signalId, name: signalName(signalId), reason };
  return {
    status: 'insufficient-data',
    title: `${ruleId}: not evaluated`,
    explanation: `Not evaluated — ${what} needs the minute history of ${signalId}: ${lowerFirst(reason)}.`,
    missingSignals: [missing],
    next: `Check the history of ${signalId} for gaps (samples missing, bad or not current).`,
  };
}

// ── F-BUFFER-TREND · level rising / falling fast ─────────────────────────────

const TREND_ID = 'F-BUFFER-TREND';

const F_BUFFER_TREND: RuleDef = {
  id: TREND_ID,
  family: 'flow',
  classification: 'rule-based',
  title: 'Buffer level rising or falling fast',
  description:
    'Least-squares slope of a buffer, silo or tank level (%) over the window against a %/h threshold, reported while the trend still holds over the recent window, with the time to empty / full at that trend (linear extrapolation, not a forecast). What the direction means depends on the side of the kiln. Silo and tank levels stay in % — no level-to-mass calibration is configured.',
  appliesTo: (scope) => scope.kind === 'equipment' && inCatalog(bufferHeldBy(scope.equipmentId)?.level ?? ''),
  requiredSignals: (scope) => [bufferHeldBy(idOf(scope))!.level],
  optionalSignals: (scope) => {
    const b = bufferHeldBy(idOf(scope))!;
    return [...(b.up?.machines ?? []), ...(b.down?.machines ?? [])].map(stateSignalOf).filter(inCatalog);
  },
  params: [
    { key: 'windowMin', label: 'Window', unit: 'min', default: 60, min: 15, max: 480, step: 5, hint: 'The level trend is fitted over this trailing window (minute samples).' },
    {
      key: 'slopePct',
      label: 'Storage: faster than',
      unit: '%/h',
      default: 5,
      min: 0.5,
      max: 100,
      step: 0.5,
      decimals: 1,
      hint: 'Silos, tanks and buffer storage: a level moving faster than this is reported. Also what F-STARVE / F-BLOCK / F-POWDER-STARVATION call rising / falling.',
    },
    {
      key: 'slopePctTransfer',
      label: 'Conveyor accumulation: faster than',
      unit: '%/h',
      default: 30,
      min: 5,
      max: 500,
      step: 5,
      hint: 'Accumulations on a conveyor (small, change fast): a level moving faster than this is reported. Also what F-BLOCK / F-DOWNSTREAM-CONSTRAINT call rising.',
    },
    { key: 'etaMin', label: 'Warn when empty / full within', unit: 'min', default: 120, min: 15, max: 1440, step: 15, hint: 'A concerning trend that empties / fills the buffer within this time is a warning; later, information.' },
    {
      key: 'recentMin',
      label: 'Storage: still moving over the last',
      unit: 'min',
      default: 15,
      min: 5,
      max: 60,
      step: 5,
      hint: 'Silos, tanks and buffer storage: the trend must still hold over this trailing part of the window (at least half the threshold, or stopped at empty / full); a level that has turned or levelled off is not reported. Also what the other flow rules read as "now".',
    },
    {
      key: 'recentMinTransfer',
      label: 'Conveyor accumulation: still moving over the last',
      unit: 'min',
      default: 5,
      min: 3,
      max: 30,
      step: 1,
      hint: 'The same for accumulations on a conveyor, which turn within minutes (e.g. refilling once the stage filling them restarts).',
    },
  ],
  evaluate: (ctx, scope) => {
    const b = bufferHeldBy(idOf(scope))!;
    const W = Math.round(ctx.param(TREND_ID, 'windowMin', b.holder));
    const thr = trendLimit(ctx, b);
    const etaMax = ctx.param(TREND_ID, 'etaMin', b.holder);
    const win = ctx.window(W);
    const trend = levelTrend(ctx, b.level, win);
    if (!trend.ok) return shortHistory(TREND_ID, b.level, 'a level trend', `${trend.n} usable minute samples in the last ${W} min — ${lowerFirst(trend.reason)}`);
    const level = valueNow(ctx, b.level) ?? (trend.last.v as number);
    const slope = trend.slope;
    const evidence = levelEvidence(b, win);
    const measurements: Measurement[] = [
      { signalId: b.level, label: 'Level now', value: round(level, 1), unit: '%', at: trend.last.t },
      { signalId: b.level, label: 'Level trend', value: round(slope, 1), unit: '%/h', window: win },
      { label: 'Threshold', value: thr, unit: '%/h' },
    ];
    // Silos and tanks: the content is not known — said as a missing figure, never derived from the level.
    if (b.bulk) measurements.push({ label: b.bulk === 'silo' ? 'Powder in the silos' : 'Slip in the tanks', value: null, unit: null });
    const moved = `${b.level} went from ${num(trend.first.v, 1)} % (${clock(trend.first.t)}) to ${num(trend.last.v, 1)} % (${clock(trend.last.t)}) over the last ${W} min (${span(win)}): slope ${signed(slope, 1, '%/h')} (least squares over ${trend.samples.length} minute samples)`;
    const kind = b.bulk ?? (b.accumulation ? 'conveyor accumulation' : 'buffer storage');
    if (slope > -thr && slope < thr)
      return {
        status: 'clear',
        title: `${b.buf.name} level steady`,
        explanation: `${moved} — within ±${num(thr, 1)} %/h (${kind}).${bulkNote(b)}`,
        measurements,
        window: win,
        evidence,
        next: null,
        chartRef: CHART.buffer(b.level),
        subject: b.buf.id,
      };
    const falling = slope <= -thr;
    const neighbour = falling ? b.up : b.down;
    const nb = neighbour ? neighbour.machines.map((m) => machineWindow(ctx, m, win)) : [];
    const nbText = neighbour ? ` ${cap(stageWho(neighbour))}, ${falling ? 'filling it' : 'drawing from it'}: ${statesOf(nb)}.` : '';
    // The trend of the whole window keeps an earlier drawdown (or fill) in it: report it only while it still holds.
    const now = trendNow(ctx, b, win, slope, level, thr);
    if (now.slope != null) measurements.push({ signalId: b.level, label: 'Level trend (recent)', value: round(now.slope, 1), unit: '%/h', window: now.win });
    if (!now.holds) {
      const turn = falling ? trend.minAt : trend.maxAt;
      const turned = now.reversed ? (falling ? 'refilling' : 'drawing down') : 'levelled off';
      return {
        status: 'clear',
        title: `${b.buf.name} ${turned} after a ${falling ? 'fall' : 'rise'}`,
        explanation: `${moved} — ${falling ? 'falling' : 'rising'} faster than the ${num(thr, 1)} %/h threshold over the window (${kind}), but ${
          now.reversed ? `it is ${falling ? 'rising' : 'falling'} again` : 'it has levelled off'
        }: ${signed(now.slope as number, 1, '%/h')} over the last ${now.win.to - now.win.from} min (${span(now.win)}), from its ${falling ? 'lowest' : 'highest'} ${num(falling ? trend.min : trend.max, 1)} % at ${clock(turn)} to ${num(level, 1)} % now. The ${falling ? 'fall' : 'rise'} no longer holds, so no time to ${falling ? 'empty' : 'full'} is extrapolated from it.${nbText}${bulkNote(b)}`,
        measurements,
        window: win,
        evidence,
        next: null,
        resolvedAt: now.reversed ? Math.min(ctx.now, turn + 1) : now.win.from,
        chartRef: CHART.buffer(b.level),
        subject: b.buf.id,
      };
    }
    const eta = falling ? timeToEmpty(level, slope, 0) : timeToFull(level, slope, 100);
    const etaMin = eta.status === 'ok' ? eta.value : null;
    measurements.push({ label: falling ? 'Time to empty at this trend' : 'Time to full at this trend', value: etaMin != null ? Math.round(etaMin) : null, unit: 'min' });
    const etaText =
      etaMin == null
        ? ''
        : etaMin === 0
          ? ` It is already ${falling ? 'empty' : 'full'}.`
          : etaMin > 1440
            ? ` At this trend it would be ${falling ? 'empty' : 'full'} in more than 24 h (linear extrapolation, not a forecast).`
            : ` At this trend it is ${falling ? 'empty' : 'full'} in ≈ ${duration(etaMin)} (≈ ${clock(ctx.now + etaMin)}; linear extrapolation of the level trend, not a forecast).`;
    const rising = !falling;
    const concern = (b.ahead && falling) || (!b.ahead && rising);
    const atConstraint = (falling && b.feedsKiln) || (rising && b.fedByKiln);
    const severity: Severity = concern && etaMin != null && etaMin <= etaMax ? (atConstraint ? 'serious' : 'warning') : 'info';
    const upWho = b.up ? stageWho(b.up) : 'the stage filling it';
    const downWho = b.down ? stageWho(b.down) : 'the stage drawing from it';
    const already = etaMin === 0;
    const at = etaMin != null && etaMin > 0 && etaMin <= 1440 ? ` (≈ ${clock(ctx.now + etaMin)} at this trend)` : '';
    // The neighbour behind the trend in a planned stop / changeover: a planned drawdown (or fill) — check it is covered.
    const planned = plannedNow(nb);
    const next = !concern
      ? null
      : planned
        ? already
          ? `${cap(plannedWords(planned))}, and ${bufferWords(b)} ${is(b)} already ${falling ? 'empty' : 'full'}: ${falling ? downWho : upWho} waits until it restarts — check that the stop ends on schedule.`
          : falling
            ? `${cap(plannedWords(planned))}: check that ${bufferWords(b)} ${covers(b)} the rest of the stop — empty${at || ' at this trend'} — or slow ${downWho} down in a controlled way before then.`
            : `${cap(plannedWords(planned))}: check that it restarts before ${bufferWords(b)} ${is(b)} full${at}.`
        : already
          ? falling
            ? `Restore the supply from ${upWho}: ${bufferWords(b)} ${is(b)} already empty.`
            : `Restore the take-away at ${downWho}: ${bufferWords(b)} ${is(b)} already full.`
          : falling
            ? `Restore the supply from ${upWho} before ${bufferWords(b)} ${runs(b)} empty${at}, or plan a controlled slow-down of ${downWho}.`
            : `Restore the take-away at ${downWho} before ${bufferWords(b)} ${is(b)} full${at}.`;
    const rate = `${num(Math.abs(slope), Math.abs(slope) < 10 ? 1 : 0)} %/h`;
    return {
      status: 'fired',
      severity,
      title: already
        ? `${b.buf.name} ${falling ? 'empty' : 'full'} — ${falling ? 'fell' : 'rose'} ${rate} over ${W} min`
        : `${b.buf.name} ${falling ? 'falling' : 'rising'} ${rate}${etaMin != null && etaMin > 0 && etaMin <= 1440 ? ` — ${falling ? 'empty' : 'full'} in ≈ ${duration(etaMin)}` : ''}`,
      explanation: `${moved}, ${falling ? 'falling' : 'rising'} faster than the ${num(thr, 1)} %/h threshold (${kind}).${etaText} ${sideWords(b, falling ? 'falling' : 'rising')}${nbText}${bulkNote(b)}`,
      measurements,
      window: win,
      evidence: [...evidence, ...eventEvidence(ctx, neighbour?.machines ?? [], win)],
      next,
      firstSeen: falling ? trend.maxAt : trend.minAt,
      chartRef: CHART.buffer(b.level),
      subject: b.buf.id,
    };
  },
};

// ── F-BALANCE · inflow below outflow ─────────────────────────────────────────

const BALANCE_ID = 'F-BALANCE';

/** A flow into / out of a buffer: a rate signal, or a counter read as a rate; × factor into the side's unit. */
type FlowSource = { signalId: string; counter: boolean; factor: number; from: string; to: string };
type FlowSides = { unit: string; inflow: FlowSource[]; outflow: FlowSource[]; note: string };

const massFlowOf = (id: string) => [`${id}.slip_flow`, `${id}.powder_flow`].find(inCatalog) ?? null;
const rateSource = (id: string): FlowSource => {
  const unit = signalUnit(`${id}.rate`) ?? 'tiles/h';
  return { signalId: `${id}.rate`, counter: false, factor: 1, from: unit, to: unit };
};
const massSource = (signalId: string): FlowSource => ({ signalId, counter: false, factor: 1, from: 't/h', to: 't/h' });

/**
 * What flows in and out of a buffer, in the stage's unit. Slip and powder (stages 1–2): t/h from the simulated
 * mass-flow signals; the powder drawn by the presses (no mass-flow signal there) from the powder-feed conveyor's
 * tile-equivalent counter with the same disclosed factor. Tiles elsewhere; after sorting only accepted tiles are
 * passed on (count_good).
 */
function flowSides(b: FlowBuffer): FlowSides | null {
  if (!b.up || !b.down) return null;
  if (b.bulk) {
    const inflow = b.up.machines.map(massFlowOf);
    if (!inflow.every(Boolean)) return null;
    const outMass = b.down.machines.map(massFlowOf);
    const feed = b.transfer[0] ? counterSignalOf(b.transfer[0].id) : null;
    const outflow: FlowSource[] | null = outMass.every(Boolean)
      ? outMass.map((s) => massSource(s!))
      : feed && inCatalog(feed)
        ? [{ signalId: feed, counter: true, factor: KG_PER_TILE / 1000, from: `${signalUnit(feed) ?? 'tile-eq'}/h`, to: 't/h' }]
        : null;
    if (!outflow) return null;
    const counted = outflow.find((x) => x.counter);
    return {
      unit: 't/h',
      inflow: inflow.map((s) => massSource(s!)),
      outflow,
      note: `Dry-body equivalent t/h: simulated mass flows (tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg per tile-equivalent, KG_PER_TILE — a labelled simulation assumption, not a weighed flow)${counted ? `; ${counted.signalId} counts tile-equivalents, converted with the same factor` : ''}.`,
    };
  }
  const unit = stageUnit(b.down);
  const inflow = b.up.machines.map((m): FlowSource => (inCatalog(`${m}.count_good`) ? { signalId: `${m}.count_good`, counter: true, factor: 1, from: unit, to: unit } : rateSource(m)));
  return {
    unit,
    inflow,
    outflow: b.down.machines.map(rateSource),
    note: inflow.some((x) => x.counter) ? 'Sorting passes on accepted tiles only (count_good): rejects leave the line at the diverters.' : '',
  };
}

/** Mean flow of one source over a window, in the side's unit (null with the reason when the history is short). */
function flowOver(ctx: RuleContext, src: FlowSource, w: Window): { v: number | null; reason?: string } {
  const minutes = w.to - w.from;
  if (src.counter) {
    const xs = ctx.samples(src.signalId, { from: w.from - 1, to: w.to });
    const good = usableOf(xs).length;
    if (good < (minutes + 1) * MIN_COVERAGE) return { v: null, reason: `${good} usable counter samples of ${minutes + 1}` };
    const eq = src.signalId.slice(0, src.signalId.indexOf('.'));
    const capPerH = CONVEYOR_BY_ID[eq]?.capacityPerHour ?? idealRateOf(eq) ?? null;
    const r = counterRate(xs, capPerH ? { maxPlausibleDelta: (capPerH / 60) * (minutes + 1) * 1.5 } : {});
    if (r.status !== 'ok') return { v: null, reason: r.reason };
    if (src.factor === 1) return { v: r.value.perHour };
    const c = convert(r.value.perHour, src.from, src.to, src.factor);
    return c.status === 'ok' ? { v: c.value } : { v: null, reason: c.reason };
  }
  const vals = ctx
    .samples(src.signalId, w)
    .map(usableValue)
    .filter((v): v is number => v != null);
  if (vals.length < minutes * MIN_COVERAGE) return { v: null, reason: `${vals.length} usable minute samples of ${minutes}` };
  return { v: (vals.reduce((a, v) => a + v, 0) / vals.length) * src.factor };
}

/** Σ of a side's flows over a window (null with the reason and the signal when one is short). */
function sideOver(ctx: RuleContext, srcs: FlowSource[], w: Window): { v: number | null; reason?: string; signalId?: string } {
  let sum = 0;
  for (const s of srcs) {
    const r = flowOver(ctx, s, w);
    if (r.v == null) return { v: null, reason: r.reason, signalId: s.signalId };
    sum += r.v;
  }
  return { v: sum };
}

const F_BALANCE: RuleDef = {
  id: BALANCE_ID,
  family: 'flow',
  classification: 'rule-based',
  title: 'Inflow below outflow',
  description:
    'Flow into a buffer (the rate / mass-flow signals of the stage filling it) against the flow out (the stage drawing from it), in the stage’s unit — t/h for slip and powder, tiles/h after pressing. Reported when the outflow exceeds the inflow by more than the deadband in every block of the sustained period and still over the recent window; while the stage filling it is in a planned stop or changeover, as a warning at most (a planned drawdown).',
  appliesTo: (scope) => {
    const b = scope.kind === 'equipment' ? bufferHeldBy(scope.equipmentId) : null;
    const f = b ? flowSides(b) : null;
    return !!f && [...f.inflow, ...f.outflow].every((x) => inCatalog(x.signalId));
  },
  requiredSignals: (scope) => {
    const f = flowSides(bufferHeldBy(idOf(scope))!)!;
    return [...f.inflow, ...f.outflow].map((x) => x.signalId);
  },
  optionalSignals: (scope) => [bufferHeldBy(idOf(scope))!.level],
  params: [
    { key: 'windowMin', label: 'Window', unit: 'min', default: 60, min: 20, max: 480, step: 10, hint: 'The flows are compared over this trailing window, block by block.' },
    { key: 'blockMin', label: 'Blocks of', unit: 'min', default: 10, min: 5, max: 60, step: 5, hint: 'The window is split into blocks of this length; each block’s net flow is checked.' },
    { key: 'minMinutes', label: 'Sustained for at least', unit: 'min', default: 30, min: 10, max: 240, step: 10, hint: 'The outflow must exceed the inflow in every block of the last this many minutes.' },
    {
      key: 'deadband',
      label: 'By more than',
      unit: '% of the planned draw',
      scale: 100,
      default: 0.05,
      min: 0.01,
      max: 0.5,
      step: 0.01,
      hint: 'Deadband: a net flow within this share of the drawing stage’s planned rate counts as balanced.',
    },
  ],
  evaluate: (ctx, scope) => {
    const b = bufferHeldBy(idOf(scope))!;
    const f = flowSides(b)!;
    const W = Math.round(ctx.param(BALANCE_ID, 'windowMin', b.holder));
    const B = Math.max(1, Math.round(ctx.param(BALANCE_ID, 'blockMin', b.holder)));
    const need = ctx.param(BALANCE_ID, 'minMinutes', b.holder);
    const share = ctx.param(BALANCE_ID, 'deadband', b.holder);
    const unit = f.unit;
    const d = digitsOf(unit);
    const win = ctx.window(W);
    const inW = sideOver(ctx, f.inflow, win);
    const outW = sideOver(ctx, f.outflow, win);
    if (inW.v == null || outW.v == null) {
      const bad = inW.v == null ? inW : outW;
      return shortHistory(BALANCE_ID, bad.signalId!, 'the flow balance', bad.reason ?? 'no usable history');
    }
    const deadband = stagePlanned(b.down!) * (unit === 't/h' ? KG_PER_TILE / 1000 : 1) * share;
    const bal = flowBalance(inW.v, outW.v, { deadband });
    if (bal.status !== 'ok') return shortHistory(BALANCE_ID, f.inflow[0].signalId, 'the flow balance', bal.reason);
    // Block by block from the newest: the trailing run in which the outflow exceeds the inflow beyond the deadband.
    let run = 0;
    for (let k = 0; ctx.now - (k + 1) * B >= win.from; k++) {
      const w = { from: ctx.now - (k + 1) * B, to: ctx.now - k * B };
      const i = sideOver(ctx, f.inflow, w).v;
      const o = sideOver(ctx, f.outflow, w).v;
      if (i == null || o == null || i - o >= -deadband) break;
      run++;
    }
    const sustained = run * B;
    const upWho = stageWho(b.up!);
    const downWho = stageWho(b.down!);
    const head = `Over the last ${W} min (${span(win)}) ${upWho} put ${num(inW.v, d)} ${unit} (${list(f.inflow.map((x) => x.signalId))}) into ${bufferWords(b)} while ${downWho} drew ${num(outW.v, d)} ${unit} (${list(f.outflow.map((x) => x.signalId))}): net ${signed(bal.value.net, d, unit)}`;
    const measurements: Measurement[] = [
      { label: 'Inflow', value: round(inW.v, d), unit, window: win },
      { label: 'Outflow', value: round(outW.v, d), unit, window: win },
      { label: 'Net flow', value: round(bal.value.net, d), unit, window: win },
      { label: 'Deadband', value: round(deadband, d), unit },
      { label: 'Draining in every block for', value: sustained, unit: 'min', window: { from: ctx.now - sustained, to: ctx.now } },
    ];
    const lvl = levelTrend(ctx, b.level, win);
    if (lvl.ok) measurements.push({ signalId: b.level, label: 'Level trend', value: round(lvl.slope, 1), unit: '%/h', window: win });
    const levelText = lvl.ok ? ` Level signal: ${b.level} ${signed(lvl.slope, 1, '%/h')}, now ${num(lvl.last.v, 1)} % (the flows are not converted into a level).` : '';
    const notes = `${f.note ? ` ${f.note}` : ''}${bulkNote(b)}`;
    const evidence: Evidence[] = [
      ...[...f.inflow, ...f.outflow].map((x): Evidence => ({ kind: 'signal', label: signalName(x.signalId), ref: x.signalId, window: win })),
      ...levelEvidence(b, win),
    ];
    if (sustained < need)
      return {
        status: 'clear',
        title: bal.value.direction === 'filling' ? `${b.buf.name}: inflow above outflow` : bal.value.direction === 'balanced' ? `${b.buf.name}: flows balanced` : `${b.buf.name}: draining, not sustained`,
        explanation: `${head} (${bal.value.direction === 'balanced' ? `within the ±${num(deadband, d)} ${unit} deadband` : bal.value.direction}).${sustained ? ` The outflow has exceeded the inflow for the last ${sustained} min — reported after ${num(need)} min.` : ''}${levelText}${notes}`,
        measurements,
        window: win,
        evidence,
        next: null,
        chartRef: CHART.buffer(b.level),
        subject: b.buf.id,
      };
    const from = ctx.now - sustained;
    // Still draining now? The newest block can straddle a restart of the stage filling the buffer.
    const nowW = recentOf(ctx, b, win);
    const inNow = sideOver(ctx, f.inflow, nowW).v;
    const outNow = sideOver(ctx, f.outflow, nowW).v;
    if (inNow != null && outNow != null) measurements.push({ label: 'Inflow (recent)', value: round(inNow, d), unit, window: nowW }, { label: 'Outflow (recent)', value: round(outNow, d), unit, window: nowW });
    if (inNow != null && outNow != null && inNow - outNow >= -deadband)
      return {
        status: 'clear',
        title: `${b.buf.name}: inflow recovered`,
        explanation: `${head}. The outflow exceeded the inflow by more than the ${num(deadband, d)} ${unit} deadband in every ${B}-min block from ${clock(from)} (${sustained} min), but over the last ${nowW.to - nowW.from} min (${span(nowW)}) ${upWho} put in ${num(inNow, d)} ${unit} against ${num(outNow, d)} ${unit} drawn — no longer draining, so not reported.${levelText}${notes}`,
        measurements,
        window: win,
        evidence,
        next: null,
        chartRef: CHART.buffer(b.level),
        subject: b.buf.id,
      };
    const ups = b.up!.machines.map((m) => machineWindow(ctx, m, win));
    // The deficit of the sustained period (the window as a whole can still be net filling).
    const susW = { from, to: ctx.now };
    const inS = sideOver(ctx, f.inflow, susW).v;
    const outS = sideOver(ctx, f.outflow, susW).v;
    const deficit = inS != null && outS != null ? outS - inS : -bal.value.net;
    measurements.push({ label: 'Net flow over the sustained period', value: round(-deficit, d), unit, window: susW });
    const susText = inS != null && outS != null ? `: ${num(inS, d)} ${unit} in against ${num(outS, d)} ${unit} out (net ${signed(-deficit, d, unit)})` : '';
    // The stage filling the buffer in a planned stop / changeover: a planned drawdown, at most a warning (whether the
    // buffer covers it is F-BUFFER-TREND's time to empty).
    const planned = plannedNow(ups);
    return {
      status: 'fired',
      severity: !b.ahead ? 'info' : b.feedsKiln && !planned ? 'serious' : 'warning',
      title: `${b.buf.name}: inflow below outflow by ${num(deficit, d)} ${unit}`,
      explanation: `${head}. The outflow has exceeded the inflow by more than the ${num(deadband, d)} ${unit} deadband (${pct(share)} of the planned draw) in every ${B}-min block since ${clock(from)} (${sustained} min)${susText}.${levelText} ${cap(upWho)}: ${statesOf(ups)}. ${b.ahead ? `Ahead of the kiln this drains the buffer until ${downWho} runs short${b.feedsKiln ? ' — the kiln, the line constraint' : ''}.` : 'Behind the kiln a draining buffer is normal balancing: the stages after the kiln are faster.'}${notes}`,
      measurements,
      window: win,
      evidence: [...evidence, ...eventEvidence(ctx, b.up!.machines, win)],
      next: !b.ahead
        ? null
        : planned
          ? `${cap(plannedWords(planned))} — a planned drawdown: check that ${bufferWords(b)} ${covers(b)} the rest of the stop (time to empty: F-BUFFER-TREND), or slow ${downWho} down in a controlled way.`
          : `Restore the output of ${upWho} (${num(inS ?? inW.v, d)} against ${num(outS ?? outW.v, d)} ${unit} drawn since ${clock(from)}) before ${bufferWords(b)} ${runs(b)} empty, or plan a controlled slow-down of ${downWho}.`,
      firstSeen: from,
      chartRef: CHART.buffer(b.level),
      subject: b.buf.id,
    };
  },
};

// ── Shared thresholds of the starvation / blockage rules ─────────────────────

const isConstraint = (id: string) => OPS_BY_ID[id]?.stage === LINE.designConstraint;

/** What "below rate" means (mirrors R-RATE). */
const shareParam: RuleParam = {
  key: 'rateShare',
  label: 'Below rate under',
  unit: '% of the planned rate',
  scale: 100,
  default: DEFAULT_EVENT_RULES.belowRateFactor,
  min: 0.3,
  max: 1,
  step: 0.01,
  hint: 'A stage counts as below rate under this share of its planned rate (ideal, capped at the line pace set by the kiln); follows the event rule R-RATE unless set here.',
  mirrors: { rule: 'belowRateFactor' },
};
/** How long a machine must be short of material (mirrors R-STARVE). */
const waitParam: RuleParam = {
  key: 'waitMin',
  label: 'Short of material for at least',
  unit: 'min',
  default: DEFAULT_EVENT_RULES.starvedMinutes,
  min: 3,
  max: 120,
  step: 1,
  hint: 'Minutes waiting for material, or below rate, with the feeding buffer low, in the window; follows the event rule R-STARVE unless set here.',
  mirrors: { rule: 'starvedMinutes' },
};
const waitKilnParam: RuleParam = {
  key: 'waitMinConstraint',
  label: 'At the kiln, for at least',
  unit: 'min',
  default: DEFAULT_EVENT_RULES.starvedMinutesConstraint,
  min: 1,
  max: 60,
  step: 1,
  hint: 'The same at the kiln (line constraint); follows the event rule R-STARVE at the constraint unless set here.',
  mirrors: { rule: 'starvedMinutesConstraint' },
};
/** A below-rate minute with the output buffer this full was held at the discharge (as P-OUTPUT's full level). */
const OUTPUT_FULL_PCT = 90;

// ── F-STARVE · starvation through a low buffer ───────────────────────────────

const STARVE_ID = 'F-STARVE';

const F_STARVE: RuleDef = {
  id: STARVE_ID,
  family: 'flow',
  classification: 'rule-based',
  title: 'Potential starvation',
  description:
    'A machine short of material — waiting (starved) or below its planned rate — while the buffer feeding it is low: potential starvation through that buffer, naming the buffer and the stage filling it (producing less than the draw, held itself, or stopped). A machine whose transfer conveyor is stopped, or that waits with a stocked buffer, is not this rule.',
  appliesTo: (scope) => {
    const id = idOf(scope);
    const b = inputBufferOf(id);
    return !!b?.up && plannedRateOf(id) != null && inCatalog(stateSignalOf(id)) && inCatalog(`${id}.rate`) && inCatalog(b.level);
  },
  requiredSignals: (scope) => [inputBufferOf(idOf(scope))!.level, stateSignalOf(idOf(scope)), `${idOf(scope)}.rate`],
  optionalSignals: (scope) => {
    const id = idOf(scope);
    const b = inputBufferOf(id)!;
    const out = outputBufferOf(id)?.level;
    return [...b.up!.machines.flatMap((m) => [stateSignalOf(m), `${m}.rate`]), ...b.transfer.map((c) => stateSignalOf(c.id)), ...(out ? [out] : [])].filter(inCatalog);
  },
  params: [
    { key: 'windowMin', label: 'Window', unit: 'min', default: 30, min: 10, max: 240, step: 5, hint: 'Minutes short of material are counted over this trailing window.' },
    { key: 'lowPct', label: 'Buffer low at', unit: '%', default: 10, min: 0, max: 50, step: 1, hint: 'The feeding buffer counts as low at or below this level (the KPI band’s "nearly empty").' },
    waitParam,
    waitKilnParam,
    shareParam,
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const b = inputBufferOf(id)!;
    const W = Math.round(ctx.param(STARVE_ID, 'windowMin', id));
    const lowPct = ctx.param(STARVE_ID, 'lowPct', id);
    const need = ctx.param(STARVE_ID, isConstraint(id) ? 'waitMinConstraint' : 'waitMin', id);
    const share = ctx.param(STARVE_ID, 'rateShare', id);
    const win = ctx.window(W);
    const m = machineWindow(ctx, id, win);
    const plan = plannedRateOf(id)!;
    const limit = plan.rate * share;
    const unit = m.unit;
    const level = valueNow(ctx, b.level);
    const inAt = levelsAt(ctx, b.level, win);
    const outBuf = outputBufferOf(id);
    const outAt = outBuf ? levelsAt(ctx, outBuf.level, win) : null;
    const lowSince = trailingRunStart((t) => {
      const v = inAt.get(t);
      return v != null && v <= lowPct;
    }, win.from, ctx.now);
    const low = level != null && level <= lowPct;
    const short = low ? shortMinutes(m, lowSince ?? win.from, win.to, inAt, lowPct, limit, outAt, OUTPUT_FULL_PCT) : { n: 0, first: null, last: null };
    const measurements: Measurement[] = [
      { signalId: stateSignalOf(id), label: 'Waiting for material', value: m.waitMin, unit: 'min', window: win },
      { signalId: `${id}.rate`, label: 'Rate over production time', value: m.prodRate != null ? Math.round(m.prodRate) : null, unit, window: win },
      { label: 'Below-rate limit', value: Math.round(limit), unit },
      { signalId: b.level, label: `${b.buf.name} level`, value: level != null ? round(level, 1) : null, unit: '%', at: ctx.now - 1 },
      { label: 'Short of material with the buffer low', value: short.n, unit: 'min', window: win },
    ];
    const evidence: Evidence[] = [
      { kind: 'signal', label: signalName(stateSignalOf(id)), ref: stateSignalOf(id), window: win },
      { kind: 'signal', label: signalName(`${id}.rate`), ref: `${id}.rate`, window: win },
      ...levelEvidence(b, win),
    ];
    const ownText = `${id} waited ${m.waitMin} min for material and made ${num(m.prodRate)} ${unit} over ${m.prodMin} min of production time in the last ${W} min (${span(win)}) — planned ${num(plan.rate)} ${unit}, below rate under ${num(limit)} ${unit} (${pct(share)})`;
    const levelText = `${bufferWords(b)} ${is(b)} at ${num(level, 1)} %`;
    if (!low) {
      const cut = stoppedTransfer(ctx, b, win);
      const waited = m.waitMin >= need || (m.prodRate != null && m.prodRate < limit && m.prodMin >= need);
      return {
        status: 'clear',
        title: waited ? `${equipmentName(id)}: waiting, but not on an empty buffer` : `${equipmentName(id)}: not short of material`,
        explanation: `${ownText}. ${cap(levelText)} — above the ${num(lowPct)} % low level${waited ? ', so the wait is not the buffer running empty' : ''}.${waited && cut.length ? ` ${list(cut.map((x) => `${x.c.id} (${x.c.name})`))} ${cut.length === 1 ? 'is' : 'are'} ${machineWords(cut[0].m)}: the transfer is cut (conveyor stop rule).` : ''}${bulkNote(b)}`,
        measurements,
        window: win,
        evidence: [...evidence, ...eventEvidence(ctx, cut.map((x) => x.c.id), win)],
        next: null,
        subject: b.buf.id,
      };
    }
    if (short.n < need)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: not short of material`,
        explanation: `${ownText}. ${cap(levelText)} (at or below ${num(lowPct)} %${lowSince != null ? ` since ${clock(lowSince)}` : ''}), but ${id} was short of material for only ${short.n} min with it low — reported from ${num(need)} min.${b.ahead ? '' : ' Behind the kiln a low buffer is normal.'}${bulkNote(b)}`,
        measurements,
        window: win,
        evidence,
        next: null,
        subject: b.buf.id,
      };
    // Still short now? A starvation that ended (the supply caught up) is not reported for the rest of the window.
    const nowW = recentOf(ctx, b, win);
    if (short.last == null || short.last < nowW.from)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: starvation ended`,
        explanation: `${ownText}; ${short.n} of those minutes short of material while ${levelText} (at or below ${num(lowPct)} %${lowSince != null ? ` since ${clock(lowSince)}` : ''}), the last at ${clock(short.last ?? win.from)} — none in the last ${nowW.to - nowW.from} min (${span(nowW)}; ${id} ${machineWords(m)}), so the starvation is not reported now.${bulkNote(b)}`,
        measurements,
        window: win,
        evidence,
        next: null,
        resolvedAt: short.last != null ? short.last + 1 : null,
        subject: b.buf.id,
      };
    const up = b.up!;
    const ups = up.machines.map((u) => machineWindow(ctx, u, win));
    const upUnit = stageUnit(up);
    const upRate = stageRate(ups);
    const draw = stagePlanned(b.down!);
    const stopped = ups.filter((u) => u.stop);
    const producing = ups.some((u) => !u.stop && (u.rate ?? 0) > 0);
    const heldUpstream = ups.every((u) => u.now != null && WAITING.has(u.now));
    const upBuffer = up.inputBuffer ? (BY_BUFFER.get(up.inputBuffer) ?? null) : null;
    measurements.push({ label: `${up.name} output`, value: upRate != null ? Math.round(upRate) : null, unit: upUnit, window: win });
    const upEnded = endedStops(ups, win);
    const upText = heldUpstream
      ? `${cap(stageWho(up))} is itself waiting for material (${statesOf(ups)}): the line is held further upstream`
      : producing
        ? `${cap(stageWho(up))} is producing ${num(upRate)} ${upUnit} over the window (${statesOf(ups)}${upEnded.length ? `; earlier in the window ${list(upEnded)}` : ''}) — less than the ${num(draw)} ${upUnit} ${stageWho(b.down!)} is planned to draw`
        : `${cap(stageWho(up))} is not producing: ${statesOf(ups)}`;
    const why = isConstraint(id)
      ? 'The kiln is the line constraint: every minute it waits is line output lost.'
      : b.ahead
        ? `${equipmentName(id)} works ahead of the kiln: if the starvation lasts, the buffers towards the kiln run down and the kiln (line constraint) loses output.`
        : `${equipmentName(id)} works downstream of the kiln and can only process what the kiln fires: waiting here loses no line output.`;
    const upPlanned = plannedNow(ups);
    const next =
      !producing && stopped.length && upPlanned
        ? `${cap(plannedWords(upPlanned))}: check that it restarts on schedule${isConstraint(id) ? ' — every minute counts at the kiln' : ''}, and plan such stops so that ${bufferWords(b)} ${covers(b)} them.`
        : !producing && stopped.length
          ? `Restore ${list(stopped.map((u) => u.id))} first (${stopped[0].stop!.reasonLabel} since ${clock(stopped[0].stop!.start)}) — see its stop event${isConstraint(id) ? '; every minute counts at the kiln' : b.ahead ? '; keep the buffers ahead of the kiln stocked' : ''}.`
          : heldUpstream
            ? `Follow the line upstream of ${stageWho(up)}${upBuffer ? ` (${upBuffer.level})` : ''} to the stage that holds it.`
            : `Check the output of ${stageWho(up)} — ${num(upRate)} against ${num(draw)} ${upUnit} drawn: its rate setpoint and short stops${upBuffer ? `, and its own supply (${upBuffer.level})` : ''}; keep ${bufferWords(b)} stocked.`;
    return {
      status: 'fired',
      severity: isConstraint(id) ? 'serious' : b.ahead ? 'warning' : 'info',
      title: `Potential starvation of ${equipmentName(id)} — ${lowerFirst(b.buf.name)} low`,
      explanation: `${ownText}; ${short.n} of those minutes short of material (waiting, or below rate) while ${levelText} — at or below ${num(lowPct)} %${lowSince != null ? ` since ${clock(lowSince)}` : ''}. ${upText}. ${why} Inferred from the state, rate and level signals — the upstream supply is the likely source, to investigate.${bulkNote(b)}`,
      measurements,
      window: win,
      evidence: [...evidence, ...up.machines.map((u): Evidence => ({ kind: 'signal', label: `${u} output rate`, ref: `${u}.rate`, window: win })), ...eventEvidence(ctx, up.machines, win)],
      next,
      firstSeen: short.first ?? lowSince ?? win.from,
      chartRef: CHART.buffer(b.level),
      subject: b.buf.id,
    };
  },
};

// ── F-BLOCK · blockage through a rising / full buffer ────────────────────────

const BLOCK_ID = 'F-BLOCK';

const F_BLOCK: RuleDef = {
  id: BLOCK_ID,
  family: 'flow',
  classification: 'rule-based',
  title: 'Potential blockage',
  description:
    'A machine still producing while the stage it feeds (or the transfer conveyor) is stopped or below rate and the buffer between is rising — or, behind the kiln, high: potential blockage through that buffer. Ahead of the kiln a full buffer alone is normal balancing (the machine has spare capacity), not this rule.',
  appliesTo: (scope) => {
    const id = idOf(scope);
    const b = outputBufferOf(id);
    return !!b?.down && plannedRateOf(id) != null && inCatalog(stateSignalOf(id)) && inCatalog(`${id}.rate`) && inCatalog(b.level);
  },
  requiredSignals: (scope) => {
    const b = outputBufferOf(idOf(scope))!;
    return [b.level, stateSignalOf(idOf(scope)), `${idOf(scope)}.rate`, ...b.down!.machines.flatMap((m) => [stateSignalOf(m), `${m}.rate`])];
  },
  optionalSignals: (scope) => outputBufferOf(idOf(scope))!.transfer.map((c) => stateSignalOf(c.id)).filter(inCatalog),
  params: [
    { key: 'windowMin', label: 'Window', unit: 'min', default: 30, min: 10, max: 240, step: 5, hint: 'The downstream rate and the level trend are read over this trailing window.' },
    { key: 'highPct', label: 'Behind the kiln, buffer high at', unit: '%', default: 90, min: 50, max: 100, step: 1, hint: 'Behind the kiln the receiving buffer counts as high at or above this level (the KPI band’s "nearly full").' },
    shareParam,
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const b = outputBufferOf(id)!;
    const W = Math.round(ctx.param(BLOCK_ID, 'windowMin', id));
    const highPct = ctx.param(BLOCK_ID, 'highPct', id);
    const share = ctx.param(BLOCK_ID, 'rateShare', id);
    const thr = trendLimit(ctx, b);
    const win = ctx.window(W);
    const m = machineWindow(ctx, id, win);
    const unit = m.unit;
    const down = b.down!;
    const downs = down.machines.map((d) => machineWindow(ctx, d, win));
    const downUnit = stageUnit(down);
    const downRate = stageRate(downs);
    const downPlanned = stagePlanned(down);
    const downLimit = downPlanned * share;
    const cut = stoppedTransfer(ctx, b, win);
    const downStopped = downs.filter((d) => d.stop);
    // "Now": the take-away stopped now, or below rate over the recent window (a restarted stage is drawing again).
    const nowW = recentOf(ctx, b, win);
    const downNow = stageRateOver(downs, nowW);
    const downRef = downNow ?? downRate;
    const slowed = downStopped.length > 0 || cut.length > 0 || (downRef != null && downRef < downLimit);
    const level = valueNow(ctx, b.level);
    const trend = levelTrend(ctx, b.level, win);
    if (!trend.ok) return shortHistory(BLOCK_ID, b.level, 'a level trend', `${trend.n} usable minute samples in the last ${W} min — ${lowerFirst(trend.reason)}`);
    const rising = trend.slope >= thr && trendNow(ctx, b, win, trend.slope, level ?? (trend.last.v as number), thr).holds;
    const high = level != null && level >= highPct;
    const measurements: Measurement[] = [
      { signalId: `${id}.rate`, label: 'Own rate', value: m.rate != null ? Math.round(m.rate) : null, unit, window: win },
      { label: `${down.name} rate`, value: downRate != null ? Math.round(downRate) : null, unit: downUnit, window: win },
      { label: `${down.name} rate (recent)`, value: downNow != null ? Math.round(downNow) : null, unit: downUnit, window: nowW },
      { label: `${down.name} below-rate limit`, value: Math.round(downLimit), unit: downUnit },
      { signalId: b.level, label: `${b.buf.name} level`, value: level != null ? round(level, 1) : null, unit: '%', at: ctx.now - 1 },
      { signalId: b.level, label: 'Level trend', value: round(trend.slope, 1), unit: '%/h', window: win },
    ];
    const evidence: Evidence[] = [
      { kind: 'signal', label: signalName(stateSignalOf(id)), ref: stateSignalOf(id), window: win },
      ...down.machines.map((d): Evidence => ({ kind: 'signal', label: `${d} output rate`, ref: `${d}.rate`, window: win })),
      ...levelEvidence(b, win),
    ];
    const levelText = `${bufferWords(b)} ${is(b)} at ${num(level, 1)} %, trend ${signed(trend.slope, 1, '%/h')} over the last ${W} min (${span(win)})`;
    const downText = `${stageWho(down)} made ${num(downRate)} ${downUnit} over the window${downNow != null ? ` (${num(downNow)} over the last ${nowW.to - nowW.from} min)` : ''} — below-rate limit ${num(downLimit)} ${downUnit}, ${pct(share)} of the planned ${num(downPlanned)} (${statesOf(downs)}${cut.length ? `; the transfer ${list(cut.map((x) => x.c.id))} ${machineWords(cut[0].m)}` : ''})`;
    if (m.stop)
      return {
        status: 'clear',
        title: `${equipmentName(id)} stopped itself`,
        explanation: `${id} is ${machineWords(m)} — it is not producing, so it is not held up by the line. ${cap(levelText)}.${bulkNote(b)}`,
        measurements,
        window: win,
        evidence,
        next: null,
        subject: b.buf.id,
      };
    if (!slowed || !(rising || (!b.ahead && high)))
      return {
        status: 'clear',
        title: `${equipmentName(id)}: no blockage building`,
        explanation: `${cap(downText)}. ${cap(levelText)}.${
          !slowed
            ? downRate != null && downRate < downLimit
              ? ` ${cap(stageWho(down))} is drawing again: ${num(downNow)} ${downUnit} over the last ${nowW.to - nowW.from} min (${span(nowW)}).`
              : ' The stage it feeds keeps drawing.'
            : b.ahead && high
              ? ` Full is normal ahead of the kiln: ${id} has spare capacity and is paced by ${stageWho(down)} — the loss is there, not here.`
              : ` The buffer is not rising faster than ${num(thr, 1)} %/h now${b.ahead ? '' : ` nor at or above ${num(highPct)} %`}.`
        }${bulkNote(b)}`,
        measurements,
        window: win,
        evidence,
        next: null,
        subject: b.buf.id,
      };
    const fullAt = trend.slope > 0 ? timeToFull(level, trend.slope, 100) : null;
    const fullMin = fullAt?.status === 'ok' ? fullAt.value : null;
    if (fullMin != null) measurements.push({ label: 'Time to full at this trend', value: Math.round(fullMin), unit: 'min' });
    const heldDownstream = downs.every((d) => d.now === 'blocked');
    const downBuffer = OUTPUT_BUFFER[down.id] ? (BY_BUFFER.get(OUTPUT_BUFFER[down.id]!) ?? null) : null;
    const why = isConstraint(id)
      ? 'This is the kiln, the line constraint: once its outfeed is full the kiln is held back and line output is lost.'
      : b.ahead
        ? `${equipmentName(id)} works ahead of the kiln with spare capacity: no line output is lost while it waits — ${heldDownstream ? 'the line is held further downstream' : `the loss is at ${stageWho(down)}`}.`
        : 'Behind the kiln the blockage moves upstream towards the kiln as the buffers fill.';
    const downPlannedNow = plannedNow(downs);
    const next = isConstraint(id)
      ? `Check the sorting line downstream of the kiln (${list([...b.transfer.map((c) => c.id), ...down.machines])}; ${b.level}): a slower sorting line fills the kiln outfeed and then holds the kiln back.`
      : downStopped.length && !cut.length && downPlannedNow
        ? `${cap(plannedWords(downPlannedNow))}: ${id} waits until it restarts — check that the stop ends on schedule${b.ahead ? '' : ', before the blockage reaches the kiln'}.`
        : downStopped.length || cut.length
          ? `Restore the take-away at ${list([...downStopped.map((d) => d.id), ...cut.map((x) => x.c.id)])} (${(downStopped[0]?.stop ?? cut[0]?.m.stop)!.reasonLabel})${b.ahead ? '' : ' before the blockage reaches the kiln'} — see its stop event.`
          : heldDownstream
            ? `${cap(stageWho(down))} is itself blocked: follow the line downstream${downBuffer ? ` (${downBuffer.level})` : ''} to the stage that holds it.`
            : `Check why ${stageWho(down)} runs below rate (${num(downRate)} against ${num(downPlanned)} ${downUnit} planned): its speed setpoint, short stops and its own take-away${downBuffer ? ` (${downBuffer.level})` : ''}.`;
    return {
      status: 'fired',
      severity: isConstraint(id) ? 'serious' : b.ahead ? 'info' : 'warning',
      title: `${m.now === 'blocked' ? 'Blockage' : 'Potential blockage'} of ${equipmentName(id)} — ${lowerFirst(b.buf.name)} ${level != null && level >= 100 - BOUND_PCT ? 'full' : rising ? 'filling' : 'high'}`,
      explanation: `${id} (${machineWords(m)}) made ${num(m.rate)} ${unit} over the window while ${downText}. ${cap(levelText)}${fullMin != null && fullMin > 0 ? ` — full in ≈ ${duration(fullMin)} at this trend (linear extrapolation, not a forecast)` : ''}. ${why} Inferred from the state, rate and level signals — the downstream take-away is the likely source, to investigate.${bulkNote(b)}`,
      measurements,
      window: win,
      evidence: [...evidence, ...eventEvidence(ctx, [...down.machines, ...b.transfer.map((c) => c.id)], win)],
      next,
      firstSeen: rising ? trend.minAt : win.from,
      chartRef: CHART.buffer(b.level),
      subject: b.buf.id,
    };
  },
};

// ── F-POWDER-STARVATION · spray dryer → powder silos → presses ───────────────

const POWDER_ID = 'F-POWDER-STARVATION';

/** Start of the trailing run of `blockMin` blocks whose mean is below `limit` (null when the newest one is not). */
function belowSince(samples: Sample[], win: Window, blockMin: number, limit: number): number | null {
  let since: number | null = null;
  for (let to = win.to; to - blockMin >= win.from; to -= blockMin) {
    const vals = samples
      .filter((x) => x.t >= to - blockMin && x.t < to)
      .map(usableValue)
      .filter((v): v is number => v != null);
    if (!vals.length || vals.reduce((a, v) => a + v, 0) / vals.length >= limit) break;
    since = to - blockMin;
  }
  return since;
}

const F_POWDER_STARVATION: RuleDef = {
  id: POWDER_ID,
  family: 'flow',
  classification: 'rule-based',
  title: 'Potential press starvation',
  description:
    'The brief’s powder chain, in one window: spray dryer powder output below normal (powder_flow, t/h), the powder silo level falling or low, and presses short of powder (waiting, or below rate with the silo low). All three are required, each with its own start time in the explanation. An association in time across the chain — to investigate, not a confirmed cause.',
  appliesTo: (scope) =>
    !!POWDER_SILO?.up && scope.kind === 'equipment' && scope.equipmentId === POWDER_SILO.holder && POWDER_SILO.up.machines.every((m) => massFlowOf(m) != null) && inCatalog(POWDER_SILO.level),
  requiredSignals: () => {
    const b = POWDER_SILO!;
    return [...b.up!.machines.map((m) => massFlowOf(m)!), b.level, ...b.down!.machines.flatMap((p) => [stateSignalOf(p), `${p}.rate`])];
  },
  optionalSignals: () => [outputBufferOf(POWDER_SILO!.down!.machines[0])?.level].filter((x): x is string => !!x && inCatalog(x)),
  params: [
    { key: 'windowMin', label: 'Window', unit: 'min', default: 60, min: 20, max: 480, step: 10, hint: 'The three conditions are read over the same trailing window.' },
    {
      key: 'normalShare',
      label: 'Powder output below',
      unit: '% of the planned output',
      scale: 100,
      default: DEFAULT_EVENT_RULES.belowRateFactor,
      min: 0.3,
      max: 1,
      step: 0.01,
      hint: 'Spray dryer output counts as below normal under this share of its planned output (its ideal, capped at the line pace); follows the event rule R-RATE unless set here.',
      mirrors: { rule: 'belowRateFactor' },
    },
    { key: 'lowPct', label: 'Silo low at', unit: '%', default: 10, min: 0, max: 50, step: 1, hint: 'A silo level at or below this (and not refilling) counts with a falling one; presses count as short of powder only with the silo this low.' },
    { ...waitParam, label: 'Presses short of powder for at least', hint: 'Minutes a press waited for powder, or ran below rate, with the silo low, in the window; follows R-STARVE unless set here.' },
  ],
  evaluate: (ctx) => {
    const b = POWDER_SILO!;
    const id = b.holder;
    const W = Math.round(ctx.param(POWDER_ID, 'windowMin', id));
    const share = ctx.param(POWDER_ID, 'normalShare', id);
    const lowPct = ctx.param(POWDER_ID, 'lowPct', id);
    const need = ctx.param(POWDER_ID, 'waitMin', id);
    const thr = trendLimit(ctx, b);
    const win = ctx.window(W);
    const towers = b.up!.machines;
    const presses = b.down!.machines;
    const flowSigs = towers.map((t) => massFlowOf(t)!);
    // 1 · Spray dryer powder output against its planned output (t/h, the same simulated conversion as the signal).
    const flows = flowSigs.map((sig) => new Map(ctx.samples(sig, win).map((x) => [x.t, usableValue(x)])));
    const flowSum: Sample[] = [];
    for (let t = win.from; t < win.to; t++) {
      const vals = flows.map((f) => f.get(t));
      const v = vals.every((x) => x != null) ? vals.reduce<number>((a, x) => a + (x as number), 0) : null;
      flowSum.push({ t, v, q: v == null ? 'missing' : 'good' });
    }
    const good = usableOf(flowSum);
    if (good.length < W * MIN_COVERAGE) return shortHistory(POWDER_ID, flowSigs[0], 'the powder chain', `${good.length} usable minute samples of ${W}`);
    const flowMean = good.reduce((a, x) => a + (x.v as number), 0) / good.length;
    const tPerTile = KG_PER_TILE / 1000;
    const planned = stagePlanned(b.up!) * tPerTile;
    const ideal = stageIdeal(b.up!) * tPerTile;
    const flowLimit = planned * share;
    // Below normal over the window and still in the newest 10-min block (a spray dryer that recovered is not this).
    const since1 = flowMean < flowLimit ? belowSince(flowSum, win, 10, flowLimit) : null;
    const item1 = since1 != null;
    // 2 · Powder silo level falling (faster than the trend threshold, and still) or low and not refilling.
    const trend = levelTrend(ctx, b.level, win);
    if (!trend.ok) return shortHistory(POWDER_ID, b.level, 'the powder chain', `${trend.n} usable minute samples in the last ${W} min — ${lowerFirst(trend.reason)}`);
    const level = valueNow(ctx, b.level) ?? (trend.last.v as number);
    const falling = trend.slope <= -thr && trendNow(ctx, b, win, trend.slope, level, thr).holds;
    const lowNow = level <= lowPct && trend.slope < thr;
    const item2 = falling || lowNow;
    const lvAt = new Map(trend.samples.map((x) => [x.t, x.v]));
    const lowSince = trailingRunStart((t) => (lvAt.get(t) ?? Infinity) <= lowPct, win.from, ctx.now);
    const since2 = item2 ? (falling ? trend.maxAt : (lowSince ?? win.from)) : null;
    // 3 · Presses short of powder, minute by minute, with the silo low that minute.
    const outBuf = outputBufferOf(presses[0]);
    const outAt = outBuf ? levelsAt(ctx, outBuf.level, win) : null;
    const pressRows = presses.map((p) => {
      const mw = machineWindow(ctx, p, win);
      const limit = plannedRateOf(p)!.rate * share;
      return { p, limit, ...shortMinutes(mw, win.from, win.to, lvAt, lowPct, limit, outAt, OUTPUT_FULL_PCT) };
    });
    // Short of powder for the minimum time in the window, and still in the recent window.
    const nowW = recentOf(ctx, b, win);
    const shortPresses = pressRows.filter((r) => r.n >= need && r.last != null && r.last >= nowW.from);
    const item3 = shortPresses.length > 0;
    const since3 = item3 ? Math.min(...shortPresses.map((r) => r.first ?? win.from)) : null;
    const pressUnit = signalUnit(`${presses[0]}.rate`) ?? 'tiles/h';
    const measurements: Measurement[] = [
      { signalId: flowSigs[0], label: 'Spray dryer powder output (mean)', value: round(flowMean, 1), unit: 't/h', window: win },
      { label: 'Below-normal limit', value: round(flowLimit, 1), unit: 't/h' },
      { signalId: b.level, label: 'Powder silo level now', value: round(level, 1), unit: '%', at: trend.last.t },
      { signalId: b.level, label: 'Powder silo level trend', value: round(trend.slope, 1), unit: '%/h', window: win },
      ...pressRows.map((r): Measurement => ({ signalId: stateSignalOf(r.p), label: `${r.p} short of powder`, value: r.n, unit: 'min', window: win })),
      { label: 'Powder in the silos', value: null, unit: null },
    ];
    const evidence: Evidence[] = [
      ...flowSigs.map((sig): Evidence => ({ kind: 'signal', label: `1 · ${signalName(sig)} (spray dryer)`, ref: sig, window: since1 != null ? { from: since1, to: ctx.now } : win })),
      { kind: 'signal', label: '2 · Powder silo level', ref: b.level, window: since2 != null ? { from: since2, to: ctx.now } : win },
      ...pressRows.map((r): Evidence => ({ kind: 'signal', label: `3 · ${r.p} state`, ref: stateSignalOf(r.p), window: r.first != null && r.n >= need ? { from: r.first, to: ctx.now } : win })),
      { kind: 'chart', label: 'Powder silo level', ref: CHART.buffer(b.level), window: win },
    ];
    const limitText = `the ${num(flowLimit, 1)} t/h limit (${pct(share)} of its planned ${num(planned, 1)} t/h; ideal ${num(ideal, 1)} t/h)`;
    const t1 = `(1) Spray dryer: ${list(flowSigs)} averaged ${num(flowMean, 1)} t/h over ${span(win)} — ${
      item1 ? `below ${limitText}, below since ${clock(since1!)}` : flowMean < flowLimit ? `below ${limitText} on average, but not over the last 10 min (recovered)` : `not below ${limitText}`
    }.`;
    const t2 = `(2) Powder silos: ${b.level} ${num(trend.first.v, 1)} % at ${clock(trend.first.t)} → ${num(level, 1)} % at ${clock(trend.last.t)}, trend ${signed(trend.slope, 1, '%/h')} — ${falling ? `falling faster than ${num(thr, 1)} %/h` : lowNow ? `low (at or below ${num(lowPct)} %)` : 'neither falling nor low'}${since2 != null ? ` since ${clock(since2)}` : ''}.`;
    const t3 = `(3) Presses: ${list(pressRows.map((r) => `${r.p} short of powder ${r.n} min${r.first != null ? ` from ${clock(r.first)}` : ''}`))} (waiting, or below ${num(pressRows[0].limit)} ${pressUnit}, with the silo at or below ${num(lowPct)} %; reported from ${num(need)} min).`;
    const items = `${t1} ${t2} ${t3}`;
    const units = ` Powder flows are simulated mass flows (tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg per tile-equivalent, KG_PER_TILE).${bulkNote(b)}`;
    if (!(item1 && item2 && item3)) {
      const held = [item1 ? 'spray dryer output below normal' : '', item2 ? 'silo falling / low' : '', item3 ? 'presses short of powder' : ''].filter(Boolean);
      return {
        status: 'clear',
        title: 'Presses not starved of powder',
        explanation: `The chain needs all three in the same window (${span(win)}); ${held.length ? `only ${list(held)} ${held.length === 1 ? 'holds' : 'hold'}` : 'none holds'}. ${items}${units}`,
        measurements,
        window: win,
        evidence,
        next: null,
        chartRef: CHART.buffer(b.level),
      };
    }
    const firstSeen = Math.max(since1 ?? win.from, since2 ?? win.from, since3 ?? win.from);
    const towerRows = towers.map((t) => machineWindow(ctx, t, win));
    const slip = b.up!.inputBuffer ? BY_BUFFER.get(b.up!.inputBuffer)?.level : undefined;
    return {
      status: 'fired',
      severity: 'warning',
      title: 'Potential press starvation',
      explanation: `All three conditions of the powder chain hold in the same window (${span(win)}), together since ${clock(firstSeen)}: ${items} Spray dryer: ${statesOf(towerRows)}. The presses work ahead of the kiln: if they stay short, the buffers towards the kiln run down and the kiln (line constraint) loses output. An association in time across the chain — the powder supply is the likely source, to investigate.${units}`,
      measurements,
      window: win,
      evidence: [...evidence, ...eventEvidence(ctx, [...towers, ...presses], win)],
      next: `Check the spray dryer (${list(towers)}): its powder output ${num(flowMean, 1)} t/h against ${num(planned, 1)} t/h planned — burner, atomiser and slip feed${slip ? ` (${slip})` : ''}; until the silos refill, match the press load to the powder available.`,
      firstSeen,
      chartRef: CHART.buffer(b.level),
    };
  },
};

// ── F-DOWNSTREAM-CONSTRAINT · sorting → kiln outfeed → kiln (stage 8) ────────

const CONSTRAINT_ID = 'F-DOWNSTREAM-CONSTRAINT';

/** Stage 8 of the brief in this line, and why the polishing example is expressed with sorting. */
const STAGE8_NOTE =
  'In this representative line the cooling-buffer stage (stage 8) is the kiln outfeed roller storage (BUF-KOUT, read by CV-SORT.outfeed_buffer_level) with the sorting-line roller conveyor (CV-SORT) — there is no dedicated cooling-buffer machine. The line has no polishing / rectification stage (stage 9), so the brief’s "polishing slowdown → cooling buffer fills" example is evaluated with the next stage that exists: a sorting-line slowdown → kiln outfeed fills → kiln limited by its outfeed.';

const F_DOWNSTREAM_CONSTRAINT: RuleDef = {
  id: CONSTRAINT_ID,
  family: 'flow',
  classification: 'rule-based',
  title: 'Possible downstream constraint at sorting',
  description:
    'Stage 8 (cooling buffer) as mapped in this line: the sorting line below its planned rate (or stopped), the kiln outfeed storage high or rising, and the kiln not in an own stop but below its ideal rate — the kiln held back by its outfeed. All three in the same window.',
  appliesTo: (scope) => !!KILN_OUTFEED?.down && scope.kind === 'equipment' && scope.equipmentId === KILN_OUTFEED.holder && inCatalog(KILN_OUTFEED.level),
  requiredSignals: () => {
    const b = KILN_OUTFEED!;
    return [b.level, ...b.down!.machines.flatMap((m) => [stateSignalOf(m), `${m}.rate`]), ...b.up!.machines.flatMap((m) => [stateSignalOf(m), `${m}.rate`])];
  },
  optionalSignals: () => KILN_OUTFEED!.transfer.map((c) => stateSignalOf(c.id)).filter(inCatalog),
  params: [
    { key: 'windowMin', label: 'Window', unit: 'min', default: 30, min: 10, max: 240, step: 5, hint: 'The three conditions are read over the same trailing window.' },
    { key: 'highPct', label: 'Kiln outfeed high at', unit: '%', default: 80, min: 30, max: 100, step: 1, hint: 'The kiln outfeed counts as high at or above this level (or when rising faster than the conveyor-accumulation trend threshold of F-BUFFER-TREND).' },
    shareParam,
  ],
  evaluate: (ctx) => {
    const b = KILN_OUTFEED!;
    const W = Math.round(ctx.param(CONSTRAINT_ID, 'windowMin', b.holder));
    const highPct = ctx.param(CONSTRAINT_ID, 'highPct', b.holder);
    const share = ctx.param(CONSTRAINT_ID, 'rateShare', b.holder);
    const thr = trendLimit(ctx, b);
    const win = ctx.window(W);
    const sort = b.down!;
    const kiln = b.up!;
    // 1 · Sorting below its planned rate, stopped, or its roller conveyor stopped.
    const sorts = sort.machines.map((m) => machineWindow(ctx, m, win));
    const sortRate = stageRate(sorts);
    const sortPlanned = stagePlanned(sort);
    const sortLimit = sortPlanned * share;
    const cut = stoppedTransfer(ctx, b, win);
    // Now: stopped now, or below rate over the recent window (a sorting line that restarted is drawing again).
    const nowW = recentOf(ctx, b, win);
    const sortNow = stageRateOver(sorts, nowW);
    const sortRef = sortNow ?? sortRate;
    const item1 = sorts.some((m) => m.stop) || cut.length > 0 || (sortRef != null && sortRef < sortLimit);
    // 2 · Kiln outfeed high, or rising (and still).
    const trend = levelTrend(ctx, b.level, win);
    if (!trend.ok) return shortHistory(CONSTRAINT_ID, b.level, 'the downstream-constraint check', `${trend.n} usable minute samples in the last ${W} min — ${lowerFirst(trend.reason)}`);
    const level = valueNow(ctx, b.level) ?? (trend.last.v as number);
    const risingNow = trend.slope >= thr && trendNow(ctx, b, win, trend.slope, level, thr).holds;
    const item2 = level >= highPct || risingNow;
    // 3 · Kiln not in an own stop (still firing, or held at its outfeed) but below its ideal.
    const kilns = kiln.machines.map((m) => machineWindow(ctx, m, win));
    const kilnRate = stageRate(kilns);
    const kilnIdeal = stageIdeal(kiln);
    const kilnLimit = kilnIdeal * share;
    const kilnStopped = kilns.filter((m) => m.stop);
    const item3 = kilnStopped.length === 0 && kilnRate != null && kilnRate < kilnLimit;
    const unit = stageUnit(sort);
    const kUnit = stageUnit(kiln);
    const measurements: Measurement[] = [
      { label: 'Sorting rate', value: sortRate != null ? Math.round(sortRate) : null, unit, window: win },
      { label: 'Sorting rate (recent)', value: sortNow != null ? Math.round(sortNow) : null, unit, window: nowW },
      { label: 'Sorting below-rate limit', value: Math.round(sortLimit), unit },
      { signalId: b.level, label: 'Kiln outfeed level now', value: round(level, 1), unit: '%', at: trend.last.t },
      { signalId: b.level, label: 'Kiln outfeed level trend', value: round(trend.slope, 1), unit: '%/h', window: win },
      { label: 'Kiln rate', value: kilnRate != null ? Math.round(kilnRate) : null, unit: kUnit, window: win },
      { label: 'Kiln ideal rate', value: Math.round(kilnIdeal), unit: kUnit },
    ];
    const evidence: Evidence[] = [
      ...sort.machines.map((m): Evidence => ({ kind: 'signal', label: `1 · ${m} output rate`, ref: `${m}.rate`, window: win })),
      { kind: 'signal', label: '2 · Kiln outfeed level', ref: b.level, window: win },
      ...kiln.machines.map((m): Evidence => ({ kind: 'signal', label: `3 · ${m} output rate`, ref: `${m}.rate`, window: win })),
      { kind: 'chart', label: 'Kiln outfeed level', ref: CHART.buffer(b.level), window: win },
    ];
    const t1 = `(1) Sorting line: ${list(sort.machines)} made ${num(sortRate)} ${unit} over ${span(win)}${sortNow != null ? ` (${num(sortNow)} over the last ${nowW.to - nowW.from} min)` : ''} — below-rate limit ${num(sortLimit)} ${unit}, ${pct(share)} of the planned ${num(sortPlanned)} (${statesOf(sorts)}${cut.length ? `; ${list(cut.map((x) => x.c.id))} ${machineWords(cut[0].m)}` : ''}).`;
    const t2 = `(2) Kiln outfeed: ${b.level} ${num(trend.first.v, 1)} % at ${clock(trend.first.t)} → ${num(level, 1)} % at ${clock(trend.last.t)}, trend ${signed(trend.slope, 1, '%/h')} (high from ${num(highPct)} %, rising from ${num(thr)} %/h).`;
    const t3 = `(3) Kiln: ${list(kiln.machines)} made ${num(kilnRate)} ${kUnit} over the window against its ideal ${num(kilnIdeal)} ${kUnit}, below-rate limit ${num(kilnLimit)} (${statesOf(kilns)}).`;
    const items = `${t1} ${t2} ${t3}`;
    if (!(item1 && item2 && item3)) {
      const held = [item1 ? 'sorting below rate' : '', item2 ? 'kiln outfeed high / rising' : '', item3 ? 'kiln below its ideal' : ''].filter(Boolean);
      return {
        status: 'clear',
        title: 'No downstream constraint at sorting',
        explanation: `${kilnStopped.length ? `The kiln is ${machineWords(kilnStopped[0])} itself — not held back by its outfeed. ` : ''}The check needs all three in the same window; ${held.length ? `only ${list(held)} ${held.length === 1 ? 'holds' : 'hold'}` : 'none holds'}. ${items} ${STAGE8_NOTE}`,
        measurements,
        window: win,
        evidence,
        next: null,
        chartRef: CHART.buffer(b.level),
      };
    }
    const lvAt = new Map(trend.samples.map((x) => [x.t, x.v as number]));
    const firstSeen = risingNow ? trend.minAt : (trailingRunStart((t) => (lvAt.get(t) ?? -Infinity) >= highPct, win.from, ctx.now) ?? win.from);
    return {
      status: 'fired',
      severity: 'serious',
      title: 'Possible downstream constraint at sorting',
      explanation: `The kiln is held back by its outfeed: ${items} The kiln is the line constraint, so the output it cannot fire is lost line output. ${STAGE8_NOTE} Inferred from rates, states and the outfeed level — the sorting line is the likely constraint, to investigate.`,
      measurements,
      window: win,
      evidence: [...evidence, ...eventEvidence(ctx, [...sort.machines, ...b.transfer.map((c) => c.id)], win)],
      next: `Check the sorting line (${list([...b.transfer.map((c) => c.id), ...sort.machines])}): ${num(sortRate)} against ${num(sortPlanned)} ${unit} planned — speed setpoint, short stops at the gauge, vision tunnel and diverters; restore it before the kiln outfeed (${b.level}) holds the kiln back further.`,
      firstSeen,
      chartRef: CHART.buffer(b.level),
    };
  },
};

/** The material-flow rules, in display order. */
export const FLOW_RULES: RuleDef[] = [F_BUFFER_TREND, F_BALANCE, F_STARVE, F_BLOCK, F_POWDER_STARVATION, F_DOWNSTREAM_CONSTRAINT];
