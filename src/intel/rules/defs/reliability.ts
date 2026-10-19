/**
 * Reliability rules (brief §7): repeated unplanned stops (RL-REPEAT-STOPS), the same fault reason recurring
 * (RL-RECURRING-FAULT), a stop lasting unusually long (RL-LONG-STOP), a run command without running feedback
 * (RL-COMMAND-FEEDBACK) and the drive condition — motor current above its rating, vibration above its warning level
 * (RL-DRIVE). No failure probability and no time to failure: the rules count, time and compare with limits.
 *
 * - Stops come from the stop records (ctx.stops): own unplanned stops only — planned stops and product changeovers
 *   are not failures, starved / blocked spells belong to the flow rules. The records are trusted only while the
 *   asset's state signal (and its alarm code, where it has one) is current, so a lost feed gives 'insufficient-data'
 *   rather than "no stops".
 * - src/calc repeatedStops returns 'insufficient' when the stops do not repeat: that is "not repeated" (clear), never
 *   missing data.
 * - RL-LONG-STOP is 'rule-based' against its configured limit; when what the stop exceeds is the 90th percentile of
 *   the same reason's stop durations over the baseline (at least 5 earlier stops), that finding is 'statistical' (an
 *   empirical percentile — it says "unusually long for this reason", not how long the stop will last).
 * - RL-DRIVE reads the condition signals only where the asset has them, while it runs. The event engine's condition
 *   assessment (R-COND: load-corrected vibration and its trend) is linked as evidence, not restated.
 */
import { downtimeMinutes, faultRecurrence, histogram, repeatedStops, usableValue, type DeviationEpisode, type Sample, type Window } from '../../../calc';
import { CONDITION_LIMITS, definitionOf, type SignalDefinition } from '../../../model/catalog';
import { LINE, OPS_BY_ID, REASON_BY_CODE } from '../../../model/plant';
import type { EquipmentStateSegment } from '../../../model/telemetry';
import type { OpEvent } from '../../../model/types';
import { OPERATIONAL_STATE_LABEL } from '../../../sim/metrics';
import { formatDateTime } from '../../../sim/time';
import type { RuleContext, RuleStop } from '../context';
import { checkSignals, type SignalCheck } from '../engine';
import { CHART, type Evidence, type Measurement, type MissingSignal, type RuleDef, type RuleEvaluation, type RuleScope, type StaleSignal } from '../types';
import {
  RUNNING,
  clock,
  duration,
  equipmentName,
  idealRateOf,
  inCatalog,
  isConveyor,
  list,
  num,
  pct,
  peersOf,
  span,
  stateLookup,
  stateSignalOf,
  trailingRunStart,
  type EquipmentState,
} from '../util';
import { currentEpisode, limitEpisodes } from './process';

// ── Shared ───────────────────────────────────────────────────────────────────

/** A tracked asset (process machine or conveyor) with a state signal in the catalogue: its stops are recorded. */
const isTracked = (id: string) => (idealRateOf(id) != null || isConveyor(id)) && inCatalog(stateSignalOf(id));
const trackedOf = (scope: RuleScope) => (scope.kind === 'equipment' && isTracked(scope.equipmentId) ? scope.equipmentId : null);
/** Equipment scope id (rules are only evaluated for scopes their appliesTo accepted). */
const idOf = (scope: RuleScope) => (scope.kind === 'equipment' ? scope.equipmentId : '');
/** The alarm / reason code signal of a process machine (conveyors have none in the catalogue). */
const alarmOf = (id: string) => (inCatalog(`${id}.alarm`) ? [`${id}.alarm`] : []);
/** Signals the stop records stand on: the state signal and, where the asset has one, its alarm code. */
const stopSignals = (scope: RuleScope) => [stateSignalOf(idOf(scope)), ...alarmOf(idOf(scope))];
const isConstraint = (id: string) => OPS_BY_ID[id]?.stage === LINE.designConstraint;
const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const reasonLabel = (code: string) => REASON_BY_CODE[code]?.label ?? code;
/** A window length: "7 days", "24 h", "4 h", "90 min". */
const lengthText = (min: number) =>
  min > 1440 && min % 1440 === 0 ? `${min / 1440} days` : min >= 60 && min % 60 === 0 ? `${min / 60} h` : duration(min);
/** A past minute as clock time, with the day when it is half a day or more ago. */
const when = (t: number, now: number) => (now - t >= 720 ? formatDateTime(t) : clock(t));
/** A window as clock times, with the day when it spans a day or more. */
const spanText = (w: Window) => (w.to - w.from >= 1440 ? `${formatDateTime(w.from)}–${formatDateTime(w.to)}` : span(w));

/** Own unplanned stops overlapping the window, oldest first (no planned stops, changeovers or waiting spells). */
const unplanned = (ctx: RuleContext, id: string, w: Window) => ctx.stops(id, w).filter((x) => x.kind === 'down').sort((a, b) => a.start - b.start);
const startsIn = (x: RuleStop, w: Window) => x.start >= w.from && x.start < w.to;
const stopMinutes = (x: RuleStop, now: number) => (x.end ?? now) - x.start;

/**
 * The last evaluation minute at which a trailing window of W minutes held at least N of the (sorted) start times:
 * for N consecutive starts s_i … s_{i+N−1} less than W apart, [T − W, T) holds them for T ∈ (s_{i+N−1}, s_i + W].
 * Null when no N starts were ever within W of each other.
 */
function lastHeld(starts: number[], N: number, W: number): number | null {
  let best: number | null = null;
  for (let i = 0; i + N - 1 < starts.length; i++) if (starts[i + N - 1] - starts[i] < W) best = Math.max(best ?? -Infinity, starts[i] + W);
  return best;
}

