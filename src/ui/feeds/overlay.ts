/**
 * Burnt-in labels drawn onto every image the feeds produce, so a copied or downloaded image stays
 * labelled: frames grabbed from a configured stream read "CAMERA FRAME · <camera> · <local time>".
 */
import { toMs } from '../../sim/time';

const pad = (n: number) => String(n).padStart(2, '0');
/** Local wall-clock date-time, e.g. "2026-10-11 14:32:05". */
export const localStamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export const cameraStrip = (cameraId: string, at: Date) => ({
  left: `CAMERA FRAME · ${cameraId} · ${localStamp(at)} local time`,
  right: 'Configured stream',
});

/** Font size (image pixels) of the strip for an image of this height. */
export const stripFontPx = (height: number) => Math.max(11, Math.min(26, Math.round(height * 0.042)));

/** File name for a downloaded snapshot, e.g. "CAM-E1_simulated-view_20261012-104213.jpg". */
export function snapshotFileName(cameraId: string, origin: 'simulated' | 'live', at: { plantMinute?: number; date?: Date }) {
  let stamp: string;
  if (origin === 'simulated' && at.plantMinute != null) {
    const iso = new Date(toMs(at.plantMinute)).toISOString(); // plant time encoded as UTC
    stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  } else {
    const d = at.date ?? new Date();
    stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  return `${cameraId}_${origin === 'simulated' ? 'simulated-view' : 'camera-frame'}_${stamp}.jpg`;
}

/** Draws the label strip along the bottom of an image (right-hand text only when it fits). */
export function drawStrip(ctx: CanvasRenderingContext2D, width: number, height: number, text: { left: string; right?: string }) {
  const fs = stripFontPx(height);
  const h = Math.round(fs * 1.9);
  const padX = Math.round(fs * 0.7);
  ctx.save();
  ctx.fillStyle = 'rgba(10, 13, 16, 0.78)';
  ctx.fillRect(0, height - h, width, h);
  ctx.fillStyle = '#fab219';
  ctx.fillRect(0, height - h, Math.max(3, Math.round(fs * 0.25)), h);
  ctx.font = `600 ${fs}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e7ebee';
  const y = height - h / 2;
  let left = text.left;
  const maxLeft = width - padX * 2;
  while (left.length > 8 && ctx.measureText(left).width > maxLeft) left = `${left.slice(0, -2).trimEnd()}…`;
  ctx.textAlign = 'left';
  ctx.fillText(left, padX, y);
  if (text.right) {
    ctx.font = `${fs}px "IBM Plex Sans", system-ui, sans-serif`;
    const lw = ctx.measureText(left).width;
    const rw = ctx.measureText(text.right).width;
    if (padX * 3 + lw + rw <= width) {
      ctx.fillStyle = '#a9b3bc';
      ctx.textAlign = 'right';
      ctx.fillText(text.right, width - padX, y);
    }
  }
  ctx.restore();
}
