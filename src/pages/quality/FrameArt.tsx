/**
 * SVG rendering of an illustrative inspection frame: a procedural tile surface for the
 * batch product, the painted defect, gauge overlays and the simulated detection box.
 * This is a drawing of a simulated record — no image is captured or classified.
 *
 * FrameStill is the evidence image (rasterised through src/twin/inspectionImage.ts for the
 * Quality workspace, the in-app report and the PDF); FrameThumb is the small chooser image of a
 * record in an event's record strip.
 */
import { memo, useId, useMemo } from 'react';
import { DEFECTS } from '../../model/plant';
import type { QualityInspection } from '../../model/types';
import type { Frame } from './frames';
import { TILE, stillScaleBar, stillView, tileGeometry, tileTransform, type Box, type DefectPaint, type TileGeometry } from './tileGeometry';

const SEV_COLOR: Record<NonNullable<QualityInspection['severity']>, string> = {
  minor: 'var(--warning)',
  major: 'var(--serious)',
  critical: 'var(--critical)',
};
export const severityColor = (sev: QualityInspection['severity']) => (sev ? SEV_COLOR[sev] : 'var(--serious)');

/** Short class names used on boxes and thumbnails. */
export const DEFECT_SHORT: Record<keyof typeof DEFECTS, string> = {
  crack: 'Crack',
  chip: 'Chip',
  surface: 'Pinholes',
  glaze: 'Glaze',
  shade: 'Shade',
  planarity: 'Planarity',
  dimension: 'Caliber',
};

/**
 * Text drawn on the detection box: the tunnel's class and simulated confidence ("sim" — no model
 * produced it), or "gauge" for a gauge result, which is a measurement out of tolerance, not a
 * classification with a confidence.
 */
export const detectionLabel = (rec: QualityInspection | null) => {
  if (!rec?.defect) return '';
  if (rec.stationId !== 'ST-VIS') return `${DEFECT_SHORT[rec.defect]} · gauge`;
  return `${DEFECT_SHORT[rec.defect]}${rec.confidence != null ? ` ${(rec.confidence * 100).toFixed(1)}% sim` : ''}`;
};

