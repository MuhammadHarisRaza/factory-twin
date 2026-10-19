/**
 * Builder of the documented catalogue entries (brief §4): signals a controller or connected system
 * could provide for a stage but that this demo does not simulate ('not-modelled') or that need an
 * instrument / integration that is not configured ('unavailable'). They carry no value and no update
 * interval, and their `statusNote` says why.
 */
import { BUFFERS, SIGNALS } from '../../plant';
import { STAGE9_EQUIPMENT_ID, stageOfEquipment } from '../stages';
import type { AvailabilityClass, AvailabilityStatus, SignalCategory, SignalDataType, SignalDefinition, SourceSystem } from '../types';

export const MES_NOTE = 'Comes from the MES — no MES is connected in this demo.';
export const WMS_NOTE = 'Comes from the WMS — no WMS is connected in this demo.';
export const QMS_NOTE = 'Laboratory / QMS result — no QMS is connected in this demo.';
export const VISION_NOTE = 'Comes from a vision system — no computer vision runs in this demo.';
export const ENERGY_NOTE = "Energy metering is not part of this demo's data.";
export const S09_NOTE = 'No polishing / rectification equipment in this representative line — map to a machine to enable';

export const RUN_STATES = ['running', 'stopped', 'fault'];

export type DocSpec = {
  name: string;
  description: string;
  category: SignalCategory;
  unit?: string | null;
  dataType: SignalDataType;
  enumValues?: string[];
  cls: AvailabilityClass;
  status: Extract<AvailabilityStatus, 'not-modelled' | 'unavailable'>;
  source: SourceSystem;
  note: string;
  eng?: [number, number];
  counter?: SignalDefinition['counter'];
  metadata?: SignalDefinition['metadata'];
};

/** A documented entry `<equipmentId>.<key>`; its stage follows the equipment (S09 → stage 9). */
export function doc(equipmentId: string, key: string, o: DocSpec): SignalDefinition {
  const d: SignalDefinition = {
    signalId: `${equipmentId}.${key}`,
    equipmentId,
    name: o.name,
    description: o.description,
    category: o.category,
    unit: o.unit ?? null,
    dataType: o.dataType,
    sourceSystem: o.source,
    sourceTag: null,
    availabilityClass: o.cls,
    availabilityStatus: o.status,
    statusNote: o.note,
    expectedUpdateIntervalS: null,
    stage: equipmentId === STAGE9_EQUIPMENT_ID ? 9 : stageOfEquipment(equipmentId),
  };
  if (o.enumValues) d.enumValues = o.enumValues;
  if (o.eng) [d.engineeringMin, d.engineeringMax] = o.eng;
  if (o.counter) d.counter = o.counter;
  if (o.metadata) d.metadata = o.metadata;
  return d;
}

/** Counter semantics of a documented counter (nothing is modelled, so nothing resets it here). */
export const DOC_COUNTER: SignalDefinition['counter'] = { rolloverAt: null, resetOn: 'Confirmed at integration (shift, changeover or power cycle)' };

/** Simulated scan interval of the hosted buffer levels (one value per plant minute, as every scanned registry signal). */
const HOSTED_SCAN_S = 60;

/**
 * Occupancy of a buffer that has no equipment of its own (src/model/plant.ts BUFFERS with
 * equipmentId null), on the equipment that hosts it. When the registry has the hosted level signal
 * (plant.ts HOSTED_BUFFER_LEVELS → SIGNALS `<host>.<key>`), the entry keeps this name, description and
 * class and is 'simulated' from the buffer content; otherwise it is documented as not modelled. A buffer
 * that gains equipment with a `<equipmentId>.level` signal needs no entry here.
 */
export function bufferLevel(bufferId: string, hostEquipmentId: string, key: string, name: string, description: string): SignalDefinition[] {
  const b = BUFFERS.find((x) => x.id === bufferId);
  if (b?.equipmentId && SIGNALS.some((s) => s.id === `${b.equipmentId}.level`)) return [];
  const capacity = b ? `, ${b.capacity.toLocaleString('en-GB')} tiles` : '';
  const registry = SIGNALS.find((s) => s.id === `${hostEquipmentId}.${key}`);
  const d = doc(hostEquipmentId, key, {
    name,
    description,
    category: 'material',
    unit: '%',
    dataType: 'float',
    cls: 'core',
    status: 'not-modelled',
    source: 'PLC',
    eng: [0, 100],
    note: `The simulation holds this buffer (${bufferId}${capacity}) internally but exposes no level signal for it.`,
  });
  if (!registry) return [d];
  return [
    {
      ...d,
      availabilityStatus: 'simulated',
      statusNote: `Simulated from the content of the buffer (${bufferId}${capacity}) the simulation holds on this conveyor; 100 % = its capacity. Not a level sensor reading.`,
      expectedUpdateIntervalS: HOSTED_SCAN_S,
      metadata: { registryKind: registry.kind, registryUnit: registry.unit, metrics: registry.metrics.join(', '), bufferId, ...(b ? { capacity: b.capacity } : {}) },
    },
  ];
}
