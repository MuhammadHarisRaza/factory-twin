/**
 * Fleet & Movement — "Where are vehicles and materials, and what is delaying movement?"
 *
 * Title + data-driven summary → the four fleet KPIs (src/intel/kpis.ts fleetKpis) → ONE primary
 * work area: the site layout with simulated vehicle positions (never GPS coordinates), the
 * numbered movement areas (gate, check-in / weighbridge, holding, queue, docks, dispatch staging,
 * exit), truck → assigned-dock lines and delay / alert marks, the movement flow strip under it and
 * the delay review; beside it the selected vehicle's detail (route #/fleet/<vehicle id>) or, with
 * nothing selected, dock usage and the active vehicle alerts. Tables, raw gate / dock records,
 * pickups / drop-offs, analytics and safety rules sit on secondary tabs (?tab=…); there the selected
 * vehicle's detail opens as an overlay drawer, so the tables keep the full width (no side column
 * squeezing them into sideways scrolling at laptop widths).
 *
 * Everything derives from the one simulation state and the shared event engine; current state is
 * "now", statistics use the header's reporting period.
 */
import { useState } from 'react';
import { useApp } from '../app/store';
import { fleetKpis } from '../intel/kpis';
import type { SimState } from '../sim/engine';
import { fleetMetrics, internalVehicles, resolvePeriod, type PeriodKey } from '../sim/metrics';
import { useSim, useSimValue } from '../sim/store';
import { Disclosure, KpiCard, KpiRow, PageHeader, Section, Tabs, useWorkspaceTab } from '../ui/kit/Page';
import { Segmented } from '../ui/kit/Panel';
import { DockUseChart, GateChart, TurnaroundChart } from './fleet/Analytics';
import { PositionsBadge, kpiCardProps, makeClock } from './fleet/common';
import { DelayReview } from './fleet/DelayReview';
import { completedVisits, dockUtilisation, eventLog, hourlyGate } from './fleet/derive';
import { FlowStrip } from './fleet/FlowStrip';
import { delayReview, dockUsage, fleetSummary } from './fleet/movement';
import {
  activeVehicleEvents,
  allHandling,
  dockHoldTarget,
  handlingWindow,
  internalTableRows,
  loadingStats,
  pipeline,
  restrictedEntryGate,
  ruleRows,
  truckRows,
  vehicleEvents,
  zoneRows,
} from './fleet/pipeline';
import { HandlingPanel, NotAvailablePanel, SafetyRules } from './fleet/Safety';
import { SimulateBar } from './fleet/Simulate';
import { MapLegend, SiteMap, mapFlags, type MapView } from './fleet/SiteMap';
import { SiteNow } from './fleet/SiteNow';
import { ContextVideo } from '../video/ContextVideo';
import { DockBoard, ExternalTable, InternalTable, RecordLog } from './fleet/Tables';
import { TruckPipeline } from './fleet/TruckPipeline';
import { VehicleDetail } from './fleet/VehicleDetail';
import { VehicleDrawer } from './fleet/VehicleDrawer';
import { VehicleEvents } from './fleet/VehicleEvents';
import './fleet/fleet.css';

export const FLEET_TABS = ['map', 'trucks', 'internal', 'records', 'events', 'analytics', 'safety'] as const;
export type FleetTab = (typeof FLEET_TABS)[number];

// Reset Demo replays the plant and truck ids restart, so a kept truck selection would name a
// different truck. Internal vehicle ids (FL-01…, WL-01) are stable and stay selected.
useSim.subscribe((s, prev) => {
  if (s.resets === prev.resets) return;
  const a = useApp.getState();
  const id = a.fleetVehicleId;
  if (id && s.sim.logistics.vehicles[id]?.class !== 'internal') a.selectFleetVehicle(null, 'replace');
});

