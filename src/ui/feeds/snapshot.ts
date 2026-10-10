/**
 * Grabbing a still from a configured stream's media element. The frame is drawn to a canvas with a
 * burnt-in "CAMERA FRAME" strip. A stream served without CORS permission taints the canvas: the
 * browser then refuses to export it, which is reported as blocked rather than worked around.
 */
import type { TwinRender } from '../../twin/bridge';
import { cameraStrip, drawStrip } from './overlay';

export type FrameGrab = { ok: true; frame: TwinRender; at: Date } | { ok: false; reason: 'cors' | 'no-frame' | 'error'; message: string };

export const CORS_BLOCKED = "Snapshot blocked by the stream's cross-origin policy";

const isSecurityError = (e: unknown) => e instanceof DOMException && e.name === 'SecurityError';

export function grabFrame(el: HTMLVideoElement | HTMLImageElement, cameraId: string, maxWidth = 960): FrameGrab {
  const srcW = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const srcH = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  if (!srcW || !srcH) return { ok: false, reason: 'no-frame', message: 'No frame received from the stream yet' };
  const scale = Math.min(1, maxWidth / srcW);
  const w = Math.max(2, Math.round(srcW * scale));
  const h = Math.max(2, Math.round(srcH * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return { ok: false, reason: 'error', message: '2D canvas unavailable in this browser' };
  const at = new Date();
  try {
    ctx.drawImage(el, 0, 0, w, h);
    drawStrip(ctx, w, h, cameraStrip(cameraId, at));
    return { ok: true, frame: { dataUrl: c.toDataURL('image/jpeg', 0.85), width: w, height: h }, at };
  } catch (e) {
    if (isSecurityError(e)) return { ok: false, reason: 'cors', message: CORS_BLOCKED };
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : 'The frame could not be read' };
  }
}

/**
 * Small fingerprint of the element's current frame (for MJPEG freshness), or null when the canvas is
 * tainted (no CORS) or no frame is available.
 */
export function frameFingerprint(el: HTMLImageElement, probe: HTMLCanvasElement): number | null {
  if (!el.naturalWidth || !el.naturalHeight) return null;
  probe.width = 24;
  probe.height = 14;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(el, 0, 0, 24, 14);
    const d = ctx.getImageData(0, 0, 24, 14).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ (d[i] + 3 * d[i + 1] + 7 * d[i + 2]), 16777619);
    return h >>> 0;
  } catch {
    return null;
  }
}
