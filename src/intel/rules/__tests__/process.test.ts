/**
 * Process-control rules (src/intel/rules/defs/process.ts) on one pre-rolled simulation: clear in normal operation (process
 * values at setpoint, within limits, valid measurements; the process measurements the catalogue lists but the simulation
 * does not have are named once per item, not evaluated); fixture sources for a deviation that is too short / long enough,
 * an implausible reading (a measurement problem, never a deviation) and a stopped machine; a 'process-deviation' beyond
 * the alarm band on the kiln's peak-firing zone fires PC-SETPOINT and PC-LIMIT (serious) and resolves when cleared, one
 * within the band stays clear; 'data-quality' bad quality, spike and gap fire PC-MEASUREMENT, and a frozen PV is not
 * evaluated — that PV only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { definitionOf } from '../../../model/catalog';
import type { EquipmentStateSegment, TelemetrySource } from '../../../model/telemetry';
import type { ScenarioActivation } from '../../../model/types';
import { activateScenario, advance, clearScenario, createSim, type SimState } from '../../../sim/engine';
import { simulatedSource } from '../../../sim/telemetry';
import { formatClock } from '../../../sim/time';
import { CHART, PROCESS_RULES, RULE_BY_ID, findingsFor, plantFindings, type FindingsOptions, type RuleFinding } from '..';

const START = 2 * 1440 + 240;
const s = createSim(41, START);
const ZONE3 = 'H-KILN.zone3_temp_pv';
const ZONE2 = 'H-KILN.zone2_temp_pv';
const ZONE1 = 'H-KILN.zone1_temp_pv';

const process = (equipmentId: string, opts?: FindingsOptions) => findingsFor(s, { kind: 'equipment', equipmentId }, opts).filter((f) => f.family === 'process');
const finding = (ruleId: string, equipmentId: string, subject?: string, opts?: FindingsOptions): RuleFinding => {
  const f = process(equipmentId, opts).find((x) => x.ruleId === ruleId && x.subject === subject);
  if (!f) throw new Error(`no ${ruleId} finding for ${equipmentId} ${subject ?? ''}`);
  return f;
};
const measurement = (f: RuleFinding, label: string) => f.measurements.find((m) => m.label === label);

/** The simulated source with one signal's samples from minute `from` on replaced (series and current reading). */
function overrideSource(signalId: string, from: number, value: (t: number) => number | null, states?: TelemetrySource<SimState>['states']): TelemetrySource<SimState> {
  return {
    kind: 'simulated',
    read: (st, sig) => {
      const r = simulatedSource.read(st, sig);
      return sig === signalId && st.minute - 1 >= from ? { ...r, value: value(st.minute - 1), text: String(value(st.minute - 1)) } : r;
    },
    series: (st, sig, w) => {
      const x = simulatedSource.series(st, sig, w);
      return sig === signalId && x ? { ...x, v: x.v.map((v, i) => (x.t[i] >= from ? value(x.t[i]) : v)) } : x;
    },
    states: states ?? simulatedSource.states,
  };
}

