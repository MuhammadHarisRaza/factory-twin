import { CircleCheck, OctagonX } from 'lucide-react';
import { useApp } from '../../app/store';
import { LINE } from '../../model/plant';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { EmptyState } from '../../ui/kit/Page';
import { MetricText, OperationalStatus, StatusBadge } from '../../ui/kit/Status';
import { Block, Verdict, m2 } from './common';
import { machineLosses } from './derive';
import { conveyorRows, machineRows, type ConveyorRow, type MachineRow } from './equipment';
import { LossBars } from './LossBars';
import { equipmentContribution, lossLedger } from './loss';

const STOPPED = new Set(['stopped', 'fault']);
const KILN_STAGE = LINE.designConstraint;

/** Equipment level: every process machine and conveyor for the period; a row opens the drill-down. */
export function EquipmentView({ periodKey, selected, onAsset }: { periodKey: PeriodKey; selected: string | null; onAsset: (id: string) => void }) {
  const finance = useApp((s) => s.finance);
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const L = lossLedger(s, p, finance);
      const c = equipmentContribution(s, p, L);
      return { p, L, machines: machineRows(s, p, c), conveyors: conveyorRows(s, p, c), losses: machineLosses(s, p) };
    },
    [periodKey, finance],
  );
  return (
    <>
      <EquipmentSummary machines={d.machines} conveyors={d.conveyors} periodLabel={d.p.label} />
      <MachineTable rows={d.machines} selected={selected} onAsset={onAsset} lineLoss={d.L.outputLossM2} />
      <div className="prod-2col">
        <ConveyorTable rows={d.conveyors} selected={selected} onAsset={onAsset} />
        <Block
          title="Own lost output by machine"
          subtitle="Down, starved and blocked minutes × the machine’s ideal rate · select for the drill-down"
          note={<span>Asset-level view: a machine away from the kiln costs line output only when it holds the kiln up, so these bars are not added to the line loss.</span>}
        >
          {d.losses.some((r) => r.totalM2 > 0) ? (
            <LossBars rows={d.losses} selectedKey={selected} onSelect={onAsset} />
          ) : (
            <EmptyState title="No losses">No unplanned downtime, starved or blocked time in this period.</EmptyState>
          )}
        </Block>
      </div>
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
    <div className="prod-eq-summary" aria-label={`Equipment · ${periodLabel}`}>
      <Verdict tone={n ? 'critical' : 'good'}>
        {n ? `${n} asset${n === 1 ? '' : 's'} stopped now: ${[...stopped, ...cvStopped].map((r) => r.id).join(', ')}` : 'All machines and conveyors running or waiting on material'}
      </Verdict>
      <div className="mini-kpis">
        <div className="mini-kpi">
          <span>Machines stopped now</span>
          <b>
            {stopped.length}
            <small>of {machines.length}</small>
          </b>
          <em>
            {cvStopped.length} of {conveyors.length} conveyors stopped
          </em>
        </div>
        <div className="mini-kpi" title="Machine OEE uses that machine's own time accounting and the rejects attributed to its stage — it is not the line OEE">
          <span>Lowest machine OEE</span>
          <b>{lowest ? <MetricText m={lowest.mm.oee.oee} /> : '—'}</b>
          <em>{lowest ? `${lowest.id} · ${lowest.name}` : 'No machine OEE available'}</em>
        </div>
        <div className="mini-kpi">
          <span>Most unplanned downtime</span>
          <b>
            {mostDown && mostDown.downMin > 0 ? (
              <>
                {fmtInt(mostDown.downMin)}
                <small>min</small>
              </>
            ) : (
              'None'
            )}
          </b>
          <em>{mostDown && mostDown.downMin > 0 ? `${mostDown.id} · ${mostDown.name}` : 'No unplanned stops in the period'}</em>
        </div>
        <div className="mini-kpi" title="Unplanned loss at the kiln charged to the asset that caused it (counted once)">
          <span>Largest share of the line loss</span>
          <b>{lineTop && lineTop.lineLossM2 >= 0.5 ? m2(lineTop.lineLossM2) : 'None'}</b>
          <em>{lineTop && lineTop.lineLossM2 >= 0.5 ? `${lineTop.id} · ${lineTop.name}` : 'Nothing held the kiln back'}</em>
        </div>
        <div className="mini-kpi">
          <span>Lowest conveyor availability</span>
          <b>{worstCv ? fmtPct(worstCv.availability, 1) : '—'}</b>
          <em>{worstCv ? `${worstCv.id} · ${worstCv.stops} stop${worstCv.stops === 1 ? '' : 's'}` : 'No conveyor data'}</em>
        </div>
      </div>
    </div>
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
    <Block
      title="Equipment OEE — process machines"
      subtitle={`Each machine’s own OEE for the period · line loss at the kiln ${m2(lineLoss)} in total · select a row for events, reports and the 3D view`}
      note={<span>Machine OEE uses the machine’s own time accounting and ideal rate, with the rejects attributed to its stage; the line OEE is measured at the kiln and is not an average of these.</span>}
      flush
    >
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => onAsset(r.id)} selectedKey={selected} maxHeight="none" />
    </Block>
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
    <Block
      title="Conveyors"
      subtitle="Availability, utilisation and stops · OEE is not meaningful for a conveyor · select a row for the drill-down"
      actions={stopped ? <StatusBadge tone="critical" icon={OctagonX} label={`${stopped} stopped`} /> : <StatusBadge tone="good" icon={CircleCheck} label="None stopped" />}
      flush
    >
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => onAsset(r.id)} selectedKey={selected} maxHeight="none" />
    </Block>
  );
}
