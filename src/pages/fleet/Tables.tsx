/**
 * Fleet & Movement tables (secondary tabs): dock board (current state + period utilisation),
 * external trucks (stage, dock, loading, gate-in / out, waiting, turnaround, event), internal
 * vehicles (zone, movement, activity, handling, time at the current stop, event) and the raw
 * gate / dock / restricted-zone records of the period.
 *
 * The vehicle tables keep to ≤ 8 columns with two-line cells (value + context below) so they fit
 * the full work width at laptop sizes without sideways scrolling; detail-level fields (arrival,
 * dock time, zone of a truck; task, idle time, restricted entries of an internal vehicle) live in
 * the vehicle detail, which opens as a drawer over the table (VehicleDrawer).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ShieldAlert, TriangleAlert } from 'lucide-react';
import { openEquipment, openEvent } from '../../app/store';
import type { OpEvent } from '../../model/types';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { formatClock } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Panel, Segmented } from '../../ui/kit/Panel';
import { SeverityBadge, SourceTag, StatusBadge } from '../../ui/kit/Status';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { DOCK_STATUS, IntegrityBadge, MovementBadge, PositionTag, TYPE_LABEL, dur, sinceText, type Clock } from './common';
import { DOCK_NAME, geofenceName, type DockRow, type LogRow, type LogType } from './derive';
import { STAGE_BY_KEY, type InternalRow, type TruckRow } from './pipeline';

/**
 * Two-line table cell: the value, and its context in smaller type below it. `wrap` lets long text
 * wrap inside the cell instead of widening the table.
 */
function Cell2({ main, sub, wrap = false, title }: { main: ReactNode; sub?: ReactNode; wrap?: boolean; title?: string }) {
  return (
    <span className={`fv-c2${wrap ? ' wrap' : ''}`} title={title}>
      <span className="fv-c2-m">{main}</span>
      {sub != null && sub !== false && <span className="fv-c2-s">{sub}</span>}
    </span>
  );
}

