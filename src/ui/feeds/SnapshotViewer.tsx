import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Download, X } from 'lucide-react';
import { CAMERA_BY_ID } from '../../model/plant';
import type { TwinRender } from '../../twin/bridge';
import { formatClockSec, formatDay } from '../../sim/time';
import { localStamp, snapshotFileName } from './overlay';

export type Snapshot = {
  cameraId: string;
  /** simulated = rendered from the digital twin; live = frame grabbed from the configured stream. */
  origin: 'simulated' | 'live';
  frame: TwinRender;
  /** Plant time of a twin render. */
  plantMinute?: number;
  /** Wall-clock time of a stream frame. */
  at?: Date;
};

/**
 * Small viewer for a snapshot taken from a camera feed, with a download of the labelled JPEG.
 * Snapshots taken here are not attached to events — event evidence is captured automatically.
 */
export function SnapshotViewer({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [onClose]);

  const cam = CAMERA_BY_ID[snap.cameraId];
  const sim = snap.origin === 'simulated';
  const when = sim
    ? snap.plantMinute != null
      ? `${formatDay(snap.plantMinute)} ${formatClockSec(snap.plantMinute)} plant time`
      : 'plant time unknown'
    : `${localStamp(snap.at ?? new Date())} local time`;
  const file = snapshotFileName(snap.cameraId, snap.origin, { plantMinute: snap.plantMinute, date: snap.at });

  return createPortal(
    <div className="feed-viewer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="feed-viewer" role="dialog" aria-modal="true" aria-label={`Snapshot of ${snap.cameraId}`}>
        <header className="feed-viewer-h">
          <Camera size={14} aria-hidden />
          <b>Snapshot · {snap.cameraId}</b>
          {cam && <span className="muted">{cam.name}</span>}
          <span className="spacer" />
          <a className="btn sm" href={snap.frame.dataUrl} download={file} title={`Download ${file}`}>
            <Download size={13} aria-hidden /> Download JPEG
          </a>
          <button ref={closeRef} className="btn ghost sm icon" onClick={onClose} title="Close (Esc)" aria-label="Close the snapshot">
            <X size={14} />
          </button>
        </header>
        <div className="feed-viewer-b">
          <img
            src={snap.frame.dataUrl}
            width={snap.frame.width}
            height={snap.frame.height}
            alt={sim ? `Simulated view of ${snap.cameraId}, rendered from the digital twin` : `Frame from the configured stream of ${snap.cameraId}`}
          />
        </div>
        <footer className="feed-viewer-f">
          {sim ? <span className="tag sim">Simulated</span> : <span className="tag">Camera frame</span>}
          <span>{sim ? 'Rendered from the digital twin — not a camera image.' : 'Frame from the configured camera stream.'}</span>
          <span className="spacer" />
          <span className="num">
            {when} · {snap.frame.width}×{snap.frame.height}
          </span>
        </footer>
        <p className="feed-viewer-note">Not attached to any event. Event evidence is captured automatically when an event is detected.</p>
      </div>
    </div>,
    document.body,
  );
}