describe('normal simulation', () => {
  it('registers the process rules as rule-based process-control rules', () => {
    expect(PROCESS_RULES.map((d) => d.id)).toEqual(['PC-SETPOINT', 'PC-LIMIT', 'PC-MEASUREMENT']);
    for (const d of PROCESS_RULES) {
      expect(RULE_BY_ID[d.id]).toBe(d);
      expect(d.family).toBe('process');
      expect(d.classification).toBe('rule-based');
    }
  });

  it('evaluates every simulated kiln zone on its own and reports each at setpoint, within limits and measured validly', () => {
    const kiln = process('H-KILN');
    for (const z of [1, 2, 3, 4, 5]) {
      const pv = `H-KILN.zone${z}_temp_pv`;
      for (const rule of ['PC-SETPOINT', 'PC-LIMIT', 'PC-MEASUREMENT']) {
        const f = kiln.find((x) => x.ruleId === rule && x.subject === pv);
        expect(f?.status, `${rule} ${pv}`).toBe('clear');
        expect(f!.key).toBe(`${rule}|eq:H-KILN|${pv}`);
        expect(f!.chartRef).toBe(CHART.process(pv));
        expect(f!.provenance.source).toBe('simulated');
        expect(f!.provenance.note).toMatch(/^Simulated data/);
        expect(f!.provenance.scenarioId).toBeUndefined();
      }
    }
    // The setpoints are not process values of their own.
    expect(kiln.some((f) => f.subject?.endsWith('_sp'))).toBe(false);
  });

  it('plant-wide: nothing fired; the only unevaluated findings name the measurements the simulation does not have, once per item', () => {
    const all = plantFindings(s).findings.filter((f) => f.family === 'process');
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((f) => f.status === 'fired')).toEqual([]);
    const notEvaluated = all.filter((f) => f.status === 'insufficient-data');
    expect(notEvaluated.length).toBeGreaterThan(0);
    for (const f of notEvaluated) {
      expect(f.ruleId, f.key).toBe('PC-MEASUREMENT');
      expect(f.subject, f.key).toBe('not-available');
      expect(f.title).toMatch(/^Process measurements not available: /);
      expect(f.missingSignals.length).toBeGreaterThan(0);
      for (const m of f.missingSignals) expect(definitionOf(m.signalId)!.availabilityStatus, m.signalId).not.toBe('simulated');
    }
    const items = notEvaluated.map((f) => (f.scope.kind === 'equipment' ? f.scope.equipmentId : ''));
    expect(new Set(items).size).toBe(items.length);
    expect(items).toEqual(expect.arrayContaining(['H-KILN', 'D-TWR', 'F-DRY', 'G-LINE', 'CV-SORT', 'C-SLIP']));
    // A simulated signal is never listed as not available, and a not-modelled one never gets a verdict of its own.
    const kiln = notEvaluated.find((f) => f.scope.kind === 'equipment' && f.scope.equipmentId === 'H-KILN')!;
    expect(kiln.missingSignals.map((m) => m.signalId)).toEqual(expect.arrayContaining(['H-KILN.temp_firing', 'H-KILN.flue_o2']));
    expect(kiln.explanation).toMatch(/H-KILN\.temp_firing \(Firing temperature \(single value\)\): not modelled in this simulation — /);
    expect(kiln.next).toMatch(/^Map H-KILN\.temp_firing, .* to real signals at integration/);
    expect(all.some((f) => f.subject === 'H-KILN.temp_firing')).toBe(false);
  });

  it('explains clear verdicts with figures, units, bands and the time window', () => {
    const sp = finding('PC-SETPOINT', 'H-KILN', ZONE3);
    expect(sp.explanation).toMatch(
      /^H-KILN\.zone3_temp_pv [\d,]+ °C against a setpoint of 1,195 °C \([+−]\d+ °C\), within the warning band ±10 °C, alarm band ±20 °C over the last 120 min \(\d\d:\d\d–\d\d:\d\d\)\./,
    );
    expect(measurement(sp, 'Setpoint')).toMatchObject({ value: 1195, unit: '°C', signalId: 'H-KILN.zone3_temp_sp' });
    expect(measurement(sp, 'Warning band (±)')?.value).toBe(10);
    const lim = finding('PC-LIMIT', 'H-KILN', ZONE3);
    expect(lim.explanation).toMatch(/within its limits \(warning low 1,185 °C \/ high 1,205 °C; alarm low 1,175 °C \/ high 1,215 °C\)/);
    const mes = finding('PC-MEASUREMENT', 'H-KILN', ZONE3);
    expect(mes.explanation).toMatch(/^H-KILN\.zone3_temp_pv delivers valid readings: .* engineering range of 0–1,300 °C in the last 15 min/);
    // A hydraulic oil temperature has limits but no setpoint: limit-checked only.
    expect(process('E-PRS1').filter((f) => f.subject === 'E-PRS1.oil_temp').map((f) => f.ruleId).sort()).toEqual(['PC-LIMIT', 'PC-MEASUREMENT']);
    // The slip tanks have no state signal: evaluated every minute.
    expect(finding('PC-SETPOINT', 'C-SLIP', 'C-SLIP.slip_density_pv').explanation).toMatch(/^C-SLIP\.slip_density_pv 1\.\d{3} g\/cm³ against a setpoint of 1\.700 g\/cm³/);
    // Condition-monitoring signals are left to the reliability rules.
    expect(process('H-KILN').some((f) => f.subject === 'H-KILN.vibration' || f.subject === 'H-KILN.temperature')).toBe(false);
  });
});

