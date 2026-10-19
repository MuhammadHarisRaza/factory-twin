/**
 * Quality rules (brief §7): reject rate above its baseline, first-pass-yield decline, a defect category rising,
 * and the brief's quality scenario — a process deviation, the batch made during it, and that batch's reject rate
 * ("association to investigate", never a cause). Prefix QL- (the event engine's Q-RATE / Q-COUNT / Q-DET / Q-REPEAT
 * / Q-CRIT stay its own rules).
 *
 * Every verdict is a two-proportion z-test (src/calc proportionChange) of tiles rejected ÷ tiles inspected:
 * 'statistical', with the sample sizes, both rates, z and the critical value stated — and, besides significance, a
 * practical threshold (a ratio or a drop in points) so that the slow drift of a normal line does not read as a
 * finding. Counts come from the line's inspection counters (ctx.quality: the minute quality log, hourly buckets
 * beyond it); a window and its baseline never overlap (the baseline ends on the hour before the window) and are
 * never mixed with the inspection records, which carry batch ids only (each represents several rejected tiles, the
 * QC bench samples a few tiles an hour — neither is a denominator).
 *
 * Scope: the sorting & inspection stage (stage 10), where the line's tiles are inspected; plant and stage views
 * include them through the stage. The modelled line has no rework loop, so first-pass yield = accepted ÷ inspected
 * (1 − reject rate): QL-FPY-DECLINE watches a sustained decline over a shift against the week before,
 * QL-REJECT-BASELINE an acute rise over the last hour against the day before.
 */
import { deviationEpisodes, firstPassYield, proportionChange, usableValue, type Calc, type ProportionChange, type Sample, type Window } from '../../../calc';
import { DEFECT_ACTIONS } from '../../../model/actions';
import { CATALOG, stageOfEquipment, type ProductionStageNo, type SignalDefinition } from '../../../model/catalog';
import { DEFAULT_EVENT_RULES, DEFECTS, DEFECT_ORDER, OPS_BY_ID, SCENARIO_KIND_LABELS, STAGE_BY_ID } from '../../../model/plant';
import type { DefectCategory, StageId } from '../../../model/types';
import { LOG_MIN } from '../../../sim/engine';
import { formatDateTime } from '../../../sim/time';
import type { QualityCounts, RuleContext } from '../context';
import { CHART, type Evidence, type Measurement, type MissingSignal, type RuleDef, type RuleEvaluation, type RuleScope } from '../types';
import { RUNNING, clock, duration, equipmentName, list, num, pct, signalName, signalUnit, span, stateLookup } from '../util';

// ── Shared ───────────────────────────────────────────────────────────────────

/** The sorting, grading & inspection stage: every tile of the line is inspected there. */
const SORT_STAGE: ProductionStageNo = 10;
const isSortScope = (scope: RuleScope) => scope.kind === 'stage' && scope.stageNo === SORT_STAGE;

/** The line's inspection counters (vision tunnel: tiles inspected and rejected; gauge: rejected). */
const INSPECTED = 'I-VIS.count_inspected';
const COUNTERS = [INSPECTED, 'I-VIS.count_rejected', 'I-GAUGE.count_rejected'];

const ROUND = (v: number) => Math.round(v);
/** "31 of 1,214 tiles". */
const ofTiles = (q: { rejected: number; inspected: number }) => `${num(q.rejected)} of ${num(q.inspected)} tiles`;
/** A rate with two decimals below 1 %, one above ("0.62 %", "2.4 %"). */
const rate = (f: number | null) => (f == null ? '—' : pct(f, f < 0.01 ? 2 : 1));
const rateOf = (c: Calc<number>) => (c.status === 'ok' ? c.value : null);
const pctValue = (f: number | null, digits = 2) => (f == null ? null : Number((f * 100).toFixed(digits)));
const zText = (z: number) => `z = ${num(z, 1)}`;

/** Label and origin of a defect category: "chip & edge damage (originates at firing — H-KILN, stage 7)". */
function originText(d: DefectCategory): string {
  const st = STAGE_BY_ID[DEFECTS[d].origin];
  const no = stageOfEquipment(st.machines[0]);
  return `${DEFECTS[d].label.toLowerCase()} (originates at ${st.name.toLowerCase()} — ${list(st.machines)}${no ? `, stage ${no}` : ''})`;
}
/** Defect categories that originate at a process stage. */
const defectsFrom = (stage: StageId | null | undefined) => (stage ? DEFECT_ORDER.filter((d) => DEFECTS[d].origin === stage) : []);
const sumDefects = (q: { byDefect: Record<DefectCategory, number> }, ds: DefectCategory[]) => ds.reduce((a, d) => a + q.byDefect[d], 0);

/**
 * A recent window [now − W, now) and its baseline: the `hours` whole hours that end on the hour at or before the
 * window's start, so the two never overlap (the minutes between are in neither).
 */
function windowsOf(ctx: RuleContext, recentMin: number, hours: number): { recent: Window; baseline: Window } {
  const recent = { from: ctx.now - recentMin, to: ctx.now };
  const to = Math.floor(recent.from / 60) * 60;
  return { recent, baseline: { from: Math.max(0, to - Math.round(hours) * 60), to } };
}

/**
 * The baseline as read: "the 24 h to 09:00" — shorter than requested when the history starts later, with the hours
 * that have inspection buckets when some are missing.
 */
