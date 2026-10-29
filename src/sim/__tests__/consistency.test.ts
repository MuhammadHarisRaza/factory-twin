/**
 * Regression tests for the second code review: one event record → the same figures in the report,
 * the PDF, the insights and the monitoring views, whenever and wherever they are read.
 */
import { describe, expect, it } from 'vitest';
import { DEFECTS, M2_PER_TILE, MONITORED_STAGE_BY_ID, TARGET } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { insights } from '../../intel/insights';
import { buildEventReport, eventImpact, fpyBefore, lineGoodLostTiles } from '../../intel/report';
import { activateScenario, advance, clearScenario, createSim, LOG_MIN, minuteAt } from '../engine';
import { attachEvidenceImage, eventInMonitoredStage, evidenceOf, qualityWindow } from '../events';
import { capacityBreakdown, hourlyTrend, lineMetrics, resolvePeriod, targetStatus } from '../metrics';

const START = 2 * 1440 + 240;
const win = (from: number, to: number) => ({ from, to, label: 'test' });
const row = (ev: OpEvent, s: ReturnType<typeof createSim>, label: string) => eventImpact(s, ev).rows.find((r) => r.label.startsWith(label));

describe('quality events: one window, one reference, final once cleared (#0, #8, #15, #27)', () => {
  const s = createSim(56, START);
  const t0 = s.minute;
  const sc = activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze ×5' });
  // Step minute by minute: when an event clears, its counts must equal the minute log over its window.
  const checkedAtClear = new Set<string>();
  const mismatches: string[] = [];
  for (let m = t0; m < t0 + 200; m++) {
    if (m === t0 + 90) clearScenario(s, sc.id);
    advance(s, m + 1);
    for (const e of s.events) {
      if (e.category !== 'quality' || e.end == null || checkedAtClear.has(e.id) || e.start < t0 - 130) continue;
      checkedAtClear.add(e.id);
      if (s.minute - e.start > LOG_MIN) continue;
      const w = qualityWindow(s, e.end - 1, e.end - e.start, e.refs.defect);
      if (Math.abs(w.inspected - e.acc.inspected) > 0.01 || Math.abs(w.rejected - e.acc.rejects) > 0.01)
        mismatches.push(`${e.id}: acc ${e.acc.inspected}/${e.acc.rejects} vs log ${w.inspected}/${w.rejected}`);
    }
  }
  const quality = s.events.filter((e) => e.category === 'quality' && e.start >= t0 - 130);
  const closed = quality.filter((e) => e.end != null);

  it('accumulates the whole window from the condition start (backfilled at detection)', () => {
    expect(checkedAtClear.size).toBeGreaterThan(2);
    expect(mismatches).toEqual([]);
  });

  it('a cleared event shows the same impact and cost hours later', () => {
    expect(closed.length).toBeGreaterThan(2);
    const snap = (e: OpEvent) => {
      const imp = eventImpact(s, e);
      return JSON.stringify({ rows: imp.rows, total: imp.estimate?.total, lines: imp.estimate?.lines });
    };
    const before = closed.map(snap);
    advance(s, t0 + 700);
    expect(closed.map(snap)).toEqual(before);
  });

  it('values excess rejects against the reference the rule detected with', () => {
    const det = quality.filter((e) => e.type === 'defect-deterioration');
    expect(det.length).toBeGreaterThan(0);
    for (const e of det) {
      const observed = e.trigger.observed.find((o) => o.label === 'Reference (24 h)')!.value;
      expect(`${(e.acc.referenceRejectRate! * 100).toFixed(2)} %`).toBe(observed);
      expect(row(e, s, 'Rate vs 24 h reference')!.value.endsWith(`vs ${observed}`)).toBe(true);
    }
  });

  it('files defect-count events under the defect origin stage, still listed at sorting', () => {
    const counts = quality.filter((e) => e.type === 'defect-count');
    expect(counts.length).toBeGreaterThan(0);
    for (const e of counts) {
      expect(e.asset.stage).toBe(DEFECTS[e.refs.defect!].origin);
      expect(eventInMonitoredStage(MONITORED_STAGE_BY_ID.GLAZE, e)).toBe(true);
      expect(eventInMonitoredStage(MONITORED_STAGE_BY_ID.SORT, e)).toBe(true);
    }
  });

  it('says the root cause is unconfirmed only when no cause is confirmed', () => {
    const confirmed = quality.find((e) => e.causes.some((c) => c.confidence === 'confirmed'))!;
    expect(confirmed).toBeTruthy();
    expect(eventImpact(s, confirmed).estimate!.limitations.join(' ')).not.toMatch(/Root cause not confirmed/);
    const h = createSim(61, START);
    const plain = h.events.find((e) => e.category === 'quality' && !e.causes.some((c) => c.confidence === 'confirmed'))!;
    expect(plain).toBeTruthy();
    expect(eventImpact(h, plain).estimate!.limitations.join(' ')).toMatch(/Root cause not confirmed/);
  });
});

