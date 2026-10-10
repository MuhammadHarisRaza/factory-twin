/**
 * Vision inspection station (I-VIS): an illustrative frame viewer over the simulated
 * inspection records, a frame feed that advances with the simulation clock, and the
 * selected defect's classification, context and recommended investigation.
 * No camera, image or vision model is involved — frames are drawn from the records.
 */
import { useState, type KeyboardEvent } from 'react';
import {
  Box,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Filter,
  FlaskConical,
  Locate,
  MessageSquareText,
  Pin,
  Radio,
  ScanLine,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { openEquipment, openStation, useApp } from '../../app/store';
import { DEFECT_ACTIONS } from '../../intel/insights';
import { DEFECTS, STAGE_BY_ID } from '../../model/plant';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { Empty, Panel, Segmented } from '../../ui/kit/Panel';
import { SourceTag } from '../../ui/kit/Status';
import { DefectSeverity, ResultBadge } from './badges';
import { DEFECT_SHORT, FrameThumb, FrameView } from './FrameArt';
import {
  affectingScenario,
  frameById,
  frameContext,
  isFrameStation,
  latestFrames,
  neighbourFrame,
  qualityScenarioImpacts,
  type FeedMode,
  type Frame,
  type FrameContext,
  type QualityScenarioImpact,
} from './frames';
import { PRODUCT_BY_SKU, STATION_BY_ID } from './lookup';
import { SURFACES, surfaceOf } from './tileGeometry';

export const FEED_SIZE = 16;

type Props = {
  /** Selected frame / record id (shared with the history table); null = follow the latest frame. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  batchFilter: string | null;
  onFilterBatch: (batchId: string | null) => void;
};

export function VisionStation({ selected, onSelect, batchFilter, onFilterBatch }: Props) {
  const [mode, setMode] = useState<FeedMode>('all');
  const [zoomId, setZoomId] = useState<string | null>(null);

  const v = useSimValue(
    (s) => {
      const feed = latestFrames(s, FEED_SIZE, mode);
      const pinned = selected ? frameById(s, selected) : null;
      const frame = pinned ?? feed[feed.length - 1] ?? null;
      const affected = new Set(feed.filter((f) => affectingScenario(s, f.rec)).map((f) => f.id));
      let records = 0;
      let tiles = 0;
      for (let i = s.inspections.length - 1; i >= 0 && s.inspections[i].time >= s.minute - 60; i--) {
        const r = s.inspections[i];
        if (r.result === 'reject' && isFrameStation(r.stationId)) {
          records++;
          tiles += r.tiles;
        }
      }
      return {
        now: s.minute,
        feed,
        pinned,
        frame,
        prev: frame ? neighbourFrame(s, frame, -1, mode) : null,
        next: pinned ? neighbourFrame(s, pinned, 1, mode) : null,
        ctx: frame ? frameContext(s, frame) : null,
        affected,
        impacts: qualityScenarioImpacts(s, useSim.getState().baseline),
        lastHour: { records, tiles },
      };
    },
    [mode, selected],
  );

  const { frame, pinned, feed, ctx } = v;
  const following = !pinned;
  const zoomed = !!frame && zoomId === frame.id;
  const canZoom = !!frame?.rec?.box;
  const inFeed = !!frame && feed.some((f) => f.id === frame.id);

  const toggleZoom = () => {
    if (!frame || !canZoom) return;
    if (following) onSelect(frame.id);
    setZoomId(zoomed ? null : frame.id);
  };
  const step = (dir: -1 | 1) => {
    const n = dir < 0 ? v.prev : v.next;
    if (n) onSelect(n.id);
  };
  const toggleFollow = () => onSelect(following ? (frame?.id ?? null) : null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Escape') onSelect(null);
    else if (e.key === 'z' || e.key === 'Z') toggleZoom();
    else return;
    e.preventDefault();
  };

  const st = frame ? STATION_BY_ID[frame.stationId] : STATION_BY_ID['ST-VIS'];
  const product = frame ? PRODUCT_BY_SKU[frame.sku] : undefined;
  const rec = frame?.rec ?? null;
  const frameLabel = frame
    ? rec?.defect
      ? `Illustrative inspection frame: ${DEFECTS[rec.defect].label} on ${product?.name ?? frame.sku}, ${formatDateTime(frame.time)}`
      : `Illustrative sampled pass frame of ${product?.name ?? frame.sku}, ${formatDateTime(frame.time)}`
    : '';

  return (
    <Panel
      className="q-vis-panel"
      title={
        <>
          Vision inspection station · <span className="mono">I-VIS</span>
        </>
      }
      subtitle="Illustrative frame · simulated classification — no vision model runs in this demo"
      actions={
        <button className="btn sm" onClick={() => openStation(frame?.stationId ?? 'ST-VIS')} title={`${st.name} (${st.equipmentId}) in the Factory Twin`}>
          <Locate size={13} /> Show station in twin
        </button>
      }
      footer={
        <span>
          Frames are drawn from simulated inspection records; the box and confidence are simulated outputs. Pass frames are a display sample — every tile is
          inspected. Keys in the viewer: ← → step · Z zoom · Esc follow latest.
        </span>
      }
      flush
    >
      {v.impacts.map((im) => (
        <ScenarioBanner key={im.scenario.id} im={im} now={v.now} batchFilter={batchFilter} onFilterBatch={onFilterBatch} />
      ))}

      <div className="q-vis">
        <div className="q-viewer" role="group" tabIndex={0} onKeyDown={onKey} aria-label="Inspection frame viewer (arrow keys step frames, Z zooms, Esc follows latest)">
          <div className="q-viewer-bar">
            <ScanLine size={14} aria-hidden className="q-viewer-icon" />
            <span className="q-viewer-station">
              {st.name} <span className="mono muted">{st.equipmentId}</span>
            </span>
            {frame && (
              <span className="q-viewer-meta mono">
                {frame.kind === 'pass' ? 'sampled pass frame' : frame.id} · {formatDateTime(frame.time)}
              </span>
            )}
            <span className="spacer" />
            {frame && <ResultChip frame={frame} />}
          </div>
          <div className="q-viewer-img">
            {frame ? (
              <>
                <FrameView frame={frame} zoomed={zoomed} onBoxClick={canZoom ? toggleZoom : undefined} label={frameLabel} />
                <div key={frame.id} className="q-scan" aria-hidden />
              </>
            ) : (
              <Empty title="No inspection frames yet">The sorter has not inspected tiles in the last week of simulated time.</Empty>
            )}
          </div>
          <div className="q-viewer-bar foot">
            {frame && (
              <>
                <span>
                  Batch{' '}
                  <button className="row-link mono" onClick={() => onFilterBatch(batchFilter === frame.batchId ? null : frame.batchId)} title="Filter the inspection history to this batch">
                    {frame.batchId}
                  </button>
                </span>
                <span className="mono dim">{frame.sku}</span>
                <span className="dim">{SURFACES[surfaceOf(frame.sku)].label}</span>
              </>
            )}
            <span className="spacer" />
            {ctx?.scenario && (
              <span className="tag scenario" title={`Raised by scenario: ${ctx.scenario.label}`}>
                <FlaskConical size={11} aria-hidden /> Scenario-affected
              </span>
            )}
            {zoomed && <span className="tag">Zoomed to defect</span>}
            <span className="tag sim">Illustrative frame</span>
            <span className={`q-follow-state ${following ? 'on' : ''}`}>
              {following ? <Radio size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
              {following ? 'Following latest' : 'Pinned'}
            </span>
          </div>
        </div>

        <aside className="q-vis-detail" aria-label="Frame details">
          {frame && ctx ? (
            <FrameDetail frame={frame} ctx={ctx} batchFilter={batchFilter} onFilterBatch={onFilterBatch} zoomed={zoomed} canZoom={canZoom} onZoom={toggleZoom} />
          ) : (
            <Empty title="No frame selected" />
          )}
        </aside>
      </div>

      <div className="q-feed">
        <div className="q-feed-h">
          <div className="q-feed-t">
            <b>Frame feed</b>
            <span className="muted">
              Latest {feed.length} · {mode === 'all' ? 'reject records interleaved with sampled pass frames' : 'reject records only'} · ST-VIS / ST-GAUGE
            </span>
          </div>
          <span className="spacer" />
          <span className="q-feed-stat" title="Reject records at the tunnel and gauge in the last 60 simulated minutes">
            Last 60 min: <b className="num">{fmtInt(v.lastHour.records)}</b> reject records · <span className="num">{fmtInt(v.lastHour.tiles)}</span> tiles
          </span>
          <Segmented
            label="Frames shown in the feed"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'all', label: 'All frames' },
              { value: 'rejects', label: 'Rejects only' },
            ]}
          />
          <div className="q-step">
            <button className="btn sm icon" onClick={() => step(-1)} disabled={!v.prev} aria-label="Previous frame" title="Previous frame (←)">
              <ChevronLeft size={14} />
            </button>
            <button className="btn sm icon" onClick={() => step(1)} disabled={!v.next} aria-label="Next frame" title="Next frame (→)">
              <ChevronRight size={14} />
            </button>
          </div>
          <button className={`btn sm ${following ? 'on' : ''}`} aria-pressed={following} onClick={toggleFollow} title={following ? 'Pin the current frame' : 'Advance with the simulation clock'}>
            <Radio size={13} /> Follow latest
          </button>
        </div>
        {pinned && !inFeed && (
          <div className="q-feed-note">
            <Pin size={12} aria-hidden /> Showing a pinned frame from {formatDateTime(pinned.time)}, outside the latest feed.
            <button className="row-link" onClick={() => onSelect(null)}>
              Back to latest
            </button>
          </div>
        )}
        <div className="q-strip" style={{ gridTemplateColumns: `repeat(${FEED_SIZE}, minmax(0, 1fr))` }}>
          {feed.map((f) => {
            const sel = frame?.id === f.id;
            const aff = v.affected.has(f.id);
            const defect = f.rec?.defect;
            return (
              <button
                key={f.id}
                className={`q-thumb ${f.kind} ${sel ? 'sel' : ''} ${aff ? 'aff' : ''}`}
                aria-pressed={sel}
                onClick={() => onSelect(sel && !following ? null : f.id)}
                title={`${formatDateTime(f.time)} · ${f.kind === 'reject' && defect ? `Reject · ${DEFECTS[defect].label} · ${fmtPct(f.rec?.confidence, 1)}` : 'Sampled pass frame'} · ${f.batchId}${aff ? ' · scenario-affected' : ''}`}
              >
                <FrameThumb frame={f} />
                <span className="q-thumb-cap">
                  <span className={`q-thumb-res ${f.kind}`}>
                    {f.kind === 'reject' ? <CircleX size={11} aria-hidden /> : <CircleCheck size={11} aria-hidden />}
                    <span>{f.kind === 'reject' && defect ? DEFECT_SHORT[defect] : 'Pass'}</span>
                  </span>
                  <span className="q-thumb-t num">{formatClock(f.time)}</span>
                </span>
                {aff && (
                  <span className="q-thumb-flag" aria-label="Scenario-affected">
                    <FlaskConical size={10} aria-hidden />
                  </span>
                )}
              </button>
            );
          })}
          {Array.from({ length: Math.max(0, FEED_SIZE - feed.length) }, (_, i) => (
            <span key={`e${i}`} className="q-thumb empty" aria-hidden />
          ))}
        </div>
        <div className="q-feed-legend" aria-hidden>
          <span>
            <CircleX size={11} className="rej" /> Reject record · box colour = severity
          </span>
          <span>
            <CircleCheck size={11} className="pass" /> Sampled pass frame · no box
          </span>
          <span>
            <FlaskConical size={11} className="aff" /> Raised by an active quality scenario
          </span>
        </div>
      </div>
    </Panel>
  );
}

function ResultChip({ frame }: { frame: Frame }) {
  return frame.kind === 'reject' ? (
    <span className="q-result reject">
      <CircleX size={14} strokeWidth={2.4} aria-hidden /> REJECT
    </span>
  ) : (
    <span className="q-result pass">
      <CircleCheck size={14} strokeWidth={2.4} aria-hidden /> PASS
    </span>
  );
}

function FrameDetail({
  frame,
  ctx,
  batchFilter,
  onFilterBatch,
  zoomed,
  canZoom,
  onZoom,
}: {
  frame: Frame;
  ctx: FrameContext;
  batchFilter: string | null;
  onFilterBatch: (id: string | null) => void;
  zoomed: boolean;
  canZoom: boolean;
  onZoom: () => void;
}) {
  const openCopilot = useApp((s) => s.openCopilot);
  const st = STATION_BY_ID[frame.stationId];
  const product = PRODUCT_BY_SKU[frame.sku];
  const rec = frame.rec;
  const batchOn = batchFilter === frame.batchId;
  const batchRow = (
    <>
      <dt>Batch</dt>
      <dd>
        <button className="row-link mono" onClick={() => onFilterBatch(batchOn ? null : frame.batchId)} title="Filter the inspection history to this batch">
          {frame.batchId}
        </button>{' '}
        <span className="dim">· {product?.name ?? frame.sku}</span>
        <div className="q-vd-sub">
          {fmtInt(ctx.batchRejectTiles)} rejected tiles in batch{ctx.batchTopDefect ? ` · top: ${DEFECTS[ctx.batchTopDefect].label}` : ''}
          {ctx.batch && (ctx.batch.end == null ? ' · active' : ` · ended ${formatClock(ctx.batch.end)}`)}
        </div>
      </dd>
    </>
  );
  const stationRow = (
    <>
      <dt>Station</dt>
      <dd>
        <button className="row-link" onClick={() => openStation(st.id)} title="Show the station in the Factory Twin">
          <Locate size={12} /> {st.name}
        </button>{' '}
        <span className="mono muted">{st.equipmentId}</span>
        <div className="q-vd-sub">{st.method}</div>
      </dd>
    </>
  );
  const batchBtn = (
    <button className={`btn sm ${batchOn ? 'on' : ''}`} aria-pressed={batchOn} onClick={() => onFilterBatch(batchOn ? null : frame.batchId)}>
      <Filter size={13} /> {batchOn ? 'Batch filter on' : 'Filter history to batch'}
    </button>
  );

  if (!rec || rec.result !== 'reject' || !rec.defect) {
    return (
      <div className="q-vd">
        <div className="q-vd-head">
          <ResultBadge result="pass" />
          <span className="tag">Sampled pass frame</span>
        </div>
        <div className="q-vd-class">
          <div className="q-vd-k">Classification · simulated</div>
          <div className="q-vd-defect">No defect detected</div>
          <p className="q-vd-note">Every tile passes the tunnel and the gauge; a passed tile is sampled every few minutes so the feed shows the stream between reject records. No box is drawn.</p>
        </div>
        <dl className="dl">
          <dt>Time</dt>
          <dd>{formatDateTime(frame.time)}</dd>
          {stationRow}
          {batchRow}
          <dt>Station rejects</dt>
          <dd>
            {fmtInt(ctx.stationRecentRecords)} records · {fmtInt(ctx.stationRecentTiles)} tiles <span className="muted">in the 60 min before</span>
          </dd>
        </dl>
        <div className="q-actions">{batchBtn}</div>
      </div>
    );
  }

  const d = DEFECTS[rec.defect];
  const origin = STAGE_BY_ID[d.origin];
  return (
    <div className="q-vd">
      <div className="q-vd-head">
        <ResultBadge result="reject" />
        <SourceTag source={rec.source} />
        {ctx.scenario && (
          <span className="tag scenario" title={`Raised by scenario: ${ctx.scenario.label}`}>
            <FlaskConical size={11} aria-hidden /> Scenario-affected
          </span>
        )}
        <span className="spacer" />
        <span className="mono muted">{rec.id}</span>
      </div>

      <div className="q-vd-class">
        <div className="q-vd-k">Classification · simulated</div>
        <div className="q-vd-defect">{d.label}</div>
        {rec.confidence != null && (
          <div className="q-vd-conf" title="Simulated classification confidence (no model runs)">
            <span>Confidence</span>
            <div className="meter" aria-hidden>
              <i style={{ width: `${rec.confidence * 100}%` }} />
            </div>
            <b className="num">{fmtPct(rec.confidence, 1)}</b>
          </div>
        )}
      </div>

      <dl className="dl">
        <dt>Severity</dt>
        <dd>
          <DefectSeverity severity={rec.severity} />
        </dd>
        <dt>Measurement</dt>
        <dd>{rec.measurement ?? '—'}</dd>
        <dt>Detected</dt>
        <dd>
          {formatDateTime(rec.time)} · {fmtInt(rec.tiles)} tiles
        </dd>
        {stationRow}
        {batchRow}
        <dt>Origin stage</dt>
        <dd>
          {origin.name}
          <div className="q-vd-machines">
            {origin.machines.map((id) => (
              <button key={id} className="row-link mono" onClick={() => openEquipment(id)} title={`Open ${id} in the Factory Twin`}>
                <Box size={12} /> {id}
              </button>
            ))}
          </div>
        </dd>
      </dl>

      <section className="q-vd-rec">
        <h3>Recommended investigation</h3>
        <p>{DEFECT_ACTIONS[rec.defect]}</p>
      </section>

      <div className="q-actions">
        <button className="btn sm" onClick={() => openEquipment(origin.machines[0])} title={`${origin.name}: ${origin.machines[0]}`}>
          <Box size={13} /> View origin machine
        </button>
        {batchBtn}
        {canZoom && (
          <button className={`btn sm ${zoomed ? 'on' : ''}`} aria-pressed={zoomed} onClick={onZoom}>
            {zoomed ? <ZoomOut size={13} /> : <ZoomIn size={13} />} {zoomed ? 'Full tile' : 'Zoom to defect'}
          </button>
        )}
        <button className="btn sm ghost" onClick={() => openCopilot(`Why are we seeing ${d.label.toLowerCase()} rejects?`)} title="Ask the rule-based copilot about this defect">
          <MessageSquareText size={13} /> Ask copilot
        </button>
      </div>
    </div>
  );
}

function ScenarioBanner({
  im,
  now,
  batchFilter,
  onFilterBatch,
}: {
  im: QualityScenarioImpact;
  now: number;
  batchFilter: string | null;
  onFilterBatch: (id: string | null) => void;
}) {
  const sc = im.scenario;
  const stage = sc.stage ? STAGE_BY_ID[sc.stage] : null;
  const b = im.focus.batch;
  const product = PRODUCT_BY_SKU[b.sku];
  const extra = im.baselineRejected != null ? im.rejected - im.baselineRejected : null;
  const others = im.batches.filter((x) => x.batchId !== b.id);
  const on = batchFilter === b.id;
  return (
    <div className="q-scn" role="status">
      <div className="q-scn-cell grow">
        <span className="q-scn-k">
          <FlaskConical size={13} aria-hidden /> Quality scenario active
        </span>
        <b>{sc.label}</b>
        <span className="muted">
          since {formatClock(sc.start)} ({formatDuration(now - sc.start)}) · {stage ? `defects originating at ${stage.name}` : 'all defect categories'}
        </span>
      </div>
      <div className="q-scn-cell">
        <span className="q-scn-k">Affected batch</span>
        <b className="q-scn-batch mono">{b.id}</b>
        <span className="muted">
          {product?.name ?? b.sku}
          {others.length > 0 && ` · also ${others.map((x) => x.batchId).join(', ')}`}
        </span>
      </div>
      <div className="q-scn-cell">
        <span className="q-scn-k">Scenario-affected rejects</span>
        <b className="num">
          {fmtInt(im.tiles)} <small>tiles</small>
        </b>
        <span className="muted">
          {fmtInt(im.records)} frame{im.records === 1 ? '' : 's'} · batch {b.id}: {fmtInt(im.focus.tiles)} tiles
        </span>
      </div>
      <div className="q-scn-cell">
        <span className="q-scn-k">All rejects since {formatClock(im.windowFrom)}</span>
        <b className="num">
          {fmtInt(im.rejected)} <small>tiles</small>
        </b>
        <span className="muted" title="Same seed simulated without any scenario">
          {extra != null ? `no-scenario baseline ${fmtInt(im.baselineRejected)} · ${extra >= 0 ? '+' : '−'}${fmtInt(Math.abs(extra))}` : 'baseline not ready yet'}
        </span>
      </div>
      <div className="q-scn-act">
        <button className={`btn sm ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onFilterBatch(on ? null : b.id)}>
          <Filter size={13} /> {on ? 'Batch filter on' : 'Filter history to batch'}
        </button>
        {stage && (
          <button className="btn sm" onClick={() => openEquipment(stage.machines[0])} title={`${stage.name}: ${stage.machines.join(', ')}`}>
            <Box size={13} /> Origin: {stage.machines[0]}
          </button>
        )}
        <button className="btn sm ghost" onClick={() => useSim.getState().clear(sc.id)}>
          Clear scenario
        </button>
      </div>
    </div>
  );
}
