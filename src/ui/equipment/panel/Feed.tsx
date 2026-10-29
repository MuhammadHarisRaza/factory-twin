/**
 * The panel's ONE feed (types.ts FeedChoice): a configured stream in the camera feed, a client
 * recording or a public reference clip in the bare video player, or an explicit unavailable state.
 * No topic tabs, no title or description under it. A configured stream carries a small source badge
 * on the frame (top-left) — the stream's state; a recording or reference clip carries no tag on the
 * picture. An ⓘ button
 * (top-right; its tooltip names the kind of footage) discloses the compact source details — title,
 * camera, recorded at, provider, licence and the honesty note (a recording, not a live feed). While a
 * provider embed is loaded, whose own title covers the top of the frame, the chrome moves to
 * a slim line under it and the details open below that line, so nothing overlaps the embed.
 *
 * On a phone the inspector is a short bottom sheet: the feed starts as one "Show camera" line, so the
 * state and the key figures stay in view; it opens on demand.
 */
import { memo, useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { sameProps } from '../../kit/equal';

import { ChevronDown, ExternalLink, Film, Globe, Info, Radio, Video, VideoOff, X, type LucideIcon } from 'lucide-react';
import { CameraFeed } from '../../feeds/CameraFeed';
import { useLiveStatus } from '../../feeds/registry';
import type { LiveState } from '../../feeds/live';
import { VideoPlayer, playsInVideoElement } from '../../../video/VideoPlayer';
import type { VideoRef } from '../../../video/types';
import type { FeedChoice, IntelTone } from '../intel/types';

/** Badge of a configured stream from what its player reports: "Live stream" only while it actually plays. */
export function streamBadge(state: LiveState | null): { label: string; tone: IntelTone } {
  switch (state) {
    case 'live':
      return { label: 'Live stream', tone: 'good' };
    case 'loading':
      return { label: 'Stream · connecting', tone: 'neutral' };
    case 'unverified':
      return { label: 'Stream · freshness unknown', tone: 'neutral' };
    case 'stale':
      return { label: 'Stream · stale', tone: 'warning' };
    case 'error':
      return { label: 'Stream · connection error', tone: 'warning' };
    case 'unavailable':
      return { label: 'Stream · not playable here', tone: 'neutral' };
    default:
      return { label: 'Stream · not playing', tone: 'neutral' };
  }
}

/** What a configured stream's players last reported (the best of them; null when none is open for the camera). */
export const useStreamState = (cameraId: string | null) => useLiveStatus((s) => (cameraId ? (s.byCamera[cameraId]?.state ?? null) : null));

/** Recorded client footage and public reference footage of another plant look different (the badge tells them apart). */
const BADGE_ICON: Record<Exclude<FeedChoice['kind'], 'none'>, LucideIcon> = {
  'live-stream': Radio,
  recording: Film,
  reference: Globe,
};

/** Narrow screens (the inspector becomes a bottom sheet): src/ui/twin/twin.css ≤ 760 px. */
const NARROW = '(max-width: 760px)';
function useNarrow() {
  const query = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches;
  const [narrow, setNarrow] = useState(query);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

function SourceDetails({ feed, onClose, id, closeRef }: { feed: Exclude<FeedChoice, { kind: 'none' }>; onClose: () => void; id: string; closeRef: RefObject<HTMLButtonElement | null> }) {
  const video: VideoRef | null = feed.kind === 'recording' || feed.kind === 'reference' ? feed.video : null;
  // A disclosure (not a dialog): it does not trap focus or take the twin's shortcuts; Esc and its X
  // close it and return focus to the ⓘ that opened it.
  return (
    <div className="eqp-pop" role="region" aria-label="Source details" id={id}>
      <div className="eqp-pop-h">
        <b>Source details</b>
        <button type="button" ref={closeRef} className="btn ghost sm icon" onClick={onClose} aria-label="Close source details" title="Close (Esc)">
          <X size={13} />
        </button>
      </div>
      <dl>
        {feed.details.map((d) => (
          <div key={d.label} className={d.label === 'Note' ? 'note' : ''}>
            <dt>{d.label}</dt>
            <dd>{d.value}</dd>
          </div>
        ))}
      </dl>
      {video && (
        <a className="eqp-pop-link" href={video.sourceUrl} target="_blank" rel="noreferrer noopener">
          {feed.kind === 'recording' ? 'Open the recording file' : 'Open the original source'} <ExternalLink size={11} aria-hidden />
        </a>
      )}
      {feed.kind === 'live-stream' && <p className="eqp-pop-fine">Camera streams are configured under Technical details › Cameras.</p>}
    </div>
  );
}

/**
 * `subject` identifies what the panel shows (an asset or vehicle id): while the viewer holds a clip
 * (started it with sound, unmuted it or paused it), a new feed choice for the same subject (a truck
 * changing visit phase) does not swap the clip under them; a clip that only plays by itself (muted)
 * follows the choice.
 */
export const FeedView = memo(function FeedView({ feed, subject }: { feed: FeedChoice; subject: string }) {
  const [held, setHeld] = useState<{ subject: string; feed: FeedChoice } | null>(null);
  const current = held && held.subject === subject ? held.feed : feed;
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState(false);
  const narrow = useNarrow();
  const [shownOn, setShownOn] = useState<string | null>(null);
  const popId = useId();
  const box = useRef<HTMLDivElement>(null);
  const info = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const stream = useStreamState(current.kind === 'live-stream' ? current.cameraId : null);
  const videoId = current.kind === 'recording' || current.kind === 'reference' ? current.video.id : null;

  const onActiveChange = useCallback(
    (loaded: boolean, engaged: boolean) => {
      setActive(loaded);
      setHeld(engaged ? { subject, feed: current } : null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keep the clip that was playing when it started
    [subject, videoId],
  );

  /** Closes the details; `refocus` returns focus to the ⓘ (Esc, the X) instead of leaving it on <body>. */
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => info.current?.focus());
  }, []);

  // The details close with Esc (focus back on ⓘ) or a click outside. The twin's shortcuts leave Esc to
  // an open .eqp-pop (src/useKeyboardShortcuts.ts OVERLAY_SELECTOR) and keep working otherwise.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) close(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, close]);
  // Another subject: details closed.
  useEffect(() => setOpen(false), [subject]);

  if (current.kind === 'none')
    return (
      <div className="eqp-feed-none" role="note">
        <VideoOff size={15} aria-hidden />
        <span>
          <b>No camera image</b> {current.reason}
        </span>
      </div>
    );

  const badge = current.kind === 'live-stream' ? streamBadge(stream) : { label: current.badge, tone: 'neutral' as IntelTone };
  const Icon = BADGE_ICON[current.kind];

  // Phone bottom sheet: one line until the user asks for the camera (per subject).
  if (narrow && shownOn !== subject)
    return (
      <button type="button" className="eqp-feed-show" aria-expanded={false} onClick={() => setShownOn(subject)} title="Show the camera / footage of this subject">
        <Video size={14} aria-hidden />
        <span>Show camera</span>
        <span className={`eqp-feed-badge k-${current.kind} ${badge.tone}`}>
          <Icon size={12} aria-hidden />
          {badge.label}
        </span>
        <ChevronDown size={14} aria-hidden className="chev" />
      </button>
    );

  const video = current.kind === 'recording' || current.kind === 'reference' ? current.video : null;
  // A provider embed draws its own title over the top of the frame while it is loaded.
  const docked = active && video != null && !playsInVideoElement(video);
  // A recording or reference clip has no badge on the picture: the ⓘ's tooltip names the footage (a public
  // reference clip is also not this plant).
  const disclosure = current.kind === 'reference' ? 'not this plant, not a live feed' : 'not a live feed';
  const infoTitle = video ? `${badge.label} footage — ${disclosure}. Source details` : 'Source details';
  // No tag on the picture of a recording or reference clip: its ⓘ (tooltip and source details) says what it is.
  const chrome = (
    <>
      {!video && (
        <span className={`eqp-feed-badge k-${current.kind} ${badge.tone}`} title={current.details.find((d) => d.label === 'Note')?.value}>
          <Icon size={12} aria-hidden />
          {badge.label}
        </span>
      )}
      <button
        type="button"
        ref={info}
        className={`eqp-feed-info ${open ? 'on' : ''}`}
        aria-label={video ? `Source details · ${badge.label.toLowerCase()} footage, ${disclosure}` : 'Source details'}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={infoTitle}
        onClick={() => {
          if (open) close(false);
          else {
            setOpen(true);
            // Focus moves into the details so a screen reader reads them, not just "expanded".
            requestAnimationFrame(() => closeBtn.current?.focus());
          }
        }}
      >
        <Info size={14} aria-hidden />
      </button>
    </>
  );

  return (
    <div className={`eqp-feed k-${current.kind} ${docked ? 'docked' : ''}`} ref={box}>
      <div className="eqp-feed-frame">
        {video ? (
          <VideoPlayer key={video.id} video={video} bare onActiveChange={onActiveChange} />
        ) : current.kind === 'live-stream' ? (
          <CameraFeed key={current.cameraId} cameraId={current.cameraId} compact />
        ) : null}
        {!docked && <div className="eqp-feed-chrome">{chrome}</div>}
      </div>
      {docked && <div className="eqp-feed-dock">{chrome}</div>}
      {open && <SourceDetails feed={current} onClose={() => close(true)} id={popId} closeRef={closeBtn} />}
    </div>
  );
}, sameProps);
