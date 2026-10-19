/**
 * Process-control rules (brief §7): deviation from setpoint and its duration (PC-SETPOINT), a process value outside
 * its configured warning / alarm limits regardless of the setpoint (PC-LIMIT), and a process measurement that is
 * missing, flagged bad or outside its engineering range while the machine runs (PC-MEASUREMENT — "measurement
 * invalid", distinct from a process deviation). All three are threshold rules ('rule-based') on the PV / SP history
 * read through the rule context (src/calc deviationEpisodes) — never the simulation's internal values.
 *
 * - Only process values the catalogue marks 'simulated' (or 'connected') are evaluated. The process measurements
 *   it lists as not modelled / unavailable are named once per equipment item, in one insufficient-data finding of
 *   PC-MEASUREMENT ("Process measurements not available: …") — not once per rule or per signal.
 * - A PV is controlled to its setpoint while its machine is in operation (running, below rate, or waiting on a
 *   neighbour). In an own stop (fault, stop, planned stop, changeover) it holds, cools or has no value by design, so
 *   those minutes are left out; an item without a state signal (the slip tanks) is evaluated every minute.
 * - Restart allowance. After an own stop a PV that cooled (dryer and spray-dryer temperatures after any stop, kiln
 *   zones after a breakdown) is still outside its band when the machine resumes and heats back up for a while. Such an
 *   episode — one that began at the restart — is reported as information for `restartMin` after the restart, naming the
 *   stop; still outside after it, it gets its full severity (a value that does not recover is a real problem).
 * - A reading outside the engineering range is a measurement problem (PC-MEASUREMENT), never a deviation:
 *   PC-SETPOINT and PC-LIMIT leave such samples out.
 * - Each PV is validated on its own (engine checkSignals): a bad / stale / missing PV gives an insufficient-data
 *   finding for that PV only, naming it and why, while the other PVs of the machine are still evaluated.
 * - The condition-monitoring signals (vibration, bearing temperature, motor current) belong to the reliability
 *   rules (RL-DRIVE) and the condition model, not to these.
 */
import { deviationEpisodes, usableValue, type DeviationEpisode, type Sample, type Window } from '../../../calc';
import { catalogFor, definitionOf, PROCESS_SIGNAL_BY_ID, type SignalDefinition } from '../../../model/catalog';
import { DEFECT_ORDER, DEFECTS, OPS_BY_ID } from '../../../model/plant';
import type { EquipmentStateSegment } from '../../../model/telemetry';
import { OPERATIONAL_STATE_LABEL } from '../../../sim/metrics';
import type { RuleContext, RuleStop } from '../context';
import { checkSignals, type SignalCheck } from '../engine';
import { CHART, type Evidence, type Measurement, type RuleDef, type RuleEvaluation, type RuleParam, type RuleScope } from '../types';
import { RUNNING, clock, duration, equipmentName, inCatalog, list, num, span, stateLookup, stateSignalOf, type EquipmentState } from '../util';

// ── Shared ───────────────────────────────────────────────────────────────────

/** States in which a machine is in operation and its process values are controlled: running, below rate, waiting on a neighbour. */
export const IN_OPERATION: ReadonlySet<EquipmentState> = new Set<EquipmentState>(['running', 'reduced', 'starved', 'blocked', 'idle']);

const usableStatus = (d: SignalDefinition) => d.availabilityStatus === 'simulated' || d.availabilityStatus === 'connected';
const hasLimits = (d: SignalDefinition) => d.warningLow != null || d.warningHigh != null || d.alarmLow != null || d.alarmHigh != null;
const keyOf = (signalId: string) => signalId.slice(signalId.indexOf('.') + 1);
/** The condition-monitoring signals (vibration, bearing temperature, motor current): reliability, not process control. */
const CONDITION_MODEL = new Set(['vibration', 'temperature', 'motor_current']);
const isConditionModel = (d: SignalDefinition) => d.category === 'condition' && CONDITION_MODEL.has(keyOf(d.signalId));

const memo = <T>(fn: (id: string) => T) => {
  const cache = new Map<string, T>();
  return (id: string) => {
    if (!cache.has(id)) cache.set(id, fn(id));
    return cache.get(id)!;
  };
};

/** Simulated / connected process values with a setpoint (PC-SETPOINT). */
const setpointPvs = memo((id) => catalogFor(id).filter((d) => d.category === 'process' && !!d.setpointSignalId && usableStatus(d)));
/** Simulated / connected values with configured warning / alarm limits, condition-monitoring signals excepted (PC-LIMIT). */
const limitSignals = memo((id) => catalogFor(id).filter((d) => usableStatus(d) && hasLimits(d) && d.category !== 'setpoint' && !isConditionModel(d)));
/** Process measurements checked for validity (PC-MEASUREMENT): the process values and the limit-checked values. */
const measured = memo((id) => catalogFor(id).filter((d) => usableStatus(d) && ((d.category === 'process' && d.unit != null) || limitSignals(id).includes(d))));
/** Process measurements of the catalogue the demo does not have (not modelled / unavailable / reference). */
const notAvailable = memo((id) => catalogFor(id).filter((d) => d.category === 'process' && !usableStatus(d)));

/** Whether the item has a state signal in the catalogue (else every minute counts as in operation). */
const hasStateSignal = (id: string) => inCatalog(stateSignalOf(id));
/** Equipment scope id (rules are only evaluated for scopes their appliesTo accepted). */
const idOf = (scope: RuleScope) => (scope.kind === 'equipment' ? scope.equipmentId : '');
/** The state signal, required where the item has one (the minutes in operation come from it). */
const stateRequired = (id: string) => (hasStateSignal(id) ? [stateSignalOf(id)] : []);

