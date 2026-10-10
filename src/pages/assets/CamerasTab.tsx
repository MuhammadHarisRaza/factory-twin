import { useMemo, useState, type FormEvent } from 'react';
import { Info, Link2Off, Save, Undo2 } from 'lucide-react';
import { useApp, type CameraSource } from '../../app/store';
import { ZONE_BY_ID } from '../../data/layout';
import { CAMERAS, CAMERA_BY_ID } from '../../model/plant';
import type { CameraDef } from '../../model/types';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Panel } from '../../ui/kit/Panel';
import { FeedStatusBadge, StatusBadge } from '../../ui/kit/Status';
import { CameraFeed, LIVE_BADGE, cameraStageName } from '../../ui/feeds/CameraFeed';
import { KIND_LABEL, RESOLVED_LABEL, browserEnv, planStream, urlSummary } from '../../ui/feeds/live';
import { useLiveStatus, type LiveReport } from '../../ui/feeds/registry';

const KINDS = Object.keys(KIND_LABEL) as CameraSource['kind'][];

function LiveCell({ source, report }: { source: CameraSource | undefined; report: LiveReport | undefined }) {
  if (!source) return <FeedStatusBadge status="simulated" />;
  if (!report) return <span className="muted">Not open — select to preview</span>;
  return (
    <span title={report.detail}>
      <StatusBadge {...LIVE_BADGE[report.state]} />
    </span>
  );
}

/** Stream editor for one camera (keyed by camera id, so switching cameras starts from that camera's saved source). */
function SourceEditor({ cam }: { cam: CameraDef }) {
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
    <>
      <form className="a-cam-form" onSubmit={save} noValidate>
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
          <p className={`a-cam-plan ${plan.ok ? (plan.warning ? 'warn' : '') : 'bad'}`} role="status">
            {plan.ok ? (
              <>
                Plays as <b>{RESOLVED_LABEL[plan.kind]}</b>
                {plan.guessed ? ' (detected from the URL)' : ''}. "Live" is shown only once the stream actually plays.
                {plan.warning && <span className="a-cam-warn"> {plan.warning}</span>}
              </>
            ) : (
              <>
                <b>{plan.reason}.</b> {plan.detail}
                {!blocked && ' It can be saved, but will show as unavailable here.'}
              </>
            )}
          </p>
        )}
        <div className="a-cam-actions">
          <button type="submit" className="btn primary sm" disabled={!canSave}>
            <Save size={12} aria-hidden /> {saved ? 'Save changes' : 'Save stream'}
          </button>
          {dirty && (
            <button type="button" className="btn ghost sm" onClick={revert}>
              <Undo2 size={12} aria-hidden /> Revert
            </button>
          )}
          {saved && (
            <button type="button" className="btn sm danger" onClick={clear} title="Remove the stream; the camera shows its simulated view again">
              <Link2Off size={12} aria-hidden /> Clear stream
            </button>
          )}
        </div>
      </form>
      <div className="a-cam-preview">
        <div className="a-cam-preview-h">Preview</div>
        <CameraFeed cameraId={cam.id} compact />
      </div>
    </>
  );
}

