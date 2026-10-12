/**
 * Operational state made visible in the 3D factory — all driven by the shared simulation:
 * status beacons, conveyor stop / accumulation marks, the line-constraint marker (worded as the
 * Overview's constraint claim), condition and data-stale pins, inspection points, product moving
 * on the conveyors, the selected vehicle's route and the highlighted production stage. Alert markers honour useTwin.alertFilter
 * (./alerts.ts); beacons, the constraint marker and the stage highlight are always shown.
 */
import { AssetPins } from './AssetPins';
import { ConstraintHighlight } from './ConstraintHighlight';
import { ConveyorStatus } from './ConveyorStatus';
import { InspectionMarkers } from './InspectionMarkers';
import { ProductFlow } from './ProductFlow';
import { StageHighlight } from './StageHighlight';
import { StatusBeacons } from './StatusBeacons';
import { VehicleRoute } from './VehicleRoute';
import './status.css';

export function OperationalStatus() {
  return (
    <>
      <StageHighlight />
      <ProductFlow />
      <StatusBeacons />
      <ConveyorStatus />
      <ConstraintHighlight />
      <AssetPins />
      <InspectionMarkers />
      <VehicleRoute />
    </>
  );
}