/** "Zone 3 temperature · peak firing" (the catalogue name without its " · actual" suffix). */
const labelOf = (d: SignalDefinition) => d.name.replace(/ · actual$/, '');
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const digitsOf = (d: SignalDefinition) => PROCESS_SIGNAL_BY_ID[d.signalId]?.digits ?? 1;
/** "1,226 °C" ('—' for null). */
const fmt = (d: SignalDefinition, v: number | null | undefined) => (v == null ? '—' : `${num(v, digitsOf(d))}${d.unit ? ` ${d.unit}` : ''}`);
/** "+31 °C" / "−4 °C". */
const fmtSigned = (d: SignalDefinition, v: number) => `${v >= 0 ? '+' : '−'}${fmt(d, Math.abs(v))}`;
const round = (d: SignalDefinition, v: number | null) => (v == null ? null : Number(v.toFixed(digitsOf(d))));
const plausible = (d: SignalDefinition, v: number) => (d.engineeringMin == null || v >= d.engineeringMin) && (d.engineeringMax == null || v <= d.engineeringMax);
const rangeText = (d: SignalDefinition) =>
  d.engineeringMin != null && d.engineeringMax != null ? `${num(d.engineeringMin, digitsOf(d))}–${fmt(d, d.engineeringMax)}` : d.engineeringMax != null ? `up to ${fmt(d, d.engineeringMax)}` : `from ${fmt(d, d.engineeringMin)}`;

type Operation = {
  /** Whether the item has a state signal. */
  stated: boolean;
  /** In operation at minute t (false for a minute without a known state). */
  at(t: number): boolean;
  /** The state segment covering minute t (null without a state signal, or for a minute no segment covers). */
  seg(t: number): EquipmentStateSegment | null;
};

/** Minutes in operation of an item over a window (from its state timeline). */
function operationOf(ctx: RuleContext, id: string, win: Window): Operation {
  if (!hasStateSignal(id)) return { stated: false, at: () => true, seg: () => null };
  const look = stateLookup(ctx.states(id, win));
  return {
    stated: true,
    at: (t) => {
      const x = look(t);
      return !!x && IN_OPERATION.has(x.state);
    },
    seg: look,
  };
}

const stateWords = (seg: EquipmentStateSegment | null) => (seg ? `${OPERATIONAL_STATE_LABEL[seg.state]}${seg.label && seg.reason ? ` — ${seg.label}` : ''} since ${clock(seg.from)}` : 'without a known state');

type Prepared = {
  /** The samples the deviation / limit checks read: no value where the item is not in operation or the reading is implausible. */
  controlled: Sample[];
  /** The latest usable, plausible sample in operation at the last minute (null otherwise). */
  now: Sample | null;
  /** Minutes of the window not in operation. */
  outMin: number;
  /** Samples outside the engineering range (left out). */
  implausible: number;
};

/** A process value's window history as the deviation / limit checks read it. */
function prepare(ctx: RuleContext, d: SignalDefinition, win: Window, op: Operation): Prepared {
  let outMin = 0;
  let implausible = 0;
  const controlled = ctx.samples(d.signalId, win).map((x): Sample => {
    if (!op.at(x.t)) {
      outMin++;
      return { t: x.t, v: null, q: 'missing' };
    }
    const v = usableValue(x);
    if (v != null && !plausible(d, v)) {
      implausible++;
      return { t: x.t, v: null, q: 'bad' };
    }
    return x;
  });
  const last = controlled[controlled.length - 1];
  return { controlled, now: last && last.t === ctx.now - 1 && usableValue(last) != null ? last : null, outMin, implausible };
}

/** Excursion episodes beyond one-sided or two-sided limits (the amount beyond the limit as the deviation from 0). */
export function limitEpisodes(samples: Sample[], low: number | undefined, high: number | undefined): DeviationEpisode[] {
  if (low == null && high == null) return [];
  const beyond = samples.map((x): Sample => {
    const v = usableValue(x);
    return v == null ? x : { ...x, v: Math.max(0, high != null ? v - high : 0, low != null ? low - v : 0) };
  });
  return deviationEpisodes(beyond, 0, 0, { stepMin: 1 });
}

/** The trailing episode (still open at the last minute), if any. */
export const currentEpisode = (episodes: DeviationEpisode[], now: number) => {
  const last = episodes[episodes.length - 1];
  return last && last.to >= now ? last : null;
};

/** The longest episode inside [from, to). */
const longestWithin = (episodes: DeviationEpisode[], from: number, to: number) =>
  episodes.filter((e) => e.from >= from && e.to <= to).sort((a, b) => b.minutes - a.minutes)[0] ?? null;

/** Text naming each problem signal and why (the engine's wording). */
const problems = (c: SignalCheck) => [...c.missing.map((m) => `${m.signalId} (${m.name}): ${m.reason}`), ...c.stale.map((m) => `${m.signalId} (${m.name}): ${c.reasons[m.signalId]}`)];

/** The check that would let the rule evaluate the signal again. */
function restoreText(id: string, c: SignalCheck): string {
  const out: string[] = [];
  if (c.stale.length) out.push(`Check the data feed (PLC / gateway link) of ${id}: ${list(c.stale.map((x) => x.signalId))} ${c.stale.length === 1 ? 'is' : 'are'} not updating.`);
  const bad = c.missing.filter((m) => m.reason.startsWith('bad quality'));
  if (bad.length) out.push(`Check the transmitter and the quality flag of ${list(bad.map((m) => m.signalId))} at the source.`);
  const rest = c.missing.filter((m) => !bad.includes(m));
  if (rest.length) out.push(`Check why ${list(rest.map((m) => m.signalId))} ${rest.length === 1 ? 'delivers' : 'deliver'} no usable value (tag mapping, wiring, gateway).`);
  return out.join(' ');
}

/** A per-signal 'insufficient-data' evaluation: the signal(s) that cannot be used, and why — never a guess. */
function notEvaluated(ruleId: string, id: string, d: SignalDefinition, c: SignalCheck): RuleEvaluation {
  return {
    status: 'insufficient-data',
    subject: d.signalId,
    title: `${ruleId}: ${lowerFirst(labelOf(d))} not evaluated`,
    explanation: `Not evaluated — requires ${problems(c).join('; ')}.`,
    missingSignals: c.missing,
    staleSignals: c.stale,
    evidence: [...c.missing, ...c.stale].map((m) => ({ kind: 'signal' as const, label: m.name, ref: m.signalId })),
    confidence: 'low',
    confidenceNote: 'The signal is missing, not current or flagged bad — no verdict is given for it.',
    next: restoreText(id, c) || null,
    signals: [d.signalId],
    chartRef: CHART.process(d.signalId),
  };
}

