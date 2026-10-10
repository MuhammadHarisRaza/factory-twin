/**
 * Live camera streams: what a configured URL can be played as in a browser, and the feed states.
 * Pure helpers (no DOM) — the player is src/ui/feeds/CameraFeed.tsx.
 *
 * Browsers play MP4 / WebM (<video>), MJPEG (<img>) and HLS only where the browser supports it
 * natively. RTSP / RTMP / ONVIF cannot be opened by a browser: they need a gateway that restreams
 * the camera as WebRTC, HLS, MJPEG or MP4.
 */
import type { CameraSource } from '../../app/store';

/**
 * State of a configured stream. 'live' only after the media element actually plays / loads AND new
 * frames can be seen arriving; 'unverified' = playing, but whether frames still arrive cannot be
 * checked (an MJPEG / JPEG stream without CORS permission) — never shown or used as live.
 */
export type LiveState = 'loading' | 'live' | 'unverified' | 'stale' | 'error' | 'unavailable';

/** No new frame (video time update / MJPEG change) for longer than this → stale. */
export const STALE_AFTER_MS = 10_000;

export const STALE_DETAIL = 'No new frame for more than 10 s';
export const UNVERIFIED_DETAIL = 'Playing, but frame freshness cannot be checked without CORS permission — a frozen image would look the same';

/** The media element is showing the stream (frames arriving, stale, or of unknown freshness). */
export const isPlaying = (state: LiveState) => state === 'live' || state === 'stale' || state === 'unverified';

export type ResolvedKind = 'video' | 'hls' | 'mjpeg';

export const KIND_LABEL: Record<CameraSource['kind'], string> = {
  auto: 'Auto-detect from URL',
  video: 'MP4 / WebM video',
  hls: 'HLS (.m3u8)',
  mjpeg: 'MJPEG / JPEG',
};
export const RESOLVED_LABEL: Record<ResolvedKind, string> = { video: 'MP4 / WebM', hls: 'HLS', mjpeg: 'MJPEG' };

