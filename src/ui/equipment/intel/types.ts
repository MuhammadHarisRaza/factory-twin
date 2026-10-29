/**
 * Equipment intelligence panel — the view model contract.
 *
 * ONE panel (src/ui/equipment/panel/) renders every selectable asset of the 3D factory and every
 * vehicle from this model; what differs per asset comes from its profile (src/ui/equipment/profile.ts)
 * and the derivation (src/ui/equipment/intel/derive.ts), never from a per-machine component.
 * Every value comes from the shared simulation state and the metric layer; a parameter the model
 * does not have is listed as "not modelled", never filled with a plausible number.
 *
 * Section order (fixed header · scrolling body · persistent action bar):
 *   header → feed (one) → facets (what state is it in) → metrics (4–6 tiles) → insights + rule findings (what
 *   matters) → charts over the viewer's range (how has it behaved) → signals (catalogue table) → events & alarms
 *   → technical details (collapsed). Wave 3 adds `charts`, `signalTable`, `history`, `findings`, `log`, `catalog`
 *   (optional, equipment only) and the header's `lastUpdate` / `stage12` and data-badge kinds.
 */
import type { AlertSeverity, OpEvent, OperationalState } from '../../../model/types';
import type { RangeKey, TelemetrySeries } from '../../../model/telemetry';
import type { RuleFinding } from '../../../intel/rules/types';
import type { HealthAssessment } from '../../../sim/health';
import type { VideoRef } from '../../../video/types';
import type { EqKpiSet } from '../kpis';
import type { AssetProfile } from '../profile';
import type { ChartSpec } from './charts';
import type { IntelProcess } from './panelData';
import type { SignalTableRow } from './signalTable';

/** Semantic tone (always shown with words and an icon, never colour alone). */
export type IntelTone = 'good' | 'warning' | 'critical' | 'neutral';

// ── Header ───────────────────────────────────────────────────────────────────

export type IntelHeader = {
  /** "Single-layer roller kiln" / "FL-02 · Forklift". */
  title: string;
  /** "Kiln firing & cooling · H-KILN". */
  subtitle: string;
  /** Zone letter and colour of the asset (vehicles: their current zone, or null). */
  zone: { id: string; color: string } | null;
  /** Operating state in words ("Running", "Stopped — die / punch damage", "Moving", "No operating state"). */
  state: { label: string; tone: IntelTone; op: OperationalState | null };
  /** Minute the current state began (null when unknown / not modelled). */
  since: number | null;
  /**
   * Where the data comes from: the simulation, a stale (simulated) feed, a connected source (never produced in this
   * release), no operating data at all ('unavailable': the asset has catalogue entries but nothing is simulated), or
   * a 3D-layout reference without any data ('reference'). A configured camera stream never changes it.
   */
  source: { kind: IntelSourceKind; label: string; since?: number | null };
  /** Optional (added): plant minute of the newest sample of the asset's simulated signals ("Updated hh:mm"); null = none. */
  lastUpdate?: number | null;
  /** Optional (added): the brief's 12-stage mapping of the asset ("Brief stage 7 · Kiln firing"), null for support assets. */
  stage12?: { no: number; label: string; note: string } | null;
};

export type IntelSourceKind = 'simulated' | 'stale' | 'connected' | 'unavailable' | 'reference';

// ── Feed (exactly one) ───────────────────────────────────────────────────────

/**
 * The single camera / video of the panel, chosen in this order:
 *   1. live-stream  — a stream the user configured for the asset's camera (shown Live only while it plays);
 *   2. recording    — a client-provided camera recording for this asset (registry sourceType 'client-recording');
 *   3. reference    — the best reference clip for the asset (registry: footage provided by the client);
 *   4. none         — no appropriate source: an explicit unavailable state (a camera without a
 *                     configured stream says so; nothing is rendered from the twin in its place).
 */
export type FeedChoice =
  | { kind: 'live-stream'; cameraId: string; badge: string; details: FeedDetail[] }
  | { kind: 'recording'; video: VideoRef; badge: string; details: FeedDetail[] }
  | { kind: 'reference'; video: VideoRef; badge: string; details: FeedDetail[] }
  | { kind: 'none'; reason: string; badge: null; details: FeedDetail[] };

