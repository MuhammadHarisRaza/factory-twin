/**
 * Deterministic geometry for an illustrative inspection frame: the tile outline, its
 * placement on the roller conveyor and the painted defect, all derived from the frame id
 * (so a frame always looks the same) and the record's box / measurement. Units are tile
 * coordinates: 0–1000 across the 600 mm tile.
 */
import type { DefectCategory, QualityInspection } from '../../model/types';
import { hashString, mulberry32, type Rng } from '../../sim/rng';
import type { Frame } from './frames';

export const TILE = 1000;
/** Tile units per millimetre (60 × 60 cm format). */
export const UNITS_PER_MM = TILE / 600;

export type Surface = 'beige' | 'grey' | 'wood';
export const SURFACES: Record<Surface, { base: string; label: string }> = {
  beige: { base: '#d0bf9f', label: 'Beige matt' },
  grey: { base: '#8c9194', label: 'Grey polished' },
  wood: { base: '#a2754d', label: 'Wood-look satin' },
};
export const surfaceOf = (sku: string): Surface => (sku.includes('-GRY-') ? 'grey' : sku.includes('-WOD-') ? 'wood' : 'beige');

export type Pt = [number, number];
export type Box = { x: number; y: number; w: number; h: number };
/** TL, TR, BR, BL — clockwise on screen (y down). */
export type Corner = 0 | 1 | 2 | 3;

export type DefectPaint =
  | { kind: 'crack'; main: string; core: string; branches: string[] }
  | { kind: 'chip'; corner: Corner; brk: string; inner: string }
  | { kind: 'surface'; holes: { x: number; y: number; r: number }[] }
  | { kind: 'glaze'; blob: string; core: string; thicker: boolean; strength: number }
  | { kind: 'shade'; blob: string; blur: number; strength: number; warm: boolean }
  | { kind: 'planarity'; lines: string[]; nominal: string[]; value: string; at: Pt }
  | { kind: 'dimension'; y0: number; y1: number; offset: number; edge: string; value: string };

export type TileGeometry = {
  /** Seed for the procedural surface texture. */
  seed: number;
  surface: Surface;
  base: string;
  /** Placement on the conveyor (degrees, frame units). */
  rot: number;
  dx: number;
  dy: number;
  outline: string;
  defect: DefectPaint | null;
  box: Box | null;
};

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const pt = (p: Pt) => `${f1(p[0])} ${f1(p[1])}`;
const polyline = (pts: Pt[]) => `M${pts.map(pt).join(' L')}`;
const polygon = (pts: Pt[]) => `${polyline(pts)} Z`;
const between = (r: Rng, a: number, b: number) => a + (b - a) * r();
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Plateau 1 with smooth shoulders over the first / last 22 %. */
const bump = (t: number) => (t <= 0 || t >= 1 ? 0 : t < 0.22 ? smooth(t / 0.22) : t > 0.78 ? smooth((1 - t) / 0.22) : 1);

/** Closed Catmull-Rom spline through the points. */
export function closedSpline(pts: Pt[]) {
  const n = pts.length;
  let d = `M${pt(pts[0])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return `${d} Z`;
}

function mixHex(hex: string, toward: '#000000' | '#ffffff', amt: number) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(toward.slice(1), 16);
  const ch = (v: number, sh: number) => (v >> sh) & 255;
  const m = (sh: number) => Math.round(ch(a, sh) + (ch(b, sh) - ch(a, sh)) * amt);
  return `#${((m(16) << 16) | (m(8) << 8) | m(0)).toString(16).padStart(6, '0')}`;
}

// ── Measurement parsing (records carry an illustrative text measurement) ─────

const num = (m: RegExpMatchArray | null, i = 1) => (m ? Number(m[i]) : NaN);
const signOf = (s: string | undefined) => (s === '−' || s === '-' ? -1 : 1);

