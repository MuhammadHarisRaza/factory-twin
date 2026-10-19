/**
 * Stage view (#/production/<stage>): what one stage is doing now and over the shared period — inputs
 * and outputs at its counting points, its buffer, machines and conveyors, the simulated camera view
 * and a reference video, its events, trend, losses, signals and the shift summary. The 3D model
 * highlights the stage while it is open (ProductionPage). Every figure reads the one simulation
 * state through derive.ts.
 */
import { useState } from 'react';
import { ArrowLeft, ArrowRight, Box, ChevronLeft, ChevronRight } from 'lucide-react';
import { openEquipment, useApp } from '../../../app/store';
import { CAMERA_BY_ID, MONITORED_STAGES, MONITORED_STAGE_BY_ID } from '../../../model/plant';
import type { MonitoredStage, MonitoredStageId } from '../../../model/types';
import { resolvePeriod, type PeriodKey } from '../../../sim/metrics';
import { useSimValue } from '../../../sim/store';
import { useTwin } from '../../../store';
import { EventList } from '../../../ui/events/EventList';
import { openEventsFor } from '../../../ui/events/open';
import { CameraFeed } from '../../../ui/feeds/CameraFeed';
import { DataTable, type Column } from '../../../ui/kit/DataTable';
import { fmt1, fmtInt, fmtPct } from '../../../ui/kit/format';
import { Disclosure, EmptyState, Facts, ProvenanceBadge } from '../../../ui/kit/Page';
import { Segmented } from '../../../ui/kit/Panel';
import { OPERATIONAL_STATE, StatusBadge } from '../../../ui/kit/Status';
import { ContextVideo } from '../../../video/ContextVideo';
import { Block, canDrill } from '../common';
import { openMaterialFlow } from '../ui';
import { MASS_DISCLOSURE, NO_CALIBRATION, isMaterialAsset, tileEqToT } from '../units';
import {
  ASSET_KIND_LABEL,
  bottleneckView,
  bufferName,
  countCell,
  isMaterialStage,
  rateShare,
  stageEvents,
  sinceLabel,
  stageRow,
  wipShare,
  type AssetView,
  type StageRow,
} from './derive';
import { LossesPanel } from './Losses';
import { AssetState, CauseText, ConstraintTag, Count, FeedBadge, StaleMark } from './parts';
import { QuickActions } from './QuickActions';
import { ShiftPanel } from './ShiftPanel';
import { SignalTrends } from './Signals';
import { TrendPanel } from './Trend';

/**
 * Opens the Factory Twin with the stage's equipment highlighted and framed. The stage becomes the model's
 * focus: an earlier equipment or vehicle selection is released first (the twin shows the most specific
 * item, so a kept selection would open that asset's panel and address instead of the stage), so the
 * address is #/twin and the twin shows the stage panel.
 */
export function showStageIn3D(id: MonitoredStageId) {
  const t = useTwin.getState();
  if (t.vehicle) t.selectVehicle(null);
  if (t.selected) t.select(null);
  // Highlight now (the twin opens on the stage panel); frame once the twin is visible and has sized its canvas.
  t.selectStage(id, { frame: false });
  useApp.getState().go('twin');
  requestAnimationFrame(() => useTwin.getState().selectStage(id));
}

