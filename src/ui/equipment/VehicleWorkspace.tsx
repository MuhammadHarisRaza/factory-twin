/**
 * Vehicle variant of the equipment workspace, for a truck or internal vehicle selected in the model:
 * simulated position (zone level), moving or stationary since (time at the current stop — never zone
 * residency), task or visit phase, dock, events, recommended steps and the way to its full record in
 * Fleet & Movement. Positions are simulated; no GPS, telematics or indoor positioning is connected.
 */
import { useMemo } from 'react';
import { LocateFixed, LogOut, Scan, Video, X } from 'lucide-react';
import { openFleetVehicle } from '../../app/store';
import { DOCKS } from '../../model/plant';
import type { OpEvent, Vehicle } from '../../model/types';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { ContextVideo } from '../../video/ContextVideo';
import type { VideoContext, VideoTopic } from '../../video/types';
import { ProvenanceBadge } from '../kit/Page';
import { StatusBadge } from '../kit/Status';
import { AssetEventList } from '../twin/EventRows';
import { selectionCamera, vehicleActivity, vehicleEvents, vehicleGeofence } from '../twin/derive';
import { phaseIcon } from '../twin/LiveList';
import { useTwinUi } from '../twin/uiStore';
import type { NextStep } from './context';
import { vehicleKpis } from './kpis';
import { eventsForSubject, openEventsFor } from '../events/open';
import { ContinueIn, KpiTiles, NextSteps } from './parts';
import './equipment.css';

const TYPE_LABEL: Record<Vehicle['type'], string> = {
  'outbound-truck': 'Outbound truck',
  'inbound-tipper': 'Inbound tipper',
  forklift: 'Forklift',
  'wheel-loader': 'Wheel loader',
};

/** Reference footage topic for what the vehicle is doing (illustrative — never this vehicle). */
export function vehicleTopic(v: Vehicle): VideoTopic {
  if (v.type === 'forklift') return 'warehouse-forklift';
  if (v.type === 'wheel-loader') return 'raw-materials';
  if (v.phase === 'loading') return 'truck-loading';
  if (v.phase === 'unloading') return 'raw-materials';
  if (v.phase === 'to-dock') return 'dock-operations';
  return 'yard-movement';
}

const SEV = { info: 0, warning: 1, serious: 2, critical: 3 } as const;

/** Recommendations of the vehicle's open events (each labelled with its event). */
function vehicleSteps(events: OpEvent[]): NextStep[] {
  return events
    .filter((e) => e.status !== 'resolved' && !e.consequenceOf && e.recommendations.length > 0)
    .sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.start - a.start)
    .slice(0, 3)
    .map((e): NextStep => ({ key: e.id, origin: 'event', severity: e.severity, title: e.title, text: e.recommendations[0], eventId: e.id, links: [{ kind: 'event', id: e.id, label: `Report ${e.id}` }] }));
}

