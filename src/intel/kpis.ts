/**
 * Headline KPIs — the single source of truth for every KPI card in the product. Overview,
 * Production, Quality, Fleet, the Factory Twin and the reports read these view models instead of
 * re-deriving the same figure, so a number has one name, one formula, one scope and one status
 * wherever it appears. Each carries its plain-language definition and why it matters.
 *
 * Values come from the simulation (provenance SIMULATED). A KPI that cannot be computed from the
 * data says so (`unavailable`) instead of showing a made-up value.
 */
import { DEFECTS, LINE, M2_PER_TILE, STAGE_BY_ID, TARGET } from '../model/plant';
import type { AlertSeverity, DefectCategory, OpEvent } from '../model/types';
import type { SimState } from '../sim/engine';
import {
  TARGET_STATUS_LABEL,
  externalVehicles,
  fleetMetrics,
  lineGoodIn,
  lineMetrics,
  planTiles,
  qualityIn,
  targetStatus,
  visitDurations,
  type LineMetrics,
  type Period,
} from '../sim/metrics';
import { formatClock, shiftAt } from '../sim/time';
import type { Tone } from '../ui/kit/Status';

export type KpiId =
  | 'good-output'
  | 'target-attainment'
  | 'factory-oee'
  | 'first-pass-quality'
  | 'active-issues'
  | 'production-rate'
  | 'reject-rate'
  | 'constraint-downtime'
  | 'inspected'
  | 'defective'
  | 'top-defect'
  | 'active-vehicles'
  | 'delayed-vehicles'
  | 'avg-dwell'
  | 'completed-trips';

export type KpiModel = {
  id: KpiId;
  label: string;
  /** Raw value (for comparisons and tests); null when unavailable. */
  value: number | null;
  /** Formatted value (without unit). */
  display: string;
  unit?: string;
  /** Time / equipment scope, e.g. "Shift B · 06:00–now · tile line 1". */
  scope: string;
  /** Target or comparison, formatted (e.g. "Plan 7,040 m²"). */
  target?: string;
  status: { tone: Tone; label: string } | null;
  /** Why the figure matters / what it means, one sentence. */
  why: string;
  /** How it is calculated (shown on demand). */
  definition: string;
  /** Reason the KPI cannot be calculated (replaces the value). */
  unavailable?: string;
  /** Set when part of the figure rests on a data feed that stopped updating (labelled STALE). */
  provenance?: 'stale';
};

/** Minute an asset's data feed went stale inside the period (null = fresh for the whole period). */
export function feedStaleSince(s: SimState, id: string, p: Period): number | null {
  const f = s.feeds[id];
  return f && f.status === 'stale' && f.since < p.to ? f.since : null;
}

/** The kiln (line constraint) feed is stale inside the period: A and P after that minute are not confirmed. */
export const constraintFeedStale = (s: SimState, p: Period) => feedStaleSince(s, 'H-KILN', p);

/** The sorting line's feed (where good output and rejects are counted) is stale inside the period. */
export const sortingFeedStale = (s: SimState, p: Period) => feedStaleSince(s, 'I-SORT', p);

/** A KPI computed while the feed it rests on is stale: same value, marked not confirmed. */
function markStale(k: KpiModel, since: number, what = 'kiln'): KpiModel {
  return {
    ...k,
    provenance: 'stale',
    status: { tone: 'neutral', label: `Not confirmed · ${what} data stale since ${formatClock(since)}` },
    why: `The ${what} data feed has not updated since ${formatClock(since)}: the figure includes simulated values the feed has not confirmed. ${k.why}`.trim(),
  };
}

/** Marks a sorting-counted KPI (output, quality) when the sorting feed is stale in its period. */
const sortingChecked = (s: SimState, p: Period, k: KpiModel): KpiModel => {
  const since = sortingFeedStale(s, p);
  return since != null && !k.unavailable ? markStale(k, since, 'sorting') : k;
};

