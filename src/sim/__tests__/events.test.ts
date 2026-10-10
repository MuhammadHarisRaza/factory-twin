/**
 * Shared event / evidence engine: the end-to-end demonstration scenarios of the spec run headless
 * against the same records every workspace, the report, the PDF and the copilot read.
 */
import { describe, expect, it } from 'vitest';
import { activateScenario, advance, clearScenario, createSim } from '../engine';
import { acknowledgeEvent, addEventNote, canResolve, evidenceOf, investigateEvent, qualityWindow, resolveEvent } from '../events';
import { lineMetrics, machineMetrics, operationalState, qualityIn, stageIO, capacityBreakdown } from '../metrics';
import { signalValue } from '../signals';
import { buildEventReport, eventImpact } from '../../intel/report';
import { DEFAULT_FINANCE } from '../finance';

/** Mid-shift, two days of history (fast). */
const START = 2 * 1440 + 240;
const win = (from: number, to: number) => ({ from, to, label: 'test' });
const newEvents = (s: ReturnType<typeof createSim>, from: number) => s.events.filter((e) => e.start >= from - 30 && e.lastUpdate >= from);

describe('Scenario A · conveyor stoppage', () => {
  it('state change → event → evidence → consequence → impact → report → recovery', () => {
    const s = createSim(51, START);
    s.liveFrom = START; // live session: snapshots are requested
    const t0 = s.minute;
    const sc = activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: t0 + 25, label: 'Packing belt stop' });
    advance(s, t0 + 15);
    expect(s.machines['CV-PACK'].state).toBe('down');
    expect(operationalState(s, 'CV-PACK')).toBe('stopped');
    const ev = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-PACK' && e.start >= t0)!;
    expect(ev).toBeTruthy();
    expect(ev.start).toBe(t0);
    expect(ev.source).toBe('scenario');
    expect(ev.refs.scenarioId).toBe(sc.id);
    expect(ev.trigger.ruleId).toBe('R-CONV');
    // Evidence is stored against the event id.
    const evd = evidenceOf(s, ev);
    expect(evd.every((x) => x.eventId === ev.id)).toBe(true);
    expect(evd.map((x) => x.kind)).toEqual(expect.arrayContaining(['state-transition', 'counter-series', 'camera-snapshot', 'metrics']));
    expect(evd.find((x) => x.kind === 'camera-snapshot')!.status).toBe('pending');
    // Packing is starved because of the conveyor — an inferred, linked consequence, not a second root event.
    const starved = s.events.find((e) => e.type === 'starvation' && e.consequenceOf === ev.id);
    expect(starved).toBeTruthy();
    expect(starved!.causes[0].confidence).toBe('likely');
    expect(ev.related).toContain(starved!.id);
    // The accumulation buffer absorbs it: no line output lost, and the impact says so.
    expect(ev.acc.constraintMin).toBe(0);
    const imp = eventImpact(s, ev, DEFAULT_FINANCE);
    expect(imp.notes.join(' ')).toMatch(/No line output lost/);
    // No duplicates while the condition persists.
    expect(s.events.filter((e) => e.dedupeKey === ev.dedupeKey && e.end == null)).toHaveLength(1);
    // Report built from the same record.
    const rep = buildEventReport(s, ev.id)!;
    expect(rep.summary.id).toBe(ev.id);
    expect(rep.asset.kind).toBe('Conveyor');
    expect(rep.detection.rule).toBe('R-CONV');
    expect(rep.context.related.some((r) => r.id === starved!.id && r.relation === 'Consequence of this event')).toBe(true);
    expect(rep.provenance.unavailable.some((u) => /Video segment/.test(u.title))).toBe(true);
    // Recovery: condition cleared, unacknowledged → auto-resolved, history kept.
    advance(s, t0 + 40);
    expect(ev.end).toBe(t0 + 25);
    expect(ev.status).toBe('resolved');
    expect(ev.resolution?.by).toBe('system');
    expect(ev.history.map((h) => h.action)).toEqual(expect.arrayContaining(['detected', 'cleared', 'resolved']));
    expect(ev.facts.some((f) => /Recovered at/.test(f))).toBe(true);
    expect(s.events).toContain(ev);
    void sc;
  });

  it('a stopped kiln infeed conveyor costs line output, valued under the root event only', () => {
    const s = createSim(52, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 20, label: 'Kiln infeed stop' });
    advance(s, t0 + 20);
    const ev = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-KIN' && e.start >= t0)!;
    expect(s.machines['H-KILN'].state).toBe('starved');
    expect(ev.acc.constraintMin).toBeGreaterThan(10);
    const kilnStarved = s.events.find((e) => e.type === 'starvation' && e.asset.equipmentId === 'H-KILN' && e.start >= t0)!;
    expect(kilnStarved.consequenceOf).toBe(ev.id);
    const rootImp = eventImpact(s, ev);
    const consImp = eventImpact(s, kilnStarved);
    expect(rootImp.estimate!.total).toBeGreaterThan(0);
    // The consequence reports the loss but values it under the root event.
    expect(consImp.estimate?.lines.some((l) => /Lost good output/.test(l.label)) ?? false).toBe(false);
    expect(consImp.notes.join(' ')).toMatch(new RegExp(ev.id));
  });
});

