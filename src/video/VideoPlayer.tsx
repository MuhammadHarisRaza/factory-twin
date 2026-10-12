/**
 * Reference-video player. Shows a poster with the clip's title and classification; nothing is
 * loaded from the provider until the user presses play (lazy, no autoplay, one video at a time).
 * YouTube clips play in the privacy-enhanced embed and report errors through the player's
 * postMessage channel, so a removed clip or one whose owner disabled embedding falls back to the
 * poster with an "Open on YouTube" link instead of a black box. Direct MP4 files play in <video>.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { create } from 'zustand';
import { Clapperboard, ExternalLink, LoaderCircle, Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { ProvenanceBadge } from '../ui/kit/Page';
import type { VideoRef } from './types';
import './video.css';

/** The one player currently loaded, by player instance (starting another returns the previous one to its poster). */
const usePlaying = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({ id: null, set: (id) => set({ id }) }));

const PROVIDER_LABEL: Record<VideoRef['provider'], string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
  wikimedia: 'Wikimedia Commons',
  client: 'Client recording',
  other: 'Web',
};

const isRecording = (v: VideoRef) => v.sourceType === 'client-recording';

/** The one-line honesty note of a client recording (shown in compact players too). */
export function recordingNote(v: VideoRef) {
  const r = v.recording;
  const when = [r?.recordedAt ? `Recorded ${r.recordedAt}` : 'Recorded footage', r?.camera].filter(Boolean).join(' · ');
  const overlays = r?.overlays ? ` Its ${r.overlays} come from the system that made the recording.` : '';
  return `${when} · provided by the client. A recording, not a live feed, and not linked to this demo's simulated data.${overlays}`;
}

/** YouTube player error codes → plain reasons. */
const YT_ERRORS: Record<number, string> = {
  2: 'The video link is invalid.',
  5: 'The browser cannot play this video.',
  100: 'The video has been removed or made private.',
  101: 'The owner does not allow this video to be played on other sites.',
  150: 'The owner does not allow this video to be played on other sites.',
  153: 'The video player did not accept this page as its embedding site.',
};

/** Seconds before a player that has not reported ready offers the link out. */
const SLOW_MS = 15000;

const isYouTube = (v: VideoRef) => v.provider === 'youtube' && !!v.embedUrl;
const isFile = (v: VideoRef) => !!v.embedUrl && /\.(mp4|webm)(\?|$)/i.test(v.embedUrl);

function youTubeSrc(v: VideoRef) {
  const u = new URL(v.embedUrl!);
  u.searchParams.set('autoplay', '1');
  u.searchParams.set('rel', '0');
  u.searchParams.set('playsinline', '1');
  u.searchParams.set('enablejsapi', '1');
  if (typeof location !== 'undefined') u.searchParams.set('origin', location.origin);
  if (v.segment?.start) u.searchParams.set('start', String(Math.floor(v.segment.start)));
  if (v.segment?.end) u.searchParams.set('end', String(Math.floor(v.segment.end)));
  return u.toString();
}

type State = { kind: 'idle' } | { kind: 'loading'; slow: boolean } | { kind: 'ready' } | { kind: 'failed'; reason: string };

/**
 * One player for one clip (ContextVideo mounts a fresh player per clip, keyed by the clip id).
 * `onActiveChange` reports when the embed is loaded (playing or loading) and when it is back on its poster.
 */
