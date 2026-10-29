/**
 * "Technical details" of the equipment panel — one disclosure at the bottom, collapsed by default:
 * register data, the condition assessment (with the condition indicator and its definition — the
 * only place the indicator appears), data source and feed, the integration status and the signal catalogue
 * (availability counts, signal mappings with 'tag not configured', the rule thresholds that apply, calculation
 * definitions), the cameras covering the asset (configure a
 * stream), stop / condition / maintenance history and the definitions of every figure the panel
 * shows. Vehicles: their register, visit and position source.
 */
import { MapPin } from 'lucide-react';
import { AVAILABILITY_CLASS_LABEL, AVAILABILITY_STATUS_LABEL, SOURCE_SYSTEM_LABEL } from '../../model/catalog';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { CONVEYOR_BY_ID, DOCKS, LINE, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import { useSimValue } from '../../sim/store';
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

/**
 * The asset's signal catalogue as an integrator reads it: availability class × status counts, every signal's mapping
 * (source system; no tag is configured — mapped at integration), the rule thresholds that apply (default or
 * configured), the calculation definitions behind the figures and the integration status. Nothing is connected.
 */
function CatalogueView({ intel }: { intel: EquipmentIntel }) {
  const c = intel.catalog;
  const rows = intel.signalTable ?? [];
  return (
    <>
      <div className="eqw-sub-h">Integration status</div>
      <p className="insp-desc">
        No plant system is connected: every value of this asset is produced by the demo simulation. Controller tags are not configured — each signal is mapped at
        integration (PLC / SCADA / historian / MES / QMS / WMS as listed).
      </p>
      {c && c.counts.length > 0 && (
        <>
          <div className="eqw-sub-h">Signal catalogue · availability</div>
          <ul className="eqw-cat-counts">
            {c.counts.map((x) => (
              <li key={`${x.cls}|${x.status}`}>
                <b className="num">{x.n}</b> {x.cls} · {x.status}
              </li>
            ))}
          </ul>
        </>
      )}
      {rows.length > 0 ? (
        <>
          <div className="eqw-sub-h">Signal mappings</div>
          <ul className="eqw-sigs">
            {rows.map((r) => (
              <li key={r.def.signalId} title={r.def.statusNote ?? r.def.description}>
                <span className="mono eqw-sig-id">{r.def.signalId}</span>
                <span className="eqw-sig-v">
                  {SOURCE_SYSTEM_LABEL[r.def.sourceSystem]} · Tag: not configured
                </span>
                <span className="eqw-sig-m">
                  {AVAILABILITY_CLASS_LABEL[r.def.availabilityClass]} · {AVAILABILITY_STATUS_LABEL[r.def.availabilityStatus]}
                  {r.def.unit ? ` · ${r.def.unit}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="insp-desc">No catalogue signal is defined for this asset.</p>
      )}
      {c && c.thresholds.length > 0 && (
        <>
          <div className="eqw-sub-h">Rule thresholds that apply</div>
          <dl className="eqw-defs">
            {c.thresholds.map((x) => (
              <div key={`${x.ruleId}.${x.key}`}>
                <dt>
                  {x.ruleId} · {x.label}
                </dt>
                <dd>
                  {x.value} <span className="muted">({x.source})</span>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {c && c.definitions.length > 0 && (
        <>
          <div className="eqw-sub-h">Calculations</div>
          <dl className="eqw-defs">
            {c.definitions.map((d) => (
              <div key={d.label}>
                <dt>{d.label}</dt>
                <dd>{d.text}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </>
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
  const signals = intel.signalTable?.length ?? ops?.signals.length ?? 0;
  const cams = camerasOf(id).length;
  const h = intel.health;
  return (
    <Disclosure title="Technical details" meta={`register · catalogue of ${signals} signal${signals === 1 ? '' : 's'} · thresholds · ${cams} camera${cams === 1 ? '' : 's'} · history · definitions`}>
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

      <CatalogueView intel={intel} />

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