describe('Ball mill stopped (spec example)', () => {
  it('records start, signals, impact; recovery records final downtime', () => {
    const s = createSim(53, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'C-BM1', end: t0 + 30, label: 'Ball mill 1 stop' });
    advance(s, t0 + 5);
    const ev = s.events.find((e) => e.asset.equipmentId === 'C-BM1' && e.dedupeKey === 'stop:C-BM1' && e.end == null)!;
    expect(ev.type).toBe('machine-stop');
    expect(ev.facts[0]).toMatch(/C-BM1\.state changed .* → STOPPED/);
    const kinds = evidenceOf(s, ev).map((x) => x.kind);
    expect(kinds).toContain('signal-series'); // condition-monitored asset: vibration / temperature / current
    advance(s, t0 + 40);
    expect(ev.end).toBe(t0 + 30);
    expect(ev.facts.some((f) => /final downtime 30 min/.test(f))).toBe(true);
    // Slip tanks covered the stop: no line output lost.
    expect(ev.acc.constraintMin).toBe(0);
  });
});

describe('Scenario B · OEE loss', () => {
  it('reduced kiln rate → performance falls, below-rate event, constraint loss quantified', () => {
    const s = createSim(54, START);
    const t0 = s.minute;
    const before = machineMetrics(s, 'H-KILN', win(t0 - 60, t0));
    activateScenario(s, { kind: 'reduced-rate', equipmentId: 'H-KILN', factor: 0.6, end: null, label: 'Kiln at 60 %' });
    advance(s, t0 + 60);
    const after = machineMetrics(s, 'H-KILN', win(t0, t0 + 60));
    expect(after.oee.performance.value!).toBeLessThan(before.oee.performance.value! - 0.25);
    const lm = lineMetrics(s, win(t0, t0 + 60));
    expect(lm.oee.oee.value!).toBeCloseTo(lm.oee.availability.value! * lm.oee.performance.value! * lm.oee.quality.value!, 9);
    const ev = s.events.find((e) => e.type === 'below-rate' && e.asset.equipmentId === 'H-KILN')!;
    expect(ev.severity).toBe('serious');
    expect(ev.causes[0].confidence).toBe('confirmed');
    // Capacity breakdown attributes the loss to speed (performance) at the constraint.
    const cap = capacityBreakdown(s, win(t0, t0 + 60));
    const speed = cap.losses.find((l) => l.key === 'speed')!;
    expect(speed.m2).toBeGreaterThan(cap.losses.find((l) => l.key === 'availability')!.m2);
    expect(cap.theoreticalM2 - cap.losses.reduce((a, l) => a + l.m2, 0)).toBeCloseTo(cap.goodM2, 6);
  });

  it('the sorter running below its capacity because the kiln feeds it less is not a rate event', () => {
    const s = createSim(55, START);
    advance(s, s.minute + 120);
    expect(s.events.some((e) => e.type === 'below-rate' && e.asset.equipmentId === 'I-SORT' && e.start >= START)).toBe(false);
  });
});

