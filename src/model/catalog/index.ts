/**
 * Public entry of the equipment / signal catalogue (brief §4–§5): the 12-stage registry, every
 * SignalDefinition, lookups per equipment and stage, and coverage counts by availability class ×
 * status. Static: built once at import time. See docs/SIGNALS.md.
 */
import { EQUIPMENT } from '../../data/equipment';
import { CATALOG } from './signals';
import { STAGE9_EQUIPMENT_ID, STAGES_12, SUPPORT_EQUIPMENT } from './stages';
import type { AvailabilityClass, AvailabilityStatus, ProductionStageDef, ProductionStageNo, SignalCategory, SignalDefinition } from './types';

export * from './types';
export { CATALOG, ENERGY_SIGNAL_NAMES, MACHINE_STATE_VALUES, PLACEHOLDER_SIGNAL_NAMES } from './signals';
export { STAGE9_EQUIPMENT_ID, STAGES_12, STAGE_BY_NO, SUPPORT_EQUIPMENT, stageOfBuffer, stageOfEquipment } from './stages';
export { CONDITION_LIMITS, type ConditionLimits } from './condition';
export {
  KG_PER_M2,
  KG_PER_TILE,
  KILN_ZONES,
  PRESS_CAVITIES,
  PROCESS_SIGNALS,
  PROCESS_SIGNAL_BY_ID,
  TILES_PER_CARTON,
  type ProcessRole,
  type ProcessSignalSpec,
  type StoppedBehaviour,
} from './process';

export const CATALOG_BY_ID: Record<string, SignalDefinition> = Object.fromEntries(CATALOG.map((d) => [d.signalId, d]));

/** Definition of a signal id (null = not in the catalogue — also for inherited keys such as 'constructor'). */
export const definitionOf = (signalId: string): SignalDefinition | null => (Object.hasOwn(CATALOG_BY_ID, signalId) ? CATALOG_BY_ID[signalId] : null);

/** True only for signals the demo simulation produces a value for. */
export const isSimulated = (signalId: string) => definitionOf(signalId)?.availabilityStatus === 'simulated';

/** Display order of the categories (a setpoint is shown right after its process value). */
export const CATEGORY_ORDER: SignalCategory[] = [
  'state',
  'command',
  'production',
  'process',
  'setpoint',
  'drive',
  'material',
  'condition',
  'quality',
  'alarm',
  'recipe',
  'logistics',
  'communication',
  'energy',
];
const CATEGORY_RANK = Object.fromEntries(CATEGORY_ORDER.map((c, i) => [c, i])) as Record<SignalCategory, number>;
/** Process values and setpoints form one group so that pairs stay together. */
const groupOf = (d: SignalDefinition) => CATEGORY_RANK[d.category === 'setpoint' ? 'process' : d.category];

export const AVAILABILITY_CLASSES: AvailabilityClass[] = ['core', 'conditional', 'external'];
export const AVAILABILITY_STATUSES: AvailabilityStatus[] = ['simulated', 'reference', 'not-modelled', 'unavailable', 'connected'];
const STATUS_RANK: Record<AvailabilityStatus, number> = { connected: 0, simulated: 1, reference: 2, 'not-modelled': 3, unavailable: 4 };

/**
 * Orders definitions for display: by category (CATEGORY_ORDER), then what the demo has (simulated
 * first), then catalogue order — with every setpoint placed right after its process value.
 */
export function orderSignals(defs: SignalDefinition[]): SignalDefinition[] {
  const index = new Map(CATALOG.map((d, i) => [d.signalId, i]));
  const sorted = [...defs].sort(
    (a, b) =>
      groupOf(a) - groupOf(b) ||
      STATUS_RANK[a.availabilityStatus] - STATUS_RANK[b.availabilityStatus] ||
      (index.get(a.signalId) ?? 0) - (index.get(b.signalId) ?? 0),
  );
  const byId = new Map(sorted.map((d) => [d.signalId, d]));
  const paired = new Set(sorted.flatMap((d) => (d.setpointSignalId && byId.has(d.setpointSignalId) ? [d.setpointSignalId] : [])));
  const out: SignalDefinition[] = [];
  for (const d of sorted) {
    if (paired.has(d.signalId)) continue;
    out.push(d);
    if (d.setpointSignalId && paired.has(d.setpointSignalId)) out.push(byId.get(d.setpointSignalId)!);
  }
  return out;
}

