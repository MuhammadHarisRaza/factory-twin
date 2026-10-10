/**
 * Operational state made visible in the 3D factory — all driven by the shared simulation:
 * status beacons, conveyor stop / accumulation marks, the current bottleneck, machine-health,
 * energy and data-stale pins, inspection points, product moving on the conveyors and the
 * selected vehicle's route.
 */
import { AssetPins } from './AssetPins';
import { BottleneckHighlight } from './BottleneckHighlight';
import { ConveyorStatus } from './ConveyorStatus';
import { InspectionMarkers } from './InspectionMarkers';
import { ProductFlow } from './ProductFlow';
import { StatusBeacons } from './StatusBeacons';
import { VehicleRoute } from './VehicleRoute';
import './status.css';

export function OperationalStatus() {
  return (
    <>
      <ProductFlow />
      <StatusBeacons />
      <ConveyorStatus />
      <BottleneckHighlight />
      <AssetPins />
      <InspectionMarkers />
      <VehicleRoute />
    </>
  );
}
