/**
 * Where the panel's subject is explained further: its production stage, quality for inspection,
 * fleet for logistics. Shown as one compact "Continue in" line in the panel body (the action bar keeps
 * only Focus, Camera and Ask Copilot). The subject's event records are not repeated here: the Events
 * section's "View all N events" opens exactly that list.
 */
import { openFleetVehicle, openStage, useApp } from '../../../app/store';
import { MONITORED_STAGE_BY_ID } from '../../../model/plant';
import type { MonitoredStageId } from '../../../model/types';
import type { AssetProfile } from '../profile';

export type FlowLink = { key: string; label: string; title: string; run: () => void };

/** Workflow links of an asset: its production stage, quality for sorting / inspection, fleet for logistics. */
export function flowLinks(prof: AssetProfile): FlowLink[] {
  const out: FlowLink[] = [];
  if (prof.monitored) {
    const name = MONITORED_STAGE_BY_ID[prof.monitored].name;
    const stage = prof.monitored;
    out.push({ key: 'production', label: 'Production', title: `Open in Production — ${name}: inputs, outputs, losses and events`, run: () => openStage(stage) });
  }
  if (prof.kind === 'station' || prof.stage === 'SORT') out.push({ key: 'quality', label: 'Quality & Defects', title: 'Defect inspection, evidence and trends', run: () => useApp.getState().go('quality') });
  if (prof.kind === 'logistics' || prof.id === 'B-RCV' || prof.id === 'B-LOAD')
    out.push({ key: 'fleet', label: 'Fleet & Movement', title: 'Vehicles, docks, dwell and material movement', run: () => useApp.getState().go('fleet') });
  return out;
}

/** Workflow links of a vehicle: its full record in Fleet & Movement. */
export function vehicleLinks(id: string): FlowLink[] {
  return [{ key: 'fleet', label: 'Fleet & Movement', title: 'Open in Fleet & Movement — the vehicle’s full record: route, visit and events', run: () => openFleetVehicle(id) }];
}

/** Workflow links of a production stage. */
export function stageLinks(id: MonitoredStageId): FlowLink[] {
  const name = MONITORED_STAGE_BY_ID[id].name;
  return [{ key: 'production', label: 'Production', title: `Open in Production — ${name}: inputs, outputs, losses and events`, run: () => openStage(id) }];
}
