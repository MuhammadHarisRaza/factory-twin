/**
 * Captures pending camera-snapshot evidence for the event records (mounted once in App).
 *
 * For each pending snapshot: a frame from the camera's configured stream when that stream is playing
 * right now (provenance "live camera"), otherwise the camera's view rendered from the digital twin
 * (provenance stays "rendered from the digital twin"). If the twin cannot render within ~10 s or the
 * render fails, the evidence is marked unavailable with the reason. One capture at a time, renders
 * queued and throttled by the twin renderer — the UI is never blocked. See src/ui/feeds/capture.ts.
 */
import { useEffect } from 'react';
import { pendingSnapshots } from '../sim/events';
import { useSim } from '../sim/store';
import { putImage, renderTwinCamera, twinRendererReady } from '../twin/bridge';
import { createEvidenceCapturer } from '../ui/feeds/capture';
import { liveElement } from '../ui/feeds/registry';
import { grabFrame } from '../ui/feeds/snapshot';

/** Size of evidence snapshots (also used by the PDF report). */
const EVIDENCE_SIZE = { width: 960, height: 540 };

export function EvidenceCapture() {
  useEffect(() => {
    const capturer = createEvidenceCapturer({
      getSim: () => useSim.getState().sim,
      pending: pendingSnapshots,
      rendererReady: twinRendererReady,
      renderTwin: (cameraId) => renderTwinCamera(cameraId, EVIDENCE_SIZE),
      grabLive: (cameraId) => {
        const el = liveElement(cameraId);
        if (!el) return null;
        const g = grabFrame(el, cameraId, EVIDENCE_SIZE.width);
        // A CORS-blocked or empty frame falls back to the (labelled) twin render.
        return g.ok ? g.frame : null;
      },
      putImage,
      attach: (id, image, provenance) => useSim.getState().attachImage(id, image, provenance),
      unavailable: (id, reason) => useSim.getState().evidenceUnavailable(id, reason),
      now: () => performance.now(),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    const kick = () => {
      void capturer.pump();
    };
    kick();
    const unsubscribe = useSim.subscribe((st, prev) => {
      if (st.version !== prev.version || st.sim !== prev.sim) kick();
    });
    return unsubscribe;
  }, []);
  return null;
}