const int = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}`;
const m2 = (tiles: number) => tiles * M2_PER_TILE;
/**
 * The time scope of a figure. A period that ends now is "to date": a shift label (06:00–14:00) is
 * shown as 06:00–now so the figure and its plan are not read as whole-shift values.
 */
export function periodScope(s: SimState, p: Period) {
  if (p.to < s.minute) return p.label;
  const m = /^(.*?)(\d\d:\d\d)–\d\d:\d\d$/.exec(p.label);
  if (m) return `${m[1]}${m[2]}–${formatClock(p.to)} (to date)`;
  return `${p.label} (to ${formatClock(p.to)})`;
}
const scopeOf = (s: SimState, p: Period, what: string = LINE.name) => `${periodScope(s, p)} · ${what}`;

const TARGET_TONE: Record<ReturnType<typeof targetStatus>, Tone> = {
  ahead: 'good',
  'on-track': 'good',
  behind: 'warning',
  'well-behind': 'critical',
  none: 'neutral',
};

/** Good output: tiles accepted at sorting, in m² (tiles in the definition). */
export function goodOutputKpi(s: SimState, p: Period, lm: LineMetrics = lineMetrics(s, p)): KpiModel {
  return sortingChecked(s, p, goodOutputKpiRaw(s, p, lm));
}

function goodOutputKpiRaw(s: SimState, p: Period, lm: LineMetrics): KpiModel {
  return {
    id: 'good-output',
    label: 'Good output',
    value: lm.outputM2,
    display: int(lm.outputM2),
    unit: 'm²',
    scope: scopeOf(s, p),
    target: lm.targetM2 > 0 ? planText(s, p, lm) : undefined,
    status: lm.target > 0 ? { tone: TARGET_TONE[targetStatus(lm.attainment)], label: TARGET_STATUS_LABEL[targetStatus(lm.attainment)] } : null,
    why: `${int(lm.output)} tiles accepted at sorting — the sellable output of the line.`,
    definition: `Tiles accepted at sorting (gauge + vision inspection) × ${M2_PER_TILE} m² per tile. Rejected tiles are not counted.`,
  };
}

/** Target attainment: good output ÷ plan for the planned production time elapsed. */
export function targetAttainmentKpi(s: SimState, p: Period, lm: LineMetrics = lineMetrics(s, p)): KpiModel {
  return sortingChecked(s, p, targetAttainmentKpiRaw(s, p, lm));
}

function targetAttainmentKpiRaw(s: SimState, p: Period, lm: LineMetrics): KpiModel {
  const st = targetStatus(lm.attainment);
  if (lm.attainment == null)
    return {
      id: 'target-attainment',
      label: 'Target attainment',
      value: null,
      display: '—',
      scope: scopeOf(s, p),
      status: null,
      why: 'No planned production time has elapsed in this period yet.',
      definition: planDefinition(),
      unavailable: 'No planned production time has elapsed yet, so there is no plan to compare with.',
    };
  const gapM2 = lm.targetM2 - lm.outputM2;
  return {
    id: 'target-attainment',
    label: 'Target attainment',
    value: lm.attainment,
    display: pct(lm.attainment),
    unit: '%',
    scope: scopeOf(s, p),
    target: 'Plan 100 %',
    status: { tone: TARGET_TONE[st], label: TARGET_STATUS_LABEL[st] },
    why: gapM2 > 0 ? `${int(gapM2)} m² short of the plan so far.` : `${int(-gapM2)} m² ahead of the plan so far.`,
    definition: planDefinition(),
  };
}

/** "Plan 1,782 m²", or for the running shift "Plan to date 1,782 m² · shift 3,168 m²". */
function planText(s: SimState, p: Period, lm: LineMetrics) {
  const sh = shiftAt(s.minute);
  if (p.from === sh.start && p.to >= s.minute && p.to < sh.end) {
    const full = m2(planTiles(s, { from: sh.start, to: sh.end, label: sh.label }));
    return `Plan to date ${int(lm.targetM2)} m² · shift ${int(full)} m²`;
  }
  return `Plan ${int(lm.targetM2)} m²`;
}

const planDefinition = () =>
  `Good output ÷ plan. Plan = ${int(TARGET.goodPerHour)} good tiles (${int(m2(TARGET.goodPerHour))} m²) per planned production hour; planned kiln stops reduce the plan instead of counting as a shortfall. Status: ≥ 100 % ahead, ≥ 97 % on track, ≥ 90 % behind, below that well behind.`;

/** Factory OEE: availability × performance at the line constraint × first-pass quality at sorting. */
export function factoryOeeKpi(s: SimState, p: Period, lm: LineMetrics = lineMetrics(s, p)): KpiModel {
  const k = factoryOeeKpiRaw(s, p, lm);
  if (k.unavailable) return k;
  // A and P come from the kiln's accounting, Q from sorting: either feed going stale leaves OEE unconfirmed.
  const kiln = constraintFeedStale(s, p);
  if (kiln != null) return markStale(k, kiln);
  const sorting = sortingFeedStale(s, p);
  return sorting != null ? markStale(k, sorting, 'sorting') : k;
}

function factoryOeeKpiRaw(s: SimState, p: Period, lm: LineMetrics): KpiModel {
  const o = lm.oee.oee;
  const definition = `OEE = Availability × Performance × Quality. Availability and performance are measured at the kiln (the line's designed constraint), quality is first-pass yield at sorting. Target ${pct(TARGET.oeeTarget, 0)} %.`;
  if (o.status !== 'ok' || o.value == null)
    return { id: 'factory-oee', label: 'Line OEE', value: null, display: '—', scope: scopeOf(s, p), status: null, why: '', definition, unavailable: o.issue ?? 'OEE cannot be calculated for this period.' };
  const gap = o.value - TARGET.oeeTarget;
  const tone: Tone = gap >= 0 ? 'good' : gap >= -0.05 ? 'warning' : 'critical';
  const a = lm.oee.availability.value;
  const pf = lm.oee.performance.value;
  const q = lm.oee.quality.value;
  return {
    id: 'factory-oee',
    label: 'Line OEE',
    value: o.value,
    display: pct(o.value),
    unit: '%',
    scope: scopeOf(s, p),
    target: `Target ${pct(TARGET.oeeTarget, 0)} %`,
    status: { tone, label: gap >= 0 ? 'At or above target' : `${pct(-gap)} pts below target` },
    why: a != null && pf != null && q != null ? `Availability ${pct(a)} % × performance ${pct(pf)} % × quality ${pct(q)} %.` : 'Share of the planned time spent making good tiles at full speed.',
    definition,
  };
}