function derive(s: SimState, periodKey: PeriodKey, tab: FleetTab, selected: string | null) {
  const p = resolvePeriod(periodKey, s.minute);
  const now = s.minute;
  const alerts = activeVehicleEvents(s);
  const review = delayReview(s, alerts);
  const docks = dockUsage(s);
  const events = vehicleEvents(s, p);
  const on = (t: FleetTab) => tab === t;
  const needPipe = on('map') || on('trucks');
  const overstay = new Map(s.events.filter((e) => e.type === 'dock-overstay' && e.end == null && e.asset.dockId).map((e) => [e.asset.dockId!, e]));
  const handlingFrom = on('internal') ? handlingWindow(s, 60) : now;
  return {
    p,
    now,
    rules: s.rules,
    kpis: fleetKpis(s, p),
    review,
    docks,
    summary: fleetSummary(s, review, docks),
    trucksOnSite: s.logistics.active.filter((id) => {
      const v = s.logistics.vehicles[id];
      return v.class === 'external' && v.visit!.gateIn <= now;
    }).length,
    internalN: internalVehicles(s).length,
    activeAlerts: events.filter((e) => e.end == null),
    events,
    inside: Object.entries(s.logistics.restrictedOpen)
      .filter(([, o]) => !!o)
      .map(([id, o]) => [id, o!.geofenceId] as [string, string]),
    pipe: needPipe ? pipeline(s) : null,
    flags: on('map') ? mapFlags(s, review, alerts) : null,
    hold: on('map') ? dockHoldTarget(s, selected) : null,
    restricted: on('map') ? restrictedEntryGate(s) : ({ ok: true } as const),
    alerts,
    overstay,
    trucks: on('trucks') ? truckRows(s, p, alerts) : [],
    util: on('trucks') || on('analytics') ? dockUtilisation(s, p) : [],
    internal: on('internal') ? internalTableRows(s, alerts) : [],
    handling: { from: handlingFrom, rows: on('internal') ? allHandling(s, handlingFrom) : [] },
    log: on('records') ? eventLog(s, p) : [],
    visits: on('analytics') ? completedVisits(s, p) : [],
    loading: on('analytics') ? loadingStats(s, p) : { avg: null, n: 0, max: null },
    gate: on('analytics') ? hourlyGate(s, p) : { hours: [], values: [] },
    fm: fleetMetrics(s, p),
    ruleRows: on('safety') ? ruleRows(s, p) : [],
    zones: on('safety') ? zoneRows(s) : [],
  };
}

/** Remounts on Reset Demo so local view state never refers to the discarded run. */
export function FleetPage() {
  const resets = useSim((s) => s.resets);
  return <FleetMovement key={resets} />;
}

