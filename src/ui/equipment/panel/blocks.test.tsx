/**
 * The panel's building blocks, server-rendered: the signal table (filters, folded catalogue entries, the inline
 * detail with source system, 'tag not configured', availability class and status note), the rule findings (fired,
 * recently resolved, not evaluated, classification labels, no AI) and the chart set with its time range.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import type { RuleFinding } from '../../../intel/rules/types';
import { createSim } from '../../../sim/engine';
import { seriesOf } from '../../../sim/telemetry';
import { chartsFor } from '../intel/charts';
import { rangeAvailability } from '../intel/ranges';
import { Charts } from './Charts';
import { RuleFindings, groupFindings, measurementText } from './RuleFindings';
import { ALL_SIGNALS, SignalTable, ageText, categoriesOf, filterSignalRows, signalDetail, signalTableRows } from './SignalTable';

const s = createSim(81, 2 * 1440 + 260);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

describe('signal table', () => {
  const rows = signalTableRows(s, 'H-KILN');

  it('joins the catalogue with the readings: quality words, ages, the catalogue status wins over a reading', () => {
    const z3 = rows.find((r) => r.def.signalId === 'H-KILN.zone3_temp_pv')!;
    expect(z3.quality).toBe('Good');
    expect(z3.unit).toBe('°C');
    expect(z3.age).toBe('< 1 min');
    expect(rows.find((r) => r.def.signalId === 'H-KILN.temp_firing')!.quality).toBe('Not modelled');
    // The energy counter reads an illustrative model, but the catalogue lists it as unavailable: no value shown.
    const kwh = rows.find((r) => r.def.signalId === 'H-KILN.energy_kwh')!;
    expect(kwh.quality).toBe('Unavailable');
    expect(kwh.value).toBeNull();
    expect(ageText(null, 100)).toBe('—');
    expect(ageText(90, 100)).toBe('9 min');
  });

  it('filters: the default view folds the catalogue entries without a value; search, category and availability work', () => {
    const d = filterSignalRows(rows, ALL_SIGNALS);
    expect(d.shown.every((r) => r.def.availabilityStatus === 'simulated')).toBe(true);
    expect(d.more.length).toBeGreaterThan(0);
    expect(d.more.every((r) => r.def.availabilityStatus !== 'simulated')).toBe(true);
    const q = filterSignalRows(rows, { ...ALL_SIGNALS, query: 'zone 3' });
    expect(q.shown.map((r) => r.def.signalId)).toEqual(['H-KILN.zone3_temp_pv', 'H-KILN.zone3_temp_sp']);
    expect(filterSignalRows(rows, { ...ALL_SIGNALS, query: 'H-KILN.roller' }).shown).toHaveLength(1);
    const c = filterSignalRows(rows, { ...ALL_SIGNALS, category: 'condition' });
    expect(c.shown.length).toBeGreaterThan(0);
    expect(c.shown.every((r) => r.def.category === 'condition')).toBe(true);
    const none = filterSignalRows(rows, { ...ALL_SIGNALS, availability: 'none' });
    expect(none.shown.every((r) => !r.hasValue)).toBe(true);
    expect(none.more).toHaveLength(0);
    expect(filterSignalRows(rows, { ...ALL_SIGNALS, availability: 'value' }).shown.every((r) => r.hasValue)).toBe(true);
    expect(categoriesOf(rows)).toContain('process');
    expect(categoriesOf(signalTableRows(s, 'D-SILO'))).not.toContain('process');
  });

  it('renders the table with search, category and availability controls; the folded entries as one line', () => {
    const out = renderToStaticMarkup(<SignalTable rows={rows} range="8h" />);
    expect(out).toContain('type="search"');
    expect(out).toContain('aria-label="Signal category"');
    expect(out).toContain('aria-label="Availability"');
    expect(out).toContain('data-signal="H-KILN.zone3_temp_pv"');
    expect(text(out)).toMatch(/\+ \d+ catalogue signals without a value \(.+\) · not modelled or unavailable in the demo · Show/);
    expect(out).not.toContain('data-signal="H-KILN.temp_firing"');
  });

  it('a highlighted signal unfolds and opens its detail: source system, tag not configured, class, status note, history', () => {
    const out = renderToStaticMarkup(<SignalTable rows={rows} range="8h" highlight="H-KILN.temp_firing" history={(id) => seriesOf(s, id, '8h')} />);
    const t = text(out);
    expect(t).toContain('Tag: not configured (mapped at integration)');
    expect(t).toContain('PLC / machine controller');
    expect(t).toMatch(/Core candidate · Not modelled/);
    const d = rows.find((r) => r.def.signalId === 'H-KILN.temp_firing')!.def;
    expect(d.statusNote && t.includes(d.statusNote.slice(0, 40))).toBe(true);
    expect(t).toContain('No history: the demo has no value for this signal.');
    const pv = renderToStaticMarkup(<SignalTable rows={rows} range="8h" highlight="H-KILN.zone3_temp_pv" history={(id) => seriesOf(s, id, '8h')} />);
    expect(text(pv)).toMatch(/Warning limits|Alarm limits/);
    expect(text(pv)).toContain('Setpoint signal');
    expect(pv).toContain('class="chart');
  });

  it('detail lines of a counter and of a setpoint pair', () => {
    const r = signalTableRows(s, 'J-BOX').find((x) => x.def.signalId === 'J-BOX.carton_count')!;
    expect(signalDetail(r).some((l) => l.label === 'Counter')).toBe(true);
    expect(signalDetail(r).find((l) => l.label === 'Expected update')?.value).toBe('every 60 s');
  });
});

const finding = (o: Partial<RuleFinding>): RuleFinding => ({
  ruleId: 'P-CYCLE',
  family: 'production',
  classification: 'rule-based',
  scope: { kind: 'equipment', equipmentId: 'E-PRS2' },
  key: `k-${Math.random()}`,
  status: 'fired',
  severity: 'warning',
  title: 'Cycle time above target',
  explanation: 'Cycle time 16.9 s against the 15.3 s target for 22 min (09:40–10:02). The other presses are on target.',
  measurements: [{ label: 'Cycle time', value: 16.9, unit: 's', window: { from: 3000, to: 3022 } }],
  window: { from: 3000, to: 3022 },
  evidence: [
    { kind: 'signal', label: 'Cycle time', ref: 'E-PRS2.cycle_time' },
    { kind: 'chart', label: 'Cycle-time chart', ref: 'chart:cycle', window: { from: 3000, to: 3022 } },
  ],
  confidence: 'high',
  confidenceNote: 'Minute samples',
  next: 'Check the die of E-PRS2.',
  missingSignals: [],
  staleSignals: [],
  provenance: { source: 'simulated', signals: ['E-PRS2.cycle_time'], note: 'Evaluated on simulated data' },
  firstSeen: 3000,
  lastSeen: 3022,
  ...o,
});

describe('rule findings', () => {
  const list = [
    finding({}),
    finding({ ruleId: 'P-DECLINE', classification: 'statistical', title: 'Rate declining', severity: 'serious' }),
    finding({ ruleId: 'P-OUTPUT', status: 'clear', title: 'Output back on target', resolvedAt: 2990 }),
    finding({ ruleId: 'P-COUNTER', status: 'clear', title: 'Counter advancing' }),
    finding({ ruleId: 'PC-SETPOINT', status: 'insufficient-data', title: 'Not evaluated — requires pressing pressure', missingSignals: [{ signalId: 'E-PRS2.press_pressure_pv', name: 'Pressing pressure', reason: 'bad quality' }] }),
  ];

  it('groups fired, recently resolved, not evaluated and the rules checked clear', () => {
    const g = groupFindings(list);
    expect(g.fired).toHaveLength(2);
    expect(g.resolved).toHaveLength(1);
    expect(g.notEvaluated).toHaveLength(1);
    expect(g.clearRules).toBe(1);
    expect(measurementText(list[0].measurements[0])).toMatch(/^Cycle time 16\.9 s · \d\d:\d\d–\d\d:\d\d$/);
    expect(measurementText({ label: 'Level', value: null, unit: '%' })).toBe('Level no value');
  });

  it('renders severity in words, the classification, measurements, evidence links, next check, provenance and since', () => {
    const out = renderToStaticMarkup(<RuleFindings findings={list} now={3023} onSignal={() => {}} onChart={() => {}} onEvent={() => {}} />);
    const t = text(out);
    expect(t).toContain('Warning');
    expect(t).toContain('Serious');
    expect(t).toContain('Rule-based');
    expect(t).toContain('Statistical');
    expect(t).toContain('Next check');
    expect(t).toMatch(/Simulated data · rule P-CYCLE/);
    expect(t).toMatch(/since \d\d:\d\d/);
    expect(t).toContain('Recently resolved');
    expect(t).toContain('Not evaluated (1)');
    expect(t).toContain('1 rule checked with no issue');
    expect(out).toMatch(/class="eqp-chip link"[^>]*title="Show the chart chart:cycle/);
    expect(t).not.toMatch(/\bAI\b|artificial intelligence|machine learning|probability/i);
    expect(t).not.toMatch(/connected/i);
  });

  it('honest when nothing applies', () => {
    expect(text(renderToStaticMarkup(<RuleFindings findings={[]} now={1} onSignal={() => {}} onChart={() => {}} onEvent={() => {}} />))).toContain('No detection rule applies');
  });
});

describe('chart set', () => {
  it('a time-range control with the disabled reasons, and one figure per spec carrying its chart ids', () => {
    const specs = chartsFor(s, { kind: 'equipment', equipmentId: 'H-KILN' }, '8h');
    const out = renderToStaticMarkup(<Charts specs={specs} range="8h" onRange={() => {}} disabled={rangeAvailability(s, ['H-KILN.rate'])} notCharted={[{ signalId: 'H-KILN.temp_firing', name: 'Firing temperature', status: 'Not modelled' }]} />);
    expect(out).toContain('aria-label="Chart time range"');
    expect(out).toMatch(/aria-disabled="true"[^>]*title="The simulation holds/);
    expect(out).toContain('data-chart="chart:zones"');
    expect(out).toMatch(/data-charts="[^"]*chart:process:H-KILN\.zone3_temp_pv/);
    expect(text(out)).toContain('Not charted');
    expect(text(out)).not.toMatch(/tiles?\/h.*t\/h/);
  });
});
