import { describe, it } from 'vitest';
import { advance, createSim } from './sim/engine';
import { DEFAULT_START } from './sim/time';

describe('event growth', () => {
  it('counts', () => {
    const s = createSim(undefined, DEFAULT_START);
    for (let d = 1; d <= 30; d++) {
      advance(s, s.minute + 1440);
      if (d % 3) continue;
      const by: Record<string, number> = {};
      for (const e of s.events) {
        const k = `${e.historical ? 'H' : 'L'}:${e.status}:${e.end == null ? 'open' : 'closed'}`;
        by[k] = (by[k] ?? 0) + 1;
      }
      const first = s.events[0];
      console.log(`day ${d}: events=${s.events.length} evidence=${s.evidence.length} first=${first.id} start=${first.start} end=${first.end} status=${first.status}`, JSON.stringify(by));
    }
  }, 600_000);
});
