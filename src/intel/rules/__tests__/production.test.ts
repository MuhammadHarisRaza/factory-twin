/**
 * Production rules (src/intel/rules/defs/production.ts) on one pre-rolled simulation: clear in normal operation;
 * a 'reduced-rate' press fires output below target, cycle time above target and a declining rate; a stopped press
 * is not "cycle above target"; a counter that stops while the state signal is current and running fires P-COUNTER
 * (fixture source), while a 'data-quality' frozen counter does not — it is a stale signal, reported as not evaluated.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { TelemetrySource } from '../../../model/telemetry';
import type { ScenarioActivation } from '../../../model/types';
import { activateScenario, advance, createSim, type SimState } from '../../../sim/engine';
import { simulatedSource } from '../../../sim/telemetry';
import { CHART, findingsFor, plantFindings, type FindingsOptions, type RuleFinding } from '..';

const START = 2 * 1440 + 240;
const s = createSim(41, START);
const PRESSES = ['E-PRS1', 'E-PRS2', 'E-PRS3'];

const finding = (ruleId: string, equipmentId: string, opts?: FindingsOptions): RuleFinding => {
  const f = findingsFor(s, { kind: 'equipment', equipmentId }, opts).find((x) => x.ruleId === ruleId);
  if (!f) throw new Error(`no ${ruleId} finding for ${equipmentId}`);
  return f;
};
const measurement = (f: RuleFinding, label: string) => f.measurements.find((m) => m.label === label);
/** The production-family findings of an equipment item (other families register their own rules). */
const production = (equipmentId: string) => findingsFor(s, { kind: 'equipment', equipmentId }).filter((f) => f.family === 'production');

