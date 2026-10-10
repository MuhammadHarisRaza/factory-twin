/**
 * Top of the Command Center: the four connected use cases (each with its headline figure and a
 * link to its workspace), then the situation strip (open events, equipment, bottleneck, energy).
 * Every cell opens where its figure is explained.
 */
import type { ReactNode } from 'react';
import { ArrowRight, CircleCheck, CircleHelp, Gauge, Info, OctagonX, ScanSearch, TriangleAlert, Truck, Activity, type LucideIcon } from 'lucide-react';
import { openEquipment, useApp, type WorkspaceId } from '../../app/store';
import { assumptionList } from '../../sim/finance';
import { TARGET_STATUS_LABEL, targetStatus } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { fmtInt, fmtPct, pct } from '../../ui/kit/format';
import { MetricText, StatusBadge } from '../../ui/kit/Status';
import { issueText, strip, useCases } from './derive';
import { scrollToPanel } from './nav';

function Cell({ label, title, onClick, children, className = '' }: { label: ReactNode; title: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={`cc-cell ${className}`} onClick={onClick} title={title}>
      <span className="kpi-label">{label}</span>
      {children}
    </button>
  );
}

function UseCaseCell({ n, icon: Icon, title, ws, hint, children }: { n: number; icon: LucideIcon; title: string; ws: WorkspaceId; hint: string; children: ReactNode }) {
  const go = useApp((s) => s.go);
  return (
    <Cell
      className="cc-uc-cell"
      label={
        <span className="cc-uc-l">
          <span className="cc-uc-n" aria-hidden>
            {n}
          </span>
          <Icon size={13} aria-hidden />
          {title}
          <ArrowRight size={12} aria-hidden className="cc-uc-go" />
        </span>
      }
      title={hint}
      onClick={() => go(ws)}
    >
      {children}
    </Cell>
  );
}

/** The four use cases on one shared state: production at every stage, OEE & loss, defects, vehicles. */
export function UseCaseStrip() {
  const finance = useApp((s) => s.finance);
  const u = useSimValue((s) => useCases(s, finance), [finance]);
  const { production: pr, oee, defects: q, vehicles: v } = u;
  const status = targetStatus(oee.attainment);
  const first = pr.issues[0];
  return (
    <section className="cc-uc" aria-label="Use cases">
      <UseCaseCell n={1} icon={Activity} title="Production monitoring" ws="monitoring" hint="Stage input / output, machine and conveyor states, camera feeds and events per stage — open Production Monitoring">
        <span className="cc-v">
          {pr.issues.length}
          <small>
            of {pr.stages} stages with an issue
          </small>
        </span>
        <span className="kpi-sub">
          {first ? (
            <StatusBadge tone={first.state === 'unknown' ? 'neutral' : first.state === 'reduced' ? 'warning' : 'critical'} icon={first.state === 'unknown' ? CircleHelp : first.state === 'reduced' ? Gauge : OctagonX} label={issueText(first)} />
          ) : (
            <StatusBadge tone="good" icon={CircleCheck} label="No stop, stale feed or rate loss" />
          )}
        </span>
        <span className="kpi-sub">
          {pr.issues.length > 1 ? `+${pr.issues.length - 1} more · ` : ''}
          {pr.openEvents} open production / data {pr.openEvents === 1 ? 'event' : 'events'}
        </span>
      </UseCaseCell>

      <UseCaseCell n={2} icon={Gauge} title="OEE & loss" ws="production" hint="Line OEE, theoretical capacity, losses at the constraint and their estimated value this shift — open OEE & Loss Intelligence">
        <span className="cc-v">
          <MetricText m={oee.oee} />
          <small>OEE · target {pct(oee.target)}</small>
        </span>
        <span className="kpi-sub">
          <StatusBadge
            tone={status === 'none' ? 'neutral' : status === 'ahead' || status === 'on-track' ? 'good' : status === 'behind' ? 'warning' : 'critical'}
            icon={status === 'none' ? Info : status === 'ahead' || status === 'on-track' ? CircleCheck : TriangleAlert}
            label={`${TARGET_STATUS_LABEL[status]} · ${fmtPct(oee.attainment, 0)}`}
          />
        </span>
        <span className="kpi-sub" title={[oee.valueBasis, ...assumptionList(finance)].join('\n')}>
          {oee.planGapM2 >= 1 ? `${fmtInt(oee.planGapM2)} m² behind plan · ≈ ${oee.currency} ${fmtInt(oee.value)}` : 'On or ahead of plan'}
          <span className="tag sim">estimate · assumptions shown</span>
        </span>
      </UseCaseCell>

      <UseCaseCell n={3} icon={ScanSearch} title="AI defect monitoring" ws="quality" hint="Inspection workflow, defect evidence and quality events — open AI Defect Monitoring">
        <span className="cc-v">
          {fmtPct(q.rate)}
          <small>rejects · last ≈ 2 h vs {fmtPct(q.refRate)}</small>
        </span>
        <span className="kpi-sub">
          {q.exception ? (
            <StatusBadge tone="warning" icon={TriangleAlert} label={q.openEvents ? `${q.openEvents} open quality ${q.openEvents === 1 ? 'event' : 'events'}` : q.ratio != null && q.ratio >= 1.35 ? `${q.ratio.toFixed(1)}× reference` : 'Rising defect category'} />
          ) : (
            <StatusBadge tone="good" icon={CircleCheck} label="Within reference · no open quality event" />
          )}
        </span>
        <span className="kpi-sub">Simulated classification — no vision model</span>
      </UseCaseCell>

      <UseCaseCell n={4} icon={Truck} title="Vehicle monitoring" ws="fleet" hint="Trucks from gate to exit, docks, forklifts by zone and safety events — open Vehicle Monitoring">
        <span className="cc-v">
          {v.onSite}
          <small>
            {v.onSite === 1 ? 'truck' : 'trucks'} on site · {v.waiting} waiting
          </small>
        </span>
        <span className="kpi-sub">
          {v.openEvents ? (
            <StatusBadge tone="warning" icon={TriangleAlert} label={`${v.openEvents} open vehicle ${v.openEvents === 1 ? 'event' : 'events'}`} />
          ) : (
            <StatusBadge tone="good" icon={CircleCheck} label="No open vehicle event" />
          )}
        </span>
        <span className="kpi-sub">
          {v.atDock} at a dock · simulated positions (zone level)
        </span>
      </UseCaseCell>
    </section>
  );
}