function baselineText(q: QualityCounts, requestedH: number): string {
  const hours = Math.round((q.window.to - q.window.from) / 60);
  const notes = [
    hours < Math.round(requestedH) ? `the history starts on ${formatDateTime(q.window.from)}; ${num(requestedH)} h requested` : '',
    q.resolution === 'hour' && q.coverage.present < q.coverage.expected ? `${q.coverage.present} of ${q.coverage.expected} h with inspection buckets` : '',
  ].filter(Boolean);
  return `the ${num(hours)} h to ${clock(q.window.to)}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

const counterEvidence = (w: Window): Evidence[] => [
  { kind: 'signal', label: signalName(INSPECTED), ref: INSPECTED, window: w },
  { kind: 'signal', label: signalName('I-VIS.count_rejected'), ref: 'I-VIS.count_rejected', window: w },
  { kind: 'signal', label: signalName('I-GAUGE.count_rejected'), ref: 'I-GAUGE.count_rejected', window: w },
  { kind: 'chart', label: 'Reject rate', ref: CHART.quality, window: w },
];

/** A rule-level 'insufficient-data' result: too few tiles inspected, or counts the test cannot use. */
function tooFew(ruleId: string, title: string, what: string, c: Calc<ProportionChange>, next: string | null = null): RuleEvaluation {
  const reason = c.status === 'ok' ? '' : c.reason;
  const missing: MissingSignal = { signalId: INSPECTED, name: signalName(INSPECTED), reason: `${what} — ${reason}` };
  return {
    status: 'insufficient-data',
    title: `${ruleId}: not evaluated`,
    explanation: `${title} not evaluated — ${what}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}. A significance test on fewer tiles would be a guess.`,
    missingSignals: [missing],
    confidence: 'low',
    confidenceNote: 'Too few inspected tiles for a two-proportion test — no verdict is given.',
    next,
    chartRef: CHART.quality,
  };
}

/** The defect category that adds the most to a rise in the reject rate (null when none rises). */
function largestRise(cur: QualityCounts, base: QualityCounts): DefectCategory | null {
  let best: DefectCategory | null = null;
  let gain = 0;
  for (const d of DEFECT_ORDER) {
    const g = cur.byDefect[d] / Math.max(1e-9, cur.inspected) - base.byDefect[d] / Math.max(1e-9, base.inspected);
    if (g > gain) {
      gain = g;
      best = d;
    }
  }
  return best;
}

const statNote = (n1: number, n0: number) =>
  `Two-proportion z-test on ${num(n1)} and ${num(n0)} inspected tiles; it assumes independent tiles and treats the simulated counts as samples. A significant change says the difference is unlikely to be chance — not what caused it.`;

// ── QL-REJECT-BASELINE · reject rate above its baseline ──────────────────────

const REJECT_ID = 'QL-REJECT-BASELINE';

const QL_REJECT_BASELINE: RuleDef = {
  id: REJECT_ID,
  family: 'quality',
  classification: 'statistical',
  title: 'Reject rate above its baseline',
  description:
    'Line reject rate (gauge + vision rejects ÷ tiles inspected) over the recent window against the whole hours before it, by a two-proportion z-test: reported when the rise is significant and at least the minimum ratio of the baseline. Below the minimum number of inspected tiles in either window it is not evaluated.',
  appliesTo: (scope) => isSortScope(scope),
  requiredSignals: () => COUNTERS,
  params: [
    { key: 'windowMin', label: 'Recent window', unit: 'min', default: 60, min: 15, max: LOG_MIN, step: 5, hint: 'The reject rate of this trailing window is compared with the baseline.' },
    { key: 'baselineH', label: 'Baseline', unit: 'h before the window', default: 24, min: 2, max: 168, step: 1, hint: 'Whole hours ending on the hour before the recent window (hourly inspection buckets).' },
    { key: 'minRatio', label: 'At least', unit: '× the baseline rate', decimals: 2, default: 1.35, min: 1.05, max: 5, step: 0.05, hint: 'Practical threshold: a significant rise smaller than this is not reported (the quality insight uses 1.35× too).' },
    { key: 'zCritical', label: 'Significant beyond', unit: 'z (two-sided)', decimals: 2, default: 2.58, min: 1.64, max: 6, step: 0.01, hint: 'Critical value of the two-proportion test (2.58 ≈ 99 %). The rule is evaluated every minute on overlapping windows, so a stricter value than 1.96 keeps chance findings rare.' },
    { key: 'minInspected', label: 'With at least', unit: 'tiles inspected per window', default: 300, min: 50, max: 20000, step: 50, hint: 'Fewer inspected tiles in either window give no verdict (Q-RATE needs 300 too).' },
    {
      key: 'seriousAbove',
      label: 'Serious above',
      unit: '% reject rate',
      scale: 100,
      decimals: 1,
      default: DEFAULT_EVENT_RULES.rejectRateMax,
      min: 0.005,
      max: 0.5,
      step: 0.005,
      hint: 'A finding with the recent rate above this is serious; follows the event rule Q-RATE (reject rate above) unless set here.',
      mirrors: { rule: 'rejectRateMax' },
    },
  ],
  evaluate: (ctx) => {
    const W = Math.round(ctx.param(REJECT_ID, 'windowMin'));
    const B = ctx.param(REJECT_ID, 'baselineH');
    const minRatio = ctx.param(REJECT_ID, 'minRatio');
    const zc = ctx.param(REJECT_ID, 'zCritical');
    const minN = ctx.param(REJECT_ID, 'minInspected');
    const { recent, baseline } = windowsOf(ctx, W, B);
    const cur = ctx.quality(recent);
    const base = ctx.quality(baseline);
    const test = proportionChange({ x: cur.rejected, n: cur.inspected }, { x: base.rejected, n: base.inspected }, { minN, z: zc });
    if (test.status !== 'ok')
      return tooFew(REJECT_ID, 'Reject rate', `${num(cur.inspected)} tiles inspected in the last ${W} min, ${num(base.inspected)} in ${baselineText(base, B)}`, test, null);
    const t = test.value;
    const ratio = t.baseline > 0 ? t.current / t.baseline : t.current > 0 ? Infinity : 1;
    const measurements: Measurement[] = [
      { signalId: 'I-VIS.count_rejected', label: 'Reject rate (recent window)', value: pctValue(t.current), unit: '%', window: cur.window },
      { label: 'Reject rate (baseline)', value: pctValue(t.baseline), unit: '%', window: base.window },
      { label: 'Ratio to the baseline', value: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null, unit: '×' },
      { label: 'z (two-proportion test)', value: Number(t.z.toFixed(2)), unit: null },
      { signalId: INSPECTED, label: 'Tiles inspected (recent window)', value: ROUND(cur.inspected), unit: 'tiles', window: cur.window },
      { signalId: INSPECTED, label: 'Tiles inspected (baseline)', value: ROUND(base.inspected), unit: 'tiles', window: base.window },
    ];
    const ratioText = t.baseline > 0 ? `${num(ratio, 2)}× the baseline` : 'against no reject in the baseline';
    const head = `Reject rate ${rate(t.current)} over the last ${W} min (${ofTiles(cur)}, ${span(cur.window)}) vs ${rate(t.baseline)} in ${baselineText(base, B)} (${ofTiles(base)}): ${ratioText}, ${zText(t.z)}`;
    const rule = `reported when significant (|z| ≥ ${num(zc, 2)}) and at least ${num(minRatio, 2)}× the baseline`;
    const fired = t.significant && t.diff > 0 && ratio >= minRatio;
    const evidence = [...counterEvidence(recent), ...ctx.events('I-VIS', recent).slice(0, 2).map((e): Evidence => ({ kind: 'event', label: e.title, ref: e.id }))];
    if (!fired)
      return {
        status: 'clear',
        title: 'Reject rate within its baseline',
        explanation: `${head} — ${t.significant ? (t.diff > 0 ? `significant but below ${num(minRatio, 2)}× the baseline` : 'significantly lower than the baseline') : 'not significant'} (${rule}).`,
        measurements,
        window: recent,
        evidence: counterEvidence(recent),
        confidenceNote: statNote(cur.inspected, base.inspected),
        next: null,
        chartRef: CHART.quality,
      };
    const top = largestRise(cur, base);
    const topText = top
      ? ` The largest contribution: ${originText(top)}, ${rate(cur.byDefect[top] / cur.inspected)} of inspected tiles vs ${rate(base.byDefect[top] / base.inspected)}.`
      : '';
    return {
      status: 'fired',
      severity: t.current > ctx.param(REJECT_ID, 'seriousAbove') ? 'serious' : 'warning',
      title: `Reject rate ${rate(t.current)} — ${Number.isFinite(ratio) ? `${num(ratio, 1)}×` : 'above'} its baseline`,
      explanation: `${head} — a significant rise (${rule}).${topText}`,
      measurements,
      window: recent,
      evidence,
      confidence: 'medium',
      confidenceNote: statNote(cur.inspected, base.inspected),
      next: top
        ? `Check the ${DEFECTS[top].label.toLowerCase()} rejects first: ${DEFECT_ACTIONS[top]} Compare the batch and the process values of ${STAGE_BY_ID[DEFECTS[top].origin].name.toLowerCase()} in the window with the baseline.`
        : 'Open the reject records of the window by category and station, and compare the batch and the process values with the baseline.',
      firstSeen: recent.from,
      chartRef: CHART.quality,
    };
  },
};

// ── QL-FPY-DECLINE · first-pass yield declining ──────────────────────────────

const FPY_ID = 'QL-FPY-DECLINE';

const QL_FPY_DECLINE: RuleDef = {
  id: FPY_ID,
  family: 'quality',
  classification: 'statistical',
  title: 'First-pass yield declining',
  description:
    'First-pass yield (tiles accepted at the first inspection ÷ tiles inspected — the modelled line has no rework loop) over the recent window against the whole hours before it, by a two-proportion z-test: reported when the decline is significant and at least the minimum drop in percentage points. A sustained-decline check; QL-REJECT-BASELINE watches the last hour.',
  appliesTo: (scope) => isSortScope(scope),
  requiredSignals: () => COUNTERS,
  params: [
    { key: 'windowMin', label: 'Recent window', unit: 'min', default: 480, min: 60, max: LOG_MIN, step: 30, hint: 'The first-pass yield of this trailing window (default one shift) is compared with the baseline.' },
    { key: 'baselineH', label: 'Baseline', unit: 'h before the window', default: 168, min: 8, max: 168, step: 1, hint: 'Whole hours ending on the hour before the recent window (default the week before; shorter when less history is kept).' },
    { key: 'minDrop', label: 'Lower by at least', unit: 'percentage points', scale: 100, decimals: 1, default: 0.01, min: 0.001, max: 0.2, step: 0.001, hint: 'Practical threshold: a significant decline smaller than this is not reported.' },
    { key: 'zCritical', label: 'Significant beyond', unit: 'z (two-sided)', decimals: 2, default: 2.58, min: 1.64, max: 6, step: 0.01, hint: 'Critical value of the two-proportion test (2.58 ≈ 99 %).' },
    { key: 'minInspected', label: 'With at least', unit: 'tiles inspected per window', default: 1000, min: 100, max: 50000, step: 100, hint: 'Fewer inspected tiles in either window give no verdict.' },
  ],
  evaluate: (ctx) => {
    const W = Math.round(ctx.param(FPY_ID, 'windowMin'));
    const B = ctx.param(FPY_ID, 'baselineH');
    const minDrop = ctx.param(FPY_ID, 'minDrop');
    const zc = ctx.param(FPY_ID, 'zCritical');
    const minN = ctx.param(FPY_ID, 'minInspected');
    const { recent, baseline } = windowsOf(ctx, W, B);
    const cur = ctx.quality(recent);
    const base = ctx.quality(baseline);
    const good = (q: QualityCounts) => Math.max(0, q.inspected - q.rejected);
    const test = proportionChange({ x: good(cur), n: cur.inspected }, { x: good(base), n: base.inspected }, { minN, z: zc });
    if (test.status !== 'ok')
      return tooFew(FPY_ID, 'First-pass yield', `${num(cur.inspected)} tiles inspected in the last ${W} min, ${num(base.inspected)} in ${baselineText(base, B)}`, test, null);
    const t = test.value;
    const fpyNow = rateOf(firstPassYield(good(cur), cur.inspected));
    const fpyBase = rateOf(firstPassYield(good(base), base.inspected));
    const drop = -t.diff;
    const measurements: Measurement[] = [
      { signalId: 'I-SORT.count_good', label: 'First-pass yield (recent window)', value: pctValue(fpyNow), unit: '%', window: cur.window },
      { label: 'First-pass yield (baseline)', value: pctValue(fpyBase), unit: '%', window: base.window },
      { label: 'Change', value: Number((t.diff * 100).toFixed(2)), unit: 'percentage points' },
      { label: 'z (two-proportion test)', value: Number(t.z.toFixed(2)), unit: null },
      { signalId: INSPECTED, label: 'Tiles inspected (recent window)', value: ROUND(cur.inspected), unit: 'tiles', window: cur.window },
      { signalId: INSPECTED, label: 'Tiles inspected (baseline)', value: ROUND(base.inspected), unit: 'tiles', window: base.window },
    ];
    const pts = (f: number) => `${f >= 0 ? '+' : '−'}${num(Math.abs(f) * 100, 2)} pts`;
    const head = `First-pass yield ${pct(fpyNow, 2)} over the last ${duration(W)} (${num(good(cur))} of ${num(cur.inspected)} tiles accepted, ${span(cur.window)}) vs ${pct(fpyBase, 2)} in ${baselineText(base, B)} (${num(good(base))} of ${num(base.inspected)}): ${pts(t.diff)}, ${zText(t.z)}`;
    const rule = `reported when significant (|z| ≥ ${num(zc, 2)}) and at least ${num(minDrop * 100, 1)} pts lower`;
    if (!(t.significant && drop >= minDrop))
      return {
        status: 'clear',
        title: 'First-pass yield holding',
        explanation: `${head} — ${t.significant ? (drop > 0 ? `significant but less than ${num(minDrop * 100, 1)} pts lower` : 'significantly higher than the baseline') : 'no significant change'} (${rule}).`,
        measurements,
        window: recent,
        evidence: counterEvidence(recent),
        confidenceNote: statNote(cur.inspected, base.inspected),
        next: null,
        chartRef: CHART.quality,
      };
    const top = largestRise(cur, base);
    return {
      status: 'fired',
      severity: drop >= 2 * minDrop ? 'warning' : 'info',
      title: `First-pass yield down ${num(drop * 100, 1)} pts to ${pct(fpyNow, 1)}`,
      explanation: `${head} — a significant decline (${rule}).${top ? ` The largest contribution: ${originText(top)}.` : ''}`,
      measurements,
      window: recent,
      evidence: counterEvidence(recent),
      confidence: 'medium',
      confidenceNote: statNote(cur.inspected, base.inspected),
      next: top
        ? `Compare the shift's ${DEFECTS[top].label.toLowerCase()} rejects by batch and hour with the week before, then: ${DEFECT_ACTIONS[top]}`
        : 'Compare the reject categories of the shift by batch and hour with the week before.',
      firstSeen: recent.from,
      chartRef: CHART.quality,
    };
  },
};

