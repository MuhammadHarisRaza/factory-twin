/**
 * Captures pending camera-snapshot evidence for the event records (mounted once in App).
 *
 * For each pending snapshot: a frame from the camera's configured stream when that stream is playing
 * right now (provenance "live camera"); otherwise the evidence is marked unavailable with the reason.
 * Nothing is rendered from the 3D twin as a stand-in. See src/ui/feeds/capture.ts.
 */
import { useEffect } from 'react';
import { pendingSnapshots } from '../sim/events';
import { useSim } from '../sim/store';
import { putImage, retainImagesFor } from '../twin/bridge';
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
      grabLive: (cameraId) => {
        const el = liveElement(cameraId);
        if (!el) return null;
        const g = grabFrame(el, cameraId, EVIDENCE_SIZE.width);
        // A CORS-blocked or empty frame: no image (the evidence is marked unavailable).
        return g.ok ? g.frame : null;
      },
      putImage,
      attach: (id, image, provenance) => useSim.getState().attachImage(id, image, provenance),
      unavailable: (id, reason) => useSim.getState().evidenceUnavailable(id, reason),
    });
    const kick = () => {
      void capturer.pump();
    };
    kick();
    const unsubscribe = useSim.subscribe((st, prev) => {
      if (st.version !== prev.version || st.sim !== prev.sim) {
        // Images of evidence pruned from the history are released (a no-op while the array is unchanged).
        retainImagesFor(st.sim.evidence);
        kick();
      }
    });
    return unsubscribe;
  }, []);
  return null;
}
