/**
 * Acknowledgement & resolution of one event record: lifecycle controls (through the shared store,
 * so every view updates from the same record) and the live history.
 */
import { useEffect, useState } from 'react';
import { CheckCheck, CircleCheck, CircleX, Eye, NotebookPen, Search, UserRound } from 'lucide-react';
import type { EventReport } from '../../intel/report';
import type { OpEvent } from '../../model/types';
import { HISTORY_LABEL, plantTime, wallClock } from '../../report/format';
import { canResolve, type LifecycleResult } from '../../sim/events';
import { useSim } from '../../sim/store';
import { EventStatusBadge } from '../kit/Status';
import { KV, Sub } from './parts';

type Feedback = { ok: boolean; text: string } | null;

function Controls({ ev }: { ev: OpEvent }) {
  const [owner, setOwner] = useState(ev.owner ?? '');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [action, setAction] = useState('');
  const [fb, setFb] = useState<Feedback>(null);
  useEffect(() => setOwner(ev.owner ?? ''), [ev.owner]);

  const run = (done: string, fn: () => LifecycleResult, after?: () => void) => {
    const r = fn();
    setFb(r.ok ? { ok: true, text: done } : { ok: false, text: r.reason });
    if (r.ok) after?.();
  };
  const S = useSim.getState;
  const resolvable = canResolve(ev);
  const closed = ev.status === 'resolved';

  return (
    <div className="rp-life">
      <div className="rp-life-row">
        <button className="btn sm" disabled={ev.status !== 'active'} onClick={() => run(`${ev.id} acknowledged`, () => S().acknowledge(ev.id))} title={ev.status !== 'active' ? 'Only an active (unacknowledged) event can be acknowledged' : 'Confirm the event has been seen'}>
          <Eye size={13} aria-hidden /> Acknowledge
        </button>
        <button
          className="btn sm"
          disabled={closed || ev.status === 'investigating'}
          onClick={() => run(`Investigation started on ${ev.id}`, () => S().investigate(ev.id))}
          title={closed ? 'The event is resolved' : ev.status === 'investigating' ? 'Already under investigation' : 'Acknowledge (if needed) and start the investigation'}
        >
          <Search size={13} aria-hidden /> Start investigation
        </button>
      </div>

      <form
        className="rp-life-row"
        onSubmit={(e) => {
          e.preventDefault();
          run(`Owner set to ${owner.trim()}`, () => S().assign(ev.id, owner));
        }}
      >
        <label className="field rp-grow">
          Owner
          <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Name or team" maxLength={60} />
        </label>
        <button className="btn sm" type="submit" disabled={!owner.trim() || owner.trim() === ev.owner}>
          <UserRound size={13} aria-hidden /> Assign owner
        </button>
      </form>

      <form
        className="rp-life-row"
        onSubmit={(e) => {
          e.preventDefault();
          run('Note added', () => S().note(ev.id, note), () => setNote(''));
        }}
      >
        <label className="field rp-grow">
          Note
          <textarea className="input rp-textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observation, check done, next step…" rows={2} maxLength={500} />
        </label>
        <button className="btn sm" type="submit" disabled={!note.trim()}>
          <NotebookPen size={13} aria-hidden /> Add note
        </button>
      </form>

      <form
        className="rp-life-res"
        onSubmit={(e) => {
          e.preventDefault();
          run(`${ev.id} resolved`, () => S().resolve(ev.id, reason, action), () => {
            setReason('');
            setAction('');
          });
        }}
      >
        <div className="rp-life-row">
          <label className="field rp-grow">
            Resolution reason
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What was found" maxLength={160} disabled={!resolvable.ok} />
          </label>
          <label className="field rp-grow">
            Action taken <span className="muted">(optional)</span>
            <input className="input" value={action} onChange={(e) => setAction(e.target.value)} placeholder="Repair, adjustment, instruction…" maxLength={160} disabled={!resolvable.ok} />
          </label>
          <button className="btn sm primary" type="submit" disabled={!resolvable.ok || !reason.trim()} title={resolvable.ok ? 'Close the event with this resolution' : resolvable.reason}>
            <CheckCheck size={13} aria-hidden /> Resolve
          </button>
        </div>
        {!resolvable.ok && <p className="rp-hint">{resolvable.reason}.</p>}
      </form>

      {fb && (
        <p className={`rp-fb ${fb.ok ? 'ok' : 'err'}`} role="status">
          {fb.ok ? <CircleCheck size={13} aria-hidden /> : <CircleX size={13} aria-hidden />} {fb.text}
        </p>
      )}
    </div>
  );
}

export function Lifecycle({ r, readOnly = false }: { r: EventReport; readOnly?: boolean }) {
  const R = r.resolution;
  const ev = r.event;
  return (
    <>
      <KV
        rows={[
          ['Status', <EventStatusBadge key="s" status={ev.status} />],
          ['Owner', R.owner ?? <span className="muted">Unassigned</span>],
          [
            'Resolution',
            R.resolution ? (
              <>
                {R.resolution.by === 'user' ? 'Resolved by user' : 'Resolved by the system'} at {plantTime(R.resolution.t)}: {R.resolution.reason}
              </>
            ) : (
              <span className="muted">Not resolved</span>
            ),
          ],
          ['Action taken', R.resolution?.action ?? <span className="muted">—</span>],
        ]}
      />
      {!readOnly && <Controls key={ev.id} ev={ev} />}
      <Sub>Notes</Sub>
      {R.notes.length ? (
        <ul className="rp-notes">
          {R.notes.map((n, i) => (
            <li key={i}>
              <span className="num muted">{plantTime(n.t)}</span> <b>{n.by}</b> {n.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No notes</p>
      )}
      <Sub>History</Sub>
      <ol className="rp-hist">
        {R.history.map((h, i) => (
          <li key={i} className={h.by}>
            <span className="num rp-hist-t">{plantTime(h.t)}</span>
            <span className="rp-hist-a">{HISTORY_LABEL[h.action]}</span>
            <span className="rp-hist-by muted">{h.by === 'user' ? 'User' : 'System'}</span>
            <span className="rp-hist-x">{h.text}</span>
          </li>
        ))}
      </ol>
      {R.reports.length > 0 && (
        <>
          <Sub>Reports exported</Sub>
          <ul className="rp-notes">
            {R.reports.map((x, i) => (
              <li key={i}>
                <span className="num muted">{plantTime(x.t)}</span> {x.format.toUpperCase()} · {wallClock(x.at)} (wall clock)
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