/** One line of the compact source-details popover (title, provider, licence, camera, recorded at, …). */
export type FeedDetail = { label: string; value: string };

// ── Facets: the distinct conditions an operator must not confuse ─────────────

/**
 * A running machine may still be starved, below target, degraded or the line constraint; each is
 * a separate facet. Facets that do not apply to the asset are omitted (a buffer has no condition facet).
 */
export type FacetKey = 'machine' | 'material' | 'rate' | 'condition' | 'role' | 'feed' | 'quality' | 'location' | 'movement' | 'trip' | 'dwell';

export type Facet = {
  key: FacetKey;
  /** Facet name ("Machine", "Material", "Rate", "Condition", "Line role"). */
  label: string;
  /** Short value in words ("Running", "Starved", "92 % of ideal", "Normal", "Design constraint (modeled)"). */
  value: string;
  tone: IntelTone;
  /** What the facet means / how it is determined (tooltip). */
  hint: string;
};

// ── Insights: interpretation with evidence ───────────────────────────────────

export type InsightBasis =
  /** A configured detection / condition rule evaluated on the simulated signals. */
  | 'rule'
  /** The condition was injected by a scenario the presenter started. */
  | 'scenario'
  /** An event record of the event engine (its rule id is in the evidence). */
  | 'event';

export type IntelEvidence = {
  kind: 'signal' | 'event' | 'metric' | 'rule';
  /** "Vibration 3.9 mm/s RMS (alarm 7.1)", "EV-02312", "Rate 1,045 tiles/h vs 1,250 ideal". */
  label: string;
  /** Signal id or event id to link to. */
  ref?: string;
  /**
   * Optional (added): the chip's words when it is a link to a signal row — the signal's name only
   * ("Motor current", "Vibration"); the observed text already states the value, so a link chip does
   * not restate it (the full `label` stays in its tooltip).
   */
  short?: string;
};

export type IntelInsight = {
  id: string;
  severity: 'positive' | 'info' | 'warning' | 'serious' | 'critical';
  /** "Operating normally", "Upstream material starvation", "Vibration rising". */
  title: string;
  /** What was observed (facts, with figures). */
  observed: string;
  /** Why it matters operationally (output, quality, delivery) — only what the data supports. */
  why: string;
  evidence: IntelEvidence[];
  /** The most useful next step, specific to the asset (null when none is warranted). */
  next: string | null;
  basis: InsightBasis;
  /** "Rule-based", "Scenario input", "Event rule R-STOP" — shown as a small tag. */
  basisLabel: string;
  /** Wording discipline: a cause that is not established is "possible contributing factor" / "requires investigation". */
  certainty: 'observed' | 'likely' | 'possible';
};

// ── Analytics: how the asset has behaved ─────────────────────────────────────

export type TimelineSegment = {
  from: number;
  to: number;
  state: OperationalState;
  /**
   * Optional (added by the derivation): words for the state when OPERATIONAL_STATE_LABEL does not fit —
   * vehicles use state 'running' = "Moving" and 'idle' = "Stationary"; minutes after a feed went stale
   * are 'unknown' = "Unknown (feed stale)".
   */
  label?: string;
};

