/**
 * Data & connectivity tab of Events & Reports (brief §8 F): which data sources exist and what they deliver in
 * this demo, how much of the signal catalogue the simulation covers per stage / availability class / status,
 * per equipment item, which signals are not modelled or unavailable and why, how fresh each tracked asset's
 * feed is, and what the data-quality rules found — pure, testable.
 *
 * Honesty rules held here: the simulation engine is the only source and reads 'Simulated'; every other source
 * reads 'Not connected' (this release has no verified integration, whatever a status field says). A catalogue
 * count of 'connected' is not a claim this code ever makes — it is reported as 0 and asserted in the tests.
 * Freshness is judged from the timestamps the telemetry source delivers (calc freshness), not from the
 * simulation's internal feed state.
 */
import { freshness, type FreshnessStatus } from '../../calc';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import {
  AVAILABILITY_CLASSES,
  AVAILABILITY_CLASS_LABEL,
  AVAILABILITY_STATUS_LABEL,
  CATALOG,
  SOURCE_SYSTEM_LABEL,
  STAGE9_EQUIPMENT_ID,
  STAGE_BY_NO,
  STAGES_12,
  catalogFor,
  coverage,
  definitionOf,
  type AvailabilityClass,
  type AvailabilityStatus,
  type CoverageCount,
  type ProductionStageDef,
  type ProductionStageNo,
  type SignalDefinition,
  type SourceSystem,
} from '../../model/catalog';
import { CONVEYOR_BY_ID, DATA_SOURCES } from '../../model/plant';
import type { Quality } from '../../calc/types';
import type { DataSource } from '../../model/types';
import { TRACKED_ASSETS, type SimState } from '../../sim/engine';
import { readSignal } from '../../sim/telemetry';
import { formatClock } from '../../sim/time';

/** The statement the tab leads with (docs named, not linked: they live in the repository). */
export const NO_PLANT_CONNECTION =
  'No plant system is connected in this demo: no PLC, SCADA, historian, MES, ERP, WMS, QMS, telematics or vision system. Every value comes from the in-browser simulation engine.';
export const BOUNDARY_NOTE =
  'Pages and rules read telemetry through one adapter interface (TelemetrySource, src/model/telemetry.ts); the demo implements it with the simulation. A real read-only adapter would implement the same interface — see docs/INTEGRATION.md for the integration boundary and docs/SIGNALS.md for the signal catalogue.';

// ── Sources ──────────────────────────────────────────────────────────────────

/** Catalogue source systems a declared data source would provide (documentation of the boundary, not a link). */
const SYSTEMS_OF_KIND: Record<DataSource['kind'], SourceSystem[]> = {
  simulation: [],
  plc: ['PLC'],
  scada: ['SCADA', 'historian'],
  'iot-gateway': [],
  mes: ['MES'],
  erp: [],
  wms: ['WMS'],
  telematics: ['telematics'],
  vision: ['vision'],
};

export type StatusCounts = { total: number; simulated: number; notModelled: number; unavailable: number };

const countStatuses = (defs: SignalDefinition[]): StatusCounts => ({
  total: defs.length,
  simulated: defs.filter((d) => d.availabilityStatus === 'simulated').length,
  notModelled: defs.filter((d) => d.availabilityStatus === 'not-modelled').length,
  unavailable: defs.filter((d) => d.availabilityStatus === 'unavailable').length,
});

export type SourceRow = {
  id: string;
  name: string;
  kind: DataSource['kind'];
  /** 'simulated' for the simulation engine; every other source is not connected in this release. */
  status: 'simulated' | 'not-connected';
  statusLabel: 'Simulated' | 'Not connected';
  protocol: string;
  description: string;
  /** Catalogue source systems this source stands for (empty when none is mapped). */
  systems: SourceSystem[];
  /** Catalogue entries from those systems (the simulation: the entries it simulates); null when none is mapped. */
  signals: StatusCounts | null;
  /** What happens at the adapter boundary for this source. */
  boundary: string;
};

export function sourceRows(): SourceRow[] {
  return DATA_SOURCES.map((d): SourceRow => {
    const sim = d.kind === 'simulation' && d.status === 'simulated';
    const systems = SYSTEMS_OF_KIND[d.kind] ?? [];
    const defs = sim ? CATALOG.filter((x) => x.availabilityStatus === 'simulated') : CATALOG.filter((x) => systems.includes(x.sourceSystem));
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      status: sim ? 'simulated' : 'not-connected',
      statusLabel: sim ? 'Simulated' : 'Not connected',
      protocol: d.protocol,
      description: d.description,
      systems,
      signals: sim || defs.length ? countStatuses(defs) : null,
      boundary: sim
        ? 'Implements the telemetry adapter in the browser (simulatedSource) — every reading is labelled simulated'
        : `No adapter configured; a read-only ${d.protocol} adapter would implement the same interface`,
    };
  });
}

