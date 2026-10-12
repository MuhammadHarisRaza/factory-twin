/**
 * Review round 3 — the copilot agrees with the rest of the product:
 *  - #4 / #16: constraint statements are the Overview's graded claim (constraintClaim / constraintPhrase):
 *    "currently constraining output" only with evidence, otherwise the modeled design constraint, and
 *    nothing beyond that while the kiln feed is stale;
 *  - #17: the rising defect category is the one shared rule (risingDefects), so the copilot, the
 *    Quality & Defects summary and the insights name the same category or all say none is rising;
 *  - #19: the kiln / machine answers use the operational state (a stale feed is "state unknown", never
 *    "running") and print earlier-day times with their date.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFECTS, DEFECT_ORDER } from '../../model/plant';
import type { DefectCategory, StageId } from '../../model/types';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { activateScenario, advance, createSim, DEFAULT_SEED, type SimState } from '../../sim/engine';
import { OPERATIONAL_STATE_LABEL, resolvePeriod, risingDefects } from '../../sim/metrics';
import { formatClock, formatDateTime } from '../../sim/time';
import { qualitySummary, risingDefect, summaryText } from '../../pages/quality/investigate';
import { ask, type CopilotAnswer, type CopilotContext } from '../copilot';
import { insights } from '../insights';
import { constraintClaim, constraintPhrase, executiveSummary } from '../summary';

const T = DEFAULT_TARIFFS;
const ofKind = (a: CopilotAnswer, kind: string) => a.sections.filter((x) => x.kind === kind).map((x) => x.text);
const q = (s: SimState, question: string, ctx?: CopilotContext) => ask(s, question, T, ctx);
const sentence = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
const when = (s: SimState, t: number) => (Math.floor(t / 1440) === Math.floor(s.minute / 1440) ? formatClock(t) : formatDateTime(t));
const CONSTRAINT_Q = 'Which stage is currently constraining output?';
/** A shorter pre-roll (2 days + 4.5 h: enough history for every 24 h reference) keeps the scenario states cheap. */
const SHORT = 2 * 1440 + 4 * 60 + 30;
const DEFECTS_Q = 'Which defect category is increasing?';

let plain: SimState;
/** The Overview test's seeded state (finding #4's evidence). */
let overview: SimState;
/** Sorting at 30 % for 90 min: the kiln is blocked, traced downstream to sorting. */
let sortBn: SimState;
/** Kiln stopped for 40 min. */
let kilnStop: SimState;
/** Kiln data feed lost 30 min ago: its state is unknown. */
let kilnStale: SimState;

