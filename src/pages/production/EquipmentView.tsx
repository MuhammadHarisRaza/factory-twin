import { CircleCheck, OctagonX } from 'lucide-react';
import { useApp } from '../../app/store';
import { LINE } from '../../model/plant';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { MetricText, OperationalStatus, StatusBadge } from '../../ui/kit/Status';
import { Kpi, Verdict, m2 } from './common';
import { machineLosses } from './derive';
import { conveyorRows, machineRows, type ConveyorRow, type MachineRow } from './equipment';
import { LossBars } from './LossBars';
import { equipmentContribution, lossLedger } from './loss';

const STOPPED = new Set(['stopped', 'fault']);
const KILN_STAGE = LINE.designConstraint;

/** Equipment level: every process machine and conveyor for the period; a row opens the drill-down. */
export function EquipmentView({ periodKey, selected, onAsset }: { periodKey: PeriodKey; selected: string | null; onAsset: (id: string) => void }) {
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const L = lossLedger(s, p, finance, tariffs);
      const c = equipmentContribution(s, p, L);
      return { p, L, machines: machineRows(s, p, c), conveyors: conveyorRows(s, p, c), losses: machineLosses(s, p) };
    },
    [periodKey, finance, tariffs],
  );
  return (
    <>
      <EquipmentSummary machines={d.machines} conveyors={d.conveyors} periodLabel={d.p.label} />
      <MachineTable rows={d.machines} selected={selected} onAsset={onAsset} lineLoss={d.L.outputLossM2} />
      <ConveyorTable rows={d.conveyors} selected={selected} onAsset={onAsset} />
      <Panel
        className="col-4"
        title="Own lost output by machine"
        subtitle="Down, starved and blocked minutes × the machine’s ideal rate · click for the drill-down"
        footer={<span>Asset-level view: a machine away from the kiln costs line output only when it holds the kiln up, so these bars are not added to the line loss.</span>}
      >
        {d.losses.some((r) => r.totalM2 > 0) ? (
          <LossBars rows={d.losses} selectedKey={selected} onSelect={onAsset} />
        ) : (
          <div className="empty">
            <b>No losses</b>
            No unplanned downtime, starved or blocked time in this period
          </div>
        )}
      </Panel>
    </>
  );
}

function EquipmentSummary({ machines, conveyors, periodLabel }: { machines: MachineRow[]; conveyors: ConveyorRow[]; periodLabel: string }) {
  const stopped = machines.filter((r) => STOPPED.has(r.op));
  const cvStopped = conveyors.filter((r) => STOPPED.has(r.op));
  const withOee = machines.filter((r) => r.mm.oee.oee.status === 'ok');
  const lowest = [...withOee].sort((a, b) => a.mm.oee.oee.value! - b.mm.oee.oee.value!)[0];
  const mostDown = [...machines].sort((a, b) => b.downMin - a.downMin)[0];
  const lineTop = [...machines, ...conveyors].sort((a, b) => b.lineLossM2 - a.lineLossM2)[0];
  const cvAvail = conveyors.filter((r) => r.availability != null);
  const worstCv = [...cvAvail].sort((a, b) => a.availability! - b.availability!)[0];
  const n = stopped.length + cvStopped.length;
  return (
    <section className="summary prod-kpis prod-kpis-4" aria-label="Equipment summary">
      <div className="prod-kpi-head">
        <div className="kpi-label">Equipment · {periodLabel}</div>
        <Verdict tone={n ? 'critical' : 'good'}>
          {n ? `${n} asset${n === 1 ? '' : 's'} stopped now: ${[...stopped, ...cvStopped].map((r) => r.id).join(', ')}` : 'All machines and conveyors running or waiting on material'}
        </Verdict>
        <div className="kpi-value">
          {stopped.length}
          <small>of {machines.length} machines stopped</small>
        </div>
        <div className="kpi-sub">
          <span>
            {cvStopped.length} of {conveyors.length} conveyors stopped · starved / blocked assets count as not stopped
          </span>
        </div>
      </div>
      <Kpi
        label="Lowest machine OEE"
        title="Machine OEE uses that machine's own time accounting and the rejects attributed to its stage — it is not the line OEE"
        value={lowest ? <MetricText m={lowest.mm.oee.oee} /> : '—'}
        lines={[<span key="i">{lowest ? `${lowest.id} · ${lowest.name}` : 'No machine OEE available'}</span>]}
      />
      <Kpi
        label="Most unplanned downtime"
        value={
          mostDown && mostDown.downMin > 0 ? (
            <>
              {fmtInt(mostDown.downMin)}
              <small>min</small>
            </>
          ) : (
            'None'
          )
        }
        lines={[<span key="i">{mostDown && mostDown.downMin > 0 ? `${mostDown.id} · ${mostDown.name}` : 'No unplanned stops in the period'}</span>]}
      />
      <Kpi
        label="Largest share of the line loss"
        title="Unplanned loss at the kiln charged to the asset that caused it (counted once)"
        value={lineTop && lineTop.lineLossM2 >= 0.5 ? m2(lineTop.lineLossM2) : 'None'}
        lines={[<span key="i">{lineTop && lineTop.lineLossM2 >= 0.5 ? `${lineTop.id} · ${lineTop.name}` : 'Nothing held the kiln back'}</span>]}
      />
      <Kpi
        label="Lowest conveyor availability"
        value={worstCv ? fmtPct(worstCv.availability, 1) : '—'}
        lines={[<span key="i">{worstCv ? `${worstCv.id} · ${worstCv.stops} stop${worstCv.stops === 1 ? '' : 's'}` : 'No conveyor data'}</span>]}
      />
    </section>
  );
}