/** Catalogue source systems no declared data source stands for (e.g. QMS / lab), with their entries. */
export function unlistedSystems(): { system: SourceSystem; label: string; signals: StatusCounts }[] {
  const mapped = new Set(Object.values(SYSTEMS_OF_KIND).flat());
  const systems = [...new Set(CATALOG.map((d) => d.sourceSystem))].filter((x) => !mapped.has(x) && x !== 'simulated' && x !== 'reference');
  return systems.map((system) => ({ system, label: SOURCE_SYSTEM_LABEL[system], signals: countStatuses(CATALOG.filter((d) => d.sourceSystem === system)) }));
}

// ── Coverage matrix ──────────────────────────────────────────────────────────

export type ClassFilter = AvailabilityClass | 'all';

export type CoverageRow = {
  /** 'S01'…'S12', 'support' or 'total'. */
  key: string;
  no: ProductionStageNo | null;
  name: string;
  present: ProductionStageDef['present'] | null;
  presentLabel: string;
  note: string | null;
  total: number;
  simulated: number;
  notModelled: number;
  unavailable: number;
  reference: number;
  connected: number;
};

/** How the stage exists in this representative plant (stage 8 partial, stage 9 not present). */
export const PRESENT_LABEL: Record<ProductionStageDef['present'], string> = {
  yes: 'Present',
  partial: 'Partial — kiln outfeed storage + sorting roller conveyor',
  no: 'Not present — flagged for configuration',
};

function countRow(c: CoverageCount, cls: ClassFilter): Pick<CoverageRow, 'total' | 'simulated' | 'notModelled' | 'unavailable' | 'reference' | 'connected'> {
  const by: Record<AvailabilityStatus, number> = cls === 'all' ? c.byStatus : c.matrix[cls];
  return {
    total: cls === 'all' ? c.total : c.byClass[cls],
    simulated: by.simulated,
    notModelled: by['not-modelled'],
    unavailable: by.unavailable,
    reference: by.reference,
    connected: by.connected,
  };
}

/** Catalogue coverage per brief stage (1–12), the support assets and in total, for one availability class or all. */
export function coverageRows(cls: ClassFilter = 'all'): { rows: CoverageRow[]; total: CoverageRow } {
  const c = coverage();
  const rows: CoverageRow[] = c.stages.map((st) => ({
    key: st.id,
    no: st.no,
    name: st.name,
    present: st.present,
    presentLabel: PRESENT_LABEL[st.present],
    note: st.present === 'yes' ? null : STAGE_BY_NO[st.no].note,
    ...countRow(st, cls),
  }));
  rows.push({ key: 'support', no: null, name: 'Site utilities & support (no stage)', present: null, presentLabel: 'Support assets', note: null, ...countRow(c.support, cls) });
  return { rows, total: { key: 'total', no: null, name: 'All catalogue entries', present: null, presentLabel: '', note: null, ...countRow(c.total, cls) } };
}

/** Counts per availability class (for the class selector). */
export const classCounts = (): Record<ClassFilter, number> => {
  const t = coverage().total;
  return { all: t.total, core: t.byClass.core, conditional: t.byClass.conditional, external: t.byClass.external };
};

// ── Per-equipment coverage ───────────────────────────────────────────────────

export type FeedState = 'simulated' | 'stale' | 'issue' | 'none';

export type EquipmentCoverageRow = {
  id: string;
  name: string;
  stageNo: ProductionStageNo | null;
  stageName: string;
  total: number;
  simulated: number;
  notModelled: number;
  unavailable: number;
  /** Newest timestamp of its simulated signals (plant minute; null = none received). */
  lastUpdate: number | null;
  /** Simulated signals whose current reading is bad, stale or missing. */
  notCurrent: number;
  feed: FeedState;
  feedLabel: string;
  /** Process machine or conveyor with an operating feed. */
  tracked: boolean;
};

const UNUSABLE: ReadonlySet<Quality> = new Set<Quality>(['bad', 'stale', 'missing']);

