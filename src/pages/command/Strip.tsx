/** Compact situation strip: one cell per operational question, each opening its detail. */
import type { ReactNode } from 'react';
import { CircleCheck, Info, OctagonX, TriangleAlert, Truck } from 'lucide-react';
import { openEquipment, useApp } from '../../app/store';
import { TARGET } from '../../model/plant';
import { TARGET_STATUS_LABEL, targetStatus } from '../../sim/metrics';
import { shiftAt } from '../../sim/time';
import { useSimValue } from '../../sim/store';
import { fmtInt, fmtM2, fmtPct, pct } from '../../ui/kit/format';
import { MetricText, StatusBadge } from '../../ui/kit/Status';
import { strip } from './derive';
import { scrollToPanel } from './nav';

function Cell({ label, title, onClick, children }: { label: ReactNode; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="cc-cell" onClick={onClick} title={title}>
      <span className="kpi-label">{label}</span>
      {children}
    </button>
  );
}

export function Strip() {
  const tariffs = useApp((s) => s.tariffs);
  const go = useApp((s) => s.go);
  const d = useSimValue((s) => strip(s, tariffs), [tariffs]);
  const { lm, alerts, attention, quality: q, bn, energy, fleet } = d;
  const att = lm.attainment;
  const status = targetStatus(att);
  const verdict = {
    tone: status === 'none' ? ('neutral' as const) : status === 'ahead' || status === 'on-track' ? ('good' as const) : status === 'behind' ? ('warning' as const) : ('critical' as const),
    icon: status === 'none' ? Info : status === 'ahead' || status === 'on-track' ? CircleCheck : status === 'behind' ? TriangleAlert : OctagonX,
    label: TARGET_STATUS_LABEL[status],
  };
  const highAlerts = alerts.critical + alerts.serious + alerts.warning;

  return (
    <section className="cc-strip" aria-label="Plant situation">
      <Cell label={`Line status · Shift ${shiftAt(d.period.from).id}`} title={`Output vs target and OEE this shift (OEE target ${pct(TARGET.oeeTarget)}) — open Production & OEE`} onClick={() => go('production')}>
        <span className="cc-v">
          {fmtPct(att, 0)}
          <small>of target</small>
        </span>
        <span className="kpi-sub">
          <StatusBadge {...verdict} />
        </span>
        <span className="kpi-sub">
          <span>
            {fmtM2(lm.output)} / {fmtM2(lm.target)} m²
          </span>
          <span>
            OEE <MetricText m={lm.oee.oee} />
          </span>
        </span>
      </Cell>

      <Cell label="Alerts · last 8 h" title="Alerts raised in the last 8 hours — show the alerts table" onClick={() => scrollToPanel('cc-alerts')}>
        <span className="cc-v">
          {fmtInt(highAlerts)}
          <small>warning or higher</small>
        </span>
        <span className="kpi-sub cc-sev">
          <StatusBadge tone="critical" icon={OctagonX} label={`${alerts.critical} critical`} />
          <StatusBadge tone="serious" icon={TriangleAlert} label={`${alerts.serious} serious`} />
          <StatusBadge tone="warning" icon={TriangleAlert} label={`${alerts.warning} warning`} />
          <StatusBadge tone="neutral" icon={Info} label={`${alerts.info} info`} />
        </span>
      </Cell>

      <Cell label="Equipment attention" title="Machines down or at reduced rate and assets at health warning or alarm — show the list" onClick={() => scrollToPanel('cc-attention')}>
        <span className="cc-v">
          {attention.total}
          <small>{attention.total === 1 ? 'asset' : 'assets'}</small>
        </span>
        <span className="kpi-sub cc-sev">
          {attention.total === 0 ? (
            <StatusBadge tone="good" icon={CircleCheck} label="All running normally" />
          ) : (
            <>
              {attention.down > 0 && <StatusBadge tone="critical" icon={OctagonX} label={`${attention.down} down`} />}
              {attention.reduced > 0 && <StatusBadge tone="warning" icon={TriangleAlert} label={`${attention.reduced} reduced rate`} />}
              {attention.health > 0 && <StatusBadge tone="serious" icon={TriangleAlert} label={`${attention.health} health warning+`} />}
            </>
          )}
        </span>
      </Cell>

      <Cell label="Rejects · last 2 h" title="Reject rate at sorting vs the 24 h reference — open Quality Intelligence" onClick={() => go('quality')}>
        <span className="cc-v">
          {fmtPct(q.rate)}
          <small>vs {fmtPct(q.refRate)} ref.</small>
        </span>
        <span className="kpi-sub">
          {q.exception ? (
            <StatusBadge tone="warning" icon={TriangleAlert} label={q.ratio != null && q.ratio >= 1.35 ? `${q.ratio.toFixed(1)}× reference` : `${q.rising} rising ${q.rising === 1 ? 'defect' : 'defects'}`} />
          ) : (
            <StatusBadge tone="good" icon={CircleCheck} label="Within reference" />
          )}
        </span>
        {q.exception && q.ratio != null && q.ratio >= 1.35 && q.rising > 0 && (
          <span className="kpi-sub">
            {q.rising} rising {q.rising === 1 ? 'defect' : 'defects'}
          </span>
        )}
      </Cell>

      <Cell label="Current bottleneck" title="Active-period constraint over the last 2 h — locate it in the Factory Twin" onClick={() => openEquipment(bn.machines[0])}>
        <span className="cc-h">{bn.name}</span>
        <span className="kpi-sub">Active {pct(bn.activeShare)} · last 2 h</span>
        <span className="kpi-sub">
          {bn.shifted ? <StatusBadge tone="warning" icon={TriangleAlert} label="Shifted from the kiln" /> : <span>Design constraint</span>}
        </span>
      </Cell>

      <Cell label="Energy excess · shift" title="Cost above the energy model this shift (illustrative model and tariffs) — open Energy Intelligence" onClick={() => go('energy')}>
        <span className="cc-v">
          <small className="cc-cur">{tariffs.currency}</small>
          {fmtInt(energy.excessCost)}
        </span>
        <span className="kpi-sub">
          {energy.deviation == null ? '—' : `${energy.deviation >= 0 ? '+' : '−'}${Math.abs(energy.deviation * 100).toFixed(1)} % vs model`}
        </span>
        <span className="kpi-sub">Illustrative tariffs</span>
      </Cell>

      <Cell label="Trucks waiting" title="Outbound trucks queuing for a dock — open Fleet & Logistics" onClick={() => go('fleet')}>
        <span className="cc-v">
          {fleet.waiting}
          <small>
            <Truck size={13} aria-hidden /> {fleet.onSite} on site
          </small>
        </span>
        <span className="kpi-sub">
          {fleet.waiting >= 3 ? (
            <StatusBadge tone={fleet.waiting >= 5 ? 'serious' : 'warning'} icon={TriangleAlert} label="Yard congestion" />
          ) : (
            <StatusBadge tone="good" icon={CircleCheck} label="Docks flowing" />
          )}
        </span>
        <span className="kpi-sub">{fleet.atDock} at a dock</span>
      </Cell>
    </section>
  );
}
