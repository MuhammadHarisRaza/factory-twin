/**
 * Vehicle Monitoring (use case 4): external trucks through gate → check-in / weighbridge → holding →
 * queue → dock → dispatch staging → exit, internal vehicles by zone, dwell, turnaround and safety
 * events. Current state ("now") for the pipeline, map, dock board and vehicle tables; the shared
 * reporting period for statistics, events, records and analytics. Everything derives from the one
 * simulation state and the shared event engine — positions are simulated at zone level.
 */
import { useState } from 'react';
import { Info } from 'lucide-react';
import { useApp } from '../app/store';
import { DOCKS } from '../model/plant';
import type { OpEvent } from '../model/types';
import type { SimState } from '../sim/engine';
import { fleetMetrics, resolvePeriod, type PeriodKey } from '../sim/metrics';
import { useSim, useSimValue } from '../sim/store';
import { dayStart, formatClock, formatDateTime } from '../sim/time';
import { Panel, Segmented } from '../ui/kit/Panel';
import { fmtInt, fmtPct } from '../ui/kit/format';
import { GateChart, TurnaroundChart } from './fleet/Analytics';
import { PositionTag, dur } from './fleet/common';
import { completedVisits, dockBoard, dockUtilisation, eventLog, geofenceName, hourlyGate } from './fleet/derive';
import {
  activeVehicleEvents,
  allHandling,
  dockHoldTarget,
  handlingWindow,
  internalDwell,
  internalTableRows,
  loadingStats,
  pipeline,
  restrictedEntryGate,
  ruleRows,
  truckRows,
  vehicleEvents,
  zoneRows,
} from './fleet/pipeline';
import { TruckPipeline } from './fleet/TruckPipeline';
import { HandlingPanel, NotAvailablePanel, SafetyRules } from './fleet/Safety';
import { SimulateBar } from './fleet/Simulate';
import { MapLegend, SiteMap, type MapView } from './fleet/SiteMap';
import { DockBoard, ExternalTable, InternalTable, RecordLog } from './fleet/Tables';
import { VehicleDetail } from './fleet/VehicleDetail';
import { VehicleEvents } from './fleet/VehicleEvents';
import './fleet.css';

function derive(s: SimState, periodKey: PeriodKey, selected: string | null) {
  const p = resolvePeriod(periodKey, s.minute);
  const now = s.minute;
  const alerts = activeVehicleEvents(s);
  const overstay = new Map<string, OpEvent>();
  for (const e of s.events) if (e.type === 'dock-overstay' && e.end == null && e.asset.dockId) overstay.set(e.asset.dockId, e);
  const pipe = pipeline(s);
  const waitingNow = pipe.stages.queue.concat(pipe.stages.holding).filter((x) => x.v.phase === 'waiting' && x.v.queuedAt != null);
  const from = handlingWindow(s, 60);
  return {
    p,
    now,
    rules: s.rules,
    fm: fleetMetrics(s, p),
    pipe,
    alerts,
    overstay,
    longestWait: waitingNow.reduce((m, x) => Math.max(m, now - x.v.queuedAt!), 0),
    loading: loadingStats(s, p),
    dwell: internalDwell(s),
    docks: dockBoard(s),
    util: dockUtilisation(s, p),
    trucks: truckRows(s, p, alerts),
    internal: internalTableRows(s, alerts),
    events: vehicleEvents(s, p),
    log: eventLog(s, p),
    handling: { from, rows: allHandling(s, from) },
    ruleRows: ruleRows(s, p),
    zones: zoneRows(s),
    visits: completedVisits(s, p),
    gate: hourlyGate(s, p),
    hold: dockHoldTarget(s, selected),
    restricted: restrictedEntryGate(s),
    internalN: s.logistics.active.filter((id) => s.logistics.vehicles[id].class === 'internal').length,
  };
}

/** Remounts on Reset Demo so the local selection never points at a vehicle of the discarded run. */
export function FleetPage() {
  const resets = useSim((s) => s.resets);
  return <VehicleMonitoring key={resets} />;
}

