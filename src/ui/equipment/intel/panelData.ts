/**
 * The wave-3 parts of the equipment panel model (brief §6), kept out of derive.ts so it stays an adapter: the chart
 * set over the viewer's range, the rule findings merged with the curated insights (one statement per topic), the
 * Events & alarms log (alarm codes and condition alerts, state transitions, data-quality findings and signal-loss
 * events) and the catalogue view of Technical details. Pure functions of the simulation state; nothing here claims
 * connectivity or uses AI — findings are 'Rule-based' or 'Statistical'.
 */
import { AVAILABILITY_CLASS_LABEL, AVAILABILITY_STATUS_LABEL, KG_PER_TILE, KILN_ZONES, PROCESS_SIGNAL_BY_ID, catalogFor, definitionOf } from '../../../model/catalog';
import type { RangeKey } from '../../../model/telemetry';
import { seriesToSamples, setpointDeviation, trendSlope } from '../../../calc';
import { bufferHeldBy } from '../../../intel/rules/defs/flow';
import { formatClock } from '../../../sim/time';
import { BUFFER_LEVEL_BAND, bufferLevelBand } from '../kpis';
import { CONDITION_MONITORED, REASON_BY_CODE } from '../../../model/plant';
import type { OperationalState } from '../../../model/types';
import { findingsFor, resolveParam, rulesFor, useRuleThresholds, type RuleFinding } from '../../../intel/rules';
import { SEVERITY_RANK } from '../../../intel/rules/types';
import type { SimState } from '../../../sim/engine';
import { OPERATIONAL_STATE_LABEL } from '../../../sim/metrics';
import { readSignal, seriesOf, stateTimeline } from '../../../sim/telemetry';
import { formatDuration } from '../../../sim/time';
import { localeNumber } from '../../../sim/numberFormat';
import { CM_ALERT_PREFIX } from '../monitoring';
import { chartSignals, chartsFor, notCharted, type ChartSubject } from './charts';
import { effectiveRange, rangeAvailability, windowOf } from './ranges';
import type { IntelCatalog, IntelCharts, IntelFindings, IntelInsight, IntelLogEntry } from './types';

// ── Charts ───────────────────────────────────────────────────────────────────

/** The chart set of a subject for the viewer's range (or the closest shorter one the data serves). */
export function panelCharts(s: SimState, subject: ChartSubject, wanted: RangeKey): IntelCharts | null {
  const disabled = rangeAvailability(s, chartSignals(subject));
  const range = effectiveRange(wanted, disabled);
  const specs = chartsFor(s, subject, range);
  const nc = subject.kind === 'equipment' ? notCharted(subject.equipmentId) : [];
  if (!specs.length && !nc.length) return null;
  const w = windowOf(s, range);
  return { range, disabled, specs, notCharted: nc, window: { from: w.from, to: w.to } };
}

// ── Findings merged with the curated insights ────────────────────────────────

/**
 * The curated insight topics (derive.ts insight id prefixes) a rule says the same thing as. A fired finding whose
 * topic a curated insight already presents for the asset is not repeated; its rule id is added to that insight's
 * evidence instead.
 */
export const RULE_TOPICS: Record<string, string[]> = {
  'RL-DRIVE': ['condition:'],
  'F-STARVE': ['flow:'],
  'F-BLOCK': ['flow:'],
  'F-POWDER-STARVATION': ['flow:'],
  'F-DOWNSTREAM-CONSTRAINT': ['flow:', 'role:'],
  'F-BUFFER-TREND': ['buffer:'],
  'F-BALANCE': ['buffer:'],
  'P-OUTPUT': ['rate:', 'event:'],
  'P-DECLINE': ['rate:'],
  'P-CYCLE': ['rate:'],
  'RL-LONG-STOP': ['event:'],
  'DQ-SOURCE': ['stale:'],
  'DQ-STALE': ['stale:'],
  'QL-REJECT-BASELINE': ['quality:'],
  'QL-FPY-DECLINE': ['quality:'],
  'QL-DEFECT-CATEGORY': ['quality:'],
};

