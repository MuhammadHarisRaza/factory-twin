/**
 * Simulated process model (src/sim/process.ts): PVs follow their setpoints, follow the stopped behaviour of
 * their spec through stops, derived values agree with the simulated rate, everything is deterministic, and
 * a 'process-deviation' scenario offsets its PV and — beyond the warning band — raises the reject weights of
 * the defects that originate at its stage, with the batch id kept on the affected inspections.
 */
import { describe, expect, it } from 'vitest';
import { KG_PER_TILE, PRESS_CAVITIES, PROCESS_SIGNALS, PROCESS_SIGNAL_BY_ID, TILES_PER_CARTON } from '../../model/catalog/process';
import { DEFECTS, DEFECT_ORDER, OPS_BY_ID, TILES_PER_PALLET } from '../../model/plant';
import type { DefectCategory } from '../../model/types';
import { LOG_MIN, activateScenario, advance, batchAt, clearScenario, createSim, minuteAt, type SimState } from '../engine';
import { countAt, deviationBoosts, processValue, rateAt, stopAt } from '../process';

const START = 2 * 1440 + 240;
const ZONE3 = 'H-KILN.zone3_temp_pv';
const sp = (id: string) => PROCESS_SIGNAL_BY_ID[id].nominal!;
const num = (s: SimState, id: string, t?: number) => processValue(s, id, t) as number;

/** Rejects of the given defects in [from, to) from the per-minute quality log. */
function rejectsOf(s: SimState, defects: DefectCategory[], from: number, to: number) {
  let n = 0;
  for (let m = from; m < to; m++) {
    const i = m % LOG_MIN;
    if (s.qualityLog.t[i] !== m) continue;
    for (const d of defects) n += s.qualityLog.defect[d][i];
  }
  return n;
}

