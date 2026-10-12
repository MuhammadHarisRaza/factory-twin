/**
 * Review2 finding #10 (Quality part): a camera snapshot grabbed from a configured stream is a camera
 * frame and must be labelled so; a digital-twin render must never be presented as a camera image.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import type { Evidence } from '../../model/types';
import { activateScenario, advance } from '../../sim/engine';
import { attachEvidenceImage, evidenceOf } from '../../sim/events';
import { useSim } from '../../sim/store';
import { getImage, putImage } from '../../twin/bridge';
import { LIVE_PROVENANCE } from '../../ui/feeds/capture';
import { resolveSelection } from './investigate';
import { SnapshotEvidence } from './SnapshotEvidence';

useSim.getState().pause();

const IMG = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 4, height: 3 };
const snap = (over: Partial<Evidence>): Evidence => ({
  id: 'EVD-1',
  eventId: 'EV-1',
  kind: 'camera-snapshot',
  title: 'CAM-04 · Sorting & inspection',
  capturedAt: 100,
  cameraId: 'CAM-04',
  provenance: { origin: 'digital-twin-render', sourceId: 'CAM-04', label: 'Rendered from the digital twin (simulated camera view)' },
  status: 'available',
  image: { key: 'EVD-1', width: 4, height: 3, frameTime: 100 },
  ...over,
});

describe('quality event camera snapshot', () => {
  it('labels a frame from a configured stream as a camera frame, not a twin render', () => {
    const html = renderToStaticMarkup(<SnapshotEvidence x={snap({ provenance: LIVE_PROVENANCE('CAM-04') })} img={IMG} />);
    expect(html).toContain('alt="Camera frame of');
    expect(html).toContain('Camera frame · Frame from the configured camera stream');
    expect(html).not.toMatch(/digital twin|digital-twin/i);
  });

  it('keeps the twin render labelled as simulated and never as a camera image', () => {
    const html = renderToStaticMarkup(<SnapshotEvidence x={snap({})} img={IMG} />);
    expect(html).toContain('alt="Digital-twin render of');
    expect(html).toContain('Simulated feed · rendered from the digital twin — not a camera image');
    expect(html).not.toContain('Camera frame');
  });

  it('explains a missing image by its provenance, pending and unavailable states', () => {
    expect(renderToStaticMarkup(<SnapshotEvidence x={snap({ provenance: LIVE_PROVENANCE('CAM-04') })} img={null} />)).toContain('Camera frame not kept in this browser session');
    expect(renderToStaticMarkup(<SnapshotEvidence x={snap({})} img={null} />)).toContain('Rendered view not kept in this browser session');
    expect(renderToStaticMarkup(<SnapshotEvidence x={snap({ status: 'pending', image: undefined })} img={null} />)).toContain('Being captured');
    expect(renderToStaticMarkup(<SnapshotEvidence x={snap({ status: 'unavailable', image: undefined, unavailableReason: 'No camera position covers I-QC' })} img={null} />)).toContain(
      'Unavailable — No camera position covers I-QC',
    );
  });

  it('labels the live-camera snapshot of a detected quality event as a camera frame', () => {
    const s = useSim.getState().sim;
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze deterioration (snapshot test)' });
    advance(s, s.minute + 90);
    const ev = s.events.find((e) => e.category === 'quality' && evidenceOf(s, e).some((x) => x.kind === 'camera-snapshot' && x.cameraId));
    expect(ev).toBeTruthy();
    expect(resolveSelection(s, ev!.id).kind).toBe('event');
    const x = evidenceOf(s, ev!).find((y) => y.kind === 'camera-snapshot' && y.cameraId)!;
    putImage(x.id, IMG);
    attachEvidenceImage(s, x.id, { key: x.id, width: IMG.width, height: IMG.height, frameTime: s.minute }, LIVE_PROVENANCE(x.cameraId!));

    const html = renderToStaticMarkup(<SnapshotEvidence x={evidenceOf(s, ev!).find((y) => y.id === x.id)!} img={getImage(x.id)} />);
    expect(html).toContain('Camera frame · Frame from the configured camera stream');
    expect(html).toContain('alt="Camera frame of');
    expect(html).not.toContain('rendered from the digital twin — not a camera image');
  });
});
