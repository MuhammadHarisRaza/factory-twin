/**
 * Material flow (Production ?tab=material): the stage chain in physical units (t/h for slip / powder with the
 * disclosure computed from KG_PER_TILE, tiles/h and m²/h after pressing), silos and slip tanks as level % only,
 * buffer trend / balance / time to empty or full from the calculation library, the flow findings of the rule
 * engine, the 12-stage mapping, chart series with gaps — and the Plan & flow buffer reading that never turns a
 * missing level into 0 %.
 */
import { describe, expect, it } from 'vitest';
import { insufficient, ok, unavailable } from '../../calc';
import { KG_PER_TILE } from '../../model/catalog';
import { BUFFER_LEVEL_SIGNAL, M2_PER_TILE, STAGES } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { bottleneck } from '../../sim/metrics';
import { levelOf, lineFlow } from './line';
import { BUFFER_TOPOLOGY, bufferChart, bufferOfFinding, flowFindings, flowText, horizonOf, materialFlow, stageMapping } from './material';
import { MASS_DISCLOSURE, NO_CALIBRATION, isMaterialAsset, massFlowSignalOf, tileEqToT } from './units';

const START = 2 * 1440 + 9 * 60;
const s = createSim(7, START);
const d = materialFlow(s);
const byStage = Object.fromEntries(d.stages.map((x) => [x.id, x]));
const byBuffer = Object.fromEntries(d.buffers.map((x) => [x.id, x]));

describe('units', () => {
  it('discloses the tile-equivalent conversion with the factor computed from KG_PER_TILE', () => {
    expect(MASS_DISCLOSURE).toBe(`simulated: tile-eq × ${KG_PER_TILE.toFixed(2)} kg`);
    expect(tileEqToT(1000)).toBeCloseTo(KG_PER_TILE, 9);
    expect(tileEqToT(null)).toBeNull();
    expect(isMaterialAsset('C-BM1')).toBe(true);
    expect(isMaterialAsset('D-TWR')).toBe(true);
    expect(isMaterialAsset('E-PRS1')).toBe(false);
    expect(massFlowSignalOf('C-BM1')).toBe('C-BM1.slip_flow');
    expect(massFlowSignalOf('D-TWR')).toBe('D-TWR.powder_flow');
  });
});

describe('stage chain', () => {
  it('rates stages 1–2 in t/h (with the disclosure) and the tile stages in tiles/h with m²/h', () => {
    for (const id of ['PREP', 'SPRAY'] as const) {
      const st = byStage[id];
      expect(st.unit).toBe('t/h');
      expect(st.m2PerHour).toBeNull();
      expect(st.basis).toContain(MASS_DISCLOSURE);
      expect(st.rate.status).toBe('ok');
      // A ball-mill line puts out some t/h of dry body, not thousands of "tiles".
      if (st.rate.status === 'ok') expect(st.rate.value).toBeLessThan(100);
    }
    for (const id of ['PRESS', 'DRY', 'KILN', 'SORT'] as const) {
      const st = byStage[id];
      expect(st.unit).toBe('tiles/h');
      expect(st.rate.status).toBe('ok');
      if (st.rate.status === 'ok') expect(st.m2PerHour).toBeCloseTo(st.rate.value * M2_PER_TILE, 6);
    }
    expect(flowText(9.94, 't/h')).toBe('9.9 t/h');
    expect(flowText(null, 'tiles/h')).toBeNull();
  });

  it('runs upstream → downstream with every buffer before the stage it feeds and stage 9 flagged as not present', () => {
    const order = d.chain.map((c) => (c.kind === 'stage' ? c.stage.id : c.kind === 'buffer' ? c.buffer.id : `absent-${c.def.no}`));
    expect(order.filter((x) => STAGES.some((st) => st.id === x))).toEqual(STAGES.map((st) => st.id));
    for (const st of STAGES) if (st.inputBuffer) expect(order.indexOf(st.inputBuffer)).toBe(order.indexOf(st.id) - (st.id === 'SORT' ? 2 : 1));
    const i9 = order.indexOf('absent-9');
    expect(i9).toBeGreaterThan(order.indexOf('BUF-KOUT'));
    expect(i9).toBeLessThan(order.indexOf('SORT'));
  });

  it('shows silos and slip tanks as level % only — no mass without a level-to-mass calibration', () => {
    for (const id of ['BUF-SLIP', 'BUF-SILO']) {
      const b = byBuffer[id];
      expect(b.bulk).toBe(true);
      expect(b.unit).toBe('t/h');
      expect(b.capacityTiles).toBeNull();
      expect(b.mass).toEqual(expect.objectContaining({ status: 'unavailable', value: null }));
      expect(b.mass?.status !== 'ok' && b.mass?.reason).toBe(NO_CALIBRATION);
    }
    for (const b of d.buffers.filter((x) => !x.bulk)) {
      expect(b.unit).toBe('tiles/h');
      expect(b.mass).toBeNull();
    }
    expect(d.summary).toContain(NO_CALIBRATION.toLowerCase());
  });

  it('balance = inflow − outflow, direction against the deadband; trend and horizon from the calc library', () => {
    for (const b of d.buffers) {
      expect(b.level.status).toBe('ok');
      if (b.inflow.status === 'ok' && b.outflow.status === 'ok') {
        expect(b.balance.status).toBe('ok');
        if (b.balance.status === 'ok') {
          expect(b.balance.value.net).toBeCloseTo(b.inflow.value - b.outflow.value, 6);
          const dir = Math.abs(b.balance.value.net) <= b.deadband ? 'balanced' : b.balance.value.net > 0 ? 'filling' : 'draining';
          expect(b.balance.value.direction).toBe(dir);
        }
      }
      if (b.trend.status === 'ok') expect(b.direction).toBe(Math.abs(b.trend.value) < b.trendThreshold ? 'steady' : b.trend.value > 0 ? 'rising' : 'falling');
    }
  });

  it('time to empty / full: a linear extrapolation, balanced inside the threshold, a reason when there is no level', () => {
    expect(horizonOf(ok(50), ok(-10), 5)).toMatchObject({ kind: 'empty', minutes: 300 });
    expect(horizonOf(ok(50), ok(-10), 5).text).toMatch(/^Empty in ≈ 5 h 00 min at this trend \(linear extrapolation, not a forecast\)$/);
    expect(horizonOf(ok(80), ok(20), 5)).toMatchObject({ kind: 'full', minutes: 60 });
    expect(horizonOf(ok(50), ok(2), 5)).toMatchObject({ kind: 'balanced', minutes: null });
    expect(horizonOf(ok(99), ok(1), 5).text).toMatch(/^Steady at full/);
    expect(horizonOf(ok(50), ok(-0.01), 0.001).text).toContain('more than 24 h');
    const none = horizonOf(unavailable('flagged bad by the source'), ok(3), 5);
    expect(none).toMatchObject({ kind: 'none', minutes: null });
    expect(none.text).toBe('Level not available — flagged bad by the source');
    expect(horizonOf(ok(40), insufficient('3 samples'), 5).text).toBe('No level trend — 3 samples');
  });
});