// ── QL-DEFECT-CATEGORY · a defect category rising ────────────────────────────

const CATEGORY_ID = 'QL-DEFECT-CATEGORY';

const QL_DEFECT_CATEGORY: RuleDef = {
  id: CATEGORY_ID,
  family: 'quality',
  classification: 'statistical',
  title: 'Defect category rising',
  description:
    "A defect category's share of inspected tiles (its rejects ÷ tiles inspected) over the recent window against the whole hours before it, by a two-proportion z-test per category: reported when the rise is significant, at least the minimum ratio (follows the event rule Q-DET) and the category reaches the minimum rate. Names the category and the stage where it originates (modelled attribution).",
  appliesTo: (scope) => isSortScope(scope),
  requiredSignals: () => COUNTERS,
  params: [
    { key: 'windowMin', label: 'Recent window', unit: 'min', default: 120, min: 30, max: LOG_MIN, step: 10, hint: 'The category rates of this trailing window are compared with the baseline (Q-DET uses 2 h).' },
    { key: 'baselineH', label: 'Baseline', unit: 'h before the window', default: 24, min: 2, max: 168, step: 1, hint: 'Whole hours ending on the hour before the recent window (Q-DET uses the 24 h before).' },
    {
      key: 'minRatio',
      label: 'At least',
      unit: '× the baseline rate',
      decimals: 2,
      default: DEFAULT_EVENT_RULES.deteriorationRatio,
      min: 1.1,
      max: 10,
      step: 0.1,
      hint: 'Practical threshold; follows the event rule Q-DET (deterioration ratio) unless set here.',
      mirrors: { rule: 'deteriorationRatio' },
    },
    { key: 'minRate', label: 'And at least', unit: '% of inspected tiles', scale: 100, decimals: 2, default: 0.004, min: 0, max: 0.1, step: 0.001, hint: 'A category below this share of inspected tiles is not reported however fast it rises (Q-DET uses 0.4 %).' },
    { key: 'zCritical', label: 'Significant beyond', unit: 'z (two-sided)', decimals: 2, default: 2.58, min: 1.64, max: 6, step: 0.01, hint: 'Critical value of the two-proportion test (2.58 ≈ 99 %); seven categories are tested each minute.' },
    { key: 'minInspected', label: 'With at least', unit: 'tiles inspected per window', default: 600, min: 100, max: 20000, step: 50, hint: 'Fewer inspected tiles in either window give no verdict (Q-DET needs 600).' },
  ],
  evaluate: (ctx) => {
    const W = Math.round(ctx.param(CATEGORY_ID, 'windowMin'));
    const B = ctx.param(CATEGORY_ID, 'baselineH');
    const minRatio = ctx.param(CATEGORY_ID, 'minRatio');
    const minRate = ctx.param(CATEGORY_ID, 'minRate');
    const zc = ctx.param(CATEGORY_ID, 'zCritical');
    const minN = ctx.param(CATEGORY_ID, 'minInspected');
    const { recent, baseline } = windowsOf(ctx, W, B);
    const cur = ctx.quality(recent);
    const base = ctx.quality(baseline);
    const rows = DEFECT_ORDER.map((d) => ({ d, test: proportionChange({ x: cur.byDefect[d], n: cur.inspected }, { x: base.byDefect[d], n: base.inspected }, { minN, z: zc }) }));
    const failed = rows.find((r) => r.test.status !== 'ok');
    if (failed) return tooFew(CATEGORY_ID, 'Defect categories', `${num(cur.inspected)} tiles inspected in the last ${W} min, ${num(base.inspected)} in ${baselineText(base, B)}`, failed.test, null);
    const ok = rows.map((r) => ({ d: r.d, t: (r.test as Extract<Calc<ProportionChange>, { status: 'ok' }>).value }));
    const ratioOf = (t: ProportionChange) => (t.baseline > 0 ? t.current / t.baseline : t.current > 0 ? Infinity : 1);
    const rising = ok.filter(({ t }) => t.significant && t.diff > 0 && ratioOf(t) >= minRatio && t.current >= minRate).sort((a, b) => b.t.z - a.t.z);
    const rule = `reported when significant (|z| ≥ ${num(zc, 2)}), at least ${num(minRatio, 1)}× the baseline and ${pct(minRate, 1)} of inspected tiles`;
    const windows = `the last ${W} min (${span(cur.window)}, ${num(cur.inspected)} tiles inspected) vs ${baselineText(base, B)} (${num(base.inspected)} tiles)`;
    const measurementsOf = (d: DefectCategory, t: ProportionChange): Measurement[] => [
      { label: `${DEFECTS[d].label} (recent window)`, value: pctValue(t.current), unit: '% of inspected tiles', window: cur.window },
      { label: `${DEFECTS[d].label} (baseline)`, value: pctValue(t.baseline), unit: '% of inspected tiles', window: base.window },
      { label: 'Ratio to the baseline', value: Number.isFinite(ratioOf(t)) ? Number(ratioOf(t).toFixed(2)) : null, unit: '×' },
      { label: 'z (two-proportion test)', value: Number(t.z.toFixed(2)), unit: null },
      { label: `${DEFECTS[d].label} rejects (recent window)`, value: ROUND(cur.byDefect[d]), unit: 'tiles', window: cur.window },
      { label: 'Share of all rejects (recent window)', value: cur.rejected > 0 ? pctValue(cur.byDefect[d] / cur.rejected, 1) : null, unit: '%', window: cur.window },
    ];
    if (!rising.length) {
      const top = [...ok].sort((a, b) => b.t.z - a.t.z)[0];
      return {
        status: 'clear',
        title: 'No defect category rising',
        explanation: `No defect category rises significantly over ${windows} (${rule}). Largest change: ${DEFECTS[top.d].label.toLowerCase()} ${rate(top.t.current)} of inspected tiles vs ${rate(top.t.baseline)}, ${zText(top.t.z)}.`,
        measurements: measurementsOf(top.d, top.t),
        window: recent,
        evidence: counterEvidence(recent),
        confidenceNote: statNote(cur.inspected, base.inspected),
        next: null,
        chartRef: CHART.quality,
      };
    }
    return rising.map(({ d, t }): RuleEvaluation => {
      const ratio = ratioOf(t);
      const origin = DEFECTS[d].origin;
      const machines = STAGE_BY_ID[origin].machines;
      const station = DEFECTS[d].station;
      return {
        status: 'fired',
        severity: ratio >= 2 * minRatio ? 'serious' : 'warning',
        subject: d,
        title: `${DEFECTS[d].label} rising — ${Number.isFinite(ratio) ? `${num(ratio, 1)}×` : 'up from none'} · origin ${STAGE_BY_ID[origin].name.toLowerCase()}`,
        explanation: `${DEFECTS[d].label} rejects (${station === 'ST-VIS' ? 'vision tunnel' : 'planarity & caliper gauge'}): ${rate(t.current)} of inspected tiles over the last ${W} min (${num(cur.byDefect[d])} of ${num(cur.inspected)} tiles, ${span(cur.window)}) vs ${rate(t.baseline)} in ${baselineText(base, B)} (${num(base.byDefect[d])} of ${num(base.inspected)}): ${Number.isFinite(ratio) ? `${num(ratio, 2)}×` : 'up from none'}, ${zText(t.z)} — a significant rise (${rule}). The category is ${originText(d)} by the modelled defect attribution — where it usually starts, not a confirmed cause.`,
        measurements: measurementsOf(d, t),
        window: recent,
        evidence: [...counterEvidence(recent), ...machines.map((m): Evidence => ({ kind: 'signal', label: `${equipmentName(m)} state`, ref: `${m}.state`, window: recent }))],
        confidence: 'medium',
        confidenceNote: statNote(cur.inspected, base.inspected),
        next: `${DEFECT_ACTIONS[d]} Compare the process values of ${list(machines)} over ${span(recent)} with the baseline.`,
        firstSeen: recent.from,
        chartRef: CHART.quality,
      };
    });
  },
};

