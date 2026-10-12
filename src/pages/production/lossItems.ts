/**
 * The quantified losses shown first on Plan & flow (capacity steps, m²) and on OEE & losses (OEE
 * categories, kiln minutes): for each the affected stage, duration or lost units, the estimated
 * value with its basis, the related event record and a suggested investigation. Pure functions over
 * the one SimState; every quantity comes from src/sim/metrics.ts (capacityBreakdown, the kiln time
 * accounting, the OEE loss tree) and the loss ledger (src/pages/production/loss.ts).
 */
import { DEFECTS, DEFECT_ORDER, M2_PER_TILE, MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { DefectCategory, MonitoredStageId, OpEvent, RecordSource } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { lostOutputValue, type FinanceAssumptions, type MoneyLine } from '../../sim/finance';
import { lineLossTree, qualityIn, type Period } from '../../sim/metrics';
import { KILN, lossLedger, qualityLossValue, type LossLedger } from './loss';
import { assetStage, monitoredStageOf } from './stage/derive';

const n0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const pctS = (f: number | null | undefined, d = 0) => (f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(d)} %`);
const minS = (v: number) => `${n0.format(Math.round(v))} min`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const overlap = (e: OpEvent, p: Period, now: number) => Math.max(0, Math.min(e.end ?? now, p.to) - Math.max(e.start, p.from));

export type LossItem = {
  key: 'planned' | 'availability' | 'avail-own' | 'avail-held' | 'speed' | 'quality';
  /** Loss category in words. */
  category: string;
  /** Short name for sentences, e.g. "kiln speed loss". */
  short: string;
  /** Stage the loss is charged to (measured there, or caused there). */
  stage: MonitoredStageId | null;
  stageName: string;
  /** Asset or measuring point, e.g. "H-KILN · Roller kiln". */
  where: string;
  /** Kiln minutes behind the loss (or the minute equivalent at the design rate), null where not a time loss. */
  minutes: number | null;
  minutesLabel: string | null;
  /** Lost units (tiles) and their area. */
  tiles: number;
  m2: number;
  /** OEE points lost (OEE categories only): minutes ÷ planned kiln time. */
  pts: number | null;
  /** Estimated value (null = deliberately not valued) and how it was valued. */
  value: number | null;
  lines: MoneyLine[];
  valueNote: string;
  /** Related event record (the largest one), or why there is none. */
  event: { id: string; title: string; source: RecordSource } | null;
  eventNote: string | null;
  /** Observed facts behind the figure. */
  facts: string[];
  investigation: string;
  /** Quality losses link to Quality & Defects. */
  quality: boolean;
};

const total = (lines: MoneyLine[]) => lines.reduce((a, l) => a + l.amount, 0);
const stageName = (id: MonitoredStageId | null) => (id ? MONITORED_STAGE_BY_ID[id].name : '—');

/** Event of the kiln's own stops with the most minutes inside the period. */
function kilnStopEvent(s: SimState, p: Period): OpEvent | null {
  const list = s.events
    .filter((e) => e.asset.equipmentId === KILN && (e.type === 'machine-fault' || e.type === 'machine-stop') && overlap(e, p, s.minute) > 0)
    .sort((a, b) => overlap(b, p, s.minute) - overlap(a, p, s.minute));
  return list[0] ?? null;
}

const eventRef = (e: OpEvent | null | undefined) => (e ? { id: e.id, title: e.title, source: e.source } : null);

/** Shared facts about the period, computed once for both loss lists. */
function context(s: SimState, p: Period, f: FinanceAssumptions, L: LossLedger = lossLedger(s, p, f)) {
  const k = L.lm.constraint.totals;
  const att = L.attribution;
  const idealPerMin = L.idealPerHour / 60;
  const rootCause = att.causes[0] ?? null;
  const rootEv = rootCause ? (s.events.find((e) => e.id === rootCause.eventIds[0]) ?? null) : null;
  const kilnEv = kilnStopEvent(s, p);
  const ownReason = att.kilnReasons[0] ?? null;
  const belowRate = s.events
    .filter((e) => e.asset.equipmentId === KILN && e.type === 'below-rate' && overlap(e, p, s.minute) > 0)
    .sort((a, b) => overlap(b, p, s.minute) - overlap(a, p, s.minute))[0];
  const q = qualityIn(s, p);
  const topDefect = (DEFECT_ORDER.map((d) => [d, q.byDefect[d] ?? 0]) as [DefectCategory, number][]).sort((a, b) => b[1] - a[1])[0];
  const qualityEv = s.events
    .filter((e) => e.category === 'quality' && !e.consequenceOf && overlap(e, p, s.minute) > 0)
    .sort((a, b) => b.acc.rejects - a.acc.rejects || b.start - a.start)[0];
  const speedTiles = Math.max(0, idealPerMin * k.operating - k.count);
  return { L, k, att, idealPerMin, rootCause, rootEv, kilnEv, ownReason, belowRate, q, topDefect, qualityEv, speedTiles };
}
type Ctx = ReturnType<typeof context>;

const kilnWhere = 'H-KILN · roller kiln';

function ownStops(c: Ctx, f: FinanceAssumptions, pts: number | null): LossItem {
  const { k, ownReason, kilnEv, idealPerMin, L } = c;
  const tiles = idealPerMin * k.down;
  const lines = [lostOutputValue(f, tiles * L.fpyUsed)];
  return {
    key: 'avail-own',
    category: 'Availability — kiln stops',
    short: 'kiln stops',
    stage: 'KILN',
    stageName: stageName('KILN'),
    where: kilnWhere,
    minutes: k.down,
    minutesLabel: `${minS(k.down)} stopped`,
    tiles,
    m2: tiles * M2_PER_TILE,
    pts,
    value: total(lines),
    lines,
    valueNote: `Lost kiln tiles × first-pass yield ${pctS(L.fpyUsed, 1)} at contribution`,
    event: eventRef(kilnEv),
    eventNote: kilnEv ? null : 'No stop event overlaps the period',
    facts: k.down >= 0.5 ? [`The kiln itself was stopped (unplanned) ${minS(k.down)}${ownReason ? ` — largest reason: ${lower(ownReason.label)} ${minS(ownReason.minutes)}` : ''}.`] : [],
    investigation: ownReason ? `Review the kiln stop records (${lower(ownReason.label)}) and the time to restart; every kiln minute lost is line output lost.` : 'Review the kiln stop records and the time to restart.',
    quality: false,
  };
}

function heldUp(c: Ctx, f: FinanceAssumptions, pts: number | null): LossItem {
  const { k, rootCause, rootEv, att, idealPerMin, L } = c;
  const held = k.starved + k.blocked;
  const tiles = idealPerMin * held;
  const lines = [lostOutputValue(f, tiles * L.fpyUsed)];
  const st = rootCause ? assetStage(rootCause.equipmentId) : 'KILN';
  return {
    key: 'avail-held',
    category: 'Availability — kiln starved / blocked',
    short: 'kiln waiting on other stages',
    stage: st,
    stageName: stageName(st),
    where: rootCause ? `${rootCause.equipmentId} · ${rootCause.name} (root cause, from event records)` : `${kilnWhere} (no single root event recorded)`,
    minutes: held,
    minutesLabel: `${minS(held)} waiting`,
    tiles,
    m2: tiles * M2_PER_TILE,
    pts,
    value: total(lines),
    lines,
    valueNote: `Lost kiln tiles × first-pass yield ${pctS(L.fpyUsed, 1)} at contribution`,
    event: eventRef(rootEv),
    eventNote: rootEv ? null : 'No root event recorded for these minutes',
    facts: [
      ...(held >= 0.5 ? [`The kiln waited ${minS(k.starved)} for tiles and ${minS(k.blocked)} for outlet space.`] : []),
      ...(rootCause ? [`${rootCause.equipmentId} held it up ${minS(rootCause.minutes)}${rootCause.reasons[0] ? ` — ${lower(rootCause.reasons[0].label)}` : ''}${att.causes.length > 1 ? `; ${att.causes.length - 1} other asset${att.causes.length > 2 ? 's' : ''} recorded` : ''}.`] : []),
      ...(att.unattributedMin >= 1 ? [`${minS(att.unattributedMin)} not explained by a recorded root event.`] : []),
    ],
    investigation: rootCause
      ? `Review why ${rootCause.equipmentId} stopped and whether the buffer between it and the kiln can cover a stop of that length.`
      : 'Check the buffers either side of the kiln and the stages feeding and clearing it.',
    quality: false,
  };
}

function speed(c: Ctx, f: FinanceAssumptions, pts: number | null, minutes: number): LossItem {
  const { k, idealPerMin, belowRate, L, speedTiles } = c;
  const lines = [lostOutputValue(f, speedTiles * L.fpyUsed)];
  const perf = k.operating > 0 ? k.count / (idealPerMin * k.operating) : null;
  return {
    key: 'speed',
    category: 'Performance — kiln speed loss',
    short: 'kiln speed loss',
    stage: 'KILN',
    stageName: stageName('KILN'),
    where: kilnWhere,
    minutes,
    minutesLabel: `≈ ${minS(minutes)} at design rate`,
    tiles: speedTiles,
    m2: speedTiles * M2_PER_TILE,
    pts,
    value: total(lines),
    lines,
    valueNote: `Lost kiln tiles × first-pass yield ${pctS(L.fpyUsed, 1)} at contribution`,
    event: eventRef(belowRate),
    eventNote: belowRate ? null : 'No below-rate event: the kiln stayed above the alert threshold — a steady speed loss',
    facts: [
      `While operating ${minS(k.operating)} the kiln fired ${n0.format(k.count)} tiles vs ${n0.format(idealPerMin * k.operating)} at its design rate of ${n0.format(L.idealPerHour)} tiles/h (${pctS(perf, 1)}).`,
    ],
    investigation: `Compare the kiln's running speed with its design rate of ${n0.format(L.idealPerHour)} tiles/h. Roller-speed and firing-curve setpoints are not in the model (unavailable).`,
    quality: false,
  };
}

