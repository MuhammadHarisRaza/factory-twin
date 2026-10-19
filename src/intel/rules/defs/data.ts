/**
 * Data-quality rules (brief §5 / §7): signals that are not current (stale / late against their expected update
 * interval), a whole source interrupted, values frozen while the machine runs, samples flagged bad, timestamp gaps,
 * counter resets and rollovers, and readings outside the engineering range. Prefix DQ-. Every rule is a threshold
 * check on what the telemetry source delivers — timestamps, quality flags and values — never on the simulation's
 * internal feed state: a real adapter's data would be judged the same way.
 *
 * Scope: one finding per rule per equipment item, listing the affected signals (the plant and stage views include
 * them through their equipment). One cause, one finding: when every scanned signal of an asset stops updating at
 * once that is a source interruption (DQ-SOURCE), not a list of stale signals; a signal frozen while the asset's
 * state signal is current and reports running is DQ-FROZEN, not DQ-STALE. Event-driven signals (no expected update
 * interval: alarms, gate events, QC results) are never judged by age.
 *
 * Data rules examine the very signals the engine would otherwise refuse to evaluate (stale, bad, missing), so they
 * declare no required signals — except DQ-FROZEN, which needs a current state signal to say the value should be
 * changing. The signals examined are named in each finding's provenance.
 */
import { counterDelta, freshness, gaps, outOfRange, usableValue, type FreshnessStatus, type Sample, type Window } from '../../../calc';
import { catalogFor, PROCESS_SIGNAL_BY_ID, type SignalDefinition } from '../../../model/catalog';
import { CONVEYOR_BY_ID } from '../../../model/plant';
import type { TelemetrySample } from '../../../model/telemetry';
import type { RuleContext } from '../context';
import { CHART, type Evidence, type Measurement, type RuleDef, type RuleScope } from '../types';
import { RUNNING, clock, duration, equipmentName, idealRateOf, list, minutesWhere, num, span, stateLookup, stateSignalOf } from '../util';

// ── Shared ───────────────────────────────────────────────────────────────────

const STALE_ID = 'DQ-STALE';
const SOURCE_ID = 'DQ-SOURCE';
const FROZEN_ID = 'DQ-FROZEN';
const BAD_ID = 'DQ-BAD-QUALITY';
const GAP_ID = 'DQ-GAP';
const RESET_ID = 'DQ-COUNTER-RESET';
const RANGE_ID = 'DQ-IMPLAUSIBLE';

/** Signals the source should deliver: in the catalogue as simulated (or, with a real adapter, connected). */
const delivered = (d: SignalDefinition) => d.availabilityStatus === 'simulated' || d.availabilityStatus === 'connected';
const signalsOf = (id: string) => catalogFor(id).filter(delivered);
/** Scanned signals: expected to update every expectedUpdateIntervalS (event-driven ones are not judged by age). */
const scannedOf = (id: string) => signalsOf(id).filter((d) => d.expectedUpdateIntervalS != null && d.expectedUpdateIntervalS > 0);
/** Signals with a numeric history (counters, analog values, commands as 0 / 1). */
const numericOf = (id: string) => scannedOf(id).filter((d) => d.dataType === 'float' || d.dataType === 'integer' || d.dataType === 'boolean');
const idOf = (scope: RuleScope) => (scope.kind === 'equipment' ? scope.equipmentId : '');

