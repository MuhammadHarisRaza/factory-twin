/**
 * Secondary view: where defects are counted and what they cost. The inspection stations mapped to
 * the 3D equipment, rejects by defect category with their modeled origin stage, the production
 * batches of the period and the scrap / rework estimate (assumptions shown and editable).
 */
import { Cpu, FlaskConical, Locate, Ruler } from 'lucide-react';
import { openStation, useApp } from '../../app/store';
import { eventImpact } from '../../intel/report';
import { DEFECTS, DEFECT_ORDER, INSPECTION_STATIONS, STAGE_BY_ID } from '../../model/plant';
import type { DefectCategory, ProductionBatch } from '../../model/types';
import { qualityIn, resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSim, useSimValue } from '../../sim/store';
import { formatDateTime } from '../../sim/time';
import { RankedBars, type RankedRow } from '../../ui/kit/charts';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { EmptyState, ProvenanceBadge, Section } from '../../ui/kit/Page';
import { GAUGE_CLASSES, SIM_MODEL, VISION_CLASSES, impactFigures, inspectionMethod, periodQualityImpact, qualityEventsIn } from './derive';
import { affectingScenario } from './frames';
import { periodRecords } from './history';
import { PRODUCT_BY_SKU, STATION_BY_ID } from './lookup';
import { ScrapImpact } from './ScrapImpact';

type StationRow = { id: string; inspected: number; rejected: number; rate: number | null; samples: boolean };
type BatchRow = { batch: ProductionBatch; rejectedTiles: number; topDefect: DefectCategory | null; affectedTiles: number };

/** Inline stations count every tile; the QC bench only checks samples. */
const INLINE = (id: string) => (STATION_BY_ID[id]?.detects.length ?? 0) > 0;

type Props = {
  periodKey: PeriodKey;
  selectedId: string | null;
  /** Filter the inspection records (and switch to them). */
  onFilterStation: (id: string) => void;
  onFilterBatch: (id: string) => void;
  /** Filter the investigation list to a category (and switch to it). */
  onDefect: (d: DefectCategory) => void;
  /** Open an event's evidence. */
  onOpen: (id: string) => void;
};

