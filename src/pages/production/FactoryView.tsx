import { useState } from 'react';
import { ArrowRight, MessageSquareText } from 'lucide-react';
import { openEvent, useApp } from '../../app/store';
import { M2_PER_TILE, TARGET } from '../../model/plant';
import { scenariosActive } from '../../sim/engine';
import { TARGET_STATUS_LABEL, bottleneck, resolvePeriod, targetStatus, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { RankedBars } from '../../ui/kit/charts';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { MetricText } from '../../ui/kit/Status';
import { CapacityWaterfall, WATERFALL_LEGEND } from './CapacityWaterfall';
import { EstTag, Kpi, Verdict, m2, type Level, type Tone } from './common';
import { shiftProjection } from './derive';
import { FinancePanel } from './FinancePanel';
import { BaselinePanel, ImprovementPanel } from './Improvements';
import {
  capacitySteps,
  contributionParts,
  equipmentContribution,
  fmtMoney,
  investigate,
  lossLedger,
  withPeriod,
  type Answer,
  type CapacityStep,
  type Contribution,
  type InvestigationLink,
  type LossLedger,
  type LossRow,
} from './loss';

type Nav = { onLevel: (l: Level) => void; onAsset: (id: string) => void };

/** Factory level: output vs plan and capacity, losses and their estimated value, why, and what to do. */
export function FactoryView({ periodKey, onLevel, onAsset }: { periodKey: PeriodKey } & Nav) {
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const [comparing, setComparing] = useState(false);
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const L = lossLedger(s, p, finance, tariffs);
      const contributions = equipmentContribution(s, p, L);
      const bn = bottleneck(s);
      return {
        p,
        L,
        contributions,
        answers: investigate(L, contributions, bn, finance),
        steps: capacitySteps(L),
        proj: periodKey === 'shift' ? shiftProjection(s, L.lm.output) : null,
        scenarioCount: s.scenarios.length,
        activeScenarios: scenariosActive(s).length,
      };
    },
    [periodKey, finance, tariffs],
  );
  const showBaseline = comparing && d.scenarioCount > 0;
  return (
    <>
      <FactorySummary L={d.L} proj={d.proj} />
      <Investigation answers={d.answers} periodKey={periodKey} periodLabel={d.p.label} onLevel={onLevel} onAsset={onAsset} />
      <CapacityPanel L={d.L} steps={d.steps} />
      <LossCostPanel L={d.L} />
      <ContributionPanel contributions={d.contributions} total={d.L.outputLossM2} onAsset={onAsset} />
      <FinancePanel className="col-4" />
      <ImprovementPanel className="col-8" L={d.L} scenarioCount={d.scenarioCount} activeScenarios={d.activeScenarios} comparing={showBaseline} onCompare={setComparing} />
      {showBaseline && <BaselinePanel className="col-12" periodKey={periodKey} />}
    </>
  );
}

// ── Summary band ─────────────────────────────────────────────────────────────