// ── QL-PROCESS-ASSOCIATION · process deviation ↔ reject rate of its batch ─────

const ASSOC_ID = 'QL-PROCESS-ASSOCIATION';

/** Process values controlled to a setpoint, with a warning band (the deviation threshold). */
const PVS: SignalDefinition[] = CATALOG.filter(
  (d) => d.category === 'process' && !!d.setpointSignalId && d.warningLow != null && d.warningHigh != null && d.availabilityStatus === 'simulated',
);
/** "Zone 3 temperature" of "Zone 3 temperature · peak firing · actual". */
const shortName = (d: SignalDefinition) => d.name.split(' · ')[0];
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Half-width of a PV's warning band around its setpoint. */
const bandOf = (d: SignalDefinition) => ((d.warningHigh as number) - (d.warningLow as number)) / 2;

type Exposure = { pv: SignalDefinition; episodes: { from: number; to: number; minutes: number; maxAbs: number }[]; windows: Window[]; usable: number; samples: number };

/** Sorted, merged windows. */
function merge(ws: Window[]): Window[] {
  const out: Window[] = [];
  for (const w of [...ws].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else if (w.to > w.from) out.push({ ...w });
  }
  return out;
}
/** The parts of `w` outside the (merged) windows `cut`. */
function minus(w: Window, cut: Window[]): Window[] {
  const out: Window[] = [];
  let from = w.from;
  for (const c of cut) {
    if (c.to <= from || c.from >= w.to) continue;
    if (c.from > from) out.push({ from, to: Math.min(c.from, w.to) });
    from = Math.max(from, c.to);
  }
  if (from < w.to) out.push({ from, to: w.to });
  return out;
}
/** Line counts summed over windows (minute quality log). */
function countsOver(ctx: RuleContext, ws: Window[]): { inspected: number; rejected: number; byDefect: Record<DefectCategory, number> } {
  const byDefect = Object.fromEntries(DEFECT_ORDER.map((d) => [d, 0])) as Record<DefectCategory, number>;
  let inspected = 0;
  let rejected = 0;
  for (const w of ws) {
    const q = ctx.quality(w);
    inspected += q.inspected;
    rejected += q.rejected;
    for (const d of DEFECT_ORDER) byDefect[d] += q.byDefect[d];
  }
  return { inspected, rejected, byDefect };
}
/**
 * The batches of the tiles inspected in the windows, from the batch ids on the inspection records: the records in
 * the windows (most records first); with none there (a short window — records stand for several rejects), the
 * records just before and just after them, which bracket the tiles in between.
 */
