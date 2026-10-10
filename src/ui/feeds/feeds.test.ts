import { describe, expect, it } from 'vitest';
import type { Evidence } from '../../model/types';
import { DEFAULT_START } from '../../sim/time';
import { LIVE_PROVENANCE, createEvidenceCapturer, type CaptureDeps, type CaptureSim } from './capture';
import { feedRenderSize, frameTimeOf, tagFrameTime } from './frames';
import {
  HLS_REASON,
  RTSP_REASON,
  STALE_AFTER_MS,
  guessKind,
  isPlaying,
  mjpegFreshness,
  mjpegState,
  planStream,
  snapshotBlocked,
  staleness,
  urlSummary,
  type LiveState,
} from './live';
import { cameraStrip, localStamp, simulatedStrip, snapshotFileName, stripFontPx } from './overlay';

const env = { canPlayHls: false, pageHttps: false };

describe('stream URLs', () => {
  it('guesses the stream type from the URL', () => {
    expect(guessKind('https://gw.local/cam1/index.m3u8')).toBe('hls');
    expect(guessKind('https://gw.local/api/stream.m3u8?src=cam1')).toBe('hls');
    expect(guessKind('http://10.0.0.5/axis-cgi/mjpg/video.cgi')).toBe('mjpeg');
    expect(guessKind('https://gw.local/api/stream.mjpeg?src=cam1')).toBe('mjpeg');
    expect(guessKind('https://gw.local/snap.jpg')).toBe('mjpeg');
    expect(guessKind('https://gw.local/api/stream.mp4?src=cam1')).toBe('video');
    expect(guessKind('https://cdn.example/clip.webm')).toBe('video');
    expect(guessKind('rtsp://10.0.0.5:554/stream1')).toBe('rtsp');
    expect(guessKind('rtmp://media/live')).toBe('rtsp');
    expect(guessKind('https://gw.local/live/cam1')).toBe('video');
  });

  it('never plans RTSP or non-http URLs, and explains why', () => {
    const rtsp = planStream({ url: 'rtsp://10.0.0.5/s1', kind: 'auto' }, env);
    expect(rtsp.ok).toBe(false);
    if (!rtsp.ok) {
      expect(rtsp.reason).toBe(RTSP_REASON);
      expect(rtsp.detail).toMatch(/gateway/);
    }
    // Even when the user picks a browser kind, an RTSP URL stays unplayable.
    expect(planStream({ url: 'rtsp://10.0.0.5/s1', kind: 'video' }, env).ok).toBe(false);
    expect(planStream({ url: 'ftp://x/y.mp4', kind: 'auto' }, env).ok).toBe(false);
    expect(planStream({ url: 'not a url', kind: 'auto' }, env).ok).toBe(false);
    expect(planStream({ url: '  ', kind: 'auto' }, env).ok).toBe(false);
  });

  it('needs native HLS support for HLS', () => {
    const p = planStream({ url: 'https://gw/cam.m3u8', kind: 'auto' }, env);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe(HLS_REASON);
    const ok = planStream({ url: 'https://gw/cam.m3u8', kind: 'auto' }, { ...env, canPlayHls: true });
    expect(ok).toMatchObject({ ok: true, kind: 'hls', guessed: true });
    // An explicit kind wins over the guess.
    expect(planStream({ url: 'https://gw/live', kind: 'mjpeg' }, env)).toMatchObject({ ok: true, kind: 'mjpeg', guessed: false });
  });

  it('warns about mixed content and credentials', () => {
    const mixed = planStream({ url: 'http://gw/cam.mp4', kind: 'auto' }, { ...env, pageHttps: true });
    expect(mixed.ok && mixed.warning).toMatch(/mixed content/);
    const cred = planStream({ url: 'https://user:pw@gw/cam.mp4', kind: 'auto' }, env);
    expect(cred.ok && cred.warning).toMatch(/credentials/);
    expect(planStream({ url: 'https://gw/cam.mp4', kind: 'auto' }, env)).toMatchObject({ ok: true, warning: undefined });
  });

  it('summarises URLs without the query string', () => {
    expect(urlSummary('https://gw.local:8443/api/stream.mp4?src=cam1&token=secret')).toBe('gw.local:8443/api/stream.mp4');
    expect(urlSummary('https://gw.local/')).toBe('gw.local');
  });
});