const useUid = () => `q${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
const REGION = { x: -60, y: -60, width: TILE + 120, height: TILE + 120, filterUnits: 'userSpaceOnUse', colorInterpolationFilters: 'sRGB' } as const;

/** Procedural surface textures (seeded turbulence) for the three products. */
function SurfaceDefs({ uid, g }: { uid: string; g: TileGeometry }) {
  switch (g.surface) {
    case 'beige':
      return (
        <>
          <filter id={`${uid}-ta`} {...REGION}>
            <feTurbulence type="fractalNoise" baseFrequency="0.0055" numOctaves={3} seed={g.seed} />
            <feColorMatrix type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.33  0 0 0 0 0.22  0.62 0 0 0 -0.24" />
          </filter>
          <filter id={`${uid}-tb`} {...REGION}>
            <feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves={2} seed={g.seed + 7} result="n" />
            <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.34  0 0 0 0 0.26  0 0 0 0 0.18  5 0 0 0 -3.4" result="d" />
            <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.98  0 0 0 0 0.95  0 0 0 0 0.9  0 5 0 0 -3.45" result="l" />
            <feMerge>
              <feMergeNode in="d" />
              <feMergeNode in="l" />
            </feMerge>
          </filter>
        </>
      );
    case 'grey':
      return (
        <>
          <filter id={`${uid}-ta`} {...REGION}>
            <feTurbulence type="fractalNoise" baseFrequency="0.0035" numOctaves={4} seed={g.seed} />
            <feColorMatrix type="matrix" values="0 0 0 0 0.3  0 0 0 0 0.32  0 0 0 0 0.34  0.9 0 0 0 -0.32" />
          </filter>
          <filter id={`${uid}-tb`} {...REGION}>
            <feTurbulence type="turbulence" baseFrequency="0.0028 0.006" numOctaves={3} seed={g.seed + 3} />
            <feColorMatrix type="matrix" values="0 0 0 0 0.9  0 0 0 0 0.91  0 0 0 0 0.92  -7 0 0 0 0.62" />
          </filter>
          <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.36" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.47" stopColor="#fff" stopOpacity="0.16" />
            <stop offset="0.52" stopColor="#fff" stopOpacity="0.07" />
            <stop offset="0.64" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </>
      );
    case 'wood':
      return (
        <>
          <filter id={`${uid}-ta`} {...REGION}>
            <feTurbulence type="fractalNoise" baseFrequency="0.0016 0.021" numOctaves={3} seed={g.seed} />
            <feColorMatrix type="matrix" values="0 0 0 0 0.33  0 0 0 0 0.19  0 0 0 0 0.08  1 0 0 0 0" />
            <feComponentTransfer>
              <feFuncA type="table" tableValues="0 0.38 0 0.36 0 0.4 0.04 0.38 0 0.36 0 0.38 0" />
            </feComponentTransfer>
          </filter>
          <filter id={`${uid}-tb`} {...REGION}>
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.3" numOctaves={2} seed={g.seed + 5} />
            <feColorMatrix type="matrix" values="0 0 0 0 0.28  0 0 0 0 0.16  0 0 0 0 0.07  3 0 0 0 -1.85" />
          </filter>
          <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="1" y2="0.6">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0.06" />
            <stop offset="0.7" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </>
      );
  }
}

/** Defect painted into the surface (clipped to the tile). */
function DefectPaintLayer({ d, uid }: { d: DefectPaint; uid: string }) {
  switch (d.kind) {
    case 'crack':
      return (
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d={d.main} stroke="rgba(0,0,0,0.1)" strokeWidth={11} />
          {d.branches.map((b, i) => (
            <path key={`h${i}`} d={b} stroke="rgba(0,0,0,0.08)" strokeWidth={7} />
          ))}
          <path d={d.main} stroke="rgba(30,21,14,0.85)" strokeWidth={3} />
          <path d={d.core} stroke="rgba(26,18,12,0.9)" strokeWidth={4.6} />
          {d.branches.map((b, i) => (
            <path key={`c${i}`} d={b} stroke="rgba(30,21,14,0.78)" strokeWidth={2.2} />
          ))}
          <path d={d.core} stroke="rgba(255,255,255,0.32)" strokeWidth={1.4} transform="translate(2.6 1.4)" />
        </g>
      );
    case 'chip':
      return (
        <g fill="none" strokeLinejoin="round" strokeLinecap="round">
          <path d={d.brk} stroke="#cdbda3" strokeWidth={20} />
          <path d={d.brk} stroke="rgba(90,74,56,0.55)" strokeWidth={5} />
          <path d={d.inner} stroke="rgba(60,46,32,0.45)" strokeWidth={2.2} />
        </g>
      );
    case 'surface':
      return (
        <g>
          {d.holes.map((h, i) => (
            <g key={i}>
              <circle cx={h.x} cy={h.y} r={h.r * 2.2} fill="rgba(0,0,0,0.07)" />
              <circle cx={h.x} cy={h.y} r={h.r} fill="rgba(34,25,17,0.84)" />
              <circle cx={h.x - 0.8} cy={h.y - 0.8} r={h.r + 1.6} fill="none" stroke="rgba(255,255,255,0.42)" strokeWidth={1.4} />
            </g>
          ))}
        </g>
      );
    case 'glaze':
      return (
        <g>
          <path d={d.blob} fill={d.thicker ? '#3b2b1d' : '#fffaf0'} opacity={d.strength} filter={`url(#${uid}-soft)`} />
          <path d={d.blob} fill="none" stroke={d.thicker ? 'rgba(40,28,18,0.32)' : 'rgba(255,255,255,0.5)'} strokeWidth={1.6} />
          {d.thicker && <path d={d.core} fill="#ffffff" opacity={0.16} filter={`url(#${uid}-soft)`} />}
        </g>
      );
    case 'shade':
      return <path d={d.blob} fill={d.warm ? '#7a4a1c' : '#2f3b4a'} opacity={d.strength} filter={`url(#${uid}-soft)`} />;
    default:
      return null;
  }
}

