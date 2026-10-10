import { describe, expect, it } from 'vitest';
import { DEFECTS } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import {
  affectingScenario,
  compareFrames,
  frameById,
  framesIn,
  latestFrames,
  neighbourFrame,
  qualityScenarioImpacts,
} from './frames';
import { TILE, outlinePoints, parseMeasurement, scaleBar, tileGeometry, zoomOnBox } from './tileGeometry';

describe('vision frame feed', () => {
  const s = createSim(11, 2 * 1440 + 300);

  it('interleaves reject records with sampled pass frames, oldest first', () => {
    const feed = latestFrames(s, 16, 'all');
    expect(feed).toHaveLength(16);
    for (let i = 1; i < feed.length; i++) expect(compareFrames(feed[i - 1], feed[i])).toBeLessThan(0);
    expect(new Set(feed.map((f) => f.id)).size).toBe(16);
    expect(feed.every((f) => f.time < s.minute)).toBe(true);
    for (const f of feed) {
      if (f.kind === 'pass') expect(f.rec).toBeNull();
      else expect(f.rec?.box).not.toBeNull();
      expect(['ST-VIS', 'ST-GAUGE']).toContain(f.stationId);
    }
    // A longer window certainly contains both kinds.
    const wide = framesIn(s, s.minute - 240, s.minute, 'all');
    expect(wide.some((f) => f.kind === 'pass')).toBe(true);
    expect(wide.some((f) => f.kind === 'reject')).toBe(true);
  });

  it('rejects-only mode only contains tunnel / gauge reject records', () => {
    const feed = latestFrames(s, 16, 'rejects');
    expect(feed.length).toBe(16);
    expect(feed.every((f) => f.kind === 'reject' && f.rec?.result === 'reject')).toBe(true);
  });

  it('resolves frames by id and steps between neighbours', () => {
    const feed = latestFrames(s, 16, 'all');
    for (const f of feed) expect(frameById(s, f.id)?.id).toBe(f.id);
    expect(frameById(s, 'PF-not-a-minute')).toBeNull();
    const qc = s.inspections.find((r) => r.stationId === 'ST-QC');
    expect(qc && frameById(s, qc.id)).toBeNull();
    const last = feed[feed.length - 1];
    expect(neighbourFrame(s, last, -1, 'all')?.id).toBe(feed[feed.length - 2].id);
    expect(neighbourFrame(s, feed[feed.length - 2], 1, 'all')?.id).toBe(last.id);
    expect(neighbourFrame(s, last, 1, 'all')).toBeNull();
  });

  it('pass frames are deterministic across identical simulations', () => {
    const t = createSim(11, 2 * 1440 + 300);
    expect(latestFrames(t, 16, 'all').map((f) => f.id)).toEqual(latestFrames(s, 16, 'all').map((f) => f.id));
  });

  it('attributes rejects to an active quality-deterioration scenario and its batch', () => {
    const q = createSim(5, 2 * 1440 + 300);
    const base = createSim(5, 2 * 1440 + 300);
    const sc = activateScenario(q, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 6, end: null, label: 'Glazing defects ×6' });
    advance(q, q.minute + 90);
    advance(base, q.minute);
    const affected = q.inspections.filter((r) => affectingScenario(q, r));
    expect(affected.length).toBeGreaterThan(0);
    expect(affected.every((r) => r.defect && DEFECTS[r.defect].origin === 'GLAZE' && r.time >= sc.start)).toBe(true);
    const [im] = qualityScenarioImpacts(q, base);
    expect(im.scenario.id).toBe(sc.id);
    expect(im.records).toBe(affected.length);
    expect(im.batches.map((b) => b.batchId)).toContain(im.focus.batch.id);
    expect(im.baselineRejected).not.toBeNull();
    expect(im.rejected).toBeGreaterThan(im.baselineRejected!);
    // Records of other origins in the window are not attributed.
    const kilnRec = q.inspections.find((r) => r.time >= sc.start && r.defect && DEFECTS[r.defect].origin === 'KILN');
    if (kilnRec) expect(affectingScenario(q, kilnRec)).toBeNull();
  });
});

describe('tile geometry', () => {
  const s = createSim(3, 2 * 1440 + 300);
  const frames = framesIn(s, 0, s.minute, 'rejects');

  it('is deterministic per frame and draws every defect category inside its box', () => {
    const seen = new Set<string>();
    for (const f of frames) {
      const a = tileGeometry(f);
      const b = tileGeometry(f);
      expect(a).toEqual(b);
      expect(a.outline.endsWith('Z')).toBe(true);
      expect(a.defect?.kind).toBe(f.rec!.defect);
      seen.add(a.defect!.kind);
      const box = a.box!;
      if (a.defect?.kind === 'surface')
        for (const h of a.defect.holes) {
          expect(h.x).toBeGreaterThanOrEqual(box.x);
          expect(h.x).toBeLessThanOrEqual(box.x + box.w);
        }
      if (a.defect?.kind === 'crack') {
        const nums = a.defect.main.match(/-?\d+(\.\d+)?/g)!.map(Number);
        for (let i = 0; i < nums.length; i += 2) {
          expect(nums[i]).toBeGreaterThanOrEqual(box.x - 1);
          expect(nums[i]).toBeLessThanOrEqual(box.x + box.w + 1);
        }
      }
    }
    expect(seen.size).toBe(7);
  });

  it('chips the corner the box marks', () => {
    const chip = frames.find((f) => f.rec?.defect === 'chip')!;
    const g = tileGeometry(chip);
    const b = chip.rec!.box!;
    const cx = b.x < 0.5 ? 0 : TILE;
    const cy = b.y < 0.5 ? 0 : TILE;
    // The original corner point is no longer part of the outline.
    expect(g.outline.includes(`M${cx} ${cy} `) || g.outline.includes(`L${cx} ${cy} `)).toBe(false);
    expect(outlinePoints({}).length).toBe(160);
  });

  it('parses measurements and sizes the zoom and scale bar', () => {
    expect(parseMeasurement('surface', '7 pinholes / spots in 100 cm²').count).toBe(7);
    expect(parseMeasurement('glaze', 'Glaze weight deviation −6.2 %')).toEqual({ sign: -1, value: 6.2 });
    expect(parseMeasurement('dimension', 'Caliber 600.8 mm (600 ± 0.6)').sign).toBe(1);
    expect(parseMeasurement('planarity', 'Centre deviation +0.62 mm (limit ±0.40)')).toEqual({ sign: 1, value: 0.62 });
    const pin = tileGeometry(frames.find((f) => f.rec?.defect === 'surface')!);
    const z = zoomOnBox(pin)!;
    expect(z.k).toBeGreaterThan(2);
    expect(scaleBar(1).mm).toBe(100);
    expect(scaleBar(3.4).mm).toBeLessThan(100);
  });
});
