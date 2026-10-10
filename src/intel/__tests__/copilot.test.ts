/**
 * Factory Copilot — answers are assembled from the shared simulation state, split into observed /
 * inferred / estimate / method, carry their assumptions, cite the event they investigate and never
 * claim a model or live data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { M2_PER_TILE, REASON_BY_CODE, TARGET } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { activateScenario, advance, createSim, DEFAULT_SEED, minuteAt, type SimState } from '../../sim/engine';
import { activeEvents, openEvents } from '../../sim/events';
import { DEFAULT_FINANCE, lostOutputValue } from '../../sim/finance';
import { assess } from '../../sim/health';
import { bottleneck, capacityBreakdown, clippedDuration, downtimePareto, lineMetrics, resolvePeriod } from '../../sim/metrics';
import { EVENT_QUESTIONS, QUESTION_GROUPS, SUGGESTED_QUESTIONS, ask, eventQuestionsFor, type CopilotAnswer } from '../copilot';
import { buildEventReport, fpyBefore } from '../report';

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
/** Kiln-origin quality deterioration for 2 h: planarity events at the laser gauge (phase-2 review finding #14). */
let gaugeQ: SimState;
/** Press quality ×8 for 25 h (24 h FPY well below 97.5 %), then the kiln stopped 30 min (phase-2 review finding #29). */
let lowFpy: SimState;
/** Kiln at 60 % rate for 40 min: a below-rate event on the line constraint (phase-2 review finding #29). */
let kilnSlow: SimState;

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
  gaugeQ = createSim(DEFAULT_SEED);
  activateScenario(gaugeQ, { kind: 'quality-deterioration', stage: 'KILN', factor: 6, end: null, label: 'Kiln quality deterioration' });
  advance(gaugeQ, gaugeQ.minute + 120);
  lowFpy = createSim(DEFAULT_SEED);
  activateScenario(lowFpy, { kind: 'quality-deterioration', stage: 'PRESS', factor: 8, end: null, label: 'Press quality deterioration' });
  advance(lowFpy, lowFpy.minute + 25 * 60);
  activateScenario(lowFpy, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln breakdown' });
  advance(lowFpy, lowFpy.minute + 30);
  kilnSlow = createSim(DEFAULT_SEED);
  activateScenario(kilnSlow, { kind: 'reduced-rate', equipmentId: 'H-KILN', factor: 0.6, end: null, label: 'Kiln at 60 %' });
  advance(kilnSlow, kilnSlow.minute + 40);
}, 180_000);

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
    expect(a.text.join(' ')).toContain(`${int(TARGET.goodPerHour)} good tiles per planned hour`);

    const cap = capacityBreakdown(conveyor, resolvePeriod('shift', conveyor.minute));
    const c = q(conveyor, 'What prevents us from reaching theoretical output?');
    expect(c.facts.find((f) => f.label === 'Theoretical')!.value).toBe(`${int(cap.theoreticalM2)} m²`);
    // Losses are listed largest first.
    const listed = c.text.filter((t) => /^\d+\. /.test(t)).map((t) => Number(/: ([\d,]+) m²/.exec(t)![1].replace(/,/g, '')));
    expect(listed.length).toBe(cap.losses.filter((l) => l.kind !== 'transit').length);
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