describe('fixture sources', () => {
  it('reports a deviation only once it has lasted the minimum duration, and at the warning level inside the alarm band', () => {
    const now = s.minute;
    const short = finding('PC-SETPOINT', 'H-KILN', ZONE3, { source: overrideSource(ZONE3, now - 3, () => 1210) });
    expect(short.status).toBe('clear');
    expect(short.explanation).toMatch(/Beyond the warning band for the last 3 min — reported after 5 min\./);
    const long = finding('PC-SETPOINT', 'H-KILN', ZONE3, { source: overrideSource(ZONE3, now - 8, () => 1210) });
    expect(long.status).toBe('fired');
    expect(long.severity).toBe('warning');
    expect(long.firstSeen).toBe(now - 8);
    expect(long.lastSeen).toBe(now);
    expect(long.title).toBe('Single-layer roller kiln: zone 3 temperature · peak firing +15 °C from setpoint');
    expect(long.explanation).toMatch(
      /^H-KILN\.zone3_temp_pv has been above its setpoint by more than the warning band for 8 min \(since \d\d:\d\d\) while H-KILN is in operation: now 1,210 °C against a setpoint of 1,195 °C \(\+15 °C\), largest deviation 15 °C\. Warning band ±10 °C, alarm band ±20 °C\. Reported after 5 min/,
    );
    expect(measurement(long, 'Beyond the alarm band for')?.value).toBe(0);
  });

  it('an implausible reading is a measurement problem, never a deviation', () => {
    const now = s.minute;
    const source = overrideSource(ZONE3, now - 4, (t) => (t === now - 4 ? 5000 : 1195));
    const mes = finding('PC-MEASUREMENT', 'H-KILN', ZONE3, { source });
    expect(mes.status).toBe('fired');
    expect(mes.title).toBe('Single-layer roller kiln: zone 3 temperature · peak firing measurement invalid');
    expect(mes.explanation).toMatch(/^H-KILN\.zone3_temp_pv — measurement invalid while H-KILN is in operation: 1 reading outside its engineering range of 0–1,300 °C \(latest 5,000 °C at \d\d:\d\d\)/);
    expect(mes.explanation).toMatch(/This is a measurement problem, not a process deviation/);
    expect(mes.firstSeen).toBe(now - 4);
    expect(mes.next).toMatch(/scaling of H-KILN\.zone3_temp_pv at the PLC input/);
    for (const rule of ['PC-SETPOINT', 'PC-LIMIT']) {
      const f = finding(rule, 'H-KILN', ZONE3, { source });
      expect(f.status, rule).toBe('clear');
      expect(f.explanation, rule).toMatch(/Left out: 1 implausible sample outside the engineering range \(PC-MEASUREMENT\)\./);
    }
  });

  it('a machine in an own stop is not a deviation: not assessed, even with the PV far from its setpoint', () => {
    const now = s.minute;
    const fault: TelemetrySource<SimState>['states'] = (_st, id, w) =>
      id === 'H-KILN' ? [{ from: w.from, to: w.to, state: 'fault', label: 'Roller jam', reason: 'MECH_ROLLER' } as EquipmentStateSegment] : simulatedSource.states(_st, id, w);
    const source = overrideSource(ZONE3, now - 60, () => 1100, fault);
    for (const rule of ['PC-SETPOINT', 'PC-LIMIT', 'PC-MEASUREMENT']) {
      const f = finding(rule, 'H-KILN', ZONE3, { source });
      expect(f.status, rule).toBe('clear');
      expect(f.confidence, rule).toBe('low');
      expect(f.explanation, rule).toMatch(/^Not assessed now: H-KILN is Fault — Roller jam since \d\d:\d\d/);
    }
  });
});