/** Event badge (most severe active vehicle event) with its type below it; opens the event report. */
function AlertCell({ alert }: { alert: OpEvent | null }) {
  if (!alert) return <span className="muted">—</span>;
  return (
    <button
      type="button"
      className="row-link fv-alert"
      title={`${alert.id} · ${alert.title} — open the report`}
      onClick={(e) => {
        e.stopPropagation();
        openEvent(alert.id);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <SeverityBadge severity={alert.severity} />
      <span className="fv-alert-t">{EVENT_TYPE_LABEL[alert.type]}</span>
    </button>
  );
}

// ── Dock board ────────────────────────────────────────────────────────────────

export function DockBoard({
  rows,
  util,
  overstay,
  dockStayMax,
  now,
  clock,
  periodLabel,
  selected,
  onSelect,
}: {
  rows: DockRow[];
  util: { id: string; busy: number; share: number }[];
  /** Dock id → open dock-overstay event. */
  overstay: Map<string, OpEvent>;
  dockStayMax: number;
  now: number;
  clock: Clock;
  periodLabel: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const share = new Map(util.map((u) => [u.id, u]));
  const cols: Column<DockRow>[] = [
    { key: 'dock', header: 'Dock', render: (r) => r.name, width: 70 },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge {...DOCK_STATUS[r.status]} /> },
    {
      key: 'truck',
      header: 'Truck · carrier',
      render: (r) => (r.truck ? <Cell2 main={<span className="mono">{r.truck.id}</span>} sub={r.truck.operator} wrap /> : <span className="muted">—</span>),
    },
    {
      key: 'since',
      header: 'Since',
      numeric: true,
      title: 'Docked since (reserved: dock assigned at)',
      render: (r) => (r.since != null ? clock(r.since) : '—'),
    },
    {
      key: 'time',
      header: 'Dock time',
      numeric: true,
      title: `Time at the dock; flagged from the dock-stay threshold (${dockStayMax} min)`,
      render: (r) =>
        r.dockTime != null && r.dockTime >= dockStayMax ? <StatusBadge tone="warning" icon={TriangleAlert} label={dur(r.dockTime)} /> : dur(r.dockTime),
    },
    {
      key: 'pallets',
      header: 'Pallets loaded',
      numeric: true,
      title: 'Pallets brought to the trailer so far / load (credited when the forklift trip starts)',
      render: (r) => (r.truck && r.status !== 'reserved' ? `${fmtInt(r.loaded)} / ${fmtInt(r.load)}` : r.truck ? `0 / ${fmtInt(r.load)}` : '—'),
    },
    {
      key: 'util',
      header: 'Occupied (period)',
      numeric: true,
      title: `Occupied minutes and share of ${periodLabel}`,
      render: (r) => {
        const u = share.get(r.id);
        return u ? <Cell2 main={fmtPct(u.share, 0)} sub={dur(u.busy)} /> : '—';
      },
    },
    {
      key: 'ev',
      header: 'Event',
      render: (r) => <AlertCell alert={overstay.get(r.id) ?? null} />,
    },
  ];
  const held = [...overstay.values()];
  return (
    <Panel
      className="fv-tbl"
      title="Dock board"
      subtitle={`Plant time ${formatClock(now)} · outbound loading docks · occupancy share over ${periodLabel}`}
      flush
      footer={
        held.length ? (
          <span>
            <StatusBadge tone="warning" icon={TriangleAlert} label={`${held.map((e) => DOCK_NAME[e.asset.dockId ?? ''] ?? e.asset.dockId).join(', ')} over the dock-stay threshold (${dockStayMax} min)`} />
          </span>
        ) : (
          <span>Dock prep 8 min before loading; paperwork and sealing after loading complete. Dock-stay threshold {dockStayMax} min.</span>
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

export function ExternalTable({
  rows,
  now,
  clock,
  periodLabel,
  selected,
  onSelect,
}: {
  rows: TruckRow[];
  now: number;
  clock: Clock;
  periodLabel: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [scope, setScope] = useState<'site' | 'all'>('all');
  const shown = scope === 'site' ? rows.filter((r) => r.active) : rows;
  const at = (m: number | null | undefined) => (m != null && m <= now ? clock(m) : '—');
  const cols: Column<TruckRow>[] = [
    {
      key: 'id',
      header: 'Vehicle',
      title: 'Truck id and type (arrow up: outbound, arrow down: inbound)',
      render: (r) => (
        <Cell2
          main={
            <span className="fv-veh-cell">
              {r.v.visit!.direction === 'outbound' ? <ArrowUpFromLine size={12} aria-label="Outbound" /> : <ArrowDownToLine size={12} aria-label="Inbound" />}
              <span className="mono">{r.id}</span>
              {r.source === 'scenario' && <SourceTag source="scenario" />}
            </span>
          }
          sub={TYPE_LABEL[r.v.type]}
        />
      ),
      sort: (r) => r.id,
    },
    {
      key: 'stage',
      header: 'Stage',
      title: 'Step of the movement flow (numbers match the site layout) and the status within it',
      render: (r) =>
        r.place ? (
          <Cell2
            wrap
            title={r.place.status}
            main={
              <>
                <span className="fv-stepno">{STAGE_BY_KEY[r.place.stage].step}</span>
                {STAGE_BY_KEY[r.place.stage].label}
              </>
            }
            sub={r.place.status}
          />
        ) : (
          <span className="muted">Left site</span>
        ),
      sort: (r) => (r.place ? STAGE_BY_KEY[r.place.stage].step : 99),
    },
    {
      key: 'dock',
      header: 'Dock',
      render: (r) => (r.v.visit!.direction === 'inbound' ? <span className="dim">Shed bay</span> : r.v.visit!.dockId ? DOCK_NAME[r.v.visit!.dockId] : '—'),
      sort: (r) => r.v.visit!.dockId ?? '',
    },
    {
      key: 'load',
      header: 'Loading',
      render: (r) => <Cell2 wrap main={<span className={r.load.done ? '' : 'dim'}>{r.load.label}</span>} />,
      sort: (r) => (r.load.done ? 1 : 0),
    },
    {
      key: 'gateIn',
      header: 'Gate in',
      numeric: true,
      title: 'Gate in, with the gate out below it once the truck has left',
      render: (r) => {
        const out = r.v.visit!.gateOut;
        return <Cell2 main={at(r.v.visit!.gateIn)} sub={out != null && out <= now ? `out ${clock(out)}` : null} />;
      },
      sort: (r) => r.v.visit!.gateIn,
    },
    { key: 'wait', header: 'Waiting', numeric: true, title: 'Holding arrival → dock assigned', render: (r) => dur(r.d.waiting), sort: (r) => r.d.waiting },
    {
      key: 'turn',
      header: 'Turnaround',
      numeric: true,
      title: 'Gate in → gate out (on site: time so far)',
      render: (r) =>
        r.integrity.kind === 'incomplete' ? (
          <span title={r.integrity.note ?? undefined}>
            <IntegrityBadge integrity={r.integrity} />
          </span>
        ) : r.d.turnaround != null ? (
          dur(r.d.turnaround)
        ) : r.v.visit!.gateIn <= now ? (
          <Cell2 main={<span className="dim">{dur(now - r.v.visit!.gateIn)}</span>} sub="so far" />
        ) : (
          '—'
        ),
      sort: (r) => (r.integrity.kind === 'incomplete' ? null : (r.d.turnaround ?? (r.v.visit!.gateIn <= now ? now - r.v.visit!.gateIn : null))),
    },
    { key: 'ev', header: 'Event', render: (r) => <AlertCell alert={r.alert} />, sort: (r) => (r.alert ? 1 : 0) },
  ];
  const active = rows.filter((r) => r.active).length;
  return (
    <Panel
      className="fv-tbl"
      title="External vehicles"
      subtitle={`${active} on site past gate-in · ${rows.length - active} departed in ${periodLabel} · from simulated gate and dock records`}
      actions={
        <>
          <PositionTag />
          <Segmented
            label="Trucks shown"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'On site + departed' },
              { value: 'site', label: 'On site' },
            ]}
          />
        </>
      }
      flush
    >
      <DataTable
        columns={cols}
        rows={shown}
        rowKey={(r) => r.id}
        selectedKey={selected}
        onRowClick={(r) => onSelect(r.id)}
        maxHeight={360}
        initialSort={{ key: 'gateIn', dir: 'desc' }}
        empty={scope === 'site' ? 'No external vehicle on site past gate-in' : 'No external vehicles on site or departed in this period'}
      />
    </Panel>
  );
}

// ── Internal vehicles ─────────────────────────────────────────────────────────

/** Zone-cell badge of an internal vehicle inside a restricted geofence now (the zone is named in the title). */
const RESTRICTED_NOW = 'In restricted zone';
const restrictedTitle = (geofenceId: string) => `Inside the restricted zone: ${geofenceName(geofenceId)} — simulated position`;

export function InternalTable({ rows, clock, selected, onSelect }: { rows: InternalRow[]; clock: Clock; selected: string | null; onSelect: (id: string) => void }) {
  const cols: Column<InternalRow>[] = [
    { key: 'id', header: 'Vehicle', render: (r) => <Cell2 main={<span className="mono">{r.id}</span>} sub={TYPE_LABEL[r.v.type]} />, sort: (r) => r.id },
    {
      key: 'zone',
      header: 'Zone',
      title:
        'Simulated position, zone level · below it: a restricted-zone entry now or earlier today, otherwise since when the vehicle has worked in this zone (context, not a dwell)',
      render: (r) => (
        <Cell2
          wrap
          main={geofenceName(r.zone)}
          sub={
            r.insideRestricted ? (
              // Short label that may wrap (the zone names are long and carry their own brackets, e.g.
              // "Palletiser cell (no entry)"); the zone is named in the title and in the vehicle detail.
              <span className="fv-zone-flag" title={restrictedTitle(r.insideRestricted)}>
                <StatusBadge tone="warning" icon={ShieldAlert} label={RESTRICTED_NOW} />
                <span className="sr-only">: {geofenceName(r.insideRestricted)}</span>
              </span>
            ) : r.restrictedToday > 0 ? (
              <StatusBadge tone="warning" icon={TriangleAlert} label={`${r.restrictedToday} restricted-zone ${r.restrictedToday === 1 ? 'entry' : 'entries'} today`} />
            ) : r.zoneSince != null ? (
              `in zone since ${sinceText(r.zoneSince, clock)}`
            ) : null
          }
        />
      ),
      sort: (r) => geofenceName(r.zone),
    },
    {
      key: 'move',
      header: 'Movement',
      render: (r) => <Cell2 main={<MovementBadge state={r.movement} />} sub={r.loaded ? 'loaded' : 'empty'} />,
      sort: (r) => r.movement,
    },
    { key: 'act', header: 'Current activity', render: (r) => <Cell2 wrap main={r.activity ?? '—'} /> },
    {
      key: 'last',
      header: 'Last pickup / drop-off',
      render: (r) =>
        r.last ? (
          <Cell2
            wrap
            title={`${r.last.activity} · ${r.last.dock ?? geofenceName(r.last.zone)}`}
            main={
              <>
                <span className={`fv-kind ${r.last.kind}`}>{r.last.kind === 'pickup' ? 'Pickup' : 'Drop-off'}</span> {clock(r.last.time)}
              </>
            }
            sub={r.last.dock ?? geofenceName(r.last.zone)}
          />
        ) : (
          <span className="muted">—</span>
        ),
      sort: (r) => r.last?.time ?? null,
    },
    { key: 'h60', header: 'Handling, 60 min', numeric: true, title: 'Pickups + drop-offs in the last 60 min (within the retained movement history)', render: (r) => fmtInt(r.handled60), sort: (r) => r.handled60 },
    {
      key: 'stop',
      header: 'At current stop',
      numeric: true,
      title: 'Dwell of an internal vehicle: minutes standing at the current stop (0 while moving). Zone residency is not a dwell.',
      render: (r) => (r.moving ? <span className="dim">moving</span> : dur(r.stationaryMin)),
      sort: (r) => (r.moving ? 0 : r.stationaryMin),
    },
    { key: 'ev', header: 'Event', render: (r) => <AlertCell alert={r.alert} />, sort: (r) => (r.alert ? 1 : 0) },
  ];
  return (
    <Panel
      className="fv-tbl"
      title="Internal vehicles"
      subtitle="Warehouse, dispatch and packaging forklifts, raw-material wheel loader · current state (simulated)"
      actions={<PositionTag long />}
      flush
    >
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} selectedKey={selected} onRowClick={(r) => onSelect(r.id)} maxHeight="none" />
    </Panel>
  );
}

// ── Gate / dock / zone records ────────────────────────────────────────────────

const LOG_LIMIT = 300;
const LOG_TYPE: Record<LogType, string> = { gate: 'Gate', dock: 'Dock', restricted: 'Restricted zone' };

export function RecordLog({ rows, clock, periodLabel, onSelect }: { rows: LogRow[]; clock: Clock; periodLabel: string; onSelect: (id: string) => void }) {
  const [type, setType] = useState<'all' | LogType>('all');
  const filtered = useMemo(() => (type === 'all' ? rows : rows.filter((r) => r.type === type)), [rows, type]);
  const shown = filtered.slice(0, LOG_LIMIT);
  const cols: Column<LogRow>[] = [
    { key: 'time', header: 'Time', numeric: true, render: (r) => clock(r.time) },
    {
      key: 'event',
      header: 'Record',
      render: (r) => (r.type === 'restricted' ? <StatusBadge tone="warning" icon={TriangleAlert} label={r.event} /> : <span title={LOG_TYPE[r.type]}>{r.event}</span>),
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
      title="Gate, dock & zone records"
      subtitle={`Gate-in / gate-out, dock and restricted-zone records · ${periodLabel}`}
      actions={
        <Segmented
          label="Record type"
          value={type}
          onChange={setType}
          options={[
            { value: 'all', label: 'All' },
            { value: 'gate', label: 'Gate' },
            { value: 'dock', label: 'Dock' },
            { value: 'restricted', label: 'Zone' },
          ]}
        />
      }
      flush
      footer={
        <span>
          {filtered.length > LOG_LIMIT ? `Latest ${LOG_LIMIT} of ${fmtInt(filtered.length)} records` : `${fmtInt(filtered.length)} records`} · newest first · simulated records, no gate system connected
        </span>
      }
    >
      <DataTable columns={cols} rows={shown} rowKey={(r) => r.id} maxHeight={330} empty="No records of this type in the period" />
    </Panel>
  );
}
