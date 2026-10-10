import { ChevronDown, ChevronRight, OctagonX, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTwin } from '../store';
import { VIEWS, VIEW_ORDER, ZONES } from '../data/layout';
import { EQUIPMENT } from '../data/equipment';
import { useSimValue } from '../sim/store';
import type { MachineState } from '../model/types';
import { MACHINE_STATE } from './kit/Status';

/** Keyboard shortcut shown next to the n-th view: 1–9, then 0. */
export const viewShortcut = (index: number) => (index + 1) % 10;

function StateIcon({ state }: { state: MachineState }) {
  const s = MACHINE_STATE[state];
  const Icon = s.icon;
  return (
    <span className={`status ${s.tone}`} title={s.label} aria-label={s.label}>
      <Icon size={12} strokeWidth={2.3} />
    </span>
  );
}

/** Left panel: camera views, then the zone list with expandable equipment and live status. */
export function ZonePanel() {
  const open = useTwin((s) => s.zonePanel);
  const setOpen = useTwin((s) => s.setZonePanel);
  const activeZone = useTwin((s) => s.zone);
  const selected = useTwin((s) => s.selected);
  const selectZone = useTwin((s) => s.selectZone);
  const select = useTwin((s) => s.select);
  const preset = useTwin((s) => s.preset);
  const states = useSimValue((s) => Object.fromEntries(Object.values(s.machines).map((m) => [m.id, m.state])) as Record<string, MachineState>);

  if (!open) {
    return (
      <button className="btn icon panel-open overlay-panel" onClick={() => setOpen(true)} title="Show zones & views">
        <PanelLeftOpen size={16} />
      </button>
    );
  }

  return (
    <aside className="zones overlay-panel" aria-label="Factory navigation">
      <div className="zones-h">
        <span>Views</span>
        <button className="btn ghost sm icon" onClick={() => setOpen(false)} title="Collapse panel">
          <PanelLeftClose size={15} />
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
        <span>Production zones</span>
        <span className="muted">{ZONES.length}</span>
      </div>
      <div className="zone-list">
        {ZONES.map((zone) => {
          const isOpen = activeZone === zone.id;
          const items = EQUIPMENT.filter((e) => e.zone === zone.id);
          const down = items.filter((e) => states[e.id] === 'down').length;
          return (
            <div key={zone.id} className={`zone-row ${isOpen ? 'on' : ''}`}>
              {/* Clicking the open zone again closes it, unless a machine in it is selected. */}
              <button className="zone-btn" onClick={() => selectZone(isOpen && !selected ? null : zone.id)} aria-expanded={isOpen}>
                <span className="chip" style={{ background: zone.color }}>
                  {zone.id}
                </span>
                <span className="zn">
                  <b>{zone.name}</b>
                  <small>{zone.stage}</small>
                </span>
                {down > 0 && (
                  <span className="zone-alert" title={`${down} machine${down > 1 ? 's' : ''} down`}>
                    <OctagonX size={13} />
                  </span>
                )}
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              {isOpen && (
                <div className="eq-list">
                  {items.map((e) => (
                    <button key={e.id} className={selected === e.id ? 'on' : ''} onClick={() => select(e.id)}>
                      <span>{e.name}</span>
                      {states[e.id] && <StateIcon state={states[e.id]} />}
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
