import { useMemo, useState } from 'react';
import { Locate, Search } from 'lucide-react';
import { openEquipment } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { DATA_SOURCES, EQUIPMENT_OPS, LINE, PROCESS_MACHINES, STAGE_BY_ID } from '../../model/plant';
import type { EquipmentCategory, EquipmentOps, MachineState } from '../../model/types';
import { useSimValue } from '../../sim/store';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { MachineStatus, SourceBadge } from '../../ui/kit/Status';

export const CATEGORY_LABEL: Record<EquipmentCategory, string> = {
  process: 'Process',
  buffer: 'Buffer',
  inspection: 'Inspection',
  'material-handling': 'Material handling',
  storage: 'Storage',
  logistics: 'Logistics',
  utility: 'Utility',
  support: 'Support',
};

const SOURCE_BY_ID = Object.fromEntries(DATA_SOURCES.map((d) => [d.id, d]));

export function ZoneChip({ zone }: { zone: string }) {
  const z = ZONE_BY_ID[zone];
  return (
    <span className="a-zone" title={z?.name}>
      <span className="chip" style={{ background: z?.color }}>
        {zone}
      </span>
      {z?.short ?? zone}
    </span>
  );
}

export function EquipmentTab({ onShowSignals }: { onShowSignals: (equipmentId: string) => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<EquipmentCategory | ''>('');
  const states = useSimValue((s) => Object.fromEntries(PROCESS_MACHINES.map((id) => [id, s.machines[id].state])) as Record<string, MachineState>);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return EQUIPMENT_OPS.filter(
      (o) =>
        (!category || o.category === category) &&
        (!q || o.id.toLowerCase().includes(q) || EQUIPMENT_BY_ID[o.id].name.toLowerCase().includes(q) || EQUIPMENT_BY_ID[o.id].stage.toLowerCase().includes(q)),
    );
  }, [query, category]);

  const columns: Column<EquipmentOps>[] = [
    { key: 'id', header: 'Equipment id', render: (o) => <span className="mono">{o.id}</span>, sort: (o) => o.id },
    { key: 'name', header: 'Name', render: (o) => <span title={EQUIPMENT_BY_ID[o.id].description}>{EQUIPMENT_BY_ID[o.id].name}</span>, sort: (o) => EQUIPMENT_BY_ID[o.id].name },
    { key: 'zone', header: 'Zone', render: (o) => <ZoneChip zone={o.zone} />, sort: (o) => o.zone },
    { key: 'cat', header: 'Category', render: (o) => CATEGORY_LABEL[o.category], sort: (o) => CATEGORY_LABEL[o.category] },
    {
      key: 'line',
      header: 'Line / stage',
      render: (o) =>
        o.lineId ? (
          <>
            {LINE.name}
            {o.stage && <span className="sub">{STAGE_BY_ID[o.stage].name}</span>}
          </>
        ) : (
          <span className="muted">—</span>
        ),
      sort: (o) => (o.stage ? STAGE_BY_ID[o.stage].step : o.lineId ? 99 : null),
    },
    {
      key: 'map',
      header: '3D object',
      render: (o) => (
        <span className="a-map">
          <span className="dim">Mapped</span>
          <button
            className="row-link"
            onClick={(e) => {
              e.stopPropagation();
              openEquipment(o.id);
            }}
            title={`Locate ${o.id} in the Factory Twin`}
          >
            <Locate size={12} /> Locate
          </button>
        </span>
      ),
    },
    {
      key: 'rate',
      header: 'Ideal rate (tiles/h)',
      numeric: true,
      render: (o) => (o.idealRatePerHour != null ? fmtInt(o.idealRatePerHour) : <span className="muted">—</span>),
      sort: (o) => o.idealRatePerHour,
    },
    { key: 'sig', header: 'Signals', numeric: true, render: (o) => (o.signals.length ? fmtInt(o.signals.length) : <span className="muted">0</span>), sort: (o) => o.signals.length },
    { key: 'src', header: 'Data source', render: (o) => <SourceBadge status={SOURCE_BY_ID[o.sourceId]?.status ?? 'disconnected'} />, sort: (o) => o.sourceId },
    {
      key: 'state',
      header: 'Live state',
      render: (o) => (states[o.id] ? <MachineStatus state={states[o.id]} /> : <span className="muted">—</span>),
      sort: (o) => states[o.id] ?? null,
    },
  ];

  return (
    <div className="col-12">
      <Panel
        title="Equipment registry"
        subtitle={`${fmtInt(rows.length)} of ${fmtInt(EQUIPMENT_OPS.length)} assets · every record maps to an object in the 3D model · click a row for its signals`}
        flush
        actions={
          <div className="a-filters">
            <label className="a-search">
              <Search size={13} aria-hidden />
              <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search id, name or area" aria-label="Search equipment" />
            </label>
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value as EquipmentCategory | '')} aria-label="Filter by category">
              <option value="">All categories</option>
              {(Object.keys(CATEGORY_LABEL) as EquipmentCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
        }
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(o) => o.id}
          onRowClick={(o) => o.signals.length && onShowSignals(o.id)}
          maxHeight={560}
          empty="No equipment matches the search"
        />
      </Panel>
    </div>
  );
}