describe('Review findings, phase 2', () => {
  const kilnHeld = (s: SimState, from: number, to: number) => {
    let n = 0;
    for (let m = from; m < to; m++) {
      const x = minuteAt(s, 'H-KILN', m)!;
      if (x.state === 'down' || x.state === 'starved' || x.state === 'blocked') n++;
    }
    return n;
  };

  it('#13 a kiln attribution to a conveyor stop is inferred with a confidence, never presented as observed', () => {
    const ev = conveyor.events.find((e) => e.dedupeKey === 'stop:CV-KIN' && e.end == null)!;
    expect(ev.acc.constraintMin).toBeGreaterThan(0);
    const d = conveyor.downtime.find((x) => x.equipmentId === 'CV-KIN' && x.end == null)!;

    const a = q(conveyor, 'Which conveyor stopped most recently?');
    expect(a.eventId).toBe(ev.id);
    const obs = ofKind(a, 'observed').join(' ');
    expect(obs).not.toMatch(/because of it/);
    expect(obs).not.toMatch(/held (the kiln|it) up/);
    // Observed: what the kiln's own state log shows while the conveyor was stopped.
    expect(obs).toContain(`the kiln (line constraint) was down, starved or blocked for ${int(kilnHeld(conveyor, d.start, conveyor.minute))} min so far (kiln state log)`);
    // Inferred: the event engine's attribution, with its confidence.
    expect(ofKind(a, 'inferred')).toContainEqual(expect.stringMatching(new RegExp(`^Likely: ${ev.id} held the kiln \\(line constraint\\) up ${int(ev.acc.constraintMin)} min so far — .*inferred`)));

    // Same rule in the plant-wide answers that cite the attribution.
    const md = q(conveyor, 'Which machine has the greatest downtime loss?');
    expect(md.intent).toBe('machine-downtime');
    expect(ofKind(md, 'observed').join(' ')).not.toMatch(/kiln held up|held the kiln up/);
    expect(ofKind(md, 'inferred').filter((x) => x.includes('CV-KIN') && x.includes(`${int(ev.acc.constraintMin)} min`))).toEqual([expect.stringMatching(/^Likely: /)]);
    const first = q(conveyor, 'What should the supervisor investigate first?');
    const line = ofKind(first, 'observed').find((x) => x.includes(`${ev.id} ·`))!;
    expect(line).toContain(`${int(ev.acc.constraintMin)} min of kiln hold-up attributed (inferred)`);
    expect(line).not.toContain('kiln held up');

    // The event's own impact answer: the kiln minutes and the line output derived from them move to Inferred.
    const imp = q(conveyor, `What is the impact of ${ev.id}?`);
    expect(ofKind(imp, 'observed').join(' ')).not.toMatch(/held up or slowed by this event|Line good output lost/);
    const inferred = ofKind(imp, 'inferred');
    expect(inferred.some((x) => x.startsWith(`Likely: Kiln (line constraint) held up or slowed by this event: ${int(ev.acc.constraintMin)} min`))).toBe(true);
    expect(inferred.some((x) => x.startsWith('Likely: Line good output lost'))).toBe(true);
  });

  it('#13 the kiln stop event keeps its own kiln minutes under Observed', () => {
    const ev = kilnStop.events.find((e) => e.dedupeKey === 'stop:H-KILN' && e.end == null)!;
    const imp = q(kilnStop, `What is the impact of ${ev.id}?`);
    expect(ofKind(imp, 'observed').some((x) => x.startsWith(`Kiln (line constraint) held up or slowed by this event: ${int(ev.acc.constraintMin)} min`))).toBe(true);
    expect(ofKind(imp, 'inferred').some((x) => /held up or slowed/.test(x))).toBe(false);
  });

  it('#14 laser-gauge records are measurements: no classification confidence is shown for them', () => {
    const a = q(gaugeQ, 'Show the report and evidence for the latest planarity defect');
    expect(a.intent).toBe('defect-report');
    const ev = gaugeQ.events.find((e) => e.id === a.eventId)!;
    expect(ev.refs.defect).toBe('planarity');
    expect(ev.asset.stationId).toBe('ST-GAUGE');
    const obs = ofKind(a, 'observed').join(' ');
    expect(obs).toMatch(/Inspection evidence: INS-\d+ planarity deviation .*simulated gauge measurement: /);
    expect(obs).not.toMatch(/confidence/i);
    const method = ofKind(a, 'method').join(' ');
    expect(method).toContain('Gauge records are simulated laser measurements checked against a tolerance — not classifications');
    expect(method).not.toMatch(/simulated classification/);
    // The evidence answer of the same event says the same.
    const evd = q(gaugeQ, `What evidence is available for ${ev.id}?`);
    expect(ofKind(evd, 'method').join(' ')).toContain('Gauge records are simulated laser measurements');
    expect(ofKind(evd, 'method').join(' ')).not.toMatch(/simulated classification/);
    // A reject record without a quality event (fallback answer) is described the same way.
    const dim = q(gaugeQ, 'Show the report and evidence for the latest dimensional defect');
    if (!dim.eventId && /Latest reject record/.test(dim.text.join(' '))) {
      expect(dim.text.join(' ')).toMatch(/simulated gauge measurement/);
      expect(dim.text.join(' ')).not.toMatch(/simulated confidence/);
    }
  });

  it('#14 tunnel (vision) records keep their simulated confidence', () => {
    const a = q(gaugeQ, 'Show the report and evidence for the latest chip defect');
    expect(a.intent).toBe('defect-report');
    expect(gaugeQ.events.find((e) => e.id === a.eventId)?.asset.stationId).toBe('ST-VIS');
    if (/Inspection evidence: INS-/.test(a.text.join(' '))) expect(ofKind(a, 'observed').join(' ')).toMatch(/simulated confidence \d+ %/);
    expect(ofKind(a, 'method').join(' ')).toMatch(/simulated classification, no vision model; confidence values are simulated/);
  });

  it('#29 the per-minute estimate of a kiln stop uses the event report FPY, not 97.5 %', () => {
    const ev = lowFpy.events.find((e) => e.dedupeKey === 'stop:H-KILN' && e.end == null)!;
    const fpy = fpyBefore(lowFpy, ev.start);
    expect(fpy).toBeLessThan(0.96);
    const rep = buildEventReport(lowFpy, ev.id)!;
    const repFpy = /first-pass yield ([\d.]+ %)/.exec(rep.impact.rows.find((r) => r.label === 'Line good output lost')!.basis)![1];
    const a = q(lowFpy, `What should we do about ${ev.id}?`);
    expect(a.intent).toBe('event-action');
    const est = ofKind(a, 'estimate')[0];
    expect(est).toMatch(/^Every further minute at the current kiln rate ≈ USD /);
    expect(est).toContain(`× ${repFpy} first-pass yield`);
    expect(est).not.toContain('97.5 %');
    const now = minuteAt(lowFpy, 'H-KILN', lowFpy.minute - 1)!;
    expect(now.state).toBe('down');
    const v = lostOutputValue(DEFAULT_FINANCE, Math.max(0, ev.acc.kilnTypicalRate - now.rate) * fpy);
    expect(est).toContain(`≈ USD ${v.amount.toFixed(2)} of contribution`);
  });

  it('#29 a below-rate kiln event is valued at its actual shortfall, not the full typical rate', () => {
    const ev = kilnSlow.events.find((e) => e.dedupeKey === 'rate:H-KILN' && e.end == null)!;
    expect(ev.acc.constraintMin).toBeGreaterThan(0);
    const now = minuteAt(kilnSlow, 'H-KILN', kilnSlow.minute - 1)!;
    expect(now.rate).toBeGreaterThan(0);
    const fpy = fpyBefore(kilnSlow, ev.start);
    const a = q(kilnSlow, `What should we do about ${ev.id}?`);
    const est = ofKind(a, 'estimate')[0];
    const shortfall = lostOutputValue(DEFAULT_FINANCE, (ev.acc.kilnTypicalRate - now.rate) * fpy);
    const full = lostOutputValue(DEFAULT_FINANCE, ev.acc.kilnTypicalRate * fpy);
    expect(est).toContain(`≈ USD ${shortfall.amount.toFixed(2)} of contribution`);
    expect(est).not.toContain(`USD ${full.amount.toFixed(2)}`);
    expect(est).toContain(`− ${int(now.rate * 60)} tiles/h now`);
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
    // Phase-2 review #13 / #14: attributions are never observed facts; a missing confidence is never printed as one.
    for (const a of answers) {
      for (const x of ofKind(a, 'observed')) expect(x, a.intent).not.toMatch(/because of it/);
      expect(a.text.join(' '), a.intent).not.toMatch(/simulated confidence —/);
    }
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
