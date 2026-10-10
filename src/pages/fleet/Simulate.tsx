/**
 * Scenario buttons of Vehicle Monitoring. Each activates a scenario on the one simulation state
 * (useSim.activate) with the same definition the Scenario Simulator uses, then selects the vehicle
 * it acts on so the presenter can follow it through the pipeline, the map and the events.
 */
import { useState } from 'react';
import { CircleCheck, Hourglass, ShieldAlert, TrafficCone, Truck } from 'lucide-react';
import type { ScenarioActivation } from '../../model/types';
import { useSim } from '../../sim/store';
import { CONGESTION_TRUCKS, DOCK_HOLD_MIN, RESTRICTED_VEHICLE, type DockHoldTarget } from './pipeline';

type Def = Omit<ScenarioActivation, 'id' | 'start'>;

/** First vehicle injected by a scenario (the earliest arrival of a congestion burst). */
function scenarioTruck(scenarioId: string): string | null {
  const L = useSim.getState().sim.logistics;
  const v = L.active
    .map((id) => L.vehicles[id])
    .filter((x) => x.visit?.scenarioId === scenarioId)
    .sort((a, b) => a.spawned - b.spawned)[0];
  return v?.id ?? null;
}

export function SimulateBar({
  hold,
  restricted,
  onSelect,
}: {
  hold: DockHoldTarget | null;
  restricted: { ok: true } | { ok: false; reason: string };
  onSelect: (id: string) => void;
}) {
  const activate = useSim((s) => s.activate);
  const [done, setDone] = useState<string | null>(null);

  const run = (def: Def, select: (sc: ScenarioActivation) => string | null, what: string) => {
    const sc = activate(def);
    const id = select(sc);
    if (id) onSelect(id);
    setDone(`${sc.label} — ${what}${id ? ` · ${id} selected` : ''}`);
  };

  return (
    <div className="fv-sim" role="group" aria-label="Simulate vehicle scenarios">
      <span className="fv-sim-k">Simulate</span>
      <button
        className="btn sm"
        title="An additional outbound truck arrives at the main gate now (scenario)"
        onClick={() => run({ kind: 'truck-arrival', end: null, label: 'Additional truck arrival' }, (sc) => scenarioTruck(sc.id), 'arriving at the gate')}
      >
        <Truck size={14} aria-hidden />
        Simulate truck arrival
      </button>
      <button
        className="btn sm"
        disabled={!hold}
        title={
          hold
            ? `Holds ${hold.truckId} at ${hold.name} for an extra ${DOCK_HOLD_MIN} min after loading (documentation hold)${hold.held ? ' — this truck is already held; the hold is extended' : ''}`
            : 'No truck is at a dock right now — nothing to hold'
        }
        onClick={() =>
          hold &&
          run(
            { kind: 'prolonged-dock-stay', dockId: hold.dockId, count: DOCK_HOLD_MIN, end: null, label: `Dock hold +${DOCK_HOLD_MIN} min · ${hold.name}` },
            () => hold.truckId,
            `held at ${hold.name}`,
          )
        }
      >
        <Hourglass size={14} aria-hidden />
        {hold ? `Simulate prolonged dock stay · ${hold.truckId} at ${hold.name}` : 'Simulate prolonged dock stay'}
      </button>
      <button
        className="btn sm"
        title={`${CONGESTION_TRUCKS} outbound trucks arrive two minutes apart (scenario)`}
        onClick={() =>
          run({ kind: 'yard-congestion', count: CONGESTION_TRUCKS, end: null, label: `Yard congestion · ${CONGESTION_TRUCKS} trucks` }, (sc) => scenarioTruck(sc.id), `${CONGESTION_TRUCKS} trucks due two minutes apart`)
        }
      >
        <TrafficCone size={14} aria-hidden />
        Simulate yard congestion
      </button>
      <button
        className="btn sm"
        disabled={!restricted.ok}
        title={
          restricted.ok
            ? `Forklift ${RESTRICTED_VEHICLE} takes its next empty-pallet run across the hall pedestrian walkway (no-entry zone); the geofence rule checks its simulated position`
            : restricted.reason
        }
        onClick={() =>
          run(
            { kind: 'restricted-entry', vehicleId: RESTRICTED_VEHICLE, end: null, label: `Restricted-zone entry · ${RESTRICTED_VEHICLE}` },
            () => RESTRICTED_VEHICLE,
            'next run crosses the walkway',
          )
        }
      >
        <ShieldAlert size={14} aria-hidden />
        Simulate restricted-zone entry ({RESTRICTED_VEHICLE})
      </button>
      {!hold && <span className="fv-why">No dock occupied — dock stay unavailable</span>}
      {!restricted.ok && <span className="fv-why">{restricted.reason}</span>}
      {done && (
        <span className="fv-sim-done" role="status">
          <CircleCheck size={13} aria-hidden /> {done}
        </span>
      )}
    </div>
  );
}
