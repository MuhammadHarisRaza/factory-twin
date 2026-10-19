/**
 * Equipment-specific KPIs for the equipment workspace (master prompt §7, "Context-sensitive KPIs").
 * Three to five figures per asset, chosen by its stage and type, computed only from what the
 * simulation actually holds: machine metrics (counts, availability, own stops), the asset's rate
 * signal, conveyor metrics, inspection counters per station, buffer levels and the logistics state.
 * A parameter the model does not contain (kiln temperature profile, powder moisture, slip density…)
 * is returned as `unavailable` with `notModelled: true` and the reason — never a plausible number.
 * Headline figures that already exist as shared KPIs (first-pass quality, truck dwell, delayed
 * trucks) come from src/intel/kpis.ts so they read the same everywhere.
 */
import { BUFFERS, BUFFER_LEVEL_SIGNAL, CONVEYOR_BY_ID, DEFECTS, DOCKS, INSPECTION_STATIONS, LINE, M2_PER_TILE, MONITORED_STAGE_BY_ID, OPS_BY_ID, REASON_BY_CODE, STAGES, STAGE_BY_ID, TILES_PER_PALLET } from '../../model/plant';
import type { DefectCategory, MonitoredStageId, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import type { Metric } from '../../sim/oee';
import { avgDwellKpi, delayedVehiclesKpi, feedStaleSince, firstPassQualityKpi, type KpiModel } from '../../intel/kpis';
import { clockLabel, constraintClaim, type ConstraintClaim } from '../../intel/summary';
import {
  OPERATIONAL_STATE_LABEL,
  clippedDuration,
  conveyorMetrics,
  externalVehicles,
  fleetMetrics,
  internalActivity,
  lineMetrics,
  machineMetrics,
  operationalState,
  qualityIn,
  resolvePeriod,
  stageIO,
  visitDurations,
  type Period,
} from '../../sim/metrics';
import { phaseLabel, type TruckRuntime } from '../../sim/logistics';
import { formatClock, formatDuration } from '../../sim/time';
import type { Tone } from '../kit/Status';
import { counterRate, rejectRate, seriesToSamples, setpointDeviation, timeToEmpty, timeToFull, trendSlope } from '../../calc';
import { KG_PER_TILE, KILN_ZONES, PROCESS_SIGNAL_BY_ID, TILES_PER_CARTON, definitionOf } from '../../model/catalog';
import { readSignal, seriesOf } from '../../sim/telemetry';
import { feedWord, outputMachines } from '../flow/derive';
import { vehicleGeofence } from '../twin/derive';
import { assetProfile, type AssetProfile } from './profile';

export type EqKpi = {
  key: string;
  label: string;
  /** Formatted value without unit; absent when unavailable. */
  value?: string;
  unit?: string;
  /** Comparison or context (ideal rate, share, "of N"). */
  sub?: string;
  /** Short status, always words (+ the tile's icon), never colour alone. */
  status?: { tone: Tone; label: string } | null;
  /** How the figure is calculated (shown on hover / focus). */
  hint: string;
  /** Why no value is shown. */
  unavailable?: string;
  /** True when the parameter does not exist in the simulation at all (vs. "no data in this period yet"). */
  notModelled?: boolean;
  /**
   * Optional (added): the tile's own time context when it differs from the set's scope — "now", "last 60 min",
   * "last value 10:20" (instantaneous readings next to shift figures).
   */
  window?: string;
};

export type EqKpiSet = {
  /** Time scope of the set, e.g. "Shift B · 14:00–22:00". */
  scope: string;
  kpis: EqKpi[];
  /** Shown instead of tiles when the asset has no operating data at all. */
  note?: string;
  /** Earliest minute a data feed the set's figures rest on went stale (null = every feed fresh). */
  staleSince?: number | null;
  /** The stale mark of the set (KpiTiles shows it above the tiles). */
  stale?: StaleMark | null;
};

/**
 * One rule for a stale data feed (every surface): aggregate figures keep the simulation's running
 * accounting — the same number as the KPI cards, the flow strip and Production — and carry the mark
 * "Not confirmed · <asset> data stale since hh:mm"; raw signal values (a rate "now") show the frozen
 * last value received instead.
 */
export type StaleMark = {
  /** Earliest minute one of the feeds went stale. */
  since: number;
  /** Assets whose feed is stale. */
  assetIds: string[];
  /** "Not confirmed · E-PRS1 data stale since 10:20". */
  label: string;
  /** What that means for the figures shown (one sentence, lower-case start). */
  note: string;
};

/** Status of a tile whose figure rests on a stale feed (the KPI cards' tone: neutral, in words). */
export const NOT_CONFIRMED: Readonly<{ tone: Tone; label: string }> = { tone: 'neutral', label: 'Not confirmed' };

/** Reasons for parameters the simulation does not contain. Exported so tests and the UI say the same thing. */
export const NOT_MODELLED = {
  slipDensity: 'Not in the model: slip density is only recorded as a stop reason (“slip density out of spec”), never as a measured value.',
  powderMoisture:
    'Not in the model: the simulation has no drying model, so powder moisture is not calculated. The D-TWR.powder_moisture signal is listed under Technical details without a value.',
  dryerConditions:
    'Not in the model: there is no thermal model of the dryer, so deck temperature and drying time are not calculated. The F-DRY.temp_deck signal is listed under Technical details without a value.',
  kilnProfile:
    'Not in the model: there is no thermal model of the kiln, so the firing temperature profile and the firing-cycle time are not calculated. The temp_firing / temp_preheat signals are listed under Technical details without a value (no physical model behind them).',
  feedRate: 'Not in the model: box-feeder weighing is not integrated; the mills are fed continuously in the simulation.',
  rawStock: 'Not in the model: stockpile quantities are not tracked; raw-material supply never limits the simulated line.',
  incomingQuality: 'Not in the model: no incoming-material inspection is recorded.',
  qcCounts: 'Not in the model: the QC bench takes manual samples and has no tile counters.',
  siloMass: 'Not in the model: the mass in the silos needs a level-to-mass calibration (D-SILO.powder_mass) — none is configured, so only the level % is shown.',
  tankMass: 'Not in the model: the slip volume / mass needs a level-to-mass calibration — none is configured, so only the level % is shown.',
} as const;

/** Set-level note for assets without any simulated operation. */
export const NO_OPERATING_DATA = 'No operating data is simulated for this asset — it is part of the 3D model for spatial context. Its register data is under Technical details.';

const int = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-GB'));
const pct1 = (f: number) => (f * 100).toFixed(1);
const pct0 = (f: number) => (f * 100).toFixed(0);
const hoursOf = (p: Period) => Math.max(1 / 60, (p.to - p.from) / 60);

const na = (key: string, label: string, reason: string, hint: string): EqKpi => ({ key, label, unavailable: reason, notModelled: true, hint });
const noData = (key: string, label: string, reason: string, hint: string): EqKpi => ({ key, label, unavailable: reason, hint });

/** Clock time, with the date when it is not today. */
const clockOf = clockLabel;

/** Assets of `ids` whose data feed is stale inside the period, with the minute it went stale. */
const staleFeeds = (s: SimState, ids: readonly string[], p: Period) =>
  ids.flatMap((id) => {
    const since = feedStaleSince(s, id, p);
    return since == null ? [] : [{ id, since }];
  });

/**
 * The stale mark for figures resting on the feeds of `ids` in the period (null while all are fresh),
 * in the KPI cards' and the flow strip's wording: "Not confirmed · kiln data stale since 10:30".
 */
export function staleMark(s: SimState, ids: readonly string[], p: Period, note: string): StaleMark | null {
  const stale = staleFeeds(s, ids, p);
  if (!stale.length) return null;
  const since = Math.min(...stale.map((x) => x.since));
  const assetIds = stale.map((x) => x.id);
  return { since, assetIds, label: `Not confirmed · ${feedWord(assetIds)} data stale since ${clockOf(since, s.minute)}`, note };
}

/** True when a status already says the figure is not confirmed / a last value (set by a shared KPI or a raw signal). */
const staleWorded = (st: EqKpi['status']) => !!st && /^(Not confirmed|Last value)/.test(st.label);

/** Gives every tile with a value (except `keep`) the not-confirmed status, unless it already says so. */
function markTiles(kpis: EqKpi[], mark: StaleMark | null, keep: readonly string[] = []): EqKpi[] {
  if (!mark) return kpis;
  return kpis.map((k) => (k.unavailable || k.value == null || keep.includes(k.key) || staleWorded(k.status) ? k : { ...k, status: NOT_CONFIRMED }));
}

/**
 * A rate signal as the product has it: the frozen last value received while the asset's feed is stale; null when
 * no value was received (a stale feed with no last rate, an asset without a rate) — never a zero standing in.
 */
export function signalRate(s: SimState, id: string): number | null {
  const f = s.feeds[id];
  return f?.status === 'stale' ? (f.lastRate ?? null) : (s.machines[id]?.ratePerHour ?? null);
}

/** A shared headline KPI (src/intel/kpis.ts) as a tile: same value, unit, target and status. */
export function fromKpi(k: KpiModel, key: string = k.id): EqKpi {
  if (k.unavailable) return noData(key, k.label, k.unavailable, k.definition);
  return { key, label: k.label, value: k.display, unit: k.unit, sub: k.target, status: k.status, hint: k.definition };
}

/** A metric from the OEE module as a percentage tile (unavailable / invalid say why). */
function metricKpi(key: string, label: string, m: Metric, hint: string, sub?: string): EqKpi {
  if (m.status !== 'ok' || m.value == null) return noData(key, label, m.issue ?? 'Cannot be calculated for this period.', hint);
  return { key, label, value: pct1(m.value), unit: '%', sub, hint };
}

/** A product changeover stop record (not a planned stop in the calendar, not a breakdown either). */
export const isChangeover = (d: { reasonCode: string }) => REASON_BY_CODE[d.reasonCode]?.category === 'Changeover';

/**
 * Own stops of an asset in the period that count against its plan: breakdowns, process stops and
 * changeovers (starved / blocked spells and planned stops excluded). `changeovers` says how many of
 * `count` are product changeovers, so they are never called "unplanned stops".
 */
export function ownStops(s: SimState, id: string, p: Period) {
  const list = s.downtime.filter(
    (d) => d.equipmentId === id && d.category !== 'Starved' && d.category !== 'Blocked' && !REASON_BY_CODE[d.reasonCode]?.planned && d.start < p.to && (d.end ?? s.minute) > p.from,
  );
  return { count: list.length, changeovers: list.filter(isChangeover).length, minutes: list.reduce((a, d) => a + clippedDuration(d, p, s.minute), 0) };
}

const countWords = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function stopsKpi(s: SimState, id: string, p: Period, label = 'Stoppages'): EqKpi {
  const st = ownStops(s, id, p);
  const unplanned = st.count - st.changeovers;
  const sub = [unplanned ? countWords(unplanned, 'unplanned stop') : null, st.changeovers ? countWords(st.changeovers, 'changeover') : null].filter(Boolean).join(' · ');
  return {
    key: 'stops',
    label,
    value: formatDuration(st.minutes),
    sub: sub || undefined,
    status: unplanned ? null : { tone: 'good', label: 'No unplanned stop' },
    hint: `Time this asset was stopped by its own stops in the period — unplanned stops (breakdowns, process stops) and product changeovers, counted separately — from its ${id}.state signal. Planned stops and time starved or blocked by neighbouring stages are not counted.`,
  };
}

/**
 * Current rate reported by the asset's rate signal against its ideal rate (the frozen last value
 * while the feed is stale). The same rule as the stage panel's rate (stageKpis): the engine paces a
 * machine by its supply and the space downstream, and only the line constraint is meant to run near
 * its ideal rate, so a lower share — or a machine starved / blocked by its neighbours — is shown
 * neutrally. A warning only while the constraint claim (constraintClaim, the Overview's wording)
 * names the asset's stage as currently constraining output, or when the asset runs below its own set
 * rate ('reduced'); a stop or fault of the asset itself is critical.
 */
function rateKpi(s: SimState, prof: AssetProfile, claim: ConstraintClaim, label = 'Rate now'): EqKpi {
  const id = prof.id;
  const ideal = OPS_BY_ID[id]?.idealRatePerHour ?? 0;
  const f = s.feeds[id];
  const stale = f?.status === 'stale';
  const rate = signalRate(s, id);
  const op = operationalState(s, id);
  const hint = `Output rate reported by ${id}.rate (simulated PLC signal) against the asset's ideal rate. The line is paced by its constraint: a machine running below its ideal rate because of its supply or the space downstream has spare capacity — not a loss in itself. A warning only while the constraint analysis attributes lost line output to this stage now, or while the asset runs below its own set rate.${stale ? ' The feed is stale: this is the last value received.' : ''}`;
  if (rate == null) return noData('rate', label, stale ? 'The feed went stale before a rate was received.' : `No value of ${id}.rate received.`, hint);
  const ratio = ideal > 0 ? rate / ideal : null;
  const share = ratio != null ? `${pct0(ratio)} % of ideal` : null;
  // The process stage the trace ended at — the rule of the constraint marker, the 3D outline and the
  // panel's facets — never the monitored stage (GLAZE covers glazing and decoration, PACK packing and
  // palletising): one constraint statement per machine.
  const constraining = claim.constraining && prof.stage != null && claim.processStage === prof.stage;
  const withShare = (words: string) => (share ? `${words} · ${share}` : words);
  let status: EqKpi['status'] = null;
  if (stale) status = { tone: 'neutral', label: `Last value · ${clockOf(f.since, s.minute)}` };
  else if (op === 'stopped' || op === 'fault') status = { tone: 'critical', label: OPERATIONAL_STATE_LABEL[op] };
  else if (op === 'planned') status = { tone: 'neutral', label: 'Planned stop' };
  else if (op === 'changeover') status = { tone: 'neutral', label: 'Changeover' };
  else if (constraining) status = { tone: 'warning', label: withShare('Constraining output') };
  else if (op === 'reduced') status = { tone: 'warning', label: withShare(OPERATIONAL_STATE_LABEL.reduced) };
  else if (op === 'starved' || op === 'blocked' || op === 'idle') status = { tone: 'neutral', label: OPERATIONAL_STATE_LABEL[op] };
  else if (ratio != null) status = ratio >= 0.95 ? { tone: 'good', label: 'At ideal rate' } : { tone: 'neutral', label: share! };
  return {
    key: 'rate',
    label,
    value: int(rate),
    unit: 'tiles/h',
    sub: ideal ? `ideal ${int(ideal)} tiles/h` : undefined,
    window: stale ? undefined : 'now',
    status,
    hint,
  };
}

function countKpi(key: string, label: string, tiles: number, hint: string, unit = 'tiles', sub?: string): EqKpi {
  return { key, label, value: int(tiles), unit, sub, hint };
}

const STAGE_REJECTS: Partial<Record<StageId, string>> = {
  PRESS: 'Press-origin rejects',
  GLAZE: 'Glaze-origin rejects',
  DECOR: 'Decoration-origin rejects',
};

function rejectsKpi(stage: StageId, rejects: number, count: number): EqKpi {
  const defects = (Object.keys(DEFECTS) as DefectCategory[]).filter((d) => DEFECTS[d].origin === stage).map((d) => DEFECTS[d].label.toLowerCase());
  return {
    key: 'rejects',
    label: STAGE_REJECTS[stage] ?? 'Rejects attributed',
    value: int(rejects),
    unit: 'tiles',
    sub: count > 0 ? `${((rejects / count) * 100).toFixed(2)} % of output · found at sorting` : 'found at sorting',
    hint: `Tiles rejected at sorting for defect types the model attributes to ${STAGE_BY_ID[stage].name.toLowerCase()} (${defects.join(', ')}). The origin is a modelled attribution — a hypothesis to check, not a confirmed cause.`,
  };
}

/** Backlog in front of an asset: the level of its stage's input buffer. */
function backlogKpi(s: SimState, stage: StageId): EqKpi | null {
  const bufId = STAGE_BY_ID[stage].inputBuffer;
  const buf = bufId ? BUFFERS.find((b) => b.id === bufId) : null;
  if (!buf) return null;
  const level = s.buffers[buf.id];
  return {
    key: 'backlog',
    label: 'Backlog waiting',
    value: int(level),
    unit: 'tiles',
    sub: `${pct0(level / buf.capacity)} % of ${buf.name.toLowerCase()} (${int(buf.capacity)})`,
    status: level / buf.capacity >= 0.9 ? { tone: 'warning', label: 'Buffer nearly full' } : null,
    hint: `Tiles waiting in ${buf.name} (${buf.id}), the input buffer of ${STAGE_BY_ID[stage].name.toLowerCase()}, from its simulated level signal.`,
  };
}

// ── Process signals as tiles (wave 3: equipment-specific figures from the catalogue's simulated signals) ──

const NFD = [0, 1, 2, 3].map((d) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtD = (v: number, d: number) => NFD[Math.max(0, Math.min(3, d))].format(v).replace(/^-/, '−');
const digitsOf = (signalId: string, fallback = 1) => PROCESS_SIGNAL_BY_ID[signalId]?.digits ?? fallback;

/** Disclosure of every t/h figure derived from a tile-equivalent rate (simulated, KG_PER_TILE). */
export const MASS_FLOW_HINT = `Simulated t/h: tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg per tile-equivalent (KG_PER_TILE, a simulation assumption — not a weighed flow).`;

/**
 * The current reading of a catalogue signal as a tile: the value with its unit and "now"; a stale feed's last value
 * says so; a bad-quality reading, a missing value or a signal the demo does not simulate is unavailable with the
 * reason — never a number standing in.
 */
function readingKpi(s: SimState, signalId: string, key: string, label: string, hint: string, o: { digits?: number; sub?: string; window?: string } = {}): EqKpi {
  const d = definitionOf(signalId);
  if (!d || d.availabilityStatus !== 'simulated') return noData(key, label, d?.statusNote ?? `${signalId} is not simulated in this demo.`, hint);
  const r = readSignal(s, signalId);
  if (r.quality === 'bad') return noData(key, label, `Bad-quality reading of ${signalId}${r.note ? ` (${r.note})` : ''} — not shown as a figure.`, hint);
  if (typeof r.value !== 'number' || r.quality === 'missing') return noData(key, label, r.note ?? `No value of ${signalId} received.`, hint);
  const stale = r.quality === 'stale';
  return {
    key,
    label,
    value: fmtD(r.value, o.digits ?? digitsOf(signalId)),
    unit: r.unit ?? d.unit ?? undefined,
    sub: o.sub,
    window: stale && r.timestamp != null ? `last value ${clockOf(r.timestamp, s.minute)}` : (o.window ?? 'now'),
    status: stale && r.timestamp != null ? { tone: 'neutral', label: `Last value · ${clockOf(r.timestamp, s.minute)}` } : null,
    hint: `${hint} Simulated signal ${signalId}.`,
  };
}

/** A process value against its setpoint: PV now, SP in the sub line, the band it is in (words) as the status. */
function pvSpKpi(s: SimState, pvId: string, key: string, label: string): EqKpi {
  const d = definitionOf(pvId);
  const spId = d?.setpointSignalId ?? null;
  const spec = PROCESS_SIGNAL_BY_ID[pvId];
  const warn = d?.warningHigh != null && spec?.nominal != null ? d.warningHigh - spec.nominal : null;
  const alarm = d?.alarmHigh != null && spec?.nominal != null ? d.alarmHigh - spec.nominal : null;
  const hint = `${d?.description ?? label} Compared with its setpoint${spId ? ` ${spId}` : ''}${warn != null ? `: warning beyond ±${fmtD(warn, digitsOf(pvId))} ${d?.unit ?? ''}, alarm beyond ±${fmtD(alarm ?? warn, digitsOf(pvId))} ${d?.unit ?? ''}` : ''}.`;
  const k = readingKpi(s, pvId, key, label, hint);
  if (k.unavailable || !spId) return k;
  const sp = readSignal(s, spId);
  const pv = readSignal(s, pvId);
  const spV = typeof sp.value === 'number' && sp.quality !== 'bad' ? sp.value : null;
  const dev = setpointDeviation(typeof pv.value === 'number' ? pv.value : null, spV, warn != null && alarm != null ? { warn, alarm } : undefined);
  const sub = spV != null ? `SP ${fmtD(spV, digitsOf(pvId))} ${d?.unit ?? ''}`.trim() : 'setpoint not reported';
  if (k.status) return { ...k, sub };
  if (dev.status !== 'ok') return { ...k, sub };
  const delta = `${dev.value.abs >= 0 ? '+' : '−'}${fmtD(Math.abs(dev.value.abs), digitsOf(pvId))}`;
  const status: EqKpi['status'] =
    dev.value.level === 'alarm' ? { tone: 'critical', label: `${delta} · beyond alarm band` } : dev.value.level === 'warning' ? { tone: 'warning', label: `${delta} · beyond warning band` } : { tone: 'good', label: `${delta} · within band` };
  return { ...k, sub, status };
}

/** Least-squares trend of a level signal over the last 60 minutes of minute data (%/h). */
function levelTrend(s: SimState, levelId: string) {
  const x = seriesOf(s, levelId, { from: s.minute - 60, to: s.minute, stepMin: 1 });
  return x ? trendSlope(seriesToSamples(x, x.t[0] ?? 0), { minSamples: 20, minSpanMin: 30 }) : null;
}

/** Rate of a cumulative counter over the last 60 minutes (per hour); unavailable with the reason. */
function counterKpi(s: SimState, signalId: string, key: string, label: string, unit: string, hint: string): EqKpi {
  const d = definitionOf(signalId);
  if (!d || d.availabilityStatus !== 'simulated') return noData(key, label, d?.statusNote ?? `${signalId} is not simulated in this demo.`, hint);
  const x = seriesOf(s, signalId, { from: s.minute - 61, to: s.minute, stepMin: 1 });
  const r = x ? counterRate(seriesToSamples(x, x.t[0] ?? 0)) : null;
  if (!r || r.status !== 'ok') return noData(key, label, r ? r.reason : `No history of ${signalId}.`, hint);
  return { key, label, value: fmtD(r.value.perHour, r.value.perHour < 10 ? 1 : 0), unit, window: 'last 60 min', hint: `${hint} From the counter ${signalId} (resets and rollovers handled).` };
}

/** The state of an asset in words as a tile (packing: "line state"). */
function stateKpi(s: SimState, id: string, label = 'Line state'): EqKpi {
  const op = operationalState(s, id);
  const tone: Tone = op === 'running' ? 'good' : op === 'stopped' || op === 'fault' ? 'critical' : op === 'reduced' || op === 'starved' || op === 'blocked' ? 'warning' : 'neutral';
  return {
    key: 'state',
    label,
    value: op === 'unknown' ? 'Unknown' : OPERATIONAL_STATE_LABEL[op],
    window: 'now',
    status: op === 'unknown' ? { tone: 'neutral', label: 'Data stale' } : { tone, label: tone === 'good' ? 'Producing' : tone === 'critical' ? 'Not producing' : tone === 'warning' ? 'Not at full output' : 'Not scheduled' },
    hint: `Operating state of ${id} from its simulated state signal (unknown while the feed is stale).`,
  };
}

/** Kiln zones within their warning band now (n of 5), from the simulated zone PV / SP pairs. */
function kilnZonesKpi(s: SimState, id: string): EqKpi {
  const hint = 'Zone temperatures (preheating, firing, peak firing, rapid and final cooling) against their setpoints; a zone counts as within band while |PV − SP| is inside its warning band.';
  let read = 0;
  let within = 0;
  const off: string[] = [];
  const unread: number[] = [];
  for (const z of KILN_ZONES) {
    const pvId = `${id}.zone${z.no}_temp_pv`;
    const d = definitionOf(pvId);
    const spec = PROCESS_SIGNAL_BY_ID[pvId];
    if (!d || d.availabilityStatus !== 'simulated' || !d.setpointSignalId || spec?.nominal == null || d.warningHigh == null || d.alarmHigh == null) continue;
    const pv = readSignal(s, pvId);
    const sp = readSignal(s, d.setpointSignalId);
    const dev =
      pv.quality === 'bad' || pv.quality === 'stale'
        ? null
        : setpointDeviation(typeof pv.value === 'number' ? pv.value : null, typeof sp.value === 'number' ? sp.value : null, { warn: d.warningHigh - spec.nominal, alarm: d.alarmHigh - spec.nominal });
    if (!dev || dev.status !== 'ok') {
      unread.push(z.no);
      continue;
    }
    read++;
    if (dev.value.level === 'within') within++;
    else off.push(`zone ${z.no} ${dev.value.abs >= 0 ? '+' : '−'}${fmtD(Math.abs(dev.value.abs), 0)} °C`);
  }
  if (!read) return noData('zones', 'Zones within band', 'No usable zone-temperature reading now (bad quality, stale or not producing).', hint);
  // Of the zones readable now: a bad / stale / missing zone reading is named, never counted as within band.
  const notRead = unread.length ? `zone${unread.length > 1 ? 's' : ''} ${unread.join(', ')} not readable` : null;
  return {
    key: 'zones',
    label: 'Zones within band',
    value: `${within} / ${read}`,
    unit: read < KILN_ZONES.length ? `read of ${KILN_ZONES.length}` : undefined,
    sub: [off.length ? off.join(' · ') : read === KILN_ZONES.length ? 'all zones on setpoint' : null, notRead].filter(Boolean).join(' · ') || undefined,
    window: 'now',
    status: within === read ? { tone: notRead ? 'neutral' : 'good', label: notRead ? 'Read zones within band' : 'All zones within band' } : { tone: 'warning', label: `${read - within} outside the warning band` },
    hint: `${hint}${notRead ? ` ${notRead[0].toUpperCase()}${notRead.slice(1)} now (bad quality, stale or no value).` : ''}`,
  };
}

/** Alarm codes of the shift (unplanned stops carry their alarm code) and the code active now — never "no fault". */
function alarmsKpi(s: SimState, id: string, p: Period): EqKpi {
  const st = ownStops(s, id, p);
  const unplanned = st.count - st.changeovers;
  const r = readSignal(s, `${id}.alarm`);
  const active = typeof r.value === 'string' && r.value !== 'none' && r.quality !== 'missing';
  return {
    key: 'alarms',
    label: 'Alarms',
    value: String(unplanned),
    unit: unplanned === 1 ? 'alarm stop' : 'alarm stops',
    window: 'shift',
    sub: active ? `active now: ${r.text}` : r.quality === 'stale' ? 'alarm signal stale' : 'no active alarm code now',
    status: active ? { tone: 'critical', label: 'Alarm active' } : null,
    hint: `Unplanned stops of ${id} in the period (each carries its alarm / stop code on ${id}.alarm) and the code reported now. No active code is not proof that the machine is fault-free.`,
  };
}

/** Level %, its 60-min trend and the time to empty / full at that trend — % basis for slip tanks and powder silos. */
function levelKpis(s: SimState, levelId: string, bulk: boolean, band: ReturnType<typeof bufferLevelBand> | null, levelHint: string): EqKpi[] {
  const lv = readSignal(s, levelId);
  const level = typeof lv.value === 'number' && lv.quality !== 'bad' && lv.quality !== 'missing' ? lv.value : null;
  const out: EqKpi[] = [
    level == null
      ? noData('level', 'Level', lv.note ?? `No usable value of ${levelId}.`, levelHint)
      : {
          key: 'level',
          label: 'Level',
          value: fmtD(level, 0),
          unit: '%',
          window: lv.quality === 'stale' && lv.timestamp != null ? `last value ${clockOf(lv.timestamp, s.minute)}` : 'now',
          sub: bulk ? 'level only · no mass calibration' : undefined,
          status: band?.concern ? { tone: 'warning', label: band.label } : null,
          hint: levelHint,
        },
  ];
  const tr = levelTrend(s, levelId);
  const trendHint = `Least-squares slope of the minute samples of ${levelId} over the last 60 min.`;
  if (!tr || tr.status !== 'ok') {
    out.push(noData('trend', 'Level trend', tr ? tr.reason : 'No level history.', trendHint));
    return out;
  }
  out.push({ key: 'trend', label: 'Level trend', value: `${tr.value >= 0 ? '+' : '−'}${fmtD(Math.abs(tr.value), 1)}`, unit: '%/h', window: 'last 60 min', hint: trendHint });
  const basis = bulk ? ' · % basis' : '';
  const ttHint = `A linear extrapolation of the 60-min level trend from the current level${bulk ? ' — on a % basis: without a level-to-mass calibration no tonnes are derived' : ''}. Not a forecast.`;
  if (Math.abs(tr.value) < 0.5) out.push({ key: 'time-to', label: `Time to empty / full${basis}`, value: 'Steady', sub: 'trend under 0.5 %/h', window: 'at the 60-min trend', hint: ttHint });
  else {
    const c = tr.value < 0 ? timeToEmpty(level, tr.value) : timeToFull(level, tr.value);
    const label = `${tr.value < 0 ? 'Time to empty' : 'Time to full'}${basis}`;
    out.push(
      c.status === 'ok'
        ? {
            key: 'time-to',
            label,
            value: c.value < 1 ? (tr.value < 0 ? 'Empty' : 'Full') : formatDuration(c.value),
            window: 'at the 60-min trend',
            status: tr.value < 0 && c.value < 60 && band?.ahead ? { tone: 'warning', label: 'Runs empty within 1 h' } : null,
            hint: ttHint,
          }
        : noData('time-to', label, c.reason, ttHint),
    );
  }
  return out;
}

// ── Process machines, by stage ─────────────────────────────────────────────

function machineKpis(s: SimState, prof: AssetProfile, p: Period, claim: ConstraintClaim): EqKpi[] {
  const id = prof.id;
  const mm = machineMetrics(s, id, p);
  const t = mm.totals;
  const stage = mm.stage;
  const avail = () =>
    metricKpi('availability', 'Availability', mm.oee.availability, `Operating time ÷ planned production time of ${id} in the period (the same machine metrics as Production).`, 'of planned time');
  /** Tile-equivalents of slip / powder as simulated tonnes (disclosed), never tiles. */
  const massOut = (key: string, label: string, what: string): EqKpi => ({
    key,
    label,
    value: fmtD((t.count * KG_PER_TILE) / 1000, 1),
    unit: 't',
    sub: `${int(t.count)} tile-eq. · simulated mass`,
    hint: `${what} in the period: ${id}.count_total (tile-equivalents) × ${KG_PER_TILE.toFixed(2)} kg per tile-equivalent. ${MASS_FLOW_HINT}`,
  });
  switch (stage) {
    case 'PREP':
      return [
        readingKpi(s, `${id}.slip_flow`, 'rate', 'Slip output', `Slip discharged by the mill as dry-body mass. ${MASS_FLOW_HINT}`, { sub: 'simulated t/h (tile-eq. × kg)' }),
        massOut('output', 'Slip milled', 'Slip milled'),
        readingKpi(s, `${id}.mill_speed`, 'speed', 'Mill speed', 'Drum speed of the ball mill (drive).'),
        avail(),
        stopsKpi(s, id, p),
      ];
    case 'SPRAY':
      return [
        readingKpi(s, `${id}.powder_flow`, 'rate', 'Powder output', `Granulate produced by the spray dryer. ${MASS_FLOW_HINT}`, { sub: 'simulated t/h (tile-eq. × kg)' }),
        pvSpKpi(s, `${id}.outlet_temp_pv`, 'outlet', 'Outlet temperature'),
        pvSpKpi(s, `${id}.powder_moisture_pv`, 'moisture', 'Powder moisture'),
        massOut('output', 'Powder made', 'Powder sent to the silos'),
        stopsKpi(s, id, p, 'Downtime'),
      ];
    case 'PRESS': {
      const cyc = readingKpi(s, `${id}.cycle_time`, 'cycle', 'Cycle time', 'Time of one press cycle (fill, press, de-air, eject), mean over the minute, against the target cycle time of the die / product.');
      const tgt = readSignal(s, `${id}.cycle_time_target`);
      const cycle =
        cyc.unavailable || typeof tgt.value !== 'number'
          ? cyc
          : (() => {
              const c = readSignal(s, `${id}.cycle_time`);
              const over = typeof c.value === 'number' ? (c.value - tgt.value) / tgt.value : null;
              return {
                ...cyc,
                sub: `target ${fmtD(tgt.value, 1)} s`,
                status: cyc.status ?? (over == null ? null : over > 0.05 ? { tone: 'warning' as Tone, label: `${fmtD(over * 100, 0)} % slower than target` } : { tone: 'good' as Tone, label: 'On target' }),
              };
            })();
      return [
        rateKpi(s, prof, claim, 'Press output rate'),
        cycle,
        countKpi('good', 'Good tiles pressed', Math.max(0, t.count - t.rejects), `Tiles pressed in the period (${id}.count_total) minus the rejects attributed to pressing.`, 'tiles', `of ${int(t.count)} pressed`),
        rejectsKpi('PRESS', t.rejects, t.count),
        stopsKpi(s, id, p, 'Stoppage time'),
      ];
    }
    case 'DRY':
      return [
        pvSpKpi(s, `${id}.zone1_temp_pv`, 'zone1', 'Zone 1 temperature'),
        pvSpKpi(s, `${id}.zone2_temp_pv`, 'zone2', 'Zone 2 temperature'),
        readingKpi(s, `${id}.roller_speed`, 'speed', 'Roller speed', 'Speed of the dryer roller decks (drive); follows the line rate.'),
        rateKpi(s, prof, claim, 'Throughput now'),
        countKpi('output', 'Tiles dried', t.count, `Tiles leaving the dryer in the period (${id}.count_total).`),
        stopsKpi(s, id, p, 'Downtime'),
      ];
    case 'GLAZE':
      return [
        readingKpi(s, `${id}.line_speed`, 'speed', 'Line speed', 'Glazing line belt speed (drive); follows the line rate.'),
        pvSpKpi(s, `${id}.glaze_density_pv`, 'density', 'Glaze density'),
        rateKpi(s, prof, claim, 'Line rate'),
        countKpi('output', 'Tiles glazed', t.count, `Tiles through ${id} in the period (${id}.count_total).`),
        rejectsKpi(stage, t.rejects, t.count),
        stopsKpi(s, id, p),
      ];
    case 'DECOR':
      return [
        rateKpi(s, prof, claim, 'Line rate'),
        countKpi('output', 'Tiles decorated', t.count, `Tiles through ${id} in the period (${id}.count_total).`),
        rejectsKpi(stage, t.rejects, t.count),
        stopsKpi(s, id, p),
      ];
    case 'KILN':
      return [
        kilnZonesKpi(s, id),
        rateKpi(s, prof, claim, 'Firing rate'),
        readingKpi(s, `${id}.roller_speed`, 'speed', 'Roller speed', 'Speed of the kiln roller drive; follows the firing rate.'),
        alarmsKpi(s, id, p),
        countKpi('output', 'Tiles fired', t.count, `Tiles leaving the kiln in the period (${id}.count_total) — the line's throughput at its constraint.`, 'tiles', `${int(t.count * M2_PER_TILE)} m²`),
        stopsKpi(s, id, p, 'Downtime'),
      ];
    case 'SORT': {
      const q = qualityIn(s, p);
      const rr = rejectRate(q.rejected, q.inspected);
      return [
        countKpi('inspected', 'Tiles inspected', q.inspected, 'Tiles through the gauge and the vision tunnel in the period (inspection counters).'),
        rr.status === 'ok'
          ? {
              key: 'rejected',
              label: 'Reject rate',
              value: fmtD(rr.value * 100, 2),
              unit: '%',
              sub: `${int(q.rejected)} of ${int(q.inspected)} tiles · limit ${pct0(s.rules.rejectRateMax)} %`,
              status: rr.value > s.rules.rejectRateMax ? { tone: 'critical', label: 'Above line limit' } : null,
              hint: 'Tiles rejected by the gauge or the vision tunnel ÷ tiles inspected in the period (simulated classification).',
            }
          : noData('rejected', 'Reject rate', rr.reason, 'Tiles rejected ÷ tiles inspected in the period.'),
        fromKpi(firstPassQualityKpi(s, p), 'fpq'),
        {
          key: 'inspection-rate',
          label: 'Inspection rate',
          value: int(q.inspected / hoursOf(p)),
          unit: 'tiles/h',
          sub: `ideal sorting rate ${int(OPS_BY_ID[id].idealRatePerHour)} tiles/h`,
          hint: 'Tiles inspected ÷ hours elapsed in the period.',
        },
      ];
    }
    case 'PACK':
    case 'PAL': {
      const per =
        stage === 'PAL'
          ? counterKpi(s, `${id}.pallet_count`, 'per-hour', 'Pallets per hour', 'pallets/h', 'Pallets completed by the palletiser cell.')
          : counterKpi(s, `${id}.carton_count`, 'per-hour', 'Cartons per hour', 'cartons/h', `Cartons closed by the packaging machine (${TILES_PER_CARTON} tiles per carton).`);
      const out =
        stage === 'PAL'
          ? countKpi('output', 'Pallets built', t.count / TILES_PER_PALLET, `Palletised tiles in the period ÷ ${TILES_PER_PALLET} tiles per pallet (${id}.count_total).`, 'pallets', `${int(t.count)} tiles`)
          : countKpi('output', 'Tiles packed', t.count, `Tiles boxed in the period (${id}.count_total) — good output only, rejects leave the line at sorting.`);
      return [per, stateKpi(s, id), out, rateKpi(s, prof, claim, 'Throughput now'), backlogKpi(s, stage), stopsKpi(s, id, p)].filter((k): k is EqKpi => k != null);
    }
  }
}

// ── Other asset kinds ──────────────────────────────────────────────────────

function conveyorKpis(s: SimState, id: string, p: Period): EqKpi[] {
  const cm = conveyorMetrics(s, id, p);
  const nominal = CONVEYOR_BY_ID[id]?.speedMpm;
  const speed = readingKpi(s, `${id}.speed`, 'speed', 'Speed', 'Belt / roller speed of the conveyor drive.', { sub: nominal != null ? `nominal ${nominal} m/min` : undefined });
  return [
    stateKpi(s, id, 'State'),
    speed,
    { key: 'stops', label: 'Stops', value: String(cm.stops), sub: cm.stops ? `${formatDuration(cm.downMin)} stopped` : undefined, status: cm.stops ? null : { tone: 'good', label: 'No stops' }, hint: `Stops of ${id} overlapping the period, from its run_state signal.` },
    cm.utilisation == null
      ? noData('utilisation', 'Utilisation', 'No planned running time in this period yet.', 'Tiles moved ÷ nominal capacity.')
      : { key: 'utilisation', label: 'Utilisation', value: pct1(cm.utilisation), unit: '%', sub: 'of nominal capacity', hint: `Tiles moved (${id}.tile_count) ÷ nominal transport capacity over the planned time.` },
    // The powder belt carries tile-equivalents of powder (catalogue unit), never tiles.
    definitionOf(`${id}.tile_count`)?.unit === 'tile-eq'
      ? countKpi('moved', 'Powder carried', cm.totals.count, `Tile-equivalents of powder counted on the belt in the period (${id}.tile_count) — a simulation unit, not tiles.`, 'tile-eq.')
      : countKpi('moved', 'Tiles moved', cm.totals.count, `Tiles counted on the conveyor in the period (${id}.tile_count).`),
  ];
}

/** Process stages either side of a buffer (the stage filling it, the stage drawing from it). */
function bufferNeighbours(bufferId: string) {
  const i = STAGES.findIndex((st) => st.inputBuffer === bufferId);
  return { up: i > 0 ? STAGES[i - 1] : undefined, down: i >= 0 ? STAGES[i] : undefined };
}

/** Buffer level band (the share of capacity below / above which a buffer is "low" / "high"). */
export const BUFFER_LEVEL_BAND = { low: 0.1, high: 0.9 } as const;

/**
 * What a buffer level means on its side of the kiln (the line constraint). Ahead of the kiln (the
 * buffer feeds a stage at or before it) an empty buffer starves the next stage — a concern — while a
 * full one is normal balancing; behind the kiln a full buffer moves the blockage towards the kiln — a
 * concern — while a low one is normal (the stages after the kiln are faster).
 */
export function bufferLevelBand(bufferId: string, fill: number): { ahead: boolean; side: 'low' | 'high' | 'normal'; concern: boolean; label: string } {
  const { down } = bufferNeighbours(bufferId);
  const kiln = STAGES.findIndex((st) => st.id === LINE.designConstraint);
  const ahead = down != null && STAGES.indexOf(down) <= kiln;
  if (fill <= BUFFER_LEVEL_BAND.low) return ahead ? { ahead, side: 'low', concern: true, label: 'Nearly empty' } : { ahead, side: 'low', concern: false, label: 'Low · normal after the kiln' };
  if (fill >= BUFFER_LEVEL_BAND.high) return ahead ? { ahead, side: 'high', concern: false, label: 'Full · normal ahead of the kiln' } : { ahead, side: 'high', concern: true, label: 'Nearly full' };
  return { ahead, side: 'normal', concern: false, label: 'Normal band' };
}

/** Slip tanks (stage 1) and powder silos (stage 2): bulk material — level % only, flows in simulated t/h, never tiles. */
export const BULK_BUFFER_IDS: ReadonlySet<string> = new Set(['BUF-SLIP', 'BUF-SILO']);

function bufferKpis(s: SimState, prof: AssetProfile): EqKpi[] {
  const buf = BUFFERS.find((b) => b.id === prof.bufferId)!;
  const bulk = BULK_BUFFER_IDS.has(buf.id);
  const levelId = BUFFER_LEVEL_SIGNAL[buf.id] ?? `${prof.id}.level`;
  const level = s.buffers[buf.id];
  const { up, down } = bufferNeighbours(buf.id);
  // Rate signals of the neighbouring machines: the last value received while a feed is stale; unknown (null) when one has none.
  const rate = (st: (typeof STAGES)[number] | undefined): number | null => {
    if (!st) return null;
    let a = 0;
    for (const m of st.machines) {
      const r = signalRate(s, m);
      if (r == null) return null;
      a += r;
    }
    return a;
  };
  const lastValue = (st: (typeof STAGES)[number] | undefined): EqKpi['status'] => {
    const stale = (st?.machines ?? []).filter((m) => s.feeds[m]?.status === 'stale');
    if (!stale.length) return null;
    const at = clockOf(Math.max(...stale.map((m) => s.feeds[m].since)), s.minute);
    return { tone: 'neutral', label: stale.length === st!.machines.length ? `Last value · ${at}` : `Incl. last value of ${stale.join(', ')}` };
  };
  const band = bufferLevelBand(buf.id, level / buf.capacity);
  const levelHint = `Simulated level signal of ${buf.name} (${levelId}), % of capacity. ${
    bulk
      ? 'A level is not a mass: without a level-to-mass calibration no tonnes are derived.'
      : band.ahead
        ? 'Ahead of the kiln a nearly empty buffer starves the next stage; a full one is normal (the stage filling it has spare capacity).'
        : 'Behind the kiln a nearly full buffer moves a blockage towards the kiln; a low one is normal (the stages after the kiln are faster).'
  }`;
  const levels = levelKpis(s, levelId, bulk, band, levelHint);
  if (!bulk) levels[0] = levels[0].unavailable ? levels[0] : { ...levels[0], sub: `${int(level)} of ${int(buf.capacity)} tiles` };
  const flow = (key: 'inflow' | 'outflow', label: string, st: (typeof STAGES)[number] | undefined): EqKpi => {
    const r = rate(st);
    const hint = `Current output rate of the ${key === 'inflow' ? 'upstream' : 'downstream'} stage (${st?.machines.join(', ') ?? '—'}); the last value received while a machine's feed is stale.${bulk ? ` ${MASS_FLOW_HINT}` : ''}`;
    if (!st) return noData(key, label, 'No process stage on this side of the buffer.', hint);
    if (r == null) return noData(key, label, `No rate value received from ${st.machines.join(', ')}.`, hint);
    return bulk
      ? { key, label, value: fmtD((r * KG_PER_TILE) / 1000, 1), unit: 't/h', sub: `${st.name} · simulated`, window: 'now', status: lastValue(st), hint }
      : { key, label, value: int(r), unit: 'tiles/h', sub: st.name, window: 'now', status: lastValue(st), hint };
  };
  const out = [...levels, flow('inflow', 'Filling from', up), flow('outflow', 'Drawn by', down)];
  // The mass in a silo / tank is the "needs calibration" note (listed once with the not-modelled parameters).
  if (bulk) out.push(na('mass', buf.id === 'BUF-SILO' ? 'Powder mass in the silos' : 'Slip mass in the tanks', buf.id === 'BUF-SILO' ? NOT_MODELLED.siloMass : NOT_MODELLED.tankMass, 'Mass from the level needs a level-to-mass calibration.'));
  return out;
}

const STATION_DETECTS = Object.fromEntries(INSPECTION_STATIONS.map((st) => [st.id, st.detects])) as Record<string, DefectCategory[]>;

function stationKpis(s: SimState, prof: AssetProfile, p: Period): EqKpi[] {
  const stationId = prof.stationId!;
  const detects = STATION_DETECTS[stationId] ?? [];
  if (!detects.length) {
    const samples = s.inspections.filter((r) => r.stationId === stationId && r.time >= p.from && r.time <= s.minute);
    const last = [...s.inspections].reverse().find((r) => r.stationId === stationId && r.time <= s.minute);
    return [
      { key: 'samples', label: 'Samples checked', value: String(samples.length), sub: 'this period', hint: 'Laboratory sample records of the QC bench in the period (simulated).' },
      last
        ? {
            key: 'last',
            label: 'Last sample',
            value: last.result === 'pass' ? 'Pass' : 'Out of spec',
            sub: formatClock(last.time),
            status: last.result === 'pass' ? { tone: 'good', label: 'Within specification' } : { tone: 'warning', label: 'Retest requested' },
            hint: 'Result of the most recent laboratory sample record.',
          }
        : noData('last', 'Last sample', 'No laboratory sample recorded yet.', 'Result of the most recent laboratory sample record.'),
      na('counts', 'Tiles inspected', NOT_MODELLED.qcCounts, 'Tile counters of the station.'),
    ];
  }
  const q = qualityIn(s, p);
  const st = q.byStation[stationId] ?? { inspected: 0, rejected: 0 };
  const ranked = detects.map((d) => [d, q.byDefect[d] ?? 0] as const).sort((a, b) => b[1] - a[1]);
  const [top, n] = ranked[0] ?? [null, 0];
  return [
    countKpi('inspected', 'Tiles inspected', st.inspected, `Tiles through this station in the period (${prof.id}.count_inspected).`),
    countKpi('rejected', 'Rejected here', st.rejected, `Tiles this station rejected in the period (${prof.id}.count_rejected).`),
    st.inspected > 0
      ? {
          key: 'reject-rate',
          label: 'Reject rate',
          value: ((st.rejected / st.inspected) * 100).toFixed(2),
          unit: '%',
          sub: `limit ${pct0(s.rules.rejectRateMax)} % for the line`,
          status: st.rejected / st.inspected > s.rules.rejectRateMax ? { tone: 'critical', label: 'Above line limit' } : { tone: 'good', label: 'Within line limit' },
          hint: 'Rejected ÷ inspected at this station in the period.',
        }
      : noData('reject-rate', 'Reject rate', 'No tiles inspected in this period yet.', 'Rejected ÷ inspected at this station.'),
    top && n > 0
      ? { key: 'top-defect', label: 'Most frequent defect', value: DEFECTS[top].label, sub: `${int(n)} tiles`, hint: 'Defect category with the most rejects among those this station detects (simulated classification).' }
      : noData('top-defect', 'Most frequent defect', 'No defects recorded at this station in this period.', 'Defect category with the most rejects among those this station detects.'),
  ];
}

function rawKpis(s: SimState, p: Period): EqKpi[] {
  const trucks: TruckRuntime[] = [...externalVehicles(s), ...s.logistics.departed];
  const seen = new Set<string>();
  const delivered = trucks.filter((v) => {
    if (seen.has(v.id)) return false;
    seen.add(v.id);
    const vis = v.visit;
    return vis?.direction === 'inbound' && vis.dockEnd != null && vis.dockEnd >= p.from && vis.dockEnd <= s.minute;
  });
  const tonnes = delivered.reduce((a, v) => a + (v.visit?.load ?? 0), 0);
  return [
    {
      key: 'deliveries',
      label: 'Deliveries unloaded',
      value: int(tonnes),
      unit: 't',
      sub: `${delivered.length} tipper${delivered.length === 1 ? '' : 's'} this period`,
      hint: 'Inbound raw-material trucks whose unloading finished in the period (simulated visits), and their declared loads.',
    },
    na('feed-rate', 'Feed rate', NOT_MODELLED.feedRate, 'Raw materials dosed to the mills per hour.'),
    na('stock', 'Material stock', NOT_MODELLED.rawStock, 'Quantity in the bays and silos.'),
    na('incoming-quality', 'Incoming quality', NOT_MODELLED.incomingQuality, 'Moisture / composition checks on delivered material.'),
  ];
}

function logisticsKpis(s: SimState, id: string, p: Period): EqKpi[] {
  const fm = fleetMetrics(s, p);
  const wh = () => stageIO(s, 'WH', p);
  switch (id) {
    case 'A-GATE':
      return [
        { key: 'on-site', label: 'Trucks on site', value: String(fm.onSite), sub: `${fm.inbound} inbound · ${fm.onSite - fm.inbound} outbound`, hint: 'External trucks between gate-in and gate-out now (simulated gate events).' },
        { key: 'gate-in', label: 'Gate-ins', value: String(fm.gateIn), sub: 'this period', hint: 'Gate entry events in the period.' },
        { key: 'gate-out', label: 'Gate-outs', value: String(fm.gateOut), sub: 'this period', hint: 'Gate exit events in the period.' },
        fromKpi(avgDwellKpi(s, p), 'dwell'),
      ];
    case 'A-HOLD':
      return [
        {
          key: 'waiting',
          label: 'Waiting for a dock',
          value: String(fm.waiting),
          unit: 'trucks',
          status: fm.waiting >= s.rules.yardQueueMax ? { tone: 'warning', label: `Queue limit ${s.rules.yardQueueMax}` } : null,
          hint: 'Outbound trucks in the holding area waiting for a dock now.',
        },
        fromKpi(delayedVehiclesKpi(s), 'delayed'),
        fm.avgWaiting == null
          ? noData('avg-wait', 'Average wait', 'No outbound visit completed in this period yet.', 'Average holding-area wait of completed outbound visits.')
          : { key: 'avg-wait', label: 'Average wait', value: int(fm.avgWaiting), unit: 'min', sub: 'completed outbound visits', hint: 'Average holding-area wait of outbound visits completed in the period.' },
      ];
    case 'K-DOCK': {
      const occupied = DOCKS.filter((d) => s.logistics.docks[d.id]?.vehicleId).length;
      return [
        { key: 'occupied', label: 'Docks occupied', value: `${occupied} / ${DOCKS.length}`, sub: 'now', hint: 'Docks with a truck at them now (K-DOCK.dock_occupancy).' },
        { key: 'utilisation', label: 'Dock utilisation', value: pct1(fm.dockUtilisation), unit: '%', sub: 'this period', hint: 'Occupied dock minutes ÷ (docks × minutes in the period).' },
        fm.avgDockTime == null
          ? noData('dock-time', 'Average time at dock', 'No outbound visit completed in this period yet.', 'Average dock stay of completed outbound visits.')
          : { key: 'dock-time', label: 'Average time at dock', value: int(fm.avgDockTime), unit: 'min', sub: `limit ${s.rules.dockStayMax} min`, hint: 'Average dock stay of outbound visits completed in the period.' },
        { key: 'dispatched', label: 'Pallets dispatched', value: int(wh().output), unit: 'pallets', sub: 'loading complete', hint: 'Pallets on trucks whose loading completed in the period.' },
      ];
    }
    case 'K-FLT': {
      const forklifts = s.logistics.active.map((v) => s.logistics.vehicles[v]).filter((v) => v.class === 'internal' && v.type === 'forklift');
      const acts = forklifts.map((v) => internalActivity(v, s.minute));
      const util = acts.filter((a) => a.idleLastHour != null).map((a) => 1 - a.idleLastHour! / 60);
      return [
        { key: 'on-duty', label: 'Forklifts on duty', value: String(forklifts.length), hint: 'Internal forklifts simulated on site now.' },
        { key: 'moving', label: 'Moving now', value: String(acts.filter((a) => a.moving).length), sub: `${acts.filter((a) => !a.moving).length} stationary`, hint: 'Forklifts on a driving leg now (simulated positions).' },
        util.length
          ? { key: 'utilisation', label: 'Utilisation · last hour', value: pct0(util.reduce((a, b) => a + b, 0) / util.length), unit: '%', sub: 'mean of the fleet', hint: 'Share of the last hour each forklift was not idle or waiting (simulated activity log), averaged.' }
          : noData('utilisation', 'Utilisation · last hour', 'Less than an hour of forklift activity recorded.', 'Share of the last hour not idle.'),
      ];
    }
    default: {
      const io = wh();
      return [
        { key: 'stock', label: 'Pallets in stock', value: int(s.logistics.stockPallets), unit: 'pallets', hint: 'Finished-goods pallets in the warehouse now (simulated stock).' },
        { key: 'in', label: 'Pallets in', value: int(io.input), unit: 'pallets', sub: 'off the wrapper', hint: 'Palletised tiles ÷ tiles per pallet in the period.' },
        { key: 'out', label: 'Pallets dispatched', value: int(io.output), unit: 'pallets', sub: 'loading complete', hint: 'Pallets on trucks whose loading completed in the period.' },
      ];
    }
  }
}

/** Inspection stations counted on the sorting line (the QC bench takes manual samples, no counters). */
const COUNTED_STATIONS = new Set(INSPECTION_STATIONS.filter((st) => st.detects.length > 0).map((st) => st.equipmentId));

/**
 * The data feeds an asset's figures rest on, with what a stale one means for them: its own counters
 * (machines, conveyors), the sorting line's counters (inspection stations — as the Quality KPIs), the
 * rate signals either side of a buffer, the palletiser's count (pallets into the warehouse).
 */
function feedsOf(prof: AssetProfile): { ids: string[]; note: string; keep: string[] } | null {
  switch (prof.kind) {
    case 'machine':
      return {
        ids: [prof.id],
        note: 'counts, times and shares are the simulation’s running accounting, which the feed has not confirmed since then; the rate is the last value received.',
        // The rate tile says "Last value"; the input buffer's level comes from the buffer's own signal.
        keep: ['rate', 'backlog'],
      };
    case 'conveyor':
      return { ids: [prof.id], note: 'counts and times are the simulation’s running accounting, which the feed has not confirmed since then.', keep: [] };
    case 'station':
      return COUNTED_STATIONS.has(prof.id)
        ? { ids: ['I-SORT'], note: 'the inspection counts are the simulation’s running accounting, which the sorting line’s feed has not confirmed since then.', keep: [] }
        : null;
    case 'buffer': {
      const { up, down } = bufferNeighbours(prof.bufferId!);
      return {
        ids: [...(up?.machines ?? []), ...(down?.machines ?? [])],
        note: 'the filling and drawing rates are the last values received; the level comes from the buffer’s own signal.',
        keep: ['level', 'trend', 'time-to', 'inflow', 'outflow'],
      };
    }
    case 'logistics':
      return prof.id === 'K-RACK' ? { ids: ['J-PAL'], note: 'pallets in are the simulation’s running count, which the palletiser’s feed has not confirmed since then.', keep: ['stock', 'out'] } : null;
    default:
      return null;
  }
}

/** The KPI set of one equipment item for a period (default: the current shift, as on the Overview). */
export function equipmentKpis(s: SimState, id: string, p: Period = resolvePeriod('shift', s.minute), claim?: ConstraintClaim): EqKpiSet {
  const prof = assetProfile(id);
  const feeds = feedsOf(prof);
  const stale = feeds ? staleMark(s, feeds.ids, p, feeds.note) : null;
  const set = (kpis: EqKpi[]): EqKpiSet => ({ scope: p.label, staleSince: stale?.since ?? null, stale, kpis: markTiles(kpis, stale, feeds?.keep) });
  switch (prof.kind) {
    case 'machine':
      return set(machineKpis(s, prof, p, claim ?? constraintClaim(s)));
    case 'conveyor':
      return set(conveyorKpis(s, id, p));
    case 'buffer':
      return set(bufferKpis(s, prof));
    case 'station':
      return set(stationKpis(s, prof, p));
    case 'raw':
      return set(rawKpis(s, p));
    case 'logistics':
      return set(logisticsKpis(s, id, p));
    default:
      return { scope: p.label, staleSince: null, stale: null, kpis: [], note: NO_OPERATING_DATA };
  }
}

// ── Vehicles ───────────────────────────────────────────────────────────────

/** Vehicle KPIs: simulated location, movement (stationary time at the current stop, never zone residency), task / visit phase, utilisation. */
export function vehicleKpis(s: SimState, id: string): EqKpiSet {
  const v = s.logistics.vehicles[id];
  const now = s.minute;
  const scope = `Now · ${formatClock(now)}`;
  if (!v) return { scope, kpis: [], note: 'This vehicle is no longer simulated.' };
  const zone = vehicleGeofence(s, id);
  const act = internalActivity(v, now);
  const location: EqKpi = {
    key: 'location',
    label: 'Location',
    value: zone?.name ?? '—',
    sub: 'simulated · zone level',
    hint: 'Geofence of the vehicle’s current simulated leg. No GPS, telematics or indoor positioning is connected.',
  };
  const movement: EqKpi = act.current
    ? act.moving
      ? { key: 'movement', label: 'Movement', value: 'Moving', sub: act.current.activity, status: { tone: 'good', label: 'On a driving leg' }, hint: 'The vehicle is on a driving leg of its simulated route.' }
      : {
          key: 'movement',
          label: 'Stationary for',
          value: formatDuration(act.stationaryMin),
          sub: act.stationaryMin != null ? `since ${formatClock(now - act.stationaryMin)}` : undefined,
          hint: 'Time standing at the current stop (simulated route legs). Not the time spent in the zone, which can span many stops.',
        }
    : noData('movement', 'Movement', 'No route leg has started yet.', 'Driving or stationary at the current stop.');
  if (v.class === 'internal') {
    const util = act.idleLastHour != null ? 1 - act.idleLastHour / 60 : null;
    return {
      scope,
      kpis: [
        location,
        movement,
        { key: 'task', label: 'Task', value: act.current?.activity ?? v.task ?? 'Idle', sub: v.task && v.task !== act.current?.activity ? v.task : undefined, hint: 'Activity of the current simulated route leg.' },
        util == null
          ? noData('utilisation', 'Utilisation · last hour', 'Less than an hour of activity recorded for this vehicle.', 'Share of the last hour not idle or waiting.')
          : { key: 'utilisation', label: 'Utilisation · last hour', value: pct0(util), unit: '%', sub: `${int(act.idleLastHour)} min idle`, hint: 'Share of the last hour the vehicle was not idle, waiting or available (simulated activity log).' },
      ],
    };
  }
  const t = v as TruckRuntime;
  const vis = t.visit;
  const d = vis ? visitDurations(t, now) : null;
  const onSite = vis && vis.gateIn <= now ? (vis.gateOut ?? now) - vis.gateIn : null;
  const phase = vis && vis.gateIn > now ? 'Approaching' : v.phase ? phaseLabel[v.phase] : '—';
  return {
    scope,
    kpis: [
      location,
      {
        key: 'phase',
        label: 'Visit phase',
        value: phase,
        sub: vis ? `${vis.direction === 'outbound' ? 'Outbound' : 'Inbound'} · ${vis.direction === 'outbound' ? `${vis.load} pallets` : `${vis.load} t ${vis.material ?? ''}`.trim()}` : undefined,
        status: v.phase === 'waiting' ? { tone: 'warning', label: 'Waiting' } : null,
        hint: 'Current step of the simulated truck visit.',
      },
      d?.waiting != null
        ? {
            key: 'waiting',
            label: 'Waiting for dock',
            value: formatDuration(d.waiting),
            sub: `limit ${s.rules.truckWaitMax} min`,
            status: d.waiting > s.rules.truckWaitMax ? { tone: 'warning', label: 'Over limit' } : null,
            hint: 'Holding-area wait from queueing to dock assignment (to now while still waiting).',
          }
        : noData('waiting', 'Waiting for dock', vis?.direction === 'inbound' ? 'Inbound tippers unload at the raw-material shed without queueing for a dock.' : 'Has not queued for a dock.', 'Holding-area wait.'),
      d?.dockTime != null
        ? { key: 'dock', label: 'At dock', value: formatDuration(d.dockTime), sub: `limit ${s.rules.dockStayMax} min`, status: d.dockTime > s.rules.dockStayMax ? { tone: 'warning', label: 'Over limit' } : null, hint: 'Time at the dock or unloading point.' }
        : noData('dock', 'At dock', 'Not at a dock yet.', 'Time at the dock or unloading point.'),
      onSite != null
        ? { key: 'on-site', label: vis?.gateOut != null ? 'Turnaround' : 'On site', value: formatDuration(onSite), sub: `limit ${s.rules.turnaroundMax} min`, status: onSite > s.rules.turnaroundMax ? { tone: 'warning', label: 'Over limit' } : null, hint: 'Gate-in to gate-out (to now while on site).' }
        : noData('on-site', 'On site', 'Not through the gate yet.', 'Gate-in to gate-out.'),
    ],
  };
}


// ── Production stage (stage highlight panel) ───────────────────────────────

/** Monitored stages made of two process stages: their input and output are different counting points. */
const TWO_POINT_STAGES = new Set<MonitoredStageId>(['GLAZE', 'PACK']);

/**
 * Stage context figures from its counting points (src/sim/metrics.ts stageIO), in the units and at
 * the boundary of the Overview flow strip (src/ui/flow/derive.ts), so selecting a stage shows the
 * same figure in both places:
 *  - output in m² as the main figure with the tile count next to it — a tile-equivalent of slip or
 *    powder for preparation and spray drying, never "tiles";
 *  - at sorting (the line output stage) the line's good output — tiles accepted at sorting
 *    (lineMetrics) — with the rejected tiles as a subline, not every tile sorted;
 *  - the rate against the stage's ideal capacity. Only the line constraint runs near its ideal
 *    capacity; the other stages have spare capacity by design, so a lower share is shown neutrally.
 *    A warning only while the constraint claim (constraintClaim, the Overview's wording) names the
 *    stage as currently constraining output.
 * A stale data feed of a counting asset of the stage (stageCountingAssets) leaves the figures at the
 * simulation's running count — the same number as the KPI cards and the flow strip — and marks them
 * "Not confirmed · <asset> data stale since hh:mm" (the set's `stale`, shown by KpiTiles, and a
 * not-confirmed status on each figure resting on the counters).
 */
export function stageKpis(s: SimState, stage: MonitoredStageId, p: Period = resolvePeriod('shift', s.minute), claim: ConstraintClaim = constraintClaim(s)): EqKpiSet {
  const io = stageIO(s, stage, p);
  const ms = MONITORED_STAGE_BY_ID[stage];
  const pallets = io.unit === 'pallets';
  const eq = !pallets && /tile-equivalent/i.test(ms.output.label);
  const tiles = eq ? 'tile-eq.' : 'tiles';
  const kpis: EqKpi[] = [];
  if (pallets)
    kpis.push({
      key: 'output',
      label: 'Pallets dispatched',
      value: int(io.output),
      unit: 'pallets',
      sub: io.input != null ? `${int(io.input)} pallets off the wrapper` : undefined,
      hint: 'Pallets on trucks whose loading completed in the period (dock loading-complete events), and pallets built (palletised tiles ÷ tiles per pallet).',
    });
  else if (stage === LINE.outputStage) {
    const lm = lineMetrics(s, p);
    kpis.push({
      key: 'output',
      label: 'Good output',
      value: int(lm.outputM2),
      unit: 'm²',
      sub: `${int(lm.output)} tiles accepted · rejected ${int(lm.rejected)} tiles`,
      hint: `Tiles accepted at sorting in the period — the line's good output, the same figure as the Overview flow strip — at ${M2_PER_TILE} m² per tile. Rejected tiles (gauge and vision tunnel) leave the line here and are not output.`,
    });
  } else {
    const out = io.output;
    kpis.push({
      key: 'output',
      label: 'Output',
      value: int(out == null ? null : out * M2_PER_TILE),
      unit: eq ? 'm² eq.' : 'm²',
      sub: `${int(out)} ${tiles}${TWO_POINT_STAGES.has(stage) && io.input != null ? ` · input ${int(io.input)} ${tiles}` : ''}`,
      hint: `${ms.output.label} in the period (${ms.output.signalId ?? 'stage counters'}), at ${M2_PER_TILE} m² per tile${eq ? ': a tile-equivalent of the slip or powder, not tiles' : ''} — the same figure as the Overview flow strip.`,
    });
  }
  if (io.ratePerHour != null) {
    const rateUnit = pallets ? 'pallets/h' : `${tiles}/h`;
    const ideal = io.expectedPerHour;
    const ratio = ideal != null && ideal > 0 ? io.ratePerHour / ideal : null;
    const constraining = claim.constraining && claim.stage === stage;
    kpis.push({
      key: 'rate',
      label: 'Rate',
      value: int(io.ratePerHour),
      unit: rateUnit,
      sub: ratio != null ? `${pct0(ratio)} % of ideal capacity (${int(ideal)} ${rateUnit})` : undefined,
      status: ratio == null ? null : constraining ? { tone: 'warning', label: 'Constraining output' } : ratio >= 0.95 ? { tone: 'good', label: 'At ideal capacity' } : null,
      hint:
        'Output per hour over the period against the stage’s ideal capacity (ideal rate × planned time). Only the line constraint is meant to run near its ideal capacity; the other stages have spare capacity by design, so a lower share is not a loss in itself. A warning only while the constraint analysis attributes lost line output to this stage now.',
    });
  }
  if (io.wip != null)
    kpis.push({
      key: 'wip',
      label: pallets ? 'Pallets in stock' : 'Work in progress',
      value: int(io.wip),
      // Slip tanks and powder silos hold tile-equivalents (the stage's input per the counting registry).
      unit: pallets ? 'pallets' : /tile-equivalent/i.test(`${ms.input.label} ${ms.input.note ?? ''}`) ? 'tile-eq.' : 'tiles',
      sub: io.wipCapacity ? `${pct0(io.wip / io.wipCapacity)} % of the input buffer` : undefined,
      hint: 'Level of the stage’s input buffer now (or warehouse stock).',
    });
  if (!pallets && io.downMin != null && io.starvedMin != null && io.blockedMin != null)
    kpis.push({
      key: 'lost',
      label: 'Time not producing',
      value: formatDuration(io.downMin + io.starvedMin + io.blockedMin),
      sub: `${formatDuration(io.downMin)} down · ${formatDuration(io.starvedMin + io.blockedMin)} starved / blocked`,
      hint: 'Minutes per machine the stage was stopped by its own stops, or starved / blocked by its neighbours, in the period.',
    });
  const stale = staleMark(
    s,
    stageCountingAssets(stage),
    p,
    pallets
      ? 'pallets built off the wrapper are the simulation’s running count, which the palletiser’s feed has not confirmed since then; dispatch counts come from the dock records.'
      : 'the figures are the simulation’s running count — the same numbers as on every other surface — which the feed has not confirmed since then.',
  );
  if (!stale || pallets) return { scope: p.label, kpis, staleSince: stale?.since ?? null, stale };
  // Which tiles rest on a stale counter: output and rate on the output counting point (the flow
  // strip's rule), time not producing on every machine of the stage; buffer levels on neither. A
  // constraining claim keeps its warning (the one constraint statement).
  const outStale = staleFeeds(s, outputMachines(stage), p).length > 0;
  const keep = ['wip', ...(outStale && !(claim.constraining && claim.stage === stage) ? [] : ['rate']), ...(outStale ? [] : ['output'])];
  return { scope: p.label, kpis: markTiles(kpis, stale, keep), staleSince: stale.since, stale };
}

/**
 * Assets whose counters make a monitored stage's figures: the machines of its process stages (input,
 * output and time not producing), the palletiser for the warehouse (pallets off the wrapper).
 */
export function stageCountingAssets(stage: MonitoredStageId): string[] {
  if (stage === 'WH') return STAGE_BY_ID.PAL.machines;
  const ps: StageId[] = stage === 'GLAZE' ? ['GLAZE', 'DECOR'] : stage === 'PACK' ? ['PACK', 'PAL'] : [stage];
  return ps.flatMap((x) => STAGE_BY_ID[x].machines);
}
