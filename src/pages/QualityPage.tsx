/**
 * AI Defect Monitoring — the inspection workflow made explicit and connected to the event system.
 *
 *   capture → (simulated) inference → classify & localise → associate → rule → store → counts & OEE → event
 *
 * One selected record drives every view on the page: the vision viewer, the workflow strip, the
 * record detail (original frame + annotated defect crop), its quality event with evidence and
 * lifecycle actions, the root-cause hypotheses and the scrap / rework impact. Records, classes,
 * boxes and confidences are simulated by deterministic rules — no camera or vision model runs.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { BellRing, Cpu, FlaskConical, Info, Locate, Ruler, X } from 'lucide-react';
import { openStation, useApp } from '../app/store';
import { eventImpact } from '../intel/report';
import { BASE_REJECT_RATE, DEFECTS, DEFECT_ORDER, INSPECTION_STATIONS, STAGE_BY_ID } from '../model/plant';
import type { DefectCategory, ProductionBatch } from '../model/types';
import { defectTrend, qualityIn, resolvePeriod } from '../sim/metrics';
import type { Metric } from '../sim/oee';
import { useSim, useSimValue } from '../sim/store';
import { formatClock, formatDateTime, formatDay, shiftAt } from '../sim/time';
import { RankedBars, StackedColumns, type RankedRow } from '../ui/kit/charts';
import { DataTable, type Column } from '../ui/kit/DataTable';
import { fmtInt, fmtM2, fmtPct } from '../ui/kit/format';
import { Empty, Panel } from '../ui/kit/Panel';
import { MetricText, SourceBadge } from '../ui/kit/Status';
import {
  GAUGE_CLASSES,
  SIM_MODEL,
  VISION_CLASSES,
  VISION_NOTE,
  contextStates,
  eventsOfRecord,
  fmtMoney,
  impactFigures,
  inspectionEventLinks,
  inspectionMethod,
  periodQualityImpact,
  qualityEventsIn,
  ruleChecks,
} from './quality/derive';
import { affectingScenario, frameById, isFrameStation, viewerFrame, type FeedMode } from './quality/frames';
import { keepUnchanged, periodRecords, scenarioAffected, useStable, type HistoryInputs } from './quality/history';
import { HistoryTable } from './quality/HistoryTable';
import { PRODUCT_BY_SKU, STATION_BY_ID } from './quality/lookup';
import { QualityEvents, type ImpactFigures } from './quality/QualityEvents';
import { RecordDetail } from './quality/RecordDetail';
import { RootCause } from './quality/RootCause';
import { ScrapImpact } from './quality/ScrapImpact';
import { FEED_SIZE, VisionStation } from './quality/VisionStation';
import { WorkflowStrip, type WorkflowSubject } from './quality/WorkflowStrip';
// Registers the inspection-image rasteriser (reports and the PDF draw the same frames).
import './quality/rasterise';
import './quality.css';

const DEFECT_COLOR = Object.fromEntries(DEFECT_ORDER.map((d, i) => [d, `var(--series-${i + 1})`])) as Record<DefectCategory, string>;
/** Inline stations count every tile; the QC bench only checks samples. */
const INLINE = (id: string) => (STATION_BY_ID[id]?.detects.length ?? 0) > 0;
const HISTORY_LIMIT = 500;
const scrollTo = (el: HTMLElement | null) => el?.scrollIntoView({ behavior: 'smooth', block: 'start' });

type StationRow = { id: string; inspected: number; rejected: number; rate: number | null; samples: boolean };
type BatchRow = { batch: ProductionBatch; rejectedTiles: number; topDefect: DefectCategory | null; affectedTiles: number };

export function QualityPage() {
  // Reset Demo rebuilds the seeded plant: filters, the pinned record and the focused event refer to
  // records of the discarded run, so the workspace remounts with it (review finding #31).
  const resets = useSim((s) => s.resets);
  return <QualityWorkspace key={resets} />;
}

