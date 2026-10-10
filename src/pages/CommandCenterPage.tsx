/**
 * Command Center — connects the twin to operational decisions: the four use cases at a glance
 * (production at every stage, OEE & loss, defects, vehicles), the open operational events and
 * the next actions they call for (acknowledged from here on the shared record), what is stopped,
 * stale or degrading, quality exceptions, rule-based insights, where output is lost, and the
 * copilot docked alongside. Every figure is derived from the one simulation state; nothing here
 * is a language model.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Clock, FlaskConical, MessageSquareText, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useApp } from '../app/store';
import { insights } from '../intel/insights';
import { useSimValue } from '../sim/store';
import { formatClock, formatDay, formatDuration, shiftAt } from '../sim/time';
import { CopilotPanel } from '../ui/copilot/CopilotPanel';
import { useCopilot } from '../ui/copilot/store';
import { AttentionList } from './command/Attention';
import { ActiveEvents, EventActions } from './command/Events';
import { InsightsFeed } from './command/Insights';
import { MachineLosses, ReasonLosses } from './command/Losses';
import { QualityExceptions } from './command/Quality';
import { ShiftCompare } from './command/ShiftCompare';
import { Strip, UseCaseStrip } from './command/Strip';
import { EventTimeline } from './command/Timeline';
import './command.css';

/** Viewport width from which the copilot docks beside the dashboard. */
const DOCK_QUERY = '(min-width: 1280px)';

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Grid slot (span class + optional scroll anchor) holding one panel. */
const Slot = ({ span, id, children }: { span: 4 | 5 | 6 | 7 | 12; id?: string; children: ReactNode }) => (
  <div className={`cc-slot cc-s${span}`} id={id}>
    {children}
  </div>
);

export function CommandCenterPage() {
  const tariffs = useApp((s) => s.tariffs);
  const wide = useMediaQuery(DOCK_QUERY);
  const [dockPref, setDockPref] = useState(true);
  const docked = wide && dockPref;

  const feed = useSimValue((s) => insights(s, { tariffs }), [tariffs]);

  return (
    <div className={`cc ${docked ? 'docked' : ''}`}>
      <div className="cc-main">
        <Context
          docked={docked}
          wide={wide}
          onToggleDock={() => (wide ? setDockPref(!dockPref) : useApp.getState().openCopilot())}
        />
        <UseCaseStrip />
        <Strip />
        <div className="cc-grid">
          <Slot span={7} id="cc-events">
            <ActiveEvents />
          </Slot>
          <Slot span={5}>
            <EventActions />
          </Slot>

          <Slot span={6} id="cc-attention">
            <AttentionList />
          </Slot>
          <Slot span={6}>
            <QualityExceptions />
          </Slot>

          <Slot span={7}>
            <InsightsFeed items={feed} />
          </Slot>
          <Slot span={5}>
            <EventTimeline />
          </Slot>

          <Slot span={4}>
            <ReasonLosses />
          </Slot>
          <Slot span={4}>
            <MachineLosses />
          </Slot>
          <Slot span={4}>
            <ShiftCompare />
          </Slot>
        </div>
      </div>
      {docked && <Dock />}
    </div>
  );
}

function Context({ docked, wide, onToggleDock }: { docked: boolean; wide: boolean; onToggleDock: () => void }) {
  const minute = useSimValue((s) => s.minute);
  const sh = shiftAt(minute);
  return (
    <div className="cc-context">
      <span className="cc-context-t">
        <Clock size={14} aria-hidden />
        Situation at <b className="num">{formatClock(minute)}</b> plant time · {formatDay(minute)} · {sh.label} · {formatDuration(minute - sh.start)} elapsed
      </span>
      <span className="tag sim">
        <FlaskConical size={11} aria-hidden />
        Simulated
      </span>
      <span className="cc-context-n">Insights, actions and copilot answers are rule-based on the current demo state.</span>
      <div className="spacer" />
      <button
        type="button"
        className={`btn ${docked ? 'ghost' : ''}`}
        onClick={onToggleDock}
        title={wide ? (docked ? 'Hide the docked copilot' : 'Dock the copilot beside the dashboard') : 'Open the copilot'}
      >
        {wide ? docked ? <PanelRightClose size={14} aria-hidden /> : <PanelRightOpen size={14} aria-hidden /> : <MessageSquareText size={14} aria-hidden />}
        {wide ? (docked ? 'Hide copilot' : 'Show copilot') : 'Open copilot'}
      </button>
    </div>
  );
}

/** The copilot docked on the right; registers itself so the header Copilot button focuses it. */
function Dock() {
  const register = useCopilot((s) => s.registerDock);
  useEffect(() => register(), [register]);
  return (
    <aside className="cc-dock" aria-label="Copilot">
      <CopilotPanel variant="dock" />
    </aside>
  );
}
