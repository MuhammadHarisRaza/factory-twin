/**
 * Copilot — every suggested question is answered from the shared simulation state with the same
 * numbers as the KPI cards (src/intel/kpis.ts, same period), in labelled sections (confirmed facts,
 * simulated events, inferred explanation, unverified hypotheses, recommended actions), says when
 * something cannot be established, links only into the seven workspaces, and never claims a model,
 * live data or energy figures.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { REASON_BY_CODE, TARGET } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { activateScenario, advance, createSim, DEFAULT_SEED, minuteAt, type SimState } from '../../sim/engine';
import { activeEvents, openEvents } from '../../sim/events';
import { DEFAULT_FINANCE, lostOutputValue } from '../../sim/finance';
import { assess } from '../../sim/health';
import { bottleneck, capacityBreakdown, clippedDuration, downtimePareto, lineMetrics, resolvePeriod, type PeriodKey } from '../../sim/metrics';
import {
  CORE_SECTIONS,
  EMPTY_SECTION_LINE,
  EVENT_QUESTIONS,
  INCIDENT_QUESTION,
  QUESTION_GROUPS,
  SECTION_ORDER,
  SUGGESTED_QUESTIONS,
  WORKSPACE_TITLE,
  ask,
  eventQuestionsFor,
  monitoredStage,
  type CopilotAnswer,
  type CopilotContext,
} from '../copilot';
import {
  activeIssuesKpi,
  attentionEvents,
  periodScope,
  avgDwellKpi,
  constraintDowntimeKpi,
  defectiveKpi,
  delayedTrucks,
  delayedVehiclesKpi,
  factoryOeeKpi,
  firstPassQualityKpi,
  goodOutputKpi,
  inspectedKpi,
  rejectRateKpi,
  targetAttainmentKpi,
  topDefectKpi,
  type KpiModel,
} from '../kpis';
import { buildEventReport, fpyBefore } from '../report';
import { constraintClaim, constraintPhrase } from '../summary';

const T = DEFAULT_TARIFFS;
const int = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (f: number) => `${(f * 100).toFixed(1)} %`;
const all = (a: CopilotAnswer) => [...a.text, ...a.facts.map((f) => `${f.label} ${f.value}`)].join('\n');
const ofKind = (a: CopilotAnswer, kind: string) => a.sections.filter((x) => x.kind === kind).map((x) => x.text);
const fact = (a: CopilotAnswer, label: string) => a.facts.find((f) => f.label === label)?.value;
/** A KPI card's value as the card shows it. */
const card = (k: KpiModel) => (k.unavailable ? 'Unavailable' : `${k.display}${k.unit ? ` ${k.unit}` : ''}`);
const EMPTY = new Set(Object.values(EMPTY_SECTION_LINE));

const Q = {
  belowTarget: 'Why is production below target?',
  constraint: 'Which stage is currently constraining output?',
  oeeLosses: 'What are the main OEE losses this shift?',
  defects: 'Which defect category is increasing?',
  vehicles: 'Which vehicles are delayed?',
  incident: INCIDENT_QUESTION,
  first: 'Which equipment should be investigated first?',
};

let plain: SimState;
/** Kiln infeed conveyor stopped 45 min ago and still stopped: a root event with active consequences. */
let conveyor: SimState;
/** Hydraulic press 1 stopped for 200 min. */
let pressStop: SimState;
/** Sorting at 30 % capacity for 90 min — the kiln is blocked. */
let sortBn: SimState;
/** Kiln stopped at 13:00, asked at 14:30 in shift B; yard congestion from 13:30 under a 40-min turnaround rule. */
let kilnStop: SimState;
/** Kiln-origin quality deterioration for 2 h: planarity events at the laser gauge. */
let gaugeQ: SimState;
/** Press quality ×8 for 25 h (24 h FPY well below 97.5 %), then the kiln stopped 30 min. */
let lowFpy: SimState;
/** Kiln at 60 % rate for 40 min: a below-rate event on the line constraint. */
let kilnSlow: SimState;

