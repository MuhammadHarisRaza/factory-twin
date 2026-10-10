/**
 * Visual and supporting evidence of an event report — the evidence records frozen with the event
 * (src/sim/events.ts), shown with their provenance. Missing evidence is explained, never blank.
 */
import { useEffect, useState } from 'react';
import { openEvent } from '../../app/store';
import { cameraName, type EventReport, type ReportEvidence } from '../../intel/report';
import { DEFECTS } from '../../model/plant';
import type { EvidenceSeries, QualityInspection } from '../../model/types';
import { EVIDENCE_KIND_LABEL, LABELS, axisFormat, fmtValue, plantClock, plantTime } from '../../report/format';
import { inspectionImage } from '../../report/frames';
import { snapshotImage } from '../../report/images';
import { INSPECTION_GONE, missingReason } from '../../report/model';
import { LineChart, type LineSeries } from '../kit/charts';
import { Prov, Sub, Unavailable } from './parts';

// ── Visual evidence ───────────────────────────────────────────────────────────

function Snapshot({ x }: { x: ReportEvidence }) {
  const img = snapshotImage(x);
  const live = x.provenance.origin === 'live-camera';
  return (
    <figure className="rp-fig rp-snap">
      <figcaption className="rp-fig-t">{x.title}</figcaption>
      {img ? (
        <img src={img.dataUrl} width={img.width} height={img.height} alt={`${live ? 'Camera frame' : 'Digital-twin render'} of ${x.cameraId ? cameraName(x.cameraId) : 'the asset'} at ${plantClock(x.image?.frameTime ?? x.capturedAt)}`} />
      ) : x.status === 'pending' ? (
        <Unavailable pending reason="Capturing… rendering the digital-twin view of this camera position" />
      ) : (
        <Unavailable reason={missingReason(x, false) ?? 'Unavailable'} />
      )}
      <div className="rp-cap">
        <span className={live ? 'rp-cap-live' : 'rp-cap-sim'}>{live ? `Camera frame · ${x.provenance.label}` : LABELS.simulatedFeed}</span>
        <span>
          Frame time {plantTime(x.image?.frameTime ?? x.capturedAt)} · {x.originLabel}
          {x.cameraId ? ` · ${x.cameraId} ${cameraName(x.cameraId)}` : ''}
        </span>
      </div>
    </figure>
  );
}