/** Situation strip: open events, equipment needing attention, the bottleneck and energy. */
export function Strip() {
  const tariffs = useApp((s) => s.tariffs);
  const go = useApp((s) => s.go);
  const d = useSimValue((s) => strip(s, tariffs), [tariffs]);
  const { events: ev, attention, bn, energy } = d;
  const sev = ev.bySeverity;

  return (
    <section className="cc-strip" aria-label="Plant situation">
      <Cell label="Open events" title="Operational events not yet resolved — show the list (unacknowledged first)" onClick={() => scrollToPanel('cc-events')}>
        <span className="cc-v">
          {fmtInt(ev.open)}
          <small>{ev.unacknowledged} unacknowledged</small>
        </span>
        <span className="kpi-sub cc-sev">
          <StatusBadge tone="critical" icon={OctagonX} label={`${sev.critical} critical`} />
          <StatusBadge tone="serious" icon={TriangleAlert} label={`${sev.serious} serious`} />
          <StatusBadge tone="warning" icon={TriangleAlert} label={`${sev.warning} warning`} />
          <StatusBadge tone="neutral" icon={Info} label={`${sev.info} info`} />
        </span>
        <span className="kpi-sub">{ev.conditionActive} with the condition still active</span>
      </Cell>

      <Cell label="Equipment attention" title="Machines and conveyors stopped, with stale data or below rate, and assets at health warning or alarm — show the list" onClick={() => scrollToPanel('cc-attention')}>
        <span className="cc-v">
          {attention.total}
          <small>{attention.total === 1 ? 'asset' : 'assets'}</small>
        </span>
        <span className="kpi-sub cc-sev">
          {attention.total === 0 ? (
            <StatusBadge tone="good" icon={CircleCheck} label="All running normally" />
          ) : (
            <>
              {attention.down > 0 && <StatusBadge tone="critical" icon={OctagonX} label={`${attention.down} stopped${attention.conveyorsDown ? ` (${attention.conveyorsDown} conveyor)` : ''}`} />}
              {attention.stale > 0 && <StatusBadge tone="neutral" icon={CircleHelp} label={`${attention.stale} data stale`} />}
              {attention.reduced > 0 && <StatusBadge tone="warning" icon={Gauge} label={`${attention.reduced} below rate`} />}
              {attention.health > 0 && <StatusBadge tone="serious" icon={TriangleAlert} label={`${attention.health} health warning+`} />}
            </>
          )}
        </span>
      </Cell>

      <Cell label="Current bottleneck" title={`Line constraint traced from the kiln · ${bn.label.toLowerCase()} — locate it in the Factory Twin`} onClick={() => openEquipment(bn.machines[0])}>
        <span className="cc-h">{bn.name}</span>
        <span className="kpi-sub">
          Working {pct(bn.workingShare)} · {bn.label.toLowerCase()}
        </span>
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
          {energy.openEvents > 0 ? ` · ${energy.openEvents} open energy ${energy.openEvents === 1 ? 'event' : 'events'}` : ''}
        </span>
        <span className="kpi-sub">Illustrative model and tariffs</span>
      </Cell>
    </section>
  );
}