describe('scenarios', () => {
  let t0 = 0;
  let alarm: ScenarioActivation;
  let spike: ScenarioActivation;
  beforeAll(() => {
    t0 = s.minute;
    alarm = activateScenario(s, { kind: 'process-deviation', signalId: ZONE3, offset: 30, rampMin: 10, end: null, label: 'Kiln zone 3 +30 °C' });
    activateScenario(s, { kind: 'process-deviation', signalId: ZONE2, offset: 5, rampMin: 10, end: null, label: 'Kiln zone 2 +5 °C' });
    activateScenario(s, { kind: 'data-quality', mode: 'bad-quality', equipmentId: 'F-DRY', signalId: 'F-DRY.zone1_temp_pv', end: null, label: 'Dryer zone 1 bad quality' });
    spike = activateScenario(s, { kind: 'data-quality', mode: 'spike', equipmentId: 'D-TWR', end: null, label: 'Spray dryer spikes' });
    activateScenario(s, { kind: 'data-quality', mode: 'gap', equipmentId: 'D-TWR', signalId: 'D-TWR.outlet_temp_pv', end: null, label: 'Outlet temperature gap' });
    activateScenario(s, { kind: 'data-quality', mode: 'frozen', equipmentId: 'H-KILN', signalId: ZONE1, end: null, label: 'Kiln zone 1 frozen' });
    advance(s, t0 + 40);
  });

  it("'process-deviation' beyond the alarm band: PC-SETPOINT and PC-LIMIT fire serious, with the PV, SP, deviation, duration and window", () => {
    const sp = finding('PC-SETPOINT', 'H-KILN', ZONE3);
    expect(sp.status).toBe('fired');
    expect(sp.severity).toBe('serious');
    expect(sp.classification).toBe('rule-based');
    expect(sp.firstSeen!).toBeGreaterThanOrEqual(t0);
    expect(sp.firstSeen!).toBeLessThan(t0 + 10);
    expect(sp.lastSeen).toBe(s.minute);
    expect(sp.title).toMatch(/^Single-layer roller kiln: zone 3 temperature · peak firing \+\d+ °C from setpoint$/);
    expect(sp.explanation).toMatch(
      /^H-KILN\.zone3_temp_pv has been above its setpoint by more than the warning band for \d+ min \(since \d\d:\d\d\) while H-KILN is in operation: now 1,2\d\d °C against a setpoint of 1,195 °C \(\+\d\d °C\), largest deviation \d\d °C\. Warning band ±10 °C, alarm band ±20 °C; beyond the alarm band for \d+ min \(since \d\d:\d\d\)\. Reported after 5 min beyond the warning band; history read over the last 120 min \(\d\d:\d\d–\d\d:\d\d\)\./,
    );
    expect(measurement(sp, 'Beyond the alarm band for')!.value as number).toBeGreaterThanOrEqual(5);
    expect(measurement(sp, 'Deviation now')!.value as number).toBeGreaterThan(20);
    expect(sp.chartRef).toBe('chart:process:H-KILN.zone3_temp_pv');
    expect(sp.next).toMatch(/^Check the burners and combustion air of kiln zone 3 .* \(H-KILN\.zone2_temp_pv and H-KILN\.zone4_temp_pv\)\./);
    // A possible quality effect is an association to investigate, never a cause.
    expect(sp.next).toMatch(/to investigate: a time association, not a proven cause/);
    expect(sp.provenance.scenarioId).toBeDefined();
    expect(sp.provenance.note).toMatch(/A simulated scenario acts on this scope/);

    const lim = finding('PC-LIMIT', 'H-KILN', ZONE3);
    expect(lim.status).toBe('fired');
    expect(lim.severity).toBe('serious');
    expect(lim.title).toBe('Single-layer roller kiln: zone 3 temperature · peak firing above its alarm limit');
    expect(lim.explanation).toMatch(/^H-KILN\.zone3_temp_pv has been above its high warning limit of 1,205 °C for \d+ min .* Alarm limit 1,215 °C: beyond it for \d+ min/);
    expect(lim.explanation).toMatch(/checked regardless of the setpoint/);
    // The readings stay plausible: not a measurement problem.
    expect(finding('PC-MEASUREMENT', 'H-KILN', ZONE3).status).toBe('clear');
    expect(plantFindings(s, { top: 30 }).top.map((f) => f.key)).toEqual(expect.arrayContaining([sp.key, lim.key]));
  });

  it('a deviation within the warning band stays clear', () => {
    const sp = finding('PC-SETPOINT', 'H-KILN', ZONE2);
    expect(sp.status).toBe('clear');
    expect(Math.abs(measurement(sp, 'Deviation now')!.value as number)).toBeLessThanOrEqual(10);
    expect(sp.explanation).toMatch(/within the warning band ±10 °C/);
    expect(sp.provenance.scenarioId).toBeDefined();
    expect(finding('PC-LIMIT', 'H-KILN', ZONE2).status).toBe('clear');
  });

  it("'data-quality' bad quality: PC-MEASUREMENT fires, the deviation and limit checks of that PV only are not evaluated", () => {
    const mes = finding('PC-MEASUREMENT', 'F-DRY', 'F-DRY.zone1_temp_pv');
    expect(mes.status).toBe('fired');
    expect(mes.severity).toBe('warning');
    expect(mes.explanation).toMatch(/^F-DRY\.zone1_temp_pv — measurement invalid while F-DRY is in operation: a bad quality flag on 15 of the last 15 min; first invalid sample of this episode at \d\d:\d\d\./);
    expect(mes.explanation).toMatch(/Source note: Bad quality flag from the source/);
    expect(mes.firstSeen).toBe(t0);
    expect(mes.next).toMatch(/^Check the transmitter of F-DRY\.zone1_temp_pv and the channel status at its PLC input/);
    for (const rule of ['PC-SETPOINT', 'PC-LIMIT']) {
      const f = finding(rule, 'F-DRY', 'F-DRY.zone1_temp_pv');
      expect(f.status, rule).toBe('insufficient-data');
      expect(f.missingSignals).toEqual([expect.objectContaining({ signalId: 'F-DRY.zone1_temp_pv', reason: expect.stringMatching(/^bad quality flag/) })]);
      expect(f.explanation).toMatch(/^Not evaluated — requires F-DRY\.zone1_temp_pv \(Dryer zone 1 temperature · actual\): bad quality flag/);
    }
    // The other dryer zone is still evaluated.
    expect(finding('PC-SETPOINT', 'F-DRY', 'F-DRY.zone2_temp_pv').status).toBe('clear');
  });

  it("'data-quality' spike: an implausible reading fires PC-MEASUREMENT on the spiked PV", () => {
    const mes = finding('PC-MEASUREMENT', 'D-TWR', 'D-TWR.inlet_temp_pv');
    expect(mes.status).toBe('fired');
    expect(mes.explanation).toMatch(/reading(s)? outside its engineering range of 0–700 °C \(latest 1,050 °C at \d\d:\d\d\); first invalid sample of this episode at \d\d:\d\d/);
    expect(mes.firstSeen).toBe(spike.start);
    expect(finding('PC-SETPOINT', 'D-TWR', 'D-TWR.inlet_temp_pv').status).not.toBe('fired');
    expect(finding('PC-MEASUREMENT', 'D-TWR', 'D-TWR.powder_moisture_pv').status).toBe('clear');
  });

  it("'data-quality' gap: no samples while in operation is an invalid measurement", () => {
    const mes = finding('PC-MEASUREMENT', 'D-TWR', 'D-TWR.outlet_temp_pv');
    expect(mes.status).toBe('fired');
    expect(mes.explanation).toMatch(/^D-TWR\.outlet_temp_pv — measurement invalid while D-TWR is in operation: no sample in 15 of the last 15 min; first invalid sample of this episode at \d\d:\d\d\./);
    expect(mes.firstSeen).toBe(t0);
    expect(mes.next).toMatch(/^Check why D-TWR\.outlet_temp_pv delivers no samples/);
    const sp = finding('PC-SETPOINT', 'D-TWR', 'D-TWR.outlet_temp_pv');
    expect(sp.status).toBe('insufficient-data');
    expect(sp.missingSignals[0]).toMatchObject({ signalId: 'D-TWR.outlet_temp_pv', reason: expect.stringMatching(/^no current value/) });
  });

  it('a frozen PV is not current: not evaluated (stale) for that zone only — not a deviation, not an invalid measurement', () => {
    for (const rule of ['PC-SETPOINT', 'PC-LIMIT', 'PC-MEASUREMENT']) {
      const f = finding(rule, 'H-KILN', ZONE1);
      expect(f.status, rule).toBe('insufficient-data');
      expect(f.staleSignals.map((x) => x.signalId)).toEqual([ZONE1]);
      expect(f.explanation).toMatch(/^Not evaluated — requires H-KILN\.zone1_temp_pv \(Zone 1 temperature · preheating · actual\): not current — last value \d\d:\d\d/);
      expect(f.next).toMatch(/data feed \(PLC \/ gateway link\) of H-KILN/);
    }
    expect(finding('PC-SETPOINT', 'H-KILN', 'H-KILN.zone4_temp_pv').status).toBe('clear');
  });

  it('a cleared deviation is reported as recently resolved', () => {
    const t1 = s.minute;
    clearScenario(s, alarm.id);
    advance(s, t1 + 10);
    for (const rule of ['PC-SETPOINT', 'PC-LIMIT']) {
      const f = finding(rule, 'H-KILN', ZONE3);
      expect(f.status, rule).toBe('clear');
      expect(f.resolvedAt!, rule).toBeGreaterThanOrEqual(t1 - 1);
      expect(f.resolvedAt!, rule).toBeLessThanOrEqual(t1 + 1);
      expect(f.lastSeen).toBeNull();
    }
    expect(finding('PC-SETPOINT', 'H-KILN', ZONE3).explanation).toMatch(/It was beyond the warning band from \d\d:\d\d to \d\d:\d\d \(\d+ min, largest deviation \d\d °C\)\./);
  });
});

