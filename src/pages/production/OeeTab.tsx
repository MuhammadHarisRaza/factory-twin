/**
 * OEE & losses: line OEE = Availability × Performance × Quality with the plain-language definitions
 * and the actual numbers, the target comparison and scope, interpretation only where the data support
 * it, the integrity checks evaluated from the data (the ten of §10 plus constraint data freshness), the count reconciliation and the three
 * largest OEE losses.
 */
import { ArrowDown, CircleCheck, CircleSlash, Clock, TriangleAlert, type LucideIcon } from 'lucide-react';
import { TARGET } from '../../model/plant';
import { formatClock } from '../../sim/time';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { KpiStatusText, ProvenanceBadge } from '../../ui/kit/Page';
import { MetricText, StatusBadge, type Tone } from '../../ui/kit/Status';
import type { ProductionTab } from '../ProductionPage';
import { Block } from './common';
import type { CheckStatus, IntegrityCheck, reconciliationView } from './integrity';
import { FinanceNote, LossCards } from './LossCards';
import { OEE_DEFINITIONS, type OeeData, type OeeView } from './oee';
import { useProductionUi } from './ui';

const CHECK: Record<CheckStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  pass: { label: 'Pass', tone: 'good', icon: CircleCheck },
  attention: { label: 'Attention', tone: 'warning', icon: TriangleAlert },
  na: { label: 'Not applicable', tone: 'neutral', icon: CircleSlash },
};

/** OEE & losses; `d` is computed once per simulated minute by ProductionPage (oeeData). */
export function OeeTab({ d, onTab }: { d: OeeData; onTab: (t: ProductionTab) => void }) {
  const editAssumptions = () => {
    useProductionUi.getState().setAnalysis('finance');
    onTab('analysis');
  };
  const attention = d.checks.filter((c) => c.status === 'attention').length;
  const passed = d.checks.filter((c) => c.status === 'pass').length;
  return (
    <>
      <OeeSummary v={d.v} periodLabel={d.p.label} />

      <div className="work">
        <Block
          title="Integrity checks"
          subtitle={`The ${d.checks.length} OEE consistency and data checks, evaluated from this period's data · ${passed} pass · ${attention} need attention`}
          actions={
            attention ? <StatusBadge tone="warning" icon={TriangleAlert} label={`${attention} need attention`} /> : <StatusBadge tone="good" icon={CircleCheck} label="All applicable checks pass" />
          }
          note={<span>Nothing is adjusted to make a check pass: a failing check shows the figures that disagree. Tolerance: rounding of counters (0.5 %, half a tile, one minute).</span>}
          flush
        >
          <ChecksList checks={d.checks} />
        </Block>
        <Reconciliation chain={d.chain} periodLabel={d.p.label} />
      </div>

      <Block
        title="Largest OEE losses"
        subtitle={`Minutes of planned kiln time lost per category, largest first · points add up to 100 − OEE · ${d.p.label}`}
        note={<FinanceNote onEdit={editAssumptions} />}
        actions={
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              useProductionUi.getState().setAnalysis('downtime');
              onTab('analysis');
            }}
          >
            Downtime Pareto in Analysis
          </button>
        }
      >
        <LossCards items={d.losses} mode="oee" empty="No OEE loss at the kiln in this period" />
      </Block>
    </>
  );
}

// ── OEE summary ───────────────────────────────────────────────────────────────

