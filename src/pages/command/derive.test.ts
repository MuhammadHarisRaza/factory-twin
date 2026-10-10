import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { downtimePareto, resolvePeriod } from '../../sim/metrics';
import { ALERT_WINDOW_MIN, TIMELINE_WINDOW_MIN, attentionList, machineLosses, qualityExceptions, recentAlerts, shiftCompare, strip, timeline } from './derive';

describe('command center derivations', () => {
  const s = createSim(11, 3 * 1440 + 4 * 60 + 30);

  it('lists recent alerts newest first inside the window', () => {
    const a = recentAlerts(s);
    for (const x of a) expect(x.time).toBeGreaterThanOrEqual(s.minute - ALERT_WINDOW_MIN);
    for (let i = 1; i < a.length; i++) expect(a[i - 1].time).toBeGreaterThanOrEqual(a[i].time);
  });

  it('merges a newest-first timeline without duplicate stop alerts', () => {
    const tl = timeline(s, { gate: true });
    for (const x of tl) {
      expect(x.time).toBeGreaterThanOrEqual(s.minute - TIMELINE_WINDOW_MIN);
      expect(x.time).toBeLessThanOrEqual(s.minute);
    }
    for (let i = 1; i < tl.length; i++) expect(tl[i - 1].time).toBeGreaterThanOrEqual(tl[i].time);
    const stops = new Set(tl.filter((x) => x.kind === 'stop').map((x) => `${x.equipmentId}@${x.time}`));
    for (const x of tl) if (x.kind === 'alert' && x.title.endsWith(' stopped')) expect(stops.has(`${x.equipmentId}@${x.time}`)).toBe(false);
    expect(new Set(tl.map((x) => x.key)).size).toBe(tl.length);
  });

  it('machine losses agree with the downtime pareto minutes', () => {
    const p = resolvePeriod('shift', s.minute);
    const byMachine = machineLosses(s, p).reduce((a, r) => a + r.minutes, 0);
    const byReason = downtimePareto(s, p).reduce((a, r) => a + r.minutes, 0);
    expect(byMachine).toBeCloseTo(byReason, 6);
    for (const r of machineLosses(s, p)) expect(r.lostM2).toBeGreaterThanOrEqual(0);
  });

  it('flags stopped and reduced machines as requiring attention', () => {
    const t = createSim(5, 2 * 1440 + 300);
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press 2 stop' });
    activateScenario(t, { kind: 'reduced-rate', equipmentId: 'G-INK', factor: 0.6, end: null, label: 'Inkjet slow' });
    advance(t, t.minute + 5);
    const rows = attentionList(t);
    const press = rows.find((r) => r.id === 'E-PRS2')!;
    expect(press.kinds).toContain('down');
    expect(press.scenario).toBe(true);
    const ink = rows.find((r) => r.id === 'G-INK')!;
    expect(ink.kinds).toContain('reduced');
    expect(ink.reasons[0]).toMatch(/60 %/);
    expect(rows.indexOf(press)).toBeLessThan(rows.indexOf(ink));
    const tl = timeline(t);
    expect(tl.some((x) => x.kind === 'scenario-start' && x.title.includes('Press 2 stop'))).toBe(true);
    expect(tl.some((x) => x.kind === 'stop' && x.equipmentId === 'E-PRS2')).toBe(true);
  });

  it('builds the strip, quality exceptions and shift comparison', () => {
    const st = strip(s, DEFAULT_TARIFFS);
    expect(st.lm.target).toBeGreaterThan(0);
    expect(st.bn.machines.length).toBeGreaterThan(0);
    const q = qualityExceptions(s);
    expect(q.rows.length).toBe(7);
    expect(q.batch.id).toBeTruthy();
    const sc = shiftCompare(s);
    expect(sc.previous.period.to).toBe(sc.current.period.from);
  });
});