/** The specific check behind a process value out of its band / limits. */
function checkFor(d: SignalDefinition): string {
  const id = d.equipmentId;
  const key = keyOf(d.signalId);
  const zone = d.metadata?.zone;
  if (id === 'H-KILN' && /^zone\d_temp_pv$/.test(key)) {
    const n = Number(zone);
    const peers = [n - 1, n + 1].map((z) => `H-KILN.zone${z}_temp_pv`).filter(inCatalog);
    return `Check the burners and combustion air of kiln zone ${zone} and confirm its roof thermocouple against a reference; compare with the neighbouring zone${peers.length === 1 ? '' : 's'} (${list(peers)}).`;
  }
  if (id === 'F-DRY' && /^zone\d_temp_pv$/.test(key)) return `Check the burner / hot-air supply of dryer zone ${zone} and its thermocouple; compare with the other dryer zone.`;
  switch (key) {
    case 'inlet_temp_pv':
      return 'Check the hot-air generator (D-HAG) burner and its temperature control, and confirm the inlet-duct thermocouple.';
    case 'outlet_temp_pv':
      return 'Check the slip feed to the tower (pump pressure, nozzles) and the inlet air temperature — the outlet temperature follows the drying load.';
    case 'powder_moisture_pv':
      return 'Check the spray-dryer outlet temperature and the slip density (C-SLIP.slip_density_pv), and confirm the moisture analyser with a lab (oven) sample.';
    case 'press_pressure_pv':
      return `Check the hydraulic pressure control of ${id} (proportional valve, accumulator charge) and its pressure transducer; compare with the other presses.`;
    case 'slip_density_pv':
      return 'Check the water / deflocculant dosing at the ball mills and confirm the densimeter with a litre-weight sample.';
    case 'glaze_density_pv':
      return 'Check the water addition at glaze preparation (G-PREP) and confirm the densimeter with a litre-weight sample.';
    case 'oil_temp':
      return `Check the hydraulic oil cooler of ${id} (cooling water flow, fan) and the oil level.`;
    case 'ink_level':
      return 'Check the ink refill from the IBCs and the supply pumps of the printer.';
    default:
      return `Check the control loop of ${lowerFirst(labelOf(d))} on ${id}: the setpoint, the controller output and the sensor.`;
  }
}

/** Defects that originate at the item's stage: the association to look at — never a cause. */
function associationText(id: string): string {
  const stage = OPS_BY_ID[id]?.stage;
  const defects = DEFECT_ORDER.filter((x) => DEFECTS[x].origin === stage).map((x) => DEFECTS[x].label.toLowerCase());
  return defects.length
    ? ` Then compare the sorting rejects for ${list(defects)} of the tiles processed in the episode with the hours before — to investigate: a time association, not a proven cause.`
    : '';
}

/** Operational events of the item in the window (linked as evidence). */
const eventEvidence = (ctx: RuleContext, id: string, w: Window): Evidence[] =>
  ctx
    .events(id, w)
    .slice(0, 3)
    .map((e) => ({ kind: 'event', label: e.title, ref: e.id, window: { from: e.start, to: e.end ?? ctx.now } }));

/** The restart allowance of PC-SETPOINT and PC-LIMIT (each rule has its own copy, so each can be tuned). */
const restartParam: RuleParam = {
  key: 'restartMin',
  label: 'Restart allowance',
  unit: 'min',
  default: 60,
  min: 0,
  max: 240,
  step: 5,
  hint: 'A value already outside its band when the machine restarts after an own stop (a dryer or a kiln zone heating back up) is information for this long after the restart; still outside after it, it is reported at its full severity. 0 = no allowance.',
};

/** Own stops of a machine (its process values hold, cool or have no value by design). */
const OWN_STOP: ReadonlySet<EquipmentState> = new Set<EquipmentState>(['fault', 'stopped', 'planned', 'changeover']);
/** An episode starting this close to a restart was already out of band when the machine resumed. */
const RESTART_SLACK_MIN = 2;

type Restart = { at: number; stop: RuleStop | null; seg: EquipmentStateSegment };

/**
 * The restart an episode began at: the machine resumed operation after an own stop (in the window) with the value
 * already outside its band — a PV recovering from the stop (a dryer or a kiln zone heating back up), not one that
 * drifted away while running. Null without a state signal, or when the episode began later in the run.
 */
function restartOf(ctx: RuleContext, id: string, op: Operation, episodeFrom: number, win: Window): Restart | null {
  if (!op.stated) return null;
  let t = episodeFrom;
  while (t - 1 >= win.from && op.at(t - 1)) t--;
  if (t <= win.from || episodeFrom - t > RESTART_SLACK_MIN) return null;
  const seg = op.seg(t - 1);
  if (!seg || !OWN_STOP.has(seg.state)) return null;
  const stop = ctx.stops(id, { from: t - 1, to: t }).filter((x) => x.end != null && x.end <= t + RESTART_SLACK_MIN).pop() ?? null;
  return { at: t, stop, seg };
}

/**
 * The restart allowance of PC-SETPOINT / PC-LIMIT: an episode that began at a restart (restartOf) is information for
 * `restartMin` minutes after it — the value recovering from the stop, as the machine's own stop behaviour makes it —
 * and is reported at its full severity once it is still outside after that. Texts for the explanation and the check.
 */
function restartAllowance(
  ctx: RuleContext,
  ruleId: string,
  id: string,
  op: Operation,
  episodeFrom: number,
  win: Window,
  label: string,
  band: string,
): { recovering: boolean; lead: string; tail: string; next: string } {
  const r = restartOf(ctx, id, op, episodeFrom, win);
  if (!r) return { recovering: false, lead: '', tail: '', next: '' };
  const allowance = Math.round(ctx.param(ruleId, 'restartMin', id));
  const until = r.at + allowance;
  if (allowance > 0 && ctx.now < until)
    return {
      recovering: true,
      lead: `${id} restarted at ${clock(r.at)} after ${restartWords(r)} with its ${lowerFirst(label)} still outside ${band}: the value is recovering from the stop. `,
      tail: ` Within the ${allowance}-min restart allowance this is information; still outside ${band} at ${clock(until)}, it is reported at its full severity.`,
      next: `Confirm the ${lowerFirst(label)} is back within ${band} by ${clock(until)} (end of the restart allowance); if it is not, `,
    };
  return {
    recovering: false,
    lead: '',
    tail: ` It has been outside ${band} since ${id} restarted at ${clock(r.at)} after ${restartWords(r)}${allowance > 0 ? ` — longer than the ${allowance}-min restart allowance for a value recovering from a stop` : ''}.`,
    next: '',
  };
}

