/**
 * Plant time at which a twin render was taken (the moment burnt into its label), keyed by the
 * render object returned through src/twin/bridge.ts — the feed header shows exactly that time.
 */
const times = new WeakMap<object, number>();

export const tagFrameTime = (frame: object, plantMinute: number) => {
  times.set(frame, plantMinute);
};
export const frameTimeOf = (frame: object | null | undefined) => (frame ? (times.get(frame) ?? null) : null);

/**
 * Twin render size for a feed's media box: the box's aspect ratio (so nothing — including the
 * burnt-in label — is cropped), at up to 1.5× device pixels, 320–960 px wide in steps of 32 px
 * (few distinct sizes → render targets are reused).
 */
export function feedRenderSize(boxWidth: number, boxHeight: number, dpr = 1) {
  const w = boxWidth > 0 ? boxWidth : 640;
  const h = boxHeight > 0 ? boxHeight : Math.round((w * 9) / 16);
  const scale = Math.min(1.5, Math.max(1, dpr || 1));
  const width = Math.min(960, Math.max(320, Math.ceil((w * scale) / 32) * 32));
  return { width, height: Math.max(90, Math.round((width * h) / w)) };
}
