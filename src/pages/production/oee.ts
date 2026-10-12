/**
 * OEE & losses — the line OEE view model: the three components with their plain-language
 * definitions, the formula with the actual numbers, the target comparison, the scope and the
 * interpretation sentences the data support. Values are exactly those of lineMetrics (the same
 * figure as the Overview and the KPI cards); nothing is recomputed differently here.
 */
import { constraintFeedStale, sortingFeedStale } from '../../intel/kpis';
import { M2_PER_TILE, TARGET } from '../../model/plant';
import { formatClock, formatDateTime } from '../../sim/time';
import type { SimState } from '../../sim/engine';
import { clippedDuration, downtimeIn, lineLossTree, lineMetrics, type Period } from '../../sim/metrics';
import type { Metric } from '../../sim/oee';
import { fmtMetric } from '../../ui/kit/format';
import { oeeExplain, type OeeExplain } from './derive';
import type { FinanceAssumptions } from '../../sim/finance';
import { evaluateIntegrity, integrityInputs, reconciliationView } from './integrity';
import { KILN, constraintAttribution, lossLedger } from './loss';
import { oeeLosses } from './lossItems';

const n0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const n1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pctS = (f: number | null | undefined, d = 1) => (f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(d)} %`);
const minS = (v: number) => `${n0.format(Math.round(v))} min`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Plain-language definitions (master prompt §10), shown next to every component. */
export const OEE_DEFINITIONS = {
  availability: 'Operating time divided by planned production time.',
  performance: 'Actual production rate relative to the defined ideal rate during operating time.',
  quality: 'Good output divided by total output, using consistent counting boundaries.',
  oee: 'Availability × Performance × Quality: the share of planned time spent making good tiles at the ideal rate.',
} as const;

export type OeeComponent = {
  key: 'availability' | 'performance' | 'quality';
  name: string;
  definition: string;
  /** Where it is measured. */
  measuredAt: string;
  /** The formula in words and with this period's numbers. */
  formula: string;
  values: string;
  metric: Metric;
  /** Minutes of planned kiln time this component loses (OEE loss tree), and the points of OEE. */
  lossMin: number | null;
  lossPts: number | null;
  /** "Not confirmed · kiln data stale since 10:30" when the feed it is measured at is stale in the period (A, P: kiln; Q: sorting). */
  stale: string | null;
};

export type OeeView = {
  x: OeeExplain;
  components: OeeComponent[];
  oee: Metric;
  target: number;
  /** OEE − target in points (null when OEE is unavailable). */
  gapPts: number | null;
  /** "OEE = A × P × Q = …" with the displayed values. */
  formula: string;
  scope: string;
  /** Interpretation sentences; empty when the data do not support one. */
  interpretation: string[];
  /** Simulated downtime at the kiln in the period and the part caused by presenter scenarios. */
  downtimeMin: number;
  scenarioMin: number;
  /**
   * Minute the kiln's data feed (constraintFeedStale: A and P not confirmed) or else the sorting feed
   * (sortingFeedStale: Q not confirmed) went stale inside the period, or null — the Line OEE KPI's rule.
   */
  staleSince: number | null;
  /** Which feed: 'kiln' or 'sorting' (the KPI wording), null when fresh. */
  staleFeed: 'kiln' | 'sorting' | null;
  /** The sentence that says so (null when the feed is fresh). */
  staleNote: string | null;
};

/** "10:30" today, "Sun 11 Oct 11:37" for an earlier day. */
const clockOf = (t: number, now: number) => (Math.floor(t / 1440) === Math.floor(now / 1440) ? formatClock(t) : formatDateTime(t));

/** The stale-feed sentence of the OEE view (same wording basis as the KPI's "Not confirmed" status). */
export const staleOeeNote = (since: number, now: number, feed: 'kiln' | 'sorting' = 'kiln') =>
  feed === 'kiln'
    ? `The kiln's data feed has not updated since ${clockOf(since, now)}: availability and performance after that minute rest on simulated values the feed has not confirmed, so Line OEE is shown as not confirmed — not as a valid comparison with the target.`
    : `The sorting data feed has not updated since ${clockOf(since, now)}: first-pass quality after that minute rests on simulated values the feed has not confirmed, so Line OEE is shown as not confirmed — not as a valid comparison with the target.`;

