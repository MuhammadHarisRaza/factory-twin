import { useState } from 'react';
import { openEquipment } from '../../app/store';
import { useSimValue } from '../../sim/store';
import { formatDuration } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt } from '../../ui/kit/format';
import { Panel, Segmented } from '../../ui/kit/Panel';
import { FeedStatusBadge, MACHINE_STATE, OperationalStatus } from '../../ui/kit/Status';
import { feedRows, feedSummary, type FeedRow } from './feeds';

type Filter = 'all' | 'machine' | 'conveyor' | 'stale';

const columns: Column<FeedRow>[] = [
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
  { key: 'kind', header: 'Type', render: (r) => (r.kind === 'machine' ? 'Process machine' : 'Conveyor'), sort: (r) => r.kind },
  { key: 'stage', header: 'Stage', render: (r) => r.stageName, sort: (r) => r.stageName },
  {
    key: 'feed',
    header: 'Data feed',
    render: (r) =>
      r.status === 'stale' ? (
        <span title={`No update for ${formatDuration(r.staleFor)}`}>
          <FeedStatusBadge status="stale" />
          <span className="sub">{r.statusLabel.replace('Stale ', '')}</span>
        </span>
      ) : (
        <FeedStatusBadge status="simulated" />
      ),
    sort: (r) => (r.status === 'stale' ? 0 : 1),
  },
  {
    key: 'state',
    header: 'State shown',
    title: 'Operational state the product shows for the asset (Unknown while its feed is stale)',
    render: (r) => <OperationalStatus state={r.state} />,
    sort: (r) => r.state,
  },
  {
    key: 'last',
    header: 'Last values received',
    title: 'Values frozen when the feed went stale — what a real gateway would still display',
    render: (r) =>
      r.last ? (
        <span className="dim">
          {r.last.state ? MACHINE_STATE[r.last.state].label : '—'} · {r.last.rate != null ? `${fmtInt(r.last.rate)} tiles/h` : '—'}
        </span>
      ) : (
        <span className="muted">Updating every plant minute</span>
      ),
  },
  {
    key: 'cause',
    header: 'Cause',
    render: (r) => (r.scenarioId ? <span className="tag scenario" title="Signal-loss scenario">{r.scenarioId}</span> : <span className="muted">—</span>),
  },
  { key: 'src', header: 'Planned source', render: (r) => <span className="dim" title={r.plannedSource}>{r.plannedSource}</span> },
];

/** Simulated data-feed health per process machine and conveyor (s.feeds). */
export function FeedsTab() {
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useSimValue((s) => feedRows(s));
  const sum = feedSummary(rows);
  const shown = rows.filter((r) => (filter === 'all' ? true : filter === 'stale' ? r.status === 'stale' : r.kind === filter));

  return (
    <>
      <div className="col-8">
        <Panel
          title="Data feeds"
          subtitle={`${sum.machines} process machines · ${sum.conveyors} conveyors · all simulated${sum.stale ? ` · ${sum.stale} stale (longest ${sum.longest})` : ' · none stale'}`}
          flush
          actions={
            <Segmented<Filter>
              label="Feed filter"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'machine', label: 'Machines' },
                { value: 'conveyor', label: 'Conveyors' },
                { value: 'stale', label: `Stale (${sum.stale})` },
              ]}
            />
          }
          footer="Click a row to locate the asset in the Factory Twin. No plant data source is connected: every feed is produced by the simulation engine."
        >
          <DataTable columns={columns} rows={shown} rowKey={(r) => r.id} onRowClick={(r) => openEquipment(r.id)} maxHeight={560} empty="No stale feeds — every simulated feed is updating" />
        </Panel>
      </div>
      <div className="col-4">
        <Panel title="What the feed status means" subtitle="Honest freshness, no connection claims">
          <ul className="a-list">
            <li>
              <b>Simulated.</b> The engine delivers the asset's state and counter every plant minute, as a PLC gateway would. It is not a connection to a
              real machine.
            </li>
            <li>
              <b>Stale since hh:mm.</b> The simulated gateway stopped delivering (a signal-loss scenario). The asset keeps producing in the simulation, but the
              product only knows the last values received: its state shows <i>Unknown — data stale</i>, signal values are frozen and a counter-inactivity
              event is raised.
            </li>
            <li>
              <b>Live.</b> Shown only for a source that is actually connected and delivering — in this release that can only be a configured camera stream
              that is playing (Camera sources).
            </li>
            <li>
              <b>Other simulated feeds.</b> Inspection records, condition-monitoring sensors, energy meters and vehicle positions (zone level) are also
              produced by the simulation; see Signals &amp; mappings and Data sources.
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
