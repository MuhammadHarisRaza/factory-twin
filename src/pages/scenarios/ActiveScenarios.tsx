import { Activity, FastForward, X } from 'lucide-react';
import { SCENARIO_KIND_LABELS } from '../../model/plant';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { EmptyState } from '../../ui/kit/Page';
import { isClearable, outcomeOf, scenarioStatus, when } from './catalogue';

/**
 * What is in effect now — only scenarios still active (a fault that broke down or was removed is
 * over) — with what each has done so far, Clear / Clear all, and Skip to let the simulation run
 * ahead (the clock jumps; nothing else changes).
 */
export function ActiveScenarios() {
  const clear = useSim((s) => s.clear);
  const resetting = useSim((s) => s.resetting);
  const d = useSimValue((s) => ({
    now: s.minute,
    running: s.scenarios
      .map((sc) => ({ sc, st: scenarioStatus(s, sc), clearable: isClearable(s, sc), outcome: outcomeOf(s, sc) }))
      .filter(({ st }) => st.key === 'active')
      .reverse(),
  }));
  const clearable = d.running.filter((r) => r.clearable);
  const skip = (min: number) => useSim.getState().skip(min);
  return (
    <div className="scna">
      <div className="scna-h">
        <Activity size={14} aria-hidden />
        <b>{d.running.length ? `${d.running.length} scenario${d.running.length === 1 ? '' : 's'} in effect` : 'No scenario in effect'}</b>
        <span className="muted num">plant time {formatClock(d.now)}</span>
        <span className="spacer" />
        <button type="button" className="btn sm" disabled={resetting} onClick={() => skip(15)} title="Simulate the next 15 minutes at once (the clock jumps; nothing else changes)">
          <FastForward size={13} aria-hidden />
          Skip 15 min
        </button>
        <button type="button" className="btn sm" disabled={resetting} onClick={() => skip(60)} title="Simulate the next hour at once">
          <FastForward size={13} aria-hidden />
          Skip 1 h
        </button>
        {clearable.length > 1 && (
          <button type="button" className="btn sm" disabled={resetting} onClick={() => clearable.forEach(({ sc }) => clear(sc.id))} title="End every running scenario now (condition-based maintenance is left to complete)">
            <X size={13} aria-hidden />
            Clear all ({clearable.length})
          </button>
        )}
      </div>
      {d.running.length === 0 ? (
        <EmptyState title="Nothing injected right now">The plant runs on the seeded simulation. Start a guided demo or a scenario from the catalogue.</EmptyState>
      ) : (
        <ul className="scnp-inst scna-list" aria-label="Running scenarios">
          {d.running.map(({ sc, st, clearable: canClear, outcome }) => (
            <li key={sc.id}>
              <span className="scnp-inst-l" title={`${SCENARIO_KIND_LABELS[sc.kind]} · ${sc.label}`}>
                {sc.label}
                {outcome && <span className="scna-o"> · {outcome}</span>}
              </span>
              <span className="scnp-inst-m">since {when(sc.start, d.now)}</span>
              {canClear ? (
                <button type="button" className="btn sm" onClick={() => clear(sc.id)} title="End this scenario now; its effects stop from the current minute">
                  <X size={13} aria-hidden />
                  Clear
                </button>
              ) : (
                <span className="scnp-inst-m">{st.note ?? `until ${formatClock(sc.end ?? d.now)}`}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