export const equipmentName = (id: string) =>
  id === STAGE9_EQUIPMENT_ID ? 'Polishing & rectification (no machine in the 3D model)' : (EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id);

/** Every equipment item of the catalogue with its coverage counts and the state of its simulated readings. */
export function equipmentCoverageRows(s: SimState): EquipmentCoverageRow[] {
  const tracked = new Set(TRACKED_ASSETS);
  return coverage().equipment.map((e): EquipmentCoverageRow => {
    const sim = catalogFor(e.equipmentId).filter((d) => d.availabilityStatus === 'simulated');
    let last: number | null = null;
    let notCurrent = 0;
    for (const d of sim) {
      const r = readSignal(s, d.signalId);
      if (r.timestamp != null && (last == null || r.timestamp > last)) last = r.timestamp;
      if (UNUSABLE.has(r.quality)) notCurrent++;
    }
    const f = s.feeds[e.equipmentId];
    const [feed, feedLabel]: [FeedState, string] =
      f?.status === 'stale'
        ? ['stale', `Stale since ${formatClock(f.since)}`]
        : notCurrent
          ? ['issue', `${notCurrent} signal${notCurrent === 1 ? '' : 's'} not current`]
          : sim.length
            ? ['simulated', 'Simulated']
            : ['none', e.equipmentId === STAGE9_EQUIPMENT_ID ? 'Not present — flagged for configuration' : 'No simulated signal'];
    return {
      id: e.equipmentId,
      name: equipmentName(e.equipmentId),
      stageNo: e.stage,
      stageName: e.stage ? `${e.stage} · ${STAGE_BY_NO[e.stage].name}` : 'Support (no stage)',
      total: e.total,
      simulated: e.byStatus.simulated,
      notModelled: e.byStatus['not-modelled'],
      unavailable: e.byStatus.unavailable,
      lastUpdate: last,
      notCurrent,
      feed,
      feedLabel,
      tracked: tracked.has(e.equipmentId),
    };
  });
}

export type StageFilter = ProductionStageNo | 'support' | 'all';