describe('Scenario C · defect deterioration', () => {
  it('inspection records, rejects, quality and events reconcile', () => {
    const s = createSim(56, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze ×5' });
    advance(s, t0 + 90);
    const evs = newEvents(s, t0).filter((e) => e.category === 'quality');
    expect(evs.map((e) => e.type)).toEqual(expect.arrayContaining(['defect-count']));
    expect(evs.some((e) => e.type === 'defect-rate' || e.type === 'defect-deterioration')).toBe(true);
    const ev = evs.find((e) => e.type === 'defect-count')!;
    expect(['surface', 'glaze']).toContain(ev.refs.defect);
    // Image evidence points at real inspection records of the event's category.
    const imgs = evidenceOf(s, ev).filter((x) => x.kind === 'inspection-image' && x.status === 'available');
    expect(imgs.length).toBeGreaterThan(0);
    for (const x of imgs) expect(s.inspections.find((r) => r.id === x.inspectionId)?.defect).toBe(ev.refs.defect);
    // Minute-level window and hourly buckets agree on full hours.
    const h0 = Math.ceil(t0 / 60) * 60;
    const fromLog = qualityWindow(s, h0 + 59, 60);
    const fromBuckets = qualityIn(s, win(h0, h0 + 60));
    expect(fromLog.inspected).toBeCloseTo(fromBuckets.inspected, 2); // minute log is Float32
    expect(fromLog.rejected).toBeCloseTo(fromBuckets.rejected, 2);
    // Line quality rate = accepted ÷ inspected, and OEE = A × P × Q.
    const lm = lineMetrics(s, win(h0, h0 + 60));
    expect(lm.oee.quality.value!).toBeCloseTo((lm.inspected - lm.rejected) / lm.inspected, 9);
    const imp = eventImpact(s, ev);
    expect(imp.estimate!.lines.some((l) => /Scrap/.test(l.label))).toBe(true);
    expect(ev.causes.some((c) => c.confidence === 'confirmed' && /scenario/i.test(c.text))).toBe(true);
    expect(ev.causes.some((c) => c.confidence === 'possible')).toBe(true);
  });
});

describe('Scenario D · truck delay', () => {
  it('truck arrival + prolonged dock stay → dock event with timeline, turnaround grows, clears on departure', () => {
    const s = createSim(57, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'truck-arrival', end: null, label: 'Truck' });
    advance(s, t0 + 45);
    activateScenario(s, { kind: 'prolonged-dock-stay', count: 90, end: null, label: 'Hold at dock' });
    advance(s, t0 + 200);
    const ev = s.events.find((e) => e.type === 'dock-overstay' && e.start >= t0 - 60)!;
    expect(ev).toBeTruthy();
    expect(ev.source).toBe('scenario');
    const tl = evidenceOf(s, ev).find((x) => x.kind === 'vehicle-timeline')!;
    expect(tl.milestones!.find((m) => m.label === 'Gate in')!.t).not.toBeNull();
    expect(ev.acc.waitMin).toBeGreaterThan(0);
    advance(s, t0 + 360);
    expect(ev.end).not.toBeNull();
    const v = s.logistics.vehicles[ev.asset.vehicleId!];
    expect(v.visit!.dockEnd! - v.visit!.dockStart!).toBeGreaterThanOrEqual(s.rules.dockStayMax);
  });

  it('restricted-zone entry scenario creates a linked logistics event', () => {
    const s = createSim(58, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'restricted-entry', vehicleId: 'FL-05', end: null, label: 'Walkway shortcut' });
    advance(s, t0 + 40);
    const ev = s.events.find((e) => e.type === 'restricted-entry' && e.asset.vehicleId === 'FL-05' && e.start >= t0)!;
    expect(ev).toBeTruthy();
    expect(ev.source).toBe('scenario');
    expect(ev.facts.join(' ')).toMatch(/simulated/i);
  });
});