const pathOf = (url: string) => url.trim().toLowerCase().split(/[?#]/)[0];

/** Stream type guessed from the URL ('rtsp' for protocols a browser cannot open). */
export function guessKind(url: string): ResolvedKind | 'rtsp' {
  const u = url.trim().toLowerCase();
  if (/^(rtsps?|rtmps?|rtp|srt|onvif):/.test(u)) return 'rtsp';
  const path = pathOf(u);
  if (/\.m3u8$/.test(path) || /[?&](format|type|f)=(hls|m3u8)\b/.test(u)) return 'hls';
  if (/mjpe?g/.test(u) || /\.jpe?g$/.test(path) || /[?&]action=stream\b/.test(u)) return 'mjpeg';
  if (/\.(mp4|m4v|webm|ogv|ogg|mov)$/.test(path)) return 'video';
  return 'video';
}

export type StreamPlan =
  | { ok: true; kind: ResolvedKind; guessed: boolean; warning?: string }
  | { ok: false; kind: ResolvedKind | 'rtsp' | null; reason: string; detail: string };

export const RTSP_REASON = 'Browsers cannot open RTSP streams';
export const HLS_REASON = 'HLS needs a supported browser or gateway';

/**
 * How a source would be played here. `env.canPlayHls` = the browser plays application/vnd.apple.mpegurl
 * natively; `env.pageHttps` = this page is served over https (an http stream is then mixed content).
 */
export function planStream(src: CameraSource, env: { canPlayHls: boolean; pageHttps: boolean }): StreamPlan {
  const url = src.url.trim();
  if (!url) return { ok: false, kind: null, reason: 'No stream URL', detail: 'Enter the URL of a browser-playable stream.' };
  const guessed = guessKind(url);
  if (guessed === 'rtsp')
    return {
      ok: false,
      kind: 'rtsp',
      reason: RTSP_REASON,
      detail: 'RTSP, RTMP and ONVIF need a gateway that restreams the camera as WebRTC, HLS, MJPEG or MP4 over http(s).',
    };
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:'))
    return { ok: false, kind: null, reason: 'Not an http(s) URL', detail: 'A browser can only play http:// or https:// stream URLs.' };
  const kind: ResolvedKind = src.kind === 'auto' ? guessed : src.kind;
  if (kind === 'hls' && !env.canPlayHls)
    return {
      ok: false,
      kind,
      reason: HLS_REASON,
      detail: 'This browser has no native HLS playback. Use a browser that plays HLS natively, or have the gateway provide MJPEG or MP4 / WebM.',
    };
  const warning =
    env.pageHttps && parsed.protocol === 'http:'
      ? 'This page is served over https and the stream over http: the browser will likely block it as mixed content.'
      : parsed.username || parsed.password
        ? 'The URL contains credentials; it is stored in plain text in this browser.'
        : undefined;
  return { ok: true, kind, guessed: src.kind === 'auto', warning };
}

/**
 * State after a staleness check of a playing stream: no new frame for > STALE_AFTER_MS → stale (and
 * back to live when frames resume). `lastFrameAt` null = freshness cannot be verified → 'unverified',
 * never kept as 'live'.
 */
export function staleness(state: LiveState, lastFrameAt: number | null, now: number): LiveState {
  if (!isPlaying(state)) return state;
  if (lastFrameAt == null) return 'unverified';
  return now - lastFrameAt > STALE_AFTER_MS ? 'stale' : 'live';
}

/**
 * How the freshness of an MJPEG / JPEG stream shown in an <img> can be checked: by its pixels (the
 * frame fingerprint is readable — same origin or CORS allowed), by per-part load events (the browser
 * fired `load` more than once on the same element, as Firefox does for multipart streams), or not at
 * all (a cross-origin stream without CORS in a browser that fires `load` once).
 */
export function mjpegFreshness(fingerprint: number | null, loads: number): 'pixels' | 'load-events' | 'unknown' {
  if (fingerprint != null) return 'pixels';
  return loads >= 2 ? 'load-events' : 'unknown';
}

/**
 * State of a playing MJPEG / JPEG <img> stream from what can be observed: its current pixel
 * fingerprint (null = unreadable), the load events seen on the element, and when a new frame was
 * last seen (a changed fingerprint or a load event). Unknown freshness → 'unverified', never 'live'.
 */
export function mjpegState(
  state: LiveState,
  o: { fingerprint: number | null; loads: number; lastFrameAt: number | null; now: number },
): LiveState {
  const unknown = mjpegFreshness(o.fingerprint, o.loads) === 'unknown';
  return staleness(state, unknown ? null : o.lastFrameAt, o.now);
}

/**
 * Why no snapshot can be taken from a stream in this state, or null when its current frame can be
 * grabbed. Only a live stream: a stale or unverified frame may be old, and would be stamped with the
 * capture time.
 */
export function snapshotBlocked(state: LiveState): string | null {
  if (state === 'live') return null;
  if (state === 'stale') return 'No snapshot while the stream is stale — the frame shown is more than 10 s old';
  if (state === 'unverified') return 'No snapshot — it cannot be checked that the frame shown is current';
  return 'No frame to capture — the stream is not playing';
}

let hlsNative: boolean | null = null;
/** What this browser can do: native HLS playback, and whether the page is served over https. */
export function browserEnv() {
  if (hlsNative == null) {
    try {
      hlsNative = typeof document !== 'undefined' && document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
    } catch {
      hlsNative = false;
    }
  }
  return { canPlayHls: hlsNative, pageHttps: typeof location !== 'undefined' && location.protocol === 'https:' };
}

/** Short host / path summary of a URL for tables (never the query string, which may hold tokens). */
export function urlSummary(url: string) {
  try {
    const u = new URL(url.trim());
    const path = u.pathname.length > 28 ? `…${u.pathname.slice(-26)}` : u.pathname;
    return `${u.host}${path === '/' ? '' : path}`;
  } catch {
    return url.trim().slice(0, 40);
  }
}
