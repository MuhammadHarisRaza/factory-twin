/**
 * Equipment workspace — the contextual panel of the Factory Twin when an equipment item is selected
 * in the model (master prompt §7). Hierarchy: name + stage + operating status + SIMULATED, then the
 * reference video, 3–5 equipment-specific KPIs, the current condition, the newest events, the impact
 * (only when the data supports one), the recommended next steps, links to the workflows, and the
 * technical details collapsed. Switching equipment updates the panel in place; Close or Esc
 * deselects (Esc is handled by the twin's keyboard shortcuts, in order camera → vehicle → asset).
 */
import { useEffect, useMemo, useRef } from 'react';
import { Crosshair, Hourglass, MessageSquareText, Video, X } from 'lucide-react';
import { openEvent, openStage, useApp } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { CAMERA_BY_ID, MONITORED_STAGE_BY_ID } from '../../model/plant';
import { eventImpact } from '../../intel/report';
import { recommendationsFor } from '../../intel/insights';
import { assess } from '../../sim/health';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { ContextVideo } from '../../video/ContextVideo';
import type { VideoContext } from '../../video/types';
import { ProvenanceBadge } from '../kit/Page';
import { OperationalStatus, StatusBadge, MACHINE_STATE } from '../kit/Status';
import { fmtInt, fmtPct } from '../kit/format';
import { AssetEventList } from '../twin/EventRows';
import { assetStatus, selectionCamera } from '../twin/derive';
import { useTwinUi, type WorkspaceSection } from '../twin/uiStore';
import { ConditionSection } from './Condition';
import { activeRootEvents, constraintRole, nextSteps, recentEvents } from './context';
import { equipmentKpis } from './kpis';
import { eventsForSubject, openEventsFor } from '../events/open';
import { ContinueIn, KpiTiles, NextSteps, goTo, type FlowLink } from './parts';
import { assetProfile, type AssetProfile } from './profile';
import { TechnicalDetails } from './TechnicalDetails';
import './equipment.css';

/** Workflow links of an asset: its production stage, quality for sorting / inspection, fleet for logistics, events. */
export function flowLinks(prof: AssetProfile): FlowLink[] {
  const out: FlowLink[] = [];
  if (prof.monitored) {
    const name = MONITORED_STAGE_BY_ID[prof.monitored].name;
    const stage = prof.monitored;
    out.push({ key: 'production', label: 'Open in Production', title: `${name}: inputs, outputs, losses and events in Production`, run: () => openStage(stage) });
  }
  if (prof.kind === 'station' || prof.stage === 'SORT') out.push({ key: 'quality', label: 'Quality & Defects', title: 'Defect inspection, evidence and trends', run: goTo('quality') });
  if (prof.kind === 'logistics' || prof.id === 'B-RCV' || prof.id === 'B-LOAD')
    out.push({ key: 'fleet', label: 'Fleet & Movement', title: 'Vehicles, docks, dwell and material movement', run: goTo('fleet') });
  out.push({ key: 'events', label: 'Events & Reports', title: `Every event record of ${prof.id} (all recorded time), each with its report and PDF`, run: () => openEventsFor({ equipmentId: prof.id }) });
  return out;
}

