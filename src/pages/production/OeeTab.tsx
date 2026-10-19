/**
 * OEE & losses: line OEE = Availability × Performance × Quality with the plain-language definitions
 * and the actual numbers, the target comparison and scope, interpretation only where the data support
 * it, the integrity checks evaluated from the data (the ten of §10 plus constraint data freshness), the count reconciliation and the three
 * largest OEE losses.
 */
import { useState } from 'react';
import { ArrowDown, CircleCheck, CircleSlash, Clock, TriangleAlert, type LucideIcon } from 'lucide-react';
import { TARGET } from '../../model/plant';
import { formatClock } from '../../sim/time';
import { RankedBars, TimeSeriesChart, type TimeSeries } from '../../ui/kit/charts';
import type { Metric } from '../../sim/oee';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { KpiStatusText, ProvenanceBadge } from '../../ui/kit/Page';
import { MetricText, StatusBadge, type Tone } from '../../ui/kit/Status';
import type { ProductionTab } from '../ProductionPage';
import { Block } from './common';
import type { CheckStatus, IntegrityCheck, reconciliationView } from './integrity';
import { FinanceNote, LossCards } from './LossCards';
import { OEE_DEFINITIONS, type OeeData, type OeeTrend, type OeeView, type PartialOee, type StageOeeRow } from './oee';
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
      <OeeSummary v={d.v} periodLabel={d.p.label} partial={d.partial} />

      <div className="prod-2col">
        <OeeTrendBlock t={d.trend} periodLabel={d.p.label} />
        <StageComparison rows={d.stages} periodLabel={d.p.label} />
      </div>

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

function OeeSummary({ v, periodLabel, partial }: { v: OeeView; periodLabel: string; partial: PartialOee | null }) {
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
          {partial && (
            <p className="prod-oee-partial" role="note">
              <StatusBadge tone="neutral" icon={CircleSlash} label={partial.label} /> {partial.formula} = <b className="num">{fmtPct(partial.value)}</b> — not an OEE figure.
            </p>
          )}
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

// ── OEE trend ────────────────────────────────────────────────────────────────

type SeriesKey = 'oee' | 'availability' | 'performance' | 'quality';
const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: 'oee', label: 'OEE', color: 'var(--series-1)' },
  { key: 'availability', label: 'Availability', color: 'var(--series-3)' },
  { key: 'performance', label: 'Performance', color: 'var(--series-4)' },
  { key: 'quality', label: 'Quality', color: 'var(--series-5)' },
];

function OeeTrendBlock({ t, periodLabel }: { t: OeeTrend; periodLabel: string }) {
  const [on, setOn] = useState<Record<SeriesKey, boolean>>({ oee: true, availability: false, performance: false, quality: false });
  const per = t.granularity === 'hour' ? 'hour' : 'shift';
  const series: TimeSeries[] = SERIES.filter((x) => on[x.key]).map((x) => ({
    id: x.key,
    label: x.label,
    color: x.color,
    step: true,
    t: t.points.map((p) => p.t),
    v: t.points.map((p) => (p[x.key] == null ? null : p[x.key]! * 100)),
  }));
  if (on.oee && t.partials > 0)
    series.push({ id: 'partial', label: 'Partial A × P (quality input missing)', color: 'var(--text-2)', dashed: true, step: true, t: t.points.map((p) => p.t), v: t.points.map((p) => (p.partialOee == null ? null : p.partialOee * 100)) });
  return (
    <Block
      title="OEE trend"
      subtitle={`Line OEE per ${per} · ${periodLabel} · %`}
      actions={
        <div className="seg" role="group" aria-label="Series">
          {SERIES.map((x) => (
            <button key={x.key} type="button" aria-pressed={on[x.key]} className={on[x.key] ? 'on' : ''} onClick={() => setOn((o) => ({ ...o, [x.key]: !o[x.key] }))}>
              {x.label}
            </button>
          ))}
        </div>
      }
      note={
        <span>
          Each {per} is computed like the period figure (A × P × Q at the kiln, Q at sorting). A {per} without a valid figure is a gap
          {t.gaps ? ` (${t.gaps} here)` : ''}, never 0 %.{t.partials ? ` Where quality is missing the dashed line is A × P only — partial, not OEE.` : ''}
        </span>
      }
    >
      {series.length ? (
        <TimeSeriesChart
          label={`Line OEE per ${per}`}
          from={t.from}
          to={t.to}
          unit="%"
          yMin={0}
          yMax={100}
          height={200}
          formatValue={(v) => `${v.toFixed(1)}`}
          series={series}
          refLines={on.oee ? [{ value: TARGET.oeeTarget * 100, label: `Target ${fmtPct(TARGET.oeeTarget, 0)}`, kind: 'target' }] : []}
          emptyReason="No OEE value in this period yet"
        />
      ) : (
        <p className="muted">Select at least one series.</p>
      )}
    </Block>
  );
}

// ── Stage comparison ─────────────────────────────────────────────────────────

const metricPct = (m: Metric) => (m.status === 'ok' ? fmtPct(m.value) : m.status === 'invalid' ? 'Invalid' : 'Unavailable');

function StageComparison({ rows, periodLabel }: { rows: StageOeeRow[]; periodLabel: string }) {
  const bars = rows.flatMap((r) =>
    r.machines.filter((m) => m.oee.status === 'ok').map((m) => ({ key: m.id, label: <span>{r.stageName} · <span className="mono">{m.id}</span></span>, value: m.oee.value! })),
  );
  const missing = rows.flatMap((r) => r.machines.filter((m) => m.oee.status !== 'ok').map((m) => ({ r, m })));
  const notMeaningful = rows.filter((r) => !r.meaningful);
  const material = rows.filter((r) => r.meaningful && r.note);
  return (
    <Block
      title="OEE by stage"
      subtitle={`Each machine’s own OEE, grouped by monitored stage · ${periodLabel}`}
      note={
        <span>
          Asset-level figures: they are not added up and downtime is not counted twice across stages — the line loss is counted once, at the kiln.
          {material.length ? ` ${material.map((r) => r.stageName).join(' and ')}: ${material[0].note!.toLowerCase()}.` : ''}
        </span>
      }
    >
      {bars.length ? (
        <RankedBars rows={[...bars].sort((a, b) => a.value - b.value)} format={(v) => fmtPct(v)} valueHeader="OEE" labelHeader="Stage · machine" showCumulative={false} />
      ) : (
        <p className="muted">No machine OEE in this period yet.</p>
      )}
      {(missing.length > 0 || notMeaningful.length > 0) && (
        <ul className="prod-oee-na">
          {missing.map(({ r, m }) => (
            <li key={m.id}>
              {r.stageName} · <span className="mono">{m.id}</span> — {metricPct(m.oee)}
              {m.oee.issue ? ` (${m.oee.issue})` : ''}
              {m.partial ? ` · ${m.partial.label}: ${m.partial.formula} = ${fmtPct(m.partial.value)}` : ''}
            </li>
          ))}
          {notMeaningful.map((r) => (
            <li key={r.stage}>
              {r.stageName} — {r.note}
            </li>
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
