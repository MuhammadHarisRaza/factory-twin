/**
 * Data-feed rows and signal provenance shown in the equipment workspace's technical details
 * (ported from the retired Assets & Data page): every tracked asset reads "Simulated", a lost
 * feed reads "Stale since hh:mm" with its frozen values, and placeholder process values are
 * never presented as engine or condition data.
 */
import { describe, expect, it } from 'vitest';
import { CONVEYOR_IDS, PROCESS_MACHINES, SIGNALS } from '../../model/plant';
import { activateScenario, advance, clearScenario, createSim } from '../../sim/engine';
import { DEFAULT_START } from '../../sim/time';
import { feedOf, feedRows, feedSummary } from './feeds';
import { assetSignals, basisOf } from './signals';

describe('data feed rows', () => {
  it('lists every process machine and conveyor as simulated, and a lost feed as stale since its loss', () => {
    const s = createSim(20261012, DEFAULT_START);
    let rows = feedRows(s);
    expect(rows.map((r) => r.id).sort()).toEqual([...PROCESS_MACHINES, ...CONVEYOR_IDS].sort());
    expect(rows.every((r) => r.status === 'simulated' && r.statusLabel === 'Simulated' && r.last == null)).toBe(true);
    expect(feedSummary(rows)).toMatchObject({ machines: PROCESS_MACHINES.length, conveyors: CONVEYOR_IDS.length, stale: 0, longest: null });
    expect(rows.find((r) => r.id === 'CV-KIN')).toMatchObject({ kind: 'conveyor', stage: 'KILN' });
    expect(feedOf(s, 'A-PARK')).toBeNull();

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
    // Signals of a stale asset are the last values received.
    expect(assetSignals(s, 'E-PRS2').find((x) => x.def.name === 'state')!.reading.quality).toBe('stale');

    clearScenario(s, sc.id);
    advance(s, s.minute + 2);
    expect(feedRows(s).find((x) => x.id === 'E-PRS2')!.status).toBe('simulated');
  });

  it('marks placeholder process values as such', () => {
    const s = createSim(3, DEFAULT_START);
    const kiln = assetSignals(s, 'H-KILN');
    expect(kiln.map((r) => r.def.id)).toEqual(SIGNALS.filter((x) => x.equipmentId === 'H-KILN').map((x) => x.id));
    expect(kiln.find((r) => r.def.name === 'temp_firing')!.basis).toBe('placeholder');
    // No plausible-looking number for a parameter the model does not have.
    expect(kiln.find((r) => r.def.name === 'temp_firing')!.text).toBe('Not modelled');
    expect(kiln.every((r) => r.basis !== 'placeholder' || !/\d/.test(r.text))).toBe(true);
    expect(kiln.find((r) => r.def.name === 'vibration')!.basis).toBe('condition');
    expect(kiln.find((r) => r.def.name === 'count_total')!.basis).toBe('engine');
    expect(basisOf('powder_moisture')).toBe('placeholder');
    expect(basisOf('energy_kwh')).toBe('energy-model');
  });
});
