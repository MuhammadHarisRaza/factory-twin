/**
 * Fleet & Logistics: internal and external vehicle monitoring. Live state ("now") for
 * the map, dock board and vehicle tables; the shared reporting period for statistics,
 * the event log and analytics. All figures derive from the one simulation state.
 */
import { useMemo, useState } from 'react';
import {
  CalendarClock,
  CircleDashed,
  CirclePause,
  Crosshair,
  FileText,
  Hourglass,
  Info,
  MoveRight,
  PackageCheck,
  TrafficCone,
  TriangleAlert,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { openEquipment, openVehicle, useApp } from '../app/store';
import { DOCKS } from '../model/plant';
import type { Vehicle } from '../model/types';
import type { SimState } from '../sim/engine';
import { phaseLabel, type TruckRuntime } from '../sim/logistics';
import { fleetMetrics, resolvePeriod } from '../sim/metrics';
import { useSim, useSimValue } from '../sim/store';
import { dayStart, formatClock, formatDateTime, formatDay, formatDuration } from '../sim/time';
import { DataTable, type Column } from '../ui/kit/DataTable';
import { Empty, Panel, Segmented } from '../ui/kit/Panel';
import { SourceTag, StatusBadge, type Tone } from '../ui/kit/Status';
import { ColumnChart, RankedBars, StackedColumns, TipRow, type ColumnDatum } from '../ui/kit/charts';
import { fmtInt, fmtPct } from '../ui/kit/format';
import {
  DOCK_NAME,
  GEOFENCE_BY_ID,
  completedVisits,
  currentZone,
  dockBoard,
  dockUtilisation,
  eventLog,
  externalRows,
  geofenceName,
  hourlyGate,
  internalRows,
  liveDurations,
  recentLegs,
  truckSource,
  visitTimeline,
  type DockRow,
  type DockStatus,
  type ExtRow,
  type IntRow,
  type LogRow,
  type LogType,
} from './fleet/derive';
import { MapLegend, SiteMap, type MapView } from './fleet/SiteMap';
import './fleet.css';

const DOCK_STATUS: Record<DockStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  free: { label: 'Free', tone: 'neutral', icon: CircleDashed },
  reserved: { label: 'Reserved', tone: 'planned', icon: CalendarClock },
  loading: { label: 'Loading', tone: 'good', icon: PackageCheck },
  paperwork: { label: 'Paperwork', tone: 'neutral', icon: FileText },
  held: { label: 'Held (documentation)', tone: 'warning', icon: TriangleAlert },
};

const TYPE_LABEL: Record<Vehicle['type'], string> = {
  'outbound-truck': 'Outbound',
  'inbound-tipper': 'Inbound',
  forklift: 'Forklift',
  'wheel-loader': 'Wheel loader',
};

const LOG_TYPE: Record<LogType, string> = { gate: 'Gate', dock: 'Dock', restricted: 'Restricted zone' };

const dur = (m: number | null | undefined) => formatDuration(m);
const minFmt = (v: number) => `${fmtInt(v)} min`;

function derive(s: SimState, periodKey: Parameters<typeof resolvePeriod>[0]) {
  const p = resolvePeriod(periodKey, s.minute);
  return {
    p,
    now: s.minute,
    fm: fleetMetrics(s, p),
    docks: dockBoard(s),
    ext: externalRows(s, p),
    int: internalRows(s),
    log: eventLog(s, p),
    visits: completedVisits(s, p),
    gate: hourlyGate(s, p),
    util: dockUtilisation(s, p),
  };
}

