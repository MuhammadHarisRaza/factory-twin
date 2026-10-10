import { useLayoutEffect, useRef, useState } from 'react';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import type { CapacityStep } from './loss';

const COLOR: Record<CapacityStep['kind'], string> = {
  total: 'var(--series-1)',
  loss: 'var(--series-2)',
  neutral: 'var(--text-4)',
  gap: 'var(--series-2)',
};

export const WATERFALL_LEGEND = [
  { key: 'total', label: 'Capacity / output level', swatch: 'var(--series-1)' },
  { key: 'loss', label: 'Unplanned loss at the kiln', swatch: 'var(--series-2)' },
  { key: 'neutral', label: 'Not a loss (planned stops, in transit)', swatch: 'var(--text-4)' },
] as const;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTop(max: number) {
  if (!(max > 0)) return 1;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw)!;
  return Math.ceil(max / step) * step;
}

/**
 * Theoretical capacity → planned stops → losses at the kiln → fired → rejects → good output, then
 * the capacity gap (theoretical − good) as an outlined bar; the plan is a dashed reference line.
 * One axis, m². Bars are focusable and selectable (linked to the basis table).
 */
export function CapacityWaterfall({
  steps,
  plan,
  height = 250,
  selectedKey,
  onSelect,
}: {
  steps: CapacityStep[];
  plan: number;
  height?: number;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const theoretical = steps[0]?.value ?? 0;
  const top = niceTop(Math.max(1, theoretical, plan));
  const pad = { l: 50, r: 10, t: 16, b: 36 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const slot = iw / Math.max(1, steps.length);
  const bw = Math.min(56, slot * 0.6);
  const y = (v: number) => pad.t + ih - (Math.max(0, v) / top) * ih;
  const ticks = [0, top / 4, top / 2, (3 * top) / 4, top];

  let level = 0;
  const bars = steps.map((s) => {
    if (s.kind === 'total') {
      level = s.value;
      return { s, lo: 0, hi: s.value };
    }
    if (s.kind === 'gap') return { s, lo: level, hi: theoretical };
    const next = level - s.value;
    const b = { s, lo: Math.min(level, next), hi: Math.max(level, next) };
    level = next;
    return b;
  });

  const tipBar = hover != null ? bars[hover] : null;
  const tipX = hover != null ? Math.min(Math.max(pad.l + hover * slot + slot / 2, 150), width - 150) : 0;

  return (
    <div className="chart prod-wf" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="group" aria-label="Capacity waterfall, square metres">
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        {ticks.map((t) => (
          <text key={t} x={pad.l - 6} y={y(t) + 3.5} textAnchor="end">
            {fmtInt(t)}
          </text>
        ))}
        <text x={pad.l - 6} y={pad.t - 6} textAnchor="end">
          m²
        </text>
        {bars.map((b, i) => {
          const cx = pad.l + i * slot + slot / 2;
          const x = cx - bw / 2;
          const yTop = y(b.hi);
          const h = Math.max(1, y(b.lo) - y(b.hi));
          const dim = selectedKey != null && selectedKey !== b.s.key;
          const sel = selectedKey === b.s.key;
          const [l1, l2] = b.s.label.split('\n');
          return (
            <g
              key={b.s.key}
              className="prod-wf-bar"
              role="button"
              tabIndex={0}
              aria-pressed={sel}
              aria-label={`${b.s.label.replace('\n', ' ')}: ${fmtInt(b.s.value)} m²`}
              opacity={dim ? 0.45 : 1}
              onMouseMove={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect(sel ? null : b.s.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(sel ? null : b.s.key);
                }
              }}
            >
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
              {b.s.kind === 'gap' ? (
                <rect x={x + 1} y={yTop} width={bw - 2} height={h} rx={2} fill="none" stroke={COLOR.gap} strokeWidth={2} strokeDasharray="4 3" />
              ) : (
                <rect x={x} y={yTop} width={bw} height={h} rx={2} fill={COLOR[b.s.kind]} />
              )}
              {sel && <rect x={x - 3} y={yTop - 3} width={bw + 6} height={h + 6} rx={3} fill="none" stroke="var(--text-1)" strokeWidth={1} />}
              {i < bars.length - 1 && b.s.kind !== 'gap' && bars[i + 1].s.kind !== 'gap' && (
                <line
                  x1={x + bw}
                  x2={x + slot}
                  y1={y(b.s.kind === 'total' ? b.hi : b.s.value >= 0 ? b.lo : b.hi)}
                  y2={y(b.s.kind === 'total' ? b.hi : b.s.value >= 0 ? b.lo : b.hi)}
                  stroke="var(--line-3)"
                  strokeDasharray="2 2"
                />
              )}
              <text x={cx} y={yTop - 5} textAnchor="middle" style={{ fill: 'var(--text-2)' }}>
                {b.s.kind === 'total' || b.s.kind === 'gap' ? fmtInt(b.s.value) : `${b.s.value >= 0 ? '−' : '+'}${fmtInt(Math.abs(b.s.value))}`}
              </text>
              <text x={cx} y={height - 20} textAnchor="middle">
                {l1}
              </text>
              {l2 && (
                <text x={cx} y={height - 7} textAnchor="middle">
                  {l2}
                </text>
              )}
            </g>
          );
        })}
        {plan > 0 && (
          <g aria-label={`Plan ${fmtInt(plan)} m²`}>
            <line x1={pad.l} x2={width - pad.r} y1={y(plan)} y2={y(plan)} stroke="var(--text-2)" strokeDasharray="5 4" strokeWidth={1.5} />
            <text x={width - pad.r} y={y(plan) - 5} textAnchor="end" style={{ fill: 'var(--text-1)' }}>
              Plan {fmtInt(plan)} m²
            </text>
          </g>
        )}
      </svg>
      {tipBar && (
        <div className="chart-tip prod-wf-tip" style={{ left: tipX, top: y(tipBar.hi) }}>
          <b>{tipBar.s.label.replace('\n', ' ')}</b>
          <div className="row">
            <span>{tipBar.s.kind === 'total' ? 'Level' : tipBar.s.kind === 'gap' ? 'Gap' : 'Step'}</span>
            <span>{fmtInt(tipBar.s.value)} m²</span>
          </div>
          <div className="row">
            <span>Share of theoretical</span>
            <span>{theoretical > 0 ? fmtPct(tipBar.s.value / theoretical, 1) : '—'}</span>
          </div>
          <p>{tipBar.s.basis}</p>
        </div>
      )}
    </div>
  );
}
