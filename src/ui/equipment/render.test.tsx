/**
 * Smoke test (server-side): the camera feed in every mode and the cameras / stream editor of the
 * equipment panel's technical details render with their honesty labels — "Live" never appears
 * for a simulated or not-yet-playing feed — and the vehicle variant and stage panel render.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import type { ReactElement } from 'react';
import { useApp, type CameraSource } from '../../app/store';
import { CAMERA_BY_ID } from '../../model/plant';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { CameraFeed } from '../feeds/CameraFeed';
import { useTwinUi } from '../twin/uiStore';
import { StagePanel } from '../twin/StagePanel';
import { CameraSources, StreamEditor, camerasOf } from './CameraSources';
import { flowLinks } from './panel/links';
import { assetProfile } from './profile';

useSim.getState().pause();

const withSources = (cameraSources: Record<string, CameraSource>) => {
  useApp.setState({ cameraSources });
  Object.assign(useApp.getInitialState(), useApp.getState());
};
const html = (el: ReactElement) => {
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useTwin.getInitialState(), useTwin.getState());
  Object.assign(useTwinUi.getInitialState(), useTwinUi.getState());
  return renderToStaticMarkup(el);
};

describe('camera feed render', () => {
  it('shows no image, only a no-stream state, for a camera without a stream', () => {
    withSources({});
    for (const compact of [false, true]) {
      const out = html(<CameraFeed cameraId="CAM-E1" compact={compact} height={180} />);
      expect(out).toContain('No camera stream configured');
      expect(out).not.toContain('<img');
      expect(out).not.toMatch(/>Live</);
    }
    expect(html(<CameraFeed cameraId="CAM-NOPE" />)).toContain('Unknown camera CAM-NOPE');
  });

  it('shows a configured stream as connecting, never live, before it plays', () => {
    withSources({ 'CAM-E1': { url: 'https://gw.example/cam-e1/stream.mp4', kind: 'auto' } });
    const out = html(<CameraFeed cameraId="CAM-E1" />);
    expect(out).toContain('Connecting');
    expect(out).not.toMatch(/>Live</);
    expect(out).not.toContain('No camera stream configured');
    withSources({});
  });
});

describe('equipment cameras', () => {
  it('lists the cameras covering an asset with their honest feed state', () => {
    withSources({ 'CAM-E1': { url: 'https://gw.example/press.mjpg?token=secret', kind: 'auto' } });
    expect(camerasOf('E-PRS2').map((c) => c.id)).toEqual(['CAM-E1']);
    const out = html(<CameraSources equipmentId="E-PRS2" />);
    expect(out).toContain('Press line');
    expect(out).toContain('CAM-E1');
    expect(out).toContain('Configured stream');
    expect(out).toContain('gw.example/press.mjpg');
    expect(out).not.toContain('token=secret');
    expect(out).toContain('Edit stream');
    expect(out).not.toMatch(/>Live</);
    withSources({});
    const sim = html(<CameraSources equipmentId="H-KILN" />);
    expect(sim).toContain('No stream configured — no image');
    expect(sim).toContain('Configure a stream');
    expect(html(<CameraSources equipmentId="A-PARK" />)).toContain('No camera position covers this asset');
  });

  it('explains what a browser can play in the stream editor', () => {
    withSources({});
    const out = html(<StreamEditor cam={CAMERA_BY_ID['CAM-H1']} />);
    expect(out).toContain('Stream URL');
    expect(out).toContain('Browsers cannot open RTSP');
    expect(out).toContain('CORS');
    expect(out).toContain('stored in this browser only');
    expect(out).toContain('No camera stream configured');
  });
});

describe('workflow links and stage panel', () => {
  it('links each asset to the workflows that explain it', () => {
    const labels = (id: string) => flowLinks(assetProfile(id)).map((l) => l.key);
    // The subject's events are the Events section's "View all" — not repeated as a link.
    expect(labels('E-PRS2')).toEqual(['production']);
    expect(labels('I-VIS')).toEqual(['production', 'quality']);
    expect(labels('K-DOCK')).toEqual(['production', 'fleet']);
    expect(labels('A-PARK')).toEqual([]);
  });

  it('renders the stage panel of every production stage', () => {
    for (const id of ['PREP', 'SPRAY', 'PRESS', 'DRY', 'GLAZE', 'KILN', 'SORT', 'PACK', 'WH'] as const) {
      const out = html(<StagePanel id={id} />);
      expect(out, id).toContain('Open in Production');
      expect(out, id).toContain('Simulated');
    }
  });
});