/** First-pass quality: tiles accepted at the first inspection ÷ tiles inspected (no rework loop in the model). */
export function firstPassQualityKpi(s: SimState, p: Period): KpiModel {
  return sortingChecked(s, p, firstPassQualityKpiRaw(s, p));
}

function firstPassQualityKpiRaw(s: SimState, p: Period): KpiModel {
  const q = qualityIn(s, p);
  const limit = s.rules.rejectRateMax;
  const definition = `Accepted ÷ inspected at sorting (dimensional gauge + vision tunnel). The modeled line has no rework loop, so every rejected tile is a first-pass failure. Alert limit: reject rate above ${pct(limit, 0)} % (event rule).`;
  if (q.inspected <= 0)
    return { id: 'first-pass-quality', label: 'First-pass quality', value: null, display: '—', scope: scopeOf(s, p, 'sorting'), status: null, why: '', definition, unavailable: 'No tiles have been inspected in this period yet.' };
  const fpy = q.accepted / q.inspected;
  const within = 1 - fpy <= limit;
  return {
    id: 'first-pass-quality',
    label: 'First-pass quality',
    value: fpy,
    display: pct(fpy),
    unit: '%',
    scope: scopeOf(s, p, 'sorting'),
    target: `Limit ≥ ${pct(1 - limit, 0)} %`,
    status: { tone: within ? 'good' : 'critical', label: within ? 'Within reject limit' : 'Reject limit exceeded' },
    why: `${int(q.rejected)} of ${int(q.inspected)} inspected tiles rejected.`,
    definition,
  };
}

// ── Issues requiring attention ───────────────────────────────────────────────