export type IntelAnalytics = {
  /** Window of the timeline / trend (minute log: up to the last 240 min). */
  window: { from: number; to: number; label: string };
  /** State over the window, merged into segments (from the minute log). */
  timeline: TimelineSegment[];
  /**
   * Minutes per state in the window, largest first (sums to window.to − window.from). `label` as on
   * TimelineSegment. Vehicles: exact (fractional) minutes of their route legs — a 0.2-min driving leg
   * keeps its duration.
   */
  timeInState: { state: OperationalState; minutes: number; label?: string }[];
  /**
   * Output rate per step over the window (tiles/h; null where no sample), with the ideal rate.
   * Optional `idealLabel` (added): what the reference line is — "ideal rate" for machines, "nominal capacity" for conveyors.
   */
  rate: { points: (number | null)[]; stepMin: number; ideal: number | null; unit: string; idealLabel?: string } | null;
  /** Stoppages of the asset (own downtime records). */
  stops: {
    /** In the shift so far. */
    shiftCount: number;
    shiftMinutes: number;
    /** Largest stop reason in the shift. */
    topReason: { label: string; minutes: number } | null;
    /** Over the retained history (≈ 7 days): mean time between failures (h) and to repair (min) — null without enough stops. */
    mtbfH: number | null;
    mttrMin: number | null;
    basis: string;
    /**
     * Optional (added): the not-confirmed mark of the stop figures when a data feed they rest on is
     * stale ("Not confirmed · E-PRS2 data stale since 10:20" — the KPI tiles' mark, Decision 1).
     */
    notConfirmed?: string;
  } | null;
  /**
   * Output not made at this asset's ideal rate in the shift, and whether it reached line output.
   * Optional `breakdown` (added): where the shortfall came from — own stops, waiting on neighbours
   * (starved / blocked), below the ideal pace — in tiles, summing to `tiles` (rounding aside).
   */
  loss: {
    tiles: number;
    m2: number;
    reachedLine: 'yes' | 'no' | 'unknown';
    basis: string;
    breakdown?: { key: 'stops' | 'waiting' | 'pace'; label: string; tiles: number; hint: string }[];
    /** Optional (added): the not-confirmed mark of the figure while a feed it rests on is stale (as `stops`). */
    notConfirmed?: string;
    /** Optional (added): the unit of `tiles` — 'tile-eq.' for slip and powder (never 'tiles'); default 'tiles'. */
    unit?: string;
  } | null;
  /**
   * Optional (added): a few extra compact facts with figures ("Starved · last 60 min 12 %", "Mean rate · 4 h",
   * vehicles: "Moves · last hour", "At current stop"). Label, value with unit, and how it is calculated.
   */
  facts?: { label: string; value: string; hint: string }[];
};

// ── Signals (PLC-style) ──────────────────────────────────────────────────────

export type IntelSignal = {
  /** Signal id, e.g. "H-KILN.vibration". */
  id: string;
  /** Human label: "Vibration · roller drive gearmotor", "Motor current", "Run state", "Output rate". */
  label: string;
  /** Current value formatted, or null when not available. */
  value: string | null;
  unit: string | null;
  /** Interpretation against a configured limit or expected range (words + tone). */
  interpretation: { tone: IntelTone; label: string } | null;
  /** The limits behind the interpretation (for the tooltip), e.g. "expected 2.1 · alarm 7.1 · trip 11.2 mm/s". */
  limits: string | null;
  /** Recent samples, oldest first (only where history exists), for a sparkline. */
  trend: (number | null)[] | null;
  /** "Simulated · now", "Last value 10:20 (feed stale)". */
  freshness: string;
  stale: boolean;
};

export type IntelSignals = {
  rows: IntelSignal[];
  /** Parameters an operator would expect that the model does not contain ("Firing temperature profile"). */
  notModelled: { label: string; reason: string }[];
};

// ── Events ───────────────────────────────────────────────────────────────────

export type IntelEventRow = {
  event: OpEvent;
  /** One short impact statement where the data supports it ("Kiln held up 12 min", "No line output lost yet"). */
  impact: string | null;
  /**
   * Optional (added): older resolved events of the same type collapsed into this (newest resolved) row —
   * the UI may show "+N earlier". Absent / 0 for open events and for types that occurred once.
   */
  earlier?: number;
};

export type IntelEvents = {
  /** Open (unresolved) events first, then the newest resolved ones; at most 5. */
  rows: IntelEventRow[];
  openCount: number;
  /** All events of the asset in the retained history (the "View all" count). */
  total: number;
};

// ── Wave 3: charts over a range, catalogue signals, rule findings, the event log ─────────────────────

/** The chart set of the panel (intel/charts.ts) for the viewer's range. */
export type IntelCharts = {
  /** The range the specs cover (the viewer's choice, or the closest shorter one the data serves). */
  range: RangeKey;
  /** Ranges the data cannot serve, with the reason. */
  disabled: Partial<Record<RangeKey, string>>;
  specs: ChartSpec[];
  /** Numeric catalogue signals without a chart (not modelled / unavailable). */
  notCharted: { signalId: string; name: string; status: string }[];
  /** [from, to) of the range. */
  window: { from: number; to: number };
  /** Plant minute the charts were computed at when it is a live card's earlier result (src/ui/equipment/intel/live.ts); absent = now. */
  at?: number;
};


