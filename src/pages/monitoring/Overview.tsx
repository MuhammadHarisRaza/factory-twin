/**
 * Production Monitoring overview: the line as an ordered stage flow and one row per monitored stage —
 * equipment and conveyor states (worst first), counted input / output / good / rejected / WIP,
 * actual vs expected rate, held-up minutes, active events and the current bottleneck.
 */
import { ArrowRight, CircleCheck, Hourglass, Info, OctagonX, TriangleAlert, Unplug, type LucideIcon } from 'lucide-react';
import { openEvent, useApp } from '../../app/store';
import type { MonitoredStageId } from '../../model/types';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmt1, fmtInt, fmtM2, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { OPERATIONAL_STATE, SeverityBadge, StatusBadge, type Tone } from '../../ui/kit/Status';
import { STATE_RANK, countCell, overview, wipShare, type BottleneckView, type Overview as OverviewData, type StageRow } from './derive';
import { ActiveEvents, AssetLine, BottleneckTag, CauseText, ConstraintTag, Count, RateText, StaleFeeds } from './parts';

export function Overview({ periodKey }: { periodKey: PeriodKey }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      return { p, o: overview(s, p) };
    },
    [periodKey],
  );
  const select = (id: MonitoredStageId) => useApp.getState().selectStage(id);

  return (
    <>
      <Summary o={d.o} periodLabel={d.p.label} onSelect={select} />
      <StageFlow rows={d.o.rows} onSelect={select} />
      <StageTable rows={d.o.rows} periodLabel={d.p.label} onSelect={select} />
    </>
  );
}

// ── Answer-first band ─────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function bottleneckText(bn: BottleneckView) {
  if (bn.cause === 'constraint') return 'Kiln limits the line, as designed';
  return bn.cause === 'starving' ? 'Upstream of the kiln — starving it' : 'Downstream of the kiln — blocking it';
}

function Summary({ o, periodLabel, onSelect }: { o: OverviewData; periodLabel: string; onSelect: (id: MonitoredStageId) => void }) {
  const n = o.attention.length;
  const verdict: { tone: Tone; icon: LucideIcon; text: string } = o.stopped.length
    ? { tone: 'critical', icon: OctagonX, text: `${plural(n, 'stage')} need${n === 1 ? 's' : ''} attention` }
    : n
      ? { tone: 'warning', icon: TriangleAlert, text: `${plural(n, 'stage')} need${n === 1 ? 's' : ''} attention` }
      : { tone: 'good', icon: CircleCheck, text: 'All stages running' };
  const VIcon = verdict.icon;
  return (
    <section className="summary mon-kpis" aria-label="Production monitoring summary">
      <div>
        <div className="kpi-label">Line status · now</div>
        <div className={`mon-verdict ${verdict.tone}`}>
          <VIcon size={16} strokeWidth={2.2} aria-hidden />
          {verdict.text}
        </div>
        <div className="kpi-sub">
          {o.attention.slice(0, 4).map((r) => (
            <button key={r.ms.id} className="row-link" onClick={() => onSelect(r.ms.id)}>
              {r.ms.name}
            </button>
          ))}
          {o.attention.length > 4 && <span>+{o.attention.length - 4} more</span>}
          {!o.attention.length && <span>No stopped, held-up or stale equipment</span>}
        </div>
      </div>

      <div>
        <div className="kpi-label">
          <Hourglass size={13} aria-hidden />
          Current bottleneck
        </div>
        <div className="kpi-headline">
          {o.bn.stage ? (
            <button className="row-link" onClick={() => onSelect(o.bn.stage!)}>
              {o.bn.name}
            </button>
          ) : (
            o.bn.name
          )}
        </div>
        <div className="kpi-sub" title={`Working at its own pace ${fmtPct(o.bn.workingShare, 0)} of the window (down ${fmtPct(o.bn.downShare, 0)})`}>
          <span>{bottleneckText(o.bn)}</span>
          <span>· {o.bn.windowLabel.toLowerCase()}</span>
        </div>
      </div>

      <div>
        <div className="kpi-label">Equipment stopped</div>
        <div className="kpi-value">
          {o.stopped.length}
          <small>fault or stop</small>
        </div>
        <div className="kpi-sub">
          {o.stopped.length ? (
            o.stopped.slice(0, 3).map((a) => (
              <span key={a.id} className="mono">
                {a.id}
              </span>
            ))
          ) : (
            <span>No unplanned stop now</span>
          )}
        </div>
      </div>

      <div>
        <div className="kpi-label">Active events</div>
        <div className="kpi-value">
          {o.active.length}
          <small>across the stages</small>
        </div>
        <div className="kpi-sub">
          {o.worst ? (
            <>
              <SeverityBadge severity={o.worst} />
              <button className="row-link" onClick={() => openEvent(o.active[0].id)} title={o.active[0].title}>
                {o.active[0].id}
              </button>
            </>
          ) : (
            <span>No condition active</span>
          )}
        </div>
      </div>

      <div>
        <div className="kpi-label">Data feeds</div>
        <div className="kpi-value">
          {o.stale.length}
          <small>stale</small>
        </div>
        <div className="kpi-sub">
          {o.stale.length ? (
            <StatusBadge tone="warning" icon={Unplug} label={o.stale.map((a) => a.id).join(', ')} />
          ) : (
            <span>All simulated feeds updating</span>
          )}
        </div>
      </div>

      <div>
        <div className="kpi-label" title="First-quality tiles accepted at sorting — the line's output counting point">
          Line good output · {periodLabel}
        </div>
        <div className="kpi-value">
          {fmtM2(o.lineGood)}
          <small>m²</small>
        </div>
        <div className="kpi-sub">
          <span>{fmtInt(o.lineGood)} tiles accepted at sorting</span>
        </div>
      </div>
    </section>
  );
}