export function FleetPage() {
  const period = useApp((s) => s.period);
  const activate = useSim((s) => s.activate);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<MapView>('site');
  const d = useSimValue((s) => derive(s, period), [period]);
  const { p, now, fm } = d;

  /** Clock with the day when the minute is before today (multi-day periods). */
  const clock = (m: number) => (m < dayStart(now) ? formatDateTime(m) : formatClock(m));

  const occupied = d.docks.filter((r) => r.status === 'loading' || r.status === 'paperwork' || r.status === 'held');
  const firstDocked = occupied[0] ?? null;

  const selectScenarioTruck = (scenarioId: string) => {
    const L = useSim.getState().sim.logistics;
    const v = L.active.map((id) => L.vehicles[id]).find((x) => x.visit?.scenarioId === scenarioId);
    if (v) setSelected(v.id);
  };

  return (
    <div className="page">
      {/* ── Answer-first summary ── */}
      <section className="summary fleet-summary" aria-label="Fleet summary">
        <div>
          <div className="kpi-label">Vehicles on site</div>
          <div className="kpi-value">
            {fmtInt(fm.onSite)}
            <small>external</small>
          </div>
          <div className="kpi-sub">
            <span>{fmtInt(fm.onSite - fm.inbound)} outbound</span>
            <span>{fmtInt(fm.inbound)} inbound</span>
          </div>
        </div>
        <div>
          <div className="kpi-label">Waiting for a dock</div>
          <div className="kpi-value">
            {fmtInt(fm.waiting)}
            <small>trucks</small>
          </div>
          <div className="kpi-sub">
            <span>avg wait {dur(fm.avgWaiting)}</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Outbound trucks loading at a dock and inbound tippers unloading in the shed">At dock (load / unload)</div>
          <div className="kpi-value">
            {fmtInt(fm.atDock)}
            <small>trucks</small>
          </div>
          <div className="kpi-sub">
            <span>
              {occupied.length} of {DOCKS.length} docks occupied
            </span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Gate in → gate out, visits completed in the period">
            Avg turnaround
          </div>
          <div className="kpi-value">{dur(fm.avgTurnaround)}</div>
          <div className="kpi-sub">
            <span>{fmtInt(fm.completedVisits)} visits completed</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Outbound visits completed in the period">
            Avg gate → dock
          </div>
          <div className="kpi-value">{dur(fm.avgGateToDock)}</div>
          <div className="kpi-sub">
            <span>outbound · dock time {dur(fm.avgDockTime)}</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Occupied dock minutes ÷ (6 docks × period minutes)">
            Dock utilisation
          </div>
          <div className="kpi-value">{fmtPct(fm.dockUtilisation)}</div>
          <div className="meter" aria-hidden>
            <i style={{ width: `${Math.min(100, fm.dockUtilisation * 100)}%` }} />
          </div>
        </div>
        <div className="kpi-context">
          <div className="kpi-label">Warehouse stock</div>
          <div className="kpi-value">
            {fmtInt(fm.stockPallets)}
            <small>pallets</small>
          </div>
          <div className="kpi-sub">
            <span>
              gate {fmtInt(fm.gateIn)} in · {fmtInt(fm.gateOut)} out
            </span>
          </div>
        </div>
      </section>

      {/* ── Notice + contextual actions ── */}
      <div className="toolbar-row fleet-toolbar">
        <div className="notice" role="note">
          <Info size={14} aria-hidden />
          <span>
            <b>Simulated at zone level.</b> Vehicle movement, gate and dock events come from the simulation; no GPS, ANPR, telematics or indoor
            positioning is connected. Statistics: {p.label}.
          </span>
        </div>
        <button
          className="btn"
          onClick={() => {
            const sc = activate({ kind: 'yard-congestion', count: 10, end: null, label: 'Yard congestion · 10 trucks' });
            selectScenarioTruck(sc.id);
          }}
          title="Six outbound trucks arrive two minutes apart"
        >
          <TrafficCone size={14} aria-hidden />
          Simulate yard congestion
        </button>
        <button
          className="btn"
          disabled={!firstDocked}
          title={firstDocked ? `Holds the truck at ${firstDocked.name} for an extra 75 min (documentation)` : 'No truck is at a dock — nothing to hold'}
          onClick={() => {
            if (!firstDocked) return;
            activate({ kind: 'prolonged-dock-stay', dockId: firstDocked.id, count: 75, end: null, label: `Dock hold +75 min · ${firstDocked.name}` });
            if (firstDocked.truck) setSelected(firstDocked.truck.id);
          }}
        >
          <Hourglass size={14} aria-hidden />
          {firstDocked ? `Extend dock stay · ${firstDocked.name}` : 'Extend dock stay'}
        </button>
        {!firstDocked && <span className="why">No dock occupied</span>}
        <button
          className="btn"
          onClick={() => {
            const sc = activate({ kind: 'truck-arrival', end: null, label: 'Additional truck arrival' });
            selectScenarioTruck(sc.id);
          }}
          title="An outbound truck arrives at the gate now"
        >
          <Truck size={14} aria-hidden />
          Truck arrival
        </button>
      </div>

      {/* ── Map + dock board | detail + event log ── */}
      <div className="col-8 fleet-stack">
        <Panel
          title="Live site map"
          subtitle={`Plant time ${formatClock(now)} · ${d.ext.filter((r) => r.active).length} external, ${d.int.length} internal vehicles · click a vehicle to select`}
          actions={
            <Segmented
              label="Map scale"
              value={view}
              onChange={setView}
              options={[
                { value: 'site', label: 'Site' },
                { value: 'warehouse', label: 'Warehouse' },
              ]}
            />
          }
        >
          <SiteMap view={view} selectedId={selected} onSelect={setSelected} />
          <MapLegend />
        </Panel>
        <DockBoard rows={d.docks} now={now} clock={clock} selected={selected} onSelect={setSelected} />
      </div>
      <div className="col-4 fleet-stack">
        <VehicleDetail id={selected} onClose={() => setSelected(null)} clock={clock} />
        <EventLog rows={d.log} clock={clock} periodLabel={p.label} onSelect={setSelected} />
      </div>

      {/* ── External vehicles ── */}
      <div className="col-12">
        <ExternalTable rows={d.ext} now={now} clock={clock} periodLabel={p.label} selected={selected} onSelect={setSelected} />
      </div>

      {/* ── Internal vehicles | dock utilisation ── */}
      <div className="col-8">
        <InternalTable rows={d.int} selected={selected} onSelect={setSelected} />
      </div>
      <div className="col-4">
        <Panel title="Dock utilisation" subtitle={`Occupied minutes; share = occupied share of the period · ${p.label}`} footer={<span>Overall {fmtPct(fm.dockUtilisation)} across {DOCKS.length} docks</span>}>
          <RankedBars
            rows={[...d.util]
              .sort((x, y) => y.busy - x.busy)
              .map((u) => ({ key: u.id, label: u.name, value: u.busy, share: u.share }))}
            format={minFmt}
            labelHeader="Dock"
            valueHeader="Occupied"
            showCumulative={false}
            onSelect={() => openEquipment('K-DOCK')}
          />
        </Panel>
      </div>

      {/* ── Analytics ── */}
      <div className="col-7">
        <TurnaroundChart visits={d.visits} periodLabel={p.label} onSelect={setSelected} />
      </div>
      <div className="col-5">
        <Panel title="Gate movements per hour" subtitle={`Gate-in and gate-out events · ${p.label}`} footer={<span>{fmtInt(fm.gateIn)} in · {fmtInt(fm.gateOut)} out in the period</span>}>
          {d.gate.hours.length ? (
            <StackedColumns
              labels={d.gate.hours.map((h) => (d.gate.hours.length > 30 ? formatDay(h * 60) : formatClock(h * 60)))}
              series={[
                { key: 'in', label: 'Gate in', color: 'var(--series-1)' },
                { key: 'out', label: 'Gate out', color: 'var(--series-2)' },
              ]}
              values={d.gate.values}
              format={(v) => fmtInt(v)}
              tickEvery={d.gate.hours.length > 30 ? 24 : d.gate.hours.length > 12 ? 2 : 1}
              height={190}
            />
          ) : (
            <Empty title="No hours in this period yet" />
          )}
        </Panel>
      </div>
    </div>
  );
}

