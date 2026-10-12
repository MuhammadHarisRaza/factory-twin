/**
 * Delay review: the trucks past a waiting, dock or turnaround limit (`delayedTrucks`, the same list
 * the "Waiting or delayed" KPI reads) with their reason and minutes against the limit, the trucks
 * waiting for a dock within the limit, and — kept apart — visit records that look incomplete
 * (no gate-out far beyond the turnaround limit), which are flagged for checking instead of being
 * presented as a real stay.
 */
import { CircleCheck, Clock3, FileQuestion, TriangleAlert } from 'lucide-react';
import type { EventRules } from '../../model/types';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { EmptyState, ProvenanceBadge, Section } from '../../ui/kit/Page';
import { SeverityBadge } from '../../ui/kit/Status';
import { IntegrityBadge, dur, type Clock } from './common';
import type { DelayReview as Review, DelayRow, WatchRow } from './movement';

/** Bar scale: the limit sits at the middle, twice the limit fills the bar. */
const fill = (minutes: number, limit: number) => `${Math.min(100, (minutes / Math.max(1, 2 * limit)) * 100).toFixed(1)}%`;

export function DelayReview({
  review,
  rules,
  selected,
  onSelect,
  clock,
}: {
  review: Review;
  rules: Pick<EventRules, 'truckWaitMax' | 'dockStayMax' | 'turnaroundMax'>;
  selected: string | null;
  onSelect: (id: string) => void;
  clock: Clock;
}) {
  const { delayed, watch, incomplete } = review;
  const none = !delayed.length && !watch.length;
  return (
    <Section
      id="fl-delays"
      title="Delay review"
      subtitle={`What is delaying movement now · limits from the event rules: waiting ${rules.truckWaitMax} min · at the dock ${rules.dockStayMax} min · on site ${rules.turnaroundMax} min`}
      actions={
        <>
          <span className="fl-count-note">
            {delayed.length} past a limit · {watch.length} waiting within the limit
          </span>
          <ProvenanceBadge kind="simulated" />
        </>
      }
      flush
    >
      {none ? (
        <EmptyState icon={CircleCheck} title="No truck waiting or past a limit">
          Every truck on site is within the waiting, dock and turnaround limits, and none is queuing for a dock.
        </EmptyState>
      ) : (
        <ul className="fl-delays" aria-label="Trucks past a limit or waiting for a dock">
          {delayed.map((r) => (
            <DelayItem key={r.id} r={r} sel={selected === r.id} onSelect={onSelect} />
          ))}
          {watch.map((w) => (
            <WatchItem key={w.id} w={w} sel={selected === w.id} onSelect={onSelect} />
          ))}
        </ul>
      )}
      {incomplete.length > 0 && (
        <div className="fl-incomplete">
          <h4>
            <FileQuestion size={13} aria-hidden /> Visit records to check · {incomplete.length}
          </h4>
          <ul>
            {incomplete.map((r) => (
              <li key={r.id}>
                <button type="button" className={`fl-delay ${selected === r.id ? 'sel' : ''}`} aria-pressed={selected === r.id} onClick={() => onSelect(r.id)}>
                  <span className="fl-delay-ic neutral">
                    <FileQuestion size={15} aria-hidden />
                  </span>
                  <span className="fl-delay-main">
                    <span className="fl-delay-l1">
                      <b className="mono">{r.id}</b>
                      <IntegrityBadge integrity={r.integrity} />
                    </span>
                    <span className="fl-delay-l2">
                      Gate-in recorded {clock(r.v.visit!.gateIn)} · no gate-out recorded · {r.where}
                    </span>
                    {r.integrity.note && <span className="fl-delay-note">{r.integrity.note}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function DelayItem({ r, sel, onSelect }: { r: DelayRow; sel: boolean; onSelect: (id: string) => void }) {
  const tone = r.event ? (r.event.severity === 'critical' ? 'critical' : r.event.severity === 'serious' ? 'serious' : 'warning') : 'warning';
  return (
    <li>
      <button type="button" className={`fl-delay ${sel ? 'sel' : ''}`} aria-pressed={sel} onClick={() => onSelect(r.id)}>
        <span className={`fl-delay-ic ${tone}`}>
          <TriangleAlert size={15} aria-hidden />
        </span>
        <span className="fl-delay-main">
          <span className="fl-delay-l1">
            <b className="mono">{r.id}</b>
            <span className="fl-delay-reason">{r.reason}</span>
            <IntegrityBadge integrity={r.integrity} />
          </span>
          <span className="fl-delay-l2">{[r.where, r.reason === 'Waiting for a dock' && r.status.startsWith('Waiting') ? null : r.status, r.v.operator].filter(Boolean).join(' · ')}</span>
          {r.event && (
            <span className="fl-delay-ev">
              <SeverityBadge severity={r.event.severity} />
              <span className="dim">
                {EVENT_TYPE_LABEL[r.event.type]} · <span className="mono">{r.event.id}</span>
              </span>
            </span>
          )}
        </span>
        <span className="fl-delay-m">
          <span className="fl-delay-v">
            <b className="num">{dur(r.minutes)}</b>
            <span>limit {r.limit} min</span>
          </span>
          <span className="fl-meter over" aria-hidden>
            <i style={{ width: fill(r.minutes, r.limit) }} />
            <em />
          </span>
          <span className="fl-delay-over">+{dur(r.over)} over the limit</span>
        </span>
      </button>
    </li>
  );
}

function WatchItem({ w, sel, onSelect }: { w: WatchRow; sel: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={`fl-delay watch ${sel ? 'sel' : ''}`} aria-pressed={sel} onClick={() => onSelect(w.id)}>
        <span className="fl-delay-ic neutral">
          <Clock3 size={15} aria-hidden />
        </span>
        <span className="fl-delay-main">
          <span className="fl-delay-l1">
            <b className="mono">{w.id}</b>
            <span className="fl-delay-reason">Waiting for a dock{w.queuePos != null ? ` · #${w.queuePos} in queue` : ''}</span>
          </span>
          <span className="fl-delay-l2">
            {w.where} · {w.v.operator}
          </span>
        </span>
        <span className="fl-delay-m">
          <span className="fl-delay-v">
            <b className="num">{dur(w.minutes)}</b>
            <span>limit {w.limit} min</span>
          </span>
          <span className="fl-meter" aria-hidden>
            <i style={{ width: fill(w.minutes, w.limit) }} />
            <em />
          </span>
          <span className="fl-delay-over muted">{dur(Math.max(0, w.limit - w.minutes))} to the limit</span>
        </span>
      </button>
    </li>
  );
}
