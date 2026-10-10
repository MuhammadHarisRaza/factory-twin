import { Activity, ArrowRight, ClipboardList, Locate, Truck } from 'lucide-react';
import { openEquipment, openEvent, openStage, openVehicle, useApp } from '../../app/store';
import type { InsightLink } from '../../intel/insights';
import { useSim } from '../../sim/store';

/**
 * Follows an insight / copilot link: equipment → Factory Twin with the asset selected,
 * vehicle → Factory Twin following it (Fleet & Logistics if it has left the site),
 * workspace → that workspace.
 */
export function followLink(link: InsightLink) {
  if (link.kind === 'equipment') openEquipment(link.id);
  else if (link.kind === 'vehicle') {
    if (useSim.getState().sim.logistics.active.includes(link.id)) openVehicle(link.id);
    else useApp.getState().go('fleet');
  } else if (link.kind === 'event') openEvent(link.id);
  else if (link.kind === 'stage') openStage(link.id);
  else useApp.getState().go(link.id);
}

const ICON = { equipment: Locate, vehicle: Truck, workspace: ArrowRight, event: ClipboardList, stage: Activity } as const;

export function LinkButton({ link, onFollow }: { link: InsightLink; onFollow?: () => void }) {
  const Icon = ICON[link.kind];
  const where =
    link.kind === 'equipment'
      ? 'Locate in the Factory Twin'
      : link.kind === 'vehicle'
        ? 'Follow in the Factory Twin'
        : link.kind === 'event'
          ? 'Open the event report'
          : link.kind === 'stage'
            ? 'Open the stage in Production Monitoring'
            : 'Open workspace';
  return (
    <button
      type="button"
      className="btn sm"
      title={`${where}: ${link.id}`}
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
