/**
 * Cameras covering an asset, inside the equipment workspace's technical details (moved here from
 * the retired Assets & Data › Camera sources tab). A camera shows an image only when the user
 * configures a browser-playable stream for it (otherwise it says no stream is configured); "Live" is
 * shown only while such a stream actually plays. Stream URLs stay in this browser.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Link2Off, Save, Settings2, Undo2, Video } from 'lucide-react';
import { useApp, type CameraSource } from '../../app/store';
import { CAMERAS } from '../../model/plant';
import type { CameraDef } from '../../model/types';
import { CameraFeed, LIVE_BADGE } from '../feeds/CameraFeed';
import { KIND_LABEL, RESOLVED_LABEL, browserEnv, planStream, urlSummary } from '../feeds/live';
import { useLiveStatus } from '../feeds/registry';
import { FeedStatusBadge, StatusBadge } from '../kit/Status';
import { useTwinUi } from '../twin/uiStore';

const KINDS = Object.keys(KIND_LABEL) as CameraSource['kind'][];

/** Cameras whose field of view includes the asset (events on it get these as evidence). */
export const camerasOf = (equipmentId: string) => CAMERAS.filter((c) => c.covers.includes(equipmentId));

/** Feed state of a camera: simulated, or what its configured stream's player last reported. */
function CameraState({ cameraId }: { cameraId: string }) {
  const source = useApp((s) => s.cameraSources[cameraId]);
  const report = useLiveStatus((s) => s.byCamera[cameraId]);
  if (!source) return <FeedStatusBadge status="simulated" />;
  if (!report)
    return (
      <span className="muted" title="The stream is opened only when its view is shown">
        Stream configured · not open
      </span>
    );
  return (
    <span title={report.detail}>
      <StatusBadge {...LIVE_BADGE[report.state]} />
    </span>
  );
}

/** Stream editor for one camera (keyed by camera id, so switching cameras starts from that camera's saved source). */
export function StreamEditor({ cam }: { cam: CameraDef }) {
  const saved = useApp((s) => s.cameraSources[cam.id]);
  const setSource = useApp((s) => s.setCameraSource);
  const [url, setUrl] = useState(saved?.url ?? '');
  const [kind, setKind] = useState<CameraSource['kind']>(saved?.kind ?? 'auto');
  const plan = useMemo(() => planStream({ url, kind }, browserEnv()), [url, kind]);
  const dirty = (saved?.url ?? '') !== url.trim() || (saved?.kind ?? 'auto') !== kind;
  // RTSP and non-http URLs can never play in a browser: not saved. An HLS URL is kept (another browser may play it).
  const blocked = !plan.ok && (plan.kind === 'rtsp' || plan.kind === null);
  const canSave = url.trim() !== '' && dirty && !blocked;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (canSave) setSource(cam.id, { url: url.trim(), kind });
  };
  const clear = () => {
    setSource(cam.id, null);
    setUrl('');
    setKind('auto');
  };
  const revert = () => {
    setUrl(saved?.url ?? '');
    setKind(saved?.kind ?? 'auto');
  };

  return (
    <div className="eqw-stream">
      <form className="eqw-stream-form" onSubmit={save} noValidate>
        <label className="field">
          Stream URL
          <input
            className="input"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://gateway.example/cam/stream.m3u8"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className="field">
          Stream type
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as CameraSource['kind'])}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {url.trim() !== '' && (
          <p className={`eqw-stream-plan ${plan.ok ? (plan.warning ? 'warn' : '') : 'bad'}`} role="status">
            {plan.ok ? (
              <>
                Plays as <b>{RESOLVED_LABEL[plan.kind]}</b>
                {plan.guessed ? ' (detected from the URL)' : ''}. “Live” is shown only once the stream actually plays.
                {plan.warning && <span> {plan.warning}</span>}
              </>
            ) : (
              <>
                <b>{plan.reason}.</b> {plan.detail}
                {!blocked && ' It can be saved, but will show as unavailable here.'}
              </>
            )}
          </p>
        )}
        <div className="eqw-stream-actions">
          <button type="submit" className="btn primary sm" disabled={!canSave}>
            <Save size={12} aria-hidden /> {saved ? 'Save changes' : 'Save stream'}
          </button>
          {dirty && (
            <button type="button" className="btn ghost sm" onClick={revert}>
              <Undo2 size={12} aria-hidden /> Revert
            </button>
          )}
          {saved && (
            <button type="button" className="btn sm danger" onClick={clear} title="Remove the stream; the camera then shows no image">
              <Link2Off size={12} aria-hidden /> Clear stream
            </button>
          )}
        </div>
      </form>
      <div className="eqw-stream-preview">
        <div className="eqw-sub-h">Preview</div>
        <CameraFeed cameraId={cam.id} compact height={150} />
      </div>
      <ul className="eqw-fine-list">
        <li>Browsers cannot open RTSP / ONVIF directly: a gateway must restream the camera as HLS (.m3u8), MJPEG or MP4 / WebM over http(s).</li>
        <li>To capture frames for event evidence the gateway must allow CORS for this page; without it the stream still plays, but no frame is captured as event evidence.</li>
        <li>The URL is stored in this browser only. Do not put credentials in it.</li>
      </ul>
    </div>
  );
}

/** Camera list of an asset: feed state, the floating camera view and the stream editor. */
export function CameraSources({ equipmentId }: { equipmentId: string }) {
  const cams = camerasOf(equipmentId);
  const sources = useApp((s) => s.cameraSources);
  const open = useTwinUi((s) => s.camera);
  const setCamera = useTwinUi((s) => s.setCamera);
  const [editing, setEditing] = useState<string | null>(null);
  if (!cams.length) return <p className="insp-desc">No camera position covers this asset.</p>;
  return (
    <div className="eqw-cams">
      {cams.map((c) => {
        const src = sources[c.id];
        const on = open === c.id;
        const edit = editing === c.id;
        return (
          <div key={c.id} className="eqw-cam">
            <div className="eqw-cam-h">
              <Video size={13} aria-hidden />
              <b>{c.name}</b>
              <span className="mono muted">{c.id}</span>
            </div>
            <div className="eqw-cam-m">
              <span>{src ? `Configured stream · ${src.kind === 'auto' ? 'auto' : RESOLVED_LABEL[src.kind]} · ${urlSummary(src.url)}` : 'No stream configured — no image'}</span>
              <CameraState cameraId={c.id} />
            </div>
            <div className="eqw-cam-a">
              <button type="button" className={`btn sm ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setCamera(on ? null : c.id)} title="Show this camera in the floating camera view over the model">
                <Video size={12} aria-hidden />
                {on ? 'Hide view' : 'Show view'}
              </button>
              <button type="button" className={`btn sm ${edit ? 'on' : ''}`} aria-expanded={edit} onClick={() => setEditing(edit ? null : c.id)}>
                <Settings2 size={12} aria-hidden />
                {src ? 'Edit stream' : 'Configure a stream'}
              </button>
            </div>
            {edit && <StreamEditor key={c.id} cam={c} />}
          </div>
        );
      })}
    </div>
  );
}
