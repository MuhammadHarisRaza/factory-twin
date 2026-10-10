import type { ReactNode } from 'react';
import {
  Activity,
  CalendarClock,
  Crosshair,
  ExternalLink,
  HeartPulse,
  Lightbulb,
  LocateFixed,
  LogOut,
  MessageSquareText,
  Scan,
  Video,
  X,
} from 'lucide-react';
import { useTwin } from '../store';
import { ZONE_BY_ID } from '../data/layout';
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment';
import { BUFFERS, CAMERA_BY_ID, CONVEYOR_BY_ID, DOCKS, INSPECTION_STATIONS, OPS_BY_ID, REASON_BY_CODE, STAGE_BY_ID } from '../model/plant';
import type { MachineState, StageId } from '../model/types';
import { WORKSPACES, openStage, useApp, type WorkspaceId } from '../app/store';
import { findDowntime } from '../sim/engine';
import { useSimValue } from '../sim/store';
import { conveyorMetrics, eventDuration, fleetMetrics, machineMetrics, qualityIn, resolvePeriod, visitDurations } from '../sim/metrics';
import { signalValue } from '../sim/signals';
import { phaseLabel, type TruckRuntime } from '../sim/logistics';
import { HEALTH_BY_ID, assess } from '../sim/health';
import { recommendationsFor } from '../intel/insights';
import { formatClock, formatDuration } from '../sim/time';
import { FEED_STATUS, FeedStatusBadge, MACHINE_STATE, MetricText, OperationalStatus, SourceTag, StatusBadge } from './kit/Status';
import { fmtInt, fmtM2, fmtPct } from './kit/format';
import { EventsTab, HEALTH_LEVEL, HealthBadge, HealthTab, RecsTab, VehicleEvents } from './twin/MachineTabs';
import { AssetEventList } from './twin/EventRows';
import { useTwinUi, type InspectorTab } from './twin/uiStore';
import { assetEvents, assetStatus, monitoredStageOf, selectionCamera, vehicleActivity, vehicleGeofence, type AssetStatus } from './twin/derive';
import { phaseIcon } from './twin/LiveList';

const TITLE = Object.fromEntries(WORKSPACES.map((w) => [w.id, w.title])) as Record<WorkspaceId, string>;