/** "a planned stop (Planned cleaning, 10:10–10:25)" / "a stop (Roller jam, 06:01–07:22)". */
function restartWords(r: Restart): string {
  const kind = (k: string) => (k === 'planned' ? 'a planned stop' : k === 'changeover' ? 'a product changeover' : 'a stop');
  return r.stop
    ? `${kind(r.stop.kind)} (${r.stop.reasonLabel}, ${clock(r.stop.start)}–${clock(r.at)})`
    : `${kind(r.seg.state)} (${r.seg.label ?? OPERATIONAL_STATE_LABEL[r.seg.state]}, until ${clock(r.at)})`;
}

/** Minutes of the window left out of the check, as a sentence. */
const leftOutText = (p: Prepared, op: Operation) =>
  [
    op.stated && p.outMin ? `${p.outMin} min of the window not in operation (own stop or unknown state — the PV is not controlled then)` : '',
    p.implausible ? `${p.implausible} implausible sample${p.implausible === 1 ? '' : 's'} outside the engineering range (PC-MEASUREMENT)` : '',
  ].filter(Boolean);

// ── PC-SETPOINT · deviation from setpoint ────────────────────────────────────

const SETPOINT_ID = 'PC-SETPOINT';

/** Deviation bands (half widths) from the configured absolute limits around the setpoint. */
function bandsOf(d: SignalDefinition, sp: number): { warn: number | null; alarm: number | null } {
  const half = (lo: number | undefined, hi: number | undefined) => (lo != null && hi != null ? (hi - lo) / 2 : hi != null ? Math.abs(hi - sp) : lo != null ? Math.abs(sp - lo) : null);
  const warn = half(d.warningLow, d.warningHigh);
  const alarm = half(d.alarmLow, d.alarmHigh);
  return { warn: warn ?? alarm, alarm };
}

function setpointFinding(ctx: RuleContext, id: string, d: SignalDefinition, op: Operation): RuleEvaluation {
  const pv = d.signalId;
  const spId = d.setpointSignalId!;
  const check = checkSignals(ctx, [pv, spId]);
  if (check.missing.length || check.stale.length) return notEvaluated(SETPOINT_ID, id, d, check);
  const W = Math.round(ctx.param(SETPOINT_ID, 'windowMin', id));
  const N = ctx.param(SETPOINT_ID, 'minMinutes', id);
  const win = ctx.window(W);
  const spRead = ctx.read(spId);
  const spNow = typeof spRead.value === 'number' ? spRead.value : null;
  const label = labelOf(d);
  const base = { subject: pv, chartRef: CHART.process(pv), signals: [pv, spId, ...stateRequired(id)] };
  if (spNow == null)
    return {
      ...base,
      status: 'insufficient-data',
      title: `${SETPOINT_ID}: ${lowerFirst(label)} not evaluated`,
      explanation: `Not evaluated — ${spId} carries no setpoint value.`,
      missingSignals: [{ signalId: spId, name: definitionOf(spId)?.name ?? spId, reason: 'no setpoint value' }],
      next: `Check the recipe / operator setpoint of ${lowerFirst(label)} on ${id}.`,
    };
  const band = bandsOf(d, spNow);
  if (band.warn == null)
    return {
      ...base,
      status: 'insufficient-data',
      title: `${SETPOINT_ID}: ${lowerFirst(label)} not evaluated`,
      explanation: `Not evaluated — no warning or alarm band is configured for ${pv}.`,
      missingSignals: [{ signalId: pv, name: d.name, reason: 'no warning / alarm limits configured' }],
      next: `Configure the warning and alarm limits of ${pv} in the signal catalogue.`,
    };
  const p = prepare(ctx, d, win, op);
  const spSamples = ctx.samples(spId, win);
  const sp = spSamples.some((x) => usableValue(x) != null) ? spSamples : spNow;
  const episodes = deviationEpisodes(p.controlled, sp, band.warn, { stepMin: 1 });
  const alarmEpisodes = band.alarm != null ? deviationEpisodes(p.controlled, sp, band.alarm, { stepMin: 1 }) : [];
  const current = currentEpisode(episodes, ctx.now);
  const pvNow = p.now ? usableValue(p.now) : null;
  const devNow = pvNow != null ? pvNow - spNow : null;
  const measurements: Measurement[] = [
    { signalId: pv, label: 'Process value now', value: round(d, pvNow), unit: d.unit, at: ctx.now - 1 },
    { signalId: spId, label: 'Setpoint', value: round(d, spNow), unit: d.unit, at: spRead.timestamp ?? undefined },
    { label: 'Deviation now', value: round(d, devNow), unit: d.unit, at: ctx.now - 1 },
    { label: 'Warning band (±)', value: round(d, band.warn), unit: d.unit },
    { label: 'Alarm band (±)', value: round(d, band.alarm), unit: d.unit },
  ];
  const evidence: Evidence[] = [
    { kind: 'signal', label: d.name, ref: pv, window: win },
    { kind: 'signal', label: definitionOf(spId)?.name ?? spId, ref: spId, window: win },
    { kind: 'chart', label: label, ref: CHART.process(pv), window: win },
  ];
  const left = leftOutText(p, op);
  const leftText = left.length ? ` Left out: ${list(left)}.` : '';
  const bandText = `warning band ±${fmt(d, band.warn)}${band.alarm != null ? `, alarm band ±${fmt(d, band.alarm)}` : ''}`;
  const past = episodes.filter((e) => e !== current && e.minutes >= N);
  const resolved = past[past.length - 1] ?? null;
  const resolvedText = resolved
    ? ` It was beyond the warning band from ${clock(resolved.from)} to ${clock(resolved.to)} (${duration(resolved.minutes)}, largest deviation ${fmt(d, resolved.maxAbs)}).`
    : '';

  if (current && current.minutes >= N) {
    const alarm = band.alarm != null ? longestWithin(alarmEpisodes, current.from, current.to) : null;
    const serious = !!alarm && alarm.minutes >= N;
    const w = { from: current.from, to: ctx.now };
    measurements.push(
      { label: 'Largest deviation in the episode', value: round(d, current.maxAbs), unit: d.unit, window: w },
      { label: 'Beyond the warning band for', value: current.minutes, unit: 'min', window: w },
      { label: 'Beyond the alarm band for', value: alarm ? alarm.minutes : 0, unit: 'min', window: w },
    );
    const dir = devNow == null ? 'away from' : devNow > 0 ? 'above' : 'below';
    const rs = restartAllowance(ctx, SETPOINT_ID, id, op, current.from, win, label, 'the warning band');
    return {
      ...base,
      status: 'fired',
      severity: rs.recovering ? 'info' : serious ? 'serious' : 'warning',
      title: `${equipmentName(id)}: ${lowerFirst(label)} ${devNow != null ? fmtSigned(d, devNow) : 'off'} from setpoint${rs.recovering ? ' — recovering after the restart' : ''}`,
      explanation:
        `${rs.lead}${pv} has been ${dir} its setpoint by more than the warning band for ${duration(current.minutes)} (since ${clock(current.from)})${op.stated ? ` while ${id} is in operation` : ''}: ` +
        `now ${fmt(d, pvNow)} against a setpoint of ${fmt(d, spNow)} (${devNow != null ? fmtSigned(d, devNow) : 'no current value'}), largest deviation ${fmt(d, current.maxAbs)}. ` +
        `${bandText[0].toUpperCase()}${bandText.slice(1)}${alarm ? `; beyond the alarm band for ${duration(alarm.minutes)} (since ${clock(alarm.from)})` : ''}. Reported after ${num(N)} min beyond the warning band; history read over the last ${W} min (${span(win)}).${rs.tail}${leftText}`,
      measurements,
      window: w,
      evidence: [...evidence, ...eventEvidence(ctx, id, w)],
      next: `${rs.recovering ? `${rs.next}${lowerFirst(checkFor(d))}` : checkFor(d)}${associationText(id)}`,
      firstSeen: current.from,
    };
  }
  const seg = op.seg(ctx.now - 1);
  if (!op.at(ctx.now - 1))
    return {
      ...base,
      status: 'clear',
      title: `${equipmentName(id)}: ${lowerFirst(label)} not assessed now`,
      explanation: `Not assessed now: ${id} is ${stateWords(seg)} — in an own stop the PV is not controlled to its setpoint (it holds, cools or has no value by design).${resolvedText}`,
      measurements,
      window: win,
      evidence,
      confidence: 'low',
      confidenceNote: 'No deviation check while the machine is not in operation.',
      next: null,
      resolvedAt: resolved ? resolved.to : null,
    };
  if (pvNow == null)
    return {
      ...base,
      status: 'clear',
      title: `${equipmentName(id)}: ${lowerFirst(label)} not assessed now`,
      explanation: `Not assessed now: ${pv} has no usable value for the last minute (${ctx.read(pv).note ?? 'no value'}) — no deviation is assumed.${resolvedText}`,
      measurements,
      window: win,
      evidence,
      confidence: 'low',
      confidenceNote: 'No current process value to compare with the setpoint.',
      next: null,
      resolvedAt: resolved ? resolved.to : null,
    };
  const pending = current ? ` Beyond the warning band for the last ${duration(current.minutes)} — reported after ${num(N)} min.` : '';
  return {
    ...base,
    status: 'clear',
    title: `${equipmentName(id)}: ${lowerFirst(label)} at setpoint`,
    explanation: `${pv} ${fmt(d, pvNow)} against a setpoint of ${fmt(d, spNow)} (${fmtSigned(d, devNow!)}), within the ${bandText} over the last ${W} min (${span(win)}).${pending}${resolvedText}${leftText}`,
    measurements,
    window: win,
    evidence,
    next: null,
    resolvedAt: resolved ? resolved.to : null,
  };
}

