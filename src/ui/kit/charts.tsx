/**
 * Small SVG chart set for the analytical workspaces. Conventions (see the dataviz rules):
 * recessive grid and axes, thin marks with 4 px rounded data-ends anchored on the
 * baseline, a 2 px surface gap between adjacent fills, one y-axis per chart, hover
 * tooltips by default, legends only for two or more series, text in text colours.
 * Selectable marks (ColumnChart / RankedBars with onSelect) are keyboard controls: focusable,
 * activated with Enter or Space, named for screen readers, with a visible focus mark.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';

/** Enter / Space activate a non-button control (role="button"). */
const onActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  fn();
};

/** A button that looks like the text it wraps (focus ring from :focus-visible). */
const PLAIN_BUTTON: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 0,
  margin: 0,
  border: 0,
  borderRadius: 2,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  cursor: 'pointer',
};

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** "Nice" upper bound and ticks for a y scale starting at 0. */
function niceScale(max: number, ticks = 4) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

type Tip = { x: number; y: number; content: ReactNode } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
      {tip.content}
    </div>
  );
}

export const TipRow = ({ k, v, swatch }: { k: ReactNode; v: ReactNode; swatch?: string }) => (
  <div className="row">
    <span>
      {swatch && <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: swatch, marginRight: 6 }} />}
      {k}
    </span>
    <span>{v}</span>
  </div>
);

const PAD = { l: 44, r: 8, t: 8, b: 22 };

/** Bars rounded on the data end only (top), flat on the baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 3) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

// ── Columns vs target ─────────────────────────────────────────────────────────

export type ColumnDatum = { key: string; label: string; value: number; target?: number; muted?: boolean };

/**
 * One series of columns with an optional dashed per-bucket target step. With `onSelect` every column
 * is a keyboard control (Tab to it, Enter / Space selects; the tooltip follows focus).
 */