function rejects(c: Ctx, f: FinanceAssumptions, pts: number | null, minutes: number | null): LossItem {
  const { L, q, topDefect, qualityEv } = c;
  const lines = qualityLossValue(f, L.lm.rejected);
  const origin = topDefect && topDefect[1] > 0 ? DEFECTS[topDefect[0]] : null;
  const originStage = origin ? monitoredStageOf(origin.origin) : null;
  return {
    key: 'quality',
    category: 'Quality — rejects at sorting',
    short: 'rejects at sorting',
    stage: 'SORT',
    stageName: stageName('SORT'),
    where: 'Gauge + vision inspection (detection point)',
    minutes,
    minutesLabel: minutes != null ? `≈ ${minS(minutes)} of kiln time` : null,
    tiles: L.lm.rejected,
    m2: L.lm.rejected * M2_PER_TILE,
    pts,
    value: total(lines),
    lines,
    valueNote: `Scrapped ${pctS(1 - f.reworkShare)} at sunk cost + lost contribution; reworked ${pctS(f.reworkShare)} at rework cost`,
    event: eventRef(qualityEv),
    eventNote: qualityEv ? null : 'No quality event overlaps the period — rejects stayed within the alert rules',
    facts: [
      `${n0.format(L.lm.rejected)} of ${n0.format(q.inspected)} inspected tiles rejected (${pctS(q.inspected > 0 ? L.lm.rejected / q.inspected : null, 2)}; simulated classification).`,
      ...(origin && topDefect
        ? [`Most frequent: ${lower(origin.label)} ${n0.format(topDefect[1])} tiles — modeled origin ${lower(stageName(originStage))} (a hypothesis to check, not a confirmed cause).`]
        : []),
    ],
    investigation: origin ? `Open the defect evidence in Quality & Defects and check ${lower(stageName(originStage))} for ${lower(origin.label)}.` : 'Open the defect evidence in Quality & Defects.',
    quality: true,
  };
}