export function parseMeasurement(defect: DefectCategory, text: string | null): { count?: number; sign?: number; value?: number } {
  const t = text ?? '';
  switch (defect) {
    case 'surface': {
      const n = num(t.match(/(\d+)\s*pinholes/));
      return { count: Number.isFinite(n) ? clamp(Math.round(n), 1, 14) : 5 };
    }
    case 'glaze': {
      const m = t.match(/deviation\s*([+−-])\s*([\d.]+)/);
      return { sign: signOf(m?.[1]), value: Number.isFinite(num(m, 2)) ? num(m, 2) : 6 };
    }
    case 'shade': {
      const v = num(t.match(/ΔE\s*([\d.]+)/));
      return { value: Number.isFinite(v) ? v : 1.6 };
    }
    case 'planarity': {
      const m = t.match(/deviation\s*([+−-])\s*([\d.]+)/);
      return { sign: signOf(m?.[1]), value: Number.isFinite(num(m, 2)) ? num(m, 2) : 0.55 };
    }
    case 'dimension': {
      const v = num(t.match(/Caliber\s*([\d.]+)/));
      const dev = Number.isFinite(v) ? v - 600 : 0.8;
      return { sign: dev < 0 ? -1 : 1, value: Math.abs(dev) };
    }
    default:
      return {};
  }
}

// ── Outline ───────────────────────────────────────────────────────────────────

const CORNERS: Pt[] = [
  [0, 0],
  [TILE, 0],
  [TILE, TILE],
  [0, TILE],
];
/** Outward normal of edge i (corner i → corner i+1). */
const NORMALS: Pt[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

type OutlineOpts = {
  /** Outward bow of every edge at its midpoint (warp). */
  bow?: number;
  /** Outward offset of a stretch of the left edge (caliber). */
  leftBump?: { y0: number; y1: number; offset: number };
  chip?: { corner: Corner; s1: number; s2: number; brk: Pt[] };
};

export function outlinePoints(o: OutlineOpts): Pt[] {
  const K = 40;
  const pts: Pt[] = [];
  for (let e = 0; e < 4; e++) {
    const [ax, ay] = CORNERS[e];
    const [bx, by] = CORNERS[(e + 1) % 4];
    const [nx, ny] = NORMALS[e];
    for (let i = 0; i < K; i++) {
      const u = i / K;
      const x = ax + (bx - ax) * u;
      const y = ay + (by - ay) * u;
      let d = (o.bow ?? 0) * 4 * u * (1 - u);
      if (e === 3 && o.leftBump) d += o.leftBump.offset * bump((y - o.leftBump.y0) / (o.leftBump.y1 - o.leftBump.y0));
      pts.push([x + nx * d, y + ny * d]);
    }
  }
  if (!o.chip) return pts;

  // Replace the chipped corner by the break line.
  const { corner, s1, s2, brk } = o.chip;
  const C = CORNERS[corner];
  const a = edgeDir(corner, -1);
  const b = edgeDir(corner, 1);
  const inChip = (p: Pt) => {
    const vx = p[0] - C[0];
    const vy = p[1] - C[1];
    const al = vx * a[0] + vy * a[1];
    const be = vx * b[0] + vy * b[1];
    return al > -1 && be > -1 && al < s1 && be < s2;
  };
  const n = pts.length;
  const rm = pts.map(inChip);
  const start = rm.findIndex((v, i) => v && !rm[(i - 1 + n) % n]);
  if (start < 0) return pts;
  const rest: Pt[] = [];
  for (let j = 0; j < n; j++) {
    const k = (start + j) % n;
    if (!rm[k]) rest.push(pts[k]);
  }
  return [...brk, ...rest];
}

/** Unit vector from a corner along its incoming (−1, towards the previous corner) or outgoing (+1) edge. */
function edgeDir(corner: Corner, dir: -1 | 1): Pt {
  const C = CORNERS[corner];
  const O = CORNERS[(corner + (dir > 0 ? 1 : 3)) % 4];
  return [(O[0] - C[0]) / TILE, (O[1] - C[1]) / TILE];
}

// ── Defect painters ───────────────────────────────────────────────────────────

/** Meandering fissure: a heading-persistent walk down the box, with one or two side branches. */
function walk(r: Rng, b: Box, start: Pt, heading: number, step: number, maxSteps: number, spread: number, until: (p: Pt) => boolean): Pt[] {
  const minX = b.x + b.w * 0.06;
  const maxX = b.x + b.w * 0.94;
  const maxY = b.y + b.h * 0.97;
  const margin = b.w * 0.18;
  let [x, y] = start;
  let th = heading;
  const pts: Pt[] = [[x, y]];
  for (let i = 0; i < maxSteps && !until([x, y]); i++) {
    th += (r() - 0.5) * 0.6;
    // Steer gently away from the box sides instead of bouncing off them.
    if (x < minX + margin) th -= 0.22 * (1 - (x - minX) / margin);
    if (x > maxX - margin) th += 0.22 * (1 - (maxX - x) / margin);
    th = clamp(th, Math.PI / 2 - spread, Math.PI / 2 + spread);
    x = clamp(x + Math.cos(th) * step, minX, maxX);
    y = Math.min(maxY, y + Math.sin(th) * step);
    pts.push([x + (r() - 0.5) * 2.4, y]);
  }
  return pts;
}

function crack(r: Rng, b: Box): DefectPaint {
  const step = Math.max(6, b.h / 30);
  const bottom = b.y + b.h * 0.95;
  // Narrow boxes keep the fissure closer to vertical.
  const spread = clamp(Math.atan2(b.w, b.h) * 1.5, 0.35, 1.0);
  const main = walk(r, b, [b.x + b.w * between(r, 0.3, 0.7), b.y + b.h * 0.04], Math.PI / 2 + (r() - 0.5) * spread, step, 160, spread, (p) => p[1] >= bottom);
  const n = main.length;
  const core = main.slice(Math.floor(n * 0.18), Math.ceil(n * 0.82));
  const branches: string[] = [];
  const nb = 1 + Math.floor(r() * 2);
  for (let k = 0; k < nb && n > 8; k++) {
    const from = main[Math.floor(n * between(r, 0.25, 0.7))];
    const side = r() > 0.5 ? 1 : -1;
    const br = walk(r, b, from, Math.PI / 2 - side * between(r, 0.6, 1.0), step * 0.8, 5 + Math.floor(r() * 6), 1.1, () => false);
    branches.push(polyline(br));
  }
  return { kind: 'crack', main: polyline(main), core: polyline(core.length > 1 ? core : main), branches };
}

function chipCorner(b: Box): Corner {
  const left = b.x + b.w / 2 < TILE / 2;
  const top = b.y + b.h / 2 < TILE / 2;
  return top ? (left ? 0 : 1) : left ? 3 : 2;
}

function chipBreak(r: Rng, corner: Corner, s1: number, s2: number): Pt[] {
  const C = CORNERS[corner];
  const a = edgeDir(corner, -1);
  const b = edgeDir(corner, 1);
  const inward: Pt = [(a[0] + b[0]) / Math.SQRT2, (a[1] + b[1]) / Math.SQRT2];
  const m = Math.min(s1, s2);
  const out: Pt[] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const j = i === 0 || i === N ? 0 : m * (0.2 * Math.sin(Math.PI * u) + (r() - 0.5) * 0.12);
    out.push([C[0] + a[0] * s1 * (1 - u) + b[0] * s2 * u + inward[0] * j, C[1] + a[1] * s1 * (1 - u) + b[1] * s2 * u + inward[1] * j]);
  }
  return out;
}

