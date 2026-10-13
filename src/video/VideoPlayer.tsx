/**
 * Video player for public reference clips and client recordings. A clip starts by itself — muted,
 * looping — as soon as its frame is on screen (browsers only allow autoplay without sound); it
 * pauses when scrolled or panned out of view and resumes when it comes back. Nothing is loaded
 * from the provider before the frame is visible. The picture has no playback controls (no play
 * bar, timeline or duration; the provider embeds are asked to hide theirs): a click (or Space /
 * Enter) on it pauses and resumes it, so moving footage can always be stopped.
 * Viewers who asked their system for reduced motion or data saving get the poster and play
 * button instead of autoplay; a browser that refuses autoplay falls back to the same poster.
 * Sound only plays when the viewer starts a clip from that poster, and only one player has sound
 * at a time: another one taking it mutes the previous one, which keeps playing.
 * YouTube clips play in the privacy-enhanced embed and report errors through the player's
 * postMessage channel, so a removed clip or one whose owner disabled embedding falls back to the
 * poster with an "Open on YouTube" link instead of a black box. Direct MP4 files play in <video>.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Clapperboard, ExternalLink, LoaderCircle, Pause, Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { ProvenanceBadge } from '../ui/kit/Page';
import type { VideoRef } from './types';
import './video.css';

/** The one player allowed to play with sound, by player instance (another one taking it mutes it). */
const useSound = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({ id: null, set: (id) => set({ id }) }));

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

/** Share of the frame that must be on screen for the clip to play (on) by itself. */
const VISIBLE_RATIO = 0.35;

const isYouTube = (v: VideoRef) => v.provider === 'youtube' && !!v.embedUrl;
const isVimeo = (v: VideoRef) => v.provider === 'vimeo' && !!v.embedUrl;
const isFile = (v: VideoRef) => !!v.embedUrl && /\.(mp4|webm)(\?|$)/i.test(v.embedUrl);

/**
 * True when the clip plays in a <video> element (its controls sit at the bottom only); false for
 * provider embeds (YouTube and others draw their own title and buttons over the top of the frame).
 */
export const playsInVideoElement = isFile;

/**
 * Whether clips may start by themselves here: not when the viewer asked for reduced motion or data
 * saving (they get the poster and play button). Server rendering: no (the poster is rendered).
 */
export function autoplayAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  } catch {
    /* no media queries: allowed */
  }
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: { saveData?: boolean } }) : null;
  return !nav?.connection?.saveData;
}

/** The YouTube embed URL: autoplay, no player controls; `muted` when the clip started by itself; a whole clip loops. */
export function youTubeSrc(v: VideoRef, muted: boolean) {
  const u = new URL(v.embedUrl!);
  u.searchParams.set('autoplay', '1');
  u.searchParams.set('rel', '0');
  u.searchParams.set('playsinline', '1');
  u.searchParams.set('enablejsapi', '1');
  u.searchParams.set('controls', '0');
  u.searchParams.set('disablekb', '1');
  u.searchParams.set('fs', '0');
  u.searchParams.set('iv_load_policy', '3');
  if (typeof location !== 'undefined') u.searchParams.set('origin', location.origin);
  if (v.segment?.start) u.searchParams.set('start', String(Math.floor(v.segment.start)));
  if (v.segment?.end) u.searchParams.set('end', String(Math.floor(v.segment.end)));
  if (muted) u.searchParams.set('mute', '1');
  // A single clip loops only as a playlist of itself; a clip cut to a segment stops at its end.
  const ytId = u.pathname.split('/').pop();
  if (!v.segment?.end && ytId) {
    u.searchParams.set('loop', '1');
    u.searchParams.set('playlist', ytId);
  }
  return u.toString();
}

/** Other provider embeds (Vimeo): autoplay and loop without controls, muted when the clip started by itself. */
export function embedSrc(v: VideoRef, muted: boolean) {
  if (!isVimeo(v)) return v.embedUrl!;
  const u = new URL(v.embedUrl!);
  u.searchParams.set('autoplay', '1');
  u.searchParams.set('loop', '1');
  u.searchParams.set('controls', '0');
  if (muted) u.searchParams.set('muted', '1');
  return u.toString();
}

type State = { kind: 'idle' } | { kind: 'loading'; slow: boolean } | { kind: 'ready' } | { kind: 'failed'; reason: string };

/**
 * One player for one clip (hosts mount a fresh player per clip, keyed by the clip id).
 * `onActiveChange(loaded, engaged)` reports whether the embed is loaded (playing, paused or loading)
 * and whether the viewer engaged with it (started it with sound or unmuted it): hosts keep an
 * engaged clip instead of swapping it under the viewer; an ambient (muted, autoplayed) one may change.
 * `bare`: the frame only — no title, provenance line or note under it (the host shows the source in
 * its own badge and source-details control); autoplay, sound rules and the error fallback are unchanged.
 */