function plannedStops(c: Ctx, m2: number): LossItem {
  const { k } = c;
  return {
    key: 'planned',
    category: 'Planned stops at the kiln',
    short: 'planned kiln stops',
    stage: 'KILN',
    stageName: stageName('KILN'),
    where: kilnWhere,
    minutes: k.plannedStop,
    minutesLabel: `${minS(k.plannedStop)} planned`,
    tiles: m2 / M2_PER_TILE,
    m2,
    pts: null,
    value: null,
    lines: [],
    valueNote: 'Not valued — planned stops are part of the plan, not a shortfall',
    event: null,
    eventNote: 'Planned stop (cleaning or maintenance order) — no event is raised',
    facts: [`${minS(k.plannedStop)} of planned stops; the plan does not accrue during them.`],
    investigation: 'Confirm that the planned window matches the maintenance or cleaning order.',
    quality: false,
  };
}

/**
 * Production losses for Plan & flow: the loss steps of the core capacity breakdown (planned stops,
 * availability, speed, quality — the signed "in transit" step is not a loss), in m² at the kiln,
 * largest first. Availability is one step here; its facts split it into the kiln's own stops and the
 * minutes it was held up by other stages.
 */
export function productionLosses(s: SimState, p: Period, f: FinanceAssumptions, L?: LossLedger): LossItem[] {
  const c = context(s, p, f, L);
  const capLoss = (key: string) => c.L.cap.losses.find((l) => l.key === key && l.kind === 'loss')?.m2 ?? 0;
  const items: LossItem[] = [];
  const planned = capLoss('planned');
  if (planned > 0) items.push(plannedStops(c, planned));
  const avail = capLoss('availability');
  if (avail > 0) {
    const own = ownStops(c, f, null);
    const held = heldUp(c, f, null);
    // Charged to the largest single contributor: the kiln's own stops, or the root asset that held it up longest.
    const heldMin = c.k.starved + c.k.blocked;
    const main = c.k.down >= heldMin || (c.rootCause != null && c.rootCause.minutes < c.k.down) ? own : held;
    items.push({
      ...main,
      key: 'availability',
      category: 'Downtime at the kiln (availability)',
      short: 'kiln downtime',
      minutes: c.k.planned - c.k.operating,
      minutesLabel: `${minS(c.k.planned - c.k.operating)} without output`,
      tiles: avail / M2_PER_TILE,
      m2: avail,
      value: total([...own.lines, ...held.lines]),
      lines: [...own.lines.map((l) => ({ ...l, label: `Kiln stops: ${lower(l.label)}` })), ...held.lines.map((l) => ({ ...l, label: `Kiln held up: ${lower(l.label)}` }))],
      facts: [...own.facts, ...held.facts],
    });
  }
  const sp = capLoss('speed');
  if (sp > 0) items.push(speed(c, f, null, c.speedTiles / c.idealPerMin));
  const ql = capLoss('quality');
  if (ql > 0) items.push(rejects(c, f, null, null));
  return items.filter((x) => x.m2 >= 0.5).sort((a, b) => b.m2 - a.m2);
}

/**
 * OEE loss categories at the line constraint, in minutes of planned kiln time (from the OEE loss
 * tree): availability split into the kiln's own stops and starved / blocked time, performance
 * (speed) and quality. Points = minutes ÷ planned time × 100, so the points of all categories add
 * up to 100 − OEE. Largest first.
 */
export function oeeLosses(s: SimState, p: Period, f: FinanceAssumptions, L?: LossLedger): LossItem[] {
  const c = context(s, p, f, L);
  const tree = lineLossTree(s, p);
  const planned = c.k.planned;
  if (!tree || planned <= 0) return [];
  const pts = (min: number) => (min / planned) * 100;
  const held = c.k.starved + c.k.blocked;
  const items = [
    ownStops(c, f, pts(c.k.down)),
    heldUp(c, f, pts(held)),
    speed(c, f, pts(tree.performanceLoss), tree.performanceLoss),
    rejects(c, f, pts(tree.qualityLoss), tree.qualityLoss),
  ];
  return items.filter((x) => (x.minutes ?? 0) >= 0.05).sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0));
}