/** "E-PRS1.rate, E-PRS1.count_total and 6 more". */
function names(ids: string[], max = 4): string {
  if (ids.length <= max) return list(ids);
  return `${ids.slice(0, max).join(', ')} and ${ids.length - max} more`;
}
/** A reading as text: whole numbers above 100, two decimals below ("1,950", "0.42"). */
const value = (v: number) => num(v, Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 2);
const interval = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`);
/** "12 s" / "4 min" / "1 h 05 min". */
const age = (seconds: number) => (seconds < 60 ? `${Math.round(seconds)} s` : duration(seconds / 60));

/** The recent window of a data rule, never before the first simulated minute. */
const recentWindow = (ctx: RuleContext, minutes: number): Window => ({ from: Math.max(0, ctx.now - Math.round(minutes)), to: ctx.now });

// ── Current readings: freshness of every signal of an asset ──────────────────

type ReadingKind = 'current' | 'late' | 'stale' | 'no-value' | 'bad' | 'event';

type ReadingView = { def: SignalDefinition; r: TelemetrySample; kind: ReadingKind; fresh: FreshnessStatus; ageS: number | null; scanned: boolean };

type FeedView = {
  readings: ReadingView[];
  scanned: ReadingView[];
  /** Scanned signals not updating: late, stale, or no value with an old / no timestamp. */
  notCurrent: ReadingView[];
  /** Every scanned signal not updating (≥ 2 of them): a source interruption. */
  whole: boolean;
  /** Signals frozen while the state signal is current and reports running (DQ-FROZEN). */
  frozen: ReadingView[];
  /** Late / stale signals left to DQ-STALE (not the whole source, not frozen). */
  stale: ReadingView[];
  /** The state signal's reading when it is current and good, else null. */
  state: TelemetrySample | null;
  running: boolean;
};

/** Categories whose value follows the operation (a frozen one while running is suspicious); not setpoints, states or alarms. */
const CHANGING: ReadonlySet<SignalDefinition['category']> = new Set(['production', 'process', 'drive', 'condition', 'material', 'quality', 'command']);
const RUNNING_VALUES: ReadonlySet<string> = new Set(['running', 'reduced']);

const feedMemo = new WeakMap<RuleContext, Map<string, FeedView>>();

/**
 * Classifies the current reading of every delivered signal of an asset (one pass, memoised per context): a bad
 * flag; no value (a gap); flagged stale by the source; or — for scanned signals — late / stale by the age of its
 * timestamp against the expected update interval (src/calc freshness, DQ-STALE's factors). Then splits what is not
 * current between a whole-source interruption, values frozen while the asset runs, and the rest (stale).
 */
function feedOf(ctx: RuleContext, id: string): FeedView {
  let memo = feedMemo.get(ctx);
  if (!memo) feedMemo.set(ctx, (memo = new Map()));
  const late = ctx.param(STALE_ID, 'lateFactor', id);
  const staleF = Math.max(late, ctx.param(STALE_ID, 'staleFactor', id));
  const key = `${id}|${late}|${staleF}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const readings: ReadingView[] = [];
  for (const def of signalsOf(id)) {
    const r = ctx.read(def.signalId);
    if (r.status === 'not-modelled' || r.status === 'unavailable') continue;
    const scanned = def.expectedUpdateIntervalS != null && def.expectedUpdateIntervalS > 0;
    const f = freshness(r.timestamp, ctx.now, scanned ? def.expectedUpdateIntervalS : null, { lateFactor: late, staleFactor: staleF });
    let kind: ReadingKind;
    if (r.quality === 'bad') kind = 'bad';
    else if (r.quality === 'missing' || f.status === 'missing') kind = scanned ? 'no-value' : 'event';
    else if (r.quality === 'stale') kind = 'stale';
    else if (!scanned) kind = 'event';
    else kind = f.status === 'stale' ? 'stale' : f.status === 'late' ? 'late' : 'current';
    readings.push({ def, r, kind, fresh: f.status, ageS: f.ageS, scanned });
  }
  const scanned = readings.filter((x) => x.scanned);
  const notCurrent = scanned.filter((x) => x.kind === 'late' || x.kind === 'stale' || x.kind === 'no-value');
  const whole = scanned.length >= 2 && notCurrent.length === scanned.length;
  const stateId = stateSignalOf(id);
  const st = readings.find((x) => x.def.signalId === stateId);
  const state = st && st.kind === 'current' && st.r.quality === 'good' ? st.r : null;
  let running = false;
  const frozen: ReadingView[] = [];
  if (!whole && state && typeof state.value === 'string' && RUNNING_VALUES.has(state.value)) {
    running = true;
    for (const x of scanned) {
      if (x.def.signalId === stateId || !CHANGING.has(x.def.category) || x.r.timestamp == null) continue;
      // Frozen: no new value (and timestamp) for longer than the stale age.
      if (x.kind !== 'stale' || x.ageS == null || x.ageS <= staleF * (x.def.expectedUpdateIntervalS as number)) continue;
      // …while the asset ran for most of that time (the value should have been changing).
      const w = { from: x.r.timestamp + 1, to: ctx.now };
      const ran = minutesWhere(ctx.states(id, w), w, (s) => RUNNING.has(s) || (s === 'idle' && !!CONVEYOR_BY_ID[id]));
      if (ran >= 0.8 * (w.to - w.from)) frozen.push(x);
    }
  }
  const stale = whole ? [] : readings.filter((x) => (x.kind === 'late' || x.kind === 'stale') && !frozen.includes(x));
  const view: FeedView = { readings, scanned, notCurrent, whole, frozen, stale, state, running };
  memo.set(key, view);
  return view;
}

const lastUpdate = (x: ReadingView) => (x.r.timestamp != null ? clock(x.r.timestamp) : 'never');
/** "E-PRS1.rate (last value 10:12, 9 min ago)". */
const staleItem = (x: ReadingView) => `${x.def.signalId} (last value ${lastUpdate(x)}${x.ageS != null ? `, ${age(x.ageS)} ago` : ''}${x.r.quality === 'stale' && x.r.note ? ` — ${x.r.note.charAt(0).toLowerCase()}${x.r.note.slice(1)}` : ''})`;
const signalEvidence = (xs: ReadingView[], w?: Window): Evidence[] => xs.slice(0, 6).map((x) => ({ kind: 'signal', label: x.def.name, ref: x.def.signalId, ...(w ? { window: w } : {}) }));
const eventsOf = (ctx: RuleContext, id: string, w: Window): Evidence[] => ctx.events(id, w).filter((e) => e.category === 'data').slice(0, 2).map((e) => ({ kind: 'event', label: e.title, ref: e.id }));

/** The DQ-STALE thresholds the stale, source and frozen rules share. */
const STALE_PARAMS: RuleDef['params'] = [
  { key: 'lateFactor', label: 'Late after', unit: '× the expected update interval', decimals: 1, default: 2, min: 1.2, max: 20, step: 0.1, hint: 'A scanned signal whose last value is older than this many update intervals is late (shared with DQ-SOURCE).' },
  { key: 'staleFactor', label: 'Stale after', unit: '× the expected update interval', decimals: 1, default: 5, min: 2, max: 60, step: 0.5, hint: 'Older than this many update intervals it is stale (shared with DQ-SOURCE and DQ-FROZEN: the stale age).' },
];

// ── DQ-STALE · signals not current ───────────────────────────────────────────

