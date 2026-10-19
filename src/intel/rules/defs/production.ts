/**
 * Production rules (brief §7): output below target, press cycle time above target, a counter that does not
 * advance while the machine reports running, and a declining output rate. Every verdict is computed from the
 * signals through the rule context (counters with src/calc counterRate / counterDelta, states from the state
 * timeline) — never from the simulation's internal rates.
 *
 * P-OUTPUT / P-CYCLE / P-COUNTER are threshold rules ('rule-based'); P-DECLINE tests its regression slope with a
 * t statistic ('statistical'). The thresholds that the event engine also has (R-RATE: rate below 85 % of ideal for
 * 10 min; R-COUNTER: 3 min) mirror the configured event rules, so the two never contradict each other.
 *
 * Line balancing is not a production loss: stages next to the kiln carry spare capacity, so off the kiln the output
 * target is the line pace (plannedRateOf), time waiting on a neighbour is left to the flow rules, and a shortfall or
 * a decline while a neighbouring buffer is full / empty (its level signal) is reported as the line pacing the
 * machine. At the kiln — the line constraint — every lost minute counts.
 */
import { counterDelta, counterRate, deviationEpisodes, productionRate, stats, trendSlope, usableValue, varianceVsTarget, type Sample, type Window } from '../../../calc';
import { CONVEYOR_BY_ID, CONVEYORS, DEFAULT_EVENT_RULES, LINE, OPS_BY_ID, STAGES, STAGE_BY_ID } from '../../../model/plant';
import { OPERATIONAL_STATE_LABEL } from '../../../sim/metrics';
import type { RuleContext } from '../context';
import { CHART, type Evidence, type Measurement, type MissingSignal, type RuleDef, type RuleScope } from '../types';
import {
  NOT_SCHEDULED,
  RUNNING,
  buffersOf,
  clock,
  counterSignalOf,
  equipmentName,
  idealRateOf,
  inCatalog,
  isConveyor,
  list,
  minutesWhere,
  num,
  pct,
  peersOf,
  signalName,
  signalUnit,
  signedPct,
  slopeTest,
  span,
  stateLookup,
  stateSignalOf,
  trailingRunStart,
  type EquipmentState,
} from '../util';

// ── Shared ───────────────────────────────────────────────────────────────────

/** A process machine with an ideal rate whose counter and state signals the catalogue knows. */
const isMachine = (id: string) => idealRateOf(id) != null && !isConveyor(id) && inCatalog(counterSignalOf(id)) && inCatalog(stateSignalOf(id));
const machineOf = (scope: RuleScope) => (scope.kind === 'equipment' && isMachine(scope.equipmentId) ? scope.equipmentId : null);
/** Counting unit of an asset's counter ('tiles', or 'tile-eq' for slip and powder). */
const unitOf = (id: string) => signalUnit(counterSignalOf(id)) ?? 'tiles';
const stateWord = (st: EquipmentState | undefined) => (st ? OPERATIONAL_STATE_LABEL[st] : 'no state');
const isConstraint = (id: string) => OPS_BY_ID[id]?.stage === LINE.designConstraint;
const unknownState = (st: EquipmentState) => st === 'unknown' || st === 'disconnected';
/** Waiting on a neighbour (no input / output full): material flow, reported by the flow rules. */
const waitingState = (st: EquipmentState) => st === 'starved' || st === 'idle' || st === 'blocked';
/** Equipment scope id (rules are only evaluated for scopes their appliesTo accepted). */
const idOf = (scope: RuleScope) => (scope.kind === 'equipment' ? scope.equipmentId : '');

/** Usable counter samples in time order (bad / stale / missing samples left out). */
const usable = (samples: Sample[]) => samples.filter((x) => usableValue(x) !== null);

/**
 * Counter options: the most an asset can count over `minutes` (1.5 × its ideal rate, or a conveyor's capacity). A
 * larger step is implausible — e.g. a counter falling back by a fraction (a value restored after a freeze) is
 * otherwise read as a reset to its whole lifetime count (src/calc counterDelta: callers pass maxPlausibleDelta).
 */
function plausible(id: string, minutes: number): { maxPlausibleDelta?: number } {
  const cap = idealRateOf(id) ?? CONVEYOR_BY_ID[id]?.capacityPerHour ?? null;
  return cap ? { maxPlausibleDelta: (cap / 60) * Math.max(1, minutes) * 1.5 } : {};
}