/** Every answer produced in these tests, for the cross-cutting checks. */
const answers: CopilotAnswer[] = [];
const q = (s: SimState, question: string, ctx?: CopilotContext) => {
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
  it('are exactly the seven operational questions, with no energy suggestion', () => {
    expect(SUGGESTED_QUESTIONS).toEqual([Q.belowTarget, Q.constraint, Q.oeeLosses, Q.defects, Q.vehicles, Q.incident, Q.first]);
    expect(QUESTION_GROUPS.map((g) => g.id)).toEqual(['production', 'quality', 'fleet', 'events']);
    expect(SUGGESTED_QUESTIONS.join(' ')).not.toMatch(/energy|kwh|gas|electric/i);
  });

  it('every suggested question is answered from the state, with the five labelled core sections', () => {
    const intents: Record<string, string> = {
      [Q.belowTarget]: 'below-target',
      [Q.constraint]: 'bottleneck',
      [Q.oeeLosses]: 'oee-losses',
      [Q.defects]: 'defects',
      [Q.vehicles]: 'delayed-vehicles',
      [Q.incident]: 'event-missing',
      [Q.first]: 'investigate-first',
    };
    for (const s of [plain, conveyor, kilnStop]) {
      for (const question of SUGGESTED_QUESTIONS) {
        const a = q(s, question);
        expect(a.intent, question).toBe(intents[question]);
        for (const k of CORE_SECTIONS) expect(ofKind(a, k).length, `${question}: ${k}`).toBeGreaterThan(0);
        // Sections come in display order; text[] repeats them for older consumers.
        const order = a.sections.map((x) => SECTION_ORDER.indexOf(x.kind));
        expect([...order].sort((x, y) => x - y)).toEqual(order);
        expect(a.text).toEqual(a.sections.map((x) => x.text));
        expect(ofKind(a, 'method').length, question).toBeGreaterThan(0);
      }
    }
    expect(q(plain, 'How is press 2 doing?').intent).toBe('machine');
    expect(q(plain, 'hello').intent).toBe('help');
  });
});