function OeeSummary({ v, periodLabel }: { v: OeeView; periodLabel: string }) {
  const r = v.oee;
  const gap = v.gapPts;
  // A stale kiln / sorting feed: the same "Not confirmed" status as the Line OEE KPI, never a target verdict.
  const status =
    v.staleSince != null
      ? { tone: 'neutral' as const, label: `Not confirmed · ${v.staleFeed ?? 'kiln'} data stale since ${formatClock(v.staleSince)}`, icon: Clock }
      : gap == null
        ? null
        : gap >= 0
          ? { tone: 'good' as const, label: 'At or above target', icon: CircleCheck }
          : { tone: (gap >= -5 ? 'warning' : 'critical') as Tone, label: `${fmt1(-gap)} pts below target`, icon: TriangleAlert };
  return (
    <Block
      title="Line OEE"
      subtitle={`${periodLabel} · tile line 1 · simulated time accounting and counts`}
      actions={v.staleSince != null ? <ProvenanceBadge kind="stale" title={v.staleNote ?? undefined} /> : undefined}
      note={
        <>
          <span>{v.scope}</span>
          <span>
            Percentages are rounded to 0.1 %; OEE is computed from the unrounded components
            {v.x.rounding.applicable && !v.x.rounding.matches ? ` (the rounded components multiply to ${fmtPct(v.x.rounding.productOfShown)})` : ''}. Planned kiln stops are excluded from planned
            production time ({fmtInt(v.x.plannedStopMin)} min in this period).
          </span>
        </>
      }
    >
      <div className="prod-oee">
        <div className="prod-oee-main">
          <span className="prod-oee-label">OEE</span>
          <span className="prod-oee-value">
            <MetricText m={r} />
          </span>
          <span className="prod-oee-target">Target {fmtPct(TARGET.oeeTarget, 0)}</span>
          {status && <KpiStatusText status={status} />}
          {r.status !== 'ok' && r.issue && <span className="muted">{r.issue}</span>}
          {v.staleNote && (
            <p className="prod-oee-stale" role="note">
              {v.staleNote}
            </p>
          )}
          <p className="prod-oee-def">{OEE_DEFINITIONS.oee}</p>
        </div>
        <div className="prod-oee-parts">
          {v.components.map((c) => (
            <article key={c.key} className="prod-oee-part">
              <header>
                <span>{c.name}</span>
                <b>
                  <MetricText m={c.metric} />
                </b>
              </header>
              {c.stale && (
                <span className="prod-stale">
                  <ProvenanceBadge kind="stale" /> <span>{c.stale}</span>
                </span>
              )}
              <p className="prod-oee-def">{c.definition}</p>
              <dl className="prod-oee-calc">
                <dt>{c.formula}</dt>
                <dd className="num">{c.values}</dd>
                <dt>Measured at</dt>
                <dd>{c.measuredAt}</dd>
                <dt>Loss</dt>
                <dd className="num">{c.lossMin != null ? `${fmt1(c.lossMin)} min · ${fmt1(c.lossPts)} pts of OEE` : '—'}</dd>
              </dl>
              {c.metric.status !== 'ok' && c.metric.issue && <p className="prod-oee-issue">{c.metric.issue}</p>}
            </article>
          ))}
        </div>
      </div>
      <p className="prod-formula num">{v.formula}</p>
      {v.interpretation.length > 0 && (
        <ul className="prod-interp">
          {v.interpretation.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
    </Block>
  );
}

// ── Integrity checks ─────────────────────────────────────────────────────────

function ChecksList({ checks }: { checks: IntegrityCheck[] }) {
  return (
    <ol className="prod-checks">
      {checks.map((c) => {
        const st = CHECK[c.status];
        return (
          <li key={c.key} className={`prod-check ${c.status}`}>
            <span className="prod-check-n">{c.n}</span>
            <div className="prod-check-b">
              <div className="prod-check-h">
                <b>{c.title}</b>
                <StatusBadge tone={st.tone} icon={st.icon} label={st.label} />
              </div>
              <p>{c.evidence}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Count reconciliation ─────────────────────────────────────────────────────

function Reconciliation({ chain, periodLabel }: { chain: ReturnType<typeof reconciliationView>; periodLabel: string }) {
  const res = (r: number | null) => (r == null ? 'not recorded' : `residual ${fmt1(Math.abs(r) < 0.05 ? 0 : r)}`);
  return (
    <Block
      title="Count reconciliation"
      subtitle={`Tiles at each counting point · ${periodLabel}`}
      actions={
        chain.reconciles ? (
          <StatusBadge tone="good" icon={CircleCheck} label="Counts reconcile" />
        ) : (
          <StatusBadge tone="warning" icon={TriangleAlert} label={chain.unknown ? 'Buffer level not recorded' : `${fmt1(chain.worst)} tiles unexplained`} />
        )
      }
      note={
        <span>
          Sorting passes only accepted tiles downstream, so packing and pallets count good output — never rejects. Each difference between two counting points is a buffer
          change; a residual near 0 means the counts reconcile.
        </span>
      }
    >
      <ol className="prod-chain">
        {chain.steps.map((st, i) => {
          const link = chain.links[i];
          return (
            <li key={st.key}>
              <div className="prod-chain-step">
                <span className="prod-chain-label">{st.label}</span>
                <b className="num">{fmtInt(st.value)}</b>
                <span className="mono muted">{st.point}</span>
                {st.note && <span className="muted">{st.note}</span>}
              </div>
              {link && (
                <div className={`prod-chain-link ${link.kind}`}>
                  <ArrowDown size={12} aria-hidden />
                  <span>
                    {link.delta != null && <b className="num">{link.delta >= 0 ? '+' : '−'}{fmt1(Math.abs(link.delta))} </b>}
                    {link.text} · <span className="num">{res(link.residual)}</span>
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Block>
  );
}
