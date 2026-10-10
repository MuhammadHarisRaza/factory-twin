/**
 * Factory Copilot — answers are assembled from the shared simulation state, split into observed /
 * inferred / estimate / method, carry their assumptions, cite the event they investigate and never
 * claim a model or live data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { M2_PER_TILE, REASON_BY_CODE, TARGET } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { activateScenario, advance, createSim, DEFAULT_SEED, type SimState } from '../../sim/engine';
import { activeEvents, openEvents } from '../../sim/events';
import { DEFAULT_FINANCE } from '../../sim/finance';
import { assess } from '../../sim/health';
import { bottleneck, capacityBreakdown, clippedDuration, downtimePareto, lineMetrics, resolvePeriod } from '../../sim/metrics';
import { EVENT_QUESTIONS, QUESTION_GROUPS, SUGGESTED_QUESTIONS, ask, eventQuestionsFor, type CopilotAnswer } from '../copilot';

const T = DEFAULT_TARIFFS;
const int = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (f: number) => `${(f * 100).toFixed(1)} %`;
const all = (a: CopilotAnswer) => [...a.text, ...a.facts.map((f) => `${f.label} ${f.value}`)].join('\n');
const ofKind = (a: CopilotAnswer, kind: string) => (a.sections ?? []).filter((x) => x.kind === kind).map((x) => x.text);

let plain: SimState;
/** Kiln infeed conveyor stopped 45 min ago and still stopped: a root event with active consequences. */
let conveyor: SimState;
/** Hydraulic press 1 stopped for 200 min (review finding #1). */
let pressStop: SimState;
/** Sorting at 30 % capacity for 90 min — the kiln is blocked (review finding #2). */
let sortBn: SimState;
/** Kiln stopped at 13:00, asked at 14:30 in shift B (review finding #4); yard congestion from 13:30 under a 40-min turnaround rule. */
let kilnStop: SimState;

/** Every answer produced in these tests, for the cross-cutting honesty checks. */
const answers: CopilotAnswer[] = [];
const q = (s: SimState, question: string, ctx?: Parameters<typeof ask>[3]) => {
  const a = ask(s, question, T, ctx);
  answers.push(a);
  return a;
};

beforeAll(() => {
  plain = createSim(DEFAULT_SEED);
  conveyor = createSim(DEFAULT_SEED);
  activateScenario(conveyor, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: null, label: 'Kiln infeed conveyor stop' });
  advance(conveyor, conveyor.minute + 45);
  pressStop = createSim(DEFAULT_SEED);
  activateScenario(pressStop, { kind: 'machine-stop', equipmentId: 'E-PRS1', end: null, label: 'Press 1 stop' });
  advance(pressStop, pressStop.minute + 200);
  sortBn = createSim(DEFAULT_SEED);
  activateScenario(sortBn, { kind: 'bottleneck', stage: 'SORT', factor: 0.3, end: null, label: 'Sorting at 30 %' });
  advance(sortBn, sortBn.minute + 90);
  kilnStop = createSim(DEFAULT_SEED);
  kilnStop.rules.turnaroundMax = 40;
  advance(kilnStop, kilnStop.minute + 150); // 13:00
  activateScenario(kilnStop, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln breakdown' });
  advance(kilnStop, kilnStop.minute + 30);
  activateScenario(kilnStop, { kind: 'yard-congestion', count: 10, end: null, label: 'Yard congestion · 10 trucks' });
  advance(kilnStop, kilnStop.minute + 60); // 14:30, shift B
}, 120_000);

describe('Suggested questions', () => {
  it('cover the four use cases with about ten questions', () => {
    expect(SUGGESTED_QUESTIONS.length).toBeGreaterThanOrEqual(8);
    expect(SUGGESTED_QUESTIONS.length).toBeLessThanOrEqual(12);
    expect(QUESTION_GROUPS.map((g) => g.id)).toEqual(expect.arrayContaining(['monitoring', 'oee', 'quality', 'vehicles']));
  });

  it('every suggested question is answered from the state, in sections', () => {
    for (const s of [plain, conveyor, kilnStop]) {
      for (const question of SUGGESTED_QUESTIONS) {
        const a = q(s, question);
        expect(a.intent, question).not.toBe('help');
        expect(a.sections?.length, question).toBeGreaterThan(0);
        // text[] stays populated for older consumers: the sections, in order.
        expect(a.text).toEqual(a.sections!.map((x) => x.text));
        expect(ofKind(a, 'observed').length, question).toBeGreaterThan(0);
        expect(ofKind(a, 'method').length, question).toBeGreaterThan(0);
        expect(a.text.join(' ').length).toBeGreaterThan(80);
      }
    }
    expect(q(plain, 'How is press 2 doing?').intent).toBe('machine');
    expect(q(plain, 'hello').intent).toBe('help');
  });
});

