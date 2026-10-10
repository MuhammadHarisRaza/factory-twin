/** Equipment requiring attention: stopped, reduced-rate and health warning / alarm assets. */
import { ArrowRight, CircleCheck, Locate } from 'lucide-react';
import { openEquipment, useApp } from '../../app/store';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDuration } from '../../sim/time';
import { Panel } from '../../ui/kit/Panel';
import { MachineStatus } from '../../ui/kit/Status';
import { HealthBadge } from './badges';
import { attentionCounts, attentionList } from './derive';

export function AttentionList() {
  const go = useApp((s) => s.go);
  const d = useSimValue((s) => ({ rows: attentionList(s), now: s.minute }));
  const c = attentionCounts(d.rows);
  return (
    <Panel
      title="Equipment requiring attention"
      subtitle={c.total ? `${c.down} down · ${c.reduced} reduced rate · ${c.health} health warning or alarm` : 'Machines down or slowed and assets with abnormal condition signals'}
      actions={
        <button type="button" className="btn ghost sm" onClick={() => go('health')} title="Open Machine Health">
          Machine Health
          <ArrowRight size={12} aria-hidden />
        </button>
      }
      footer={<span>Machine health: rule-based detection on simulated signals — no trained model or physical sensors.</span>}
      flush
    >
      {d.rows.length === 0 ? (
        <div className="empty">
          <CircleCheck size={22} aria-hidden />
          <b>All equipment running normally</b>
          No machine is down or slowed and no monitored asset is at health warning or alarm.
        </div>
      ) : (
        <ul className="cc-att">
          {d.rows.map((r) => (
            <li key={r.id}>
              <div className="cc-att-main">
                <div className="cc-att-name">
                  <span className="mono">{r.id}</span>
                  <span className="dim">{r.name}</span>
                  {r.scenario && <span className="tag scenario">Scenario</span>}
                </div>
                <div className="cc-att-reason">{r.reasons.join(' · ')}</div>
                <div className="cc-att-meta">
                  {r.state && <MachineStatus state={r.state} />}
                  {r.health && r.health.level !== 'offline' && <HealthBadge level={r.health.level} score={r.health.score} />}
                  <span className="muted">{r.since != null ? `Since ${formatClock(r.since)} · ${formatDuration(d.now - r.since)}` : 'Since —'}</span>
                </div>
              </div>
              <button type="button" className="btn sm" onClick={() => openEquipment(r.id)} title={`Locate ${r.id} in the Factory Twin`}>
                <Locate size={12} aria-hidden />
                Locate
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
