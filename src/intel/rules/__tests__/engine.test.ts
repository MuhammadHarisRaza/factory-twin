/**
 * Rule engine core (src/intel/rules): required signals are validated before a rule runs — missing, not modelled,
 * unavailable, unknown, bad and stale signals give 'insufficient-data' naming each one and why; findings are
 * completed (key, classification, provenance, first / last seen), deduplicated and ordered; findingsFor is
 * memoised per state, minute and thresholds version; thresholds resolve per equipment → global → mirrored event
 * rule → default. Fixture rules and a fixture TelemetrySource over one pre-rolled simulation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EVENT_RULES } from '../../../model/plant';
import type { TelemetrySample, TelemetrySource } from '../../../model/telemetry';
import { advance, createSim, type SimState } from '../../../sim/engine';
import { simulatedSource } from '../../../sim/telemetry';
import {
  CLASSIFICATION_LABEL,
  RULE_BY_ID,
  RULE_PARAM_DEFAULTS,
  RULES,
  buildContext,
  checkSignals,
  evaluate,
  findingKey,
  findingsFor,
  paramOf,
  plantFindings,
  resolveParam,
  rulesFor,
  useRuleThresholds,
  type RuleDef,
  type RuleEvaluation,
  type RuleScope,
} from '..';

const START = 2 * 1440 + 240;
const s = createSim(41, START);
const EQ: RuleScope = { kind: 'equipment', equipmentId: 'E-PRS2' };

/** A test rule (no parameters) that applies everywhere and reads the given signals. */
function fixtureRule(id: string, required: string[], evaluate: RuleDef['evaluate'], optional: string[] = []): RuleDef {
  return {
    id,
    family: 'production',
    classification: 'rule-based',
    title: `Fixture ${id}`,
    description: 'Test rule',
    appliesTo: () => true,
    requiredSignals: () => required,
    optionalSignals: () => optional,
    params: [],
    evaluate,
  };
}

/** The simulated source with some readings replaced (what a gateway with problems would deliver). */
function fixtureSource(overrides: Record<string, Partial<TelemetrySample>>): TelemetrySource<SimState> {
  return {
    kind: 'simulated',
    read: (st, id) => (overrides[id] ? { ...simulatedSource.read(st, id), ...overrides[id] } : simulatedSource.read(st, id)),
    series: simulatedSource.series,
    states: simulatedSource.states,
  };
}

const fired = (o: Partial<RuleEvaluation> = {}): RuleEvaluation => ({ status: 'fired', title: 'Fired', explanation: 'Evidence', ...o });

afterEach(() => useRuleThresholds.getState().reset());

