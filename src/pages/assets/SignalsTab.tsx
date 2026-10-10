import { Fragment, useMemo, useState } from 'react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { DATA_SOURCES, SIGNALS } from '../../model/plant';
import type { MetricId, SignalDef } from '../../model/types';
import { signalValue } from '../../sim/signals';
import { useSimValue } from '../../sim/store';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { SourceBadge } from '../../ui/kit/Status';

export const METRIC_LABEL: Record<MetricId, string> = {
  availability: 'Availability',
  performance: 'Performance',
  quality: 'Quality',
  oee: 'OEE',
  output: 'Output',
  downtime: 'Downtime',
  rejects: 'Rejects',
  'buffer-level': 'Buffer level',
  energy: 'Energy / process',
  health: 'Machine health',
  turnaround: 'Turnaround',
};

const KIND_LABEL: Record<SignalDef['kind'], string> = { state: 'State', counter: 'Counter', analog: 'Analog', event: 'Event' };
const SOURCE_BY_ID = Object.fromEntries(DATA_SOURCES.map((d) => [d.id, d]));
const SIGNAL_EQUIPMENT = [...new Set(SIGNALS.map((s) => s.equipmentId))];

/** Signal name → the metrics it feeds (derived from the signal registry). */
const MAPPING = (() => {
  const m = new Map<string, { kind: SignalDef['kind']; metrics: Set<MetricId>; count: number }>();
  for (const s of SIGNALS) {
    const e = m.get(s.name) ?? { kind: s.kind, metrics: new Set<MetricId>(), count: 0 };
    s.metrics.forEach((x) => e.metrics.add(x));
    e.count++;
    m.set(s.name, e);
  }
  return [...m.entries()].filter(([, e]) => e.metrics.size > 0);
})();

export function SignalsTab({ equipment, onEquipment }: { equipment: string; onEquipment: (id: string) => void }) {
  const [kind, setKind] = useState<SignalDef['kind'] | ''>('');
  const rows = useMemo(() => SIGNALS.filter((s) => (!equipment || s.equipmentId === equipment) && (!kind || s.kind === kind)), [equipment, kind]);
  const values = useSimValue((s) => Object.fromEntries(rows.map((r) => [r.id, signalValue(s, r.id)])), [rows]);

  const columns: Column<SignalDef>[] = [
    { key: 'id', header: 'Signal id', render: (r) => <span className="mono">{r.id}</span>, sort: (r) => r.id },
    {
      key: 'eq',
      header: 'Equipment',
      render: (r) => <span title={EQUIPMENT_BY_ID[r.equipmentId]?.name}>{EQUIPMENT_BY_ID[r.equipmentId]?.name ?? r.equipmentId}</span>,
      sort: (r) => r.equipmentId,
    },
    { key: 'kind', header: 'Kind', render: (r) => KIND_LABEL[r.kind], sort: (r) => r.kind },
    { key: 'unit', header: 'Unit', render: (r) => <span className="dim">{r.unit}</span> },
    {
      key: 'metrics',
      header: 'Feeds metrics',
      render: (r) => (r.metrics.length ? r.metrics.map((m) => METRIC_LABEL[m]).join(', ') : <span className="muted">Position only</span>),
    },
    { key: 'src', header: 'Source', render: (r) => <SourceBadge status={SOURCE_BY_ID[r.sourceId]?.status ?? 'disconnected'} /> },
    {
      key: 'val',
      header: 'Current value',
      numeric: true,
      render: (r) => {
        const v = values[r.id];
        if (!v || v.value == null) return <span className="muted">—</span>;
        const unit = typeof v.value === 'number' && !['enum', 'code', 'in/out', 'docks', 'pass/fail', 'zone id'].includes(r.unit) ? r.unit : '';
        return (
          <span title={v.text}>
            {v.text}
            {unit && <span className="sub">{unit}</span>}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <div className="col-8">
        <Panel
          title="Signals & mappings"
          subtitle={`${fmtInt(rows.length)} of ${fmtInt(SIGNALS.length)} signals · current simulated values, updated every plant minute`}
          flush
          actions={
            <div className="a-filters">
              <select className="select" value={equipment} onChange={(e) => onEquipment(e.target.value)} aria-label="Filter by equipment">
                <option value="">All equipment</option>
                {SIGNAL_EQUIPMENT.map((id) => (
                  <option key={id} value={id}>
                    {id} · {EQUIPMENT_BY_ID[id]?.name}
                  </option>
                ))}
              </select>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value as SignalDef['kind'] | '')} aria-label="Filter by kind">
                <option value="">All kinds</option>
                {(Object.keys(KIND_LABEL) as SignalDef['kind'][]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
          }
          footer="Analog process values (temperatures, pressure, power, flow) are bounded simulated values, not measurements."
        >
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} maxHeight={560} empty="No signals match the filters" />
        </Panel>
      </div>
      <div className="col-4">
        <Panel title="How signals become metrics" subtitle="One signal id per value; every metric is derived from these">
          <p className="a-text">
            Each workspace computes its figures from these signal ids only. A machine's <span className="mono">state</span> drives availability and the
            downtime log; <span className="mono">count_total</span> drives performance, quality and output; inspection counters drive first-pass yield.
          </p>
          <dl className="dl">
            {MAPPING.map(([name, e]) => (
              <Fragment key={name}>
                <dt>
                  <span className="mono">{name}</span>
                  <span className="muted"> · {KIND_LABEL[e.kind].toLowerCase()} · {e.count}×</span>
                </dt>
                <dd>{[...e.metrics].map((m) => METRIC_LABEL[m]).join(', ')}</dd>
              </Fragment>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