// ── Dock board ────────────────────────────────────────────────────────────────

function DockBoard({
  rows,
  now,
  clock,
  selected,
  onSelect,
}: {
  rows: DockRow[];
  now: number;
  clock: (m: number) => string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const cols: Column<DockRow>[] = [
    { key: 'dock', header: 'Dock', render: (r) => r.name, width: 70 },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge {...DOCK_STATUS[r.status]} /> },
    { key: 'truck', header: 'Truck', render: (r) => (r.truck ? <span className="mono">{r.truck.id}</span> : <span className="muted">—</span>) },
    { key: 'carrier', header: 'Carrier', render: (r) => r.truck?.operator ?? <span className="muted">—</span> },
    {
      key: 'since',
      header: 'Since',
      numeric: true,
      title: 'Docked since (reserved: dock assigned at)',
      render: (r) => (r.since != null ? clock(r.since) : '—'),
    },
    { key: 'time', header: 'Dock time', numeric: true, render: (r) => dur(r.dockTime) },
    {
      key: 'pallets',
      header: 'Pallets loaded',
      numeric: true,
      render: (r) => (r.truck && r.status !== 'reserved' ? `${fmtInt(r.loaded)} / ${fmtInt(r.load)}` : r.truck ? `0 / ${fmtInt(r.load)}` : '—'),
    },
  ];
  const held = rows.filter((r) => r.dockTime != null && r.dockTime >= 90);
  return (
    <Panel
      title="Dock board"
      subtitle={`Live at ${formatClock(now)} · outbound loading docks`}
      flush
      footer={
        held.length ? (
          <StatusBadge tone="serious" icon={TriangleAlert} label={`${held.map((r) => r.name).join(', ')} docked ≥ 90 min`} />
        ) : (
          <span>Dock prep 8 min before loading; paperwork and sealing after loading complete.</span>
        )
      }
    >
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        selectedKey={rows.find((r) => r.truck?.id === selected)?.id ?? null}
        onRowClick={(r) => (r.truck ? onSelect(r.truck.id) : openEquipment('K-DOCK'))}
        maxHeight="none"
      />
    </Panel>
  );
}

