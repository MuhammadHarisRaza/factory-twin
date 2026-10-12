/**
 * Key figures: the context KPI set of the subject (equipmentKpis / vehicleKpis / stageKpis — the same
 * figures as the rest of the product), with its scope shown once in the heading. A parameter the
 * model does not contain is not a tile: it joins the panel's one "Not modelled" line. A status the
 * facets already state is not repeated on the tile.
 */
import { formatClock } from '../../../sim/time';
import { Unavailable } from '../../kit/Page';
import type { EqKpi, EqKpiSet } from '../kpis';
import { STALE_ICON, TONE_ICON, isStaleWording } from './tone';

function Tile({ k, quiet }: { k: EqKpi; quiet: boolean }) {
  const status = k.status && !quiet ? k.status : null;
  const Icon = status ? (status.tone === 'neutral' && isStaleWording(status.label) ? STALE_ICON : TONE_ICON[status.tone]) : null;
  return (
    <div className={`eqp-kpi ${k.unavailable ? 'na' : ''}`} title={k.unavailable ? `${k.unavailable}\n\n${k.hint}` : k.hint}>
      <span className="l">{k.label}</span>
      {k.unavailable ? (
        <b className="v na-v">
          <Unavailable reason={k.unavailable}>No data yet</Unavailable>
        </b>
      ) : (
        <b className="v num">
          {k.value}
          {k.unit && <small>{k.unit}</small>}
        </b>
      )}
      {status && Icon && (
        <span className={`s status ${status.tone}`}>
          <Icon size={11} strokeWidth={2.2} aria-hidden />
          {status.label}
        </span>
      )}
      {k.sub && <span className="sub">{k.sub}</span>}
      {k.unavailable && <span className="sub">{k.unavailable}</span>}
    </div>
  );
}

/** Tiles of a KPI set without its not-modelled parameters (those are listed with the signals). */
export const shownKpis = (set: EqKpiSet, omit: ReadonlySet<string> = new Set()) => set.kpis.filter((k) => !k.notModelled && !omit.has(k.key));

/** The KPI set's not-modelled parameters, as label + reason. */
export const notModelledKpis = (set: EqKpiSet) => set.kpis.filter((k) => k.notModelled).map((k) => ({ label: k.label, reason: k.unavailable ?? 'Not in the model' }));

export function MetricTiles({
  set,
  label,
  quiet = new Set(),
  omit = new Set(),
}: {
  set: EqKpiSet;
  label: string;
  /** Status labels already stated elsewhere (the facets): not repeated on a tile. */
  quiet?: ReadonlySet<string>;
  /** Tile keys already shown elsewhere. */
  omit?: ReadonlySet<string>;
}) {
  const tiles = shownKpis(set, omit);
  return (
    <>
      {set.note && <p className="eqp-note">{set.note}</p>}
      {tiles.length > 0 && (
        <div className="eqp-kpis" role="group" aria-label={label}>
          {tiles.map((k) => (
            <Tile key={k.key} k={k} quiet={!!k.status && quiet.has(k.status.label.toLowerCase())} />
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