/** The OpEvents of the given stop records (R-STOP / R-CONV events carry the downtime id). */
function stopEvents(ctx: RuleContext, id: string, stops: RuleStop[], w: Window): OpEvent[] {
  const ids = new Set(stops.map((x) => x.downtimeId));
  return ctx.events(id, w).filter((e) => e.refs.downtimeId != null && ids.has(e.refs.downtimeId));
}
const eventRefs = (events: OpEvent[], now: number): Evidence[] => events.slice(0, 5).map((e) => ({ kind: 'event', label: e.title, ref: e.id, window: { from: e.start, to: e.end ?? now } }));

/** "Hydraulic pressure fault ×2 (22 min)" per reason, most frequent first. */
function reasonsText(stops: RuleStop[], w: Window): string[] {
  return faultRecurrence(stops, w, { by: 'reason' }).map((r) => `${r.reasonLabel ?? r.reasonCode} ×${r.count} (${duration(r.totalMin)})`);
}

/** The next check behind a recurring reason, by its category. */
function reasonCheck(id: string, code: string): string {
  const r = REASON_BY_CODE[code];
  const label = (r?.label ?? code).toLowerCase();
  if (code.startsWith('SCN_')) return `Review the ${label} stops of ${id} in the event log (a simulated scenario input) and the condition of the asset before the next restart.`;
  switch (r?.category) {
    case 'Electrical & control':
      return `Check the device behind '${label}' on ${id} — the sensor / drive, its wiring and connectors — and the PLC diagnostic buffer around each stop.`;
    case 'Process':
      return `Check the process settings behind '${label}' on ${id} (recipe values and the incoming material) before the machine itself — a process stop that keeps recurring is worth comparing with the settings and the material first.`;
    default:
      return `Inspect the cause of '${label}' on ${id} (component, wear parts, the last maintenance on it) instead of resetting again, and check the maintenance history for this reason.`;
  }
}

/** Short insufficient-data result for a rule's own history problem (invalid window / threshold). */
const notEvaluatedCalc = (ruleId: string, reason: string, signal: string): RuleEvaluation => ({
  status: 'insufficient-data',
  title: `${ruleId}: not evaluated`,
  explanation: `Not evaluated — ${reason}.`,
  missingSignals: [{ signalId: signal, name: definitionOf(signal)?.name ?? signal, reason }],
  next: null,
});

// ── RL-REPEAT-STOPS · repeated unplanned stops ───────────────────────────────

const REPEAT_ID = 'RL-REPEAT-STOPS';