const DQ_STALE: RuleDef = {
  id: STALE_ID,
  family: 'data',
  classification: 'rule-based',
  title: 'Signals not current',
  description:
    "Scanned signals whose last value is older than the late / stale age (× their expected update interval), or that the source flags stale, while the asset's other signals still update. A whole feed that stops at once is a source interruption (DQ-SOURCE); a value frozen while the machine runs is DQ-FROZEN. Event-driven signals are not judged by age.",
  appliesTo: (scope) => scope.kind === 'equipment' && scannedOf(scope.equipmentId).length > 0,
  requiredSignals: () => [],
  params: STALE_PARAMS,
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const f = feedOf(ctx, id);
    const signals = f.readings.map((x) => x.def.signalId);
    const ivs = [...new Set(f.scanned.map((x) => x.def.expectedUpdateIntervalS as number))].map(interval);
    const events = f.readings.filter((x) => !x.scanned).length;
    const evText = events ? ` ${events} event-driven signal${events === 1 ? ' is' : 's are'} not judged by age.` : '';
    if (f.whole)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: reported as a source interruption`,
        explanation: `Every scanned signal of ${id} has stopped updating — reported once as a source interruption (${SOURCE_ID}), not signal by signal.`,
        evidence: [{ kind: 'rule', label: 'Source interruption', ref: SOURCE_ID }],
        next: null,
        signals,
      };
    if (!f.stale.length) {
      const current = f.scanned.filter((x) => x.kind === 'current').length;
      const others = [
        f.frozen.length ? `${names(f.frozen.map((x) => x.def.signalId))} frozen while ${id} runs (${FROZEN_ID})` : '',
        f.notCurrent.some((x) => x.kind === 'no-value') ? `${names(f.notCurrent.filter((x) => x.kind === 'no-value').map((x) => x.def.signalId))} delivering no value (${GAP_ID})` : '',
        f.readings.some((x) => x.kind === 'bad') ? `${f.readings.filter((x) => x.kind === 'bad').length} flagged bad (${BAD_ID})` : '',
      ].filter(Boolean);
      return {
        status: 'clear',
        title: `${equipmentName(id)}: signals current`,
        explanation: `${current} of ${f.scanned.length} scanned signals of ${id} updated within ${num(ctx.param(STALE_ID, 'lateFactor', id), 1)}× their expected interval (${list(ivs)}; last update ${clock(ctx.now - 1)}).${others.length ? ` Reported by other rules: ${others.join('; ')}.` : ''}${evText}`,
        evidence: signalEvidence(f.scanned.slice(0, 2)),
        next: null,
        signals,
      };
    }
    const staleOnes = f.stale.filter((x) => x.kind === 'stale');
    const oldest = f.stale.reduce((a, b) => ((b.r.timestamp ?? -Infinity) < (a.r.timestamp ?? -Infinity) ? b : a));
    const since = oldest.r.timestamp;
    const measurements: Measurement[] = [
      { label: 'Signals not current', value: f.stale.length, unit: 'signals' },
      { label: 'Scanned signals of the asset', value: f.scanned.length, unit: 'signals' },
      ...f.stale.slice(0, 6).map((x): Measurement => ({ signalId: x.def.signalId, label: `${x.def.name}: age of the last value`, value: x.ageS != null ? Math.round(x.ageS) : null, unit: 's', ...(x.r.timestamp != null ? { at: x.r.timestamp } : {}) })),
    ];
    const updating = f.scanned.length - f.notCurrent.length;
    return {
      status: 'fired',
      severity: staleOnes.length ? 'warning' : 'info',
      title: `${equipmentName(id)}: ${f.stale.length} signal${f.stale.length === 1 ? '' : 's'} ${staleOnes.length ? 'stale' : 'late'}`,
      explanation: `${f.stale.length} signal${f.stale.length === 1 ? '' : 's'} of ${id} ${f.stale.length === 1 ? 'is' : 'are'} not current: ${f.stale.map(staleItem).join('; ')}. Expected every ${list(ivs)} — late beyond ${num(ctx.param(STALE_ID, 'lateFactor', id), 1)}×, stale beyond ${num(ctx.param(STALE_ID, 'staleFactor', id), 1)}× that interval. ${updating ? `${updating} other scanned signal${updating === 1 ? '' : 's'} of ${id} still update${updating === 1 ? 's' : ''}, so the link to the asset is up.` : `${f.scanned.length === 1 ? `It is the only scanned signal of ${id}: one signal cannot tell a sensor fault from a lost link.` : 'No other scanned signal of the asset is current.'}`} The last value${f.stale.length === 1 ? ' is' : 's are'} shown as last received, not as current.${evText}`,
      measurements,
      window: since != null ? { from: since, to: ctx.now } : null,
      evidence: [...signalEvidence(f.stale), ...eventsOf(ctx, id, ctx.window(60))],
      next: `Check the data path of ${names(f.stale.map((x) => x.def.signalId))} on ${id}: the transmitter, its tag mapping and the gateway poll for ${f.stale.length === 1 ? 'that item' : 'those items'}${updating ? " — the asset's other signals still update" : ''}.`,
      firstSeen: since != null ? since + 1 : null,
      signals,
    };
  },
};

// ── DQ-SOURCE · source interruption ──────────────────────────────────────────

const DQ_SOURCE: RuleDef = {
  id: SOURCE_ID,
  family: 'data',
  classification: 'rule-based',
  title: 'Source interruption',
  description:
    "Every scanned signal of the asset has stopped updating at once — stale by its timestamps (DQ-STALE's late / stale ages) or flagged stale by the source, or delivering no value: the PLC / gateway link or the source itself, not the individual sensors. One finding for the asset, not one per signal.",
  appliesTo: (scope) => scope.kind === 'equipment' && scannedOf(scope.equipmentId).length >= 2,
  requiredSignals: () => [],
  params: [],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const f = feedOf(ctx, id);
    const signals = f.readings.map((x) => x.def.signalId);
    if (!f.whole) {
      const n = f.notCurrent.length;
      return {
        status: 'clear',
        title: `${equipmentName(id)}: source delivering`,
        explanation: `${f.scanned.length - n} of ${f.scanned.length} scanned signals of ${id} are current (last update ${clock(ctx.now - 1)})${n ? `; ${n} not current — reported per signal (${STALE_ID} / ${FROZEN_ID} / ${GAP_ID})` : ''}: the source is delivering.`,
        evidence: signalEvidence(f.scanned.slice(0, 2)),
        next: null,
        signals,
      };
    }
    const stamps = f.scanned.map((x) => x.r.timestamp).filter((t): t is number => t != null);
    const newest = stamps.length ? Math.max(...stamps) : null;
    const noValue = f.scanned.filter((x) => x.kind === 'no-value').length;
    const flagged = f.scanned.filter((x) => x.r.quality === 'stale').length;
    const ageMin = newest != null ? ctx.now - newest : null;
    const staleAfterMin = (ctx.param(STALE_ID, 'staleFactor', id) * Math.min(...f.scanned.map((x) => x.def.expectedUpdateIntervalS as number))) / 60;
    if (newest == null && f.scanned.every((x) => x.kind === 'no-value'))
      return {
        status: 'insufficient-data',
        title: `${SOURCE_ID}: not evaluated`,
        explanation: `Not evaluated — no value has been received yet from any of the ${f.scanned.length} scanned signals of ${id}: there is no last update to judge an interruption by.`,
        missingSignals: f.scanned.slice(0, 6).map((x) => ({ signalId: x.def.signalId, name: x.def.name, reason: 'no value received yet' })),
        next: null,
        signals,
      };
    const note = f.scanned.find((x) => x.r.note)?.r.note;
    const how = [
      noValue ? `${noValue} deliver${noValue === 1 ? 's' : ''} no value` : '',
      flagged ? `${flagged} ${flagged === 1 ? 'is' : 'are'} flagged stale by the source` : '',
      f.scanned.length - noValue - flagged > 0 ? `${f.scanned.length - noValue - flagged} carr${f.scanned.length - noValue - flagged === 1 ? 'ies' : 'y'} an old timestamp` : '',
    ].filter(Boolean);
    return {
      status: 'fired',
      severity: ageMin == null || ageMin > staleAfterMin ? 'serious' : 'warning',
      title: `${equipmentName(id)}: data source interrupted`,
      explanation: `All ${f.scanned.length} scanned signals of ${id} stopped updating at the same time — the newest value is from ${newest != null ? clock(newest) : 'never'}${ageMin != null ? ` (${duration(ageMin)} ago)` : ''}: ${list(how)}. One interruption of the source (PLC / gateway link), not ${f.scanned.length} sensor faults.${note ? ` Source note: ${note}.` : ''} Every value of ${id} is shown as last received, not as current, and the rules that need them are not evaluated.`,
      measurements: [
        { label: 'Signals not updating', value: f.scanned.length, unit: 'signals' },
        { label: 'Newest value', value: newest != null ? clock(newest) : null, unit: null, ...(newest != null ? { at: newest } : {}) },
        { label: 'Age of the newest value', value: ageMin, unit: 'min' },
      ],
      window: newest != null ? { from: newest + 1, to: ctx.now } : null,
      evidence: [...signalEvidence(f.scanned, newest != null ? { from: newest, to: ctx.now } : undefined), ...eventsOf(ctx, id, ctx.window(Math.max(60, ageMin ?? 60)))],
      next: `Check the PLC / gateway link of ${id} (network path, gateway service, controller in run mode): all of its signals stopped at ${newest != null ? clock(newest + 1) : 'the same time'}.`,
      firstSeen: newest != null ? newest + 1 : null,
      chartRef: CHART.states,
      signals,
    };
  },
};

// ── DQ-FROZEN · value frozen while running ───────────────────────────────────

const DQ_FROZEN: RuleDef = {
  id: FROZEN_ID,
  family: 'data',
  classification: 'rule-based',
  title: 'Value frozen while running',
  description:
    "A signal that follows the operation (counter, rate, process value, drive, condition, level) whose value and timestamp have not changed for longer than the stale age (DQ-STALE) while the asset's state signal is current and reports running — the value should be changing. A transmitter or OPC item holding its last value; the rest of the asset's feed keeps updating.",
  appliesTo: (scope) => scope.kind === 'equipment' && signalsOf(scope.equipmentId).some((d) => d.signalId === stateSignalOf(scope.equipmentId)) && scannedOf(scope.equipmentId).some((d) => CHANGING.has(d.category)),
  requiredSignals: (scope) => [stateSignalOf(idOf(scope))],
  params: [],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const f = feedOf(ctx, id);
    const stateId = stateSignalOf(id);
    const signals = f.readings.map((x) => x.def.signalId);
    const staleAge = ctx.param(STALE_ID, 'staleFactor', id);
    if (!f.frozen.length)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: no frozen value`,
        explanation: f.running
          ? `No signal of ${id} has kept its value and timestamp beyond the stale age (${num(staleAge, 1)}× its update interval) while ${stateId} reports ${f.state?.text ?? 'running'}.`
          : `${stateId} reads ${f.state?.text ?? '—'}: ${id} is not running, so an unchanged value is not suspicious — values that stop updating are reported by ${STALE_ID}.`,
        evidence: [{ kind: 'signal', label: 'State', ref: stateId }],
        next: null,
        signals,
      };
    const oldest = Math.min(...f.frozen.map((x) => x.r.timestamp as number));
    const items = f.frozen.map((x) => `${x.def.signalId} = ${x.r.text}${x.r.unit ? ` ${x.r.unit}` : ''} since ${clock(x.r.timestamp as number)} (${age(x.ageS as number)})`);
    return {
      status: 'fired',
      severity: 'warning',
      title: `${equipmentName(id)}: ${f.frozen.length === 1 ? f.frozen[0].def.name.toLowerCase() : `${f.frozen.length} values`} frozen while running`,
      explanation: `${list(items)} — no new value or timestamp for longer than the stale age (${num(staleAge, 1)}× the expected update interval) while ${stateId} is current and reports ${f.state?.text ?? 'running'}, so ${f.frozen.length === 1 ? 'the value' : 'the values'} should be changing. The asset's other signals keep updating: a frozen ${f.frozen.length === 1 ? 'item' : 'set of items'}, not a lost link. The frozen value is not current and is not used as such.`,
      measurements: f.frozen.slice(0, 6).map((x): Measurement => ({ signalId: x.def.signalId, label: `${x.def.name} (frozen value)`, value: typeof x.r.value === 'number' ? x.r.value : x.r.text, unit: x.r.unit, at: x.r.timestamp as number })),
      window: { from: oldest, to: ctx.now },
      evidence: [...signalEvidence(f.frozen, { from: oldest, to: ctx.now }), { kind: 'signal', label: 'State', ref: stateId }],
      next: `Check ${names(f.frozen.map((x) => x.def.signalId))} on ${id}: a transmitter or OPC item holding its last value — compare with a local reading at the machine while it runs.`,
      firstSeen: oldest + 1,
      signals,
    };
  },
};

