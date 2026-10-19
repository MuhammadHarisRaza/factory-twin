/**
 * Performance guards for the live views (the per-minute work at 60× speed): the shared per-minute memo, the live
 * throttles of rule findings and history charts (src/sim/live.ts, src/intel/rules/live.ts,
 * src/ui/equipment/intel/live.ts), the primitive-value check of useSimValue and the faster noise draw — each must keep
 * the values a fresh computation gives. The timing checks have loose bounds (a busy machine must not fail them); they
 * catch a regression to evaluating everything every minute.
 */
import { describe, expect, it } from 'vitest';
import { findingsFor, liveFindingsFor, livePlantFindings, LIVE_FINDINGS_MIN, plantFindings } from '../intel/rules';
import { activateScenario, advance, createSim } from '../sim/engine';
import { hashString, mulberry32, noise01, smoothNoise } from '../sim/rng';
import { samePrimitives } from '../sim/store';
import { seriesOf } from '../sim/telemetry';
import { DEFAULT_START } from '../sim/time';
import { DEFAULT_INTEL_CONTEXT, deriveEquipmentIntel } from '../ui/equipment/intel/derive';
import { chartsFresh } from '../ui/equipment/intel/live';

describe('primitives keep their values', () => {
  it('noise01 is mulberry32(hashString(`seed:key:index`))()', () => {
    for (const seed of [1, 81, 12345])
      for (const key of ['ink', 'pv:H-KILN.zone3_temp_pv:a', 'sens:C-BM1:v'])
        for (const i of [0, 1, -3, 17, 2.5, 99999, 1e7]) expect(noise01(seed, key, i)).toBe(mulberry32(hashString(`${seed}:${key}:${i}`))());
    const ref = (t: number) => {
      const k = Math.floor(t / 17);
      const f = (t - k * 17) / 17;
      const a = mulberry32(hashString(`7:pv:x:a:${k}`))();
      const b = mulberry32(hashString(`7:pv:x:a:${k + 1}`))();
      return a + (b - a) * (f * f * (3 - 2 * f));
    };
    for (const t of [0, 5, 16, 17, 400, 10351]) expect(smoothNoise(7, 'pv:x:a', t, 17)).toBe(ref(t));
  });

  it('useSimValue keeps a value of the same primitives, never one holding objects', () => {
    expect(samePrimitives('running', 'running')).toBe(true);
    expect(samePrimitives(3, 4)).toBe(false);
    expect(samePrimitives(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(samePrimitives({ count: 2, worst: null }, { count: 2, worst: null })).toBe(true);
    const rec = { status: 'active' };
    // A simulation record is mutated in place: the same reference may carry new content.
    expect(samePrimitives(rec, rec)).toBe(false);
    expect(samePrimitives([rec], [rec])).toBe(false);
  });
});

describe('shared per minute and live throttles', () => {
  const s = createSim(3, DEFAULT_START);

  it('a history is computed once per minute and version, and equals a fresh computation', () => {
    const a = seriesOf(s, 'H-KILN.zone3_temp_pv', '8h');
    expect(seriesOf(s, 'H-KILN.zone3_temp_pv', '8h')).toBe(a);
    s.version++;
    const b = seriesOf(s, 'H-KILN.zone3_temp_pv', '8h');
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
    advance(s, s.minute + 1);
    expect(seriesOf(s, 'H-KILN.zone3_temp_pv', '8h')!.t[0]).toBe(a!.t[0] + 1);
  });

  it('live findings: reused for less than LIVE_FINDINGS_MIN minutes, then (and on a material change) evaluated again', () => {
    const scope = { kind: 'equipment' as const, equipmentId: 'H-KILN' };
    const first = liveFindingsFor(s, scope);
    expect(first.at).toBe(s.minute);
    expect(first.value).toEqual(findingsFor(s, scope));
    advance(s, s.minute + LIVE_FINDINGS_MIN - 1);
    const kept = liveFindingsFor(s, scope);
    // Unless something material happened in the meantime (a stop, an event), the evaluation is reused.
    if (kept.at === first.at) expect(kept.value).toBe(first.value);
    advance(s, s.minute + 1);
    expect(liveFindingsFor(s, scope).at).toBe(s.minute);
    advance(s, s.minute + 1);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    const after = liveFindingsFor(s, scope);
    expect(after.at).toBe(s.minute);
    expect(after.value).toEqual(findingsFor(s, scope));
    const plant = livePlantFindings(s, 5);
    expect(plant.value.findings).toEqual(plantFindings(s, { top: 5 }).findings);
  });

  it('live charts: 8 h sets at most 5 minutes old, hourly sets within the hour, minute sets every minute', () => {
    expect(chartsFresh('8h', 600, 604)).toBe(true);
    expect(chartsFresh('8h', 600, 605)).toBe(false);
    expect(chartsFresh('24h', 601, 660)).toBe(true);
    expect(chartsFresh('24h', 601, 661)).toBe(false);
    expect(chartsFresh('1h', 600, 601)).toBe(false);
    expect(chartsFresh('15m', 600, 601)).toBe(false);
  });

  it('a live card says how old its findings and charts are, and is otherwise the fresh model', () => {
    const t = createSim(5, DEFAULT_START);
    const ctx = { ...DEFAULT_INTEL_CONTEXT, live: true };
    deriveEquipmentIntel(t, 'H-KILN', ctx);
    advance(t, t.minute + 2);
    const live = deriveEquipmentIntel(t, 'H-KILN', ctx);
    const fresh = deriveEquipmentIntel(t, 'H-KILN');
    if (live.charts?.at != null) expect(live.charts.at).toBeLessThan(t.minute);
    if (live.findings?.at != null) expect(live.findings.at).toBeLessThanOrEqual(t.minute);
    // Everything that is not throttled reads the same as the fresh model.
    expect(live.header).toEqual(fresh.header);
    expect(live.metrics).toEqual(fresh.metrics);
    expect(live.signalTable).toEqual(fresh.signalTable);
    expect(live.log).toEqual(fresh.log);
    expect(live.process).toEqual(fresh.process);
  });
});

describe('per-minute cost (loose bounds)', () => {
  it('a live kiln card and the Overview feed cost well under evaluating everything each minute', () => {
    const t = createSim(9, DEFAULT_START);
    const ctx = { ...DEFAULT_INTEL_CONTEXT, live: true };
    const run = (fn: () => void) => {
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) {
        advance(t, t.minute + 1);
        fn();
      }
      return performance.now() - t0;
    };
    run(() => deriveEquipmentIntel(t, 'H-KILN', ctx)); // warm-up
    const liveMs = run(() => {
      deriveEquipmentIntel(t, 'H-KILN', ctx);
      livePlantFindings(t, 5);
    });
    const freshMs = run(() => {
      deriveEquipmentIntel(t, 'H-KILN');
      plantFindings(t, { top: 5 });
    });
    expect(liveMs).toBeLessThan(freshMs * 0.9);
    // ≈ 10–20 ms per minute on a quiet developer machine; the bound only catches a large regression.
    expect(liveMs / 10).toBeLessThan(400);
  });
});