function batchesOf(ctx: RuleContext, ws: Window[], lookback: Window): { ids: string[]; bracketed: boolean } {
  const n = new Map<string, number>();
  for (const w of ws) for (const r of ctx.inspections(w)) if (r.batchId) n.set(r.batchId, (n.get(r.batchId) ?? 0) + 1);
  if (n.size) return { ids: [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id), bracketed: false };
  if (!ws.length) return { ids: [], bracketed: false };
  const before = ctx.inspections({ from: lookback.from, to: ws[0].from }).filter((r) => r.batchId).pop();
  const after = ctx.inspections({ from: ws[ws.length - 1].to, to: ctx.now }).find((r) => r.batchId);
  return { ids: [...new Set([before?.batchId, after?.batchId].filter((x): x is string => !!x))], bracketed: true };
}

/**
 * Deviation episodes of every PV over the lookback: |PV − SP| beyond the warning band for at least the minimum
 * duration while its machine runs (state timeline; a stopped machine makes no tiles, so its cooling is no exposure).
 */
function exposures(ctx: RuleContext, lookback: Window, minMin: number, transit: number): Exposure[] {
  const out: Exposure[] = [];
  for (const pv of PVS) {
    const eq = pv.equipmentId;
    const segs = ctx.states(eq, lookback);
    const st = segs.length ? stateLookup(segs) : null;
    const raw = ctx.samples(pv.signalId, lookback);
    const samples: Sample[] = raw.map((x) => {
      const state = st?.(x.t)?.state;
      return st && !(state && RUNNING.has(state)) ? { t: x.t, v: null, q: 'missing' } : x;
    });
    const sp = ctx.samples(pv.setpointSignalId!, lookback);
    const episodes = deviationEpisodes(samples, sp, bandOf(pv), { minMinutes: minMin, stepMin: 1 });
    const windows = merge(episodes.map((e) => ({ from: Math.max(lookback.from, e.from + transit), to: Math.min(ctx.now, e.to + transit) })));
    out.push({ pv, episodes, windows, usable: raw.filter((x) => usableValue(x) !== null).length, samples: raw.length });
  }
  return out;
}

