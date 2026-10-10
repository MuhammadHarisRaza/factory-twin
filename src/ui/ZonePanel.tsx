import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTwin } from '../store';
import { VIEWS, VIEW_ORDER, ZONES } from '../data/layout';
import { EQUIPMENT } from '../data/equipment';

/** Keyboard shortcut shown next to the n-th view: 1–9, then 0. */
export const viewShortcut = (index: number) => (index + 1) % 10;

/** Left panel: camera views, then the zone list with expandable equipment. */
export function ZonePanel() {
  const open = useTwin((s) => s.zonePanel);
  const setOpen = useTwin((s) => s.setZonePanel);
  const activeZone = useTwin((s) => s.zone);
  const selected = useTwin((s) => s.selected);
  const selectZone = useTwin((s) => s.selectZone);
  const select = useTwin((s) => s.select);
  const preset = useTwin((s) => s.preset);

  if (!open) {
    return (
      <button className="panel-open" onClick={() => setOpen(true)} title="Show zones & views">
        <PanelLeftOpen size={18} />
      </button>
    );
  }

  return (
    <aside className="zones">
      <div className="zones-h">
        <span>Views</span>
        <button className="icon-btn" onClick={() => setOpen(false)} title="Collapse panel">
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="views">
        {VIEW_ORDER.map((id, i) => (
          <button key={id} onClick={() => preset(id)} title={`Shortcut ${viewShortcut(i)}`}>
            <kbd>{viewShortcut(i)}</kbd>
            {VIEWS[id].label}
          </button>
        ))}
      </div>
      <div className="zones-h">
        <span>Factory zones</span>
        <span className="muted">{ZONES.length}</span>
      </div>
      <div className="zone-list">
        {ZONES.map((zone) => {
          const isOpen = activeZone === zone.id;
          const items = EQUIPMENT.filter((e) => e.zone === zone.id);
          return (
            <div key={zone.id} className={`zone-row ${isOpen ? 'on' : ''}`}>
              {/* Clicking the open zone again closes it, unless a machine in it is selected. */}
              <button className="zone-btn" onClick={() => selectZone(isOpen && !selected ? null : zone.id)}>
                <span className="letter" style={{ background: zone.color }}>
                  {zone.id}
                </span>
                <span className="zn">
                  <b>{zone.name}</b>
                  <small>{zone.stage}</small>
                </span>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              {isOpen && (
                <div className="eq-list">
                  {items.map((e) => (
                    <button key={e.id} className={selected === e.id ? 'on' : ''} onClick={() => select(e.id)}>
                      {e.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