export function VehicleWorkspace({ id }: { id: string }) {
  const selectVehicle = useTwin((s) => s.selectVehicle);
  const follow = useTwin((s) => s.follow);
  const setFollow = useTwin((s) => s.setFollow);
  const camOpen = useTwinUi((s) => s.camera);
  const setCamera = useTwinUi((s) => s.setCamera);
  const d = useSimValue(
    (s) => {
      const v = s.logistics.vehicles[id];
      if (!v) return null;
      const now = s.minute;
      const events = vehicleEvents(s, id);
      const recent = [...events].sort((a, b) => b.start - a.start);
      // The Events list the link opens (this vehicle's id in the search, all recorded time).
      const listed = eventsForSubject(s, { vehicleId: id });
      const shown = new Set(recent.slice(0, 3).map((e) => e.id));
      return {
        v,
        now,
        kpis: vehicleKpis(s, id),
        zone: vehicleGeofence(s, id),
        act: vehicleActivity(v, now),
        gone: v.despawned != null && v.despawned <= now,
        events: recent,
        listed: listed.length,
        more: listed.some((e) => !shown.has(e.id)),
        steps: vehicleSteps(events),
        camera: selectionCamera(s, { vehicleId: id })?.id ?? null,
      };
    },
    [id],
  );
  const topic = d ? vehicleTopic(d.v) : null;
  const video = useMemo<VideoContext>(() => ({ topic }), [topic]);
  if (!d) return null;
  const { v, zone } = d;
  const vis = v.visit;
  const dock = vis?.dockId ? DOCKS.find((x) => x.id === vis.dockId)?.name : null;
  const camOn = d.camera != null && camOpen === d.camera;
  return (
    <aside className="inspector overlay-panel tw-insp eqw" aria-label={`${v.label} · vehicle details`}>
      <header className="insp-h">
        <div>
          <div className="insp-zone">
            {TYPE_LABEL[v.type]} · {v.class === 'external' ? 'external' : 'internal'} · {v.operator}
          </div>
          <h2>{v.label}</h2>
          <div className="tw-insp-status">
            <StatusBadge tone={d.gone ? 'neutral' : d.act.tone} icon={d.gone ? LogOut : phaseIcon(d.act.label, d.act.tone)} label={d.gone ? 'Left site' : d.act.label} />
            <ProvenanceBadge kind="simulated" title="Simulated position and activity — no GPS, telematics or indoor positioning is connected" />
          </div>
        </div>
        <button type="button" className="btn ghost sm icon" onClick={() => selectVehicle(null)} title="Close (Esc)" aria-label="Close vehicle details">
          <X size={16} />
        </button>
      </header>
      <div className="tw-insp-b eqw-b">
        <section className="insp-sec eqw-video" aria-label="Reference video">
          <ContextVideo context={video} compact subject={id} />
          <p className="tw-fine">Illustrative footage of this kind of operation — it does not show this vehicle or establish where it is.</p>
        </section>
        <section className="insp-sec" aria-label="Key figures">
          <h3>Key figures · {d.kpis.scope}</h3>
          <KpiTiles set={d.kpis} label={`${v.label} key figures`} />
        </section>
        <section className="insp-sec" aria-label="Details">
          <h3>Details</h3>
          <dl className="dl">
            <dt>Zone</dt>
            <dd>
              {zone?.name ?? '—'} <span className="muted">· simulated, zone level</span>
            </dd>
            {v.task && (
              <>
                <dt>Task</dt>
                <dd>{v.task}</dd>
              </>
            )}
            {vis && (
              <>
                <dt>Gate in</dt>
                <dd>{vis.gateIn <= d.now ? formatClock(vis.gateIn) : 'Not yet'}</dd>
                <dt>Dock</dt>
                <dd>{dock ?? (vis.direction === 'inbound' ? 'Raw-material shed' : 'Not assigned yet')}</dd>
                <dt>Load</dt>
                <dd>{vis.direction === 'outbound' ? `${vis.load} pallets` : `${vis.load} t ${vis.material ?? ''}`}</dd>
              </>
            )}
          </dl>
          {vis && <p className="tw-fine">The visit milestones are in the strip at the bottom of the model.</p>}
        </section>
        <section className="insp-sec" aria-label="Recent events">
          <h3>Recent events · newest first</h3>
          <AssetEventList events={d.events.slice(0, 3)} now={d.now} empty="No event recorded for this vehicle." />
          {d.more && (
            <button type="button" className="tw-link tw-more" onClick={() => openEventsFor({ vehicleId: id })} title={`Events & Reports, filtered to ${id} for all recorded time`}>
              All {d.listed} event{d.listed === 1 ? '' : 's'} of this vehicle in Events &amp; Reports →
            </button>
          )}
        </section>
        <NextSteps steps={d.steps} current={null} empty="No open recommendation for this vehicle: its waiting, dock and turnaround rules are within thresholds." />
        <ContinueIn
          links={[
            { key: 'fleet', label: 'Open in Fleet & Movement', title: 'The vehicle’s full record: route, visit and events', run: () => openFleetVehicle(id) },
            { key: 'events', label: 'Events & Reports', title: `Every event record of ${id} (all recorded time), each with its report and PDF`, run: () => openEventsFor({ vehicleId: id }) },
          ]}
        />
      </div>
      <footer className="insp-f">
        <button type="button" className={`btn sm ${follow ? 'on' : ''}`} onClick={() => setFollow(!follow)} title="Keep the camera on this vehicle" aria-pressed={follow}>
          <LocateFixed size={13} aria-hidden />
          {follow ? 'Following' : 'Follow'}
        </button>
        {zone?.equipmentId && (
          <button type="button" className="btn sm" onClick={() => useTwin.getState().select(zone.equipmentId!)} title="Open the area the vehicle is in">
            <Scan size={13} aria-hidden />
            Inspect {zone.kind === 'dock' ? 'dock' : 'area'}
          </button>
        )}
        {d.camera && (
          <button type="button" className={`btn sm ${camOn ? 'on' : ''}`} aria-pressed={camOn} onClick={() => setCamera(camOn ? null : d.camera)} title="Simulated camera view of the area the vehicle is in">
            <Video size={13} aria-hidden />
            Camera
          </button>
        )}
      </footer>
    </aside>
  );
}
