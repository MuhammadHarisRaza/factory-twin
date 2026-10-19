/**
 * The panel's chart specs (intel/charts.ts) and time ranges (intel/ranges.ts): per equipment type the right charts
 * from its catalogue signals, honest units (no tiles/h for slip, powder or silos; silo level % only with the
 * calibration note), not-modelled signals listed instead of charted, empty states, and range windows / availability.
 */
import { describe, expect, it } from 'vitest';
import { CHART } from '../../../intel/rules/types';
import { createSim } from '../../../sim/engine';
import { LEVEL_ONLY_NOTE, MASS_FLOW_NOTE, PANEL_CHART, chartIds, chartsFor, notCharted, type ChartSpec, type TimeChartSpec } from './charts';
import { effectiveRange, rangeAvailability, rangeCovering, windowOf } from './ranges';

const s = createSim(81, 2 * 1440 + 260);
const specs = (id: string, range: Parameters<typeof chartsFor>[2] = '8h') => chartsFor(s, { kind: 'equipment', equipmentId: id }, range);
const byId = (xs: ChartSpec[], id: string) => xs.find((x) => chartIds(x).includes(id));
/** Every word a spec shows (titles, units, series and reference labels, facts, notes). */
const words = (x: ChartSpec) =>
  [
    x.title,
    x.unit,
    x.note,
    x.coverage,
    ...(x.facts ?? []).flatMap((f) => [f.label, f.value]),
    ...(x.kind === 'time' ? [...x.series.map((v) => v.label), ...x.refLines.map((r) => r.label), ...x.bands.map((b) => b.label)] : []),
  ].join(' | ');

describe('ranges', () => {
  it('windows: minute ranges end now; hourly ranges are whole hours ending with the current one', () => {
    const w8 = windowOf(s, '8h');
    expect(w8.to - w8.from).toBe(480);
    expect(w8.stepMin).toBe(5);
    expect(w8.to).toBe(s.minute);
    const w24 = windowOf(s, '24h');
    expect(w24.stepMin).toBe(60);
    expect(w24.from % 60).toBe(0);
    expect(w24.to - w24.from).toBe(1440);
    expect(w24.resolution).toBe('hour');
  });

  it('availability: minute ranges always; 7 days disabled while the simulation holds less history, with the reason', () => {
    const r = rangeAvailability(s, ['H-KILN.rate']);
    expect(r['15m']).toBeUndefined();
    expect(r['8h']).toBeUndefined();
    expect(r['24h']).toBeUndefined();
    expect(r['7d']).toMatch(/holds .* of history/);
    expect(effectiveRange('7d', r)).toBe('24h');
    expect(rangeCovering(s.minute, { from: s.minute - 200, to: s.minute }, r)).toBe('8h');
    expect(rangeCovering(s.minute, { from: s.minute - 30, to: s.minute }, r)).toBe('1h');
  });
});

