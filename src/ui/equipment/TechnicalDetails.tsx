/**
 * "Technical details" of the equipment panel — one disclosure at the bottom, collapsed by default:
 * register data, the condition assessment (with the condition indicator and its definition — the
 * only place the indicator appears), data source and feed, the full signal registry with ids, units
 * and how each value is produced, the cameras covering the asset (simulated view / configure a
 * stream), stop / condition / maintenance history and the definitions of every figure the panel
 * shows. Vehicles: their register, visit and position source.
 */
import { MapPin } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { CONVEYOR_BY_ID, DOCKS, LINE, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { clockLabel } from '../../intel/summary';
import { Disclosure, Facts, ProvenanceBadge } from '../kit/Page';
import { FeedStatusBadge, SourceBadge, StatusBadge, FEED_STATUS } from '../kit/Status';
import { fmtInt } from '../kit/format';
import { vehicleGeofence } from '../twin/derive';
import { CameraSources, camerasOf } from './CameraSources';
import { ConditionAssessment, ConditionHistory, INDICATOR_DEFINITION } from './Condition';
import { PLANNED_SOURCE, SIM_SOURCE, feedOf } from './feeds';
import type { EquipmentIntel } from './intel/types';
import { KIND_LABEL, type AssetProfile } from './profile';
import { BASIS_LABEL, SIGNAL_KIND_LABEL, assetSignals } from './signals';

/** Clickable upstream / downstream equipment. */
function Connections({ ids }: { ids: string[] }) {
  const select = useTwin((s) => s.select);
  if (!ids.length) return <span className="muted">—</span>;
  return (
    <span className="conn-items eqw-conn">
      {ids.map((id) => {
        const item = EQUIPMENT_BY_ID[id];
        const zone = ZONE_BY_ID[item.zone];
        return (
          <button key={id} type="button" onClick={() => select(id)} title={`${item.name} · ${zone.name}`}>
            <span className="dot" style={{ background: zone.color }} aria-hidden />
            {id}
          </button>
        );
      })}
    </span>
  );
}

function SignalList({ id }: { id: string }) {
  const rows = useSimValue((s) => assetSignals(s, id), [id]);
  if (!rows.length) return <p className="insp-desc">No signal is configured for this asset.</p>;
  return (
    <ul className="eqw-sigs">
      {rows.map((r) => (
        <li key={r.def.id} title={`Feeds: ${r.metrics} · source: ${r.source}`}>
          <span className="mono eqw-sig-id">{r.def.id}</span>
          <span className="eqw-sig-v num">
            {r.text}
            {r.reading.quality === 'stale' && r.reading.since != null && <small> · last value {formatClock(r.reading.since)}</small>}
          </span>
          <span className="eqw-sig-m">
            {SIGNAL_KIND_LABEL[r.def.kind]} · {r.def.unit} · <span className={r.basis === 'placeholder' ? 'eqw-warn' : ''}>{BASIS_LABEL[r.basis]}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How every figure of the panel is determined: the KPI tiles, facets, analytics and (monitored assets) the condition indicator. */
function Definitions({ intel }: { intel: EquipmentIntel }) {
  const rows: { label: string; text: string }[] = [
    ...intel.metrics.kpis.map((k) => ({ label: k.label, text: k.unavailable && k.notModelled ? `${k.hint} ${k.unavailable}` : k.hint })),
    ...intel.facets.map((f) => ({ label: `${f.label} (state)`, text: f.hint })),
  ];
  const a = intel.analytics;
  if (a?.stops) rows.push({ label: 'Stops · MTBF / MTTR', text: a.stops.basis });
  if (a?.loss) rows.push({ label: 'Output not made at the ideal rate', text: a.loss.basis });
  for (const f of a?.facts ?? []) rows.push({ label: f.label, text: f.hint });
  if (intel.health) rows.push({ label: 'Condition indicator (0–100)', text: INDICATOR_DEFINITION });
  if (!rows.length) return <p className="insp-desc">No figure is calculated for this item.</p>;
  return (
    <dl className="eqw-defs">
      {rows.map((r, i) => (
        <div key={`${i}:${r.label}`}>
          <dt>{r.label}</dt>
          <dd>{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function EquipmentTechnical({ prof, intel }: { prof: AssetProfile; intel: EquipmentIntel }) {
  const id = prof.id;
  const item = EQUIPMENT_BY_ID[id];
  const zone = ZONE_BY_ID[item.zone];
  const ops = OPS_BY_ID[id];
  const conv = CONVEYOR_BY_ID[id];
  const feed = useSimValue((s) => feedOf(s, id), [id]);
  const signals = ops?.signals.length ?? 0;
  const cams = camerasOf(id).length;
  const h = intel.health;
  return (
    <Disclosure title="Technical details" meta={`register · ${signals} signal${signals === 1 ? '' : 's'} · ${cams} camera${cams === 1 ? '' : 's'} · history · definitions`}>
      <div className="eqw-sub-h">Register</div>
      <Facts
        rows={[
          { label: 'Asset id', value: <span className="mono">{id}</span> },
          { label: 'Type', value: KIND_LABEL[prof.kind] },
          { label: 'Zone', value: `${zone.id} · ${zone.name}` },
          { label: 'Process stage', value: prof.stage ? STAGE_BY_ID[prof.stage].name : item.stage },
          { label: 'Line', value: ops?.lineId ? LINE.name : '—' },
          {
            label: 'Ideal rate',
            value: ops?.idealRatePerHour != null ? `${fmtInt(ops.idealRatePerHour)} tiles/h` : conv ? `${fmtInt(conv.capacityPerHour)} tiles/h nominal · ${conv.speedMpm} m/min` : '—',
          },
          { label: 'Upstream', value: <Connections ids={item.upstream} /> },
          { label: 'Downstream', value: <Connections ids={item.downstream} /> },
        ]}
      />
      <p className="insp-desc eqw-desc">{item.description}</p>

      {prof.conditionMonitored && h && (
        <>
          <div className="eqw-sub-h">Condition assessment · rule-based</div>
          <ConditionAssessment id={id} h={h} />
        </>
      )}

      <div className="eqw-sub-h">Data source &amp; feed</div>
      <Facts
        rows={[
          {
            label: 'Delivered by',
            value: (
              <span className="eqw-src">
                {SIM_SOURCE.name} <SourceBadge status={SIM_SOURCE.status} />
              </span>
            ),
          },
          ...(feed
            ? [
                {
                  label: 'Feed status',
                  value:
                    feed.status === 'stale' ? (
                      <span title="The asset keeps operating in the simulation, but the product only knows the last values received">
                        <StatusBadge {...FEED_STATUS.stale} label={feed.statusLabel} />
                      </span>
                    ) : (
                      <FeedStatusBadge status="simulated" />
                    ),
                },
                { label: 'Planned integration', value: PLANNED_SOURCE },
              ]
            : []),
          { label: 'Provenance', value: <ProvenanceBadge kind="simulated" /> },
        ]}
      />

      <div className="eqw-sub-h">Signal registry · current simulated values</div>
      <SignalList id={id} />
      <p className="tw-fine">
        Every value is produced by the simulation engine. Process values the model does not calculate (temperatures, moisture, pressure) are listed as signals a
        real integration would provide, without a value — the demo has no physical model for them, so it shows none.
      </p>

      <div className="eqw-sub-h">Cameras</div>
      <CameraSources equipmentId={id} />

      <div className="eqw-sub-h">History</div>
      <ConditionHistory prof={prof} h={h} />

      <div className="eqw-sub-h">Definitions</div>
      <Definitions intel={intel} />
    </Disclosure>
  );
}

const VEHICLE_TYPE = { 'outbound-truck': 'Outbound truck', 'inbound-tipper': 'Inbound tipper', forklift: 'Forklift', 'wheel-loader': 'Wheel loader' } as const;

function VehicleTechnical({ id, intel }: { id: string; intel: EquipmentIntel }) {
  const d = useSimValue((s) => ({ v: s.logistics.vehicles[id] ?? null, now: s.minute, area: vehicleGeofence(s, id) ?? null }), [id]);
  const v = d.v;
  if (!v) return null;
  const vis = v.visit;
  const t = (m: number | null | undefined) => (m != null && m <= d.now ? clockLabel(m, d.now) : 'Not yet');
  const dock = vis?.dockId ? (DOCKS.find((x) => x.id === vis.dockId)?.name ?? vis.dockId) : null;
  const area = d.area?.equipmentId ? d.area : null;
  return (
    <Disclosure title="Technical details" meta="register · visit · position source · definitions">
      <div className="eqw-sub-h">Register</div>
      <Facts
        rows={[
          { label: 'Vehicle id', value: <span className="mono">{v.id}</span> },
          { label: 'Label', value: v.label },
          { label: 'Type', value: `${VEHICLE_TYPE[v.type]} · ${v.class === 'external' ? 'external' : 'internal'}` },
          { label: 'Operator', value: v.operator },
          ...(v.task ? [{ label: 'Task', value: v.task }] : []),
        ]}
      />
      {vis && (
        <>
          <div className="eqw-sub-h">Visit</div>
          <Facts
            rows={[
              { label: 'Direction', value: vis.direction === 'inbound' ? 'Inbound (raw material)' : 'Outbound (finished goods)' },
              { label: 'Gate in', value: t(vis.gateIn) },
              { label: 'Dock', value: dock ?? (vis.direction === 'inbound' ? 'Raw-material shed' : 'Not assigned yet') },
              { label: 'At dock', value: vis.dockStart != null && vis.dockStart <= d.now ? `${t(vis.dockStart)}${vis.dockEnd != null && vis.dockEnd <= d.now ? `–${t(vis.dockEnd)}` : ''}` : 'Not yet' },
              { label: 'Gate out', value: t(vis.gateOut) },
              { label: 'Load', value: vis.direction === 'outbound' ? `${vis.load} pallets` : `${vis.load} t ${vis.material ?? ''}`.trim() },
            ]}
          />
        </>
      )}
      <div className="eqw-sub-h">Position source</div>
      <p className="insp-desc">
        Simulated route legs at zone level — no GPS, telematics or indoor positioning is connected. The current area is the geofence of its current leg
        {d.area ? ` (${d.area.name})` : ''}.
      </p>
      {area && (
        <button type="button" className="btn sm eqw-area" onClick={() => useTwin.getState().select(area.equipmentId!)} title={`Open ${area.equipmentId} — the area the vehicle is in`}>
          <MapPin size={12} aria-hidden />
          Open the area ({area.equipmentId})
        </button>
      )}
      <div className="eqw-sub-h">Definitions</div>
      <Definitions intel={intel} />
    </Disclosure>
  );
}

/** Collapsed technical detail of the panel's subject (equipment or vehicle). */
export function TechnicalDetails({ intel }: { intel: EquipmentIntel }) {
  return (
    <div className="eqp-tech">
      {intel.subject.type === 'vehicle' ? <VehicleTechnical id={intel.subject.id} intel={intel} /> : <EquipmentTechnical prof={intel.subject.profile} intel={intel} />}
    </div>
  );
}
