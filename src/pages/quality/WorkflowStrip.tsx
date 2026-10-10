/**
 * Inspection workflow, made explicit for one frame (the selected record, or the frame the vision
 * viewer shows): capture → inference → classify & localise → associate → rule → store →
 * counts & OEE → event. Every value is read from the shared simulation state; inference is
 * simulated (deterministic rules, no vision model).
 */
import type { ReactNode } from 'react';
import {
  BellRing,
  Camera,
  ChevronRight,
  ClipboardList,
  Cpu,
  Database,
  FileText,
  Gauge,
  Link2,
  ListChecks,
  Pin,
  Radio,
  ScanSearch,
  Tags,
} from 'lucide-react';
import type { OpEvent, ProductionBatch, QualityInspection } from '../../model/types';
import { DEFECTS } from '../../model/plant';
import { openEvent } from '../../app/store';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import type { Metric } from '../../sim/oee';
import { formatClock, formatDateTime } from '../../sim/time';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { EventStatusBadge, MetricText } from '../../ui/kit/Status';
import { ResultBadge } from './badges';
import { VISION_NOTE, inspectionMethod, type RuleCheck } from './derive';
import type { Frame } from './frames';
import { PRODUCT_BY_SKU, STATION_BY_ID } from './lookup';
import { boxMm } from './tileGeometry';

export type WorkflowSubject = {
  /** Record behind the frame; null for a sampled pass frame (display sample, not stored). */
  rec: QualityInspection | null;
  frame: Frame | null;
  time: number;
  stationId: string;
  batch: ProductionBatch | null;
  batchId: string;
  pinned: boolean;
  rules: RuleCheck[];
  events: OpEvent[];
};

export type PeriodCounts = { label: string; inspected: number; accepted: number; rejected: number; quality: Metric; oee: Metric };

type Step = { key: string; n: number; title: string; icon: typeof Camera; body: ReactNode; accent?: boolean };