export function StationsTab({ periodKey, selectedId, onFilterStation, onFilterBatch, onDefect, onOpen }: Props) {
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const d = useSimValue(
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
      const events = qualityEventsIn(s, p);
      const rows = [...events.open, ...events.resolved].map((ev) => ({ ev, f: impactFigures(eventImpact(s, ev, finance, tariffs)) }));
      return { p, q, stations, batches, rows, impact: periodQualityImpact(s, p, finance, useSim.getState().baseline) };
    },
    [periodKey, finance, tariffs],
  );

  const total = DEFECT_ORDER.reduce((a, x) => a + d.q.byDefect[x], 0);
  const classRows = (list: DefectCategory[]): RankedRow[] =>
    [...list]
      .sort((a, b) => d.q.byDefect[b] - d.q.byDefect[a])
      .map((x, i) => ({
        key: x,
        label: (
          <>
            {DEFECTS[x].label}
            <span className="muted"> · modeled origin {STAGE_BY_ID[DEFECTS[x].origin].name}</span>
          </>
        ),
        value: d.q.byDefect[x],
        share: total > 0 ? d.q.byDefect[x] / total : 0,
        color: `var(--series-${(i % 7) + 1})`,
      }));

  const stationCols: Column<StationRow>[] = [
    { key: 'station', header: 'Station', render: (r) => STATION_BY_ID[r.id].name, sort: (r) => STATION_BY_ID[r.id].name },
    { key: 'eq', header: 'Equipment', render: (r) => <span className="mono">{STATION_BY_ID[r.id].equipmentId}</span> },
    {
      key: 'inference',
      header: 'Result source',
      render: (r) => {
        const m = inspectionMethod(r.id);
        return (
          <span title={m.note}>
            <span className={m.kind === 'vision' ? 'mono' : ''}>{m.source}</span>
          </span>
        );
      },
    },
    {
      key: 'detects',
      header: 'Detects',
      render: (r) => {
        const x = STATION_BY_ID[r.id].detects;
        const text = x.length ? x.map((c) => DEFECTS[c].label).join(', ') : 'Lab sample checks (water absorption, MOR)';
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
    {
      key: 'twin',
      header: '',
      render: (r) => (
        <button
          type="button"
          className="row-link"
          onClick={(e) => {
            e.stopPropagation();
            openStation(r.id);
          }}
        >
          <Locate size={12} aria-hidden /> Show in 3D
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
    { key: 'product', header: 'Product', render: (r) => <span title={PRODUCT_BY_SKU[r.batch.sku]?.name}>{PRODUCT_BY_SKU[r.batch.sku]?.name ?? r.batch.sku}</span>, sort: (r) => r.batch.sku },
    { key: 'start', header: 'Start', render: (r) => formatDateTime(r.batch.start), sort: (r) => r.batch.start },
    { key: 'end', header: 'End', render: (r) => (r.batch.end == null ? <span className="dim">Active</span> : formatDateTime(r.batch.end)), sort: (r) => r.batch.end ?? Infinity },
    { key: 'rej', header: 'Rejected tiles', numeric: true, render: (r) => fmtInt(r.rejectedTiles), sort: (r) => r.rejectedTiles },
    { key: 'top', header: 'Top defect', render: (r) => (r.topDefect ? DEFECTS[r.topDefect].label : <span className="muted">—</span>) },
  ];

  return (
    <div className="qd-tab">
      <div className="qd-two">
        <Section title="Rejects by defect category" subtitle={`${d.p.label} · share of all rejects · select a category to investigate it`}>
          {total > 0 ? (
            <div className="qd-cls">
              <div className="qd-cls-h">
                <Cpu size={13} aria-hidden /> Vision classes · <span className="mono">{SIM_MODEL}</span>
              </div>
              <RankedBars rows={classRows(VISION_CLASSES)} format={fmtInt} labelHeader="Class" valueHeader="Tiles" showCumulative={false} onSelect={(r) => onDefect(r.key as DefectCategory)} />
              <div className="qd-cls-h">
                <Ruler size={13} aria-hidden /> Gauge measurements · non-vision
              </div>
              <RankedBars rows={classRows(GAUGE_CLASSES)} format={fmtInt} labelHeader="Measurement" valueHeader="Tiles" showCumulative={false} onSelect={(r) => onDefect(r.key as DefectCategory)} />
              <p className="qd-note">The modeled origin stage is process knowledge of the category — a hypothesis to check, not a confirmed cause.</p>
            </div>
          ) : (
            <EmptyState title="No rejects in this period" />
          )}
        </Section>
        <Section title="Production batches" subtitle="Batches active in the period · select one to see its inspection records" flush>
          <DataTable columns={batchCols} rows={d.batches} rowKey={(r) => r.batch.id} onRowClick={(r) => onFilterBatch(r.batch.id)} maxHeight={330} empty="No batches in this period" />
        </Section>
      </div>

      <Section
        title="Inspection stations"
        subtitle="Inspection points mapped to the 3D equipment · select a row to see its records"
        flush
        actions={<ProvenanceBadge kind="simulated" />}
      >
        <DataTable columns={stationCols} rows={d.stations} rowKey={(r) => r.id} onRowClick={(r) => onFilterStation(r.id)} maxHeight="none" />
        <p className="qd-note qd-pad">Inline stations check every sorted tile; the QC bench checks hourly samples (counts are sample tiles). No camera or vision model is connected.</p>
      </Section>

      <ScrapImpact impact={d.impact} rows={d.rows} periodLabel={d.p.label} focusId={selectedId} onFocus={onOpen} />
    </div>
  );
}
