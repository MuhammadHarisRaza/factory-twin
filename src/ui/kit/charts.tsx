/**
 * Small SVG chart set for the analytical workspaces. Conventions (see the dataviz rules):
 * recessive grid and axes, thin marks with 4 px rounded data-ends anchored on the
 * baseline, a 2 px surface gap between adjacent fills, one y-axis per chart, hover
 * tooltips by default, legends only for two or more series, text in text colours.
 * Selectable marks (ColumnChart / RankedBars / EventStrip with onSelect) are keyboard controls: focusable,
 * activated with Enter or Space, named for screen readers, with a visible focus mark.
 *
 * Time-based charts (TimeSeriesChart, StateTimeline, EventStrip) share a real time axis in plant
 * minutes whose ticks adapt to the span. Missing values are gaps, never bridged and never drawn as
 * zero; a chart with nothing to draw (or too few samples to mean anything) says so in words.
 * Status marks carry a shape or pattern and words as well as a colour.
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { formatClock, formatDuration, MIN_PER_DAY, toMs } from '../../sim/time';
import './kit.css';

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
  label,
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
  /** Accessible name of the chart. */
  label?: string;
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
          aria-label={label}
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
  label,
}: {
  labels: string[];
  series: StackSeries[];
  /** values[bucket][seriesIndex] */
  values: number[][];
  height?: number;
  format: (v: number) => string;
  tickEvery?: number;
  /** Accessible name of the chart. */
  label?: string;
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
        <svg width={width} height={height} role="img" aria-label={label}>
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

export function Waterfall({ steps, height = 210, format, label }: { steps: WaterfallStep[]; height?: number; format: (v: number) => string; label?: string }) {
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
      <svg width={width} height={height} role="img" aria-label={label}>
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

/** A tiny trend beside a value (decorative: the value next to it carries the meaning). A null lifts the pen: gaps are never bridged. */
export function Sparkline({ values, width = 96, height = 24, color = 'var(--text-2)', max }: { values: (number | null)[]; width?: number; height?: number; color?: string; max?: number }) {
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const vals = values.filter(ok);
  if (vals.length < 2) return <svg width={width} height={height} aria-hidden />;
  const hi = max ?? Math.max(...vals);
  const lo = Math.min(0, ...vals);
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - lo) / Math.max(1e-9, hi - lo)) * (height - 4);
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (!ok(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
    // A sample between two gaps is a zero-length stroke: the round cap draws it as a dot.
    if (!pen && !ok(values[i + 1])) d += 'h0';
    pen = true;
  });
  return (
    <svg width={width} height={height} aria-hidden style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Shared helpers of the time-based charts ──────────────────────────────────

/** Formats a plant minute for axis ticks and tooltips. */
export type Clock = (minute: number) => string;

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });

/** The default plant clock for a span: 'hh:mm', or 'Mon 10:00' once the span is longer than a day. */
export const plantClock = (span: number): Clock => (span > MIN_PER_DAY ? (m) => `${WEEKDAY.format(toMs(m))} ${formatClock(m)}` : formatClock);

/** Tick steps of a time axis, in minutes (whole steps align to the hour and to the 06:00 production day). */
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 10080];

/** Time ticks on whole steps that fit the width without label collisions: the step adapts to the span. */
function timeTicks(from: number, to: number, px: number, clock: Clock) {
  const span = Math.max(1e-6, to - from);
  const minGap = Math.max(44, clock(from + span / 2).length * 6.5 + 18);
  const maxN = Math.max(1, Math.floor(px / minGap));
  const step = TIME_STEPS.find((s) => span / s <= maxN) ?? Math.ceil(span / maxN / 10080) * 10080;
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to + 1e-9; t += step) out.push(t);
  return out;
}

/** Text anchor that keeps a label centred on px inside [0, width] (11 px text ≈ 6.6 px a character). */
const anchorFor = (px: number, text: string, width: number) => {
  const half = text.length * 3.3;
  return px - half < 0 ? 'start' : px + half > width ? 'end' : 'middle';
};

