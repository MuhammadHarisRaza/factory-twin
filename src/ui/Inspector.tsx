import { Crosshair, X } from 'lucide-react';
import { useTwin } from '../store';
import { ZONE_BY_ID } from '../data/layout';
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment';

/** Clickable list of related equipment (upstream / downstream). */
function Connections({ ids, label }: { ids: string[]; label: string }) {
  const select = useTwin((s) => s.select);
  if (!ids.length) return null;
  return (
    <div className="conn">
      <div className="conn-l">{label}</div>
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

/** Right panel: details of the selected machine, or of the active zone. */
export function Inspector() {
  const selected = useTwin((s) => s.selected);
  const zoneId = useTwin((s) => s.zone);
  const select = useTwin((s) => s.select);
  const selectZone = useTwin((s) => s.selectZone);
  const focusEquipment = useTwin((s) => s.focusEquipment);

  if (selected) {
    const item = EQUIPMENT_BY_ID[selected];
    const zone = ZONE_BY_ID[item.zone];
    return (
      <aside className="inspector">
        <div className="insp-h">
          <div>
            <div className="insp-zone">
              <span className="letter" style={{ background: zone.color }}>
                {zone.id}
              </span>
              {zone.name}
            </div>
            <h2>{item.name}</h2>
          </div>
          <button className="icon-btn" onClick={() => select(null)} title="Deselect (Esc)">
            <X size={16} />
          </button>
        </div>
        <dl className="insp-meta">
          <div>
            <dt>Process stage</dt>
            <dd>{item.stage}</dd>
          </div>
          <div>
            <dt>Asset group</dt>
            <dd className="mono">{item.id}</dd>
          </div>
        </dl>
        <p className="insp-desc">{item.description}</p>
        <Connections ids={item.upstream} label="Upstream" />
        <Connections ids={item.downstream} label="Downstream" />
        <div className="insp-f">
          <button className="tb-btn" onClick={() => focusEquipment(item.id)}>
            <Crosshair size={15} />
            Focus
          </button>
          <span className="muted">Descriptive data only · no live values</span>
        </div>
      </aside>
    );
  }

  if (zoneId) {
    const zone = ZONE_BY_ID[zoneId];
    const items = EQUIPMENT.filter((e) => e.zone === zoneId);
    return (
      <aside className="inspector">
        <div className="insp-h">
          <div>
            <div className="insp-zone">
              <span className="letter" style={{ background: zone.color }}>
                {zone.id}
              </span>
              Zone {zone.id}
            </div>
            <h2>{zone.name}</h2>
          </div>
          <button className="icon-btn" onClick={() => selectZone(null)} title="Clear zone">
            <X size={16} />
          </button>
        </div>
        <p className="insp-desc">{zone.summary}</p>
        <div className="conn">
          <div className="conn-l">Equipment in this zone · click to inspect</div>
          <div className="conn-items">
            {items.map((e) => (
              <button key={e.id} onClick={() => select(e.id)}>
                <span className="dot" style={{ background: zone.color }} />
                {e.name}
              </button>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  return null;
}
