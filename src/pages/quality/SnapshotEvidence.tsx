/**
 * The station camera view captured with a quality event, labelled by its provenance: a frame
 * grabbed from a configured stream is a camera frame; everything else is a digital-twin render and
 * is never presented as a camera image.
 */
import type { Evidence } from '../../model/types';
import { cameraName } from '../../intel/report';
import { formatClock } from '../../sim/time';
import type { TwinRender } from '../../twin/bridge';

export function SnapshotEvidence({ x, img }: { x: Evidence; img: TwinRender | null }) {
  const live = x.provenance.origin === 'live-camera';
  const at = `${x.cameraId ? cameraName(x.cameraId) : 'the asset'} at ${formatClock(x.image?.frameTime ?? x.capturedAt)}`;
  return (
    <div className="qd-snap">
      {x.status === 'available' && img ? <img src={img.dataUrl} alt={live ? `Camera frame of ${at}` : `Digital-twin render of ${at} — simulated view, not a camera image`} /> : null}
      <span>
        <b>{x.title}</b>
        <span className="dim">
          {x.status === 'available'
            ? img
              ? live
                ? ` · Camera frame · ${x.provenance.label}`
                : ' · Simulated feed · rendered from the digital twin — not a camera image'
              : live
                ? ' · Camera frame not kept in this browser session'
                : ' · Rendered view not kept in this browser session'
            : x.status === 'pending'
              ? ' · Being captured'
              : ` · Unavailable — ${x.unavailableReason ?? 'no reason recorded'}`}
        </span>
      </span>
    </div>
  );
}
