/**
 * Factory Twin interface derivations. Pure functions over the one simulation state —
 * line status per process stage, a truck's visit milestones, the shift timeline, global
 * search and quick-view targets. Every figure comes from src/sim (metrics, health,
 * logistics); this file only shapes it for the overlays.
 */
import { EQUIPMENT } from '../../data/equipment';
import { ZONES, ZONE_BY_ID } from '../../data/layout';
import { DOCKS, PRODUCTS, REASON_BY_CODE, SCENARIO_KIND_LABELS, STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity, MachineState, ProductionBatch, RecordSource, StageId, Vehicle } from '../../model/types';
import { findDowntime, type SimState } from '../../sim/engine';
import type { HealthAssessment, HealthLevel } from '../../sim/health';
import { phaseLabel, type TruckRuntime } from '../../sim/logistics';
import { bottleneck } from '../../sim/metrics';
import { formatClock, shiftAt } from '../../sim/time';

// ── Production-line status strip ─────────────────────────────────────────────

export type LineStageDef = {
  key: string;
  /** Short chip caption. */
  label: string;
  name: string;
  /** Simulated process stages covered by the chip (empty = storage end of the line, no machine state). */
  stages: StageId[];
  zone: string;
};

/** The line as the presenter tells it: Raw → … → Warehouse (packing & palletising share one chip). */
export const LINE_STAGES: LineStageDef[] = [
  { key: 'RAW', label: 'Raw', name: 'Raw materials', stages: [], zone: 'B' },
  { key: 'PREP', label: 'Prep', name: 'Body preparation', stages: ['PREP'], zone: 'C' },
  { key: 'SPRAY', label: 'Spray', name: 'Spray drying', stages: ['SPRAY'], zone: 'D' },
  { key: 'PRESS', label: 'Press', name: 'Pressing', stages: ['PRESS'], zone: 'E' },
  { key: 'DRY', label: 'Dry', name: 'Drying', stages: ['DRY'], zone: 'F' },
  { key: 'GLAZE', label: 'Glaze', name: 'Glazing', stages: ['GLAZE'], zone: 'G' },
  { key: 'DECOR', label: 'Decor', name: 'Digital decoration', stages: ['DECOR'], zone: 'G' },
  { key: 'KILN', label: 'Kiln', name: 'Firing', stages: ['KILN'], zone: 'H' },
  { key: 'SORT', label: 'Sort', name: 'Sorting & inspection', stages: ['SORT'], zone: 'I' },
  { key: 'PACK', label: 'Pack', name: 'Packing & palletising', stages: ['PACK', 'PAL'], zone: 'J' },
  { key: 'WH', label: 'Warehouse', name: 'Finished-goods warehouse', stages: [], zone: 'K' },
];

/** Severity order used to pick a stage's worst machine state. */
export const STATE_RANK: Record<MachineState, number> = { running: 1, planned: 2, starved: 3, blocked: 4, reduced: 5, down: 6 };

export type LineStageStatus = {
  def: LineStageDef;
  machines: { id: string; state: MachineState; reason: string | null }[];
  /** Worst machine state in the stage; null where no machine state is modelled. */
  worst: MachineState | null;
  /** Machine to locate on click: the one in the worst state (first machine when all are equal). */
  focusId: string | null;
  bottleneck: boolean;
};

export function lineStatus(s: SimState) {
  const bn = bottleneck(s);
  const stages: LineStageStatus[] = LINE_STAGES.map((def) => {
    const machines = def.stages
      .flatMap((st) => STAGE_BY_ID[st].machines)
      .map((id) => {
        const m = s.machines[id];
        const dt = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
        return { id, state: m.state, reason: dt ? REASON_BY_CODE[dt.reasonCode].label : null };
      });
    let worst: MachineState | null = null;
    let focusId: string | null = null;
    for (const m of machines)
      if (worst == null || STATE_RANK[m.state] > STATE_RANK[worst]) {
        worst = m.state;
        focusId = m.id;
      }
    return { def, machines, worst, focusId, bottleneck: def.stages.includes(bn.current.stage) };
  });
  return { stages, bottleneckStage: bn.current.stage, bottleneckShare: bn.current.activeShare, window: bn.period.label };
}

// ── Truck visit stepper ──────────────────────────────────────────────────────

