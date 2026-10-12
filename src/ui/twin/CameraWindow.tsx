import { useEffect, useRef } from 'react';
import { ExternalLink, Video, X } from 'lucide-react';
import { openStage } from '../../app/store';
import { CAMERA_BY_ID, MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { MonitoredStageId } from '../../model/types';
import { useSimValue } from '../../sim/store';
import { useTwin } from '../../store';
import { CameraFeed } from '../feeds/CameraFeed';
import { selectionCamera } from './derive';
import { useTwinUi } from './uiStore';

/**
 * Small floating camera view over the scene, opened from the equipment workspace (Camera button or technical details).
 * It follows the selection: selecting another asset switches to the camera covering it (or closes
 * when none does); a followed vehicle switches camera as it moves between covered areas.
 * The feed itself (simulated twin render, or a configured stream that actually plays) is CameraFeed.
 */
export function CameraWindow() {
  const camera = useTwinUi((s) => s.camera);
  const setCamera = useTwinUi((s) => s.setCamera);
  const selected = useTwin((s) => s.selected);
  const vehicle = useTwin((s) => s.vehicle);
  const selKey = vehicle ? `v:${vehicle}` : selected ? `e:${selected}` : null;
  const covering = useSimValue((s) => (camera ? (selectionCamera(s, { equipmentId: selected, vehicleId: vehicle })?.id ?? null) : null), [camera, selected, vehicle]);
  const lastKey = useRef(selKey);

  useEffect(() => {
    if (!camera) {
      lastKey.current = selKey;
      return;
    }
    const changed = lastKey.current !== selKey;
    lastKey.current = selKey;
    // Nothing selected any more: close. Another selection: its own camera, or close when none covers it.
    if (!selKey) setCamera(null);
    else if (changed) setCamera(covering);
    // Same selection (a vehicle on the move): switch when another camera covers it; keep the last one in between.
    else if (covering && covering !== camera) setCamera(covering);
  }, [camera, covering, selKey, setCamera]);

  const cam = camera ? CAMERA_BY_ID[camera] : undefined;
  if (!cam) return null;
  const stage = cam.stage && MONITORED_STAGE_BY_ID[cam.stage as MonitoredStageId] ? (cam.stage as MonitoredStageId) : null;
  const outOfView = vehicle != null && covering == null;
  return (
    <section className="tw-cam overlay-panel" aria-label={`Camera view · ${cam.name}`}>
      <header className="tw-cam-h">
        <Video size={13} aria-hidden />
        <b>{cam.name}</b>
        <span className="muted mono">{cam.id}</span>
        <span className="spacer" />
        {stage && (
          <button className="btn ghost sm icon" onClick={() => openStage(stage)} title={`Open ${MONITORED_STAGE_BY_ID[stage].name} in Production`} aria-label="Open the stage in Production">
            <ExternalLink size={13} />
          </button>
        )}
        <button className="btn ghost sm icon" onClick={() => setCamera(null)} title="Close the camera view (Esc)" aria-label="Close the camera view">
          <X size={14} />
        </button>
      </header>
      <CameraFeed cameraId={cam.id} compact height={176} />
      <p className="tw-cam-f">{outOfView ? 'The vehicle has left this camera’s field of view (simulated position, zone level).' : cam.purpose}</p>
    </section>
  );
}
