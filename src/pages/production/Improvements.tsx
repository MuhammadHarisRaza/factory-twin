import { useEffect, useState } from 'react';
import { Equal, GitCompare, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { useApp } from '../../app/store';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSim, useSimValue } from '../../sim/store';
import { fmt1 } from '../../ui/kit/format';
import { Segmented } from '../../ui/kit/Panel';
import { StatusBadge } from '../../ui/kit/Status';
import { Block, EstTag } from './common';
import { DEFAULT_WHAT_IF, baselineComparison, fmtMoney, whatIfs, type BaselineRow, type LossLedger, type WhatIfOptions } from './loss';

const PTS = ['1', '2', '3', '5'] as const;
const CUTS = ['0.1', '0.25', '0.5'] as const;

/**
 * What-if estimates on the period's own records (arithmetic, not simulation runs), each with its
 * change, basis and assumptions; plus the comparison with the no-scenario baseline.
 */
export function ImprovementPanel({
  L,
  scenarioCount,
  activeScenarios,
  comparing,
  onCompare,
}: {
  L: LossLedger;
  scenarioCount: number;
  activeScenarios: number;
  comparing: boolean;
  onCompare: (v: boolean) => void;
}) {
  const finance = useApp((s) => s.finance);
  const [opts, setOpts] = useState<WhatIfOptions>(DEFAULT_WHAT_IF);
  const list = useSimValue((s) => whatIfs(s, L, opts, finance), [L, opts, finance]);
  const cur = finance.currency;
  return (
    <Block
      title="Improvement estimates"
      subtitle="What-if arithmetic on this period's records, scaled to an 8-hour shift · not simulation runs · not additive · not savings"
      actions={
        <div className="prod-actions">
          <EstTag />
          {scenarioCount > 0 ? (
            <button type="button" className={`btn sm ${comparing ? 'on' : ''}`} onClick={() => onCompare(!comparing)} aria-pressed={comparing} title="Compare this period with the same plant simulated without the scenarios">
              <GitCompare size={12} aria-hidden /> Compare with baseline{activeScenarios ? ` · ${activeScenarios} active` : ''}
            </button>
          ) : (
            <button type="button" className="btn sm" onClick={() => useApp.getState().setScenariosOpen(true)} title="No scenario has run in this session — start one to compare against the no-scenario baseline">
              <GitCompare size={12} aria-hidden /> Run a scenario to compare
            </button>
          )}
        </div>
      }
      note={<span>Each estimate removes one loss on its own; two of them can address the same kiln minutes, so the gains must not be added up. Change the financial assumptions to revalue them.</span>}
    >
      <ul className="prod-wi">
        {list.map((w) => (
          <li key={w.key} className={w.available ? '' : 'off'}>
            <div className="prod-wi-main">
              <div className="prod-wi-title">
                <b>{w.title}</b>
                {w.key === 'kiln-speed' && (
                  <Segmented label="Kiln performance points" value={String(opts.kilnPts) as (typeof PTS)[number]} options={PTS.map((v) => ({ value: v, label: `+${v} pts` }))} onChange={(v) => setOpts({ ...opts, kilnPts: Number(v) })} />
                )}
                {w.key === 'changeover' && (
                  <Segmented label="Changeover reduction" value={String(opts.changeoverCut) as (typeof CUTS)[number]} options={CUTS.map((v) => ({ value: v, label: `−${Math.round(Number(v) * 100)} %` }))} onChange={(v) => setOpts({ ...opts, changeoverCut: Number(v) })} />
                )}
              </div>
              <div className="dim">{w.change}</div>
              {w.note && <div className="muted">{w.note}</div>}
              <details className="prod-wi-basis">
                <summary>Basis &amp; assumptions</summary>
                <p>{w.basis}.</p>
                {w.lines.map((l) => (
                  <p key={l.label}>
                    {l.label}: {l.basis}
                  </p>
                ))}
                <ul>
                  {w.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </details>
            </div>
            <div className="prod-wi-gain">
              <span className="prod-wi-m2">{w.available ? `+${fmt1(w.gainM2PerShift)} m²` : '—'}</span>
              <span className="muted">per shift</span>
              <span className="prod-wi-money">{w.available ? `≈ ${fmtMoney(w.moneyPerShift, cur)}` : '—'}</span>
              <span className="muted">per shift · estimate</span>
            </div>
          </li>
        ))}
      </ul>
    </Block>
  );
}

const DIR = {
  1: { label: 'Better', tone: 'good' as const, icon: TrendingUp },
  [-1]: { label: 'Worse', tone: 'warning' as const, icon: TrendingDown },
  0: { label: 'Same', tone: 'neutral' as const, icon: Equal },
};

function Direction({ r }: { r: BaselineRow }) {
  if (r.direction == null) return <span className="muted">Not comparable</span>;
  const d = DIR[r.direction];
  return <StatusBadge tone={d.tone} icon={d.icon} label={d.label} />;
}

/** The period with the scenarios vs the same seed simulated without them (deterministic engine). */
export function BaselinePanel({ periodKey }: { periodKey: PeriodKey }) {
  const baseline = useSim((s) => s.baseline);
  const finance = useApp((s) => s.finance);
  useEffect(() => {
    if (baseline) return;
    const t = setTimeout(() => useSim.getState().ensureBaseline(), 60);
    return () => clearTimeout(t);
  }, [baseline]);
  const d = useSimValue(
    (s) => {
      if (!baseline) return null;
      const p = resolvePeriod(periodKey, s.minute);
      return { p, ...baselineComparison(s, baseline, p, finance) };
    },
    [baseline, periodKey, finance],
  );
  const cur = finance.currency;
  return (
    <Block
      title="Compare with the no-scenario baseline"
      subtitle={d ? `${d.p.label} · with the scenarios vs the same plant simulated without them` : 'Preparing the no-scenario baseline'}
      actions={<EstTag />}
      note={
        <span>
          The baseline is the same seed simulated without any scenario — because the engine is deterministic, every difference is caused by the scenarios. Only good output is valued; OEE, downtime and rejects act through good output.
        </span>
      }
      flush
    >
      {!d ? (
        <div className="empty">
          <Loader2 size={18} className="spin" aria-hidden />
          <b>Preparing baseline…</b>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Measure</th>
                <th className="n">With scenarios</th>
                <th className="n">Baseline</th>
                <th className="n">Difference</th>
                <th>Effect</th>
                <th className="n">Est. value</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="n">{r.now}</td>
                  <td className="n">{r.base}</td>
                  <td className="n">{r.delta}</td>
                  <td>
                    <Direction r={r} />
                  </td>
                  <td className="n">{r.value == null ? <span className="muted">—</span> : fmtMoney(r.value, cur)}</td>
                  <td className="wrap prod-basis">{r.basis}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>Net estimated effect of the scenarios</td>
                <td className="n">{fmtMoney(d.net, cur)}</td>
                <td className="muted">Estimate · negative = cost</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Block>
  );
}