// ── Ordered flow ──────────────────────────────────────────────────────────────

function StageFlow({ rows, onSelect }: { rows: StageRow[]; onSelect: (id: MonitoredStageId) => void }) {
  return (
    <nav className="col-12 mon-flow" aria-label="Line stages in flow order">
      {rows.map((r, i) => {
        const st = r.state ? OPERATIONAL_STATE[r.state] : null;
        const Icon = st?.icon;
        // A stage without machine state signals (warehouse transfer) shows its count instead.
        const fallback = r.io.wip != null ? `${fmtInt(r.io.wip)} ${r.ms.unit} in stock` : 'No state signal';
        // A stopped / faulted / stale conveyor matters as much as a machine: it cuts the transfer.
        const conv = r.conveyors.find((c) => c.state != null && STATE_RANK[c.state] <= STATE_RANK.unknown);
        const cst = conv?.state ? OPERATIONAL_STATE[conv.state] : null;
        const CIcon = cst?.icon;
        return (
          <div key={r.ms.id} className="mon-flow-item">
            {i > 0 && <ArrowRight size={13} className="mon-flow-arrow" aria-hidden />}
            <button
              className={`mon-flow-step ${r.isBottleneck ? 'bn' : ''}`}
              onClick={() => onSelect(r.ms.id)}
              title={`${r.ms.name} — ${st ? st.label : 'no machine state signal'}${r.active.length ? ` · ${r.active.length} active event${r.active.length === 1 ? '' : 's'}` : ''}${r.isBottleneck ? ' · current bottleneck' : ''}`}
            >
              <span className="mon-step-n">{r.ms.step}</span>
              <span className="mon-step-name">{r.ms.name}</span>
              <span className={`status ${st?.tone ?? 'neutral'}`}>
                {Icon ? <Icon size={13} strokeWidth={2.2} aria-hidden /> : <Info size={13} aria-hidden />}
                {st ? st.label : fallback}
              </span>
              {conv && cst && CIcon && (
                <span className={`status ${cst.tone}`}>
                  <CIcon size={13} strokeWidth={2.2} aria-hidden />
                  {conv.id} {cst.label.toLowerCase()}
                </span>
              )}
              {r.isBottleneck && <Hourglass size={12} className="mon-bn-ico" aria-label="Current bottleneck" />}
            </button>
          </div>
        );
      })}
    </nav>
  );
}

// ── Stage table ───────────────────────────────────────────────────────────────