describe('critical-defect groups: every referenced record has its frame (#3)', () => {
  it('records joining an open group add their inspection frame', () => {
    const s = createSim(57, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'quality-deterioration', stage: 'KILN', factor: 10, end: t0 + 480, label: 'Kiln ×10' });
    advance(s, t0 + 480);
    const crit = s.events.filter((e) => e.type === 'critical-defect' && e.start >= t0);
    expect(crit.some((e) => e.facts.length > 1)).toBe(true); // at least one group grew after detection
    for (const e of crit) {
      const frames = evidenceOf(s, e).filter((x) => x.kind === 'inspection-image' && x.inspectionId).map((x) => x.inspectionId!);
      expect([...frames].sort()).toEqual([...(e.refs.inspectionIds ?? [])].sort());
      const rep = buildEventReport(s, e.id)!;
      expect(rep.visualEvidence.filter((x) => x.kind === 'inspection-image').length).toBe(frames.length);
    }
  });
});

describe('production events: one line-loss figure (#4, #13, #25)', () => {
  it('the insight shows the report figure (24 h FPY, not a constant) and says the attribution is inferred', () => {
    const s = createSim(54, START);
    const t0 = s.minute;
    const q = activateScenario(s, { kind: 'quality-deterioration', stage: 'PRESS', factor: 8, end: null, label: 'Press ×8' });
    advance(s, t0 + 360);
    clearScenario(s, q.id);
    const t1 = s.minute;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t1 + 40, label: 'Kiln infeed stop' });
    advance(s, t1 + 35);
    const ev = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-KIN' && e.start >= t1)!;
    expect(Math.abs(fpyBefore(s, ev.start) - 0.975)).toBeGreaterThan(0.005);
    const lostM2 = lineGoodLostTiles(s, ev) * M2_PER_TILE;
    expect(row(ev, s, 'Line good output lost')!.value).toBe(`${lostM2.toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} m²`);
    const ins = insights(s).find((i) => i.id === `stop-${ev.id}`)!;
    expect(ins.impact).toBe(`${Math.round(lostM2).toLocaleString('en-GB')} m² line output lost so far`);
    expect(ins.evidence.join(' ')).toMatch(/attributed to this stop \(inferred · likely\)/);
    expect(row(ev, s, 'Kiln (line constraint) held up')!.basis).toMatch(/attributed to this event \(inferred/);
  });

  it('the kiln typical rate is the hour before the condition began, not its own slow minutes', () => {
    const s = createSim(54, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'reduced-rate', equipmentId: 'H-KILN', factor: 0.6, end: null, label: 'Kiln at 60 %' });
    advance(s, t0 + 30);
    const ev = s.events.find((e) => e.type === 'below-rate' && e.asset.equipmentId === 'H-KILN' && e.start >= t0)!;
    expect(ev).toBeTruthy();
    let sum = 0;
    let n = 0;
    for (let m = ev.start - 60; m < ev.start; m++) {
      const x = minuteAt(s, 'H-KILN', m);
      if (x && (x.state === 'running' || x.state === 'reduced')) {
        sum += x.rate;
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(10);
    expect(ev.acc.kilnTypicalRate).toBeCloseTo(sum / n, 9);
    expect(row(ev, s, 'Kiln (line constraint) held up')!.basis).toMatch(/observed/);
  });
});