describe('stream states', () => {
  it('turns stale after 10 s without a frame and recovers when frames resume', () => {
    expect(staleness('live', 1000, 1000 + STALE_AFTER_MS)).toBe('live');
    expect(staleness('live', 1000, 1001 + STALE_AFTER_MS)).toBe('stale');
    expect(staleness('stale', 20_000, 21_000)).toBe('live');
    // Loading / error / unavailable are never turned into live by the clock.
    expect(staleness('loading', 1000, 2000)).toBe('loading');
    expect(staleness('error', 1000, 2000)).toBe('error');
    expect(staleness('unavailable', 1000, 2000)).toBe('unavailable');
    // Unknown freshness is never kept as live (review #9).
    expect(staleness('live', null, 1e9)).toBe('unverified');
    expect(staleness('stale', null, 1e9)).toBe('unverified');
    expect(staleness('unverified', null, 1e9)).toBe('unverified');
    // Once freshness can be checked again, the clock decides.
    expect(staleness('unverified', 1000, 2000)).toBe('live');
    expect(staleness('unverified', 1000, 1001 + STALE_AFTER_MS)).toBe('stale');
    expect(isPlaying('unverified')).toBe(true);
    expect(isPlaying('loading')).toBe(false);
  });

  it('checks MJPEG freshness by pixels, else by repeated load events, else not at all', () => {
    expect(mjpegFreshness(12345, 1)).toBe('pixels');
    expect(mjpegFreshness(null, 1)).toBe('unknown');
    expect(mjpegFreshness(null, 0)).toBe('unknown');
    expect(mjpegFreshness(null, 2)).toBe('load-events');
  });

  // Review #9: an MJPEG / snapshot URL served without CORS (pixels unreadable) and a browser that fires
  // `load` once. It loads at 14:02:11, then freezes. It must never read "Live" — before or after.
  it('never shows a no-CORS MJPEG stream with a single load event as live, even an hour later', () => {
    const t0 = 1_000_000;
    // The player's onLoad handler: first load event, fingerprint unreadable.
    let st: LiveState = mjpegState('live', { fingerprint: null, loads: 1, lastFrameAt: t0, now: t0 });
    expect(st).toBe('unverified');
    // The player's 1 s interval for the next hour: nothing changes (no load event, pixels unreadable).
    for (let now = t0 + 1000; now <= t0 + 3_600_000; now += 1000) {
      st = mjpegState(st, { fingerprint: null, loads: 1, lastFrameAt: t0, now });
      expect(st).not.toBe('live');
    }
    expect(st).toBe('unverified');
  });

  it('uses per-part load events (as Firefox fires them) as freshness for a no-CORS MJPEG stream', () => {
    const t0 = 1_000_000;
    expect(mjpegState('live', { fingerprint: null, loads: 1, lastFrameAt: t0, now: t0 })).toBe('unverified');
    // Second part arrives: load events prove frames are arriving.
    let st = mjpegState('unverified', { fingerprint: null, loads: 2, lastFrameAt: t0 + 200, now: t0 + 200 });
    expect(st).toBe('live');
    // The stream freezes after the 50th part: stale 10 s later.
    const last = t0 + 5000;
    st = mjpegState(st, { fingerprint: null, loads: 50, lastFrameAt: last, now: last + STALE_AFTER_MS });
    expect(st).toBe('live');
    st = mjpegState(st, { fingerprint: null, loads: 50, lastFrameAt: last, now: last + STALE_AFTER_MS + 1000 });
    expect(st).toBe('stale');
  });

  it('turns a CORS-readable MJPEG stream whose pixels stop changing stale', () => {
    const t0 = 1_000_000;
    expect(mjpegState('live', { fingerprint: 42, loads: 1, lastFrameAt: t0, now: t0 })).toBe('live');
    expect(mjpegState('live', { fingerprint: 42, loads: 1, lastFrameAt: t0, now: t0 + STALE_AFTER_MS + 1000 })).toBe('stale');
    // Not playing: left alone.
    expect(mjpegState('error', { fingerprint: null, loads: 1, lastFrameAt: t0, now: t0 + 1e6 })).toBe('error');
    expect(mjpegState('loading', { fingerprint: null, loads: 0, lastFrameAt: null, now: t0 })).toBe('loading');
  });

  // Review #11: a snapshot of a stale (frozen) stream would be stamped with the capture time.
  it('allows a snapshot only from a live stream', () => {
    expect(snapshotBlocked('live')).toBeNull();
    expect(snapshotBlocked('stale')).toMatch(/stale .* more than 10 s old/);
    expect(snapshotBlocked('unverified')).toMatch(/cannot be checked/);
    for (const s of ['loading', 'error', 'unavailable'] as const) expect(snapshotBlocked(s)).toMatch(/not playing/);
  });
});