function MachineTable({ rows, selected, onAsset, lineLoss }: { rows: MachineRow[]; selected: string | null; onAsset: (id: string) => void; lineLoss: number }) {
  const cols: Column<MachineRow>[] = [
    {
      key: 'stage',
      header: 'Stage',
      render: (r) => (
        <span className="prod-stage">
          {r.stageName}
          {r.stage === KILN_STAGE && (
            <span className="tag prod-constraint" title="Designed line constraint — line OEE and capacity are measured here">
              Constraint
            </span>
          )}
        </span>
      ),
      sort: (r) => r.stageName,
    },
    {
      key: 'machine',
      header: 'Machine',
      render: (r) => (
        <>
          <span className="mono">{r.id}</span>
          <span className="sub">{r.name}</span>
        </>
      ),
      sort: (r) => r.id,
    },
    { key: 'state', header: 'State now', render: (r) => <OperationalStatus state={r.op} />, sort: (r) => r.op },
    { key: 'a', header: 'A', numeric: true, title: 'Availability', render: (r) => <MetricText m={r.mm.oee.availability} />, sort: (r) => r.mm.oee.availability.value },
    { key: 'p', header: 'P', numeric: true, title: 'Performance', render: (r) => <MetricText m={r.mm.oee.performance} />, sort: (r) => r.mm.oee.performance.value },
    { key: 'q', header: 'Q', numeric: true, title: 'Quality (rejects attributed to the stage)', render: (r) => <MetricText m={r.mm.oee.quality} />, sort: (r) => r.mm.oee.quality.value },
    {
      key: 'oee',
      header: 'OEE',
      numeric: true,
      render: (r) => (
        <b>
          <MetricText m={r.mm.oee.oee} />
        </b>
      ),
      sort: (r) => r.mm.oee.oee.value,
    },
    { key: 'out', header: 'Output m²', numeric: true, render: (r) => fmtInt(r.outputM2), sort: (r) => r.outputM2 },
    { key: 'down', header: 'Downtime', numeric: true, title: 'Unplanned downtime, minutes', render: (r) => `${fmtInt(r.downMin)} min`, sort: (r) => r.downMin },
    { key: 'st', header: 'Starved', numeric: true, title: 'Share of planned time waiting for material', render: (r) => fmtPct(r.starvedShare, 0), sort: (r) => r.starvedShare },
    { key: 'bl', header: 'Blocked', numeric: true, title: 'Share of planned time unable to discharge', render: (r) => fmtPct(r.blockedShare, 0), sort: (r) => r.blockedShare },
    { key: 'own', header: 'Own lost m²', numeric: true, title: 'Down + starved + blocked minutes × ideal rate — asset level, not additive', render: (r) => fmtInt(r.ownLostM2), sort: (r) => r.ownLostM2 },
    {
      key: 'line',
      header: 'Line loss m²',
      numeric: true,
      title: 'Its share of the unplanned loss at the kiln (counted once; adds up across assets)',
      render: (r) => (r.lineLossM2 >= 0.5 ? <b>{fmtInt(r.lineLossM2)}</b> : <span className="dim">0</span>),
      sort: (r) => r.lineLossM2,
    },
    {
      key: 'ev',
      header: 'Events',
      numeric: true,
      render: (r) => (r.activeEvents ? <StatusBadge tone="critical" icon={OctagonX} label={`${r.events} · ${r.activeEvents} active`} /> : r.events ? fmtInt(r.events) : <span className="dim">0</span>),
      sort: (r) => r.events,
    },
  ];
  return (
    <Panel
      className="col-12"
      title="Process machines"
      subtitle={`Period figures per machine · line loss at the kiln ${m2(lineLoss)} in total · click a row for events, reports and the 3D view`}
      flush
    >
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => onAsset(r.id)} selectedKey={selected} maxHeight="none" />
    </Panel>
  );
}