const RL_REPEAT: RuleDef = {
  id: REPEAT_ID,
  family: 'reliability',
  classification: 'rule-based',
  title: 'Repeated stops',
  description:
    'At least the threshold number of own unplanned stops starting in the trailing window (stop records; planned stops, product changeovers and starved / blocked spells are not counted). Fewer stops is "not repeated" — clear, not missing data.',
  appliesTo: (scope) => trackedOf(scope) != null,
  requiredSignals: stopSignals,
  params: [
    { key: 'minCount', label: 'At least', unit: 'unplanned stops', default: 3, min: 2, max: 20, step: 1, hint: 'Number of own unplanned stops in the window that counts as repeated.' },
    { key: 'windowMin', label: 'Within', unit: 'min', default: 240, min: 30, max: 1440, step: 30, hint: 'Trailing window the stops are counted in (by their start).' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const N = Math.round(ctx.param(REPEAT_ID, 'minCount', id));
    const W = Math.round(ctx.param(REPEAT_ID, 'windowMin', id));
    const win = ctx.window(W);
    const all = unplanned(ctx, id, ctx.window(2 * W));
    const r = repeatedStops(all, win, N);
    if (r.status === 'invalid') return notEvaluatedCalc(REPEAT_ID, r.reason, stateSignalOf(id));
    const inWin = all.filter((x) => startsIn(x, win));
    const overlapping = all.filter((x) => x.start < win.to && (x.end ?? Infinity) > win.from);
    const downMin = downtimeMinutes(overlapping, win);
    const reasons = reasonsText(inWin, win);
    const open = inWin.find((x) => x.end == null);
    const measurements: Measurement[] = [
      { label: 'Unplanned stops in the window', value: inWin.length, unit: 'stops', window: win },
      { label: 'Threshold', value: N, unit: 'stops' },
      { label: 'Unplanned downtime in the window', value: Math.round(downMin), unit: 'min', window: win },
    ];
    const evidence: Evidence[] = [
      { kind: 'signal', label: definitionOf(stateSignalOf(id))?.name ?? 'State', ref: stateSignalOf(id), window: win },
      { kind: 'chart', label: 'State timeline', ref: CHART.states, window: win },
      ...eventRefs(stopEvents(ctx, id, inWin, win), ctx.now),
    ];
    if (r.status === 'ok') {
      const count = r.value.count;
      const top = faultRecurrence(inWin, win, { by: 'reason' })[0];
      const peers = isConveyor(id) ? [] : peersOf(id);
      return {
        status: 'fired',
        severity: count >= 2 * N ? 'serious' : 'warning',
        title: `${equipmentName(id)}: ${count} unplanned stops in ${lengthText(W)}`,
        explanation:
          `${id} stopped ${count} times unplanned in the last ${lengthText(W)} (${spanText(win)}): ${list(reasons)}; ${duration(downMin)} of unplanned downtime in the window` +
          `${open ? `, the last stop still open (since ${clock(open.start)})` : ''}. Threshold: ${plural(N, 'stop')} in ${lengthText(W)}. Planned stops, product changeovers and waiting on a neighbour are not counted.`,
        measurements,
        window: { from: r.value.first, to: ctx.now },
        evidence,
        next: `Review the ${count} stops of ${id} together in the event log (reason, duration and the minutes before each stop) and check the cause behind the most frequent reason (${top?.reasonLabel ?? top?.reasonCode}, ×${top?.count}) before the next restart${
          peers.length ? `; compare with ${list(peers)} over the same window` : ''
        }.`,
        firstSeen: r.value.first,
        chartRef: CHART.states,
      };
    }
    // Not repeated now; did it repeat earlier in the look-back (and when did that clear)?
    const held = lastHeld(all.map((x) => x.start).sort((a, b) => a - b), N, W);
    const resolvedAt = held != null && held < ctx.now ? held + 1 : null;
    const resolvedText = resolvedAt != null ? ` Stops were repeated earlier: ${num(N)} or more within ${lengthText(W)} until ${when(resolvedAt, ctx.now)}.` : '';
    return {
      status: 'clear',
      title: `${equipmentName(id)}: stops not repeated`,
      explanation: `${inWin.length ? `${plural(inWin.length, 'unplanned stop')} (${list(reasons)})` : 'No unplanned stop'} of ${id} in the last ${lengthText(W)} (${spanText(win)}) — below the repeat threshold of ${num(N)}: not repeated.${resolvedText}`,
      measurements,
      window: win,
      evidence,
      next: null,
      resolvedAt,
      chartRef: CHART.states,
    };
  },
};

// ── RL-RECURRING-FAULT · the same reason recurring ───────────────────────────

const RECUR_ID = 'RL-RECURRING-FAULT';

const RL_RECURRING: RuleDef = {
  id: RECUR_ID,
  family: 'reliability',
  classification: 'rule-based',
  title: 'Recurring fault',
  description:
    'The same stop reason (alarm / reason code) at least the threshold number of times in the trailing window on one asset (own unplanned stops, by their start). One finding per recurring reason.',
  appliesTo: (scope) => trackedOf(scope) != null,
  requiredSignals: stopSignals,
  params: [
    { key: 'minCount', label: 'Same reason at least', unit: 'times', default: 3, min: 2, max: 20, step: 1, hint: 'Number of stops with one reason code in the window that counts as recurring.' },
    { key: 'windowMin', label: 'Within', unit: 'min', default: 1440, min: 60, max: 10080, step: 60, hint: 'Trailing window the stops are counted in (by their start).' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const N = Math.round(ctx.param(RECUR_ID, 'minCount', id));
    const W = Math.round(ctx.param(RECUR_ID, 'windowMin', id));
    const win = ctx.window(W);
    const all = unplanned(ctx, id, ctx.window(2 * W));
    const inWin = all.filter((x) => startsIn(x, win));
    const rows = faultRecurrence(inWin, win, { by: 'reason' });
    const out: RuleEvaluation[] = [];
    const stateEvidence: Evidence = { kind: 'signal', label: definitionOf(stateSignalOf(id))?.name ?? 'State', ref: stateSignalOf(id), window: win };
    for (const row of rows.filter((x) => x.count >= N)) {
      const code = row.reasonCode!;
      const stops = inWin.filter((x) => x.reasonCode === code);
      const label = row.reasonLabel ?? reasonLabel(code);
      const times = stops.map((x) => when(x.start, ctx.now));
      const others = rows.filter((x) => x !== row).map((x) => `${x.reasonLabel ?? x.reasonCode} ×${x.count}`);
      out.push({
        status: 'fired',
        severity: row.count >= 2 * N ? 'serious' : 'warning',
        subject: code,
        title: `${equipmentName(id)}: ${label} ${row.count} times in ${lengthText(W)}`,
        explanation:
          `${label} (${code}) stopped ${id} ${row.count} times in the last ${lengthText(W)} (${spanText(win)}), ${duration(row.totalMin)} in total — at ${list(times.length > 8 ? [...times.slice(0, 8), `${times.length - 8} more`] : times)}. ` +
          `Threshold: the same reason ${num(N)} times in ${lengthText(W)}.${others.length ? ` Other unplanned stops in the window: ${list(others)}.` : ''}`,
        measurements: [
          { label: 'Stops with this reason', value: row.count, unit: 'stops', window: win },
          { label: 'Minutes with this reason', value: Math.round(row.totalMin), unit: 'min', window: win },
          { label: 'Threshold', value: N, unit: 'stops' },
        ],
        window: { from: stops[0].start, to: ctx.now },
        evidence: [stateEvidence, ...alarmOf(id).map((a): Evidence => ({ kind: 'signal', label: 'Alarm / reason code', ref: a, window: win })), ...eventRefs(stopEvents(ctx, id, stops, win), ctx.now)],
        next: reasonCheck(id, code),
        firstSeen: stops[0].start,
        chartRef: CHART.states,
      });
    }
    // Reasons that recurred earlier in the look-back but no longer do: recently resolved.
    const firing = new Set(out.map((x) => x.subject));
    const codes = [...new Set(all.map((x) => x.reasonCode))].filter((c) => !firing.has(c));
    for (const code of codes) {
      const held = lastHeld(all.filter((x) => x.reasonCode === code).map((x) => x.start).sort((a, b) => a - b), N, W);
      if (held == null || held >= ctx.now) continue;
      const count = inWin.filter((x) => x.reasonCode === code).length;
      out.push({
        status: 'clear',
        subject: code,
        title: `${equipmentName(id)}: ${reasonLabel(code)} no longer recurring`,
        explanation: `${reasonLabel(code)} (${code}) stopped ${id} ${num(N)} or more times within ${lengthText(W)} until ${when(held + 1, ctx.now)}; ${plural(count, 'stop')} with this reason in the last ${lengthText(W)} now — below the threshold of ${num(N)}.`,
        measurements: [{ label: 'Stops with this reason', value: count, unit: 'stops', window: win }],
        window: win,
        evidence: [stateEvidence],
        next: null,
        resolvedAt: held + 1,
        chartRef: CHART.states,
      });
    }
    if (!out.length) {
      const top = rows[0];
      out.push({
        status: 'clear',
        title: `${equipmentName(id)}: no recurring fault`,
        explanation: `No stop reason of ${id} recurred ${num(N)} times in the last ${lengthText(W)} (${spanText(win)})${
          top ? `: most frequent ${top.reasonLabel ?? top.reasonCode} ×${top.count} of ${plural(inWin.length, 'unplanned stop')}` : ': no unplanned stop'
        }.`,
        measurements: [
          { label: 'Unplanned stops in the window', value: inWin.length, unit: 'stops', window: win },
          { label: 'Most stops with one reason', value: top?.count ?? 0, unit: 'stops', window: win },
          { label: 'Threshold', value: N, unit: 'stops' },
        ],
        window: win,
        evidence: [stateEvidence],
        next: null,
        chartRef: CHART.states,
      });
    }
    return out;
  },
};

// ── RL-LONG-STOP · stop lasting unusually long ───────────────────────────────

const LONG_ID = 'RL-LONG-STOP';

type Baseline = { n: number; p50: number; p90: number; min: number; max: number } | { n: number; reason: string };

/** Durations of the asset's earlier closed stops with one reason, starting in [from, before): the percentile baseline. */
function baselineOf(stops: RuleStop[], code: string, from: number, before: number, minSamples: number): Baseline {
  const durations = stops.filter((x) => x.reasonCode === code && x.end != null && x.start >= from && x.start < before).map((x) => (x.end as number) - x.start);
  const max = durations.length ? Math.max(...durations) : 0;
  const h = histogram(durations, { binWidth: Math.max(1, Math.ceil(max / 200)), minSamples });
  if (h.status !== 'ok') return { n: durations.length, reason: h.reason };
  return { n: h.value.n, p50: h.value.p50, p90: h.value.p90, min: Math.min(...durations), max };
}

const hasPercentile = (b: Baseline): b is Extract<Baseline, { p90: number }> => 'p90' in b;

/** Whether a stop of `minutes` is long: beyond the limit (rule-based) or beyond its reason's 90th percentile (statistical). */
function longBy(minutes: number, limit: number, floor: number, b: Baseline): 'limit' | 'percentile' | null {
  if (minutes > limit) return 'limit';
  if (hasPercentile(b) && minutes > b.p90 && minutes >= floor) return 'percentile';
  return null;
}

const RL_LONG: RuleDef = {
  id: LONG_ID,
  family: 'reliability',
  classification: 'rule-based',
  title: 'Stop lasting unusually long',
  description:
    "The current unplanned stop has lasted longer than the configured limit (rule-based), or longer than the 90th percentile of the asset's earlier stops with the same reason over the baseline window when at least the minimum number exist (that finding is statistical: an empirical percentile, not a forecast of the remaining duration).",
  appliesTo: (scope) => trackedOf(scope) != null,
  requiredSignals: stopSignals,
  params: [
    { key: 'limitMin', label: 'Longer than', unit: 'min', default: 60, min: 5, max: 720, step: 5, hint: 'Configured limit for one unplanned stop.' },
    { key: 'baselineMin', label: 'Percentile baseline over', unit: 'min', default: 10080, min: 1440, max: 10080, step: 1440, hint: 'Window of earlier stops with the same reason the 90th percentile is taken from (stop records are kept 8 days).' },
    { key: 'minSamples', label: 'Percentile from at least', unit: 'earlier stops', default: 5, min: 3, max: 50, step: 1, hint: 'Fewer earlier stops with the reason: only the configured limit applies.' },
    { key: 'minMinutes', label: 'Percentile check from', unit: 'min', default: 15, min: 1, max: 240, step: 1, hint: 'A stop shorter than this is never reported by the percentile check (short stops vary widely).' },
    { key: 'windowMin', label: 'Show a resolved long stop for', unit: 'min', default: 240, min: 30, max: 1440, step: 30, hint: 'A long stop that ended within this window is shown as resolved.' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const limit = ctx.param(LONG_ID, 'limitMin', id);
    const B = Math.round(ctx.param(LONG_ID, 'baselineMin', id));
    const minSamples = Math.round(ctx.param(LONG_ID, 'minSamples', id));
    const floor = ctx.param(LONG_ID, 'minMinutes', id);
    const R = Math.round(ctx.param(LONG_ID, 'windowMin', id));
    const base = ctx.window(B);
    const stops = unplanned(ctx, id, base);
    const open = [...stops].reverse().find((x) => x.end == null) ?? null;
    const evidence: Evidence[] = [
      { kind: 'signal', label: definitionOf(stateSignalOf(id))?.name ?? 'State', ref: stateSignalOf(id), window: ctx.window(R) },
      { kind: 'chart', label: 'State timeline', ref: CHART.states, window: ctx.window(R) },
    ];
    const baselineText = (b: Baseline, label: string) =>
      hasPercentile(b)
        ? `its ${plural(b.n, `earlier ${label} stop`)} over the last ${lengthText(B)} lasted ${num(b.min)}–${num(b.max)} min (median ${num(b.p50)} min, 90th percentile ${num(b.p90)} min)`
        : `no percentile baseline (${plural(b.n, `earlier ${label} stop`)} over the last ${lengthText(B)}; the percentile check needs ${num(minSamples)})`;
    if (!open) {
      // A long stop that ended recently: clear with resolvedAt.
      const recent = stops.filter((x) => x.end != null && (x.end as number) >= ctx.now - R).reverse();
      for (const x of recent) {
        const b = baselineOf(stops, x.reasonCode, base.from, x.start, minSamples);
        const how = longBy(stopMinutes(x, ctx.now), limit, floor, b);
        if (!how) continue;
        return {
          status: 'clear',
          title: `${equipmentName(id)}: long stop ended`,
          explanation: `${id} is not in an unplanned stop. The last long stop (${x.reasonLabel}, ${duration(stopMinutes(x, ctx.now))} from ${clock(x.start)}) ended at ${clock(x.end as number)} — ${
            how === 'limit' ? `longer than the configured limit of ${lengthText(limit)}` : `longer than the 90th percentile of ${num((b as Extract<Baseline, { p90: number }>).p90)} min of its earlier ${x.reasonLabel} stops`
          }.`,
          measurements: [{ label: 'Duration of the last long stop', value: stopMinutes(x, ctx.now), unit: 'min', window: { from: x.start, to: x.end as number } }],
          window: { from: x.start, to: x.end as number },
          evidence: [...evidence, ...eventRefs(stopEvents(ctx, id, [x], base), ctx.now)],
          next: null,
          resolvedAt: x.end,
          chartRef: CHART.states,
        };
      }
      return {
        status: 'clear',
        title: `${equipmentName(id)}: no stop in progress`,
        explanation: `${id} is not in an unplanned stop (stop records${alarmOf(id).length ? ` and ${alarmOf(id)[0]}` : ''}).`,
        evidence,
        next: null,
        chartRef: CHART.states,
      };
    }
    const minutes = stopMinutes(open, ctx.now);
    const label = open.reasonLabel ?? reasonLabel(open.reasonCode);
    const b = baselineOf(stops, open.reasonCode, base.from, open.start, minSamples);
    const how = longBy(minutes, limit, floor, b);
    const w = { from: open.start, to: ctx.now };
    const measurements: Measurement[] = [
      { label: 'Stop duration so far', value: minutes, unit: 'min', window: w },
      { label: 'Configured limit', value: limit, unit: 'min' },
      { label: `Earlier ${label} stops in the baseline`, value: b.n, unit: 'stops', window: { from: base.from, to: open.start } },
      { label: '90th percentile of their durations', value: hasPercentile(b) ? Math.round(b.p90) : null, unit: 'min' },
      { label: 'Median of their durations', value: hasPercentile(b) ? Math.round(b.p50) : null, unit: 'min' },
    ];
    const events = stopEvents(ctx, id, [open], base);
    const head = `${id} has been stopped for ${duration(minutes)} (since ${clock(open.start)}; ${label}, ${open.reasonCode})`;
    if (how) {
      const pctl = how === 'percentile' && hasPercentile(b);
      return {
        status: 'fired',
        classification: pctl ? 'statistical' : 'rule-based',
        severity: isConstraint(id) || minutes >= 2 * limit ? 'serious' : 'warning',
        title: `${equipmentName(id)}: stop ${duration(minutes)} — ${pctl ? 'longer than usual for this reason' : `beyond the ${lengthText(limit)} limit`}`,
        explanation: pctl
          ? `${head} — longer than 90 % of its ${plural(b.n, `earlier ${label} stop`)} over the last ${lengthText(B)} (90th percentile ${num(b.p90)} min, median ${num(b.p50)} min, longest ${num(b.max)} min). The configured limit is ${lengthText(limit)}. An empirical percentile of ${num(b.n)} stops: the stop is unusually long for this reason — not a forecast of how long it will last.`
          : `${head} — longer than the configured limit of ${lengthText(limit)}; ${baselineText(b, label)}.`,
        measurements,
        window: w,
        evidence: [...evidence, ...eventRefs(events, ctx.now)],
        confidence: pctl ? (b.n >= 10 ? 'medium' : 'low') : 'high',
        confidenceNote: pctl
          ? `Empirical 90th percentile of ${num(b.n)} earlier stops with the same reason on ${id} (statistical); few stops make the percentile uncertain.`
          : undefined,
        next: `Check the repair status of ${id} with maintenance — spare parts, a second fault found during the repair, a restart held by an interlock — and update the expected restart time on the stop event${events[0] ? ` (${events[0].id})` : ''}${
          isConstraint(id) ? '; the kiln is the line constraint, so every minute of the stop is lost line output' : ''
        }.`,
        firstSeen: open.start,
        chartRef: CHART.states,
      };
    }
    const why = hasPercentile(b) && minutes > b.p90 ? ` Above the 90th percentile (${num(b.p90)} min), but the percentile check starts at ${num(floor)} min.` : '';
    return {
      status: 'clear',
      title: `${equipmentName(id)}: stop within its usual duration`,
      explanation: `${head}: within the configured limit of ${lengthText(limit)}${hasPercentile(b) && minutes <= b.p90 ? ` and the 90th percentile of ${num(b.p90)} min of its ${plural(b.n, `earlier ${label} stop`)}` : `; ${baselineText(b, label)}`}.${why}`,
      measurements,
      window: w,
      evidence: [...evidence, ...eventRefs(events, ctx.now)],
      next: null,
      chartRef: CHART.states,
    };
  },
};

// ── RL-COMMAND-FEEDBACK · run command without running feedback ───────────────

const COMMAND_ID = 'RL-COMMAND-FEEDBACK';
const commandOf = (id: string) => `${id}.run_command`;
/** States without running feedback: the machine is not running (an own stop of any kind). */
const NO_FEEDBACK: ReadonlySet<EquipmentState> = new Set<EquipmentState>(['stopped', 'fault', 'planned', 'changeover']);

const RL_COMMAND: RuleDef = {
  id: COMMAND_ID,
  family: 'reliability',
  classification: 'rule-based',
  title: 'Command without running feedback',
  description:
    'The run command is on while the state signal (the running feedback) reports the machine not running for at least the minimum duration — a commanded start without running feedback. In a normal stop the command drops, so the rule stays clear.',
  appliesTo: (scope) => scope.kind === 'equipment' && inCatalog(commandOf(scope.equipmentId)) && inCatalog(stateSignalOf(scope.equipmentId)),
  requiredSignals: (scope) => [commandOf(idOf(scope)), stateSignalOf(idOf(scope))],
  params: [
    { key: 'minMinutes', label: 'For at least', unit: 'min', default: 3, min: 1, max: 60, step: 1, hint: 'Minimum time the command is on without running feedback.' },
    { key: 'windowMin', label: 'Look back', unit: 'min', default: 60, min: 15, max: 480, step: 5, hint: 'How far back the command and state history is read.' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const N = ctx.param(COMMAND_ID, 'minMinutes', id);
    const W = Math.round(ctx.param(COMMAND_ID, 'windowMin', id));
    const win = ctx.window(W);
    const cmd = commandOf(id);
    const stateSig = stateSignalOf(id);
    const on = new Map(ctx.samples(cmd, win).map((x) => [x.t, usableValue(x)]));
    const st = stateLookup(ctx.states(id, win));
    const noFeedback = (t: number) => {
      const seg = st(t);
      return on.get(t) === 1 && !!seg && NO_FEEDBACK.has(seg.state);
    };
    const from = trailingRunStart(noFeedback, win.from, ctx.now);
    const minutes = from == null ? 0 : ctx.now - from;
    // Earlier episodes in the window that lasted the minimum (recently resolved).
    let resolvedAt: number | null = null;
    let resolvedFrom: number | null = null;
    for (let t = (from ?? ctx.now) - 1; t >= win.from; t--) {
      if (!noFeedback(t)) continue;
      let a = t;
      while (a - 1 >= win.from && noFeedback(a - 1)) a--;
      if (t + 1 - a >= N) {
        resolvedAt = t + 1;
        resolvedFrom = a;
        break;
      }
      t = a;
    }
    const cmdNow = ctx.read(cmd);
    const segNow = st(ctx.now - 1);
    const stateText = segNow ? `${OPERATIONAL_STATE_LABEL[segNow.state]}${segNow.label && segNow.reason ? ` (${segNow.label})` : ''}` : 'no state';
    const measurements: Measurement[] = [
      { signalId: cmd, label: 'Run command', value: cmdNow.text, unit: null, at: cmdNow.timestamp ?? undefined },
      { signalId: stateSig, label: 'Running feedback (state)', value: segNow ? OPERATIONAL_STATE_LABEL[segNow.state] : null, unit: null, at: ctx.now - 1 },
      { label: 'Command on without running feedback', value: minutes, unit: 'min', window: { from: from ?? ctx.now, to: ctx.now } },
    ];
    const evidence: Evidence[] = [
      { kind: 'signal', label: definitionOf(cmd)?.name ?? 'Run command', ref: cmd, window: win },
      { kind: 'signal', label: definitionOf(stateSig)?.name ?? 'State', ref: stateSig, window: win },
      { kind: 'chart', label: 'State timeline', ref: CHART.states, window: win },
    ];
    const resolvedText = resolvedAt != null && resolvedFrom != null ? ` The command was on without running feedback from ${clock(resolvedFrom)} to ${clock(resolvedAt)} (${duration(resolvedAt - resolvedFrom)}).` : '';
    if (from != null && minutes >= N) {
      const w = { from, to: ctx.now };
      return {
        status: 'fired',
        severity: isConstraint(id) ? 'serious' : 'warning',
        title: `${equipmentName(id)}: run command on, no running feedback`,
        explanation: `${cmd} has been On for ${duration(minutes)} (since ${clock(from)}) while ${stateSig} reports ${stateText} — a commanded start without running feedback. In a normal stop the run command drops; here the command stays on and the machine does not run. Reported after ${num(N)} min.`,
        measurements,
        window: w,
        evidence: [...evidence, ...eventRefs(stopEvents(ctx, id, unplanned(ctx, id, w), w), ctx.now)],
        next: `Check why ${id} does not run on command: the drive / motor-starter ready and fault signals, the running-feedback contact (auxiliary contact or drive status word) at its PLC input, and the interlock chain (guards, emergency stops, upstream permissives).`,
        firstSeen: from,
        chartRef: CHART.states,
      };
    }
    const cmdOn = cmdNow.value === true;
    const running = !!segNow && !NO_FEEDBACK.has(segNow.state);
    return {
      status: 'clear',
      title: `${equipmentName(id)}: command and running feedback agree`,
      explanation: `${
        cmdOn && running
          ? `${cmd} On and ${stateSig} reports ${stateText} — running feedback present.`
          : !cmdOn && !running
            ? `${cmd} Off while ${id} reports ${stateText}: a normal stop — the run command dropped.`
            : cmdOn
              ? `${cmd} On while ${stateSig} reports ${stateText} for the last ${duration(minutes)} — reported after ${num(N)} min.`
              : `${cmd} Off while ${stateSig} reports ${stateText}.`
      }${resolvedText}`,
      measurements,
      window: win,
      evidence,
      next: null,
      resolvedAt,
      chartRef: CHART.states,
    };
  },
};

// ── RL-DRIVE · motor current above rated, vibration above warning ────────────

const DRIVE_ID = 'RL-DRIVE';
const vibrationOf = (id: string) => `${id}.vibration`;
const currentOf = (id: string) => `${id}.motor_current`;
const ratedOf = (d: SignalDefinition | null) => {
  const v = d?.metadata?.ratedCurrentA;
  return typeof v === 'number' && v > 0 ? v : null;
};
const hasVibration = (id: string) => definitionOf(vibrationOf(id))?.warningHigh != null;
const hasCurrent = (id: string) => ratedOf(definitionOf(currentOf(id))) != null;

type Excursion = {
  signalId: string;
  def: SignalDefinition;
  /** The level the signal is compared with (vibration warning / rated current). */
  limit: number;
  /** Vibration alarm level (null for the current). */
  alarm: number | null;
  now: number | null;
  current: DeviationEpisode | null;
  alarmEpisode: DeviationEpisode | null;
  resolved: DeviationEpisode | null;
};

/** One condition signal against its level over the running minutes of the window. */
function excursionOf(ctx: RuleContext, d: SignalDefinition, limit: number, alarm: number | null, running: (t: number) => boolean, win: Window, N: number): Excursion {
  const samples = ctx.samples(d.signalId, win).map((x): Sample => (running(x.t) ? x : { t: x.t, v: null, q: 'missing' }));
  const episodes = limitEpisodes(samples, undefined, limit);
  const current = currentEpisode(episodes, ctx.now);
  const alarms = alarm != null && current ? limitEpisodes(samples, undefined, alarm).filter((e) => e.from >= current.from && e.to <= current.to) : [];
  const last = samples[samples.length - 1];
  const past = episodes.filter((e) => e !== current && e.minutes >= N);
  return {
    signalId: d.signalId,
    def: d,
    limit,
    alarm,
    now: last && last.t === ctx.now - 1 ? usableValue(last) : null,
    current,
    alarmEpisode: alarms.sort((a, b) => b.minutes - a.minutes)[0] ?? null,
    resolved: past[past.length - 1] ?? null,
  };
}

const RL_DRIVE: RuleDef = {
  id: DRIVE_ID,
  family: 'reliability',
  classification: 'rule-based',
  title: 'Drive condition',
  description:
    "Motor current above the drive's rated current (catalogue metadata) or vibration above its warning level for at least the minimum duration while the asset runs — only where those condition signals exist. A threshold check on the signals: no failure probability, no time to failure; the condition assessment (R-COND) is linked, not restated.",
  appliesTo: (scope) => scope.kind === 'equipment' && (hasVibration(scope.equipmentId) || hasCurrent(scope.equipmentId)),
  requiredSignals: (scope) => (inCatalog(stateSignalOf(idOf(scope))) ? [stateSignalOf(idOf(scope))] : []),
  params: [
    { key: 'minMinutes', label: 'For at least', unit: 'min', default: 10, min: 1, max: 120, step: 1, hint: 'Minimum time above the level while running.' },
    { key: 'currentMargin', label: 'Current above rated by more than', unit: '% of rated', scale: 100, default: 0, min: 0, max: 0.5, step: 0.01, hint: 'Allowed excess over the rated current before it is reported.' },
    { key: 'windowMin', label: 'Look back', unit: 'min', default: 120, min: 30, max: 480, step: 10, hint: 'How far back the condition history is read.' },
  ],
  evaluate: (ctx, scope) => {
    const id = idOf(scope);
    const N = ctx.param(DRIVE_ID, 'minMinutes', id);
    const margin = ctx.param(DRIVE_ID, 'currentMargin', id);
    const W = Math.round(ctx.param(DRIVE_ID, 'windowMin', id));
    const win = ctx.window(W);
    const stated = inCatalog(stateSignalOf(id));
    const st: (t: number) => EquipmentStateSegment | null = stated ? stateLookup(ctx.states(id, win)) : () => null;
    const running = (t: number) => {
      if (!stated) return true;
      const x = st(t);
      return !!x && RUNNING.has(x.state);
    };
    const candidates = [hasVibration(id) ? vibrationOf(id) : null, hasCurrent(id) ? currentOf(id) : null].filter((x): x is string => !!x);
    const check: SignalCheck = checkSignals(ctx, candidates);
    const unusable = new Set([...check.missing.map((m) => m.signalId), ...check.stale.map((m) => m.signalId)]);
    const usable = candidates.filter((x) => !unusable.has(x));
    const problemText = [...check.missing.map((m) => `${m.signalId} (${m.name}): ${m.reason}`), ...check.stale.map((m) => `${m.signalId} (${m.name}): ${check.reasons[m.signalId]}`)];
    if (!usable.length)
      return {
        status: 'insufficient-data',
        title: `${DRIVE_ID}: not evaluated`,
        explanation: `Not evaluated — requires ${problemText.join('; ')}.`,
        missingSignals: check.missing,
        staleSignals: check.stale,
        evidence: candidates.map((x): Evidence => ({ kind: 'signal', label: definitionOf(x)?.name ?? x, ref: x })),
        confidence: 'low',
        confidenceNote: 'The condition signals are missing, not current or flagged bad — no verdict is given.',
        next: `Check the condition sensors of ${id} and their data feed (${list(candidates)}).`,
      };
    const ex: Excursion[] = usable.map((sig) => {
      const d = definitionOf(sig)!;
      return sig === vibrationOf(id) ? excursionOf(ctx, d, d.warningHigh!, d.alarmHigh ?? null, running, win, N) : excursionOf(ctx, d, ratedOf(d)! * (1 + margin), null, running, win, N);
    });
    const vib = ex.find((x) => x.signalId === vibrationOf(id)) ?? null;
    const cur = ex.find((x) => x.signalId === currentOf(id)) ?? null;
    const rated = cur ? ratedOf(cur.def)! : null;
    const fires = (x: Excursion | null) => !!x && !!x.current && x.current.minutes >= N;
    const vibFires = fires(vib);
    const curFires = fires(cur);
    const vd = (v: number | null) => (v == null ? '—' : `${num(v, 1)} mm/s`);
    const ad = (v: number | null) => (v == null ? '—' : `${num(v)} A`);
    const measurements: Measurement[] = [
      ...(vib
        ? [
            { signalId: vib.signalId, label: 'Vibration now', value: vib.now != null ? Number(vib.now.toFixed(2)) : null, unit: 'mm/s', at: ctx.now - 1 },
            { label: 'Vibration warning level', value: vib.limit, unit: 'mm/s' },
            { label: 'Vibration alarm level', value: vib.alarm, unit: 'mm/s' },
            { label: 'Vibration above warning for', value: vib.current?.minutes ?? 0, unit: 'min', window: vib.current ? { from: vib.current.from, to: ctx.now } : undefined },
          ]
        : []),
      ...(cur
        ? [
            { signalId: cur.signalId, label: 'Motor current now', value: cur.now != null ? Math.round(cur.now) : null, unit: 'A', at: ctx.now - 1 },
            { label: 'Rated current', value: rated, unit: 'A' },
            { label: 'Current above rated for', value: cur.current?.minutes ?? 0, unit: 'min', window: cur.current ? { from: cur.current.from, to: ctx.now } : undefined },
          ]
        : []),
    ];
    const missingSignals: MissingSignal[] = check.missing;
    const staleSignals: StaleSignal[] = check.stale;
    const partial = problemText.length ? ` Not evaluated: ${problemText.join('; ')}.` : '';
    const evidence: Evidence[] = [
      ...ex.map((x): Evidence => ({ kind: 'signal', label: x.def.name, ref: x.signalId, window: win })),
      { kind: 'chart', label: vib ? 'Vibration' : 'Motor current', ref: CHART.process(vib?.signalId ?? cur!.signalId), window: win },
    ];
    const cond = ctx.events(id, win).find((e) => e.trigger.ruleId === 'R-COND' && e.end == null);
    if (cond) evidence.push({ kind: 'event', label: cond.title, ref: cond.id, window: { from: cond.start, to: ctx.now } });
    const component = CONDITION_LIMITS[id]?.component;
    const temp = inCatalog(`${id}.temperature`) ? `${id}.temperature` : null;
    if (vibFires || curFires) {
      const serious = vibFires && !!vib!.alarmEpisode && vib!.alarmEpisode.minutes >= N;
      const parts: string[] = [];
      if (vibFires) {
        const e = vib!.current!;
        parts.push(
          `${vib!.signalId} has been above its warning level of ${vd(vib!.limit)} for ${duration(e.minutes)} (since ${clock(e.from)}) while running: now ${vd(vib!.now)}, up to ${vd(vib!.limit + e.maxAbs)}; alarm level ${vd(vib!.alarm)}${
            vib!.alarmEpisode ? ` — above it for ${duration(vib!.alarmEpisode.minutes)} (since ${clock(vib!.alarmEpisode.from)})` : ', not reached'
          }.`,
        );
      }
      if (curFires) {
        const e = cur!.current!;
        parts.push(
          `${cur!.signalId} has been above the rated current of ${ad(rated)}${margin > 0 ? ` (+${pct(margin)} allowed)` : ''} for ${duration(e.minutes)} (since ${clock(e.from)}) while running: now ${ad(cur!.now)}${
            cur!.now != null && rated ? ` (${pct(cur!.now / rated)} of rated)` : ''
          }, up to ${ad(cur!.limit + e.maxAbs)}.`,
        );
      }
      const firstSeen = Math.min(...[vibFires ? vib!.current!.from : Infinity, curFires ? cur!.current!.from : Infinity]);
      const what = vibFires && curFires ? 'vibration above its warning level and motor current above rated' : vibFires ? `vibration above its ${serious ? 'alarm' : 'warning'} level` : 'motor current above rated';
      return {
        status: 'fired',
        severity: serious ? 'serious' : 'warning',
        title: `${equipmentName(id)}: ${what}`,
        explanation: `${parts.join(' ')} Reported after ${num(N)} min above the level.${cond ? ` The condition event ${cond.id} (R-COND) carries the load-corrected assessment.` : ''} A threshold check on the signals only — no failure probability and no time to failure is estimated.${partial}`,
        measurements,
        window: { from: firstSeen, to: ctx.now },
        evidence,
        missingSignals,
        staleSignals,
        confidence: problemText.length ? 'medium' : 'high',
        next: `Check the drive train of ${id}${component ? ` (${component.toLowerCase()})` : ''} at the next opportunity: lubrication, alignment, coupling and mechanical load${temp ? `, with the bearing / oil temperature (${temp}) alongside` : ''}${
          curFires ? '; current above rated at normal output can come from mechanical drag or from the supply — check the drive current limit and the motor' : ''
        }.`,
        firstSeen,
        chartRef: CHART.process(vibFires ? vib!.signalId : cur!.signalId),
      };
    }
    const seg = st(ctx.now - 1);
    const resolved = [vib?.resolved, cur?.resolved].filter((x): x is DeviationEpisode => !!x).sort((a, b) => b.to - a.to)[0] ?? null;
    const resolvedText = resolved ? ` Above its level from ${clock(resolved.from)} to ${clock(resolved.to)} (${duration(resolved.minutes)}).` : '';
    const nowText = [
      vib ? `${vib.signalId} ${vd(vib.now)} (warning ${vd(vib.limit)}, alarm ${vd(vib.alarm)})` : '',
      cur ? `${cur.signalId} ${ad(cur.now)} (rated ${ad(rated)})` : '',
    ].filter(Boolean);
    if (stated && !running(ctx.now - 1))
      return {
        status: 'clear',
        title: `${equipmentName(id)}: drive condition not assessed now`,
        explanation: `Not assessed now: ${id} is ${seg ? `${OPERATIONAL_STATE_LABEL[seg.state]} since ${clock(seg.from)}` : 'without a known state'} — the drive condition is read while it runs.${resolvedText}${partial}`,
        measurements,
        window: win,
        evidence,
        missingSignals,
        staleSignals,
        confidence: 'low',
        confidenceNote: 'No condition check while the asset is not running.',
        next: null,
        resolvedAt: resolved?.to ?? null,
        chartRef: CHART.process(vib?.signalId ?? cur!.signalId),
      };
    const pending = [vib, cur].filter((x): x is Excursion => !!x?.current).map((x) => `${x.signalId} above its level for the last ${duration(x.current!.minutes)}`);
    return {
      status: 'clear',
      title: `${equipmentName(id)}: drive condition within limits`,
      explanation: `${list(nowText)} — within limits while running over the last ${W} min (${spanText(win)}).${pending.length ? ` ${list(pending)} — reported after ${num(N)} min.` : ''}${resolvedText}${partial}`,
      measurements,
      window: win,
      evidence,
      missingSignals,
      staleSignals,
      confidence: problemText.length ? 'medium' : 'high',
      next: null,
      resolvedAt: resolved?.to ?? null,
      chartRef: CHART.process(vib?.signalId ?? cur!.signalId),
    };
  },
};

/** The reliability rules, in display order. */
export const RELIABILITY_RULES: RuleDef[] = [RL_REPEAT, RL_RECURRING, RL_LONG, RL_COMMAND, RL_DRIVE];
