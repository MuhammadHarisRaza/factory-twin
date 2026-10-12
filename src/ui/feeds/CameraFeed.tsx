import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Camera, CirclePlay, LoaderCircle, RefreshCw, VideoOff, WifiOff, type LucideIcon } from 'lucide-react';
import { useApp, type CameraSource } from '../../app/store';
import { CAMERA_BY_ID, MONITORED_STAGE_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { CameraDef, MonitoredStageId, StageId } from '../../model/types';
import { simClock } from '../../sim/store';
import { formatClockSec, formatDay } from '../../sim/time';
import { renderTwinCamera, twinRendererReady, type TwinRender } from '../../twin/bridge';
import { FEED_STATUS, FeedStatusBadge, StatusBadge, type Tone } from '../kit/Status';
import { feedRenderSize, frameTimeOf } from './frames';
import {
  RESOLVED_LABEL,
  STALE_DETAIL,
  UNVERIFIED_DETAIL,
  browserEnv,
  isPlaying,
  mjpegState,
  planStream,
  snapshotBlocked,
  staleness,
  urlSummary,
  type LiveState,
} from './live';
import { registerLive, useLiveStatus } from './registry';
import { frameFingerprint, grabFrame } from './snapshot';
import { SnapshotViewer, type Snapshot } from './SnapshotViewer';
import './feeds.css';

/**
 * Camera feed. Without a configured stream it shows the camera position's view rendered from the
 * digital twin, refreshed about every 2 s while on screen and labelled as simulated. With a stream
 * configured (Assets & Data → Camera sources) it plays the stream and shows "Live" only once the
 * media element actually plays and new frames can be seen arriving; otherwise connecting / connection
 * error / stale / unavailable, or "Playing · freshness unknown" when a frozen image could not be told
 * apart from a moving one (an MJPEG / JPEG stream without CORS permission).
 */
export type CameraFeedProps = {
  cameraId: string;
  /** Height in px (width follows the container, 16:9 by default). */
  height?: number;
  /** Smaller chrome for side panels. */
  compact?: boolean;
  style?: CSSProperties;
};

const REFRESH_MS = 2000;
const CONNECT_TIMEOUT_MS = 20_000;
const SNAPSHOT_SIZE = { width: 960, height: 540 };
export const SIMULATED_LABEL = 'Simulated feed · rendered from the digital twin';

/** Badge of a configured stream's state ("Live" only while it actually plays). */
export const LIVE_BADGE: Record<LiveState, { tone: Tone; icon: LucideIcon; label: string }> = {
  loading: { tone: 'neutral', icon: LoaderCircle, label: 'Connecting' },
  live: FEED_STATUS.live,
  // Playing, but a frozen image could not be told apart from a moving one (no CORS): never "Live".
  unverified: { tone: 'neutral', icon: CirclePlay, label: 'Playing · freshness unknown' },
  stale: FEED_STATUS.stale,
  error: { ...FEED_STATUS.disconnected, label: 'Connection error' },
  unavailable: FEED_STATUS.unavailable,
};

export function cameraStageName(stage: CameraDef['stage']) {
  if (stage == null) return null;
  if (stage === 'YARD') return 'Site & yard';
  return MONITORED_STAGE_BY_ID[stage as MonitoredStageId]?.name ?? STAGE_BY_ID[stage as StageId]?.name ?? stage;
}

const localClock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });

/** Why a media element failed, from its MediaError when it has one. */
function mediaErrorText(el: HTMLVideoElement | HTMLImageElement | null) {
  const code = el instanceof HTMLVideoElement ? el.error?.code : undefined;
  if (code === 2) return 'Network error while loading the stream';
  if (code === 3) return 'The stream could not be decoded';
  if (code === 4) return 'The stream could not be opened — unreachable, or a format this browser cannot play';
  return 'The stream could not be loaded';
}

/** On screen (IntersectionObserver) and the document visible. */
function useOnScreen(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false);
  const [docVisible, setDocVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const on = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return inView && docVisible;
}

function Msg({ icon: Icon, title, text, overlay, children }: { icon: LucideIcon; title: string; text?: ReactNode; overlay?: boolean; children?: ReactNode }) {
  return (
    <div className={`feed-msg ${overlay ? 'overlay' : ''}`}>
      <Icon size={18} aria-hidden />
      <b>{title}</b>
      {text && <span>{text}</span>}
      {children && <div className="feed-msg-actions">{children}</div>}
    </div>
  );
}

