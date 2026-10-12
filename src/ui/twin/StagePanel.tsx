/**
 * Contextual panel of a production stage highlighted in the model (useTwin.stage — set from the
 * line strip, the Overview flow strip or Production): its state, reference video, counts, the
 * equipment and conveyors that make it up (each opens its equipment workspace), its open events and
 * the way into Production. Esc or Close clears the highlight; the camera stays where it is.
 */
import { useMemo } from 'react';
import { Crosshair, Hourglass, X } from 'lucide-react';
import { openStage } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { CONVEYOR_BY_ID, MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { MonitoredStageId } from '../../model/types';
import { constraintClaim } from '../../intel/summary';
import { eventInMonitoredStage } from '../../sim/events';
import { useSimValue } from '../../sim/store';
import { useTwin } from '../../store';
import { ContextVideo } from '../../video/ContextVideo';
import type { VideoContext } from '../../video/types';
import { stageKpis } from '../equipment/kpis';
import { ContinueIn, KpiTiles } from '../equipment/parts';
import { eventsForSubject, openEventsFor } from '../events/open';
import { ProvenanceBadge } from '../kit/Page';
import { OperationalStatus, StatusBadge } from '../kit/Status';
import { constraintMarker } from './constraint';
import { AssetEventList } from './EventRows';
import { OP_RANK, assetStatus, sortEvents, worstOf } from './derive';
import '../equipment/equipment.css';

export function StagePanel({ id }: { id: MonitoredStageId }) {
  const ms = MONITORED_STAGE_BY_ID[id];
  const select = useTwin((s) => s.select);
  const zone = ZONE_BY_ID[ms.zone];
  const d = useSimValue(
    (s) => {
      const assets = [...ms.equipment, ...ms.conveyors.filter((c) => !ms.equipment.includes(c))].map((a) => ({
        id: a,
        name: EQUIPMENT_BY_ID[a]?.name ?? CONVEYOR_BY_ID[a]?.name ?? a,
        status: s.machines[a] ? assetStatus(s, a) : null,
      }));
      const tracked = assets.flatMap((a) => (a.status ? [a.status] : []));
      // One constraint claim for the badge, the sentence and the rate tile (the Overview's wording).
      const claim = constraintClaim(s);
      const c = constraintMarker(s, claim);
      const events = sortEvents(s.events.filter((e) => e.status !== 'resolved' && !e.consequenceOf && eventInMonitoredStage(ms, e)));
      // The Events list the link opens (the stage filter, all recorded time): its count is the list's.
      const listed = eventsForSubject(s, { stage: id }).length;
      return {
        now: s.minute,
        assets,
        worst: worstOf(tracked)?.op ?? null,
        constraint: c.stage === id ? c : null,
        kpis: stageKpis(s, id, undefined, claim),
        events,
        listed,
      };
    },
    [id],
  );
  const video = useMemo<VideoContext>(() => ({ stage: id }), [id]);
  const clear = () => useTwin.getState().selectStage(null);

  return (
    <aside className="inspector overlay-panel tw-insp eqw" aria-label={`${ms.name} · stage details`}>
      <header className="insp-h">
        <div>
          <div className="insp-zone">
            <span className="chip" style={{ background: zone.color }} aria-hidden>
              {zone.id}
            </span>
            Production stage {ms.step} · highlighted in the model
          </div>
          <h2>{ms.name}</h2>
          <div className="tw-insp-status">
            {d.worst ? <OperationalStatus state={d.worst} /> : <span className="muted">No machine state modelled</span>}
            {d.constraint && <StatusBadge tone={d.constraint.active ? 'warning' : 'neutral'} icon={Hourglass} label={d.constraint.label} size={12} />}
            <ProvenanceBadge kind="simulated" />
          </div>
        </div>
        <button type="button" className="btn ghost sm icon" onClick={clear} title="Clear the stage highlight (Esc)" aria-label="Clear the stage highlight">
          <X size={16} />
        </button>
      </header>
      <div className="tw-insp-b eqw-b">
        <section className="insp-sec eqw-video" aria-label="Reference video">
          <ContextVideo context={video} compact />
        </section>
        <section className="insp-sec" aria-label="Key figures">
          <h3>Key figures · {d.kpis.scope}</h3>
          <KpiTiles set={d.kpis} label={`${ms.name} key figures`} />
          {d.constraint && (
            <p className="tw-fine" title={d.constraint.title}>
              {d.constraint.sentence}
              {d.constraint.active ? ' Every minute lost here is lost line output.' : ''}
            </p>
          )}
        </section>
        <section className="insp-sec" aria-label="Equipment of the stage">
          <h3>Equipment · worst first · click to open</h3>
          <div className="mini-events">
            {[...d.assets]
              .sort((a, b) => (b.status ? OP_RANK[b.status.op] : 0) - (a.status ? OP_RANK[a.status.op] : 0))
              .map((a) => (
                <button key={a.id} type="button" onClick={() => select(a.id)} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }} title={`Open ${a.id}`}>
                  <span className="d">
                    {a.name} <span className="mono muted">{a.id}</span>
                  </span>
                  {a.status ? <OperationalStatus state={a.status.op} /> : <span className="muted">—</span>}
                </button>
              ))}
          </div>
        </section>
        <section className="insp-sec" aria-label="Open events of the stage">
          <h3>Open events · {d.events.length}</h3>
          <AssetEventList events={d.events.slice(0, 3)} now={d.now} empty="No open event in this stage." />
          {d.listed > 0 && (
            <button type="button" className="tw-link tw-more" onClick={() => openEventsFor({ stage: id })} title={`Events & Reports, filtered to ${ms.name} for all recorded time`}>
              All {d.listed} event{d.listed === 1 ? '' : 's'} of this stage in Events &amp; Reports →
            </button>
          )}
        </section>
        <ContinueIn
          links={[
            { key: 'production', label: 'Open in Production', title: `${ms.name}: inputs, outputs, losses and events in Production`, run: () => openStage(id) },
            { key: 'events', label: 'Events & Reports', title: `Every event record of ${ms.name} (all recorded time), each with its report and PDF`, run: () => openEventsFor({ stage: id }) },
          ]}
        />
      </div>
      <footer className="insp-f">
        <button type="button" className="btn sm" onClick={() => useTwin.getState().selectStage(id)} title="Frame the stage’s equipment and conveyors">
          <Crosshair size={13} aria-hidden />
          Frame stage
        </button>
        <button type="button" className="btn sm" onClick={clear} title="Remove the highlight from the model">
          <X size={13} aria-hidden />
          Clear highlight
        </button>
      </footer>
    </aside>
  );
}
