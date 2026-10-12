/**
 * The defect list of the investigation workspace: quality events (open now, then resolved in the
 * period) and the reject records that no event references, as compact rows — no images, so the same
 * picture is never repeated down the list. A row opens its evidence; ↑ / ↓ move through the list.
 */
import { useRef, type KeyboardEvent } from 'react';
import { FlaskConical, ListFilter } from 'lucide-react';
import type { NavMode } from '../../app/store';
import { DEFECTS, DEFECT_ORDER } from '../../model/plant';
import type { DefectCategory, OpEvent, QualityInspection } from '../../model/types';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { fmtInt } from '../../ui/kit/format';
import { EventStatusBadge, SeverityBadge } from '../../ui/kit/Status';
import { DefectSeverity } from './badges';
import { inPeriod, type DefectListData } from './investigate';
import { STATION_BY_ID } from './lookup';

type Props = {
  data: DefectListData;
  selectedId: string | null;
  now: number;
  periodLabel: string;
  /** Records raised by a quality scenario (marked in the list). */
  scenarioRecords: Set<string>;
  defect: DefectCategory | null;
  onDefect: (d: DefectCategory | null) => void;
  onSelect: (id: string, mode?: NavMode) => void;
  onMore: () => void;
  onAllRecords: () => void;
};

export function DefectList({ data, selectedId, now, periodLabel, scenarioRecords, defect, onDefect, onSelect, onMore, onAllRecords }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const ids = [...data.events.map((e) => e.id), ...data.records.map((r) => r.id)];
  const remaining = data.recordTotal - data.records.length;

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    // Only from a row: the defect-type select keeps its own arrow keys.
    if (!ids.length || !(e.target as HTMLElement).closest?.('.qd-row')) return;
    const i = selectedId ? ids.indexOf(selectedId) : -1;
    const next = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
    e.preventDefault();
    if (next === selectedId) return;
    // Stepping with the keyboard rewrites the address instead of adding a history step per row.
    onSelect(next, 'replace');
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-id="${next}"]`)?.focus());
  };

  return (
    <div className="qd-list" ref={ref} onKeyDown={onKey}>
      <div className="qd-list-h">
        <label className="qd-filter">
          <ListFilter size={13} aria-hidden />
          <span className="q-sr">Defect type</span>
          <select className="select" value={defect ?? ''} onChange={(e) => onDefect((e.target.value || null) as DefectCategory | null)} aria-label="Filter the list by defect type">
            <option value="">All defect types</option>
            {DEFECT_ORDER.map((d) => (
              <option key={d} value={d}>
                {DEFECTS[d].label} · {fmtInt(data.byDefect[d])} tiles
              </option>
            ))}
          </select>
        </label>
        {defect && (
          <button type="button" className="btn sm ghost" onClick={() => onDefect(null)}>
            Clear
          </button>
        )}
      </div>

      <div className="qd-group">
        <div className="qd-group-h">
          <b>Quality events</b> <span className="num">{data.events.length}</span>
          <span className="muted">open now, and resolved {inPeriod(periodLabel)}</span>
        </div>
        {data.events.length ? (
          <ul className="qd-rows">
            {data.events.map((e) => (
              <li key={e.id}>
                <EventRow ev={e} now={now} on={e.id === selectedId} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="qd-none">{defect ? `No quality event about ${DEFECTS[defect].label.toLowerCase()} in this period.` : 'No quality event is open or was resolved in this period.'}</p>
        )}
      </div>

      <div className="qd-group">
        <div className="qd-group-h">
          <b>Defect records outside an event</b> <span className="num">{data.recordTotal}</span>
          <span className="muted">newest first</span>
        </div>
        {data.records.length ? (
          <ul className="qd-rows">
            {data.records.map((r) => (
              <li key={r.id}>
                <RecordRow rec={r} on={r.id === selectedId} scenario={scenarioRecords.has(r.id)} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="qd-none">No reject record outside an event in this period.</p>
        )}
        <div className="qd-list-f">
          {remaining > 0 && (
            <button type="button" className="btn sm" onClick={onMore}>
              Show {Math.min(10, remaining)} more
            </button>
          )}
          <button type="button" className="btn sm ghost" onClick={onAllRecords}>
            All inspection records
          </button>
        </div>
      </div>
    </div>
  );
}

function EventRow({ ev, now, on, onSelect }: { ev: OpEvent; now: number; on: boolean; onSelect: Props['onSelect'] }) {
  const st = ev.asset.stationId ? STATION_BY_ID[ev.asset.stationId] : null;
  return (
    <button type="button" className={`qd-row ${on ? 'on' : ''}`} data-id={ev.id} aria-current={on ? 'true' : undefined} onClick={() => onSelect(ev.id)}>
      <span className="qd-row-top">
        <SeverityBadge severity={ev.severity} />
        <span className="mono dim">{ev.id}</span>
        <span className="spacer" />
        <span className="num muted" title={formatDateTime(ev.start)}>
          {formatClock(ev.start)}
        </span>
      </span>
      <span className="qd-row-title">{ev.title}</span>
      <span className="qd-row-meta">
        <EventStatusBadge status={ev.status} />
        <span>{ev.end == null ? `ongoing ${formatDuration(now - ev.start)}` : `cleared ${formatClock(ev.end)}`}</span>
        <span className="dim">
          {EVENT_TYPE_LABEL[ev.type]}
          {st ? ` · ${st.name}` : ''}
        </span>
        {ev.source === 'scenario' && (
          <span className="qd-scn" title="Raised while a quality scenario ran">
            <FlaskConical size={11} aria-hidden /> Scenario
          </span>
        )}
      </span>
    </button>
  );
}

function RecordRow({ rec, on, scenario, onSelect }: { rec: QualityInspection; on: boolean; scenario: boolean; onSelect: Props['onSelect'] }) {
  const st = STATION_BY_ID[rec.stationId];
  return (
    <button type="button" className={`qd-row ${on ? 'on' : ''}`} data-id={rec.id} aria-current={on ? 'true' : undefined} onClick={() => onSelect(rec.id)}>
      <span className="qd-row-top">
        <DefectSeverity severity={rec.severity} />
        <span className="mono dim">{rec.id}</span>
        <span className="spacer" />
        <span className="num muted" title={formatDateTime(rec.time)}>
          {formatClock(rec.time)}
        </span>
      </span>
      <span className="qd-row-title">{rec.defect ? DEFECTS[rec.defect].label : 'Reject'}</span>
      <span className="qd-row-meta">
        <span className="dim">
          {st?.name ?? rec.stationId} · batch <span className="mono">{rec.batchId}</span>
        </span>
        {scenario && (
          <span className="qd-scn" title="Raised by an active quality scenario">
            <FlaskConical size={11} aria-hidden /> Scenario
          </span>
        )}
      </span>
    </button>
  );
}