const show = (m: Metric) => (m.status === 'ok' ? fmtMetric(m) : m.status === 'invalid' ? 'invalid' : 'unavailable');

export function oeeView(s: SimState, p: Period): OeeView {
  const x = oeeExplain(s, p);
  const kilnMark = constraintFeedStale(s, p);
  const sortMark = sortingFeedStale(s, p);
  const mark = (since: number | null, feed: string) => (since == null ? null : `Not confirmed · ${feed} data stale since ${clockOf(since, s.minute)}`);
  const r = x.oee;
  const tree = lineLossTree(s, p);
  const planned = x.plannedMin;
  const pts = (min: number | null | undefined) => (min == null || planned <= 0 ? null : (min / planned) * 100);
  const components: OeeComponent[] = [
    {
      key: 'availability',
      name: 'Availability',
      definition: OEE_DEFINITIONS.availability,
      measuredAt: 'H-KILN roller kiln (modeled design constraint)',
      formula: 'Operating time ÷ planned production time',
      values: `${n1.format(x.operatingMin)} min ÷ ${n1.format(x.plannedMin)} min`,
      metric: r.availability,
      lossMin: tree ? tree.availabilityLoss : null,
      lossPts: pts(tree?.availabilityLoss),
      stale: mark(kilnMark, 'kiln'),
    },
    {
      key: 'performance',
      name: 'Performance',
      definition: OEE_DEFINITIONS.performance,
      measuredAt: `H-KILN · ideal rate ${n0.format(x.idealRatePerHour)} tiles/h`,
      formula: 'Ideal cycle time × total count ÷ operating time',
      values: `${x.idealCycleSec.toFixed(2)} s × ${n0.format(x.totalCount)} tiles = ${n1.format(x.netRunMin)} min ÷ ${n1.format(x.operatingMin)} min`,
      metric: r.performance,
      lossMin: tree ? tree.performanceLoss : null,
      lossPts: pts(tree?.performanceLoss),
      stale: mark(kilnMark, 'kiln'),
    },
    {
      key: 'quality',
      name: 'Quality',
      definition: OEE_DEFINITIONS.quality,
      measuredAt: 'Sorting · gauge + vision (first pass)',
      formula: 'Good tiles ÷ tiles inspected',
      values: `${n0.format(x.good)} ÷ ${n0.format(x.sorted)} tiles`,
      metric: r.quality,
      lossMin: tree ? tree.qualityLoss : null,
      lossPts: pts(tree?.qualityLoss),
      stale: mark(sortMark, 'sorting'),
    },
  ];
  const gapPts = r.oee.status === 'ok' ? (r.oee.value! - TARGET.oeeTarget) * 100 : null;

  // Simulated downtime at the kiln (its own unplanned stops, from the downtime records) and the part
  // a presenter scenario caused.
  const kilnStops = downtimeIn(s, p).filter((d) => d.equipmentId === KILN && d.category !== 'Starved' && d.category !== 'Blocked' && d.category !== 'Planned');
  const downtimeMin = kilnStops.reduce((a, d) => a + clippedDuration(d, p, s.minute), 0);
  const scenarioMin = kilnStops.filter((d) => d.source === 'scenario').reduce((a, d) => a + clippedDuration(d, p, s.minute), 0);
  const t = lineMetrics(s, p).constraint.totals;
  const att = constraintAttribution(s, p);
  const scenarioHeld = att.causes.reduce((a, c) => a + (s.events.find((e) => e.id === c.eventIds[0])?.source === 'scenario' ? c.minutes : 0), 0);

  // The Line OEE KPI's rule (factoryOeeKpi): a stale kiln feed first, else a stale sorting feed.
  const kilnStale = kilnMark;
  const sortStale = kilnStale == null ? sortMark : null;
  const staleSince = kilnStale ?? sortStale;
  const staleFeed = kilnStale != null ? 'kiln' : sortStale != null ? 'sorting' : null;
  const staleNote = staleSince != null && staleFeed ? staleOeeNote(staleSince, s.minute, staleFeed) : null;
  const interpretation: string[] = [];
  if (staleNote) {
    // No target verdict or loss attribution on figures the feed has not confirmed.
    interpretation.push(staleNote);
    if (r.oee.status === 'ok') interpretation.push(`The simulated accounting reads ${pctS(r.oee.value)}; it is a confirmed figure again once the ${staleFeed === 'kiln' ? "kiln's" : 'sorting'} feed is restored.`);
  } else if (r.oee.status === 'ok' && gapPts != null && tree) {
    interpretation.push(
      Math.abs(gapPts) < 0.05
        ? `Line OEE is ${pctS(r.oee.value)}, at the ${pctS(TARGET.oeeTarget, 0)} target.`
        : gapPts > 0
          ? `Line OEE is ${pctS(r.oee.value)}, ${n1.format(gapPts)} pts above the ${pctS(TARGET.oeeTarget, 0)} target.`
          : `Line OEE is ${pctS(r.oee.value)}, ${n1.format(-gapPts)} pts below the ${pctS(TARGET.oeeTarget, 0)} target.`,
    );
    const ranked = components.filter((c) => (c.lossMin ?? 0) > 0.05).sort((a, b) => (b.lossMin ?? 0) - (a.lossMin ?? 0));
    const top = ranked[0];
    const lead = top ? (gapPts < 0 ? `${top.name} (${show(top.metric)}) is the main reason it is below target` : `${top.name} (${show(top.metric)}) is the largest of the three losses`) : '';
    if (top?.key === 'availability') {
      const parts: string[] = [];
      if (t.down >= 0.5) parts.push(`${minS(t.down)} of its own stops${att.kilnReasons[0] ? ` (largest: ${lower(att.kilnReasons[0].label)})` : ''}`);
      if (t.starved + t.blocked >= 0.5) {
        const root = att.causes[0];
        parts.push(`${minS(t.starved + t.blocked)} starved or blocked${root ? `, mostly by ${root.equipmentId} · ${root.name}` : ''}`);
      }
      const scen = scenarioMin + scenarioHeld;
      interpretation.push(
        `${lead}: the simulated kiln did not produce for ${minS(tree.availabilityLoss)} of ${minS(planned)} planned — ${parts.join(' and ')}${scen >= 0.5 ? `; about ${minS(scen)} of it was caused by a presenter-started scenario` : ''}.`,
      );
    } else if (top?.key === 'performance') {
      const ideal = (x.idealRatePerHour / 60) * x.operatingMin;
      interpretation.push(
        `${lead}: while operating, the simulated kiln fired ${n0.format(x.totalCount)} tiles against ${n0.format(ideal)} at its ideal rate — a speed loss of ≈ ${n0.format(Math.max(0, ideal - x.totalCount) * M2_PER_TILE)} m².`,
      );
    } else if (top?.key === 'quality') {
      const rej = x.sorted - x.good;
      interpretation.push(`${lead}: ${n0.format(rej)} of ${n0.format(x.sorted)} inspected tiles were rejected at sorting (simulated classification).`);
    }
    if (r.availability.status === 'ok' && r.availability.value! >= 0.9995) interpretation.push('Availability is 100 %: the kiln produced in every planned minute of the period.');
  }

  return {
    x,
    components,
    oee: r.oee,
    target: TARGET.oeeTarget,
    gapPts,
    formula: `OEE = ${show(r.availability)} × ${show(r.performance)} × ${show(r.quality)} = ${show(r.oee)}`,
    scope: 'Availability and performance at H-KILN (the modeled design constraint, where lost time is lost line output); quality at sorting (first pass, gauge + vision). Same period, same line, combined explicitly.',
    interpretation,
    downtimeMin,
    scenarioMin,
    staleSince,
    staleFeed,
    staleNote,
  };
}

// ── Everything OEE & losses shows ────────────────────────────────────────────

export type OeeData = ReturnType<typeof oeeData>;

/** The OEE & losses view model for a period: OEE view, integrity checks, count chain and the OEE losses. */
export function oeeData(s: SimState, p: Period, f: FinanceAssumptions) {
  const inputs = integrityInputs(s, p, f);
  const v = oeeView(s, p);
  return {
    p,
    v,
    checks: evaluateIntegrity(inputs),
    chain: reconciliationView(inputs.chain),
    losses: oeeLosses(s, p, f, lossLedger(s, p, f)),
    summary: v.interpretation.length ? v.interpretation.slice(0, 2).join(' ') : (v.oee.issue ?? 'Line OEE cannot be calculated for this period yet.'),
  };
}