/** Clickable list of related equipment (upstream / downstream). */
function Connections({ ids, label }: { ids: string[]; label: string }) {
  const select = useTwin((s) => s.select);
  if (!ids.length) return null;
  return (
    <div className="insp-sec">
      <h3>{label}</h3>
      <div className="conn-items">
        {ids.map((id) => {
          const item = EQUIPMENT_BY_ID[id];
          const zone = ZONE_BY_ID[item.zone];
          return (
            <button key={id} onClick={() => select(id)} title={zone.name}>
              <span className="dot" style={{ background: zone.color }} />
              {item.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OpenIn({ workspace, label }: { workspace: WorkspaceId; label?: string }) {
  const go = useApp((s) => s.go);
  return (
    <button className="btn sm" onClick={() => go(workspace)}>
      <ExternalLink size={13} />
      {label ?? TITLE[workspace]}
    </button>
  );
}

/** Opens the small floating camera view (simulated feed) for a camera covering the selection. */
function CameraButton({ cameraId }: { cameraId: string | null }) {
  const open = useTwinUi((s) => s.camera);
  const setCamera = useTwinUi((s) => s.setCamera);
  if (!cameraId || !CAMERA_BY_ID[cameraId]) return null;
  const on = open === cameraId;
  return (
    <button
      className={`btn sm ${on ? 'on' : ''}`}
      aria-pressed={on}
      onClick={() => setCamera(on ? null : cameraId)}
      title={`${CAMERA_BY_ID[cameraId].name} (${cameraId}) · simulated feed rendered from the digital twin unless a stream is configured`}
    >
      <Video size={13} />
      Camera
    </button>
  );
}

/** Data-feed status of a tracked asset: "Simulated", or "Stale since hh:mm" while its feed is frozen. */
function FeedTag({ status }: { status: AssetStatus | null }) {
  if (status?.staleSince != null)
    return (
      <span className="tw-feed" title="The asset's data feed stopped updating; values shown are the last ones received">
        <StatusBadge {...FEED_STATUS.stale} label={`Stale since ${formatClock(status.staleSince)}`} />
      </span>
    );
  return (
    <span className="tw-feed" title="Data feed: simulation engine — no PLC, gateway or sensor is connected">
      <FeedStatusBadge status="simulated" />
    </span>
  );
}

/** Operational state with its timing: "since 10:42" or the frozen last report while the feed is stale. */
function StatusLine({ st, extra }: { st: AssetStatus; extra?: ReactNode }) {
  return (
    <div className="tw-insp-line">
      <OperationalStatus state={st.op} />
      <span className="muted num">
        {st.staleSince != null ? `no update since ${formatClock(st.staleSince)}` : `since ${formatClock(st.since)}`}
        {extra}
      </span>
    </div>
  );
}

function StaleNote({ st, last }: { st: AssetStatus; last: MachineState | undefined }) {
  if (st.staleSince == null) return null;
  return (
    <p className="insp-desc tw-stale">
      Data feed stale since {formatClock(st.staleSince)}: last reported {last ? MACHINE_STATE[last].label.toLowerCase() : 'state unknown'} at {fmtInt(st.rate)} tiles/h. The
      current state is unknown until the feed updates again; figures after {formatClock(st.staleSince)} are not confirmed by the feed.
    </p>
  );
}

/** Live operational section for a process machine, from the shared simulation. */
function MachineLive({ id }: { id: string }) {
  const data = useSimValue(
    (s) => {
      const st = assetStatus(s, id);
      const m = s.machines[id];
      const mm = machineMetrics(s, id, resolvePeriod('shift', s.minute));
      const active = st.staleSince == null && m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
      return { st, mm, now: s.minute, active, last: s.feeds[id]?.lastState };
    },
    [id],
  );
  const ideal = OPS_BY_ID[id].idealRatePerHour!;
  const { st } = data;
  return (
    <>
      <div className="insp-sec">
        <h3>Status · simulated signals</h3>
        <StatusLine st={st} extra={st.staleSince == null ? ` · ${fmtInt(st.rate)} / ${fmtInt(ideal)} tiles/h` : null} />
        {data.active && (
          <p className="insp-desc" style={{ marginTop: 6 }}>
            {REASON_BY_CODE[data.active.reasonCode].label} · {formatDuration(eventDuration(data.active, data.now))} so far <SourceTag source={data.active.source} />
          </p>
        )}
        <StaleNote st={st} last={data.last} />
      </div>
      <div className="insp-sec">
        <h3>Current shift</h3>
        <div className="insp-kpis">
          <div>
            <span>Output</span>
            <b>{fmtM2(data.mm.totals.count)}</b>
            <span>m²</span>
          </div>
          <div>
            <span>Avail.</span>
            <b>
              <MetricText m={data.mm.oee.availability} digits={0} />
            </b>
          </div>
          <div>
            <span>Perf.</span>
            <b>
              <MetricText m={data.mm.oee.performance} digits={0} />
            </b>
          </div>
          <div title="Tiles from this machine not rejected for defects that originate here">
            <span>Qual.</span>
            <b>
              <MetricText m={data.mm.oee.quality} digits={0} />
            </b>
          </div>
          <div title="Machine OEE = availability × performance × quality (this machine's own losses), from unrounded components">
            <span>OEE</span>
            <b>
              <MetricText m={data.mm.oee.oee} digits={0} />
            </b>
          </div>
        </div>
      </div>
    </>
  );
}

const stageName = (st: StageId | null) => (st ? STAGE_BY_ID[st].name : 'outside the line');
const names = (ids: StageId[]) => ids.map((x) => STAGE_BY_ID[x].name.toLowerCase()).join(' and ');

/** Conveyor: run state, speed, route and what a stop does; shift availability / utilisation / stops; open events. */
function ConveyorLive({ id }: { id: string }) {
  const c = CONVEYOR_BY_ID[id];
  const setTab = useTwinUi((s) => s.setTab);
  const data = useSimValue(
    (s) => {
      const st = assetStatus(s, id);
      const p = resolvePeriod('shift', s.minute);
      const m = s.machines[id];
      const active = st.staleSince == null && m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
      const all = assetEvents(s, id);
      return {
        st,
        p,
        cm: conveyorMetrics(s, id, p),
        active,
        now: s.minute,
        speed: signalValue(s, `${id}.speed`),
        last: s.feeds[id]?.lastState,
        open: all.filter((e) => e.status !== 'resolved'),
        total: all.length,
      };
    },
    [id],
  );
  const { st, cm } = data;
  const effects = [c.blocksInputOf.length ? `starves ${names(c.blocksInputOf)}` : null, c.blocksOutputOf.length ? `blocks ${names(c.blocksOutputOf)}` : null].filter(Boolean).join('; ');
  return (
    <>
      <div className="insp-sec">
        <h3>Conveyor status · simulated signals</h3>
        <StatusLine st={st} extra={` · ${data.speed.text} m/min${data.speed.quality === 'stale' ? ' (last value)' : ''}`} />
        {data.active && (
          <p className="insp-desc" style={{ marginTop: 6 }}>
            {REASON_BY_CODE[data.active.reasonCode].label} · stopped {formatDuration(eventDuration(data.active, data.now))} so far <SourceTag source={data.active.source} />
          </p>
        )}
        <StaleNote st={st} last={data.last} />
        <dl className="dl" style={{ marginTop: 8 }}>
          <dt>Carries</dt>
          <dd>
            {stageName(c.from)} → {stageName(c.to)}
          </dd>
          <dt>Nominal</dt>
          <dd>
            {fmtInt(c.capacityPerHour)} tiles/h · {c.speedMpm} m/min · {c.kind}
          </dd>
          {effects && (
            <>
              <dt>When stopped</dt>
              <dd>{effects.charAt(0).toUpperCase() + effects.slice(1)}</dd>
            </>
          )}
        </dl>
      </div>
      <div className="insp-sec">
        <h3>Current shift · since {formatClock(data.p.from)}</h3>
        <div className="insp-kpis">
          <div title="Running (not stopped) share of the planned time">
            <span>Availability</span>
            <b className="num">{fmtPct(cm.availability, 0)}</b>
          </div>
          <div title="Tiles moved ÷ nominal transport capacity over the planned time">
            <span>Utilisation</span>
            <b className="num">{fmtPct(cm.utilisation, 0)}</b>
          </div>
          <div>
            <span>Stops</span>
            <b className="num">{cm.stops}</b>
          </div>
          <div>
            <span>Stopped</span>
            <b className="num">{formatDuration(cm.downMin)}</b>
          </div>
        </div>
        <p className="tw-fine">OEE is not meaningful for a conveyor: availability is its running share of planned time and utilisation the tiles moved against its nominal capacity.</p>
      </div>
      <div className="insp-sec">
        <h3>Open events · {data.open.length}</h3>
        <AssetEventList events={data.open.slice(0, 3)} now={data.now} empty="No open event on this conveyor." />
        {data.total > 0 && (
          <button className="tw-link tw-more" onClick={() => setTab(id, 'events')}>
            All events of {id} ({data.total}) →
          </button>
        )}
      </div>
    </>
  );
}

function BufferLive({ id }: { id: string }) {
  const b = BUFFERS.find((x) => x.equipmentId === id)!;
  const level = useSimValue((s) => s.buffers[b.id] / b.capacity, [id]);
  return (
    <div className="insp-sec">
      <h3>Buffer level · simulated</h3>
      <div className="num" style={{ fontSize: 16 }}>
        {fmtPct(level, 0)} <span className="muted" style={{ fontSize: 12 }}>of {fmtInt(b.capacity)} tiles</span>
      </div>
      <div className="meter">
        <i style={{ width: `${level * 100}%` }} />
      </div>
    </div>
  );
}

function StationLive({ id }: { id: string }) {
  const st = INSPECTION_STATIONS.find((x) => x.equipmentId === id)!;
  const q = useSimValue((s) => qualityIn(s, resolvePeriod('shift', s.minute)).byStation[st.id], [id]);
  return (
    <div className="insp-sec">
      <h3>Current shift · simulated records</h3>
      <dl className="dl">
        <dt>Method</dt>
        <dd>{st.method}</dd>
        {st.detects.length > 0 && (
          <>
            <dt>Inspected</dt>
            <dd>{fmtInt(q.inspected)} tiles</dd>
            <dt>Rejected</dt>
            <dd>
              {fmtInt(q.rejected)} tiles · {fmtPct(q.inspected ? q.rejected / q.inspected : null)}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

const LOGISTICS_IDS = ['A-GATE', 'A-HOLD', 'K-DOCK', 'K-STG', 'K-RACK', 'K-FLT', 'B-RCV'];

function LogisticsLive({ id }: { id: string }) {
  const data = useSimValue(
    (s) => {
      const lg = s.logistics;
      const dockRows = DOCKS.map((d) => ({ d, v: lg.docks[d.id].vehicleId ? lg.vehicles[lg.docks[d.id].vehicleId!] : null }));
      // Same definition as the KPI chip, Vehicle Monitoring and Command Center: through the gate, not yet out.
      const fm = fleetMetrics(s, resolvePeriod('shift', s.minute));
      return { dockRows, waiting: fm.waiting, stock: lg.stockPallets, onSite: fm.onSite };
    },
    [id],
  );
  if (id === 'K-DOCK')
    return (
      <div className="insp-sec">
        <h3>Docks · simulated · click a truck to follow it</h3>
        <dl className="dl">
          {data.dockRows.map(({ d, v }) => (
            <span key={d.id} style={{ display: 'contents' }}>
              <dt>{d.name}</dt>
              <dd>
                {v ? (
                  <button className="tw-link" onClick={() => useTwin.getState().selectVehicle(v.id, true)}>
                    {v.label} · {v.phase ? phaseLabel[v.phase] : ''}
                  </button>
                ) : (
                  'Free'
                )}
              </dd>
            </span>
          ))}
        </dl>
      </div>
    );
  return (
    <div className="insp-sec">
      <h3>Logistics · simulated</h3>
      <dl className="dl">
        <dt>Trucks on site</dt>
        <dd>{data.onSite}</dd>
        <dt>Waiting for a dock</dt>
        <dd>{data.waiting}</dd>
        {id.startsWith('K') && (
          <>
            <dt>Warehouse stock</dt>
            <dd>{fmtInt(data.stock)} pallets</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function VehicleInspector({ id }: { id: string }) {
  const selectVehicle = useTwin((s) => s.selectVehicle);
  const follow = useTwin((s) => s.follow);
  const setFollow = useTwin((s) => s.setFollow);
  const data = useSimValue(
    (s) => {
      const v = s.logistics.vehicles[id];
      if (!v) return null;
      const now = s.minute;
      const leg = [...v.legs].reverse().find((l) => l.start <= now) ?? v.legs[0];
      const dur = v.class === 'external' ? visitDurations(v as TruckRuntime, now) : null;
      return {
        v,
        leg,
        zone: vehicleGeofence(s, id),
        dur,
        now,
        act: vehicleActivity(v, now),
        gone: v.despawned != null && v.despawned <= now,
        camera: selectionCamera(s, { vehicleId: id })?.id ?? null,
      };
    },
    [id],
  );
  if (!data) return null;
  const { v, leg, zone, dur } = data;
  return (
    <aside className="inspector overlay-panel tw-insp" aria-label={`Vehicle ${v.label}`}>
      <div className="insp-h">
        <div>
          <div className="insp-zone">{v.class === 'external' ? 'External vehicle' : 'Internal vehicle'} · simulated</div>
          <h2>{v.label}</h2>
          <div className="tw-insp-status">
            <StatusBadge tone={data.gone ? 'neutral' : data.act.tone} icon={data.gone ? LogOut : phaseIcon(data.act.label, data.act.tone)} label={data.gone ? 'Left site' : data.act.label} />
            <span className="tw-feed" title="No GPS, telematics or indoor positioning is connected">
              <FeedStatusBadge status="simulated" />
            </span>
          </div>
        </div>
        <button className="btn ghost sm icon" onClick={() => selectVehicle(null)} title="Deselect (Esc)">
          <X size={16} />
        </button>
      </div>
      <div className="tw-insp-b">
        <div className="insp-sec">
          <dl className="dl">
            <dt>Type</dt>
            <dd>{v.type.replace('-', ' ')}</dd>
            <dt>Operator</dt>
            <dd>{v.operator}</dd>
            {v.phase && (
              <>
                <dt>Phase</dt>
                <dd>{phaseLabel[v.phase]}</dd>
              </>
            )}
            <dt>Activity</dt>
            <dd>{data.gone ? 'Left site' : (leg?.activity ?? '—')}</dd>
            <dt>Zone</dt>
            <dd>
              {zone?.name ?? '—'} <span className="muted">· simulated position (zone level)</span>
            </dd>
            {v.visit && (
              <>
                <dt>Gate in</dt>
                <dd>{v.visit.gateIn <= data.now ? formatClock(v.visit.gateIn) : 'Not yet'}</dd>
                <dt>Dock</dt>
                <dd>{v.visit.dockId ? DOCKS.find((d) => d.id === v.visit!.dockId)!.name : v.visit.direction === 'inbound' ? 'Raw-material shed' : '—'}</dd>
                <dt>Load</dt>
                <dd>{v.visit.direction === 'outbound' ? `${v.visit.load} pallets` : `${v.visit.load} t ${v.visit.material ?? ''}`}</dd>
              </>
            )}
            {v.task && (
              <>
                <dt>Task</dt>
                <dd>{v.task}</dd>
              </>
            )}
          </dl>
        </div>
        {dur && (
          <div className="insp-sec">
            <h3>Durations · visit milestones in the strip below</h3>
            <div className="insp-kpis">
              <div>
                <span>Waiting</span>
                <b>{dur.waiting == null ? '—' : Math.round(dur.waiting)}</b>
                <span>min</span>
              </div>
              <div>
                <span>Gate→dock</span>
                <b>{dur.gateToDock == null ? '—' : Math.round(dur.gateToDock)}</b>
                <span>min</span>
              </div>
              <div>
                <span>At dock</span>
                <b>{dur.dockTime == null ? '—' : Math.round(dur.dockTime)}</b>
                <span>min</span>
              </div>
              <div>
                <span>Turnaround</span>
                <b>{dur.turnaround == null ? '—' : Math.round(dur.turnaround)}</b>
                <span>min</span>
              </div>
            </div>
          </div>
        )}
        <VehicleEvents id={id} />
      </div>
      <div className="insp-f">
        <button className={`btn sm ${follow ? 'on' : ''}`} onClick={() => setFollow(!follow)} title="Keep the camera on this vehicle" aria-pressed={follow}>
          <LocateFixed size={13} />
          {follow ? 'Following' : 'Follow'}
        </button>
        {zone?.equipmentId && (
          <button className="btn sm" onClick={() => useTwin.getState().select(zone.equipmentId!)}>
            <Scan size={13} />
            Inspect {zone.kind === 'dock' ? 'dock' : 'zone'}
          </button>
        )}
        <CameraButton cameraId={data.camera} />
        <OpenIn workspace="fleet" />
      </div>
    </aside>
  );
}

/** Equipment detail: Overview | Health | Events | Recommendations. */
function EquipmentInspector({ id }: { id: string }) {
  const select = useTwin((s) => s.select);
  const focusEquipment = useTwin((s) => s.focusEquipment);
  const preset = useTwin((s) => s.preset);
  const tabFor = useTwinUi((s) => s.tabFor);
  const setTab = useTwinUi((s) => s.setTab);
  const tariffs = useApp((s) => s.tariffs);
  const item = EQUIPMENT_BY_ID[id];
  const zone = ZONE_BY_ID[item.zone];
  const ops = OPS_BY_ID[id];
  const isProcess = ops.category === 'process';
  const isConveyor = !!CONVEYOR_BY_ID[id];
  const isHealth = !!HEALTH_BY_ID[id];
  const isBuffer = BUFFERS.some((b) => b.equipmentId === id);
  const isStation = INSPECTION_STATIONS.some((s) => s.equipmentId === id);
  const isLogistics = LOGISTICS_IDS.includes(id);
  const stage = monitoredStageOf(id);
  const live = useSimValue(
    (s) => ({
      status: s.machines[id] ? assetStatus(s, id) : null,
      health: HEALTH_BY_ID[id] ? assess(s, id) : null,
      recs: recommendationsFor(s, id, { tariffs }),
      active: assetEvents(s, id).filter((e) => e.end == null).length,
      camera: selectionCamera(s, { equipmentId: id })?.id ?? null,
    }),
    [id, tariffs],
  );
  const requested = tabFor?.id === id ? tabFor.tab : 'overview';
  const tab: InspectorTab = requested === 'health' && !isHealth ? 'overview' : requested;
  const openRecs = live.recs.filter((r) => r.severity !== 'positive').length;
  const tabs: { id: InspectorTab; label: string; badge?: ReactNode }[] = [
    { id: 'overview', label: 'Overview' },
    ...(isHealth && live.health
      ? [
          {
            id: 'health' as const,
            label: 'Health',
            badge: (() => {
              const H = HEALTH_LEVEL[live.health.level];
              const Icon = H.icon;
              return (
                <span className={`status ${H.tone}`} aria-label={H.label}>
                  <Icon size={12} strokeWidth={2.3} />
                </span>
              );
            })(),
          },
        ]
      : []),
    { id: 'events', label: 'Events', badge: live.active ? <span className="tw-count num" title={`${live.active} active`}>{live.active}</span> : undefined },
    { id: 'recs', label: 'Recommendations', badge: openRecs ? <span className="tw-count num">{openRecs}</span> : undefined },
  ];

  return (
    <aside className="inspector overlay-panel tw-insp" aria-label={item.name}>
      <div className="insp-h">
        <div>
          <div className="insp-zone">
            <span className="chip" style={{ background: zone.color }}>
              {zone.id}
            </span>
            {zone.name}
          </div>
          <h2>{item.name}</h2>
          <div className="tw-insp-status">
            {live.status && <OperationalStatus state={live.status.op} />}
            {live.health && (
              <button className="tw-link" onClick={() => setTab(id, 'health')} title="Condition (rule-based) · open the Health tab">
                <HealthBadge level={live.health.level} />
                {live.health.level !== 'offline' && <span className="muted num"> {live.health.score}/100</span>}
              </button>
            )}
            <FeedTag status={live.status} />
          </div>
        </div>
        <button className="btn ghost sm icon" onClick={() => select(null)} title="Deselect (Esc)">
          <X size={16} />
        </button>
      </div>
      <div className="tw-tabs tw-insp-tabs" role="tablist" aria-label="Asset detail">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(id, t.id)}>
            {t.label}
            {t.badge}
          </button>
        ))}
      </div>
      <div className="tw-insp-b" role="tabpanel">
        {tab === 'overview' && (
          <>
            {isProcess && <MachineLive id={id} />}
            {isConveyor && <ConveyorLive id={id} />}
            {isBuffer && <BufferLive id={id} />}
            {isStation && <StationLive id={id} />}
            {isLogistics && <LogisticsLive id={id} />}
            <div className="insp-sec">
              <dl className="dl">
                <dt>Asset id</dt>
                <dd className="mono">{item.id}</dd>
                <dt>Process stage</dt>
                <dd>{item.stage}</dd>
                <dt>Category</dt>
                <dd style={{ textTransform: 'capitalize' }}>{ops.category.replace('-', ' ')}</dd>
                {live.camera && (
                  <>
                    <dt>Camera</dt>
                    <dd>
                      {CAMERA_BY_ID[live.camera].name} <span className="muted mono">{live.camera}</span>
                    </dd>
                  </>
                )}
              </dl>
              <p className="insp-desc" style={{ marginTop: 8 }}>
                {item.description}
              </p>
            </div>
            <Connections ids={item.upstream} label="Upstream" />
            <Connections ids={item.downstream} label="Downstream" />
          </>
        )}
        {tab === 'health' && live.health && <HealthTab id={id} a={live.health} />}
        {tab === 'events' && <EventsTab id={id} />}
        {tab === 'recs' && <RecsTab id={id} recs={live.recs} />}
      </div>
      <div className="insp-f">
        <button className="btn sm" onClick={() => focusEquipment(item.id)} title="Frame this asset">
          <Crosshair size={13} />
          Focus
        </button>
        <button className="btn sm" onClick={() => preset(zone.preset)} title={`Back to the ${zone.short} view`}>
          <Scan size={13} />
          Zone view
        </button>
        <CameraButton cameraId={live.camera} />
        {stage && (
          <button className="btn sm" onClick={() => openStage(stage)} title="Stage inputs, outputs, losses, cameras and events in Production Monitoring">
            <Activity size={13} />
            Stage monitoring
          </button>
        )}
        {isProcess && <OpenIn workspace="production" />}
        {isHealth && (
          <button className="btn sm" onClick={() => useApp.getState().go('health')}>
            <HeartPulse size={13} />
            {TITLE.health}
          </button>
        )}
        {isStation && <OpenIn workspace="quality" />}
        {isLogistics && <OpenIn workspace="fleet" />}
        {tab === 'events' && (
          <button className="btn sm" onClick={() => useApp.getState().go('events')} title="Every event, its report and PDF in Events & Reports">
            <CalendarClock size={13} />
            {TITLE.events}
          </button>
        )}
        <button
          className="btn sm"
          onClick={() => useApp.getState().openCopilot(`How is ${item.id} performing?`)}
          title="Ask the operations copilot (rule-based on the current demo state — no language model)"
        >
          {tab === 'recs' ? <Lightbulb size={13} /> : <MessageSquareText size={13} />}
          Ask copilot
        </button>
      </div>
    </aside>
  );
}

function ZoneInspector({ id }: { id: string }) {
  const select = useTwin((s) => s.select);
  const selectZone = useTwin((s) => s.selectZone);
  const zone = ZONE_BY_ID[id];
  const items = EQUIPMENT.filter((e) => e.zone === id);
  const states = useSimValue((s) => Object.fromEntries(items.map((e) => [e.id, s.machines[e.id] ? assetStatus(s, e.id).op : null] as const)), [id]);
  return (
    <aside className="inspector overlay-panel tw-insp" aria-label={zone.name}>
      <div className="insp-h">
        <div>
          <div className="insp-zone">
            <span className="chip" style={{ background: zone.color }}>
              {zone.id}
            </span>
            Zone {zone.id} · {zone.stage}
          </div>
          <h2>{zone.name}</h2>
        </div>
        <button className="btn ghost sm icon" onClick={() => selectZone(null)} title="Clear zone">
          <X size={16} />
        </button>
      </div>
      <div className="tw-insp-b">
        <div className="insp-sec">
          <p className="insp-desc">{zone.summary}</p>
        </div>
        <div className="insp-sec">
          <h3>Equipment · click to inspect</h3>
          <div className="mini-events">
            {items.map((e) => (
              <button key={e.id} onClick={() => select(e.id)} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <span className="d">{e.name}</span>
                {states[e.id] ? <OperationalStatus state={states[e.id]!} /> : <span className="muted">—</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Right panel: selected machine, vehicle, or active zone. */
export function Inspector() {
  const selected = useTwin((s) => s.selected);
  const vehicle = useTwin((s) => s.vehicle);
  const zoneId = useTwin((s) => s.zone);
  if (vehicle) return <VehicleInspector id={vehicle} />;
  if (selected && EQUIPMENT_BY_ID[selected]) return <EquipmentInspector key={selected} id={selected} />;
  if (zoneId) return <ZoneInspector id={zoneId} />;
  return null;
}