describe('Numbers match the metrics', () => {
  it('OEE answer shows A × P × Q with the line metrics of the shift', () => {
    const lm = lineMetrics(plain, resolvePeriod('shift', plain.minute));
    const a = q(plain, 'What is the current OEE and how is it calculated?');
    expect(a.intent).toBe('oee');
    const fact = (l: string) => a.facts.find((f) => f.label === l)?.value;
    expect(fact('OEE')).toBe(pct(lm.oee.oee.value!));
    expect(fact('Planned time')).toBe(`${int(lm.constraint.totals.planned)} min`);
    expect(fact('Operating time')).toBe(`${int(lm.constraint.totals.operating)} min`);
    expect(a.text.join(' ')).toContain(`availability ${pct(lm.oee.availability.value!)} × performance ${pct(lm.oee.performance.value!)} × quality ${pct(lm.oee.quality.value!)}`);
    expect(ofKind(a, 'method').join(' ')).toMatch(/simplified demo OEE/i);
  });

  it('below-target and theoretical-output answers use lineMetrics and capacityBreakdown', () => {
    const p = resolvePeriod('today', conveyor.minute);
    const lm = lineMetrics(conveyor, p);
    const a = q(conveyor, "Why is today's production below target?");
    expect(a.facts.find((f) => f.label === 'Output')!.value).toBe(`${int(lm.output * M2_PER_TILE)} m²`);
    expect(a.facts.find((f) => f.label === 'OEE')!.value).toBe(pct(lm.oee.oee.value!));
    expect(a.text.join(' ')).toContain(`${int(TARGET.goodPerHour)} good tiles per hour`);

    const cap = capacityBreakdown(conveyor, resolvePeriod('shift', conveyor.minute));
    const c = q(conveyor, 'What prevents us from reaching theoretical output?');
    expect(c.facts.find((f) => f.label === 'Theoretical')!.value).toBe(`${int(cap.theoreticalM2)} m²`);
    // Losses are listed largest first.
    const listed = c.text.filter((t) => /^\d+\. /.test(t)).map((t) => Number(/: ([\d,]+) m²/.exec(t)![1].replace(/,/g, '')));
    expect(listed.length).toBe(cap.losses.length);
    expect([...listed].sort((x, y) => y - x)).toEqual(listed);
  });

  it('greatest downtime loss uses minutes clipped to the period', () => {
    const p = resolvePeriod('shift', conveyor.minute);
    const a = q(conveyor, 'Which machine has the greatest downtime loss?');
    expect(a.intent).toBe('machine-downtime');
    const top = a.facts[0].label.split(' · ')[0];
    const minutes = conveyor.downtime
      .filter(
        (d) =>
          d.equipmentId === top &&
          d.category !== 'Planned' &&
          d.category !== 'Starved' &&
          d.category !== 'Blocked' &&
          !REASON_BY_CODE[d.reasonCode]?.planned &&
          d.start < p.to &&
          (d.end ?? conveyor.minute) > p.from,
      )
      .reduce((x, d) => x + clippedDuration(d, p, conveyor.minute), 0);
    expect(a.facts[0].value.startsWith(`${int(minutes)} min`)).toBe(true);
  });

  it('turnaround answer uses the rule threshold and the turnaround events', () => {
    const a = q(kilnStop, 'Which trucks exceeded their turnaround threshold?');
    expect(a.intent).toBe('turnaround');
    expect(a.text[0]).toContain(`Threshold: ${kilnStop.rules.turnaroundMax} min`);
    const evs = kilnStop.events.filter((e) => e.type === 'turnaround-exceeded' && e.end == null);
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs.slice(0, 2)) expect(all(a)).toContain(e.id);
    // Every truck listed as on site above the threshold really is.
    for (const v of kilnStop.logistics.active.map((id) => kilnStop.logistics.vehicles[id])) {
      const t = v as { label?: string; visit?: { gateIn: number; gateOut: number | null } };
      if (!t.visit || t.visit.gateIn > kilnStop.minute || !t.label) continue;
      if (kilnStop.minute - t.visit.gateIn >= kilnStop.rules.turnaroundMax) expect(a.text.join(' ')).toContain(t.label);
    }
  });
});

