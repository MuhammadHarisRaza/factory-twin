import { useLayoutEffect } from 'react';
import { ChevronDown, ChevronRight, OctagonX, PanelLeftClose } from 'lucide-react';
import { useTwin } from '../store';
import { VIEWS, VIEW_ORDER, ZONES } from '../data/layout';
import { EQUIPMENT } from '../data/equipment';
import { useSimValue } from '../sim/store';
import type { OperationalState } from '../model/types';
import { OPERATIONAL_STATE } from './kit/Status';
import { QUICK_VIEWS } from './twin/quickViews';
import { assetStatus } from './twin/derive';
import { useTwinUi } from './twin/uiStore';

/** Keyboard shortcut shown next to the n-th view: 1–9, then 0. */
export const viewShortcut = (index: number) => (index + 1) % 10;

/** Below this viewport width the panel starts folded so the 3D view keeps the room (once per session). */
const AUTO_FOLD_BELOW = 1500;
let autoFolded = false;

function StateIcon({ state }: { state: OperationalState }) {
  const s = OPERATIONAL_STATE[state];
  const Icon = s.icon;
  return (
    <span className={`status ${s.tone}`} title={s.label} aria-label={s.label}>
      <Icon size={12} strokeWidth={2.3} />
    </span>
  );
}

/** Left panel: camera and quick views, then the zone list with expandable equipment and live status. */
export function ZonePanel() {
  const open = useTwin((s) => s.zonePanel);
  const setOpen = useTwin((s) => s.setZonePanel);
  const activeZone = useTwin((s) => s.zone);
  const selected = useTwin((s) => s.selected);
  const selectZone = useTwin((s) => s.selectZone);
  const select = useTwin((s) => s.select);
  const preset = useTwin((s) => s.preset);
  // Operational state as the product shows it (planned stops are not faults; a stale feed reads unknown).
  const states = useSimValue((s) => Object.fromEntries(Object.keys(s.machines).map((id) => [id, assetStatus(s, id).op])) as Record<string, OperationalState>);

  useLayoutEffect(() => {
    if (autoFolded) return;
    autoFolded = true;
    if (window.innerWidth < AUTO_FOLD_BELOW) setOpen(false);
  }, [setOpen]);

  // Reopened from the rail (first button).
  if (!open) return null;

  return (
    <aside className="zones overlay-panel" aria-label="Factory navigation">
      <div className="zones-h">
        <span>Views</span>
        <button
          className="btn ghost sm icon"
          onClick={() => {
            setOpen(false);
            // Hiding the list brings back the panel width the viewer chose (showing it may have made it compact).
            useTwinUi.getState().restorePanelWidth();
          }}
          title="Collapse panel (reopen from the rail)"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>
      <div className="views">
        {VIEW_ORDER.map((id, i) => (
          <button key={id} onClick={() => preset(id)} title={`${VIEWS[id].label} · shortcut ${viewShortcut(i)}`}>
            <kbd>{viewShortcut(i)}</kbd>
            {VIEWS[id].label}
          </button>
        ))}
        {QUICK_VIEWS.map((q) => {
          const Icon = q.icon;
          return (
            <button key={q.id} className="tw-quick" onClick={q.run} title={q.hint}>
              <Icon size={13} aria-hidden />
              {q.label}
            </button>
          );
        })}
      </div>
      <div className="zones-h">
        <span>Production zones</span>
        <span className="muted">{ZONES.length}</span>
      </div>
      <div className="zone-list">
        {ZONES.map((zone) => {
          const isOpen = activeZone === zone.id;
          const items = EQUIPMENT.filter((e) => e.zone === zone.id);
          const down = items.filter((e) => states[e.id] === 'stopped' || states[e.id] === 'fault').length;
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
                  <span className="zone-alert" title={`${down} asset${down > 1 ? 's' : ''} stopped or in fault`} aria-label={`${down} stopped`}>
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