/** Free-text (id / name, every term) and stage filter of the equipment table. */
export function filterEquipmentRows(rows: EquipmentCoverageRow[], f: { query: string; stage: StageFilter }): EquipmentCoverageRow[] {
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.stage === 'support' ? r.stageNo != null : f.stage !== 'all' && r.stageNo !== f.stage) return false;
    const text = `${r.id} ${r.name}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });
}

// ── Not-modelled / unavailable signals ───────────────────────────────────────

export type GapStatus = 'not-modelled' | 'unavailable';
export const GAP_STATUSES: GapStatus[] = ['not-modelled', 'unavailable'];

export type GapFilters = {
  stage: StageFilter;
  cls: ClassFilter;
  status: GapStatus | 'all';
  source: SourceSystem | 'all';
  /** One equipment item (set from the equipment table), null = any. */
  equipmentId: string | null;
  query: string;
};

export const DEFAULT_GAP_FILTERS: GapFilters = { stage: 'all', cls: 'all', status: 'all', source: 'all', equipmentId: null, query: '' };

const isGap = (d: SignalDefinition): d is SignalDefinition & { availabilityStatus: GapStatus } => (GAP_STATUSES as string[]).includes(d.availabilityStatus);
export const GAP_SIGNALS: SignalDefinition[] = CATALOG.filter(isGap);

type GapFacet = 'stage' | 'cls' | 'status' | 'source';

function passesGap(d: SignalDefinition, f: GapFilters, skip?: GapFacet): boolean {
  if (skip !== 'stage' && (f.stage === 'support' ? d.stage != null : f.stage !== 'all' && d.stage !== f.stage)) return false;
  if (skip !== 'cls' && f.cls !== 'all' && d.availabilityClass !== f.cls) return false;
  if (skip !== 'status' && f.status !== 'all' && d.availabilityStatus !== f.status) return false;
  if (skip !== 'source' && f.source !== 'all' && d.sourceSystem !== f.source) return false;
  if (f.equipmentId && d.equipmentId !== f.equipmentId) return false;
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const text = `${d.signalId} ${d.name} ${d.description} ${d.statusNote ?? ''}`.toLowerCase();
    if (!terms.every((t) => text.includes(t))) return false;
  }
  return true;
}

/** The catalogue entries the demo has no value for (not modelled / unavailable), filtered, in stage order. */
export function gapSignals(f: GapFilters): SignalDefinition[] {
  return GAP_SIGNALS.filter((d) => passesGap(d, f)).sort((a, b) => (a.stage ?? 99) - (b.stage ?? 99));
}

export type GapFacets = {
  stage: Record<string, number>;
  cls: Record<ClassFilter, number>;
  status: Record<GapStatus | 'all', number>;
  source: Record<string, number>;
};

/** Per-option counts: every filter applies except the facet's own, so an option shows what selecting it would list. */
export function gapFacets(f: GapFilters): GapFacets {
  const out: GapFacets = { stage: { all: 0, support: 0 }, cls: { all: 0, core: 0, conditional: 0, external: 0 }, status: { all: 0, 'not-modelled': 0, unavailable: 0 }, source: { all: 0 } };
  for (const st of STAGES_12) out.stage[st.no] = 0;
  for (const d of GAP_SIGNALS) {
    if (passesGap(d, f, 'stage')) {
      out.stage.all++;
      out.stage[d.stage ?? 'support']++;
    }
    if (passesGap(d, f, 'cls')) {
      out.cls.all++;
      out.cls[d.availabilityClass]++;
    }
    if (passesGap(d, f, 'status')) {
      out.status.all++;
      out.status[d.availabilityStatus as GapStatus]++;
    }
    if (passesGap(d, f, 'source')) {
      out.source.all++;
      out.source[d.sourceSystem] = (out.source[d.sourceSystem] ?? 0) + 1;
    }
  }
  return out;
}

/** Source systems that occur among the gap signals, in label order. */
export const GAP_SOURCES: SourceSystem[] = [...new Set(GAP_SIGNALS.map((d) => d.sourceSystem))].sort((a, b) => SOURCE_SYSTEM_LABEL[a].localeCompare(SOURCE_SYSTEM_LABEL[b]));

export const gapStatusLabel = (st: GapStatus) => AVAILABILITY_STATUS_LABEL[st];
export const classLabel = (c: AvailabilityClass) => AVAILABILITY_CLASS_LABEL[c];
export { AVAILABILITY_CLASSES };

// ── Asset feed freshness ─────────────────────────────────────────────────────

export type FreshnessRow = {
  id: string;
  name: string;
  kind: 'machine' | 'conveyor';
  /** The state signal read (`.state`, conveyors `.run_state`). */
  signalId: string;
  text: string;
  quality: Quality;
  timestamp: number | null;
  ageS: number | null;
  /** Judged from the delivered timestamp against the catalogue's update interval; a 'stale' quality flag is stale. */
  status: FreshnessStatus;
  /** First minute without a fresh value (the minute after the last one), when the value is not current. */
  staleSince: number | null;
  note?: string;
};

export const FRESHNESS_LABEL: Record<FreshnessStatus, string> = { fresh: 'Fresh', late: 'Late', stale: 'Stale', missing: 'No value', 'event-driven': 'Event-driven' };

/** State-signal freshness of every tracked asset (process machines and conveyors). */
export function assetFreshness(s: SimState): FreshnessRow[] {
  return TRACKED_ASSETS.map((id): FreshnessRow => {
    const conv = !!CONVEYOR_BY_ID[id];
    const signalId = `${id}.${conv ? 'run_state' : 'state'}`;
    const r = readSignal(s, signalId);
    const fr = freshness(r.timestamp, s.minute, definitionOf(signalId)?.expectedUpdateIntervalS ?? null);
    const status: FreshnessStatus = r.quality === 'stale' ? 'stale' : r.quality === 'missing' && r.timestamp == null ? 'missing' : fr.status;
    const current = status === 'fresh' || status === 'event-driven';
    return {
      id,
      name: equipmentName(id),
      kind: conv ? 'conveyor' : 'machine',
      signalId,
      text: r.text,
      quality: r.quality,
      timestamp: r.timestamp,
      ageS: fr.ageS,
      status,
      staleSince: current ? null : r.timestamp != null ? r.timestamp + 1 : null,
      ...(r.note ? { note: r.note } : {}),
    };
  });
}

/** Counts per freshness status, plus readings flagged bad (a bad reading keeps its value but is not trusted). */
export function freshnessSummary(rows: FreshnessRow[]): Record<FreshnessStatus, number> & { bad: number } {
  const out = { fresh: 0, late: 0, stale: 0, missing: 0, 'event-driven': 0, bad: 0 };
  for (const r of rows) {
    out[r.status]++;
    if (r.quality === 'bad') out.bad++;
  }
  return out;
}
