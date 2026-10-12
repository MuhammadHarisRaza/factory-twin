/**
 * Right-hand contextual panel of the Factory Twin. The most specific context wins: a selected
 * vehicle or a selected equipment item (both the one equipment intelligence panel), then a highlighted production
 * stage, then the active zone. Each closes with its button or Esc (src/useKeyboardShortcuts.ts).
 */
import { X } from 'lucide-react';
import { useTwin } from '../store';
import { ZONE_BY_ID } from '../data/layout';
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment';
import { MONITORED_STAGE_BY_ID } from '../model/plant';
import { useSimValue } from '../sim/store';
import { OperationalStatus } from './kit/Status';
import { ProvenanceBadge } from './kit/Page';
import { SelectedEquipmentPanel, SelectedVehiclePanel } from './equipment/panel/EquipmentPanel';
import { StagePanel } from './twin/StagePanel';
import { assetStatus } from './twin/derive';

/** Zone selected without an asset: its summary and equipment with live state. */
function ZoneInspector({ id }: { id: string }) {
  const select = useTwin((s) => s.select);
  const selectZone = useTwin((s) => s.selectZone);
  const zone = ZONE_BY_ID[id];
  const items = EQUIPMENT.filter((e) => e.zone === id);
  const states = useSimValue((s) => Object.fromEntries(items.map((e) => [e.id, s.machines[e.id] ? assetStatus(s, e.id).op : null] as const)), [id]);
  return (
    <aside className="inspector overlay-panel tw-insp" aria-label={`Zone ${zone.id} · ${zone.name}`}>
      <div className="insp-h">
        <div>
          <div className="insp-zone">
            <span className="chip" style={{ background: zone.color }} aria-hidden>
              {zone.id}
            </span>
            Zone {zone.id} · {zone.stage}
          </div>
          <h2>{zone.name}</h2>
          <div className="tw-insp-status">
            <ProvenanceBadge kind="simulated" />
          </div>
        </div>
        <button type="button" className="btn ghost sm icon" onClick={() => selectZone(null)} title="Back to the whole factory (Esc)" aria-label="Close zone">
          <X size={16} />
        </button>
      </div>
      <div className="tw-insp-b">
        <div className="insp-sec">
          <p className="insp-desc">{zone.summary}</p>
        </div>
        <div className="insp-sec">
          <h3>Equipment · click to open</h3>
          <div className="mini-events">
            {items.map((e) => (
              <button key={e.id} type="button" onClick={() => select(e.id)} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
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

/** Right panel: selected vehicle, selected equipment, highlighted stage or active zone. */
export function Inspector() {
  const selected = useTwin((s) => s.selected);
  const vehicle = useTwin((s) => s.vehicle);
  const stage = useTwin((s) => s.stage);
  const zoneId = useTwin((s) => s.zone);
  if (vehicle) return <SelectedVehiclePanel id={vehicle} />;
  if (selected && EQUIPMENT_BY_ID[selected]) return <SelectedEquipmentPanel id={selected} />;
  if (stage && MONITORED_STAGE_BY_ID[stage]) return <StagePanel id={stage} />;
  if (zoneId && ZONE_BY_ID[zoneId]) return <ZoneInspector id={zoneId} />;
  return null;
}
