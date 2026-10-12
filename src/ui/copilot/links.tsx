import { ArrowRight, ClipboardList, Factory, Locate, ScanSearch, Truck } from 'lucide-react';
import { openDefect, openEquipment, openEvent, openFleetVehicle, openStage, openVehicle, useApp } from '../../app/store';
import type { CopilotLink } from '../../intel/copilot';
import { useSim } from '../../sim/store';

/**
 * Follows an insight / copilot link — always into one of the seven workspaces:
 * equipment → Factory Twin with the asset selected; vehicle → Factory Twin following it (Fleet &
 * Movement if it has left the site); fleet-vehicle → its detail in Fleet & Movement; event → its
 * report in Events & Reports; defect → its evidence in Quality & Defects; stage → Production (and
 * the stage highlighted in the 3D model); workspace → that workspace.
 */
export function followLink(link: CopilotLink) {
  switch (link.kind) {
    case 'equipment':
      return openEquipment(link.id);
    case 'vehicle':
      return useSim.getState().sim.logistics.active.includes(link.id) ? openVehicle(link.id) : openFleetVehicle(link.id);
    case 'fleet-vehicle':
      return openFleetVehicle(link.id);
    case 'event':
      return openEvent(link.id);
    case 'defect':
      return openDefect(link.id);
    case 'stage':
      return openStage(link.id);
    default:
      return useApp.getState().go(link.id);
  }
}

const ICON = { equipment: Locate, vehicle: Truck, 'fleet-vehicle': Truck, workspace: ArrowRight, event: ClipboardList, defect: ScanSearch, stage: Factory } as const;

const WHERE: Record<CopilotLink['kind'], string> = {
  equipment: 'Select it in the Factory Twin',
  vehicle: 'Follow it in the Factory Twin',
  'fleet-vehicle': 'Open its detail in Fleet & Movement',
  event: 'Open the event report in Events & Reports',
  defect: 'Open the defect evidence in Quality & Defects',
  stage: 'Open the stage in Production',
  workspace: 'Open the workspace',
};

export function LinkButton({ link, onFollow }: { link: CopilotLink; onFollow?: () => void }) {
  const Icon = ICON[link.kind];
  return (
    <button
      type="button"
      className="btn sm"
      title={`${WHERE[link.kind]}: ${link.id}`}
      onClick={() => {
        followLink(link);
        onFollow?.();
      }}
    >
      <Icon size={12} aria-hidden />
      {link.label}
    </button>
  );
}