describe('normal simulation', () => {
  it('evaluates every production rule for each press and reports nothing while the presses and the kiln run normally', () => {
    expect(production('E-PRS2').map((f) => f.ruleId).sort()).toEqual(['P-COUNTER', 'P-CYCLE', 'P-DECLINE', 'P-OUTPUT']);
    for (const id of [...PRESSES, 'H-KILN'])
      for (const f of production(id)) {
        expect(f.status, f.key).toBe('clear');
        expect(f.provenance.source).toBe('simulated');
        expect(f.provenance.scenarioId).toBeUndefined();
        expect(f.lastSeen).toBeNull();
      }
  });

  it('plant-wide: no counter, cycle or decline finding, nothing unevaluated, and output findings only where an unplanned stop explains them', () => {
    const prod = plantFindings(s).findings.filter((f) => f.family === 'production');
    expect(prod.length).toBeGreaterThan(40);
    expect(prod.filter((f) => f.status === 'insufficient-data')).toEqual([]);
    for (const f of prod.filter((x) => x.status === 'fired')) {
      expect(f.ruleId, f.key).toBe('P-OUTPUT');
      expect(f.explanation, f.key).toMatch(/min stopped \(longest: /);
      expect(f.next, f.key).toMatch(/^Review the unplanned stop/);
    }
  });

  it('explains clear verdicts with figures, units and the time window', () => {
    const out = finding('P-OUTPUT', 'E-PRS1');
    expect(out.explanation).toMatch(/^E-PRS1 made [\d,]+ tiles in the last 60 min \(\d\d:\d\d–\d\d:\d\d\): [\d,]+ tiles\/h over \d+ min of production time, at or above the target of 85 % of its planned 417 tiles\/h \(354 tiles\/h; planned at the line pace set by the kiln/);
    expect(measurement(out, 'Output rate over production time')?.unit).toBe('tiles/h');
    expect(measurement(out, 'Target')?.value).toBe(354);
    const kiln = finding('P-OUTPUT', 'H-KILN');
    expect(kiln.explanation).toMatch(/target of 85 % of its planned 1,250 tiles\/h \(1,063 tiles\/h, its ideal rate\)/);
    const mill = finding('P-OUTPUT', 'C-BM1');
    expect(mill.explanation).toMatch(/tile-eq\/h/);
    const cyc = finding('P-CYCLE', 'E-PRS1');
    expect(cyc.explanation).toMatch(/^E-PRS1 cycle time \d+\.\d s against a target of 15\.3 s \(\+\d+ %\), within the \+17\.6 % tolerance \(18\.0 s\) while running over the last 120 min\./);
    expect(cyc.chartRef).toBe(CHART.cycle);
    const dec = finding('P-DECLINE', 'E-PRS1');
    expect(dec.classification).toBe('statistical');
    expect(dec.explanation).toMatch(/^No significant decline over the last 120 min \(\d\d:\d\d–\d\d:\d\d\): slope −?[\d,]+ tiles\/h per hour .* t = −?\d+\.\d/);
    expect(dec.confidenceNote).toMatch(/autocorrelated/);
    expect(finding('P-COUNTER', 'E-PRS1').explanation).toMatch(/^E-PRS1\.count_total advancing while running: \+[\d,]+ tiles in the last 30 min/);
  });

  it('P-COUNTER fires when the counter stops while the state signal is current and reports running (fixture source)', () => {
    const id = 'H-KILN.count_total';
    const freezeAt = s.minute - 9;
    const frozen = simulatedSource.series(s, id, { from: freezeAt, to: freezeAt + 1, stepMin: 1 })!.v[0]!;
    // A counting sensor that stopped: the gateway still delivers the counter every minute (fresh timestamps), unchanged.
    const source: TelemetrySource<SimState> = {
      kind: 'simulated',
      read: (st, sig) => {
        const r = simulatedSource.read(st, sig);
        return sig === id ? { ...r, value: Math.round(frozen) } : r;
      },
      series: (st, sig, w) => {
        const x = simulatedSource.series(st, sig, w);
        return sig === id && x ? { ...x, v: x.v.map((v, i) => (x.t[i] > freezeAt && v != null ? frozen : v)) } : x;
      },
      states: simulatedSource.states,
    };
    const f = finding('P-COUNTER', 'H-KILN', { source });
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('warning');
    expect(f.firstSeen).toBe(freezeAt + 1);
    expect(f.lastSeen).toBe(s.minute);
    expect(measurement(f, 'Not advancing while running')).toMatchObject({ value: 8, unit: 'min' });
    expect(f.explanation).toMatch(/^H-KILN\.count_total has not advanced for 8 min \(since \d\d:\d\d; value [\d,]+ tiles\) while H-KILN\.state reports Running and is current/);
    expect(f.explanation).toMatch(/not a stale feed/);
    expect(f.next).toMatch(/counting sensor .* on H-KILN, and compare with the next counting point \(CV-SORT\.tile_count\)/);
    expect(f.chartRef).toBe(CHART.rate);
    // Without the fixture the kiln counts normally.
    expect(finding('P-COUNTER', 'H-KILN').status).toBe('clear');
  });
});

describe('scenarios', () => {
  let t0 = 0;
  let reduced: ScenarioActivation;
  let stop: ScenarioActivation;
  beforeAll(() => {
    t0 = s.minute;
    reduced = activateScenario(s, { kind: 'reduced-rate', equipmentId: 'E-PRS2', factor: 0.6, end: null, label: 'Press 2 at 60 %' });
    stop = activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS3', end: null, label: 'Press 3 breakdown' });
    advance(s, t0 + 45);
  });

  it("'reduced-rate' on a press: output below target, cycle time above target and a declining rate, with the scenario in the provenance", () => {
    const out = finding('P-OUTPUT', 'E-PRS2');
    expect(out.status).toBe('fired');
    expect(out.severity).toBe('warning');
    expect(out.title).toMatch(/^Hydraulic press 2 output \d+ % of plan — below target$/);
    expect(out.explanation).toMatch(/min at reduced rate/);
    expect(out.explanation).toMatch(/Over the same window E-PRS1 made [\d,]+ tiles\/h and E-PRS3 made [\d,]+ tiles\/h\./);
    expect(out.firstSeen!).toBeGreaterThanOrEqual(t0);
    expect(out.lastSeen).toBe(s.minute);
    expect(out.provenance.scenarioId).toBe(reduced.id);
    expect(out.provenance.note).toMatch(/A simulated scenario acts on this scope: Press 2 at 60 % \(Reduced production rate/);
    expect(out.next).toMatch(/^Check the die \/ powder feed of E-PRS2; compare Hydraulic press 2 with Hydraulic press 1 and Hydraulic press 3/);

    const cyc = finding('P-CYCLE', 'E-PRS2');
    expect(cyc.status).toBe('fired');
    expect(cyc.chartRef).toBe(CHART.cycle);
    expect(cyc.firstSeen!).toBeGreaterThanOrEqual(t0);
    expect(cyc.firstSeen!).toBeLessThanOrEqual(s.minute - 10);
    expect(measurement(cyc, 'Cycle time now')!.value as number).toBeGreaterThan(18);
    expect(cyc.explanation).toMatch(/while running: now \d+\.\d s, mean \d+\.\d s, longest \d+\.\d s against a target of 15\.3 s — the limit is 18\.0 s \(\+17\.6 %\)/);
    expect(cyc.next).toMatch(/E-PRS1 \d+\.\d s and E-PRS3 not cycling now/);

    const dec = finding('P-DECLINE', 'E-PRS2');
    expect(dec.status).toBe('fired');
    expect(dec.classification).toBe('statistical');
    expect(measurement(dec, 'Slope as a share of the ideal rate')!.value as number).toBeLessThan(-10);
    expect(dec.explanation).toMatch(/t = −\d+\.\d \(threshold −2\.58\)/);
    expect(dec.confidence).not.toBe('high');

    // The plant view ranks them among the top fired findings.
    const top = plantFindings(s, { top: 20 }).top.map((f) => f.key);
    for (const k of [out.key, cyc.key, dec.key]) expect(top).toContain(k);
  });

  it('a stopped press is not "cycle time above target", and its counter is not expected to advance', () => {
    const cyc = finding('P-CYCLE', 'E-PRS3');
    expect(cyc.status).toBe('clear');
    expect(cyc.title).toBe('Hydraulic press 3 not cycling');
    expect(cyc.explanation).toMatch(/^E-PRS3 is not running \(Stopped since \d\d:\d\d\) — there is no press cycle to time/);
    const cnt = finding('P-COUNTER', 'E-PRS3');
    expect(cnt.status).toBe('clear');
    expect(cnt.explanation).toMatch(/E-PRS3\.state reads Down/);
    const out = finding('P-OUTPUT', 'E-PRS3');
    expect(out.status).toBe('fired');
    expect(out.explanation).toMatch(/45 min stopped \(longest: Simulated breakdown \(scenario\), 45 min from \d\d:\d\d\)/);
    expect(out.next).toMatch(/^Review the unplanned stop of E-PRS3/);
    expect(out.provenance.scenarioId).toBe(stop.id);
  });

  it('a stage next to the presses held back by a full buffer is the line pacing it, not an output loss', () => {
    const dry = finding('P-OUTPUT', 'F-DRY');
    expect(dry.status).toBe('clear');
    expect(dry.title).toBe('Multi-deck roller dryer: output paced by the line');
    expect(dry.explanation).toMatch(/\((F-BUF|E-COL)\.level\) is (at )?\d+ %/);
  });

  it("a 'data-quality' frozen counter is not P-COUNTER: clear while still fresh, then not evaluated as a stale signal", () => {
    const t1 = s.minute;
    activateScenario(s, { kind: 'data-quality', mode: 'frozen', equipmentId: 'E-PRS1', signalId: 'E-PRS1.count_total', end: null, label: 'Frozen counter' });
    advance(s, t1 + 1);
    expect(finding('P-COUNTER', 'E-PRS1').status).toBe('clear');
    // The frozen value is not read as a reset to the lifetime count (implausible step left out).
    const out = finding('P-OUTPUT', 'E-PRS1');
    expect(out.status).not.toBe('fired');
    expect(measurement(out, 'Output in the window')!.value as number).toBeLessThan(600);
    for (let k = 2; k <= 6; k++) {
      advance(s, t1 + k);
      const f = finding('P-COUNTER', 'E-PRS1');
      expect(f.status, `minute ${k}`).toBe('insufficient-data');
      expect(f.staleSignals.map((x) => x.signalId)).toEqual(['E-PRS1.count_total']);
      expect(f.staleSignals[0].since).toBe(t1 - 1);
      expect(f.explanation).toMatch(/^Not evaluated — requires E-PRS1\.count_total \(Output counter\): not current — last value \d\d:\d\d/);
      expect(f.next).toMatch(/data feed \(PLC \/ gateway link\) of E-PRS1/);
    }
    expect(finding('P-OUTPUT', 'E-PRS1').status).toBe('insufficient-data');
  });
});