export type VisitStep = { key: string; label: string; time: number | null; note?: string };

/** Visit milestones with timestamps (null = not reached yet; never a future time). */
export function visitSteps(s: SimState, v: TruckRuntime): VisitStep[] {
  const now = s.minute;
  const vis = v.visit!;
  const past = (t: number | null | undefined) => (t != null && t <= now ? t : null);
  const dock = vis.dockId ? DOCKS.find((d) => d.id === vis.dockId)?.name : undefined;
  if (vis.direction === 'inbound') {
    const weigh = v.legs.find((l) => l.activity.startsWith('Weighing'));
    return [
      { key: 'gate-in', label: 'Gate in', time: past(vis.gateIn) },
      { key: 'weigh', label: 'Weighbridge', time: past(weigh?.start) },
      { key: 'unload', label: 'Unloading', time: past(vis.dockStart), note: vis.material },
      { key: 'unloaded', label: 'Unloading complete', time: past(vis.dockEnd) },
      { key: 'gate-out', label: 'Gate out', time: past(vis.gateOut) },
    ];
  }
  const loaded = s.logistics.dockEvents.find((e) => e.vehicleId === v.id && e.kind === 'loading-complete')?.time;
  return [
    { key: 'gate-in', label: 'Gate in', time: past(vis.gateIn) },
    { key: 'holding', label: 'Holding', time: past(v.queuedAt) },
    { key: 'assigned', label: 'Dock assigned', time: past(vis.dockAssigned), note: dock },
    { key: 'docked', label: 'Docked / loading', time: past(vis.dockStart) },
    { key: 'loaded', label: 'Loading complete', time: past(loaded), note: `${vis.load} pallets` },
    { key: 'gate-out', label: 'Gate out', time: past(vis.gateOut) },
  ];
}

/** Index of the step in progress (first not reached), or steps.length when the visit is complete. */
export const currentStep = (steps: VisitStep[]) => {
  const i = steps.findIndex((st) => st.time == null);
  return i < 0 ? steps.length : i;
};

// ── Live vehicle phase ───────────────────────────────────────────────────────

export type PhaseTone = 'good' | 'warning' | 'neutral';

/** Current activity of any vehicle (phase for trucks, leg activity for internal vehicles). */
export function vehicleActivity(v: Vehicle, now: number): { label: string; tone: PhaseTone } {
  if (v.class === 'external') {
    if (v.visit && v.visit.gateIn > now) return { label: 'Approaching', tone: 'neutral' };
    const p = v.phase ?? 'approaching';
    return { label: phaseLabel[p], tone: p === 'waiting' ? 'warning' : p === 'loading' || p === 'unloading' ? 'good' : 'neutral' };
  }
  const leg = [...v.legs].reverse().find((l) => l.start <= now);
  const label = leg?.activity ?? v.task ?? 'Idle';
  return { label, tone: /idle|waiting|available/i.test(label) ? 'neutral' : 'good' };
}

// ── Shift timeline ───────────────────────────────────────────────────────────

export type MarkerTone = 'critical' | 'serious' | 'warning' | 'neutral' | 'accent';

export type TimelineMarker = {
  id: string;
  kind: 'downtime' | 'alert' | 'scenario';
  /** Marker position (event start, clipped to the shift). */
  t: number;
  /** End of a span (downtime, scenario); null for point events. */
  end: number | null;
  /** True while the downtime / scenario is still running. */
  open: boolean;
  tone: MarkerTone;
  title: string;
  detail: string;
  equipmentId?: string;
  vehicleId?: string;
  source: RecordSource;
};

const SEVERITY_TONE: Record<AlertSeverity, MarkerTone> = { critical: 'critical', serious: 'serious', warning: 'warning', info: 'neutral' };

/** Equipment that best locates a scenario in the 3D model. */
const scenarioTarget = (sc: SimState['scenarios'][number]) =>
  sc.equipmentId ??
  (sc.stage
    ? STAGE_BY_ID[sc.stage].machines[0]
    : sc.kind === 'truck-arrival'
      ? 'A-GATE'
      : sc.kind === 'yard-congestion'
        ? 'A-HOLD'
        : sc.kind === 'prolonged-dock-stay'
          ? 'K-DOCK'
          : undefined);

