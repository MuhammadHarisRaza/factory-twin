/**
 * Round 2 — one rule for a stale data feed in the copilot (Decision 1), and the KPI cards' time scope (#22):
 *  - a figure that rests on a stale feed (kiln: availability, performance, kiln minutes; sorting: output,
 *    attainment, quality) keeps the KPI card's running value but is never a confirmed fact: it goes under
 *    "Cannot be established" as "Not confirmed by the feed (<asset> data stale since hh:mm): …", and its
 *    facts row carries the card's mark — read from the KPI models' provenance;
 *  - the event "action" answer never reads the kiln rate "right now" from a stale kiln feed;
 *  - a running shift is "Shift A · 06:00–10:30 (to date)" with the plan "Plan to date X m² · shift Y m²"
 *    (the Good output card's wording), in the answer and on the Copilot page.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { constraintDowntimeKpi, factoryOeeKpi, goodOutputKpi, periodScope, targetAttainmentKpi } from '../kpis';
import { activateScenario, advance, createSim, DEFAULT_SEED, type SimState } from '../../sim/engine';
import { lineMetrics, resolvePeriod } from '../../sim/metrics';
import { formatClock } from '../../sim/time';
import { copilotSummary } from '../../pages/copilot/derive';
import { ask, type CopilotAnswer, type CopilotContext } from '../copilot';

const SHORT = 2 * 1440 + 4 * 60 + 30;
const ofKind = (a: CopilotAnswer, kind: string) => a.sections.filter((x) => x.kind === kind).map((x) => x.text);
const fact = (a: CopilotAnswer, label: string) => a.facts.find((f) => f.label === label)?.value;
const q = (s: SimState, question: string, ctx?: CopilotContext) => ask(s, question, undefined, ctx);
const int = (n: number) => Math.round(n).toLocaleString('en-GB');
const low1 = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
const BELOW = 'Why is production below target?';
const LOSSES = 'What are the main OEE losses this shift?';
const OEE = 'What is the current OEE and how is it calculated?';

let plain: SimState;
let kilnStale: SimState;
let sortStale: SimState;

function lose(id: string) {
  const s = createSim(DEFAULT_SEED, SHORT);
  activateScenario(s, { kind: 'signal-loss', equipmentId: id, end: null, label: `${id} feed lost` });
  advance(s, s.minute + 30);
  return s;
}

beforeAll(() => {
  plain = createSim(DEFAULT_SEED, SHORT);
  kilnStale = lose('H-KILN');
  sortStale = lose('I-SORT');
}, 180_000);

const markOf = (s: SimState, id: string, what: string) => `${what} data stale since ${formatClock(s.feeds[id].since)}`;

describe('Decision 1 — stale feeds: the copilot never states an unconfirmed figure as a fact', () => {
  it('the KPI models carry the marks the copilot reads', () => {
    const p = resolvePeriod('shift', kilnStale.minute);
    expect(factoryOeeKpi(kilnStale, p).provenance).toBe('stale');
    expect(constraintDowntimeKpi(kilnStale, p).status?.label).toBe(`Not confirmed · ${markOf(kilnStale, 'H-KILN', 'kiln')}`);
    expect(goodOutputKpi(sortStale, resolvePeriod('shift', sortStale.minute)).provenance).toBe('stale');
  });

  it('below target, sorting feed stale: output vs plan is "not confirmed", never "below / not below target"', () => {
    const s = sortStale;
    const p = resolvePeriod('shift', s.minute);
    const lm = lineMetrics(s, p);
    const good = goodOutputKpi(s, p, lm);
    const att = targetAttainmentKpi(s, p, lm);
    const mark = markOf(s, 'I-SORT', 'sorting');
    const a = q(s, BELOW);
    const confirmed = ofKind(a, 'confirmed').join(' ');
    expect(confirmed).not.toMatch(/below target|ahead|on track|good output/i);
    expect(confirmed).not.toMatch(/Line OEE/);
    const unknown = ofKind(a, 'unknown').join(' ');
    expect(unknown).toContain(`Not confirmed by the feed (${mark}): output vs plan — simulated running total ${good.display} m² of ${int(lm.targetM2)} m² planned to date, target attainment ${att.display} %`);
    expect(unknown).toContain(`Not confirmed by the feed (${mark}): line OEE`);
    // The same figures as the cards, with the cards' mark.
    expect(fact(a, 'Good output')).toBe(`${good.display} m² (not confirmed — ${mark})`);
    expect(fact(a, 'Target attainment')).toBe(`${att.display} % (not confirmed — ${mark})`);
    expect(ofKind(a, 'actions').join(' ')).not.toContain('No recovery action is indicated');
    expect(a.links.some((l) => l.kind === 'equipment' && l.id === 'I-SORT')).toBe(true);
  });

  it('below target, kiln feed stale: Line OEE and the kiln minutes move to "not confirmed"; sorting output stays confirmed', () => {
    const s = kilnStale;
    const p = resolvePeriod('shift', s.minute);
    const lm = lineMetrics(s, p);
    const mark = markOf(s, 'H-KILN', 'kiln');
    const a = q(s, BELOW);
    const confirmed = ofKind(a, 'confirmed');
    expect(confirmed[0]).toMatch(/^Production is (not )?below target in shift [ABC] · \d\d:\d\d–\d\d:\d\d \(to date\): good output /);
    for (const t of confirmed) expect(t).not.toMatch(/Line OEE|Downtime affecting output/);
    const unknown = ofKind(a, 'unknown').join(' ');
    expect(unknown).toContain(`Not confirmed by the feed (${mark}): line OEE ${factoryOeeKpi(s, p, lm).display} %`);
    expect(unknown).toContain(`Not confirmed by the feed (${mark}): downtime affecting output: ${constraintDowntimeKpi(s, p, lm).display} min`);
    expect(fact(a, 'OEE')).toContain(`(not confirmed — ${mark})`);
    expect(fact(a, 'Downtime affecting output')).toContain(`(not confirmed — ${mark})`);
    expect(fact(a, 'Good output')).not.toContain('not confirmed');
  });

  it('OEE losses: A, P and the kiln loss minutes are not confirmed with a stale kiln; quality with a stale sorting feed', () => {
    const k = q(kilnStale, LOSSES);
    const kMark = markOf(kilnStale, 'H-KILN', 'kiln');
    const kc = ofKind(k, 'confirmed');
    for (const t of kc) expect(t).not.toMatch(/^Line OEE for|^\d+\. |^Losses at the kiln|^Downtime affecting output/);
    const ku = ofKind(k, 'unknown');
    expect(ku.join(' ')).toContain(`Not confirmed by the feed (${kMark}): line OEE for shift`);
    expect(ku).toContain(`Not confirmed by the feed (${kMark}): losses at the kiln (line constraint), in minutes of kiln time, largest first:`);
    expect(ku.some((t) => /^1\. /.test(t))).toBe(true);
    expect(fact(k, 'Availability')).toContain(`(not confirmed — ${kMark})`);
    expect(fact(k, 'Performance')).toContain(`(not confirmed — ${kMark})`);
    expect(fact(k, 'Quality')).not.toContain('not confirmed');
    expect(kc.join(' ')).toMatch(/Quality loss: reject rate/);

    const s = q(sortStale, LOSSES);
    const sMark = markOf(sortStale, 'I-SORT', 'sorting');
    expect(ofKind(s, 'confirmed').join(' ')).not.toMatch(/Quality loss|Line OEE for/);
    expect(ofKind(s, 'confirmed').join(' ')).toMatch(/Losses at the kiln/);
    expect(ofKind(s, 'unknown').join(' ')).toContain(`Not confirmed by the feed (${sMark}): quality loss: reject rate`);
    expect(fact(s, 'Quality')).toContain(`(not confirmed — ${sMark})`);
    expect(fact(s, 'Availability')).not.toContain('not confirmed');
  });

  it('the OEE calculation answer routes each factor by its feed', () => {
    const a = q(kilnStale, OEE);
    const mark = markOf(kilnStale, 'H-KILN', 'kiln');
    expect(ofKind(a, 'confirmed').filter((t) => /^(Line OEE|Availability|Performance|Quality) /.test(t)).map((t) => t.split(' ')[0])).toEqual(['Quality']);
    expect(ofKind(a, 'unknown').join(' ')).toContain(`Not confirmed by the feed (${mark}): availability`);
    expect(ofKind(a, 'unknown').join(' ')).toContain(`Not confirmed by the feed (${mark}): performance`);
    expect(fact(a, 'Total count (kiln)')).toContain('not confirmed');
  });

  it('cost, capacity and defect answers keep sorting-counted figures out of the confirmed facts while sorting is stale', () => {
    const mark = markOf(sortStale, 'I-SORT', 'sorting');
    const cost = q(sortStale, 'What is the estimated cost of the current production loss?');
    expect(ofKind(cost, 'confirmed').join(' ')).not.toMatch(/^Good output for/m);
    expect(ofKind(cost, 'unknown').join(' ')).toContain(`Not confirmed by the feed (${mark}): good output for shift`);
    const cap = q(sortStale, 'What prevents us from reaching theoretical output?');
    expect(ofKind(cap, 'confirmed').join(' ')).not.toMatch(/first-quality|^\d+\. /m);
    expect(ofKind(cap, 'unknown').join(' ')).toContain(`Not confirmed by the feed (${mark}): fired`);
    expect(fact(cap, 'First quality (good)')).toContain(`(not confirmed — ${mark})`);
    const def = q(sortStale, 'Which defect category is increasing?');
    expect(ofKind(def, 'confirmed').join(' ')).not.toMatch(/ inspected, .* defective/);
    expect(ofKind(def, 'unknown').join(' ')).toContain(`Not confirmed by the feed (${mark}): in shift`);
  });

  it('a fresh feed changes nothing: no "not confirmed" anywhere', () => {
    for (const question of [BELOW, LOSSES, OEE]) {
      const a = q(plain, question);
      expect(JSON.stringify(a), question).not.toMatch(/not confirmed|Not confirmed by the feed/i);
    }
  });
});

describe('Decision 1 — the event "action" answer never reads the kiln rate from a stale feed', () => {
  it('fresh feed: the current kiln rate values a further minute; stale kiln feed: unknown, no "right now", no estimate', () => {
    const s = createSim(DEFAULT_SEED, SHORT);
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: null, label: 'Kiln infeed stop' });
    advance(s, s.minute + 45);
    const ev = s.events.find((e) => e.category === 'production' && e.end == null && !e.consequenceOf && e.acc.constraintMin > 0)!;
    expect(ev).toBeDefined();
    const fresh = q(s, 'What should we do?', { eventId: ev.id });
    expect(fresh.intent).toBe('event-action');
    expect([...ofKind(fresh, 'confirmed'), ...ofKind(fresh, 'estimate')].join(' ')).toMatch(/right now|Every further minute at the current kiln rate/);

    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed lost' });
    advance(s, s.minute + 20);
    const f = s.feeds['H-KILN'];
    expect(f.status).toBe('stale');
    const a = q(s, 'What should we do?', { eventId: ev.id });
    expect(a.intent).toBe('event-action');
    const all = a.text.join(' ');
    expect(all).not.toMatch(/right now|this minute —|tiles\/h now|Every further minute at the current kiln rate/);
    expect(ofKind(a, 'estimate')).toEqual([]);
    expect(ofKind(a, 'unknown').join(' ')).toContain(`Not confirmed by the feed (kiln data stale since ${formatClock(f.since)}): the kiln's current rate is unknown`);
  });
});

describe('#22 — a running shift is "to date", with the plan in the Good output card\'s words', () => {
  it('below-target answer: periodScope label and sentence, "Plan to date X m² · shift Y m²" plan', () => {
    const s = plain;
    const p = resolvePeriod('shift', s.minute);
    const good = goodOutputKpi(s, p);
    expect(good.target).toMatch(/^Plan to date [\d,]+ m² · shift [\d,]+ m²$/);
    const a = q(s, BELOW);
    expect(a.periodLabel).toBe(periodScope(s, p));
    expect(a.periodLabel).toMatch(/\(to date\)$/);
    expect(a.periodLabel).not.toBe(p.label);
    const first = ofKind(a, 'confirmed')[0];
    expect(first).toContain(`in ${low1(periodScope(s, p))}:`);
    expect(first).toContain(`good output ${good.display} m² against ${low1(good.target!)}`);
    expect(a.text.join(' ')).not.toContain(p.label);
    expect(fact(a, 'Plan to date')).toBe(good.target!.replace(/^Plan to date /, ''));
    expect(fact(a, 'Plan')).toBeUndefined();
    // A completed shift keeps its own label and a plain plan.
    const prev = q(s, BELOW, { period: 'prev-shift' });
    const pp = resolvePeriod('prev-shift', s.minute);
    expect(prev.periodLabel).toBe(pp.label);
    expect(fact(prev, 'Plan')).toBe(goodOutputKpi(s, pp).target!.replace(/^Plan /, ''));
  });

  it('the Copilot page sentence uses the same scope and plan wording, and a stale sorting feed is "not confirmed"', () => {
    const p = resolvePeriod('shift', plain.minute);
    const good = goodOutputKpi(plain, p);
    const sum = copilotSummary(plain);
    expect(sum.scope).toBe(periodScope(plain, p));
    expect(sum.sentence.startsWith(`${periodScope(plain, p)}: good output ${good.display} m² against ${low1(good.target!)}`)).toBe(true);
    expect(sum.sentence).not.toContain(p.label);

    const st = copilotSummary(sortStale);
    const ps = resolvePeriod('shift', sortStale.minute);
    const g2 = goodOutputKpi(sortStale, ps);
    expect(st.sentence).toContain(`output vs plan not confirmed — ${markOf(sortStale, 'I-SORT', 'sorting')} (simulated running total ${g2.display} m² against ${low1(g2.target!)})`);
    expect(st.sentence).not.toMatch(/of plan \(/);
  });
});