function FleetMovement() {
  const period = useApp((s) => s.period);
  const selected = useApp((s) => s.fleetVehicleId);
  const [tab, setWorkspaceTab] = useWorkspaceTab<FleetTab>('fleet', 'map', FLEET_TABS);
  const [view, setView] = useState<MapView>('site');
  const d = useSimValue((s) => derive(s, period, tab, selected), [period, tab, selected]);
  const { p, now, rules } = d;
  const clock = makeClock(now);

  const select = (id: string) => useApp.getState().selectFleetVehicle(id);
  const close = () => useApp.getState().selectFleetVehicle(null);
  // Leaving the site layout for another tab releases the vehicle picked on the layout, so its drawer
  // does not cover the tab just opened (Back returns to the layout with the vehicle selected).
  const setTab = (t: FleetTab) => {
    const leaveMap = tab === 'map' && t !== 'map';
    setWorkspaceTab(t);
    if (leaveMap && useApp.getState().fleetVehicleId != null) useApp.getState().selectFleetVehicle(null, 'replace');
  };
  const showDelays = () => {
    setTab('map');
    requestAnimationFrame(() => document.getElementById('fl-delays')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const kpiAction: Record<string, { onClick: () => void; actionLabel: string; selected?: boolean } | undefined> = {
    'delayed-vehicles': { onClick: showDelays, actionLabel: 'Show the delay review' },
    'avg-dwell': { onClick: () => setTab('analytics'), actionLabel: 'Show turnaround per visit', selected: tab === 'analytics' },
    'completed-trips': { onClick: () => setTab('analytics'), actionLabel: 'Show visit analytics', selected: tab === 'analytics' },
  };

  // Site & movement: the detail (or docks & alerts) is a column beside the layout. Every other tab is a
  // table, list or chart that needs the full width: the detail opens as a drawer over it instead.
  const side = tab !== 'map' ? null : selected ? (
    <VehicleDetail key={selected} id={selected} onClose={close} onSelect={select} />
  ) : (
    <div className="fl-side">
      <SiteNow
        docks={d.docks.rows}
        occupied={d.docks.occupied}
        reserved={d.docks.reserved}
        alerts={d.activeAlerts}
        inside={d.inside}
        now={now}
        clock={clock}
        selected={selected}
        onSelect={select}
      />
      {/* The site-entrance camera recording (client-provided): context for gate and yard movement, not a live view. */}
      <Section title="Site entrance camera" subtitle="Recorded footage · not a live view of the simulated site" className="fl-cam">
        <ContextVideo context={{ topic: 'yard-movement' }} compact />
      </Section>
    </div>
  );

  return (
    <div className="wp fl-page">
      <PageHeader
        title="Fleet & Movement"
        context={
          <>
            <span>Site yard, gate, docks & warehouse</span>
            <span>Plant time {clock(now)} (simulated)</span>
            <span>Statistics: {p.label}</span>
          </>
        }
        summary={d.summary}
      />

      <KpiRow label="Fleet KPIs">
        {d.kpis.map((k) => {
          const a = kpiAction[k.id];
          return (
            <div key={k.id} className="fl-kpi" title={k.definition}>
              <KpiCard {...kpiCardProps(k)} onClick={a?.onClick} actionLabel={a?.actionLabel} selected={a?.selected ?? false} />
            </div>
          );
        })}
      </KpiRow>

      <Tabs<FleetTab>
        label="Fleet & Movement views"
        value={tab}
        onChange={(t) => setTab(t)}
        options={[
          { value: 'map', label: 'Site & movement' },
          { value: 'trucks', label: 'Trucks & docks', count: d.trucksOnSite, title: 'Truck visit pipeline, dock board and every truck on site or departed in the period' },
          { value: 'internal', label: 'Internal vehicles', count: d.internalN, title: 'Forklifts and wheel loader: movement, stop time, pickups and drop-offs' },
          { value: 'records', label: 'Gate & dock log', title: 'Raw gate-in / gate-out, dock and restricted-zone records of the period' },
          { value: 'events', label: 'Vehicle events', count: d.activeAlerts.length || null, title: 'Vehicle events of the period; the count is the events whose condition is still active' },
          { value: 'analytics', label: 'Analytics', title: 'Turnaround per visit, gate movements per hour and dock occupancy for the period' },
          { value: 'safety', label: 'Rules & safety', title: 'Detection thresholds, restricted zones and capabilities that need an integration' },
        ]}
      />

      <div className={side ? 'work' : 'fl-solo'}>
        <div className="fl-main" role="tabpanel" aria-label={tab}>
          {tab === 'map' && (
            <>
              <Section
                className="fl-mapsec"
                title="Site layout"
                subtitle={`${d.trucksOnSite} truck${d.trucksOnSite === 1 ? '' : 's'} and ${d.internalN} internal vehicles · positions move with simulated time · select a vehicle or a dock's truck`}
                actions={
                  <>
                    <PositionsBadge />
                    <Segmented
                      label="Map scale"
                      value={view}
                      onChange={setView}
                      options={[
                        { value: 'site', label: 'Whole site' },
                        { value: 'warehouse', label: 'Warehouse & docks' },
                      ]}
                    />
                  </>
                }
              >
                <SiteMap view={view} selectedId={selected} onSelect={select} />
                <MapLegend />
                <div className="fl-flow-h">
                  <h4>Movement flow now</h4>
                  <span>The step numbers match the numbered areas on the layout · trucks past a limit carry a warning mark</span>
                </div>
                {d.pipe && d.flags && <FlowStrip pipe={d.pipe} flags={d.flags} selected={selected} onSelect={select} onMore={() => setTab('trucks')} />}
              </Section>

              <DelayReview review={d.review} rules={rules} selected={selected} onSelect={select} clock={clock} />

              <div className="fl-simwrap">
                <Disclosure title="Simulate a vehicle scenario" meta="presenter tool · adds a scenario to the simulation">
                  <p className="fl-sim-note">Each button starts a real scenario on the shared simulation (the same ones as the Scenarios drawer) and selects the vehicle it acts on.</p>
                  <SimulateBar hold={d.hold} restricted={d.restricted} onSelect={select} />
                </Disclosure>
              </div>
            </>
          )}

          {tab === 'trucks' && d.pipe && (
            <>
              <TruckPipeline pipe={d.pipe} now={now} waitMax={rules.truckWaitMax} alerts={d.alerts} selected={selected} onSelect={select} />
              <DockBoard
                rows={d.docks.rows}
                util={d.util}
                overstay={d.overstay}
                dockStayMax={rules.dockStayMax}
                now={now}
                clock={clock}
                periodLabel={p.label}
                selected={selected}
                onSelect={select}
              />
              <ExternalTable rows={d.trucks} now={now} clock={clock} periodLabel={p.label} selected={selected} onSelect={select} />
            </>
          )}

          {tab === 'internal' && (
            <>
              <InternalTable rows={d.internal} clock={clock} selected={selected} onSelect={select} />
              <HandlingPanel rows={d.handling.rows} from={d.handling.from} now={now} clock={clock} selected={selected} onSelect={select} />
            </>
          )}

          {tab === 'records' && <RecordLog rows={d.log} clock={clock} periodLabel={p.label} onSelect={select} />}

          {tab === 'events' && <VehicleEvents events={d.events} periodLabel={p.label} clock={clock} onSelectVehicle={select} />}

          {tab === 'analytics' && (
            <>
              <TurnaroundChart visits={d.visits} threshold={rules.turnaroundMax} periodLabel={p.label} onSelect={select} />
              <div className="fl-grid2">
                <GateChart gate={d.gate} gateIn={d.fm.gateIn} gateOut={d.fm.gateOut} periodLabel={p.label} />
                <DockUseChart util={d.util} average={d.fm.dockUtilisation} loading={d.loading} periodLabel={p.label} />
              </div>
            </>
          )}

          {tab === 'safety' && (
            <>
              <SafetyRules rules={d.ruleRows} zones={d.zones} clock={clock} periodLabel={p.label} onSelect={select} />
              <NotAvailablePanel />
            </>
          )}
        </div>
        {side}
      </div>
      {selected && tab !== 'map' && <VehicleDrawer id={selected} onClose={close} onSelect={select} />}
    </div>
  );
}
