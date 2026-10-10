import { ZonePanel } from '../ZonePanel';
import { Inspector } from '../Inspector';
import { FlowLegend, Toolbar } from '../Toolbar';
import { Minimap } from '../Minimap';
import { Hint } from '../Overlays';
import { TwinStatusBar } from '../TwinStatusBar';

/** Interface layered over the 3D factory (hidden in presentation mode). */
export function TwinOverlays() {
  return (
    <>
      <ZonePanel />
      <TwinStatusBar />
      <Inspector />
      <Toolbar />
      <Minimap />
      <FlowLegend />
      <Hint />
    </>
  );
}