/** '+' / '−' when the PV was above / below its setpoint on average over the episode ('±' when unknown). */
function signOf(samples: Sample[], ep: Window, sp: number | null): string {
  let sum = 0;
  let n = 0;
  for (const x of samples) {
    const v = x.t >= ep.from && x.t < ep.to ? usableValue(x) : null;
    if (v == null) continue;
    sum += v;
    n++;
  }
  return sp == null || !n ? '±' : sum / n >= sp ? '+' : '−';
}

const QL_PROCESS_ASSOCIATION: RuleDef = {
  id: ASSOC_ID,
  family: 'quality',
  classification: 'statistical',
  title: 'Process deviation associated with a batch reject rate',
  description:
    "A process value outside its warning band around the setpoint for at least the minimum duration while its machine runs (deviation episodes over the lookback, any PV with a setpoint); the batch made during it (batch ids on the inspection records of those minutes); the reject rate of those tiles against the tiles made outside every deviation, by a two-proportion z-test. A significant, large enough difference is an association to investigate — never a demonstrated cause. Without batch ids, PV history or enough inspected tiles it is not evaluated.",
  appliesTo: (scope) => isSortScope(scope),
  requiredSignals: () => COUNTERS,
  params: [
    { key: 'lookbackMin', label: 'Look back', unit: 'min', default: LOG_MIN, min: 60, max: LOG_MIN, step: 30, hint: 'Deviations and inspections of this trailing window (minute history).' },
    { key: 'minEpisodeMin', label: 'Deviation for at least', unit: 'min', default: 10, min: 1, max: 240, step: 1, hint: 'Shorter excursions beyond the warning band are not treated as a deviation episode.' },
    { key: 'transitMin', label: 'Transit to sorting', unit: 'min', default: 0, min: 0, max: 240, step: 1, hint: 'Minutes from the deviating stage to sorting. The simulation models no residence or transit time (a tile passes the kiln and sorting in the same minute), so 0; a real line configures it per stage.' },
    { key: 'minRatio', label: 'At least', unit: '× the rate outside', decimals: 2, default: 1.5, min: 1.05, max: 10, step: 0.05, hint: 'Practical threshold: a significant difference smaller than this is not reported.' },
    { key: 'zCritical', label: 'Significant beyond', unit: 'z (two-sided)', decimals: 2, default: 2.58, min: 1.64, max: 6, step: 0.01, hint: 'Critical value of the two-proportion test (2.58 ≈ 99 %).' },
    { key: 'minInspected', label: 'With at least', unit: 'tiles inspected per group', default: 200, min: 50, max: 20000, step: 50, hint: 'Fewer tiles made during the deviation (or outside it) give no verdict.' },
  ],
  evaluate: (ctx) => {
    const L = Math.round(Math.min(LOG_MIN, ctx.param(ASSOC_ID, 'lookbackMin')));
    const minMin = ctx.param(ASSOC_ID, 'minEpisodeMin');
    const transit = Math.round(ctx.param(ASSOC_ID, 'transitMin'));
    const minRatio = ctx.param(ASSOC_ID, 'minRatio');
    const zc = ctx.param(ASSOC_ID, 'zCritical');
    const minN = ctx.param(ASSOC_ID, 'minInspected');
    // The trailing minute history, never before the first simulated minute.
    const lookback = { from: Math.max(0, ctx.now - L), to: ctx.now };
    const lookText = duration(lookback.to - lookback.from);
    const all = exposures(ctx, lookback, minMin, transit);
    const unusable = all.filter((x) => x.usable < x.samples / 2);
    const unusableText = unusable.length ? ` Not assessed — a usable value for less than half the window (machine not producing, or a data problem): ${list(unusable.map((x) => x.pv.signalId))}.` : '';
    const deviating = all.filter((x) => x.windows.length);
    const unusableSignals = unusable.map((x) => ({ signalId: x.pv.signalId, name: x.pv.name, reason: `${x.usable} of ${x.samples} minutes with a usable value in the last ${lookText}` }));
    if (!deviating.length && unusable.length === all.length)
      return {
        status: 'insufficient-data',
        title: `${ASSOC_ID}: not evaluated`,
        explanation: `Not evaluated — no process value with a setpoint has a usable history for at least half of the last ${lookText}, so deviations cannot be told from missing data.`,
        missingSignals: unusableSignals,
        next: null,
        signals: [...COUNTERS, ...PVS.flatMap((p) => [p.signalId, p.setpointSignalId!])],
      };
    const bandText = (pv: SignalDefinition) => `±${num(bandOf(pv), Math.abs(bandOf(pv)) >= 1 ? 0 : 2)} ${pv.unit ?? ''}`.trim();
    if (!deviating.length)
      return {
        status: 'clear',
        title: 'No process deviation to associate',
        explanation: `No process value with a setpoint left its warning band for ${num(minMin)} min or longer while its machine ran in the last ${lookText} (${span(lookback)}; ${PVS.length - unusable.length} of ${PVS.length} process values checked) — there is no deviation to compare a batch's reject rate with.${unusableText}`,
        window: lookback,
        evidence: [{ kind: 'chart', label: 'Reject rate', ref: CHART.quality, window: lookback }],
        missingSignals: unusableSignals.map((m) => ({ ...m, optional: true })),
        next: null,
        signals: [...COUNTERS, ...PVS.flatMap((p) => [p.signalId, p.setpointSignalId!])],
        chartRef: CHART.quality,
      };
    const exposedAll = merge(deviating.flatMap((x) => x.windows));
    const outside = minus(lookback, exposedAll);
    const ref = countsOver(ctx, outside);
    const refBatches = batchesOf(ctx, outside, lookback).ids;
    // One finding per equipment item: PVs of one machine that deviate together (e.g. kiln zones after a restart) are
    // one exposure of the same tiles; the PV with the largest excess (× its band, × minutes) leads the text.
    const byEquipment = new Map<string, Exposure[]>();
    for (const x of deviating) byEquipment.set(x.pv.equipmentId, [...(byEquipment.get(x.pv.equipmentId) ?? []), x]);
    const weight = (x: Exposure) => Math.max(...x.episodes.map((e) => (e.maxAbs / bandOf(x.pv)) * e.minutes));
    return [...byEquipment.entries()].map(([eq, group]): RuleEvaluation => {
      const lead = group.reduce((a, b) => (weight(b) > weight(a) ? b : a));
      const { pv, episodes } = lead;
      const windows = merge(group.flatMap((x) => x.windows));
      const sp = pv.setpointSignalId!;
      const unit = signalUnit(pv.signalId) ?? '';
      const digits = Math.abs(bandOf(pv)) >= 1 ? 0 : 2;
      const ep = episodes.reduce((a, b) => (b.maxAbs * b.minutes > a.maxAbs * a.minutes ? b : a));
      const started = Math.min(...group.map((x) => x.episodes[0].from));
      const ended = Math.max(...group.map((x) => x.episodes[x.episodes.length - 1].to));
      const spValue = ctx.read(sp).value;
      const dir = signOf(ctx.samples(pv.signalId, lookback), ep, typeof spValue === 'number' ? spValue : null);
      const when = (e: Window) => (e.to >= ctx.now ? `since ${clock(e.from)} (ongoing)` : span(e));
      const what = `${eq} ${shortName(pv).toLowerCase()}`;
      const devText = `the ${what} deviation ${when(ep)} (up to ${dir}${num(ep.maxAbs, digits)} ${unit} from its setpoint${typeof spValue === 'number' ? ` of ${num(spValue, digits)} ${unit}` : ''}, beyond its ${bandText(pv)} warning band)`;
      const others = `${episodes.length > 1 ? ` ${episodes.length} episodes in the lookback: ${list(episodes.map(when))}.` : ''}${
        group.length > 1 ? ` Also outside their warning bands on ${eq}: ${list(group.filter((x) => x !== lead).map((x) => `${shortName(x.pv).toLowerCase()} (${list(x.episodes.map(when))})`))}.` : ''
      }`;
      const exposed = countsOver(ctx, windows);
      const { ids: batches, bracketed } = batchesOf(ctx, windows, lookback);
      const stage = OPS_BY_ID[eq]?.stage;
      const origin = defectsFrom(stage);
      const acting = ctx.scenarios(eq, { from: ep.from, to: ctx.now });
      const scenario = acting.find((sc) => sc.signalId === pv.signalId) ?? acting[0];
      const scenarioText = scenario ? ` A simulated scenario acts on ${eq} in this window: ${scenario.label} (${SCENARIO_KIND_LABELS[scenario.kind]}, since ${clock(scenario.start)}).` : '';
      const evidence: Evidence[] = [
        { kind: 'signal', label: pv.name, ref: pv.signalId, window: { from: ep.from, to: ep.to } },
        { kind: 'signal', label: signalName(sp), ref: sp },
        { kind: 'chart', label: pv.name, ref: CHART.process(pv.signalId), window: lookback },
        { kind: 'chart', label: 'Reject rate', ref: CHART.quality, window: lookback },
        ...ctx.events(eq, { from: ep.from, to: Math.max(ep.to, ep.from + 1) }).slice(0, 2).map((e): Evidence => ({ kind: 'event', label: e.title, ref: e.id })),
      ];
      const signals = [...COUNTERS, ...group.flatMap((x) => [x.pv.signalId, x.pv.setpointSignalId!])];
      if (!batches.length)
        return {
          status: 'insufficient-data',
          subject: eq,
          title: `${ASSOC_ID}: not evaluated`,
          explanation: `Not evaluated — ${devText}, but no inspection record in or around those minutes carries a batch id, so the deviation cannot be tied to a batch.`,
          missingSignals: [{ signalId: 'I-VIS.count_rejected', name: 'Inspection records (batch ids)', reason: `no record with a batch id in or around ${list(windows.map(span))}` }],
          evidence,
          next: 'Check that the QMS / vision records carry the batch (lot) id of each inspected tile.',
          signals,
        };
      const test = proportionChange({ x: exposed.rejected, n: exposed.inspected }, { x: ref.rejected, n: ref.inspected }, { minN, z: zc });
      if (test.status !== 'ok') {
        const ev = tooFew(ASSOC_ID, 'The association', `${num(exposed.inspected)} tiles inspected that were made during ${devText}; ${num(ref.inspected)} made outside every deviation in the last ${lookText}`, test, null);
        return { ...ev, subject: eq, evidence, signals };
      }
      const t = test.value;
      const ratio = t.baseline > 0 ? t.current / t.baseline : t.current > 0 ? Infinity : 1;
      const batchText = batches.length === 1 ? `batch ${batches[0]}` : `batches ${list(batches)}`;
      const refText = refBatches.length ? ` (${refBatches.length === 1 ? 'batch' : 'batches'} ${list(refBatches)})` : '';
      const originRates = origin.length
        ? ` Defects that originate at ${STAGE_BY_ID[stage!].name.toLowerCase()} (${list(origin.map((d) => DEFECTS[d].label.toLowerCase()))}): ${rate(sumDefects(exposed, origin) / exposed.inspected)} of the tiles made during the deviation vs ${rate(sumDefects(ref, origin) / ref.inspected)}.`
        : '';
      const measurements: Measurement[] = [
        { label: 'Reject rate — made during the deviation', value: pctValue(t.current), unit: '%', window: { from: windows[0].from, to: windows[windows.length - 1].to } },
        { label: 'Reject rate — made outside any deviation', value: pctValue(t.baseline), unit: '%', window: lookback },
        { label: 'Ratio', value: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null, unit: '×' },
        { label: 'z (two-proportion test)', value: Number(t.z.toFixed(2)), unit: null },
        { signalId: INSPECTED, label: 'Tiles inspected — made during the deviation', value: ROUND(exposed.inspected), unit: 'tiles' },
        { signalId: INSPECTED, label: 'Tiles inspected — made outside', value: ROUND(ref.inspected), unit: 'tiles' },
        { signalId: pv.signalId, label: 'Largest deviation from the setpoint', value: Number(ep.maxAbs.toFixed(digits + 1)), unit: unit || null, window: { from: ep.from, to: ep.to } },
        { signalId: pv.signalId, label: 'Deviation episode', value: ep.minutes, unit: 'min', window: { from: ep.from, to: ep.to } },
      ];
      const transitText = transit ? `matched ${transit} min later at sorting (configured transit)` : 'matched by the minute they passed sorting (this simulation models no transit or residence time between the stage and sorting)';
      const how = `${ofTiles(exposed)} made during the deviation were rejected vs ${ofTiles(ref)} made outside every deviation in the last ${lookText}${refText}. Batch attribution from the batch ids on the inspection records${bracketed ? ' (none within the deviation itself: the records just before and after it)' : ''}; tiles ${transitText}.`;
      const rule = `reported when significant (|z| ≥ ${num(zc, 2)}) and at least ${num(minRatio, 2)}× the rate outside`;
      const versus = `a reject rate of ${rate(t.current)} vs ${rate(t.baseline)} for the tiles made outside it`;
      if (!(t.significant && t.diff > 0 && ratio >= minRatio))
        return {
          status: 'clear',
          subject: eq,
          title: `${cap(what)}: no significant batch association`,
          explanation: `Tiles of ${batchText} made during ${devText} have ${versus}, ${zText(t.z)} — ${t.significant && t.diff > 0 ? `significant but below ${num(minRatio, 2)}× ` : 'no significant difference '}(${rule}).${originRates}${others} ${how}${scenarioText}`,
          measurements,
          window: lookback,
          evidence,
          confidenceNote: statNote(exposed.inspected, ref.inspected),
          next: null,
          signals,
          chartRef: CHART.process(pv.signalId),
        };
      return {
        status: 'fired',
        severity: 'warning',
        subject: eq,
        title: `Association to investigate: ${batchText} · ${what} deviation`,
        explanation: `Association to investigate — not a demonstrated cause: the tiles of ${batchText} made during ${devText} have ${versus}: ${Number.isFinite(ratio) ? `${num(ratio, 1)}×` : 'up from none'}, ${zText(t.z)} — a significant difference (${rule}).${originRates}${others} ${how} Other conditions that changed at the same time (batch, recipe, other stages) can explain the same difference.${scenarioText}`,
        measurements,
        window: { from: started, to: ended },
        evidence,
        confidence: 'medium',
        confidenceNote: `${statNote(exposed.inspected, ref.inspected)} Correlation in time and batch only.`,
        next: `Hold the pallets of ${batchText} for a quality review (QC sample of the batch) and check the ${shortName(pv).toLowerCase()} control of ${eq} — sensor, actuator and setpoint record ${when(ep)} — before changing the process; confirm the link with a controlled comparison.`,
        firstSeen: started,
        signals,
        chartRef: CHART.process(pv.signalId),
      };
    });
  },
};

/** The quality rules, in display order. */
export const QUALITY_RULES: RuleDef[] = [QL_REJECT_BASELINE, QL_FPY_DECLINE, QL_DEFECT_CATEGORY, QL_PROCESS_ASSOCIATION];

/** The process values QL-PROCESS-ASSOCIATION watches (PVs with a setpoint and a warning band). */
export const ASSOCIATION_PVS: string[] = PVS.map((d) => d.signalId);
