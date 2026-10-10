/**
 * Pure helpers for the Energy Intelligence workspace. Every figure still comes from
 * src/sim/metrics.ts (energyIn, energyTrend, kilnIdleBurn); these only window, rank,
 * pro-rate or format them for display.
 */
import type { Insight } from '../../intel/insights';
import { M2_PER_TILE, TARGET } from '../../model/plant';
import { CONSUMER_BY_ID, type Tariffs } from '../../sim/energy';
import type { SimState } from '../../sim/engine';
import { energyIn, energyTrend, kilnIdleBurn, lineGoodIn, sumBuckets, type EnergyRow, type Period } from '../../sim/metrics';
import { formatClock, formatDay } from '../../sim/time';

/** Deviation thresholds (share of the model): amber above 8 %, red above 15 %. */
export const WARN_DEV = 0.08;
export const SEVERE_DEV = 0.15;
/** Hours in a month of continuous (three-shift) operation, for "if sustained" projections. */
export const MONTH_HOURS = 24 * 30;

export type DevLevel = 'ok' | 'warning' | 'critical';
export const devLevel = (d: number | null | undefined): DevLevel =>
  d == null ? 'ok' : Math.abs(d) > SEVERE_DEV ? 'critical' : Math.abs(d) > WARN_DEV ? 'warning' : 'ok';
const LEVEL_RANK: Record<DevLevel, number> = { ok: 0, warning: 1, critical: 2 };
export const worstLevel = (a: DevLevel, b: DevLevel): DevLevel => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

/** Consumers with a thermal (natural-gas) supply; they also draw some electricity. */
export const isGas = (id: string) => !!CONSUMER_BY_ID[id]?.thermal;

// ── Formatting ───────────────────────────────────────────────────────────────

const money0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money amount without currency: two decimals below 10 so small hourly figures stay readable. */
export function fmtAmount(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—';
  const x = Math.abs(v) < 0.005 ? 0 : v;
  return Math.abs(x) < 10 ? money2.format(x) : money0.format(x);
}

/** "USD 1,234". */
export const fmtMoney = (v: number | null | undefined, currency: string) => (v == null || !Number.isFinite(v) ? '—' : `${currency} ${fmtAmount(v)}`);

/** Signed percentage, e.g. "+12.4 %" / "−3.0 %". */
export function fmtSigned(f: number | null | undefined, digits = 1) {
  if (f == null || !Number.isFinite(f)) return '—';
  const v = Math.abs(f * 100) < 0.5 * 10 ** -digits ? 0 : f * 100;
  return `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(digits)} %`;
}

/** Price / factor with up to three decimals (tariff inputs and the cost breakdown). */
export const fmtRate = (v: number) => v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

// ── Windows ──────────────────────────────────────────────────────────────────

/** Minutes into the hour before the "last hour" window drops the previous hour bucket. */
export const RECENT_MIN_MINUTES = 10;

/**
 * The "last hour" window: the current hourly energy bucket, plus the previous one during
 * the first 10 minutes of the hour (10–69 min of data). Energy is accounted in hourly
 * buckets, so windows start on an hour boundary.
 */
export function recentWindow(now: number): Period {
  const h = Math.floor(now / 60) * 60;
  const from = Math.max(0, now - h >= RECENT_MIN_MINUTES ? h : h - 60);
  return { from, to: now, label: `Since ${formatClock(from)}` };
}

// ── Anomalies ────────────────────────────────────────────────────────────────

export type AnomalyRow = {
  id: string;
  label: string;
  gas: boolean;
  period: EnergyRow;
  recent: EnergyRow;
  /** Deviation vs the energy model over the reporting period / the last hour. */
  periodDev: number | null;
  recentDev: number | null;
  level: DevLevel;
  /** Still deviating in the last hour (not only earlier in the period). */
  active: boolean;
  /** Period excess energy (kWh) and its cost. */
  excessKwh: number;
  excessCost: number;
  /** Last-hour excess cost rate, per hour; and per month if that rate is sustained. */
  excessCostPerH: number;
  projectedMonth: number | null;
  recommendation: string;
  /** 'insight' when an energy insight (last 2 h rule) backs it; 'early' while only the last hour shows it. */
  recommendationSource: 'insight' | 'early';
};

