import { describe, expect, it } from 'vitest';
import { createSim } from '../../sim/engine';
import { detectionLabel } from './FrameArt';
import { frameForRecord } from './frames';
import { STILL_CAPTION, frameStillMarkup } from './still';

describe('standalone frame stills (input of the inspection-image rasteriser)', () => {
  const s = createSim(5, 1440 + 400);
  const vis = s.inspections.find((r) => r.result === 'reject' && r.stationId === 'ST-VIS' && r.box && r.confidence != null)!;
  const gauge = s.inspections.find((r) => r.result === 'reject' && r.stationId === 'ST-GAUGE')!;

  it('labels tunnel classes with a simulated confidence and gauge results as measurements', () => {
    expect(detectionLabel(vis)).toMatch(/% sim$/);
    expect(detectionLabel(gauge)).toMatch(/· gauge$/);
    expect(detectionLabel(gauge)).not.toMatch(/%/);
    expect(STILL_CAPTION).toBe('Illustrative frame · simulated classification — no vision model');
  });

  it('renders a self-contained SVG (namespace, pixel size, embedded styles, no CSS variables)', async () => {
    const frame = frameForRecord(vis, 'FT-6060-GRY-P')!;
    const annotated = await frameStillMarkup(frame, { annotated: true, crop: true, size: 320 });
    expect(annotated.startsWith('<svg')).toBe(true);
    expect(annotated).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(annotated).toContain('width="320"');
    expect(annotated).toContain('<style>');
    expect(annotated).not.toContain('var(--');
    expect(annotated).toContain(detectionLabel(vis));
    const original = await frameStillMarkup(frame, { annotated: false, size: 320 });
    expect(original).not.toContain(detectionLabel(vis));
    expect(original).not.toContain('var(--');
    // Deterministic: the same record draws the same image.
    expect(await frameStillMarkup(frame, { annotated: true, crop: true, size: 320 })).toBe(annotated);
  });
});
