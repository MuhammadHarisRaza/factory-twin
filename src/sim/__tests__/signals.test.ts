import { describe, expect, it } from 'vitest';
import { SIGNALS } from '../../model/plant';
import { createSim } from '../engine';
import { signalValue } from '../signals';

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

  it('keeps analog values in plausible bounds and gives every signal a value', () => {
    const s = createSim(7, START);
    const firing = signalValue(s, 'H-KILN.temp_firing').value as number;
    expect(firing).toBeGreaterThan(1100);
    expect(firing).toBeLessThan(1250);
    const p = signalValue(s, 'A-COMP.header_pressure').value as number;
    expect(p).toBeGreaterThan(6);
    expect(p).toBeLessThan(8);
    for (const sig of SIGNALS) expect(signalValue(s, sig.id).text, sig.id).not.toBe('—');
  });
});
