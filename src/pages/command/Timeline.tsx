/** Merged event stream of the last 4 h as a vertical timeline; an entry locates its subject. */
import { useState } from 'react';
import { CalendarClock, CircleCheck, CirclePlay, CircleStop, FlaskConical, Info, LogIn, LogOut, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime } from '../../sim/time';
import { Empty, Panel } from '../../ui/kit/Panel';
import type { Tone } from '../../ui/kit/Status';
import { timeline, type TimelineItem } from './derive';
import { locate } from './nav';

const LIMIT = 80;

const SEV: Record<TimelineItem['severity'], { tone: Tone; icon: LucideIcon }> = {
  critical: { tone: 'critical', icon: OctagonX },
  serious: { tone: 'serious', icon: TriangleAlert },
  warning: { tone: 'warning', icon: TriangleAlert },
  info: { tone: 'neutral', icon: Info },
};

function look(i: TimelineItem): { tone: Tone; icon: LucideIcon; label: string } {
  switch (i.kind) {
    case 'stop':
      return { tone: SEV[i.severity].tone, icon: OctagonX, label: 'Stoppage' };
    case 'restart':
      return { tone: 'good', icon: CirclePlay, label: 'Restart' };
    case 'planned':
      return { tone: 'planned', icon: CalendarClock, label: 'Planned stop' };
    case 'planned-end':
      return { tone: 'good', icon: CircleCheck, label: 'Planned stop ended' };
    case 'scenario-start':
      return { tone: 'neutral', icon: FlaskConical, label: 'Scenario' };
    case 'scenario-end':
      return { tone: 'neutral', icon: CircleStop, label: 'Scenario ended' };
    case 'gate-in':
      return { tone: 'neutral', icon: LogIn, label: 'Gate entry' };
    case 'gate-out':
      return { tone: 'neutral', icon: LogOut, label: 'Gate exit' };
    default:
      return { ...SEV[i.severity], label: `${i.severity[0].toUpperCase()}${i.severity.slice(1)} alert` };
  }
}

export function EventTimeline() {
  const [gate, setGate] = useState(false);
  const d = useSimValue((s) => {
    const all = timeline(s, { gate });
    return { items: all.slice(0, LIMIT), total: all.length };
  }, [gate]);
  return (
    <Panel
      title="Event timeline"
      subtitle={`Last 4 h · newest first · ${d.total} events${d.total > LIMIT ? ` (latest ${LIMIT} shown)` : ''}`}
      actions={
        <label className="cc-check">
          <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} />
          Gate events
        </label>
      }
      flush
    >
      {d.items.length === 0 ? (
        <Empty title="No events in the last 4 hours" />
      ) : (
        <ol className="cc-tl">
          {d.items.map((i) => {
            const l = look(i);
            const Icon = l.icon;
            return (
              <li key={i.key}>
                <button type="button" className="cc-tl-item" onClick={() => locate(i)} title={`${formatDateTime(i.time)} · ${l.label} — click to locate`}>
                  <span className="cc-tl-time">{formatClock(i.time)}</span>
                  <span className={`cc-tl-dot status ${l.tone}`} aria-label={l.label}>
                    <Icon size={13} strokeWidth={2.2} aria-hidden />
                  </span>
                  <span className="cc-tl-text">
                    <b>{i.title}</b>
                    <span>{i.detail}</span>
                  </span>
                  {i.source === 'scenario' && <span className="tag scenario">Scenario</span>}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
