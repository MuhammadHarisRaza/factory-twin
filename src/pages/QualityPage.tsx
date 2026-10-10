/**
 * Quality Intelligence — inspection results for the shared reporting period.
 * Answers: how many tiles passed first time, what is being rejected, where it comes
 * from and which station / batch is affected. All records are simulated.
 */
import { useMemo, useRef, useState } from 'react';
import { Box, FlaskConical, Info, Locate, ScanLine, X } from 'lucide-react';
import { useApp, openEquipment, openStation } from '../app/store';
import { DEFECT_ACTIONS } from '../intel/insights';
import { BASE_REJECT_RATE, DEFECTS, DEFECT_ORDER, INSPECTION_STATIONS, STAGE_BY_ID } from '../model/plant';
import type { DefectCategory, ProductionBatch, QualityInspection, ScenarioActivation } from '../model/types';
import { defectTrend, qualityIn, resolvePeriod } from '../sim/metrics';
import type { Metric } from '../sim/oee';
import { useSimValue } from '../sim/store';
import { formatClock, formatDateTime, formatDay, shiftAt } from '../sim/time';
import { RankedBars, StackedColumns, type RankedRow } from '../ui/kit/charts';
import { DataTable, type Column } from '../ui/kit/DataTable';
import { fmtInt, fmtM2, fmtPct } from '../ui/kit/format';
import { Empty, Panel } from '../ui/kit/Panel';
import { MetricText, SourceBadge, SourceTag } from '../ui/kit/Status';
import { DefectSeverity, ResultBadge } from './quality/badges';
import { FrameThumb } from './quality/FrameArt';
import { affectingScenario, frameById, isFrameStation, type Frame } from './quality/frames';
import { PRODUCT_BY_SKU, STATION_BY_ID } from './quality/lookup';
import { VisionStation } from './quality/VisionStation';
import './quality.css';

const DEFECT_COLOR = Object.fromEntries(DEFECT_ORDER.map((d, i) => [d, `var(--series-${i + 1})`])) as Record<DefectCategory, string>;
/** Inline stations count every tile; the QC bench only checks samples. */
const INLINE = (id: string) => (STATION_BY_ID[id]?.detects.length ?? 0) > 0;
const HISTORY_LIMIT = 500;

type StationRow = { id: string; inspected: number; rejected: number; rate: number | null; samples: boolean };
type BatchRow = { batch: ProductionBatch; rejectedTiles: number; topDefect: DefectCategory | null; affectedTiles: number };

