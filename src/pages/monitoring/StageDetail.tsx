/**
 * Stage detail (#/monitoring/<stage>): what the stage is doing now and over the shared period —
 * counting boundary, equipment, I/O, trends, signals, cameras, events, losses, shift summary and
 * presenter quick actions. Every figure reads the one simulation state through derive.ts.
 */
import { ArrowLeft, Box, ChevronLeft, ChevronRight } from 'lucide-react';
import { openEquipment, useApp } from '../../app/store';
import { CAMERA_BY_ID, MONITORED_STAGES, MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { MonitoredStage, MonitoredStageId } from '../../model/types';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { EventList } from '../../ui/events/EventList';
import { CameraFeed } from '../../ui/feeds/CameraFeed';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { Empty, Panel } from '../../ui/kit/Panel';
import { OPERATIONAL_STATE } from '../../ui/kit/Status';
import {
  ASSET_KIND_LABEL,
  bottleneckView,
  bufferName,
  countCell,
  isMachine,
  rateShare,
  stageEvents,
  stageRow,
  stageSentence,
  wipShare,
  type AssetView,
  type StageRow,
} from './derive';
import { LossesPanel } from './Losses';
import { AssetState, BottleneckTag, CauseText, ConstraintTag, Count, FeedBadge } from './parts';
import { QuickActions } from './QuickActions';
import { ShiftPanel } from './ShiftPanel';
import { SignalTrends } from './Signals';
import { TrendPanel } from './Trend';

/** Factory Twin framed on the stage: its single machine, or its zone when it has several. */
export function focusStageIn3D(ms: MonitoredStage) {
  const machines = ms.equipment.filter(isMachine);
  if (machines.length === 1) return openEquipment(machines[0]);
  useApp.getState().go('twin');
  requestAnimationFrame(() => useTwin.getState().selectZone(ms.zone));
}

export function StageDetail({ stageId, periodKey }: { stageId: MonitoredStageId; periodKey: PeriodKey }) {
  const ms = MONITORED_STAGE_BY_ID[stageId];
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const events = stageEvents(s, ms);
      const row = stageRow(s, ms, p, bottleneckView(s), events);
      const history = events.filter((e) => e.end != null && e.end >= p.from && e.start <= p.to);
      return { p, row, history };
    },
    [periodKey, stageId],
  );
  const idx = MONITORED_STAGES.findIndex((x) => x.id === stageId);
  const prev = MONITORED_STAGES[idx - 1];
  const next = MONITORED_STAGES[idx + 1];
  const selectStage = useApp((s) => s.selectStage);
  const { row } = d;

  return (
    <>
      <div className="toolbar-row mon-head">
        <button className="btn ghost" onClick={() => selectStage(null)} title="Back to all stages">
          <ArrowLeft size={14} aria-hidden /> All stages
        </button>
        <div className="mon-title">
          <span className="mon-step-n">{ms.step}</span>
          <h2>{ms.name}</h2>
          <span className="mono muted">{ms.id}</span>
          {row.isBottleneck && <BottleneckTag label="Current bottleneck" />}
          {row.isConstraint && <ConstraintTag />}
        </div>
        <div className="spacer" />
        <div className="mon-nav" role="group" aria-label="Neighbouring stages">
          <button className="btn sm" disabled={!prev} onClick={() => prev && selectStage(prev.id)} title={prev ? `Upstream: ${prev.name}` : 'First stage'}>
            <ChevronLeft size={13} aria-hidden /> {prev ? prev.name : 'Upstream'}
          </button>
          <button className="btn sm" disabled={!next} onClick={() => next && selectStage(next.id)} title={next ? `Downstream: ${next.name}` : 'Last stage'}>
            {next ? next.name : 'Downstream'} <ChevronRight size={13} aria-hidden />
          </button>
        </div>
        <button className="btn" onClick={() => focusStageIn3D(ms)} title="Open the Factory Twin framed on this stage">
          <Box size={14} aria-hidden /> Focus in 3D
        </button>
      </div>

      <IoBand row={row} periodLabel={d.p.label} />

      <EquipmentPanel row={row} />
      <BoundaryPanel row={row} periodKey={periodKey} />

      <Panel
        className="col-7"
        title="Active events"
        subtitle={`${row.active.length} condition${row.active.length === 1 ? '' : 's'} active now · open one for its report and evidence`}
      >
        <EventList events={row.active} hideAsset={false} empty="No active event at this stage" />
      </Panel>
      <CamerasPanel ms={ms} />

      <TrendPanel ms={ms} periodKey={periodKey} />
      <div className="col-5 mon-side">
        <ShiftPanel ms={ms} />
        <QuickActions ms={ms} />
      </div>

      <SignalTrends ms={ms} />

      <LossesPanel ms={ms} periodKey={periodKey} />
      <Panel className="col-5" title="Event history" subtitle={`Ended conditions · ${d.p.label}`}>
        <EventList events={d.history} limit={40} empty="No event of this stage ended in this period" />
        {d.history.length > 40 && (
          <p className="muted mon-more">
            Showing the 40 most recent of {d.history.length} —{' '}
            <button className="row-link" onClick={() => useApp.getState().go('events')}>
              Events &amp; Reports
            </button>{' '}
            lists them all.
          </p>
        )}
      </Panel>
    </>
  );
}

