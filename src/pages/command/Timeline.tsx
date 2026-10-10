/**
 * Event timeline of the last 4 h from the operational events (condition started / cleared and,
 * optionally, the lifecycle steps people took) plus the scenario inputs. An event entry opens its
 * report; a scenario entry locates its target.
 */
import { useState } from 'react';
import { CircleCheck, CircleStop, Eye, FlaskConical, Info, OctagonX, Search, TriangleAlert, type LucideIcon } from 'lucide-react';
import { openEvent } from '../../app/store';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime } from '../../sim/time';
import { Empty, Panel } from '../../ui/kit/Panel';
import type { Tone } from '../../ui/kit/Status';
import { TIMELINE_WINDOW_MIN, timeline, type TimelineItem } from './derive';
import { locate } from './nav';

const LIMIT = 80;

const SEV: Record<TimelineItem['severity'], { tone: Tone; icon: LucideIcon; label: string }> = {
  critical: { tone: 'critical', icon: OctagonX, label: 'Critical event' },
  serious: { tone: 'serious', icon: TriangleAlert, label: 'Serious event' },
  warning: { tone: 'warning', icon: TriangleAlert, label: 'Warning event' },
  info: { tone: 'neutral', icon: Info, label: 'Info event' },
};

function look(i: TimelineItem): { tone: Tone; icon: LucideIcon; label: string } {
  switch (i.kind) {
    case 'detected':
      return SEV[i.severity];
    case 'cleared':
      return { tone: 'good', icon: CircleCheck, label: 'Condition cleared' };
    case 'acknowledged':
      return { tone: 'neutral', icon: Eye, label: 'Acknowledged' };
    case 'investigating':
      return { tone: 'planned', icon: Search, label: 'Investigating' };
    case 'resolved':
      return { tone: 'good', icon: CircleCheck, label: 'Resolved' };
    case 'scenario-start':
      return { tone: 'neutral', icon: FlaskConical, label: 'Scenario' };
    default:
      return { tone: 'neutral', icon: CircleStop, label: 'Scenario ended' };
  }
}

export function EventTimeline() {
  const [lifecycle, setLifecycle] = useState(true);
  const d = useSimValue((s) => {
    const all = timeline(s, { lifecycle });
    return { items: all.slice(0, LIMIT), total: all.length };
  }, [lifecycle]);
  return (
    <Panel
      title="Event timeline"
      subtitle={`Last ${TIMELINE_WINDOW_MIN / 60} h · operational events and scenario inputs · newest first · ${d.total} entries${d.total > LIMIT ? ` (latest ${LIMIT} shown)` : ''}`}
      actions={
        <label className="cc-check">
          <input type="checkbox" checked={lifecycle} onChange={(e) => setLifecycle(e.target.checked)} />
          Lifecycle steps
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
            const toReport = !!i.eventId;
            return (
              <li key={i.key}>
                <button
                  type="button"
                  className="cc-tl-item"
                  onClick={() => (i.eventId ? openEvent(i.eventId) : locate(i))}
                  title={`${formatDateTime(i.time)} · ${l.label} — ${toReport ? 'open the event report' : 'locate the scenario target'}`}
                >
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