describe('restart recovery', () => {
  const ZONE = 'F-DRY.zone2_temp_pv';
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let stopAt = 0;
  let restart = 0;
  beforeAll(() => {
    stopAt = s.minute;
    const sc = activateScenario(s, { kind: 'machine-stop', equipmentId: 'F-DRY', end: null, label: 'Dryer breakdown' });
    advance(s, stopAt + 30);
    clearScenario(s, sc.id);
    restart = s.minute;
    advance(s, restart + 8);
  });

  it('a dryer zone still cold after the restart is information within the restart allowance, naming the stop', () => {
    const sp = finding('PC-SETPOINT', 'F-DRY', ZONE);
    expect(sp.status).toBe('fired');
    expect(sp.severity).toBe('info');
    expect(sp.firstSeen).toBe(restart);
    expect(sp.title).toMatch(/^Multi-deck roller dryer: dryer zone 2 temperature −\d+ °C from setpoint — recovering after the restart$/);
    const lead = `F-DRY restarted at ${formatClock(restart)} after a stop (Simulated breakdown (scenario), ${formatClock(stopAt)}–${formatClock(restart)}) with its dryer zone 2 temperature still outside the warning band: the value is recovering from the stop. F-DRY.zone2_temp_pv has been below its setpoint`;
    expect(sp.explanation.startsWith(lead)).toBe(true);
    expect(sp.explanation).toContain(`Within the 60-min restart allowance this is information; still outside the warning band at ${formatClock(restart + 60)}, it is reported at its full severity.`);
    expect(measurement(sp, 'Beyond the alarm band for')!.value as number).toBeGreaterThanOrEqual(5);
    expect(sp.next).toMatch(new RegExp(`^${esc(`Confirm the dryer zone 2 temperature is back within the warning band by ${formatClock(restart + 60)} (end of the restart allowance); if it is not, check the burner`)}`));
    const lim = finding('PC-LIMIT', 'F-DRY', ZONE);
    expect(lim.status).toBe('fired');
    expect(lim.severity).toBe('info');
    expect(lim.title).toMatch(/below its alarm limit — recovering after the restart$/);
  });

  it('after the allowance — here set to 5 min for the dryer — the same episode is reported at its full severity', () => {
    const values = { 'PC-SETPOINT.restartMin@F-DRY': 5, 'PC-LIMIT.restartMin@F-DRY': 5 };
    const sp = finding('PC-SETPOINT', 'F-DRY', ZONE, { values });
    expect(sp.severity).toBe('serious');
    expect(sp.title).not.toMatch(/recovering/);
    expect(sp.explanation).toContain(
      `It has been outside the warning band since F-DRY restarted at ${formatClock(restart)} after a stop (Simulated breakdown (scenario), ${formatClock(stopAt)}–${formatClock(restart)}) — longer than the 5-min restart allowance for a value recovering from a stop.`,
    );
    expect(sp.next).toMatch(/^Check the burner \/ hot-air supply of dryer zone 2/);
    expect(finding('PC-LIMIT', 'F-DRY', ZONE, { values }).severity).toBe('serious');
    // A deviation that starts while the machine runs (not at a restart) gets no allowance: the kiln zone 3 case above.
  });
});
