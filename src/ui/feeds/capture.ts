/**
 * Camera-snapshot evidence capture (wired up by src/app/EvidenceCapture.tsx).
 *
 * The event engine records a 'camera-snapshot' evidence item as pending when an event is detected
 * in the live session. The capturer takes them one at a time:
 *  - if the camera has a configured stream that is playing right now, it grabs that frame
 *    (provenance: live camera);
 *  - otherwise it renders the camera's view of the digital twin (provenance stays "rendered from
 *    the digital twin");
 *  - if the twin cannot render within ~10 s, or the render fails, the evidence is marked unavailable
 *    with the reason — nothing is invented.
 * Results for a simulation that was reset meanwhile are dropped (evidence ids restart after a reset).
 */
import type { Evidence } from '../../model/types';
import type { TwinRender } from '../../twin/bridge';

export type CaptureSim = { minute: number; evidence: Evidence[] };

export type CaptureDeps<S extends CaptureSim> = {
  getSim: () => S;
  pending: (s: S) => Evidence[];
  rendererReady: () => boolean;
  renderTwin: (cameraId: string) => Promise<TwinRender | null>;
  /** Frame of a configured stream that is live now, or null (none, not playing, or blocked by CORS). */
  grabLive: (cameraId: string) => TwinRender | null;
  putImage: (key: string, img: TwinRender) => void;
  attach: (evidenceId: string, image: NonNullable<Evidence['image']>, provenance?: Evidence['provenance']) => void;
  unavailable: (evidenceId: string, reason: string) => void;
  now: () => number;
  wait: (ms: number) => Promise<void>;
};

export const READY_TIMEOUT_MS = 10_000;
export const RENDER_TIMEOUT_MS = 8_000;
const POLL_MS = 400;

export const LIVE_PROVENANCE = (cameraId: string): Evidence['provenance'] => ({
  origin: 'live-camera',
  sourceId: cameraId,
  label: 'Frame from the configured camera stream',
});

export function createEvidenceCapturer<S extends CaptureSim>(deps: CaptureDeps<S>, readyTimeoutMs = READY_TIMEOUT_MS) {
  let busy = false;
  let again = false;
  let sim: S | null = null;
  const firstSeen = new Map<string, number>();
  const attempted = new Set<string>();

  const stillPending = (s: S, id: string) => deps.getSim() === s && s.evidence.some((x) => x.id === id && x.status === 'pending');

  async function captureOne(s: S, x: Evidence) {
    const id = x.id;
    const cam = x.cameraId;
    if (!cam) {
      deps.unavailable(id, 'No camera position assigned to this evidence');
      return;
    }
    if (!firstSeen.has(id)) firstSeen.set(id, deps.now());

    const live = deps.grabLive(cam);
    if (live) {
      deps.putImage(id, live);
      deps.attach(id, { key: id, width: live.width, height: live.height, frameTime: s.minute }, LIVE_PROVENANCE(cam));
      return;
    }

    while (!deps.rendererReady()) {
      if (deps.now() - firstSeen.get(id)! >= readyTimeoutMs) {
        if (stillPending(s, id)) deps.unavailable(id, 'The 3D twin was not ready to render within 10 s — no view was captured');
        return;
      }
      await deps.wait(POLL_MS);
      if (!stillPending(s, id)) return;
    }

    let img: TwinRender | null = null;
    let error: string | null = null;
    try {
      // A render that never settles (e.g. a lost WebGL context) must not stall the queue for good.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('render timed out')), RENDER_TIMEOUT_MS);
      });
      try {
        img = await Promise.race([deps.renderTwin(cam), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!stillPending(s, id)) return;
    if (!img) {
      deps.unavailable(id, error ? `Rendering the twin view failed (${error})` : `Rendering the twin view of ${cam} failed`);
      return;
    }
    deps.putImage(id, img);
    // Provenance is left as recorded by the engine: "rendered from the digital twin".
    deps.attach(id, { key: id, width: img.width, height: img.height, frameTime: s.minute });
  }

  /** Processes pending snapshots until none is left; safe to call often (one capture at a time). */
  async function pump(): Promise<void> {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        for (;;) {
          const s = deps.getSim();
          if (s !== sim) {
            sim = s;
            firstSeen.clear();
            attempted.clear();
          }
          const next = deps.pending(s).find((x) => !attempted.has(x.id));
          if (!next) break;
          attempted.add(next.id);
          try {
            await captureOne(s, next);
          } catch (e) {
            if (stillPending(s, next.id)) deps.unavailable(next.id, `Capture failed (${e instanceof Error ? e.message : String(e)})`);
          }
        }
      } while (again);
    } finally {
      busy = false;
    }
  }

  return { pump, get busy() {
    return busy;
  } };
}