const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/**
 * Open issues that need someone's attention: events not yet resolved, of warning severity or above,
 * that are root events (consequences are reached through their root, so a stoppage and the
 * starvation it caused downstream count once), including a condition detected during the pre-rolled
 * history that is still active. Most severe first, then still-active, then newest.
 */
export function attentionEvents(s: SimState): OpEvent[] {
  return s.events
    // A pre-roll (historical) event counts while its condition is still active; once it has ended it is history.
    .filter((e) => e.status !== 'resolved' && e.severity !== 'info' && !e.consequenceOf && !(e.historical && e.end != null))
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || Number(b.end == null) - Number(a.end == null) || b.start - a.start);
}

export function activeIssuesKpi(s: SimState): KpiModel {
  const list = attentionEvents(s);
  const active = list.filter((e) => e.end == null).length;
  const worst = list[0]?.severity ?? null;
  const tone: Tone = !worst ? 'good' : worst === 'critical' ? 'critical' : 'warning';
  return {
    id: 'active-issues',
    label: 'Issues requiring attention',
    value: list.length,
    display: int(list.length),
    unit: 'open',
    scope: `Now · ${formatClock(s.minute)}`,
    status: { tone, label: !worst ? 'None open' : `Highest: ${worst}` },
    why: list.length ? `${active} still active; ${list.length - active} cleared but not yet resolved by a user.` : 'No unresolved warning, serious or critical event.',
    definition: 'Unresolved events of warning severity or above, counted once per root cause (knock-on events such as downstream starvation are part of their root event).',
  };
}

// ── Production ───────────────────────────────────────────────────────────────

/** Good output in the last complete plant hour, against the plan rate. */
export function productionRateKpi(s: SimState): KpiModel {
  const h = Math.floor(s.minute / 60) - 1;
  const p: Period = { from: h * 60, to: h * 60 + 60, label: `${formatClock(h * 60)}–${formatClock(h * 60 + 60)}` };
  return sortingChecked(s, p, productionRateKpiRaw(s, p));
}

function productionRateKpiRaw(s: SimState, p: Period): KpiModel {
  const good = lineGoodIn(s, p);
  const planRate = m2(TARGET.goodPerHour);
  const ratio = good / TARGET.goodPerHour;
  const tone: Tone = ratio >= 0.97 ? 'good' : ratio >= 0.9 ? 'warning' : 'critical';
  return {
    id: 'production-rate',
    label: 'Production rate',
    value: m2(good),
    display: int(m2(good)),
    unit: 'm²/h',
    scope: `Last full hour · ${p.label}`,
    target: `Plan ${int(planRate)} m²/h`,
    status: { tone, label: `${pct(ratio, 0)} % of plan rate` },
    why: `${int(good)} good tiles in the last complete hour.`,
    definition: `Good tiles accepted at sorting in the last complete plant hour × ${M2_PER_TILE} m². Plan rate ${int(TARGET.goodPerHour)} tiles/h.`,
  };
}

export function rejectRateKpi(s: SimState, p: Period): KpiModel {
  return sortingChecked(s, p, rejectRateKpiRaw(s, p));
}

function rejectRateKpiRaw(s: SimState, p: Period): KpiModel {
  const q = qualityIn(s, p);
  const limit = s.rules.rejectRateMax;
  const definition = `Rejected ÷ inspected at sorting. Alert limit ${pct(limit, 0)} % (event rule).`;
  if (q.inspected <= 0)
    return { id: 'reject-rate', label: 'Reject rate', value: null, display: '—', scope: scopeOf(s, p, 'sorting'), status: null, why: '', definition, unavailable: 'No tiles have been inspected in this period yet.' };
  const r = q.rejected / q.inspected;
  return {
    id: 'reject-rate',
    label: 'Reject rate',
    value: r,
    display: pct(r, 2),
    unit: '%',
    scope: scopeOf(s, p, 'sorting'),
    target: `Limit ${pct(limit, 0)} %`,
    status: { tone: r <= limit ? 'good' : 'critical', label: r <= limit ? 'Within limit' : 'Above limit' },
    why: `${int(q.rejected)} tiles (${int(m2(q.rejected))} m²) scrapped or downgraded.`,
    definition,
  };
}