describe('findings, ranking and mapping', () => {
  it('wires the flow family of the rule engine (plant scope) to its buffers', () => {
    const all = flowFindings(s);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((f) => f.family === 'flow')).toBe(true);
    expect(d.findings.total).toBe(all.length);
    expect(d.findings.fired.length + d.findings.insufficient.length + d.findings.clear).toBe(all.length);
    for (const b of d.buffers) for (const f of b.findings) expect(bufferOfFinding(f)).toBe(b.id);
    expect(flowFindings(s)).toBe(all); // memoised per minute
    for (const f of d.findings.fired) expect(f.classification).toMatch(/rule-based|statistical/);
  });

  it('ranks the stages from the shared bottleneck trace with shares of planned time', () => {
    const bn = bottleneck(s);
    expect(d.ranking.rows.map((r) => r.stage)).toEqual(bn.ranked.map((x) => x.stage));
    expect(d.ranking.rows.filter((r) => r.traced)).toHaveLength(1);
    expect(d.ranking.rows.find((r) => r.design)?.stage).toBe('KILN');
  });

  it('maps the twelve brief stages: stage 8 partial, stage 9 not present and flagged for configuration', () => {
    const m = stageMapping();
    expect(m.map((r) => r.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(m.find((r) => r.no === 8)).toMatchObject({ present: 'partial', flag: 'Partial' });
    expect(m.find((r) => r.no === 9)).toMatchObject({ present: 'no', monitored: null, flag: 'Not present — flagged for configuration' });
    expect(m.find((r) => r.no === 6)?.monitored?.id).toBe('GLAZE');
  });
});

describe('chart series and missing levels', () => {
  it('serves every range with aligned level / inflow / outflow series in the buffer unit', () => {
    for (const range of ['15m', '1h', '8h', '24h', '7d'] as const) {
      const c = bufferChart(s, 'BUF-SILO', range)!;
      expect(c.unit).toBe('t/h');
      expect(c.inflow.t).toEqual(c.level.t);
      expect(c.outflow.t).toEqual(c.level.t);
      expect(c.inflow.label).toContain(MASS_DISCLOSURE);
    }
    expect(bufferChart(s, 'BUF-KIN', '1h')!.unit).toBe('tiles/h');
    expect(bufferChart(s, 'NOPE', '1h')).toBeNull();
    expect(BUFFER_TOPOLOGY.map((t) => t.buf.id)).toContain('BUF-KOUT');
  });

  it('a bad-quality level is no level: no trend horizon, no 0 %, a gap in the chart and "Level not available" in Plan & flow', () => {
    const x = createSim(7, START);
    const sig = BUFFER_LEVEL_SIGNAL['BUF-KIN'];
    activateScenario(x, { kind: 'data-quality', equipmentId: sig.slice(0, sig.indexOf('.')), signalId: sig, mode: 'bad-quality', end: null, label: 'Bad level' });
    advance(x, x.minute + 15);
    const b = materialFlow(x).buffers.find((y) => y.id === 'BUF-KIN')!;
    expect(b.level.status).toBe('unavailable');
    expect(b.horizon.kind).toBe('none');
    expect(b.horizon.text).toMatch(/^Level not available/);
    const c = bufferChart(x, 'BUF-KIN', '15m')!;
    expect(c.level.v.slice(-5).every((v) => v == null)).toBe(true);
    const lv = levelOf(x, 'BUF-KIN');
    expect(lv.fill).toBeNull();
    const kin = lineFlow(x, bottleneck(x)).find((f) => f.stage === 'KILN')!.input!;
    expect(kin.fill).toBeNull();
    expect(kin.tiles).toBeNull();
    expect(kin.coverMin).toBeNull();
    expect(kin.effect).toMatch(/^Level not available/);
    expect(kin.effect).not.toMatch(/0 %|starved/);
  });

  it('Plan & flow buffers read the level signal; slip / powder changes are in % points, never tiles', () => {
    const flow = lineFlow(s, bottleneck(s));
    for (const f of flow) if (f.input) expect(f.input.fill).not.toBeNull();
    for (const f of flow.filter((x) => x.input?.material)) expect(f.input!.effect).not.toMatch(/tiles/);
  });
});