/**
 * Same investigation text as the energy insight rule (src/intel/insights.ts), used while
 * the deviation is visible in the last hour but not yet in the insight's 2-hour window.
 */
const FALLBACK_INVESTIGATION = {
  gas: 'Check combustion air/gas ratio, burner tuning and flue-gas O₂; inspect for air ingress and insulation damage.',
  electric: 'Check for compressed-air leaks, motor load and power factor; compare against the last service readings.',
};

/** Minimum model consumption for a deviation to count (keeps tiny loads from flagging on noise). */
const MIN_PERIOD_KWH = 20;
const MIN_RECENT_KWH = 5;

const flagged = (dev: number | null, expected: number, min: number) => dev != null && expected >= min && Math.abs(dev) > WARN_DEV;

/**
 * Consumers whose consumption deviates more than 8 % from the energy model over the period
 * or in the last hour. Recommendations come from the energy insights (rule-based).
 */
export function findAnomalies(s: SimState, p: Period, tariffs: Tariffs, energyInsights: Insight[]): AnomalyRow[] {
  const rw = recentWindow(s.minute);
  const hours = Math.max(1 / 60, (rw.to - rw.from) / 60);
  const per = energyIn(s, p, tariffs);
  const rec = energyIn(s, rw, tariffs);
  const out: AnomalyRow[] = [];
  per.rows.forEach((r, i) => {
    const q = rec.rows[i];
    const inPeriod = flagged(r.deviation, r.expected, MIN_PERIOD_KWH);
    const inRecent = flagged(q.deviation, q.expected, MIN_RECENT_KWH);
    if (!inPeriod && !inRecent) return;
    const perH = (q.cost - q.expectedCost) / hours;
    // The per-consumer anomaly insight (the kiln also carries an 'energy-kiln-idle' insight, which is not about deviation).
    const insight = energyInsights.find((x) => x.kind === 'energy' && x.id === `energy-${r.id}` && x.recommendation);
    out.push({
      id: r.id,
      label: r.label,
      gas: isGas(r.id),
      period: r,
      recent: q,
      periodDev: r.deviation,
      recentDev: q.deviation,
      level: worstLevel(inPeriod ? devLevel(r.deviation) : 'ok', inRecent ? devLevel(q.deviation) : 'ok'),
      active: inRecent,
      excessKwh: r.total - r.expected,
      excessCost: r.cost - r.expectedCost,
      excessCostPerH: perH,
      projectedMonth: inRecent ? perH * MONTH_HOURS : null,
      recommendation: insight?.recommendation ?? FALLBACK_INVESTIGATION[isGas(r.id) ? 'gas' : 'electric'],
      recommendationSource: insight ? 'insight' : 'early',
    });
  });
  const mag = (a: AnomalyRow) => Math.max(Math.abs(a.recentDev ?? 0), Math.abs(a.periodDev ?? 0));
  return out.sort((a, b) => Number(b.active) - Number(a.active) || mag(b) - mag(a));
}

/** The consumer closest to the threshold (for the "all within model" empty state). */
export function largestDeviation(rows: EnergyRow[]) {
  return rows.filter((r) => r.deviation != null && r.expected >= MIN_PERIOD_KWH).sort((a, b) => Math.abs(b.deviation!) - Math.abs(a.deviation!))[0] ?? null;
}

// ── Hourly series ────────────────────────────────────────────────────────────

const multiDay = (p: Period) => p.to - p.from > 26 * 60;
const hourLabel = (start: number, long: boolean) => (long ? `${formatDay(start).split(' ')[0].replace(',', '')} ${formatClock(start)}` : formatClock(start));

export type HourEnergy = {
  start: number;
  label: string;
  /** Minutes of data in the bucket (60 except for the in-progress hour). */
  minutes: number;
  actual: number;
  expected: number;
  /** kWh per hour: equals the bucket's kWh for complete hours, pro-rated for the in-progress hour. */
  actualRate: number;
  expectedRate: number;
};