/** Tile body: drop shadow, clipped procedural surface with the defect, bevel highlight. */
function TileBody({ g, uid, shadow }: { g: TileGeometry; uid: string; shadow: boolean }) {
  const d = g.defect;
  return (
    <>
      <defs>
        <clipPath id={`${uid}-clip`}>
          <path d={g.outline} />
        </clipPath>
        <SurfaceDefs uid={uid} g={g} />
        {shadow && (
          <filter id={`${uid}-shadow`} {...REGION}>
            <feGaussianBlur stdDeviation="10" />
          </filter>
        )}
        {(d?.kind === 'glaze' || d?.kind === 'shade') && (
          <filter id={`${uid}-soft`} {...REGION}>
            <feGaussianBlur stdDeviation={d.kind === 'shade' ? d.blur : 9} />
          </filter>
        )}
      </defs>
      {shadow && <path d={g.outline} fill="#000" opacity={0.55} transform="translate(12 16)" filter={`url(#${uid}-shadow)`} />}
      <g clipPath={`url(#${uid}-clip)`}>
        <rect x={-60} y={-60} width={TILE + 120} height={TILE + 120} fill={g.base} />
        <rect x={-60} y={-60} width={TILE + 120} height={TILE + 120} filter={`url(#${uid}-ta)`} />
        <rect x={-60} y={-60} width={TILE + 120} height={TILE + 120} filter={`url(#${uid}-tb)`} />
        {g.surface !== 'beige' && <rect x={-60} y={-60} width={TILE + 120} height={TILE + 120} fill={`url(#${uid}-sheen)`} />}
        {d && <DefectPaintLayer d={d} uid={uid} />}
      </g>
      <path d={g.outline} fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth={3} />
      <path d={g.outline} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={1.2} transform="translate(1.5 2)" />
    </>
  );
}