function VehicleMonitoring() {
  const period = useApp((s) => s.period);
  const resetting = useSim((s) => s.resetting);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<MapView>('site');
  const d = useSimValue((s) => derive(s, period, selected), [period, selected]);
  const { p, now, fm, rules } = d;

  /** Clock with the day when the minute is before today (multi-day periods). */
  const clock = (m: number) => (m < dayStart(now) ? formatDateTime(m) : formatClock(m));

  const occupied = d.docks.filter((r) => r.status === 'loading' || r.status === 'paperwork' || r.status === 'held').length;
  const external = d.trucks.filter((r) => r.active).length;

  return (
    <div className="page">
      {/* ── Answer-first summary ── */}
      <section className="summary fleet-summary" aria-label="Vehicle monitoring summary">
        <div>
          <div className="kpi-label" title="External trucks past gate-in and still on site (now)">
            Vehicles on site
          </div>
          <div className="kpi-value">
            {fmtInt(fm.onSite)}
            <small>trucks</small>
          </div>
          <div className="kpi-sub">
            <span>
              {fmtInt(fm.onSite - fm.inbound)} out · {fmtInt(fm.inbound)} in
            </span>
            <span>+ {d.internalN} internal</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Outbound trucks in the holding area waiting for a dock (now), incl. driver check-in">
            Waiting for a dock
          </div>
          <div className="kpi-value">
            {fmtInt(fm.waiting)}
            <small>trucks</small>
          </div>
          <div className="kpi-sub">
            <span>{fm.waiting ? `longest ${dur(d.longestWait)}` : 'none waiting'}</span>
            <span>threshold {rules.truckWaitMax} min</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Trucks loading or unloading now; dock utilisation = occupied dock minutes ÷ (6 docks × period minutes)">
            Dock activity
          </div>
          <div className="kpi-value">
            {fmtInt(occupied)}
            <small>of {DOCKS.length} docks</small>
          </div>
          <div className="kpi-sub">
            <span>{fmtPct(fm.dockUtilisation, 0)} utilised in period</span>
          </div>
          <div className="meter" aria-hidden>
            <i style={{ width: `${Math.min(100, fm.dockUtilisation * 100)}%` }} />
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Gate in → gate out of the visits completed in the period">
            Avg turnaround
          </div>
          <div className="kpi-value">{dur(fm.avgTurnaround)}</div>
          <div className="kpi-sub">
            <span>{fmtInt(fm.completedVisits)} visits</span>
            <span>threshold {rules.turnaroundMax} min</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Gate in → docked, outbound visits completed in the period">
            Avg gate → dock
          </div>
          <div className="kpi-value">{dur(fm.avgGateToDock)}</div>
          <div className="kpi-sub">
            <span>outbound visits</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Arrival in holding → dock assigned, outbound visits completed in the period">
            Avg queue duration
          </div>
          <div className="kpi-value">{dur(fm.avgWaiting)}</div>
          <div className="kpi-sub">
            <span>holding → dock assigned</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Docked → loading complete, outbound visits completed in the period">
            Avg loading duration
          </div>
          <div className="kpi-value">{dur(d.loading.avg)}</div>
          <div className="kpi-sub">
            <span>dock time {dur(fm.avgDockTime)}</span>
          </div>
        </div>
        <div>
          <div className="kpi-label" title="Average minutes the internal vehicles have spent in their current zone (now; simulated position, zone level)">
            Internal vehicle dwell
          </div>
          <div className="kpi-value">{dur(d.dwell.avg)}</div>
          <div className="kpi-sub">
            <span>{d.dwell.longest ? `longest ${d.dwell.longest.id} · ${dur(d.dwell.longest.dwell)} in ${geofenceName(d.dwell.longest.zone)}` : '—'}</span>
          </div>
        </div>
      </section>

      {/* ── Honesty notice + scenarios ── */}
      <div className="toolbar-row fleet-toolbar">
        <div className="notice" role="note">
          <Info size={14} aria-hidden />
          <span>
            <b>Simulated at zone level.</b> Vehicle movement, gate and dock records come from the simulation; no GPS, ANPR, telematics, CCTV analytics or indoor positioning is connected.
            Statistics: {p.label}.{resetting ? ' Resetting the demo…' : ''}
          </span>
        </div>
        <SimulateBar hold={d.hold} restricted={d.restricted} onSelect={setSelected} />
      </div>

      {/* ── Truck stage pipeline ── */}
      <div className="col-12">
        <TruckPipeline pipe={d.pipe} now={now} waitMax={rules.truckWaitMax} alerts={d.alerts} selected={selected} onSelect={setSelected} />
      </div>

      {/* ── Map + dock board | selected vehicle ── */}
      <div className="col-8 fleet-stack">
        <Panel
          title="Site map"
          subtitle={`Plant time ${formatClock(now)} · ${external} external, ${d.internal.length} internal vehicles · click a vehicle to select`}
          actions={
            <>
              <PositionTag />
              <Segmented
                label="Map scale"
                value={view}
                onChange={setView}
                options={[
                  { value: 'site', label: 'Site' },
                  { value: 'warehouse', label: 'Warehouse' },
                ]}
              />
            </>
          }
        >
          <SiteMap view={view} selectedId={selected} onSelect={setSelected} />
          <MapLegend />
        </Panel>
        <DockBoard
          rows={d.docks}
          util={d.util}
          overstay={d.overstay}
          dockStayMax={rules.dockStayMax}
          now={now}
          clock={clock}
          periodLabel={p.label}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
      <div className="col-4 fleet-stack">
        <VehicleDetail id={selected} onClose={() => setSelected(null)} clock={clock} />
      </div>

      {/* ── Vehicle events | raw records ── */}
      <div className="col-7">
        <VehicleEvents events={d.events} periodLabel={p.label} clock={clock} onSelectVehicle={setSelected} />
      </div>
      <div className="col-5">
        <RecordLog rows={d.log} clock={clock} periodLabel={p.label} onSelect={setSelected} />
      </div>

      {/* ── External trucks ── */}
      <div className="col-12">
        <ExternalTable rows={d.trucks} now={now} clock={clock} periodLabel={p.label} selected={selected} onSelect={setSelected} />
      </div>

      {/* ── Internal vehicles | pickups & drop-offs ── */}
      <div className="col-8">
        <InternalTable rows={d.internal} clock={clock} selected={selected} onSelect={setSelected} />
      </div>
      <div className="col-4">
        <HandlingPanel rows={d.handling.rows} from={d.handling.from} now={now} clock={clock} selected={selected} onSelect={setSelected} />
      </div>

      {/* ── Rules & safety | not available ── */}
      <div className="col-6">
        <SafetyRules rules={d.ruleRows} zones={d.zones} clock={clock} periodLabel={p.label} onSelect={setSelected} />
      </div>
      <div className="col-6">
        <NotAvailablePanel />
      </div>

      {/* ── Analytics ── */}
      <div className="col-7">
        <TurnaroundChart visits={d.visits} threshold={rules.turnaroundMax} periodLabel={p.label} onSelect={setSelected} />
      </div>
      <div className="col-5">
        <GateChart gate={d.gate} gateIn={fm.gateIn} gateOut={fm.gateOut} periodLabel={p.label} />
      </div>
    </div>
  );
}