function StageTable({ rows, periodLabel, onSelect }: { rows: StageRow[]; periodLabel: string; onSelect: (id: MonitoredStageId) => void }) {
  const columns: Column<StageRow>[] = [
    { key: 'step', header: '#', width: 28, render: (r) => <span className="mon-step-n">{r.ms.step}</span> },
    {
      key: 'stage',
      header: 'Stage',
      render: (r) => (
        <div className="mon-stack">
          <b className="mon-strong">{r.ms.name}</b>
          <span className="mon-tags">
            <span className="mono muted">{r.ms.id}</span>
            {r.isBottleneck && <BottleneckTag />}
            {r.isConstraint && <ConstraintTag />}
          </span>
        </div>
      ),
    },
    {
      key: 'equipment',
      header: 'Equipment · observed state',
      title: 'State from each asset’s state signal, worst first. An inferred cause is shown only when the event engine linked it to a root event.',
      render: (r) => (
        <div className="mon-stack">
          {r.equipment.map((a) => (
            <AssetLine key={a.id} a={a} />
          ))}
          {r.cause && <CauseText cause={r.cause} stop />}
        </div>
      ),
    },
    {
      key: 'conveyors',
      header: 'Conveyors',
      render: (r) =>
        r.conveyors.length ? (
          <div className="mon-stack">
            {r.conveyors.map((a) => (
              <AssetLine key={a.id} a={a} />
            ))}
          </div>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'in', header: 'Input', numeric: true, title: 'At the stage’s input counting point, in the period', render: (r) => <Count cell={countCell(r.ms, 'input', r.io)} /> },
    {
      key: 'out',
      header: 'Output',
      numeric: true,
      title: 'At the stage’s output counting point, in the period',
      render: (r) => (
        <div className="mon-stack end">
          <Count cell={countCell(r.ms, 'output', r.io)} />
          {r.stale.length > 0 && <StaleFeeds assets={r.stale} />}
        </div>
      ),
    },
    {
      key: 'gr',
      header: 'Good · rejected',
      numeric: true,
      title: 'Good and rejected tiles are counted where inspection happens (sorting)',
      render: (r) => {
        const g = countCell(r.ms, 'good', r.io);
        const x = countCell(r.ms, 'rejected', r.io);
        if (!g && !x) return <span className="muted" title="No good / reject counting point at this stage — rejects are detected at sorting">—</span>;
        return (
          <div className="mon-stack end">
            <Count cell={g} compact />
            <Count cell={x} compact />
          </div>
        );
      },
    },
    {
      key: 'wip',
      header: 'WIP',
      numeric: true,
      title: 'Work in progress at the stage input (buffer level now)',
      render: (r) => {
        if (r.io.wip == null) return <span className="muted">—</span>;
        const w = wipShare(r.io);
        return (
          <span className="num">
            {fmtInt(r.io.wip)} <span className="muted">{r.ms.unit}</span>
            {w != null && <span className="mon-share"> {fmtPct(w, 0)}</span>}
          </span>
        );
      },
    },
    {
      key: 'rate',
      header: 'Rate · actual / expected',
      numeric: true,
      render: (r) => <RateText actual={r.io.ratePerHour} expected={r.io.expectedPerHour} unit={r.ms.unit} />,
    },
    {
      key: 'held',
      header: 'Down · starved · blocked',
      numeric: true,
      title: 'Minutes in the period, averaged over the stage’s machines',
      render: (r) =>
        r.ms.id === 'WH' ? (
          <span className="muted" title="No machine state signals at warehouse transfer">—</span>
        ) : (
          <span className="num">
            {fmt1(r.io.downMin)} · {fmt1(r.io.starvedMin)} · {fmt1(r.io.blockedMin)} <span className="muted">min</span>
          </span>
        ),
    },
    { key: 'events', header: 'Active events', render: (r) => <ActiveEvents events={r.active} worst={r.worst} /> },
  ];
  return (
    <Panel
      className="col-12"
      title="Stages in flow order"
      subtitle={`Counts for ${periodLabel} · states and events now · select a stage for its detail view`}
      flush
      footer={
        <span>
          Counts come from each stage’s configured counting points; a quantity without a counting point reads “Not measured” instead of being inferred.
          Expected rate = ideal rate × planned running time. Feed stale = the asset’s state is unknown and its counter frozen at the last value received.
        </span>
      }
    >
      <div className="mon-table">
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.ms.id} onRowClick={(r) => onSelect(r.ms.id)} maxHeight="none" />
      </div>
    </Panel>
  );
}