function ConveyorTable({ rows, selected, onAsset }: { rows: ConveyorRow[]; selected: string | null; onAsset: (id: string) => void }) {
  const cols: Column<ConveyorRow>[] = [
    {
      key: 'id',
      header: 'Conveyor',
      render: (r) => (
        <>
          <span className="mono">{r.id}</span>
          <span className="sub">{r.name}</span>
        </>
      ),
      sort: (r) => r.id,
    },
    { key: 'route', header: 'Route', render: (r) => <span className="muted">{r.route}</span>, sort: (r) => r.route },
    { key: 'state', header: 'State now', render: (r) => <OperationalStatus state={r.op} />, sort: (r) => r.op },
    { key: 'a', header: 'Availability', numeric: true, title: 'Running share of planned time', render: (r) => fmtPct(r.availability, 1), sort: (r) => r.availability },
    { key: 'u', header: 'Utilisation', numeric: true, title: 'Transported ÷ nominal capacity over planned time', render: (r) => fmtPct(r.utilisation, 0), sort: (r) => r.utilisation },
    { key: 'stops', header: 'Stops', numeric: true, render: (r) => (r.stops ? `${r.stops} · ${fmtInt(r.downMin)} min` : <span className="dim">0</span>), sort: (r) => r.downMin },
    {
      key: 'line',
      header: 'Line loss m²',
      numeric: true,
      title: 'Unplanned loss at the kiln charged to this conveyor (minutes it held the kiln up)',
      render: (r) => (r.lineLossM2 >= 0.5 ? <b>{fmtInt(r.lineLossM2)}</b> : <span className="dim">0</span>),
      sort: (r) => r.lineLossM2,
    },
    { key: 'oee', header: 'OEE', render: () => <span className="muted" title="A conveyor has no production cycle of its own — availability and utilisation describe it">Not meaningful</span> },
    {
      key: 'ev',
      header: 'Events',
      numeric: true,
      render: (r) => (r.activeEvents ? <StatusBadge tone="critical" icon={OctagonX} label={`${r.events} · ${r.activeEvents} active`} /> : r.events ? fmtInt(r.events) : <span className="dim">0</span>),
      sort: (r) => r.events,
    },
  ];
  const stopped = rows.filter((r) => STOPPED.has(r.op)).length;
  return (
    <Panel
      className="col-8"
      title="Conveyors"
      subtitle="Availability, utilisation and stops · OEE is not meaningful for a conveyor · click a row for the drill-down"
      actions={stopped ? <StatusBadge tone="critical" icon={OctagonX} label={`${stopped} stopped`} /> : <StatusBadge tone="good" icon={CircleCheck} label="None stopped" />}
      flush
    >
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => onAsset(r.id)} selectedKey={selected} maxHeight="none" />
    </Panel>
  );
}
