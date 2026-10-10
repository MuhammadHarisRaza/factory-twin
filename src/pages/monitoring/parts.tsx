/** Small shared pieces of the Production Monitoring workspace (status lines, counting cells, markers). */
import { CircleHelp, CircleSlash, Hourglass, Landmark } from 'lucide-react';
import { openEvent } from '../../app/store';
import type { AlertSeverity, OpEvent } from '../../model/types';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { FeedStatusBadge, OperationalStatus, SeverityBadge, StatusBadge } from '../../ui/kit/Status';
import type { AssetView, CauseLine, CountCell, FeedView } from './derive';

/** Operational state of an asset, or an explicit "no state signal" for storage / docks. */
export function AssetState({ a, reading = false }: { a: AssetView; reading?: boolean }) {
  if (a.state == null)
    return reading && a.reading ? (
      <span className="muted mon-reading" title="No state signal — current reading from the simulated logistics state">
        {a.reading}
      </span>
    ) : (
      <StatusBadge tone="neutral" icon={CircleSlash} label="No state signal" />
    );
  return <OperationalStatus state={a.state} />;
}

/** Asset id + state on one line (overview cells, lists). */
export function AssetLine({ a }: { a: AssetView }) {
  return (
    <span className="mon-asset" title={`${a.id} · ${a.name}`}>
      <span className="mono">{a.id}</span>
      <AssetState a={a} reading />
    </span>
  );
}

/** Data-feed status: "Simulated" while the simulated link updates, "Stale since hh:mm" when it froze. Never "Live". */
export function FeedBadge({ feed }: { feed: FeedView }) {
  if (feed.status === 'stale') return <StatusBadge tone="warning" icon={CircleHelp} label={feed.label} />;
  return <FeedStatusBadge status="simulated" />;
}

/** Marker on a stage count while one of its assets' data feeds is stale. */
export function StaleFeeds({ assets }: { assets: AssetView[] }) {
  const ids = assets.map((a) => a.id).join(', ');
  return (
    <span title={`Data feed stale: ${assets.map((a) => `${a.id} ${a.feed.label.toLowerCase()}`).join('; ')}. Its state is unknown and its counter frozen; the stage count still includes its simulated output.`}>
      <StatusBadge tone="warning" icon={CircleHelp} label={`Feed stale · ${ids}`} size={12} />
    </span>
  );
}

/** A counted quantity: value + unit, "not measured" with the counting point's note, or "—" when the stage has no such counting point. */
export function Count({ cell, compact = false }: { cell: CountCell | null; compact?: boolean }) {
  if (!cell) return <span className="muted" title="No counting point for this quantity at this stage">—</span>;
  if (!cell.measured)
    return (
      <span className="mon-nm" title={cell.note ?? 'No counting point configured'}>
        Not measured
        {!compact && cell.note && <small>{cell.note}</small>}
      </span>
    );
  return (
    <span className="num" title={`${cell.label}${cell.signalId ? ` · ${cell.signalId}` : ''}`}>
      {fmtInt(cell.value)} <span className="muted">{cell.unit}</span>
    </span>
  );
}

export function BottleneckTag({ label = 'Bottleneck' }: { label?: string }) {
  return (
    <span className="tag mon-bn" title="Current bottleneck of the line (traced from the kiln over the last 120 min)">
      <Hourglass size={11} aria-hidden /> {label}
    </span>
  );
}

export function ConstraintTag() {
  return (
    <span className="tag" title="Designed line constraint — line OEE and capacity are measured here">
      <Landmark size={11} aria-hidden /> Design constraint
    </span>
  );
}

const HELD_WORD = { starved: 'Starved', blocked: 'Blocked' } as const;

/**
 * Inferred cause, kept visibly apart from the observed state: shown only when the event engine linked
 * the stage's starvation / blockage to a root event.
 */
export function CauseText({ cause, stop = false }: { cause: CauseLine; stop?: boolean }) {
  return (
    <span className="mon-cause">
      <span className="tag" title="Inference from correlated states and buffer levels — not directly observed">
        {cause.confidence === 'confirmed' ? 'confirmed' : `inferred · ${cause.confidence}`}
      </span>
      <span>
        {HELD_WORD[cause.held]} — {cause.confidence === 'confirmed' ? 'because' : 'likely because'}{' '}
        <button
          className="row-link"
          title={`Open ${cause.root.id} — the root event`}
          onClick={(e) => {
            if (stop) e.stopPropagation();
            openEvent(cause.root.id);
          }}
        >
          {cause.root.title}
        </button>
      </span>
    </span>
  );
}

/** Active events: count and worst severity. */
export function ActiveEvents({ events, worst }: { events: OpEvent[]; worst: AlertSeverity | null }) {
  if (!events.length) return <span className="muted">None</span>;
  return (
    <span className="mon-evcount">
      <b className="num">{events.length}</b>
      {worst && <SeverityBadge severity={worst} />}
    </span>
  );
}

/** Actual vs expected rate per hour. */
export function RateText({ actual, expected, unit }: { actual: number | null; expected: number | null; unit: string }) {
  if (actual == null) return <span className="muted">—</span>;
  const share = expected != null && expected > 0 ? actual / expected : null;
  return (
    <span className="num" title={expected != null ? 'Expected = ideal rate × planned running time (planned stops excluded)' : 'No expected rate configured for this stage'}>
      {fmtInt(actual)}
      {expected != null ? <span className="muted"> / {fmtInt(expected)}</span> : null} <span className="muted">{unit}/h</span>
      {share != null && <span className="mon-share"> {fmtPct(share, 0)}</span>}
    </span>
  );
}