/**
 * Merges the rule engine's findings for an equipment item with its curated insights: fired findings on a topic a
 * (non-positive) curated insight already covers are dropped and named on that insight as a rule chip; an
 * "Operating normally" insight is dropped while a finding of warning severity or above has fired.
 */
export function mergeFindings(insights: IntelInsight[], findings: RuleFinding[]): { insights: IntelInsight[]; findings: IntelFindings } {
  const merged: IntelFindings['merged'] = [];
  const out = insights.map((i) => ({ ...i, evidence: [...i.evidence] }));
  const shown: RuleFinding[] = [];
  for (const f of findings) {
    if (f.status !== 'fired') {
      shown.push(f);
      continue;
    }
    const topics = RULE_TOPICS[f.ruleId] ?? [];
    const host = out.find((i) => i.severity !== 'positive' && topics.some((t) => i.id.startsWith(t)));
    if (host) {
      merged.push({ ruleId: f.ruleId, insightId: host.id });
      if (!host.evidence.some((e) => e.kind === 'rule' && e.ref === f.ruleId)) host.evidence.push({ kind: 'rule', label: `Also rule ${f.ruleId}`, ref: f.ruleId });
      continue;
    }
    shown.push(f);
  }
  const attention = shown.some((f) => f.status === 'fired' && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.warning);
  return { insights: attention ? out.filter((i) => i.severity !== 'positive') : out, findings: { shown, merged } };
}

/** The asset's findings (memoised by the engine per minute and thresholds version). */
export const assetFindings = (s: SimState, equipmentId: string) => findingsFor(s, { kind: 'equipment', equipmentId });

// ── Events & alarms log ──────────────────────────────────────────────────────

const STOPPED: ReadonlySet<OperationalState> = new Set(['stopped', 'fault']);
const stateWords = (st: OperationalState, label?: string) => (st === 'unknown' && label ? `Unknown (${label.toLowerCase()})` : OPERATIONAL_STATE_LABEL[st]);

/**
 * Alarms (the alarm code active now, alarm codes of unplanned stops, condition-monitoring alerts), state transitions
 * (stops and restarts with times, durations and reasons) and data-quality entries (fired DQ findings) of an asset in
 * a window, newest first. Event records stay in the event list; acknowledgement is not part of this log.
 */
