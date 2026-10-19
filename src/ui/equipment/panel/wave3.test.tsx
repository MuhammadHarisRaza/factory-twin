/**
 * Wave 3 of the equipment panel (brief §6), server-rendered from real derived models: the header's data badge kinds
 * (no "Simulated" for assets without operating data; the stream never upgrades it), the 12-stage mapping and
 * "Updated hh:mm"; equipment-specific key figures with units and time context (no tiles/h for slip, powder or
 * silos, no zero for missing); the chart section with its time range and the viewer's persisted range; the signal
 * table; rule findings merged with the curated insights without saying a thing twice; the events type filter with
 * alarms, state transitions and data-quality entries; the stage panel's mapping line, findings and charts.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import type { ReactElement } from 'react';
import { useApp } from '../../../app/store';
import type { RuleFinding } from '../../../intel/rules/types';
import { activateScenario, advance, createSim, type SimState } from '../../../sim/engine';
import { useSim } from '../../../sim/store';
import { useTwin } from '../../../store';
import { StagePanel, briefStageLine } from '../../twin/StagePanel';
import { DEFAULT_PANEL_RANGE, useTwinUi } from '../../twin/uiStore';
import { deriveEquipmentIntel, deriveVehicleIntel } from '../intel/derive';
import { mergeFindings } from '../intel/panelData';
import type { EquipmentIntel, IntelInsight } from '../intel/types';
import { EquipmentPanel, chartOfSignal } from './EquipmentPanel';
import { eventFilterOptions, filterLog } from './Events';

useSim.getState().pause();

const START = 2 * 1440 + 4 * 60 + 20;
const normal = createSim(81, START);
const scenario = (seed: number, minutes: number, ...defs: Parameters<typeof activateScenario>[1][]) => {
  const s = createSim(seed, START);
  for (const d of defs) activateScenario(s, d);
  advance(s, START + minutes);
  return s;
};
const STORES = [useSim, useApp, useTwin, useTwinUi] as unknown as { getInitialState: () => object; getState: () => object }[];
const html = (el: ReactElement) => {
  for (const st of STORES) Object.assign(st.getInitialState(), st.getState());
  return renderToStaticMarkup(el);
};
const panel = (s: SimState, m: EquipmentIntel) => html(<EquipmentPanel intel={m} now={s.minute} />);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/\s+/g, ' ');
const header = (h: string) => h.slice(h.indexOf('<header class="eqp-h">'), h.indexOf('</header>'));
const kpi = (m: EquipmentIntel, key: string) => m.metrics.kpis.find((k) => k.key === key)!;

describe('header: data badge, 12-stage mapping, last update', () => {
  it('assets without operating data are Unavailable or Reference — never Simulated (A-COMP, a layout item)', () => {
    const comp = deriveEquipmentIntel(normal, 'A-COMP');
    expect(comp.header.source).toEqual({ kind: 'unavailable', label: 'Unavailable · no operating data' });
    const out = panel(normal, comp);
    expect(text(header(out))).not.toContain('Simulated');
    expect(out).toContain('prov prov-unavailable');
    const park = deriveEquipmentIntel(normal, 'A-PARK');
    expect(park.header.source.kind).toBe('reference');
    expect(text(header(panel(normal, park)))).toContain('Reference · layout only');
    expect(comp.header.lastUpdate).toBeNull();
    // Nothing to evaluate there: no rule findings in "What matters".
    expect(out).not.toContain('What matters');
  });

  it('a simulated asset: the brief stage next to the stage label and "Updated hh:mm" from its newest sample', () => {
    const m = deriveEquipmentIntel(normal, 'H-KILN');
    expect(m.header.stage12).toMatchObject({ no: 7, label: 'Brief stage 7 · Kiln firing' });
    expect(m.header.lastUpdate).toBe(normal.minute - 1);
    const t = text(header(panel(normal, m)));
    expect(t).toContain('Brief stage 7 · Kiln firing');
    expect(t).toMatch(/Updated \d\d:\d\d/);
    expect(deriveEquipmentIntel(normal, 'CV-SORT').header.stage12?.no).toBe(8);
    expect(deriveEquipmentIntel(normal, 'A-COMP').header.stage12).toBeNull();
  });

  it('a stale feed: the stale badge, no "Updated" next to it', () => {
    const s = scenario(81, 30, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'feed' });
    const out = header(panel(s, deriveEquipmentIntel(s, 'E-PRS2')));
    expect(out).toContain('prov prov-stale');
    expect(out).not.toContain('Updated');
  });
});

describe('key figures: equipment-specific, with units and time context', () => {
  it('press: output rate, cycle time vs target, downtime', () => {
    const m = deriveEquipmentIntel(normal, 'E-PRS2');
    expect(kpi(m, 'rate')).toMatchObject({ label: 'Press output rate', unit: 'tiles/h', window: 'now' });
    expect(kpi(m, 'cycle')).toMatchObject({ label: 'Cycle time', unit: 's' });
    expect(kpi(m, 'cycle').sub).toMatch(/^target \d+\.\d s$/);
    expect(kpi(m, 'stops').label).toBe('Stoppage time');
    expect(m.metrics.kpis.some((k) => k.label === 'Press cycle rate')).toBe(false);
  });

  it('spray dryer: powder output in simulated t/h, outlet temperature and moisture vs SP; silo: level, trend, time to empty (% basis), mass needs calibration', () => {
    const d = deriveEquipmentIntel(normal, 'D-TWR');
    expect(kpi(d, 'rate')).toMatchObject({ label: 'Powder output', unit: 't/h' });
    expect(kpi(d, 'rate').hint).toMatch(/KG_PER_TILE/);
    expect(kpi(d, 'outlet').sub).toMatch(/^SP \d+ °C$/);
    expect(kpi(d, 'moisture').unit).toBe('%');
    const silo = deriveEquipmentIntel(normal, 'D-SILO');
    expect(kpi(silo, 'level')).toMatchObject({ unit: '%', sub: 'level only · no mass calibration' });
    expect(kpi(silo, 'trend').unit).toBe('%/h');
    expect(kpi(silo, 'time-to').label).toMatch(/% basis$/);
    expect(kpi(silo, 'mass')).toMatchObject({ notModelled: true });
    expect(kpi(silo, 'inflow').unit).toBe('t/h');
  });

  it('kiln: zones within band (n / 5), firing rate, roller speed, alarms (never "no fault"), throughput', () => {
    const k = deriveEquipmentIntel(normal, 'H-KILN');
    expect(kpi(k, 'zones').value).toBe('5 / 5');
    expect(kpi(k, 'speed').unit).toBe('m/min');
    expect(kpi(k, 'alarms').sub).toBe('no active alarm code now');
    expect(kpi(k, 'alarms').status).toBeNull();
    expect(kpi(k, 'output').sub).toMatch(/m²$/);
    // A bad-quality zone reading is not counted as within band and not shown as a number.
    const bad = scenario(81, 10, { kind: 'data-quality', mode: 'bad-quality', equipmentId: 'H-KILN', signalId: 'H-KILN.zone3_temp_pv', end: null, label: 'Bad zone 3 sensor' });
    const z = kpi(deriveEquipmentIntel(bad, 'H-KILN'), 'zones');
    expect(z.value).toBe('4 / 4');
    expect(z.sub).toContain('zone 3 not readable');
    const row = deriveEquipmentIntel(bad, 'H-KILN').signalTable!.find((r) => r.def.signalId === 'H-KILN.zone3_temp_pv')!;
    expect(row.quality).toBe('Bad');
  });

  it('dryer, glaze, sorting, packing and conveyors get their own figures', () => {
    expect(kpi(deriveEquipmentIntel(normal, 'F-DRY'), 'zone1').unit).toBe('°C');
    expect(kpi(deriveEquipmentIntel(normal, 'G-LINE'), 'density').unit).toBe('g/L');
    expect(kpi(deriveEquipmentIntel(normal, 'I-SORT'), 'rejected')).toMatchObject({ label: 'Reject rate', unit: '%' });
    expect(kpi(deriveEquipmentIntel(normal, 'J-BOX'), 'per-hour')).toMatchObject({ label: 'Cartons per hour', unit: 'cartons/h', window: 'last 60 min' });
    expect(kpi(deriveEquipmentIntel(normal, 'J-PAL'), 'per-hour').unit).toBe('pallets/h');
    expect(kpi(deriveEquipmentIntel(normal, 'J-BOX'), 'state').label).toBe('Line state');
    const cv = deriveEquipmentIntel(normal, 'CV-PACK');
    expect(cv.metrics.kpis.map((k) => k.key)).toEqual(['state', 'speed', 'stops', 'utilisation', 'moved']);
    expect(kpi(cv, 'speed').unit).toBe('m/min');
  });

  it('no tiles/h for slip, powder or silos anywhere on their panels (C-BM*, D-TWR, D-SILO, C-SLIP, D-BELT)', () => {
    for (const id of ['C-BM1', 'C-BM2', 'D-TWR', 'D-SILO', 'C-SLIP', 'D-BELT']) expect(text(panel(normal, deriveEquipmentIntel(normal, id))), id).not.toMatch(/tiles?\/h/);
    const tile = panel(normal, deriveEquipmentIntel(normal, 'H-KILN'));
    expect(text(tile)).toMatch(/Zones within band · now/);
  });
});

describe('the approved card: process block, hero tiles, signal table, legend', () => {
  it('kiln: the firing profile with five zones and five deviation gauges, from the zone PV / SP signals', () => {
    const m = deriveEquipmentIntel(normal, 'H-KILN');
    expect(m.process?.kind).toBe('zones');
    expect(m.process!.gauges.map((g) => g.pvId)).toEqual([1, 2, 3, 4, 5].map((n) => `H-KILN.zone${n}_temp_pv`));
    expect(m.process!.gauges.every((g) => g.pv != null && g.sp != null && g.level === 'within')).toBe(true);
    expect(m.process!.level).toBeNull();
    const out = panel(normal, m);
    expect(out).toContain('Firing profile · now');
    expect(out).toMatch(/<svg class="eqp-zones"[^>]*role="img" aria-label="Zone temperatures along the kiln/);
    expect(out.split('class="eqp-gauge t-').length - 1).toBe(5);
    // Status in words for every gauge (screen readers, tooltips), never colour alone.
    expect(text(out)).toMatch(/Zone 3 temperature · peak firing: actual [\d,]+ °C vs setpoint 1,195 °C, [+−]?[\d.,]+ °C — within band/);
  });

  it('a kiln zone beyond its band: the gauge and the dot say so, the zones tile glows as a warning', () => {
    const s = scenario(81, 40, { kind: 'process-deviation', signalId: 'H-KILN.zone3_temp_pv', offset: 40, rampMin: 5, end: null, label: 'Zone 3 high' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    const z3 = m.process!.gauges[2];
    expect(z3.level).toBe('alarm');
    const out = panel(s, m);
    expect(out).toMatch(/<svg class="eqp-zones"[^>]*aria-label="[^"]*Z3 Peak firing \+[\d.,]+ °C beyond the alarm band/);
    expect(text(out)).toMatch(/Zone 3 temperature · peak firing: actual [\d,]+ °C vs setpoint 1,195 °C, \+[\d,]+ °C — beyond the alarm band/);
    expect(out).toMatch(/class="eqp-kpi t-warning[^"]*"[^>]*><span class="l">Zones within band/);
  });

  it('other PV / SP pairs: deviation gauges, no zone chart (spray dryer, press, dryer); a stopped press says why, never a zero', () => {
    const d = deriveEquipmentIntel(normal, 'D-TWR');
    expect(d.process?.kind).toBe('pairs');
    expect(d.process!.gauges.map((g) => g.pvId)).toEqual(expect.arrayContaining(['D-TWR.inlet_temp_pv', 'D-TWR.outlet_temp_pv']));
    const out = panel(normal, d);
    expect(out).toContain('Process values vs setpoint · now');
    expect(out).not.toContain('class="eqp-zones"');
    expect(deriveEquipmentIntel(normal, 'E-PRS2').process!.gauges.map((g) => g.pvId)).toEqual(['E-PRS2.press_pressure_pv']);
    expect(deriveEquipmentIntel(normal, 'F-DRY').process!.gauges).toHaveLength(2);
    const stop = scenario(82, 25, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press stop' });
    const g = deriveEquipmentIntel(stop, 'E-PRS2').process!.gauges[0];
    expect(g.pv).toBeNull();
    expect(g.level).toBeNull();
    expect(g.reason).toBeTruthy();
  });

  it('silo: a level gauge in % only (low line, trend %/h), no mass; sorting and conveyors: no process block', () => {
    const silo = deriveEquipmentIntel(normal, 'D-SILO');
    expect(silo.process?.level).toMatchObject({ bulk: true, low: 10, high: 90 });
    const out = panel(normal, silo);
    expect(out).toContain('Level · now');
    expect(out).toMatch(/role="meter" aria-label="[^"]+ level" aria-valuemin="0" aria-valuemax="100"/);
    expect(text(out)).toContain('level % only — no mass calibration');
    expect(text(out)).not.toMatch(/\d\s?t\b(?!\/h)/);
    for (const id of ['I-SORT', 'CV-PACK', 'J-BOX']) {
      expect(deriveEquipmentIntel(normal, id).process ?? null, id).toBeNull();
      expect(panel(normal, deriveEquipmentIntel(normal, id)), id).not.toContain('id="eqp-proc-');
    }
  });

  it('hero tiles: sparklines where a simulated signal backs the figure, none for counts; the alarm tile never says "no fault"', () => {
    const k = deriveEquipmentIntel(normal, 'H-KILN');
    expect(Object.keys(k.tileTrends!)).toEqual(expect.arrayContaining(['rate', 'speed']));
    expect(k.tileTrends!.output).toBeUndefined();
    expect(k.tileTrends!.stops).toBeUndefined();
    const out = panel(normal, k);
    expect(out).toContain('class="eqp-kpi-spark"');
    expect(text(out)).toContain('No active alarm code — not proof of no fault');
    expect(Object.keys(deriveEquipmentIntel(normal, 'D-SILO').tileTrends!)).toContain('level');
    expect(Object.keys(deriveEquipmentIntel(normal, 'E-PRS2').tileTrends!)).toEqual(expect.arrayContaining(['rate', 'cycle']));
  });

  it('signal table: unit and availability class columns, the folded catalogue line, the legend; Ask Copilot accented', () => {
    const out = panel(normal, deriveEquipmentIntel(normal, 'H-KILN'));
    expect(out).toContain('PLC signals');
    expect(text(out)).toMatch(/\d+ with values · \d+ not available/);
    expect(out).toMatch(/class="eqp-cls c-core"[^>]*>Core</);
    expect(out).toMatch(/class="eqp-cls c-conditional"[^>]*>Conditional</);
    expect(out).toContain('class="eqp-legend"');
    expect(text(out)).not.toMatch(/\bconnected\b/i);
    expect(out).toMatch(/class="btn sm eqp-act\s+accent"[^>]*>.*?<span>Ask Copilot<\/span>/);
  });
});

describe('charts, signals and the time range', () => {
  it('the chart section: a time-range control, figures with chart ids, compact stop figures beside them', () => {
    const out = panel(normal, deriveEquipmentIntel(normal, 'E-PRS2'));
    expect(out).toContain('How it has behaved');
    expect(out).toContain('aria-label="Chart time range"');
    expect(out).toContain('data-chart="chart:cycle"');
    expect(out).toContain('data-chart="chart:cycle-histogram"');
    expect(out).toContain('MTBF / MTTR');
    // The 7-day range is offered but disabled on this two-day simulation, with the reason.
    expect(out).toMatch(/aria-disabled="true"[^>]*title="The simulation holds [^"]+">7 days</);
    expect(out).not.toContain('Last 4 h');
  });

  it('the viewer range: persisted in the twin UI store (default 8 h); a range the data cannot serve falls back with the reason', () => {
    expect(DEFAULT_PANEL_RANGE).toBe('8h');
    expect(useTwinUi.getState().panelRange).toBe('8h');
    useTwinUi.getState().setPanelRange('1h');
    expect(useTwinUi.getState().panelRange).toBe('1h');
    useTwinUi.getState().setPanelRange('8h');
    const day = deriveEquipmentIntel(normal, 'H-KILN', { finance: useApp.getState().finance, cameraSources: {}, range: '24h' });
    expect(day.charts!.range).toBe('24h');
    expect(day.charts!.window.to - day.charts!.window.from).toBe(1440);
    const week = deriveEquipmentIntel(normal, 'H-KILN', { finance: useApp.getState().finance, cameraSources: {}, range: '7d' });
    expect(week.charts!.range).toBe('24h');
    expect(week.charts!.disabled['7d']).toMatch(/holds/);
    expect(chartOfSignal(day.charts!.specs, 'H-KILN.zone3_temp_pv')).toBe('chart:process:H-KILN.zone3_temp_pv');
    expect(chartOfSignal(day.charts!.specs, 'H-KILN.temp_firing')).toBeNull();
  });

  it('the signal table replaces the old list for equipment (search, filters, data-signal anchors); vehicles keep their list', () => {
    const out = panel(normal, deriveEquipmentIntel(normal, 'H-KILN'));
    expect(out).toContain('aria-label="Search signals"');
    expect(out).toContain('data-signal="H-KILN.zone3_temp_pv"');
    expect(out).not.toContain('class="eqp-sigs"');
    const fl = html(<EquipmentPanel intel={deriveVehicleIntel(normal, 'FL-02')} now={normal.minute} />);
    expect(fl).not.toContain('aria-label="Search signals"');
    expect(fl).not.toContain('aria-label="Chart time range"');
  });
});

describe('what matters: curated insights and rule findings, one statement per topic', () => {
  const insight = (id: string, severity: IntelInsight['severity'] = 'warning'): IntelInsight => ({
    id,
    severity,
    title: 't',
    observed: 'observed text here',
    why: 'why text here',
    evidence: [],
    next: null,
    basis: 'rule',
    basisLabel: 'Rule-based',
    certainty: 'observed',
  });
  const finding = (ruleId: string, status: RuleFinding['status'] = 'fired', severity: RuleFinding['severity'] = 'warning') =>
    ({ ruleId, status, severity, key: `${ruleId}|eq:X`, family: 'reliability', classification: 'rule-based' }) as RuleFinding;

  it('drops a fired finding a curated insight already says (and names its rule there); keeps the rest', () => {
    const r = mergeFindings([insight('condition:C-BM1')], [finding('RL-DRIVE'), finding('PC-SETPOINT'), finding('P-OUTPUT', 'clear')]);
    expect(r.findings.shown.map((f) => f.ruleId)).toEqual(['PC-SETPOINT', 'P-OUTPUT']);
    expect(r.findings.merged).toEqual([{ ruleId: 'RL-DRIVE', insightId: 'condition:C-BM1' }]);
    expect(r.insights[0].evidence).toContainEqual({ kind: 'rule', label: 'Also rule RL-DRIVE', ref: 'RL-DRIVE' });
  });

  it('"Operating normally" goes while a finding of warning severity or more has fired', () => {
    expect(mergeFindings([insight('normal:X', 'positive')], [finding('PC-SETPOINT')]).insights).toEqual([]);
    expect(mergeFindings([insight('normal:X', 'positive')], [finding('PC-SETPOINT', 'fired', 'info')]).insights).toHaveLength(1);
  });

  it('a kiln zone deviation: the rule finding shows in What matters with its classification and chart link, once', () => {
    const s = scenario(81, 40, { kind: 'process-deviation', signalId: 'H-KILN.zone3_temp_pv', offset: 40, rampMin: 5, end: null, label: 'Zone 3 high' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    const fired = m.findings!.shown.filter((f) => f.status === 'fired');
    expect(fired.some((f) => f.ruleId === 'PC-SETPOINT' || f.ruleId === 'PC-LIMIT')).toBe(true);
    const out = panel(s, m);
    const matters = text(out.slice(out.indexOf('What matters'), out.indexOf('How it has behaved')));
    expect(matters).toMatch(/Rule-based|Statistical/);
    expect(matters).toMatch(/Simulated data · rule PC-/);
    expect(out).toMatch(/class="eqp-chip link"[^>]*title="Show the chart chart:process:H-KILN\.zone3_temp_pv/);
    // Each fired finding once (no duplicate keys).
    const keys = m.findings!.shown.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(matters).not.toMatch(/\bAI\b|probability of failure|will fail/);
  });
});

describe('events & alarms: alarms, state transitions and data quality with a type filter', () => {
  it('a kiln stop: the active alarm code and the stop as a state transition, each with severity, time and source', () => {
    const s = scenario(82, 25, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    const log = m.log!;
    expect(log.some((e) => e.kind === 'alarm' && /^Active alarm code/.test(e.title))).toBe(true);
    const tr = log.find((e) => e.kind === 'state' && /→ Stopped/.test(e.title))!;
    expect(tr.source).toMatch(/State signal/);
    expect(tr.detail).toMatch(/ongoing \d+ min/);
    const opts = eventFilterOptions(m.events, log);
    expect(opts.map((o) => o.label)).toEqual(['All', 'Alarms', 'Events', 'State', 'Data quality']);
    expect(filterLog(log, 'state').every((e) => e.kind === 'state')).toBe(true);
    expect(filterLog(log, 'event')).toEqual([]);
    const out = panel(s, m);
    expect(out).toContain('aria-label="Event type"');
    expect(out).toContain('Events &amp; alarms');
    expect(text(out)).not.toMatch(/acknowledg/i);
  });

  it('a data-quality scenario becomes a data-quality entry from its DQ rule', () => {
    const s = scenario(81, 20, { kind: 'data-quality', mode: 'frozen', equipmentId: 'E-PRS2', signalId: 'E-PRS2.count_total', end: null, label: 'Frozen counter' });
    const log = deriveEquipmentIntel(s, 'E-PRS2').log!;
    expect(log.some((e) => e.kind === 'data' && /^Rule DQ-/.test(e.source))).toBe(true);
  });
});

describe('stage panel: the brief-stage mapping, rule findings and the stage chart set', () => {
  it('names the brief stages it covers (kiln outfeed as the cooling buffer)', () => {
    expect(briefStageLine('GLAZE')).toBe('Covers brief stages 5 · Glazing & engobe and 6 · Digital printing');
    expect(briefStageLine('KILN')).toBe('Covers brief stages 7 · Kiln firing and 8 · Cooling buffer & roller conveyors (kiln outfeed storage; no dedicated cooling-buffer machine)');
  });

  it('renders the mapping, the findings and the charts with a time range', () => {
    const out = html(<StagePanel id="PRESS" />);
    expect(text(out)).toContain('Covers brief stage 3 · Pressing');
    expect(out).toContain('aria-label="Chart time range"');
    expect(out).toContain('data-chart="chart:states"');
    expect(text(out)).toMatch(/rules? checked with no issue|Not evaluated/);
  });
});
