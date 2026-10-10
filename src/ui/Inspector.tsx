import { Crosshair, ExternalLink, LocateFixed, Scan, X } from 'lucide-react';
import { useTwin } from '../store';
import { ZONE_BY_ID } from '../data/layout';
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment';
import { BUFFERS, DOCKS, GEOFENCES, INSPECTION_STATIONS, OPS_BY_ID, REASON_BY_CODE } from '../model/plant';
import { useApp, type WorkspaceId } from '../app/store';
import { useSimValue } from '../sim/store';
import { eventDuration, machineMetrics, qualityIn, resolvePeriod, visitDurations } from '../sim/metrics';
import { phaseLabel, type TruckRuntime } from '../sim/logistics';
import { formatClock, formatDuration } from '../sim/time';
import { MachineStatus, MetricText, SourceTag } from './kit/Status';
import { fmtInt, fmtM2, fmtPct } from './kit/format';

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

function OpenIn({ workspace, label }: { workspace: WorkspaceId; label: string }) {
  const go = useApp((s) => s.go);
  return (
    <button className="btn sm" onClick={() => go(workspace)}>
      <ExternalLink size={13} />
      {label}
    </button>
  );
}

/** Live operational section for a process machine, from the shared simulation. */
function MachineLive({ id }: { id: string }) {
  const data = useSimValue(
    (s) => {
      const m = s.machines[id];
      const p = resolvePeriod('shift', s.minute);
      const mm = machineMetrics(s, id, p);
      const events = s.downtime.filter((d) => d.equipmentId === id && d.category !== 'Starved' && d.category !== 'Blocked').slice(-5).reverse();
      return { m, mm, events, now: s.minute, active: m.activeDowntimeId ? s.downtime.find((d) => d.id === m.activeDowntimeId) : null };
    },
    [id],
  );
  const ideal = OPS_BY_ID[id].idealRatePerHour!;
  return (
    <>
      <div className="insp-sec">
        <h3>Status · simulated</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
          <MachineStatus state={data.m.state} />
          <span className="muted num" style={{ fontSize: 12 }}>
            since {formatClock(data.m.since)} · {fmtInt(data.m.ratePerHour)} / {fmtInt(ideal)} tiles/h
          </span>
        </div>
        {data.active && (
          <p className="insp-desc" style={{ marginTop: 6 }}>
            {REASON_BY_CODE[data.active.reasonCode].label} · {formatDuration(eventDuration(data.active, data.now))} so far{' '}
            <SourceTag source={data.active.source} />
          </p>
        )}
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
          <div>
            <span>OEE</span>
            <b>
              <MetricText m={data.mm.oee.oee} digits={0} />
            </b>
          </div>
        </div>
      </div>
      {data.events.length > 0 && (
        <div className="insp-sec">
          <h3>Recent stoppages</h3>
          <div className="mini-events">
            {data.events.map((d) => (
              <button key={d.id} onClick={() => useApp.getState().go('production')} title="Open Production & OEE">
                <span className="t">{formatClock(d.start)}</span>
                <span className="d">{REASON_BY_CODE[d.reasonCode].label}</span>
                <span className="muted num">{d.end == null ? 'Active' : formatDuration(eventDuration(d, data.now))}</span>
              </button>
            ))}
          </div>
        </div>
      )}
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

function LogisticsLive({ id }: { id: string }) {
  const data = useSimValue(
    (s) => {
      const lg = s.logistics;
      const dockRows = DOCKS.map((d) => ({ d, v: lg.docks[d.id].vehicleId ? lg.vehicles[lg.docks[d.id].vehicleId!] : null }));
      return { dockRows, waiting: lg.queue.length, stock: lg.stockPallets, onSite: lg.active.filter((v) => lg.vehicles[v].class === 'external').length };
    },
    [id],
  );
  if (id === 'K-DOCK')
    return (
      <div className="insp-sec">
        <h3>Docks · simulated</h3>
        <dl className="dl">
          {data.dockRows.map(({ d, v }) => (
            <span key={d.id} style={{ display: 'contents' }}>
              <dt>{d.name}</dt>
              <dd>{v ? `${v.label} · ${v.phase ? phaseLabel[v.phase] : ''}` : 'Free'}</dd>
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
      const zone = GEOFENCES.find((g) => g.id === leg?.zone);
      const dur = v.class === 'external' ? visitDurations(v as TruckRuntime, now) : null;
      return { v, leg, zone, dur, now, gone: v.despawned != null && v.despawned <= now };
    },
    [id],
  );
  if (!data) return null;
  const { v, leg, zone, dur } = data;
  return (
    <aside className="inspector overlay-panel">
      <div className="insp-h">
        <div>
          <div className="insp-zone">{v.class === 'external' ? 'External vehicle' : 'Internal vehicle'} · simulated</div>
          <h2>{v.label}</h2>
        </div>
        <button className="btn ghost sm icon" onClick={() => selectVehicle(null)} title="Deselect (Esc)">
          <X size={16} />
        </button>
      </div>
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
          <dd>{data.gone ? 'Left site' : leg?.activity ?? '—'}</dd>
          <dt>Zone</dt>
          <dd>{zone?.name ?? '—'}</dd>
          {v.visit && (
            <>
              <dt>Gate in</dt>
              <dd>{formatClock(v.visit.gateIn)}</dd>
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
          <h3>Durations</h3>
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
      <div className="insp-f">
        <button className={`btn sm ${follow ? 'on' : ''}`} onClick={() => setFollow(!follow)} title="Keep the camera on this vehicle">
          <LocateFixed size={13} />
          {follow ? 'Following' : 'Follow'}
        </button>
        {zone?.equipmentId && (
          <button className="btn sm" onClick={() => useTwin.getState().select(zone.equipmentId!)}>
            <Scan size={13} />
            Inspect {zone.kind === 'dock' ? 'dock' : 'zone'}
          </button>
        )}
        <OpenIn workspace="fleet" label="Fleet & Logistics" />
      </div>
    </aside>
  );
}

/** Right panel: selected machine, vehicle, or active zone. */
export function Inspector() {
  const selected = useTwin((s) => s.selected);
  const vehicle = useTwin((s) => s.vehicle);
  const zoneId = useTwin((s) => s.zone);
  const select = useTwin((s) => s.select);
  const selectZone = useTwin((s) => s.selectZone);
  const focusEquipment = useTwin((s) => s.focusEquipment);
  const preset = useTwin((s) => s.preset);
  const zoneStates = useSimValue(
    (s) => (zoneId ? EQUIPMENT.filter((e) => e.zone === zoneId).map((e) => [e.id, s.machines[e.id]?.state ?? null] as const) : []),
    [zoneId],
  );

  if (vehicle) return <VehicleInspector id={vehicle} />;

  if (selected) {
    const item = EQUIPMENT_BY_ID[selected];
    const zone = ZONE_BY_ID[item.zone];
    const ops = OPS_BY_ID[selected];
    const isBuffer = BUFFERS.some((b) => b.equipmentId === selected);
    const isStation = INSPECTION_STATIONS.some((s) => s.equipmentId === selected);
    const isLogistics = ['A-GATE', 'A-HOLD', 'K-DOCK', 'K-STG', 'K-RACK', 'K-FLT', 'B-RCV'].includes(selected);
    return (
      <aside className="inspector overlay-panel">
        <div className="insp-h">
          <div>
            <div className="insp-zone">
              <span className="chip" style={{ background: zone.color }}>
                {zone.id}
              </span>
              {zone.name}
            </div>
            <h2>{item.name}</h2>
          </div>
          <button className="btn ghost sm icon" onClick={() => select(null)} title="Deselect (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="insp-sec">
          <dl className="dl">
            <dt>Asset id</dt>
            <dd className="mono">{item.id}</dd>
            <dt>Process stage</dt>
            <dd>{item.stage}</dd>
            <dt>Category</dt>
            <dd style={{ textTransform: 'capitalize' }}>{ops.category.replace('-', ' ')}</dd>
          </dl>
          <p className="insp-desc" style={{ marginTop: 8 }}>
            {item.description}
          </p>
        </div>
        {ops.category === 'process' && <MachineLive id={selected} />}
        {isBuffer && <BufferLive id={selected} />}
        {isStation && <StationLive id={selected} />}
        {isLogistics && <LogisticsLive id={selected} />}
        <Connections ids={item.upstream} label="Upstream" />
        <Connections ids={item.downstream} label="Downstream" />
        <div className="insp-f">
          <button className="btn sm" onClick={() => focusEquipment(item.id)} title="Frame this asset">
            <Crosshair size={13} />
            Focus
          </button>
          <button className="btn sm" onClick={() => preset(zone.preset)} title={`Back to the ${zone.short} view`}>
            <Scan size={13} />
            Zone view
          </button>
          {ops.category === 'process' && <OpenIn workspace="production" label="Production & OEE" />}
          {isStation && <OpenIn workspace="quality" label="Quality" />}
          {isLogistics && <OpenIn workspace="fleet" label="Fleet & Logistics" />}
        </div>
      </aside>
    );
  }

  if (zoneId) {
    const zone = ZONE_BY_ID[zoneId];
    const items = EQUIPMENT.filter((e) => e.zone === zoneId);
    const states = Object.fromEntries(zoneStates);
    return (
      <aside className="inspector overlay-panel">
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
        <div className="insp-sec">
          <p className="insp-desc">{zone.summary}</p>
        </div>
        <div className="insp-sec">
          <h3>Equipment · click to inspect</h3>
          <div className="mini-events">
            {items.map((e) => (
              <button key={e.id} onClick={() => select(e.id)} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <span className="d">{e.name}</span>
                {states[e.id] ? <MachineStatus state={states[e.id]!} /> : <span className="muted">—</span>}
              </button>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  return null;
}
