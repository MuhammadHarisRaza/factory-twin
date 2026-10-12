/**
 * 9. Production losses of a stage: asset-level downtime / starved / blocked minutes and the output
 * not made vs the ideal rate (m²), kept apart from the line-level question — did the loss reach the
 * line constraint (kiln)? Only kiln minutes held up by the asset's own root events count there;
 * consequence events report their loss under the root, exactly as the event report does.
 */
import { ArrowUpRight } from 'lucide-react';
import { openEvent, useApp } from '../../../app/store';
import type { MonitoredStage } from '../../../model/types';
import { resolvePeriod, type PeriodKey } from '../../../sim/metrics';
import { useSimValue } from '../../../sim/store';
import { DataTable, type Column } from '../../../ui/kit/DataTable';
import { fmtInt } from '../../../ui/kit/format';
import { Empty } from '../../../ui/kit/Panel';
import { Block } from '../common';
import { ASSET_KIND_LABEL, lossTotals, m2, stageLosses, type LossRow } from './derive';

const minText = (v: number) => (v > 0 ? fmtInt(v) : <span className="muted">0</span>);

export function LossesPanel({ ms, periodKey }: { ms: MonitoredStage; periodKey: PeriodKey }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const rows = stageLosses(s, ms, p);
      return { p, rows, totals: lossTotals(rows) };
    },
    [periodKey, ms.id],
  );
  const go = useApp((s) => s.go);
  const setTab = useApp((s) => s.setTab);
  const tileEq = ms.id === 'PREP' || ms.id === 'SPRAY';

  const columns: Column<LossRow>[] = [
    {
      key: 'asset',
      header: 'Asset',
      sort: (r) => r.id,
      render: (r) => (
        <span title={r.name}>
          <span className="mono">{r.id}</span>
          <span className="sub">{ASSET_KIND_LABEL[r.kind]}</span>
        </span>
      ),
    },
    { key: 'down', header: 'Down', numeric: true, sort: (r) => r.downMin, title: 'Minutes stopped (unplanned) in the period', render: (r) => minText(r.downMin) },
    { key: 'starved', header: 'Starved', numeric: true, sort: (r) => r.starvedMin, title: 'Minutes waiting for material', render: (r) => minText(r.starvedMin) },
    { key: 'blocked', header: 'Blocked', numeric: true, sort: (r) => r.blockedMin, title: 'Minutes unable to discharge', render: (r) => minText(r.blockedMin) },
    {
      key: 'lost',
      header: 'Not made · m²',
      numeric: true,
      sort: (r) => r.lostTiles,
      title: 'Output not made vs the ideal rate over planned time (machines). Conveyors have no ideal rate — their stops show as minutes only.',
      render: (r) =>
        r.lostTiles == null ? (
          <span className="muted" title="A conveyor has no ideal rate of its own">—</span>
        ) : (
          <span className="num" title={`${fmtInt(r.lostTiles)} tiles · of which ${fmtInt(r.speedLossTiles)} while running below the ideal rate`}>
            {fmtInt(m2(r.lostTiles))}
          </span>
        ),
    },
    {
      key: 'reach',
      header: 'Reached the constraint',
      sort: (r) => r.constraintMin,
      title: 'Kiln minutes held up (down, starved or blocked) by this asset’s own events — the part that cost line output',
      render: (r) => <ReachCell r={r} />,
    },
  ];

  return (
    <Block
      title="Production losses"
      subtitle={`Asset level vs line level · ${d.p.label}`}
      flush
      actions={
        <button type="button" className="btn sm ghost" onClick={() => setTab('production', 'oee')} title="Line OEE, its losses at the constraint and the integrity checks">
          OEE &amp; losses <ArrowUpRight size={12} aria-hidden />
        </button>
      }
      note={
        <span>
          Asset level: minutes and output not made at each asset vs its ideal rate{tileEq ? ' (tile-equivalent m²)' : ''}. Line level: only time that held up the
          kiln — the line constraint — cost line output; upstream losses absorbed by buffers did not. Constraint figures are those of the root events overlapping the
          period (whole event). Estimated values: Production → Analysis.
        </span>
      }
    >
      {!d.rows.length ? (
        <Empty title="No machine or conveyor with stop accounting at this stage">
          <span>Warehouse transfer is measured in pallets; dock and truck delays are in Fleet &amp; Movement.</span>
          <button type="button" className="btn sm" onClick={() => go('fleet')}>
            Open Fleet &amp; Movement
          </button>
        </Empty>
      ) : (
        <>
          <div className="stg-loss-sum">
            <div>
              <span className="kpi-label">Asset level · not made</span>
              <b className="num">
                {fmtInt(m2(d.totals.lostTiles))} <small>m²</small>
              </b>
              <span className="muted" title="Minutes summed over the stage’s assets">
                {fmtInt(d.totals.downMin)} asset-min down · {fmtInt(d.totals.heldMin)} starved / blocked
              </span>
            </div>
            <div>
              <span className="kpi-label">Line level · reached the kiln</span>
              <b className="num">
                {fmtInt(m2(d.totals.constraintLostTiles))} <small>m²</small>
              </b>
              <span className="muted">
                {d.totals.constraintMin > 0
                  ? `${fmtInt(d.totals.constraintMin)} kiln min held up · ${d.totals.eventIds.length} root event${d.totals.eventIds.length === 1 ? '' : 's'}`
                  : 'No loss of this stage held up the kiln'}
              </span>
            </div>
          </div>
          <DataTable columns={columns} rows={d.rows} rowKey={(r) => r.id} maxHeight="none" initialSort={{ key: 'lost', dir: 'desc' }} />
        </>
      )}
    </Block>
  );
}

function ReachCell({ r }: { r: LossRow }) {
  if (r.isConstraint)
    return (
      <span className="stg-reach" title="The kiln is the line constraint: every kiln minute lost is line output lost">
        <b className="num">{fmtInt(m2(r.constraintLostTiles))} m²</b>
        <span className="muted">is the constraint · {fmtInt(r.constraintMin)} min</span>
      </span>
    );
  if (r.constraintMin <= 0)
    return (
      <span className="muted" title="No root event of this asset held up the kiln in the period — buffers absorbed it or it is still within the buffer">
        No · absorbed
      </span>
    );
  return (
    <span className="stg-reach">
      <b className="num">{fmtInt(m2(r.constraintLostTiles))} m²</b>
      <span className="muted">{fmtInt(r.constraintMin)} kiln min</span>
      {r.eventIds.slice(0, 2).map((id) => (
        <button key={id} className="row-link mono" onClick={() => openEvent(id)} title={`Open ${id} — report and evidence`}>
          {id}
        </button>
      ))}
      {r.eventIds.length > 2 && <span className="muted">+{r.eventIds.length - 2}</span>}
    </span>
  );
}