/** Production time lost at the line constraint (the kiln): planned minutes without output. */
export function constraintDowntimeKpi(s: SimState, p: Period, lm: LineMetrics = lineMetrics(s, p)): KpiModel {
  const k = constraintDowntimeKpiRaw(s, p, lm);
  const stale = constraintFeedStale(s, p);
  return stale != null ? markStale(k, stale) : k;
}

function constraintDowntimeKpiRaw(s: SimState, p: Period, lm: LineMetrics): KpiModel {
  const t = lm.constraint.totals;
  const lost = Math.max(0, t.planned - t.operating);
  const ideal = lm.constraint.idealRatePerHour;
  const lostTiles = (lost / 60) * ideal;
  const share = t.planned > 0 ? lost / t.planned : 0;
  return {
    id: 'constraint-downtime',
    label: 'Downtime affecting output',
    value: lost,
    display: int(lost),
    unit: 'min',
    scope: scopeOf(s, p, 'kiln (line constraint)'),
    target: t.planned > 0 ? `${pct(share, 0)} % of planned time` : undefined,
    status: { tone: share <= 0.05 ? 'good' : share <= 0.12 ? 'warning' : 'critical', label: lost === 0 ? 'No lost time' : `${int(t.down)} min stopped · ${int(t.starved + t.blocked)} min starved/blocked` },
    why: `≈ ${int(m2(lostTiles))} m² of capacity at the kiln's ideal rate.`,
    definition: `Planned production minutes in which the kiln — the line's designed constraint, where lost time is lost output — produced nothing: its own stops plus time starved of tiles or blocked by full downstream buffers. Stops elsewhere only count once they reach the kiln.`,
  };
}

// ── Quality ──────────────────────────────────────────────────────────────────

export function inspectedKpi(s: SimState, p: Period): KpiModel {
  return sortingChecked(s, p, inspectedKpiRaw(s, p));
}

function inspectedKpiRaw(s: SimState, p: Period): KpiModel {
  const q = qualityIn(s, p);
  return {
    id: 'inspected',
    label: 'Tiles inspected',
    value: q.inspected,
    display: int(q.inspected),
    unit: 'tiles',
    scope: scopeOf(s, p, 'sorting'),
    status: null,
    why: 'Every tile passes the dimensional gauge and the vision tunnel at sorting.',
    definition: 'Tiles that passed the inspection stations at sorting in the period.',
  };
}

export function defectiveKpi(s: SimState, p: Period): KpiModel {
  return sortingChecked(s, p, defectiveKpiRaw(s, p));
}

function defectiveKpiRaw(s: SimState, p: Period): KpiModel {
  const q = qualityIn(s, p);
  const r = q.inspected > 0 ? q.rejected / q.inspected : null;
  return {
    id: 'defective',
    label: 'Defective tiles',
    value: q.rejected,
    display: int(q.rejected),
    unit: 'tiles',
    scope: scopeOf(s, p, 'sorting'),
    target: r != null ? `${pct(r, 2)} % of inspected` : undefined,
    status: r == null ? null : { tone: r <= s.rules.rejectRateMax ? 'good' : 'critical', label: r <= s.rules.rejectRateMax ? 'Within limit' : 'Above limit' },
    why: `${int(m2(q.rejected))} m² rejected at sorting.`,
    definition: 'Tiles rejected by the gauge or the vision tunnel (simulated classification).',
  };
}

export function topDefectKpi(s: SimState, p: Period): KpiModel {
  const q = qualityIn(s, p);
  const ranked = (Object.entries(q.byDefect) as [DefectCategory, number][]).sort((a, b) => b[1] - a[1]);
  const [cat, n] = ranked[0] ?? [null, 0];
  if (!cat || n <= 0)
    return { id: 'top-defect', label: 'Most frequent defect', value: null, display: '—', scope: scopeOf(s, p, 'sorting'), status: null, why: '', definition: 'Defect category with the most rejected tiles.', unavailable: 'No defects recorded in this period.' };
  const share = q.rejected > 0 ? n / q.rejected : 0;
  return {
    id: 'top-defect',
    label: 'Most frequent defect',
    value: n,
    display: DEFECTS[cat].label,
    scope: scopeOf(s, p, 'sorting'),
    target: `${int(n)} tiles · ${pct(share, 0)} % of rejects`,
    status: null,
    why: `Modeled origin stage: ${STAGE_BY_ID[DEFECTS[cat].origin].name} (a hypothesis to check, not a confirmed cause).`,
    definition: 'Defect category with the most rejected tiles in the period (simulated classification).',
  };
}