export function VideoPlayer({ video, compact = false, onActiveChange }: { video: VideoRef; compact?: boolean; onActiveChange?: (active: boolean) => void }) {
  const me = useId();
  const playingId = usePlaying((s) => s.id);
  const setPlaying = usePlaying((s) => s.set);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [posterFailed, setPosterFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const active = state.kind === 'loading' || state.kind === 'ready';

  // Another player started (any clip, any panel): go back to the poster (unloads this embed).
  useEffect(() => {
    if (active && playingId !== me) setState({ kind: 'idle' });
  }, [active, playingId, me]);

  // Tell the parent whether the embed is loaded, so it does not swap the clip under the viewer.
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Unmounting the player releases the "playing" slot (only if it is still this player's).
  useEffect(
    () => () => {
      if (usePlaying.getState().id === me) usePlaying.getState().set(null);
    },
    [me],
  );

  // YouTube: listen to the player's postMessage channel while the embed is loaded. A clip whose owner
  // disabled embedding reports "ready" and then error 150, so errors are honoured after ready too.
  const loaded = state.kind === 'loading' || state.kind === 'ready';
  useEffect(() => {
    if (!loaded || !isYouTube(video)) return;
    let greeted = false;
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      let d: { event?: string; info?: unknown } | null = null;
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data as typeof d);
      } catch {
        return;
      }
      if (!d?.event) return;
      if (d.event === 'initialDelivery' || d.event === 'onReady') greeted = true;
      if (d.event === 'onError') {
        const code = Number(d.info);
        setState({ kind: 'failed', reason: YT_ERRORS[code] ?? `The video player reported error ${code}.` });
      } else if (d.event === 'onReady') {
        setState((s) => (s.kind === 'loading' ? { kind: 'ready' } : s));
      }
    };
    window.addEventListener('message', onMessage);
    // Handshake: the embed only reports events after the page says it is listening.
    const hello = setInterval(() => {
      if (!greeted) frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: video.id, channel: 'widget' }), '*');
    }, 400);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(hello);
    };
  }, [loaded, video]);

  // Offer the link out when the embed has not reported ready after a while (never an endless spinner).
  useEffect(() => {
    if (state.kind !== 'loading' || state.slow) return;
    const t = setTimeout(() => setState((s) => (s.kind === 'loading' ? { kind: 'loading', slow: true } : s)), SLOW_MS);
    return () => clearTimeout(t);
  }, [state]);

  const play = () => {
    if (!video.embedUrl) return;
    setPlaying(me);
    setState({ kind: 'loading', slow: false });
  };

  const meta = (
    <div className="vp-meta">
      <div className="vp-title" title={video.description}>
        {video.title}
      </div>
      <div className="vp-sub">
        <ProvenanceBadge kind={isRecording(video) ? 'recorded' : 'reference'} />
        <span>{video.label}</span>
        <span className="vp-dot">·</span>
        <span>{isRecording(video) ? video.publisher : `${PROVIDER_LABEL[video.provider]} · ${video.publisher}`}</span>
        <a
          className="vp-link"
          href={video.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          title={isRecording(video) ? 'Open the recording file in a new tab' : 'Open the original source in a new tab'}
        >
          {isRecording(video) ? 'File' : 'Source'}
          <ExternalLink size={11} aria-hidden />
        </a>
      </div>
      {isRecording(video) ? (
        // A recording of a real camera view: the not-live / not-linked note is always shown, also in compact players.
        <div className="vp-note">
          {!compact && `${video.description} `}
          {recordingNote(video)}
          {!compact && ` ${video.licence}.`}
        </div>
      ) : (
        !compact && (
          <div className="vp-note">
            {video.description} Public footage of a comparable process — not this plant, not a live view, and not evidence of any event.
            {video.attribution ? ` ${video.attribution}.` : ''} Licence: {video.licence}.
          </div>
        )
      )}
    </div>
  );

  return (
    <figure className={`vp ${compact ? 'compact' : ''}`}>
      <div className="vp-frame">
        {state.kind === 'loading' || state.kind === 'ready' ? (
          isYouTube(video) ? (
            <iframe
              ref={frame}
              className="vp-media"
              src={youTubeSrc(video)}
              title={`${video.label}: ${video.title}`}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              allowFullScreen
            />
          ) : isFile(video) ? (
            <video
              className="vp-media"
              src={video.embedUrl!}
              poster={video.poster ?? undefined}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onCanPlay={() => setState({ kind: 'ready' })}
              onError={() => setState({ kind: 'failed', reason: 'The video file could not be loaded.' })}
            />
          ) : (
            <iframe ref={frame} className="vp-media" src={video.embedUrl!} title={`${video.label}: ${video.title}`} allow="autoplay; fullscreen" loading="lazy" onLoad={() => setState({ kind: 'ready' })} />
          )
        ) : (
          <button
            type="button"
            className="vp-poster"
            onClick={play}
            disabled={!video.embedUrl || state.kind === 'failed'}
            aria-label={video.embedUrl && state.kind !== 'failed' ? `Play ${video.label.toLowerCase()}: ${video.title}` : `${video.title} (cannot be played here)`}
          >
            {video.poster && !posterFailed ? (
              <img src={video.poster} alt="" loading="lazy" decoding="async" onError={() => setPosterFailed(true)} />
            ) : isFile(video) && video.posterTime != null && !posterFailed ? (
              // A frame of the file itself as the still (metadata and that frame only; the clip loads on play).
              <video
                className="vp-still"
                src={`${video.embedUrl}#t=${video.posterTime}`}
                preload="metadata"
                muted
                playsInline
                tabIndex={-1}
                aria-hidden
                onError={() => setPosterFailed(true)}
              />
            ) : (
              <span className="vp-blank" aria-hidden>
                <Clapperboard size={compact ? 22 : 28} />
              </span>
            )}
            {state.kind !== 'failed' && video.embedUrl && (
              <span className="vp-play" aria-hidden>
                <Play size={compact ? 18 : 22} fill="currentColor" />
              </span>
            )}
          </button>
        )}
        {state.kind === 'loading' && (
          <div className={`vp-overlay ${state.slow ? 'slow' : ''}`} role="status">
            {state.slow ? (
              <>
                <span>Still loading.</span>
                <a href={video.sourceUrl} target="_blank" rel="noreferrer noopener">
                  Open the source <ExternalLink size={11} aria-hidden />
                </a>
              </>
            ) : (
              <LoaderCircle className="spin" size={20} aria-label="Loading video" />
            )}
          </div>
        )}
        {state.kind === 'failed' && (
          <div className="vp-overlay failed" role="alert">
            <TriangleAlert size={18} aria-hidden />
            <span>{state.reason}</span>
            <span className="vp-actions">
              <a className="btn sm" href={video.sourceUrl} target="_blank" rel="noreferrer noopener">
                Open on {PROVIDER_LABEL[video.provider]} <ExternalLink size={12} aria-hidden />
              </a>
              <button type="button" className="btn sm ghost" onClick={() => setState({ kind: 'idle' })}>
                <RotateCcw size={12} aria-hidden /> Back
              </button>
            </span>
          </div>
        )}
        {!video.embedUrl && (
          <div className="vp-overlay failed">
            <span>This clip can only be watched on {PROVIDER_LABEL[video.provider]}.</span>
            <a className="btn sm" href={video.sourceUrl} target="_blank" rel="noreferrer noopener">
              Open source <ExternalLink size={12} aria-hidden />
            </a>
          </div>
        )}
      </div>
      <figcaption>{meta}</figcaption>
    </figure>
  );
}