/** Hourly actual vs model energy for the period (all consumers or one). */
export function hourlyEnergy(s: SimState, p: Period, id?: string): HourEnergy[] {
  const long = multiDay(p);
  return energyTrend(s, p, id)
    .map((h) => {
      const minutes = Math.min(60, Math.max(0, s.minute - h.start));
      const k = minutes > 0 ? 60 / minutes : 0;
      return { start: h.start, label: hourLabel(h.start, long), minutes, actual: h.actual, expected: h.expected, actualRate: h.actual * k, expectedRate: h.expected * k };
    })
    .filter((h) => h.minutes > 0);
}

export type HourSec = { start: number; label: string; sec: number | null; expectedSec: number | null; goodM2: number };

/**
 * Specific energy consumption per hour (kWh per good m²). Hours with less than a quarter
 * of the target output are left as gaps: the ratio is not meaningful there.
 */
export function secTrend(s: SimState, p: Period): HourSec[] {
  const long = multiDay(p);
  const targetM2PerMin = (TARGET.goodPerHour * M2_PER_TILE) / 60;
  return energyTrend(s, p)
    .map((h) => {
      const minutes = Math.min(60, Math.max(0, s.minute - h.start));
      const goodM2 = lineGoodIn(s, { from: h.start, to: h.start + 60, label: '' }) * M2_PER_TILE;
      const ok = minutes > 0 && goodM2 >= 0.25 * targetM2PerMin * minutes;
      return { start: h.start, label: hourLabel(h.start, long), minutes, sec: ok ? h.actual / goodM2 : null, expectedSec: ok ? h.expected / goodM2 : null, goodM2 };
    })
    .filter((h) => h.minutes > 0);
}

// ── Kiln idle burn ───────────────────────────────────────────────────────────

/** Gas the kiln burnt without output (starved / blocked) and what it cost. */
export function kilnIdle(s: SimState, p: Period, tariffs: Tariffs) {
  const kwh = kilnIdleBurn(s, p);
  const t = sumBuckets(s, 'H-KILN', p);
  const e = energyIn(s, p, tariffs);
  const kiln = e.rows.find((r) => r.id === 'H-KILN');
  return {
    kwh,
    cost: kwh * tariffs.gas,
    co2Kg: kwh * tariffs.co2Gas,
    starvedMin: t.starved,
    blockedMin: t.blocked,
    plannedMin: t.planned,
    /** Share of the kiln's gas in the period burnt while idle. */
    shareOfKilnGas: kiln && kiln.thermal > 0 ? kwh / kiln.thermal : null,
    /** kWh per good m² the idle burn adds to the plant SEC. */
    secPenalty: e.goodM2 > 0 ? kwh / e.goodM2 : null,
  };
}

// ── Scenario presets ─────────────────────────────────────────────────────────

export const ANOMALY_CONSUMERS: { id: string; cause: string }[] = [
  { id: 'H-KILN', cause: 'Kiln combustion-air drift' },
  { id: 'D-HAG', cause: 'Hot-air generator burner fouling' },
  { id: 'A-COMP', cause: 'Compressed-air leakage' },
  { id: 'C-BM2', cause: 'Ball mill 2 overload' },
];
export const ANOMALY_FACTORS = [1.1, 1.2, 1.35];

export const anomalyLabel = (id: string, factor: number) =>
  `${ANOMALY_CONSUMERS.find((c) => c.id === id)?.cause ?? `${id} consumption drift`} +${Math.round((factor - 1) * 100)} %`;

// ── Tariff input parsing ─────────────────────────────────────────────────────

/** A non-negative decimal (comma or point) up to `max`; null when not a valid entry. */
export function parseAmount(raw: string, max: number): number | null {
  const t = raw.trim().replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= 0 && v <= max ? v : null;
}

/** ISO-4217-style three-letter code, upper-cased; null when invalid. */
export function parseCurrency(raw: string): string | null {
  const t = raw.trim();
  return /^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : null;
}

export const sameTariffs = (a: Tariffs, b: Tariffs) =>
  a.currency === b.currency && a.electricity === b.electricity && a.gas === b.gas && a.co2Electricity === b.co2Electricity && a.co2Gas === b.co2Gas;