beforeAll(() => {
  plain = createSim(DEFAULT_SEED);
  overview = createSim(81, 2 * 1440 + 4 * 60 + 20);
  sortBn = createSim(DEFAULT_SEED, SHORT);
  activateScenario(sortBn, { kind: 'bottleneck', stage: 'SORT', factor: 0.3, end: null, label: 'Sorting at 30 %' });
  advance(sortBn, sortBn.minute + 90);
  kilnStop = createSim(DEFAULT_SEED, SHORT);
  activateScenario(kilnStop, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln breakdown' });
  advance(kilnStop, kilnStop.minute + 40);
  kilnStale = createSim(DEFAULT_SEED, SHORT);
  activateScenario(kilnStale, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed lost' });
  advance(kilnStale, kilnStale.minute + 30);
}, 180_000);

describe('#4 / #16 — constraint statements follow the Overview claim', () => {
  it('a kiln that nobody held up is the modeled design constraint, not "currently constraining" (confirmed vs inferred)', () => {
    for (const s of [plain, overview]) {
      const claim = constraintClaim(s);
      expect(claim.kind).toBe('design');
      const a = q(s, CONSTRAINT_Q);
      const confirmed = ofKind(a, 'confirmed');
      expect(confirmed[0]).toBe(sentence(constraintPhrase(claim)));
      expect(confirmed[0]).toMatch(/is the modeled design constraint — no other stage held it up in the last 2 h/);
      // The Overview summary says the same thing.
      expect(executiveSummary(s).text).toContain(constraintPhrase(claim));
      // The trace shares stay as supporting evidence.
      expect(confirmed[1]).toMatch(/^Bottleneck trace over the last 120 min \(supporting evidence\): Firing \(H-KILN\) working \d+ %, starved \d+ %, blocked \d+ %, down \d+ %/);
      for (const t of confirmed) expect(t).not.toMatch(/currently constraining|stage constraining output is|is this constraint/);
      // "Limits the line as designed" is an inference, never a confirmed fact.
      expect(ofKind(a, 'inferred').join(' ')).toMatch(/^Likely: the kiln limits the line as designed/);
      // The kiln, stage and below-target answers make no stronger claim either.
      for (const x of [q(s, 'How is the kiln doing?'), q(s, 'How is this stage doing?', { stageId: 'KILN' }), q(s, 'Why is production below target?')])
        for (const t of [...ofKind(x, 'confirmed'), ...ofKind(x, 'inferred')]) expect(t, x.intent).not.toMatch(/currently constraining|currently the stage constraining/);
      expect(ofKind(q(s, 'How is this stage doing?', { stageId: 'KILN' }), 'confirmed')).toContain(sentence(constraintPhrase(claim)));
      // The constraint insight says "design constraint (modeled)", never a bare "Constraint" / "Bottleneck".
      const ins = insights(s).find((i) => i.kind === 'bottleneck')!;
      expect(ins.title).toBe(`Design constraint (modeled): ${claim.name}`);
      expect(ins.severity).toBe('info');
    }
  });

  it('a traced constraint is "currently constraining output", with the evidence', () => {
    const claim = constraintClaim(sortBn);
    expect(claim.kind).toBe('blocking');
    expect(claim.constraining).toBe(true);
    const a = q(sortBn, CONSTRAINT_Q);
    expect(ofKind(a, 'confirmed')[0]).toBe(sentence(constraintPhrase(claim)));
    expect(ofKind(a, 'confirmed')[0]).toMatch(/^Sorting & inspection is currently constraining output — the kiln was blocked \d+ % of the last 2 h/);
    expect(insights(sortBn).find((i) => i.kind === 'bottleneck')!.title).toBe('Bottleneck shifted to Sorting & inspection');
  });

  it('the kiln stopped now is constraining output at the kiln, whatever the earlier trace says', () => {
    const claim = constraintClaim(kilnStop);
    expect(claim.kind).toBe('kiln-stopped');
    const a = q(kilnStop, CONSTRAINT_Q);
    expect(ofKind(a, 'confirmed')[0]).toMatch(/^Kiln firing & cooling is currently constraining output — the kiln has been (stopped|in fault) since \d\d:\d\d/);
    expect(a.links.some((l) => l.kind === 'stage' && l.id === 'KILN')).toBe(true);
  });

  it('with the kiln feed stale nothing beyond the design label is stated', () => {
    const claim = constraintClaim(kilnStale);
    expect(claim.kind).toBe('kiln-unknown');
    for (const question of [CONSTRAINT_Q, 'How is the kiln doing?', 'Why is production below target?']) {
      const a = q(kilnStale, question);
      for (const t of ofKind(a, 'confirmed')) expect(t, question).not.toMatch(/currently constraining|Bottleneck trace/);
      expect(ofKind(a, 'unknown').join(' '), question).toMatch(/Whether any stage is constraining output now cannot be established: the kiln data feed is stale since \d\d:\d\d/);
    }
    const a = q(kilnStale, CONSTRAINT_Q);
    expect(ofKind(a, 'confirmed')[0]).toBe('Kiln firing & cooling is the modeled design constraint; its data feed is stale, so its current state is unknown.');
    expect(a.facts.find((f) => f.label === 'Firing')!.value).toContain('not confirmed (feed stale)');
    expect(insights(kilnStale).find((i) => i.kind === 'bottleneck')!.title).toBe('Design constraint (modeled): Kiln firing & cooling · state unknown');
  });
});

describe('#17 — one rising-defect rule for the copilot, the Quality summary and the insights', () => {
  /** The category an answer names as rising the most, or null when it says none is rising. */
  const copilotRising = (a: CopilotAnswer): DefectCategory | null => {
    const head = ofKind(a, 'confirmed')[0];
    if (/^No defect category is rising/.test(head) || /^Too few tiles/.test(head)) return null;
    const d = DEFECT_ORDER.find((x) => head.startsWith(`${DEFECTS[x].label} is increasing the most`));
    expect(d, head).toBeDefined();
    return d!;
  };
  it('names the same category (or none) in every deterioration state, whatever the period that ends now', () => {
    const cases: [StageId, number][] = [
      ['GLAZE', 2],
      ['KILN', 4],
      ['PRESS', 4],
    ];
    let named = 0;
    let none = 0;
    for (const [stage, factor] of cases) {
      const s = createSim(DEFAULT_SEED, SHORT);
      activateScenario(s, { kind: 'quality-deterioration', stage, factor, end: null, label: `${stage} ×${factor}` });
      for (let step = 0; step < 6; step++) {
        advance(s, s.minute + 25);
        // The Quality & Defects summary (last 24 hours) …
        const summary = qualitySummary(s, resolvePeriod('24h', s.minute));
        const page = summary.rising?.defect ?? null;
        // … gives the same answer for every period that ends now …
        expect(risingDefect(s, resolvePeriod('shift', s.minute))?.defect ?? null).toBe(page);
        // … and the copilot, asked from either period, names the same category.
        for (const period of ['24h', 'shift'] as const) expect(copilotRising(q(s, DEFECTS_Q, { period })), `${stage} ×${factor} @${s.minute} ${period}`).toBe(page);
        const text = summaryText(summary, 'Last 24 hours');
        const qi = insights(s).find((i) => i.kind === 'quality');
        if (page) {
          named++;
          expect(text).toContain(`${DEFECTS[page].label} is rising`);
          // The quality insight (when there is one) names the same category as rising.
          if (qi) expect(qi.title.toLowerCase()).toContain(`${DEFECTS[page].label.toLowerCase()} rising`);
        } else {
          none++;
          expect(text).toMatch(/No defect category is rising|Too few tiles were inspected/);
          if (qi) expect(qi.title).not.toMatch(/rising/);
        }
      }
    }
    // Both outcomes occur in these states (the check is not vacuous).
    expect(named).toBeGreaterThan(0);
    expect(none).toBeGreaterThan(0);
  }, 240_000);

  it('a focused question uses the same rule, and the method names it', () => {
    const s = createSim(DEFAULT_SEED, SHORT);
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze ×5' });
    advance(s, s.minute + 150);
    const r = risingDefects(s, resolvePeriod('shift', s.minute));
    expect(r.rising.length).toBeGreaterThan(0);
    const a = q(s, DEFECTS_Q);
    expect(copilotRising(a)).toBe(r.rising[0].defect);
    expect(ofKind(a, 'method').join(' ')).toMatch(/One rising-defect rule, shared with the Quality & Defects summary/);
    expect(ofKind(a, 'method').join(' ')).toContain(`≥ ${s.rules.deteriorationRatio}× its 24 h rate`);
    // A category that is not rising says so, by the same rule.
    const calm = r.rows.find((x) => !x.rising)!;
    const f = q(s, `Is ${DEFECTS[calm.defect].label.toLowerCase()} increasing?`);
    expect(f.intent).toBe('defects');
    expect(ofKind(f, 'confirmed')[0]).toMatch(/not rising by the rule/);
  });
});

describe('#19 — operational state, stale feeds and dates', () => {
  it('a stale kiln feed is "state unknown", never "running", and the period figures are not confirmed', () => {
    const s = kilnStale;
    const f = s.feeds['H-KILN'];
    expect(f.status).toBe('stale');
    expect(s.machines['H-KILN'].state).toBe('running');
    for (const question of ['How is the kiln doing?', 'What is the state of the kiln?', 'Tell me about H-KILN']) {
      const a = q(s, question);
      expect(a.intent, question).toBe('kiln');
      const confirmed = ofKind(a, 'confirmed');
      expect(confirmed[0]).toBe(`The kiln: state unknown — data feed stale since ${formatClock(f.since)} (last value: running).`);
      expect(confirmed.join(' ')).not.toMatch(/kiln is running|availability|fired \d/);
      expect(ofKind(a, 'unknown').join(' ')).toMatch(/^Not confirmed by the feed: the kiln's simulated accounting says in .* it ran at availability/);
      expect(a.facts.find((x) => x.label === 'Kiln state')!.value).toBe(OPERATIONAL_STATE_LABEL.unknown);
      expect(a.facts.find((x) => x.label === 'Kiln availability')!.value).toContain('not confirmed');
    }
    // The machine answer for the same asset says the same.
    const m = q(s, 'How is this machine doing?', { equipmentId: 'H-KILN' });
    expect(m.intent).toBe('machine');
    expect(ofKind(m, 'confirmed')[0]).toMatch(/\(H-KILN\): state unknown — data feed stale since \d\d:\d\d \(last value: running\)\.$/);
    expect(m.facts.find((x) => x.label === 'State')!.value).toBe(OPERATIONAL_STATE_LABEL.unknown);
  });

  it('uses the operational state words, and prints a time from an earlier day with its date', () => {
    const s = plain;
    const k = s.machines['H-KILN'];
    // The kiln has been running since the previous plant day in the seeded state.
    expect(Math.floor(k.since / 1440)).toBeLessThan(Math.floor(s.minute / 1440));
    const a = q(s, 'How is the kiln doing?');
    expect(ofKind(a, 'confirmed')[0]).toMatch(new RegExp(`^The kiln is running \\(since ${when(s, k.since).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\.`));
    expect(ofKind(a, 'confirmed')[0]).toContain(formatDateTime(k.since));
    expect(a.facts.find((x) => x.label === 'Kiln state')!.value).toBe(OPERATIONAL_STATE_LABEL.running);
    // The machine answer prints its "since" the same way.
    const id = 'E-PRS2';
    const mm = q(s, 'How is press 2 doing?');
    expect(mm.intent).toBe('machine');
    expect(ofKind(mm, 'confirmed')[0]).toContain(` since ${when(s, s.machines[id].since)}`);
    // A stopped kiln reads "stopped" / "in fault", the words of the state label.
    const st = q(kilnStop, 'How is the kiln doing?');
    expect(ofKind(st, 'confirmed')[0]).toMatch(/^The kiln is (stopped|in fault) \(since /);
  });
});
