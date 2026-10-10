import { Equal, FlaskConical, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { useApp } from '../../app/store';
import { impactVsBaseline } from '../../sim/metrics';
import { useSim, useSimValue } from '../../sim/store';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { StatusBadge } from '../../ui/kit/Status';
import { faultOutcomes, impactWindow, judge, scenarioStatus, signed, when, type Direction, type WindowMode } from './catalogue';

const VERDICT: Record<Direction, { label: string; tone: 'good' | 'warning' | 'neutral' }> = {
  better: { label: 'Better than baseline', tone: 'good' },
  worse: { label: 'Worse than baseline', tone: 'warning' },
  same: { label: 'Same as baseline', tone: 'neutral' },
};

function Verdict({ delta, dir }: { delta: number | null; dir: Direction | null }) {
  if (dir == null) return <span className="muted">Not comparable</span>;
  const icon = dir === 'same' ? Equal : (delta ?? 0) > 0 ? TrendingUp : TrendingDown;
  return <StatusBadge tone={VERDICT[dir].tone} icon={icon} label={VERDICT[dir].label} />;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Answer-first band: what the active scenarios have changed compared with the baseline —
 * the same deterministic seed simulated without scenarios. The baseline is built in background
 * slices after start-up and after every reset (src/sim/store.ts); the band waits for it rather than
 * forcing a synchronous build, so the UI never freezes.
 */
export function ImpactBand({ mode }: { mode: WindowMode }) {
  const baseline = useSim((s) => s.baseline);
  const resetting = useSim((s) => s.resetting);
  const tariffs = useApp((s) => s.tariffs);

  const d = useSimValue(
    (s) => {
      const w = impactWindow(s, mode);
      const keys = s.scenarios.map((sc) => scenarioStatus(s, sc).key);
      // A fault that ended in a breakdown is not a resolved fault (finding #16).
      const faults = faultOutcomes(s);
      return {
        now: s.minute,
        w,
        active: keys.filter((k) => k === 'active').length,
        removed: faults.removed,
        brokeDown: faults.brokeDown,
        total: s.scenarios.length,
        impact: baseline ? impactVsBaseline(s, baseline, w.period, tariffs) : null,
      };
    },
    [mode, baseline, tariffs],
  );
  const { impact: im, w } = d;

  const headline = resetting ? (
    <span className="scnp-preparing">
      <Loader2 size={15} className="spin" aria-hidden />
      Resetting the demo…
    </span>
  ) : !im ? (
    <span className="scnp-preparing">
      <Loader2 size={15} className="spin" aria-hidden />
      Preparing baseline…
    </span>
  ) : d.active || d.removed || d.brokeDown ? (
    [
      d.active ? `${plural(d.active, 'scenario')} active` : 'No scenario active',
      d.removed ? `${plural(d.removed, 'fault')} removed by maintenance` : '',
      d.brokeDown ? `${plural(d.brokeDown, 'fault')} broke down` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  ) : d.total ? (
    'No scenario active'
  ) : (
    'No scenarios yet — the plant matches its baseline'
  );

  const windowNote = w.anchor
    ? `From ${when(w.period.from, d.now)}, the top of the hour the first active scenario began (${when(w.anchor.start, d.now)} · ${w.anchor.label}).`
    : w.fallback
      ? `Nothing active — showing the current shift (${w.period.label}).`
      : `${w.period.label}.`;

  const cells: { label: string; value: string; unit: string; sub: string; delta: number | null; dir: Direction | null; title: string }[] = im
    ? [
        {
          label: 'Good output',
          value: signed(im.deltaOutputM2, fmtInt),
          unit: 'm²',
          sub: `With scenarios ${fmtInt(im.outputM2)} · baseline ${fmtInt(im.baselineOutputM2)} m²`,
          delta: im.deltaOutputM2,
          dir: judge(im.deltaOutputM2, 1, true),
          title: 'First-quality m² accepted at sorting',
        },
        {
          label: 'Line OEE',
          value: signed(im.deltaOeePts, fmt1),
          unit: 'pts',
          sub: `With scenarios ${fmtPct(im.oee)} · baseline ${fmtPct(im.baselineOee)}`,
          delta: im.deltaOeePts,
          dir: judge(im.deltaOeePts, 0.05, true),
          title: 'Percentage points of line OEE (kiln availability × performance × first-pass quality)',
        },
        {
          label: 'Unplanned downtime',
          value: signed(im.deltaDowntimeMin, fmtInt),
          unit: 'min',
          sub: `With scenarios ${fmtInt(im.downtimeMin)} · baseline ${fmtInt(im.downtimeMin - im.deltaDowntimeMin)} min`,
          delta: im.deltaDowntimeMin,
          dir: judge(im.deltaDowntimeMin, 0.5, false),
          title: 'Line downtime excluding planned stops, starved and blocked time',
        },
        {
          label: 'Reject rate',
          value: signed(im.deltaRejectRatePts, (v) => v.toFixed(2)),
          unit: 'pts',
          sub: `With scenarios ${fmtPct(im.rejectRate, 2)} (${fmtInt(im.rejects)} tiles) · baseline ${fmtPct(im.baselineRejectRate, 2)} (${fmtInt(im.rejects - im.deltaRejects)})`,
          delta: im.deltaRejectRatePts,
          dir: judge(im.deltaRejectRatePts, 0.05, false),
          title: 'Share of inspected tiles rejected at the gauge and optical inspection — a rate, so a stopped line does not look better',
        },
        {
          label: 'Energy cost per good m²',
          value: signed(im.deltaCostPerGoodM2, (v) => v.toFixed(2)),
          unit: tariffs.currency,
          sub: `With scenarios ${im.costPerGoodM2 != null ? `${tariffs.currency} ${im.costPerGoodM2.toFixed(2)}` : '—'} · baseline ${im.baselineCostPerGoodM2 != null ? `${tariffs.currency} ${im.baselineCostPerGoodM2.toFixed(2)}` : '—'} · total ${signed(im.deltaEnergyCost, fmtInt)} ${tariffs.currency}`,
          delta: im.deltaCostPerGoodM2,
          dir: judge(im.deltaCostPerGoodM2, 0.005, false),
          title: 'Illustrative energy model; tariffs are assumptions (editable in Energy Intelligence). Per good m², because a stopped kiln still burns gas while producing nothing.',
        },
      ]
    : ['Good output', 'Line OEE', 'Unplanned downtime', 'Reject rate', 'Energy cost per good m²'].map((label) => ({
        label,
        value: '—',
        unit: '',
        sub: 'Waiting for the baseline run',
        delta: null,
        dir: null,
        title: '',
      }));

  return (
    <section className="summary scnp-band" aria-label="Impact versus baseline">
      <div>
        <div className="kpi-label">
          <FlaskConical size={13} aria-hidden />
          Impact vs baseline · {w.period.label}
        </div>
        <div className="kpi-headline">{headline}</div>
        <div className="kpi-sub scnp-note">{windowNote}</div>
      </div>
      {cells.map((c) => (
        <div key={c.label} title={c.title}>
          <div className="kpi-label">{c.label} Δ</div>
          <div className="kpi-value">
            {c.value}
            {c.unit && <small>{c.unit}</small>}
          </div>
          <div className="kpi-sub">{c.sub}</div>
          <div className="kpi-sub">
            <Verdict delta={c.delta} dir={c.dir} />
          </div>
        </div>
      ))}
    </section>
  );
}
