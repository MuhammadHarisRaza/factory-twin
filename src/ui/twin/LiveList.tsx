import { useState } from 'react';
import { ChevronDown, ChevronUp, CirclePause, ClipboardList, Cog, Forklift, Hourglass, Package, Route, Truck } from 'lucide-react';
import { useTwin } from '../../store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { OPS_BY_ID, PROCESS_MACHINES } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { OperationalStatus, StatusBadge } from '../kit/Status';
import { fmtInt } from '../kit/format';
import { assetStatus, liveEvents, vehicleActivity, type PhaseTone } from './derive';
import { LiveEventRow, eventTarget, locateEvent } from './EventRows';
import { useMediaQuery } from './useMedia';
import { useTwinUi, type LiveTab } from './uiStore';

/** Cleared events stay in the list this long (open events stay until resolved). */
const EVENT_WINDOW = 240;

/** Icon for a vehicle activity pill (always shown with its label). */
export function phaseIcon(label: string, tone: PhaseTone) {
  if (/waiting/i.test(label)) return Hourglass;
  if (/loading|unloading/i.test(label)) return Package;
  if (tone === 'neutral' && /idle|available/i.test(label)) return CirclePause;
  return Route;
}

/**
 * Bottom-right live list (simulated): operational events (active first, then open and recently
 * cleared ones), process machines with their state, and vehicles on site with their phase.
 * An event row opens the event record; its locate button and the other rows locate in the twin.
 */
export function LiveList() {
  const tab = useTwinUi((s) => s.liveTab);
  const setTab = useTwinUi((s) => s.setLiveTab);
  const open = useTwinUi((s) => s.liveOpen);
  const setOpen = useTwinUi((s) => s.setLiveOpen);
  const selected = useTwin((s) => s.selected);
  const vehicle = useTwin((s) => s.vehicle);
  const zone = useTwin((s) => s.zone);
  // On short screens the list folds away while an inspector is open (unless opened from the list).
  const short = useMediaQuery('(max-height: 860px)');
  const selKey = vehicle ? `v:${vehicle}` : selected ? `e:${selected}` : zone ? `z:${zone}` : null;
  const [keepFor, setKeepFor] = useState<string | null>(null);
  const folded = short && selKey != null && keepFor !== selKey;
  const isOpen = open && !folded;

  const data = useSimValue((s) => {
    const now = s.minute;
    const events = liveEvents(s, EVENT_WINDOW);
    const machines = PROCESS_MACHINES.map((id) => ({ ...assetStatus(s, id), name: EQUIPMENT_BY_ID[id].name, ideal: OPS_BY_ID[id].idealRatePerHour ?? 0 }));
    const vehicles = s.logistics.active
      .map((id) => s.logistics.vehicles[id])
      .filter((v) => v.spawned <= now)
      .map((v) => ({
        id: v.id,
        label: v.label,
        external: v.class === 'external',
        info:
          v.class === 'external'
            ? v.visit?.direction === 'inbound'
              ? `Inbound · ${v.visit.load} t ${v.visit.material ?? ''}`
              : `Outbound · ${v.visit?.load ?? '—'} pallets`
            : v.operator,
        act: vehicleActivity(v, now),
      }))
      .sort((a, b) => Number(b.external) - Number(a.external) || a.label.localeCompare(b.label, 'en', { numeric: true }));
    return { now, events, active: events.filter((e) => e.end == null).length, machines, vehicles };
  });

  const notRunning = data.machines.filter((m) => m.op !== 'running').length;
  const tabs: { id: LiveTab; label: string; icon: typeof Cog; count: number | null }[] = [
    { id: 'events', label: 'Events', icon: ClipboardList, count: data.active || null },
    { id: 'machines', label: 'Machines', icon: Cog, count: notRunning || null },
    { id: 'vehicles', label: 'Vehicles', icon: Truck, count: data.vehicles.length },
  ];

  /** Select from the list; the list stays open for the selection it made. */
  const pick = (key: string, run: () => void) => {
    setKeepFor(key);
    run();
  };
  const toggle = () => {
    if (folded) {
      setKeepFor(selKey);
      setOpen(true);
    } else setOpen(!open);
  };

  return (
    <section className={`tw-live overlay-panel ${isOpen ? '' : 'folded'}`} aria-label="Lists (simulated)">
      <header className="tw-live-h">
        <div className="tw-tabs" role="tablist" aria-label="Live list">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? 'on' : ''}
                onClick={() => {
                  setTab(t.id);
                  if (!isOpen) toggle();
                }}
                title={t.id === 'events' ? 'Operational events · count = active conditions; open and recently cleared events follow' : t.id === 'machines' ? 'Process machines · count = not running normally' : 'Vehicles on site'}
              >
                <Icon size={13} aria-hidden />
                {t.label}
                {t.count != null && t.count > 0 && <span className="tw-count num">{t.count}</span>}
              </button>
            );
          })}
        </div>
        <button className="btn ghost sm icon" onClick={toggle} title={isOpen ? 'Fold the list' : 'Show the list'} aria-expanded={isOpen}>
          {isOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </header>
      {isOpen && (
        <div className="tw-live-b" role="tabpanel">
          {tab === 'events' &&
            (data.events.length ? (
              data.events.map((ev) => {
                const t = eventTarget(ev);
                const key = t ? `${t.kind === 'vehicle' ? 'v' : t.kind === 'zone' ? 'z' : 'e'}:${t.id}` : null;
                return <LiveEventRow key={ev.id} ev={ev} now={data.now} on={key != null && key === selKey} onLocate={() => key && pick(key, () => locateEvent(ev))} />;
              })
            ) : (
              <div className="tw-live-empty">No active or open events, and none cleared in the last 4 h.</div>
            ))}
          {tab === 'machines' &&
            data.machines.map((m) => (
              <button key={m.id} className={`tw-row ${selected === m.id ? 'on' : ''}`} onClick={() => pick(`e:${m.id}`, () => useTwin.getState().select(m.id))} title={`Locate ${m.id}`}>
                <span className="tw-row-m">
                  <b>{m.name}</b>
                  <small className="num">
                    {m.id} · {m.staleSince != null ? `last ${fmtInt(m.rate)} tiles/h · stale since ${formatClock(m.staleSince)}` : `${fmtInt(m.rate)} / ${fmtInt(m.ideal)} tiles/h`}
                  </small>
                </span>
                <span className="tw-pill">
                  <OperationalStatus state={m.op} />
                </span>
              </button>
            ))}
          {tab === 'vehicles' &&
            (data.vehicles.length ? (
              data.vehicles.map((v) => {
                const VIcon = v.external ? Truck : Forklift;
                return (
                  <button
                    key={v.id}
                    className={`tw-row ${vehicle === v.id ? 'on' : ''}`}
                    onClick={() => pick(`v:${v.id}`, () => useTwin.getState().selectVehicle(v.id, true))}
                    title={`Follow ${v.label}`}
                  >
                    <VIcon className="tw-row-i" size={14} aria-hidden />
                    <span className="tw-row-m">
                      <b>{v.label}</b>
                      <small>{v.info}</small>
                    </span>
                    <span className="tw-pill">
                      <StatusBadge tone={v.act.tone} icon={phaseIcon(v.act.label, v.act.tone)} label={v.act.label} size={12} />
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="tw-live-empty">No vehicles on site.</div>
            ))}
        </div>
      )}
    </section>
  );
}