// ── External vehicles ─────────────────────────────────────────────────────────

function ExternalTable({
  rows,
  now,
  clock,
  periodLabel,
  selected,
  onSelect,
}: {
  rows: ExtRow[];
  now: number;
  clock: (m: number) => string;
  periodLabel: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const cols: Column<ExtRow>[] = [
    { key: 'id', header: 'Vehicle', render: (r) => <span className="mono">{r.id}</span>, sort: (r) => r.id },
    {
      key: 'type',
      header: 'Direction / type',
      render: (r) => (r.v.visit!.direction === 'outbound' ? `Outbound · ${r.v.visit!.load} pallets` : `Inbound · ${r.v.visit!.material ?? 'raw material'} ${r.v.visit!.load} t`),
      sort: (r) => r.v.visit!.direction,
    },
    { key: 'carrier', header: 'Carrier', render: (r) => r.v.operator, sort: (r) => r.v.operator },
    { key: 'phase', header: 'Phase', render: (r) => phaseLabel[r.v.phase ?? 'approaching'], sort: (r) => r.v.phase ?? '' },
    { key: 'zone', header: 'Current zone', render: (r) => (r.active ? geofenceName(r.zone) : <span className="muted">Left site</span>), sort: (r) => (r.active ? geofenceName(r.zone) : '~') },
    {
      key: 'gateIn',
      header: 'Gate in',
      numeric: true,
      render: (r) => (r.v.visit!.gateIn <= now ? clock(r.v.visit!.gateIn) : '—'),
      sort: (r) => r.v.visit!.gateIn,
    },
    {
      key: 'dock',
      header: 'Dock',
      render: (r) => (r.v.visit!.direction === 'inbound' ? <span className="dim">Unloading bay</span> : r.v.visit!.dockId ? DOCK_NAME[r.v.visit!.dockId] : '—'),
      sort: (r) => r.v.visit!.dockId ?? '',
    },
    { key: 'wait', header: 'Waiting', numeric: true, render: (r) => dur(r.d.waiting), sort: (r) => r.d.waiting },
    { key: 'g2d', header: 'Gate → dock', numeric: true, render: (r) => dur(r.d.gateToDock), sort: (r) => r.d.gateToDock },
    { key: 'dockTime', header: 'Dock time', numeric: true, render: (r) => dur(r.d.dockTime), sort: (r) => r.d.dockTime },
    { key: 'turn', header: 'Turnaround', numeric: true, render: (r) => dur(r.d.turnaround), sort: (r) => r.d.turnaround },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.source} /> },
  ];
  const active = rows.filter((r) => r.active).length;
  return (
    <Panel title="External vehicles" subtitle={`${active} on site now · ${rows.length - active} departed in ${periodLabel}`} flush>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        selectedKey={selected}
        onRowClick={(r) => onSelect(r.id)}
        maxHeight={360}
        initialSort={{ key: 'gateIn', dir: 'desc' }}
        empty="No external vehicles on site or departed in this period"
      />
    </Panel>
  );
}