// ── History helpers ──────────────────────────────────────────────────────────

/** Process values that legitimately have no value while their machine is not producing (behaviour 'none', cycle time). */
const noValueWhenIdle = (signalId: string) => {
  const p = PROCESS_SIGNAL_BY_ID[signalId];
  return !!p && (p.stopped?.kind === 'none' || signalId.endsWith('.cycle_time'));
};

/** "10:12–10:20 (8 min)" / "since 10:12 (8 min, ongoing)". */
const windowText = (w: Window, now: number) => (w.to >= now ? `since ${clock(w.from)} (${duration(w.to - w.from)}, ongoing)` : `${span(w)} (${duration(w.to - w.from)})`);

/** Signals grouped by identical windows: "a, b and c: since 10:12 (8 min, ongoing)". */
function grouped(items: { id: string; windows: Window[] }[], now: number): string[] {
  const byText = new Map<string, string[]>();
  for (const it of items) {
    const text = it.windows.map((w) => windowText(w, now)).join(', ');
    byText.set(text, [...(byText.get(text) ?? []), it.id]);
  }
  return [...byText.entries()].map(([text, ids]) => `${names(ids)}: ${text}`);
}

const WINDOW_PARAM = (hint: string): RuleDef['params'][number] => ({ key: 'windowMin', label: 'Look back', unit: 'min', default: 60, min: 10, max: 480, step: 5, hint });