export function eventLog(s: SimState, id: string, window: { from: number; to: number }, findings: RuleFinding[] = []): IntelLogEntry[] {
  const out: IntelLogEntry[] = [];
  const to = Math.min(window.to, s.minute);
  if (s.machines[id]) {
    const alarm = readSignal(s, `${id}.alarm`);
    if (typeof alarm.value === 'string' && alarm.value !== 'none' && alarm.quality !== 'missing') {
      const stop = s.machines[id].activeDowntimeId ? s.downtime.find((d) => d.id === s.machines[id].activeDowntimeId) : null;
      out.push({
        id: `alarm:now:${id}`,
        kind: 'alarm',
        t: stop?.start ?? alarm.timestamp ?? s.minute - 1,
        end: null,
        severity: 'serious',
        title: `Active alarm code · ${alarm.text}`,
        detail: alarm.quality === 'stale' ? 'Last value of a stale feed' : undefined,
        source: `Alarm code · ${id}.alarm (simulated)`,
      });
    }
    for (const d of s.downtime) {
      if (d.equipmentId !== id || d.category === 'Starved' || d.category === 'Blocked' || d.start >= to || (d.end ?? s.minute) <= window.from) continue;
      const r = REASON_BY_CODE[d.reasonCode];
      if (r?.planned || r?.category === 'Changeover') continue;
      if (d.end == null && out.some((e) => e.id === `alarm:now:${id}`)) continue;
      out.push({
        id: `alarm:${d.id}`,
        kind: 'alarm',
        t: d.start,
        end: d.end,
        severity: 'warning',
        title: `Alarm / stop code ${d.reasonCode} · ${r?.label ?? d.reasonCode}`,
        detail: `${d.category} · ${d.end == null ? `ongoing ${formatDuration(s.minute - d.start)}` : formatDuration(d.end - d.start)}`,
        source: `Stop record · ${id}.alarm (simulated)`,
      });
    }
    // State transitions over the window (a change of state; the first segment is where the window starts).
    const segs = stateTimeline(s, id, { from: window.from, to });
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1];
      const b = segs[i];
      if (a.state === b.state) continue;
      const restart = STOPPED.has(a.state) || a.state === 'planned' || a.state === 'changeover';
      const reason = b.reason ? (REASON_BY_CODE[b.reason]?.label ?? b.reason) : null;
      out.push({
        id: `state:${id}:${b.from}`,
        kind: 'state',
        t: b.from,
        end: b.to >= to ? null : b.to,
        severity: STOPPED.has(b.state) ? 'warning' : 'info',
        title: `${stateWords(a.state, a.label)} → ${stateWords(b.state, b.label)}`,
        detail: [restart && !STOPPED.has(b.state) ? `after ${formatDuration(a.to - a.from)} ${OPERATIONAL_STATE_LABEL[a.state].toLowerCase()}` : null, reason, b.to >= to ? `ongoing ${formatDuration(to - b.from)}` : `for ${formatDuration(b.to - b.from)}`]
          .filter(Boolean)
          .join(' · '),
        source: 'State signal · stop records (simulated)',
      });
    }
  }
  for (const al of s.alerts) {
    if (al.equipmentId !== id || al.time < window.from || al.time >= to || !al.title.startsWith(CM_ALERT_PREFIX)) continue;
    out.push({ id: `alert:${al.id}`, kind: 'alarm', t: al.time, severity: al.severity, title: al.title, detail: al.detail, source: 'Condition monitoring · rule-based on simulated signals' });
  }
  for (const f of findings) {
    if (f.family !== 'data' || f.status !== 'fired') continue;
    out.push({
      id: `dq:${f.key}`,
      kind: 'data',
      t: f.firstSeen ?? s.minute - 1,
      end: null,
      severity: f.severity,
      title: f.title,
      detail: f.explanation.split(/(?<=\.)\s/)[0],
      source: `Rule ${f.ruleId} · rule-based on simulated data`,
    });
  }
  for (const e of s.events) {
    if (e.category !== 'data' || e.asset.equipmentId !== id || e.start >= to || (e.end ?? s.minute) <= window.from) continue;
    out.push({ id: `dqev:${e.id}`, kind: 'data', t: e.start, end: e.end, severity: e.severity, title: e.title, detail: e.summary, source: `Event rule ${e.trigger.ruleId}`, eventId: e.id });
  }
  return out.sort((a, b) => b.t - a.t || a.id.localeCompare(b.id));
}

// ── Process now: PV / SP deviation gauges, the kiln's zone profile, a buffer's level gauge ──────────