/** The rule engine's findings for the asset after merging with the curated insights. */
export type IntelFindings = {
  /** Every finding of the scope (fired / clear / insufficient-data) except the fired ones a curated insight already says. */
  shown: RuleFinding[];
  /** Fired findings dropped because a curated insight above says the same (by rule topic). */
  merged: { ruleId: string; insightId: string }[];
  /** Plant minute of the evaluation when it is a live view's (src/intel/rules/live.ts: up to LIVE_FINDINGS_MIN minutes old); absent = evaluated now. */
  at?: number;
};


/** One entry of the Events & alarms log besides the event records: an alarm, a state transition or a data-quality event. */
export type IntelLogKind = 'alarm' | 'state' | 'data';
export type IntelLogEntry = {
  id: string;
  kind: IntelLogKind;
  /** Plant minute it started / happened. */
  t: number;
  /** End of a spell (null: still open; undefined: an instant). */
  end?: number | null;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  /** Where it comes from ("Alarm code · H-KILN.alarm (simulated)", "State signal · stop records", "Rule DQ-STALE"). */
  source: string;
  /** The event record it belongs to (opens it), if any. */
  eventId?: string;
};

/** The catalogue view of Technical details. */
export type IntelCatalog = {
  /** Signals per availability class × status of the asset. */
  counts: { cls: string; status: string; n: number }[];
  /** Rule thresholds that apply to the asset: value in force and whether it is the default. */
  thresholds: { ruleId: string; rule: string; key: string; label: string; value: string; source: 'default' | 'configured' | 'event rule' }[];
  /** Calculation definitions the panel's figures rest on. */
  definitions: { label: string; text: string }[];
};

// ── The whole model ──────────────────────────────────────────────────────────

export type EquipmentIntel = {
  subject: { type: 'equipment'; id: string; profile: AssetProfile } | { type: 'vehicle'; id: string };
  header: IntelHeader;
  feed: FeedChoice;
  facets: Facet[];
  /** 3–5 key metric tiles (the existing context-specific KPI sets; vehicles have their own). */
  metrics: EqKpiSet;
  /** Most important first; "Operating normally" (positive) when nothing needs attention and the data shows it. */
  insights: IntelInsight[];
  analytics: IntelAnalytics | null;
  signals: IntelSignals;
  events: IntelEvents;
  /** Condition assessment for condition-monitored assets (technical details only — no score on the main view). */
  health: HealthAssessment | null;
  /** Camera the action bar's "Camera" opens (the existing floating camera view), if the asset has one. */
  cameraId: string | null;
  /**
   * Optional (added): the equipment-specific question for the action bar's "Ask Copilot"
   * (useApp().openCopilot(prompt, { eventId })) — about the top open event when there is one
   * (the copilot answers an event by its id), otherwise about the asset by its id.
   */
  ask?: { prompt: string; eventId?: string };
  /** Optional (added, equipment only): charts over the viewer's range (§6B). */
  charts?: IntelCharts | null;
  /** Optional (added, equipment only): the catalogue signal table rows (§6C). */
  signalTable?: SignalTableRow[];
  /** Optional (added): history of one signal over the charts' range, for the signal detail (null: none). */
  history?: (signalId: string) => TelemetrySeries | null;
  /** Optional (added): rule findings for the asset, merged with the curated insights (§6D). */
  findings?: IntelFindings | null;
  /** Optional (added): alarms, state transitions and data-quality entries over the charts' range (§6E). */
  log?: IntelLogEntry[];
  /** Optional (added): catalogue view for Technical details (§6G). */
  catalog?: IntelCatalog | null;
  /** Optional (added, equipment only): the process now — kiln zone profile, PV / SP deviation gauges, a buffer's level gauge. */
  process?: IntelProcess | null;
  /** Optional (added, equipment only): sparkline values per key-figure tile over the charts' range (tiles a simulated signal backs). */
  tileTrends?: Record<string, (number | null)[]>;
};
