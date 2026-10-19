import { describe, expect, it } from 'vitest';
import { SIGNALS } from '../../model/plant';
import { activateScenario, advance, createSim } from '../engine';
import { PLACEHOLDER_SIGNAL_IDS, signalValue } from '../signals';

const START = 2 * 1440 + 240;

describe('signalValue', () => {
  it('is deterministic for the same seed and minute', () => {
    const a = createSim(7, START);
    const b = createSim(7, START);
    for (const sig of SIGNALS) expect(signalValue(a, sig.id)).toEqual(signalValue(b, sig.id));
  });

  it('mirrors machine runtime and buffer state', () => {
    const s = createSim(7, START);
    expect(signalValue(s, 'H-KILN.count_total').value).toBe(Math.round(s.machines['H-KILN'].countTotal));
    expect(signalValue(s, 'H-KILN.state').value).toBe(s.machines['H-KILN'].state);
    const lvl = signalValue(s, 'D-SILO.level').value as number;
    expect(lvl).toBeGreaterThanOrEqual(0);
    expect(lvl).toBeLessThanOrEqual(100);
  });

  it('gives every simulated signal a value and the not-modelled process analogs none (null, never a plausible number)', () => {
    const s = createSim(7, START);
    for (const id of ['H-KILN.temp_firing', 'H-KILN.temp_preheat', 'D-TWR.temp_inlet', 'D-TWR.powder_moisture', 'F-DRY.temp_deck', 'A-COMP.header_pressure', 'A-WTR.tank_level']) {
      expect(PLACEHOLDER_SIGNAL_IDS.has(id), id).toBe(true);
      expect(signalValue(s, id), id).toEqual({ value: null, text: '—' });
    }
    for (const sig of SIGNALS) {
      if (PLACEHOLDER_SIGNAL_IDS.has(sig.id)) continue;
      expect(signalValue(s, sig.id).text, sig.id).not.toBe('—');
    }
    // Energy-model readings come from the model's buckets (no fabricated zero before a bucket exists).
    expect(signalValue(s, 'A-SUB.active_power').value as number).toBeGreaterThan(0);
  });

  it('serves the snapshot of every signal of a stale asset — nothing live leaks through', () => {
    const s = createSim(7, START);
    advance(s, s.minute + 5);
    const ids = SIGNALS.filter((x) => x.equipmentId === 'CV-SORT' || x.equipmentId === 'H-KILN').map((x) => x.id);
    const before = Object.fromEntries(ids.map((id) => [id, signalValue(s, id)]));
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'CV-SORT', end: null, label: 'feed loss' });
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'feed loss' });
    // Stop the kiln while its feed is stale: its alarm and state must still read the last values received.
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'stop' });
    advance(s, s.minute + 30);
    for (const id of ids) {
      const r = signalValue(s, id);
      expect(r.quality, id).toBe('stale');
      expect({ value: r.value, text: r.text }, id).toEqual({ value: before[id].value, text: before[id].text });
    }
    expect(s.machines['H-KILN'].state).toBe('down');
    expect(signalValue(s, 'H-KILN.alarm').value).toBe(before['H-KILN.alarm'].value);
    // The conveyor's speed is the last value received, not the nominal speed.
    expect(signalValue(s, 'CV-SORT.speed').value).toBe(before['CV-SORT.speed'].value);
  });
});