describe('signal validation', () => {
  it('gives insufficient-data naming each missing, not-modelled, unavailable, unknown, bad and stale signal — and never runs the rule', () => {
    const now = s.minute;
    const source = fixtureSource({
      'E-PRS2.count_total': { quality: 'stale', timestamp: now - 20, note: 'Feed stale since 09:40 — last value received' },
      'E-PRS2.state': { quality: 'bad', note: 'Bad quality flag from the source' },
      // Good quality but four minutes old: not fresh against the 60 s update interval.
      'E-PRS2.rate': { quality: 'good', timestamp: now - 4 },
      'E-PRS2.cycle_time': { quality: 'missing', value: null, timestamp: null, note: 'No samples' },
    });
    const run = vi.fn(() => fired());
    const required = ['E-PRS2.count_total', 'E-PRS2.state', 'E-PRS2.rate', 'E-PRS2.cycle_time', 'H-KILN.temp_firing', 'A-SUB.active_power', 'NOPE.signal'];
    const [f] = evaluate([fixtureRule('T-VALID', required, run)], buildContext(s, { source }), EQ);
    expect(run).not.toHaveBeenCalled();
    expect(f.status).toBe('insufficient-data');
    expect(f.severity).toBe('info');
    expect(f.confidence).toBe('low');
    expect(f.explanation.startsWith('Not evaluated — requires ')).toBe(true);
    for (const id of required) expect(f.explanation).toContain(id);
    const reason = Object.fromEntries(f.missingSignals.map((m) => [m.signalId, m.reason]));
    expect(Object.keys(reason).sort()).toEqual(['A-SUB.active_power', 'E-PRS2.cycle_time', 'E-PRS2.state', 'H-KILN.temp_firing', 'NOPE.signal']);
    expect(reason['E-PRS2.state']).toMatch(/^bad quality flag/);
    expect(reason['E-PRS2.cycle_time']).toMatch(/^no current value/);
    expect(reason['H-KILN.temp_firing']).toMatch(/^not modelled in this simulation/);
    expect(reason['A-SUB.active_power']).toMatch(/^unavailable — Energy metering/);
    expect(reason['NOPE.signal']).toBe('not in the signal catalogue');
    expect(f.missingSignals.find((m) => m.signalId === 'E-PRS2.state')?.name).toBe('Machine state');
    expect(f.staleSignals).toEqual([
      { signalId: 'E-PRS2.count_total', name: 'Output counter', since: now - 20 },
      { signalId: 'E-PRS2.rate', name: 'Output rate', since: now - 4 },
    ]);
    expect(f.explanation).toMatch(/E-PRS2\.rate \(Output rate\): not current — last value \d\d:\d\d, expected every 1 min/);
    expect(f.next).toMatch(/data feed \(PLC \/ gateway link\) of E-PRS2/);
    expect(f.next).toMatch(/quality flag of E-PRS2\.state/);
    expect(f.next).toMatch(/Map H-KILN\.temp_firing, A-SUB\.active_power and NOPE\.signal to a real signal at integration/);
    expect(f.provenance.source).toBe('simulated');
    expect(f.firstSeen).toBeNull();
    expect(f.lastSeen).toBeNull();
  });

  it('accepts current simulated signals, including a process value with no value while the machine is not producing', () => {
    const ctx = buildContext(s);
    const c = checkSignals(ctx, ['H-KILN.count_total', 'H-KILN.state', 'H-KILN.zone3_temp_pv', 'CV-SORT.outfeed_buffer_level', 'E-PRS1.cycle_time', 'H-KILN.alarm']);
    expect(c.missing).toEqual([]);
    expect(c.stale).toEqual([]);
    const src = fixtureSource({ 'E-PRS1.cycle_time': { value: null, quality: 'good', note: 'No value: the machine is not producing' } });
    expect(checkSignals(buildContext(s, { source: src }), ['E-PRS1.cycle_time']).missing).toEqual([]);
  });

  it('flags a stale feed of the simulation (signal-loss) as not current', () => {
    const feed = s.feeds['H-KILN'];
    s.feeds['H-KILN'] = { status: 'stale', since: s.minute - 10 };
    try {
      const c = checkSignals(buildContext(s), ['H-KILN.count_total', 'H-KILN.state']);
      expect(c.stale.map((x) => x.signalId)).toEqual(['H-KILN.count_total', 'H-KILN.state']);
      expect(c.reasons['H-KILN.state']).toMatch(/not current — last value/);
    } finally {
      s.feeds['H-KILN'] = feed;
    }
  });
});

