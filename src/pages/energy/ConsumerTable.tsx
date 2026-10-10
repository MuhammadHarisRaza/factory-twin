import { Locate } from 'lucide-react';
import { openEquipment } from '../../app/store';
import type { EnergyRow } from '../../sim/metrics';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Panel } from '../../ui/kit/Panel';
import { SourceTag } from '../../ui/kit/Status';
import { fmtInt } from '../../ui/kit/format';
import { ConsumerType, DevBadge } from './badges';
import { fmtAmount, isGas } from './derive';

type Power = Record<string, { elec: number; thermal: number }>;
type Totals = { rows: EnergyRow[]; total: number; expected: number; deviation: number | null; cost: number };

/** Every metered consumer: actual vs model, deviation, cost and current power. */
export function ConsumerTable({
  e,
  power,
  currency,
  periodLabel,
  focus,
  onFocus,
  scenarioIds,
}: {
  e: Totals;
  power: Power;
  currency: string;
  periodLabel: string;
  focus: string | null;
  onFocus: (id: string | null) => void;
  /** Consumers with an active simulated energy-anomaly input. */
  scenarioIds: string[];
}) {
  const kw = (id: string) => (power[id]?.elec ?? 0) + (power[id]?.thermal ?? 0);
  const totalKw = Object.keys(power).reduce((a, id) => a + kw(id), 0);
  const cols: Column<EnergyRow>[] = [
    {
      key: 'consumer',
      header: 'Consumer',
      render: (r) => (
        <span className="en-consumer" title={`${r.id} · ${r.label}`}>
          <span className="en-consumer-name">
            {r.label}
            <span className="sub mono">{r.id}</span>
          </span>
          {scenarioIds.includes(r.id) && <SourceTag source="scenario" />}
        </span>
      ),
      sort: (r) => r.label,
    },
    { key: 'type', header: 'Type', render: (r) => <ConsumerType id={r.id} />, sort: (r) => (isGas(r.id) ? 'gas' : 'electric') },
    {
      key: 'act',
      header: 'Actual kWh',
      numeric: true,
      render: (r) => <span title={`Electricity ${fmtInt(r.elec)} kWh${r.thermal > 0 ? ` · gas ${fmtInt(r.thermal)} kWh` : ''}`}>{fmtInt(r.total)}</span>,
      sort: (r) => r.total,
    },
    { key: 'model', header: 'Model kWh', numeric: true, title: 'Energy model: expected consumption for the actual machine states and throughput', render: (r) => fmtInt(r.expected), sort: (r) => r.expected },
    { key: 'dev', header: 'Deviation', numeric: true, title: 'Actual vs model · amber above 8 %, red above 15 %', render: (r) => <DevBadge d={r.deviation} />, sort: (r) => r.deviation },
    { key: 'cost', header: `Cost ${currency}`, numeric: true, render: (r) => fmtAmount(r.cost), sort: (r) => r.cost },
    {
      key: 'kw',
      header: 'Power now kW',
      numeric: true,
      title: 'Average power in the current hour so far (electrical + thermal)',
      render: (r) => (
        <span title={`Electrical ${fmtInt(power[r.id]?.elec)} kW${isGas(r.id) ? ` · thermal ${fmtInt(power[r.id]?.thermal)} kW` : ''}`}>{fmtInt(kw(r.id))}</span>
      ),
      sort: (r) => kw(r.id),
    },
    {
      key: 'locate',
      header: '',
      render: (r) => (
        <button
          className="row-link"
          onClick={(ev) => {
            ev.stopPropagation();
            openEquipment(r.id);
          }}
          title={`Locate ${r.id} in the Factory Twin`}
        >
          <Locate size={12} aria-hidden /> Locate
        </button>
      ),
    },
  ];
  return (
    <Panel
      title="Consumers"
      subtitle={`${periodLabel} · actual vs energy model · click a row to show its hourly trend`}
      flush
      footer={<span>Power now is the average of the current hour so far. Gas-fired consumers' kWh include their electricity.</span>}
    >
      <DataTable
        columns={cols}
        rows={e.rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => onFocus(focus === r.id ? null : r.id)}
        selectedKey={focus}
        maxHeight="none"
        initialSort={{ key: 'act', dir: 'desc' }}
        footer={
          <tfoot>
            <tr>
              <td>Plant total</td>
              <td />
              <td className="n">{fmtInt(e.total)}</td>
              <td className="n">{fmtInt(e.expected)}</td>
              <td className="n">
                <DevBadge d={e.deviation} />
              </td>
              <td className="n">{fmtAmount(e.cost)}</td>
              <td className="n">{fmtInt(totalKw)}</td>
              <td />
            </tr>
          </tfoot>
        }
      />
    </Panel>
  );
}
