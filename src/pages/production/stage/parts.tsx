/** Small shared pieces of the Production stage view (status lines, counting cells, markers). */
import { CircleHelp, CircleSlash, Hourglass, Landmark } from 'lucide-react';
import { openEvent } from '../../../app/store';
import { constraintPhrase } from '../../../intel/summary';
import type { AlertSeverity, OpEvent } from '../../../model/types';
import { fmtInt } from '../../../ui/kit/format';
import { ProvenanceBadge } from '../../../ui/kit/Page';
import { FeedStatusBadge, OperationalStatus, SeverityBadge, StatusBadge } from '../../../ui/kit/Status';
import type { AssetView, CauseLine, CountCell, FeedView, StageRow } from './derive';

/** Operational state of an asset, or an explicit "no state signal" for storage / docks. */
export function AssetState({ a, reading = false }: { a: AssetView; reading?: boolean }) {
  if (a.state == null)
    return reading && a.reading ? (
      <span className="muted stg-reading" title="No state signal — current reading from the simulated logistics state">
        {a.reading}
      </span>
    ) : (
      <StatusBadge tone="neutral" icon={CircleSlash} label="No state signal" />
    );
  return <OperationalStatus state={a.state} />;
}

/** Data-feed status: "Simulated" while the simulated link updates, "Stale since hh:mm" when it froze. Never "Live". */
export function FeedBadge({ feed }: { feed: FeedView }) {
  if (feed.status === 'stale') return <StatusBadge tone="warning" icon={CircleHelp} label={feed.label} />;
  return <FeedStatusBadge status="simulated" />;
}

/** A counted quantity: value + unit, "not measured" with the counting point's note, or "—" when the stage has no such counting point. */
export function Count({ cell, compact = false }: { cell: CountCell | null; compact?: boolean }) {
  if (!cell) return <span className="muted" title="No counting point for this quantity at this stage">—</span>;
  if (!cell.measured)
    return (
      <span className="stg-nm" title={cell.note ?? 'No counting point configured'}>
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

const HELD_WORD = { starved: 'Starved', blocked: 'Blocked' } as const;

/**
 * Inferred cause, kept visibly apart from the observed state: shown only when the event engine linked
 * the stage's starvation / blockage to a root event.
 */
export function CauseText({ cause, stop = false }: { cause: CauseLine; stop?: boolean }) {
  return (
    <span className="stg-cause">
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
    <span className="stg-evcount">
      <b className="num">{events.length}</b>
      {worst && <SeverityBadge severity={worst} />}
    </span>
  );
}

/**
 * The stage's constraint marker, from the shared claim (constraintClaim — the Overview's, flow strip's
 * and twin's statement): the claim's label where the claim names the stage ("Constraint" only while it
 * is constraining output, otherwise "Design constraint"), and the kiln's modeled role elsewhere.
 */
export function ConstraintTag({ row }: { row: StageRow }) {
  const c = row.constraint;
  if (c?.constraining)
    return (
      <span className="tag prod-tag-claim" title={`${constraintPhrase(c)}. ${c.detail}.`}>
        <Hourglass size={10} aria-hidden /> {c.label}
      </span>
    );
  if (c || row.isConstraint)
    return (
      <span className="tag" title={c ? `${constraintPhrase(c)}.` : "The line's configured (modeled) design constraint — line OEE and capacity are measured here"}>
        <Landmark size={10} aria-hidden /> Design constraint
      </span>
    );
  return null;
}

/** The not-confirmed mark of a stage's counts (Stale badge + "Not confirmed · kiln data stale since 10:30"). */
export function StaleMark({ mark }: { mark: NonNullable<StageRow['staleMark']> }) {
  return (
    <span className="prod-stale" title={mark.note}>
      <ProvenanceBadge kind="stale" title={mark.note} />
      <span>{mark.label}</span>
    </span>
  );
}
