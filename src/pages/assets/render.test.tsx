/**
 * Smoke test: the camera feed in every mode and the new Assets & Data views render (server-side)
 * with their honesty labels — "Live" never appears for a simulated or not-yet-playing feed.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp, type CameraSource } from '../../app/store';
import { CAMERAS } from '../../model/plant';
import { TRACKED_ASSETS, activateScenario, advance } from '../../sim/engine';
import { EVENT_RULE_DEFS } from '../../sim/events';
import { useSim } from '../../sim/store';
import { CameraFeed, SIMULATED_LABEL } from '../../ui/feeds/CameraFeed';
import { AssetsPage } from '../AssetsPage';
import { CamerasTab } from './CamerasTab';
import { FeedsTab } from './FeedsTab';
import { RulesTab } from './RulesTab';

useSim.getState().pause();

const withSources = (cameraSources: Record<string, CameraSource>) => {
  useApp.setState({ cameraSources });
  Object.assign(useApp.getInitialState(), useApp.getState());
};
const html = (el: React.ReactElement) => {
  Object.assign(useSim.getInitialState(), useSim.getState());
  return renderToStaticMarkup(el);
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');

describe('camera feed render', () => {
  it('shows a simulated feed, labelled, for a camera without a stream', () => {
    withSources({});
    for (const compact of [false, true]) {
      const out = html(<CameraFeed cameraId="CAM-E1" compact={compact} height={180} />);
      expect(out).toContain(SIMULATED_LABEL);
      expect(out).toContain('Simulated');
      expect(out).not.toMatch(/>Live</);
    }
    expect(html(<CameraFeed cameraId="CAM-E1" />)).toContain('Press line');
    expect(html(<CameraFeed cameraId="CAM-NOPE" />)).toContain('Unknown camera CAM-NOPE');
  });

  it('shows a configured stream as connecting, never live, before it plays', () => {
    withSources({ 'CAM-E1': { url: 'https://gw.example/cam-e1/stream.mp4', kind: 'auto' } });
    const out = html(<CameraFeed cameraId="CAM-E1" />);
    expect(out).toContain('Connecting');
    expect(out).toContain('Configured stream · MP4 / WebM');
    expect(out).not.toMatch(/>Live</);
    expect(out).not.toContain(SIMULATED_LABEL);
  });

  it('explains streams a browser cannot play', () => {
    withSources({ 'CAM-E1': { url: 'rtsp://10.0.0.5/stream1', kind: 'auto' }, 'CAM-H1': { url: 'https://gw.example/kiln.m3u8', kind: 'auto' } });
    const rtsp = html(<CameraFeed cameraId="CAM-E1" />);
    expect(rtsp).toContain('Browsers cannot open RTSP streams');
    expect(rtsp).toContain('Unavailable');
    expect(rtsp).toContain('Show simulated view');
    expect(html(<CameraFeed cameraId="CAM-H1" />)).toContain('HLS needs a supported browser or gateway');
    withSources({});
  });
});

describe('assets & data render', () => {
  it('renders the page shell with the new sections', () => {
    const out = html(<AssetsPage />);
    for (const t of ['Camera sources', 'Data feeds', 'Event rules']) expect(out).toContain(t);
  });

  it('lists every camera position with its mode and the RTSP / CORS notes', () => {
    withSources({ 'CAM-K1': { url: 'https://gw.example/docks.mjpg?token=secret', kind: 'auto' } });
    const out = html(<CamerasTab />);
    for (const c of CAMERAS) expect(out).toContain(c.id);
    expect(out).toContain('Browsers cannot open RTSP directly');
    expect(out).toContain('Allow CORS for snapshots');
    expect(out).toContain('Nothing is configured by default');
    expect(out).toContain('gw.example/docks.mjpg');
    expect(out).not.toContain('token=secret');
    expect(out).not.toMatch(/>Live</);
    withSources({});
  });

  it('shows every tracked asset feed as simulated, and a lost feed as stale', () => {
    let out = html(<FeedsTab />);
    for (const id of TRACKED_ASSETS) expect(out).toContain(id);
    expect(out).toContain('all simulated · none stale');
    expect(out).not.toMatch(/[Cc]onnected<\/span>/);
    const s = useSim.getState().sim;
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'Signal loss E-PRS2' });
    advance(s, s.minute + 5);
    useSim.setState({ version: s.version });
    out = html(<FeedsTab />);
    expect(out).toContain('all simulated · 1 stale');
    expect(out).toMatch(/since \d\d:\d\d/);
    expect(out).toContain('Unknown — data stale');
  });

  it('lists the detection rules with editable thresholds and the unavailable rules with reasons', () => {
    const out = html(<RulesTab />);
    for (const d of EVENT_RULE_DEFS) expect(out).toContain(d.id);
    for (const d of EVENT_RULE_DEFS.filter((x) => !x.available)) expect(out).toContain(esc(d.unavailableReason!));
    expect(out).toContain('Reset all to defaults');
    expect(out).toContain('% of ideal');
  });
});
