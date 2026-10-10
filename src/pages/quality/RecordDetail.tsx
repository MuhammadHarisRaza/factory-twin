/**
 * One inspection record in full: the original illustrative frame and the annotated defect crop
 * (FrameArt stills), classification with its source and simulated confidence, association (station,
 * time, batch / tile), production context at the time, the record's effect on good / reject counts
 * and the quality events it belongs to. Everything is read from the shared simulation state.
 */
import { Box, FileText, FlaskConical, Locate, ScanLine, Search, X } from 'lucide-react';
import { openEquipment, openEvent, openStation, useApp } from '../../app/store';
import { DEFECT_ACTIONS } from '../../model/actions';
import { DEFECTS, M2_PER_TILE, STAGE_BY_ID } from '../../model/plant';
import type { OpEvent, ProductionBatch, QualityInspection, ScenarioActivation } from '../../model/types';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { formatClock, formatDateTime } from '../../sim/time';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { EventStatusBadge, MachineStatus, SourceTag } from '../../ui/kit/Status';
import { DefectSeverity, ResultBadge } from './badges';
import { inspectionMethod, isVisionRecord, rejectImpact, fmtMoney, type StateAt } from './derive';
import { FrameStill } from './FrameArt';
import type { Frame } from './frames';
import { PRODUCT_BY_SKU, STATION_BY_ID } from './lookup';
import { STILL_CAPTION } from './still';
import { boxMm } from './tileGeometry';

export type RecordDetailData = {
  rec: QualityInspection;
  batch: ProductionBatch | null;
  frame: Frame | null;
  scenario: ScenarioActivation | null;
  /** Machine states at the record's minute (null state = no longer in the 4-hour minute log). */
  states: StateAt[];
  /** Quality events that reference the record, newest first. */
  events: OpEvent[];
};

type Props = RecordDetailData & {
  /** Tiles inspected in the reporting period (for the quality-rate effect of this record). */
  periodInspected: number;
  periodLabel: string;
  onShowFrame: () => void;
  onShowEvent: (id: string) => void;
  onClose: () => void;
};

