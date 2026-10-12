/**
 * Secondary view: the raw inspection history of the period (up to 500 rows) with filters. A row
 * opens the record's evidence in the investigation view.
 */
import { useMemo } from 'react';
import { BellRing, FlaskConical } from 'lucide-react';
import { DEFECTS, DEFECT_ORDER, INSPECTION_STATIONS } from '../../model/plant';
import type { DefectCategory, QualityInspection } from '../../model/types';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { fmtInt } from '../../ui/kit/format';
import { Section } from '../../ui/kit/Page';
import { inspectionEventLinks } from './derive';
import { keepUnchanged, periodRecords, scenarioAffected, useStable, type HistoryInputs } from './history';
import { HistoryTable } from './HistoryTable';
import { inPeriod } from './investigate';

export type RecordFilters = {
  station: string;
  defect: DefectCategory | '';
  result: '' | QualityInspection['result'];
  severity: '' | NonNullable<QualityInspection['severity']>;
  batch: string;
  inEvent: boolean;
  scenario: boolean;
};

export const NO_FILTERS: RecordFilters = { station: '', defect: '', result: '', severity: '', batch: '', inEvent: false, scenario: false };

const HISTORY_LIMIT = 500;

type Props = {
  periodKey: PeriodKey;
  filters: RecordFilters;
  onFilters: (f: RecordFilters) => void;
  /** Open a record's evidence (identity-stable). */
  onOpen: (id: string) => void;
  /** Show an event's evidence (identity-stable). */
  onShowEvent: (id: string) => void;
  selectedId: string | null;
};

export function RecordsTab({ periodKey, filters: f, onFilters, onOpen, onShowEvent, selectedId }: Props) {
  const data = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const records = periodRecords(s, p);
      return { p, records, affected: scenarioAffected(s, records), links: inspectionEventLinks(s) };
    },
    [periodKey],
  );
  // Inputs keep their identity while their content is unchanged, so the memoised table skips minutes without a new record.
  const fresh = useMemo((): HistoryInputs => ({ records: data.records, affected: data.affected, links: data.links }), [data]);
  const hist = useStable(fresh, keepUnchanged);

  const filtered = useMemo(
    () =>
      hist.records.filter(
        (r) =>
          (!f.station || r.stationId === f.station) &&
          (!f.defect || r.defect === f.defect) &&
          (!f.result || r.result === f.result) &&
          (!f.severity || r.severity === f.severity) &&
          (!f.batch || r.batchId === f.batch) &&
          (!f.scenario || hist.affected.has(r.id)) &&
          (!f.inEvent || hist.links.has(r.id)),
      ),
    [hist, f],
  );
  const shown = useMemo(() => filtered.slice(0, HISTORY_LIMIT), [filtered]);
  const batches = useMemo(() => [...new Set(hist.records.map((r) => r.batchId))], [hist]);
  const inEvents = useMemo(() => hist.records.reduce((a, r) => a + (hist.links.has(r.id) ? 1 : 0), 0), [hist]);
  const any = JSON.stringify(f) !== JSON.stringify(NO_FILTERS);
  const set = (patch: Partial<RecordFilters>) => onFilters({ ...f, ...patch });
  return (
    <Section
      title="Inspection records"
      subtitle={`${fmtInt(filtered.length)} of ${fmtInt(hist.records.length)} records ${inPeriod(data.p.label)} · newest first${filtered.length > HISTORY_LIMIT ? ` · showing the latest ${HISTORY_LIMIT}` : ''} · select a record to open its evidence`}
      flush
      actions={
        <div className="qd-filters">
          <button type="button" className={`btn sm ${f.inEvent ? 'on' : ''}`} aria-pressed={f.inEvent} onClick={() => set({ inEvent: !f.inEvent })} title="Only records referenced by a quality event">
            <BellRing size={12} aria-hidden /> In an event {fmtInt(inEvents)}
          </button>
          {(f.scenario || hist.affected.size > 0) && (
            <button type="button" className={`btn sm ${f.scenario ? 'on' : ''}`} aria-pressed={f.scenario} onClick={() => set({ scenario: !f.scenario })} title="Only records raised by a quality-deterioration scenario">
              <FlaskConical size={12} aria-hidden /> Scenario-affected {fmtInt(hist.affected.size)}
            </button>
          )}
          <select className="select" value={f.station} onChange={(e) => set({ station: e.target.value })} aria-label="Filter by station">
            <option value="">All stations</option>
            {INSPECTION_STATIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select className="select" value={f.defect} onChange={(e) => set({ defect: e.target.value as RecordFilters['defect'] })} aria-label="Filter by defect">
            <option value="">All defects</option>
            {DEFECT_ORDER.map((d) => (
              <option key={d} value={d}>
                {DEFECTS[d].label}
              </option>
            ))}
          </select>
          <select className="select" value={f.result} onChange={(e) => set({ result: e.target.value as RecordFilters['result'] })} aria-label="Filter by result">
            <option value="">All results</option>
            <option value="reject">Reject</option>
            <option value="pass">Pass</option>
          </select>
          <select className="select" value={f.severity} onChange={(e) => set({ severity: e.target.value as RecordFilters['severity'] })} aria-label="Filter by severity">
            <option value="">All severities</option>
            <option value="minor">Minor</option>
            <option value="major">Major</option>
            <option value="critical">Critical</option>
          </select>
          <select className="select" value={f.batch} onChange={(e) => set({ batch: e.target.value })} aria-label="Filter by batch">
            <option value="">All batches</option>
            {(f.batch && !batches.includes(f.batch) ? [f.batch, ...batches] : batches).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          {any && (
            <button type="button" className="btn sm ghost" onClick={() => onFilters(NO_FILTERS)}>
              Clear
            </button>
          )}
        </div>
      }
    >
      <HistoryTable
        rows={shown}
        selected={selectedId}
        links={hist.links}
        affected={hist.affected}
        onSelect={onOpen}
        onShowEvent={onShowEvent}
        empty={any ? 'No records match the filters' : 'No inspection records in this period'}
      />
    </Section>
  );
}
