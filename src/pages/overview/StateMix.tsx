/**
 * Equipment state now: a compact strip of how many process machines (or conveyors) are running, below rate,
 * starved, blocked, stopped, in fault, in a planned stop, in changeover or unknown (stale data) — icon + words
 * + count, the assets of each state in its tooltip. Production › Plan & flow has the stage-by-stage view.
 */
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { openView } from '../../app/store';
import { useSimValue } from '../../sim/store';
import { Segmented } from '../../ui/kit/Panel';
import { OPERATIONAL_STATE, StatusBadge } from '../../ui/kit/Status';
import { STATE_SCOPE_LABEL, scopeAssets, stateMix, type StateScope } from './states';

const SCOPES: StateScope[] = ['machines', 'conveyors'];

export function StateMix() {
  const [scope, setScope] = useState<StateScope>('machines');
  const d = useSimValue((s) => stateMix(s, scope), [scope]);
  return (
    <div className="ov-states" role="group" aria-label="Equipment state now">
      <div className="ov-states-h">
        <b>Equipment state now</b>
        <span className="muted">
          {d.total} {STATE_SCOPE_LABEL[d.scope].toLowerCase()} · simulated state signals
        </span>
        <Segmented<StateScope>
          label="Which assets are counted"
          value={scope}
          options={SCOPES.map((v) => ({ value: v, label: `${STATE_SCOPE_LABEL[v]} ${scopeAssets(v).length}` }))}
          onChange={setScope}
        />
        <button type="button" className="row-link ov-states-link" onClick={() => openView('production', 'flow')} title="Stage-by-stage state, output and buffers in Production › Plan & flow">
          Plan &amp; flow
          <ArrowRight size={12} aria-hidden />
        </button>
      </div>
      <ul className="ov-states-l">
        {d.buckets.map((b) => {
          const st = OPERATIONAL_STATE[b.state];
          return (
            <li key={b.state} className={b.count ? undefined : 'zero'} title={b.count ? `${st.label}: ${b.assets.map((a) => `${a.name} (${a.id})`).join(', ')}` : `${st.label}: none of the ${d.total} now`}>
              <StatusBadge tone={st.tone} icon={st.icon} label={st.label} />
              <b className="num">{b.count}</b>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