// ── DQ-BAD-QUALITY · samples flagged bad ─────────────────────────────────────

const DQ_BAD_QUALITY: RuleDef = {
  id: BAD_ID,
  family: 'data',
  classification: 'rule-based',
  title: 'Bad-quality samples',
  description:
    'Readings or history samples the source flags bad (sensor fault, wiring, out-of-range input card): their value is not trusted and is used by no rule or chart. One finding per asset with the affected signals and when the flags started.',
  appliesTo: (scope) => scope.kind === 'equipment' && signalsOf(scope.equipmentId).length > 0,
  requiredSignals: () => [],
  params: [WINDOW_PARAM('Bad-flagged history samples of this trailing window are counted.')],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const w = recentWindow(ctx, ctx.param(BAD_ID, 'windowMin', id));
    const f = feedOf(ctx, id);
    const nowBad = f.readings.filter((x) => x.kind === 'bad');
    const hist = numericOf(id)
      .map((d) => {
        const bad = ctx.samples(d.signalId, w).filter((x) => x.q === 'bad');
        return { id: d.signalId, n: bad.length, first: bad[0]?.t ?? null, last: bad[bad.length - 1]?.t ?? null };
      })
      .filter((x) => x.n > 0);
    const signals = f.readings.map((x) => x.def.signalId);
    if (!nowBad.length && !hist.length)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: no bad-quality flags`,
        explanation: `No reading of ${id} is flagged bad now, and no history sample in the last ${duration(w.to - w.from)} (${span(w)}) was.`,
        window: w,
        next: null,
        signals,
      };
    const firsts = hist.map((x) => x.first as number);
    const since = firsts.length ? Math.min(...firsts) : null;
    const samples = hist.reduce((a, x) => a + x.n, 0);
    const notes = [...new Set(nowBad.map((x) => x.r.note).filter((n): n is string => !!n))];
    const parts = [
      nowBad.length ? `${nowBad.length} reading${nowBad.length === 1 ? '' : 's'} flagged bad now: ${names(nowBad.map((x) => x.def.signalId), 6)}` : '',
      hist.length ? `${samples} bad sample${samples === 1 ? '' : 's'} in the last ${duration(w.to - w.from)} across ${hist.length} signal${hist.length === 1 ? '' : 's'}${since != null ? `, the first at ${clock(since)}` : ''}` : '',
    ].filter(Boolean);
    const ended = !nowBad.length;
    const lastBad = hist.length ? Math.max(...hist.map((x) => x.last as number)) : null;
    return {
      status: 'fired',
      severity: ended ? 'info' : 'warning',
      title: `${equipmentName(id)}: ${ended ? 'bad-quality samples in the window' : `${nowBad.length} signal${nowBad.length === 1 ? '' : 's'} flagged bad`}`,
      explanation: `${parts.join('; ')}.${notes.length ? ` Source note: ${notes[0]}.` : ''} A bad-flagged value is not trusted: it is not shown as a measurement and no rule uses it (rules that need it are not evaluated).${ended && lastBad != null ? ` The flags stopped after ${clock(lastBad)}.` : ''}`,
      measurements: [
        { label: 'Readings flagged bad now', value: nowBad.length, unit: 'signals' },
        { label: 'Bad samples in the window', value: samples, unit: 'samples', window: w },
        ...hist.slice(0, 4).map((x): Measurement => ({ signalId: x.id, label: `${x.id}: bad samples`, value: x.n, unit: 'samples', window: w })),
      ],
      window: since != null ? { from: since, to: ctx.now } : w,
      evidence: [...signalEvidence(nowBad), ...hist.slice(0, 3).map((x): Evidence => ({ kind: 'signal', label: x.id, ref: x.id, window: w }))],
      next: `Check the transmitter${nowBad.length + hist.length === 1 ? '' : 's'} and the quality flag of ${names([...new Set([...nowBad.map((x) => x.def.signalId), ...hist.map((x) => x.id)])])} at the source (sensor, wiring, input card).`,
      firstSeen: since ?? ctx.now,
      signals,
    };
  },
};

// ── DQ-GAP · timestamp gaps in the recent history ────────────────────────────

const DQ_GAP: RuleDef = {
  id: GAP_ID,
  family: 'data',
  classification: 'rule-based',
  title: 'Gaps in the recent history',
  description:
    "Timestamp discontinuities in the minute history of a scanned signal: minutes with no sample delivered (src/calc gaps). A process value that has no value while its machine is not producing (press pressure, cycle time) is not a gap. One finding per asset, the affected signals grouped by gap.",
  appliesTo: (scope) => scope.kind === 'equipment' && numericOf(scope.equipmentId).length > 0,
  requiredSignals: () => [],
  params: [
    WINDOW_PARAM('The minute history of this trailing window is checked for gaps.'),
    { key: 'minGapMin', label: 'Gaps of at least', unit: 'min', default: 2, min: 1, max: 60, step: 1, hint: 'Shorter holes in the history are not reported.' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const w = recentWindow(ctx, ctx.param(GAP_ID, 'windowMin', id));
    const minGap = ctx.param(GAP_ID, 'minGapMin', id);
    const segs = ctx.states(id, w);
    const st = segs.length ? stateLookup(segs) : null;
    const rateSamples = new Map(ctx.samples(`${id}.rate`, w).map((x) => [x.t, x]));
    /** A minute in which the asset produced nothing (state not running, or a good zero rate). */
    const idle = (t: number) => {
      const s = st?.(t)?.state;
      const r = rateSamples.get(t);
      return (!!s && !RUNNING.has(s)) || (r != null && usableValue(r) === 0);
    };
    const items: { id: string; windows: Window[] }[] = [];
    for (const d of numericOf(id)) {
      // A signal the source keeps no numeric history for (dock occupancy) has no timestamps to check.
      if (!ctx.series(d.signalId, w)) continue;
      const samples = ctx.samples(d.signalId, w).filter((x) => x.t >= w.from && x.t < w.to);
      const legit = noValueWhenIdle(d.signalId);
      const got = samples.filter((x) => x.q !== 'missing' || (legit && idle(x.t)));
      // Interior discontinuities (calc gaps) plus a hole at the start or the end of the window.
      const holes: Window[] = gaps(got, 1);
      if (!got.length) holes.push({ from: w.from, to: w.to });
      else {
        if (got[0].t > w.from) holes.unshift({ from: w.from, to: got[0].t });
        const last = got[got.length - 1].t;
        if (last < w.to - 1) holes.push({ from: last + 1, to: w.to });
      }
      const found = holes.filter((h) => h.to - h.from >= minGap).sort((a, b) => a.from - b.from);
      if (found.length) items.push({ id: d.signalId, windows: found });
    }
    const signals = numericOf(id)
      .map((d) => d.signalId)
      .filter((x) => !!ctx.series(x, w));
    if (!items.length)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: history complete`,
        explanation: `No gap of ${num(minGap)} min or longer in the minute history of the ${signals.length} numeric signal${signals.length === 1 ? '' : 's'} of ${id} over the last ${duration(w.to - w.from)} (${span(w)}).`,
        window: w,
        next: null,
        signals,
      };
    const ongoing = items.some((x) => x.windows.some((g) => g.to >= ctx.now));
    const first = Math.min(...items.flatMap((x) => x.windows.map((g) => g.from)));
    const missing = items.reduce((a, x) => a + x.windows.reduce((b, g) => b + g.to - g.from, 0), 0);
    return {
      status: 'fired',
      severity: ongoing ? 'warning' : 'info',
      title: `${equipmentName(id)}: ${ongoing ? 'no samples' : 'gaps in the history'} — ${items.length} signal${items.length === 1 ? '' : 's'}`,
      explanation: `No samples delivered in the last ${duration(w.to - w.from)} (${span(w)}) for ${grouped(items, ctx.now).join('; ')}. Charts and rules over these minutes have no data there (shown as gaps, never as zero).${ongoing ? ' The gap is ongoing.' : ''}`,
      measurements: [
        { label: 'Signals with gaps', value: items.length, unit: 'signals', window: w },
        { label: 'Missing sample minutes', value: missing, unit: 'min', window: w },
        ...items.slice(0, 4).map((x): Measurement => ({ signalId: x.id, label: `${x.id}: longest gap`, value: Math.max(...x.windows.map((g) => g.to - g.from)), unit: 'min', window: x.windows[0] })),
      ],
      window: { from: first, to: ctx.now },
      evidence: items.slice(0, 6).map((x): Evidence => ({ kind: 'signal', label: x.id, ref: x.id, window: x.windows[0] })),
      next: `Check the gateway / historian buffering of ${id} for ${names(items.map((x) => x.id))}: samples were not delivered ${items[0].windows[0].to >= ctx.now ? `since ${clock(items[0].windows[0].from)}` : `from ${span(items[0].windows[0])}`}.`,
      firstSeen: first,
      signals,
    };
  },
};

