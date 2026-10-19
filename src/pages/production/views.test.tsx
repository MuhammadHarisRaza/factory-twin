/**
 * Wave-3 Production views: the Material flow tab, the OEE trend / partial A × P / stage comparison, the equipment-state
 * distribution of Plan & flow, the stage signal table (search, category filter, catalogue availability) — and the
 * fixed honesty violations: no tiles / tiles/h for slip, powder or silos, no zero for a missing value, no unit
 * without a number, and the drawer's link to the shared equipment panel.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { AVAILABILITY_CLASS_LABEL, KG_PER_TILE } from '../../model/catalog';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { MonitoredStageId } from '../../model/types';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { resolvePeriod, stageIO } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import type { Metric } from '../../sim/oee';
import { ProductionPage } from '../ProductionPage';
import { EquipmentDrawer } from './MachineDrawer';
import { oeeTrend, partialOee, stageOee } from './oee';
import { quickDef, bottleneckView, filterSignalRows, rowCategories, signalRows, stageRow, stageSentence } from './stage/derive';
import { SignalTable, signalCharts } from './stage/Signals';
import { LINE_MACHINES, stateDistribution } from './states';
import { useProductionUi } from './ui';
import { MASS_DISCLOSURE, NO_CALIBRATION } from './units';

useSim.getState().pause();

const sync = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useProductionUi.getInitialState(), useProductionUi.getState());
};
const render = (tab: 'flow' | 'material' | 'oee', stage: MonitoredStageId | null = null) => {
  useApp.setState({ workspace: 'production', period: 'shift', productionStage: stage, tabs: tab === 'flow' ? {} : { production: tab } });
  sync();
  return renderToStaticMarkup(<ProductionPage />);
};
const honest = (html: string) => {
  expect(html).not.toMatch(/>Live</);
  expect(html).not.toMatch(/\bAI\b|AI model|machine learning/);
  expect(html).not.toMatch(/Ghani/i);
  // "No plant data source is connected" is the honest statement; anything claiming a connection is not.
  expect(html.replace(/No plant data source is connected/g, '')).not.toMatch(/is connected|>Connected</);
};
const ok = (v: number): Metric => ({ value: v, status: 'ok' });
const na: Metric = { value: null, status: 'unavailable', issue: 'x' };

describe('Material flow tab', () => {
  it('renders the chain, charts, findings, ranking and the 12-stage mapping with the honesty labels', () => {
    const html = render('material');
    for (const text of [
      'Material flow',
      'Stage chain',
      'Buffer over time',
      'Chart range',
      'Starvation and blockage findings',
      'Bottleneck ranking',
      'Brief stages on this line',
      't/h',
      'tiles/h',
      'm²/h',
      `simulated: tile-eq × ${KG_PER_TILE.toFixed(2)} kg`,
      NO_CALIBRATION.toLowerCase(),
      'Not present — flagged for configuration',
      'Polishing &amp; rectification',
      'Partial',
      'linear extrapolation',
      'Simulated',
    ])
      expect(html, text).toContain(text);
    honest(html);
  });

  it('never puts tiles or tiles/h on the slip and powder rows', () => {
    const html = render('material');
    const rows = html.split('<tr').map((r) => r.slice(0, r.indexOf('</tr>'))).filter((r) => /Body preparation|Spray drying|Slip|Powder silo|powder/i.test(r) && /mf-(stage|buffer)/.test(r));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      expect(r).not.toMatch(/tiles\/h|\d tiles\b/);
      expect(r).toContain('t/h');
    }
  });
});

describe('OEE tab additions', () => {
  it('partial A × P when quality is missing — labelled, never OEE; nothing when OEE exists', () => {
    expect(partialOee(ok(0.9), ok(0.8), na)).toMatchObject({ value: 0.9 * 0.8, label: 'Partial — quality input missing', formula: 'Availability × Performance' });
    expect(partialOee(ok(0.9), na, ok(0.95))).toMatchObject({ label: 'Partial — performance input missing' });
    expect(partialOee(ok(0.9), ok(0.8), ok(0.95), ok(0.684))).toBeNull();
    expect(partialOee(na, ok(0.8), na)).toBeNull();
  });

  it('trend per hour with gaps instead of zeros, and the stage comparison with transfer stages not meaningful', () => {
    const s = createSim(3, 2 * 1440 + 10 * 60);
    const p = resolvePeriod('shift', s.minute);
    const t = oeeTrend(s, p);
    expect(t.granularity).toBe('hour');
    expect(t.points.length).toBeGreaterThan(0);
    for (const x of t.points) {
      if (x.oee != null) expect(x.oee).toBeCloseTo((x.availability ?? NaN) * (x.performance ?? NaN) * (x.quality ?? NaN), 6);
      expect(x.oee === 0 && x.availability !== 0).toBe(false);
    }
    const rows = stageOee(s, p);
    expect(rows.find((r) => r.stage === 'WH')).toMatchObject({ meaningful: false, machines: [] });
    expect(rows.find((r) => r.stage === 'PREP')?.note).toMatch(/tile-equivalent/);
    expect(rows.find((r) => r.stage === 'KILN')?.machines.map((m) => m.id)).toEqual(['H-KILN']);
    const html = render('oee');
    for (const text of ['OEE trend', 'OEE by stage', 'Availability', 'Quality', 'not counted twice', 'Not meaningful']) expect(html, text).toContain(text);
    honest(html);
  });
});

describe('Plan & flow additions', () => {
  it('state distribution: every machine counted once now, machine-time per state over the period', () => {
    const s = createSim(5, 2 * 1440 + 10 * 60);
    const p = resolvePeriod('shift', s.minute);
    const d = stateDistribution(s, p);
    expect(d.window.to).toBeGreaterThan(d.window.from);
    expect(d.machines).toBe(LINE_MACHINES.length);
    expect(d.now.reduce((a, x) => a + x.count, 0)).toBe(LINE_MACHINES.length);
    const span = d.window.to - d.window.from;
    const recorded = d.period.reduce((a, x) => a + x.minutes, 0);
    expect(recorded + d.unrecorded).toBeCloseTo(span * LINE_MACHINES.length, 6);
    expect(d.period.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 6);
    expect(d.lanes).toHaveLength(LINE_MACHINES.length);
    // A product changeover is a state of its own.
    const x = createSim(5, 2 * 1440 + 10 * 60);
    activateScenario(x, quickDef('machine-stop', 'E-PRS1', 30, x.minute));
    advance(x, x.minute + 10);
    const dx = stateDistribution(x, resolvePeriod('shift', x.minute));
    expect(dx.now.find((c) => c.ids.includes('E-PRS1'))?.state).not.toBe('running');
  });

  it('renders the equipment states and links the buffers to Material flow', () => {
    const html = render('flow');
    for (const text of ['Equipment states', 'Machines per state now', 'Machine-time', 'State timeline per machine', 'Material flow']) expect(html, text).toContain(text);
    honest(html);
  });
});

describe('stage view', () => {
  const s = createSim();

  it('signal table rows carry category and catalogue availability; search and category filter work', () => {
    const rows = signalRows(s, 'H-KILN');
    const z = rows.find((r) => r.id === 'H-KILN.zone3_temp_pv')!;
    expect(z).toMatchObject({ category: 'process', basis: 'process-model', availabilityClass: AVAILABILITY_CLASS_LABEL.core, availabilityStatus: 'Simulated', trend: true });
    expect(z.value).not.toBeNull();
    expect(z.quality).toBe('good');
    const nm = rows.find((r) => r.id === 'H-KILN.burner_demand')!;
    expect(nm).toMatchObject({ value: null, valueLabel: 'Not modelled' });
    expect(filterSignalRows(rows, 'zone3').map((r) => r.id)).toEqual(['H-KILN.zone3_temp_pv', 'H-KILN.zone3_temp_sp']);
    expect(filterSignalRows(rows, '', 'condition').every((r) => r.category === 'condition')).toBe(true);
    expect(filterSignalRows(rows, 'no such signal')).toEqual([]);
    expect(rowCategories(rows)[0]).toBe('state');
    const html = renderToStaticMarkup(<SignalTable rows={rows} />);
    for (const text of ['Search signals', 'All categories', 'Availability', 'Quality · age', 'Core candidate', 'Conditional', 'Category']) expect(html, text).toContain(text);
    // Ball mills: the catalogue's tile-equivalent units, never tiles.
    const mill = signalRows(s, 'C-BM1');
    expect(mill.find((r) => r.name === 'rate')?.unit).toBe('tile-eq/h');
    expect(mill.some((r) => r.unit === 'tiles' || r.unit === 'tiles/h')).toBe(false);
  });

  it('signal charts follow the time range; slip / powder rates in t/h with the disclosure', () => {
    for (const range of ['15m', '8h', '7d'] as const) {
      const charts = signalCharts(s, MONITORED_STAGE_BY_ID.PREP, 'C-BM1', range);
      const rate = charts.find((c) => c.title.startsWith('Output rate'))!;
      expect(rate.unit).toBe('t/h');
      expect(rate.note).toContain(MASS_DISCLOSURE);
      expect(rate.to - rate.from).toBe({ '15m': 15, '8h': 480, '7d': 10080 }[range]);
    }
    const kiln = signalCharts(s, MONITORED_STAGE_BY_ID.KILN, 'H-KILN', '1h');
    expect(kiln.filter((c) => c.series.some((x) => x.label === 'Setpoint')).length).toBe(5);
    expect(signalCharts(s, MONITORED_STAGE_BY_ID.PRESS, 'E-PRS1', '1h').find((c) => c.key === 'E-PRS1.rate')?.unit).toBe('tiles/h');
  });

  it('slip / powder stages show t/h, tile-eq and level % — never tiles/h, never a unit without a number', () => {
    for (const id of ['PREP', 'SPRAY'] as const) {
      const html = render('flow', id);
      const io = html.slice(html.indexOf('prod-io-strip'), html.indexOf('Machines and conveyors'));
      expect(io, id).toContain('t/h');
      expect(io, id).not.toMatch(/tiles\/h|>tiles</);
      expect(html.slice(html.indexOf('Machines and conveyors')), id).not.toMatch(/\d<!-- --> tiles\/h|\/ [\d,]+ tiles\/h/);
      expect(html, id).toContain(MASS_DISCLOSURE);
      honest(html);
    }
    expect(render('flow', 'PRESS')).toContain(NO_CALIBRATION.toLowerCase());
    for (const ms of Object.values(MONITORED_STAGE_BY_ID)) expect(render('flow', ms.id), ms.id).not.toMatch(/—<small>|— tiles/);
  });

  it('stage sentence: a missing quantity is "not measured", never 0', () => {
    const p = resolvePeriod('shift', s.minute);
    for (const id of ['PREP', 'SPRAY', 'PRESS', 'WH'] as const) {
      const ms = MONITORED_STAGE_BY_ID[id];
      const row = stageRow(s, ms, p, bottleneckView(s));
      const io = stageIO(s, id, p);
      const text = stageSentence({ ...row, io: { ...io, output: null, input: null, wip: null } }, 'shift');
      expect(text, id).toMatch(/not measured/);
      expect(text, id).not.toMatch(/\b0 (tiles|tile-eq|pallets)\b/);
    }
    expect(stageSentence(stageRow(s, MONITORED_STAGE_BY_ID.PREP, p, bottleneckView(s)), 'shift')).toMatch(/tile-eq \(≈ [\d,]+ t, simulated: tile-eq ×/);
  });

  it('the Production drill-down links to the shared equipment panel in the Factory Twin; slip machines in t', () => {
    useApp.setState({ period: 'shift' });
    sync();
    const html = renderToStaticMarkup(<EquipmentDrawer id="C-BM1" periodKey="shift" onClose={() => {}} />);
    expect(html).toContain('Open in Factory Twin');
    expect(html).toContain('tile-eq');
    expect(html).not.toMatch(/tiles\/h/);
  });
});