describe('conveyor events are filed under the monitored stage that lists them (#5)', () => {
  it('a glaze-line conveyor stop belongs to glazing & decoration', () => {
    const s = createSim(61, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-GLZ', end: t0 + 20, label: 'Glaze belt stop' });
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PAL', end: t0 + 20, label: 'Carton conveyor stop' });
    advance(s, t0 + 10);
    const glz = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-GLZ' && e.start >= t0)!;
    expect(glz.asset.stage).toBe('GLAZE');
    expect(eventInMonitoredStage(MONITORED_STAGE_BY_ID.GLAZE, glz)).toBe(true);
    expect(eventInMonitoredStage(MONITORED_STAGE_BY_ID.KILN, glz)).toBe(false);
    expect(buildEventReport(s, glz.id)!.asset.stage).toBe(MONITORED_STAGE_BY_ID.GLAZE.name);
    const pal = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-PAL' && e.start >= t0)!;
    expect(pal.asset.stage).toBe('PACK');
  });
});

describe('report text from the record, not the current settings (#6, #10)', () => {
  it('the impact basis keeps the threshold the event was detected with', () => {
    const s = createSim(60, START);
    s.rules.truckWaitMax = 2;
    activateScenario(s, { kind: 'yard-congestion', end: null, label: 'Arrivals' });
    advance(s, s.minute + 40);
    const ev = s.events.find((e) => e.type === 'truck-waiting')!;
    expect(ev).toBeTruthy();
    s.rules.truckWaitMax = 45;
    expect(row(ev, s, 'Minutes beyond the threshold')!.basis).toBe('Counted from detection (threshold 2 min)');
    expect(buildEventReport(s, ev.id)!.detection.threshold).toMatchObject({ value: 2, unit: 'min' });
  });

  it('limitations do not call a frame from a configured camera stream a twin render', () => {
    const s = createSim(51, START);
    s.liveFrom = START;
    const t0 = s.minute;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: t0 + 25, label: 'Packing belt stop' });
    advance(s, t0 + 5);
    const ev = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-PACK' && e.start >= t0)!;
    const before = buildEventReport(s, ev.id)!.provenance;
    expect(before.liveCamera).toBe(false);
    expect(before.disclaimers.join(' ')).toMatch(/No camera image is included/);
    const snap = evidenceOf(s, ev).find((x) => x.kind === 'camera-snapshot')!;
    attachEvidenceImage(s, snap.id, { key: snap.id, width: 960, height: 540, frameTime: s.minute }, { origin: 'live-camera', sourceId: snap.cameraId ?? 'CAM', label: 'Camera frame from the configured stream' });
    const after = buildEventReport(s, ev.id)!.provenance;
    expect(after.liveCamera).toBe(true);
    const text = after.disclaimers.join(' ');
    expect(text).toMatch(/frame from a configured stream/);
    expect(text).not.toMatch(/No PLC, SCADA, camera/);
    expect(text).not.toMatch(/No camera image is included/);
  });
});

describe('plan and capacity (#24, #26)', () => {
  it('a planned stop at the kiln lowers the plan instead of showing as a shortfall', () => {
    const base = createSim(61, START + 300);
    const s = createSim(61, START + 300);
    const t0 = s.minute;
    activateScenario(s, { kind: 'maintenance', equipmentId: 'H-KILN', count: 60, end: null, label: 'Kiln maintenance' });
    advance(s, t0 + 120);
    advance(base, t0 + 120);
    const p = resolvePeriod('shift', s.minute);
    const lm = lineMetrics(s, p);
    const planned = lm.constraint.totals.plannedStop;
    expect(planned).toBe(60);
    expect(lm.target).toBeCloseTo((TARGET.goodPerHour * (p.to - p.from - planned)) / 60, 9);
    expect(lineMetrics(base, p).target - lm.target).toBeCloseTo(TARGET.goodPerHour, 9);
    // Not 'behind' because of the plan's own stop: the status reflects the planned hours only.
    expect(['ahead', 'on-track']).toContain(targetStatus(lm.attainment));
    const cap = capacityBreakdown(s, p);
    expect(cap.plannedM2).toBeCloseTo(lm.targetM2, 9);
    expect(cap.planGapM2).toBeCloseTo(lm.targetM2 - cap.goodM2, 9);
    // The hourly plan agrees with the period plan.
    const trend = hourlyTrend(s, p);
    expect(trend.reduce((a, h) => a + h.target, 0)).toBeCloseTo(lm.target, 6);
    expect(Math.min(...trend.map((h) => h.target))).toBe(0);
  });

  it('quality is the rejects of the period; WIP between kiln and sorting is a signed transit step', () => {
    const s = createSim(52, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 40, label: 'Kiln infeed stop' });
    advance(s, t0 + 180);
    let negative = 0;
    for (let h = t0; h < t0 + 180; h += 60) {
      const p = win(h, h + 60);
      const cap = capacityBreakdown(s, p);
      const lm = lineMetrics(s, p);
      const step = (k: string) => cap.losses.find((l) => l.key === k)!;
      expect(step('quality').m2).toBeCloseTo(lm.rejected * M2_PER_TILE, 9);
      if (lm.rejected > 0) expect(step('quality').m2).toBeGreaterThan(0);
      expect(step('transit').m2).toBeCloseTo((lm.constraint.totals.count - lm.inspected) * M2_PER_TILE, 9);
      expect(step('transit').kind).toBe('transit');
      if (step('transit').m2 < 0) negative++;
      // The waterfall closes exactly to good output.
      expect(cap.theoreticalM2 - cap.losses.reduce((a, l) => a + l.m2, 0)).toBeCloseTo(cap.goodM2, 6);
      for (const l of cap.losses.filter((x) => x.kind === 'loss')) expect(l.m2).toBeGreaterThanOrEqual(0);
    }
    void negative;
  });
});