/** Baseline, tick marks and clock labels of a time axis (labels at the edges anchor inwards). */
function TimeAxis({
  from,
  to,
  x,
  y,
  left,
  right,
  width,
  clock,
}: {
  from: number;
  to: number;
  x: (t: number) => number;
  y: number;
  left: number;
  right: number;
  width: number;
  clock: Clock;
}) {
  return (
    <g aria-hidden>
      <line className="baseline" x1={left} x2={right} y1={y} y2={y} />
      {timeTicks(from, to, right - left, clock).map((t) => {
        const px = x(t);
        const text = clock(t);
        return (
          <g key={t}>
            <line className="baseline" x1={px} x2={px} y1={y} y2={y + 4} />
            <text x={px} y={y + 15} textAnchor={anchorFor(px, text, width)}>
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
}

const NUM_FMT = new Map<string, Intl.NumberFormat>();
function numFmt(minDigits: number, maxDigits: number) {
  const key = `${minDigits}:${maxDigits}`;
  let f = NUM_FMT.get(key);
  if (!f) NUM_FMT.set(key, (f = new Intl.NumberFormat('en-GB', { minimumFractionDigits: minDigits, maximumFractionDigits: maxDigits })));
  return f;
}
/** A reading with a precision that suits its magnitude ('1,182', '12.4', '0.82'). */
const fmtAuto = (v: number) => {
  const a = Math.abs(v);
  return numFmt(0, a >= 100 || a === 0 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3).format(v);
};
/** Decimals that resolve a tick step (50 → 0, 2.5 → 1, 0.25 → 2). */
function stepDecimals(step: number) {
  const s = String(Number(step.toPrecision(6)));
  const i = s.indexOf('.');
  return i < 0 || s.includes('e') ? 0 : Math.min(4, s.length - i - 1);
}
const withUnit = (text: string, unit: string | null | undefined) => (unit ? `${text} ${unit}` : text);
/** A duration; exact segment minutes can be under one minute. */
const dur = (min: number) => (min > 0 && min < 0.5 ? '< 1 min' : formatDuration(min));
const r1 = (v: number) => Math.round(v * 10) / 10;

function extent(vals: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** "Nice" bounds and ticks around [lo, hi], not anchored at 0 (niceScale is the 0-based variant). */
function niceRange(lo: number, hi: number, ticks = 4) {
  // Bounds given the wrong way round (e.g. a fixed yMin above every value) still make a scale.
  if (hi < lo) [lo, hi] = [hi, lo];
  if (!(hi > lo)) {
    if (lo === 0) hi = 1;
    else {
      const pad = Math.abs(lo) * 0.05;
      lo -= pad;
      hi += pad;
    }
  }
  const raw = (hi - lo) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * (1 - 1e-9))!;
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const n = Math.max(1, Math.round((max - min) / step));
  return { min, max: min + n * step, step, ticks: Array.from({ length: n + 1 }, (_, i) => Number((min + i * step).toPrecision(12))) };
}

/** Index of the last value ≤ x in an ascending array (−1 if none). */
function lastAtOrBefore(ts: number[], x: number, n = ts.length) {
  let lo = 0;
  let hi = n - 1;
  let r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ts[m] <= x) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
}
/** Index of the value nearest to x in an ascending, non-empty array. */
function nearestIndex(ts: number[], x: number, n = ts.length) {
  const i = lastAtOrBefore(ts, x, n);
  if (i < 0) return 0;
  if (i >= n - 1) return n - 1;
  return x - ts[i] <= ts[i + 1] - x ? i : i + 1;
}
/** Median spacing of ascending times (the fallback for fewer than two). */
function medianStep(ts: number[], fallback: number) {
  if (ts.length < 2) return fallback;
  const d: number[] = [];
  for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
  d.sort((a, b) => a - b);
  return d[d.length >> 1] || fallback;
}

/** Left / Right / Home / End / PageUp (+10) / PageDown (−10) over n positions; null for any other key. */
function navIndex(key: string, cur: number, n: number): number | null {
  const to: Record<string, number> = { ArrowRight: cur + 1, ArrowLeft: cur - 1, PageUp: cur + 10, PageDown: cur - 10, Home: 0, End: n - 1 };
  const k = Object.prototype.hasOwnProperty.call(to, key) ? to[key] : null;
  return k == null || n === 0 ? null : Math.max(0, Math.min(n - 1, k));
}

/** Whether a focus came from the keyboard (the focus mark and readout are for keyboard focus). */
function keyboardFocus(el: Element) {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** An id usable inside url(#…) references (useId output can contain characters that need escaping). */
function useUid() {
  return `c${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
}

type ShapeKind = 'circle' | 'triangle' | 'diamond' | 'square';

/** A status mark whose shape carries the meaning as well as its colour; 1.5 px surface ring. */
function Shape({ kind, cx, cy, r, fill }: { kind: ShapeKind; cx: number; cy: number; r: number; fill: string }) {
  const ring = { fill, stroke: 'var(--bg-1)', strokeWidth: 1.5 };
  if (kind === 'circle') return <circle cx={cx} cy={cy} r={r} {...ring} />;
  if (kind === 'square') return <rect x={cx - r * 0.85} y={cy - r * 0.85} width={r * 1.7} height={r * 1.7} rx={1} {...ring} />;
  const pts =
    kind === 'triangle'
      ? [
          [cx, cy - r * 1.1],
          [cx + r, cy + r * 0.75],
          [cx - r, cy + r * 0.75],
        ]
      : [
          [cx, cy - r * 1.15],
          [cx + r * 1.15, cy],
          [cx, cy + r * 1.15],
          [cx - r * 1.15, cy],
        ];
  return <polygon points={pts.map((p) => p.map(r1).join(',')).join(' ')} {...ring} />;
}

/** The honest empty / insufficient state of a chart: says in words why there is nothing to draw. */
function ChartEmpty({ label, title, height, children }: { label: string; title: string; height: number; children?: ReactNode }) {
  return (
    <figure className="chart-empty" style={{ minHeight: height }} aria-label={label}>
      <Inbox size={18} aria-hidden />
      <b>{title}</b>
      {children && <span className="chart-empty-text">{children}</span>}
    </figure>
  );
}

// ── Time series (real time axis) ─────────────────────────────────────────────

export type TimeSeries = {
  id: string;
  label: string;
  /** Sample times in plant minutes, ascending. */
  t: number[];
  /** Values aligned with `t`; null = no value (a gap, never bridged). */
  v: (number | null)[];
  color?: string;
  dashed?: boolean;
  /** Step series: each value holds until the next sample (setpoints, hourly buckets). */
  step?: boolean;
};
export type TimeRefLine = { value: number; label: string; kind: 'target' | 'setpoint' | 'warning' | 'alarm' | 'limit' };
/** A time band, e.g. a stop or a deviation episode. */
export type TimeBand = { from: number; to: number; label: string; tone: 'warning' | 'critical' | 'neutral' };
export type TimeMarker = { t: number; label: string; tone?: 'neutral' | 'warning' | 'critical' };

const REF_STYLE: Record<TimeRefLine['kind'], { stroke: string; dash: string }> = {
  target: { stroke: 'var(--text-1)', dash: '3 3' },
  setpoint: { stroke: 'var(--accent)', dash: '6 3' },
  warning: { stroke: 'var(--warning)', dash: '4 3' },
  alarm: { stroke: 'var(--critical)', dash: '4 2' },
  limit: { stroke: 'var(--text-2)', dash: '1 3' },
};
const BAND_COLOR: Record<TimeBand['tone'], string> = { warning: 'var(--warning)', critical: 'var(--critical)', neutral: 'var(--neutral)' };
const MARKER_STYLE: Record<NonNullable<TimeMarker['tone']>, { color: string; shape: ShapeKind }> = {
  neutral: { color: 'var(--text-2)', shape: 'circle' },
  warning: { color: 'var(--warning)', shape: 'triangle' },
  critical: { color: 'var(--critical)', shape: 'square' },
};

/** The value of a series at time t: a number, null (a sample without a value) or undefined (no sample there). */
function sampleAt(s: TimeSeries, t: number, step: number): number | null | undefined {
  const n = Math.min(s.t.length, s.v.length);
  if (!n) return undefined;
  const clean = (v: number | null) => (v != null && Number.isFinite(v) ? v : null);
  if (s.step) {
    const i = lastAtOrBefore(s.t, t, n);
    if (i < 0) return undefined;
    const end = i + 1 < n ? s.t[i + 1] : s.t[i] + step;
    return t < end || t === s.t[i] ? clean(s.v[i]) : undefined;
  }
  const i = nearestIndex(s.t, t, n);
  return Math.abs(s.t[i] - t) <= step / 2 + 1e-9 ? clean(s.v[i]) : undefined;
}

/**
 * SVG path of a series: the pen lifts at every null, and (for a line series) across a run of missing
 * samples longer than three typical sample steps, where the tooltip also reads 'no sample'. Isolated
 * samples come back as dots. A step series holds each value until its next sample.
 */
function seriesPath(s: TimeSeries, x: (t: number) => number, y: (v: number) => number, holdStep: number, to: number) {
  const n = Math.min(s.t.length, s.v.length);
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const maxGap = s.step ? Infinity : 3 * holdStep + 1e-9;
  /** Whether sample i continues the line from sample i − 1 (both have values, no long time gap). */
  const joins = (i: number) => i > 0 && i < n && ok(s.v[i - 1]) && ok(s.v[i]) && s.t[i] - s.t[i - 1] <= maxGap;
  let d = '';
  const dots: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const v = s.v[i];
    if (!ok(v)) continue;
    const pen = joins(i);
    const px = r1(x(s.t[i]));
    const py = r1(y(v));
    if (s.step) {
      d += pen ? `V${py}` : `M${px},${py}`;
      d += `H${r1(x(i + 1 < n ? s.t[i + 1] : Math.min(to, s.t[i] + holdStep)))}`;
    } else {
      d += `${pen ? 'L' : 'M'}${px},${py}`;
      if (!pen && !joins(i + 1)) dots.push([px, py]);
    }
  }
  return { d, dots };
}

/**
 * Line chart on a real time axis (plant minutes): one y scale with the unit, ticks that adapt to
 * the span (minutes / hours / days), nulls as gaps, labelled reference lines by kind, time bands
 * (stops, deviation episodes), event markers and a highlighted window. Hover or keyboard focus
 * (arrows, Home / End, PageUp / PageDown) shows every series' value at the nearest sample.
 */
export function TimeSeriesChart({
  label,
  from,
  to,
  series,
  unit,
  refLines = [],
  bands = [],
  markers = [],
  highlight = null,
  height = 200,
  formatValue,
  emptyReason,
  yMin,
  yMax,
  clock,
  tipRows,
}: {
  /** Accessible name of the chart. */
  label: string;
  from: number;
  to: number;
  series: TimeSeries[];
  unit: string | null;
  refLines?: TimeRefLine[];
  bands?: TimeBand[];
  markers?: TimeMarker[];
  highlight?: { from: number; to: number } | null;
  height?: number;
  formatValue?: (v: number) => string;
  /** Shown when no series has a value in the range (default 'No data in this range'). */
  emptyReason?: string;
  yMin?: number;
  yMax?: number;
  clock?: Clock;
  /** Extra tooltip / readout rows at a sample time (e.g. the sample size behind a rate). Additive (quality Compare tab). */
  tipRows?: (t: number) => { label: string; value: string }[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useUid();
  const [hi, setHi] = useState<number | null>(null);
  const [live, setLive] = useState('');
  const span = Math.max(1e-6, to - from);
  const clk = clock ?? plantClock(span);
  const values: number[] = [];
  const timeSet = new Set<number>();
  for (const s of series) {
    const n = Math.min(s.t.length, s.v.length);
    for (let i = 0; i < n; i++) {
      if (s.t[i] < from || s.t[i] > to) continue;
      timeSet.add(s.t[i]);
      const v = s.v[i];
      if (v != null && Number.isFinite(v)) values.push(v);
    }
  }
  if (!values.length)
    return (
      <div className="chart" ref={ref}>
        <ChartEmpty label={label} height={height} title={emptyReason ?? 'No data in this range'} />
      </div>
    );

  const times = [...timeSet].sort((a, b) => a - b);
  const refs = refLines.filter((r) => Number.isFinite(r.value));
  const [vLo, vHi] = extent(values);
  const [rLo, rHi] = extent(refs.map((r) => r.value));
  let lo = Math.min(vLo, rLo);
  const top = Math.max(vHi, rHi);
  // A magnitude that sits near zero keeps the zero baseline; a process value (°C, bar) gets a tight scale.
  if (yMin == null && lo >= 0 && lo <= 0.35 * top) lo = 0;
  const nice = niceRange(yMin ?? lo, yMax ?? top);
  const y0 = yMin ?? nice.min;
  const y1 = yMax != null && yMax > y0 ? yMax : Math.max(nice.max, y0 + nice.step);
  // A fixed bound can leave the data-driven ticks outside [y0, y1]: tick the final extent instead.
  const scale = yMin != null || yMax != null ? niceRange(y0, y1) : nice;
  const ticks = scale.ticks.filter((t) => t >= y0 - scale.step * 1e-6 && t <= y1 + scale.step * 1e-6);
  const dec = stepDecimals(scale.step);
  const fmtTick = formatValue ?? ((v: number) => numFmt(dec, dec).format(v));
  const fmt = formatValue ?? fmtAuto;
  const pad = { l: Math.max(36, Math.max(...ticks.map((t) => fmtTick(t).length), (unit ?? '').length) * 6.2 + 12), r: 10, t: 20, b: 22 };
  const iw = Math.max(20, width - pad.l - pad.r);
  const ih = Math.max(20, height - pad.t - pad.b);
  const x = (t: number) => pad.l + ((t - from) / span) * iw;
  const y = (v: number) => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const colorOf = (s: TimeSeries, i: number) => s.color ?? `var(--series-${(i % 7) + 1})`;
  const steps = series.map((s) => medianStep(s.t, span));
  const readout = (s: TimeSeries, i: number, t: number) => {
    const v = sampleAt(s, t, steps[i]);
    return v === undefined ? 'no sample' : v === null ? 'no value' : withUnit(fmt(v), unit);
  };
  const near = Math.max(span / 200, medianStep(times, span) / 2);
  const bandsAt = (t: number) => bands.filter((b) => t >= b.from && t <= b.to);
  const markersAt = (t: number) => markers.filter((m) => Math.abs(m.t - t) <= near);
  const describe = (k: number) => {
    const t = times[k];
    return [
      clk(t),
      ...series.map((s, i) => `${s.label} ${readout(s, i, t)}`),
      ...(tipRows?.(t) ?? []).map((r) => `${r.label} ${r.value}`),
      ...bandsAt(t).map((b) => b.label),
      ...markersAt(t).map((m) => m.label),
    ].join(' · ');
  };
  const move = (k: number) => {
    setHi(k);
    setLive(describe(k));
  };
  // Reference labels sit above their line, or below it when they would collide with the previous one.
  let lastLabelY = -Infinity;
  const refLabels = refs
    .filter((r) => r.value >= y0 && r.value <= y1)
    .map((r) => ({ r, y: y(r.value) }))
    .sort((a, b) => a.y - b.y)
    .map((l) => {
      const ly = l.y - 4 - lastLabelY < 11 ? l.y + 12 : l.y - 4;
      lastLabelY = ly;
      return { ...l, ly };
    });
  const clip = (a: number, b: number) => [Math.max(from, a), Math.min(to, b)] as const;
  const tc = hi != null ? times[hi] : null;
  return (
    <div className="chart" ref={ref}>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s, i) => (
            <span key={s.id}>
              <i className={s.dashed ? 'dash' : 'line'} style={{ background: colorOf(s, i), borderColor: colorOf(s, i) }} />
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
          aria-label={label}
          tabIndex={0}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const t = from + ((e.clientX - r.left - pad.l) / iw) * span;
            setHi(t < from - span * 0.02 || t > to + span * 0.02 ? null : nearestIndex(times, t));
          }}
          onMouseLeave={() => setHi(null)}
          onFocus={(e) => keyboardFocus(e.currentTarget) && move(times.length - 1)}
          onBlur={() => setHi(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') return setHi(null);
            const k = navIndex(e.key, hi ?? times.length - 1, times.length);
            if (k == null) return;
            e.preventDefault();
            move(k);
          }}
        >
          <defs>
            <clipPath id={`${uid}-plot`}>
              <rect x={pad.l} y={pad.t - 3} width={iw} height={ih + 6} />
            </clipPath>
            {(['warning', 'critical', 'neutral'] as const)
              .filter((tone) => bands.some((b) => b.tone === tone))
              .map((tone) => (
                <pattern key={tone} id={`${uid}-band-${tone}`} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
                  <rect width={6} height={6} fill={BAND_COLOR[tone]} opacity={0.08} />
                  <rect width={2} height={6} fill={BAND_COLOR[tone]} opacity={0.24} />
                </pattern>
              ))}
          </defs>
          <g className="grid">
            {ticks.map((t) => (
              <line key={t} x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} />
            ))}
          </g>
          {ticks.map((t) => (
            <text key={t} x={pad.l - 6} y={y(t) + 3.5} textAnchor="end">
              {fmtTick(t)}
            </text>
          ))}
          {unit && (
            <text x={pad.l - 6} y={10} textAnchor="end">
              {unit}
            </text>
          )}
          {highlight &&
            (() => {
              const [a, b] = clip(highlight.from, highlight.to);
              return b > a ? (
                <g pointerEvents="none">
                  <rect x={x(a)} y={pad.t} width={x(b) - x(a)} height={ih} fill="var(--accent-soft)" />
                  <line x1={x(a)} x2={x(a)} y1={pad.t} y2={pad.t + ih} stroke="var(--accent-line)" />
                  <line x1={x(b)} x2={x(b)} y1={pad.t} y2={pad.t + ih} stroke="var(--accent-line)" />
                </g>
              ) : null;
            })()}
          {bands.map((b, i) => {
            const [a, bb] = clip(b.from, b.to);
            if (!(bb > a)) return null;
            const w = Math.max(1, x(bb) - x(a));
            return (
              <g key={`${b.from}-${i}`} pointerEvents="none">
                <rect x={x(a)} y={pad.t} width={w} height={ih} fill={`url(#${uid}-band-${b.tone})`} />
                <line x1={x(a)} x2={x(a)} y1={pad.t} y2={pad.t + ih} stroke={BAND_COLOR[b.tone]} strokeOpacity={0.5} strokeDasharray="2 2" />
                <line x1={x(a) + w} x2={x(a) + w} y1={pad.t} y2={pad.t + ih} stroke={BAND_COLOR[b.tone]} strokeOpacity={0.5} strokeDasharray="2 2" />
                {w > b.label.length * 6 + 10 && (
                  <text x={x(a) + 4} y={pad.t + 11} style={{ fill: 'var(--text-2)' }}>
                    {b.label}
                  </text>
                )}
              </g>
            );
          })}
          {refLabels.map(({ r, y: ry, ly }) => (
            <g key={`${r.kind}-${r.label}-${r.value}`} pointerEvents="none">
              <line x1={pad.l} x2={pad.l + iw} y1={ry} y2={ry} stroke={REF_STYLE[r.kind].stroke} strokeDasharray={REF_STYLE[r.kind].dash} strokeOpacity={0.85} />
              {/* The label names the line (target, limit, …): its colour is never the only cue. */}
              <text x={pad.l + iw} y={ly} textAnchor="end" style={{ fill: 'var(--text-2)', paintOrder: 'stroke', stroke: 'var(--bg-1)', strokeWidth: 3 }}>
                {r.label}
              </text>
            </g>
          ))}
          <g clipPath={`url(#${uid}-plot)`}>
            {series.map((s, i) => {
              const { d, dots } = seriesPath(s, x, y, steps[i], to);
              const c = colorOf(s, i);
              return (
                <g key={s.id}>
                  <path
                    data-series={s.id}
                    d={d}
                    fill="none"
                    stroke={c}
                    strokeWidth={2}
                    strokeDasharray={s.dashed ? '5 3' : undefined}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {dots.map(([cx, cy], k) => (
                    <circle key={k} cx={cx} cy={cy} r={2.5} fill={c} />
                  ))}
                </g>
              );
            })}
          </g>
          {markers
            .filter((m) => m.t >= from && m.t <= to)
            .map((m, i) => {
              const st = MARKER_STYLE[m.tone ?? 'neutral'];
              return (
                <g key={`${m.t}-${i}`} pointerEvents="none">
                  <line x1={x(m.t)} x2={x(m.t)} y1={pad.t} y2={pad.t + ih} stroke={st.color} strokeOpacity={0.7} strokeDasharray="2 3" />
                  <Shape kind={st.shape} cx={x(m.t)} cy={pad.t - 1} r={4} fill={st.color} />
                </g>
              );
            })}
          <TimeAxis from={from} to={to} x={x} y={pad.t + ih} left={pad.l} right={pad.l + iw} width={width} clock={clk} />
          {tc != null && (
            <g pointerEvents="none">
              <line x1={x(tc)} x2={x(tc)} y1={pad.t} y2={pad.t + ih} stroke="var(--line-3)" />
              {series.map((s, i) => {
                const v = sampleAt(s, tc, steps[i]);
                if (v == null || v < y0 || v > y1) return null;
                return <circle key={s.id} cx={x(tc)} cy={y(v)} r={4} fill={colorOf(s, i)} stroke="var(--bg-1)" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
        {tc != null && (
          <div className="chart-tip" style={{ left: Math.max(70, Math.min(width - 70, x(tc))), top: pad.t }}>
            <b>{clk(tc)}</b>
            {series.map((s, i) => (
              <TipRow key={s.id} k={s.label} v={readout(s, i, tc)} swatch={colorOf(s, i)} />
            ))}
            {(tipRows?.(tc) ?? []).map((r) => (
              <TipRow key={`x-${r.label}`} k={r.label} v={r.value} />
            ))}
            {bandsAt(tc).map((b, i) => (
              <div key={`b${i}`} className="note">
                <i style={{ background: BAND_COLOR[b.tone] }} />
                {b.label}
              </div>
            ))}
            {markersAt(tc).map((m, i) => (
              <div key={`m${i}`} className="note">
                <i style={{ background: MARKER_STYLE[m.tone ?? 'neutral'].color }} />
                {m.label}
              </div>
            ))}
          </div>
        )}
        <span className="chart-sr" aria-live="polite">
          {live}
        </span>
      </div>
    </div>
  );
}

// ── State timeline (lanes of state segments) ─────────────────────────────────

export type StateTone = 'good' | 'warning' | 'critical' | 'neutral' | 'planned' | 'unknown';
export type StatePattern = 'solid' | 'hatch' | 'dots';
export type StateLegendItem = { state: string; label: string; tone: StateTone; pattern?: StatePattern };
export type StateLane = { id: string; label: string; segments: { from: number; to: number; state: string; label?: string }[] };

const STATE_COLOR: Record<StateTone, string> = {
  good: 'var(--good)',
  warning: 'var(--warning)',
  critical: 'var(--critical)',
  neutral: 'var(--neutral)',
  planned: 'var(--planned)',
  unknown: 'var(--text-4)',
};
/** Default patterns: tones that could be confused without colour vision get different patterns. */
const STATE_PATTERN: Record<StateTone, StatePattern> = { good: 'solid', planned: 'solid', warning: 'hatch', neutral: 'hatch', critical: 'dots', unknown: 'dots' };
const PATTERNS: StatePattern[] = ['solid', 'hatch', 'dots'];

/** Fill patterns for the tone × pattern pairs in use (ids `${uid}-${tone}-${pattern}`), shared by the plot and the legend. */
function PatternDefs({ uid, styles }: { uid: string; styles: { tone: StateTone; pattern: StatePattern }[] }) {
  const seen = new Set<string>();
  return (
    <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden>
      <defs>
        {styles.map(({ tone, pattern }) => {
          const key = `${tone}-${pattern}`;
          if (pattern === 'solid' || seen.has(key)) return null;
          seen.add(key);
          const c = STATE_COLOR[tone];
          return pattern === 'hatch' ? (
            <pattern key={key} id={`${uid}-${key}`} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
              <rect width={6} height={6} fill={c} opacity={0.3} />
              <rect width={3} height={6} fill={c} />
            </pattern>
          ) : (
            <pattern key={key} id={`${uid}-${key}`} patternUnits="userSpaceOnUse" width={5} height={5}>
              <rect width={5} height={5} fill={c} />
              <circle cx={2.5} cy={2.5} r={1.2} fill="var(--bg-1)" />
            </pattern>
          );
        })}
      </defs>
    </svg>
  );
}

/**
 * Lanes of state segments on a time axis (one lane per asset, or one lane for a single asset).
 * Segments are coloured by tone and told apart by pattern, the legend names every state shown
 * (with the time in state for a single lane), and time without a record is shown as such.
 * Hover a segment, or focus the chart and use the arrows (Up / Down change lane), for the state,
 * its from–to and its duration.
 */
export function StateTimeline({
  label,
  from,
  to,
  lanes,
  legend,
  clock,
  laneHeight = 18,
  emptyReason,
}: {
  /** Accessible name of the chart. */
  label: string;
  from: number;
  to: number;
  lanes: StateLane[];
  legend: StateLegendItem[];
  clock?: Clock;
  laneHeight?: number;
  /** Shown when no lane has a segment in the range (default 'No state records in this range'). */
  emptyReason?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useUid();
  const [hover, setHover] = useState<Tip>(null);
  const [cur, setCur] = useState<{ l: number; s: number } | null>(null);
  const [live, setLive] = useState('');
  const span = Math.max(1e-6, to - from);
  const clk = clock ?? plantClock(span);
  const rows = lanes.map((ln) =>
    ln.segments
      .map((s) => ({ ...s, a: Math.max(from, s.from), b: Math.min(to, s.to) }))
      .filter((s) => s.b > s.a)
      .sort((p, q) => p.a - q.a),
  );
  if (!rows.some((r) => r.length))
    return (
      <div className="chart" ref={ref}>
        <ChartEmpty label={label} height={56} title={emptyReason ?? 'No state records in this range'} />
      </div>
    );

  // The caller's states, plus any unlisted state (shown by its raw name as 'unknown'). Explicit
  // patterns are taken first; a defaulted one moves on when its tone already uses that pattern.
  const items = [...legend];
  for (const r of rows) for (const s of r) if (!items.some((i) => i.state === s.state)) items.push({ state: s.state, label: s.state, tone: 'unknown' });
  const used = new Set(items.filter((i) => i.pattern).map((i) => `${i.tone}-${i.pattern}`));
  const style = new Map<string, { label: string; tone: StateTone; pattern: StatePattern }>();
  for (const it of items) {
    let pattern = it.pattern;
    if (!pattern) {
      const base = STATE_PATTERN[it.tone];
      pattern = [base, ...PATTERNS.filter((p) => p !== base)].find((p) => !used.has(`${it.tone}-${p}`)) ?? base;
      used.add(`${it.tone}-${pattern}`);
    }
    if (!style.has(it.state)) style.set(it.state, { label: it.label, tone: it.tone, pattern });
  }
  const fillOf = (state: string) => {
    const st = style.get(state)!;
    return st.pattern === 'solid' ? STATE_COLOR[st.tone] : `url(#${uid}-${st.tone}-${st.pattern})`;
  };
  type Seg = (typeof rows)[number][number];
  const nameOf = (s: Seg) => s.label ?? style.get(s.state)?.label ?? s.state;
  const totals = rows.map((r) => {
    const m = new Map<string, number>();
    for (const s of r) m.set(s.state, (m.get(s.state) ?? 0) + (s.b - s.a));
    return m;
  });
  const uncovered = totals.map((m) => span - [...m.values()].reduce((a, b) => a + b, 0));
  const multi = lanes.length > 1;
  const maxLen = Math.max(0, ...lanes.map((l) => l.label.length));
  const gutter = multi ? Math.min(150, Math.max(56, maxLen * 6.4 + 14)) : 0;
  const pad = { l: gutter + 1, r: 10, t: 4 };
  const gap = 6;
  const height = pad.t + lanes.length * (laneHeight + gap) - gap + 26;
  const iw = Math.max(20, width - pad.l - pad.r);
  const x = (t: number) => pad.l + ((t - from) / span) * iw;
  const laneY = (i: number) => pad.t + i * (laneHeight + gap);
  const tipOf = (l: number, s: Seg) => (
    <>
      <b>{nameOf(s)}</b>
      {multi && <TipRow k="Lane" v={lanes[l].label} />}
      <TipRow k="From – to" v={`${clk(s.from)}–${clk(s.to)}`} />
      <TipRow k="Duration" v={dur(s.to - s.from)} />
      {(s.from < from || s.to > to) && <div className="note">Continues beyond the range shown</div>}
    </>
  );
  const focusSeg = (l: number, si: number) => {
    const s = rows[l][si];
    setCur({ l, s: si });
    setLive(`${multi ? `${lanes[l].label}: ` : ''}${nameOf(s)}, ${clk(s.from)} to ${clk(s.to)}, ${dur(s.to - s.from)}`);
    setHover({ x: (x(s.a) + x(s.b)) / 2, y: laneY(l), content: tipOf(l, s) });
  };
  const first = () => {
    const l = rows.findIndex((r) => r.length);
    return { l, s: rows[l].length - 1 };
  };
  const summary = lanes
    .map((ln, l) => {
      const parts = [...totals[l].entries()].sort((a, b) => b[1] - a[1]).map(([st, min]) => `${style.get(st)!.label} ${dur(min)}`);
      if (uncovered[l] >= 1) parts.push(`no record ${dur(uncovered[l])}`);
      return `${ln.label}: ${parts.length ? parts.join(', ') : 'no record'}`;
    })
    .join('. ');
  const shown = [...style.entries()].filter(([st]) => totals.some((m) => m.has(st)));
  const c = cur && rows[cur.l]?.[cur.s] ? rows[cur.l][cur.s] : null;
  return (
    <div className="chart" ref={ref}>
      <PatternDefs uid={uid} styles={shown.map(([, st]) => st)} />
      <div style={{ position: 'relative' }} onMouseLeave={() => !cur && setHover(null)}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          aria-describedby={`${uid}-sum`}
          tabIndex={0}
          onFocus={(e) => {
            if (!keyboardFocus(e.currentTarget)) return;
            const f = first();
            focusSeg(f.l, f.s);
          }}
          onBlur={() => {
            setCur(null);
            setHover(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setCur(null);
              setHover(null);
              return;
            }
            // The cursor can go stale when live data replaces the segments: fall back to the first one.
            const at = cur && rows[cur.l]?.[cur.s] ? cur : first();
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const dir = e.key === 'ArrowDown' ? 1 : -1;
              const seg = rows[at.l][at.s];
              const mid = (seg.a + seg.b) / 2;
              for (let l = at.l + dir; l >= 0 && l < rows.length; l += dir) {
                if (!rows[l].length) continue;
                const hit = rows[l].findIndex((s) => s.a <= mid && s.b >= mid);
                focusSeg(l, hit >= 0 ? hit : nearestIndex(rows[l].map((s) => s.a), mid));
                return;
              }
              return;
            }
            const k = navIndex(e.key, at.s, rows[at.l].length);
            if (k == null) return;
            e.preventDefault();
            focusSeg(at.l, k);
          }}
        >
          {lanes.map((ln, l) => (
            <g key={ln.id}>
              {multi && (
                <text x={gutter - 8} y={laneY(l) + laneHeight / 2 + 4} textAnchor="end" style={{ fill: 'var(--text-2)' }}>
                  {ln.label.length > (gutter - 14) / 6.4 ? `${ln.label.slice(0, Math.max(3, Math.floor((gutter - 14) / 6.4) - 1))}…` : ln.label}
                </text>
              )}
              <rect
                x={pad.l}
                y={laneY(l)}
                width={iw}
                height={laneHeight}
                rx={2}
                fill="var(--bg-3)"
                onMouseMove={(e) => {
                  const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                  if (!box) return;
                  const t = from + ((e.clientX - box.left - pad.l) / iw) * span;
                  setHover({
                    x: e.clientX - box.left,
                    y: laneY(l),
                    content: (
                      <>
                        <b>No state recorded</b>
                        {multi && <TipRow k="Lane" v={ln.label} />}
                        <TipRow k="At" v={clk(t)} />
                      </>
                    ),
                  });
                }}
              />
              {rows[l].map((s, si) => {
                const w = x(s.b) - x(s.a);
                return (
                  <rect
                    key={`${s.a}-${si}`}
                    x={x(s.a)}
                    y={laneY(l)}
                    width={Math.max(1, w >= 4 ? w - 1 : w)}
                    height={laneHeight}
                    rx={w > 6 ? 2 : 0}
                    fill={fillOf(s.state)}
                    onMouseMove={() => setHover({ x: (x(s.a) + x(s.b)) / 2, y: laneY(l), content: tipOf(l, s) })}
                  />
                );
              })}
            </g>
          ))}
          {c && cur && (
            <rect
              x={x(c.a) - 1.5}
              y={laneY(cur.l) - 1.5}
              width={Math.max(1, x(c.b) - x(c.a)) + 3}
              height={laneHeight + 3}
              rx={3}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}
          <TimeAxis from={from} to={to} x={x} y={height - 24} left={pad.l} right={pad.l + iw} width={width} clock={clk} />
        </svg>
        <Tooltip tip={hover} />
        <span className="chart-sr" aria-live="polite">
          {live}
        </span>
      </div>
      <p id={`${uid}-sum`} className="chart-sr">
        {summary}
      </p>
      <div className="chart-legend chart-legend-below">
        {shown.map(([st, s]) => (
          <span key={st}>
            <svg className="sw" width={12} height={12} aria-hidden>
              <rect width={12} height={12} rx={2} fill={fillOf(st)} />
            </svg>
            {s.label}
            {!multi && <b className="num">{dur(totals[0].get(st) ?? 0)}</b>}
          </span>
        ))}
        {uncovered.some((m) => m >= 1) && (
          <span>
            <svg className="sw" width={12} height={12} aria-hidden>
              <rect width={12} height={12} rx={2} fill="var(--bg-3)" stroke="var(--line-3)" />
            </svg>
            No record
            {!multi && <b className="num">{dur(uncovered[0])}</b>}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Histogram ────────────────────────────────────────────────────────────────

export type HistogramBin = { from: number; to: number; count: number };
export type HistogramMarker = { value: number; label: string; kind: 'target' | 'p50' | 'p90' | 'mean' };

const HIST_MARK: Record<HistogramMarker['kind'], { stroke: string; dash?: string }> = {
  target: { stroke: 'var(--text-1)', dash: '3 3' },
  p50: { stroke: 'var(--text-2)' },
  p90: { stroke: 'var(--text-2)', dash: '5 3' },
  mean: { stroke: 'var(--accent)', dash: '1 3' },
};

/**
 * Distribution of a measure (cycle time, stop duration) as adjacent bins with the sample count
 * stated ('n = N'). Below `minSamples` it shows an insufficient-samples state instead of a shape
 * that would mean nothing. Markers (target, P50, P90, mean) are labelled lines.
 */
export function Histogram({
  label,
  bins,
  unit,
  n,
  markers = [],
  minSamples = 20,
  height = 180,
  formatValue,
}: {
  /** Accessible name of the chart. */
  label: string;
  bins: HistogramBin[];
  unit: string;
  /** Samples behind the bins. */
  n: number;
  markers?: HistogramMarker[];
  minSamples?: number;
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Tip>(null);
  const valid = bins.filter((b) => Number.isFinite(b.from) && Number.isFinite(b.to) && b.to > b.from && b.count >= 0).sort((a, b) => a.from - b.from);
  const binW = valid.length ? valid[0].to - valid[0].from : null;
  const even = binW != null && valid.every((b) => Math.abs(b.to - b.from - binW) < 1e-9 * Math.max(1, binW));
  // Edges need the decimals of the bin width and of the first edge (bins of 2 from 12.5 → 12.5, 14.5, …).
  const edgeDec = binW != null ? Math.min(3, Math.max(stepDecimals(binW), stepDecimals(Math.abs(valid[0].from)))) : 1;
  const fmtX = formatValue ?? ((v: number) => numFmt(0, edgeDec).format(v));
  const meta = (
    <div className="chart-meta">
      <b className="num">{`n = ${numFmt(0, 0).format(Math.max(0, n))}`}</b>
      {even && binW != null && <span>{`bins of ${withUnit(fmtX(binW), unit)}`}</span>}
    </div>
  );
  // A few samples are 'not enough' even when no bin survived validation (the header already states n).
  if (n > 0 && n < minSamples)
    return (
      <div className="chart" ref={ref}>
        {meta}
        <ChartEmpty label={label} height={height} title="Not enough samples for a distribution">
          {`At least ${minSamples} samples are needed; this range has ${n}.`}
        </ChartEmpty>
      </div>
    );
  if (!(n > 0) || !valid.length)
    return (
      <div className="chart" ref={ref}>
        {meta}
        <ChartEmpty label={label} height={height} title="No samples in this range" />
      </div>
    );

  const marks = markers.filter((m) => Number.isFinite(m.value));
  const lo = Math.min(valid[0].from, ...marks.map((m) => m.value));
  const hiX = Math.max(valid[valid.length - 1].to, ...marks.map((m) => m.value));
  const { top, ticks } = niceScale(Math.max(1, ...valid.map((b) => b.count)));
  const yTicks = ticks.filter((t) => Number.isInteger(t));
  const pad = { l: Math.max(30, Math.max(...yTicks.map((t) => numFmt(0, 0).format(t).length)) * 6.2 + 12), r: 12, t: marks.length ? 32 : 8, b: 22 };
  const iw = Math.max(20, width - pad.l - pad.r);
  const ih = Math.max(20, height - pad.t - pad.b);
  const x = (v: number) => pad.l + ((v - lo) / Math.max(1e-9, hiX - lo)) * iw;
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const edges = [valid[0].from, ...valid.map((b) => b.to)];
  const every = Math.ceil(edges.length / Math.max(2, Math.floor(iw / 48)));
  const shownEdges = edges.filter((_, i) => i % every === 0);
  // Marker labels on two rows so neighbours do not collide.
  const rowEnd = [-Infinity, -Infinity];
  const placed = [...marks]
    .sort((a, b) => a.value - b.value)
    .map((m) => {
      const px = x(m.value);
      const half = m.label.length * 3.2 + 4;
      const row = rowEnd[0] <= px - half ? 0 : rowEnd[1] <= px - half ? 1 : 0;
      rowEnd[row] = px + half;
      return { m, px, row };
    });
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {meta}
      <div style={{ position: 'relative' }}>
        <svg width={width} height={height} role="img" aria-label={label}>
          <g className="grid">
            {yTicks.map((t) => (
              <line key={t} x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} />
            ))}
          </g>
          {yTicks.map((t) => (
            <text key={t} x={pad.l - 6} y={y(t) + 3.5} textAnchor="end">
              {numFmt(0, 0).format(t)}
            </text>
          ))}
          {valid.map((b, i) => {
            const x0 = x(b.from);
            const w = Math.max(1, x(b.to) - x0);
            const share = b.count / n;
            return (
              <g
                key={`${b.from}-${i}`}
                onMouseMove={() =>
                  setHover({
                    x: x0 + w / 2,
                    y: y(b.count),
                    content: (
                      <>
                        <b>
                          {fmtX(b.from)}–{withUnit(fmtX(b.to), unit)}
                        </b>
                        <TipRow k="Samples" v={numFmt(0, 0).format(b.count)} />
                        <TipRow k="Share of n" v={`${(share * 100).toFixed(1)} %`} />
                      </>
                    ),
                  })
                }
              >
                <rect x={x0} y={pad.t} width={w} height={ih} fill="transparent" />
                <path d={barPath(x0 + (w > 4 ? 1 : 0), y(b.count), Math.max(1, w > 4 ? w - 2 : w), y(0) - y(b.count))} fill="var(--series-1)" />
              </g>
            );
          })}
          {placed.map(({ m, px, row }) => (
            <g key={`${m.kind}-${m.value}`} pointerEvents="none">
              <line x1={px} x2={px} y1={pad.t - (row === 0 ? 20 : 8)} y2={pad.t + ih} stroke={HIST_MARK[m.kind].stroke} strokeDasharray={HIST_MARK[m.kind].dash} strokeWidth={1.5} />
              <text x={px} y={row === 0 ? 10 : 22} textAnchor={anchorFor(px, m.label, width)} style={{ fill: 'var(--text-2)' }}>
                {m.label}
              </text>
            </g>
          ))}
          <line className="baseline" x1={pad.l} x2={pad.l + iw} y1={y(0)} y2={y(0)} />
          {shownEdges.map((e, i) => (
            <text key={e} x={x(e)} y={height - 6} textAnchor={i === shownEdges.length - 1 && x(e) > width - 30 ? 'end' : 'middle'}>
              {i === shownEdges.length - 1 ? withUnit(fmtX(e), unit) : fmtX(e)}
            </text>
          ))}
        </svg>
        <Tooltip tip={hover} />
      </div>
    </div>
  );
}

// ── Event strip ──────────────────────────────────────────────────────────────

export type StripEvent = {
  id: string;
  t: number;
  /** End of a duration event; null = still open (drawn to the end of the range); undefined = an instant. */
  end?: number | null;
  label: string;
  severity: 'info' | 'warning' | 'serious' | 'critical';
  kind?: string;
};

const SEVERITY_MARK: Record<StripEvent['severity'], { word: string; color: string; shape: ShapeKind }> = {
  info: { word: 'Info', color: 'var(--neutral)', shape: 'circle' },
  warning: { word: 'Warning', color: 'var(--warning)', shape: 'triangle' },
  serious: { word: 'Serious', color: 'var(--serious)', shape: 'diamond' },
  critical: { word: 'Critical', color: 'var(--critical)', shape: 'square' },
};
const SEVERITY_ORDER: StripEvent['severity'][] = ['critical', 'serious', 'warning', 'info'];

/**
 * Events on a time axis: a severity shape (circle info · triangle warning · diamond serious ·
 * square critical) at the start, a bar for the duration when the event has one, and a tooltip.
 * Overlapping events stack on up to four rows. With `onSelect` the markers are keyboard controls
 * (one Tab stop; Left / Right move between events, Enter / Space selects).
 */
export function EventStrip({
  label,
  from,
  to,
  events,
  onSelect,
  clock,
  emptyReason,
}: {
  /** Accessible name of the strip. */
  label: string;
  from: number;
  to: number;
  events: StripEvent[];
  onSelect?: (id: string) => void;
  clock?: Clock;
  /** Shown when no event falls in the range (default 'No events recorded in this range'). */
  emptyReason?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useUid();
  const [hover, setHover] = useState<Tip>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [rov, setRov] = useState<string | null>(null);
  const nodes = useRef(new Map<string, SVGGElement>());
  const span = Math.max(1e-6, to - from);
  const clk = clock ?? plantClock(span);
  const vis = events
    .filter((e) => Number.isFinite(e.t) && e.t <= to && (e.end === null || (e.end ?? e.t) >= from))
    .sort((a, b) => a.t - b.t);
  if (!vis.length)
    return (
      <div className="chart" ref={ref}>
        <ChartEmpty label={label} height={56} title={emptyReason ?? 'No events recorded in this range'} />
      </div>
    );

  const pad = { l: 8, r: 10, t: 4 };
  const rowH = 18;
  const iw = Math.max(20, width - pad.l - pad.r);
  const x = (t: number) => pad.l + ((t - from) / span) * iw;
  const rowEnd: number[] = [];
  const placed = vis.map((e) => {
    const a = Math.max(from, e.t);
    const b = e.end === null ? to : e.end != null ? Math.min(to, Math.max(e.end, a)) : a;
    const x0 = x(a) - 7;
    let row = rowEnd.findIndex((end) => end <= x0);
    if (row < 0) row = rowEnd.length < 4 ? rowEnd.length : rowEnd.indexOf(Math.min(...rowEnd));
    rowEnd[row] = Math.max(x(b), x(a)) + 7;
    return { e, a, b, row };
  });
  const height = pad.t + Math.max(1, rowEnd.length) * rowH + 26;
  const stop = vis.some((e) => e.id === rov) ? rov : vis[vis.length - 1].id;
  const hasDur = (e: StripEvent) => e.end != null && e.end > e.t;
  const nameOf = (e: StripEvent) => {
    const tail = e.end === null ? ', ongoing' : hasDur(e) ? `, ${dur(e.end! - e.t)}` : '';
    return `${clk(e.t)} · ${SEVERITY_MARK[e.severity].word}: ${e.label}${e.kind ? ` (${e.kind})` : ''}${tail}`;
  };
  const tipOf = (e: StripEvent) => (
    <>
      <b>{e.label}</b>
      <TipRow k="Severity" v={SEVERITY_MARK[e.severity].word} />
      <TipRow k="Time" v={hasDur(e) ? `${clk(e.t)}–${clk(e.end!)}` : clk(e.t)} />
      {hasDur(e) && <TipRow k="Duration" v={dur(e.end! - e.t)} />}
      {e.end === null && <TipRow k="Status" v="Ongoing" />}
      {e.kind && <TipRow k="Kind" v={e.kind} />}
    </>
  );
  const counts = SEVERITY_ORDER.map((s) => [s, vis.filter((e) => e.severity === s).length] as const).filter(([, c]) => c > 0);
  const summary = `${vis.length} ${vis.length === 1 ? 'event' : 'events'}: ${counts.map(([s, c]) => `${c} ${SEVERITY_MARK[s].word.toLowerCase()}`).join(', ')}`;
  return (
    <div className="chart" ref={ref}>
      <div style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} role={onSelect ? 'group' : 'img'} aria-label={label} aria-describedby={`${uid}-sum`}>
          {Array.from({ length: Math.max(1, rowEnd.length) }, (_, r) => (
            <line key={r} x1={pad.l} x2={pad.l + iw} y1={pad.t + r * rowH + rowH / 2} y2={pad.t + r * rowH + rowH / 2} stroke="var(--chart-grid)" aria-hidden />
          ))}
          {placed.map(({ e, a, b, row }, idx) => {
            const m = SEVERITY_MARK[e.severity];
            const cy = pad.t + row * rowH + rowH / 2;
            const xa = x(a);
            const xb = x(b);
            const show = () => setHover({ x: xa, y: cy - 8, content: tipOf(e) });
            const hit = { x: xa - 8, y: cy - 9, width: Math.max(16, xb - xa + 16), height: 18 };
            return (
              <g
                key={e.id}
                ref={(el) => {
                  if (el) nodes.current.set(e.id, el);
                  else nodes.current.delete(e.id);
                }}
                onMouseMove={show}
                onClick={onSelect ? () => onSelect(e.id) : undefined}
                style={{ cursor: onSelect ? 'pointer' : undefined, outline: 'none' }}
                {...(onSelect
                  ? {
                      role: 'button',
                      tabIndex: e.id === stop ? 0 : -1,
                      'aria-label': nameOf(e),
                      onKeyDown: (ev: KeyboardEvent<SVGGElement>) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          onSelect(e.id);
                          return;
                        }
                        const k = navIndex(ev.key, idx, placed.length);
                        if (k == null) return;
                        ev.preventDefault();
                        const id = placed[k].e.id;
                        setRov(id);
                        nodes.current.get(id)?.focus();
                      },
                      onFocus: (ev: FocusEvent<SVGGElement>) => {
                        setRov(e.id);
                        if (keyboardFocus(ev.currentTarget)) setFocused(e.id);
                        show();
                      },
                      onBlur: () => {
                        setFocused((f) => (f === e.id ? null : f));
                        setHover(null);
                      },
                    }
                  : {})}
              >
                <rect {...hit} fill="transparent" />
                {xb > xa + 0.5 && (
                  <rect
                    x={xa}
                    y={cy - 3}
                    width={xb - xa}
                    height={6}
                    rx={3}
                    fill={m.color}
                    fillOpacity={e.end === null ? 0.25 : 0.5}
                    stroke={e.end === null ? m.color : undefined}
                    strokeDasharray={e.end === null ? '3 2' : undefined}
                  />
                )}
                <Shape kind={m.shape} cx={xa} cy={cy} r={4.5} fill={m.color} />
                {focused === e.id && <rect {...hit} rx={3} fill="none" stroke="var(--accent)" strokeWidth={1.5} pointerEvents="none" />}
              </g>
            );
          })}
          <TimeAxis from={from} to={to} x={x} y={height - 24} left={pad.l} right={pad.l + iw} width={width} clock={clk} />
        </svg>
        <Tooltip tip={hover} />
      </div>
      <p id={`${uid}-sum`} className="chart-sr">
        {summary}
      </p>
      <div className="chart-legend chart-legend-below" aria-hidden>
        {counts.map(([s, c]) => (
          <span key={s}>
            <svg className="sw" width={12} height={12}>
              <Shape kind={SEVERITY_MARK[s].shape} cx={6} cy={6} r={4} fill={SEVERITY_MARK[s].color} />
            </svg>
            {SEVERITY_MARK[s].word}
            <b className="num">{c}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Scatter ──────────────────────────────────────────────────────────────────

export type ScatterPoint = { x: number; y: number; label?: string };

/**
 * Paired samples of two measures on linear scales. No trend line is fitted (an invented fit
 * would suggest a relationship the data may not support); below `minPoints` it shows an
 * insufficient-data state. Hover (nearest point within 24 px) or keyboard focus (arrows) reads a point.
 */
export function ScatterChart({
  label,
  points,
  xLabel,
  yLabel,
  xUnit,
  yUnit,
  minPoints = 8,
  note,
  height = 220,
  formatX,
  formatY,
}: {
  /** Accessible name of the chart. */
  label: string;
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  xUnit: string;
  yUnit: string;
  minPoints?: number;
  /** A caption under the chart (e.g. what a pattern does and does not show). */
  note?: string;
  height?: number;
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const [live, setLive] = useState('');
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x || a.y - b.y);
  const caption = note ? <p className="chart-note">{note}</p> : null;
  if (pts.length < minPoints)
    return (
      <div className="chart" ref={ref}>
        <ChartEmpty label={label} height={height} title="Not enough paired samples">
          {`${pts.length} paired ${pts.length === 1 ? 'sample' : 'samples'} of ${xLabel} and ${yLabel}; at least ${minPoints} are needed to show a relationship.`}
        </ChartEmpty>
        {caption}
      </div>
    );

  const xs = niceRange(...extent(pts.map((p) => p.x)));
  const ys = niceRange(...extent(pts.map((p) => p.y)));
  const xDec = stepDecimals(xs.step);
  const yDec = stepDecimals(ys.step);
  const tickX = formatX ?? ((v: number) => numFmt(xDec, xDec).format(v));
  const tickY = formatY ?? ((v: number) => numFmt(yDec, yDec).format(v));
  const fx = formatX ?? fmtAuto;
  const fy = formatY ?? fmtAuto;
  const pad = { l: Math.max(36, Math.max(...ys.ticks.map((t) => tickY(t).length)) * 6.2 + 12), r: 12, t: 22, b: 38 };
  const iw = Math.max(20, width - pad.l - pad.r);
  const ih = Math.max(20, height - pad.t - pad.b);
  const x = (v: number) => pad.l + ((v - xs.min) / (xs.max - xs.min)) * iw;
  const y = (v: number) => pad.t + ih - ((v - ys.min) / (ys.max - ys.min)) * ih;
  const every = iw / xs.ticks.length < 44 ? 2 : 1;
  const axisTitle = (l: string, u: string) => (u ? `${l} (${u})` : l);
  const describe = (p: ScatterPoint) => `${p.label ? `${p.label}: ` : ''}${xLabel} ${withUnit(fx(p.x), xUnit)}, ${yLabel} ${withUnit(fy(p.y), yUnit)}`;
  const move = (k: number) => {
    setHi(k);
    setLive(describe(pts[k]));
  };
  const p = hi != null ? pts[hi] : null;
  return (
    <div className="chart" ref={ref}>
      <div className="chart-meta">
        <b className="num">{`n = ${numFmt(0, 0).format(pts.length)}`}</b>
        <span>paired samples</span>
      </div>
      <div style={{ position: 'relative' }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const mx = e.clientX - r.left;
            const my = e.clientY - r.top;
            let best = -1;
            let bestD = 24 * 24;
            pts.forEach((q, i) => {
              const d = (x(q.x) - mx) ** 2 + (y(q.y) - my) ** 2;
              if (d <= bestD) {
                bestD = d;
                best = i;
              }
            });
            setHi(best >= 0 ? best : null);
          }}
          onMouseLeave={() => setHi(null)}
          onFocus={(e) => keyboardFocus(e.currentTarget) && move(0)}
          onBlur={() => setHi(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') return setHi(null);
            const k = navIndex(e.key, hi ?? 0, pts.length);
            if (k == null) return;
            e.preventDefault();
            move(k);
          }}
        >
          <g className="grid">
            {ys.ticks.map((t) => (
              <line key={`y${t}`} x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} />
            ))}
            {xs.ticks.map((t) => (
              <line key={`x${t}`} x1={x(t)} x2={x(t)} y1={pad.t} y2={pad.t + ih} />
            ))}
          </g>
          {ys.ticks.map((t) => (
            <text key={t} x={pad.l - 6} y={y(t) + 3.5} textAnchor="end">
              {tickY(t)}
            </text>
          ))}
          {xs.ticks.map((t, i) =>
            i % every === 0 ? (
              <text key={t} x={x(t)} y={pad.t + ih + 15} textAnchor="middle">
                {tickX(t)}
              </text>
            ) : null,
          )}
          <text x={0} y={10} style={{ fill: 'var(--text-2)' }}>
            {axisTitle(yLabel, yUnit)}
          </text>
          <text x={pad.l + iw} y={height - 4} textAnchor="end" style={{ fill: 'var(--text-2)' }}>
            {axisTitle(xLabel, xUnit)}
          </text>
          <line className="baseline" x1={pad.l} x2={pad.l + iw} y1={pad.t + ih} y2={pad.t + ih} />
          <line className="baseline" x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t + ih} />
          {pts.map((q, i) => (
            <circle key={i} cx={x(q.x)} cy={y(q.y)} r={4} fill="var(--series-1)" fillOpacity={0.85} stroke="var(--bg-1)" strokeWidth={1.5} />
          ))}
          {p && <circle cx={x(p.x)} cy={y(p.y)} r={6} fill="none" stroke="var(--text-1)" strokeWidth={1.5} pointerEvents="none" />}
        </svg>
        {p && (
          <div className="chart-tip" style={{ left: x(p.x), top: y(p.y) - 6 }}>
            {p.label && <b>{p.label}</b>}
            <TipRow k={xLabel} v={withUnit(fx(p.x), xUnit)} />
            <TipRow k={yLabel} v={withUnit(fy(p.y), yUnit)} />
          </div>
        )}
        <span className="chart-sr" aria-live="polite">
          {live}
        </span>
      </div>
      {caption}
    </div>
  );
}
