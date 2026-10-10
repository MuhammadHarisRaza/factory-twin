/**
 * Small pure helpers for the Production & OEE workspace. All figures still come from
 * src/sim/metrics.ts; these only bucket, filter or project them for display.
 */
import { M2_PER_TILE, OPS_BY_ID, REASON_BY_CODE, TARGET } from '../../model/plant';
import type { DowntimeCategory, DowntimeEvent } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { downtimeIn, downtimePareto, hourlyTrend, lineGoodIn, lineMetrics, sumBuckets, type ParetoRow, type Period } from '../../sim/metrics';
import { formatClock, formatDay, shiftAt } from '../../sim/time';

export type Granularity = 'hour' | 'shift';

/** Hourly up to ~a day; shift buckets for the 7-day window so the charts stay readable. */
export const granularityFor = (p: Period): Granularity => (p.to - p.from > 26 * 60 ? 'shift' : 'hour');

type Slot = { key: string; from: number; to: number; label: string; tip: string; partial: boolean };

function slots(p: Period, g: Granularity): Slot[] {
  const out: Slot[] = [];
  if (g === 'hour') {
    for (let h = Math.floor(p.from / 60) * 60; h < p.to; h += 60) {
      const to = Math.min(h + 60, p.to);
      out.push({ key: String(h), from: Math.max(h, p.from), to, label: formatClock(h), tip: `${formatDay(h)} ${formatClock(h)}–${formatClock(h + 60)}`, partial: to < h + 60 });
    }
    return out;
  }
  let sh = shiftAt(p.from);
  while (sh.start < p.to) {
    const from = Math.max(sh.start, p.from);
    const to = Math.min(sh.end, p.to);
    out.push({
      key: String(sh.start),
      from,
      to,
      label: `${formatDay(sh.start).split(' ')[0].replace(',', '')} ${sh.id}`,
      tip: `${formatDay(sh.start)} · ${sh.label}`,
      partial: from > sh.start || to < sh.end,
    });
    sh = shiftAt(sh.end);
  }
  return out;
}

export type TrendBucket = { key: string; label: string; tip: string; partial: boolean; outputM2: number; targetM2: number; oee: number | null };

/** Line output vs target and OEE per bucket (hourlyTrend for hours, lineMetrics per shift otherwise). */
export function lineTrend(s: SimState, p: Period, g: Granularity): TrendBucket[] {
  const sl = slots(p, g);
  if (g === 'hour') {
    const pts = new Map(hourlyTrend(s, p).map((h) => [h.start, h]));
    return sl.map((x) => {
      const h = pts.get(Number(x.key));
      return {
        key: x.key,
        label: x.label,
        tip: x.tip,
        partial: x.partial,
        outputM2: (h?.output ?? 0) * M2_PER_TILE,
        targetM2: (h?.target ?? 0) * M2_PER_TILE,
        oee: h?.oee ?? null,
      };
    });
  }
  return sl.map((x) => {
    const lm = lineMetrics(s, { from: x.from, to: x.to, label: x.tip });
    return {
      key: x.key,
      label: x.label,
      tip: x.tip,
      partial: x.partial,
      outputM2: lm.outputM2,
      targetM2: lm.targetM2,
      oee: lm.oee.oee.status === 'ok' ? lm.oee.oee.value : null,
    };
  });
}

export type MachineBucket = { key: string; label: string; tip: string; outputM2: number; idealM2: number; plannedMin: number };

/** A machine's output vs its ideal-rate output over planned time, per bucket. */
export function machineTrend(s: SimState, id: string, p: Period, g: Granularity): MachineBucket[] {
  const ideal = OPS_BY_ID[id].idealRatePerHour ?? 0;
  return slots(p, g).map((x) => {
    const t = sumBuckets(s, id, { from: x.from, to: x.to, label: '' });
    return { key: x.key, label: x.label, tip: x.tip, outputM2: t.count * M2_PER_TILE, idealM2: ((ideal * t.planned) / 60) * M2_PER_TILE, plannedMin: t.planned };
  });
}

/** End-of-shift projection at the shift-to-date average rate. Null in the first 15 minutes. */
export function shiftProjection(s: SimState, outputTiles: number) {
  const sh = shiftAt(s.minute);
  const elapsed = s.minute - sh.start;
  if (elapsed < 15) return null;
  const perMin = outputTiles / elapsed;
  const projected = outputTiles + perMin * (sh.end - s.minute);
  const target = (TARGET.goodPerHour * (sh.end - sh.start)) / 60;
  return { projectedM2: projected * M2_PER_TILE, targetM2: target * M2_PER_TILE, attainment: projected / target, rateM2h: perMin * 60 * M2_PER_TILE, endsAt: sh.end };
}

/** Last complete plant hour: output and target. */
export function lastFullHour(s: SimState) {
  const h = Math.floor(s.minute / 60) - 1;
  const p: Period = { from: h * 60, to: h * 60 + 60, label: '' };
  const spark: number[] = [];
  for (let i = 7; i >= 0; i--) spark.push(lineGoodIn(s, { from: (h - i) * 60, to: (h - i) * 60 + 60, label: '' }) * M2_PER_TILE);
  return { from: p.from, outputM2: lineGoodIn(s, p) * M2_PER_TILE, targetM2: TARGET.goodPerHour * M2_PER_TILE, spark };
}

// ── Downtime filtering ────────────────────────────────────────────────────────

export type EventFilter = {
  category: DowntimeCategory | 'all';
  equipmentId: string | 'all';
  reason: string | null;
  /** Include starved/blocked (process-interaction) events. */
  includeFlow: boolean;
};

export const isFlow = (c: DowntimeCategory) => c === 'Starved' || c === 'Blocked';

/** Downtime events in the period matching the filter: active first, then newest first. */
export function filterEvents(s: SimState, p: Period, f: EventFilter): DowntimeEvent[] {
  return downtimeIn(s, p)
    .filter(
      (d) =>
        (f.includeFlow || !isFlow(d.category)) &&
        (f.category === 'all' || d.category === f.category) &&
        (f.equipmentId === 'all' || d.equipmentId === f.equipmentId) &&
        (f.reason == null || d.reasonCode === f.reason),
    )
    .sort((a, b) => (a.end == null ? 0 : 1) - (b.end == null ? 0 : 1) || b.start - a.start);
}

/** Pareto by reason with the category / machine filter applied; shares recomputed within the subset. */
export function filteredPareto(s: SimState, p: Period, f: EventFilter): ParetoRow[] {
  const rows = downtimePareto(s, p, { includeFlow: f.includeFlow, equipmentId: f.equipmentId === 'all' ? undefined : f.equipmentId })
    .filter((r) => f.category === 'all' || r.category === f.category)
    .map((r) => ({ ...r }));
  const total = rows.reduce((a, r) => a + r.minutes, 0);
  let cum = 0;
  for (const r of rows) {
    r.share = total > 0 ? r.minutes / total : 0;
    cum += r.share;
    r.cumulative = cum;
  }
  return rows;
}

export const reasonLabel = (code: string) => REASON_BY_CODE[code]?.label ?? code;
