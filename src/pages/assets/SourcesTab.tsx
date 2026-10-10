import { DATA_SOURCES } from '../../model/plant';
import type { DataSource } from '../../model/types';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { SourceBadge } from '../../ui/kit/Status';

const KIND_LABEL: Record<DataSource['kind'], string> = {
  simulation: 'Simulation',
  plc: 'PLC',
  scada: 'SCADA / historian',
  'iot-gateway': 'IoT gateway',
  mes: 'MES',
  erp: 'ERP',
  wms: 'WMS',
  telematics: 'Telematics',
  vision: 'Vision system',
};

const columns: Column<DataSource>[] = [
  { key: 'name', header: 'Source', render: (d) => d.name, sort: (d) => d.name },
  { key: 'kind', header: 'Kind', render: (d) => KIND_LABEL[d.kind], sort: (d) => d.kind },
  { key: 'status', header: 'Status', render: (d) => <SourceBadge status={d.status} />, sort: (d) => d.status },
  { key: 'protocol', header: 'Protocol / interface', render: (d) => <span title={d.protocol}>{d.protocol}</span> },
  {
    key: 'signals',
    header: 'Signals',
    numeric: true,
    title: 'Signal ids this source provides (simulation) or would provide once connected',
    render: (d) => (d.provides.length ? fmtInt(d.provides.length) : <span className="muted">—</span>),
    sort: (d) => d.provides.length,
  },
  { key: 'desc', header: 'Description', render: (d) => <span className="a-wrap">{d.description}</span> },
];

export function SourcesTab() {
  const active = DATA_SOURCES.filter((d) => d.status === 'simulated' || d.status === 'connected').length;
  return (
    <>
      <div className="col-8">
        <Panel
          title="Data sources"
          subtitle={`${active} of ${DATA_SOURCES.length} sources active · only the simulation engine supplies data in this release`}
          flush
          footer="Signal counts for disconnected sources are the signal ids a future gateway would take over (e.g. the PLC gateway → process-machine signals)."
        >
          <DataTable columns={columns} rows={DATA_SOURCES} rowKey={(d) => d.id} maxHeight="none" />
        </Panel>
      </div>
      <div className="col-4">
        <Panel title="Integration boundary" subtitle="What a live deployment would change">
          <ul className="a-list">
            <li>
              <b>Same signal ids.</b> Future gateways (OPC UA, MQTT, REST) publish the signal ids listed under Signals &amp; mappings; metrics, tables and the
              3D twin read them unchanged.
            </li>
            <li>
              <b>Read-only.</b> The product subscribes to values; it never writes set-points or commands to PLCs or control systems.
            </li>
            <li>
              <b>Backend required.</b> Persistence of history, multi-user access and live connectivity need a server-side service; this release runs
              entirely in the browser.
            </li>
            <li>
              <b>Provenance stays visible.</b> Every record carries its source; simulated and scenario values remain labelled as such.
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
