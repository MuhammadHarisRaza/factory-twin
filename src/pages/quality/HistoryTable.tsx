/**
 * Inspection-record table of Quality & Defects (up to 500 rows).
 *
 * Memoised on its inputs (kept identity-stable by ./history), so a simulated minute without a new
 * record, scenario link or event link does not render it. When it does render (a new record, a new
 * selection, a sort), the costly cells are memoised per record and only the changed ones render.
 */
import { memo, useCallback, useMemo } from 'react';
import { FlaskConical } from 'lucide-react';
import { DEFECTS } from '../../model/plant';
import type { DefectCategory, QualityInspection, ScenarioActivation } from '../../model/types';
import { formatDateTime } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { SourceTag } from '../../ui/kit/Status';
import { DefectSeverity, ResultBadge } from './badges';
import { isVisionRecord } from './derive';
import { sameList } from './history';
import { STATION_BY_ID } from './lookup';

type Props = {
  /** Rows to show, newest first. */
  rows: QualityInspection[];
  selected: string | null;
  links: Map<string, string[]>;
  affected: Map<string, ScenarioActivation>;
  /** Open a record. Must be identity-stable. */
  onSelect: (id: string) => void;
  /** Focus an event and its evidence. Must be identity-stable. */
  onShowEvent: (id: string) => void;
  empty: string;
};

const SEV_ORDER = ['minor', 'major', 'critical'];
const recordKey = (r: QualityInspection) => r.id;

export const HistoryTable = memo(function HistoryTable({ rows, selected, links, affected, onSelect, onShowEvent, empty }: Props) {
  const columns = useMemo(() => historyColumns(links, affected, onShowEvent), [links, affected, onShowEvent]);
  const onRowClick = useCallback((r: QualityInspection) => onSelect(r.id), [onSelect]);
  return <DataTable columns={columns} rows={rows} rowKey={recordKey} onRowClick={onRowClick} selectedKey={selected} maxHeight={480} empty={empty} />;
});

function historyColumns(links: Map<string, string[]>, affected: Map<string, ScenarioActivation>, onShowEvent: (id: string) => void): Column<QualityInspection>[] {
  return [
    { key: 'time', header: 'Time', render: (r) => <When t={r.time} />, sort: (r) => r.time },
    { key: 'id', header: 'Record', render: (r) => <span className="mono">{r.id}</span> },
    { key: 'station', header: 'Station', render: (r) => STATION_BY_ID[r.stationId]?.name ?? r.stationId, sort: (r) => r.stationId },
    { key: 'batch', header: 'Batch', render: (r) => <span className="mono">{r.batchId}</span>, sort: (r) => r.batchId },
    { key: 'result', header: 'Result', render: (r) => <Result result={r.result} />, sort: (r) => r.result },
    {
      key: 'defect',
      header: 'Defect',
      render: (r) => <DefectCell defect={r.defect} sc={affected.get(r.id) ?? null} />,
      sort: (r) => (r.defect ? DEFECTS[r.defect].label : null),
    },
    {
      key: 'conf',
      header: 'Sim. conf.',
      numeric: true,
      title: 'Simulated classification confidence (vision tunnel only — gauge results are measurements)',
      render: (r) => <Confidence rec={r} />,
      sort: (r) => (isVisionRecord(r) ? r.confidence : null),
    },
    {
      key: 'sev',
      header: 'Severity',
      render: (r) => <Severity severity={r.severity} />,
      sort: (r) => (r.severity ? SEV_ORDER.indexOf(r.severity) : null),
    },
    { key: 'meas', header: 'Measurement', render: (r) => <span title={r.measurement ?? undefined}>{r.measurement ?? '—'}</span> },
    { key: 'tiles', header: 'Tiles', numeric: true, render: (r) => fmtInt(r.tiles), sort: (r) => r.tiles },
    {
      key: 'event',
      header: 'Event',
      render: (r) => <EventCell ids={links.get(r.id) ?? NONE} onShowEvent={onShowEvent} />,
      sort: (r) => links.get(r.id)?.[0] ?? null,
    },
    { key: 'src', header: 'Source', render: (r) => <Source source={r.source} /> },
  ];
}

const NONE: string[] = [];

// ── Memoised cells (props are primitives or immutable records) ──────────────────

const When = memo(function When({ t }: { t: number }) {
  return <>{formatDateTime(t)}</>;
});

const Result = memo(ResultBadge);
const Severity = memo(DefectSeverity);
const Source = memo(SourceTag);

const DefectCell = memo(function DefectCell({ defect, sc }: { defect: DefectCategory | null; sc: ScenarioActivation | null }) {
  if (!defect) return <span className="muted">—</span>;
  return (
    <>
      {DEFECTS[defect].label}
      {sc && (
        <span className="q-aff" title={`Raised by scenario: ${sc.label}`}>
          <FlaskConical size={11} aria-hidden />
          <span className="q-sr">Scenario-affected</span>
        </span>
      )}
    </>
  );
});

const Confidence = memo(function Confidence({ rec: r }: { rec: QualityInspection }) {
  return isVisionRecord(r) && r.confidence != null ? fmtPct(r.confidence, 1) : <span className="muted">{r.stationId === 'ST-GAUGE' && r.defect ? 'gauge' : '—'}</span>;
});

const EventCell = memo(
  function EventCell({ ids, onShowEvent }: { ids: string[]; onShowEvent: (id: string) => void }) {
    if (!ids.length) return <span className="muted">—</span>;
    return (
      <button
        className="row-link mono"
        onClick={(e) => {
          e.stopPropagation();
          onShowEvent(ids[0]);
        }}
        title={`Part of ${ids.join(', ')} — show the event and its evidence`}
      >
        {ids[0]}
        {ids.length > 1 && <span className="muted"> +{ids.length - 1}</span>}
      </button>
    );
  },
  // The links map is rebuilt when any record's links change: compare this record's ids by content.
  (a, b) => a.onShowEvent === b.onShowEvent && sameList(a.ids, b.ids),
);
