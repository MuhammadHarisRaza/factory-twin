import { openEquipment, openVehicle, useApp } from '../../app/store';
import { useSim } from '../../sim/store';

/**
 * Navigates to the subject of an alert or event: a vehicle still on site is followed in
 * the Factory Twin, otherwise its equipment is located; vehicles that have left go to
 * Fleet & Logistics, records without a subject (scenario inputs) to the Scenario Simulator.
 */
export function locate(t: { equipmentId?: string; vehicleId?: string }) {
  if (t.vehicleId && useSim.getState().sim.logistics.active.includes(t.vehicleId)) openVehicle(t.vehicleId);
  else if (t.equipmentId) openEquipment(t.equipmentId);
  else if (t.vehicleId) useApp.getState().go('fleet');
  else useApp.getState().go('scenarios');
}

/** Smoothly scrolls a Command Center panel into view. */
export function scrollToPanel(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
