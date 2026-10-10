import { useEffect, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  Box,
  Building2,
  ClipboardList,
  ChevronsLeft,
  ChevronsRight,
  Database,
  FlaskConical,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  LoaderCircle,
  MessageSquareText,
  Pause,
  Play,
  ScanSearch,
  SlidersHorizontal,
  Truck,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { FACTORY } from '../model/plant';
import type { AlertSeverity } from '../model/types';
import { PERIOD_LABELS, type PeriodKey } from '../sim/metrics';
import { activeEvents } from '../sim/events';
import { SPEEDS, useSim, useSimValue } from '../sim/store';
import { formatClock, formatDay, shiftAt } from '../sim/time';
import { useTwin } from '../store';
import { SEVERITY } from '../ui/kit/Status';
import { WORKSPACES, WORKSPACE_GROUPS, useApp, type WorkspaceId } from './store';
import { scenariosActive } from '../sim/engine';
import '../ui/shell.css';

const ICONS: Record<WorkspaceId, LucideIcon> = {
  twin: Box,
  monitoring: Activity,
  events: ClipboardList,
  copilot: Bot,
  production: Gauge,
  quality: ScanSearch,
  health: HeartPulse,
  energy: Zap,
  command: LayoutDashboard,
  scenarios: FlaskConical,
  fleet: Truck,
  assets: Database,
};

const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/** Active conditions (events whose condition still persists) and the highest severity among them. */
function useActiveEvents() {
  return useSimValue((s) => {
    const list = activeEvents(s);
    let worst: AlertSeverity | null = null;
    for (const e of list) if (worst == null || SEV_RANK[e.severity] > SEV_RANK[worst]) worst = e.severity;
    return { count: list.length, worst };
  });
}

/** Count of active events on the Events & Reports entry: severity icon + number, coloured by the worst severity. */
function EventsBadge() {
  const { count, worst } = useActiveEvents();
  if (!count || !worst) return null;
  const sev = SEVERITY[worst];
  const Icon = sev.icon;
  return (
    <span className={`nav-badge ${sev.tone}`} title={`${count} active event${count > 1 ? 's' : ''} · highest severity ${sev.label.toLowerCase()}`} aria-label={`${count} active, highest ${sev.label}`}>
      <Icon size={11} strokeWidth={2.4} aria-hidden />
      <b className="num">{count}</b>
    </span>
  );
}

export function Sidebar() {
  const workspace = useApp((s) => s.workspace);
  const go = useApp((s) => s.go);
  const collapsed = useApp((s) => s.navCollapsed);
  const setCollapsed = useApp((s) => s.setNavCollapsed);
  const presenting = useTwin((s) => s.uiHidden);
  // Presentation mode belongs to the Factory Twin (where its exit control and demo mark live):
  // leaving the twin by any route (a link, a deep link) shows the interface again.
  useEffect(() => {
    if (presenting && workspace !== 'twin') useTwin.getState().setUiHidden(false);
  }, [presenting, workspace]);
  return (
    <nav className="nav" aria-label="Workspaces">
      <div className="nav-brand">
        <div className="mark">wAI</div>
        <div>
          <b>wAI Manufacturing Digital Twin</b>
          <small>AI-Powered Operational Intelligence</small>
        </div>
      </div>
      {WORKSPACE_GROUPS.map(({ id: group, label }) => (
        <div className="nav-items" key={group}>
          <div className="nav-section">{label}</div>
          {WORKSPACES.filter((w) => w.group === group).map((w) => {
            const Icon = ICONS[w.id];
            return (
              <button
                key={w.id}
                className={`nav-item ${workspace === w.id ? 'on' : ''}`}
                onClick={() => go(w.id)}
                aria-current={workspace === w.id ? 'page' : undefined}
                title={collapsed ? w.title : undefined}
              >
                <Icon size={17} strokeWidth={1.9} />
                <span>{w.title}</span>
                {w.id === 'events' && <EventsBadge />}
              </button>
            );
          })}
        </div>
      ))}
      <div className="nav-foot">
        <div className="nav-note">
          Demonstration release. All operational data is simulated; no equipment, cameras or vehicles are connected.
        </div>
        <button className="nav-item" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
          {collapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
          <span>Collapse</span>
        </button>
      </div>
    </nav>
  );
}

/** Demo-mode indicator, simulated plant clock and clock controls. */
function DemoControls() {
  const running = useSim((s) => s.running);
  const speed = useSim((s) => s.speed);
  const play = useSim((s) => s.play);
  const pause = useSim((s) => s.pause);
  const setSpeed = useSim((s) => s.setSpeed);
  const resetting = useSim((s) => s.resetting);
  const minute = useSimValue((s) => s.minute);
  const shift = shiftAt(minute);
  return (
    <div className="demo" role="group" aria-label="Simulation clock">
      <span className="demo-flag" title="Demo mode: every value in this product is generated by the simulation engine">
        <FlaskConical size={14} />
        Demo<span className="demo-long"> · simulated data</span>
      </span>
      {resetting ? (
        <span className="demo-resetting" role="status" title="Rebuilding the seeded demo state in the background; the clock resumes when it is ready">
          <LoaderCircle className="spin" size={13} aria-hidden />
          Resetting demo…
        </span>
      ) : (
        <span className="demo-clock" title="Simulated plant time">
          <small>
            {formatDay(minute)} · Shift {shift.id}
          </small>
          {formatClock(minute)}
        </span>
      )}
      <button className="btn ghost sm icon" onClick={running ? pause : play} disabled={resetting} title={running ? 'Pause simulation' : 'Run simulation'}>
        {running ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <select className="select" style={{ height: 26, border: 0, background: 'none', paddingRight: 22 }} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Simulation speed">
        {SPEEDS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PeriodSelect() {
  const period = useApp((s) => s.period);
  const setPeriod = useApp((s) => s.setPeriod);
  return (
    <select className="select" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} aria-label="Reporting period">
      {(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => (
        <option key={k} value={k}>
          {PERIOD_LABELS[k]}
        </option>
      ))}
    </select>
  );
}

export function Header({ title, period = false, actions }: { title: string; period?: boolean; actions?: ReactNode }) {
  const setScenariosOpen = useApp((s) => s.setScenariosOpen);
  const active = useSimValue((s) => scenariosActive(s).length);
  return (
    <header className="header">
      <h1>{title}</h1>
      <span className="sep" />
      <span className="facility" title={FACTORY.reference}>
        <Building2 size={14} />
        {FACTORY.name}
      </span>
      {period && (
        <>
          <span className="sep" />
          <PeriodSelect />
        </>
      )}
      <div className="spacer" />
      {actions}
      <button className="btn" onClick={() => useApp.getState().openCopilot()} title="Open the Factory Copilot (rule-based on the current demo state — no language model)">
        <MessageSquareText size={14} />
        <span className="btn-label">Copilot</span>
      </button>
      <button className={`btn ${active ? 'on' : ''}`} onClick={() => setScenariosOpen(true)} title="Simulated scenarios">
        <SlidersHorizontal size={14} />
        <span className="btn-label">Scenarios</span>
        {active ? <span className="num">{active}</span> : null}
      </button>
      <DemoControls />
    </header>
  );
}

/** Presentation mode hides navigation and header for every workspace. */
export const usePresenting = () => useTwin((s) => s.uiHidden);