export function QualityPage() {
  const periodKey = useApp((s) => s.period);

  const data = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const q = qualityIn(s, p);
      const records = s.inspections.filter((r) => r.time >= p.from && r.time < p.to);

      const stations: StationRow[] = INSPECTION_STATIONS.map((st) => {
        if (INLINE(st.id)) {
          const b = q.byStation[st.id];
          return { id: st.id, inspected: b.inspected, rejected: b.rejected, rate: b.inspected > 0 ? b.rejected / b.inspected : null, samples: false };
        }
        // Sample-based station: counts come from its records.
        const own = records.filter((r) => r.stationId === st.id);
        const inspected = own.reduce((a, r) => a + r.tiles, 0);
        const rejected = own.filter((r) => r.result === 'reject').reduce((a, r) => a + r.tiles, 0);
        return { id: st.id, inspected, rejected, rate: inspected > 0 ? rejected / inspected : null, samples: true };
      });

      const bucketMin = periodKey === '7d' ? 480 : 60;
      const trend = defectTrend(s, p, bucketMin);

      const batches: BatchRow[] = s.batches
        .filter((b) => b.start < p.to && (b.end ?? s.minute) > p.from)
        .map((b) => {
          const recs = s.inspections.filter((r) => r.batchId === b.id && r.result === 'reject');
          const byDefect = new Map<DefectCategory, number>();
          for (const r of recs) if (r.defect) byDefect.set(r.defect, (byDefect.get(r.defect) ?? 0) + r.tiles);
          const top = [...byDefect.entries()].sort((a, c) => c[1] - a[1])[0];
          const affectedTiles = recs.reduce((a, r) => a + (affectingScenario(s, r) ? r.tiles : 0), 0);
          return { batch: b, rejectedTiles: recs.reduce((a, r) => a + r.tiles, 0), topDefect: top ? top[0] : null, affectedTiles };
        })
        .reverse();

      // Records raised by a quality-deterioration scenario (defect origin = scenario stage).
      const affected = new Map<string, ScenarioActivation>();
      for (const r of records) {
        const sc = affectingScenario(s, r);
        if (sc) affected.set(r.id, sc);
      }

      return { p, q, records: records.reverse(), stations, trend, bucketMin, batches, affected };
    },
    [periodKey],
  );

  const { q, stations, trend, bucketMin, batches } = data;

  // ── Summary figures ────────────────────────────────────────────────────────
  const fpy: Metric =
    q.inspected <= 0
      ? { value: null, status: 'unavailable', issue: 'No tiles inspected in this period' }
      : q.accepted < 0
        ? { value: null, status: 'invalid', issue: 'More rejects than inspected tiles' }
        : { value: q.accepted / q.inspected, status: 'ok' };
  const rejectRate = q.inspected > 0 ? q.rejected / q.inspected : null;
  const defectTotal = DEFECT_ORDER.reduce((a, d) => a + q.byDefect[d], 0);
  const topDefect = defectTotal > 0 ? [...DEFECT_ORDER].sort((a, b) => q.byDefect[b] - q.byDefect[a])[0] : null;
  const worst = stations.filter((r) => !r.samples && r.rate != null).sort((a, b) => b.rate! - a.rate!)[0];

  // ── History filters & selection ───────────────────────────────────────────
  const [fStation, setFStation] = useState('');
  const [fDefect, setFDefect] = useState('');
  const [fResult, setFResult] = useState('');
  const [fSeverity, setFSeverity] = useState('');
  const [fBatch, setFBatch] = useState<string | null>(null);
  const [fAffected, setFAffected] = useState(false);
  /** Selected record / frame id, shared by the vision viewer and the history table (null = the viewer follows the latest frame). */
  const [selected, setSelected] = useState<string | null>(null);
  const visionRef = useRef<HTMLDivElement>(null);
  const showInViewer = () => visionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const filtered = useMemo(
    () =>
      data.records.filter(
        (r) =>
          (!fStation || r.stationId === fStation) &&
          (!fDefect || r.defect === fDefect) &&
          (!fResult || r.result === fResult) &&
          (!fSeverity || r.severity === fSeverity) &&
          (!fBatch || r.batchId === fBatch) &&
          (!fAffected || data.affected.has(r.id)),
      ),
    [data.records, data.affected, fStation, fDefect, fResult, fSeverity, fBatch, fAffected],
  );
  const shown = filtered.slice(0, HISTORY_LIMIT);
  const anyFilter = fStation || fDefect || fResult || fSeverity || fBatch || fAffected;
  const clearFilters = () => {
    setFStation('');
    setFDefect('');
    setFResult('');
    setFSeverity('');
    setFBatch(null);
    setFAffected(false);
  };

  const detail = useSimValue(
    (s) => {
      if (!selected) return null;
      const rec = s.inspections.find((r) => r.id === selected);
      if (!rec) return null;
      return {
        rec,
        batch: s.batches.find((b) => b.id === rec.batchId) ?? null,
        frame: isFrameStation(rec.stationId) ? frameById(s, rec.id) : null,
        scenario: affectingScenario(s, rec),
      };
    },
    [selected],
  );

  // ── Charts ────────────────────────────────────────────────────────────────
  const defectRows: RankedRow[] = [...DEFECT_ORDER]
    .sort((a, b) => q.byDefect[b] - q.byDefect[a])
    .map((d) => ({
      key: d,
      label: (
        <>
          {DEFECTS[d].label}
          <span className="muted"> · {STAGE_BY_ID[DEFECTS[d].origin].name}</span>
        </>
      ),
      value: q.byDefect[d],
      share: defectTotal > 0 ? q.byDefect[d] / defectTotal : 0,
      color: DEFECT_COLOR[d],
    }));

  const trendLabels = trend.map((b) => (bucketMin >= 480 ? `${formatDay(b.start).split(' ').slice(0, 2).join(' ')} · ${shiftAt(b.start).id}` : formatClock(b.start)));
  const trendValues = trend.map((b) => DEFECT_ORDER.map((d) => b.byDefect[d]));
  const tickEvery = trend.length > 16 ? 3 : trend.length > 10 ? 2 : 1;

  // ── Tables ────────────────────────────────────────────────────────────────
  const stationCols: Column<StationRow>[] = [
    {
      key: 'station',
      header: 'Station',
      render: (r) => STATION_BY_ID[r.id].name,
      sort: (r) => STATION_BY_ID[r.id].name,
    },
    { key: 'eq', header: 'Equipment', render: (r) => <span className="mono">{STATION_BY_ID[r.id].equipmentId}</span> },
    { key: 'method', header: 'Method', render: (r) => <span className="dim">{STATION_BY_ID[r.id].method}</span> },
    {
      key: 'detects',
      header: 'Defects detected',
      render: (r) => {
        const d = STATION_BY_ID[r.id].detects;
        const text = d.length ? d.map((x) => DEFECTS[x].label).join(', ') : 'Lab sample checks (water absorption, MOR)';
        return <span title={text}>{text}</span>;
      },
    },
    {
      key: 'inspected',
      header: 'Inspected',
      numeric: true,
      render: (r) => (
        <>
          {fmtInt(r.inspected)}
          {r.samples && <span className="sub">samples</span>}
        </>
      ),
      sort: (r) => r.inspected,
    },
    { key: 'rejected', header: 'Rejected', numeric: true, render: (r) => fmtInt(r.rejected), sort: (r) => r.rejected },
    { key: 'rate', header: 'Reject rate', numeric: true, render: (r) => fmtPct(r.rate, 2), sort: (r) => r.rate },
    { key: 'src', header: 'Source', render: () => <SourceBadge status="simulated" /> },
    {
      key: 'twin',
      header: '',
      render: (r) => (
        <button className="row-link" onClick={(e) => {
            e.stopPropagation();
            openStation(r.id);
          }}>
          <Locate size={12} /> Show in twin
        </button>
      ),
    },
  ];

  const historyCols: Column<QualityInspection>[] = [
    { key: 'time', header: 'Time', render: (r) => formatDateTime(r.time), sort: (r) => r.time },
    { key: 'id', header: 'Record', render: (r) => <span className="mono">{r.id}</span> },
    { key: 'station', header: 'Station', render: (r) => STATION_BY_ID[r.stationId]?.name ?? r.stationId, sort: (r) => r.stationId },
    { key: 'batch', header: 'Batch', render: (r) => <span className="mono">{r.batchId}</span>, sort: (r) => r.batchId },
    { key: 'result', header: 'Result', render: (r) => <ResultBadge result={r.result} />, sort: (r) => r.result },
    {
      key: 'defect',
      header: 'Defect',
      render: (r) => {
        const sc = data.affected.get(r.id);
        if (!r.defect) return <span className="muted">—</span>;
        return (
          <>
            {DEFECTS[r.defect].label}
            {sc && (
              <span className="q-aff" title={`Raised by scenario: ${sc.label}`}>
                <FlaskConical size={11} aria-hidden />
                <span className="q-sr">Scenario-affected</span>
              </span>
            )}
          </>
        );
      },
      sort: (r) => (r.defect ? DEFECTS[r.defect].label : null),
    },
    {
      key: 'sev',
      header: 'Severity',
      render: (r) => <DefectSeverity severity={r.severity} />,
      sort: (r) => (r.severity ? ['minor', 'major', 'critical'].indexOf(r.severity) : null),
    },
    { key: 'meas', header: 'Measurement', render: (r) => <span title={r.measurement ?? undefined}>{r.measurement ?? '—'}</span> },
    { key: 'tiles', header: 'Tiles', numeric: true, render: (r) => fmtInt(r.tiles), sort: (r) => r.tiles },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.source} /> },
  ];

  const batchCols: Column<BatchRow>[] = [
    {
      key: 'id',
      header: 'Batch',
      render: (r) => (
        <>
          <span className="mono">{r.batch.id}</span>
          {r.affectedTiles > 0 && (
            <span className="q-aff" title={`${fmtInt(r.affectedTiles)} rejected tiles raised by a quality scenario`}>
              <FlaskConical size={11} aria-hidden />
              <span className="q-sr">Scenario-affected</span>
            </span>
          )}
        </>
      ),
      sort: (r) => r.batch.start,
    },
    {
      key: 'product',
      header: 'Product',
      render: (r) => <span title={PRODUCT_BY_SKU[r.batch.sku]?.name}>{PRODUCT_BY_SKU[r.batch.sku]?.name ?? r.batch.sku}</span>,
      sort: (r) => r.batch.sku,
    },
    { key: 'start', header: 'Start', render: (r) => formatDateTime(r.batch.start), sort: (r) => r.batch.start },
    { key: 'end', header: 'End', render: (r) => (r.batch.end == null ? <span className="dim">Active</span> : formatDateTime(r.batch.end)), sort: (r) => r.batch.end ?? Infinity },
    { key: 'rej', header: 'Rejected tiles', numeric: true, render: (r) => fmtInt(r.rejectedTiles), sort: (r) => r.rejectedTiles },
    { key: 'top', header: 'Top defect', render: (r) => (r.topDefect ? DEFECTS[r.topDefect].label : <span className="muted">—</span>) },
  ];

  return (
    <div className="page quality-page">
      <div className="col-12 notice">
        <Info size={14} aria-hidden />
        <span>
          <b>Inspection records are simulated and illustrative.</b> No camera feed or computer vision runs in this release; this module is the foundation
          for a future vision-system integration.
        </span>
      </div>

      <section className="summary" aria-label="Quality summary">
        <div>
          <div className="kpi-label">First-pass yield</div>
          <div className="kpi-value">
            <MetricText m={fpy} digits={1} />
          </div>
          <div className="kpi-sub">
            <span>Accepted ÷ inspected · {data.p.label}</span>
          </div>
          {fpy.status === 'ok' && (
            <div className="meter" aria-hidden>
              <i style={{ width: `${fpy.value! * 100}%` }} />
            </div>
          )}
        </div>
        <div>
          <div className="kpi-label">Inspected</div>
          <div className="kpi-value">
            {fmtInt(q.inspected)}
            <small>tiles</small>
          </div>
          <div className="kpi-sub">{fmtM2(q.inspected)} m² sorted</div>
        </div>
        <div>
          <div className="kpi-label">Accepted</div>
          <div className="kpi-value">
            {fmtInt(q.accepted)}
            <small>tiles</small>
          </div>
          <div className="kpi-sub">{fmtM2(q.accepted)} m² first quality</div>
        </div>
        <div>
          <div className="kpi-label">Rejected</div>
          <div className="kpi-value">
            {fmtInt(q.rejected)}
            <small>tiles</small>
          </div>
          <div className="kpi-sub">
            <span>{fmtPct(rejectRate, 2)} reject rate</span>
            <span>baseline {fmtPct(BASE_REJECT_RATE, 1)}</span>
          </div>
        </div>
        <div>
          <div className="kpi-label">Top defect</div>
          <div className="kpi-headline">{topDefect ? DEFECTS[topDefect].label : 'None recorded'}</div>
          <div className="kpi-sub">
            {topDefect && (
              <>
                <span>{fmtPct(q.byDefect[topDefect] / defectTotal, 0)} of rejects</span>
                <span>origin: {STAGE_BY_ID[DEFECTS[topDefect].origin].name}</span>
              </>
            )}
          </div>
        </div>
        <div>
          <div className="kpi-label">Worst station</div>
          <div className="kpi-headline">{worst ? STATION_BY_ID[worst.id].name : 'No inspections'}</div>
          <div className="kpi-sub">{worst && <span>{fmtPct(worst.rate, 2)} reject rate</span>}</div>
        </div>
      </section>

      <div className="col-12 q-vis-anchor" ref={visionRef}>
        <VisionStation selected={selected} onSelect={setSelected} batchFilter={fBatch} onFilterBatch={setFBatch} />
      </div>

      <div className="col-7">
        <Panel
          title="Inspection stations"
          subtitle="Registry of inspection points mapped to 3D equipment"
          flush
          footer="Inline stations check every sorted tile; the QC bench checks hourly samples (counts are sample tiles)."
        >
          <DataTable columns={stationCols} rows={stations} rowKey={(r) => r.id} onRowClick={(r) => setFStation(r.id)} maxHeight="none" />
        </Panel>
      </div>

      <div className="col-5">
        <Panel title="Defects by category" subtitle="Rejected tiles · origin stage · share of rejects" footer="Click a category to filter the inspection history.">
          {defectTotal > 0 ? (
            <RankedBars rows={defectRows} format={fmtInt} valueHeader="Tiles" showCumulative={false} onSelect={(r) => setFDefect(r.key)} />
          ) : (
            <Empty title="No rejects in this period" />
          )}
        </Panel>
      </div>

      <div className="col-7">
        <Panel title="Defect trend" subtitle={`Rejected tiles per ${bucketMin >= 480 ? 'shift' : 'hour'}, by defect category`}>
          {trend.length ? (
            <StackedColumns
              labels={trendLabels}
              series={DEFECT_ORDER.map((d) => ({ key: d, label: DEFECTS[d].label, color: DEFECT_COLOR[d] }))}
              values={trendValues}
              format={fmtInt}
              tickEvery={tickEvery}
              height={210}
            />
          ) : (
            <Empty title="No inspection data in this period" />
          )}
        </Panel>
      </div>

      <div className="col-5">
        <Panel title="Production batches" subtitle="Batches active in the period · click to filter records" flush>
          <DataTable
            columns={batchCols}
            rows={batches}
            rowKey={(r) => r.batch.id}
            onRowClick={(r) => setFBatch(fBatch === r.batch.id ? null : r.batch.id)}
            selectedKey={fBatch}
            maxHeight={280}
            empty="No batches in this period"
          />
        </Panel>
      </div>

      <div className={detail ? 'col-8' : 'col-12'}>
        <Panel
          title="Inspection event history"
          subtitle={`${fmtInt(filtered.length)} records · newest first${filtered.length > HISTORY_LIMIT ? ` · showing latest ${HISTORY_LIMIT}` : ''}`}
          flush
          actions={
            <div className="q-filters">
              {fBatch && (
                <button className="btn sm on" onClick={() => setFBatch(null)} title="Clear batch filter">
                  Batch {fBatch} <X size={12} />
                </button>
              )}
              {(fAffected || data.affected.size > 0) && (
                <button
                  className={`btn sm ${fAffected ? 'on' : ''}`}
                  aria-pressed={fAffected}
                  onClick={() => setFAffected(!fAffected)}
                  title="Only records raised by a quality-deterioration scenario"
                >
                  <FlaskConical size={12} /> Scenario-affected {fmtInt(data.affected.size)}
                </button>
              )}
              <select className="select" value={fStation} onChange={(e) => setFStation(e.target.value)} aria-label="Filter by station">
                <option value="">All stations</option>
                {INSPECTION_STATIONS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select className="select" value={fDefect} onChange={(e) => setFDefect(e.target.value)} aria-label="Filter by defect">
                <option value="">All defects</option>
                {DEFECT_ORDER.map((d) => (
                  <option key={d} value={d}>
                    {DEFECTS[d].label}
                  </option>
                ))}
              </select>
              <select className="select" value={fResult} onChange={(e) => setFResult(e.target.value)} aria-label="Filter by result">
                <option value="">All results</option>
                <option value="reject">Reject</option>
                <option value="pass">Pass</option>
              </select>
              <select className="select" value={fSeverity} onChange={(e) => setFSeverity(e.target.value)} aria-label="Filter by severity">
                <option value="">All severities</option>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="critical">Critical</option>
              </select>
              {anyFilter && (
                <button className="btn sm ghost" onClick={clearFilters}>
                  Clear
                </button>
              )}
            </div>
          }
        >
          <DataTable
            columns={historyCols}
            rows={shown}
            rowKey={(r) => r.id}
            onRowClick={(r) => setSelected(r.id === selected ? null : r.id)}
            selectedKey={selected}
            maxHeight={440}
            empty={anyFilter ? 'No records match the filters' : 'No inspection records in this period'}
          />
        </Panel>
      </div>

      {detail && (
        <RecordDetail
          rec={detail.rec}
          batch={detail.batch}
          frame={detail.frame}
          scenario={detail.scenario}
          onShowFrame={showInViewer}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function RecordDetail({
  rec,
  batch,
  frame,
  scenario,
  onShowFrame,
  onClose,
}: {
  rec: QualityInspection;
  batch: ProductionBatch | null;
  frame: Frame | null;
  scenario: ScenarioActivation | null;
  onShowFrame: () => void;
  onClose: () => void;
}) {
  const st = STATION_BY_ID[rec.stationId];
  const product = batch ? PRODUCT_BY_SKU[batch.sku] : undefined;
  const origin = rec.defect ? STAGE_BY_ID[DEFECTS[rec.defect].origin] : null;
  return (
    <div className="col-4">
      <Panel
        title={<span className="mono">{rec.id}</span>}
        subtitle="Inspection record"
        actions={
          <button className="btn sm icon ghost" onClick={onClose} aria-label="Close detail">
            <X size={14} />
          </button>
        }
        footer={
          <>
            <SourceTag source={rec.source} /> Illustrative record generated by the simulation.
          </>
        }
      >
        <div className="q-detail">
          {frame && (
            <section className="q-rd-frame">
              <button className="q-rd-thumb" onClick={onShowFrame} title="Show this frame in the vision viewer">
                <FrameThumb frame={frame} />
              </button>
              <div>
                <h3>Inspection frame</h3>
                <p className="muted">Illustrative frame · simulated classification. Selected in the vision viewer.</p>
                {scenario && (
                  <p>
                    <span className="tag scenario" title={`Raised by scenario: ${scenario.label}`}>
                      <FlaskConical size={11} aria-hidden /> Scenario-affected
                    </span>
                  </p>
                )}
                <button className="btn sm" onClick={onShowFrame}>
                  <ScanLine size={13} /> Show in vision viewer
                </button>
              </div>
            </section>
          )}
          <section>
            <h3>Record</h3>
            <dl className="dl">
              <dt>Time</dt>
              <dd>{formatDateTime(rec.time)}</dd>
              <dt>Result</dt>
              <dd>
                <ResultBadge result={rec.result} />
              </dd>
              <dt>Defect</dt>
              <dd>{rec.defect ? DEFECTS[rec.defect].label : '—'}</dd>
              <dt>Severity</dt>
              <dd>
                <DefectSeverity severity={rec.severity} />
              </dd>
              <dt>Measurement</dt>
              <dd>{rec.measurement ?? '—'}</dd>
              {rec.confidence != null && (
                <>
                  <dt>Confidence</dt>
                  <dd title="Simulated classification confidence (no model runs)">{fmtPct(rec.confidence, 1)} · simulated</dd>
                </>
              )}
              <dt>Tiles</dt>
              <dd>{fmtInt(rec.tiles)}</dd>
              {origin && (
                <>
                  <dt>Origin stage</dt>
                  <dd>{origin.name}</dd>
                </>
              )}
            </dl>
          </section>
          <section>
            <h3>Batch</h3>
            {batch ? (
              <dl className="dl">
                <dt>Batch</dt>
                <dd className="mono">{batch.id}</dd>
                <dt>SKU</dt>
                <dd className="mono">{batch.sku}</dd>
                <dt>Product</dt>
                <dd>{product?.name ?? '—'}</dd>
                <dt>Start</dt>
                <dd>{formatDateTime(batch.start)}</dd>
                <dt>End</dt>
                <dd>{batch.end == null ? 'Active' : formatDateTime(batch.end)}</dd>
              </dl>
            ) : (
              <p className="muted">Batch {rec.batchId} not found.</p>
            )}
          </section>
          {rec.defect && (
            <section>
              <h3>Recommended investigation</h3>
              <p>{DEFECT_ACTIONS[rec.defect]}</p>
            </section>
          )}
          <section>
            <h3>Station</h3>
            <dl className="dl">
              <dt>Station</dt>
              <dd>{st?.name ?? rec.stationId}</dd>
              <dt>Equipment</dt>
              <dd className="mono">{st?.equipmentId ?? '—'}</dd>
              <dt>Method</dt>
              <dd>{st?.method ?? '—'}</dd>
            </dl>
          </section>
          <div className="q-actions">
            <button className="btn sm" onClick={() => openStation(rec.stationId)}>
              <Locate size={13} /> View station in Factory Twin
            </button>
            {origin && (
              <button className="btn sm" onClick={() => openEquipment(origin.machines[0])} title={`${origin.name}: ${origin.machines[0]}`}>
                <Box size={13} /> View origin stage machine
              </button>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
