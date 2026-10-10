/**
 * Configured-stream badge and snapshot button (review #9, #11): only a stream whose frames are seen
 * arriving reads "Live"; one of unknown freshness reads "Playing · freshness unknown"; the snapshot
 * button is disabled, with the reason, unless the stream is live.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { useSim } from '../../sim/store';
import { CameraFeed, LIVE_BADGE } from './CameraFeed';
import type { LiveState } from './live';

useSim.getState().pause();

describe('configured stream badge', () => {
  it('reads "Live" only for the live state', () => {
    for (const s of Object.keys(LIVE_BADGE) as LiveState[]) {
      if (s === 'live') expect(LIVE_BADGE[s]).toMatchObject({ label: 'Live', tone: 'good' });
      else expect(LIVE_BADGE[s].label).not.toMatch(/^Live/);
    }
    expect(LIVE_BADGE.unverified).toMatchObject({ label: 'Playing · freshness unknown', tone: 'neutral' });
  });

  it('disables the snapshot button, with the reason, while the stream is not live', () => {
    useApp.setState({ cameraSources: { 'CAM-E1': { url: 'http://gw.example/cam1/snapshot.jpg', kind: 'auto' } } });
    Object.assign(useApp.getInitialState(), useApp.getState());
    const out = renderToStaticMarkup(<CameraFeed cameraId="CAM-E1" />);
    expect(out).toContain('Connecting');
    expect(out).not.toMatch(/>Live</);
    const button = out.match(/<button[^>]*aria-label="Take a snapshot"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('disabled');
    expect(button).toContain('the stream is not playing');
    useApp.setState({ cameraSources: {} });
  });
});