describe('Numbers equal the KPI cards (same functions, same period)', () => {
  const checkBelowTarget = (s: SimState, a: CopilotAnswer, key: PeriodKey) => {
    const p = resolvePeriod(key, s.minute);
    const lm = lineMetrics(s, p);
    // A running shift is scoped like the KPI cards ("… (to date)"); rolling windows keep their label.
    expect(a.periodLabel).toBe(key === 'shift' ? periodScope(s, p) : p.label);
    const good = goodOutputKpi(s, p, lm);
    const att = targetAttainmentKpi(s, p, lm);
    const oee = factoryOeeKpi(s, p, lm);
    const down = constraintDowntimeKpi(s, p, lm);
    expect(fact(a, 'Good output')).toBe(card(good));
    expect(fact(a, 'Target attainment')).toBe(card(att));
    expect(fact(a, 'OEE')).toBe(card(oee));
    expect(fact(a, 'Downtime affecting output')).toBe(card(down));
    const confirmed = ofKind(a, 'confirmed').join(' ');
    expect(confirmed).toContain(`good output ${card(good)}`);
    expect(confirmed).toContain(`target attainment ${card(att)}`);
    expect(confirmed).toContain(`Line OEE ${card(oee)}`);
    expect(confirmed).toContain(`Downtime affecting output: ${card(down)}`);
  };

  it('why production is below target — the shift by default, the workspace period from the context, a period named in the question', () => {
    checkBelowTarget(conveyor, q(conveyor, Q.belowTarget), 'shift');
    checkBelowTarget(kilnStop, q(kilnStop, Q.belowTarget), 'shift');
    checkBelowTarget(conveyor, q(conveyor, Q.belowTarget, { period: '7d' }), '7d');
    checkBelowTarget(conveyor, q(conveyor, "Why is today's production below target?", { period: '7d' }), 'today');
    const a = q(kilnStop, Q.belowTarget);
    expect(ofKind(a, 'confirmed')[0]).toMatch(/^Production is (not )?below target/);
    expect(a.text.join(' ')).toContain(`${int(TARGET.goodPerHour)} good tiles per planned hour`);
    // The kiln stop of the period is the kiln's own record: a confirmed fact, cited first.
    const stop = kilnStop.events.find((e) => e.dedupeKey === 'stop:H-KILN' && e.end == null)!;
    expect(a.eventId).toBe(stop.id);
    expect(ofKind(a, 'confirmed').some((x) => x.startsWith(`${stop.id} (`) && x.includes(`has held the kiln up ${int(stop.acc.constraintMin)} min in total`))).toBe(true);
    expect(ofKind(a, 'simulated').join(' ')).toContain('scenario-caused');
    expect(a.links.some((l) => l.kind === 'event' && l.id === stop.id)).toBe(true);
  });

  it('which stage is constraining output — the Overview constraint claim, with the bottleneck trace as evidence', () => {
    for (const s of [plain, sortBn, conveyor]) {
      const bn = bottleneck(s);
      const claim = constraintClaim(s);
      const a = q(s, Q.constraint);
      const phrase = constraintPhrase(claim);
      expect(ofKind(a, 'confirmed')[0]).toBe(`${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`);
      expect(a.links.some((l) => l.kind === 'stage' && l.id === monitoredStage(claim.processStage))).toBe(true);
      for (const r of bn.stages) expect(fact(a, r.name)).toContain(`${Math.round(r.workingShare * 100)} % working`);
    }
    expect(ofKind(q(sortBn, Q.constraint), 'inferred').join(' ')).toMatch(/so the kiln is blocked/);
    // The stage open in Production is placed against the constraint.
    expect(ofKind(q(sortBn, Q.constraint, { stageId: 'GLAZE' }), 'confirmed').join(' ')).toContain('is not the constraint right now');
  });

  it('the main OEE losses this shift — Line OEE, Downtime affecting output and Reject rate cards', () => {
    for (const s of [conveyor, kilnStop, kilnSlow]) {
      const p = resolvePeriod('shift', s.minute);
      const lm = lineMetrics(s, p);
      const a = q(s, Q.oeeLosses);
      expect(a.periodLabel).toBe(periodScope(s, p));
      expect(fact(a, 'Line OEE')).toBe(card(factoryOeeKpi(s, p, lm)));
      expect(fact(a, 'Downtime affecting output')).toBe(card(constraintDowntimeKpi(s, p, lm)));
      expect(fact(a, 'Reject rate')).toBe(card(rejectRateKpi(s, p)));
      expect(fact(a, 'Availability')).toBe(pct(lm.oee.availability.value!));
      const o = lm.oee;
      if ([o.availability, o.performance, o.quality].every((m) => m.status === 'ok'))
        expect(a.text.join(' ')).toContain(`availability ${pct(o.availability.value!)} × performance ${pct(o.performance.value!)} × quality ${pct(o.quality.value!)}`);
      // A factor the data cannot produce says why, never a made-up value.
      else expect(a.text.join(' ')).toMatch(/unavailable \(/);
      // Loss minutes are listed largest first.
      const listed = ofKind(a, 'confirmed')
        .filter((t) => /^\d+\. /.test(t))
        .map((t) => Number(/: ([\d,]+) min/.exec(t)![1].replace(/,/g, '')));
      expect(listed.length).toBeGreaterThan(0);
      expect([...listed].sort((x, y) => y - x)).toEqual(listed);
    }
    // A below-rate kiln event is a confirmed fact, not a hypothesis.
    const slow = q(kilnSlow, Q.oeeLosses);
    const ev = kilnSlow.events.find((e) => e.dedupeKey === 'rate:H-KILN' && e.end == null)!;
    expect(ofKind(slow, 'confirmed').join(' ')).toContain(ev.id);
  });

  it('which defect category is increasing — the Quality & Defects cards and the trend rule', () => {
    for (const s of [plain, gaugeQ, lowFpy]) {
      const p = resolvePeriod('shift', s.minute);
      const a = q(s, Q.defects);
      expect(fact(a, 'Tiles inspected')).toBe(card(inspectedKpi(s, p)));
      expect(fact(a, 'Defective tiles')).toBe(card(defectiveKpi(s, p)));
      expect(fact(a, 'First-pass quality')).toBe(card(firstPassQualityKpi(s, p)));
      const top = topDefectKpi(s, p);
      expect(fact(a, 'Most frequent defect')).toBe(top.unavailable ? 'None recorded' : top.display);
      expect(ofKind(a, 'simulated').join(' ')).toContain('SIM-CV v0, simulated');
    }
    const rising = q(gaugeQ, Q.defects);
    expect(ofKind(rising, 'confirmed')[0]).toMatch(/is increasing the most/);
    expect(ofKind(rising, 'unknown').join(' ')).toMatch(/cannot be established/);
    expect(rising.links.some((l) => l.kind === 'defect')).toBe(true);
    expect(ofKind(rising, 'actions').join(' ')).toMatch(/rule-based/);
  });

  it('which vehicles are delayed — the Waiting or delayed card and the delayed-truck list', () => {
    const s = kilnStop;
    const a = q(s, Q.vehicles);
    const kpi = delayedVehiclesKpi(s);
    const delayed = delayedTrucks(s);
    expect(delayed.length).toBeGreaterThan(0);
    expect(fact(a, 'Waiting or delayed')).toBe(card(kpi));
    expect(fact(a, 'Past a limit')).toBe(String(delayed.length));
    expect(fact(a, 'Average truck dwell')).toBe(card(avgDwellKpi(s, resolvePeriod('shift', s.minute))));
    expect(ofKind(a, 'confirmed')[0]).toContain(`Waiting or delayed now: ${card(kpi)}`);
    const listed = ofKind(a, 'confirmed').filter((t) => /^\d+\. /.test(t));
    expect(listed.length).toBe(delayed.length);
    delayed.forEach((d, i) => {
      expect(listed[i]).toContain(d.label);
      expect(listed[i]).toContain(`${int(d.minutes)} min (limit ${d.limit} min`);
    });
    expect(a.links[0]).toMatchObject({ kind: 'fleet-vehicle', id: delayed[0].id });
    expect(ofKind(a, 'simulated').join(' ')).toMatch(/no GPS/);
    expect(ofKind(a, 'unknown').join(' ')).toMatch(/cannot be established/);
    // With nothing delayed the answer says so, from the same card.
    const none = q(plain, Q.vehicles);
    expect(fact(none, 'Waiting or delayed')).toBe(card(delayedVehiclesKpi(plain)));
  });

  it('what happened during this incident — the event in context, or “cannot be established” without one', () => {
    const ev = conveyor.events.find((e) => e.dedupeKey === 'stop:CV-KIN' && e.end == null)!;
    const a = q(conveyor, Q.incident, { eventId: ev.id });
    expect(a.intent).toBe('event-what');
    expect(a.eventId).toBe(ev.id);
    expect(a.text[0]).toContain(ev.id);
    expect(a.links[0]).toMatchObject({ kind: 'event', id: ev.id });
    // The record is scenario-caused, and says which scenario.
    expect(ofKind(a, 'simulated').find((x) => x.startsWith(ev.id))).toMatch(/scenario-caused — started by the scenario “Kiln infeed conveyor stop”/);

    const none = q(conveyor, Q.incident);
    expect(none.intent).toBe('event-missing');
    expect(none.eventId).toBeUndefined();
    expect(ofKind(none, 'unknown').join(' ')).toMatch(/cannot be established until an incident is chosen/);
    const top = attentionEvents(conveyor).slice(0, 3);
    expect(none.followUps).toEqual(top.map((e) => `What happened in ${e.id}?`));
    // A plain simulated event is labelled as such.
    const own = openEvents(conveyor).find((e) => e.source === 'simulation' && !e.historical);
    if (own) expect(ofKind(q(conveyor, Q.incident, { eventId: own.id }), 'simulated').join(' ')).toContain("simulated — raised by the simulation's own event rules");
  });

  it('which equipment to investigate first — the Overview ranking (attentionEvents) and its count card', () => {
    for (const s of [conveyor, kilnStop, pressStop]) {
      const list = attentionEvents(s);
      const a = q(s, Q.first);
      expect(fact(a, 'Issues requiring attention')).toBe(card(activeIssuesKpi(s)));
      const target = list.find((e) => e.asset.equipmentId || e.asset.stationId) ?? list[0];
      expect(a.eventId).toBe(target.id);
      const ranked = ofKind(a, 'confirmed')
        .filter((t) => /^\d+\. /.test(t))
        .map((t) => /^\d+\. (EV-\d+)/.exec(t)![1]);
      expect(ranked).toEqual(list.slice(0, 5).map((e) => e.id));
      expect(ofKind(a, 'actions')[0]).toContain(`Investigate ${target.id}`);
      // The supervisor question takes the top of the same ranking.
      expect(q(s, 'What should the supervisor investigate first?').eventId).toBe(list[0].id);
    }
  });
});

describe('Labelled sections', () => {
  it('inferred lines carry “Likely”, hypotheses “Possible”, confirmed facts never a doubt', () => {
    expect(answers.length).toBeGreaterThan(40);
    for (const a of answers) {
      for (const t of ofKind(a, 'inferred')) expect(EMPTY.has(t) || /^Likely: /.test(t), `${a.intent}: ${t}`).toBe(true);
      for (const t of ofKind(a, 'hypotheses')) expect(EMPTY.has(t) || /^Possible: /.test(t), `${a.intent}: ${t}`).toBe(true);
      for (const t of ofKind(a, 'confirmed')) expect(t, a.intent).not.toMatch(/^(Likely|Possible): /);
      for (const k of CORE_SECTIONS) expect(ofKind(a, k).length, `${a.intent} ${k}`).toBeGreaterThan(0);
      expect(ofKind(a, 'simulated')[0]).toMatch(/generated by the demo simulation/);
    }
  });
});

describe('Cannot be established', () => {
  it('energy is not monitored — no figures', () => {
    for (const question of ['How much energy does the kiln use?', 'Are we wasting gas?', 'What is the electricity cost today?']) {
      const a = q(conveyor, question);
      expect(a.intent).toBe('energy');
      expect(ofKind(a, 'confirmed')[0]).toMatch(/Energy is not monitored in this product/);
      expect(ofKind(a, 'unknown').join(' ')).toMatch(/cannot be established/);
      for (const k of ['confirmed', 'unknown', 'inferred', 'hypotheses', 'actions', 'estimate']) for (const t of ofKind(a, k)) expect(t, k).not.toMatch(/\d/);
      expect(all(a)).not.toMatch(/kWh/);
      expect(a.facts).toEqual([]);
    }
  });

  it('process parameters without a physical model are not invented', () => {
    const a = q(conveyor, 'What is the kiln temperature?');
    expect(a.intent).toBe('process-parameter');
    expect(ofKind(a, 'confirmed')[0]).toMatch(/not modelled/);
    expect(ofKind(a, 'unknown')[0]).toMatch(/cannot be established/);
    for (const k of ['confirmed', 'unknown']) for (const t of ofKind(a, k)) expect(t).not.toMatch(/\d\s?°|°C/);
    expect(q(conveyor, 'Which press bearing temperature is at risk?').intent).toBe('health');
  });

  it('an unknown event id or an unmatched question says what cannot be established', () => {
    const a = q(conveyor, 'What happened in EV-99999?');
    expect(a.intent).toBe('event-missing');
    expect(ofKind(a, 'unknown')[0]).toMatch(/What happened in EV-99999 cannot be established/);
    const h = q(plain, 'hello');
    expect(ofKind(h, 'unknown').length).toBeGreaterThan(0);
    expect(h.text.join(' ')).toMatch(/rule-based/i);
    expect(h.text.join(' ')).toMatch(/no language model/i);
  });
});

describe('Context', () => {
  it('"this machine" and "this stage" answer about the selection', () => {
    const m = q(pressStop, 'How is this machine doing?', { equipmentId: 'E-PRS1' });
    expect(m.intent).toBe('machine');
    expect(m.text[0]).toContain('E-PRS1');
    const st = q(sortBn, 'How is this stage doing?', { stageId: 'SORT' });
    expect(st.intent).toBe('stage');
    expect(st.text[0]).toContain('Sorting');
    expect(ofKind(st, 'confirmed').join(' ')).toContain('Sorting & inspection is currently constraining output');
  });
});

describe('Links', () => {
  it('go only to the seven workspaces, with their current names', () => {
    const kinds = new Set(['equipment', 'vehicle', 'fleet-vehicle', 'event', 'defect', 'stage', 'workspace']);
    for (const a of answers)
      for (const l of a.links) {
        expect(kinds.has(l.kind), `${a.intent}: ${l.kind}`).toBe(true);
        if (l.kind === 'workspace') {
          expect(['overview', 'production', 'quality', 'fleet', 'events']).toContain(l.id);
          expect(l.label).toBe(`Open ${WORKSPACE_TITLE[l.id]}`);
        }
        if (l.kind === 'event') expect(l.label).toBe(`Events & Reports · ${l.id}`);
        if (l.kind === 'stage') expect(l.label).toMatch(/^Production · /);
        if (l.kind === 'equipment') expect(l.label).toBe(`Factory Twin · ${l.id}`);
      }
  });

  it('never name a retired page', () => {
    for (const a of answers) expect(all(a), a.intent).not.toMatch(/Command Center|Machine Health|Energy Intelligence|Scenario Simulator|Assets & Data|OEE & Loss\b|AI Defect Monitoring|Vehicle Monitoring|Production Monitoring/);
  });
});

describe('Investigation of one event', () => {
  const pickEvents = (s: SimState) => {
    const open = openEvents(s);
    const pick = (f: (e: OpEvent) => boolean) => open.find(f);
    return [pick((e) => e.category === 'production' && !e.consequenceOf), pick((e) => e.category === 'equipment'), pick((e) => !!e.consequenceOf)].filter((e): e is OpEvent => !!e);
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

  it('separates facts from causes, and causes carry a confidence in words', () => {
    for (const ev of pickEvents(conveyor)) {
      const a = q(conveyor, 'Why did it happen?', { eventId: ev.id });
      expect(a.intent).toBe('event-why');
      expect(ofKind(a, 'confirmed').length).toBeGreaterThan(0);
      for (const c of ev.causes) {
        const kind = c.confidence === 'confirmed' ? 'confirmed' : c.confidence === 'likely' ? 'inferred' : 'hypotheses';
        expect(ofKind(a, kind).some((t) => t.includes(c.text)), `${ev.id} ${c.confidence}`).toBe(true);
      }
    }
  });

  it('plant-wide questions stay plant-wide while an event is in context', () => {
    const ev = pickEvents(conveyor)[0];
    expect(q(conveyor, 'What is the current OEE and how is it calculated?', { eventId: ev.id }).intent).toBe('oee');
    expect(q(conveyor, 'Which conveyor stopped most recently?', { eventId: ev.id }).intent).toBe('conveyor-stop');
    for (const question of [Q.belowTarget, Q.constraint, Q.oeeLosses, Q.defects, Q.vehicles, Q.first]) expect(q(conveyor, question, { eventId: ev.id }).intent.startsWith('event-'), question).toBe(false);
    // Naming another machine asks about that machine.
    const other = ev.asset.equipmentId === 'E-PRS2' ? 'press 1' : 'press 2';
    expect(q(conveyor, `How is ${other} doing?`, { eventId: ev.id }).intent).toBe('machine');
  });

  it('the defect report answer links the quality event it describes', () => {
    const a = q(gaugeQ, 'Show the report and evidence for the latest defect.');
    expect(a.intent).toBe('defect-report');
    expect(a.eventId).toBeTruthy();
    expect(a.links[0]).toMatchObject({ kind: 'defect', id: a.eventId });
    expect(a.links[1]).toMatchObject({ kind: 'event', id: a.eventId });
    const quality = gaugeQ.events.filter((e) => e.category === 'quality');
    if (quality.length > 1) {
      const older = quality[0];
      const b = q(gaugeQ, 'Show the report and evidence for this defect.', { eventId: older.id });
      expect(b.eventId).toBe(older.id);
    }
  });
});

describe('Attributions, measurements and estimates', () => {
  const kilnHeld = (s: SimState, from: number, to: number) => {
    let n = 0;
    for (let m = from; m < to; m++) {
      const x = minuteAt(s, 'H-KILN', m)!;
      if (x.state === 'down' || x.state === 'starved' || x.state === 'blocked') n++;
    }
    return n;
  };

  it('a kiln attribution to a conveyor stop is inferred with a confidence, never a confirmed fact', () => {
    const ev = conveyor.events.find((e) => e.dedupeKey === 'stop:CV-KIN' && e.end == null)!;
    expect(ev.acc.constraintMin).toBeGreaterThan(0);
    const d = conveyor.downtime.find((x) => x.equipmentId === 'CV-KIN' && x.end == null)!;

    const a = q(conveyor, 'Which conveyor stopped most recently?');
    expect(a.eventId).toBe(ev.id);
    const obs = ofKind(a, 'confirmed').join(' ');
    expect(obs).not.toMatch(/because of it/);
    expect(obs).not.toMatch(/held (the kiln|it) up/);
    // Confirmed: what the kiln's own state log shows while the conveyor was stopped.
    expect(obs).toContain(`the kiln (line constraint) was down, starved or blocked for ${int(kilnHeld(conveyor, d.start, conveyor.minute))} min so far (kiln state log)`);
    // Inferred: the event engine's attribution, with its confidence.
    expect(ofKind(a, 'inferred')).toContainEqual(expect.stringMatching(new RegExp(`^Likely: ${ev.id} held the kiln \\(line constraint\\) up ${int(ev.acc.constraintMin)} min so far — .*inferred`)));
    expect(ofKind(a, 'simulated').join(' ')).toContain('was injected by a scenario');

    // Same rule in the plant-wide answers that cite the attribution.
    const md = q(conveyor, 'Which machine has the greatest downtime loss?');
    expect(md.intent).toBe('machine-downtime');
    expect(ofKind(md, 'confirmed').join(' ')).not.toMatch(/kiln held up|held the kiln up/);
    expect(ofKind(md, 'inferred').filter((x) => x.includes('CV-KIN') && x.includes(`${int(ev.acc.constraintMin)} min`))).toEqual([expect.stringMatching(/^Likely: /)]);
    for (const question of [Q.belowTarget, Q.oeeLosses, Q.first]) {
      const x = q(conveyor, question);
      expect(ofKind(x, 'confirmed').filter((t) => t.includes(ev.id) && /held the kiln up|kiln hold-up/.test(t)), question).toEqual([]);
    }

    // The event's own impact answer: the kiln minutes and the line output derived from them move to Inferred.
    const imp = q(conveyor, `What is the impact of ${ev.id}?`);
    expect(ofKind(imp, 'confirmed').join(' ')).not.toMatch(/held up or slowed by this event|Line good output lost/);
    const inferred = ofKind(imp, 'inferred');
    expect(inferred.some((x) => x.startsWith(`Likely: Kiln (line constraint) held up or slowed by this event: ${int(ev.acc.constraintMin)} min`))).toBe(true);
    expect(inferred.some((x) => x.startsWith('Likely: Line good output lost'))).toBe(true);
    // Energy rows of the report come from an illustrative model: never a confirmed fact.
    expect(ofKind(imp, 'confirmed').join(' ')).not.toMatch(/energy|kWh/i);
  });

  it('the kiln stop event keeps its own kiln minutes under Confirmed facts', () => {
    const ev = kilnStop.events.find((e) => e.dedupeKey === 'stop:H-KILN' && e.end == null)!;
    const imp = q(kilnStop, `What is the impact of ${ev.id}?`);
    expect(ofKind(imp, 'confirmed').some((x) => x.startsWith(`Kiln (line constraint) held up or slowed by this event: ${int(ev.acc.constraintMin)} min`))).toBe(true);
    expect(ofKind(imp, 'inferred').some((x) => /held up or slowed/.test(x))).toBe(false);
  });

  it('laser-gauge records are measurements: no classification confidence is shown for them', () => {
    const a = q(gaugeQ, 'Show the report and evidence for the latest planarity defect');
    expect(a.intent).toBe('defect-report');
    const ev = gaugeQ.events.find((e) => e.id === a.eventId)!;
    expect(ev.refs.defect).toBe('planarity');
    expect(ev.asset.stationId).toBe('ST-GAUGE');
    const obs = ofKind(a, 'confirmed').join(' ');
    expect(obs).toMatch(/Inspection evidence: INS-\d+ planarity deviation .*simulated gauge measurement: /);
    expect(obs).not.toMatch(/confidence/i);
    const method = ofKind(a, 'method').join(' ');
    expect(method).toContain('Gauge records are simulated laser measurements checked against a tolerance — not classifications');
    expect(method).not.toMatch(/simulated classification/);
    expect(ofKind(a, 'simulated').join(' ')).not.toMatch(/classification/);
    const evd = q(gaugeQ, `What evidence is available for ${ev.id}?`);
    expect(ofKind(evd, 'method').join(' ')).toContain('Gauge records are simulated laser measurements');
    expect(ofKind(evd, 'method').join(' ')).not.toMatch(/simulated classification/);
  });

  it('tunnel (vision) records keep their simulated confidence', () => {
    const a = q(gaugeQ, 'Show the report and evidence for the latest chip defect');
    expect(a.intent).toBe('defect-report');
    expect(gaugeQ.events.find((e) => e.id === a.eventId)?.asset.stationId).toBe('ST-VIS');
    if (/Inspection evidence: INS-/.test(a.text.join(' '))) expect(ofKind(a, 'confirmed').join(' ')).toMatch(/simulated confidence \d+ %/);
    expect(ofKind(a, 'method').join(' ')).toMatch(/simulated classification \(SIM-CV v0, simulated\), no vision model; confidence values are simulated/);
  });

  it('the per-minute estimate of a kiln stop uses the event report FPY, not 97.5 %', () => {
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
    expect(ofKind(a, 'actions').length).toBeGreaterThan(1);
  });

  it('a below-rate kiln event is valued at its actual shortfall, not the full typical rate', () => {
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

  it('the cost of the current loss never adds consequence events, and never calls it a saving', () => {
    const cons = activeEvents(conveyor).filter((e) => e.consequenceOf);
    expect(cons.length).toBeGreaterThan(0);
    const a = q(conveyor, 'What is the estimated cost of the current production loss?');
    expect(a.intent).toBe('loss-cost');
    const est = ofKind(a, 'estimate');
    for (const c of cons) expect(est.some((t) => t.startsWith(`${c.id} ·`))).toBe(false);
    expect(est.some((t) => t.startsWith('Assumptions:'))).toBe(true);
    expect(ofKind(a, 'confirmed').join(' ')).toContain(`${cons[0].id} → ${cons[0].consequenceOf}`);
    expect(ofKind(a, 'unknown').join(' ')).toMatch(/Savings cannot be established/);
  });

  it('uses the financial assumptions passed in the context', () => {
    const base = q(conveyor, 'What is the estimated cost of the current production loss?');
    const dear = q(conveyor, 'What is the estimated cost of the current production loss?', { finance: { ...DEFAULT_FINANCE, sellingPricePerM2: 12 } });
    expect(ofKind(dear, 'estimate').join(' ')).toContain('USD 12.00/m²');
    expect(ofKind(dear, 'estimate')[0]).not.toBe(ofKind(base, 'estimate')[0]);
  });

  it('every answer with a money figure lists its assumptions; money appears only under Estimate', () => {
    for (const a of answers) {
      const est = ofKind(a, 'estimate');
      if (est.some((t) => /USD\s?\d/.test(t))) expect(est.some((t) => t.startsWith('Assumptions:')), `${a.intent}: ${est.join(' | ')}`).toBe(true);
      for (const kind of SECTION_ORDER.filter((k) => k !== 'estimate')) for (const t of ofKind(a, kind)) expect(t, `${a.intent} ${kind}`).not.toMatch(/≈ USD\s?\d/);
    }
  });
});

describe('Honesty', () => {
  it('no answer claims a model, live data or an external service', () => {
    for (const a of answers) {
      const text = all(a)
        .replace(/\bno (?:[a-z-]+ )?(?:language|vision|trained) model\b/gi, '')
        .replace(/rendered live, not recorded/gi, '');
      expect(text, a.intent).not.toMatch(/\b(?:language|vision|AI|trained|machine[- ]learning|neural|predictive) model\b/i);
      expect(text, a.intent).not.toMatch(/\blive\b/i);
      expect(text, a.intent).not.toMatch(/real[- ]time|telemetry|\bLLM\b|\bGPT\b/i);
      for (const x of ofKind(a, 'confirmed')) expect(x, a.intent).not.toMatch(/because of it/);
      expect(a.text.join(' '), a.intent).not.toMatch(/simulated confidence —/);
    }
  });
});

describe('Earlier review findings', () => {
  it('an offline asset is not ranked most at risk and is not shown as 0/100', () => {
    expect(assess(pressStop, 'E-PRS1').level).toBe('offline');
    const a = q(pressStop, 'Which machine is most at risk?');
    expect(a.intent).toBe('health');
    expect(a.text[0]).not.toMatch(/E-PRS1[^.]*0\/100/);
    expect(a.facts.some((f) => f.value.startsWith('0/100'))).toBe(false);
    const f = a.facts.find((x) => x.label === 'E-PRS1');
    if (f) expect(f.value).toBe('not running, not assessed');
  });

  it('the kiln answer says the kiln is blocked when the constraint is downstream', () => {
    const bn = bottleneck(sortBn);
    expect(bn.cause).toBe('blocking');
    const a = q(sortBn, 'How is the kiln affecting production?');
    expect(a.intent).toBe('kiln');
    const t = a.text.join(' ');
    expect(t).toContain('so the kiln is blocked');
    expect(t).not.toContain('starving it');
    expect(t).not.toMatch(/kWh|gas/);
  });

  it('the largest-downtime answer credits a machine with its minutes inside the period only', () => {
    const p = resolvePeriod('shift', kilnStop.minute);
    expect(p.label).toMatch(/Shift B/);
    const top = downtimePareto(kilnStop, p)[0];
    const a = q(kilnStop, 'What is the largest downtime loss?');
    expect(a.intent).toBe('largest-downtime');
    const m = /Most of it was on ([A-Z0-9-]+) \([^,]+, ([\d,]+) min in the period\)/.exec(a.text.join(' '));
    expect(m).not.toBeNull();
    expect(Number(m![2].replace(/,/g, ''))).toBeLessThanOrEqual(Math.round(top.minutes));
  });

  it('greatest downtime loss uses minutes clipped to the period', () => {
    const p = resolvePeriod('shift', conveyor.minute);
    const a = q(conveyor, 'Which machine has the greatest downtime loss?');
    const top = a.facts[0].label.split(' · ')[0];
    const minutes = conveyor.downtime
      .filter((d) => d.equipmentId === top && d.category !== 'Planned' && d.category !== 'Starved' && d.category !== 'Blocked' && !REASON_BY_CODE[d.reasonCode]?.planned && d.start < p.to && (d.end ?? conveyor.minute) > p.from)
      .reduce((x, d) => x + clippedDuration(d, p, conveyor.minute), 0);
    expect(a.facts[0].value.startsWith(`${int(minutes)} min`)).toBe(true);
  });

  it('theoretical output uses capacityBreakdown, losses largest first', () => {
    const cap = capacityBreakdown(conveyor, resolvePeriod('shift', conveyor.minute));
    const c = q(conveyor, 'What prevents us from reaching theoretical output?');
    expect(c.facts.find((f) => f.label === 'Theoretical')!.value).toBe(`${int(cap.theoreticalM2)} m²`);
    const listed = c.text.filter((t) => /^\d+\. /.test(t)).map((t) => Number(/: ([\d,]+) m²/.exec(t)![1].replace(/,/g, '')));
    expect(listed.length).toBe(cap.losses.filter((l) => l.kind !== 'transit').length);
    expect([...listed].sort((x, y) => y - x)).toEqual(listed);
  });

  it('turnaround answer uses the rule threshold and the turnaround events', () => {
    const a = q(kilnStop, 'Which trucks exceeded their turnaround threshold?');
    expect(a.intent).toBe('turnaround');
    expect(a.text[0]).toContain(`Threshold: ${kilnStop.rules.turnaroundMax} min`);
    const evs = kilnStop.events.filter((e) => e.type === 'turnaround-exceeded' && e.end == null);
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs.slice(0, 2)) expect(all(a)).toContain(e.id);
  });
});