const PC_SETPOINT: RuleDef = {
  id: SETPOINT_ID,
  family: 'process',
  classification: 'rule-based',
  title: 'Deviation from setpoint',
  description:
    'For each simulated process value with a setpoint: |PV − SP| beyond the warning band (half the configured warning limits around the setpoint) for at least the minimum duration while the machine is in operation; serious when it stays beyond the alarm band for that long. Own stops, unknown states and implausible readings are left out; a value still recovering from an own stop after the restart is information within the restart allowance.',
  appliesTo: (scope) => scope.kind === 'equipment' && setpointPvs(scope.equipmentId).length > 0,
  requiredSignals: (scope) => stateRequired(idOf(scope)),
  params: [
    { key: 'minMinutes', label: 'Beyond the warning band for at least', unit: 'min', default: 5, min: 1, max: 120, step: 1, hint: 'A deviation is reported once it has lasted this long (noise and short excursions are not).' },
    { key: 'windowMin', label: 'Look back', unit: 'min', default: 120, min: 30, max: 480, step: 10, hint: 'How far back the PV / SP history is read (episodes, recently resolved deviations).' },
    restartParam,
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const op = operationOf(ctx, id, ctx.window(Math.round(ctx.param(SETPOINT_ID, 'windowMin', id))));
    return setpointPvs(id).map((d) => setpointFinding(ctx, id, d, op));
  },
};

// ── PC-LIMIT · outside configured limits ─────────────────────────────────────

const LIMIT_ID = 'PC-LIMIT';