export function StageView({ stageId, periodKey, onAsset }: { stageId: MonitoredStageId; periodKey: PeriodKey; onAsset: (id: string) => void }) {
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
      <nav className="prod-stage-nav" aria-label="Stage navigation">
        <button type="button" className="btn" onClick={() => selectStage(null)} title="Back to the stage flow of the whole line">
          <ArrowLeft size={14} aria-hidden /> All stages
        </button>
        <span className="prod-stage-tags">
          <span className="prod-step">{ms.step}</span>
          <span className="mono muted">{ms.id}</span>
          <ConstraintTag row={row} />
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm" disabled={!prev} onClick={() => prev && selectStage(prev.id)} title={prev ? `Upstream: ${prev.name}` : 'First stage of the line'}>
          <ChevronLeft size={13} aria-hidden /> {prev ? prev.name : 'Upstream'}
        </button>
        <button type="button" className="btn sm" disabled={!next} onClick={() => next && selectStage(next.id)} title={next ? `Downstream: ${next.name}` : 'Last stage of the line'}>
          {next ? next.name : 'Downstream'} <ChevronRight size={13} aria-hidden />
        </button>
      </nav>

      <IoStrip row={row} periodLabel={d.p.label} />

      <div className="work">
        <div className="prod-stack">
          <EquipmentBlock row={row} onAsset={onAsset} />
          <TrendPanel ms={ms} periodKey={periodKey} />
        </div>
        <div className="prod-stack">
          <CameraBlock ms={ms} />
          <Block title="Reference video" subtitle="Illustrates this process step — not this plant, not a live feed, never evidence of an event" actions={<ProvenanceBadge kind="reference" />}>
            <ContextVideo context={{ stage: ms.id }} compact />
          </Block>
        </div>
      </div>

      <Block
        title="Stage events"
        subtitle={`${row.active.length} active now · ${d.history.length} ended in ${d.p.label} · open one for its report and evidence`}
        actions={<StageEventsButton ms={ms} />}
      >
        <div className="prod-2col even">
          <div>
            <h4 className="prod-h4">Active now</h4>
            <EventList events={row.active} empty="No active event at this stage" limit={6} />
          </div>
          <div>
            <h4 className="prod-h4">Ended in the period</h4>
            <EventList events={d.history} limit={6} empty="No event of this stage ended in this period" />
          </div>
        </div>
      </Block>

      <LossesPanel ms={ms} periodKey={periodKey} />

      <div className="prod-2col even">
        <ShiftPanel ms={ms} />
        <QuickActions ms={ms} />
      </div>

      <SignalTrends ms={ms} />
    </>
  );
}

/** Opens Events & Reports on its Events tab listing this stage's events (stage filter, all recorded time). */
export function StageEventsButton({ ms }: { ms: MonitoredStage }) {
  return (
    <button type="button" className="btn sm ghost" onClick={() => openEventsFor({ stage: ms.id })} title={`Open Events & Reports listing the events of ${ms.name} (all recorded time)`}>
      Events &amp; Reports
    </button>
  );
}

// ── Inputs / outputs strip ───────────────────────────────────────────────────