describe('process values follow their setpoints', () => {
  const s = createSim(11, START);

  it('every PV is within its noise band of its setpoint while its machine runs (settled)', () => {
    let checked = 0;
    for (const spec of PROCESS_SIGNALS.filter((p) => p.role === 'pv')) {
      for (let t = s.minute - 120; t < s.minute; t += 7) {
        if (stopAt(s, spec.equipmentId, t)) continue;
        // Skip minutes still recovering from a decaying stop in the last 8 h.
        const recent = s.downtime.some((d) => d.equipmentId === spec.equipmentId && d.category !== 'Starved' && d.category !== 'Blocked' && (d.end ?? s.minute) > t - 480 && d.start <= t);
        if (recent && spec.stopped?.kind === 'decay') continue;
        const v = processValue(s, spec.id, t);
        if (v == null) continue; // 'none' PV in a minute without output
        expect(Math.abs((v as number) - spec.nominal!), `${spec.id} @${t}`).toBeLessThanOrEqual(spec.noise! + 1e-9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('setpoints are the recipe values; commands are on while the machine is not stopped', () => {
    for (const spec of PROCESS_SIGNALS.filter((p) => p.role === 'sp')) expect(processValue(s, spec.id)).toBe(spec.nominal);
    for (const spec of PROCESS_SIGNALS.filter((p) => p.role === 'command')) expect(processValue(s, spec.id), spec.id).toBe(!stopAt(s, spec.equipmentId, s.minute - 1));
  });

  it('has no value before the start or after the last simulated minute, and none for an unknown id', () => {
    expect(processValue(s, ZONE3, -5)).toBeNull();
    expect(processValue(s, ZONE3, s.minute)).toBeNull();
    expect(processValue(s, 'H-KILN.nope')).toBeNull();
  });
});

describe('stopped behaviour (kiln)', () => {
  it('decays after a breakdown, recovers after the restart and holds through a planned stop', () => {
    const s = createSim(12, START);
    const start = s.minute;
    const before = num(s, ZONE3, start - 1);
    const sc = activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln breakdown' });
    advance(s, start + 60);
    expect(stopAt(s, 'H-KILN', start + 59)?.kind).toBe('down');
    const z30 = num(s, ZONE3, start + 29);
    const z59 = num(s, ZONE3, start + 59);
    // Relaxes towards the stoppedDown value (500 °C, τ 180 min): well below the setpoint and still falling.
    expect(z30).toBeLessThan(before - 50);
    expect(z59).toBeLessThan(z30 - 30);
    expect(z59).toBeGreaterThan(500);
    const spec = PROCESS_SIGNAL_BY_ID[ZONE3];
    const expected = 500 + (before - 500) * Math.exp(-60 / 180);
    expect(z59).toBeCloseTo(expected, 0);
    // Cooling zone 5 decays towards 80 °C, the roller drive and the command are off.
    expect(num(s, 'H-KILN.zone5_temp_pv')).toBeLessThan(sp('H-KILN.zone5_temp_pv'));
    expect(processValue(s, 'H-KILN.roller_speed')).toBe(0);
    expect(processValue(s, 'H-KILN.run_command')).toBe(false);
    expect(spec.stopped?.kind).toBe('hold');

    clearScenario(s, sc.id);
    const restart = s.minute;
    advance(s, restart + 120);
    const gapAtRestart = Math.abs(num(s, ZONE3, restart) - sp(ZONE3));
    const gapLater = Math.abs(num(s, ZONE3, restart + 119) - sp(ZONE3));
    expect(gapLater).toBeLessThan(gapAtRestart / 3);
    expect(processValue(s, 'H-KILN.run_command')).toBe(true);

    // Condition-based maintenance is a planned stop: the kiln idles hot, the zones hold their setpoints.
    const m0 = s.minute;
    activateScenario(s, { kind: 'maintenance', equipmentId: 'H-KILN', count: 30, end: null, label: 'Planned kiln maintenance' });
    advance(s, m0 + 20);
    expect(stopAt(s, 'H-KILN', m0 + 10)?.kind).toBe('planned');
    for (const t of [m0 + 5, m0 + 19]) {
      // Still recovering from the breakdown a little: within noise + the remaining recovery gap.
      expect(Math.abs(num(s, ZONE3, t) - sp(ZONE3))).toBeLessThan(spec.noise! + gapLater + 1);
    }
    expect(processValue(s, 'H-KILN.run_command')).toBe(false);
  });

  it("a 'none' PV has no value while its machine is stopped (press pressure)", () => {
    const s = createSim(13, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press stop' });
    advance(s, s.minute + 10);
    expect(processValue(s, 'E-PRS2.press_pressure_pv')).toBeNull();
    expect(processValue(s, 'E-PRS2.press_pressure_sp')).toBe(300);
    expect(processValue(s, 'E-PRS2.cycle_time')).toBeNull();
    expect(processValue(s, 'E-PRS2.strokes_per_min')).toBe(0);
    expect(processValue(s, 'E-PRS1.press_pressure_pv')).not.toBeNull();
  });
});

describe('derived values', () => {
  const s = createSim(14, START);
  const t = s.minute - 1;

  it('mass flows, strokes and cycle time agree with the simulated rate', () => {
    for (let k = 0; k < 60; k += 5) {
      const m = t - k;
      const twr = minuteAt(s, 'D-TWR', m)!.rate * 60;
      expect(num(s, 'D-TWR.powder_flow', m)).toBeCloseTo((twr * KG_PER_TILE) / 1000, 9);
      const mill = minuteAt(s, 'C-BM1', m)!.rate * 60;
      expect(num(s, 'C-BM1.slip_flow', m)).toBeCloseTo((mill * KG_PER_TILE) / 1000, 9);
      const press = minuteAt(s, 'E-PRS1', m)!.rate * 60;
      const strokes = num(s, 'E-PRS1.strokes_per_min', m);
      expect(strokes).toBeCloseTo(press / 60 / PRESS_CAVITIES, 9);
      if (strokes > 0) expect(num(s, 'E-PRS1.cycle_time', m) * strokes).toBeCloseTo(60, 9);
    }
    expect(num(s, 'E-PRS1.cycle_time_target')).toBeCloseTo(60 / (OPS_BY_ID['E-PRS1'].idealRatePerHour! / 60 / PRESS_CAVITIES), 9);
    // Beyond the minute log the rate comes from the hourly buckets (never a fabricated value before the start).
    expect(rateAt(s, 'D-TWR', t - LOG_MIN - 600)).not.toBeNull();
    expect(rateAt(s, 'D-TWR', -1)).toBeNull();
  });

  it('drive speeds follow the own pace: nominal × rate ÷ ideal at its own pace, 0 when stopped', () => {
    let checked = 0;
    for (let m = t - 120; m <= t; m++) {
      const x = minuteAt(s, 'H-KILN', m)!;
      if (x.limited || x.state === 'down' || x.state === 'planned') continue;
      const ratio = (x.rate * 60) / OPS_BY_ID['H-KILN'].idealRatePerHour!;
      expect(num(s, 'H-KILN.roller_speed', m)).toBeCloseTo(PROCESS_SIGNAL_BY_ID['H-KILN.roller_speed'].nominal! * ratio, 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('carton and pallet counters come from the count totals', () => {
    expect(processValue(s, 'J-BOX.carton_count')).toBe(Math.floor(s.machines['J-BOX'].countTotal / TILES_PER_CARTON + 1e-6));
    const pallets = processValue(s, 'J-PAL.pallet_count') as number;
    expect(pallets).toBe(Math.floor(s.machines['J-PAL'].countTotal / TILES_PER_PALLET + 1e-6));
    expect(Math.abs(pallets - s.logistics.palletsProduced)).toBeLessThanOrEqual(1);
    // Counters never decrease over the history.
    let prev = -1;
    for (let m = t - LOG_MIN + 1; m <= t; m += 13) {
      const c = processValue(s, 'J-BOX.carton_count', m) as number;
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it('a counter does not step back where the hourly estimate meets the minute log (stop early in the boundary hour)', () => {
    // J-BOX stopped for the first 30 min of an hour; the minute log then starts 45 min into that hour.
    const x = createSim(19, START);
    const t0 = x.minute;
    expect(t0 % 60).toBe(0);
    activateScenario(x, { kind: 'machine-stop', equipmentId: 'J-BOX', end: t0 + 30, label: 'Packing stop' });
    advance(x, t0 + 45 + LOG_MIN);
    let prev = -Infinity;
    for (let m = t0 - 5; m < t0 + 120; m++) {
      const c = countAt(x, 'J-BOX', m)!;
      expect(c, `@${m}`).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = c;
    }
    expect(countAt(x, 'J-BOX', t0 + 44)!).toBeCloseTo(countAt(x, 'J-BOX', t0 + 45)! - minuteAt(x, 'J-BOX', t0 + 45)!.rate, 6);
  });
});

describe('determinism', () => {
  it('the same seed and scenario log give the same process values at every minute', () => {
    const a = createSim(15, START);
    const b = createSim(15, START);
    for (const x of [a, b]) {
      activateScenario(x, { kind: 'process-deviation', signalId: 'E-PRS1.press_pressure_pv', offset: -25, rampMin: 5, end: null, label: 'Pressure drop' });
      advance(x, x.minute + 30);
    }
    for (const spec of PROCESS_SIGNALS) for (let t = a.minute - 200; t < a.minute; t += 17) expect(processValue(a, spec.id, t), `${spec.id} @${t}`).toEqual(processValue(b, spec.id, t));
  });
});

describe('process deviation → reject weights → batch', () => {
  const KILN_DEFECTS = DEFECT_ORDER.filter((d) => DEFECTS[d].origin === 'KILN');
  const OTHER = DEFECT_ORDER.filter((d) => DEFECTS[d].origin !== 'KILN');

  it('offsets the PV (ramped) and raises only the defects that originate at its stage', () => {
    const s = createSim(16, START);
    const base = createSim(16, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'process-deviation', signalId: ZONE3, offset: 30, rampMin: 10, end: null, label: 'Kiln zone 3 over-firing' });
    advance(s, t0 + 120);
    advance(base, t0 + 120);
    const spec = PROCESS_SIGNAL_BY_ID[ZONE3];
    // Ramp: a third of the offset after ~3 min, the full offset after 10.
    expect(Math.abs(num(s, ZONE3, t0 + 2) - sp(ZONE3) - 9)).toBeLessThanOrEqual(spec.noise! + 1e-9);
    for (const t of [t0 + 15, t0 + 60, t0 + 119]) expect(Math.abs(num(s, ZONE3, t) - (sp(ZONE3) + 30))).toBeLessThanOrEqual(spec.noise! + 1e-9);
    expect(num(base, ZONE3, t0 + 60) - sp(ZONE3)).toBeLessThanOrEqual(spec.noise!);
    // Beyond the warning band (±10 °C) by ~20 °C: the kiln's defect weights rise by 1 + 3 × excess ÷ band.
    const boost = deviationBoosts(s, t0 + 60, s.scenarios)['KILN']!;
    expect(boost).toBeGreaterThan(5);
    expect(boost).toBeLessThan(9);
    expect(deviationBoosts(base, t0 + 60, base.scenarios)).toEqual({});
    const live = rejectsOf(s, KILN_DEFECTS, t0 + 10, t0 + 120);
    const ref = rejectsOf(base, KILN_DEFECTS, t0 + 10, t0 + 120);
    expect(live).toBeGreaterThan(ref * 4);
    // Defects that originate elsewhere are unchanged (same tiles inspected, same weights).
    expect(rejectsOf(s, OTHER, t0 + 10, t0 + 120)).toBeCloseTo(rejectsOf(base, OTHER, t0 + 10, t0 + 120), 3);
  });

  it('a deviation within the warning band changes no reject weight; clearing it ends the coupling', () => {
    const s = createSim(17, START);
    const base = createSim(17, START);
    const t0 = s.minute;
    const sc = activateScenario(s, { kind: 'process-deviation', signalId: ZONE3, offset: 5, end: null, label: 'Small offset' });
    advance(s, t0 + 60);
    advance(base, t0 + 60);
    expect(num(s, ZONE3, t0 + 30) - sp(ZONE3)).toBeGreaterThan(1);
    expect(rejectsOf(s, KILN_DEFECTS, t0, t0 + 60)).toBeCloseTo(rejectsOf(base, KILN_DEFECTS, t0, t0 + 60), 3);
    clearScenario(s, sc.id);
    advance(s, s.minute + 5);
    expect(Math.abs(num(s, ZONE3) - sp(ZONE3))).toBeLessThanOrEqual(PROCESS_SIGNAL_BY_ID[ZONE3].noise!);
  });

  it('the affected inspections carry their batch id (batch correlation possible) and are marked as scenario-driven', () => {
    const s = createSim(18, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'process-deviation', signalId: ZONE3, offset: 35, end: null, label: 'Kiln zone 3 over-firing' });
    advance(s, t0 + 90);
    const recs = s.inspections.filter((r) => r.time >= t0 + 1 && r.result === 'reject' && r.defect && KILN_DEFECTS.includes(r.defect));
    expect(recs.length).toBeGreaterThan(10);
    for (const r of recs) {
      expect(r.batchId).toBe(batchAt(s, r.time - 180).id);
      expect(r.source).toBe('scenario');
    }
    expect(new Set(recs.map((r) => r.batchId)).size).toBeGreaterThanOrEqual(1);
    // Quality events on the kiln's defects name the deviation as a possible cause — correlation, not causation.
    const q = s.events.filter((e) => e.category === 'quality' && e.start >= t0 && e.refs.defect && KILN_DEFECTS.includes(e.refs.defect));
    expect(q.length).toBeGreaterThan(0);
    for (const e of q) {
      const c = e.causes.find((x) => /^Process deviation at firing/.test(x.text));
      expect(c, e.title).toBeDefined();
      // The deviation figure of the last simulated minute is named (the rules run inside the minute).
      expect(c!.text).toMatch(/\+\d+ °C from its setpoint/);
      expect(c!.confidence).toBe('possible');
      expect(c!.basis).toMatch(/not proof of causation/);
    }
  });
});