function FactorySummary({ L, proj }: { L: LossLedger; proj: ReturnType<typeof shiftProjection> }) {
  const cur = useApp((s) => s.finance.currency);
  const lm = L.lm;
  const att = lm.attainment;
  const status = targetStatus(att);
  const tone: Tone = status === 'none' ? 'neutral' : status === 'ahead' || status === 'on-track' ? 'good' : status === 'behind' ? 'warning' : 'critical';
  const scale = Math.max(1.25, (att ?? 0) * 1.05);
  const oee = lm.oee.oee;
  const oeeDelta = oee.status === 'ok' ? (oee.value! - TARGET.oeeTarget) * 100 : null;
  return (
    <section className="summary prod-kpis prod-kpis-6" aria-label="Factory summary">
      <div className="prod-kpi-head">
        <div className="kpi-label">Good-tile output · {L.period.label}</div>
        <Verdict tone={tone}>
          {status === 'none'
            ? 'No production time in this period yet'
            : L.planGapM2 > 0.5
              ? `${TARGET_STATUS_LABEL[status]} · ${fmtInt(L.planGapM2)} m² short of plan`
              : `${TARGET_STATUS_LABEL[status]} · ${fmtInt(-L.planGapM2)} m² ahead of plan`}
        </Verdict>
        <div className="kpi-value">
          {fmtInt(L.goodM2)}
          <small>/ {fmtInt(L.plannedM2)} m² plan</small>
        </div>
        <div className="meter" title={`Attainment ${fmtPct(att)} — tick marks the plan`}>
          <i style={{ width: `${Math.min(100, ((att ?? 0) / scale) * 100)}%` }} />
          <b style={{ left: `calc(${(1 / scale) * 100}% - 1px)` }} />
        </div>
        <div className="kpi-sub">
          {proj ? (
            <span title="Shift-to-date average rate extrapolated to the end of the shift">
              Projected at {formatClock(proj.endsAt)}: <b className="prod-strong">{fmtInt(proj.projectedM2)} m²</b> ({fmtPct(proj.attainment, 0)} of plan)
            </span>
          ) : (
            <span>First-quality tiles accepted at sorting · {fmtInt(L.goodM2 / M2_PER_TILE)} tiles</span>
          )}
        </div>
      </div>
      <Kpi
        label="Target attainment"
        title="Good output ÷ plan (target rate × time). On track ≥ 97 %, behind ≥ 90 %, below that well behind — the one rule used everywhere."
        value={fmtPct(att, 1)}
        lines={[<span key="s">{TARGET_STATUS_LABEL[status]}</span>, <span key="p">Plan {fmtInt(TARGET.goodPerHour * M2_PER_TILE)} m²/h</span>]}
      />
      <Kpi
        label="Capacity utilisation"
        title="Good output ÷ theoretical capacity (kiln design rate × calendar time)"
        value={fmtPct(L.utilisation, 1)}
        lines={[<span key="t">of {m2(L.theoreticalM2)} theoretical</span>, <span key="p">Plan = {fmtPct(L.theoreticalM2 > 0 ? L.plannedM2 / L.theoreticalM2 : null, 0)} of it</span>]}
      />
      <Kpi
        label="Quality yield"
        title="First-pass yield: tiles accepted first time ÷ tiles sorted (gauge + vision)"
        value={fmtPct(L.fpy, 1)}
        lines={[<span key="r">{fmtInt(lm.rejected)} of {fmtInt(lm.inspected)} rejected</span>]}
      />
      <Kpi
        label="Factory OEE"
        title="This plant has one line, so factory OEE is the line OEE: availability and performance at the line constraint (kiln) × first-pass quality at sorting. It is not an average of machine OEEs."
        value={<MetricText m={oee} />}
        lines={[
          <span key="d">
            = line OEE (one line)
            {oeeDelta != null && <span className={oeeDelta < 0 ? 'prod-under' : ''}> · {oeeDelta < 0 ? '−' : '+'}{fmt1(Math.abs(oeeDelta))} pts vs {fmtPct(TARGET.oeeTarget, 0)}</span>}
          </span>,
          <span key="n">Not an average of machine OEEs</span>,
        ]}
      />
      <Kpi
        label="Production loss"
        title="Good output short of plan. Below: unplanned losses at the line constraint against its design rate (downtime, held up, speed, rejects), each counted once."
        value={L.planGapM2 > 0.5 ? m2(L.planGapM2) : 'None'}
        lines={[<span key="s">{L.planGapM2 > 0.5 ? 'short of plan' : `${m2(-L.planGapM2)} ahead of plan`}</span>, <span key="u">{m2(L.outputLossM2)} unplanned losses at the kiln</span>]}
      />
      <Kpi
        label="Est. financial impact"
        title={L.impact.lines.map((l) => `${l.label}: ${fmtMoney(l.amount, cur)} — ${l.basis}`).join('\n')}
        value={fmtMoney(L.impact.total, cur)}
        lines={[<EstTag key="e" />, <span key="b">Shortfall + rejects + energy + detention</span>]}
      />
    </section>
  );
}

// ── Loss investigation (answer-first) ────────────────────────────────────────