export function VideoPlayer({
  video,
  compact = false,
  bare = false,
  onActiveChange,
}: {
  video: VideoRef;
  compact?: boolean;
  bare?: boolean;
  onActiveChange?: (loaded: boolean, engaged: boolean) => void;
}) {
  const me = useId();
  const soundId = useSound((s) => s.id);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [posterFailed, setPosterFailed] = useState(false);
  // Started by itself (muted) or by the viewer (with sound); fixed while the embed is loaded.
  const [muted, setMuted] = useState(true);
  const [engaged, setEngaged] = useState(false);
  const [visible, setVisible] = useState(false);
  // The viewer paused the picture (a click on it): it stays paused until they click again.
  const [userPaused, setUserPaused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const media = useRef<HTMLVideoElement>(null);
  const visibleRef = useRef(false);
  const autoTried = useRef(false);
  const autoPaused = useRef(false);
  const audible = useRef(false);
  const ytState = useRef<number | null>(null);
  const loaded = state.kind === 'loading' || state.kind === 'ready';
  const file = isFile(video);

  /** Sends a command to the provider embed (YouTube IFrame API / Vimeo player API). */
  const command = (func: 'playVideo' | 'pauseVideo' | 'mute') => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    if (isYouTube(video)) w.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
    else if (isVimeo(video)) w.postMessage(JSON.stringify(func === 'mute' ? { method: 'setMuted', value: true } : { method: func === 'playVideo' ? 'play' : 'pause' }), '*');
  };
  /** The viewer turned the sound on: this player takes the sound (muting the previous one) and is kept by its host. */
  const takeSound = () => {
    audible.current = true;
    setEngaged(true);
    if (useSound.getState().id !== me) useSound.getState().set(me);
  };

  // Whether the frame is on screen (inside every scrolling ancestor); without an observer it counts as visible.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = (v: boolean) => {
      visibleRef.current = v;
      setVisible(v);
    };
    if (typeof IntersectionObserver === 'undefined') {
      on(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => on(!!e && e.isIntersecting && e.intersectionRatio >= VISIBLE_RATIO), { threshold: [0, VISIBLE_RATIO, 0.75] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // On screen for the first time: start by itself, muted (once — a refused or failed start shows the poster).
  useEffect(() => {
    if (!visible || state.kind !== 'idle' || autoTried.current || !video.embedUrl || !autoplayAllowed()) return;
    autoTried.current = true;
    setMuted(true);
    setState({ kind: 'loading', slow: false });
  }, [visible, state.kind, video.embedUrl]);

  // Out of view: pause what is playing; back in view: resume what was paused for that reason
  // (a clip the viewer paused stays paused).
  useEffect(() => {
    if (!loaded) return;
    if (!visible) {
      const playing = media.current ? !media.current.paused : ytState.current == null || ytState.current === 1 || ytState.current === 3;
      if (playing) {
        autoPaused.current = true;
        if (media.current) media.current.pause();
        else command('pauseVideo');
      }
    } else if (autoPaused.current) {
      autoPaused.current = false;
      if (media.current) void media.current.play()?.catch(() => {});
      else command('playVideo');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to visibility and load only
  }, [visible, loaded]);

  // Another player took the sound: this one keeps playing, muted.
  useEffect(() => {
    if (soundId === me || !audible.current || !loaded) return;
    audible.current = false;
    if (media.current) media.current.muted = true;
    else command('mute');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the sound owner only
  }, [soundId, me, loaded]);

  // Tell the host whether the embed is loaded and engaged (an engaged clip is not swapped under the viewer).
  useEffect(() => {
    onActiveChange?.(loaded, loaded && engaged);
  }, [loaded, engaged, onActiveChange]);

  // Back on the poster (failed, Back, refused autoplay): no sound owned, not engaged, not paused.
  useEffect(() => {
    if (loaded) return;
    audible.current = false;
    autoPaused.current = false;
    ytState.current = null;
    setEngaged(false);
    setUserPaused(false);
    if (useSound.getState().id === me) useSound.getState().set(null);
  }, [loaded, me]);

  // Unmounting the player releases the sound (only if it is still this player's).
  useEffect(
    () => () => {
      if (useSound.getState().id === me) useSound.getState().set(null);
    },
    [me],
  );

  // A <video> file: start it — muted when it started by itself (set on the element before play(), as the
  // autoplay policy requires). A refused autoplay goes back to the poster and its play button.
  useEffect(() => {
    const el = media.current;
    if (!loaded || !file || !el) return;
    el.muted = muted;
    if (!visibleRef.current) {
      autoPaused.current = true;
      return;
    }
    el.play()?.catch((err: unknown) => {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      setState({ kind: 'idle' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per load
  }, [loaded, file]);

  // YouTube: listen to the player's postMessage channel while the embed is loaded. A clip whose owner
  // disabled embedding reports "ready" and then error 150, so errors are honoured after ready too.
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
        return;
      }
      if (d.event === 'onReady') setState((s) => (s.kind === 'loading' ? { kind: 'ready' } : s));
      const info = (d.info ?? null) as { playerState?: number; muted?: boolean; volume?: number } | number | null;
      const ps = d.event === 'onStateChange' && typeof info === 'number' ? info : info && typeof info === 'object' ? info.playerState : undefined;
      if (typeof ps === 'number') {
        ytState.current = ps;
        // It started while out of view (ready after the viewer scrolled on): paused until it is back.
        if ((ps === 1 || ps === 3) && !visibleRef.current) {
          autoPaused.current = true;
          command('pauseVideo');
        }
      }
      if (info && typeof info === 'object' && typeof info.muted === 'boolean') {
        const on = !info.muted && (info.volume ?? 100) > 0;
        if (on && !audible.current) takeSound();
        else if (!on) audible.current = false;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per load of this clip
  }, [loaded, video]);

  // Offer the link out when the embed has not reported ready after a while (never an endless spinner).
  useEffect(() => {
    if (state.kind !== 'loading' || state.slow) return;
    const t = setTimeout(() => setState((s) => (s.kind === 'loading' ? { kind: 'loading', slow: true } : s)), SLOW_MS);
    return () => clearTimeout(t);
  }, [state]);

  /** A click (or Space / Enter) on the picture: pause it, or resume it. */
  const toggle = (el: HTMLVideoElement) => {
    autoPaused.current = false;
    if (el.paused) {
      setUserPaused(false);
      void el.play()?.catch(() => {});
    } else {
      setUserPaused(true);
      el.pause();
    }
  };

  /** The poster's play button: the viewer starts the clip, with sound. */
  const play = () => {
    if (!video.embedUrl) return;
    autoTried.current = true;
    setMuted(false);
    takeSound();
    setState({ kind: 'loading', slow: false });
  };

  const ytSrc = useMemo(() => (loaded && isYouTube(video) ? youTubeSrc(video, muted) : null), [loaded, video, muted]);
  const otherSrc = useMemo(() => (loaded && !isYouTube(video) && !file && video.embedUrl ? embedSrc(video, muted) : null), [loaded, video, muted, file]);

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
    <figure className={`vp ${compact || bare ? 'compact' : ''} ${bare ? 'bare' : ''}`}>
      <div className="vp-frame" ref={box}>
        {loaded ? (
          isYouTube(video) ? (
            <iframe
              ref={frame}
              className="vp-media"
              src={ytSrc!}
              title={`${video.label}: ${video.title}`}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              allowFullScreen
            />
          ) : file ? (
            <video
              ref={media}
              className="vp-media"
              src={video.embedUrl!}
              poster={video.poster ?? undefined}
              aria-label={`${video.label}: ${video.title} — ${userPaused ? 'paused, press to resume' : 'press to pause'}`}
              tabIndex={0}
              loop
              playsInline
              preload="auto"
              disablePictureInPicture
              onClick={(e) => toggle(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  toggle(e.currentTarget);
                }
              }}
              onCanPlay={() => setState((s) => (s.kind === 'loading' ? { kind: 'ready' } : s))}
              onPlaying={(e) => {
                // It started while out of view: paused until it is back.
                if (!visibleRef.current) {
                  autoPaused.current = true;
                  e.currentTarget.pause();
                }
              }}
              onVolumeChange={(e) => {
                const on = !e.currentTarget.muted && e.currentTarget.volume > 0;
                if (on && !audible.current) takeSound();
                else if (!on) audible.current = false;
              }}
              onError={() => setState({ kind: 'failed', reason: 'The video file could not be loaded.' })}
            />
          ) : (
            <iframe ref={frame} className="vp-media" src={otherSrc!} title={`${video.label}: ${video.title}`} allow="autoplay; fullscreen" loading="lazy" onLoad={() => setState({ kind: 'ready' })} />
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
            ) : file && video.posterTime != null && !posterFailed ? (
              // A frame of the file itself as the still (metadata and that frame only; the clip loads when it plays).
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
        {userPaused && loaded && (
          <span className="vp-held" aria-hidden>
            <Pause size={12} fill="currentColor" /> Paused
          </span>
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
      {!bare && <figcaption>{meta}</figcaption>}
    </figure>
  );
}