function useInspectionImage(rec: QualityInspection | null, enabled: boolean) {
  const key = rec && enabled ? `${rec.id}|${rec.time}` : '';
  const [state, setState] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!key || !rec) return;
    let alive = true;
    inspectionImage(rec, 320).then((url) => {
      if (alive) setState({ key, url });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return { status: 'none' as const, url: null };
  if (state?.key !== key) return { status: 'loading' as const, url: null };
  return { status: state.url ? ('ready' as const) : ('failed' as const), url: state.url };
}

function InspectionFrame({ x, rec }: { x: ReportEvidence; rec: QualityInspection | null }) {
  const available = x.status === 'available' && !!rec;
  const img = useInspectionImage(rec, available);
  return (
    <figure className="rp-fig rp-frame">
      <figcaption className="rp-fig-t">{x.title}</figcaption>
      {available ? (
        img.status === 'ready' ? (
          <img src={img.url!} width={320} height={320} alt={`Illustrative frame of inspection record ${rec!.id}, annotated`} />
        ) : img.status === 'loading' ? (
          <Unavailable pending reason="Drawing the illustrative frame…" />
        ) : (
          <Unavailable reason="The illustrative frame could not be drawn" />
        )
      ) : (
        <Unavailable reason={x.status === 'available' ? INSPECTION_GONE : (missingReason(x, false) ?? 'Unavailable')} />
      )}
      <div className="rp-cap">
        {rec && (
          <span>
            {rec.defect ? DEFECTS[rec.defect].label : 'No defect'}
            {rec.severity ? ` · ${rec.severity}` : ''}
            {rec.confidence != null ? ` · ${Math.round(rec.confidence * 100)} % ${LABELS.simulatedConfidence}` : ''}
          </span>
        )}
        {rec?.measurement && <span>{rec.measurement}</span>}
        {rec && (
          <span>
            {rec.stationId} · batch {rec.batchId} · {plantClock(rec.time)}
          </span>
        )}
        <span className="rp-cap-sim">{x.status === 'available' ? LABELS.illustrativeFrame : x.provenance.label}</span>
      </div>
    </figure>
  );
}

export function VisualEvidence({ r, records }: { r: EventReport; records: Record<string, QualityInspection> }) {
  const snaps = r.visualEvidence.filter((x) => x.kind === 'camera-snapshot');
  const frames = r.visualEvidence.filter((x) => x.kind === 'inspection-image');
  const videos = r.visualEvidence.filter((x) => x.kind === 'video-ref');
  const noVideo = r.provenance.unavailable.find((u) => u.title === 'Video segment');
  return (
    <div className="rp-visual">
      {!snaps.length && !frames.length && <p className="muted">No camera or inspection evidence applies to this event.</p>}
      {snaps.length > 0 && (
        <div className="rp-snaps">
          {snaps.map((x) => (
            <Snapshot key={x.id} x={x} />
          ))}
        </div>
      )}
      {frames.length > 0 && (
        <>
          <Sub>Inspection frames</Sub>
          <div className="rp-frames">
            {frames.map((x) => (
              <InspectionFrame key={x.id} x={x} rec={x.inspectionId ? (records[x.inspectionId] ?? null) : null} />
            ))}
          </div>
        </>
      )}
      {videos.map((x) => (
        <Unavailable key={x.id} title={x.title} reason={missingReason(x, false) ?? 'No video recording'} />
      ))}
      {noVideo && <Unavailable title="Video segment" reason={noVideo.reason} />}
    </div>
  );
}

// ── Supporting signals & measurements ────────────────────────────────────────

export function SeriesChart({ sr, compact }: { sr: EvidenceSeries; compact?: boolean }) {
  const labels = sr.t.map((m) => plantClock(m));
  const values = [...sr.v, ...(sr.expected ?? []), sr.limit?.value ?? null].filter((v): v is number => v != null);
  const fmt = axisFormat(values.length ? Math.max(...values.map(Math.abs)) : 1);
  const series: LineSeries[] = [{ id: 'v', label: sr.label, color: 'var(--series-1)', points: sr.v }];
  if (sr.expected?.some((v) => v != null)) series.push({ id: 'e', label: 'Expected', color: 'var(--text-2)', points: sr.expected, dashed: true });
  const hasData = sr.v.some((v) => v != null);
  return (
    <div className="rp-chart">
      <div className="rp-chart-t">
        {sr.label} <span className="muted">({sr.unit})</span>
      </div>
      {hasData ? (
        <LineChart
          labels={labels}
          series={series}
          height={compact ? 120 : 140}
          format={fmt}
          tickEvery={Math.max(1, Math.ceil(labels.length / (compact ? 4 : 6)))}
          reference={sr.limit ? { value: sr.limit.value, label: `${sr.limit.label} ${fmt(sr.limit.value)} ${sr.unit}` } : undefined}
        />
      ) : (
        <Unavailable reason="No samples in the captured window — chart omitted" />
      )}
    </div>
  );
}

function EvidenceBody({ x, compact }: { x: ReportEvidence; compact?: boolean }) {
  if (x.status !== 'available') return <Unavailable reason={x.status === 'pending' ? 'Being captured' : (x.unavailableReason ?? 'Unavailable')} />;
  switch (x.kind) {
    case 'signal-series':
    case 'counter-series':
      return (
        <div className={`rp-charts ${compact || (x.series?.length ?? 0) < 2 ? 'one' : ''}`}>
          {(x.series ?? []).map((sr) => (
            <SeriesChart key={sr.id} sr={sr} compact={compact} />
          ))}
        </div>
      );
    case 'state-transition':
      return (
        <table className="rp-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>From</th>
              <th>To</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {(x.transitions ?? []).map((t, i) => (
              <tr key={i}>
                <td className="num">{plantClock(t.t)}</td>
                <td>{t.from}</td>
                <td>{t.to}</td>
                <td className="muted">{t.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'vehicle-timeline':
      return (
        <ol className="rp-steps">
          {(x.milestones ?? []).map((m, i) => (
            <li key={i} className={m.t == null ? 'todo' : 'done'}>
              <span className="rp-step-l">{m.label}</span>
              <span className="rp-step-t num">{m.t == null ? 'Not reached' : plantTime(m.t)}</span>
              {m.note && <span className="rp-step-n muted">{m.note}</span>}
            </li>
          ))}
        </ol>
      );
    case 'metrics':
      return (
        <dl className="rp-kv c2">
          {(x.metrics ?? []).map((m, i) => (
            <div key={i}>
              <dt>{m.label}</dt>
              <dd className="num">{fmtValue(m)}</dd>
            </div>
          ))}
        </dl>
      );
    case 'related-events':
      return (
        <p className="rp-links">
          {(x.eventIds ?? []).length
            ? x.eventIds!.map((id) => (
                <button key={id} className="row-link mono" onClick={() => openEvent(id)}>
                  {id}
                </button>
              ))
            : 'None'}
        </p>
      );
    default:
      return null;
  }
}

export function SupportingEvidence({ items, compact }: { items: ReportEvidence[]; compact?: boolean }) {
  if (!items.length) return <p className="muted">No further signal or measurement evidence was captured for this event.</p>;
  return (
    <div className="rp-evds">
      {items.map((x) => (
        <div key={x.id} className="rp-evd">
          <div className="rp-evd-h">
            <b>{x.title}</b>
            <span className="tag">{EVIDENCE_KIND_LABEL[x.kind]}</span>
          </div>
          <Prov>
            {x.originLabel} — {x.provenance.label} · captured {plantTime(x.capturedAt)}
            {x.kind === 'vehicle-timeline' ? ` · ${LABELS.position}` : ''}
          </Prov>
          <EvidenceBody x={x} compact={compact} />
        </div>
      ))}
    </div>
  );
}
