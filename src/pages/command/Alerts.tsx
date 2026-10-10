/** Alerts raised in the last 8 h, newest first; a row locates its subject. */
import { useState } from 'react';
import type { Alert } from '../../model/types';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Panel, Segmented } from '../../ui/kit/Panel';
import { SeverityBadge, SourceTag } from '../../ui/kit/Status';
import { countBySeverity, eqName, recentAlerts } from './derive';
import { locate } from './nav';

type Scope = 'all' | 'warning';
const SEV_ORDER = ['info', 'warning', 'serious', 'critical'];

export function AlertsTable() {
  const [scope, setScope] = useState<Scope>('all');
  const d = useSimValue(
    (s) => {
      const all = recentAlerts(s);
      const label = (id: string) => s.logistics.vehicles[id]?.label ?? id;
      return {
        counts: countBySeverity(all),
        rows: (scope === 'all' ? all : all.filter((a) => a.severity !== 'info')).map((a) => ({ a, vehicle: a.vehicleId ? label(a.vehicleId) : null })),
      };
    },
    [scope],
  );
  type Row = (typeof d.rows)[number];
  const cols: Column<Row>[] = [
    { key: 'sev', header: 'Severity', render: (r) => <SeverityBadge severity={r.a.severity} />, sort: (r) => SEV_ORDER.indexOf(r.a.severity), width: 104 },
    { key: 'time', header: 'Time', render: (r) => <span title={formatDateTime(r.a.time)}>{formatClock(r.a.time)}</span>, sort: (r) => r.a.time, width: 64 },
    { key: 'title', header: 'Alert', render: (r) => <span title={r.a.title}>{r.a.title}</span>, sort: (r) => r.a.title },
    { key: 'detail', header: 'Detail', render: (r) => <span className="dim" title={r.a.detail}>{r.a.detail}</span> },
    {
      key: 'subject',
      header: 'Subject',
      render: (r) => <Subject a={r.a} vehicle={r.vehicle} />,
      sort: (r) => r.a.equipmentId ?? r.vehicle ?? '',
    },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.a.source} />, sort: (r) => r.a.source, width: 84 },
  ];
  const c = d.counts;
  return (
    <Panel
      title="Active alerts"
      subtitle={`Last 8 h · ${c.critical} critical · ${c.serious} serious · ${c.warning} warning · ${c.info} info · click a row to locate`}
      actions={
        <Segmented<Scope>
          label="Alert scope"
          value={scope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'warning', label: 'Warning +' },
          ]}
          onChange={setScope}
        />
      }
      flush
    >
      <DataTable
        columns={cols}
        rows={d.rows}
        rowKey={(r: Row) => r.a.id}
        onRowClick={(r: Row) => locate(r.a)}
        maxHeight={360}
        empty="No alerts in the last 8 hours"
      />
    </Panel>
  );
}

function Subject({ a, vehicle }: { a: Alert; vehicle: string | null }) {
  if (a.equipmentId)
    return (
      <span title={eqName(a.equipmentId)}>
        <span className="mono">{a.equipmentId}</span>
        <span className="sub">{eqName(a.equipmentId)}</span>
      </span>
    );
  if (vehicle) return <span>{vehicle}</span>;
  return <span className="muted">Scenario input</span>;
}
