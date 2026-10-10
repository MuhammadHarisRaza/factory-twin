import { useState } from 'react';
import { CalendarClock, OctagonX, Repeat, type LucideIcon } from 'lucide-react';
import { REASON_BY_CODE } from '../../model/plant';
import type { DowntimeEvent } from '../../model/types';
import type { MaintenanceRecord } from '../../sim/health';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDay, formatDuration } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Panel, Segmented } from '../../ui/kit/Panel';
import { SourceTag, StatusBadge, type Tone } from '../../ui/kit/Status';
import { alarmHistory, maintenanceHistory, type HistoryRow, type HistoryScope } from './derive';
import { LEVEL_META } from './badges';

const HISTORY_LIMIT = 300;

const STOP_KIND: Record<DowntimeEvent['category'], { label: string; tone: Tone; icon: LucideIcon }> = {
  Mechanical: { label: 'Breakdown', tone: 'critical', icon: OctagonX },
  'Electrical & control': { label: 'Breakdown', tone: 'critical', icon: OctagonX },
  Process: { label: 'Process stop', tone: 'critical', icon: OctagonX },
  Changeover: { label: 'Changeover', tone: 'neutral', icon: Repeat },
  Planned: { label: 'Planned stop', tone: 'neutral', icon: CalendarClock },
  Starved: { label: 'Starved', tone: 'warning', icon: OctagonX },
  Blocked: { label: 'Blocked', tone: 'warning', icon: OctagonX },
};

/** "Gearbox … — abnormal vibration/temperature pattern (rule-based …)" → "abnormal vibration/temperature pattern". */
const alertSummary = (detail: string) => detail.split(' — ')[1]?.replace(/\s*\(.*\)\s*$/, '') || detail;

function EventBadge({ r }: { r: HistoryRow }) {
  if (r.kind === 'alert') {
    const m = LEVEL_META[r.level];
    return <StatusBadge tone={m.tone} icon={m.icon} label={`Raised to ${m.label.toLowerCase()}`} />;
  }
  return <StatusBadge {...STOP_KIND[r.ev.category]} />;
}

/** Downtime events of the asset plus its condition-monitoring alerts. */
export function AlarmHistory({ id }: { id: string }) {
  const [scope, setScope] = useState<HistoryScope>('failures');
  const d = useSimValue((s) => {
    const all = alarmHistory(s, id, scope);
    return { now: s.minute, total: all.length, alerts: all.filter((r) => r.kind === 'alert').length, rows: all.slice(0, HISTORY_LIMIT) };
  }, [id, scope]);
  const cols: Column<HistoryRow>[] = [
    { key: 'time', header: 'Time', render: (r) => formatDateTime(r.time), sort: (r) => r.time },
    { key: 'event', header: 'Event', render: (r) => <EventBadge r={r} /> },
    {
      key: 'detail',
      header: 'Detail',
      render: (r) =>
        r.kind === 'alert' ? (
          <span title={r.alert.detail}>Condition monitoring · {alertSummary(r.alert.detail)}</span>
        ) : (
          <span title={REASON_BY_CODE[r.ev.reasonCode]?.label}>
            {REASON_BY_CODE[r.ev.reasonCode]?.label ?? r.ev.reasonCode}
            <span className="sub">{r.ev.category}</span>
          </span>
        ),
    },
    {
      key: 'dur',
      header: 'Duration',
      numeric: true,
      render: (r) =>
        r.kind === 'alert' ? <span className="dim">—</span> : r.ev.end == null ? <b>Active · {formatDuration(d.now - r.ev.start)}</b> : formatDuration(r.ev.end - r.ev.start),
      sort: (r) => (r.kind === 'alert' ? null : (r.ev.end ?? d.now) - r.ev.start),
    },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.kind === 'alert' ? r.alert.source : r.ev.source} /> },
  ];
  return (
    <Panel
      className="col-6"
      title="Alarm history"
      subtitle={
        <span title="Starved / blocked spells are caused by neighbouring stages, not by this asset, and are not listed">
          {d.total} records · {d.alerts} condition alerts · since {formatDay(0)} · newest first · excl. starved / blocked
        </span>
      }
      actions={
        <Segmented<HistoryScope>
          label="Alarm history scope"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'failures', label: 'Failures & alerts' },
            { value: 'all', label: 'All stops' },
          ]}
        />
      }
      flush
    >
      <DataTable
        columns={cols}
        rows={d.rows}
        rowKey={(r) => r.key}
        maxHeight={320}
        empty={scope === 'failures' ? 'No failures or condition alerts on this asset in the simulated week' : 'No stops on this asset in the simulated week'}
      />
    </Panel>
  );
}

export function MaintenanceHistory({ id }: { id: string }) {
  const d = useSimValue((s) => ({ now: s.minute, rows: maintenanceHistory(s, id) }), [id]);
  const cols: Column<MaintenanceRecord>[] = [
    { key: 'start', header: 'Start', render: (m) => formatDateTime(m.start), sort: (m) => m.start },
    { key: 'type', header: 'Type', render: (m) => m.type, sort: (m) => m.type },
    {
      key: 'dur',
      header: 'Duration',
      numeric: true,
      render: (m) =>
        m.start <= d.now && m.end > d.now ? (
          <span className="tag" title={`Until ${formatClock(m.end)}`}>
            In progress · until {formatClock(m.end)}
          </span>
        ) : (
          formatDuration(m.end - m.start)
        ),
      sort: (m) => m.end - m.start,
    },
    {
      key: 'desc',
      header: 'Description',
      render: (m) => (
        <span className="mh-desc" title={m.description}>
          {m.description}
        </span>
      ),
    },
    { key: 'src', header: 'Source', render: (m) => <SourceTag source={m.source} /> },
  ];
  return (
    <Panel className="col-6" title="Maintenance history" subtitle={`${d.rows.length} records · preventive, corrective and condition-based · newest first`} flush>
      <DataTable columns={cols} rows={d.rows} rowKey={(m) => m.id} maxHeight={320} empty="No maintenance recorded for this asset" />
    </Panel>
  );
}