// ── Internal vehicles ─────────────────────────────────────────────────────────

function InternalTable({ rows, selected, onSelect }: { rows: IntRow[]; selected: string | null; onSelect: (id: string) => void }) {
  const cols: Column<IntRow>[] = [
    { key: 'id', header: 'Vehicle', render: (r) => <span className="mono">{r.id}</span>, sort: (r) => r.id },
    { key: 'type', header: 'Type', render: (r) => TYPE_LABEL[r.v.type] },
    { key: 'zone', header: 'Zone', render: (r) => geofenceName(r.zone), sort: (r) => geofenceName(r.zone) },
    {
      key: 'moving',
      header: 'State',
      render: (r) => (r.moving ? <StatusBadge tone="good" icon={MoveRight} label="Moving" /> : <StatusBadge tone="neutral" icon={CirclePause} label="Stationary" />),
      sort: (r) => (r.moving ? 1 : 0),
    },
    { key: 'task', header: 'Task', render: (r) => r.v.task ?? '—' },
    { key: 'act', header: 'Current activity', render: (r) => r.activity ?? '—' },
    { key: 'dwell', header: 'Dwell in zone', numeric: true, render: (r) => dur(r.dwell), sort: (r) => r.dwell },
    {
      key: 'idle',
      header: 'Idle, last hour',
      numeric: true,
      title: 'Stationary idle / waiting minutes in the last 60 min',
      render: (r) => (r.idleLastHour == null ? <span className="metric-na" title="Less than one hour of history">—</span> : dur(r.idleLastHour)),
      sort: (r) => r.idleLastHour,
    },
    {
      key: 'rz',
      header: 'Restricted entries today',
      numeric: true,
      render: (r) => (r.restrictedToday > 0 ? <StatusBadge tone="warning" icon={TriangleAlert} label={String(r.restrictedToday)} /> : '0'),
      sort: (r) => r.restrictedToday,
    },
  ];
  return (
    <Panel title="Internal vehicles" subtitle="Warehouse and packaging forklifts, raw-material wheel loader · live" flush>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} selectedKey={selected} onRowClick={(r) => onSelect(r.id)} maxHeight="none" />
    </Panel>
  );
}

// ── Event log ─────────────────────────────────────────────────────────────────

const LOG_LIMIT = 300;

