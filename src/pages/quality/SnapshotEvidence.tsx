/**
 * The station camera frame captured with a quality event: only a frame grabbed from a configured
 * stream that was playing. Otherwise the evidence is unavailable and says why.
 */
import type { Evidence } from '../../model/types';
import { cameraName } from '../../intel/report';
import { formatClock } from '../../sim/time';
import type { TwinRender } from '../../twin/bridge';

export function SnapshotEvidence({ x, img }: { x: Evidence; img: TwinRender | null }) {
  const at = `${x.cameraId ? cameraName(x.cameraId) : 'the asset'} at ${formatClock(x.image?.frameTime ?? x.capturedAt)}`;
  return (
    <div className="qd-snap">
      {x.status === 'available' && img ? <img src={img.dataUrl} alt={`Camera frame of ${at}`} /> : null}
      <span>
        <b>{x.title}</b>
        <span className="dim">
          {x.status === 'available'
            ? img
              ? ` · Camera frame · ${x.provenance.label}`
              : ' · Camera frame not kept in this browser session'
            : x.status === 'pending'
              ? ' · Being captured'
              : ` · Unavailable — ${x.unavailableReason ?? 'no reason recorded'}`}
        </span>
      </span>
    </div>
  );
}