function blobPoints(r: Rng, cx: number, cy: number, rx: number, ry: number, n = 9): Pt[] {
  const pts: Pt[] = [];
  const phase = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const k = between(r, 0.72, 1.04);
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pts;
}

/** Planarity: laser profile lines bowed by the (exaggerated) centre deviation. */
function planarity(sign: number, value: number) {
  const A = sign * (16 + value * 30);
  const lines: string[] = [];
  const nominal: string[] = [];
  for (const [y0, w] of [
    [200, 0.55],
    [500, 1],
    [800, 0.55],
  ] as const) {
    lines.push(`M-20 ${y0} Q500 ${f1(y0 - 2 * A * w)} 1020 ${y0}`);
    nominal.push(`M0 ${y0} L1000 ${y0}`);
  }
  lines.push(`M500 -20 Q${f1(500 + 1.6 * A)} 500 500 1020`);
  nominal.push('M500 0 L500 1000');
  return { lines, nominal, at: [520, 500 - A - 18 * Math.sign(A || 1)] as Pt };
}

const fmtSigned = (sign: number, v: number, digits: number) => `${sign < 0 ? '−' : '+'}${v.toFixed(digits)} mm`;

// ── Assembly ──────────────────────────────────────────────────────────────────

export function tileGeometry(frame: Pick<Frame, 'id' | 'sku' | 'rec'>): TileGeometry {
  const r = mulberry32(hashString(`frame:${frame.id}`));
  const surface = surfaceOf(frame.sku);
  const tint = r();
  const base = mixHex(SURFACES[surface].base, tint < 0.5 ? '#000000' : '#ffffff', r() * 0.05);
  const geo: TileGeometry = {
    seed: Math.floor(r() * 9999) + 1,
    surface,
    base,
    rot: (r() - 0.5) * 1.4,
    dx: (r() - 0.5) * 70,
    dy: (r() - 0.5) * 14,
    outline: '',
    defect: null,
    box: null,
  };
  const rec: QualityInspection | null = frame.rec;
  const opts: OutlineOpts = {};
  if (rec?.result === 'reject' && rec.defect) {
    const rb = rec.box ?? { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    const b: Box = { x: rb.x * TILE, y: rb.y * TILE, w: rb.w * TILE, h: rb.h * TILE };
    geo.box = rec.box ? b : null;
    const m = parseMeasurement(rec.defect, rec.measurement);
    switch (rec.defect) {
      case 'crack':
        geo.defect = crack(r, b);
        break;
      case 'chip': {
        const corner = chipCorner(b);
        const s1 = b.w * between(r, 0.55, 0.85);
        const s2 = b.h * between(r, 0.55, 0.85);
        const brk = chipBreak(r, corner, s1, s2);
        opts.chip = { corner, s1, s2, brk };
        // Inner edge of the exposed body band, shifted into the tile.
        const a = edgeDir(corner, -1);
        const bb = edgeDir(corner, 1);
        const sh = 9 / Math.SQRT2;
        const inner = brk.map(([x, y]): Pt => [x + (a[0] + bb[0]) * sh, y + (a[1] + bb[1]) * sh]);
        geo.defect = { kind: 'chip', corner, brk: polyline(brk), inner: polyline(inner) };
        break;
      }
      case 'surface': {
        const holes = Array.from({ length: m.count ?? 5 }, () => ({
          x: b.x + b.w * between(r, 0.14, 0.86),
          y: b.y + b.h * between(r, 0.14, 0.86),
          r: between(r, 6, 11),
        }));
        geo.defect = { kind: 'surface', holes };
        break;
      }
      case 'glaze': {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const pts = blobPoints(r, cx, cy, (b.w / 2) * 0.86, (b.h / 2) * 0.86);
        const core = pts.map(([x, y]): Pt => [cx + (x - cx) * 0.55, cy + (y - cy) * 0.5]);
        geo.defect = { kind: 'glaze', blob: closedSpline(pts), core: closedSpline(core), thicker: (m.sign ?? 1) > 0, strength: clamp(0.2 + (m.value ?? 6) * 0.013, 0.2, 0.36) };
        break;
      }
      case 'shade': {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        geo.defect = {
          kind: 'shade',
          blob: closedSpline(blobPoints(r, cx, cy, (b.w / 2) * 0.82, (b.h / 2) * 0.82, 8)),
          blur: Math.max(10, Math.min(b.w, b.h) * 0.08),
          strength: clamp(0.14 + (m.value ?? 1.6) * 0.07, 0.2, 0.34),
          warm: r() > 0.45,
        };
        break;
      }
      case 'planarity': {
        const sign = m.sign ?? 1;
        const p = planarity(sign, m.value ?? 0.55);
        opts.bow = sign * 7;
        geo.defect = { kind: 'planarity', ...p, value: fmtSigned(sign, m.value ?? 0.55, 2) };
        break;
      }
      case 'dimension': {
        const sign = m.sign ?? 1;
        const offset = sign * (9 + (m.value ?? 0.8) * 18);
        const y0 = b.y;
        const y1 = b.y + b.h;
        opts.leftBump = { y0, y1, offset };
        const edge: Pt[] = [];
        for (let i = 0; i <= 24; i++) {
          const y = y0 + ((y1 - y0) * i) / 24;
          edge.push([-offset * bump((y - y0) / (y1 - y0)), y]);
        }
        geo.defect = { kind: 'dimension', y0, y1, offset, edge: polyline(edge), value: fmtSigned(sign, m.value ?? 0.8, 1) };
        break;
      }
    }
  }
  geo.outline = polygon(outlinePoints(opts));
  return geo;
}

// ── Frame-space helpers (main viewer) ─────────────────────────────────────────

export const FRAME_W = 1600;
export const FRAME_H = 1000;
/** Tile edge in frame units. */
export const TILE_PX = 860;
export const TILE_SCALE = TILE_PX / TILE;
export const TILE_X = (FRAME_W - TILE_PX) / 2;
export const TILE_Y = (FRAME_H - TILE_PX) / 2;

export const tileTransform = (g: TileGeometry) =>
  `translate(${f1(TILE_X + g.dx)} ${f1(TILE_Y + g.dy)}) rotate(${g.rot.toFixed(3)} ${TILE_PX / 2} ${TILE_PX / 2}) scale(${TILE_SCALE})`;

/** Map a tile-coordinate point into frame coordinates. */
export function toFrame(g: TileGeometry, x: number, y: number): Pt {
  const px = x * TILE_SCALE - TILE_PX / 2;
  const py = y * TILE_SCALE - TILE_PX / 2;
  const a = (g.rot * Math.PI) / 180;
  return [TILE_X + g.dx + TILE_PX / 2 + px * Math.cos(a) - py * Math.sin(a), TILE_Y + g.dy + TILE_PX / 2 + px * Math.sin(a) + py * Math.cos(a)];
}

/** Zoom that centres the defect box in the frame. */
export function zoomOnBox(g: TileGeometry): { k: number; tx: number; ty: number } | null {
  if (!g.box) return null;
  const [cx, cy] = toFrame(g, g.box.x + g.box.w / 2, g.box.y + g.box.h / 2);
  const bw = Math.max(40, g.box.w * TILE_SCALE);
  const bh = Math.max(40, g.box.h * TILE_SCALE);
  const k = clamp(0.62 * Math.min(FRAME_W / bw, FRAME_H / bh), 1.25, 3.4);
  return { k, tx: FRAME_W / 2 - k * cx, ty: FRAME_H / 2 - k * cy };
}

/** A round scale-bar length (mm) that fits the frame at zoom k, and its length in frame units. */
export function scaleBar(k: number) {
  const perMm = UNITS_PER_MM * TILE_SCALE * k;
  const mm = [200, 100, 50, 20, 10, 5].find((v) => v * perMm <= 230) ?? 5;
  return { mm, len: mm * perMm };
}

// ── Stills (record detail and raster export) ──────────────────────────────────

export type StillView = {
  /** Square view box in frame units. */
  x: number;
  y: number;
  side: number;
  /** Axis-aligned bounds of the detection box in frame units (null when the record has no box). */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
};

/** Square view of the whole tile, or a square crop around the detection box. */
export function stillView(g: TileGeometry, crop: boolean): StillView {
  const full = TILE_PX * 1.1;
  const cx0 = TILE_X + g.dx + TILE_PX / 2;
  const cy0 = TILE_Y + g.dy + TILE_PX / 2;
  let box: StillView['box'] = null;
  if (g.box) {
    const b = g.box;
    const pts = [toFrame(g, b.x, b.y), toFrame(g, b.x + b.w, b.y), toFrame(g, b.x + b.w, b.y + b.h), toFrame(g, b.x, b.y + b.h)];
    box = {
      x0: Math.min(...pts.map((p) => p[0])),
      y0: Math.min(...pts.map((p) => p[1])),
      x1: Math.max(...pts.map((p) => p[0])),
      y1: Math.max(...pts.map((p) => p[1])),
    };
  }
  if (!crop || !box) return { x: cx0 - full / 2, y: cy0 - full / 2, side: full, box };
  const side = clamp(Math.max(box.x1 - box.x0, box.y1 - box.y0) * 1.5 + 60, 200, full);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return { x: cx - side / 2, y: cy - side / 2, side, box };
}

/** A round scale-bar length (mm) of at most `maxShare` of a still's side, and its length in frame units. */
export function stillScaleBar(side: number, maxShare = 0.3) {
  const perMm = UNITS_PER_MM * TILE_SCALE;
  const mm = [200, 100, 50, 20, 10, 5].find((v) => v * perMm <= side * maxShare) ?? 5;
  return { mm, len: mm * perMm };
}

/** Detection box in millimetres on the 600 mm tile (records carry it in 0–1 tile coordinates). */
export function boxMm(b: { x: number; y: number; w: number; h: number }) {
  const mm = (v: number) => Math.round(v * 600);
  return { x: mm(b.x), y: mm(b.y), w: mm(b.w), h: mm(b.h) };
}
