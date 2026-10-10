import { describe, expect, it } from 'vitest';
import { MONITORED_STAGES } from '../../model/plant';
import { acknowledgeEvent } from '../../sim/events';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { DEFAULT_FINANCE } from '../../sim/finance';
import { downtimePareto, resolvePeriod } from '../../sim/metrics';
import {
  TIMELINE_WINDOW_MIN,
  attentionList,
  byPriority,
  eventActions,
  eventCounts,
  machineLosses,
  prioritisedEvents,
  qualityExceptions,
  shiftCompare,
  stageIssues,
  strip,
  timeline,
  useCases,
} from './derive';

describe('command center derivations', () => {
  const s = createSim(11, 3 * 1440 + 4 * 60 + 30);

  it('orders open events unacknowledged first, then by severity', () => {
    const t = createSim(5, 2 * 1440 + 300);
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    activateScenario(t, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: null, label: 'Packing belt stop' });
    advance(t, t.minute + 3);
    const open = prioritisedEvents(t);
    expect(open.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < open.length; i++) expect(byPriority(open[i - 1], open[i])).toBeLessThanOrEqual(0);
    const kiln = open.find((e) => e.asset.equipmentId === 'H-KILN')!;
    expect(kiln.severity).toBe('critical');
    // Acknowledging moves it behind every unacknowledged event and changes the next lifecycle step.
    expect(acknowledgeEvent(t, kiln.id).ok).toBe(true);
    const after = prioritisedEvents(t);
    const firstAck = after.findIndex((e) => e.status !== 'active');
    expect(after.slice(firstAck).every((e) => e.status !== 'active')).toBe(true);
    expect(eventActions(t).find((a) => a.ev.id === kiln.id)!.next).toBe('investigate');
    const c = eventCounts(after);
    expect(c.open).toBe(after.length);
    expect(c.unacknowledged).toBe(after.filter((e) => e.status === 'active').length);
    expect(prioritisedEvents(t, 'unacknowledged').every((e) => e.status === 'active')).toBe(true);
    expect(prioritisedEvents(t, 'condition').every((e) => e.end == null)).toBe(true);
  });

  it('builds a newest-first timeline from events and scenario inputs', () => {
    const t = createSim(5, 2 * 1440 + 300);
    const sc = activateScenario(t, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: t.minute + 10, label: 'Packing belt stop' });
    advance(t, t.minute + 15);
    const tl = timeline(t, { lifecycle: true });
    for (const x of tl) {
      expect(x.time).toBeGreaterThanOrEqual(t.minute - TIMELINE_WINDOW_MIN);
      expect(x.time).toBeLessThanOrEqual(t.minute);
    }
    for (let i = 1; i < tl.length; i++) expect(tl[i - 1].time).toBeGreaterThanOrEqual(tl[i].time);
    expect(new Set(tl.map((x) => x.key)).size).toBe(tl.length);
    expect(tl.some((x) => x.kind === 'scenario-start' && x.key === `${sc.id}:s`)).toBe(true);
    const stop = t.events.find((e) => e.type === 'conveyor-stop' && e.refs.scenarioId === sc.id)!;
    expect(tl.some((x) => x.kind === 'detected' && x.eventId === stop.id)).toBe(true);
    expect(tl.some((x) => x.kind === 'cleared' && x.eventId === stop.id)).toBe(true);
    // Every event item points at the record it came from.
    for (const x of tl) if (x.eventId) expect(t.events.some((e) => e.id === x.eventId)).toBe(true);
  });

  it('machine losses agree with the downtime pareto minutes', () => {
    const p = resolvePeriod('shift', s.minute);
    const byMachine = machineLosses(s, p).reduce((a, r) => a + r.minutes, 0);
    const byReason = downtimePareto(s, p).reduce((a, r) => a + r.minutes, 0);
    expect(byMachine).toBeCloseTo(byReason, 6);
    for (const r of machineLosses(s, p)) expect(r.lostM2).toBeGreaterThanOrEqual(0);
  });

  it('lists stopped conveyors, stale feeds and reduced machines as requiring attention', () => {
    const t = createSim(5, 2 * 1440 + 300);
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press 2 stop' });
    activateScenario(t, { kind: 'reduced-rate', equipmentId: 'G-INK', factor: 0.6, end: null, label: 'Inkjet slow' });
    activateScenario(t, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: null, label: 'Packing belt stop' });
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'E-PRS1', end: null, label: 'Press 1 feed loss' });
    advance(t, t.minute + 5);
    const rows = attentionList(t);
    const press = rows.find((r) => r.id === 'E-PRS2')!;
    expect(press.kinds).toContain('down');
    expect(press.scenario).toBe(true);
    expect(press.eventId).not.toBeNull();
    const belt = rows.find((r) => r.id === 'CV-PACK')!;
    expect(belt.conveyor).toBe(true);
    expect(belt.kinds).toContain('down');
    const stale = rows.find((r) => r.id === 'E-PRS1')!;
    expect(stale.kinds).toEqual(['stale']);
    expect(stale.op).toBe('unknown');
    const ink = rows.find((r) => r.id === 'G-INK')!;
    expect(ink.kinds).toContain('reduced');
    expect(ink.reasons[0]).toMatch(/60 %/);
    expect(rows.indexOf(press)).toBeLessThan(rows.indexOf(ink));
    expect(rows.indexOf(stale)).toBeLessThan(rows.indexOf(ink));

    const issues = stageIssues(t);
    expect(issues.stages).toBe(MONITORED_STAGES.length);
    const pack = issues.issues.find((i) => i.stage === 'PACK')!;
    expect(pack.assetId).toBe('CV-PACK');
    const pressing = issues.issues.find((i) => i.stage === 'PRESS')!;
    expect(['stopped', 'fault']).toContain(pressing.state);
    expect(strip(t, DEFAULT_TARIFFS).attention.stale).toBe(1);
  });

  it('builds the use cases, strip, quality exceptions and shift comparison', () => {
    const u = useCases(s, DEFAULT_FINANCE);
    expect(u.oee.target).toBeGreaterThan(0.5);
    expect(u.oee.planGapM2).toBeGreaterThanOrEqual(0);
    expect(u.oee.value).toBeGreaterThanOrEqual(0);
    expect(u.production.stages).toBe(MONITORED_STAGES.length);
    expect(u.vehicles.waiting).toBeLessThanOrEqual(u.vehicles.onSite);
    const st = strip(s, DEFAULT_TARIFFS);
    expect(st.bn.machines.length).toBeGreaterThan(0);
    expect(st.events.open).toBe(prioritisedEvents(s).length);
    const q = qualityExceptions(s);
    expect(q.rows.length).toBe(7);
    expect(q.batch.id).toBeTruthy();
    expect(q.events.every((e) => e.category === 'quality')).toBe(true);
    const sc = shiftCompare(s);
    expect(sc.previous.period.to).toBe(sc.current.period.from);
  });
});