describe('finding completion', () => {
  it('completes a fired finding: key, classification, first / last seen, provenance, chart', () => {
    const ctx = buildContext(s);
    const def = fixtureRule('T-FIRE', ['E-PRS1.count_total', 'E-PRS1.state'], () => fired({ subject: 'die', firstSeen: s.minute - 12, chartRef: 'chart:cycle', next: 'Check the die' }));
    const [f] = evaluate([def], ctx, { kind: 'equipment', equipmentId: 'E-PRS1' });
    expect(f).toMatchObject({
      ruleId: 'T-FIRE',
      status: 'fired',
      severity: 'warning',
      classification: 'rule-based',
      key: findingKey('T-FIRE', { kind: 'equipment', equipmentId: 'E-PRS1' }, 'die'),
      firstSeen: s.minute - 12,
      lastSeen: s.minute,
      chartRef: 'chart:cycle',
      subject: 'die',
      next: 'Check the die',
      confidence: 'high',
    });
    expect(f.key).toBe('T-FIRE|eq:E-PRS1|die');
    expect(f.provenance).toMatchObject({ source: 'simulated', signals: ['E-PRS1.count_total', 'E-PRS1.state'] });
    expect(f.provenance.note).toMatch(/^Simulated data — .*not plant telemetry\.$/);
    expect(f.provenance.scenarioId).toBeUndefined();
    expect(CLASSIFICATION_LABEL[f.classification]).toBe('Rule-based');
    expect(CLASSIFICATION_LABEL.statistical).toBe('Statistical');
  });

  it('lowers the confidence for uncertain or unusable optional signals and lists them as optional', () => {
    const source = fixtureSource({
      'E-PRS1.state': { quality: 'uncertain' },
      'E-PRS3.cycle_time': { quality: 'stale', timestamp: s.minute - 30 },
    });
    const def = fixtureRule('T-OPT', ['E-PRS1.count_total', 'E-PRS1.state'], () => fired(), ['E-PRS3.cycle_time']);
    const [f] = evaluate([def], buildContext(s, { source }), { kind: 'equipment', equipmentId: 'E-PRS1' });
    expect(f.status).toBe('fired');
    expect(f.confidence).toBe('low');
    expect(f.confidenceNote).toMatch(/E-PRS1\.state has uncertain quality/);
    expect(f.confidenceNote).toMatch(/Evaluated without optional context: E-PRS3\.cycle_time/);
    expect(f.staleSignals).toEqual([{ signalId: 'E-PRS3.cycle_time', name: 'Cycle time', since: s.minute - 30, optional: true }]);
  });

  it('turns a rule that throws into insufficient-data instead of breaking the page', () => {
    const def = fixtureRule('T-THROW', ['E-PRS1.state'], () => {
      throw new Error('division by nothing');
    });
    const [f] = evaluate([def], buildContext(s), EQ);
    expect(f.status).toBe('insufficient-data');
    expect(f.explanation).toMatch(/could not be computed \(division by nothing\)/);
  });
});

describe('dedupe and ordering', () => {
  it('keeps one finding per key and orders fired by severity then recency, then insufficient-data, then clear', () => {
    const many = fixtureRule('T-MANY', ['E-PRS1.state'], () => [
      { status: 'clear', title: 'old resolution', explanation: '-', subject: 'a', resolvedAt: s.minute - 50 },
      { status: 'clear', title: 'recent resolution', explanation: '-', subject: 'a2', resolvedAt: s.minute - 5 },
      fired({ subject: 'b', firstSeen: s.minute - 100 }),
      fired({ subject: 'c', severity: 'critical', firstSeen: s.minute - 300 }),
      fired({ subject: 'd', firstSeen: s.minute - 20 }),
      // Same key as 'b', more severe: the dedupe keeps this one.
      fired({ subject: 'b', severity: 'serious', firstSeen: s.minute - 90, title: 'b serious' }),
      { status: 'insufficient-data', title: 'short history', explanation: 'Not evaluated — short history', subject: 'e' },
    ]);
    const blocked = fixtureRule('T-BLOCKED', ['NOPE.signal'], () => fired());
    const out = evaluate([many, blocked], buildContext(s), EQ);
    expect(out.map((f) => `${f.ruleId}:${f.subject ?? ''}`)).toEqual(['T-MANY:c', 'T-MANY:b', 'T-MANY:d', 'T-BLOCKED:', 'T-MANY:e', 'T-MANY:a2', 'T-MANY:a']);
    expect(out.find((f) => f.subject === 'b')?.title).toBe('b serious');
    expect(new Set(out.map((f) => f.key)).size).toBe(out.length);
  });

  it('gives an equipment finding the same key whether it is asked for the equipment, its stage or the plant', () => {
    const eq = findingsFor(s, EQ).map((f) => f.key);
    const stage = findingsFor(s, { kind: 'stage', stageNo: 3 });
    const plant = plantFindings(s);
    expect(eq.length).toBeGreaterThan(0);
    for (const k of eq) {
      expect(stage.filter((f) => f.key === k)).toHaveLength(1);
      expect(plant.findings.filter((f) => f.key === k)).toHaveLength(1);
    }
    expect(new Set(plant.findings.map((f) => f.key)).size).toBe(plant.findings.length);
    // Equipment findings of a stage view belong to the stage's equipment (stage-level rules keep the stage scope).
    for (const f of stage) if (f.scope.kind === 'equipment') expect(['E-PRS1', 'E-PRS2', 'E-PRS3', 'E-COL']).toContain(f.scope.equipmentId);
    expect(stage.every((f) => f.scope.kind !== 'plant')).toBe(true);
    // Summary counts add up; top holds fired findings only.
    const { summary, top } = plant;
    expect(summary.total).toBe(plant.findings.length);
    expect(summary.byStatus.fired + summary.byStatus.clear + summary.byStatus['insufficient-data']).toBe(summary.total);
    expect(Object.values(summary.byFamily).reduce((n, r) => n + r.fired + r.clear + r['insufficient-data'], 0)).toBe(summary.total);
    expect(Object.values(summary.bySeverity).reduce((a, b) => a + b, 0)).toBe(summary.byStatus.fired);
    expect(top.every((f) => f.status === 'fired')).toBe(true);
  });
});

