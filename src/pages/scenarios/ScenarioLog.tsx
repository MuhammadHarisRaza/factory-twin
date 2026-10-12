import { ClipboardList, X } from 'lucide-react';
import { SCENARIO_KIND_LABELS } from '../../model/plant';
import type { OpEvent, ScenarioActivation } from '../../model/types';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock, formatDuration } from '../../sim/time';
import { EmptyState } from '../../ui/kit/Page';
import {
  ONE_OFF_KINDS,
  isClearable,
  outcomeOf,
  paramSummary,
  scenarioDuration,
  scenarioEvents,
  scenarioFocus,
  scenarioStatus,
  when,
  type ScenarioStatus,
  type ShowTarget,
} from './catalogue';
import { ORIGIN_LABEL, originOf, showTarget } from './actions';
import { ScenarioState, ShowButton, targetLabel } from './ui';

type Row = {
  sc: ScenarioActivation;
  st: ScenarioStatus;
  params: string;
  outcome: string | null;
  duration: number | null;
  origin: string;
  target: { t: ShowTarget; label: string } | null;
  /** Operational events the scenario produced (same records as Events & Reports). */
  events: OpEvent[];
  clearable: boolean;
};

/**
 * Every scenario activated since the last reset, newest first: what it was, its parameters, its
 * lifecycle, what it has done (from records), the events it produced, where its effect shows, and
 * Clear while it is still in effect. A compact list (the panel is a drawer, not a page).
 */
export function ScenarioLog({ onNavigate }: { onNavigate?: () => void }) {
  const resets = useSim((s) => s.resets);
  const clear = useSim((s) => s.clear);
  const d = useSimValue(
    (s) => {
      const rows: Row[] = s.scenarios.map((sc) => {
        const t = scenarioFocus(s, sc);
        const o = originOf(resets, sc.id);
        return {
          sc,
          st: scenarioStatus(s, sc),
          params: paramSummary(sc),
          outcome: outcomeOf(s, sc),
          duration: scenarioDuration(s, sc),
          origin: o ? ORIGIN_LABEL[o] : 'Another workspace',
          target: t ? { t, label: targetLabel(t, s) } : null,
          events: scenarioEvents(s, sc),
          clearable: isClearable(s, sc),
        };
      });
      // Newest first; equal start minutes keep activation order under the stable sort.
      return { now: s.minute, rows: rows.reverse().sort((a, b) => b.sc.start - a.sc.start) };
    },
    [resets],
  );
  const now = d.now;
  if (!d.rows.length) return <EmptyState title="No scenario yet">Activate one in the catalogue, set up a guided demo, or follow the presenter guide.</EmptyState>;
  return (
    <ul className="scnl" aria-label="Scenario log">
      {d.rows.map((r) => {
        const main = r.events.find((e) => !e.consequenceOf) ?? r.events[0];
        return (
          <li key={r.sc.id} className={r.st.key === 'active' ? 'on' : ''}>
            <div className="scnl-top">
              <span className="mono dim">{r.sc.id}</span>
              <b>{SCENARIO_KIND_LABELS[r.sc.kind]}</b>
              <ScenarioState st={r.st} now={now} time={false} />
              <span className="spacer" />
              <span className="scnl-t num">
                {when(r.sc.start, now)}
                {ONE_OFF_KINDS.includes(r.sc.kind)
                  ? ' · one-off'
                  : r.sc.end == null
                    ? r.st.key === 'active'
                      ? ' · until cleared'
                      : ''
                    : r.sc.end > now
                      ? ` → ${formatClock(r.sc.end)}`
                      : ` → ${when(r.sc.end, now)}`}
                {r.duration != null ? ` · ${formatDuration(r.duration)}` : ''}
              </span>
            </div>
            <div className="scnl-p" title={r.params}>
              {r.params}
            </div>
            <div className="scnl-o">
              <span>
                Outcome: <span className="scnl-v">{r.outcome ?? 'see Impact vs baseline'}</span>
              </span>
              <span className="muted">Source: {r.origin}</span>
            </div>
            <div className="scnl-a">
              {main ? (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    onNavigate?.();
                    showTarget({ type: 'event', id: main.id });
                  }}
                  title={`Open the report of ${main.id}: ${main.title}`}
                >
                  <ClipboardList size={13} aria-hidden />
                  {main.id}
                  {r.events.length > 1 && <span className="muted"> +{r.events.length - 1}</span>}
                </button>
              ) : (
                <span className="muted scnl-none">No event yet</span>
              )}
              {r.target && <ShowButton target={r.target.t} label={r.target.label} onNavigate={onNavigate} />}
              <span className="spacer" />
              {r.clearable && (
                <button type="button" className="btn sm" onClick={() => clear(r.sc.id)} title="End this scenario now; its effects stop from the current minute">
                  <X size={13} aria-hidden />
                  Clear
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
