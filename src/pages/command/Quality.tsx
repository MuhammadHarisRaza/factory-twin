/**
 * Quality exceptions: the quality events (open and of the last 8 h — the same records as AI
 * Defect Monitoring and Events & Reports), the reject rate vs its reference, the rising defect
 * categories and the affected batch.
 */
import { ArrowRight, CircleCheck, Minus, TrendingDown, TrendingUp, TriangleAlert } from 'lucide-react';
import { useApp } from '../../app/store';
import { DEFECTS, STAGE_BY_ID } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { StatusBadge } from '../../ui/kit/Status';
import { RISING_RATIO, qualityExceptions } from './derive';

const ROWS = 3;
const EVENTS = 4;

function Change({ ratio }: { ratio: number | null }) {
  if (ratio == null) return <span className="muted">—</span>;
  if (ratio > RISING_RATIO) return <StatusBadge tone="warning" icon={TrendingUp} label={`${ratio.toFixed(1)}×`} />;
  if (ratio < 1 / RISING_RATIO) return <StatusBadge tone="good" icon={TrendingDown} label={`${ratio.toFixed(1)}×`} />;
  return <StatusBadge tone="neutral" icon={Minus} label={`${ratio.toFixed(1)}×`} />;
}

export function QualityExceptions() {
  const go = useApp((s) => s.go);
  const q = useSimValue((s) => qualityExceptions(s));
  const rows = q.rows.slice(0, ROWS);
  const open = () => go('quality');
  const verdict = q.openEvents
    ? `${q.openEvents} open quality ${q.openEvents === 1 ? 'event' : 'events'}`
    : q.rising.length
      ? `${q.rising.length} rising ${q.rising.length === 1 ? 'category' : 'categories'}`
      : q.ratio != null && q.ratio >= 1.35
        ? `${q.ratio.toFixed(1)}× reference`
        : null;
  return (
    <Panel
      title="Quality exceptions"
      subtitle={`Quality events (open and last 8 h) · reject rate since ${formatClock(q.from)} vs the 24 h before`}
      actions={
        <button type="button" className="btn ghost sm" onClick={open} title="Open AI Defect Monitoring">
          Defects
          <ArrowRight size={12} aria-hidden />
        </button>
      }
      footer={<span>Inspection frames are illustrative — simulated classification and confidence, no vision model runs.</span>}
      flush
    >
      <div className="cc-q-head">
        <div>
          <span className="kpi-label">Reject rate at sorting</span>
          <span className="cc-q-rate">
            {fmtPct(q.rate)}
            <small>vs {fmtPct(q.refRate)} reference</small>
          </span>
          <span className="muted">
            {fmtInt(q.rejected)} of {fmtInt(q.inspected)} tiles rejected
          </span>
        </div>
        <div className="cc-q-verdict">
          {verdict ? <StatusBadge tone="warning" icon={TriangleAlert} label={verdict} /> : <StatusBadge tone="good" icon={CircleCheck} label="Within reference" />}
          <span className="cc-q-batch" title="Tiles reaching sorting now were pressed about 3 h earlier">
            Affected batch <span className="mono">{q.batch.id}</span>
            {q.product && <span className="dim"> · {q.product.name}</span>}
          </span>
        </div>
      </div>
      <div className="cc-q-events">
        <EventList events={q.events} limit={EVENTS} empty="No quality event open or detected in the last 8 h" />
        {q.events.length > EVENTS && <p className="cc-more">+{q.events.length - EVENTS} more in AI Defect Monitoring</p>}
      </div>
      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Defect</th>
              <th>Origin</th>
              <th className="n">Last ≈ 2 h</th>
              <th className="n">Reference</th>
              <th className="n">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.defect} className="clickable" onClick={open} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()} title="Open AI Defect Monitoring">
                <td>{r.label}</td>
                <td className="dim">{STAGE_BY_ID[DEFECTS[r.defect].origin].name}</td>
                <td className="n">{fmtPct(r.rateRecent, 2)}</td>
                <td className="n">{fmtPct(r.rateRef, 2)}</td>
                <td className="n">
                  <Change ratio={r.ratio} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