const BY_EQUIPMENT = new Map<string, SignalDefinition[]>();
for (const d of CATALOG) {
  const list = BY_EQUIPMENT.get(d.equipmentId);
  if (list) list.push(d);
  else BY_EQUIPMENT.set(d.equipmentId, [d]);
}
const FOR_EQUIPMENT = new Map<string, SignalDefinition[]>();

/** Every catalogue entry of an equipment item, in display order (empty when it has none). */
export function catalogFor(equipmentId: string): SignalDefinition[] {
  let list = FOR_EQUIPMENT.get(equipmentId);
  if (!list) FOR_EQUIPMENT.set(equipmentId, (list = orderSignals(BY_EQUIPMENT.get(equipmentId) ?? [])));
  return list;
}

/** Equipment ids of a stage in catalogue order (stage 9: its pseudo id). */
const stageEquipment = (s: ProductionStageDef) => (s.no === 9 ? [STAGE9_EQUIPMENT_ID, ...s.equipment] : s.equipment);

/** Every catalogue entry of a production stage, equipment by equipment in the stage's order. */
export function catalogForStage(no: ProductionStageNo): SignalDefinition[] {
  const s = STAGES_12.find((x) => x.no === no);
  if (!s) return [];
  const order = stageEquipment(s);
  const extra = [...new Set(CATALOG.filter((d) => d.stage === no && !order.includes(d.equipmentId)).map((d) => d.equipmentId))];
  return [...order, ...extra].flatMap((id) => catalogFor(id).filter((d) => d.stage === no));
}

// ── Coverage ──────────────────────────────────────────────────────────────────

export type CoverageMatrix = Record<AvailabilityClass, Record<AvailabilityStatus, number>>;

export type CoverageCount = {
  total: number;
  byClass: Record<AvailabilityClass, number>;
  byStatus: Record<AvailabilityStatus, number>;
  /** Signals per availability class × availability status. */
  matrix: CoverageMatrix;
};

export type StageCoverage = CoverageCount & { no: ProductionStageNo; id: string; name: string; present: ProductionStageDef['present'] };
export type EquipmentCoverage = CoverageCount & { equipmentId: string; stage: ProductionStageNo | null };

export type CatalogCoverage = {
  total: CoverageCount;
  stages: StageCoverage[];
  /** Every equipment item of the 12 stages and the support assets (zero counts included), plus the stage-9 pseudo id. */
  equipment: EquipmentCoverage[];
  /** Site utilities and support assets (no stage). */
  support: CoverageCount;
};

const zeroBy = <K extends string>(keys: K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

function count(defs: SignalDefinition[]): CoverageCount {
  const c: CoverageCount = {
    total: 0,
    byClass: zeroBy(AVAILABILITY_CLASSES),
    byStatus: zeroBy(AVAILABILITY_STATUSES),
    matrix: Object.fromEntries(AVAILABILITY_CLASSES.map((k) => [k, zeroBy(AVAILABILITY_STATUSES)])) as CoverageMatrix,
  };
  for (const d of defs) {
    c.total++;
    c.byClass[d.availabilityClass]++;
    c.byStatus[d.availabilityStatus]++;
    c.matrix[d.availabilityClass][d.availabilityStatus]++;
  }
  return c;
}

let coverageMemo: CatalogCoverage | null = null;

/** Catalogue coverage per stage, per equipment and in total, by availability class × status. */
export function coverage(): CatalogCoverage {
  if (coverageMemo) return coverageMemo;
  const staged = STAGES_12.flatMap((s) => stageEquipment(s));
  const known = new Set([...staged, ...SUPPORT_EQUIPMENT]);
  const others = [...EQUIPMENT.map((e) => e.id), ...BY_EQUIPMENT.keys()].filter((id) => !known.has(id));
  const ids = [...new Set([...staged, ...SUPPORT_EQUIPMENT, ...others])];
  coverageMemo = {
    total: count(CATALOG),
    stages: STAGES_12.map((s) => ({ no: s.no, id: s.id, name: s.name, present: s.present, ...count(catalogForStage(s.no)) })),
    equipment: ids.map((id) => {
      const defs = catalogFor(id);
      return { equipmentId: id, stage: defs[0]?.stage ?? STAGES_12.find((s) => stageEquipment(s).includes(id))?.no ?? null, ...count(defs) };
    }),
    support: count(CATALOG.filter((d) => d.stage == null)),
  };
  return coverageMemo;
}