// ── 3. Input / output band ────────────────────────────────────────────────────

function IoBand({ row, periodLabel }: { row: StageRow; periodLabel: string }) {
  const { ms, io } = row;
  const st = row.state ? OPERATIONAL_STATE[row.state] : null;
  const SIcon = st?.icon;
  const input = countCell(ms, 'input', io);
  const output = countCell(ms, 'output', io);
  const good = countCell(ms, 'good', io);
  const rejected = countCell(ms, 'rejected', io);
  const share = rateShare(io);
  const w = wipShare(io);
  return (
    <section className="summary mon-io" aria-label={`${ms.name} input and output`}>
      <div>
        <div className="kpi-label">Stage state · now</div>
        {st && SIcon ? (
          <div className={`mon-verdict ${st.tone}`}>
            <SIcon size={16} strokeWidth={2.2} aria-hidden />
            {st.label}
          </div>
        ) : (
          <div className="mon-verdict neutral">No machine state signal</div>
        )}
        <div className="kpi-sub">
          {row.cause ? <CauseText cause={row.cause} /> : <span>{st ? 'Observed from the equipment state signals' : 'Warehouse transfer is monitored through its counts'}</span>}
        </div>
      </div>
      <IoCell label={ms.input.label} cell={input} sub={input?.measured ? input.signalId : input?.note} />
      <IoCell label={ms.output.label} cell={output} sub={output?.measured ? `${output.signalId} · ${periodLabel}` : output?.note} />
      <div>
        <div className="kpi-label">Good · rejected</div>
        {good || rejected ? (
          <>
            <div className="kpi-value">
              <Count cell={good} compact />
            </div>
            <div className="kpi-sub">
              <Count cell={rejected} compact />
              {io.rejected != null && io.output ? <span>· {fmtPct(io.rejected / Math.max(1, (io.good ?? 0) + io.rejected), 1)} rejected</span> : null}
            </div>
          </>
        ) : (
          <>
            <div className="kpi-value muted">—</div>
            <div className="kpi-sub">
              <span>Not counted here — rejects are detected at sorting</span>
            </div>
          </>
        )}
      </div>
      <div>
        <div className="kpi-label">Work in progress · now</div>
        <div className="kpi-value">
          {io.wip != null ? fmtInt(io.wip) : '—'}
          <small>{ms.unit}</small>
        </div>
        <div className="kpi-sub">
          {ms.id === 'WH' ? <span>Pallets in stock (incl. awaiting put-away)</span> : ms.wipBufferId ? <span>{bufferName(ms.wipBufferId)}{w != null ? ` · ${fmtPct(w, 0)} full` : ''}</span> : <span>No input buffer at this stage</span>}
        </div>
        {w != null && (
          <div className="meter" aria-hidden>
            <i style={{ width: `${Math.min(100, w * 100)}%` }} />
          </div>
        )}
      </div>
      <div>
        <div className="kpi-label" title="Expected = ideal rate × planned running time (planned stops excluded)">
          Rate · actual vs expected
        </div>
        <div className="kpi-value">
          {fmtInt(io.ratePerHour)}
          <small>{ms.unit}/h</small>
        </div>
        <div className="kpi-sub">
          {io.expectedPerHour != null ? (
            <span>
              expected {fmtInt(io.expectedPerHour)}/h{share != null ? ` · ${fmtPct(share, 0)}` : ''}
            </span>
          ) : (
            <span>No expected rate for this stage</span>
          )}
        </div>
      </div>
      <div>
        <div className="kpi-label" title="Minutes in the period, averaged over the stage’s machines">
          Down · starved · blocked
        </div>
        {ms.id === 'WH' ? (
          <>
            <div className="kpi-value muted">—</div>
            <div className="kpi-sub">
              <span>No machine state signals</span>
            </div>
          </>
        ) : (
          <>
            <div className="kpi-value">
              {fmt1(io.downMin)}
              <small>min down</small>
            </div>
            <div className="kpi-sub">
              <span>
                {fmt1(io.starvedMin)} starved · {fmt1(io.blockedMin)} blocked
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function IoCell({ label, cell, sub }: { label: string; cell: ReturnType<typeof countCell>; sub?: string | null }) {
  return (
    <div>
      <div className="kpi-label" title={label}>
        {label}
      </div>
      <div className="kpi-value">
        {cell && cell.measured ? (
          <>
            {fmtInt(cell.value)}
            <small>{cell.unit}</small>
          </>
        ) : (
          <span className="mon-nm big">Not measured</span>
        )}
      </div>
      <div className="kpi-sub">
        <span className={cell?.measured ? 'mono' : ''}>{sub ?? '—'}</span>
      </div>
    </div>
  );
}

// ── 1. Stage overview & counting boundary ────────────────────────────────────

function BoundaryPanel({ row, periodKey }: { row: StageRow; periodKey: PeriodKey }) {
  const { ms } = row;
  const point = (label: string, cp: MonitoredStage['input'] | null) => (
    <>
      <dt>{label}</dt>
      <dd>
        {cp ? (
          cp.measured ? (
            <>
              {cp.label} · <span className="mono">{cp.signalId}</span> · {cp.unit}
              {cp.note && <div className="muted">{cp.note}</div>}
            </>
          ) : (
            <>
              <span className="mon-nm">Not measured</span> — {cp.label}
              {cp.note && <div className="muted">{cp.note}</div>}
            </>
          )
        ) : (
          <span className="muted">No counting point at this stage</span>
        )}
      </dd>
    </>
  );
  return (
    <Panel className="col-4" title="Stage overview" subtitle="Counting boundary and units">
      <p className="mon-sentence">{stageSentence(row, periodKey)}</p>
      <dl className="dl mon-dl">
        {point('Input', ms.input)}
        {point('Output', ms.output)}
        {point('Good', ms.good)}
        {point('Rejected', ms.rejected)}
        <dt>Work in progress</dt>
        <dd>{ms.id === 'WH' ? 'Warehouse stock (pallets)' : ms.wipBufferId ? `${bufferName(ms.wipBufferId)} (${ms.wipBufferId})` : 'No input buffer'}</dd>
        <dt>Unit</dt>
        <dd>{ms.unit === 'pallets' ? 'Pallets (palletised tiles ÷ tiles per pallet)' : 'Tiles (tile-equivalent upstream of pressing)'}</dd>
        <dt>Standalone OEE</dt>
        <dd>{ms.oeeMeaningful ? 'Meaningful — see OEE & Loss Intelligence' : 'Not meaningful for a transfer stage'}</dd>
      </dl>
    </Panel>
  );
}

// ── 2. Equipment ──────────────────────────────────────────────────────────────

function EquipmentPanel({ row }: { row: StageRow }) {
  const assets = [...row.equipment, ...row.conveyors];
  const columns: Column<AssetView>[] = [
    {
      key: 'asset',
      header: 'Asset',
      render: (a) => (
        <span>
          <span className="mono">{a.id}</span>
          <span className="sub">{a.name}</span>
        </span>
      ),
    },
    { key: 'kind', header: 'Type', render: (a) => <span className="muted">{ASSET_KIND_LABEL[a.kind]}</span> },
    {
      key: 'state',
      header: 'State',
      render: (a) => (
        <span className="mon-inline">
          <AssetState a={a} />
          {a.since != null && <span className="muted">since {formatClock(a.since)}</span>}
        </span>
      ),
    },
    {
      key: 'rate',
      header: 'Rate now',
      numeric: true,
      title: 'Current output (machines) or transported tiles (conveyors) vs ideal rate / nominal capacity',
      render: (a) =>
        a.rate == null ? (
          <span className="muted">{a.reading ?? '—'}</span>
        ) : (
          <span className="num" title={a.feed.status === 'stale' ? 'Last value received before the feed went stale' : undefined}>
            {fmtInt(a.rate)}
            <span className="muted"> / {fmtInt(a.nominal)} tiles/h</span>
            {a.feed.status === 'stale' && <span className="muted"> (last value)</span>}
          </span>
        ),
    },
    { key: 'feed', header: 'Data feed', render: (a) => <FeedBadge feed={a.feed} /> },
    {
      key: 'show',
      header: '',
      width: 40,
      render: (a) => (
        <button
          className="btn ghost sm icon"
          title={`Show ${a.id} in the Factory Twin`}
          aria-label={`Show ${a.id} in 3D`}
          onClick={(e) => {
            e.stopPropagation();
            openEquipment(a.id);
          }}
        >
          <Box size={13} />
        </button>
      ),
    },
  ];
  return (
    <Panel
      className="col-8"
      title="Equipment"
      subtitle={`${assets.length} assets · state, rate and data feed now`}
      flush
      footer={<span>No plant data source is connected: every feed is simulated. A feed that stops updating shows “Stale since” and its asset’s state becomes Unknown.</span>}
    >
      <DataTable columns={columns} rows={assets} rowKey={(a) => a.id} maxHeight="none" empty="No equipment configured for this stage" />
    </Panel>
  );
}

// ── 6. Cameras ────────────────────────────────────────────────────────────────

function CamerasPanel({ ms }: { ms: MonitoredStage }) {
  return (
    <Panel className="col-5" title="Camera views" subtitle={`${ms.cameras.length} camera position${ms.cameras.length === 1 ? '' : 's'} covering this stage`}>
      {ms.cameras.length ? (
        <div className={`mon-cams n${Math.min(2, ms.cameras.length)}`}>
          {ms.cameras.map((id) => (
            <figure key={id} className="mon-cam">
              <CameraFeed cameraId={id} compact height={ms.cameras.length > 1 ? 150 : 230} />
              <figcaption>
                <span className="mono">{id}</span> {CAMERA_BY_ID[id]?.name}
                <span className="muted"> · {CAMERA_BY_ID[id]?.purpose}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <Empty title="No camera configured for this stage" />
      )}
    </Panel>
  );
}