/** Events of the current shift (06/14/22 boundaries) for the time strip, up to now. */
export function shiftTimeline(s: SimState, maxAlerts = 80) {
  const now = s.minute;
  const sh = shiftAt(now);
  const from = sh.start;
  const to = sh.end;
  const markers: TimelineMarker[] = [];
  const downStarts = new Set<string>();
  for (const d of s.downtime) {
    if (d.category === 'Starved' || d.category === 'Blocked') continue;
    const end = d.end ?? now;
    if (d.start >= to || end < from) continue;
    downStarts.add(`${d.equipmentId}@${d.start}`);
    const planned = REASON_BY_CODE[d.reasonCode].planned;
    markers.push({
      id: d.id,
      kind: 'downtime',
      t: Math.max(from, d.start),
      end,
      open: d.end == null,
      tone: planned ? 'neutral' : 'critical',
      title: `${d.equipmentId} · ${REASON_BY_CODE[d.reasonCode].label}`,
      detail: `${planned ? 'Planned stop' : d.category} from ${formatClock(d.start)}${d.end == null ? ' · still stopped' : ` to ${formatClock(d.end)}`}`,
      equipmentId: d.equipmentId,
      source: d.source,
    });
  }
  const alerts = s.alerts.filter(
    (a) =>
      a.time >= from &&
      a.time <= now &&
      !a.title.startsWith('Scenario ') &&
      // A stop alert duplicates the downtime marker that opened it.
      !(a.equipmentId && a.title.endsWith(' stopped') && downStarts.has(`${a.equipmentId}@${a.time}`)),
  );
  for (const a of alerts.slice(-maxAlerts))
    markers.push({
      id: a.id,
      kind: 'alert',
      t: a.time,
      end: null,
      open: false,
      tone: SEVERITY_TONE[a.severity],
      title: a.title,
      detail: a.detail,
      equipmentId: a.equipmentId,
      vehicleId: a.vehicleId,
      source: a.source,
    });
  for (const sc of s.scenarios) {
    const end = sc.end ?? now;
    if (sc.start >= to || end < from || sc.start > now) continue;
    markers.push({
      id: sc.id,
      kind: 'scenario',
      t: Math.max(from, sc.start),
      end: Math.min(end, now),
      open: sc.end == null || sc.end > now,
      tone: 'accent',
      title: `Scenario · ${sc.label}`,
      detail: `${SCENARIO_KIND_LABELS[sc.kind]} · started ${formatClock(sc.start)}${sc.end != null && sc.end <= now ? `, ended ${formatClock(sc.end)}` : ''}`,
      equipmentId: scenarioTarget(sc),
      source: 'scenario',
    });
  }
  return { shift: sh, from, to, now, markers };
}

// ── Production batches ───────────────────────────────────────────────────────

/** Approximate transit from pressing (≈ 2.5 h to glazing, ≈ 3 h to sorting — the same offsets the engine uses). */
const BATCH_PHASES: { upTo: number; label: string; equipmentId: string }[] = [
  { upTo: 150, label: 'pressing, drying & buffer', equipmentId: 'E-PRS1' },
  { upTo: 165, label: 'glazing & decoration', equipmentId: 'G-LINE' },
  { upTo: 180, label: 'kiln', equipmentId: 'H-KILN' },
  { upTo: 200, label: 'sorting & packing', equipmentId: 'I-SORT' },
];

/** Where a batch's most recent tiles are now (approximate), and what to locate. */
export function batchLocation(s: SimState, b: ProductionBatch): { label: string; equipmentId: string; active: boolean } {
  if (b.end == null) return { label: `In production · pressing since ${formatClock(b.start)}`, equipmentId: 'E-PRS1', active: true };
  const age = s.minute - b.end;
  const ph = BATCH_PHASES.find((p) => age < p.upTo);
  if (ph) return { label: `Last tiles at ${ph.label} (approx.)`, equipmentId: ph.equipmentId, active: true };
  return { label: `Completed ${formatClock(b.end)} · finished-goods warehouse`, equipmentId: 'K-RACK', active: false };
}

// ── Global search ────────────────────────────────────────────────────────────

export type SearchKind = 'equipment' | 'zone' | 'vehicle' | 'batch';
export type SearchTarget = { kind: 'equipment' | 'zone' | 'vehicle'; id: string };
export type SearchResult = { key: string; kind: SearchKind; title: string; subtitle: string; target: SearchTarget; zone?: string; score: number };

