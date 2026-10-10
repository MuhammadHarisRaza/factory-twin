import { ArrowRight } from 'lucide-react';
import { useApp } from '../../app/store';
import { useSimValue } from '../../sim/store';
import { formatDay } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { Panel } from '../../ui/kit/Panel';
import { conditionEvents, linkedStopEvents } from './derive';

const LIMIT = 6;

/**
 * The selected asset's condition-abnormal events — the operational records raised by the
 * condition-monitoring rule (with their signal evidence, lifecycle and report) — and the stop
 * events they are linked to (e.g. the breakdown a developing fault ended in).
 */
export function ConditionEvents({ id }: { id: string }) {
  const go = useApp((s) => s.go);
  const d = useSimValue((s) => {
    const cond = conditionEvents(s, id);
    return { cond, open: cond.filter((e) => e.status !== 'resolved').length, linked: linkedStopEvents(s, cond) };
  }, [id]);
  return (
    <Panel
      className="col-12"
      title="Condition events"
      subtitle={`${id} · ${d.cond.length} condition-abnormal ${d.cond.length === 1 ? 'event' : 'events'} since ${formatDay(0)} · ${d.open} open · rule-based on simulated signals`}
      actions={
        <button type="button" className="btn ghost sm" onClick={() => go('events')} title="Open Events & Reports">
          Events &amp; Reports
          <ArrowRight size={12} aria-hidden />
        </button>
      }
      footer={<span>Each event opens its report: the vibration / temperature series frozen at detection, the assessment, suspected causes (hypotheses) and the recommended action.</span>}
    >
      <EventList events={d.cond} limit={LIMIT} hideAsset empty={`No abnormal condition has been detected on ${id}`} />
      {d.linked.length > 0 && (
        <section className="mh-sec">
          <h3>Linked stop events</h3>
          <EventList events={d.linked} limit={3} hideAsset empty="" />
        </section>
      )}
    </Panel>
  );
}