describe('Investigation of one event', () => {
  const pickEvents = (s: SimState) => {
    const open = openEvents(s);
    const pick = (f: (e: OpEvent) => boolean) => open.find(f);
    return [pick((e) => e.category === 'production' && !e.consequenceOf), pick((e) => e.category === 'equipment'), pick((e) => !!e.consequenceOf)].filter(
      (e): e is OpEvent => !!e,
    );
  };

  it('answers in the event context cite the event id', () => {
    const evs = pickEvents(conveyor);
    expect(evs.length).toBeGreaterThanOrEqual(2);
    for (const ev of evs) {
      for (const question of EVENT_QUESTIONS) {
        const a = q(conveyor, question, { eventId: ev.id, finance: DEFAULT_FINANCE });
        expect(a.intent.startsWith('event-'), `${question} ${ev.id}`).toBe(true);
        expect(a.eventId).toBe(ev.id);
        expect(a.text[0]).toContain(ev.id);
        expect(a.links.some((l) => l.kind === 'event' && l.id === ev.id)).toBe(true);
      }
      // The same questions with the id typed work without a stored context.
      for (const question of eventQuestionsFor(ev.id)) expect(q(conveyor, question).eventId).toBe(ev.id);
    }
  });

  it('separates facts from causes, and causes carry a confidence', () => {
    for (const ev of pickEvents(conveyor)) {
      const a = q(conveyor, 'Why did it happen?', { eventId: ev.id });
      expect(a.intent).toBe('event-why');
      expect(ofKind(a, 'observed').length).toBeGreaterThan(0);
      for (const t of ofKind(a, 'inferred')) expect(t).toMatch(/^(Confirmed|Likely|Possible): /);
    }
  });

  it('plant-wide questions stay plant-wide while an event is in context', () => {
    const ev = pickEvents(conveyor)[0];
    expect(q(conveyor, 'What is the current OEE and how is it calculated?', { eventId: ev.id }).intent).toBe('oee');
    expect(q(conveyor, 'Which conveyor stopped most recently?', { eventId: ev.id }).intent).toBe('conveyor-stop');
    // Naming another machine asks about that machine.
    const other = ev.asset.equipmentId === 'E-PRS2' ? 'press 1' : 'press 2';
    expect(q(conveyor, `How is ${other} doing?`, { eventId: ev.id }).intent).toBe('machine');
  });

  it('the defect report answer links the quality event it describes', () => {
    const a = q(plain, 'Show the report and evidence for the latest defect.');
    expect(a.intent).toBe('defect-report');
    if (a.eventId) expect(a.links[0]).toMatchObject({ kind: 'event', id: a.eventId });
    const quality = plain.events.filter((e) => e.category === 'quality');
    if (quality.length > 1) {
      const older = quality[0];
      const b = q(plain, 'Show the report and evidence for this defect.', { eventId: older.id });
      expect(b.eventId).toBe(older.id);
    }
  });

  it('the supervisor answer ranks open events by severity, kiln impact and recency', () => {
    const a = q(conveyor, 'What should the supervisor investigate first?');
    const open = openEvents(conveyor);
    const ids = new Set(open.map((e) => e.id));
    const rank = { info: 0, warning: 1, serious: 2, critical: 3 } as const;
    const expected = open
      .filter((e) => !e.consequenceOf || !ids.has(e.consequenceOf))
      .sort((x, y) => rank[y.severity] - rank[x.severity] || y.acc.constraintMin - x.acc.constraintMin || y.lastUpdate - x.lastUpdate)[0];
    expect(a.eventId).toBe(expected.id);
    expect(ofKind(a, 'inferred')[0]).toContain(expected.id);
  });
});