// ── DQ-COUNTER-RESET · counter reset or rollover ─────────────────────────────

/** The most an asset can count in `minutes` (1.5 × its ideal rate or a conveyor's capacity); null when unknown. */
function plausibleStep(id: string, minutes: number): number | undefined {
  const cap = idealRateOf(id) ?? CONVEYOR_BY_ID[id]?.capacityPerHour ?? null;
  // Carton / pallet counters count a fraction of the tiles: the tile rate bounds them too.
  return cap ? (cap / 60) * Math.max(1, minutes) * 1.5 : undefined;
}

type CounterStep = { signalId: string; event: 'reset' | 'rollover' | 'back' | 'jump'; at: number; from: number; to: number; rolloverAt: number | null };

const DQ_COUNTER_RESET: RuleDef = {
  id: RESET_ID,
  family: 'data',
  classification: 'rule-based',
  title: 'Counter reset or rollover',
  description:
    "Steps of a cumulative counter classified over its recent history (src/calc counterDelta): a rollover at the configured register size (info), a reset to near zero with no rollover configured (warning: unexplained), or a step neither explains — backwards, or larger than the asset can count (warning). Says which counter and when; rate calculations handle the step.",
  appliesTo: (scope) => scope.kind === 'equipment' && signalsOf(scope.equipmentId).some((d) => !!d.counter),
  requiredSignals: () => [],
  params: [WINDOW_PARAM('Counter steps of this trailing window are classified.')],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const w = recentWindow(ctx, ctx.param(RESET_ID, 'windowMin', id));
    const counters = signalsOf(id).filter((d) => !!d.counter);
    const steps: CounterStep[] = [];
    for (const d of counters) {
      const good = ctx.samples(d.signalId, { from: w.from - 1, to: w.to }).filter((x) => usableValue(x) !== null);
      const rolloverAt = d.counter?.rolloverAt ?? null;
      for (let i = 1; i < good.length; i++) {
        const a = good[i - 1];
        const b = good[i];
        const res = counterDelta(a.v, b.v, { rolloverAt, maxPlausibleDelta: plausibleStep(id, b.t - a.t) });
        const ev = res.event === 'reset' || res.event === 'rollover' ? res.event : res.event === 'invalid' ? ((b.v as number) < (a.v as number) ? 'back' : 'jump') : null;
        if (ev) steps.push({ signalId: d.signalId, event: ev, at: b.t, from: a.v as number, to: b.v as number, rolloverAt });
      }
    }
    const signals = counters.map((d) => d.signalId);
    if (!steps.length)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: counters consistent`,
        explanation: `No reset, rollover or implausible step in ${counters.length === 1 ? signals[0] : `the ${counters.length} counters of ${id}`} over the last ${duration(w.to - w.from)} (${span(w)}).`,
        window: w,
        evidence: signals.slice(0, 2).map((s): Evidence => ({ kind: 'signal', label: s, ref: s, window: w })),
        next: null,
        signals,
      };
    const unitOf = (s: string) => counters.find((d) => d.signalId === s)?.unit ?? '';
    const text = (x: CounterStep) => {
      const step = `${x.signalId} went from ${num(x.from)} to ${num(x.to)} ${unitOf(x.signalId)} at ${clock(x.at)}`.trim();
      if (x.event === 'rollover') return `${step} — a rollover at its configured register size (${num(x.rolloverAt)})`;
      if (x.event === 'reset') return `${step} — a reset to near zero with no rollover register size configured (unexplained)`;
      if (x.event === 'back') return `${step} — a step backwards that is neither a reset to zero nor a rollover`;
      return `${step} — more than ${equipmentName(id)} can count in that time`;
    };
    const warn = steps.some((x) => x.event !== 'rollover');
    const kinds = [...new Set(steps.map((x) => x.event))];
    const label = kinds.length === 1 ? { reset: 'counter reset', rollover: 'counter rollover', back: 'counter stepped back', jump: 'implausible counter step' }[kinds[0]] : 'counter steps';
    const first = Math.min(...steps.map((x) => x.at));
    return {
      status: 'fired',
      severity: warn ? 'warning' : 'info',
      title: `${equipmentName(id)}: ${label}${steps.length > 1 ? ` (${steps.length})` : ''}`,
      explanation: `${steps.map(text).join('; ')}. Rate and output calculations classify the step instead of reading it as negative production or a burst; counts made within the step's minute are not recovered.${warn ? '' : ' A rollover at the configured register size is expected behaviour.'}`,
      measurements: steps.slice(0, 6).map((x): Measurement => ({ signalId: x.signalId, label: `${x.signalId}: value after the ${x.event === 'rollover' ? 'rollover' : x.event === 'reset' ? 'reset' : 'step'}`, value: Math.round(x.to), unit: unitOf(x.signalId) || null, at: x.at })),
      window: { from: first, to: ctx.now },
      evidence: [...new Set(steps.map((x) => x.signalId))].slice(0, 4).map((s): Evidence => ({ kind: 'signal', label: s, ref: s, window: { from: first - 5, to: ctx.now } })),
      next: warn
        ? `Confirm why ${names([...new Set(steps.filter((x) => x.event !== 'rollover').map((x) => x.signalId))])} ${steps.every((x) => x.event === 'reset' || x.event === 'rollover') ? 'restarted' : 'stepped'} at ${clock(first)} (power cycle, shift or batch reset, program download) and record ${steps.length === 1 ? 'its' : 'their'} reset / rollover behaviour in the signal configuration.`
        : null,
      firstSeen: first,
      chartRef: CHART.rate,
      signals,
    };
  },
};

