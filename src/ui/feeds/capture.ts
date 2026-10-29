/**
 * Camera-snapshot evidence capture (wired up by src/app/EvidenceCapture.tsx).
 *
 * The event engine records a 'camera-snapshot' evidence item as pending when an event is detected
 * in the live session. The capturer takes them one at a time:
 *  - if the camera has a configured stream that is playing right now, it grabs that frame
 *    (provenance: live camera);
 *  - otherwise the evidence is marked unavailable with the reason — no stand-in image (such as a
 *    render of the 3D twin) is made, nothing is invented.
 * Results for a simulation that was reset meanwhile are dropped (evidence ids restart after a reset).
 */
import type { Evidence } from '../../model/types';
import type { TwinRender } from '../../twin/bridge';

export type CaptureSim = { minute: number; evidence: Evidence[] };

export type CaptureDeps<S extends CaptureSim> = {
  getSim: () => S;
  pending: (s: S) => Evidence[];
  /** Frame of a configured stream that is live now, or null (none, not playing, or blocked by CORS). */
  grabLive: (cameraId: string) => TwinRender | null;
  putImage: (key: string, img: TwinRender) => void;
  attach: (evidenceId: string, image: NonNullable<Evidence['image']>, provenance?: Evidence['provenance']) => void;
  unavailable: (evidenceId: string, reason: string) => void;
};

export const LIVE_PROVENANCE = (cameraId: string): Evidence['provenance'] => ({
  origin: 'live-camera',
  sourceId: cameraId,
  label: 'Frame from the configured camera stream',
});

export function createEvidenceCapturer<S extends CaptureSim>(deps: CaptureDeps<S>) {
  let busy = false;
  let again = false;
  let sim: S | null = null;
  const attempted = new Set<string>();

  const stillPending = (s: S, id: string) => deps.getSim() === s && s.evidence.some((x) => x.id === id && x.status === 'pending');

  async function captureOne(s: S, x: Evidence) {
    const id = x.id;
    const cam = x.cameraId;
    if (!cam) {
      deps.unavailable(id, 'No camera position assigned to this evidence');
      return;
    }
    const live = deps.grabLive(cam);
    if (live) {
      deps.putImage(id, live);
      deps.attach(id, { key: id, width: live.width, height: live.height, frameTime: s.minute }, LIVE_PROVENANCE(cam));
      return;
    }

    deps.unavailable(id, `No camera stream was playing for ${cam} when the event was detected — no image was captured`);
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