function limitFinding(ctx: RuleContext, id: string, d: SignalDefinition, op: Operation): RuleEvaluation {
  const sig = d.signalId;
  const check = checkSignals(ctx, [sig]);
  if (check.missing.length || check.stale.length) return notEvaluated(LIMIT_ID, id, d, check);
  const W = Math.round(ctx.param(LIMIT_ID, 'windowMin', id));
  const N = ctx.param(LIMIT_ID, 'minMinutes', id);
  const win = ctx.window(W);
  const label = labelOf(d);
  const base = { subject: sig, chartRef: CHART.process(sig), signals: [sig, ...stateRequired(id)] };
  // The warning limits (the alarm limits where no warning limit is configured).
  const wLow = d.warningLow ?? d.alarmLow;
  const wHigh = d.warningHigh ?? d.alarmHigh;
  const p = prepare(ctx, d, win, op);
  const episodes = limitEpisodes(p.controlled, wLow, wHigh);
  const alarmEpisodes = limitEpisodes(p.controlled, d.alarmLow, d.alarmHigh);
  const current = currentEpisode(episodes, ctx.now);
  const vNow = p.now ? usableValue(p.now) : null;
  const limitsText = [
    wLow != null || wHigh != null ? `warning ${wLow != null ? `low ${fmt(d, wLow)}` : ''}${wLow != null && wHigh != null ? ' / ' : ''}${wHigh != null ? `high ${fmt(d, wHigh)}` : ''}` : '',
    d.alarmLow != null || d.alarmHigh != null
      ? `alarm ${d.alarmLow != null ? `low ${fmt(d, d.alarmLow)}` : ''}${d.alarmLow != null && d.alarmHigh != null ? ' / ' : ''}${d.alarmHigh != null ? `high ${fmt(d, d.alarmHigh)}` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('; ');
  const measurements: Measurement[] = [
    { signalId: sig, label: 'Value now', value: round(d, vNow), unit: d.unit, at: ctx.now - 1 },
    { label: 'Warning low', value: round(d, wLow ?? null), unit: d.unit },
    { label: 'Warning high', value: round(d, wHigh ?? null), unit: d.unit },
    { label: 'Alarm low', value: round(d, d.alarmLow ?? null), unit: d.unit },
    { label: 'Alarm high', value: round(d, d.alarmHigh ?? null), unit: d.unit },
  ];
  const evidence: Evidence[] = [
    { kind: 'signal', label: d.name, ref: sig, window: win },
    { kind: 'chart', label: label, ref: CHART.process(sig), window: win },
  ];
  const left = leftOutText(p, op);
  const leftText = left.length ? ` Left out: ${list(left)}.` : '';
  const past = episodes.filter((e) => e !== current && e.minutes >= N);
  const resolved = past[past.length - 1] ?? null;
  const resolvedText = resolved ? ` It was outside its warning limits from ${clock(resolved.from)} to ${clock(resolved.to)} (${duration(resolved.minutes)}, up to ${fmt(d, resolved.maxAbs)} beyond).` : '';

  if (current && current.minutes >= N) {
    const alarm = longestWithin(alarmEpisodes, current.from, current.to);
    const serious = !!alarm && alarm.minutes >= N;
    const high = vNow != null ? wHigh != null && vNow > wHigh : wHigh != null;
    const limit = high ? wHigh! : wLow!;
    const w = { from: current.from, to: ctx.now };
    measurements.push(
      { label: 'Furthest beyond the warning limit', value: round(d, current.maxAbs), unit: d.unit, window: w },
      { label: 'Outside the warning limits for', value: current.minutes, unit: 'min', window: w },
      { label: 'Outside the alarm limits for', value: alarm ? alarm.minutes : 0, unit: 'min', window: w },
    );
    const alarmLimit = high ? d.alarmHigh : d.alarmLow;
    const rs = restartAllowance(ctx, LIMIT_ID, id, op, current.from, win, label, 'its warning limits');
    return {
      ...base,
      status: 'fired',
      severity: rs.recovering ? 'info' : serious ? 'serious' : 'warning',
      title: `${equipmentName(id)}: ${lowerFirst(label)} ${high ? 'above' : 'below'} its ${serious ? 'alarm' : 'warning'} limit${rs.recovering ? ' — recovering after the restart' : ''}`,
      explanation:
        `${rs.lead}${sig} has been ${high ? 'above its high' : 'below its low'} warning limit of ${fmt(d, limit)} for ${duration(current.minutes)} (since ${clock(current.from)})${op.stated ? ` while ${id} is in operation` : ''}: ` +
        `now ${fmt(d, vNow)}${vNow != null ? ` (${fmt(d, Math.abs(vNow - limit))} ${high ? 'above' : 'below'} the limit)` : ''}, up to ${fmt(d, current.maxAbs)} beyond it in the episode.` +
        `${alarmLimit != null ? ` Alarm limit ${fmt(d, alarmLimit)}${alarm ? `: beyond it for ${duration(alarm.minutes)} (since ${clock(alarm.from)})` : ': not reached'}.` : ''}` +
        ` The limits (${limitsText}) are fixed engineering limits from the signal configuration, checked regardless of the setpoint; reported after ${num(N)} min outside them.${rs.tail}${leftText}`,
      measurements,
      window: w,
      evidence: [...evidence, ...eventEvidence(ctx, id, w)],
      next: `${rs.recovering ? `${rs.next}${lowerFirst(checkFor(d))}` : checkFor(d)}${associationText(id)}`,
      firstSeen: current.from,
    };
  }
  const seg = op.seg(ctx.now - 1);
  if (!op.at(ctx.now - 1) || vNow == null)
    return {
      ...base,
      status: 'clear',
      title: `${equipmentName(id)}: ${lowerFirst(label)} limits not assessed now`,
      explanation: `Not assessed now: ${
        !op.at(ctx.now - 1) ? `${id} is ${stateWords(seg)} — limits are checked while the machine is in operation` : `${sig} has no usable value for the last minute (${ctx.read(sig).note ?? 'no value'})`
      }.${resolvedText}`,
      measurements,
      window: win,
      evidence,
      confidence: 'low',
      confidenceNote: 'No current value in operation to compare with the limits.',
      next: null,
      resolvedAt: resolved ? resolved.to : null,
    };
  const pending = current ? ` Outside the warning limits for the last ${duration(current.minutes)} — reported after ${num(N)} min.` : '';
  return {
    ...base,
    status: 'clear',
    title: `${equipmentName(id)}: ${lowerFirst(label)} within limits`,
    explanation: `${sig} ${fmt(d, vNow)}, within its limits (${limitsText}) over the last ${W} min (${span(win)}).${pending}${resolvedText}${leftText}`,
    measurements,
    window: win,
    evidence,
    next: null,
    resolvedAt: resolved ? resolved.to : null,
  };
}

const PC_LIMIT: RuleDef = {
  id: LIMIT_ID,
  family: 'process',
  classification: 'rule-based',
  title: 'Process value outside limits',
  description:
    'For each simulated process value with configured warning / alarm limits: outside the warning limits for at least the minimum duration while the machine is in operation, regardless of the setpoint; serious when outside the alarm limits for that long (information within the restart allowance while it recovers from an own stop). Condition-monitoring signals (vibration, bearing temperature, motor current) are left to the reliability rules.',
  appliesTo: (scope) => scope.kind === 'equipment' && limitSignals(scope.equipmentId).length > 0,
  requiredSignals: (scope) => stateRequired(idOf(scope)),
  params: [
    { key: 'minMinutes', label: 'Outside the limits for at least', unit: 'min', default: 3, min: 1, max: 120, step: 1, hint: 'A limit violation is reported once it has lasted this long.' },
    { key: 'windowMin', label: 'Look back', unit: 'min', default: 120, min: 30, max: 480, step: 10, hint: 'How far back the history is read (episodes, recently resolved violations).' },
    restartParam,
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const op = operationOf(ctx, id, ctx.window(Math.round(ctx.param(LIMIT_ID, 'windowMin', id))));
    return limitSignals(id).map((d) => limitFinding(ctx, id, d, op));
  },
};

// ── PC-MEASUREMENT · measurement missing / bad / implausible ─────────────────

const MEASUREMENT_ID = 'PC-MEASUREMENT';

type Invalid = { t: number; kind: 'bad' | 'missing' | 'implausible'; v?: number };

function measurementFinding(ctx: RuleContext, id: string, d: SignalDefinition, op: Operation): RuleEvaluation {
  const sig = d.signalId;
  const W = Math.round(ctx.param(MEASUREMENT_ID, 'windowMin', id));
  const R = Math.round(Math.min(ctx.param(MEASUREMENT_ID, 'recentMin', id), W));
  const minInvalid = Math.round(ctx.param(MEASUREMENT_ID, 'minInvalid', id));
  const win = ctx.window(W);
  const recentFrom = ctx.now - R;
  const label = labelOf(d);
  const base = { subject: sig, chartRef: CHART.process(sig), signals: [sig, ...stateRequired(id)] };
  // A value that is not current (frozen, feed lost) is not judged here: the data-quality rules report it.
  const check = checkSignals(ctx, [sig]);
  const blocking = { ...check, missing: check.missing.filter((m) => !m.reason.startsWith('bad quality') && !m.reason.startsWith('no current value')) };
  if (blocking.missing.length || blocking.stale.length) {
    const ev = notEvaluated(MEASUREMENT_ID, id, d, blocking);
    return { ...ev, explanation: `${ev.explanation} A value that is not updating is reported by the data-quality rules, not as an invalid measurement.` };
  }
  const invalid: Invalid[] = [];
  let checked = 0;
  // A PV configured to have no value while its machine does not produce (press pressure without a stroke, powder
  // moisture without powder) is only expected while it produces; any other measurement whenever in operation.
  const onlyProducing = PROCESS_SIGNAL_BY_ID[sig]?.stopped?.kind === 'none';
  for (const x of ctx.samples(sig, win)) {
    if (!op.at(x.t)) continue;
    const seg = op.seg(x.t);
    const producing = !op.stated || !onlyProducing || (!!seg && RUNNING.has(seg.state));
    checked++;
    if (x.q === 'bad') invalid.push({ t: x.t, kind: 'bad' });
    else if (x.q === 'stale') continue;
    else if (x.v == null) {
      if (producing) invalid.push({ t: x.t, kind: 'missing' });
    } else if (!plausible(d, x.v)) invalid.push({ t: x.t, kind: 'implausible', v: x.v });
  }
  const recent = invalid.filter((x) => x.t >= recentFrom);
  // The episode: invalid samples no further apart than the recent window, back from the latest.
  let start: number | null = null;
  if (recent.length) {
    start = invalid[invalid.length - 1].t;
    for (let i = invalid.length - 2; i >= 0 && start - invalid[i].t <= R; i--) start = invalid[i].t;
  }
  const measurements: Measurement[] = [
    { signalId: sig, label: 'Invalid samples in the recent window', value: recent.length, unit: 'samples', window: { from: recentFrom, to: ctx.now } },
    { label: 'Bad quality', value: recent.filter((x) => x.kind === 'bad').length, unit: 'samples', window: { from: recentFrom, to: ctx.now } },
    { label: 'No sample', value: recent.filter((x) => x.kind === 'missing').length, unit: 'samples', window: { from: recentFrom, to: ctx.now } },
    { label: 'Outside the engineering range', value: recent.filter((x) => x.kind === 'implausible').length, unit: 'samples', window: { from: recentFrom, to: ctx.now } },
    { label: 'Engineering range low', value: round(d, d.engineeringMin ?? null), unit: d.unit },
    { label: 'Engineering range high', value: round(d, d.engineeringMax ?? null), unit: d.unit },
  ];
  const evidence: Evidence[] = [
    { kind: 'signal', label: d.name, ref: sig, window: win },
    { kind: 'chart', label: label, ref: CHART.process(sig), window: win },
  ];
  const lastInvalid = invalid[invalid.length - 1] ?? null;
  if (recent.length >= minInvalid && start != null) {
    const n = (k: Invalid['kind']) => recent.filter((x) => x.kind === k);
    const bad = n('bad');
    const missing = n('missing');
    const spikes = n('implausible');
    const lastSpike = spikes[spikes.length - 1];
    const parts = [
      bad.length ? `a bad quality flag on ${bad.length} of the last ${R} min` : '',
      missing.length ? `no sample in ${missing.length} of the last ${R} min${onlyProducing ? ' while producing' : ''}` : '',
      spikes.length
        ? `${spikes.length} reading${spikes.length === 1 ? '' : 's'} outside its engineering range of ${rangeText(d)} (latest ${fmt(d, lastSpike.v)} at ${clock(lastSpike.t)})`
        : '',
    ].filter(Boolean);
    const note = ctx.read(sig).note;
    const next = [
      bad.length ? `Check the transmitter of ${sig} and the channel status at its PLC input (the source flags the value bad); confirm with a hand-held reading.` : '',
      missing.length ? `Check why ${sig} delivers no samples: the transmitter supply, the PLC input and the tag mapping at the gateway.` : '',
      spikes.length ? `Check the sensor, its wiring and the scaling of ${sig} at the PLC input — a reading of ${fmt(d, lastSpike.v)} is not physically plausible; confirm with a hand-held reading.` : '',
    ].filter(Boolean);
    const w = { from: start, to: ctx.now };
    return {
      ...base,
      status: 'fired',
      severity: 'warning',
      title: `${equipmentName(id)}: ${lowerFirst(label)} measurement invalid`,
      explanation:
        `${sig} — measurement invalid${op.stated ? ` while ${id} is in operation` : ''}: ${list(parts)}; first invalid sample of this episode at ${clock(start)}.${note ? ` Source note: ${note}.` : ''} ` +
        `This is a measurement problem, not a process deviation: PC-SETPOINT and PC-LIMIT leave these samples out${bad.length || missing.length ? ' and give no verdict while the value is unusable' : ''}. Reported from ${num(minInvalid)} invalid sample${minInvalid === 1 ? '' : 's'} in ${R} min.`,
      measurements,
      window: w,
      evidence: [...evidence, ...eventEvidence(ctx, id, w)],
      next: next.join(' '),
      firstSeen: start,
    };
  }
  const resolvedAt = lastInvalid ? lastInvalid.t + 1 : null;
  const resolvedText = lastInvalid ? ` Invalid readings until ${clock(resolvedAt!)} (${lastInvalid.kind === 'implausible' ? 'outside the engineering range' : lastInvalid.kind === 'bad' ? 'bad quality flag' : 'no sample'}) — valid since.` : '';
  if (!op.at(ctx.now - 1))
    return {
      ...base,
      status: 'clear',
      title: `${equipmentName(id)}: ${lowerFirst(label)} measurement not assessed now`,
      explanation: `Not assessed now: ${id} is ${stateWords(op.seg(ctx.now - 1))} — the measurement is checked while the machine is in operation.${resolvedText}`,
      measurements,
      window: win,
      evidence,
      confidence: 'low',
      confidenceNote: 'No measurement check while the machine is not in operation.',
      next: null,
      resolvedAt,
    };
  return {
    ...base,
    status: 'clear',
    title: `${equipmentName(id)}: ${lowerFirst(label)} measurement valid`,
    explanation: `${sig} delivers valid readings: no bad quality flag, no missing sample${onlyProducing ? ' while producing' : ''} and nothing outside its engineering range of ${rangeText(d)} in the last ${R} min (${span({ from: recentFrom, to: ctx.now })}); ${checked} min in operation checked over the last ${W} min.${resolvedText}`,
    measurements,
    window: { from: recentFrom, to: ctx.now },
    evidence,
    next: null,
    resolvedAt,
  };
}

/** The one finding naming the process measurements the catalogue has for the item but this simulation does not. */
function notAvailableFinding(id: string, defs: SignalDefinition[]): RuleEvaluation {
  const reason = (d: SignalDefinition) => {
    const what = d.availabilityStatus === 'not-modelled' ? 'not modelled in this simulation' : d.availabilityStatus === 'reference' ? 'reference data, not a signal' : 'unavailable';
    return d.statusNote ? `${what} — ${d.statusNote.replace(/\.$/, '')}` : what;
  };
  const all = defs.map((d) => lowerFirst(labelOf(d)));
  const names = all.length > 4 ? [...all.slice(0, 3), `${all.length - 3} more`] : all;
  return {
    status: 'insufficient-data',
    subject: 'not-available',
    title: `Process measurements not available: ${list(names)}`,
    explanation: `Process measurements not available for ${id}: ${defs.map((d) => `${d.signalId} (${d.name}): ${reason(d)}`).join('; ')}. No process-control verdict is given for them — not a deviation, not a valid reading.`,
    missingSignals: defs.map((d) => ({ signalId: d.signalId, name: d.name, reason: reason(d) })),
    evidence: defs.map((d) => ({ kind: 'signal' as const, label: d.name, ref: d.signalId })),
    confidence: 'low',
    confidenceNote: 'Listed in the signal catalogue but not produced by this simulation — nothing to evaluate.',
    next: `Map ${list(defs.map((d) => d.signalId))} to real signals at integration (instrument and controller tag) — not available in this simulation.`,
    signals: defs.map((d) => d.signalId),
  };
}

const PC_MEASUREMENT: RuleDef = {
  id: MEASUREMENT_ID,
  family: 'process',
  classification: 'rule-based',
  title: 'Process measurement invalid',
  description:
    'For each simulated process measurement: a bad quality flag, no sample while the machine produces, or a reading outside the engineering range while the machine is in operation — a measurement problem, distinct from a process deviation. A value that is not updating is left to the data-quality rules. Process measurements the catalogue lists but this simulation does not have are named in one not-evaluated finding per equipment item.',
  appliesTo: (scope) => scope.kind === 'equipment' && (measured(scope.equipmentId).length > 0 || notAvailable(scope.equipmentId).length > 0),
  requiredSignals: (scope) => (measured(idOf(scope)).length ? stateRequired(idOf(scope)) : []),
  params: [
    { key: 'recentMin', label: 'Recent window', unit: 'min', default: 15, min: 5, max: 120, step: 5, hint: 'Invalid samples are counted over this trailing window.' },
    { key: 'minInvalid', label: 'Report from', unit: 'invalid samples', default: 1, min: 1, max: 60, step: 1, hint: 'Number of invalid samples in the recent window that makes the measurement invalid.' },
    { key: 'windowMin', label: 'Look back', unit: 'min', default: 120, min: 30, max: 480, step: 10, hint: 'How far back the history is read (episode start, recently resolved problems).' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const out: RuleEvaluation[] = [];
    const defs = measured(id);
    if (defs.length) {
      const op = operationOf(ctx, id, ctx.window(Math.round(ctx.param(MEASUREMENT_ID, 'windowMin', id))));
      for (const d of defs) out.push(measurementFinding(ctx, id, d, op));
    }
    const missing = notAvailable(id);
    if (missing.length) out.push(notAvailableFinding(id, missing));
    return out;
  },
};

/** The process-control rules, in display order. */
export const PROCESS_RULES: RuleDef[] = [PC_SETPOINT, PC_LIMIT, PC_MEASUREMENT];
