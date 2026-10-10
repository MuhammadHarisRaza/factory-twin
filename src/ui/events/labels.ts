/**
 * Display helpers for event records shared by the event list, the Events workspace and the report.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID, GEOFENCES, INSPECTION_STATIONS, MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { MonitoredStageId, OpEvent } from '../../model/types';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';

/** "E-PRS1 · Hydraulic press 1", "TRK 1097", "ST-VIS · Vision inspection" … */
export function eventAssetLabel(ev: OpEvent, vehicleLabel?: (id: string) => string | undefined): string {
  const a = ev.asset;
  if (a.vehicleId) return vehicleLabel?.(a.vehicleId) ?? a.vehicleId;
  if (a.stationId) return `${a.stationId} · ${INSPECTION_STATIONS.find((s) => s.id === a.stationId)?.name ?? ''}`.replace(/ · $/, '');
  if (a.equipmentId) {
    const name = CONVEYOR_BY_ID[a.equipmentId]?.name ?? EQUIPMENT_BY_ID[a.equipmentId]?.name;
    return name ? `${a.equipmentId} · ${name}` : a.equipmentId;
  }
  if (a.geofenceId) return GEOFENCES.find((g) => g.id === a.geofenceId)?.name ?? a.geofenceId;
  if (a.stage) return MONITORED_STAGE_BY_ID[a.stage as MonitoredStageId]?.name ?? a.stage;
  if (a.zone) return `Zone ${a.zone}`;
  return 'Plant';
}

/** Start time: clock only when it is the same plant day as now, otherwise with the day. */
export function eventStartLabel(ev: OpEvent, now: number) {
  return Math.floor(ev.start / 1440) === Math.floor(now / 1440) ? formatClock(ev.start) : formatDateTime(ev.start);
}

/** "18 min" (cleared) / "18 min so far" (condition still active). */
export function eventDurationLabel(ev: OpEvent, now: number) {
  const d = formatDuration(Math.max(0, (ev.end ?? now) - ev.start));
  return ev.end == null ? `${d} so far` : d;
}