// ── Fleet ────────────────────────────────────────────────────────────────────

export type DelayedTruck = { id: string; label: string; reason: string; minutes: number; limit: number };

/**
 * An open visit (no gate-out) older than this is treated as a possibly incomplete record — a
 * missing gate-out — rather than a real stay, and is reviewed separately instead of counted as a
 * delay: 4 × the turnaround limit, and never less than 12 h.
 */
export const staleVisitLimit = (rules: Pick<SimState['rules'], 'turnaroundMax'>) => Math.max(4 * rules.turnaroundMax, 720);

/** Trucks on site past a configured limit: waiting for a dock, at the dock, or on site in total. */
export function delayedTrucks(s: SimState): DelayedTruck[] {
  const now = s.minute;
  const R = s.rules;
  const out: DelayedTruck[] = [];
  for (const v of externalVehicles(s)) {
    const vis = v.visit!;
    if (vis.gateIn > now || vis.gateOut != null) continue;
    const d = visitDurations(v, now);
    const onSite = now - vis.gateIn;
    if (onSite > staleVisitLimit(R)) continue; // possibly incomplete record, not a delay
    if (v.phase === 'waiting' && d.waiting != null && d.waiting > R.truckWaitMax) out.push({ id: v.id, label: v.label, reason: 'Waiting for a dock', minutes: d.waiting, limit: R.truckWaitMax });
    else if ((v.phase === 'loading' || v.phase === 'unloading') && d.dockTime != null && d.dockTime > R.dockStayMax) out.push({ id: v.id, label: v.label, reason: 'At the dock', minutes: d.dockTime, limit: R.dockStayMax });
    else if (onSite > R.turnaroundMax) out.push({ id: v.id, label: v.label, reason: 'On site', minutes: onSite, limit: R.turnaroundMax });
  }
  return out.sort((a, b) => b.minutes - b.limit - (a.minutes - a.limit));
}

export function activeVehiclesKpi(s: SimState): KpiModel {
  const fm = fleetMetrics(s, { from: s.minute - 60, to: s.minute, label: 'now' });
  const internal = Object.values(s.logistics.vehicles).filter((v) => v.class === 'internal').length;
  return {
    id: 'active-vehicles',
    label: 'Vehicles on site',
    value: fm.onSite + internal,
    display: int(fm.onSite + internal),
    unit: fm.onSite + internal === 1 ? 'vehicle' : 'vehicles',
    scope: `Now · ${formatClock(s.minute)}`,
    status: null,
    target: `${fm.onSite} truck${fm.onSite === 1 ? '' : 's'} · ${internal} internal`,
    why: `${fm.atDock} trucks at a dock, ${fm.waiting} waiting for one.`,
    definition: 'External trucks between gate-in and gate-out plus the internal fleet (forklifts and loader). Positions are simulated — no tracking system is connected.',
  };
}