const SIGNED = [0, 1, 2, 3].map((d) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtNum = (v: number, d: number) => SIGNED[Math.max(0, Math.min(3, d))].format(v).replace(/^-/, '−');

/** One process value against its setpoint now, with the bands it is judged by. */
export type ProcessGauge = {
  pvId: string;
  spId: string;
  /** "Zone 3 temperature · peak firing", "Outlet air temperature". */
  label: string;
  /** Short row label ("Z3 Peak firing", "Outlet air temperature"). */
  short: string;
  unit: string | null;
  digits: number;
  /** Process value now (null: none usable — `reason` says why; never a zero standing in). */
  pv: number | null;
  sp: number | null;
  /** pv − sp (null without both). */
  dev: number | null;
  /** Half-widths of the warning / alarm bands around the setpoint (catalogue limits around the nominal SP). */
  warn: number | null;
  alarm: number | null;
  level: 'within' | 'warning' | 'alarm' | null;
  /** Why no deviation is shown (bad quality, stale, no value while not producing). */
  reason: string | null;
  /** A stale reading's minute (the value shown is the last one received). */
  staleAt: number | null;
};

/** A buffer's level now (% of capacity only — never a mass), its 60-min trend and the low / high lines. */
export type LevelGauge = {
  signalId: string;
  name: string;
  /** Level % now (null: none usable, `reason` says why). */
  value: number | null;
  reason: string | null;
  /** Least-squares trend of the last 60 min (%/h), or why there is none. */
  trend: number | null;
  trendReason: string | null;
  low: number;
  high: number;
  /** What the level means on its side of the kiln ("Normal band", "Nearly empty", "Full · normal ahead of the kiln"). */
  band: { label: string; concern: boolean } | null;
  /** Slip tanks and silos: level only, no mass calibration. */
  bulk: boolean;
  staleAt: number | null;
};

export type IntelProcess = {
  /** 'zones': the kiln's five zones as a profile along the kiln; 'pairs': other PV / SP pairs; 'none': no pair. */
  kind: 'zones' | 'pairs' | 'none';
  gauges: ProcessGauge[];
  level: LevelGauge | null;
};

function processGauge(s: SimState, pvId: string, spId: string, short: string): ProcessGauge {
  const d = definitionOf(pvId)!;
  const spec = PROCESS_SIGNAL_BY_ID[pvId];
  const digits = spec?.digits ?? 1;
  const warn = d.warningHigh != null && spec?.nominal != null ? d.warningHigh - spec.nominal : null;
  const alarm = d.alarmHigh != null && spec?.nominal != null ? d.alarmHigh - spec.nominal : null;
  const pvR = readSignal(s, pvId);
  const spR = readSignal(s, spId);
  const sp = typeof spR.value === 'number' && spR.quality !== 'bad' && spR.quality !== 'missing' ? spR.value : null;
  const usable = typeof pvR.value === 'number' && pvR.quality !== 'bad' && pvR.quality !== 'missing';
  const pv = usable ? (pvR.value as number) : null;
  const stale = usable && pvR.quality === 'stale';
  let reason: string | null = null;
  if (pvR.quality === 'bad') reason = `Bad-quality reading${pvR.note ? ` (${pvR.note})` : ''} — not compared`;
  else if (pv == null) reason = pvR.note ?? 'No value now (the machine is not producing)';
  else if (sp == null) reason = 'Setpoint not reported';
  const dev = pv != null && sp != null ? pv - sp : null;
  const dv = dev != null && !stale ? setpointDeviation(pv, sp, warn != null && alarm != null ? { warn, alarm } : undefined) : null;
  return {
    pvId,
    spId,
    label: d.name.replace(/ · actual$/, ''),
    short,
    unit: d.unit,
    digits,
    pv,
    sp,
    dev,
    warn,
    alarm,
    level: dv && dv.status === 'ok' && warn != null ? dv.value.level : null,
    reason: reason ?? (stale && pvR.timestamp != null ? `Last value ${formatClock(pvR.timestamp)} (feed stale) — not compared` : null),
    staleAt: stale ? pvR.timestamp : null,
  };
}

/**
 * The asset's process now, from its simulated catalogue signals: the kiln's five zones (PV / SP) as a profile, any
 * other PV / SP pairs as deviation gauges, and — for a buffer, silo or tank — its level gauge. Null when the asset has
 * none of these (sorting, conveyors, packing): the panel then has no process block.
 */
export function processView(s: SimState, id: string): IntelProcess | null {
  const sim = (sig: string) => definitionOf(sig)?.availabilityStatus === 'simulated';
  const zoneIds = KILN_ZONES.map((z) => ({ z, pv: `${id}.zone${z.no}_temp_pv`, sp: `${id}.zone${z.no}_temp_sp` }));
  const zones = zoneIds.every((x) => sim(x.pv) && sim(x.sp));
  const gauges: ProcessGauge[] = zones ? zoneIds.map((x) => processGauge(s, x.pv, x.sp, `Z${x.z.no} ${x.z.role}`)) : [];
  if (!zones)
    for (const d of catalogFor(id))
      if (d.setpointSignalId && d.availabilityStatus === 'simulated' && d.category === 'process' && sim(d.setpointSignalId))
        gauges.push(processGauge(s, d.signalId, d.setpointSignalId, d.name.replace(/ · actual$/, '')));
  const held = bufferHeldBy(id);
  let level: LevelGauge | null = null;
  if (held && sim(held.level)) {
    const r = readSignal(s, held.level);
    const value = typeof r.value === 'number' && r.quality !== 'bad' && r.quality !== 'missing' ? r.value : null;
    const recent = seriesOf(s, held.level, { from: s.minute - 60, to: s.minute, stepMin: 1 });
    const tr = recent ? trendSlope(seriesToSamples(recent, recent.t[0] ?? 0), { minSamples: 20, minSpanMin: 30 }) : null;
    const band = value != null ? bufferLevelBand(held.buf.id, value / 100) : null;
    level = {
      signalId: held.level,
      name: held.buf.name,
      value,
      reason: value == null ? (r.quality === 'bad' ? 'Bad-quality level reading — not shown' : (r.note ?? 'No level value received')) : null,
      trend: tr?.status === 'ok' ? tr.value : null,
      trendReason: tr ? (tr.status === 'ok' ? null : tr.reason) : 'No level history',
      low: BUFFER_LEVEL_BAND.low * 100,
      high: BUFFER_LEVEL_BAND.high * 100,
      band: band ? { label: band.label, concern: band.concern } : null,
      bulk: held.bulk != null,
      staleAt: value != null && r.quality === 'stale' ? r.timestamp : null,
    };
  }
  if (!gauges.length && !level) return null;
  return { kind: zones ? 'zones' : gauges.length ? 'pairs' : 'none', gauges, level };
}

/** "+12 °C", "−0.4 %" — a deviation with its sign and unit. */
export function deviationText(g: Pick<ProcessGauge, 'dev' | 'digits' | 'unit'>): string {
  if (g.dev == null) return '—';
  const mag = fmtNum(Math.abs(g.dev), g.digits);
  // A deviation that rounds to zero has no sign ("0 °C", never "−0 °C").
  const sign = Number(mag.replace(/,/g, '')) === 0 ? '' : g.dev > 0 ? '+' : '−';
  return `${sign}${mag}${g.unit ? ` ${g.unit}` : ''}`;
}
export const valueText = (v: number | null, digits: number) => (v == null ? '—' : fmtNum(v, digits));

// ── Key-figure sparklines ────────────────────────────────────────────────────

/**
 * The simulated signal a key-figure tile reads now, when one backs it (the rate, a speed, a PV against its setpoint,
 * a cycle time, a level); null for counts, shares and durations of the period — those get no sparkline.
 */
export function tileSignal(id: string, key: string): string | null {
  const sim = (sig: string) => definitionOf(sig)?.availabilityStatus === 'simulated' && (definitionOf(sig)?.dataType === 'float' || definitionOf(sig)?.dataType === 'integer');
  const first = (...names: string[]) => names.map((n) => `${id}.${n}`).find(sim) ?? null;
  switch (key) {
    case 'rate':
      return first('slip_flow', 'powder_flow', 'rate');
    case 'speed':
      return first('roller_speed', 'line_speed', 'mill_speed', 'speed');
    case 'cycle':
      return first('cycle_time');
    case 'outlet':
      return first('outlet_temp_pv');
    case 'moisture':
      return first('powder_moisture_pv');
    case 'zone1':
      return first('zone1_temp_pv');
    case 'zone2':
      return first('zone2_temp_pv');
    case 'density':
      return first('glaze_density_pv', 'slip_density_pv');
    case 'level': {
      const held = bufferHeldBy(id);
      return held && sim(held.level) ? held.level : null;
    }
    default:
      return null;
  }
}

/** Sparkline values per tile key over the charts' range (only tiles a numeric simulated signal backs). */
export function tileTrends(s: SimState, id: string, keys: readonly string[], range: RangeKey): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const k of keys) {
    const sig = tileSignal(id, k);
    const x = sig ? seriesOf(s, sig, range) : null;
    if (x && x.v.filter((v) => v != null).length >= 2) out[k] = x.v;
  }
  return out;
}

