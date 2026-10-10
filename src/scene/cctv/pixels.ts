/**
 * Pixel helpers for the twin renderer (pure, testable).
 */

/**
 * Copies RGBA rows read from WebGL (bottom row first) into image order (top row first) and makes
 * every pixel opaque, so the JPEG never shows transparent overlays as black.
 */
export function flipRowsInto(src: ArrayLike<number> & { subarray(a: number, b: number): ArrayLike<number> }, width: number, height: number, dst: Uint8ClampedArray) {
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * row;
    dst.set(src.subarray(from, from + row), y * row);
  }
  for (let i = 3; i < dst.length; i += 4) dst[i] = 255;
  return dst;
}

/** Render size for a request: whole pixels, even, within [minW, maxW] wide, keeping the requested aspect. */
export function renderSize(width: number, height: number, minW = 160, maxW = 1280) {
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const w = Math.max(minW, Math.min(maxW, Math.round((width > 0 ? width : 640) / 2) * 2));
  const h = Math.max(2, Math.round(w / aspect / 2) * 2);
  return { width: w, height: h };
}
