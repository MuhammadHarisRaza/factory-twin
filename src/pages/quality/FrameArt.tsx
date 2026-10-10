/**
 * SVG rendering of an illustrative inspection frame: a procedural tile surface for the
 * batch product, the painted defect, gauge overlays and the simulated detection box.
 * This is a drawing of a simulated record — no image is captured or classified.
 */
import { memo, useId, useMemo, type KeyboardEvent } from 'react';
import { DEFECTS } from '../../model/plant';
import type { QualityInspection } from '../../model/types';
import type { Frame } from './frames';
import {
  FRAME_H,
  FRAME_W,
  TILE,
  TILE_PX,
  TILE_X,
  TILE_Y,
  scaleBar,
  tileGeometry,
  tileTransform,
  zoomOnBox,
  type Box,
  type DefectPaint,
  type TileGeometry,
} from './tileGeometry';

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

const LABEL_FS = 32;
const LABEL_H = 44;

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

/** Main viewer frame: camera view of the tile on the roller conveyor. */
export function FrameView({
  frame,
  zoomed,
  onBoxClick,
  label,
}: {
  frame: Frame;
  zoomed: boolean;
  onBoxClick?: () => void;
  /** Accessible description of the frame. */
  label: string;
}) {
  const uid = useUid();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const g = useMemo(() => tileGeometry(frame), [frame.id, frame.sku]);
  const z = zoomed ? zoomOnBox(g) : null;
  const k = z?.k ?? 1;
  const bar = scaleBar(k);
  const rec = frame.rec;
  const color = severityColor(rec?.severity ?? null);
  const text = rec?.defect ? `${DEFECT_SHORT[rec.defect]} ${rec.confidence != null ? `${(rec.confidence * 100).toFixed(1)}%` : ''}`.trim() : '';
  const lw = text.length * LABEL_FS * 0.6 + 24;
  const box = g.box;
  const lx = box ? Math.min(Math.max(box.x, -40), TILE + 40 - lw) : 0;
  // Label above the box; below it when the box touches the top edge; inside it for full-tile boxes.
  const ly = !box
    ? 0
    : box.y > LABEL_H + 10
      ? box.y - LABEL_H - 6
      : box.y + box.h + LABEL_H + 6 <= TILE
        ? box.y + box.h + 6
        : box.y + 8;
  const onKey = (e: KeyboardEvent) => {
    if (onBoxClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
      onBoxClick();
    }
  };

  return (
    <svg viewBox={`0 0 ${FRAME_W} ${FRAME_H}`} preserveAspectRatio="xMidYMid meet" className="q-frame-svg" role="img" aria-label={label}>
      <defs>
        <pattern id={`${uid}-rollers`} width="96" height="200" patternUnits="userSpaceOnUse">
          <rect width="96" height="200" fill="#0c0f11" />
          <rect x="8" width="80" height="200" fill="#1c2226" />
          <rect x="28" width="12" height="200" fill="#262d32" />
          <rect x="74" width="6" height="200" fill="#161b1e" />
        </pattern>
      </defs>
      <g
        className="q-zoom"
        style={{ transform: z ? `translate(${z.tx}px, ${z.ty}px) scale(${z.k})` : 'translate(0px, 0px) scale(1)', transformOrigin: '0 0' }}
      >
        <rect x={-3200} y={-2000} width={8000} height={5000} fill={`url(#${uid}-rollers)`} />
        <rect x={-3200} y={12} width={8000} height={22} fill="#272e33" />
        <rect x={-3200} y={FRAME_H - 34} width={8000} height={22} fill="#272e33" />
        <g transform={tileTransform(g)}>
          <TileBody g={g} uid={uid} shadow />
          {g.defect && <GaugeOverlay d={g.defect} labels={!zoomed} />}
          {box && (
            <g className="q-det">
              <BoxMark box={box} color={color} />
              <g className={`q-det-label ${zoomed ? 'hidden' : ''}`} style={{ color }} transform={`translate(${lx.toFixed(1)} ${ly.toFixed(1)})`} pointerEvents="none">
                <rect width={lw} height={LABEL_H} rx={4} fill="currentColor" />
                <text x={12} y={LABEL_H / 2} dominantBaseline="central" className="q-det-text">
                  {text}
                </text>
              </g>
              {onBoxClick && (
                <rect
                  className={`q-det-hit ${zoomed ? 'out' : ''}`}
                  x={box.x - 8}
                  y={box.y - 8}
                  width={box.w + 16}
                  height={box.h + 16}
                  fill="transparent"
                  role="button"
                  tabIndex={0}
                  aria-label={zoomed ? 'Show the full tile' : `Zoom to the ${rec?.defect ? DEFECTS[rec.defect].label.toLowerCase() : 'defect'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBoxClick();
                  }}
                  onKeyDown={onKey}
                />
              )}
            </g>
          )}
        </g>
      </g>
      {/* Field-of-view reticle and scale bar (camera overlay, not zoomed). */}
      <g className="q-reticle" fill="none">
        {(
          [
            [TILE_X - 26, TILE_Y - 26, 1, 1],
            [TILE_X + TILE_PX + 26, TILE_Y - 26, -1, 1],
            [TILE_X + TILE_PX + 26, TILE_Y + TILE_PX + 26, -1, -1],
            [TILE_X - 26, TILE_Y + TILE_PX + 26, 1, -1],
          ] as const
        ).map(([x, y, sx, sy], i) => (
          <path key={i} d={`M${x} ${y + sy * 44} L${x} ${y} L${x + sx * 44} ${y}`} />
        ))}
      </g>
      <g className="q-scalebar" transform={`translate(${FRAME_W - 60 - bar.len} ${FRAME_H - 64})`}>
        <rect x={-14} y={-38} width={bar.len + 28} height={58} rx={4} className="q-scalebar-bg" />
        <path d={`M0 0 L${bar.len} 0 M0 -9 L0 9 M${bar.len} -9 L${bar.len} 9`} />
        <text x={bar.len / 2} y={-14} textAnchor="middle">
          {bar.mm} mm
        </text>
      </g>
    </svg>
  );
}
