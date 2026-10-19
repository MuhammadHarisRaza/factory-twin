/**
 * Key figures: the context KPI set of the subject (equipmentKpis / vehicleKpis / stageKpis — the same
 * figures as the rest of the product), with its scope shown once in the heading. A parameter the
 * model does not contain is not a tile: it joins the panel's one "Not modelled" line. A status the
 * facets already state is not repeated on the tile. A tile whose figure has its own time context (a reading now,
 * the last 60 min) says it next to its label; the others follow the set's scope in the heading.
 *
 * Each tile is a hero tile (the approved card design): a coloured top strip by its status tone (warning and critical
 * also glow), the figure large with its unit, a mini sparkline where a simulated signal backs the figure (its history
 * over the panel's range), the status in words with its icon (never colour alone) and the comparison / context line.
 */
import { memo } from 'react';
import { sameProps } from '../../kit/equal';

import { formatClock } from '../../../sim/time';
import { Unavailable } from '../../kit/Page';
import type { EqKpi, EqKpiSet } from '../kpis';
import { STALE_ICON, TONE_ICON, isStaleWording } from './tone';

/** A tiny trend beside a hero figure, scaled to its own range (a temperature near 1,200 °C still shows its wiggle). Decorative: the figure carries the meaning. */
export const TileSpark = memo(function TileSpark({ values, width = 64, height = 28 }: { values: (number | null)[]; width?: number; height?: number }) {
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const vals = values.filter(ok);
  if (vals.length < 2) return null;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 3 - ((v - lo) / (hi - lo)) * (height - 6);
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (!ok(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    if (!pen && !ok(values[i + 1])) d += 'h0';
    pen = true;
  });
  return (
    <svg className="eqp-kpi-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden focusable="false">
      <path d={d} />
    </svg>
  );
});

/** The status a tile shows: its own, or for an alarm tile without an active code the honest words (never "no fault"). */
function tileStatus(k: EqKpi): EqKpi['status'] {
  if (k.status) return k.status;
  if (k.key === 'alarms' && k.sub && /^no active alarm code/i.test(k.sub)) return { tone: 'neutral', label: 'No active alarm code — not proof of no fault' };
  return null;
}

const Tile = memo(function Tile({ k, quiet, trend }: { k: EqKpi; quiet: boolean; trend?: (number | null)[] }) {
  const own = tileStatus(k);
  const status = own && !(quiet && own === k.status) ? own : null;
  const Icon = status ? (status.tone === 'neutral' && isStaleWording(status.label) ? STALE_ICON : TONE_ICON[status.tone]) : null;
  const tone = k.unavailable ? 'na' : (status?.tone ?? 'info');
  // The alarm tile's "no active alarm code now" is its status line; the sub line is not repeated.
  const sub = own && own !== k.status ? null : k.sub;
  return (
    <div className={`eqp-kpi t-${tone} ${k.unavailable ? 'na' : ''}`} title={k.unavailable ? `${k.unavailable}\n\n${k.hint}` : k.hint}>
      <span className="l">
        {k.label}
        {/* The tile's own time context when it differs from the set's scope (a reading "now", the last 60 min). */}
        {k.window && <span className="w"> · {k.window}</span>}
      </span>
      {k.unavailable ? (
        <b className="v na-v">
          <Unavailable reason={k.unavailable}>No data yet</Unavailable>
        </b>
      ) : (
        <div className="eqp-kpi-row">
          <b className="v num">
            {k.value}
            {k.unit && <small>{k.unit}</small>}
          </b>
          {trend && <TileSpark values={trend} />}
        </div>
      )}
      {status && Icon && (
        <span className={`s status ${status.tone}`}>
          <Icon size={11} strokeWidth={2.2} aria-hidden />
          {status.label}
        </span>
      )}
      {sub && <span className="sub">{sub}</span>}
      {k.unavailable && <span className="sub">{k.unavailable}</span>}
    </div>
  );
}, sameProps);

/** Tiles of a KPI set without its not-modelled parameters (those are listed with the signals). */
export const shownKpis = (set: EqKpiSet, omit: ReadonlySet<string> = new Set()) => set.kpis.filter((k) => !k.notModelled && !omit.has(k.key));

/** The KPI set's not-modelled parameters, as label + reason. */
export const notModelledKpis = (set: EqKpiSet) => set.kpis.filter((k) => k.notModelled).map((k) => ({ label: k.label, reason: k.unavailable ?? 'Not in the model' }));

export function MetricTiles({
  set,
  label,
  quiet = new Set(),
  omit = new Set(),
  trends,
}: {
  set: EqKpiSet;
  label: string;
  /** Status labels already stated elsewhere (the facets): not repeated on a tile. */
  quiet?: ReadonlySet<string>;
  /** Tile keys already shown elsewhere. */
  omit?: ReadonlySet<string>;
  /** Sparkline values per tile key (tiles a simulated signal backs). */
  trends?: Record<string, (number | null)[]>;
}) {
  const tiles = shownKpis(set, omit);
  return (
    <>
      {set.note && <p className="eqp-note">{set.note}</p>}
      {tiles.length > 0 && (
        <div className="eqp-kpis" role="group" aria-label={label} data-n={tiles.length}>
          {tiles.map((k) => (
            <Tile key={k.key} k={k} quiet={!!k.status && quiet.has(k.status.label.toLowerCase())} trend={trends?.[k.key]} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Heading meta of a KPI set: its scope, and — when a feed it rests on is stale — the not-confirmed mark.
 * When only the subject's own feed is stale (the header already says so) the mark is short.
 */
export function MetricsScope({ set, own }: { set: EqKpiSet; own?: string }) {
  if (set.stale) {
    const short = own != null && set.stale.assetIds.length === 1 && set.stale.assetIds[0] === own;
    return (
      <span className="eqp-sec-meta">
        {set.scope} ·{' '}
        <span className="eqp-stale" title={`${set.stale.label} — ${set.stale.note}`}>
          {short ? `not confirmed after ${formatClock(set.stale.since)}` : set.stale.label}
        </span>
      </span>
    );
  }
  if (set.staleSince != null)
    return (
      <span className="eqp-sec-meta">
        {set.scope} ·{' '}
        <span className="eqp-stale" title="Figures after that time are not confirmed by the feed">
          Not confirmed · data stale since {formatClock(set.staleSince)}
        </span>
      </span>
    );
  return <span className="eqp-sec-meta">{set.scope}</span>;
}