export function RecordDetail({ rec, batch, frame, scenario, states, events, periodInspected, periodLabel, onShowFrame, onShowEvent, onClose }: Props) {
  const finance = useApp((s) => s.finance);
  const st = STATION_BY_ID[rec.stationId];
  const method = inspectionMethod(rec.stationId);
  const vision = isVisionRecord(rec);
  const product = batch ? PRODUCT_BY_SKU[batch.sku] : undefined;
  const origin = rec.defect ? STAGE_BY_ID[DEFECTS[rec.defect].origin] : null;
  const reject = rec.result === 'reject';
  const cost = reject ? rejectImpact(finance, rec.tiles) : null;
  const b = rec.box ? boxMm(rec.box) : null;
  const logged = states.some((x) => x.state != null);

  return (
    <Panel
      className="q-rd-panel"
      title={
        <>
          <span className="mono">{rec.id}</span> · inspection record
        </>
      }
      subtitle={`${st?.name ?? rec.stationId} · ${formatDateTime(rec.time)}`}
      actions={
        <button className="btn sm icon ghost" onClick={onClose} aria-label="Close record detail">
          <X size={14} />
        </button>
      }
      footer={
        <>
          <SourceTag source={rec.source} /> Simulated record — the frame is an illustration of it, not a camera image.
        </>
      }
    >
      <div className="q-detail">
        {frame ? (
          <section aria-label="Inspection frames">
            <div className="q-rd-stills">
              <figure>
                <button className="q-rd-still" onClick={onShowFrame} title="Show this frame in the vision viewer">
                  <FrameStill frame={frame} annotated={false} label={`Original illustrative frame of ${rec.id}`} />
                </button>
                <figcaption>Original</figcaption>
              </figure>
              <figure>
                <button className="q-rd-still" onClick={onShowFrame} title="Show this frame in the vision viewer">
                  <FrameStill frame={frame} annotated crop={!!rec.box} label={`Annotated ${rec.box ? 'defect crop' : 'frame'} of ${rec.id}`} />
                </button>
                <figcaption>{rec.box ? (vision ? 'Annotated · defect crop' : 'Annotated · gauge overlay') : 'Annotated'}</figcaption>
              </figure>
            </div>
            <p className="q-rd-cap">
              <ScanLine size={12} aria-hidden /> {STILL_CAPTION}
            </p>
          </section>
        ) : (
          <p className="muted">No frame — {rec.stationId === 'ST-QC' ? 'lab sample checks are not imaged.' : 'this station produces no frame.'}</p>
        )}

        <section>
          <h3>Classification</h3>
          <dl className="dl">
            <dt>Result</dt>
            <dd>
              <ResultBadge result={rec.result} />
            </dd>
            <dt>Category</dt>
            <dd>
              {rec.defect ? DEFECTS[rec.defect].label : <span className="muted">No defect</span>}
              <div className="q-vd-sub">{method.classKind}</div>
            </dd>
            <dt>Model / source</dt>
            <dd>
              <span className="mono">{method.source}</span>
              <div className="q-vd-sub">{method.note}</div>
            </dd>
            <dt>Confidence</dt>
            <dd>
              {vision && rec.confidence != null ? (
                <span title="Produced by deterministic simulation rules — not the output of a model">
                  {fmtPct(rec.confidence, 1)} <span className="tag sim">simulated confidence</span>
                </span>
              ) : (
                <span className="muted">Not applicable — {method.kind === 'gauge' ? 'a measurement against a tolerance' : 'manual sample check'}</span>
              )}
            </dd>
            <dt>Severity</dt>
            <dd>
              <DefectSeverity severity={rec.severity} />
            </dd>
            <dt>Measurement</dt>
            <dd>{rec.measurement ?? '—'}</dd>
            {b && (
              <>
                <dt>Box</dt>
                <dd>
                  {b.w} × {b.h} mm at {b.x}, {b.y} mm <span className="muted">· on the 600 mm tile</span>
                </dd>
              </>
            )}
          </dl>
        </section>

        <section>
          <h3>Association</h3>
          <dl className="dl">
            <dt>Timestamp</dt>
            <dd>{formatDateTime(rec.time)}</dd>
            <dt>Station</dt>
            <dd>
              <button className="row-link" onClick={() => openStation(rec.stationId)} title="Show the station in the Factory Twin">
                <Locate size={12} /> {st?.name ?? rec.stationId}
              </button>{' '}
              <span className="mono muted">{st?.equipmentId}</span>
            </dd>
            <dt>Batch</dt>
            <dd>
              <span className="mono">{rec.batchId}</span> <span className="dim">· {product?.name ?? batch?.sku ?? '—'}</span>
              {batch && (
                <div className="q-vd-sub">
                  {formatDateTime(batch.start)} → {batch.end == null ? 'active' : formatDateTime(batch.end)}
                </div>
              )}
            </dd>
            <dt>Tiles</dt>
            <dd>
              {fmtInt(rec.tiles)} in this record <span className="muted">· tile serial not tracked</span>
            </dd>
          </dl>
        </section>

        <section>
          <h3>Production context</h3>
          <dl className="dl">
            {origin && (
              <>
                <dt>Origin stage</dt>
                <dd>
                  {origin.name}
                  <div className="q-vd-sub">Where {DEFECTS[rec.defect!].label.toLowerCase()} usually originates (process knowledge, not a finding)</div>
                </dd>
              </>
            )}
            <dt>States at {formatClock(rec.time)}</dt>
            <dd>
              {logged ? (
                <ul className="q-rd-states">
                  {states.map((x) => (
                    <li key={x.id}>
                      <button className="row-link mono" onClick={() => openEquipment(x.id)} title={`${x.role} — open ${x.id} in the Factory Twin`}>
                        {x.id}
                      </button>
                      {x.state ? <MachineStatus state={x.state} /> : <span className="muted">not logged</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">Unavailable — the per-minute state log keeps the last 4 hours only</span>
              )}
            </dd>
            {scenario && (
              <>
                <dt>Scenario</dt>
                <dd>
                  <span className="tag scenario">
                    <FlaskConical size={11} aria-hidden /> {scenario.label}
                  </span>
                </dd>
              </>
            )}
          </dl>
        </section>

        <section>
          <h3>Count impact</h3>
          {reject ? (
            <dl className="dl">
              <dt>Good count</dt>
              <dd>
                −{fmtInt(rec.tiles)} tiles <span className="muted">(−{fmt1(rec.tiles * M2_PER_TILE)} m² first quality)</span>
              </dd>
              <dt>Reject count</dt>
              <dd>+{fmtInt(rec.tiles)} tiles</dd>
              <dt>Quality rate</dt>
              <dd>
                {periodInspected > 0 ? `−${((rec.tiles / periodInspected) * 100).toFixed(3)} pts` : '—'}{' '}
                <span className="muted">of {fmtInt(periodInspected)} inspected · {periodLabel.toLowerCase()}</span>
              </dd>
              <dt>Scrap & rework</dt>
              <dd>
                {fmtMoney(finance.currency, cost!.total, 2)} <span className="tag sim">estimate · assumptions shown</span>
                {cost!.lines.map((l) => (
                  <div key={l.label} className="q-vd-sub">
                    {l.label}: {l.basis}
                  </div>
                ))}
              </dd>
            </dl>
          ) : (
            <p className="muted">Counted as good — {fmtInt(rec.tiles)} sample tile{rec.tiles === 1 ? '' : 's'} passed.</p>
          )}
        </section>

        <section>
          <h3>Quality events</h3>
          {events.length ? (
            <ul className="q-rd-events">
              {events.map((e) => (
                <li key={e.id}>
                  <div className="q-rd-ev-h">
                    <EventStatusBadge status={e.status} />
                    <span className="mono">{e.id}</span>
                    <span className="dim">{EVENT_TYPE_LABEL[e.type]}</span>
                  </div>
                  <div className="q-rd-ev-t">{e.title}</div>
                  <div className="q-actions">
                    <button className="btn sm" onClick={() => onShowEvent(e.id)} title="Focus the event and its evidence on this page">
                      <Search size={13} /> Show event & evidence
                    </button>
                    <button className="btn sm ghost" onClick={() => openEvent(e.id)}>
                      <FileText size={13} /> Open report
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Not referenced by a quality event — the record still counts toward the reject-rate and category rules.</p>
          )}
        </section>

        {rec.defect && (
          <section className="q-vd-rec">
            <h3>Recommended investigation</h3>
            <p>{DEFECT_ACTIONS[rec.defect]}</p>
          </section>
        )}

        <div className="q-actions">
          {frame && (
            <button className="btn sm" onClick={onShowFrame}>
              <ScanLine size={13} /> Show in vision viewer
            </button>
          )}
          <button className="btn sm" onClick={() => openStation(rec.stationId)}>
            <Locate size={13} /> Station in Factory Twin
          </button>
          {origin && (
            <button className="btn sm" onClick={() => openEquipment(origin.machines[0])} title={`${origin.name}: ${origin.machines[0]}`}>
              <Box size={13} /> Origin machine
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}