describe('chart specs per equipment type', () => {
  it('every spec is simulated, states its resolution, and has an id', () => {
    for (const id of ['H-KILN', 'E-PRS2', 'D-TWR', 'D-SILO', 'I-SORT', 'CV-SORT', 'C-BM1', 'F-DRY', 'G-LINE']) {
      for (const x of specs(id)) {
        expect(x.provenance, id).toBe('Simulated');
        expect(x.resolution.length, `${id} ${x.id}`).toBeGreaterThan(3);
        expect(x.id, id).toMatch(/^chart:/);
      }
    }
  });

  it('machines: a state timeline and the output rate against the ideal rate', () => {
    const xs = specs('E-PRS2');
    expect(byId(xs, CHART.states)?.kind).toBe('states');
    const rate = byId(xs, CHART.rate) as TimeChartSpec;
    expect(rate.unit).toBe('tiles/h');
    expect(rate.refLines.some((r) => /^ideal/.test(r.label))).toBe(true);
  });

  it('kiln: one zone chart with the five zones (PV solid, SP dashed) answering every zone chart id, and roller speed', () => {
    const xs = specs('H-KILN');
    const z = byId(xs, PANEL_CHART.zones) as TimeChartSpec;
    expect(z.series.filter((v) => !v.dashed)).toHaveLength(5);
    expect(z.series.filter((v) => v.dashed && v.step)).toHaveLength(5);
    for (let n = 1; n <= 5; n++) expect(chartIds(z)).toContain(CHART.process(`H-KILN.zone${n}_temp_pv`));
    expect(z.facts?.[0].value).toMatch(/of 5/);
    expect(byId(xs, CHART.process('H-KILN.roller_speed'))?.unit).toBe('m/min');
    // No separate PV/SP chart per zone.
    expect(xs.filter((x) => x.id.startsWith('chart:process:H-KILN.zone'))).toHaveLength(0);
  });

  it('presses: cycle time vs target and a cycle-time histogram from minute samples while running', () => {
    const xs = specs('E-PRS2');
    const c = byId(xs, CHART.cycle) as TimeChartSpec;
    expect(c.series.map((v) => v.label)).toEqual(['Cycle time', 'Target']);
    const h = byId(xs, PANEL_CHART.histogram);
    expect(h?.kind).toBe('histogram');
    if (h?.kind === 'histogram') {
      expect(h.n).toBeGreaterThanOrEqual(20);
      expect(h.minSamples).toBe(20);
      expect(h.markers.some((m) => m.kind === 'target')).toBe(true);
    }
    // PV vs SP of the pressing pressure, with the warning / alarm lines.
    const p = byId(xs, CHART.process('E-PRS2.press_pressure_pv')) as TimeChartSpec;
    expect(p.refLines.map((r) => r.kind).sort()).toEqual(['alarm', 'alarm', 'warning', 'warning']);
    expect(p.series[1]).toMatchObject({ dashed: true, step: true });
  });

  it('silo: level % only with the calibration note — no mass, no tiles; flows in simulated t/h with the disclosure', () => {
    const xs = specs('D-SILO');
    const lvl = byId(xs, CHART.buffer('D-SILO.level')) as TimeChartSpec;
    expect(lvl.unit).toBe('%');
    expect(lvl.note).toBe(LEVEL_ONLY_NOTE);
    expect(lvl.facts?.find((f) => f.label === 'Mass')?.value).toMatch(/calibration/);
    const flow = byId(xs, PANEL_CHART.flow('D-SILO.level')) as TimeChartSpec;
    expect(flow.unit).toBe('t/h');
    expect(flow.note).toContain(MASS_FLOW_NOTE);
    for (const x of xs) expect(words(x), x.id).not.toMatch(/\btiles?\/h\b| t\b(?!\/h)/);
  });

  it('no tiles/h for powder, slip or silos (D-TWR, C-BM*, D-SILO, C-SLIP): simulated t/h with the KG_PER_TILE disclosure', () => {
    for (const id of ['D-TWR', 'C-BM1', 'C-BM2', 'C-BM3', 'D-SILO', 'C-SLIP']) {
      for (const range of ['8h', '24h'] as const) for (const x of specs(id, range)) expect(words(x), `${id} ${x.id}`).not.toMatch(/tiles?\/h/);
    }
    const r = byId(specs('D-TWR'), CHART.rate) as TimeChartSpec;
    expect(r.unit).toBe('t/h');
    expect(r.note).toBe(MASS_FLOW_NOTE);
  });

  it('sorting: reject rate per step with n and FPY in the tooltip, and defect categories with their origin', () => {
    const xs = specs('I-SORT');
    const q = byId(xs, CHART.quality) as TimeChartSpec;
    expect(q.unit).toBe('%');
    const t = q.series[0].t.find((x) => q.tips?.[x]);
    expect(q.tips![t!].map((r) => r.label)).toEqual(['Inspected', 'Rejected', 'First-pass yield']);
    const d = byId(xs, PANEL_CHART.defects);
    expect(d?.kind).toBe('ranked');
    if (d?.kind === 'ranked') expect(String(d.rows[0]?.label ?? '')).toMatch(/· from /);
  });

  it('conveyors: state timeline and speed; a conveyor holding a buffer gets its level', () => {
    const xs = specs('CV-SORT');
    expect(byId(xs, CHART.states)).toBeTruthy();
    expect(byId(xs, PANEL_CHART.speed)?.unit).toBe('m/min');
    expect(byId(xs, CHART.buffer('CV-SORT.outfeed_buffer_level'))).toBeTruthy();
  });

  it('stops: downtime by reason and an event strip for tracked assets', () => {
    const xs = specs('E-PRS2', '24h');
    expect(byId(xs, PANEL_CHART.downtime)?.kind).toBe('ranked');
    expect(byId(xs, PANEL_CHART.events)?.kind).toBe('events');
  });

  it('not-modelled signals get no chart but are listed', () => {
    const nc = notCharted('H-KILN').map((x) => x.signalId);
    expect(nc).toContain('H-KILN.temp_firing');
    expect(specs('H-KILN').some((x) => chartIds(x).some((c) => c.includes('temp_firing')))).toBe(false);
    expect(notCharted('H-KILN').every((x) => x.status === 'Not modelled' || x.status === 'Unavailable')).toBe(true);
  });

  it('empty states: an asset without operating data has no chart; a range without samples says why', () => {
    expect(specs('A-COMP')).toEqual([]);
    const young = createSim(81, 30);
    const x = chartsFor(young, { kind: 'equipment', equipmentId: 'E-PRS2' }, '24h');
    for (const c of x) if (c.kind === 'time' && !c.series.some((v) => v.v.some((y) => y != null))) expect(c.emptyReason, c.id).toBeTruthy();
  });

  it('a stage: state lanes per machine, buffer levels and the output rate; memoised per minute and range', () => {
    const xs = chartsFor(s, { kind: 'stage', stageId: 'PRESS' }, '8h');
    const st = byId(xs, CHART.states);
    expect(st?.kind === 'states' && st.lanes.length).toBeGreaterThanOrEqual(3);
    expect(byId(xs, CHART.rate)).toBeTruthy();
    expect(byId(xs, CHART.buffer('E-COL.level'))).toBeTruthy();
    expect(chartsFor(s, { kind: 'stage', stageId: 'PRESS' }, '8h')).toBe(xs);
  });
});