export function EquipmentWorkspace({ id }: { id: string }) {
  const select = useTwin((s) => s.select);
  const focusEquipment = useTwin((s) => s.focusEquipment);
  const finance = useApp((s) => s.finance);
  const camOpen = useTwinUi((s) => s.camera);
  const setCamera = useTwinUi((s) => s.setCamera);
  const focusFor = useTwinUi((s) => s.focusFor);
  const prof = useMemo(() => assetProfile(id), [id]);
  const item = EQUIPMENT_BY_ID[id];
  const zone = ZONE_BY_ID[item.zone];
  const stageName = prof.monitored ? MONITORED_STAGE_BY_ID[prof.monitored].name : item.stage;

  const d = useSimValue(
    (s) => {
      const status = s.machines[id] ? assetStatus(s, id) : null;
      const active = activeRootEvents(s, id);
      const recent = recentEvents(s, id, 3);
      // The Events list the link opens (this asset's id in the search, all recorded time): its count, and
      // whether it holds anything beyond the rows shown here.
      const listed = eventsForSubject(s, { equipmentId: id });
      const shown = new Set(recent.map((e) => e.id));
      const impactEvent = active[0] ?? null;
      const recs = recommendationsFor(s, id);
      return {
        now: s.minute,
        status,
        lastState: s.feeds[id]?.lastState,
        kpis: equipmentKpis(s, id),
        health: prof.conditionMonitored ? assess(s, id) : null,
        recent,
        listed: listed.length,
        more: listed.some((e) => !shown.has(e.id)),
        impactEvent,
        impact: impactEvent ? eventImpact(s, impactEvent, finance) : null,
        role: constraintRole(s, prof),
        steps: nextSteps(s, id, 3, recs),
        camera: selectionCamera(s, { equipmentId: id })?.id ?? null,
        buffer: prof.bufferId ? s.buffers[prof.bufferId] : null,
      };
    },
    [id, finance, prof],
  );

  // Updated in place when another asset is selected: start at the top, or at the section a link asked for.
  const body = useRef<HTMLDivElement>(null);
  const sections = useRef<Partial<Record<WorkspaceSection, HTMLElement | null>>>({});
  const wanted = focusFor?.id === id ? focusFor : null;
  const handled = useRef<number | null>(null);
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    // A section request is honoured once (its nonce); otherwise a newly selected asset starts at the top.
    if (wanted && wanted.nonce !== handled.current) {
      handled.current = wanted.nonce;
      const target = sections.current[wanted.section];
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
        shownId.current = id;
        return;
      }
    }
    if (shownId.current !== id) {
      el.scrollTop = 0;
      shownId.current = id;
    }
  }, [id, wanted]);

  const video = useMemo<VideoContext>(() => ({ equipmentId: id, stage: prof.monitored }), [id, prof.monitored]);
  const st = d.status;
  const stale = st?.staleSince != null;
  const camOn = d.camera != null && camOpen === d.camera;

  return (
    <aside className="inspector overlay-panel tw-insp eqw" aria-label={`${item.name} · equipment details`}>
      <header className="insp-h">
        <div>
          <div className="insp-zone">
            <span className="chip" style={{ background: zone.color }} aria-hidden>
              {zone.id}
            </span>
            <span className="eqw-crumb">
              {stageName} · <span className="mono">{id}</span>
            </span>
          </div>
          <h2>{item.name}</h2>
          <div className="tw-insp-status">
            {st ? (
              <>
                <OperationalStatus state={st.op} />
                <span className="muted num">{stale ? `no update since ${formatClock(st.staleSince!)}` : `since ${formatClock(st.since)}`}</span>
              </>
            ) : prof.bufferId && d.buffer != null ? (
              <span className="muted">Buffer · level from its simulated signal</span>
            ) : (
              <span className="muted">No operating state modelled</span>
            )}
            <ProvenanceBadge kind="simulated" />
            {stale && <ProvenanceBadge kind="stale" title="The asset’s (simulated) data feed stopped updating; values are the last ones received" />}
          </div>
          {st?.reason && !stale && <div className="eqw-reason">Stop reason: {st.reason}</div>}
          {stale && (
            <div className="eqw-reason">
              Last reported {d.lastState ? MACHINE_STATE[d.lastState].label.toLowerCase() : 'state unknown'} at {fmtInt(st!.rate)} tiles/h; the current state is unknown until the feed updates.
            </div>
          )}
        </div>
        <button type="button" className="btn ghost sm icon" onClick={() => select(null)} title="Close (Esc)" aria-label="Close equipment details">
          <X size={16} />
        </button>
      </header>

      <div className="tw-insp-b eqw-b" ref={body}>
        <section className="insp-sec eqw-video" ref={(el) => void (sections.current.overview = el)} aria-label="Reference video">
          <ContextVideo context={video} compact />
        </section>

        <section className="insp-sec" aria-label="Key figures">
          <h3>Key figures · {d.kpis.scope}</h3>
          <KpiTiles set={d.kpis} label={`${item.name} key figures`} />
        </section>

        <div ref={(el) => void (sections.current.condition = el)}>
          <ConditionSection prof={prof} h={d.health} />
        </div>

        <section className="insp-sec" ref={(el) => void (sections.current.events = el)} aria-label="Recent events">
          <h3>Recent events · newest first</h3>
          <AssetEventList events={d.recent} now={d.now} empty="No event recorded for this asset: its detection rules stayed within their thresholds." />
          {d.more && (
            <button
              type="button"
              className="tw-link tw-more"
              onClick={() => openEventsFor({ equipmentId: id })}
              title={`Events & Reports, filtered to ${id} for all recorded time`}
            >
              All {d.listed} event{d.listed === 1 ? '' : 's'} of this asset in Events &amp; Reports →
            </button>
          )}
        </section>

        {(d.impact || d.role) && (
          <section className="insp-sec" aria-label="Impact">
            <h3>Impact · simulated</h3>
            {d.impactEvent && d.impact && (
              <>
                <p className="insp-desc">
                  <b>{d.impactEvent.title}</b> <span className="mono muted">{d.impactEvent.id}</span> — still active, since {formatClock(d.impactEvent.start)}.
                </p>
                <dl className="dl eqw-impact">
                  {d.impact.rows.slice(0, 4).map((r) => (
                    <div key={r.label} style={{ display: 'contents' }}>
                      <dt title={r.basis}>{r.label}</dt>
                      <dd title={r.basis}>{r.value}</dd>
                    </div>
                  ))}
                </dl>
                {d.impact.notes[0] && <p className="tw-fine">{d.impact.notes[0]}</p>}
                <button type="button" className="tw-link tw-more" onClick={() => openEvent(d.impactEvent!.id)}>
                  Full impact, evidence and cost estimate (with assumptions) in the report →
                </button>
              </>
            )}
            {d.role?.kind === 'constraint' && (
              <p className="insp-desc eqw-role" title={d.role.marker.title}>
                <StatusBadge tone={d.role.marker.active ? 'warning' : 'neutral'} icon={Hourglass} label={d.role.marker.label} size={12} /> {d.role.marker.sentence}
                {d.role.marker.active ? ' Every minute lost here is lost line output.' : ''}
              </p>
            )}
            {d.role?.kind === 'held-up' && (
              <p className="insp-desc eqw-role" title={d.role.marker.title}>
                Held up by its neighbours ({d.role.window}): starved {fmtPct(d.role.starvedShare, 0)}, blocked {fmtPct(d.role.blockedShare, 0)} of the time. {d.role.marker.sentence}
              </p>
            )}
          </section>
        )}

        <div ref={(el) => void (sections.current.next = el)}>
          <NextSteps steps={d.steps} current={id} empty="No open recommendation for this asset: its stoppage, condition, quality and flow rules are within thresholds." />
        </div>

        <ContinueIn links={flowLinks(prof)} />

        <TechnicalDetails prof={prof} h={d.health} />
      </div>

      <footer className="insp-f">
        <button type="button" className="btn sm" onClick={() => focusEquipment(id)} title="Frame this asset in the model">
          <Crosshair size={13} aria-hidden />
          Focus
        </button>
        {d.camera && CAMERA_BY_ID[d.camera] && (
          <button
            type="button"
            className={`btn sm ${camOn ? 'on' : ''}`}
            aria-pressed={camOn}
            onClick={() => setCamera(camOn ? null : d.camera)}
            title={`${CAMERA_BY_ID[d.camera].name} (${d.camera}) · simulated view rendered from the digital twin unless a stream is configured`}
          >
            <Video size={13} aria-hidden />
            Camera
          </button>
        )}
        <button
          type="button"
          className="btn sm"
          onClick={() => useApp.getState().openCopilot(`How is ${id} performing?`)}
          title="Ask the Copilot about this asset (rule-based on the current demo state — no language model)"
        >
          <MessageSquareText size={13} aria-hidden />
          Ask Copilot
        </button>
      </footer>
    </aside>
  );
}
