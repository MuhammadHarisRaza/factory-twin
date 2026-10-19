/**
 * Material-flow rules (src/intel/rules/defs/flow.ts) on one pre-rolled simulation. Normal operation first (the
 * scoped findings clear; anything detected names the stopped neighbour behind it), then fixture sources for
 * missing / stale / bad signals and history gaps (insufficient-data naming them), then scenario phases one after
 * another on the same simulation: a spray dryer stop (silos falling, inflow below outflow in t/h), the brief's
 * powder chain (spray dryer at 40 % with the silo fill set low → "Potential press starvation" and press
 * starvation), a sorting bottleneck (downstream constraint at the kiln outfeed, kiln blockage), a powder-feed
 * conveyor stop (presses cut off with stocked silos is not starvation; spray dryer blockage builds), a printer
 * breakdown (kiln starved; once it restarts the infeed refills and the window's fall is no longer reported) and a
 * data-feed loss (not evaluated). Silo and tank findings never state a mass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_RULES } from '../../../model/plant';
import type { TelemetrySample, TelemetrySeries, TelemetrySource } from '../../../model/telemetry';
import type { ScenarioActivation } from '../../../model/types';
import { activateScenario, advance, clearScenario, createSim, type SimState } from '../../../sim/engine';
import { simulatedSource } from '../../../sim/telemetry';
import { formatClock } from '../../../sim/time';
import { CHART, FLOW_RULES, RULE_BY_ID, RULE_PARAM_DEFAULTS, findingsFor, plantFindings, rulesFor, type FindingsOptions, type RuleFinding, type RuleScope } from '..';

const START = 2 * 1440 + 240;
const s = createSim(41, START);
const IDS = ['F-BUFFER-TREND', 'F-BALANCE', 'F-STARVE', 'F-BLOCK', 'F-POWDER-STARVATION', 'F-DOWNSTREAM-CONSTRAINT'];
const PRESSES = ['E-PRS1', 'E-PRS2', 'E-PRS3'];
const SILO_CAPACITY = 12000;

const eq = (equipmentId: string): RuleScope => ({ kind: 'equipment', equipmentId });
const flowFindings = (scope: RuleScope, opts: FindingsOptions = {}) => findingsFor(s, scope, { rules: FLOW_RULES, ...opts });
const finding = (ruleId: string, equipmentId: string, opts: FindingsOptions = {}): RuleFinding => {
  const f = flowFindings(eq(equipmentId), opts).find((x) => x.ruleId === ruleId);
  if (!f) throw new Error(`no ${ruleId} finding for ${equipmentId}`);
  return f;
};
const measurement = (f: RuleFinding, label: string) => f.measurements.find((m) => m.label === label);
const flowRuleIds = (scope: RuleScope) => rulesFor(scope).filter((d) => d.family === 'flow').map((d) => d.id);
/** A fired finding that names a stopped / held neighbour as the likely source. */
const NAMES_A_STOP = /stopped \(|in a planned stop \(|in a product changeover \(|itself (waiting|blocked)/;

/** The simulated source with some readings / histories replaced (what a gateway with problems would deliver). */
function fixtureSource(read: Record<string, Partial<TelemetrySample>>, series: Record<string, (x: TelemetrySeries) => TelemetrySeries> = {}): TelemetrySource<SimState> {
  return {
    kind: 'simulated',
    read: (st, id) => (read[id] ? { ...simulatedSource.read(st, id), ...read[id] } : simulatedSource.read(st, id)),
    series: (st, id, w) => {
      const x = simulatedSource.series(st, id, w);
      return x && series[id] ? series[id](x) : x;
    },
    states: simulatedSource.states,
  };
}

/** Silo and tank findings: % and %/h only — never a mass or a tile quantity derived from the level. */
function expectNoBulkQuantity(f: RuleFinding) {
  expect(f.explanation, f.key).toMatch(/no level-to-mass calibration configured, so no mass or tile quantity is derived from it/);
  // No quantity of mass or tiles anywhere (rates and the disclosed kg-per-tile-equivalent factor aside).
  expect(f.explanation, f.key).not.toMatch(/\d\s(?:t|kg|tiles|tile-eq)(?![\w/])(?! per)/);
  for (const m of f.measurements) expect(['t', 'kg', 'tiles', 'tile-eq'], `${f.key} · ${m.label}`).not.toContain(m.unit);
  const content = f.measurements.find((m) => /^(Powder in the silos|Slip in the tanks)$/.test(m.label));
  if (content) expect(content.value).toBeNull();
}

describe('registration and scope', () => {
  it('registers six rule-based flow rules; thresholds shared with the event engine follow its defaults', () => {
    expect(FLOW_RULES.map((d) => d.id)).toEqual(IDS);
    for (const id of IDS) {
      expect(RULE_BY_ID[id]).toBe(FLOW_RULES.find((d) => d.id === id));
      expect(RULE_BY_ID[id].family).toBe('flow');
      expect(RULE_BY_ID[id].classification).toBe('rule-based');
      expect(RULE_BY_ID[id].description).not.toMatch(/\bAI\b|predict|probabilit/i);
    }
    expect(RULE_PARAM_DEFAULTS['F-STARVE.waitMin']).toBe(DEFAULT_EVENT_RULES.starvedMinutes);
    expect(RULE_PARAM_DEFAULTS['F-STARVE.waitMinConstraint']).toBe(DEFAULT_EVENT_RULES.starvedMinutesConstraint);
    expect(RULE_PARAM_DEFAULTS['F-BLOCK.rateShare']).toBe(DEFAULT_EVENT_RULES.belowRateFactor);
    expect(RULE_PARAM_DEFAULTS['F-POWDER-STARVATION.normalShare']).toBe(DEFAULT_EVENT_RULES.belowRateFactor);
    expect(RULE_PARAM_DEFAULTS['F-BUFFER-TREND.slopePct']).toBe(5);
  });

  it('buffer rules apply to the item holding the buffer, starvation / blockage to the machines either side', () => {
    expect(flowRuleIds(eq('D-SILO'))).toEqual(['F-BUFFER-TREND', 'F-BALANCE', 'F-POWDER-STARVATION']);
    expect(flowRuleIds(eq('CV-SORT'))).toEqual(['F-BUFFER-TREND', 'F-BALANCE', 'F-DOWNSTREAM-CONSTRAINT']);
    expect(flowRuleIds(eq('C-SLIP'))).toEqual(['F-BUFFER-TREND', 'F-BALANCE']);
    for (const id of [...PRESSES, 'D-TWR', 'F-DRY', 'H-KILN', 'I-SORT', 'J-BOX']) expect(flowRuleIds(eq(id)), id).toEqual(['F-STARVE', 'F-BLOCK']);
    expect(flowRuleIds(eq('C-BM1'))).toEqual(['F-BLOCK']);
    expect(flowRuleIds(eq('J-PAL'))).toEqual(['F-STARVE']);
    for (const id of ['D-BELT', 'A-PARK', 'K-DOCK']) expect(flowRuleIds(eq(id)), id).toEqual([]);
    expect(flowRuleIds({ kind: 'stage', stageNo: 2 })).toContain('F-POWDER-STARVATION');
    expect(flowRuleIds({ kind: 'stage', stageNo: 8 })).toContain('F-DOWNSTREAM-CONSTRAINT');
  });
});

describe('normal simulation', () => {
  it('the targeted findings are clear while the spray dryer, presses, kiln and sorting run normally', () => {
    const clear: [string, string][] = [
      ['F-BUFFER-TREND', 'D-SILO'],
      ['F-BALANCE', 'D-SILO'],
      ['F-POWDER-STARVATION', 'D-SILO'],
      ['F-BUFFER-TREND', 'CV-SORT'],
      ['F-DOWNSTREAM-CONSTRAINT', 'CV-SORT'],
      ['F-BLOCK', 'H-KILN'],
      ['F-STARVE', 'H-KILN'],
      ['F-BLOCK', 'D-TWR'],
      ...PRESSES.map((p): [string, string] => ['F-STARVE', p]),
    ];
    for (const [ruleId, id] of clear) {
      const f = finding(ruleId, id);
      expect(f.status, f.key).toBe('clear');
      expect(f.lastSeen, f.key).toBeNull();
      expect(f.provenance.source).toBe('simulated');
      expect(f.provenance.note).toMatch(/^Simulated data — /);
    }
    expect(finding('F-POWDER-STARVATION', 'D-SILO').explanation).toMatch(/^The chain needs all three in the same window \(\d\d:\d\d–\d\d:\d\d\); none holds\./);
    expect(finding('F-BUFFER-TREND', 'D-SILO').explanation).toMatch(
      /^D-SILO\.level went from [\d.]+ % \(\d\d:\d\d\) to [\d.]+ % \(\d\d:\d\d\) over the last 60 min \(\d\d:\d\d–\d\d:\d\d\): slope [+−][\d.]+ %\/h \(least squares over \d+ minute samples\) — within ±5\.0 %\/h \(silo\)\./,
    );
    expect(finding('F-DOWNSTREAM-CONSTRAINT', 'CV-SORT').explanation).toMatch(/no dedicated cooling-buffer machine/);
  });

  it('plant-wide: every flow finding is evaluated; anything detected above information names the stopped neighbour behind it', () => {
    const flow = plantFindings(s, { rules: FLOW_RULES }).findings;
    expect(flow.length).toBeGreaterThan(30);
    expect(flow.filter((f) => f.status === 'insufficient-data')).toEqual([]);
    for (const f of flow) {
      expect(f.family).toBe('flow');
      expect(f.explanation, f.key).not.toMatch(/\bAI\b|will fail|probabilit|caused by/i);
      if (f.status !== 'fired') continue;
      expect(f.firstSeen!, f.key).toBeLessThanOrEqual(s.minute);
      expect(f.lastSeen).toBe(s.minute);
      expect(f.chartRef, f.key).toMatch(/^chart:buffer:/);
      if (f.severity !== 'info') {
        expect(f.explanation, f.key).toMatch(NAMES_A_STOP);
        expect(f.next, f.key).toBeTruthy();
      }
    }
  });

  it('silos and tanks are read in % only; stage 1–2 flows in t/h, tile buffers in tiles/h', () => {
    for (const id of ['D-SILO', 'C-SLIP']) for (const f of flowFindings(eq(id))) expectNoBulkQuantity(f);
    for (const id of ['D-SILO', 'C-SLIP']) {
      const bal = finding('F-BALANCE', id);
      expect(measurement(bal, 'Inflow')!.unit).toBe('t/h');
      expect(bal.explanation).toMatch(/Dry-body equivalent t\/h: simulated mass flows \(tile-equivalent rate × 7\.56 kg per tile-equivalent, KG_PER_TILE/);
      for (const m of bal.measurements.filter((x) => /^(Inflow|Outflow|Net flow|Deadband)$/.test(x.label))) expect(m.unit, `${id} · ${m.label}`).toBe('t/h');
      expect(bal.explanation).not.toMatch(/tiles\/h/);
    }
    expect(finding('F-BALANCE', 'D-SILO').explanation).toMatch(/\(D-TWR\.powder_flow\) into the powder silos \(D-SILO\.level\) while pressing \(E-PRS1, E-PRS2, E-PRS3\) drew [\d.]+ t\/h \(D-BELT\.tile_count\)/);
    expect(measurement(finding('F-BALANCE', 'F-BUF'), 'Inflow')!.unit).toBe('tiles/h');
    expect(measurement(finding('F-BALANCE', 'I-BUF'), 'Inflow')!.unit).toBe('tiles/h');
    expect(finding('F-BALANCE', 'I-BUF').explanation).toMatch(/I-SORT\.count_good/);
  });

  it('a trend of the window that no longer holds is not reported; a per-equipment threshold applies to that buffer only', () => {
    // The tile buffer storage stepped up by ≈ 14 % early in the hour (+11 %/h over the window) and has been level since.
    const dry = finding('F-BUFFER-TREND', 'F-BUF');
    expect(dry.status).toBe('clear');
    expect(dry.title).toBe('Tile buffer storage levelled off after a rise');
    expect(dry.explanation).toMatch(/slope \+1\d\.\d %\/h .* rising faster than the 5\.0 %\/h threshold over the window \(buffer storage\), but it has levelled off: \+0\.\d %\/h over the last 15 min/);
    expect(dry.explanation).toMatch(/The rise no longer holds, so no time to full is extrapolated from it\./);
    expect(measurement(dry, 'Level trend (recent)')).toMatchObject({ unit: '%/h', window: { from: s.minute - 15, to: s.minute } });
    expect(measurement(dry, 'Time to full at this trend')).toBeUndefined();
    // With a 1 %/h threshold on this buffer even the slow creep of the last 15 min counts: reported, as information.
    const low = finding('F-BUFFER-TREND', 'F-BUF', { values: { 'F-BUFFER-TREND.slopePct@F-BUF': 1 } });
    expect(low.status).toBe('fired');
    expect(low.severity).toBe('info');
    expect(low.explanation).toMatch(/Ahead of the kiln a full buffer is normal balancing/);
    expect(low.next).toBeNull();
    expect(finding('F-BUFFER-TREND', 'F-BUF', { values: { 'F-BUFFER-TREND.slopePct@D-SILO': 1 } }).status).toBe('clear');
  });
});

describe('missing, stale and bad signals (fixture sources)', () => {
  it('a stale spray-dryer powder flow: the powder chain and both stage 1–2 balances are not evaluated, naming it', () => {
    const source = fixtureSource({ 'D-TWR.powder_flow': { quality: 'stale', timestamp: s.minute - 20, note: 'Feed stale — last value received' } });
    for (const [ruleId, id] of [
      ['F-POWDER-STARVATION', 'D-SILO'],
      ['F-BALANCE', 'D-SILO'],
      ['F-BALANCE', 'C-SLIP'],
    ]) {
      const f = finding(ruleId, id, { source });
      expect(f.status, f.key).toBe('insufficient-data');
      expect(f.staleSignals.map((x) => x.signalId)).toEqual(['D-TWR.powder_flow']);
      expect(f.explanation).toMatch(/^Not evaluated — requires D-TWR\.powder_flow \(Powder output\): not current — last value \d\d:\d\d/);
      expect(f.next).toMatch(/data feed \(PLC \/ gateway link\) of D-TWR/);
      expect(f.measurements).toEqual([]);
    }
    // Rules that do not read it still run.
    expect(finding('F-BUFFER-TREND', 'D-SILO', { source }).status).toBe('clear');
  });

  it('a bad silo level stops every rule that reads it; a missing press state stops the powder chain', () => {
    const bad = fixtureSource({ 'D-SILO.level': { quality: 'bad', note: 'Bad quality flag from the source' } });
    for (const [ruleId, id] of [
      ['F-BUFFER-TREND', 'D-SILO'],
      ['F-POWDER-STARVATION', 'D-SILO'],
      ['F-STARVE', 'E-PRS1'],
      ['F-BLOCK', 'D-TWR'],
    ]) {
      const f = finding(ruleId, id, { source: bad });
      expect(f.status, f.key).toBe('insufficient-data');
      expect(f.missingSignals.find((m) => m.signalId === 'D-SILO.level')?.reason, f.key).toMatch(/^bad quality flag/);
    }
    const missing = fixtureSource({ 'E-PRS2.state': { quality: 'missing', value: null, timestamp: null, note: 'No samples' } });
    const f = finding('F-POWDER-STARVATION', 'D-SILO', { source: missing });
    expect(f.status).toBe('insufficient-data');
    expect(f.missingSignals.map((m) => m.signalId)).toEqual(['E-PRS2.state']);
    expect(f.missingSignals[0].reason).toMatch(/^no current value/);
    const stale = fixtureSource({ 'CV-SORT.outfeed_buffer_level': { quality: 'stale', timestamp: s.minute - 15 } });
    expect(finding('F-DOWNSTREAM-CONSTRAINT', 'CV-SORT', { source: stale }).staleSignals.map((x) => x.signalId)).toEqual(['CV-SORT.outfeed_buffer_level']);
  });

  it('a level history with gaps gives insufficient-data from the rule itself; an unusable optional signal only lowers the confidence', () => {
    const gaps = fixtureSource({}, { 'D-SILO.level': (x) => ({ ...x, v: x.v.map((v, i) => (i % 2 ? null : v)), q: x.q?.map((q, i) => (i % 2 ? 'missing' : q)) }) });
    const f = finding('F-BUFFER-TREND', 'D-SILO', { source: gaps });
    expect(f.status).toBe('insufficient-data');
    expect(f.missingSignals).toHaveLength(1);
    expect(f.missingSignals[0].signalId).toBe('D-SILO.level');
    expect(f.missingSignals[0].reason).toMatch(/^30 usable minute samples in the last 60 min — /);
    expect(f.explanation).toMatch(/^Not evaluated — a level trend needs the minute history of D-SILO\.level/);
    const optional = fixtureSource({ 'D-TWR.state': { quality: 'stale', timestamp: s.minute - 30 } });
    const g = finding('F-BUFFER-TREND', 'D-SILO', { source: optional });
    expect(g.status).toBe('clear');
    expect(g.confidence).toBe('medium');
    expect(g.staleSignals).toEqual([{ signalId: 'D-TWR.state', name: 'Machine state', since: s.minute - 30, optional: true }]);
  });
});

describe('spray dryer stop', () => {
  let t0 = 0;
  let sc: ScenarioActivation;
  beforeAll(() => {
    t0 = s.minute;
    sc = activateScenario(s, { kind: 'machine-stop', equipmentId: 'D-TWR', end: null, label: 'Spray dryer breakdown' });
    advance(s, t0 + 60);
  });
  afterAll(() => clearScenario(s, sc.id));

  it('F-BUFFER-TREND: the powder silos fall faster than 5 %/h, with the time to empty by linear extrapolation — in % only', () => {
    const f = finding('F-BUFFER-TREND', 'D-SILO');
    expect(f.status).toBe('fired');
    expect(f.subject).toBe('BUF-SILO');
    expect(f.title).toMatch(/^Powder silos falling \d+(\.\d)? %\/h — empty in ≈ \d+ h \d\d min$/);
    expect(measurement(f, 'Level trend')!.value as number).toBeLessThan(-5);
    const eta = measurement(f, 'Time to empty at this trend')!;
    expect(eta.unit).toBe('min');
    expect(eta.value as number).toBeGreaterThan(120);
    // Beyond the 2 h warning horizon: information (F-BALANCE carries the warning).
    expect(f.severity).toBe('info');
    expect(f.explanation).toMatch(/linear extrapolation of the level trend, not a forecast/);
    expect(f.explanation).toMatch(/Spray dryer tower \(D-TWR\), filling it: D-TWR stopped \(Simulated breakdown \(scenario\) since \d\d:\d\d\)/);
    expect(f.next).toMatch(/^Restore the supply from Spray dryer tower \(D-TWR\) before the powder silos \(D-SILO\.level\) run empty/);
    expect(f.firstSeen!).toBeGreaterThanOrEqual(t0 - 1);
    expect(f.chartRef).toBe(CHART.buffer('D-SILO.level'));
    expectNoBulkQuantity(f);
  });

  it('F-BALANCE: no inflow against the powder the presses draw, in t/h, sustained over the window', () => {
    const f = finding('F-BALANCE', 'D-SILO');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('warning');
    expect(measurement(f, 'Inflow')).toMatchObject({ value: 0, unit: 't/h' });
    expect(measurement(f, 'Outflow')!.value as number).toBeGreaterThan(5);
    expect(measurement(f, 'Net flow')!.value as number).toBeLessThan(-5);
    expect(measurement(f, 'Draining in every block for')!.value as number).toBeGreaterThanOrEqual(30);
    expect(f.title).toMatch(/^Powder silos: inflow below outflow by [\d.]+ t\/h$/);
    expect(f.explanation).toMatch(/in every 10-min block since \d\d:\d\d/);
    expect(f.explanation).toMatch(/Level signal: D-SILO\.level −[\d.]+ %\/h/);
    expectNoBulkQuantity(f);
  });

  it('the presses still draw from stocked silos: no press starvation, the chain holds two of three conditions', () => {
    for (const p of PRESSES) expect(finding('F-STARVE', p).status, p).toBe('clear');
    const f = finding('F-POWDER-STARVATION', 'D-SILO');
    expect(f.status).toBe('clear');
    expect(f.explanation).toMatch(/only spray dryer output below normal and silo falling \/ low hold/);
    expect(measurement(f, 'E-PRS1 short of powder')!.value).toBe(0);
  });
});

describe("the brief's powder chain", () => {
  let t0 = 0;
  let sc: ScenarioActivation;
  beforeAll(() => {
    t0 = s.minute;
    // A low silo to keep the test short; the spray dryer at 40 % then cannot keep up with the presses.
    s.buffers['BUF-SILO'] = 0.03 * SILO_CAPACITY;
    sc = activateScenario(s, { kind: 'reduced-rate', equipmentId: 'D-TWR', factor: 0.4, end: null, label: 'Spray dryer at 40 %' });
    advance(s, t0 + 60);
  });
  afterAll(() => {
    clearScenario(s, sc.id);
    s.buffers['BUF-SILO'] = 0.6 * SILO_CAPACITY;
  });

  it("F-POWDER-STARVATION: 'Potential press starvation' with the three evidence items in one window and aligned times", () => {
    const f = finding('F-POWDER-STARVATION', 'D-SILO');
    expect(f.status).toBe('fired');
    expect(f.title).toBe('Potential press starvation');
    expect(f.severity).toBe('warning');
    expect(f.classification).toBe('rule-based');
    expect(f.window).toEqual({ from: s.minute - 60, to: s.minute });
    const flow = measurement(f, 'Spray dryer powder output (mean)')!;
    expect(flow).toMatchObject({ unit: 't/h', window: f.window });
    expect(flow.value as number).toBeLessThan(measurement(f, 'Below-normal limit')!.value as number);
    expect(measurement(f, 'Powder silo level now')!.value as number).toBeLessThanOrEqual(10);
    for (const p of PRESSES) expect(measurement(f, `${p} short of powder`)!.value as number, p).toBeGreaterThanOrEqual(10);
    // The three evidence items, in order, each ending now.
    const items = f.evidence.filter((e) => /^[123] · /.test(e.label));
    expect(items.map((e) => e.ref)).toEqual(['D-TWR.powder_flow', 'D-SILO.level', ...PRESSES.map((p) => `${p}.state`)]);
    for (const e of items) expect(e.window!.to, e.label).toBe(s.minute);
    expect(f.explanation).toMatch(/\(1\) Spray dryer: D-TWR\.powder_flow averaged [\d.]+ t\/h over \d\d:\d\d–\d\d:\d\d — below the [\d.]+ t\/h limit \(85 % of its planned [\d.]+ t\/h; ideal [\d.]+ t\/h\), below since \d\d:\d\d\./);
    expect(f.explanation).toMatch(/\(2\) Powder silos: D-SILO\.level [\d.]+ % at \d\d:\d\d → [\d.]+ % at \d\d:\d\d, trend −[\d.]+ %\/h — low \(at or below 10 %\) since \d\d:\d\d\./);
    expect(f.explanation).toMatch(/\(3\) Presses: E-PRS1 short of powder \d+ min from \d\d:\d\d, E-PRS2 short of powder \d+ min from \d\d:\d\d and E-PRS3/);
    // Together since the latest of the three starts.
    expect(f.firstSeen!).toBeGreaterThanOrEqual(t0);
    expect(f.firstSeen!).toBeLessThanOrEqual(s.minute - 10);
    expect(f.explanation).toContain(`together since ${formatClock(f.firstSeen!)}`);
    expect(f.explanation).toMatch(/An association in time across the chain — the powder supply is the likely source, to investigate\./);
    expect(f.next).toMatch(/^Check the spray dryer \(D-TWR\): its powder output [\d.]+ t\/h against [\d.]+ t\/h planned/);
    expectNoBulkQuantity(f);
  });

  it('F-STARVE on each press names the low silo and the spray dryer producing below the draw (tile-equivalents, not tiles/h)', () => {
    for (const p of PRESSES) {
      const f = finding('F-STARVE', p);
      expect(f.status, p).toBe('fired');
      expect(f.severity).toBe('warning');
      expect(f.subject).toBe('BUF-SILO');
      expect(f.title).toMatch(/^Potential starvation of Hydraulic press \d — powder silos low$/);
      expect(f.explanation).toMatch(/while the powder silos \(D-SILO\.level\) are at [\d.]+ % — at or below 10 %/);
      expect(f.explanation).toMatch(/Spray dryer tower \(D-TWR\) is producing [\d,]+ tile-eq\/h over the window/);
      expect(f.explanation).toMatch(/the upstream supply is the likely source, to investigate/);
      expect(f.next).toMatch(/^Check the output of Spray dryer tower \(D-TWR\) — [\d,]+ against [\d,]+ tile-eq\/h drawn/);
      expect(f.evidence.map((e) => e.ref)).toEqual(expect.arrayContaining(['D-SILO.level', `${p}.state`, 'D-TWR.rate']));
    }
  });
});

describe('sorting bottleneck (stage 8: kiln outfeed)', () => {
  let sc: ScenarioActivation;
  beforeAll(() => {
    sc = activateScenario(s, { kind: 'bottleneck', stage: 'SORT', factor: 0.55, end: null, label: 'Sorting slowdown' });
    advance(s, s.minute + 40);
  });
  afterAll(() => {
    clearScenario(s, sc.id);
    advance(s, s.minute + 20);
  });

  it("F-DOWNSTREAM-CONSTRAINT: 'Possible downstream constraint at sorting', explaining the cooling-buffer mapping and the missing polishing stage", () => {
    const f = finding('F-DOWNSTREAM-CONSTRAINT', 'CV-SORT');
    expect(f.status).toBe('fired');
    expect(f.title).toBe('Possible downstream constraint at sorting');
    expect(f.severity).toBe('serious');
    expect(measurement(f, 'Sorting rate')!.value as number).toBeLessThan(measurement(f, 'Sorting below-rate limit')!.value as number);
    expect(measurement(f, 'Kiln outfeed level now')!.value as number).toBeGreaterThanOrEqual(80);
    expect(measurement(f, 'Kiln rate')!.value as number).toBeGreaterThan(0);
    expect(measurement(f, 'Kiln rate')!.value as number).toBeLessThan(measurement(f, 'Kiln ideal rate')!.value as number);
    expect(f.explanation).toMatch(/the cooling-buffer stage \(stage 8\) is the kiln outfeed roller storage \(BUF-KOUT, read by CV-SORT\.outfeed_buffer_level\)/);
    expect(f.explanation).toMatch(/The line has no polishing \/ rectification stage \(stage 9\)/);
    expect(f.explanation).toMatch(/a sorting-line slowdown → kiln outfeed fills → kiln limited by its outfeed/);
    expect(f.explanation).toMatch(/the sorting line is the likely constraint, to investigate/);
    expect(f.evidence.filter((e) => /^[123] · /.test(e.label)).map((e) => e.ref)).toEqual(['I-SORT.rate', 'CV-SORT.outfeed_buffer_level', 'H-KILN.rate']);
    expect(f.next).toMatch(/^Check the sorting line \(CV-SORT and I-SORT\)/);
    // Stage 8 and the plant view show it once.
    const stage = findingsFor(s, { kind: 'stage', stageNo: 8 }, { rules: FLOW_RULES }).filter((x) => x.key === f.key);
    expect(stage).toHaveLength(1);
  });

  it('F-BLOCK at the kiln (serious) and a rising kiln outfeed', () => {
    const f = finding('F-BLOCK', 'H-KILN');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('serious');
    expect(f.title).toMatch(/^(Potential b|B)lockage of Single-layer roller kiln — kiln outfeed (high|filling|full)$/);
    expect(f.explanation).toMatch(/This is the kiln, the line constraint/);
    expect(f.next).toMatch(/^Check the sorting line downstream of the kiln/);
    const t = finding('F-BUFFER-TREND', 'CV-SORT');
    expect(t.status).toBe('fired');
    // Full by now: said as full (not "rising"), and the check is to restore the take-away — not "before it is full".
    expect(t.title).toMatch(/^Kiln outfeed full — rose \d+ %\/h over 60 min$/);
    expect(t.explanation).toMatch(/rising faster than the 30\.0 %\/h threshold \(conveyor accumulation\)\. It is already full\./);
    expect(t.explanation).toMatch(/Behind the kiln a full buffer blocks Single-layer roller kiln \(H-KILN\) — the kiln, the line constraint/);
    expect(t.next).toBe('Restore the take-away at Diverters & grade stackers (I-SORT): the kiln outfeed (CV-SORT.outfeed_buffer_level) is already full.');
  });
});

describe('powder feed conveyor stop', () => {
  let sc: ScenarioActivation;
  beforeAll(() => {
    s.buffers['BUF-SILO'] = 0.5 * SILO_CAPACITY;
    sc = activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'D-BELT', end: null, label: 'Powder feed conveyor stop' });
    advance(s, s.minute + 30);
  });
  afterAll(() => {
    clearScenario(s, sc.id);
    advance(s, s.minute + 20);
  });

  it('presses cut off from stocked silos are not starved through the buffer: the stopped transfer is named', () => {
    const f = finding('F-STARVE', 'E-PRS1');
    expect(f.status).toBe('clear');
    expect(f.title).toBe('Hydraulic press 1: waiting, but not on an empty buffer');
    expect(f.explanation).toMatch(/so the wait is not the buffer running empty\. D-BELT \(Powder feed conveyor\) is stopped \(Simulated conveyor stop \(scenario\) since \d\d:\d\d\): the transfer is cut/);
  });

  it('F-BLOCK at the spray dryer: still producing into rising silos while the transfer is stopped (ahead of the kiln: information)', () => {
    const f = finding('F-BLOCK', 'D-TWR');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('info');
    expect(f.title).toBe('Potential blockage of Spray dryer tower — powder silos filling');
    expect(f.explanation).toMatch(/^D-TWR \(running[^)]*\) made [\d,]+ tile-eq\/h over the window/);
    expect(f.explanation).toMatch(/the transfer D-BELT stopped \(Simulated conveyor stop \(scenario\)/);
    expect(f.explanation).toMatch(/works ahead of the kiln with spare capacity: no line output is lost while it waits/);
    expect(f.next).toMatch(/^Restore the take-away at D-BELT \(Simulated conveyor stop \(scenario\)\)/);
    expectNoBulkQuantity(f);
  });

  it('F-STARVE at the dryer: the collector runs empty while the presses are themselves waiting — held further upstream', () => {
    const f = finding('F-STARVE', 'F-DRY');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('warning');
    expect(f.explanation).toMatch(/Pressing \(E-PRS1, E-PRS2, E-PRS3\) is itself waiting for material .*: the line is held further upstream/);
    expect(f.next).toMatch(/^Follow the line upstream of pressing/);
  });
});

describe('printer breakdown starves the kiln', () => {
  let t0 = 0;
  let sc: ScenarioActivation;
  beforeAll(() => {
    t0 = s.minute;
    sc = activateScenario(s, { kind: 'machine-stop', equipmentId: 'G-INK', end: null, label: 'Printer breakdown' });
    advance(s, t0 + 45);
  });
  afterAll(() => clearScenario(s, sc.id));

  it('F-STARVE at the kiln (serious) names the kiln infeed and the stopped printer; the infeed trend is serious too', () => {
    const f = finding('F-STARVE', 'H-KILN');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('serious');
    expect(f.title).toBe('Potential starvation of Single-layer roller kiln — kiln infeed low');
    expect(f.explanation).toMatch(/the kiln infeed \(CV-KIN\.infeed_buffer_level\) is at [\d.]+ %/);
    expect(f.explanation).toMatch(/Digital inkjet decoration \(G-INK\) is not producing: G-INK stopped \(Simulated breakdown \(scenario\) since \d\d:\d\d\)/);
    expect(f.explanation).toMatch(/The kiln is the line constraint: every minute it waits is line output lost\./);
    expect(f.next).toMatch(/^Restore G-INK first \(Simulated breakdown \(scenario\) since \d\d:\d\d\) — see its stop event; every minute counts at the kiln\./);
    expect(f.firstSeen!).toBeGreaterThan(t0);
    expect(measurement(f, 'Short of material with the buffer low')!.value as number).toBeGreaterThanOrEqual(DEFAULT_EVENT_RULES.starvedMinutesConstraint);
    const t = finding('F-BUFFER-TREND', 'CV-KIN');
    expect(t.status).toBe('fired');
    expect(t.severity).toBe('serious');
    expect(t.explanation).toMatch(/Ahead of the kiln an empty buffer starves Single-layer roller kiln \(H-KILN\) — the kiln, the line constraint/);
  });

  it('behind the kiln, sorting waiting on the starved kiln is information: held further upstream', () => {
    const f = finding('F-STARVE', 'I-SORT');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('info');
    expect(f.explanation).toMatch(/waiting here loses no line output/);
  });

  it('once the printer runs again, what held over the window gives way to what holds now: the infeed refills, the kiln is fed', () => {
    clearScenario(s, sc.id);
    const t1 = s.minute;
    advance(s, t1 + 6);
    // The infeed is still low, but refilling: no time to empty is extrapolated from the 60-min fall.
    const t = finding('F-BUFFER-TREND', 'CV-KIN');
    expect(t.status).toBe('clear');
    expect(t.title).toBe('Kiln infeed refilling after a fall');
    expect(t.explanation).toMatch(/but it is rising again: \+[\d.]+ %\/h over the last 5 min \(\d\d:\d\d–\d\d:\d\d\), from its lowest 0\.0 % at \d\d:\d\d/);
    expect(t.resolvedAt!).toBeGreaterThanOrEqual(t1);
    expect(measurement(t, 'Time to empty at this trend')).toBeUndefined();
    // The kiln has not been short of material for the last 5 min, with the infeed still under 10 %.
    const f = finding('F-STARVE', 'H-KILN');
    expect(f.status).toBe('clear');
    expect(f.title).toBe('Single-layer roller kiln: starvation ended');
    expect(measurement(f, 'Kiln infeed level')!.value as number).toBeLessThanOrEqual(10);
    expect(f.explanation).toMatch(/, the last at \d\d:\d\d — none in the last 5 min \(\d\d:\d\d–\d\d:\d\d; H-KILN running since \d\d:\d\d\), so the starvation is not reported now\./);
    expect(f.resolvedAt!).toBeGreaterThanOrEqual(t1);
    expect(f.resolvedAt!).toBeLessThanOrEqual(s.minute - 5);
  });
});

describe('data feed loss at the spray dryer', () => {
  beforeAll(() => {
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'D-TWR', end: null, label: 'Spray dryer PLC link lost' });
    advance(s, s.minute + 3);
  });

  it('the powder chain and the silo balance are not evaluated: the spray dryer signals are not current', () => {
    for (const [ruleId, id] of [
      ['F-POWDER-STARVATION', 'D-SILO'],
      ['F-BALANCE', 'D-SILO'],
      ['F-BLOCK', 'D-TWR'],
    ]) {
      const f = finding(ruleId, id);
      expect(f.status, f.key).toBe('insufficient-data');
      expect(f.staleSignals.map((x) => x.signalId)).toEqual(expect.arrayContaining([expect.stringMatching(/^D-TWR\./)]));
      expect(f.explanation).toMatch(/^Not evaluated — requires D-TWR\./);
      expect(f.next).toMatch(/data feed \(PLC \/ gateway link\) of D-TWR/);
    }
    // The silo level itself is still current: its trend is evaluated.
    expect(finding('F-BUFFER-TREND', 'D-SILO').status).not.toBe('insufficient-data');
  });
});