// ── Technical details: the catalogue view ────────────────────────────────────

const PARAM_SOURCE = { default: 'default', 'event-rule': 'event rule', global: 'configured', equipment: 'configured' } as const;

/** Availability counts, the thresholds that apply (default vs configured) and the calculation definitions of an asset. */
export function catalogView(s: SimState, id: string): IntelCatalog | null {
  const defs = catalogFor(id);
  const rules = rulesFor({ kind: 'equipment', equipmentId: id });
  if (!defs.length && !rules.length) return null;
  const counts = new Map<string, { cls: string; status: string; n: number }>();
  for (const d of defs) {
    const k = `${d.availabilityClass}|${d.availabilityStatus}`;
    const c = counts.get(k) ?? { cls: AVAILABILITY_CLASS_LABEL[d.availabilityClass], status: AVAILABILITY_STATUS_LABEL[d.availabilityStatus], n: 0 };
    c.n++;
    counts.set(k, c);
  }
  const values = useRuleThresholds.getState().values;
  const thresholds: IntelCatalog['thresholds'] = [];
  for (const r of rules)
    for (const p of r.params) {
      let v: { value: number; source: keyof typeof PARAM_SOURCE };
      try {
        v = resolveParam(values, r.id, p.key, id, s.rules);
      } catch {
        continue;
      }
      const shown = v.value * (p.scale ?? 1);
      thresholds.push({ ruleId: r.id, rule: r.title, key: p.key, label: p.label, value: `${localeNumber(shown, undefined, p.decimals ?? 2)} ${p.unit}`.trim(), source: PARAM_SOURCE[v.source] });
    }
  const has = (name: string) => defs.some((d) => d.signalId === `${id}.${name}` && d.availabilityStatus === 'simulated');
  const definitions: IntelCatalog['definitions'] = [
    { label: 'Units', text: 'Rates per hour; stages 1–2 (slip, powder) in t/h, never tiles; silo and tank levels in % of capacity; temperatures °C, pressures bar, speeds m/min.' },
  ];
  if (has('slip_flow') || has('powder_flow') || id === 'D-SILO' || id === 'C-SLIP')
    definitions.push({ label: 'Mass flows (t/h)', text: `Simulated: tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg per tile-equivalent (KG_PER_TILE — a simulation assumption, not a weighed flow).` });
  if (has('cycle_time')) definitions.push({ label: 'Cycle time', text: 'Time of one press cycle (fill, press, de-air, eject) = 60 ÷ strokes per minute, mean over the minute; compared with the target cycle time of the die / product.' });
  if (defs.some((d) => d.category === 'material' && d.unit === '%'))
    definitions.push({ label: 'Level, trend and time to empty', text: 'Level % of capacity from the simulated level signal; trend = least-squares slope of the last 60 min; time to empty / full = a linear extrapolation of that trend — not a forecast. A level is not a mass without a calibration.' });
  if (defs.some((d) => d.setpointSignalId)) definitions.push({ label: 'PV vs SP', text: 'Process value against its setpoint; warning and alarm bands are absolute limits around the nominal setpoint (catalogue). A deviation episode is a run beyond the band.' });
  if (CONDITION_MONITORED.includes(id)) definitions.push({ label: 'Condition signals', text: 'Vibration, component temperature and motor current from the simulated condition model; assessed by rules, not a trained model.' });
  definitions.push({ label: 'Rule findings', text: 'Rule-based (thresholds, durations) or Statistical (significance tests) on simulated data. A required signal that is missing, stale or bad makes a rule "not evaluated" instead of silent.' });
  return { counts: [...counts.values()].sort((a, b) => b.n - a.n), thresholds, definitions };
}