export function ColumnChart({
  data,
  height = 200,
  color = 'var(--series-1)',
  format,
  tickEvery = 1,
  tip,
  onSelect,
  label,
  barLabel,
}: {
  data: ColumnDatum[];
  height?: number;
  color?: string;
  format: (v: number) => string;
  tickEvery?: number;
  tip?: (d: ColumnDatum) => ReactNode;
  onSelect?: (d: ColumnDatum) => void;
  /** Accessible name of the chart. */
  label?: string;
  /** Accessible name of a selectable column (default: its label, value and target). */
  barLabel?: (d: ColumnDatum) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Tip>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const nameOf = barLabel ?? ((d: ColumnDatum) => `${d.label}: ${format(d.value)}${d.target != null ? `, target ${format(d.target)}` : ''}`);
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.target ?? 0)));
  const { top, ticks } = niceScale(max);
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const step = iw / Math.max(1, data.length);
  const bw = Math.max(2, step - 2);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const hasTarget = data.some((d) => d.target != null);
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {/* Interactive: a group of buttons (an "img" would hide them from assistive technology). */}
      <svg width={width} height={height} role={onSelect ? 'group' : 'img'} aria-label={label}>
        <g className="grid" aria-hidden>
          {ticks.map((t) => (
            <line key={t} x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        {ticks.map((t) => (
          <text key={t} x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end" aria-hidden={onSelect ? true : undefined}>
            {format(t)}
          </text>
        ))}
        {data.map((d, i) => {
          const x = PAD.l + i * step + 1;
          const h = y(0) - y(d.value);
          const showTip = () => tip && setHover({ x: x + bw / 2, y: y(Math.max(d.value, d.target ?? 0)), content: tip(d) });
          return (
            <g
              key={d.key}
              onMouseMove={showTip}
              onClick={onSelect ? () => onSelect(d) : undefined}
              style={{ cursor: onSelect ? 'pointer' : undefined, outline: 'none' }}
              {...(onSelect
                ? {
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': nameOf(d),
                    onKeyDown: onActivate(() => onSelect(d)),
                    onFocus: (e: FocusEvent<SVGGElement>) => {
                      // The focus mark is for keyboard focus; a mouse click shows the tooltip only.
                      let keyboard = true;
                      try {
                        keyboard = e.currentTarget.matches(':focus-visible');
                      } catch {
                        /* selector unsupported: show the mark */
                      }
                      if (keyboard) setFocused(d.key);
                      showTip();
                    },
                    onBlur: () => {
                      setFocused((k) => (k === d.key ? null : k));
                      setHover(null);
                    },
                  }
                : {})}
            >
              <rect x={x - 1} y={PAD.t} width={step} height={ih} fill="transparent" />
              <path d={barPath(x, y(d.value), bw, h)} fill={color} opacity={d.muted ? 0.45 : 1} />
              {focused === d.key && <rect x={x - 1} y={PAD.t} width={step} height={ih} fill="none" stroke="var(--accent)" strokeWidth={1.5} rx={2} pointerEvents="none" />}
            </g>
          );
        })}
        {hasTarget && (
          <path
            d={data
              .map((d, i) => (d.target == null ? '' : `M${PAD.l + i * step},${y(d.target)}H${PAD.l + (i + 1) * step}`))
              .join('')}
            stroke="var(--text-1)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            fill="none"
            pointerEvents="none"
          />
        )}
        <line className="baseline" x1={PAD.l} x2={width - PAD.r} y1={y(0)} y2={y(0)} />
        {data.map((d, i) =>
          i % tickEvery === 0 ? (
            <text key={d.key} x={PAD.l + i * step + step / 2} y={height - 6} textAnchor="middle" aria-hidden={onSelect ? true : undefined}>
              {d.label}
            </text>
          ) : null,
        )}
      </svg>
      <Tooltip tip={hover} />
    </div>
  );
}

// ── Lines ─────────────────────────────────────────────────────────────────────

export type LineSeries = { id: string; label: string; color: string; points: (number | null)[]; dashed?: boolean };

export type RefLine = { value: number; label: string };

/** Multi-line chart on one y scale with a crosshair tooltip. */
export function LineChart({
  labels,
  series,
  height = 200,
  yMax,
  yMin = 0,
  format,
  tickEvery = 1,
  reference,
}: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  yMax?: number;
  yMin?: number;
  format: (v: number) => string;
  tickEvery?: number;
  /** One or more labelled horizontal reference lines (limits, targets, baselines). */
  reference?: RefLine | RefLine[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const refs = reference == null ? [] : Array.isArray(reference) ? reference : [reference];
  const all = series.flatMap((s) => s.points.filter((p): p is number => p != null));
  const max = yMax ?? niceScale(Math.max(1e-9, ...all, ...refs.map((r) => r.value))).top;
  const ticks = Array.from({ length: 5 }, (_, i) => yMin + ((max - yMin) * i) / 4);
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const n = Math.max(1, labels.length - 1);
  const x = (i: number) => PAD.l + (i / n) * iw;
  const y = (v: number) => PAD.t + ih - ((v - yMin) / (max - yMin)) * ih;
  const path = (pts: (number | null)[]) => {
    let d = '';
    let pen = false;
    pts.forEach((p, i) => {
      if (p == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i)},${y(p)}`;
      pen = true;
    });
    return d;
  };
  return (
    <div className="chart" ref={ref}>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.id}>
              <i className={s.dashed ? 'dash' : 'line'} style={{ background: s.color, borderColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <svg
          width={width}
          height={height}
          role="img"
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const i = Math.round(((e.clientX - r.left - PAD.l) / iw) * n);
            setHi(i >= 0 && i < labels.length ? i : null);
          }}
          onMouseLeave={() => setHi(null)}
        >
          <g className="grid">
            {ticks.map((t) => (
              <line key={t} x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />
            ))}
          </g>
          {ticks.map((t) => (
            <text key={t} x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end">
              {format(t)}
            </text>
          ))}
          {refs.map((r) => (
            <g key={`${r.label}-${r.value}`}>
              <line x1={PAD.l} x2={width - PAD.r} y1={y(r.value)} y2={y(r.value)} stroke="var(--text-2)" strokeDasharray="3 3" />
              <text x={width - PAD.r} y={y(r.value) - 5} textAnchor="end" style={{ fill: 'var(--text-2)' }}>
                {r.label}
              </text>
            </g>
          ))}
          {series.map((s) => (
            <path
              key={s.id}
              d={path(s.points)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '4 3' : undefined}
              strokeLinejoin="round"
            />
          ))}
          {hi != null && (
            <g pointerEvents="none">
              <line x1={x(hi)} x2={x(hi)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--line-3)" />
              {series.map((s) =>
                s.points[hi] != null ? (
                  <circle key={s.id} cx={x(hi)} cy={y(s.points[hi]!)} r={4} fill={s.color} stroke="var(--bg-1)" strokeWidth={2} />
                ) : null,
              )}
            </g>
          )}
          {labels.map((l, i) =>
            i % tickEvery === 0 ? (
              <text key={i} x={x(i)} y={height - 6} textAnchor="middle">
                {l}
              </text>
            ) : null,
          )}
        </svg>
        {hi != null && (
          <div className="chart-tip" style={{ left: x(hi), top: PAD.t }}>
            <b>{labels[hi]}</b>
            {series.map((s) => (
              <TipRow key={s.id} k={s.label} v={s.points[hi] == null ? '—' : format(s.points[hi]!)} swatch={s.color} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Stacked columns ──────────────────────────────────────────────────────────

export type StackSeries = { key: string; label: string; color: string };

export function StackedColumns({
  labels,
  series,
  values,
  height = 200,
  format,
  tickEvery = 1,
}: {
  labels: string[];
  series: StackSeries[];
  /** values[bucket][seriesIndex] */
  values: number[][];
  height?: number;
  format: (v: number) => string;
  tickEvery?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Tip>(null);
  const totals = values.map((v) => v.reduce((a, b) => a + b, 0));
  const { top, ticks } = niceScale(Math.max(1, ...totals));
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const step = iw / Math.max(1, labels.length);
  const bw = Math.max(2, step - 2);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        <svg width={width} height={height} role="img">
          <g className="grid">
            {ticks.map((t) => (
              <line key={t} x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />
            ))}
          </g>
          {ticks.map((t) => (
            <text key={t} x={PAD.l - 6} y={y(t) + 3.5} textAnchor="end">
              {format(t)}
            </text>
          ))}
          {values.map((v, i) => {
            const x = PAD.l + i * step + 1;
            let acc = 0;
            const segs = v.map((val, si) => {
              const y0 = y(acc);
              acc += val;
              const y1 = y(acc);
              // 2 px surface gap between stacked segments.
              const h = Math.max(0, y0 - y1 - (si > 0 ? 2 : 0));
              const isTop = si === v.length - 1 || v.slice(si + 1).every((x2) => x2 === 0);
              return h > 0 ? (
                isTop ? (
                  <path key={si} d={barPath(x, y1, bw, h)} fill={series[si].color} />
                ) : (
                  <rect key={si} x={x} y={y1} width={bw} height={h} fill={series[si].color} />
                )
              ) : null;
            });
            return (
              <g
                key={i}
                onMouseMove={() =>
                  setHover({
                    x: x + bw / 2,
                    y: y(totals[i]),
                    content: (
                      <>
                        <b>{labels[i]}</b>
                        {series.map((s, si) => (
                          <TipRow key={s.key} k={s.label} v={format(v[si])} swatch={s.color} />
                        ))}
                        <TipRow k="Total" v={format(totals[i])} />
                      </>
                    ),
                  })
                }
              >
                <rect x={x - 1} y={PAD.t} width={step} height={ih} fill="transparent" />
                {segs}
              </g>
            );
          })}
          <line className="baseline" x1={PAD.l} x2={width - PAD.r} y1={y(0)} y2={y(0)} />
          {labels.map((l, i) =>
            i % tickEvery === 0 ? (
              <text key={i} x={PAD.l + i * step + step / 2} y={height - 6} textAnchor="middle">
                {l}
              </text>
            ) : null,
          )}
        </svg>
        <Tooltip tip={hover} />
      </div>
    </div>
  );
}

// ── Ranked horizontal bars (Pareto without a second axis) ────────────────────

export type RankedRow = { key: string; label: ReactNode; value: number; share?: number; cumulative?: number; color?: string };

/**
 * Sorted horizontal bars with value and cumulative share as text columns — the Pareto
 * reading without a dual-axis chart. With `onSelect` each row's label is a button (Tab, Enter /
 * Space); a click anywhere on the row selects it too.
 */
export function RankedBars({
  rows,
  format,
  valueHeader = 'Value',
  onSelect,
  color = 'var(--series-1)',
  showCumulative = true,
  labelHeader = 'Reason',
  selectedKey = null,
}: {
  rows: RankedRow[];
  format: (v: number) => string;
  valueHeader?: string;
  onSelect?: (row: RankedRow) => void;
  color?: string;
  showCumulative?: boolean;
  labelHeader?: string;
  /** Highlights one row and dims the others (e.g. an active filter). */
  selectedKey?: string | null;
}) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div role="table">
      <div className="hbar head" role="row">
        <span role="columnheader">{labelHeader}</span>
        <span aria-hidden />
        <span className="val" role="columnheader">
          {valueHeader}
        </span>
        <span className="cum" role="columnheader">
          {showCumulative ? 'Cum. %' : 'Share'}
        </span>
      </div>
      {rows.map((r) => (
        <div
          key={r.key}
          role="row"
          className={`hbar ${onSelect ? 'clickable' : ''}`}
          style={selectedKey && selectedKey !== r.key ? { opacity: 0.45 } : undefined}
          onClick={onSelect ? () => onSelect(r) : undefined}
          title={typeof r.label === 'string' ? r.label : undefined}
        >
          <span className="label" role="cell">
            {onSelect ? (
              <button
                type="button"
                style={PLAIN_BUTTON}
                aria-pressed={selectedKey != null ? selectedKey === r.key : undefined}
                aria-label={typeof r.label === 'string' ? `${r.label}: ${format(r.value)}` : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(r);
                }}
              >
                {r.label}
              </button>
            ) : (
              r.label
            )}
          </span>
          <span className="track" role="cell" aria-hidden>
            <span className="bar" style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? color }} />
          </span>
          <span className="val" role="cell">
            {format(r.value)}
          </span>
          <span className="cum" role="cell">
            {showCumulative
              ? r.cumulative != null
                ? `${Math.round(r.cumulative * 100)} %`
                : ''
              : r.share != null
                ? `${Math.round(r.share * 100)} %`
                : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Waterfall (OEE loss tree) ────────────────────────────────────────────────

export type WaterfallStep = { label: string; value: number; kind: 'total' | 'loss'; note?: string };

export function Waterfall({ steps, height = 210, format }: { steps: WaterfallStep[]; height?: number; format: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Tip>(null);
  const top = niceScale(Math.max(1, ...steps.map((s) => s.value))).top;
  const ticks = [0, top / 2, top];
  const pad = { ...PAD, b: 34 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const step = iw / steps.length;
  const bw = Math.min(64, step * 0.58);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  let level = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'total') {
      level = s.value;
      return { s, from: 0, to: s.value };
    }
    const from = level - s.value;
    const b = { s, from, to: level };
    level = from;
    return b;
  });
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img">
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        {ticks.map((t) => (
          <text key={t} x={pad.l - 6} y={y(t) + 3.5} textAnchor="end">
            {format(t)}
          </text>
        ))}
        {bars.map((b, i) => {
          const cx = pad.l + i * step + step / 2;
          const x = cx - bw / 2;
          const h = Math.max(1, y(b.from) - y(b.to));
          const fill = b.s.kind === 'total' ? 'var(--series-1)' : 'var(--series-2)';
          return (
            <g
              key={b.s.label}
              onMouseMove={() =>
                setHover({
                  x: cx,
                  y: y(b.to),
                  content: (
                    <>
                      <b>{b.s.label}</b>
                      <TipRow k={b.s.kind === 'total' ? 'Time' : 'Loss'} v={format(b.s.value)} />
                      {b.s.note && <div style={{ color: 'var(--text-3)', marginTop: 3 }}>{b.s.note}</div>}
                    </>
                  ),
                })
              }
            >
              <rect x={x} y={y(b.to)} width={bw} height={h} rx={2} fill={fill} opacity={b.s.kind === 'loss' ? 0.9 : 1} />
              {i < bars.length - 1 && (
                <line
                  x1={x + bw}
                  x2={x + step}
                  y1={y(b.s.kind === 'total' ? b.to : b.from)}
                  y2={y(b.s.kind === 'total' ? b.to : b.from)}
                  stroke="var(--line-3)"
                  strokeDasharray="2 2"
                />
              )}
              <text x={cx} y={y(b.to) - 5} textAnchor="middle" style={{ fill: 'var(--text-2)' }}>
                {format(b.s.value)}
              </text>
              <text x={cx} y={height - 18} textAnchor="middle">
                {b.s.label.split('\n')[0]}
              </text>
              {b.s.label.includes('\n') && (
                <text x={cx} y={height - 5} textAnchor="middle">
                  {b.s.label.split('\n')[1]}
                </text>
              )}
            </g>
          );
        })}
        <line className="baseline" x1={pad.l} x2={width - pad.r} y1={y(0)} y2={y(0)} />
      </svg>
      <Tooltip tip={hover} />
    </div>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

export function Sparkline({ values, width = 96, height = 24, color = 'var(--text-2)', max }: { values: (number | null)[]; width?: number; height?: number; color?: string; max?: number }) {
  const vals = values.filter((v): v is number => v != null);
  if (vals.length < 2) return <svg width={width} height={height} />;
  const hi = max ?? Math.max(...vals);
  const lo = Math.min(0, ...vals);
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - lo) / Math.max(1e-9, hi - lo)) * (height - 4);
  let d = '';
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${d ? 'L' : 'M'}${x(i)},${y(v)}`;
  });
  return (
    <svg width={width} height={height} aria-hidden style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