export function WorkflowStrip({ subject, counts, onShowEvent }: { subject: WorkflowSubject | null; counts: PeriodCounts; onShowEvent: (id: string) => void }) {
  if (!subject) {
    return (
      <Panel title="Inspection workflow" subtitle="No inspection frame in the retained history yet">
        <p className="muted q-wf-none">The sorter has not inspected tiles recently.</p>
      </Panel>
    );
  }
  const { rec, frame, rules, events } = subject;
  const st = STATION_BY_ID[subject.stationId];
  const method = inspectionMethod(subject.stationId);
  const reject = rec?.result === 'reject';
  const product = subject.batch ? PRODUCT_BY_SKU[subject.batch.sku] : frame ? PRODUCT_BY_SKU[frame.sku] : undefined;
  const fired = rules.filter((r) => r.over);
  const headline =
    rules.find((r) => r.id === (events[0]?.trigger.ruleId ?? '')) ?? rules.find((r) => r.id === 'Q-COUNT') ?? rules.find((r) => r.id === 'Q-RATE') ?? null;
  const b = rec?.box ? boxMm(rec.box) : null;

  const steps: Step[] = [
    {
      key: 'capture',
      n: 1,
      title: 'Capture',
      icon: Camera,
      body: (
        <>
          <b>{method.kind === 'lab' ? 'Lab sample' : 'Illustrative frame'}</b>
          <span>{st?.name ?? subject.stationId}</span>
          <span className="dim">{formatDateTime(subject.time)}</span>
        </>
      ),
    },
    {
      key: 'inference',
      n: 2,
      title: 'Inference',
      icon: Cpu,
      body: (
        <>
          <b className="mono">{method.source}</b>
          <span className="dim">{method.kind === 'vision' ? 'Simulated inference · deterministic rules, no vision model' : method.note}</span>
        </>
      ),
    },
    {
      key: 'classify',
      n: 3,
      title: 'Classify & localise',
      icon: Tags,
      body: rec?.defect ? (
        method.kind === 'vision' ? (
          <>
            <b>{DEFECTS[rec.defect].label}</b>
            <span>{b ? `Box ${b.w} × ${b.h} mm at ${b.x}, ${b.y} mm` : 'No box'}</span>
            <span className="dim">{rec.confidence != null ? `${fmtPct(rec.confidence, 1)} simulated confidence` : 'No confidence recorded'}</span>
          </>
        ) : (
          <>
            <b>
              {DEFECTS[rec.defect].label} <span className="muted">· measurement</span>
            </b>
            <span>{rec.measurement ?? '—'}</span>
            <span className="dim">Tolerance check — no classification confidence</span>
          </>
        )
      ) : rec ? (
        <>
          <ResultBadge result={rec.result} />
          <span className="dim">{rec.measurement ?? '—'}</span>
        </>
      ) : (
        <>
          <ResultBadge result="pass" />
          <span className="dim">No defect detected · no box</span>
        </>
      ),
    },
    {
      key: 'associate',
      n: 4,
      title: 'Associate',
      icon: Link2,
      body: (
        <>
          <b className="mono">{subject.batchId}</b>
          <span>{product?.name ?? frame?.sku ?? '—'}</span>
          <span className="dim">
            {st?.equipmentId ?? subject.stationId} · {formatClock(subject.time)} · {rec ? `${fmtInt(rec.tiles)} tiles in the record · ` : ''}tile serial not tracked
          </span>
        </>
      ),
    },
    {
      key: 'rule',
      n: 5,
      title: 'Rule',
      icon: ListChecks,
      body: headline ? (
        <>
          <b>
            <span className="mono">{headline.id}</span> {headline.value ?? '—'} <span className="muted">/ {headline.threshold}</span>
          </b>
          <span>{headline.label}</span>
          <span className="dim">{fired.length ? `Met: ${fired.map((r) => r.id).join(', ')}` : `${rules.length} rule${rules.length === 1 ? '' : 's'} checked · none met`}</span>
        </>
      ) : (
        <span className="dim">No quality rule applies</span>
      ),
    },
    {
      key: 'store',
      n: 6,
      title: 'Store',
      icon: Database,
      body: rec ? (
        <>
          <b className="mono">{rec.id}</b>
          <span>Inspection record · shared state</span>
          <span className="dim">{rec.source === 'scenario' ? 'Raised while a scenario ran' : 'Simulated record'}</span>
        </>
      ) : (
        <>
          <b>Not stored individually</b>
          <span className="dim">Passed tiles are counted in the inspection counters; the frame is a display sample</span>
        </>
      ),
    },
    {
      key: 'counts',
      n: 7,
      title: 'Counts & OEE',
      icon: Gauge,
      body: (
        <>
          <b>
            {fmtInt(counts.accepted)} <span className="muted">accepted ·</span> {fmtInt(counts.rejected)} <span className="muted">rejected</span>
          </b>
          <span>
            Quality rate (OEE Q) <MetricText m={counts.quality} digits={1} /> · line OEE <MetricText m={counts.oee} digits={1} />
          </span>
          <span className="dim">{reject ? `This record: ${fmtInt(rec!.tiles)} tiles not good · ${counts.label}` : counts.label}</span>
        </>
      ),
    },
    {
      key: 'event',
      n: 8,
      title: 'Event',
      icon: BellRing,
      accent: events.length > 0,
      body: events.length ? (
        <>
          {events.slice(0, 2).map((e) => (
            <span key={e.id} className="q-wf-ev">
              <button className="row-link mono" onClick={() => onShowEvent(e.id)} title={`Show ${e.id} and its evidence on this page`}>
                {e.id}
              </button>
              <EventStatusBadge status={e.status} />
            </span>
          ))}
          <span className="dim">{EVENT_TYPE_LABEL[events[0].type]}</span>
          <button className="row-link" onClick={() => openEvent(events[0].id)}>
            <FileText size={12} /> Open report
          </button>
        </>
      ) : (
        <>
          <b>No event</b>
          <span className="dim">{rec ? 'Not referenced by a quality event' : 'Pass frames feed the reject-rate rule only'}</span>
        </>
      ),
    },
  ];

  return (
    <Panel
      className="q-wf-panel"
      title="Inspection workflow"
      subtitle={
        <>
          {subject.pinned ? <Pin size={11} aria-hidden /> : <Radio size={11} aria-hidden />}{' '}
          {subject.pinned ? 'Pinned' : 'Following the latest frame'} · {rec ? <span className="mono">{rec.id}</span> : 'sampled pass frame'} · {st?.name ?? subject.stationId}
        </>
      }
      actions={
        <span className="tag sim" title="Classes, boxes and confidences are simulated outputs of deterministic rules">
          <ScanSearch size={11} aria-hidden /> Simulated inference
        </span>
      }
      footer={
        <span>
          <ClipboardList size={12} aria-hidden className="q-wf-foot-icon" /> {VISION_NOTE} Rule thresholds are the detection thresholds currently in force — the
          same ones the event engine uses; a rule fires only when its window is complete.
        </span>
      }
      flush
    >
      <ol className="q-wf" aria-label="Inspection workflow steps">
        {steps.map((x, i) => (
          <li key={x.key} className={`q-wf-step ${x.accent ? 'accent' : ''}`}>
            <div className="q-wf-h">
              <span className="q-wf-n num">{x.n}</span>
              <x.icon size={13} aria-hidden />
              <span>{x.title}</span>
              {i < steps.length - 1 && <ChevronRight size={14} aria-hidden className="q-wf-arrow" />}
            </div>
            <div className="q-wf-b">{x.body}</div>
          </li>
        ))}
      </ol>
      {rules.length > 0 && (
        <div className="q-wf-rules" aria-label="Rules evaluated at this frame">
          <span className="q-wf-rules-k">Rules at {rec ? 'this record' : 'this minute'}</span>
          {rules.map((r) => (
            <span key={r.id} className={`q-wf-rule ${r.over ? 'over' : ''}`} title={r.note ?? undefined}>
              <span className="mono">{r.id}</span> {r.label}: <b className="num">{r.value ?? '—'}</b> <span className="muted">({r.threshold})</span>
              {r.over && <span className="q-wf-met">met</span>}
              {r.value == null && r.note && <span className="muted"> · {r.note}</span>}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}
