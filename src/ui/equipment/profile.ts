/**
 * What kind of asset an equipment id is, as far as the simulation models it: a process machine of a
 * stage, a conveyor, a WIP buffer, an inspection station, raw-material handling, logistics, storage,
 * a utility or a support building. The equipment workspace picks its KPIs, condition section and
 * links from this profile, so an asset never shows metrics the model does not produce for it.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import {
  BUFFERS,
  CONDITION_MONITORED,
  CONVEYOR_BY_ID,
  INSPECTION_STATIONS,
  MONITORED_STAGES,
  MONITORED_STAGE_BY_ID,
  OPS_BY_ID,
  STAGES,
} from '../../model/plant';
import type { EquipmentCategory, MonitoredStageId, StageId } from '../../model/types';
import { TRACKED_ASSETS } from '../../sim/engine';

export type AssetKind = 'machine' | 'conveyor' | 'buffer' | 'station' | 'raw' | 'logistics' | 'storage' | 'utility' | 'support';

export type AssetProfile = {
  id: string;
  name: string;
  kind: AssetKind;
  category: EquipmentCategory;
  /** Process stage: a machine's own stage, the stage a conveyor or buffer feeds. */
  stage: StageId | null;
  /** Production stage (Production workspace, stage highlight) the asset belongs to. */
  monitored: MonitoredStageId | null;
  /** Simulated vibration / temperature / current sensors with the rule-based assessment (src/sim/health.ts). */
  conditionMonitored: boolean;
  /** WIP buffer the asset holds (buffers, and the green-tile collector conveyor). */
  bufferId: string | null;
  /** Inspection station at this asset. */
  stationId: string | null;
  /** The engine simulates an operating state for it (process machines and conveyors). */
  tracked: boolean;
};

/** Raw-material receiving, storage and feeding (zone B). */
export const RAW_IDS = ['B-RCV', 'B-BAYS', 'B-LOAD', 'B-FEED', 'B-SILO'];
/** Gate, yard, docks and warehouse handling. */
export const LOGISTICS_IDS = ['A-GATE', 'A-HOLD', 'K-DOCK', 'K-STG', 'K-RACK', 'K-FLT'];

const TRACKED = new Set(TRACKED_ASSETS);

/** Monitored stage of an asset: listed equipment / conveyor (the stage it feeds first), its WIP buffer, sorting for stations. */
export function monitoredOf(id: string): MonitoredStageId | null {
  const cv = CONVEYOR_BY_ID[id];
  if (cv) return (MONITORED_STAGES.find((m) => m.conveyors.includes(id) && m.id === cv.to) ?? MONITORED_STAGES.find((m) => m.conveyors.includes(id)))?.id ?? null;
  if (INSPECTION_STATIONS.some((st) => st.equipmentId === id)) return 'SORT';
  const listed = MONITORED_STAGES.find((m) => m.equipment.includes(id));
  if (listed) return listed.id;
  const buf = BUFFERS.find((b) => b.equipmentId === id);
  if (buf) return MONITORED_STAGES.find((m) => m.wipBufferId === buf.id)?.id ?? null;
  if (id === 'K-FLT') return 'WH';
  const st = OPS_BY_ID[id]?.stage;
  if (st && MONITORED_STAGE_BY_ID[st as MonitoredStageId]) return st as MonitoredStageId;
  // Digital decoration and palletising are shown inside glazing and packaging.
  if (st === 'DECOR') return 'GLAZE';
  if (st === 'PAL') return 'PACK';
  return null;
}

export function assetProfile(id: string): AssetProfile {
  const ops = OPS_BY_ID[id];
  const cv = CONVEYOR_BY_ID[id];
  const buf = BUFFERS.find((b) => b.equipmentId === id) ?? null;
  const station = INSPECTION_STATIONS.find((s) => s.equipmentId === id) ?? null;
  const category: EquipmentCategory = ops?.category ?? 'support';
  let kind: AssetKind;
  if (cv) kind = 'conveyor';
  else if (ops?.category === 'process') kind = 'machine';
  else if (buf) kind = 'buffer';
  else if (station) kind = 'station';
  else if (RAW_IDS.includes(id)) kind = 'raw';
  else if (LOGISTICS_IDS.includes(id)) kind = 'logistics';
  else if (category === 'storage') kind = 'storage';
  else if (category === 'utility') kind = 'utility';
  else kind = 'support';
  const bufferStage = buf ? (STAGES.find((s) => s.inputBuffer === buf.id)?.id ?? null) : null;
  return {
    id,
    name: EQUIPMENT_BY_ID[id]?.name ?? cv?.name ?? id,
    kind,
    category,
    stage: (ops?.stage ?? cv?.to ?? bufferStage ?? (station ? 'SORT' : null)) as StageId | null,
    monitored: monitoredOf(id),
    conditionMonitored: CONDITION_MONITORED.includes(id),
    bufferId: buf?.id ?? null,
    stationId: station?.id ?? null,
    tracked: TRACKED.has(id),
  };
}

export const KIND_LABEL: Record<AssetKind, string> = {
  machine: 'Process machine',
  conveyor: 'Conveyor',
  buffer: 'WIP buffer',
  station: 'Inspection station',
  raw: 'Raw-material handling',
  logistics: 'Logistics',
  storage: 'Storage',
  utility: 'Utility',
  support: 'Support',
};