/** A buffer level reading usable as context (good / uncertain), in %. */
function levelNow(ctx: RuleContext, signalId: string): number | null {
  const r = ctx.read(signalId);
  return typeof r.value === 'number' && (r.quality === 'good' || r.quality === 'uncertain') ? r.value : null;
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Buffer level signals around a machine (optional context of the output and decline rules). */
const bufferSignals = (id: string) => {
  const { input, output } = buffersOf(id);
  return [input?.levelSignal, output?.levelSignal].filter((x): x is string => !!x);
};

/**
 * Whether the line paces the machine now: its output buffer at or above `fullPct`, or its input buffer at or below
 * `emptyPct` (current levels; a level that is not usable says nothing). Text names the buffer and its level.
 */
function pacedByBuffers(
  ctx: RuleContext,
  id: string,
  fullPct: number,
  emptyPct: number,
): { paced: boolean; side: 'output' | 'input' | null; text: string; measurements: Measurement[]; evidence: Evidence[] } {
  const { input, output } = buffersOf(id);
  const outLevel = output ? levelNow(ctx, output.levelSignal) : null;
  const inLevel = input ? levelNow(ctx, input.levelSignal) : null;
  const measurements: Measurement[] = [];
  const evidence: Evidence[] = [];
  for (const [b, v] of [
    [output, outLevel],
    [input, inLevel],
  ] as const)
    if (b && v != null) {
      measurements.push({ signalId: b.levelSignal, label: `${b.name} level`, value: Number(v.toFixed(1)), unit: '%', at: ctx.now - 1 });
      evidence.push({ kind: 'signal', label: `${b.name} level`, ref: b.levelSignal });
    }
  const full = output && outLevel != null && outLevel >= fullPct ? output : null;
  const empty = input && inLevel != null && inLevel <= emptyPct ? input : null;
  const text = full ? `the ${lowerFirst(full.name)} (${full.levelSignal}) is ${num(outLevel)} % full` : empty ? `the ${lowerFirst(empty.name)} (${empty.levelSignal}) is at ${num(inLevel)} %` : '';
  return { paced: !!(full || empty), side: full ? 'output' : empty ? 'input' : null, text, measurements, evidence };
}

type WindowOutput = {
  /** Units counted over the minutes the good samples cover. */
  units: number;
  /** Minutes the count covers: (first good sample, last good sample]. */
  covered: Window;
  /** Covered minutes that are production time (not planned stop / changeover / unknown state; not waiting, when excluded). */
  productionMin: number;
  excludedMin: number;
  unknownMin: number;
  /** Minutes starved / blocked (left out of the production time when `excludeWaiting`). */
  waitingMin: number;
  /** Units per hour of production time (null with no production time). */
  perHour: number | null;
  note?: string;
};

/**
 * Output of an asset over the last `minutes` from its counter (counterRate: resets, rollovers and implausible
 * steps handled) per production minute — planned stops, changeovers and minutes with an unknown state left out.
 */
function windowOutput(ctx: RuleContext, id: string, minutes: number, excludeWaiting = false): WindowOutput | { error: string } {
  const now = ctx.now;
  const samples = ctx.samples(counterSignalOf(id), { from: now - minutes - 1, to: now });
  const good = usable(samples);
  const rate = counterRate(samples, plausible(id, minutes + 1));
  if (rate.status !== 'ok' || good.length < 2) return { error: rate.status === 'ok' ? 'fewer than two good counter samples' : rate.reason };
  const covered = { from: good[0].t + 1, to: good[good.length - 1].t + 1 };
  const coveredMin = covered.to - covered.from;
  const segs = ctx.states(id, covered);
  const excludedMin = minutesWhere(segs, covered, (st) => NOT_SCHEDULED.has(st));
  const unknownMin = minutesWhere(segs, covered, unknownState) + (coveredMin - minutesWhere(segs, covered, () => true));
  const waitingMin = minutesWhere(segs, covered, waitingState);
  const productionMin = coveredMin - excludedMin - unknownMin - (excludeWaiting ? waitingMin : 0);
  const units = (rate.value.perHour * coveredMin) / 60;
  const r = productionRate(units, productionMin);
  return { units, covered, productionMin, excludedMin, unknownMin, waitingMin, perHour: r.status === 'ok' ? r.value : null, note: rate.status === 'ok' ? rate.note : undefined };
}

/** Minutes of the window by loss category (state timeline). */
function losses(ctx: RuleContext, id: string, w: Window) {
  const segs = ctx.states(id, w);
  return {
    down: minutesWhere(segs, w, (st) => st === 'fault' || st === 'stopped'),
    starved: minutesWhere(segs, w, (st) => st === 'starved' || st === 'idle'),
    blocked: minutesWhere(segs, w, (st) => st === 'blocked'),
    reduced: minutesWhere(segs, w, (st) => st === 'reduced'),
  };
}

/** The next counting point downstream of an asset (a conveyor's or the next stage's counter). */
function nextCounterOf(id: string): string | null {
  const conv = CONVEYOR_BY_ID[id];
  if (conv) {
    const m = STAGES.find((s) => s.id === conv.to)?.machines[0];
    return m ? counterSignalOf(m) : null;
  }
  const stage = OPS_BY_ID[id]?.stage;
  if (!stage) return null;
  const out = CONVEYORS.find((c) => c.from === stage);
  if (out) return counterSignalOf(out.id);
  const i = STAGES.findIndex((s) => s.id === stage);
  const m = STAGES[i + 1]?.machines[0];
  return m ? counterSignalOf(m) : null;
}

/** Ideal rate of the line constraint (the kiln): the pace every other stage is planned to run at on average. */
const CONSTRAINT_RATE = STAGE_BY_ID[LINE.designConstraint].machines.reduce((a, m) => a + (idealRateOf(m) ?? 0), 0);

/**
 * Planned rate of a process machine: its ideal rate, capped at its share of the line constraint's ideal rate. A
 * stage with spare capacity (sorting, packing, the glaze line) is planned to run at the line's pace, not at its
 * nameplate: over an hour it cannot make more than the kiln passes on.
 */
export function plannedRateOf(id: string): { rate: number; ideal: number; paced: boolean } | null {
  const ideal = idealRateOf(id);
  const stage = OPS_BY_ID[id]?.stage;
  if (ideal == null || !stage) return null;
  const stageIdeal = STAGE_BY_ID[stage].machines.reduce((a, m) => a + (idealRateOf(m) ?? 0), 0);
  const paced = stageIdeal > 0 ? (CONSTRAINT_RATE * ideal) / stageIdeal : ideal;
  return paced < ideal ? { rate: paced, ideal, paced: true } : { rate: ideal, ideal, paced: false };
}

const eventEvidence = (ctx: RuleContext, id: string, w: Window): Evidence[] => ctx.events(id, w).slice(0, 3).map((e) => ({ kind: 'event', label: e.title, ref: e.id, window: { from: e.start, to: e.end ?? ctx.now } }));

// ── P-OUTPUT · output below target ───────────────────────────────────────────

const OUTPUT_ID = 'P-OUTPUT';

const P_OUTPUT: RuleDef = {
  id: OUTPUT_ID,
  family: 'production',
  classification: 'rule-based',
  title: 'Output below target',
  description:
    'Output counted over the window (counter delta, resets handled) per minute of production time against the target share of the planned rate (the ideal rate, capped at the line pace set by the kiln). Planned stops and changeovers are left out; so is time waiting on a neighbour (starved / blocked, reported by the flow rules), except at the kiln, where every lost minute is lost line output.',
  appliesTo: (scope) => machineOf(scope) != null,
  requiredSignals: (scope) => [counterSignalOf(idOf(scope)), stateSignalOf(idOf(scope))],
  optionalSignals: (scope) => bufferSignals(idOf(scope)),
  params: [
    { key: 'windowMin', label: 'Window', unit: 'min', default: 60, min: 15, max: 480, step: 5, hint: 'Output is counted over this trailing window.' },
    {
      key: 'targetShare',
      label: 'Target',
      unit: '% of the planned rate',
      scale: 100,
      default: DEFAULT_EVENT_RULES.belowRateFactor,
      min: 0.3,
      max: 1,
      step: 0.01,
      hint: 'Target output rate as a share of the planned rate (ideal rate, capped at the line pace); follows the event rule R-RATE (rate below) unless set here.',
      mirrors: { rule: 'belowRateFactor' },
    },
    { key: 'minProductionMin', label: 'Assess with at least', unit: 'min of production time', default: 20, min: 5, max: 240, step: 5, hint: 'Windows with less production time (mostly planned stop / changeover) are not assessed.' },
    { key: 'fullPct', label: 'Output buffer full at', unit: '%', default: 90, min: 50, max: 100, step: 1, hint: 'Off the kiln, a shortfall without own stops while the output buffer is this full is the line pacing the machine.' },
    { key: 'emptyPct', label: 'Input buffer empty at', unit: '%', default: 10, min: 0, max: 50, step: 1, hint: 'Off the kiln, a shortfall without own stops while the input buffer is this low is the line pacing the machine.' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const W = Math.round(ctx.param(OUTPUT_ID, 'windowMin', id));
    const share = ctx.param(OUTPUT_ID, 'targetShare', id);
    const minProd = ctx.param(OUTPUT_ID, 'minProductionMin', id);
    const plan = plannedRateOf(id)!;
    const ideal = plan.ideal;
    const target = plan.rate * share;
    const unit = unitOf(id);
    const counter = counterSignalOf(id);
    const targetText = `${pct(share)} of its planned ${num(plan.rate)} ${unit}/h (${num(target)} ${unit}/h${plan.paced ? `; planned at the line pace set by the kiln, the line constraint — its own ideal is ${num(ideal)} ${unit}/h` : ', its ideal rate'})`;
    const win = ctx.window(W);
    const excludeWaiting = !isConstraint(id);
    const out = windowOutput(ctx, id, W, excludeWaiting);
    if ('error' in out)
      return {
        status: 'insufficient-data',
        title: `${OUTPUT_ID}: not evaluated`,
        explanation: `Not evaluated — ${counter} has no usable count over the last ${W} min (${out.error}).`,
        missingSignals: [{ signalId: counter, name: signalName(counter), reason: out.error }],
        next: `Check the counter history of ${id} (gaps or implausible steps).`,
      };
    const evidence: Evidence[] = [
      { kind: 'signal', label: signalName(counter), ref: counter, window: win },
      { kind: 'signal', label: signalName(stateSignalOf(id)), ref: stateSignalOf(id), window: win },
      { kind: 'chart', label: 'Output rate', ref: CHART.rate, window: win },
      { kind: 'chart', label: 'State timeline', ref: CHART.states, window: win },
    ];
    const left = [
      out.excludedMin ? `${out.excludedMin} min of planned stop / changeover` : '',
      excludeWaiting && out.waitingMin ? `${out.waitingMin} min waiting on a neighbour (starved / blocked)` : '',
      out.unknownMin ? `${out.unknownMin} min with an unknown state` : '',
    ].filter(Boolean);
    const leftText = left.length ? ` Left out of the production time: ${list(left)}.` : '';
    if (out.productionMin < minProd || out.perHour == null)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: output not assessed`,
        explanation: `Not assessed: only ${out.productionMin} min of production time in the last ${W} min (${span(win)}); the rule needs at least ${num(minProd)} min.${leftText}`,
        window: win,
        evidence,
        confidence: 'low',
        confidenceNote: 'Too little production time in the window to compare the output with its target.',
        next: null,
        chartRef: CHART.rate,
      };
    const actual = out.perHour;
    const variance = varianceVsTarget(actual, target);
    const measurements: Measurement[] = [
      { signalId: counter, label: 'Output in the window', value: Math.round(out.units), unit, window: out.covered },
      { label: 'Output rate over production time', value: Math.round(actual), unit: `${unit}/h`, window: win },
      { label: 'Target', value: Math.round(target), unit: `${unit}/h` },
      { label: 'Planned rate', value: Math.round(plan.rate), unit: `${unit}/h` },
      { label: 'Share of planned rate', value: Number(((actual / plan.rate) * 100).toFixed(1)), unit: '%' },
      { label: 'Production time', value: out.productionMin, unit: 'min', window: win },
      { label: 'Planned stop / changeover left out', value: out.excludedMin, unit: 'min', window: win },
      { label: excludeWaiting ? 'Waiting on a neighbour left out' : 'Waiting on a neighbour (counted: line constraint)', value: out.waitingMin, unit: 'min', window: win },
    ];
    const headline = `${id} made ${num(out.units)} ${unit} in the last ${W} min (${span(win)}): ${num(actual)} ${unit}/h over ${out.productionMin} min of production time`;
    const notes = out.note ? ` Counter: ${out.note}.` : '';
    const confidence = out.note || out.unknownMin ? 'medium' : 'high';
    const confidenceNote = out.note || out.unknownMin ? `Threshold rule on the counter and the state signal.${notes}${out.unknownMin ? ` ${out.unknownMin} min with an unknown state are left out.` : ''}` : undefined;

    // Rolling check (one minute at a time over the window) for when the shortfall was first seen / resolved.
    const cond = rollingShortfall(ctx, id, W, target, minProd, excludeWaiting);
    if (!(variance.status === 'ok' && variance.value.abs < 0)) {
      const resolved = cond.lastHeld;
      return {
        status: 'clear',
        title: `${equipmentName(id)} output on target`,
        explanation: `${headline}, at or above the target of ${targetText}.${leftText}${resolved != null ? ` A shortfall cleared at ${clock(resolved)}.` : ''}${notes}`,
        measurements,
        window: win,
        evidence,
        confidence,
        confidenceNote,
        next: null,
        resolvedAt: resolved,
        chartRef: CHART.rate,
      };
    }
    const l = losses(ctx, id, win);
    // Off the kiln, a shortfall without own stops while a neighbouring buffer is full / empty is the line pacing it.
    const pace = pacedByBuffers(ctx, id, ctx.param(OUTPUT_ID, 'fullPct', id), ctx.param(OUTPUT_ID, 'emptyPct', id));
    measurements.push(...pace.measurements);
    evidence.push(...pace.evidence);
    if (excludeWaiting && pace.paced && l.down < 5)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: output paced by the line`,
        explanation: `${headline}, below the target of ${targetText} — but ${pace.text}, so the line is pacing a stage with spare capacity: material flow (flow rules), not a production loss at ${id}.${leftText}${notes}`,
        measurements,
        window: win,
        evidence,
        confidence,
        confidenceNote,
        next: null,
        chartRef: CHART.rate,
      };
    const stops = ctx.stops(id, win).filter((x) => x.kind === 'down');
    const longest = stops.map((x) => ({ x, min: Math.min(x.end ?? ctx.now, win.to) - Math.max(x.start, win.from) })).sort((a, b) => b.min - a.min)[0];
    const parts = [
      l.down ? `${l.down} min stopped${longest ? ` (longest: ${longest.x.reasonLabel}, ${longest.min} min from ${clock(longest.x.start)})` : ''}` : '',
      !excludeWaiting && l.starved ? `${l.starved} min starved` : '',
      !excludeWaiting && l.blocked ? `${l.blocked} min blocked` : '',
      l.reduced ? `${l.reduced} min at reduced rate` : '',
    ].filter(Boolean);
    const peers = peersOf(id)
      .map((p) => ({ p, o: windowOutput(ctx, p, W, excludeWaiting) }))
      .filter((x): x is { p: string; o: WindowOutput } => !('error' in x.o) && x.o.perHour != null);
    const peerText = peers.length ? ` Over the same window ${list(peers.map((x) => `${x.p} made ${num(x.o.perHour)} ${unit}/h`))}.` : '';
    const { input, output } = buffersOf(id);
    const peerNames = list(peersOf(id).map(equipmentName));
    const dominant = excludeWaiting ? l.down : Math.max(l.down, l.starved, l.blocked);
    let next: string;
    if (isConstraint(id) && pace.side === 'output' && dominant < 5 && output)
      next = `Check the sorting line downstream of the kiln (${output.levelSignal}): a slower sorting line fills the kiln outfeed and then holds the kiln back.`;
    else if (dominant >= 5 && dominant === l.down)
      next = `Review the unplanned stop${stops.length === 1 ? '' : 's'} of ${id} in the window${longest ? ` (longest: ${longest.x.reasonLabel}, ${longest.min} min from ${clock(longest.x.start)})` : ''} in the event log and confirm it runs at rate since the restart.`;
    else if (dominant >= 5 && dominant === l.starved)
      next = `Check the supply to ${id}${input ? `: the ${lowerFirst(input.name)} level (${input.levelSignal}) and the stage feeding it` : ' from the upstream stage'} — it waited for material for ${l.starved} min.`;
    else if (dominant >= 5)
      next = `Check the discharge of ${id}${output ? `: the ${lowerFirst(output.name)} level (${output.levelSignal}) and the stage it feeds` : ' to the downstream stage'} — it could not discharge for ${l.blocked} min.`;
    else if (OPS_BY_ID[id]?.stage === 'PRESS') next = `Check the die / powder feed of ${id}; compare ${equipmentName(id)} with ${peerNames} (cycle time chart).`;
    else next = `Check the speed setpoint of ${id} against the recipe and look for repeated short stops in its alarm log${peerNames ? `; compare with ${peerNames}` : ''}.`;
    return {
      status: 'fired',
      severity: isConstraint(id) ? 'serious' : 'warning',
      title: `${equipmentName(id)} output ${pct(actual / plan.rate)} of plan — below target`,
      explanation: `${headline}, below the target of ${targetText} by ${num(-variance.value.abs)} ${unit}/h (${signedPct(variance.value.rel, Math.abs(variance.value.rel) < 0.1 ? 1 : 0)}).${leftText}${parts.length ? ` In the window: ${list(parts)}.` : ' The state signal shows it running in the production time: the shortfall is in its rate (its own pace, or less material arriving — the state signal does not tell them apart).'}${excludeWaiting ? '' : ` Starved and blocked minutes count here: the kiln is the line constraint.${pace.text ? ` ${cap(pace.text)}.` : ''}`}${peerText}${notes}`,
      measurements,
      window: win,
      evidence: [...evidence, ...eventEvidence(ctx, id, win)],
      confidence,
      confidenceNote,
      next,
      firstSeen: cond.firstSeen ?? win.from,
      chartRef: CHART.rate,
    };
  },
};

/**
 * The output condition evaluated for every trailing window ending in the last W minutes (per-minute counter
 * increments; a missing increment ends the scan): when the current shortfall was first seen, and when an earlier
 * one last held. Minutes are the end of the minute (the window ending with minute k is first seen at k + 1).
 */
function rollingShortfall(
  ctx: RuleContext,
  id: string,
  W: number,
  target: number,
  minProd: number,
  excludeWaiting: boolean,
): { firstSeen: number | null; lastHeld: number | null } {
  const now = ctx.now;
  const from = now - 2 * W - 1;
  const samples = ctx.samples(counterSignalOf(id), { from, to: now });
  const value = new Map(samples.map((x) => [x.t, usableValue(x)]));
  const st = stateLookup(ctx.states(id, { from, to: now }));
  // Each minute's increment and production flag is read by up to W windows: computed once per minute (same values,
  // same summation order — the windows below still add them up one by one).
  const opts = plausible(id, 1);
  const incs = new Map<number, number | null>();
  const prods = new Map<number, boolean>();
  const inc = (m: number) => {
    let d = incs.get(m);
    if (d === undefined) incs.set(m, (d = counterDelta(value.get(m - 1) ?? null, value.get(m) ?? null, opts).delta));
    return d;
  };
  const prod = (m: number) => {
    let p = prods.get(m);
    if (p === undefined) {
      const x = st(m)?.state;
      prods.set(m, (p = x != null && !NOT_SCHEDULED.has(x) && !unknownState(x) && !(excludeWaiting && waitingState(x))));
    }
    return p;
  };

  const held = (k: number): boolean | null => {
    let units = 0;
    let p = 0;
    for (let m = k - W + 1; m <= k; m++) {
      const d = inc(m);
      if (d == null) return null;
      units += d;
      if (prod(m)) p++;
    }
    return p >= minProd && (units * 60) / p < target;
  };
  const results = new Map<number, boolean | null>();
  const at = (k: number) => {
    if (!results.has(k)) results.set(k, held(k));
    return results.get(k)!;
  };
  const start = trailingRunStart((k) => at(k) === true, now - W, now);
  let lastHeld: number | null = null;
  for (let k = now - 2; k >= now - W; k--)
    if (at(k) === true) {
      lastHeld = k + 1;
      break;
    }
  return { firstSeen: start != null ? start + 1 : null, lastHeld: at(now - 1) === true ? null : lastHeld };
}

// ── P-CYCLE · press cycle time above target ──────────────────────────────────

const CYCLE_ID = 'P-CYCLE';
const cycleOf = (id: string) => `${id}.cycle_time`;
const cycleTargetOf = (id: string) => `${id}.cycle_time_target`;
const isPress = (id: string) => inCatalog(cycleOf(id)) && inCatalog(cycleTargetOf(id)) && inCatalog(stateSignalOf(id));

const P_CYCLE: RuleDef = {
  id: CYCLE_ID,
  family: 'production',
  classification: 'rule-based',
  title: 'Cycle time above target',
  description:
    'Press cycle time above its target × (1 + tolerance) for at least the minimum duration while the press is running (state signal). A press waiting on a full collector or an empty powder silo (their level signals) is the line pacing it, not reported.',
  appliesTo: (scope) => scope.kind === 'equipment' && isPress(scope.equipmentId),
  requiredSignals: (scope) => [cycleOf(idOf(scope)), cycleTargetOf(idOf(scope)), stateSignalOf(idOf(scope))],
  optionalSignals: (scope) => [...peersOf(idOf(scope)).filter(isPress).map(cycleOf), ...bufferSignals(idOf(scope))],
  params: [
    {
      key: 'tolerance',
      label: 'Above target by more than',
      unit: '% above target',
      scale: 100,
      decimals: 1,
      default: 1 / DEFAULT_EVENT_RULES.belowRateFactor - 1,
      min: 0.02,
      max: 1,
      step: 0.01,
      hint: 'Allowed excess over the target cycle time; follows R-RATE (a rate below 85 % of ideal is a cycle 17.6 % above target) unless set here.',
      mirrors: { rule: 'belowRateFactor', map: (f) => 1 / f - 1 },
    },
    {
      key: 'minMinutes',
      label: 'for at least',
      unit: 'min',
      default: DEFAULT_EVENT_RULES.belowRateMinutes,
      min: 3,
      max: 120,
      step: 1,
      hint: 'Minimum duration of the excess while running; follows R-RATE (for at least) unless set here.',
      mirrors: { rule: 'belowRateMinutes' },
    },
    { key: 'windowMin', label: 'Look back', unit: 'min', default: 120, min: 30, max: 480, step: 10, hint: 'How far back the cycle-time history is read.' },
    { key: 'fullPct', label: 'Collector full at', unit: '%', default: 90, min: 50, max: 100, step: 1, hint: 'A longer cycle while the output buffer is this full is the press waiting to discharge.' },
    { key: 'emptyPct', label: 'Powder silo empty at', unit: '%', default: 10, min: 0, max: 50, step: 1, hint: 'A longer cycle while the input buffer is this low is the press waiting for powder.' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const tol = ctx.param(CYCLE_ID, 'tolerance', id);
    const N = ctx.param(CYCLE_ID, 'minMinutes', id);
    const W = Math.round(ctx.param(CYCLE_ID, 'windowMin', id));
    const win = ctx.window(W);
    const target = ctx.read(cycleTargetOf(id)).value;
    if (typeof target !== 'number' || !(target > 0))
      return {
        status: 'insufficient-data',
        title: `${CYCLE_ID}: not evaluated`,
        explanation: `Not evaluated — ${cycleTargetOf(id)} carries no target cycle time.`,
        missingSignals: [{ signalId: cycleTargetOf(id), name: signalName(cycleTargetOf(id)), reason: 'no target value' }],
        next: `Check the die / product recipe of ${id}: its target cycle time is not set.`,
      };
    const limit = target * (1 + tol);
    const segs = ctx.states(id, win);
    const st = stateLookup(segs);
    const sp = ctx.samples(cycleTargetOf(id), win);
    const spAt = new Map(sp.map((x) => [x.t, usableValue(x)]));
    // Only minutes the press runs count; a cycle faster than target is no excess (one-sided).
    const pv: Sample[] = ctx.samples(cycleOf(id), win).map((x) => {
      const state = st(x.t)?.state;
      if (!state || !RUNNING.has(state)) return { t: x.t, v: null, q: 'missing' };
      const v = usableValue(x);
      const ref = spAt.get(x.t) ?? target;
      return v != null && v < ref ? { ...x, v: ref } : x;
    });
    const episodes = deviationEpisodes(pv, sp.length ? sp : target, target * tol, { stepMin: 1 });
    const last = episodes[episodes.length - 1];
    const current = last && last.to >= ctx.now ? last : null;
    const longPast = episodes.filter((e) => e !== current && e.minutes >= N);
    const now = ctx.read(cycleOf(id)).value;
    const nowVal = typeof now === 'number' ? now : null;
    const peerValues = peersOf(id)
      .filter(isPress)
      .map((p) => {
        const v = ctx.read(cycleOf(p));
        return { p, v: typeof v.value === 'number' && (v.quality === 'good' || v.quality === 'uncertain') ? v.value : null };
      });
    const peers = peerValues.map((x) => `${x.p} ${x.v != null ? `${num(x.v, 1)} s` : 'not cycling'}`);
    const allSlow = peerValues.length > 0 && peerValues.every((x) => x.v != null && x.v > limit);
    const peerText = peers.length ? ` (${list(peers)} now)` : '';
    const measurements: Measurement[] = [
      { signalId: cycleOf(id), label: 'Cycle time now', value: nowVal != null ? Number(nowVal.toFixed(1)) : null, unit: 's', at: ctx.now - 1 },
      { signalId: cycleTargetOf(id), label: 'Target cycle time', value: Number(target.toFixed(1)), unit: 's' },
      { label: 'Limit (target + tolerance)', value: Number(limit.toFixed(1)), unit: 's' },
    ];
    const evidence: Evidence[] = [
      { kind: 'signal', label: signalName(cycleOf(id)), ref: cycleOf(id), window: win },
      { kind: 'signal', label: signalName(cycleTargetOf(id)), ref: cycleTargetOf(id) },
      { kind: 'chart', label: 'Cycle time', ref: CHART.cycle, window: win },
    ];
    const peerNames = list(peersOf(id).filter(isPress).map(equipmentName));
    const { input, output } = buffersOf(id);
    const next = allSlow
      ? `All presses are above the limit${peerText.replace(' now)', ')')}: check what they share first — the powder feed${input ? ` (${input.levelSignal})` : ''} and the collector discharge${output ? ` (${output.levelSignal})` : ''} — before the dies.`
      : `Check the die / powder feed of ${id}; compare ${equipmentName(id)} with ${peerNames}${peerText}.`;
    if (current && current.minutes >= N) {
      const inEp = pv.filter((x) => x.t >= current.from && x.t < current.to).map(usableValue);
      const st2 = stats(inEp);
      const mean = st2.status === 'ok' ? st2.value.mean : null;
      const max = target + current.maxAbs;
      const w = { from: current.from, to: ctx.now };
      measurements.push(
        { signalId: cycleOf(id), label: 'Mean cycle time in the episode', value: mean != null ? Number(mean.toFixed(1)) : null, unit: 's', window: w },
        { signalId: cycleOf(id), label: 'Longest cycle time in the episode', value: Number(max.toFixed(1)), unit: 's', window: w },
        { label: 'Above the limit for', value: current.minutes, unit: 'min', window: w },
      );
      const head = `${id} cycle time has been above its limit for ${current.minutes} min (since ${clock(current.from)}) while running: now ${num(nowVal, 1)} s, mean ${num(mean, 1)} s, longest ${num(max, 1)} s against a target of ${num(target, 1)} s — the limit is ${num(limit, 1)} s (${signedPct(tol, 1)}), held for at least ${num(N)} min.${peers.length ? ` Other presses now: ${list(peers)}.` : ''}`;
      const pace = pacedByBuffers(ctx, id, ctx.param(CYCLE_ID, 'fullPct', id), ctx.param(CYCLE_ID, 'emptyPct', id));
      measurements.push(...pace.measurements);
      evidence.push(...pace.evidence);
      if (pace.paced)
        return {
          status: 'clear',
          title: `${equipmentName(id)}: cycle paced by the line`,
          explanation: `${head} But ${pace.text}: the press waits ${pace.side === 'output' ? 'to discharge' : 'for powder'} — line pacing (material flow), not a press or die problem.`,
          measurements,
          window: w,
          evidence,
          next: null,
          chartRef: CHART.cycle,
        };
      return {
        status: 'fired',
        severity: 'warning',
        title: `${equipmentName(id)} cycle time ${pct(((mean ?? max) - target) / target)} above target`,
        explanation: head,
        measurements,
        window: w,
        evidence: [...evidence, ...eventEvidence(ctx, id, w)],
        next,
        firstSeen: current.from,
        chartRef: CHART.cycle,
      };
    }
    const seg = st(ctx.now - 1);
    const resolved = longPast.length ? longPast[longPast.length - 1] : null;
    const resolvedText = resolved ? ` It was above the limit from ${clock(resolved.from)} to ${clock(resolved.to)} (${resolved.minutes} min, longest ${num(target + resolved.maxAbs, 1)} s).` : '';
    const notRunning = !seg || !RUNNING.has(seg.state);
    const short = current ? ` Above the limit for the last ${current.minutes} min — reported after ${num(N)} min.` : '';
    return {
      status: 'clear',
      title: notRunning ? `${equipmentName(id)} not cycling` : `${equipmentName(id)} cycle time within tolerance`,
      explanation: notRunning
        ? `${id} is not running (${stateWord(seg?.state)}${seg ? ` since ${clock(seg.from)}` : ''}) — there is no press cycle to time, so no cycle-time excess is reported.${resolvedText}`
        : `${id} cycle time ${num(nowVal, 1)} s against a target of ${num(target, 1)} s (${nowVal != null ? signedPct((nowVal - target) / target) : '—'}), within the ${signedPct(tol, 1)} tolerance (${num(limit, 1)} s) while running over the last ${W} min.${short}${resolvedText}`,
      measurements,
      window: win,
      evidence,
      next: null,
      resolvedAt: resolved ? resolved.to : null,
      chartRef: CHART.cycle,
    };
  },
};

// ── P-COUNTER · counter not advancing while running ──────────────────────────

const COUNTER_ID = 'P-COUNTER';
/** A tracked asset (process machine or conveyor) with a counter and a state signal in the catalogue. */
const isTracked = (id: string) => (idealRateOf(id) != null || isConveyor(id)) && inCatalog(counterSignalOf(id)) && inCatalog(stateSignalOf(id));
/** Raw state values in which the asset must count (a conveyor running empty or accumulating need not). */
const COUNTING_VALUES = new Set(['running', 'reduced']);

const P_COUNTER: RuleDef = {
  id: COUNTER_ID,
  family: 'production',
  classification: 'rule-based',
  title: 'Counter not advancing while running',
  description:
    'The output counter has not advanced for the threshold while the state signal is current and reports running. A stale feed (timestamps not updating) is not this rule: it is reported as not evaluated (data rules).',
  appliesTo: (scope) => scope.kind === 'equipment' && isTracked(scope.equipmentId),
  requiredSignals: (scope) => [counterSignalOf(idOf(scope)), stateSignalOf(idOf(scope))],
  optionalSignals: (scope) => (inCatalog(`${idOf(scope)}.rate`) ? [`${idOf(scope)}.rate`] : []),
  params: [
    {
      key: 'minutes',
      label: 'No counter change for',
      unit: 'min',
      default: DEFAULT_EVENT_RULES.counterInactiveMinutes,
      min: 1,
      max: 60,
      step: 1,
      hint: 'Follows the event rule R-COUNTER (no counter change for) unless set here.',
      mirrors: { rule: 'counterInactiveMinutes' },
    },
    { key: 'windowMin', label: 'Look back', unit: 'min', default: 30, min: 10, max: 480, step: 5, hint: 'How far back the counter history is read.' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const N = ctx.param(COUNTER_ID, 'minutes', id);
    const W = Math.round(Math.max(ctx.param(COUNTER_ID, 'windowMin', id), N + 1));
    const counter = counterSignalOf(id);
    const stateSig = stateSignalOf(id);
    const unit = unitOf(id);
    const state = ctx.read(stateSig);
    const win = ctx.window(W);
    const evidence: Evidence[] = [
      { kind: 'signal', label: signalName(counter), ref: counter, window: win },
      { kind: 'signal', label: signalName(stateSig), ref: stateSig, window: win },
      { kind: 'chart', label: 'Output rate', ref: CHART.rate, window: win },
    ];
    if (typeof state.value !== 'string' || !COUNTING_VALUES.has(state.value))
      return {
        status: 'clear',
        title: `${equipmentName(id)}: counter check not applicable`,
        explanation: `${stateSig} reads ${state.text} — the counter is only expected to advance while running.`,
        evidence,
        next: null,
      };
    const good = usable(ctx.samples(counter, { from: win.from - 1, to: ctx.now }));
    if (good.length < 2)
      return {
        status: 'insufficient-data',
        title: `${COUNTER_ID}: not evaluated`,
        explanation: `Not evaluated — ${counter} has ${good.length} usable sample${good.length === 1 ? '' : 's'} in the last ${W} min.`,
        missingSignals: [{ signalId: counter, name: signalName(counter), reason: `${good.length} usable samples in the last ${W} min` }],
        next: `Check the counter history of ${id} for gaps.`,
      };
    let lastAdvance: number | null = null;
    let advanced = 0;
    for (let i = 1; i < good.length; i++) {
      const d = counterDelta(good[i - 1].v, good[i].v, plausible(id, good[i].t - good[i - 1].t)).delta;
      if (d != null && d > 0) {
        lastAdvance = good[i].t;
        advanced += d;
      }
    }
    const flatFrom = lastAdvance != null ? lastAdvance + 1 : good[0].t + 1;
    const st = stateLookup(ctx.states(id, { from: win.from - 1, to: ctx.now }));
    const runningFrom = trailingRunStart((t) => {
      const x = st(t)?.state;
      return !!x && (isConveyor(id) ? x === 'running' : RUNNING.has(x));
    }, win.from - 1, ctx.now);
    const from = runningFrom == null ? ctx.now : Math.max(flatFrom, runningFrom);
    const flatRunning = ctx.now - from;
    const value = good[good.length - 1].v as number;
    const rate = inCatalog(`${id}.rate`) ? ctx.read(`${id}.rate`) : null;
    const rateText = rate && typeof rate.value === 'number' && rate.quality === 'good' ? ` The rate signal reads ${num(rate.value)} ${rate.unit ?? `${unit}/h`}.` : '';
    const measurements: Measurement[] = [
      { signalId: counter, label: 'Counter value', value: Math.round(value), unit, at: good[good.length - 1].t },
      { label: 'Not advancing while running', value: Math.max(0, flatRunning), unit: 'min', window: { from, to: ctx.now } },
      { signalId: stateSig, label: 'State', value: state.text, unit: null, at: state.timestamp ?? undefined },
    ];
    if (flatRunning >= N) {
      const nextCounter = nextCounterOf(id);
      return {
        status: 'fired',
        severity: 'warning',
        title: `${equipmentName(id)}: counter not advancing while running`,
        explanation: `${counter} has not advanced for ${flatRunning} min (since ${clock(from)}; value ${num(value)} ${unit}) while ${stateSig} reports ${state.text} and is current (last update ${state.timestamp != null ? clock(state.timestamp) : '—'}). The counter's own timestamps keep updating, so this is not a stale feed: the asset reports running but counts nothing.${rateText}`,
        measurements,
        window: { from, to: ctx.now },
        evidence,
        next: `Check the counting sensor (photo-eye / encoder) and its PLC input on ${id}${nextCounter ? `, and compare with the next counting point (${nextCounter})` : ''}.`,
        firstSeen: from,
        chartRef: CHART.rate,
      };
    }
    return {
      status: 'clear',
      title: `${equipmentName(id)} counter advancing`,
      explanation:
        flatRunning > 0 && lastAdvance != null && lastAdvance < ctx.now - 1
          ? `${counter} last advanced at ${clock(lastAdvance)} (${flatRunning} min without a change while running — reported after ${num(N)} min); +${num(advanced)} ${unit} in the last ${W} min.`
          : `${counter} advancing while running: +${num(advanced)} ${unit} in the last ${W} min (${span(win)}).`,
      measurements,
      window: win,
      evidence,
      next: null,
      chartRef: CHART.rate,
    };
  },
};

// ── P-DECLINE · output rate declining ────────────────────────────────────────

const DECLINE_ID = 'P-DECLINE';

/** Minutes between the first and the last sample. */
const spanOf = (pts: Sample[]) => (pts.length ? pts[pts.length - 1].t - pts[0].t : 0);

const P_DECLINE: RuleDef = {
  id: DECLINE_ID,
  family: 'production',
  classification: 'statistical',
  title: 'Output rate declining',
  description:
    'Least-squares slope of the output rate over the running minutes of the window, as a share of the ideal rate per hour, below the threshold and significant by a t-test (minute samples; stopped, waiting and changeover minutes left out). Off the kiln, a decline while the output buffer is full or the input buffer empty is the line pacing the machine (buffer level signals), not reported.',
  appliesTo: (scope) => machineOf(scope) != null && inCatalog(`${idOf(scope)}.rate`),
  requiredSignals: (scope) => [`${idOf(scope)}.rate`, stateSignalOf(idOf(scope))],
  optionalSignals: (scope) => bufferSignals(idOf(scope)),
  params: [
    { key: 'windowMin', label: 'Window', unit: 'min', default: 120, min: 30, max: 480, step: 10, hint: 'The trend is fitted over this trailing window.' },
    { key: 'slopePct', label: 'Falling faster than', unit: '% of the ideal rate per hour', scale: 100, default: 0.1, min: 0.01, max: 1, step: 0.01, hint: 'Slope threshold: 0.10 = 10 % of the ideal rate per hour.' },
    { key: 'minSamples', label: 'With at least', unit: 'running minutes', default: 30, min: 10, max: 480, step: 5, hint: 'Fewer running minutes in the window give no verdict.' },
    { key: 'tCritical', label: 'Significant beyond', unit: 't (slope ÷ standard error)', decimals: 2, default: 2.58, min: 1.64, max: 6, step: 0.01, hint: 'One-sided t threshold of the slope test (2.58 ≈ 0.5 % for independent samples).' },
    { key: 'fullPct', label: 'Output buffer full at', unit: '%', default: 90, min: 50, max: 100, step: 1, hint: 'Off the kiln, a decline with the output buffer at or above this level is the line pacing the machine.' },
    { key: 'emptyPct', label: 'Input buffer empty at', unit: '%', default: 10, min: 0, max: 50, step: 1, hint: 'Off the kiln, a decline with the input buffer at or below this level is the line pacing the machine.' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const W = Math.round(ctx.param(DECLINE_ID, 'windowMin', id));
    const thr = ctx.param(DECLINE_ID, 'slopePct', id);
    const minN = Math.round(ctx.param(DECLINE_ID, 'minSamples', id));
    const tCrit = ctx.param(DECLINE_ID, 'tCritical', id);
    const ideal = idealRateOf(id)!;
    const unit = unitOf(id);
    const sig = `${id}.rate`;
    const win = ctx.window(W);
    const st = stateLookup(ctx.states(id, win));
    const pts = ctx.samples(sig, win).filter((x) => {
      const state = st(x.t)?.state;
      return usableValue(x) !== null && !!state && RUNNING.has(state);
    });
    const evidence: Evidence[] = [
      { kind: 'signal', label: signalName(sig), ref: sig, window: win },
      { kind: 'chart', label: 'Output rate', ref: CHART.rate, window: win },
    ];
    const trend = trendSlope(pts, { minSamples: minN, minSpanMin: W / 2 });
    const test = trend.status === 'ok' ? slopeTest(pts) : null;
    if (trend.status !== 'ok' || !test) {
      const reason = trend.status !== 'ok' ? trend.reason : 'no time spread';
      const missing: MissingSignal = { signalId: sig, name: signalName(sig), reason: `${pts.length} running minutes in the last ${W} min — ${reason}` };
      return {
        status: 'insufficient-data',
        title: `${DECLINE_ID}: not evaluated`,
        explanation: `Not evaluated — a trend needs at least ${minN} running minutes of ${sig} spread over ${num(W / 2)} min of the last ${W} min; ${pts.length} available${pts.length >= minN ? `, spanning ${spanOf(pts)} min` : ''} (stopped, waiting and changeover minutes are left out).`,
        missingSignals: [missing],
        evidence,
        next: null,
      };
    }
    const rel = test.slopePerHour / ideal;
    const measurements: Measurement[] = [
      { signalId: sig, label: 'Slope of the output rate', value: Math.round(test.slopePerHour), unit: `${unit}/h per hour`, window: win },
      { label: 'Slope as a share of the ideal rate', value: Number((rel * 100).toFixed(1)), unit: '% per hour', window: win },
      { label: 't statistic', value: Number(test.t.toFixed(1)), unit: null },
      { label: 'Running minutes in the fit', value: test.n, unit: 'min', window: win },
      { signalId: sig, label: 'Fitted rate at the end', value: Math.round(test.fittedEnd), unit: `${unit}/h`, at: test.to },
    ];
    // Buffer context (optional signals): a full output / empty input buffer paces a machine with spare capacity.
    const pace = pacedByBuffers(ctx, id, ctx.param(DECLINE_ID, 'fullPct', id), ctx.param(DECLINE_ID, 'emptyPct', id));
    measurements.push(...pace.measurements);
    evidence.push(...pace.evidence);
    const bufferText = pace.text;
    const { input, output } = buffersOf(id);
    const note = `Least-squares slope with a t-test on ${test.n} minute samples. Minute samples of a smooth process are autocorrelated, so the test overstates certainty — read it as an indication to check, not a forecast.`;
    const declining = rel <= -thr && test.t <= -tCrit;
    const trendText = `slope ${num(test.slopePerHour)} ${unit}/h per hour (${signedPct(rel, 1)} of the ideal ${num(ideal)} ${unit}/h per hour), from ≈ ${num(test.fittedStart)} to ≈ ${num(test.fittedEnd)} ${unit}/h over ${test.n} running minutes; t = ${num(test.t, 1)}`;
    if (declining && bufferText && !isConstraint(id))
      return {
        status: 'clear',
        title: `${equipmentName(id)}: rate paced by the line`,
        explanation: `${id} output rate fell over the last ${W} min (${span(win)}): ${trendText}. ${cap(bufferText)}, so the line is pacing a stage with spare capacity — material flow, not a production loss at ${id}.`,
        measurements,
        window: win,
        evidence,
        confidenceNote: note,
        next: null,
        chartRef: CHART.rate,
      };
    if (!declining)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: no significant rate decline`,
        explanation: `No significant decline over the last ${W} min (${span(win)}): ${trendText}; reported below ${signedPct(-thr)} per hour with t below −${num(tCrit, 2)}.`,
        measurements,
        window: win,
        evidence,
        confidenceNote: note,
        next: null,
        chartRef: CHART.rate,
      };
    const peerNames = list(peersOf(id).map(equipmentName));
    const atKiln = isConstraint(id) && bufferText ? ` ${cap(bufferText)}: the kiln is the line constraint, so this is lost line output.` : '';
    return {
      status: 'fired',
      severity: rel <= -2 * thr || isConstraint(id) ? 'warning' : 'info',
      title: `${equipmentName(id)} output rate declining ${pct(-rel)} of ideal per hour`,
      explanation: `${id} output rate has been falling over the last ${W} min (${span(win)}): ${trendText} (threshold −${num(tCrit, 2)}). Stopped, waiting and changeover minutes are left out.${atKiln}`,
      measurements,
      window: win,
      evidence,
      confidence: Math.abs(test.t) >= 2 * tCrit && test.n >= 2 * minN ? 'medium' : 'low',
      confidenceNote: note,
      next:
        isConstraint(id) && pace.side === 'output' && output
          ? `Check the sorting line downstream of the kiln (${output.levelSignal}): a slower sorting line fills the kiln outfeed and then holds the kiln back.`
          : peerNames
            ? `Compare the rate of ${id} with ${peerNames} over the same window (output rate chart) and check its speed setpoint and short stops${input ? `; if they fall too, check the shared supply (the ${lowerFirst(input.name)}, ${input.levelSignal})` : ''}.`
            : `Check the speed setpoint and short stops of ${id} (output rate chart)${input ? `, and the ${lowerFirst(input.name)} level (${input.levelSignal}) — a draining input buffer points at the supply instead` : ''}.`,
      firstSeen: test.from,
      chartRef: CHART.rate,
    };
  },
};

/** The production rules, in display order. */
export const PRODUCTION_RULES: RuleDef[] = [P_OUTPUT, P_CYCLE, P_COUNTER, P_DECLINE];
