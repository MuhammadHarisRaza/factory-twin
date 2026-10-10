import { CalendarClock, TriangleAlert } from 'lucide-react';
import { formatH } from '../../sim/health';
import { formatClock } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmt1, fmtInt } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { MachineStatus, StatusBadge } from '../../ui/kit/Status';
import { LEVEL_ORDER, PM_SOON_H, signed, type AssetRow } from './derive';
import { LevelBadge, ScoreBar } from './badges';

/** ETA to the vibration alarm / trip limit from the 3-h trend; "reached" once past the alarm limit. */
export function etaText(r: AssetRow) {
  const { etaAlarmH, etaTripH } = r.h;
  if (etaAlarmH == null && etaTripH == null) return null;
  const alarm = etaAlarmH != null ? formatH(etaAlarmH) : 'reached';
  return `${alarm} / ${etaTripH != null ? formatH(etaTripH) : '—'}`;
}

export function PmDue({ h }: { h: number }) {
  if (h < 0) return <StatusBadge tone="warning" icon={TriangleAlert} label={`Overdue ${fmtInt(-h)} h`} />;
  if (h < PM_SOON_H) return <StatusBadge tone="warning" icon={CalendarClock} label={`in ${fmtInt(h)} h`} />;
  return <span>in {fmtInt(h)} h</span>;
}

export function AssetTable({ rows, selected, onSelect }: { rows: AssetRow[]; selected: string; onSelect: (id: string) => void }) {
  const cols: Column<AssetRow>[] = [
    {
      key: 'asset',
      header: 'Asset',
      render: (r) => (
        <>
          <span className="mono">{r.id}</span>
          <span className="sub">{r.name}</span>
        </>
      ),
      sort: (r) => r.id,
    },
    {
      key: 'comp',
      header: 'Component',
      render: (r) => (
        <span className="mh-comp" title={r.asset.component}>
          {r.asset.component}
        </span>
      ),
      sort: (r) => r.asset.component,
    },
    {
      key: 'state',
      header: 'Machine state',
      render: (r) => (
        <>
          <MachineStatus state={r.state} />
          {r.maintenanceUntil != null && <span className="sub">CBM until {formatClock(r.maintenanceUntil)}</span>}
        </>
      ),
      sort: (r) => r.state,
    },
    { key: 'score', header: 'Health score', render: (r) => <ScoreBar score={r.h.score} level={r.h.level} />, sort: (r) => (r.h.level === 'offline' ? null : r.h.score) },
    { key: 'level', header: 'Level', render: (r) => <LevelBadge level={r.h.level} />, sort: (r) => LEVEL_ORDER[r.h.level] },
    {
      key: 'vib',
      header: 'Vibration / expected',
      numeric: true,
      title: 'Latest vibration velocity vs the value expected at the current load (mm/s RMS); ratio = mean over the last 60 min of running',
      render: (r) => (
        <span className="mh-vib">
          {r.h.reading.running ? (
            <span>
              {fmt1(r.h.reading.vibration)} / {fmt1(r.h.expectedVibration)}
            </span>
          ) : (
            <span className="dim">Not running</span>
          )}
          <b className={`mh-ratio ${(r.h.vibrationRatio ?? 1) >= 1.25 ? 'hi' : ''}`}>{r.h.vibrationRatio == null ? '—' : `${r.h.vibrationRatio.toFixed(2)}×`}</b>
        </span>
      ),
      sort: (r) => r.h.vibrationRatio,
    },
    { key: 'temp', header: 'Temp. °C', numeric: true, title: `Bearing / oil temperature`, render: (r) => fmtInt(r.h.reading.temperature), sort: (r) => r.h.reading.temperature },
    { key: 'cur', header: 'Current A', numeric: true, title: 'Motor current', render: (r) => fmtInt(r.h.reading.current), sort: (r) => r.h.reading.current },
    {
      key: 'trend',
      header: 'Trend',
      numeric: true,
      title: 'Vibration slope over the last 3 h of running, mm/s per hour',
      render: (r) => <span className={r.h.trend != null && r.h.trend > 0.05 ? 'mh-rising' : 'dim'}>{signed(r.h.trend)}</span>,
      sort: (r) => r.h.trend,
    },
    {
      key: 'eta',
      header: 'ETA alarm / trip',
      numeric: true,
      title: 'Time until vibration reaches the alarm / trip limit if the 3-h trend continues',
      render: (r) => etaText(r) ?? <span className="dim" title="No rising vibration trend">—</span>,
      sort: (r) => r.h.etaTripH,
    },
    { key: 'run', header: 'Since PM', numeric: true, title: 'Run hours since the last maintenance', render: (r) => `${fmtInt(r.h.runtimeSincePmH)} h`, sort: (r) => r.h.runtimeSincePmH },
    { key: 'pm', header: 'PM due', numeric: true, title: `Run hours to the next preventive maintenance (interval per asset); amber below ${PM_SOON_H} h`, render: (r) => <PmDue h={r.h.pmDueH} />, sort: (r) => r.h.pmDueH },
  ];
  return (
    <Panel
      className="col-12 mh-table"
      title="Condition-monitored assets"
      subtitle={`${rows.length} assets · current condition, most at risk first · click a row to inspect its signals and history`}
      flush
    >
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => onSelect(r.id)} selectedKey={selected} maxHeight="none" />
    </Panel>
  );
}
