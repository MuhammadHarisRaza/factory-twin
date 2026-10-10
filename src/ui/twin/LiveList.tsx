import { useState } from 'react';
import { Bell, ChevronDown, ChevronUp, CirclePause, Cog, Forklift, Hourglass, Package, Route, Truck } from 'lucide-react';
import { useTwin } from '../../store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { OPS_BY_ID, PROCESS_MACHINES } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { MachineStatus, SEVERITY, StatusBadge } from '../kit/Status';
import { fmtInt } from '../kit/format';
import { vehicleActivity, type PhaseTone } from './derive';
import { useMediaQuery } from './useMedia';
import { useTwinUi, type LiveTab } from './uiStore';

const ALERT_WINDOW = 240;

/** Icon for a vehicle activity pill (always shown with its label). */
export function phaseIcon(label: string, tone: PhaseTone) {
  if (/waiting/i.test(label)) return Hourglass;
  if (/loading|unloading/i.test(label)) return Package;
  if (tone === 'neutral' && /idle|available/i.test(label)) return CirclePause;
  return Route;
}

/**
 * Bottom-right live list (simulated): alerts of the last 4 h, process machines with their
 * state, and vehicles on site with their phase. Clicking a row locates it in the twin.
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
    const alerts = s.alerts.filter((a) => a.time >= now - ALERT_WINDOW).reverse();
    const machines = PROCESS_MACHINES.map((id) => ({
      id,
      name: EQUIPMENT_BY_ID[id].name,
      state: s.machines[id].state,
      rate: s.machines[id].ratePerHour,
      ideal: OPS_BY_ID[id].idealRatePerHour ?? 0,
    }));
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
    return { alerts, machines, vehicles };
  });

  const notRunning = data.machines.filter((m) => m.state !== 'running').length;
  const tabs: { id: LiveTab; label: string; icon: typeof Bell; count: number | null }[] = [
    { id: 'alerts', label: 'Alerts', icon: Bell, count: data.alerts.length },
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
    <section className={`tw-live overlay-panel ${isOpen ? '' : 'folded'}`} aria-label="Live lists (simulated)">
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
                title={t.id === 'alerts' ? 'Alerts raised in the last 4 h' : t.id === 'machines' ? 'Process machines · count = not running normally' : 'Vehicles on site'}
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
          {tab === 'alerts' &&
            (data.alerts.length ? (
              data.alerts.map((a) => {
                const sev = SEVERITY[a.severity];
                const Icon = sev.icon;
                const target = a.equipmentId ? `e:${a.equipmentId}` : a.vehicleId ? `v:${a.vehicleId}` : null;
                return (
                  <button
                    key={a.id}
                    className={`tw-row ${target && target === selKey ? 'on' : ''}`}
                    disabled={!target}
                    onClick={() =>
                      target &&
                      pick(target, () =>
                        a.equipmentId ? useTwin.getState().select(a.equipmentId) : useTwin.getState().selectVehicle(a.vehicleId!, true),
                      )
                    }
                    title={a.equipmentId ? `Locate ${a.equipmentId}` : a.vehicleId ? 'Follow the vehicle' : undefined}
                  >
                    <span className={`status ${sev.tone}`} title={sev.label}>
                      <Icon size={13} strokeWidth={2.2} aria-label={sev.label} />
                    </span>
                    <span className="tw-row-m">
                      <b>{a.title}</b>
                      <small>
                        {a.detail}
                        {a.source === 'scenario' ? ' · scenario' : ''}
                      </small>
                    </span>
                    <span className="tw-row-t num">{formatClock(a.time)}</span>
                  </button>
                );
              })
            ) : (
              <div className="tw-live-empty">No alerts in the last 4 h.</div>
            ))}
          {tab === 'machines' &&
            data.machines.map((m) => (
              <button key={m.id} className={`tw-row ${selected === m.id ? 'on' : ''}`} onClick={() => pick(`e:${m.id}`, () => useTwin.getState().select(m.id))} title={`Locate ${m.id}`}>
                <span className="tw-row-m">
                  <b>{m.name}</b>
                  <small className="num">
                    {m.id} · {fmtInt(m.rate)} / {fmtInt(m.ideal)} tiles/h
                  </small>
                </span>
                <span className="tw-pill">
                  <MachineStatus state={m.state} />
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