/** Gauge overlays: laser profile lines (planarity) and nominal vs measured edge (caliber). */
function GaugeOverlay({ d, labels }: { d: DefectPaint; labels: boolean }) {
  if (d.kind === 'planarity')
    return (
      <g className="q-gauge" fill="none">
        {d.nominal.map((p, i) => (
          <path key={`n${i}`} d={p} className="q-gauge-nominal" vectorEffect="non-scaling-stroke" />
        ))}
        {d.lines.map((p, i) => (
          <g key={`l${i}`}>
            <path d={p} className="q-gauge-glow" />
            <path d={p} className="q-gauge-line" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {labels && (
          <text x={d.at[0]} y={d.at[1]} className="q-gauge-text" dominantBaseline={d.at[1] < 500 ? 'auto' : 'hanging'}>
            centre {d.value}
          </text>
        )}
      </g>
    );
  if (d.kind === 'dimension') {
    const ym = (d.y0 + d.y1) / 2;
    return (
      <g className="q-gauge" fill="none">
        <path d={`M0 ${d.y0 - 70} L0 ${d.y1 + 70}`} className="q-gauge-nominal" vectorEffect="non-scaling-stroke" />
        <path d={d.edge} className="q-gauge-glow" />
        <path d={d.edge} className="q-gauge-line" vectorEffect="non-scaling-stroke" />
        {labels && (
          <>
            <path d={`M${-d.offset} ${ym} L110 ${ym}`} className="q-gauge-nominal" vectorEffect="non-scaling-stroke" />
            <text x={122} y={ym} className="q-gauge-text" dominantBaseline="middle">
              caliber {d.value}
            </text>
          </>
        )}
      </g>
    );
  }
  return null;
}

const cornerTicks = (b: Box, L: number) =>
  [
    `M${b.x} ${b.y + L} L${b.x} ${b.y} L${b.x + L} ${b.y}`,
    `M${b.x + b.w - L} ${b.y} L${b.x + b.w} ${b.y} L${b.x + b.w} ${b.y + L}`,
    `M${b.x + b.w} ${b.y + b.h - L} L${b.x + b.w} ${b.y + b.h} L${b.x + b.w - L} ${b.y + b.h}`,
    `M${b.x + L} ${b.y + b.h} L${b.x} ${b.y + b.h} L${b.x} ${b.y + b.h - L}`,
  ].join(' ');

/** Detection box (corner ticks + thin frame). */
function BoxMark({ box, color, thin }: { box: Box; color: string; thin?: boolean }) {
  const L = Math.min(48, box.w * 0.3, box.h * 0.3);
  return (
    <g style={{ color }} pointerEvents="none">
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="none" stroke="currentColor" strokeWidth={thin ? 1 : 1.25} vectorEffect="non-scaling-stroke" opacity={0.9} />
      {!thin && <path d={cornerTicks(box, L)} fill="none" stroke="currentColor" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
    </g>
  );
}

/** Thumbnail of a frame (tile only, box without label). */
export const FrameThumb = memo(
  function FrameThumb({ frame }: { frame: Frame }) {
    const uid = useUid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const g = useMemo(() => tileGeometry(frame), [frame.id, frame.sku]);
    return (
      <svg viewBox={`-50 -50 ${TILE + 100} ${TILE + 100}`} className="q-thumb-svg" aria-hidden focusable="false">
        <rect x={-50} y={-50} width={TILE + 100} height={TILE + 100} fill="#14181b" />
        <TileBody g={g} uid={uid} shadow={false} />
        {g.defect && <GaugeOverlay d={g.defect} labels={false} />}
        {g.box && <BoxMark box={g.box} color={severityColor(frame.rec?.severity ?? null)} thin />}
      </svg>
    );
  },
  (a, b) => a.frame.id === b.frame.id && a.frame.sku === b.frame.sku,
);

// ── Stills: record detail and raster export ──────────────────────────────────

const SEV_HEX: Record<NonNullable<QualityInspection['severity']>, string> = { minor: '#fab219', major: '#ec835a', critical: '#e05252' };

/** Styles a standalone still embeds (an SVG drawn as an image cannot see the page's CSS or tokens). */
export const STILL_CSS = [
  '.q-gauge-nominal{stroke:#ffffff80;stroke-width:1.2px;stroke-dasharray:8 6}',
  '.q-gauge-line{stroke:#79bdd6;stroke-width:2px}',
  '.q-gauge-glow{stroke:#5aa7c3;stroke-opacity:0.28;stroke-width:12}',
  '.q-gauge-text{font:500 30px ui-monospace,Menlo,Consolas,monospace;fill:#79bdd6;paint-order:stroke;stroke:#0e1114;stroke-width:7px;stroke-opacity:0.75}',
  '.q-still-label{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600;fill:#0e1114}',
  '.q-still-bar{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:500;fill:#ffffffd9}',
].join('');

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const clampN = (v: number, a: number, b: number) => (b < a ? a : Math.min(b, Math.max(a, v)));

/**
 * Square still of a frame: the original tile (no overlays) or the annotated frame (gauge overlay,
 * detection box with class and simulated confidence, scale bar), optionally cropped around the box.
 * `standalone` makes a self-contained SVG (namespace, pixel size, embedded styles, no CSS
 * variables) that can be drawn into a canvas for reports and the PDF.
 */
export function FrameStill({
  frame,
  annotated,
  crop = false,
  standalone,
  className,
  label,
}: {
  frame: Frame;
  annotated: boolean;
  crop?: boolean;
  standalone?: { size: number };
  className?: string;
  /** Accessible description; omitted = decorative. */
  label?: string;
}) {
  const uid = useUid();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const g = useMemo(() => tileGeometry(frame), [frame.id, frame.sku]);
  const v = stillView(g, crop);
  const rec = frame.rec;
  const sev = rec?.severity ?? null;
  const color = standalone ? SEV_HEX[sev ?? 'major'] : severityColor(sev);
  const showBox = annotated && !!g.box;
  const text = showBox ? detectionLabel(rec) : '';
  const pad = v.side * 0.03;
  const lh = v.side * 0.068;
  const fs = lh * 0.6;
  const lw = text.length * fs * 0.62 + lh * 0.5;
  let lx = 0;
  let ly = 0;
  if (v.box && text) {
    const gap = pad * 0.4;
    lx = clampN(v.box.x0, v.x + pad, v.x + v.side - pad - lw);
    ly =
      v.box.y0 - lh - gap >= v.y + pad
        ? v.box.y0 - lh - gap
        : v.box.y1 + gap + lh <= v.y + v.side - pad
          ? v.box.y1 + gap
          : Math.max(v.y + pad, v.box.y0 + gap);
  }
  const bar = stillScaleBar(v.side);
  const bx = v.x + v.side - pad - bar.len;
  const by = v.y + v.side - pad * 1.4;
  const tick = v.side * 0.012;
  return (
    <svg
      xmlns={standalone ? 'http://www.w3.org/2000/svg' : undefined}
      width={standalone?.size}
      height={standalone?.size}
      viewBox={`${f1(v.x)} ${f1(v.y)} ${f1(v.side)} ${f1(v.side)}`}
      preserveAspectRatio="xMidYMid slice"
      className={className}
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {standalone && <style>{STILL_CSS}</style>}
      <defs>
        <pattern id={`${uid}-rollers`} width="96" height="200" patternUnits="userSpaceOnUse">
          <rect width="96" height="200" fill="#0c0f11" />
          <rect x="8" width="80" height="200" fill="#1c2226" />
          <rect x="28" width="12" height="200" fill="#262d32" />
          <rect x="74" width="6" height="200" fill="#161b1e" />
        </pattern>
      </defs>
      <rect x={v.x} y={v.y} width={v.side} height={v.side} fill={`url(#${uid}-rollers)`} />
      <g transform={tileTransform(g)}>
        <TileBody g={g} uid={uid} shadow />
        {annotated && g.defect && <GaugeOverlay d={g.defect} labels={!crop} />}
        {showBox && <BoxMark box={g.box!} color={color} />}
      </g>
      {text && (
        <g style={{ color }} transform={`translate(${f1(lx)} ${f1(ly)})`}>
          <rect width={lw} height={lh} rx={lh * 0.12} fill="currentColor" />
          <text x={lh * 0.25} y={lh / 2} dominantBaseline="central" className="q-still-label" style={{ fontSize: fs }}>
            {text}
          </text>
        </g>
      )}
      {annotated && (
        <g>
          <rect x={bx - pad * 0.5} y={by - fs * 1.9} width={bar.len + pad} height={fs * 2.5} rx={pad * 0.3} fill="#0a0d0fb3" />
          <path
            d={`M${f1(bx)} ${f1(by)} L${f1(bx + bar.len)} ${f1(by)} M${f1(bx)} ${f1(by - tick)} L${f1(bx)} ${f1(by + tick)} M${f1(bx + bar.len)} ${f1(by - tick)} L${f1(bx + bar.len)} ${f1(by + tick)}`}
            fill="none"
            stroke="#ffffffd9"
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
          />
          <text x={bx + bar.len / 2} y={by - fs * 0.55} textAnchor="middle" className="q-still-bar" style={{ fontSize: fs * 0.8 }}>
            {bar.mm} mm
          </text>
        </g>
      )}
    </svg>
  );
}