function IoStrip({ row, periodLabel }: { row: StageRow; periodLabel: string }) {
  const { ms, io } = row;
  const st = row.state ? OPERATIONAL_STATE[row.state] : null;
  const share = rateShare(io);
  const w = wipShare(io);
  const good = countCell(ms, 'good', io);
  const rejected = countCell(ms, 'rejected', io);
  const material = isMaterialStage(ms);
  // The stage's input buffer holds slip or powder (BUF-SLIP, BUF-SILO): % only.
  const bulkBuffer = ms.wipBufferId === 'BUF-SLIP' || ms.wipBufferId === 'BUF-SILO';
  return (
    <div className="prod-io-strip">
      <div className="mini-kpis" role="group" aria-label={`${ms.name} — inputs and outputs`}>
        <div className="mini-kpi">
          <span>State now</span>
          <b>{st ? <StatusBadge tone={st.tone} icon={st.icon} label={st.label} /> : 'Counts only'}</b>
          <em>{st ? 'From the equipment state signals (simulated)' : 'No machine state signal at this stage'}</em>
        </div>
        <div className="mini-kpi" title={`${ms.input.label} → ${ms.output.label}`}>
          <span>Input → output · {periodLabel}</span>
          <b className="prod-io">
            <Count cell={countCell(ms, 'input', io)} compact />
            <span className="muted"> → </span>
            <Count cell={countCell(ms, 'output', io)} compact />
          </b>
          {row.staleMark ? (
            <em>
              <StaleMark mark={row.staleMark} />
            </em>
          ) : (
            <em>
              {ms.input.label} → {ms.output.label}
            </em>
          )}
        </div>
        <div className="mini-kpi">
          <span>Good · rejected</span>
          {good || rejected ? (
            <>
              <b className="prod-io">
                <Count cell={good} compact />
                <span className="muted"> · </span>
                <Count cell={rejected} compact />
              </b>
              {row.staleMark ? (
                <em>
                  <StaleMark mark={row.staleMark} />
                </em>
              ) : (
                <em>{io.rejected != null && io.good != null && io.good + io.rejected > 0 ? `${fmtPct(io.rejected / (io.good + io.rejected), 2)} rejected` : 'Inspected at gauge + vision'}</em>
              )}
            </>
          ) : (
            <>
              <b className="muted">—</b>
              <em>Not counted here — rejects are detected at sorting</em>
            </>
          )}
        </div>
        <div className="mini-kpi" title="Expected = ideal rate × planned running time (planned stops excluded)">
          <span>Rate vs expected</span>
          {io.ratePerHour == null ? (
            <b className="stg-nm">Not measured</b>
          ) : material ? (
            // Slip / powder: t/h — a disclosed conversion of tile-equivalents, never tiles/h.
            <b>
              {fmt1(tileEqToT(io.ratePerHour))}
              <small>t/h</small>
            </b>
          ) : (
            <b>
              {fmtInt(io.ratePerHour)}
              <small>{ms.unit}/h</small>
            </b>
          )}
          <em>
            {io.expectedPerHour != null
              ? `expected ${material ? `${fmt1(tileEqToT(io.expectedPerHour))} t/h` : `${fmtInt(io.expectedPerHour)}/h`}${share != null ? ` · ${fmtPct(share, 0)}` : ''}`
              : 'No expected rate for this stage'}
            {material ? ` · ${MASS_DISCLOSURE}` : ''}
            {row.staleMark ? ' · not confirmed' : ''}
          </em>
        </div>
        <div className="mini-kpi">
          <span>{ms.id === 'WH' ? 'Stock now' : 'Input buffer now'}</span>
          {ms.id === 'WH' ? (
            io.wip != null ? (
              <b>
                {fmtInt(io.wip)}
                <small>{ms.unit}</small>
              </b>
            ) : (
              <b className="stg-nm">Not measured</b>
            )
          ) : !ms.wipBufferId ? (
            <b className="muted">—</b>
          ) : w == null ? (
            <b className="stg-nm">Level not available</b>
          ) : bulkBuffer ? (
            // Slip tanks / powder silos: a level percentage only — no level-to-mass calibration is configured.
            <b>
              {fmtPct(w, 0)}
              <small>level</small>
            </b>
          ) : (
            <b>
              {fmtInt(io.wip)}
              <small>{ms.unit}</small>
            </b>
          )}
          <em>
            {ms.id === 'WH'
              ? 'Pallets in stock (incl. awaiting put-away)'
              : ms.wipBufferId
                ? bulkBuffer
                  ? `${bufferName(ms.wipBufferId)} · ${NO_CALIBRATION.toLowerCase()}`
                  : `${bufferName(ms.wipBufferId)}${w != null ? ` · ${fmtPct(w, 0)} full` : ''}`
                : 'No input buffer at this stage'}
          </em>
          {ms.wipBufferId && (
            <button type="button" className="row-link" onClick={() => openMaterialFlow(ms.wipBufferId)} title="Level, trend, time to empty / full and inflow vs outflow of this buffer">
              Material flow <ArrowRight size={11} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {row.cause && (
        <p className="prod-io-cause">
          <CauseText cause={row.cause} />
        </p>
      )}
      {ms.id !== 'WH' && (
        <p className="prod-io-held muted">
          Averaged over the stage’s machines in the period: {fmt1(io.downMin)} min down · {fmt1(io.starvedMin)} min starved · {fmt1(io.blockedMin)} min blocked.
        </p>
      )}
    </div>
  );
}

// ── Equipment and counting boundary ──────────────────────────────────────────

function EquipmentBlock({ row, onAsset }: { row: StageRow; onAsset: (id: string) => void }) {
  const { ms } = row;
  const material = isMaterialStage(ms);
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
        <span className="stg-inline">
          <AssetState a={a} />
          {a.since != null && <span className="muted">since {sinceLabel(a.since, row.now)}</span>}
        </span>
      ),
    },
    {
      key: 'rate',
      header: 'Rate now',
      numeric: true,
      title: 'Current output (machines) or transported tiles (conveyors) vs ideal rate / nominal capacity · slip and powder in t/h (simulated conversion)',
      render: (a) =>
        a.rate == null ? (
          a.reading ? <span className="muted">{a.reading}</span> : <span className="stg-nm">Not measured</span>
        ) : isMaterialAsset(a.id) ? (
          // Ball mills, spray dryer, powder belt: dry-body equivalent t/h (a disclosed conversion of tile-equivalents).
          <span className="num" title={`${MASS_DISCLOSURE}${a.feed.status === 'stale' ? ' · last value received before the feed went stale' : ''}`}>
            {fmt1(tileEqToT(a.rate))}
            {a.nominal != null && <span className="muted"> / {fmt1(tileEqToT(a.nominal))}</span>}
            <span className="muted"> t/h</span>
            {a.feed.status === 'stale' && <span className="muted"> (last value)</span>}
            <span className="sub">{MASS_DISCLOSURE}</span>
          </span>
        ) : (
          <span className="num" title={a.feed.status === 'stale' ? 'Last value received before the feed went stale' : undefined}>
            {fmtInt(a.rate)}
            {a.nominal != null && <span className="muted"> / {fmtInt(a.nominal)}</span>}
            <span className="muted"> tiles/h</span>
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
          type="button"
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
  const point = (cp: MonitoredStage['input'] | null) =>
    cp ? (
      cp.measured ? (
        <span>
          {cp.label} · <span className="mono">{cp.signalId}</span> · {cp.unit}
        </span>
      ) : (
        <span>
          <span className="stg-nm">Not measured</span> — {cp.label}
          {cp.note ? ` (${cp.note})` : ''}
        </span>
      )
    ) : (
      <span className="muted">No counting point</span>
    );
  return (
    <Block
      title="Machines and conveyors"
      subtitle={`${assets.length} assets · state, rate and data feed now · select a machine for its OEE drill-down`}
      note={<span>No plant data source is connected: every feed is simulated. A feed that stops updating shows “Stale since” and its asset’s state becomes Unknown.</span>}
      flush
    >
      <DataTable
        columns={columns}
        rows={assets}
        rowKey={(a) => a.id}
        onRowClick={(a) => (canDrill(a.id) ? onAsset(a.id) : openEquipment(a.id))}
        maxHeight="none"
        empty="No equipment configured for this stage"
      />
      <div className="prod-pad">
        <Disclosure title="How this stage is counted" meta="counting points and units">
          <Facts
            rows={[
              { label: 'Input', value: point(ms.input) },
              { label: 'Output', value: point(ms.output) },
              { label: 'Good', value: point(ms.good) },
              { label: 'Rejected', value: point(ms.rejected) },
              { label: 'Work in progress', value: ms.id === 'WH' ? 'Warehouse stock (pallets)' : ms.wipBufferId ? `${bufferName(ms.wipBufferId)} (${ms.wipBufferId})` : 'No input buffer' },
              {
                label: 'Unit',
                value:
                  ms.unit === 'pallets'
                    ? 'Pallets (palletised tiles ÷ tiles per pallet)'
                    : material
                      ? `Tile-equivalents of slip / powder; rates in t/h (${MASS_DISCLOSURE}); buffer levels in % only (${NO_CALIBRATION.toLowerCase()})`
                      : 'Tiles',
              },
              { label: 'Standalone OEE', value: ms.oeeMeaningful ? 'Meaningful — see Analysis → Equipment OEE' : 'Not meaningful for a transfer stage' },
            ]}
          />
        </Disclosure>
      </div>
    </Block>
  );
}

// ── Simulated camera view ────────────────────────────────────────────────────

function CameraBlock({ ms }: { ms: MonitoredStage }) {
  const [picked, setPicked] = useState(ms.cameras[0] ?? '');
  const cam = ms.cameras.includes(picked) ? picked : (ms.cameras[0] ?? '');
  return (
    <Block
      title="Camera view"
      subtitle="Simulated view rendered from the digital twin — no camera is connected"
      actions={
        ms.cameras.length > 1 ? <Segmented label="Camera" value={cam} options={ms.cameras.map((id) => ({ value: id, label: id }))} onChange={setPicked} /> : undefined
      }
    >
      {cam ? (
        <figure className="stg-cam">
          <CameraFeed cameraId={cam} compact height={210} />
          <figcaption>
            <span className="mono">{cam}</span> {CAMERA_BY_ID[cam]?.name}
            <span className="muted"> · {CAMERA_BY_ID[cam]?.purpose}</span>
          </figcaption>
        </figure>
      ) : (
        <EmptyState title="No camera position covers this stage" />
      )}
    </Block>
  );
}
