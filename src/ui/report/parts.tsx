/**
 * Building blocks of the in-app event report (src/ui/report/EventReportView.tsx).
 */
import { useState, type ReactNode } from 'react';
import { CircleCheck, CircleDot, CircleSlash, FileDown, LoaderCircle } from 'lucide-react';
import type { EventCause, OpEvent } from '../../model/types';
import { CONFIDENCE_HINT, CONFIDENCE_LABEL } from '../../report/format';
import { exportEventPdf } from '../../report/pdf';
import { focusEventInTwin } from '../../scene/events/focus';
import { formatClock } from '../../sim/time';

/** Numbered report section (same numbering and titles as the PDF). */
export function Sec({ n, title, tag, children, id }: { n: number; title: string; tag?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="rp-sec" id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <header className="rp-sec-h">
        <span className="rp-n num">{n}</span>
        <h3 id={id ? `${id}-h` : undefined}>{title}</h3>
        {tag && <span className="rp-sec-tag">{tag}</span>}
      </header>
      <div className="rp-sec-b">{children}</div>
    </section>
  );
}

/** Label / value grid. */
export function KV({ rows, cols = 2 }: { rows: [ReactNode, ReactNode][]; cols?: 2 | 3 }) {
  return (
    <dl className={`rp-kv c${cols}`}>
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Explicit "not available — reason" box (never a blank). */
export function Unavailable({ title, reason, pending = false }: { title?: string; reason: string; pending?: boolean }) {
  return (
    <div className={`rp-na ${pending ? 'pending' : ''}`} role="note">
      {pending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <CircleSlash size={14} aria-hidden />}
      <div>
        {title && <b>{title}</b>}
        <span>{pending ? reason : `Not available — ${reason}`}</span>
      </div>
    </div>
  );
}

export const Sub = ({ children }: { children: ReactNode }) => <h4 className="rp-sub">{children}</h4>;
export const Prov = ({ children }: { children: ReactNode }) => <p className="rp-prov">{children}</p>;

export function ConfidenceTag({ c }: { c: EventCause['confidence'] }) {
  return (
    <span className={`tag rp-conf ${c}`} title={CONFIDENCE_HINT[c]}>
      {CONFIDENCE_LABEL[c]}
    </span>
  );
}

export function ConditionBadge({ ev }: { ev: OpEvent }) {
  return ev.end == null ? (
    <span className="status warning">
      <CircleDot size={13} strokeWidth={2.2} aria-hidden />
      Condition active
    </span>
  ) : (
    <span className="status good">
      <CircleCheck size={13} strokeWidth={2.2} aria-hidden />
      Condition cleared {formatClock(ev.end)}
    </span>
  );
}

/** Downloads the PDF built from this same report model; shows progress, the saved file or the failure. */
export function PdfButton({ eventId, className = 'btn sm' }: { eventId: string; className?: string }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: string | null }>({ busy: false, error: null, saved: null });
  return (
    <span className="rp-pdf">
      <button
        className={className}
        disabled={state.busy}
        onClick={() => {
          setState({ busy: true, error: null, saved: null });
          exportEventPdf(eventId)
            .then((saved) => setState({ busy: false, error: null, saved }))
            .catch((e: unknown) => setState({ busy: false, error: e instanceof Error ? e.message : 'The PDF could not be created', saved: null }));
        }}
        title="A4 PDF of this report — the same record, evidence and estimate as shown here"
      >
        {state.busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : <FileDown size={13} aria-hidden />}
        {state.busy ? 'Preparing PDF…' : 'Download PDF'}
      </button>
      {state.error && (
        <span className="rp-err" role="alert">
          {state.error}
        </span>
      )}
      {state.saved && (
        <span className="rp-saved" role="status">
          Saved {state.saved}
        </span>
      )}
    </span>
  );
}

/** "Show in 3D": opens the Factory Twin on the event's asset / vehicle / area and marks the event there. */
export const showEventInTwin = (ev: OpEvent) => focusEventInTwin(ev);