function EventLog({ rows, clock, periodLabel, onSelect }: { rows: LogRow[]; clock: (m: number) => string; periodLabel: string; onSelect: (id: string) => void }) {
  const [type, setType] = useState<'all' | LogType>('all');
  const filtered = useMemo(() => (type === 'all' ? rows : rows.filter((r) => r.type === type)), [rows, type]);
  const shown = filtered.slice(0, LOG_LIMIT);
  const cols: Column<LogRow>[] = [
    { key: 'time', header: 'Time', numeric: true, render: (r) => clock(r.time) },
    {
      key: 'event',
      header: 'Event',
      render: (r) =>
        r.type === 'restricted' ? <StatusBadge tone="warning" icon={TriangleAlert} label={r.event} /> : <span title={LOG_TYPE[r.type]}>{r.event}</span>,
    },
    { key: 'detail', header: 'Where', render: (r) => <span className="dim">{r.detail}</span> },
    {
      key: 'veh',
      header: 'Vehicle',
      render: (r) => (
        <button className="row-link mono" onClick={() => onSelect(r.vehicleId)}>
          {r.vehicleId}
        </button>
      ),
    },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.source} /> },
  ];
  return (
    <Panel
      title="Event log"
      subtitle={`Gate, dock and restricted-zone events · ${periodLabel}`}
      actions={
        <Segmented
          label="Event type"
          value={type}
          onChange={setType}
          options={[
            { value: 'all', label: 'All' },
            { value: 'gate', label: 'Gate' },
            { value: 'dock', label: 'Dock' },
            { value: 'restricted', label: 'Restricted' },
          ]}
        />
      }
      flush
      footer={
        <span>
          {filtered.length > LOG_LIMIT ? `Latest ${LOG_LIMIT} of ${fmtInt(filtered.length)} events` : `${fmtInt(filtered.length)} events`} · newest first
        </span>
      }
    >
      <DataTable columns={cols} rows={shown} rowKey={(r) => r.id} maxHeight={330} empty="No events of this type in the period" />
    </Panel>
  );
}

// ── Selected vehicle ─────────────────────────────────────────────────────────

