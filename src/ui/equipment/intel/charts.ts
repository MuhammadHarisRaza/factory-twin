/**
 * The chart set of an equipment item or a monitored stage (brief §6B) as pure, typed specs: one spec per kit chart
 * (src/ui/kit/charts.tsx), each with a stable id (the rule engine's CHART ids, so a finding's evidence can scroll to
 * it), title, unit, provenance, range / resolution, coverage and an honest empty reason. Which charts a subject gets
 * follows from its catalogue signals (src/model/catalog) — a signal that is not modelled or unavailable gets no chart
 * (notCharted lists it instead), never an invented line.
 *
 *   machines   state timeline · output rate vs ideal / planned rate (stages 1–2 in simulated t/h, disclosed)
 *   presses    cycle time vs target · cycle-time histogram (minute samples while running)
 *   PV / SP    each simulated process value against its setpoint (dashed step), warning / alarm lines, deviation bands
 *   kiln       the five zone temperatures in one chart (PV solid, SP dashed) · roller speed
 *   buffers    level % with the 60-min trend and time to empty / full (silos and slip tanks: % only) · inflow vs outflow
 *   sorting    reject rate per step (FPY and n in the tooltip) · defect categories
 *   conveyors  state timeline · speed
 *   all with stops: downtime by reason · events and stops on a strip
 *
 * Every value is simulated and says so. Specs are memoised per simulation minute, subject and range.
 */
import {
  deviationEpisodes,
  faultRecurrence,
  firstPassYield,
  histogram,
  rejectRate,
  seriesToSamples,
  setpointDeviation,
  timeToEmpty,
  timeToFull,
  trendSlope,
  type Sample,
  type Window,
} from '../../../calc';
import { EQUIPMENT_BY_ID } from '../../../data/equipment';
import { AVAILABILITY_STATUS_LABEL, catalogFor, definitionOf, KG_PER_TILE, KILN_ZONES, PROCESS_SIGNAL_BY_ID } from '../../../model/catalog';
import { CONVEYOR_BY_ID, DEFECTS, DEFECT_ORDER, INSPECTION_STATIONS, MONITORED_STAGE_BY_ID, OPS_BY_ID, STAGE_BY_ID } from '../../../model/plant';
import type { RangeKey, TelemetrySeries } from '../../../model/telemetry';
import type { DefectCategory, MonitoredStageId, OperationalState } from '../../../model/types';
import { buildContext, type RuleContext } from '../../../intel/rules/context';
import { FLOW_BUFFERS, bufferHeldBy, type FlowBuffer } from '../../../intel/rules/defs/flow';
import { plannedRateOf } from '../../../intel/rules/defs/production';
// The rules index registers every rule (and its parameter defaults) before a threshold is read.
import { useRuleThresholds } from '../../../intel/rules';
import { CHART } from '../../../intel/rules/types';
import type { SimState } from '../../../sim/engine';
import { OPERATIONAL_STATE_LABEL } from '../../../sim/metrics';
import { readSignal, seriesOf, stateTimeline } from '../../../sim/telemetry';
import { formatClock, formatDuration } from '../../../sim/time';
import type {
  HistogramBin,
  HistogramMarker,
  RankedRow,
  StateLane,
  StateLegendItem,
  StatePattern,
  StateTone,
  StripEvent,
  TimeBand,
  TimeMarker,
  TimeRefLine,
  TimeSeries,
} from '../../kit/charts';
import { BUFFER_LEVEL_BAND } from '../kpis';
import { windowOf, type RangeWindow } from './ranges';

// ── The spec contract ────────────────────────────────────────────────────────

export type ChartSubject = { kind: 'equipment'; equipmentId: string } | { kind: 'stage'; stageId: MonitoredStageId };

/** A compact figure next to a chart (trend, time to empty, latest vs target). */
export type ChartFact = { label: string; value: string; hint?: string };

type SpecBase = {
  /** Stable id (CHART ids where a rule links to the chart). */
  id: string;
  /** Further chart ids this chart answers (the kiln zone chart answers every zone's CHART.process id). */
  aliases?: string[];
  title: string;
  unit: string | null;
  provenance: 'Simulated';
  range: RangeKey;
  from: number;
  to: number;
  /** "minute data", "5-min steps of minute data", "hourly data", or what the chart reads instead. */
  resolution: string;
  /** "412 of 480 samples · …" — what part of the range has data. */
  coverage: string | null;
  /** A disclosure that belongs to the figure (simulated conversion, calibration). */
  note?: string;
  /** Set when there is nothing to draw: the honest reason. */
  emptyReason: string | null;
  facts?: ChartFact[];
};

export type TimeChartSpec = SpecBase & {
  kind: 'time';
  series: TimeSeries[];
  refLines: TimeRefLine[];
  bands: TimeBand[];
  markers?: TimeMarker[];
  yMin?: number;
  yMax?: number;
  /** Extra tooltip rows per sample time (e.g. the tiles inspected behind a reject rate). */
  tips?: Record<number, { label: string; value: string }[]>;
};
export type StatesChartSpec = SpecBase & { kind: 'states'; lanes: StateLane[]; legend: StateLegendItem[] };
export type HistogramChartSpec = SpecBase & { kind: 'histogram'; bins: HistogramBin[]; n: number; markers: HistogramMarker[]; minSamples: number };
export type RankedChartSpec = SpecBase & { kind: 'ranked'; rows: RankedRow[]; valueHeader: string; labelHeader: string; format: 'duration' | 'count' };
export type EventsChartSpec = SpecBase & { kind: 'events'; events: StripEvent[] };