/** Header, media box and footer shared by both modes. */
function FeedFrame({
  cam,
  compact,
  badge,
  time,
  timeTitle,
  mediaRef,
  mediaStyle,
  media,
  label,
  actions,
  note,
}: {
  cam: CameraDef;
  compact: boolean;
  badge: ReactNode;
  time: string | null;
  timeTitle: string;
  mediaRef?: RefObject<HTMLDivElement | null>;
  mediaStyle: CSSProperties;
  media: ReactNode;
  label: ReactNode;
  actions: ReactNode;
  note: ReactNode;
}) {
  const stage = cameraStageName(cam.stage);
  return (
    <>
      {!compact && (
        <div className="feed-h">
          <span className="mono feed-id">{cam.id}</span>
          <span className="feed-name" title={cam.purpose}>
            {cam.name}
          </span>
          {stage && <span className="feed-stage">· {stage}</span>}
          <span className="spacer" />
          {badge}
        </div>
      )}
      <div className="feed-media" ref={mediaRef} style={mediaStyle}>
        {media}
        {compact && (
          <div className="feed-chips">
            <span className="feed-chip">{badge}</span>
            {time && (
              <span className="feed-chip num" title={timeTitle}>
                {time}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="feed-f">
        <span className="feed-label">{label}</span>
        {!compact && time && (
          <span className="feed-time num" title={timeTitle}>
            {time}
          </span>
        )}
        {actions}
      </div>
      {note && (
        <div className="feed-note" role="status" title={typeof note === 'string' ? note : undefined}>
          {note}
        </div>
      )}
    </>
  );
}

function SnapshotButton({ onClick, disabled, busy, compact, title }: { onClick: () => void; disabled?: boolean; busy?: boolean; compact: boolean; title: string }) {
  return (
    <button className={`btn ghost sm feed-snap ${compact ? 'icon' : ''}`} onClick={onClick} disabled={disabled || busy} title={title} aria-label="Take a snapshot">
      {busy ? <LoaderCircle size={13} className="feed-spin" aria-hidden /> : <Camera size={13} aria-hidden />}
      {!compact && 'Snapshot'}
    </button>
  );
}

// ── Simulated feed (twin render) ───────────────────────────────────────────────

function SimulatedFeed({
  cam,
  compact,
  mediaStyle,
  onSnapshot,
  streamConfigured,
  onBackToStream,
}: {
  cam: CameraDef;
  compact: boolean;
  mediaStyle: CSSProperties;
  onSnapshot: (s: Snapshot) => void;
  streamConfigured: boolean;
  onBackToStream: () => void;
}) {
  const mediaRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(mediaRef);
  const [frame, setFrame] = useState<TwinRender | null>(null);
  const [phase, setPhase] = useState<'waiting' | 'ok' | 'none' | 'failed'>('waiting');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!onScreen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      if (!twinRendererReady()) {
        timer = setTimeout(tick, 1000);
        return;
      }
      const el = mediaRef.current;
      try {
        const img = await renderTwinCamera(cam.id, feedRenderSize(el?.clientWidth ?? 0, el?.clientHeight ?? 0, window.devicePixelRatio));
        if (cancelled) return;
        if (img) {
          setFrame(img);
          setPhase('ok');
        } else setPhase(twinRendererReady() ? 'none' : 'waiting');
      } catch {
        if (!cancelled) setPhase('failed');
      }
      if (!cancelled) timer = setTimeout(tick, REFRESH_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [onScreen, cam.id]);

  const snapshot = async () => {
    setNote(null);
    setBusy(true);
    try {
      const img = await renderTwinCamera(cam.id, SNAPSHOT_SIZE);
      if (img) onSnapshot({ cameraId: cam.id, origin: 'simulated', frame: img, plantMinute: frameTimeOf(img) ?? simClock.t });
      else setNote('The 3D twin is not ready to render yet — try again in a moment.');
    } catch {
      setNote('The twin view could not be rendered.');
    } finally {
      setBusy(false);
    }
  };

  const t = frameTimeOf(frame);
  const time = t == null ? null : compact ? formatClockSec(t) : `${formatDay(t)} ${formatClockSec(t)}`;
  const media =
    frame && phase !== 'none' ? (
      <img className="feed-img" src={frame.dataUrl} alt={`Simulated view of ${cam.id}, rendered from the digital twin`} draggable={false} />
    ) : phase === 'none' ? (
      <Msg icon={VideoOff} title="No simulated view" text="No virtual camera position is defined for this camera." />
    ) : phase === 'failed' ? (
      <Msg icon={VideoOff} title="The twin view could not be rendered" text="It is retried every few seconds." />
    ) : (
      <Msg icon={LoaderCircle} title="Waiting for the 3D twin…" text="The view is rendered from the digital twin once the scene has loaded." />
    );

  return (
    <FeedFrame
      cam={cam}
      compact={compact}
      badge={<FeedStatusBadge status="simulated" />}
      time={time}
      timeTitle="Plant time of the last render"
      mediaRef={mediaRef}
      mediaStyle={mediaStyle}
      media={media}
      label={<span title="Simulated camera view: the digital twin rendered from this camera position — not a camera image">{SIMULATED_LABEL}</span>}
      actions={
        <>
          {streamConfigured && (
            <button className="btn ghost sm feed-back" onClick={onBackToStream} title="Show the configured stream again">
              {compact ? 'Stream' : 'Back to stream'}
            </button>
          )}
          <SnapshotButton onClick={snapshot} busy={busy} compact={compact} title="Snapshot of the simulated view (opens a viewer with download)" />
        </>
      }
      note={note ?? (streamConfigured ? 'A stream is configured for this camera but is not playing — showing the simulated view.' : null)}
    />
  );
}

// ── Configured stream ──────────────────────────────────────────────────────────

function LiveFeed({
  cam,
  source,
  compact,
  mediaStyle,
  onSnapshot,
  onShowSimulated,
}: {
  cam: CameraDef;
  source: CameraSource;
  compact: boolean;
  mediaStyle: CSSProperties;
  onSnapshot: (s: Snapshot) => void;
  onShowSimulated: () => void;
}) {
  const plan = useMemo(() => planStream(source, browserEnv()), [source]);
  const kind = plan.ok ? plan.kind : null;
  const [attempt, setAttempt] = useState(0);
  // First try with CORS (frames can then be captured); a stream without CORS headers fails that way and is retried without it.
  const [cors, setCors] = useState<'anonymous' | 'none'>('anonymous');
  const [state, setState] = useState<LiveState>(plan.ok ? 'loading' : 'unavailable');
  const [detail, setDetail] = useState<string | null>(plan.ok ? null : plan.reason);
  const [note, setNote] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const stateRef = useRef(state);
  const mediaEl = useRef<HTMLVideoElement | HTMLImageElement | null>(null);
  const lastFrame = useRef<number | null>(null);
  const played = useRef(false);
  /** `load` events seen on the current <img> (more than one = the browser fires one per MJPEG part). */
  const loads = useRef<{ el: HTMLImageElement | null; n: number }>({ el: null, n: 0 });
  const probeRef = useRef<HTMLCanvasElement | null>(null);
  const probe = () => (probeRef.current ??= document.createElement('canvas'));
  const loadsOf = (el: HTMLImageElement) => (loads.current.el === el ? loads.current.n : 0);
  const unverified = state === 'unverified';

  const go = useCallback((next: LiveState, why: string | null) => {
    stateRef.current = next;
    setState(next);
    setDetail(why);
  }, []);
  const goPlaying = useCallback(
    (next: LiveState) => go(next, next === 'stale' ? STALE_DETAIL : next === 'unverified' ? UNVERIFIED_DETAIL : null),
    [go],
  );

  // Each player reports under its own id: another player of the same camera (the floating camera view
  // next to the panel's feed) mounting or closing never resets this one's state.
  const playerId = useId();
  const report = useLiveStatus((s) => s.report);
  useEffect(() => {
    report(cam.id, { state, at: Date.now(), detail: detail ?? undefined }, playerId);
  }, [cam.id, state, detail, report, playerId]);
  useEffect(() => () => report(cam.id, null, playerId), [cam.id, report, playerId]);

  // Registry of playing elements (event evidence grabs its frame from here).
  useEffect(() => {
    const el = mediaEl.current;
    if (!el || !plan.ok) return;
    return registerLive({ cameraId: cam.id, el, isLive: () => stateRef.current === 'live' });
  }, [cam.id, plan.ok, cors, attempt]);

  // Connection timeout, MJPEG freshness probe, staleness and the "last frame" clock.
  useEffect(() => {
    if (!plan.ok) return;
    const started = Date.now();
    let lastFp: number | null = null;
    const iv = setInterval(() => {
      const now = Date.now();
      const st = stateRef.current;
      if (st === 'loading') {
        if (now - started > CONNECT_TIMEOUT_MS) go('error', 'No response from the stream within 20 s');
        return;
      }
      const img = mediaEl.current;
      let next: LiveState;
      if (kind === 'mjpeg' && img instanceof HTMLImageElement) {
        // Pixels readable: a changed fingerprint is a new frame. Not readable (no CORS): only repeated
        // load events (one per part) show frames arriving; else freshness is unknown → never 'live'.
        const fp = isPlaying(st) ? frameFingerprint(img, probe()) : null;
        if (fp != null && fp !== lastFp) {
          lastFp = fp;
          lastFrame.current = now;
        }
        next = mjpegState(st, { fingerprint: fp, loads: loadsOf(img), lastFrameAt: lastFrame.current, now });
      } else next = staleness(st, lastFrame.current, now);
      if (next !== st) goPlaying(next);
      setTick((n) => (n + 1) % 1_000_000);
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- probe / loadsOf only read refs
  }, [plan.ok, kind, cors, attempt, go, goPlaying]);

  const onLive = () => {
    const now = Date.now();
    lastFrame.current = now;
    played.current = true;
    let next: LiveState = 'live';
    const img = mediaEl.current;
    if (kind === 'mjpeg' && img instanceof HTMLImageElement) {
      if (loads.current.el !== img) loads.current = { el: img, n: 0 };
      loads.current.n += 1;
      next = mjpegState('live', { fingerprint: frameFingerprint(img, probe()), loads: loads.current.n, lastFrameAt: now, now });
    }
    if (stateRef.current !== next) goPlaying(next);
  };
  const onError = () => {
    // Never played with CORS: the gateway may simply not send CORS headers — retry without (plays, but frames can't be read).
    if (cors === 'anonymous' && !played.current) {
      setCors('none');
      return;
    }
    go('error', mediaErrorText(mediaEl.current));
  };
  const retry = () => {
    lastFrame.current = null;
    played.current = false;
    loads.current = { el: null, n: 0 };
    setCors('anonymous');
    setAttempt((a) => a + 1);
    go('loading', null);
  };

  const snapshot = () => {
    setNote(null);
    const el = mediaEl.current;
    // Only a live frame: a stale / unverified one may be old but would be stamped with the capture time.
    const blocked = snapshotBlocked(stateRef.current);
    if (!el || blocked) {
      setNote(`${blocked ?? 'No frame to capture — the stream is not playing'}.`);
      return;
    }
    const g = grabFrame(el, cam.id);
    if (g.ok) onSnapshot({ cameraId: cam.id, origin: 'live', frame: g.frame, at: g.at });
    else setNote(g.reason === 'cors' ? `${g.message}.` : g.message);
  };

  const url = source.url;
  const elKey = `${cors}-${attempt}`;
  const crossOrigin = cors === 'anonymous' ? 'anonymous' : undefined;
  const alt = `Configured camera stream of ${cam.id}`;
  const playing = isPlaying(state);
  const media = !plan.ok ? (
    <Msg icon={VideoOff} title={plan.reason} text={plan.detail}>
      <button className="btn sm" onClick={onShowSimulated}>
        Show simulated view
      </button>
    </Msg>
  ) : (
    <>
      {kind === 'mjpeg' ? (
        <img
          key={elKey}
          ref={(el) => {
            mediaEl.current = el;
          }}
          className="feed-img"
          src={url}
          alt={alt}
          crossOrigin={crossOrigin}
          onLoad={onLive}
          onError={onError}
          draggable={false}
        />
      ) : (
        <video
          key={elKey}
          ref={(el) => {
            mediaEl.current = el;
            // Muted autoplay is allowed everywhere; set the property explicitly (React does not reflect `muted`).
            if (el) {
              el.muted = true;
              el.defaultMuted = true;
            }
          }}
          className="feed-img"
          src={url}
          crossOrigin={crossOrigin}
          muted
          autoPlay
          playsInline
          aria-label={alt}
          onPlaying={onLive}
          onTimeUpdate={() => {
            lastFrame.current = Date.now();
          }}
          onError={onError}
          onEnded={() => setDetail('The stream ended')}
        />
      )}
      {state === 'loading' && <Msg overlay icon={LoaderCircle} title="Connecting to the stream…" text={urlSummary(url)} />}
      {state === 'error' && (
        <Msg
          overlay
          icon={WifiOff}
          title="Connection error"
          text={`${detail ?? 'The stream could not be loaded'}. Check that the gateway is reachable from this browser${plan.warning ? `; ${plan.warning.charAt(0).toLowerCase()}${plan.warning.slice(1)}` : '.'}`}
        >
          <button className="btn sm" onClick={retry}>
            <RefreshCw size={12} aria-hidden /> Retry
          </button>
          <button className="btn sm ghost" onClick={onShowSimulated}>
            Show simulated view
          </button>
        </Msg>
      )}
      {state === 'stale' && <div className="feed-stale">Stale — no new frame for more than 10 s</div>}
    </>
  );

  const time =
    lastFrame.current != null && playing ? `${unverified ? 'Connected' : compact ? '' : 'Last frame'} ${localClock(lastFrame.current)}`.trim() : null;
  const label = plan.ok
    ? `Configured stream · ${RESOLVED_LABEL[plan.kind]}${plan.guessed ? ' (detected from URL)' : ''}`
    : 'Configured stream · not playable in this browser';
  const hint =
    note ??
    (unverified
      ? cors === 'none'
        ? 'Playing without CORS permission: whether new frames still arrive cannot be checked, so the feed is not shown as Live; snapshots and event frames cannot be taken from this stream.'
        : 'Whether new frames still arrive cannot be checked for this stream, so it is not shown as Live.'
      : playing && cors === 'none'
        ? 'Playing without CORS permission: snapshots and event frames cannot be taken from this stream.'
        : null);
  const blocked = snapshotBlocked(state);

  return (
    <FeedFrame
      cam={cam}
      compact={compact}
      badge={<StatusBadge {...LIVE_BADGE[state]} />}
      time={time ? `${time}${compact ? '' : ' local'}` : null}
      timeTitle={unverified ? 'Local (wall-clock) time the stream connected — frame freshness unknown' : 'Local (wall-clock) time of the last frame received'}
      mediaStyle={mediaStyle}
      media={media}
      label={<span title={url.split('?')[0]}>{label}</span>}
      actions={
        <SnapshotButton
          onClick={snapshot}
          disabled={blocked != null}
          compact={compact}
          title={blocked ?? 'Snapshot of the current stream frame (opens a viewer with download)'}
        />
      }
      note={hint}
    />
  );
}

// ── Public component ───────────────────────────────────────────────────────────

export function CameraFeed({ cameraId, height, compact = false, style }: CameraFeedProps) {
  const cam = CAMERA_BY_ID[cameraId];
  const source = useApp((s) => s.cameraSources[cameraId]);
  const [preferSimulated, setPreferSimulated] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const sourceKey = source ? `${source.kind}|${source.url}` : '';
  useEffect(() => setPreferSimulated(false), [sourceKey]);
  const closeSnap = useCallback(() => setSnap(null), []);

  const mediaStyle: CSSProperties = height != null ? { height } : { aspectRatio: '16 / 9' };
  if (!cam)
    return (
      <div className={`feed ${compact ? 'compact' : ''}`} style={style}>
        <div className="feed-media" style={mediaStyle}>
          <Msg icon={VideoOff} title={`Unknown camera ${cameraId}`} text="This camera id is not in the plant's camera list." />
        </div>
      </div>
    );

  return (
    <div className={`feed ${compact ? 'compact' : ''}`} style={style} data-camera={cam.id}>
      {source && !preferSimulated ? (
        <LiveFeed
          key={sourceKey}
          cam={cam}
          source={source}
          compact={compact}
          mediaStyle={mediaStyle}
          onSnapshot={setSnap}
          onShowSimulated={() => setPreferSimulated(true)}
        />
      ) : (
        <SimulatedFeed
          cam={cam}
          compact={compact}
          mediaStyle={mediaStyle}
          onSnapshot={setSnap}
          streamConfigured={!!source}
          onBackToStream={() => setPreferSimulated(false)}
        />
      )}
      {snap && <SnapshotViewer snap={snap} onClose={closeSnap} />}
    </div>
  );
}