describe('Scenario E · reset', () => {
  it('a fresh simulation from the seed restores the baseline — no orphaned events or counters', () => {
    const a = createSim(59, START);
    activateScenario(a, { kind: 'conveyor-stop', equipmentId: 'CV-SORT', end: null, label: 'x' });
    activateScenario(a, { kind: 'quality-deterioration', stage: 'PRESS', factor: 4, end: null, label: 'y' });
    advance(a, START + 60);
    acknowledgeEvent(a, a.events[a.events.length - 1].id);
    const fresh = createSim(59, START);
    const again = createSim(59, START);
    expect(again.events.map((e) => [e.id, e.type, e.start, e.end, e.status])).toEqual(fresh.events.map((e) => [e.id, e.type, e.start, e.end, e.status]));
    expect(again.evidence.length).toBe(fresh.evidence.length);
    expect(again.machines['CV-SORT'].state).not.toBe('down');
    expect(fresh.events.some((e) => e.source === 'scenario')).toBe(false);
    expect(again.machines['H-KILN'].countTotal).toBe(fresh.machines['H-KILN'].countTotal);
  });
});

describe('Event lifecycle', () => {
  it('acknowledge → investigate → note → resolve (only after the condition cleared)', () => {
    const s = createSim(60, START);
    const t0 = s.minute;
    const sc = activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press 2' });
    advance(s, t0 + 3);
    const ev = s.events.find((e) => e.dedupeKey === 'stop:E-PRS2' && e.end == null)!;
    expect(acknowledgeEvent(s, ev.id).ok).toBe(true);
    expect(ev.status).toBe('acknowledged');
    expect(investigateEvent(s, ev.id).ok).toBe(true);
    expect(addEventNote(s, ev.id, 'Hydraulic hose checked').ok).toBe(true);
    expect(canResolve(ev).ok).toBe(false);
    expect(resolveEvent(s, ev.id, 'Replaced hose').ok).toBe(false);
    clearScenario(s, sc.id);
    advance(s, s.minute + 2);
    // Acknowledged events are not auto-resolved: they wait for the owner.
    expect(ev.end).not.toBeNull();
    expect(ev.status).toBe('investigating');
    expect(resolveEvent(s, ev.id, 'Replaced hydraulic hose', 'Hose replaced, pressure test OK').ok).toBe(true);
    expect(ev.status).toBe('resolved');
    expect(ev.resolution).toMatchObject({ by: 'user', reason: 'Replaced hydraulic hose' });
    expect(ev.history.map((h) => h.action)).toEqual(['detected', 'acknowledged', 'investigating', 'note', 'cleared', 'updated', 'resolved']);
  });

  it('same seed and inputs → identical events (deterministic)', () => {
    const a = createSim(61, START + 300);
    const b = createSim(61, START + 300);
    expect(a.events.map((e) => `${e.id}|${e.type}|${e.start}|${e.end}|${e.severity}`)).toEqual(b.events.map((e) => `${e.id}|${e.type}|${e.start}|${e.end}|${e.severity}`));
  });
});

describe('Data-source transparency', () => {
  it('a simulated PLC link loss makes the asset unknown, freezes its signals and raises counter inactivity', () => {
    const s = createSim(62, START);
    const t0 = s.minute;
    const sc = activateScenario(s, { kind: 'signal-loss', equipmentId: 'E-PRS1', end: null, label: 'PLC link' });
    advance(s, t0 + 6);
    expect(operationalState(s, 'E-PRS1')).toBe('unknown');
    const v = signalValue(s, 'E-PRS1.count_total');
    expect(v.quality).toBe('stale');
    advance(s, t0 + 9);
    expect(signalValue(s, 'E-PRS1.count_total').value).toBe(v.value);
    const ev = s.events.find((e) => e.type === 'counter-inactive' && e.asset.equipmentId === 'E-PRS1')!;
    expect(ev.category).toBe('data');
    clearScenario(s, sc.id);
    advance(s, s.minute + 2);
    expect(ev.end).not.toBeNull();
    expect(operationalState(s, 'E-PRS1')).not.toBe('unknown');
  });

  it('stage I/O follows the configured counting points', () => {
    const s = createSim(63, START);
    const io = stageIO(s, 'SORT', win(START - 120, START));
    expect(io.good! + io.rejected!).toBeGreaterThan(0);
    expect(io.input).toBeGreaterThan(0);
    const wh = stageIO(s, 'WH', win(START - 600, START));
    expect(wh.unit).toBe('pallets');
  });
});
