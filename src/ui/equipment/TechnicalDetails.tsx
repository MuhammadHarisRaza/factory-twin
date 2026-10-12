/**
 * "Technical details" of the equipment workspace — collapsed by default. Register data, the
 * asset's signals with ids, units, current simulated value, how each value is produced and its
 * feed status, the cameras covering it (simulated view / configure a stream) and its stop,
 * condition and maintenance history. Replaces the retired Assets & Data registry pages.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { CONVEYOR_BY_ID, LINE, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { HealthAssessment } from '../../sim/health';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { Disclosure, Facts, ProvenanceBadge } from '../kit/Page';
import { FeedStatusBadge, SourceBadge, StatusBadge, FEED_STATUS } from '../kit/Status';
import { fmtInt } from '../kit/format';
import { CameraSources, camerasOf } from './CameraSources';
import { ConditionHistory } from './Condition';
import { PLANNED_SOURCE, SIM_SOURCE, feedOf } from './feeds';
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

/** Collapsed technical detail of one asset. */
export function TechnicalDetails({ prof, h }: { prof: AssetProfile; h: HealthAssessment | null }) {
  const id = prof.id;
  const item = EQUIPMENT_BY_ID[id];
  const zone = ZONE_BY_ID[item.zone];
  const ops = OPS_BY_ID[id];
  const conv = CONVEYOR_BY_ID[id];
  const feed = useSimValue((s) => feedOf(s, id), [id]);
  const signals = ops?.signals.length ?? 0;
  const cams = camerasOf(id).length;
  return (
    <div className="insp-sec eqw-tech">
      <Disclosure title="Technical details" meta={`register · ${signals} signal${signals === 1 ? '' : 's'} · ${cams} camera${cams === 1 ? '' : 's'} · history`}>
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

        <div className="eqw-sub-h">Data source &amp; feed</div>
        <Facts
          rows={[
            { label: 'Delivered by', value: <span className="eqw-src">{SIM_SOURCE.name} <SourceBadge status={SIM_SOURCE.status} /></span> },
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

        <div className="eqw-sub-h">Signals · current simulated values</div>
        <SignalList id={id} />
        <p className="tw-fine">
          Every value is produced by the simulation engine. Process values the model does not calculate (temperatures, moisture, pressure) are listed as
          signals a real integration would provide, without a value — the demo has no physical model for them, so it shows none.
        </p>

        <div className="eqw-sub-h">Cameras</div>
        <CameraSources equipmentId={id} />

        <div className="eqw-sub-h">History</div>
        <ConditionHistory prof={prof} h={h} />
      </Disclosure>
    </div>
  );
}