function Investigation({ answers, periodKey, periodLabel, onLevel, onAsset }: { answers: Answer[]; periodKey: PeriodKey; periodLabel: string } & Nav) {
  const openCopilot = useApp((s) => s.openCopilot);
  const follow = (l: InvestigationLink) => (l.kind === 'equipment' ? onAsset(l.id) : l.kind === 'level' ? onLevel(l.id) : openEvent(l.id));
  return (
    <Panel
      className="col-12"
      title="Loss investigation"
      subtitle={`${periodLabel} · answers computed from the simulated records with fixed rules`}
      footer={<span>“Ask the copilot” opens the rule-based copilot (no language model) with the same question for the same period; it reads the same records and assumptions.</span>}
    >
      <div className="prod-inv">
        {answers.map((a) => (
          <article key={a.key} className="prod-inv-q">
            <div className="kpi-label">{a.question}</div>
            <Verdict tone={a.tone}>{a.headline}</Verdict>
            {a.detail.length > 0 && (
              <ul>
                {a.detail.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            <div className="prod-inv-actions">
              {a.links.map((l) => (
                <button key={`${l.kind}-${l.id}`} className="row-link" onClick={() => follow(l)}>
                  {l.label} <ArrowRight size={11} aria-hidden />
                </button>
              ))}
              <div className="spacer" />
              <button className="btn sm ghost" onClick={() => openCopilot(withPeriod(a.copilot, periodKey))} title={`Ask the rule-based copilot: “${withPeriod(a.copilot, periodKey)}”`}>
                <MessageSquareText size={12} aria-hidden /> Ask the copilot
              </button>
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}

// ── Capacity: theoretical vs plan vs actual vs good ──────────────────────────

function CapacityPanel({ L, steps }: { L: LossLedger; steps: CapacityStep[] }) {
  const [sel, setSel] = useState<string | null>(null);
  return (
    <>
      <Panel
        className="col-7"
        title="Theoretical capacity vs plan vs actual vs good"
        subtitle={`${L.period.label} · m² at the line constraint (kiln) · hover or select a bar for its basis`}
        footer={
          <span>
            The capacity gap ({m2(L.capacityGapM2)}) is theoretical − good. Theoretical capacity is a ceiling, not revenue: the plan already allows {m2(L.allowanceM2)} for normal
            losses, and only the shortfall to plan enters the financial impact.
          </span>
        }
      >
        <div className="chart-legend">
          {WATERFALL_LEGEND.map((l) => (
            <span key={l.key}>
              <i style={{ background: l.swatch }} />
              {l.label}
            </span>
          ))}
          <span>
            <i className="dash" />
            Plan
          </span>
          <span>
            <i className="prod-gap-swatch" />
            Capacity gap
          </span>
        </div>
        {L.calendarMin > 0 ? (
          <CapacityWaterfall steps={steps} plan={L.plannedM2} selectedKey={sel} onSelect={setSel} />
        ) : (
          <div className="empty">
            <b>No production time in this period yet</b>
          </div>
        )}
      </Panel>
      <Panel className="col-5" title="Basis of every bar" subtitle="Values, measurement points and assumptions" flush>
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="table prod-basis-table">
            <thead>
              <tr>
                <th>Bar</th>
                <th className="n">m²</th>
                <th className="n" title="Share of theoretical capacity">Share</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.key} className={`clickable ${sel === s.key ? 'sel' : ''}`} onClick={() => setSel(sel === s.key ? null : s.key)}>
                  <td className={s.kind === 'total' ? 'prod-strong' : ''}>{s.label.replace('\n', ' ')}</td>
                  <td className="n">{s.kind === 'loss' || s.kind === 'neutral' ? `${s.value >= 0 ? '−' : '+'}${fmtInt(Math.abs(s.value))}` : fmtInt(s.value)}</td>
                  <td className="n muted">{L.theoreticalM2 > 0 ? fmtPct(s.value / L.theoreticalM2, 1) : '—'}</td>
                  <td className="wrap prod-basis">{s.basis}</td>
                </tr>
              ))}
              <tr>
                <td>Plan (reference)</td>
                <td className="n">{fmtInt(L.plannedM2)}</td>
                <td className="n muted">{L.theoreticalM2 > 0 ? fmtPct(L.plannedM2 / L.theoreticalM2, 1) : '—'}</td>
                <td className="wrap prod-basis">{L.assumptions[1]}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="prod-notes">
          <h3 className="prod-h3">Assumptions</h3>
          <ul>
            {L.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <h3 className="prod-h3">Missing data (not connected)</h3>
          <ul>
            {L.missing.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </Panel>
    </>
  );
}

// ── Loss & cost intelligence ─────────────────────────────────────────────────

function LossRowView({ r, cur }: { r: LossRow; cur: string }) {
  return (
    <tr>
      <td>{r.label}</td>
      <td className="n">{r.m2 == null ? <span className="muted">—</span> : fmtInt(r.m2)}</td>
      <td className="n">{r.minutes == null ? <span className="muted">—</span> : fmtInt(r.minutes)}</td>
      <td className="n">{r.money == null ? <span className="muted">Not valued</span> : fmtMoney(r.money, cur)}</td>
      <td className="wrap prod-basis">
        {r.basis}
        <span className="muted"> · {r.valuation}</span>
      </td>
    </tr>
  );
}

function LossCostPanel({ L }: { L: LossLedger }) {
  const cur = useApp((s) => s.finance.currency);
  const output = L.rows.filter((r) => r.kind === 'output');
  const other = L.rows.filter((r) => r.kind === 'other');
  const costs = L.rows.filter((r) => r.kind === 'cost');
  const costTotal = costs.reduce((a, r) => a + (r.money ?? 0), 0);
  return (
    <Panel
      className="col-8"
      title="Loss & cost intelligence"
      subtitle={`${L.period.label} · each loss in m² at the line constraint and its estimated value`}
      actions={<EstTag />}
      footer={
        <div className="prod-foot">
          <span>
            <b className="prod-strong">Valued once.</b> Every lost tile is counted at the kiln: a stop elsewhere costs line output only for the minutes it held the kiln up — the event
            engine charges those minutes to the root asset (see Equipment contribution), so machine losses are never added on top. Lost kiln tiles are converted to good tiles with
            the period's first-pass yield ({fmtPct(L.fpyUsed, 1)}) before they are valued, so rejects are not valued twice. Energy and truck detention are costs, not output.
          </span>
          <span>
            Category values are what each loss would be worth if removed, against the design rate — not lost revenue, because the plan already allows{' '}
            {fmtPct(L.theoreticalM2 > 0 ? L.allowanceM2 / L.theoreticalM2 : null, 0)} of design capacity for normal losses. The financial impact against the plan values only the
            shortfall to plan plus direct costs.
          </span>
        </div>
      }
      flush
    >
      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table className="table prod-loss-table">
          <thead>
            <tr>
              <th>Loss category</th>
              <th className="n" title="m² of tile at the line constraint">m²</th>
              <th className="n" title="Kiln minutes (truck minutes for logistics)">Min</th>
              <th className="n">Est. value</th>
              <th>How it is measured · how it is valued</th>
            </tr>
          </thead>
          <tbody>
            {output.map((r) => (
              <LossRowView key={r.key} r={r} cur={cur} />
            ))}
            <tr className="prod-subtotal">
              <td>Unplanned losses at the kiln</td>
              <td className="n">{fmtInt(L.outputLossM2)}</td>
              <td className="n" />
              <td className="n">{fmtMoney(L.outputMoney, cur)}</td>
              <td className="wrap prod-basis">vs the design rate · {fmtPct(L.theoreticalM2 > 0 ? L.outputLossM2 / L.theoreticalM2 : null, 1)} of theoretical capacity</td>
            </tr>
            {costs.map((r) => (
              <LossRowView key={r.key} r={r} cur={cur} />
            ))}
            <tr className="prod-subtotal">
              <td>Direct costs</td>
              <td className="n" />
              <td className="n" />
              <td className="n">{fmtMoney(costTotal, cur)}</td>
              <td className="wrap prod-basis">Energy above the model + truck detention</td>
            </tr>
            {other.map((r) => (
              <LossRowView key={r.key} r={r} cur={cur} />
            ))}
            <tr className="prod-subtotal">
              <td>Financial impact against the plan</td>
              <td className="n">{L.impact.shortfallM2 > 0.5 ? fmtInt(L.impact.shortfallM2) : '0'}</td>
              <td className="n" />
              <td className="n">{fmtMoney(L.impact.total, cur)}</td>
              <td className="wrap prod-basis">The summary figure: shortfall of good output vs plan + the direct costs of the period</td>
            </tr>
            {L.impact.lines.map((l) => (
              <tr key={l.label}>
                <td className="prod-indent">{l.label}</td>
                <td className="n" />
                <td className="n" />
                <td className="n">{fmtMoney(l.amount, cur)}</td>
                <td className="wrap prod-basis">{l.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ── Equipment contribution to the capacity gap ───────────────────────────────

function ContributionPanel({ contributions, total, onAsset }: { contributions: Contribution[]; total: number; onAsset: (id: string) => void }) {
  const top = contributions.slice(0, 10);
  return (
    <Panel
      className="col-4"
      title="Equipment contribution"
      subtitle={`Unplanned losses at the kiln by causing asset · ${m2(total)} · click to drill down`}
      footer={
        <span>
          The kiln carries its own downtime and speed loss; the root asset of each held-up kiln minute (from event records) carries that minute; rejects go to the defect’s origin
          stage. The parts add up to the line loss.
        </span>
      }
    >
      {top.length ? (
        <RankedBars
          labelHeader="Asset"
          valueHeader="m²"
          showCumulative={false}
          rows={top.map((c) => ({
            key: c.key,
            label: (
              <span title={contributionParts(c)}>
                {c.equipmentId ? <span className="mono">{c.equipmentId}</span> : null} <span className="dim">{c.label}</span>
              </span>
            ),
            value: c.m2,
            share: total > 0 ? c.m2 / total : 0,
          }))}
          format={fmtInt}
          onSelect={(r) => {
            const c = contributions.find((x) => x.key === r.key);
            if (c?.equipmentId) onAsset(c.equipmentId);
          }}
        />
      ) : (
        <div className="empty">
          <b>No unplanned losses at the kiln</b>
          Nothing held the constraint back in this period
        </div>
      )}
    </Panel>
  );
}