function VehicleDetail({ id, onClose, clock }: { id: string | null; onClose: () => void; clock: (m: number) => string }) {
  const info = useSimValue(
    (s) => {
      if (!id) return null;
      const v = s.logistics.vehicles[id];
      if (!v) return null;
      const now = s.minute;
      const onSite = s.logistics.active.includes(id) && v.spawned <= now;
      const zone = onSite ? currentZone(v, now) : null;
      if (v.class === 'external') {
        const t = v as TruckRuntime;
        return {
          kind: 'external' as const,
          v: t,
          now,
          onSite,
          zone,
          activity: onSite ? (t.legs.filter((l) => l.start <= now).at(-1)?.activity ?? null) : null,
          d: liveDurations(t, now),
          timeline: visitTimeline(s, t),
        };
      }
      return {
        kind: 'internal' as const,
        v,
        now,
        onSite,
        zone,
        row: internalRows(s).find((r) => r.id === id) ?? null,
        legs: recentLegs(v, now, 10),
      };
    },
    [id],
  );

  if (!info)
    return (
      <Panel title="Selected vehicle">
        <Empty title="No vehicle selected">Click a vehicle on the map or a row in the vehicle tables.</Empty>
      </Panel>
    );

  const v = info.v;
  const ext = info.kind === 'external';
  const truck = ext ? info.v : null;
  const dockTarget = truck && truck.visit!.dockId && info.onSite && truck.visit!.direction === 'outbound' ? truck.visit!.dockId : null;
  const gfEquip = info.zone ? GEOFENCE_BY_ID[info.zone]?.equipmentId : undefined;
  const inspect = dockTarget ? { eq: 'K-DOCK', label: `Inspect ${DOCK_NAME[dockTarget]}` } : gfEquip ? { eq: gfEquip, label: 'Inspect zone' } : null;

  return (
    <Panel
      title="Selected vehicle"
      actions={
        <button className="btn sm ghost" onClick={onClose}>
          Clear
        </button>
      }
    >
      <div className="fleet-detail-h">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="mono">{v.id}</h3>
          <p>
            {ext ? `${TYPE_LABEL[v.type]} · ${v.type === 'inbound-tipper' ? 'tipper' : 'truck'} · ${v.operator}` : `${v.label} · ${v.operator}`}
          </p>
        </div>
        {ext ? <SourceTag source={truckSource(v)} /> : <SourceTag source="simulation" />}
      </div>

      <dl className="dl" style={{ marginTop: 12 }}>
        {ext ? (
          <>
            <dt>Phase</dt>
            <dd>{phaseLabel[v.phase ?? 'approaching']}</dd>
            <dt>Activity</dt>
            <dd>{info.activity ?? (info.onSite ? '—' : 'Left site')}</dd>
            <dt>Zone</dt>
            <dd>{info.onSite ? geofenceName(info.zone) : 'Left site'}</dd>
            <dt>{truck!.visit!.direction === 'outbound' ? 'Dock' : 'Unloading'}</dt>
            <dd>{truck!.visit!.direction === 'outbound' ? (truck!.visit!.dockId ? DOCK_NAME[truck!.visit!.dockId] : 'Not assigned') : 'Raw-material shed bay'}</dd>
            <dt>Load</dt>
            <dd>
              {truck!.visit!.direction === 'outbound'
                ? `${fmtInt(truck!.palletsLoaded ?? 0)} / ${fmtInt(truck!.visit!.load)} pallets loaded`
                : `${fmtInt(truck!.visit!.load)} t ${truck!.visit!.material ?? ''}`}
            </dd>
          </>
        ) : (
          <>
            <dt>Task</dt>
            <dd>{v.task ?? '—'}</dd>
            <dt>Activity</dt>
            <dd>{info.kind === 'internal' ? (info.row?.activity ?? '—') : '—'}</dd>
            <dt>Zone</dt>
            <dd>{geofenceName(info.zone)}</dd>
            <dt>State</dt>
            <dd>{info.kind === 'internal' && info.row?.moving ? 'Moving' : 'Stationary'}</dd>
          </>
        )}
      </dl>

      {info.kind === 'external' ? (
        <>
          <div className="fleet-detail-sec">
            <h4>Durations</h4>
            <div className="fleet-durs">
              <div>
                <span>Waiting</span>
                <b>{dur(info.d.waiting)}</b>
              </div>
              <div>
                <span>Gate → dock</span>
                <b>{dur(info.d.gateToDock)}</b>
              </div>
              <div>
                <span>{info.v.visit!.direction === 'outbound' ? 'Dock time' : 'Unloading'}</span>
                <b>{dur(info.d.dockTime)}</b>
              </div>
              <div>
                <span>Turnaround</span>
                <b>{info.d.turnaround != null ? dur(info.d.turnaround) : info.v.visit!.gateIn <= info.now ? <span className="dim">{dur(info.now - info.v.visit!.gateIn)} so far</span> : '—'}</b>
              </div>
            </div>
          </div>
          <div className="fleet-detail-sec">
            <h4>Visit timeline</h4>
            <ol className="fleet-tl">
              {info.timeline.map((st) => (
                <li key={st.key} className={st.time == null ? 'pending' : ''}>
                  <i aria-hidden />
                  <span>
                    {st.label}
                    {st.note && <span className="note">{st.note}</span>}
                  </span>
                  <span className="t">{st.time != null ? clock(st.time) : 'pending'}</span>
                </li>
              ))}
            </ol>
          </div>
        </>
      ) : (
        <>
          <div className="fleet-detail-sec">
            <h4>Activity</h4>
            <div className="fleet-durs">
              <div>
                <span>Dwell in zone</span>
                <b>{dur(info.row?.dwell)}</b>
              </div>
              <div>
                <span>Idle, last hour</span>
                <b>{dur(info.row?.idleLastHour)}</b>
              </div>
              <div>
                <span>Restricted today</span>
                <b>{fmtInt(info.row?.restrictedToday ?? 0)}</b>
              </div>
              <div />
            </div>
          </div>
          <div className="fleet-detail-sec">
            <h4>Recent legs</h4>
            <DataTable
              columns={[
                { key: 'a', header: 'Activity', render: (l) => l.activity },
                { key: 'z', header: 'Zone', render: (l) => <span className="dim">{geofenceName(l.zone)}</span> },
                { key: 's', header: 'Start', numeric: true, render: (l) => clock(l.start) },
                { key: 'd', header: 'Duration', numeric: true, render: (l) => (l.open ? <span className="dim">{dur(l.duration)} …</span> : dur(l.duration)) },
              ]}
              rows={info.legs}
              rowKey={(l) => `${l.start}-${l.activity}`}
              maxHeight={230}
              empty="No movements recorded yet"
            />
          </div>
        </>
      )}

      <div className="fleet-actions">
        <button className="btn primary" disabled={!info.onSite} title={info.onSite ? undefined : 'The vehicle has left the site'} onClick={() => openVehicle(v.id)}>
          <Crosshair size={14} aria-hidden />
          Follow in Factory Twin
        </button>
        <button
          className="btn"
          disabled={!inspect}
          title={inspect ? undefined : info.onSite ? 'Current zone has no linked equipment' : 'The vehicle has left the site'}
          onClick={() => inspect && openEquipment(inspect.eq)}
        >
          {inspect?.label ?? 'Inspect dock / zone'}
        </button>
      </div>
    </Panel>
  );
}

