import { describe, expect, it } from 'vitest';
import { CONVEYOR_IDS, DEFAULT_EVENT_RULES, PROCESS_MACHINES } from '../../model/plant';
import type { EventRules } from '../../model/types';
import { activateScenario, advance, clearScenario, createSim } from '../../sim/engine';
import { EVENT_RULE_DEFS } from '../../sim/events';
import { DEFAULT_START } from '../../sim/time';
import { feedRows, feedSummary } from './feeds';
import { RULE_PARAMS, formatParam, isModified, modifiedCount, parseParam, ruleParams, sharedWith, type RuleKey } from './rules';

describe('event rule parameters', () => {
  it('covers every EventRules field and every threshold named by a rule', () => {
    expect(Object.keys(RULE_PARAMS).sort()).toEqual(Object.keys(DEFAULT_EVENT_RULES).sort());
    for (const d of EVENT_RULE_DEFS) if (d.threshold) expect(ruleParams(d.id).map((p) => p.key)).toContain(d.threshold);
    // Every field is editable from at least one rule.
    const used = new Set(EVENT_RULE_DEFS.flatMap((d) => ruleParams(d.id).map((p) => p.key)));
    expect([...used].sort()).toEqual(Object.keys(DEFAULT_EVENT_RULES).sort());
    expect(ruleParams('R-STOP')).toEqual([]);
    expect(ruleParams('NOPE')).toEqual([]);
  });

  it('accepts every default and round-trips it through the display format', () => {
    for (const key of Object.keys(RULE_PARAMS) as RuleKey[]) {
      const p = RULE_PARAMS[key];
      const text = formatParam(p, DEFAULT_EVENT_RULES[key]);
      const r = parseParam(p, text);
      expect(r, key).toEqual({ ok: true, value: DEFAULT_EVENT_RULES[key] });
    }
    expect(formatParam(RULE_PARAMS.belowRateFactor, 0.85)).toBe('85');
    expect(formatParam(RULE_PARAMS.ioImbalanceMax, 0.015)).toBe('1.5');
    expect(formatParam(RULE_PARAMS.rejectRateMax, 0.05)).toBe('5');
  });

  it('parses display units and rejects out-of-range or invalid input', () => {
    expect(parseParam(RULE_PARAMS.belowRateFactor, '80')).toEqual({ ok: true, value: 0.8 });
    expect(parseParam(RULE_PARAMS.rejectRateMax, '7,5 %')).toEqual({ ok: true, value: 0.075 });
    expect(parseParam(RULE_PARAMS.deteriorationRatio, '2.54')).toEqual({ ok: true, value: 2.5 });
    expect(parseParam(RULE_PARAMS.truckWaitMax, '30.4')).toEqual({ ok: true, value: 30 });
    expect(parseParam(RULE_PARAMS.belowRateFactor, '120').ok).toBe(false);
    expect(parseParam(RULE_PARAMS.belowRateMinutes, '1').ok).toBe(false);
    expect(parseParam(RULE_PARAMS.truckWaitMax, 'abc')).toEqual({ ok: false, error: 'Not a number' });
    expect(parseParam(RULE_PARAMS.truckWaitMax, '')).toEqual({ ok: false, error: 'Enter a value' });
  });

  it('flags modified thresholds and fields shared between rules', () => {
    const rules: EventRules = { ...DEFAULT_EVENT_RULES, truckWaitMax: 40 };
    expect(isModified(rules, 'truckWaitMax')).toBe(true);
    expect(isModified(rules, 'dockStayMax')).toBe(false);
    expect(modifiedCount(rules)).toBe(1);
    expect(modifiedCount(DEFAULT_EVENT_RULES)).toBe(0);
    expect(sharedWith('R-STARVE', 'starvedMinutes')).toEqual(['R-BLOCK']);
    expect(sharedWith('L-WAIT', 'truckWaitMax')).toEqual([]);
  });
});

describe('data feed rows', () => {
  it('lists every process machine and conveyor as simulated, and a lost feed as stale since its loss', () => {
    const s = createSim(20261012, DEFAULT_START);
    let rows = feedRows(s);
    expect(rows.map((r) => r.id).sort()).toEqual([...PROCESS_MACHINES, ...CONVEYOR_IDS].sort());
    expect(rows.every((r) => r.status === 'simulated' && r.statusLabel === 'Simulated' && r.last == null)).toBe(true);
    expect(feedSummary(rows)).toMatchObject({ machines: PROCESS_MACHINES.length, conveyors: CONVEYOR_IDS.length, stale: 0, longest: null });
    expect(rows.find((r) => r.id === 'CV-KIN')).toMatchObject({ kind: 'conveyor', stage: 'KILN' });

    const sc = activateScenario(s, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'Signal loss E-PRS2' });
    advance(s, s.minute + 15);
    rows = feedRows(s);
    const r = rows.find((x) => x.id === 'E-PRS2')!;
    expect(r.status).toBe('stale');
    expect(r.statusLabel).toMatch(/^Stale since \d\d:\d\d$/);
    expect(r.scenarioId).toBe(sc.id);
    expect(r.state).toBe('unknown');
    expect(r.last).not.toBeNull();
    expect(r.staleFor).toBeGreaterThanOrEqual(14);
    expect(feedSummary(rows).stale).toBe(1);

    clearScenario(s, sc.id);
    advance(s, s.minute + 2);
    expect(feedRows(s).find((x) => x.id === 'E-PRS2')!.status).toBe('simulated');
  });
});