/** Camera positions, their feed mode (simulated / configured stream) and the stream editor. */
export function CamerasTab() {
  const sources = useApp((s) => s.cameraSources);
  const live = useLiveStatus((s) => s.byCamera);
  const [selected, setSelected] = useState<string>(CAMERAS[0].id);
  const cam = CAMERA_BY_ID[selected] ?? CAMERAS[0];
  const configured = CAMERAS.filter((c) => sources[c.id]).length;
  const hls = browserEnv().canPlayHls;

  const columns: Column<CameraDef>[] = [
    {
      key: 'cam',
      header: 'Camera',
      render: (c) => (
        <>
          <span className="mono">{c.id}</span>
          <span className="sub">{c.name}</span>
        </>
      ),
      sort: (c) => c.id,
    },
    {
      key: 'zone',
      header: 'Zone',
      render: (c) => (
        <span className="a-zone" title={ZONE_BY_ID[c.zone]?.name}>
          <span className="chip" style={{ background: ZONE_BY_ID[c.zone]?.color }}>
            {c.zone}
          </span>
          {ZONE_BY_ID[c.zone]?.short}
        </span>
      ),
      sort: (c) => c.zone,
    },
    { key: 'stage', header: 'Stage', render: (c) => cameraStageName(c.stage) ?? <span className="muted">—</span>, sort: (c) => c.stage ?? '' },
    {
      key: 'covers',
      header: 'Covers',
      title: 'Equipment and geofences in the field of view (events on them get this camera as evidence)',
      render: (c) => (
        <span className="mono dim" title={c.covers.join(', ')}>
          {c.covers.slice(0, 3).join(', ')}
          {c.covers.length > 3 && <span className="sub">+{c.covers.length - 3}</span>}
        </span>
      ),
      sort: (c) => c.covers.length,
    },
    {
      key: 'mode',
      header: 'Mode',
      render: (c) => {
        const s = sources[c.id];
        return s ? (
          <span title={s.url.split('?')[0]}>
            Stream · {s.kind === 'auto' ? 'auto' : RESOLVED_LABEL[s.kind]}
            <span className="sub">{urlSummary(s.url)}</span>
          </span>
        ) : (
          <span className="tag sim">Simulated</span>
        );
      },
      sort: (c) => (sources[c.id] ? 0 : 1),
    },
    { key: 'live', header: 'Feed status', render: (c) => <LiveCell source={sources[c.id]} report={live[c.id]} /> },
  ];

  return (
    <>
      <div className="col-8 a-stack">
        <Panel
          title="Camera sources"
          subtitle={`${CAMERAS.length} camera positions · ${configured ? `${configured} with a configured stream` : 'no stream configured'} · select a row to edit and preview`}
          flush
          footer="Every camera without a stream shows its simulated view, rendered from the digital twin and labelled as such. Stream URLs are stored only in this browser."
        >
          <DataTable columns={columns} rows={CAMERAS} rowKey={(c) => c.id} onRowClick={(c) => setSelected(c.id)} selectedKey={cam.id} maxHeight="none" />
        </Panel>
        <Panel title="Connecting real cameras" subtitle="What a browser can and cannot play">
          <ul className="a-list">
            <li>
              <b>Nothing is configured by default.</b> No camera is connected in this release; all views are simulated.
            </li>
            <li>
              <b>Browsers cannot open RTSP directly.</b> RTSP / ONVIF (and RTMP) cameras need a gateway — for example a media server or the VMS's web
              gateway — that restreams each camera as HLS (.m3u8), MJPEG or MP4 / WebM over http(s). WebRTC needs the gateway's own player and is not built in.
            </li>
            <li>
              <b>HLS</b> plays where the browser supports it natively{hls ? ' (this browser does)' : ' — this browser does not; use MJPEG or MP4 / WebM from the gateway'}.
            </li>
            <li>
              <b>Allow CORS for snapshots.</b> To capture frames (snapshots, event evidence), the gateway must send Access-Control-Allow-Origin for this page.
              Without it the stream still plays, but frames cannot be read — event evidence then falls back to the labelled twin render.
            </li>
            <li>
              <b>"Live" means playing.</b> A configured stream shows Live only after the browser actually plays it; otherwise Connecting, Connection error,
              Stale (no new frame for more than 10 s) or Unavailable.
            </li>
            <li>
              <b>Stored in this browser only.</b> URLs are kept in this browser's local storage, not shared with other users or devices. Avoid credentials in
              URLs.
            </li>
          </ul>
        </Panel>
      </div>
      <div className="col-4">
        <Panel
          title={
            <>
              <span className="mono">{cam.id}</span> · {cam.name}
            </>
          }
          subtitle={cam.purpose}
        >
          <dl className="dl a-cam-dl">
            <dt>Zone</dt>
            <dd>
              {cam.zone} · {ZONE_BY_ID[cam.zone]?.name}
            </dd>
            <dt>Stage</dt>
            <dd>{cameraStageName(cam.stage) ?? '—'}</dd>
            <dt>Covers</dt>
            <dd className="mono a-cam-covers">{cam.covers.join(', ')}</dd>
            <dt>Mode</dt>
            <dd>{sources[cam.id] ? 'Configured stream' : 'Simulated view (digital twin)'}</dd>
          </dl>
          <SourceEditor key={cam.id} cam={cam} />
          <p className="a-cam-note">
            <Info size={12} aria-hidden /> Snapshots taken in a feed open in a viewer with download; event evidence is captured automatically when an event
            is detected.
          </p>
        </Panel>
      </div>
    </>
  );
}