describe('Estimates', () => {
  it('the cost of the current loss never adds consequence events', () => {
    const cons = activeEvents(conveyor).filter((e) => e.consequenceOf);
    expect(cons.length).toBeGreaterThan(0);
    const a = q(conveyor, 'What is the estimated cost of the current production loss?');
    expect(a.intent).toBe('loss-cost');
    const est = ofKind(a, 'estimate');
    for (const c of cons) expect(est.some((t) => t.startsWith(`${c.id} ·`))).toBe(false);
    expect(est.some((t) => t.startsWith('Assumptions:'))).toBe(true);
    expect(ofKind(a, 'observed').join(' ')).toContain(`${cons[0].id} → ${cons[0].consequenceOf}`);
  });

  it('uses the financial assumptions passed in the context', () => {
    const base = q(conveyor, 'What is the estimated cost of the current production loss?');
    const dear = q(conveyor, 'What is the estimated cost of the current production loss?', { finance: { ...DEFAULT_FINANCE, sellingPricePerM2: 12 } });
    expect(ofKind(dear, 'estimate').join(' ')).toContain('USD 12.00/m²');
    expect(ofKind(dear, 'estimate')[0]).not.toBe(ofKind(base, 'estimate')[0]);
  });

  it('every answer with a money figure lists its assumptions', () => {
    expect(answers.length).toBeGreaterThan(40);
    for (const a of answers) {
      const est = ofKind(a, 'estimate');
      if (est.some((t) => /USD\s?\d/.test(t))) expect(est.some((t) => t.startsWith('Assumptions:')), `${a.intent}: ${est.join(' | ')}`).toBe(true);
      // Money figures only ever appear in the estimate section.
      for (const kind of ['observed', 'inferred']) for (const t of ofKind(a, kind)) expect(t, `${a.intent} ${kind}`).not.toMatch(/≈ USD\s?\d/);
    }
  });
});

describe('Honesty', () => {
  it('no answer claims a model or live data', () => {
    for (const a of answers) {
      const text = all(a)
        .replace(/\bno (?:[a-z-]+ )?(?:language|vision|trained) model\b/gi, '')
        .replace(/rendered live, not recorded/gi, '');
      expect(text, a.intent).not.toMatch(/\b(?:language|vision|AI|trained|machine[- ]learning|neural|predictive) model\b/i);
      expect(text, a.intent).not.toMatch(/\blive\b/i);
      expect(text, a.intent).not.toMatch(/real[- ]time|telemetry|\bLLM\b|\bGPT\b/i);
    }
    expect(q(plain, 'hello').text.join(' ')).toMatch(/rule-based/i);
    expect(q(plain, 'hello').text.join(' ')).toMatch(/no language model/i);
  });
});

describe('Review findings', () => {
  it('#1 an offline asset is not ranked most at risk and is not shown as 0/100', () => {
    expect(assess(pressStop, 'E-PRS1').level).toBe('offline');
    const a = q(pressStop, 'Which machine is most at risk?');
    expect(a.intent).toBe('health');
    expect(a.text[0]).not.toMatch(/E-PRS1[^.]*0\/100/);
    expect(a.facts.some((f) => f.value.startsWith('0/100'))).toBe(false);
    const f = a.facts.find((x) => x.label === 'E-PRS1');
    if (f) expect(f.value).toBe('not running, not assessed');
  });

  it('#2 the kiln answer says the kiln is blocked when the bottleneck is downstream', () => {
    const bn = bottleneck(sortBn);
    expect(bn.cause).toBe('blocking');
    const a = q(sortBn, 'How is the kiln affecting production?');
    expect(a.intent).toBe('kiln');
    const t = a.text.join(' ');
    expect(t).toContain('so the kiln is blocked');
    expect(t).not.toContain('starving it');
  });

  it('#4 the largest-downtime answer credits a machine with its minutes inside the period only', () => {
    const p = resolvePeriod('shift', kilnStop.minute);
    expect(p.label).toMatch(/Shift B/);
    const top = downtimePareto(kilnStop, p)[0];
    const a = q(kilnStop, 'What is the largest downtime loss?');
    expect(a.intent).toBe('largest-downtime');
    const m = /Most of it was on ([A-Z0-9-]+) \([^,]+, ([\d,]+) min in the period\)/.exec(a.text.join(' '));
    expect(m).not.toBeNull();
    expect(Number(m![2].replace(/,/g, ''))).toBeLessThanOrEqual(Math.round(top.minutes));
  });
});
