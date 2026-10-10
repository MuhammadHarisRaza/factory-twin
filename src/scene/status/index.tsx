/**
 * Operational state made visible in the 3D factory — all driven by the shared simulation:
 * status beacons, the current bottleneck, machine-health and energy pins, inspection points,
 * product moving on the conveyors and the selected vehicle's route.
 */
import { AssetPins } from './AssetPins';
import { BottleneckHighlight } from './BottleneckHighlight';
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
      <BottleneckHighlight />
      <AssetPins />
      <InspectionMarkers />
      <VehicleRoute />
    </>
  );
}
