import { describe, expect, it } from 'vitest';
import { DEFECTS } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { activeQualityScenario, affectingScenario, frameById, frameForRecord, skuOf, type Frame } from './frames';
import { TILE, outlinePoints, parseMeasurement, tileGeometry } from './tileGeometry';

describe('inspection frames of simulated records', () => {
  const s = createSim(11, 2 * 1440 + 300);

  it('resolves the frame of a tunnel or gauge record by id; lab samples have none', () => {
    const vis = s.inspections.find((r) => r.stationId === 'ST-VIS' && r.result === 'reject')!;
    const gauge = s.inspections.find((r) => r.stationId === 'ST-GAUGE' && r.result === 'reject')!;
    for (const r of [vis, gauge]) {
      const f = frameById(s, r.id)!;
      expect(f.id).toBe(r.id);
      expect(f.rec).toBe(r);
      expect(f.sku).toBe(skuOf(s, r.batchId));
      expect(f.kind).toBe('reject');
    }
    const qc = s.inspections.find((r) => r.stationId === 'ST-QC');
    expect(qc && frameById(s, qc.id)).toBeNull();
    expect(frameById(s, 'INS-not-retained')).toBeNull();
  });

  it('attributes rejects to an active quality-deterioration scenario of their origin stage only', () => {
    const q = createSim(5, 2 * 1440 + 300);
    expect(activeQualityScenario(q)).toBeNull();
    const sc = activateScenario(q, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 6, end: null, label: 'Glazing defects ×6' });
    advance(q, q.minute + 90);
    expect(activeQualityScenario(q)?.id).toBe(sc.id);
    const affected = q.inspections.filter((r) => affectingScenario(q, r));
    expect(affected.length).toBeGreaterThan(0);
    expect(affected.every((r) => r.defect && DEFECTS[r.defect].origin === 'GLAZE' && r.time >= sc.start)).toBe(true);
    // Records of other origins in the window are not attributed.
    const kilnRec = q.inspections.find((r) => r.time >= sc.start && r.defect && DEFECTS[r.defect].origin === 'KILN');
    if (kilnRec) expect(affectingScenario(q, kilnRec)).toBeNull();
  });
});

describe('tile geometry', () => {
  const s = createSim(3, 2 * 1440 + 300);
  const frames = s.inspections
    .filter((r) => r.result === 'reject')
    .map((r) => frameForRecord(r, skuOf(s, r.batchId)))
    .filter((f): f is Frame => !!f);

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

  it('parses the recorded measurements it paints', () => {
    expect(parseMeasurement('surface', '7 pinholes / spots in 100 cm²').count).toBe(7);
    expect(parseMeasurement('glaze', 'Glaze weight deviation −6.2 %')).toEqual({ sign: -1, value: 6.2 });
    expect(parseMeasurement('dimension', 'Caliber 600.8 mm (600 ± 0.6)').sign).toBe(1);
    expect(parseMeasurement('planarity', 'Centre deviation +0.62 mm (limit ±0.40)')).toEqual({ sign: 1, value: 0.62 });
  });
});