describe('thresholds', () => {
  it('registers every rule parameter with its default; mirrored parameters equal the configured event rule defaults', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(4);
    for (const d of RULES)
      for (const p of d.params) {
        expect(RULE_PARAM_DEFAULTS[`${d.id}.${p.key}`], `${d.id}.${p.key}`).toBe(p.default);
        if (p.min != null) expect(p.default, `${d.id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
        if (p.max != null) expect(p.default, `${d.id}.${p.key}`).toBeLessThanOrEqual(p.max);
        if (p.mirrors) {
          const raw = DEFAULT_EVENT_RULES[p.mirrors.rule];
          expect(p.default, `${d.id}.${p.key}`).toBeCloseTo(p.mirrors.map ? p.mirrors.map(raw) : raw, 9);
        }
      }
    expect(RULE_PARAM_DEFAULTS['P-OUTPUT.targetShare']).toBe(DEFAULT_EVENT_RULES.belowRateFactor);
    expect(RULE_PARAM_DEFAULTS['P-COUNTER.minutes']).toBe(DEFAULT_EVENT_RULES.counterInactiveMinutes);
    expect(RULE_PARAM_DEFAULTS['P-CYCLE.minMinutes']).toBe(DEFAULT_EVENT_RULES.belowRateMinutes);
  });

  it('resolves per equipment → global → mirrored event rule → default, and rejects unknown keys and out-of-range values', () => {
    const rules = { ...DEFAULT_EVENT_RULES, belowRateFactor: 0.8 };
    expect(resolveParam({}, 'P-OUTPUT', 'targetShare', 'E-PRS2')).toEqual({ value: 0.85, source: 'default' });
    expect(resolveParam({}, 'P-OUTPUT', 'targetShare', 'E-PRS2', rules)).toEqual({ value: 0.8, source: 'event-rule' });
    expect(paramOf({}, 'P-CYCLE', 'tolerance', null, rules)).toBeCloseTo(0.25, 9);
    const values = { 'P-OUTPUT.targetShare': 0.9, 'P-OUTPUT.targetShare@E-PRS2': 0.95 };
    expect(resolveParam(values, 'P-OUTPUT', 'targetShare', 'E-PRS2', rules)).toEqual({ value: 0.95, source: 'equipment' });
    expect(resolveParam(values, 'P-OUTPUT', 'targetShare', 'E-PRS1', rules)).toEqual({ value: 0.9, source: 'global' });
    expect(() => paramOf({}, 'P-OUTPUT', 'nope')).toThrow(/Unknown rule parameter P-OUTPUT\.nope/);
    const store = useRuleThresholds.getState();
    const v0 = store.version;
    expect(store.set('P-OUTPUT.nope', 1)).toBe(false);
    expect(store.set('P-OUTPUT.targetShare', 2)).toBe(false);
    expect(store.set('P-OUTPUT.targetShare', Number.NaN)).toBe(false);
    expect(useRuleThresholds.getState().version).toBe(v0);
    expect(store.set('P-OUTPUT.targetShare@E-PRS2', 0.7)).toBe(true);
    expect(useRuleThresholds.getState().values).toEqual({ 'P-OUTPUT.targetShare@E-PRS2': 0.7 });
    useRuleThresholds.getState().reset('P-OUTPUT.targetShare@E-PRS2');
    expect(useRuleThresholds.getState().values).toEqual({});
  });

  it("remembers overrides in localStorage ('wai.ruleThresholds') and keeps working when storage throws", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) });
    try {
      expect(useRuleThresholds.getState().set('P-COUNTER.minutes', 5)).toBe(true);
      expect(JSON.parse(stored.get('wai.ruleThresholds')!)).toEqual({ 'P-COUNTER.minutes': 5 });
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      });
      expect(useRuleThresholds.getState().set('P-COUNTER.minutes', 6)).toBe(true);
      expect(useRuleThresholds.getState().values['P-COUNTER.minutes']).toBe(6);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('applies an equipment override to that equipment only, and the context follows the configured event rules', () => {
    // A 2 % cycle-time tolerance on press 2 only: press 2 (running ~9 % above target) is reported, press 1 is not.
    useRuleThresholds.getState().set('P-CYCLE.tolerance@E-PRS2', 0.02);
    const p2 = findingsFor(s, EQ).find((f) => f.ruleId === 'P-CYCLE')!;
    const p1 = findingsFor(s, { kind: 'equipment', equipmentId: 'E-PRS1' }).find((f) => f.ruleId === 'P-CYCLE')!;
    expect(p2.status).toBe('fired');
    expect(p2.explanation).toMatch(/\+2\.0 %/);
    expect(p1.status).toBe('clear');
    // Without an override the parameter follows sim.rules (the event-rules editor).
    const rules = s.rules;
    s.rules = { ...rules, belowRateFactor: 0.5 };
    try {
      expect(buildContext(s).param('P-OUTPUT', 'targetShare', 'E-PRS1')).toBe(0.5);
      expect(buildContext(s, { values: { 'P-OUTPUT.targetShare': 0.6 } }).param('P-OUTPUT', 'targetShare', 'E-PRS1')).toBe(0.6);
    } finally {
      s.rules = rules;
    }
  });
});

describe('registry', () => {
  it('lists the production rules and answers which rules apply to a scope', () => {
    expect(['P-OUTPUT', 'P-CYCLE', 'P-COUNTER', 'P-DECLINE'].every((id) => RULE_BY_ID[id])).toBe(true);
    const production = (scope: RuleScope) => rulesFor(scope).filter((d) => d.family === 'production').map((d) => d.id);
    expect(production(EQ)).toEqual(['P-OUTPUT', 'P-CYCLE', 'P-COUNTER', 'P-DECLINE']);
    expect(production({ kind: 'equipment', equipmentId: 'CV-SORT' })).toEqual(['P-COUNTER']);
    expect(production({ kind: 'equipment', equipmentId: 'A-PARK' })).toEqual([]);
    expect(rulesFor({ kind: 'stage', stageNo: 3 }).map((d) => d.id)).toContain('P-CYCLE');
    expect(RULE_BY_ID['P-DECLINE'].classification).toBe('statistical');
    for (const d of RULES) expect(d.classification === 'rule-based' || d.classification === 'statistical').toBe(true);
  });
});

describe('memoisation', () => {
  it('returns the same findings for repeated calls in the same minute and recomputes after a threshold change or a new minute', () => {
    // Last in the file: it advances the shared simulation.
    const t = s;
    const a = findingsFor(t, EQ);
    expect(findingsFor(t, EQ)).toBe(a);
    expect(findingsFor(t, { kind: 'equipment', equipmentId: 'E-PRS1' })).not.toBe(a);
    expect(useRuleThresholds.getState().set('P-CYCLE.tolerance@E-PRS2', 0.5)).toBe(true);
    const b = findingsFor(t, EQ);
    expect(b).not.toBe(a);
    expect(findingsFor(t, EQ)).toBe(b);
    advance(t, t.minute + 1);
    const c = findingsFor(t, EQ);
    expect(c).not.toBe(b);
    expect(findingsFor(t, EQ)).toBe(c);
    // Explicit options are never memoised.
    expect(findingsFor(t, EQ, { values: {} })).not.toBe(findingsFor(t, EQ, { values: {} }));
  });
});