describe('labels and sizes', () => {
  it('burns the simulated label with camera id and plant time', () => {
    const s = simulatedStrip('CAM-E1', DEFAULT_START + 12.5);
    expect(s.left).toMatch(/^SIMULATED VIEW · CAM-E1 · Mon,? 12 Oct 10:42:30 plant time$/);
    expect(s.right).toMatch(/not a camera image/);
    expect(cameraStrip('CAM-E1', new Date(2026, 9, 11, 9, 5, 7)).left).toBe('CAMERA FRAME · CAM-E1 · 2026-10-11 09:05:07 local time');
    expect(localStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
    expect(stripFontPx(540)).toBe(23);
    expect(stripFontPx(100)).toBe(11);
  });

  it('names snapshot files by camera, origin and time', () => {
    expect(snapshotFileName('CAM-E1', 'simulated', { plantMinute: DEFAULT_START + 12.5 })).toBe('CAM-E1_simulated-view_20261012-104230.jpg');
    expect(snapshotFileName('CAM-K1', 'live', { date: new Date(2026, 9, 11, 14, 3, 9) })).toBe('CAM-K1_camera-frame_20261011-140309.jpg');
  });

  it('sizes feed renders to the media box aspect', () => {
    expect(feedRenderSize(400, 225, 1)).toEqual({ width: 416, height: 234 });
    expect(feedRenderSize(400, 225, 2)).toEqual({ width: 608, height: 342 });
    expect(feedRenderSize(2000, 400, 2).width).toBe(960);
    expect(feedRenderSize(0, 0, 1)).toEqual({ width: 640, height: 360 });
    expect(feedRenderSize(100, 100, 1)).toEqual({ width: 320, height: 320 });
  });

  it('remembers the plant time of a render', () => {
    const f = { dataUrl: 'x', width: 1, height: 1 };
    expect(frameTimeOf(f)).toBeNull();
    tagFrameTime(f, 123.5);
    expect(frameTimeOf(f)).toBe(123.5);
    expect(frameTimeOf(null)).toBeNull();
  });
});

// ── Evidence capture ──────────────────────────────────────────────────────────

type FakeSim = CaptureSim & { id: string };

const snapEv = (id: string, cameraId?: string): Evidence => ({
  id,
  eventId: `EV-${id}`,
  kind: 'camera-snapshot',
  title: 'snap',
  capturedAt: 10,
  cameraId,
  provenance: { origin: 'digital-twin-render', sourceId: cameraId ?? 'none', label: 'Rendered from the digital twin (simulated camera view)' },
  status: 'pending',
});

function harness(opts: { ready?: () => boolean; render?: (cam: string) => Promise<{ dataUrl: string; width: number; height: number } | null>; live?: string[] } = {}) {
  let t = 0;
  const sims: { current: FakeSim } = { current: { id: 'A', minute: 100, evidence: [] } };
  const log: string[] = [];
  const images = new Map<string, string>();
  const deps: CaptureDeps<FakeSim> = {
    getSim: () => sims.current,
    pending: (s) => s.evidence.filter((x) => x.status === 'pending' && x.kind === 'camera-snapshot'),
    rendererReady: opts.ready ?? (() => true),
    renderTwin: opts.render ?? (async (cam) => ({ dataUrl: `twin:${cam}`, width: 960, height: 540 })),
    grabLive: (cam) => (opts.live?.includes(cam) ? { dataUrl: `live:${cam}`, width: 1280, height: 720 } : null),
    putImage: (k, img) => {
      images.set(k, img.dataUrl);
    },
    attach: (id, image, provenance) => {
      const x = sims.current.evidence.find((e) => e.id === id)!;
      x.status = 'available';
      x.image = image;
      if (provenance) x.provenance = provenance;
      log.push(`attach ${id} ${image.frameTime}`);
    },
    unavailable: (id, reason) => {
      const x = sims.current.evidence.find((e) => e.id === id);
      if (x) {
        x.status = 'unavailable';
        x.unavailableReason = reason;
      }
      log.push(`unavailable ${id}`);
    },
    now: () => t,
    wait: async (ms) => {
      t += ms;
    },
  };
  return { sims, log, images, deps, capturer: createEvidenceCapturer(deps) };
}

describe('evidence capture', () => {
  it('renders the twin view for pending snapshots, one at a time, keeping the twin provenance', async () => {
    const h = harness();
    h.sims.current.evidence.push(snapEv('EVD-1', 'CAM-E1'), snapEv('EVD-2', 'CAM-H1'), { ...snapEv('EVD-3', 'CAM-I1'), status: 'available' });
    await h.capturer.pump();
    expect(h.log).toEqual(['attach EVD-1 100', 'attach EVD-2 100']);
    expect(h.images.get('EVD-1')).toBe('twin:CAM-E1');
    const e1 = h.sims.current.evidence[0];
    expect(e1.provenance.origin).toBe('digital-twin-render');
    expect(e1.image).toEqual({ key: 'EVD-1', width: 960, height: 540, frameTime: 100 });
  });

  it('uses a frame from a playing configured stream with live-camera provenance', async () => {
    const h = harness({ live: ['CAM-E1'] });
    h.sims.current.evidence.push(snapEv('EVD-1', 'CAM-E1'));
    await h.capturer.pump();
    expect(h.images.get('EVD-1')).toBe('live:CAM-E1');
    expect(h.sims.current.evidence[0].provenance).toEqual(LIVE_PROVENANCE('CAM-E1'));
  });

  it('marks the evidence unavailable when the twin is not ready within 10 s, or the render fails', async () => {
    const notReady = harness({ ready: () => false });
    notReady.sims.current.evidence.push(snapEv('EVD-1', 'CAM-E1'));
    await notReady.capturer.pump();
    expect(notReady.sims.current.evidence[0].status).toBe('unavailable');
    expect(notReady.sims.current.evidence[0].unavailableReason).toMatch(/not ready .* 10 s/);

    const failing = harness({ render: async () => Promise.reject(new Error('context lost')) });
    failing.sims.current.evidence.push(snapEv('EVD-1', 'CAM-E1'), snapEv('EVD-2'));
    await failing.capturer.pump();
    expect(failing.sims.current.evidence[0].unavailableReason).toMatch(/context lost/);
    expect(failing.sims.current.evidence[1].unavailableReason).toMatch(/No camera/);

    const empty = harness({ render: async () => null });
    empty.sims.current.evidence.push(snapEv('EVD-1', 'CAM-E1'));
    await empty.capturer.pump();
    expect(empty.sims.current.evidence[0].status).toBe('unavailable');
  });

  it('drops a render that finishes after a reset (evidence ids restart)', async () => {
    let release: () => void = () => undefined;
    const h = harness({
      render: (cam) =>
        new Promise((r) => {
          release = () => r({ dataUrl: `twin:${cam}`, width: 960, height: 540 });
        }),
    });
    h.sims.current.evidence.push(snapEv('EVD-1', 'CAM-E1'));
    const run = h.capturer.pump();
    await Promise.resolve();
    // Reset: a new simulation whose evidence reuses the id, already resolved.
    h.sims.current = { id: 'B', minute: 5, evidence: [{ ...snapEv('EVD-1', 'CAM-H1'), status: 'unavailable' }] };
    release();
    await run;
    expect(h.images.has('EVD-1')).toBe(false);
    expect(h.log).toEqual([]);
  });

  it('coalesces calls while busy and picks up evidence that arrives meanwhile', async () => {
    const h = harness();
    h.sims.current.evidence.push(snapEv('EVD-1', 'CAM-E1'));
    const a = h.capturer.pump();
    h.sims.current.evidence.push(snapEv('EVD-2', 'CAM-G1'));
    const b = h.capturer.pump();
    await Promise.all([a, b]);
    expect(h.log).toEqual(['attach EVD-1 100', 'attach EVD-2 100']);
    expect(h.capturer.busy).toBe(false);
  });
});
