/**
 * Page geometry and pagination maths for the A4 PDF reports (millimetres, origin top-left).
 * Pure functions — the renderer (render.ts) asks these where things go.
 */

export const A4 = { w: 210, h: 297 } as const;

export type Layout = {
  /** Left / right margins. */
  ml: number;
  mr: number;
  /** Header band height (drawn on every page). */
  headerH: number;
  /** First content line below the header band. */
  top: number;
  /** Last usable content y (the footer sits below it). */
  bottom: number;
  /** Footer rule y. */
  footerY: number;
};

export const LAYOUT: Layout = { ml: 14, mr: 14, headerH: 21, top: 29, bottom: 278, footerY: 282 };

export const contentWidth = (L: Layout = LAYOUT) => A4.w - L.ml - L.mr;
export const contentHeight = (L: Layout = LAYOUT) => L.bottom - L.top;

/** Line height in mm for a font size in pt (jsPDF default line-height factor ≈ 1.15; we use a looser 1.3). */
export const lineHeightMm = (pt: number, factor = 1.3) => pt * 0.3528 * factor;

/** Scales a w × h box to fit inside maxW × maxH, keeping its aspect ratio (never upscales beyond the box). */
export function fitBox(w: number, h: number, maxW: number, maxH: number) {
  if (!(w > 0 && h > 0)) return { w: maxW, h: Math.min(maxH, maxW * 0.5625) };
  const k = Math.min(maxW / w, maxH / h);
  return { w: w * k, h: h * k };
}

/**
 * Where a block of height `need` goes: at `y` on the current page when it fits, otherwise at the top
 * of a new page. A block taller than a whole page still starts on a fresh page (callers split it).
 */
export function placeBlock(y: number, need: number, L: Layout = LAYOUT): { y: number; newPage: boolean } {
  if (y + need <= L.bottom + 1e-6) return { y, newPage: false };
  if (y <= L.top + 1e-6) return { y, newPage: false };
  return { y: L.top, newPage: true };
}

/**
 * Splits `count` lines of height `lineH` starting at `y` into per-page chunks.
 * Returns chunks with the page offset (0 = current page), the start y and the line index range [from, to).
 */
export function splitLines(count: number, lineH: number, y: number, L: Layout = LAYOUT) {
  const chunks: { page: number; y: number; from: number; to: number }[] = [];
  let page = 0;
  let cur = y;
  let i = 0;
  while (i < count) {
    const fit = Math.floor((L.bottom - cur) / lineH + 1e-6);
    if (fit <= 0) {
      page++;
      cur = L.top;
      continue;
    }
    const to = Math.min(count, i + fit);
    chunks.push({ page, y: cur, from: i, to });
    cur += (to - i) * lineH;
    i = to;
    if (i < count) {
      page++;
      cur = L.top;
    }
  }
  return { chunks, endY: cur, pages: page };
}

export const pageLabel = (n: number, total: number) => `Page ${n} of ${total}`;

/** "Nice" axis ticks from `min` to at least `max`. */
export function niceTicks(min: number, max: number, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (max <= min) max = min + (Math.abs(min) || 1);
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw - 1e-12) ?? 10 * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

/** Value range of a chart: from 0 (or the lowest negative value) to the highest value or limit. */
export function chartRange(values: (number | null)[][], limit?: number | null) {
  const all = values.flat().filter((v): v is number => v != null && Number.isFinite(v));
  if (limit != null && Number.isFinite(limit)) all.push(limit);
  if (!all.length) return null;
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all);
  return niceTicks(lo, hi > lo ? hi : lo + 1);
}

/** Indices of x-axis labels to print (first, evenly spaced, last) for `n` points. */
export function labelIndices(n: number, max = 4) {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let k = 0; k < max; k++) out.add(Math.round((k * (n - 1)) / (max - 1)));
  return [...out].sort((a, b) => a - b);
}

/** Cell width for `cols` columns across `width` with `gap` between them. */
export const columnWidth = (width: number, cols: number, gap: number) => (width - gap * (cols - 1)) / Math.max(1, cols);