function QualityWorkspace() {
  const periodKey = useApp((s) => s.period);
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);

  const data = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const q = qualityIn(s, p);
      const records = periodRecords(s, p);

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
      const affected = scenarioAffected(s, records);

      // Events: the same OpEvent records as Events & Reports; impact = the report's EventImpact.
      const links = inspectionEventLinks(s);
      const events = qualityEventsIn(s, p);
      const impacts = new Map<string, ImpactFigures>();
      for (const e of [...events.open, ...events.resolved]) impacts.set(e.id, impactFigures(eventImpact(s, e, finance, tariffs)));
      const impact = periodQualityImpact(s, p, finance, useSim.getState().baseline);

      return { p, q, records, stations, trend, bucketMin, batches, affected, links, events, impacts, impact };
    },
    [periodKey, finance, tariffs],
  );

  const { q, stations, trend, bucketMin, batches, events, impact } = data;
  // Record table inputs keep their identity while their content is unchanged, so the memoised
  // 500-row table skips the simulated minutes that add no record or link (review2 finding #30).
  const fresh = useMemo((): HistoryInputs => ({ records: data.records, affected: data.affected, links: data.links }), [data]);
  const hist = useStable(fresh, keepUnchanged);

  // ── Selection: one record / frame drives the viewer, workflow, detail and event focus ──────
  const [mode, setMode] = useState<FeedMode>('all');
  /** Selected record / frame id (null = the viewer follows the latest frame). */
  const [selected, setSelected] = useState<string | null>(null);
  /** Event focused by a click (null = follow the selected record's event, else the top open event). */
  const [focus, setFocus] = useState<string | null>(null);
  const visionRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<HTMLDivElement>(null);

  /** Selecting a record lets its quality event take the focus. */
  const selectRecord = useCallback((id: string | null) => {
    setSelected(id);
    setFocus(null);
  }, []);

  // ── History filters ───────────────────────────────────────────────────────
  const [fStation, setFStation] = useState('');
  const [fDefect, setFDefect] = useState('');
  const [fResult, setFResult] = useState('');
  const [fSeverity, setFSeverity] = useState('');
  const [fBatch, setFBatch] = useState<string | null>(null);
  const [fAffected, setFAffected] = useState(false);
  const [fEvent, setFEvent] = useState(false);

  const filtered = useMemo(
    () =>
      hist.records.filter(
        (r) =>
          (!fStation || r.stationId === fStation) &&
          (!fDefect || r.defect === fDefect) &&
          (!fResult || r.result === fResult) &&
          (!fSeverity || r.severity === fSeverity) &&
          (!fBatch || r.batchId === fBatch) &&
          (!fAffected || hist.affected.has(r.id)) &&
          (!fEvent || hist.links.has(r.id)),
      ),
    [hist, fStation, fDefect, fResult, fSeverity, fBatch, fAffected, fEvent],
  );
  const shown = useMemo(() => filtered.slice(0, HISTORY_LIMIT), [filtered]);
  const inEvents = useMemo(() => hist.records.reduce((a, r) => a + (hist.links.has(r.id) ? 1 : 0), 0), [hist]);
  const anyFilter = fStation || fDefect || fResult || fSeverity || fBatch || fAffected || fEvent;
  const clearFilters = () => {
    setFStation('');
    setFDefect('');
    setFResult('');
    setFSeverity('');
    setFBatch(null);
    setFAffected(false);
    setFEvent(false);
  };

  // ── Workflow subject: the selected record, else the frame the viewer shows ─────────────────
  const flow = useSimValue(
    (s): WorkflowSubject | null => {
      const frame = viewerFrame(s, selected, FEED_SIZE, mode);
      const selRec = selected ? (s.inspections.find((r) => r.id === selected) ?? null) : null;
      const rec = selRec ?? frame?.rec ?? null;
      // A lab sample has no frame: the viewer keeps the latest one, the workflow shows the sample.
      const shownFrame = selRec && !isFrameStation(selRec.stationId) ? null : frame;
      if (!rec && !shownFrame) return null;
      const time = rec?.time ?? shownFrame!.time;
      const stationId = rec?.stationId ?? shownFrame!.stationId;
      const batchId = rec?.batchId ?? shownFrame!.batchId;
      return {
        rec,
        frame: shownFrame,
        time,
        stationId,
        batchId,
        batch: s.batches.find((b) => b.id === batchId) ?? null,
        pinned: !!selected && (!!selRec || frame?.id === selected),
        rules: ruleChecks(s, { time, rec }),
        events: rec ? eventsOfRecord(s, hist.links, rec.id) : [],
      };
    },
    [selected, mode, hist.links],
  );

  const detail = useSimValue(
    (s) => {
      if (!selected) return null;
      const rec = s.inspections.find((r) => r.id === selected);
      if (!rec) return null;
      return {
        rec,
        batch: s.batches.find((b) => b.id === rec.batchId) ?? null,
        frame: frameById(s, rec.id),
        scenario: affectingScenario(s, rec),
        states: contextStates(s, rec),
        events: eventsOfRecord(s, hist.links, rec.id),
      };
    },
    [selected, hist.links],
  );

  const autoFocus = (flow?.pinned ? flow.events[0]?.id : undefined) ?? events.open[0]?.id ?? events.resolved[0]?.id ?? null;
  const focusId = focus ?? autoFocus;
  const showEvent = useCallback((id: string) => {
    setFocus(id);
    scrollTo(eventsRef.current);
  }, []);
  const pinRecord = (id: string) => {
    setFocus(focusId);
    setSelected(id);
    scrollTo(visionRef.current);
  };

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
  const activeConditions = events.open.filter((e) => e.end == null).length;

  // ── Defect classes ─────────────────────────────────────────────────────────
  const classRows = (list: DefectCategory[]): RankedRow[] =>
    [...list]
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
  const toggleDefect = (d: string) => setFDefect(fDefect === d ? '' : d);

  const trendLabels = trend.map((b) => (bucketMin >= 480 ? `${formatDay(b.start).split(' ').slice(0, 2).join(' ')} · ${shiftAt(b.start).id}` : formatClock(b.start)));
  const trendValues = trend.map((b) => DEFECT_ORDER.map((d) => b.byDefect[d]));
  const tickEvery = trend.length > 16 ? 3 : trend.length > 10 ? 2 : 1;

  // ── Tables ────────────────────────────────────────────────────────────────
  const stationCols: Column<StationRow>[] = [
    { key: 'station', header: 'Station', render: (r) => STATION_BY_ID[r.id].name, sort: (r) => STATION_BY_ID[r.id].name },
    { key: 'eq', header: 'Equipment', render: (r) => <span className="mono">{STATION_BY_ID[r.id].equipmentId}</span> },
    { key: 'method', header: 'Method', render: (r) => <span className="dim">{STATION_BY_ID[r.id].method}</span> },
    {
      key: 'inference',
      header: 'Result source',
      render: (r) => {
        const m = inspectionMethod(r.id);
        return (
          <span title={m.note}>
            <span className={m.kind === 'vision' ? 'mono' : ''}>{m.source}</span>
            <span className="sub">{m.classKind}</span>
          </span>
        );
      },
    },
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
    { key: 'src', header: 'Data source', render: () => <SourceBadge status="simulated" /> },
    {
      key: 'twin',
      header: '',
      render: (r) => (
        <button
          className="row-link"
          onClick={(e) => {
            e.stopPropagation();
            openStation(r.id);
          }}
        >
          <Locate size={12} /> Show in twin
        </button>
      ),
    },
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

  const eventRows = [...events.open, ...events.resolved].map((ev) => ({ ev, f: data.impacts.get(ev.id)! })).filter((r) => r.f);

  return (
    <div className="page quality-page">
      <div className="col-12 notice">
        <Info size={14} aria-hidden />
        <span>
          <b>Simulated inference — no vision model.</b> Inspection records, classes, boxes and confidences come from deterministic simulation rules (
          <span className="mono">{SIM_MODEL}</span>); frames are illustrations of those records, not camera images. {VISION_NOTE}
        </span>
      </div>

      <section className="summary" aria-label="Defect monitoring summary">
        <div>
          <div className="kpi-label">First-pass yield</div>
          <div className="kpi-value">
            <MetricText m={fpy} digits={1} />
          </div>
          <div className="kpi-sub">
            <span>Quality rate (OEE Q) · {data.p.label}</span>
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
          <div className="kpi-sub">
            <span>{fmtInt(q.accepted)} accepted</span>
            <span>{fmtM2(q.accepted)} m²</span>
          </div>
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
                <span>{DEFECTS[topDefect].station === 'ST-VIS' ? 'vision class' : 'gauge measurement'}</span>
              </>
            )}
          </div>
        </div>
        <div>
          <div className="kpi-label">Open quality events</div>
          <div className="kpi-value">
            <button className="q-kpi-link" onClick={() => scrollTo(eventsRef.current)} title="Go to the quality events">
              {fmtInt(events.open.length)}
            </button>
          </div>
          <div className="kpi-sub">
            <span>{activeConditions} condition{activeConditions === 1 ? '' : 's'} active</span>
            <span>{fmtInt(events.resolved.length)} resolved in period</span>
          </div>
        </div>
        <div>
          <div className="kpi-label">Scrap & rework</div>
          <div className="kpi-value">{fmtMoney(finance.currency, impact.total)}</div>
          <div className="kpi-sub">
            <span className="tag sim">estimate · assumptions shown</span>
          </div>
        </div>
      </section>

      <div className="col-12">
        <WorkflowStrip
          subject={flow}
          counts={{ label: data.p.label, inspected: q.inspected, accepted: q.accepted, rejected: q.rejected, quality: impact.quality, oee: impact.oee }}
          onShowEvent={showEvent}
        />
      </div>

      <div className="col-12 q-anchor" ref={visionRef}>
        <VisionStation selected={selected} onSelect={selectRecord} mode={mode} onMode={setMode} batchFilter={fBatch} onFilterBatch={setFBatch} />
      </div>

      <div className="col-7 q-anchor" ref={eventsRef}>
        <QualityEvents
          open={events.open}
          resolved={events.resolved}
          impacts={data.impacts}
          focusId={focusId}
          focusAuto={focus == null}
          periodLabel={data.p.label}
          onFocus={setFocus}
          onPinRecord={pinRecord}
        />
      </div>

      <div className="col-5">
        <RootCause eventId={focusId} onFocus={setFocus} />
      </div>

      <div className={detail ? 'col-8' : 'col-12'}>
        <Panel
          title="Inspection records"
          subtitle={`${fmtInt(filtered.length)} records · newest first${filtered.length > HISTORY_LIMIT ? ` · showing latest ${HISTORY_LIMIT}` : ''} · select one for its frames, context and event`}
          flush
          actions={
            <div className="q-filters">
              {fBatch && (
                <button className="btn sm on" onClick={() => setFBatch(null)} title="Clear batch filter">
                  Batch {fBatch} <X size={12} />
                </button>
              )}
              <button
                className={`btn sm ${fEvent ? 'on' : ''}`}
                aria-pressed={fEvent}
                onClick={() => setFEvent(!fEvent)}
                title="Only records referenced by a quality event (event refs or inspection-image evidence)"
              >
                <BellRing size={12} /> In an event {fmtInt(inEvents)}
              </button>
              {(fAffected || hist.affected.size > 0) && (
                <button
                  className={`btn sm ${fAffected ? 'on' : ''}`}
                  aria-pressed={fAffected}
                  onClick={() => setFAffected(!fAffected)}
                  title="Only records raised by a quality-deterioration scenario"
                >
                  <FlaskConical size={12} /> Scenario-affected {fmtInt(hist.affected.size)}
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
          <HistoryTable
            rows={shown}
            selected={selected}
            links={hist.links}
            affected={hist.affected}
            onSelect={selectRecord}
            onShowEvent={showEvent}
            empty={anyFilter ? 'No records match the filters' : 'No inspection records in this period'}
          />
        </Panel>
      </div>

      {detail && (
        <div className="col-4">
          <RecordDetail
            {...detail}
            periodInspected={q.inspected}
            periodLabel={data.p.label}
            onShowFrame={() => scrollTo(visionRef.current)}
            onShowEvent={showEvent}
            onClose={() => selectRecord(null)}
          />
        </div>
      )}

      <div className="col-7">
        <ScrapImpact impact={impact} rows={eventRows} periodLabel={data.p.label} focusId={focusId} onFocus={showEvent} />
      </div>

      <div className="col-5">
        <Panel title="Defect classes" subtitle="Rejected tiles by class · share of all rejects · click to filter the records" footer="Gauge results are measurements against a tolerance — they carry no classification confidence.">
          {defectTotal > 0 ? (
            <div className="q-cls">
              <div className="q-cls-h">
                <Cpu size={13} aria-hidden /> Vision classes · <span className="mono">{SIM_MODEL}</span>
              </div>
              <RankedBars rows={classRows(VISION_CLASSES)} format={fmtInt} labelHeader="Class" valueHeader="Tiles" showCumulative={false} onSelect={(r) => toggleDefect(r.key)} selectedKey={fDefect || null} />
              <div className="q-cls-h">
                <Ruler size={13} aria-hidden /> Gauge measurements · non-vision
              </div>
              <RankedBars rows={classRows(GAUGE_CLASSES)} format={fmtInt} labelHeader="Measurement" valueHeader="Tiles" showCumulative={false} onSelect={(r) => toggleDefect(r.key)} selectedKey={fDefect || null} />
            </div>
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

      <div className="col-12">
        <Panel
          title="Inspection stations"
          subtitle="Registry of inspection points mapped to 3D equipment · click a row to filter the records"
          flush
          footer="Inline stations check every sorted tile; the QC bench checks hourly samples (counts are sample tiles)."
        >
          <DataTable columns={stationCols} rows={stations} rowKey={(r) => r.id} onRowClick={(r) => setFStation(fStation === r.id ? '' : r.id)} selectedKey={fStation || null} maxHeight="none" />
        </Panel>
      </div>
    </div>
  );
}