export function delayedVehiclesKpi(s: SimState): KpiModel {
  const fm = fleetMetrics(s, { from: s.minute - 60, to: s.minute, label: 'now' });
  const delayed = delayedTrucks(s);
  const n = delayed.length;
  // Trucks in the dock queue plus trucks past a limit, each counted once.
  const waitingIds = externalVehicles(s)
    .filter((v) => v.visit!.gateIn <= s.minute && v.visit!.gateOut == null && v.phase === 'waiting' && s.minute - v.visit!.gateIn <= staleVisitLimit(s.rules))
    .map((v) => v.id);
  const total = new Set([...delayed.map((d) => d.id), ...waitingIds]).size;
  return {
    id: 'delayed-vehicles',
    label: 'Waiting or delayed',
    value: total,
    display: int(total),
    unit: total === 1 ? 'truck' : 'trucks',
    scope: `Now · ${formatClock(s.minute)}`,
    target: `${fm.waiting} in the dock queue`,
    status: { tone: n === 0 ? (fm.waiting >= s.rules.yardQueueMax ? 'warning' : 'good') : 'warning', label: n === 0 ? 'None past a limit' : `${n} past a limit` },
    why: n ? `${delayed[0].label}: ${delayed[0].reason.toLowerCase()} ${int(delayed[0].minutes)} min (limit ${delayed[0].limit}).` : 'No truck has exceeded the waiting, dock or turnaround limit.',
    definition: `Trucks waiting for a dock, plus trucks past a limit: waiting > ${s.rules.truckWaitMax} min, at the dock > ${s.rules.dockStayMax} min or on site > ${s.rules.turnaroundMax} min (event rules).`,
  };
}

export function avgDwellKpi(s: SimState, p: Period): KpiModel {
  const fm = fleetMetrics(s, p);
  const definition = 'Average time on site (gate-in to gate-out) of the truck visits completed in the period.';
  if (fm.avgTurnaround == null)
    return { id: 'avg-dwell', label: 'Average truck dwell', value: null, display: '—', scope: `${periodScope(s, p)} · completed visits`, status: null, why: '', definition, unavailable: 'No truck visit has been completed in this period yet.' };
  const over = fm.avgTurnaround > s.rules.turnaroundMax;
  return {
    id: 'avg-dwell',
    label: 'Average truck dwell',
    value: fm.avgTurnaround,
    display: int(fm.avgTurnaround),
    unit: 'min',
    scope: `${periodScope(s, p)} · completed visits`,
    target: `Limit ${s.rules.turnaroundMax} min`,
    status: { tone: over ? 'warning' : 'good', label: over ? 'Above turnaround limit' : 'Within limit' },
    why: fm.avgWaiting != null ? `Of which ≈ ${int(fm.avgWaiting)} min waiting for a dock (outbound).` : 'Gate-in to gate-out.',
    definition,
  };
}

export function completedTripsKpi(s: SimState, p: Period): KpiModel {
  const fm = fleetMetrics(s, p);
  return {
    id: 'completed-trips',
    label: 'Completed truck visits',
    value: fm.completedVisits,
    display: int(fm.completedVisits),
    unit: fm.completedVisits === 1 ? 'visit' : 'visits',
    scope: periodScope(s, p),
    target: `${fm.gateIn} gate-ins in the period`,
    status: null,
    why: 'Trucks that have left the site in the period (gate-out).',
    definition: 'Truck visits with a gate-out in the period (inbound raw material and outbound dispatch).',
  };
}

// ── Sets per workspace ───────────────────────────────────────────────────────

/** The five Overview KPIs. */
export function overviewKpis(s: SimState, p: Period): KpiModel[] {
  const lm = lineMetrics(s, p);
  return [goodOutputKpi(s, p, lm), targetAttainmentKpi(s, p, lm), factoryOeeKpi(s, p, lm), firstPassQualityKpi(s, p), activeIssuesKpi(s)];
}

/** The five Production KPIs. */
export function productionKpis(s: SimState, p: Period): KpiModel[] {
  const lm = lineMetrics(s, p);
  return [goodOutputKpi(s, p, lm), targetAttainmentKpi(s, p, lm), productionRateKpi(s), rejectRateKpi(s, p), constraintDowntimeKpi(s, p, lm)];
}

/** The Quality KPIs (inspected, defective, rate via first-pass quality, top defect). */
export function qualityKpis(s: SimState, p: Period): KpiModel[] {
  return [inspectedKpi(s, p), defectiveKpi(s, p), firstPassQualityKpi(s, p), topDefectKpi(s, p)];
}

/** The four Fleet KPIs. */
export function fleetKpis(s: SimState, p: Period): KpiModel[] {
  return [activeVehiclesKpi(s), delayedVehiclesKpi(s), avgDwellKpi(s, p), completedTripsKpi(s, p)];
}
