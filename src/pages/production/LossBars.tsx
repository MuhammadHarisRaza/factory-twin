import { useRef, useState, type MouseEvent } from 'react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { STAGE_BY_ID } from '../../model/plant';
import { formatDuration } from '../../sim/time';
import { TipRow } from '../../ui/kit/charts';
import { fmtInt } from '../../ui/kit/format';
import type { MachineLoss } from './derive';

/** Loss components in fixed series order (starved / blocked match the bottleneck panel). */
export const LOSS_SEGMENTS = [
  { key: 'down', label: 'Unplanned downtime', color: 'var(--series-1)' },
  { key: 'starved', label: 'Starved', color: 'var(--series-2)' },
  { key: 'blocked', label: 'Blocked', color: 'var(--series-3)' },
] as const;

const segValues = (r: MachineLoss) => [r.downM2, r.starvedM2, r.blockedM2];
const segMinutes = (r: MachineLoss) => [r.downMin, r.starvedMin, r.blockedMin];

type Tip = { x: number; y: number; row: MachineLoss } | null;

/**
 * Ranked stacked bars: lost m² per machine split into unplanned downtime, starved and blocked
 * time. Every row opens the machine drill-down.
 */
export function LossBars({ rows, selectedKey, onSelect }: { rows: MachineLoss[]; selectedKey: string | null; onSelect: (id: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const max = Math.max(1e-9, ...rows.map((r) => r.totalM2));
  const total = rows.reduce((a, r) => a + r.totalM2, 0);

  const move = (e: MouseEvent<HTMLDivElement>, row: MachineLoss) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    setTip({ x: Math.min(Math.max(e.clientX - box.left, 90), box.width - 90), y: e.currentTarget.offsetTop, row });
  };

  return (
    <div className="prod-loss" ref={wrap} onMouseLeave={() => setTip(null)}>
      <div className="chart-legend">
        {LOSS_SEGMENTS.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div role="table" aria-label="Lost output by machine">
        <div className="prod-loss-row head" role="row">
          <span role="columnheader">Machine</span>
          <span role="columnheader" aria-hidden />
          <span role="columnheader" className="n">
            Lost m²
          </span>
          <span role="columnheader" className="n">
            Share
          </span>
        </div>
        {rows.map((r) => {
          const vals = segValues(r);
          return (
            <div
              key={r.id}
              role="row"
              tabIndex={0}
              aria-selected={selectedKey === r.id || undefined}
              className={`prod-loss-row ${selectedKey === r.id ? 'sel' : ''}`}
              onClick={() => onSelect(r.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(r.id);
                }
              }}
              onMouseMove={(e) => move(e, r)}
            >
              <span className="prod-loss-name" role="cell">
                <span className="mono">{r.id}</span>
                <span className="dim">{EQUIPMENT_BY_ID[r.id]?.name ?? r.id}</span>
              </span>
              <span className="prod-loss-track" role="cell" aria-label={LOSS_SEGMENTS.map((s, i) => `${s.label} ${fmtInt(vals[i])} m²`).join(', ')}>
                {vals.map((v, i) =>
                  v > 0 ? <i key={LOSS_SEGMENTS[i].key} style={{ width: `calc((100% - 4px) * ${v / max})`, background: LOSS_SEGMENTS[i].color }} /> : null,
                )}
              </span>
              <span className="n" role="cell">
                {fmtInt(r.totalM2)}
              </span>
              <span className="n muted" role="cell">
                {total > 0 ? `${Math.round((r.totalM2 / total) * 100)} %` : '—'}
              </span>
            </div>
          );
        })}
      </div>
      {tip && (
        <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
          <b>
            {tip.row.id} · {STAGE_BY_ID[tip.row.stage].name}
          </b>
          {LOSS_SEGMENTS.map((s, i) => (
            <TipRow key={s.key} k={s.label} v={`${fmtInt(segValues(tip.row)[i])} m² · ${formatDuration(segMinutes(tip.row)[i])}`} swatch={s.color} />
          ))}
          <TipRow k="Total lost" v={`${fmtInt(tip.row.totalM2)} m²`} />
        </div>
      )}
    </div>
  );
}