export type ChartSpec = TimeChartSpec | StatesChartSpec | HistogramChartSpec | RankedChartSpec | EventsChartSpec;

/** Chart ids that are not rule CHART ids. */
export const PANEL_CHART = {
  zones: 'chart:zones',
  speed: 'chart:speed',
  flow: (levelId: string) => `chart:flow:${levelId}`,
  defects: 'chart:defects',
  downtime: 'chart:downtime',
  events: 'chart:events',
  histogram: 'chart:cycle-histogram',
} as const;

/** Every id a spec answers (its own and its aliases). */
export const chartIds = (spec: ChartSpec) => [spec.id, ...(spec.aliases ?? [])];

// ── Formatting ───────────────────────────────────────────────────────────────

const NF = [0, 1, 2, 3].map((d) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }));
const num = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? '—' : NF[Math.min(3, d)].format(v).replace(/^-/, '−'));
const signed = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${num(Math.abs(v), d)}`;
const span = (w: Window) => `${formatClock(w.from)}–${formatClock(w.to)}`;

/** The disclosure of every t/h figure derived from a tile-equivalent rate. */
export const MASS_FLOW_NOTE = `Simulated t/h: tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg per tile-equivalent (KG_PER_TILE, a simulation assumption — not a weighed flow).`;
/** Silos and slip tanks: a level is not a mass. */
export const LEVEL_ONLY_NOTE = 'Level % only — no level-to-mass calibration is configured, so no mass (t) is shown and time to empty is on a % basis.';

const coverageOf = (xs: (TelemetrySeries | null)[]): string | null => {
  const ok = xs.filter((x): x is TelemetrySeries => x != null);
  if (!ok.length) return null;
  const expected = ok.reduce((a, x) => a + x.coverage.expected, 0);
  const present = ok.reduce((a, x) => a + x.coverage.present, 0);
  const notes = [...new Set(ok.map((x) => x.note).filter(Boolean))];
  return [`${num(present)} of ${num(expected)} samples`, ...notes].join(' · ');
};

const hasValue = (xs: TimeSeries[]) => xs.some((x) => x.v.some((v) => v != null && Number.isFinite(v)));
const toTime = (x: TelemetrySeries, label: string, o: Partial<TimeSeries> = {}): TimeSeries => ({ id: x.signalId, label, t: x.t, v: x.v, ...o });
const simulated = (signalId: string) => definitionOf(signalId)?.availabilityStatus === 'simulated';
const equipmentName = (id: string) => CONVEYOR_BY_ID[id]?.name ?? EQUIPMENT_BY_ID[id]?.name ?? id;

function base(w: RangeWindow, id: string, title: string, unit: string | null, resolution = w.label.slice(w.label.indexOf('·') + 2)): SpecBase {
  return { id, title, unit, provenance: 'Simulated', range: w.key, from: w.from, to: w.to, resolution, coverage: null, emptyReason: null };
}

/** Values of aligned series summed per step (a gap in any of them is a gap in the sum, never a partial sum). */
function sumSeries(xs: { t: number[]; v: (number | null)[] }[]): (number | null)[] {
  if (!xs.length) return [];
  return xs[0].t.map((_, i) => {
    let a = 0;
    for (const x of xs) {
      const v = x.v[i];
      if (v == null || !Number.isFinite(v)) return null;
      a += v;
    }
    return a;
  });
}

/** Per-hour rate from a cumulative counter series (a fall — a reset — is a gap, not a negative rate). */
function counterRate(x: TelemetrySeries, factor = 1): (number | null)[] {
  return x.v.map((v, i) => {
    const p = i > 0 ? x.v[i - 1] : null;
    if (v == null || p == null || v < p) return null;
    return ((v - p) / x.stepMin) * 60 * factor;
  });
}

// ── States ───────────────────────────────────────────────────────────────────

type ChartState = OperationalState;
/** Tone and pattern per state: states sharing a tone differ in pattern, so colour is never the only cue. */
const STATE_STYLE: Record<ChartState, { tone: StateTone; pattern: StatePattern }> = {
  running: { tone: 'good', pattern: 'solid' },
  reduced: { tone: 'warning', pattern: 'solid' },
  starved: { tone: 'warning', pattern: 'hatch' },
  blocked: { tone: 'warning', pattern: 'dots' },
  idle: { tone: 'neutral', pattern: 'hatch' },
  stopped: { tone: 'critical', pattern: 'solid' },
  fault: { tone: 'critical', pattern: 'dots' },
  planned: { tone: 'planned', pattern: 'solid' },
  changeover: { tone: 'planned', pattern: 'hatch' },
  disconnected: { tone: 'unknown', pattern: 'hatch' },
  unknown: { tone: 'unknown', pattern: 'dots' },
};

function statesChart(s: SimState, w: RangeWindow, ids: string[], id: string = CHART.states): StatesChartSpec | null {
  const tracked = ids.filter((e) => s.machines[e]);
  if (!tracked.length) return null;
  const seen = new Set<ChartState>();
  const lanes: StateLane[] = tracked.map((e) => ({
    id: e,
    label: tracked.length === 1 ? 'State' : equipmentName(e),
    segments: stateTimeline(s, e, { from: w.from, to: w.to }).map((g) => {
      seen.add(g.state);
      return { from: g.from, to: g.to, state: g.state, ...(g.label ? { label: g.label } : {}) };
    }),
  }));
  const legend: StateLegendItem[] = (Object.keys(STATE_STYLE) as ChartState[]).filter((k) => seen.has(k)).map((k) => ({ state: k, label: OPERATIONAL_STATE_LABEL[k], ...STATE_STYLE[k] }));
  const any = lanes.some((l) => l.segments.length);
  return {
    ...base(w, id, tracked.length === 1 ? 'State timeline' : 'Equipment states', null, w.resolution === 'hour' ? 'stop records and the minute log' : 'minute log'),
    kind: 'states',
    lanes,
    legend,
    coverage: w.resolution === 'hour' ? 'Beyond the 8-h minute log: stops, starved and blocked spells from their records; a reduced rate is not recorded there' : 'Every minute of the range from the minute log',
    emptyReason: any ? null : 'No state record in this range',
  };
}

// ── Output rate ──────────────────────────────────────────────────────────────

/** The flow signal a machine's output is charted from: simulated t/h at stages 1–2, else its rate. */
function outputSignalOf(id: string): { signalId: string; mass: boolean } | null {
  for (const k of ['slip_flow', 'powder_flow']) if (simulated(`${id}.${k}`)) return { signalId: `${id}.${k}`, mass: true };
  return simulated(`${id}.rate`) ? { signalId: `${id}.rate`, mass: false } : null;
}

function rateChart(s: SimState, ctx: RuleContext, w: RangeWindow, ids: string[]): TimeChartSpec | null {
  const outs = ids.map((id) => ({ id, out: outputSignalOf(id) })).filter((x): x is { id: string; out: { signalId: string; mass: boolean } } => x.out != null);
  if (!outs.length) return null;
  const mass = outs.some((x) => x.out.mass);
  const xs = outs.map((x) => seriesOf(s, x.out.signalId, w.key));
  const unit = mass ? 't/h' : (xs.find(Boolean)?.unit ?? definitionOf(outs[0].out.signalId)?.unit ?? null);
  const factor = mass ? KG_PER_TILE / 1000 : 1;
  const series = xs.flatMap((x, i) => (x ? [toTime(x, outs.length === 1 ? 'Output rate' : equipmentName(outs[i].id), { color: `var(--series-${(i % 7) + 1})` })] : []));
  const refLines: TimeRefLine[] = [];
  const facts: ChartFact[] = [];
  if (outs.length === 1) {
    const plan = plannedRateOf(outs[0].id);
    if (plan) {
      // Ideal rate, and the target the output rule (P-OUTPUT) checks: its share of the planned (kiln-paced) rate.
      const share = ctx.param('P-OUTPUT', 'targetShare', outs[0].id);
      const target = plan.rate * share * factor;
      refLines.push({ value: plan.ideal * factor, label: `ideal ${num(plan.ideal * factor, mass ? 1 : 0)} ${unit}`, kind: 'limit' });
      refLines.push({ value: target, label: `target ${num(target, mass ? 1 : 0)} ${unit} (${num(share * 100)} % of the ${plan.paced ? 'kiln-paced planned' : 'ideal'} rate)`, kind: 'target' });
    }
    const vals = series[0]?.v.filter((v): v is number => v != null) ?? [];
    if (vals.length) facts.push({ label: 'Mean over the range', value: `${num(vals.reduce((a, v) => a + v, 0) / vals.length, mass ? 1 : 0)} ${unit}` });
  }
  // Own stops as bands (planned stops neutral), so a dip reads with its cause.
  const bands: TimeBand[] =
    outs.length === 1
      ? ctx.stops(outs[0].id, { from: w.from, to: w.to }).map((st) => ({
          from: st.start,
          to: st.end ?? s.minute,
          label: `${st.kind === 'down' ? 'Stop' : st.kind === 'changeover' ? 'Changeover' : 'Planned stop'} · ${st.reasonLabel}`,
          tone: st.kind === 'down' ? 'critical' : 'neutral',
        }))
      : [];
  return {
    ...base(w, CHART.rate, outs.length === 1 ? 'Output rate' : 'Output rate by machine', unit),
    kind: 'time',
    series,
    refLines,
    bands,
    facts,
    coverage: coverageOf(xs),
    ...(mass ? { note: MASS_FLOW_NOTE } : {}),
    yMin: 0,
    emptyReason: hasValue(series) ? null : 'No rate sample in this range',
  };
}

// ── Presses: cycle time ──────────────────────────────────────────────────────

function cycleCharts(s: SimState, w: RangeWindow, id: string): ChartSpec[] {
  const cyc = `${id}.cycle_time`;
  const tgt = `${id}.cycle_time_target`;
  if (!simulated(cyc)) return [];
  const x = seriesOf(s, cyc, w.key);
  const t = simulated(tgt) ? seriesOf(s, tgt, w.key) : null;
  const series = [x && toTime(x, 'Cycle time'), t && toTime(t, 'Target', { dashed: true, step: true, color: 'var(--text-2)' })].filter((v): v is TimeSeries => !!v);
  const latest = readSignal(s, cyc);
  const target = readSignal(s, tgt);
  const facts: ChartFact[] = [];
  if (typeof latest.value === 'number' && latest.quality === 'good' && typeof target.value === 'number')
    facts.push({ label: 'Now vs target', value: `${num(latest.value, 1)} s vs ${num(target.value, 1)} s (${signed(((latest.value - target.value) / target.value) * 100, 1)} %)` });
  const trend: TimeChartSpec = {
    ...base(w, CHART.cycle, 'Cycle time vs target', 's'),
    kind: 'time',
    series,
    refLines: [],
    bands: [],
    facts,
    coverage: coverageOf([x, t]),
    emptyReason: hasValue(series.slice(0, 1)) ? null : 'No cycle-time sample in this range (the press did not cycle)',
  };
  // The distribution: minute samples while the press runs (hourly means are too coarse to show a spread).
  const minuteSpan = w.resolution === 'hour' ? 480 : Math.min(480, w.to - w.from);
  const win = { from: s.minute - minuteSpan, to: s.minute };
  const m = seriesOf(s, cyc, { ...win, stepMin: 1 });
  const states = stateTimeline(s, id, win);
  const running = (tt: number) => states.some((g) => g.from <= tt && tt < g.to && (g.state === 'running' || g.state === 'reduced'));
  const vals = m ? m.v.map((v, i) => (v != null && running(m.t[i]) ? v : null)).filter((v): v is number => v != null) : [];
  const h = histogram(vals, { binWidth: 0.5, minSamples: 20 });
  const markers: HistogramMarker[] = [];
  if (typeof target.value === 'number') markers.push({ value: target.value, label: `target ${num(target.value, 1)} s`, kind: 'target' });
  if (h.status === 'ok') markers.push({ value: h.value.p50, label: `P50 ${num(h.value.p50, 1)} s`, kind: 'p50' }, { value: h.value.p90, label: `P90 ${num(h.value.p90, 1)} s`, kind: 'p90' });
  const hist: HistogramChartSpec = {
    ...base(w, PANEL_CHART.histogram, 'Cycle-time distribution', 's', `minute samples while running · ${w.resolution === 'hour' ? 'last 8 h (hourly means are too coarse for a spread)' : `last ${formatDuration(minuteSpan)}`}`),
    kind: 'histogram',
    bins: h.status === 'ok' ? h.value.bins : [],
    n: vals.length,
    markers,
    minSamples: 20,
    coverage: `${num(vals.length)} running minutes of ${num(minuteSpan)}`,
    emptyReason: vals.length ? null : h.status === 'ok' ? null : h.reason,
  };
  return [trend, hist];
}

// ── Process values against their setpoints ───────────────────────────────────

/** Half-widths of the warning / alarm bands around the nominal setpoint of a PV (null when it has none). */
function bandsOf(pvId: string): { warn: number; alarm: number } | null {
  const spec = PROCESS_SIGNAL_BY_ID[pvId];
  const d = definitionOf(pvId);
  if (!spec?.nominal || d?.warningHigh == null || d.alarmHigh == null) return null;
  return { warn: d.warningHigh - spec.nominal, alarm: d.alarmHigh - spec.nominal };
}

/** Deviation episodes beyond the warning (and alarm) band as chart bands. */
function deviationBands(pv: TelemetrySeries | null, sp: TelemetrySeries | null, b: { warn: number; alarm: number } | null, who = ''): TimeBand[] {
  if (!pv || !sp || !b) return [];
  const pvS: Sample[] = seriesToSamples(pv, pv.t[0] ?? 0);
  const spS: Sample[] = seriesToSamples(sp, sp.t[0] ?? 0);
  const min = pv.stepMin;
  const warn = deviationEpisodes(pvS, spS, b.warn, { minMinutes: min });
  const alarm = deviationEpisodes(pvS, spS, b.alarm, { minMinutes: min });
  const unit = pv.unit ?? '';
  return [
    ...warn.map((e): TimeBand => ({ from: e.from, to: e.to, tone: 'warning', label: `${who}beyond the ±${num(b.warn)} ${unit} warning band · max ${num(e.maxAbs, 1)} ${unit} · ${span(e)}` })),
    ...alarm.map((e): TimeBand => ({ from: e.from, to: e.to, tone: 'critical', label: `${who}beyond the ±${num(b.alarm)} ${unit} alarm band · max ${num(e.maxAbs, 1)} ${unit} · ${span(e)}` })),
  ];
}

function pvSpChart(s: SimState, w: RangeWindow, pvId: string, spId: string): TimeChartSpec {
  const d = definitionOf(pvId)!;
  const pv = seriesOf(s, pvId, w.key);
  const sp = seriesOf(s, spId, w.key);
  const label = d.name.replace(/ · actual$/, '');
  const series = [pv && toTime(pv, 'Actual (PV)'), sp && toTime(sp, 'Setpoint (SP)', { dashed: true, step: true, color: 'var(--text-2)' })].filter((v): v is TimeSeries => !!v);
  const refLines: TimeRefLine[] = [];
  if (d.warningLow != null) refLines.push({ value: d.warningLow, label: `warning ${num(d.warningLow, 1)}`, kind: 'warning' });
  if (d.warningHigh != null) refLines.push({ value: d.warningHigh, label: `warning ${num(d.warningHigh, 1)}`, kind: 'warning' });
  if (d.alarmLow != null) refLines.push({ value: d.alarmLow, label: `alarm ${num(d.alarmLow, 1)}`, kind: 'alarm' });
  if (d.alarmHigh != null) refLines.push({ value: d.alarmHigh, label: `alarm ${num(d.alarmHigh, 1)}`, kind: 'alarm' });
  const b = bandsOf(pvId);
  const now = readSignal(s, pvId);
  const spNow = readSignal(s, spId);
  const dev = setpointDeviation(typeof now.value === 'number' && now.quality === 'good' ? now.value : null, typeof spNow.value === 'number' ? spNow.value : null, b ?? undefined);
  const facts: ChartFact[] =
    dev.status === 'ok'
      ? [{ label: 'Now', value: `${signed(dev.value.abs, PROCESS_SIGNAL_BY_ID[pvId]?.digits ?? 1)} ${d.unit ?? ''} vs SP · ${dev.value.level === 'within' ? 'within band' : dev.value.level}` }]
      : [{ label: 'Now', value: now.quality === 'bad' ? 'Bad-quality reading — not compared' : now.value == null ? (now.note ?? 'No value now (the machine is not producing)') : dev.reason }];
  return {
    ...base(w, CHART.process(pvId), `${label} · PV vs SP`, d.unit),
    aliases: [CHART.process(spId)],
    kind: 'time',
    series,
    refLines,
    bands: deviationBands(pv, sp, b),
    facts,
    coverage: coverageOf([pv, sp]),
    emptyReason: hasValue(series.slice(0, 1)) ? null : `No ${label.toLowerCase()} sample in this range${pv?.note ? ` (${pv.note})` : ''}`,
  };
}

function kilnCharts(s: SimState, w: RangeWindow, id: string): ChartSpec[] {
  const zones = KILN_ZONES.map((z) => ({ z, pv: `${id}.zone${z.no}_temp_pv`, sp: `${id}.zone${z.no}_temp_sp` })).filter((x) => simulated(x.pv));
  const out: ChartSpec[] = [];
  if (zones.length) {
    const xs = zones.map((x) => ({ ...x, pvS: seriesOf(s, x.pv, w.key), spS: seriesOf(s, x.sp, w.key) }));
    const series: TimeSeries[] = xs.flatMap((x) => {
      const color = `var(--series-${x.z.no})`;
      return [x.pvS && toTime(x.pvS, `Zone ${x.z.no} · ${x.z.role.toLowerCase()}`, { color }), x.spS && toTime(x.spS, `Zone ${x.z.no} SP`, { color, dashed: true, step: true })].filter(
        (v): v is TimeSeries => !!v,
      );
    });
    let within = 0;
    let read = 0;
    for (const x of zones) {
      const pv = readSignal(s, x.pv);
      const sp = readSignal(s, x.sp);
      const dev = setpointDeviation(typeof pv.value === 'number' && pv.quality === 'good' ? pv.value : null, typeof sp.value === 'number' ? sp.value : null, bandsOf(x.pv) ?? undefined);
      if (dev.status !== 'ok') continue;
      read++;
      if (dev.value.level === 'within') within++;
    }
    out.push({
      ...base(w, PANEL_CHART.zones, 'Kiln zone temperatures · PV vs SP', '°C'),
      aliases: zones.flatMap((x) => [CHART.process(x.pv), CHART.process(x.sp)]),
      kind: 'time',
      series,
      refLines: [],
      bands: xs.flatMap((x) => deviationBands(x.pvS, x.spS, bandsOf(x.pv), `Zone ${x.z.no} `)),
      facts: [{ label: 'Zones within their warning band now', value: read ? `${within} of ${zones.length}` : 'Not readable now' }],
      coverage: coverageOf(xs.map((x) => x.pvS)),
      emptyReason: hasValue(series) ? null : 'No zone-temperature sample in this range',
    });
  }
  const speed = speedChart(s, w, `${id}.roller_speed`, 'Roller speed');
  if (speed) out.push(speed);
  return out;
}

function speedChart(s: SimState, w: RangeWindow, signalId: string, title: string): TimeChartSpec | null {
  if (!simulated(signalId)) return null;
  const x = seriesOf(s, signalId, w.key);
  const eq = signalId.slice(0, signalId.indexOf('.'));
  const nominal = CONVEYOR_BY_ID[eq]?.speedMpm ?? PROCESS_SIGNAL_BY_ID[signalId]?.nominal ?? null;
  const series = x ? [toTime(x, title)] : [];
  return {
    ...base(w, signalId.endsWith('.speed') ? PANEL_CHART.speed : CHART.process(signalId), title, x?.unit ?? definitionOf(signalId)?.unit ?? null),
    kind: 'time',
    series,
    refLines: nominal != null ? [{ value: nominal, label: `nominal ${num(nominal, 1)} m/min`, kind: 'target' }] : [],
    bands: [],
    coverage: coverageOf([x]),
    yMin: 0,
    emptyReason: hasValue(series) ? null : `No ${title.toLowerCase()} sample in this range`,
  };
}

// ── Buffers ──────────────────────────────────────────────────────────────────

/** Flows into / out of a buffer in the stage's unit (t/h for slip and powder with the disclosure, tiles/h after pressing). */
function flowSides(s: SimState, w: RangeWindow, b: FlowBuffer): { unit: string; inflow: TimeSeries | null; outflow: TimeSeries | null; xs: TelemetrySeries[]; note?: string } | null {
  if (!b.up || !b.down) return null;
  const xs: TelemetrySeries[] = [];
  const read = (id: string) => {
    const x = seriesOf(s, id, w.key);
    if (x) xs.push(x);
    return x;
  };
  type Side = { t: number[]; v: (number | null)[] } | null;
  const side = (machines: string[], how: (m: string) => Side): Side => {
    const parts = machines.map(how);
    return parts.every(Boolean) && parts.length ? { t: parts[0]!.t, v: sumSeries(parts as { t: number[]; v: (number | null)[] }[]) } : null;
  };
  const massOf = (m: string): Side => {
    const sig = ['slip_flow', 'powder_flow'].map((k) => `${m}.${k}`).find(simulated);
    return sig ? read(sig) : null;
  };
  const rateOf = (m: string): Side => {
    if (simulated(`${m}.count_good`)) {
      const c = read(`${m}.count_good`);
      return c ? { t: c.t, v: counterRate(c) } : null;
    }
    return simulated(`${m}.rate`) ? read(`${m}.rate`) : null;
  };
  let unit: string;
  let inS: Side;
  let outS: Side;
  let note: string | undefined;
  if (b.bulk) {
    unit = 't/h';
    inS = side(b.up.machines, massOf);
    outS = side(b.down.machines, massOf);
    if (!outS && b.transfer[0]) {
      const feed = `${b.transfer[0].id}.tile_count`;
      const c = simulated(feed) ? read(feed) : null;
      outS = c ? { t: c.t, v: counterRate(c, KG_PER_TILE / 1000) } : null;
      if (outS) note = `${MASS_FLOW_NOTE} The draw is read from ${feed} (tile-equivalents) with the same factor.`;
    }
    note ??= MASS_FLOW_NOTE;
  } else {
    unit = definitionOf(`${b.down.machines[0]}.rate`)?.unit ?? 'tiles/h';
    inS = side(b.up.machines, rateOf);
    outS = side(b.down.machines, rateOf);
    if (b.up.machines.some((m) => simulated(`${m}.count_good`))) note = 'Sorting passes on accepted tiles only (count_good): rejects leave the line at the diverters.';
  }
  const mk = (x: Side, label: string, color: string): TimeSeries | null => (x ? { id: label, label, t: x.t, v: x.v, color } : null);
  return { unit, inflow: mk(inS, `In · ${b.up.name}`, 'var(--series-1)'), outflow: mk(outS, `Out · ${b.down.name}`, 'var(--series-2)'), xs, note };
}

function bufferCharts(s: SimState, w: RangeWindow, b: FlowBuffer): ChartSpec[] {
  const out: ChartSpec[] = [];
  const x = seriesOf(s, b.level, w.key);
  const series = x ? [toTime(x, `${b.buf.name} level`)] : [];
  // Trend over the last 60 min of minute data (the flow rule's window), whatever the range.
  const recent = seriesOf(s, b.level, { from: s.minute - 60, to: s.minute, stepMin: 1 });
  const slope = recent ? trendSlope(seriesToSamples(recent, recent.t[0] ?? 0), { minSamples: 20, minSpanMin: 30 }) : null;
  const lv = readSignal(s, b.level);
  const level = typeof lv.value === 'number' && lv.quality === 'good' ? lv.value : null;
  const facts: ChartFact[] = [];
  if (slope?.status === 'ok') {
    facts.push({ label: 'Trend · last 60 min', value: `${signed(slope.value, 1)} %/h`, hint: 'Least-squares slope of the minute level samples of the last 60 min.' });
    const basis = b.bulk ? ', % basis' : '';
    if (Math.abs(slope.value) < 0.5) facts.push({ label: 'Time to empty / full', value: 'Level steady (trend under 0.5 %/h)' });
    else {
      const tte = slope.value < 0 ? timeToEmpty(level, slope.value) : timeToFull(level, slope.value);
      facts.push({
        label: slope.value < 0 ? `Time to empty · at this trend${basis}` : `Time to full · at this trend${basis}`,
        value: tte.status === 'ok' ? (tte.value < 1 ? (slope.value < 0 ? 'Empty now' : 'Full now') : formatDuration(tte.value)) : tte.reason,
        hint: 'A linear extrapolation of the 60-min trend — not a forecast.',
      });
    }
  } else facts.push({ label: 'Trend · last 60 min', value: slope ? slope.reason : 'No level history' });
  if (b.bulk) facts.push({ label: 'Mass', value: 'Needs a level-to-mass calibration', hint: LEVEL_ONLY_NOTE });
  out.push({
    ...base(w, CHART.buffer(b.level), `${b.buf.name} · level`, '%'),
    kind: 'time',
    series,
    refLines: [
      { value: BUFFER_LEVEL_BAND.low * 100, label: `low ${num(BUFFER_LEVEL_BAND.low * 100)} %`, kind: 'limit' },
      { value: BUFFER_LEVEL_BAND.high * 100, label: `high ${num(BUFFER_LEVEL_BAND.high * 100)} %`, kind: 'limit' },
    ],
    bands: [],
    facts,
    yMin: 0,
    yMax: 100,
    coverage: coverageOf([x]),
    ...(b.bulk ? { note: LEVEL_ONLY_NOTE } : {}),
    emptyReason: hasValue(series) ? null : 'No level sample in this range',
  });
  const f = flowSides(s, w, b);
  if (f) {
    const fs = [f.inflow, f.outflow].filter((v): v is TimeSeries => !!v);
    out.push({
      ...base(w, PANEL_CHART.flow(b.level), `${b.buf.name} · inflow vs outflow`, f.unit),
      kind: 'time',
      series: fs,
      refLines: [],
      bands: [],
      coverage: coverageOf(f.xs),
      yMin: 0,
      ...(f.note ? { note: f.note } : {}),
      emptyReason: hasValue(fs) ? null : 'No flow sample on either side in this range',
    });
  }
  return out;
}

// ── Sorting and inspection ───────────────────────────────────────────────────

const QUALITY_SUBJECTS = new Set(['I-SORT', ...INSPECTION_STATIONS.filter((st) => st.detects.length > 0).map((st) => st.equipmentId)]);

function qualityCharts(s: SimState, ctx: RuleContext, w: RangeWindow, id: string): ChartSpec[] {
  const station = INSPECTION_STATIONS.find((st) => st.equipmentId === id && st.detects.length > 0);
  // Minute ranges in 5-min steps at least: a one-minute reject rate rests on about twenty tiles.
  const step = w.resolution === 'hour' ? 60 : Math.max(5, w.stepMin);
  const t: number[] = [];
  const v: (number | null)[] = [];
  const tips: Record<number, { label: string; value: string }[]> = {};
  let inspected = 0;
  for (let a = w.from; a < Math.min(w.to, s.minute); a += step) {
    const q = ctx.quality({ from: a, to: Math.min(a + step, s.minute) }, station ? { stationId: station.id } : {});
    const rr = rejectRate(q.rejected, q.inspected);
    const fpy = firstPassYield(q.inspected - q.rejected, q.inspected);
    t.push(a);
    v.push(rr.status === 'ok' ? rr.value * 100 : null);
    inspected += q.inspected;
    tips[a] = [
      { label: 'Inspected', value: `${num(q.inspected)} tiles` },
      { label: 'Rejected', value: `${num(q.rejected)} tiles` },
      { label: 'First-pass yield', value: fpy.status === 'ok' ? `${num(fpy.value * 100, 2)} %` : fpy.reason },
    ];
  }
  const series: TimeSeries[] = [{ id: 'reject-rate', label: station ? `Reject rate · ${station.name}` : 'Reject rate · gauge + vision', t, v }];
  const out: ChartSpec[] = [
    {
      ...base(w, CHART.quality, 'Reject rate per step · FPY in the tooltip', '%', `${step}-min steps of the inspection counters`),
      kind: 'time',
      series,
      refLines: station ? [] : [{ value: s.rules.rejectRateMax * 100, label: `line limit ${num(s.rules.rejectRateMax * 100, 1)} %`, kind: 'limit' }],
      bands: [],
      tips,
      yMin: 0,
      coverage: `${num(inspected)} tiles inspected in the range`,
      note: 'First-pass yield = accepted ÷ inspected (the modelled line has no rework loop). Steps without inspected tiles are gaps, not zero.',
      emptyReason: hasValue(series) ? null : 'No tiles inspected in this range',
    },
  ];
  const q = ctx.quality({ from: w.from, to: s.minute }, station ? { stationId: station.id } : {});
  const ds = (station ? station.detects : DEFECT_ORDER) as DefectCategory[];
  const total = ds.reduce((a, d) => a + q.byDefect[d], 0);
  const rows: RankedRow[] = ds
    .filter((d) => q.byDefect[d] > 0)
    .sort((a, b) => q.byDefect[b] - q.byDefect[a])
    .reduce<RankedRow[]>((acc, d) => {
      const share = total ? q.byDefect[d] / total : 0;
      const cumulative = (acc.length ? (acc[acc.length - 1].cumulative ?? 0) : 0) + share;
      acc.push({ key: d, label: `${DEFECTS[d].label} · from ${STAGE_BY_ID[DEFECTS[d].origin].name.toLowerCase()}`, value: q.byDefect[d], share, cumulative });
      return acc;
    }, []);
  out.push({
    ...base(w, PANEL_CHART.defects, 'Defect categories', 'tiles', q.resolution === 'hour' ? 'hourly inspection buckets' : 'minute inspection log'),
    kind: 'ranked',
    rows,
    valueHeader: 'Tiles',
    labelHeader: 'Defect · origin (modelled attribution)',
    format: 'count',
    coverage: `${num(q.inspected)} tiles inspected · ${num(total)} rejected`,
    note: 'The origin stage is the model’s attribution — a hypothesis to check, not a confirmed cause.',
    emptyReason: rows.length ? null : 'No rejected tile in this range',
  });
  return out;
}

// ── Stops and events ─────────────────────────────────────────────────────────

function downtimeChart(s: SimState, ctx: RuleContext, w: RangeWindow, id: string): RankedChartSpec | null {
  if (!s.machines[id]) return null;
  const win = { from: w.from, to: Math.min(w.to, s.minute) };
  const stops = ctx.stops(id, win);
  const rows = faultRecurrence(stops, win, { by: 'reason', includePlanned: true }).sort((a, b) => b.totalMin - a.totalMin);
  // Only for a subject with stops in the range ("no own stop" is the Stoppages tile's statement, not repeated here).
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + r.totalMin, 0);
  let cum = 0;
  const planned = new Set(stops.filter((x) => x.planned).map((x) => x.reasonCode));
  return {
    ...base(w, PANEL_CHART.downtime, 'Downtime by reason', 'min', 'stop records'),
    kind: 'ranked',
    rows: rows.map((r) => {
      const share = total ? r.totalMin / total : 0;
      cum += share;
      return { key: r.key, label: `${r.reasonLabel ?? r.reasonCode ?? r.key}${r.reasonCode && planned.has(r.reasonCode) ? ' (planned / changeover)' : ''} · ${r.count}×`, value: r.totalMin, share, cumulative: cum };
    }),
    valueHeader: 'Minutes',
    labelHeader: 'Stop reason · count',
    format: 'duration',
    coverage: `${stops.length} stop${stops.length === 1 ? '' : 's'} overlapping the range (clipped to it)`,
    emptyReason: rows.length ? null : 'No own stop in this range',
  };
}

function eventsChart(s: SimState, ctx: RuleContext, w: RangeWindow, ids: string[]): EventsChartSpec {
  const win = { from: w.from, to: Math.min(w.to, s.minute) };
  const events: StripEvent[] = [];
  for (const id of ids) {
    for (const e of ctx.events(id, win)) events.push({ id: e.id, t: e.start, end: e.end, label: e.title, severity: e.severity, kind: 'event' });
    for (const st of ctx.stops(id, win))
      events.push({
        id: `stop:${st.downtimeId}`,
        t: st.start,
        end: st.end,
        label: `${ids.length > 1 ? `${id} · ` : ''}${st.kind === 'down' ? 'Stop' : st.kind === 'changeover' ? 'Changeover' : 'Planned stop'} · ${st.reasonLabel}`,
        severity: st.kind === 'down' ? 'warning' : 'info',
        kind: 'stop',
      });
  }
  return {
    ...base(w, PANEL_CHART.events, 'Events and stops', null, 'event and stop records'),
    kind: 'events',
    events,
    coverage: `${events.length} record${events.length === 1 ? '' : 's'}`,
    emptyReason: events.length ? null : 'No event or stop recorded in this range',
  };
}

// ── The chart set ────────────────────────────────────────────────────────────

function equipmentCharts(s: SimState, w: RangeWindow, id: string): ChartSpec[] {
  const ctx = buildContext(s, { values: useRuleThresholds.getState().values });
  const out: (ChartSpec | null)[] = [];
  const conveyor = !!CONVEYOR_BY_ID[id];
  out.push(statesChart(s, w, [id]));
  if (!conveyor && OPS_BY_ID[id]?.category === 'process') out.push(rateChart(s, ctx, w, [id]));
  out.push(...cycleCharts(s, w, id));
  if (id === 'H-KILN') out.push(...kilnCharts(s, w, id));
  for (const d of catalogFor(id))
    if (d.setpointSignalId && d.availabilityStatus === 'simulated' && d.category === 'process' && !(id === 'H-KILN' && /^H-KILN\.zone\d_temp_pv$/.test(d.signalId)))
      out.push(pvSpChart(s, w, d.signalId, d.setpointSignalId));
  if (id !== 'H-KILN' && simulated(`${id}.roller_speed`)) out.push(speedChart(s, w, `${id}.roller_speed`, 'Roller speed'));
  if (simulated(`${id}.line_speed`)) out.push(speedChart(s, w, `${id}.line_speed`, 'Line speed'));
  const held = bufferHeldBy(id);
  if (held) out.push(...bufferCharts(s, w, held));
  if (conveyor) out.push(speedChart(s, w, `${id}.speed`, 'Conveyor speed'));
  if (QUALITY_SUBJECTS.has(id)) out.push(...qualityCharts(s, ctx, w, id));
  out.push(downtimeChart(s, ctx, w, id));
  if (s.machines[id] || ctx.events(id, { from: w.from, to: s.minute }).length) out.push(eventsChart(s, ctx, w, [id]));
  return out.filter((x): x is ChartSpec => x != null);
}

function stageCharts(s: SimState, w: RangeWindow, stageId: MonitoredStageId): ChartSpec[] {
  const ms = MONITORED_STAGE_BY_ID[stageId];
  const ctx = buildContext(s, { values: useRuleThresholds.getState().values });
  const assets = [...ms.equipment, ...ms.conveyors.filter((c) => !ms.equipment.includes(c))];
  const out: (ChartSpec | null)[] = [statesChart(s, w, assets)];
  const held = [...new Set([...assets.map(bufferHeldBy), ms.wipBufferId ? (FLOW_BUFFERS.find((b) => b.buf.id === ms.wipBufferId) ?? null) : null])].filter((b): b is FlowBuffer => b != null);
  if (held.length) {
    const xs = held.map((b) => seriesOf(s, b.level, w.key));
    const series = xs.flatMap((x, i) => (x ? [toTime(x, held[i].buf.name, { color: `var(--series-${(i % 7) + 1})` })] : []));
    out.push({
      ...base(w, 'chart:buffers', 'Buffer levels', '%'),
      aliases: held.map((b) => CHART.buffer(b.level)),
      kind: 'time',
      series,
      refLines: [],
      bands: [],
      yMin: 0,
      yMax: 100,
      coverage: coverageOf(xs),
      ...(held.some((b) => b.bulk) ? { note: LEVEL_ONLY_NOTE } : {}),
      emptyReason: hasValue(series) ? null : 'No level sample in this range',
    });
  }
  out.push(rateChart(s, ctx, w, ms.equipment.filter((e) => OPS_BY_ID[e]?.category === 'process')));
  return out.filter((x): x is ChartSpec => x != null);
}

const MEMO = new WeakMap<SimState, Map<string, ChartSpec[]>>();

/** The charts of a subject over a range, in panel order. Memoised per simulation minute / version, subject and range: treat as read-only. */
export function chartsFor(s: SimState, subject: ChartSubject, range: RangeKey): ChartSpec[] {
  const key = `${subject.kind === 'equipment' ? subject.equipmentId : `stage:${subject.stageId}`}|${range}|${s.minute}|${s.version}|${useRuleThresholds.getState().version}`;
  let m = MEMO.get(s);
  if (!m) MEMO.set(s, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const w = windowOf(s, range);
  const specs = subject.kind === 'equipment' ? equipmentCharts(s, w, subject.equipmentId) : stageCharts(s, w, subject.stageId);
  m.set(key, specs);
  while (m.size > 24) m.delete(m.keys().next().value!);
  return specs;
}

/** Numeric catalogue signals of an equipment item that get no chart because the demo has no value for them. */
export function notCharted(equipmentId: string): { signalId: string; name: string; status: string }[] {
  return catalogFor(equipmentId)
    .filter((d) => d.availabilityStatus !== 'simulated' && (d.dataType === 'float' || d.dataType === 'integer') && ['process', 'drive', 'material', 'quality', 'production', 'setpoint'].includes(d.category))
    .map((d) => ({ signalId: d.signalId, name: d.name, status: AVAILABILITY_STATUS_LABEL[d.availabilityStatus] }));
}

/** The signals whose history the charts read (for the range availability). */
export function chartSignals(subject: ChartSubject): string[] {
  const ids = subject.kind === 'equipment' ? [subject.equipmentId] : MONITORED_STAGE_BY_ID[subject.stageId].equipment;
  return ids.flatMap((id) => catalogFor(id).filter((d) => d.availabilityStatus === 'simulated' && (d.dataType === 'float' || d.dataType === 'integer')).map((d) => d.signalId)).slice(0, 4);
}