// ── Turnaround analytics ─────────────────────────────────────────────────────

const PER_VISIT_MAX = 40;
const BUCKET = 15;

function TurnaroundChart({
  visits,
  periodLabel,
  onSelect,
}: {
  visits: ReturnType<typeof completedVisits>;
  periodLabel: string;
  onSelect: (id: string) => void;
}) {
  const perVisit = visits.length <= PER_VISIT_MAX;
  const withT = visits.filter((x) => x.d.turnaround != null);
  let data: ColumnDatum[];
  if (perVisit) {
    data = withT.map(({ v, d }) => ({ key: v.id, label: v.id.slice(4), value: d.turnaround!, muted: v.visit!.direction === 'inbound' }));
  } else {
    const max = Math.max(...withT.map((x) => x.d.turnaround!));
    const n = Math.min(16, Math.max(1, Math.ceil((max + 0.001) / BUCKET)));
    const counts = Array.from({ length: n }, () => 0);
    for (const x of withT) counts[Math.min(n - 1, Math.floor(x.d.turnaround! / BUCKET))]++;
    data = counts.map((c, i) => ({
      key: String(i),
      label: i === n - 1 && max >= n * BUCKET ? `${i * BUCKET}+` : `${i * BUCKET}`,
      value: c,
    }));
  }
  const byId = new Map(visits.map((x) => [x.v.id, x]));
  const outbound = withT.filter((x) => x.v.visit!.direction === 'outbound').map((x) => x.d.turnaround!);
  const max = outbound.length ? Math.max(...outbound) : null;
  return (
    <Panel
      title={perVisit ? 'Turnaround per visit' : 'Turnaround distribution'}
      subtitle={
        perVisit
          ? `Gate in → gate out, visits completed in ${periodLabel} · outbound solid, inbound faded · click a bar to select`
          : `Visits per ${BUCKET}-min turnaround band · ${withT.length} visits in ${periodLabel}`
      }
      footer={<span>{max != null ? `Longest outbound visit ${dur(max)}` : 'No outbound visits completed in the period'}</span>}
    >
      {withT.length ? (
        perVisit ? (
          <ColumnChart
            data={data}
            height={190}
            format={minFmt}
            tickEvery={Math.max(1, Math.ceil(data.length / 14))}
            onSelect={(c) => onSelect(c.key)}
            tip={(c) => {
              const x = byId.get(c.key)!;
              return (
                <>
                  <b>
                    {x.v.id} · {x.v.visit!.direction === 'outbound' ? 'Outbound' : 'Inbound'}
                  </b>
                  <TipRow k="Carrier" v={x.v.operator} />
                  <TipRow k="Turnaround" v={dur(x.d.turnaround)} />
                  <TipRow k="Waiting" v={dur(x.d.waiting)} />
                  <TipRow k={x.v.visit!.direction === 'outbound' ? 'Dock time' : 'Unloading'} v={dur(x.d.dockTime)} />
                  <TipRow k="Gate out" v={formatClock(x.v.visit!.gateOut!)} />
                </>
              );
            }}
          />
        ) : (
          <ColumnChart
            data={data}
            height={190}
            format={(v) => fmtInt(v)}
            tip={(c) => (
              <>
                <b>{c.label.endsWith('+') ? `${c.label} min` : `${c.label}–${Number(c.label) + BUCKET} min`}</b>
                <TipRow k="Visits" v={fmtInt(c.value)} />
              </>
            )}
          />
        )
      ) : (
        <Empty title="No visits completed in this period" />
      )}
    </Panel>
  );
}