// ── DQ-IMPLAUSIBLE · readings outside the engineering range ──────────────────

const DQ_IMPLAUSIBLE: RuleDef = {
  id: RANGE_ID,
  family: 'data',
  classification: 'rule-based',
  title: 'Implausible readings',
  description:
    'History samples outside the engineering range of the signal (src/calc outOfRange against the catalogue engineering min / max): a broken transmitter, a scaling error or a spike — not a process value. Signals without a configured range are not checked.',
  appliesTo: (scope) => scope.kind === 'equipment' && numericOf(scope.equipmentId).some((d) => d.engineeringMin != null || d.engineeringMax != null),
  requiredSignals: () => [],
  params: [WINDOW_PARAM('Samples of this trailing window are checked against the engineering range.')],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const w = recentWindow(ctx, ctx.param(RANGE_ID, 'windowMin', id));
    const defs = numericOf(id).filter((d) => d.engineeringMin != null || d.engineeringMax != null);
    // A value derived from the minute's output (cycle time from strokes) is not judged in a minute the machine stops
    // or waits: a long last cycle there is a wait, not an implausible reading.
    const segs = ctx.states(id, w);
    const st = segs.length ? stateLookup(segs) : null;
    const judged = (d: SignalDefinition, t: number) => {
      if (PROCESS_SIGNAL_BY_ID[d.signalId]?.role !== 'derived' || !st) return true;
      const s = st(t)?.state;
      return !!s && RUNNING.has(s);
    };
    const hits = defs
      .map((d) => ({ d, out: outOfRange(ctx.samples(d.signalId, w).filter((x) => x.t >= w.from && judged(d, x.t)), d.engineeringMin, d.engineeringMax) }))
      .filter((x) => x.out.length);
    const signals = defs.map((d) => d.signalId);
    const rangeText = (d: SignalDefinition) => `${d.engineeringMin != null ? value(d.engineeringMin) : '−∞'}–${d.engineeringMax != null ? value(d.engineeringMax) : '∞'}${d.unit ? ` ${d.unit}` : ''}`;
    if (!hits.length)
      return {
        status: 'clear',
        title: `${equipmentName(id)}: readings plausible`,
        explanation: `Every sample of the ${defs.length} signal${defs.length === 1 ? '' : 's'} of ${id} with an engineering range was inside it over the last ${duration(w.to - w.from)} (${span(w)}).`,
        window: w,
        next: null,
        signals,
      };
    const items = hits.map(({ d, out }) => {
      const beyond = (x: Sample) => Math.max((x.v as number) - (d.engineeringMax ?? Infinity), (d.engineeringMin ?? -Infinity) - (x.v as number));
      const worst = out.reduce((a, b) => (beyond(b) > beyond(a) ? b : a));
      return { d, out, worst };
    });
    const first = Math.min(...items.flatMap((x) => x.out.map((s) => s.t)));
    const latest = Math.max(...items.flatMap((x) => x.out.map((s) => s.t)));
    return {
      status: 'fired',
      severity: 'warning',
      title: `${equipmentName(id)}: implausible readings — ${items.length === 1 ? items[0].d.name.toLowerCase() : `${items.length} signals`}`,
      explanation: `${items
        .map(({ d, out, worst }) => `${d.signalId}: ${out.length} sample${out.length === 1 ? '' : 's'} outside its engineering range ${rangeText(d)} in the last ${duration(w.to - w.from)} (${list(out.slice(-3).map((s) => `${value(s.v as number)} at ${clock(s.t)}`))}${out.length > 3 ? ', …' : ''}; furthest ${value(worst.v as number)}${d.unit ? ` ${d.unit}` : ''})`)
        .join('; ')}. A reading outside the range the instrument can measure is a data fault (transmitter, scaling, spike), not a process value: it should not be trended, averaged or alarmed on as one.`,
      measurements: items.slice(0, 6).flatMap(({ d, out, worst }): Measurement[] => [
        { signalId: d.signalId, label: `${d.name}: samples outside the range`, value: out.length, unit: 'samples', window: w },
        { signalId: d.signalId, label: `${d.name}: furthest reading`, value: Number((worst.v as number).toFixed(2)), unit: d.unit, at: worst.t },
      ]),
      window: { from: first, to: Math.max(ctx.now, latest + 1) },
      evidence: items.slice(0, 4).flatMap(({ d }): Evidence[] => [{ kind: 'signal', label: d.name, ref: d.signalId, window: w }, ...(d.category === 'process' ? [{ kind: 'chart' as const, label: d.name, ref: CHART.process(d.signalId), window: w }] : [])]),
      next: `Check the transmitter and the scaling of ${names(items.map((x) => x.d.signalId))} on ${id} (range ${rangeText(items[0].d)}); leave those samples out of trends and limits until confirmed.`,
      firstSeen: first,
      signals,
    };
  },
};

/** The data-quality rules, in display order. */
export const DATA_RULES: RuleDef[] = [DQ_SOURCE, DQ_STALE, DQ_FROZEN, DQ_BAD_QUALITY, DQ_GAP, DQ_COUNTER_RESET, DQ_IMPLAUSIBLE];