const KIND_ORDER: Record<SearchKind, number> = { equipment: 0, zone: 1, vehicle: 2, batch: 3 };
const norm = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** 0 exact · 1 prefix · 2 word prefix · 3 substring · -1 no match (best over the fields). */
function tokenScore(token: string, fields: string[]) {
  let best = -1;
  for (const raw of fields) {
    const f = norm(raw);
    let sc = -1;
    if (f === token) sc = 0;
    else if (f.startsWith(token)) sc = 1;
    else if (f.split(/[^a-z0-9]+/).some((w) => w.startsWith(token))) sc = 2;
    // Single characters only match the start of a word (no "a" anywhere in a name).
    else if (token.length > 1 && f.includes(token)) sc = 3;
    if (sc >= 0 && (best < 0 || sc < best)) best = sc;
  }
  return best;
}

/** Every token must match one of the fields; lower is better, null = no match. */
function score(tokens: string[], fields: string[]) {
  let total = 0;
  for (const t of tokens) {
    const sc = tokenScore(t, fields);
    if (sc < 0) return null;
    total += sc;
  }
  return total;
}

/** Search equipment (id/name), zones, vehicles on site and production batches. */
export function searchTwin(s: SimState, query: string, limit = 10): SearchResult[] {
  const tokens = norm(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const now = s.minute;
  const out: SearchResult[] = [];
  for (const e of EQUIPMENT) {
    const sc = score(tokens, [e.id, e.name, e.stage]);
    if (sc != null)
      out.push({ key: `e:${e.id}`, kind: 'equipment', title: e.name, subtitle: `${e.id} · ${ZONE_BY_ID[e.zone].short}`, target: { kind: 'equipment', id: e.id }, zone: e.zone, score: sc });
  }
  for (const z of ZONES) {
    // "h" or "zone h" find zone H; the letter alone only matches exactly.
    const letter = tokens.length === 1 && tokens[0] === z.id.toLowerCase() ? 0 : null;
    const sc = letter ?? score(tokens.filter((t) => t !== 'zone'), [z.name, z.short, z.stage, `zone ${z.id}`]);
    const zoneOnly = tokens.every((t) => t === 'zone');
    if (sc != null && !zoneOnly)
      out.push({ key: `z:${z.id}`, kind: 'zone', title: `Zone ${z.id} · ${z.name}`, subtitle: z.stage, target: { kind: 'zone', id: z.id }, zone: z.id, score: sc });
  }
  for (const id of s.logistics.active) {
    const v = s.logistics.vehicles[id];
    if (v.spawned > now) continue;
    const kind = v.class === 'external' ? (v.visit?.direction === 'inbound' ? 'inbound truck tipper' : 'outbound truck') : v.type.replace('-', ' ');
    const sc = score(tokens, [v.id, v.label, v.operator, kind, v.class === 'external' ? 'truck vehicle' : 'vehicle']);
    if (sc != null)
      out.push({
        key: `v:${id}`,
        kind: 'vehicle',
        title: v.label,
        subtitle: `${kind} · ${vehicleActivity(v, now).label}`,
        target: { kind: 'vehicle', id },
        score: sc,
      });
  }
  for (const b of s.batches) {
    const product = PRODUCTS.find((p) => p.sku === b.sku);
    const sc = score(tokens, [b.id, b.sku, product?.name ?? '', 'batch']);
    if (sc != null) {
      const loc = batchLocation(s, b);
      out.push({
        key: `b:${b.id}`,
        kind: 'batch',
        title: `Batch ${b.id}`,
        subtitle: `${product?.name ?? b.sku} · ${loc.label}`,
        target: { kind: 'equipment', id: loc.equipmentId },
        score: sc + (loc.active ? 0 : 0.5),
      });
    }
  }
  return out.sort((a, b) => a.score - b.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title)).slice(0, limit);
}

// ── Quick views ──────────────────────────────────────────────────────────────

export const LEVEL_RANK: Record<HealthLevel, number> = { offline: 0, normal: 1, watch: 2, warning: 3, alarm: 4 };

/** The assessed asset in the worst condition: highest level first, then lowest score (running assets before offline ones). */
export function worstHealth(list: HealthAssessment[]): HealthAssessment | null {
  if (!list.length) return null;
  return [...list].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.score - b.score)[0];
}
