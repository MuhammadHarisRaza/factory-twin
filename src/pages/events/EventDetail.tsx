/**
 * The selected event, in the order an investigation reads it (master prompt §13):
 *   what happened → affected equipment & stage (Show in 3D) → evidence (as captured, with its
 *   provenance; reference footage kept apart as orientation, not evidence) → associated KPIs →
 *   impact (estimates with their assumptions) → recommended investigation → related views →
 *   history, lifecycle and resolution.
 * Everything comes from the shared EventReport model (src/intel/report.ts buildEventReport) — the
 * same record the incident report and its PDF are built from.
 */
import { useMemo, type ReactNode } from 'react';
import { Box, ClipboardList, Factory, MessageSquareText, ShieldCheck, Truck } from 'lucide-react';
import { openDefect, openFleetVehicle, openStage, useApp } from '../../app/store';
import { buildEventReport, cameraName, type EventReport } from '../../intel/report';
import {
  activeVehiclesKpi,
  avgDwellKpi,
  constraintDowntimeKpi,
  defectiveKpi,
  delayedVehiclesKpi,
  factoryOeeKpi,
  firstPassQualityKpi,
  goodOutputKpi,
  rejectRateKpi,
  targetAttainmentKpi,
  topDefectKpi,
  type KpiModel,
} from '../../intel/kpis';
import { INSPECTION_STATIONS, MONITORED_STAGES, MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { DefectCategory, MonitoredStageId, OpEvent } from '../../model/types';
import { CONFIDENCE_HINT, LABELS, fmtMoney, fmtValue, plantTime } from '../../report/format';
import { inspectionRecords } from '../../report/images';
import { contextEvidenceId } from '../../report/model';
import type { SimState } from '../../sim/engine';
import { eventInMonitoredStage, eventStageOf } from '../../sim/events';
import { lineMetrics, resolvePeriod } from '../../sim/metrics';
import { useSim, useSimValue } from '../../sim/store';
import { Disclosure, EmptyState, ProvenanceBadge } from '../../ui/kit/Page';
import { EventStatusBadge, SeverityBadge } from '../../ui/kit/Status';
import { SupportingEvidence, VisualEvidence } from '../../ui/report/evidence';
import { Lifecycle } from '../../ui/report/Lifecycle';
import { ConditionBadge, ConfidenceTag, KV, PdfButton, Sub, Unavailable, showEventInTwin } from '../../ui/report/parts';
import { ContextVideo } from '../../video/ContextVideo';
import { EQUIPMENT_TOPICS } from '../../video/topics';
import type { VideoContext, VideoTopic } from '../../video/types';
import { openIncidentReport } from './state';
import '../../ui/report/report.css';

const COPILOT_QUESTION = 'What happened and what should we do?';

/** The monitored stage an event is filed under (the same rule as Production), if any. */
export function monitoredStageOf(ev: OpEvent): MonitoredStageId | null {
  const a = ev.asset;
  if (a.stage && MONITORED_STAGE_BY_ID[a.stage]) return a.stage;
  const byAsset = a.equipmentId ? eventStageOf(a.equipmentId) : undefined;
  if (byAsset && MONITORED_STAGE_BY_ID[byAsset]) return byAsset;
  if (a.stationId) return 'SORT';
  return MONITORED_STAGES.find((ms) => eventInMonitoredStage(ms, ev))?.id ?? null;
}

const DEFECT_TOPIC: Record<DefectCategory, VideoTopic> = {
  crack: 'crack-chip-inspection',
  chip: 'crack-chip-inspection',
  surface: 'surface-inspection',
  glaze: 'glaze-defect-inspection',
  shade: 'glaze-defect-inspection',
  planarity: 'dimensional-inspection',
  dimension: 'dimensional-inspection',
};

/** The most specific reference-video context for an event (equipment, else defect / vehicle topic, else stage). */
export function videoContextOf(ev: OpEvent, stage: MonitoredStageId | null): VideoContext {
  const eq = ev.asset.equipmentId ?? (ev.asset.stationId ? INSPECTION_STATIONS.find((s) => s.id === ev.asset.stationId)?.equipmentId : undefined);
  if (ev.category === 'quality' && ev.refs.defect) return { topic: DEFECT_TOPIC[ev.refs.defect] };
  if (eq && EQUIPMENT_TOPICS[eq]) return { equipmentId: eq, stage };
  if (ev.category === 'logistics') {
    const topic: VideoTopic = ev.type === 'restricted-entry' ? 'warehouse-forklift' : ev.type === 'dock-overstay' || ev.type === 'turnaround-exceeded' ? 'dock-operations' : 'yard-movement';
    return { topic };
  }
  return { stage };
}

/** KPIs (src/intel/kpis.ts, current shift) that the event's category bears on. */
export function associatedKpis(s: SimState, ev: OpEvent): KpiModel[] {
  const p = resolvePeriod('shift', s.minute);
  const lm = lineMetrics(s, p);
  switch (ev.category) {
    case 'quality':
      return [firstPassQualityKpi(s, p), rejectRateKpi(s, p), defectiveKpi(s, p), topDefectKpi(s, p)];
    case 'logistics':
      return [delayedVehiclesKpi(s), activeVehiclesKpi(s), avgDwellKpi(s, p)];
    case 'equipment':
      return [factoryOeeKpi(s, p, lm), constraintDowntimeKpi(s, p, lm), goodOutputKpi(s, p, lm)];
    default:
      return [goodOutputKpi(s, p, lm), targetAttainmentKpi(s, p, lm), factoryOeeKpi(s, p, lm), constraintDowntimeKpi(s, p, lm)];
  }
}

function Step({ n, title, tag, children, id }: { n: number; title: string; tag?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="evd-step" aria-labelledby={`${id}-h`}>
      <header className="evd-step-h">
        <span className="evd-n num" aria-hidden>
          {n}
        </span>
        <h3 id={`${id}-h`}>{title}</h3>
        {tag && <span className="evd-step-tag">{tag}</span>}
      </header>
      <div className="evd-step-b">{children}</div>
    </section>
  );
}

function MiniKpi({ k }: { k: KpiModel }) {
  return (
    <div className="mini-kpi" title={k.unavailable ?? k.definition}>
      <span>{k.label}</span>
      {k.unavailable ? (
        <b className="evd-na">Unavailable</b>
      ) : (
        <b>
          {k.display}
          {k.unit && <small>{k.unit}</small>}
        </b>
      )}
      <em>{k.unavailable ? k.unavailable : (k.status?.label ?? k.target ?? k.scope)}</em>
    </div>
  );
}

export function EventDetail({ eventId }: { eventId: string }) {
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const resetting = useSim((s) => s.resetting);
  const report = useSimValue((s) => buildEventReport(s, eventId, { finance, tariffs }), [eventId, finance, tariffs]);
  if (!report)
    return (
      <EmptyState title={resetting ? 'Rebuilding the demo state…' : `Event ${eventId} is not in the current demo state`}>
        {resetting ? 'Reset Demo is rebuilding the seeded history; events reappear when it completes.' : 'Reset Demo rebuilds the history with new records, and closed events older than eight days are pruned.'}
      </EmptyState>
    );
  return <Detail r={report} />;
}

function Detail({ r }: { r: EventReport }) {
  const ev = r.event;
  const sim = useSim((s) => s.sim);
  const ctx = useSimValue(
    (s) => ({
      kpis: associatedKpis(s, ev),
      scenario: ev.refs.scenarioId ? (s.scenarios.find((x) => x.id === ev.refs.scenarioId) ?? null) : null,
      vehicleLabel: ev.asset.vehicleId ? (s.logistics.vehicles[ev.asset.vehicleId]?.label ?? ev.asset.vehicleId) : null,
      vehicleOnSite: ev.asset.vehicleId ? s.logistics.active.includes(ev.asset.vehicleId) : false,
    }),
    [ev.id],
  );
  const records = useMemo(() => inspectionRecords(sim, r.visualEvidence), [sim, r.visualEvidence]);
  const stage = monitoredStageOf(ev);
  const stageName = stage ? MONITORED_STAGE_BY_ID[stage].name : null;
  const ctxId = contextEvidenceId(r);
  const ctxEvidence = r.supportingEvidence.find((x) => x.id === ctxId);
  const supporting = r.supportingEvidence.filter((x) => x.id !== ctxId);
  const video = useMemo(() => videoContextOf(ev, stage), [ev, stage]);
  const S = r.summary;
  const A = r.asset;
  const D = r.detection;
  const I = r.impact;
  const E = I.estimate;
  const G = r.diagnosis;
  const P = r.provenance;
  const id = (k: string) => `evd-${ev.id}-${k}`;

  const origin =
    ev.source === 'scenario'
      ? ctx.scenario
        ? `Scenario-caused — the presenter started the demo scenario “${ctx.scenario.label}” at ${plantTime(ctx.scenario.start)}; rule ${D.rule} raised this event from the simulated signals it changed.`
        : `Scenario-caused — raised by rule ${D.rule} while a demo scenario was active.`
      : `Simulated — raised by rule ${D.rule} (${D.ruleLabel}) on the deterministic simulation; no plant system is connected.`;

  return (
    <article className="evd" aria-label={`Event ${ev.id}`}>
      <header className="evd-head">
        <div className="evd-kicker">
          <span className="mono">{ev.id}</span>
          <span>{S.type}</span>
          <span>{S.category}</span>
        </div>
        <h2 className="evd-title">{ev.title}</h2>
        <div className="evd-badges">
          <SeverityBadge severity={ev.severity} />
          <EventStatusBadge status={ev.status} />
          <ConditionBadge ev={ev} />
          <ProvenanceBadge kind={ev.source === 'scenario' ? 'scenario' : 'simulated'} />
          {ev.historical && (
            <span className="tag" title="Detected in the pre-rolled history, before this demo session started">
              Pre-rolled history
            </span>
          )}
        </div>
        <p className="evd-origin">{origin}</p>
        <div className="evd-actions">
          <button className="btn sm primary" onClick={() => showEventInTwin(ev)} title="Open the Factory Twin on the affected asset, station, vehicle or zone and mark the event there">
            <Box size={13} aria-hidden /> Show in 3D
          </button>
          <button className="btn sm" onClick={() => useApp.getState().openCopilot(COPILOT_QUESTION, { eventId: ev.id })} title={`Copilot · ${LABELS.copilot}`}>
            <MessageSquareText size={13} aria-hidden /> Ask Copilot
          </button>
          <button className="btn sm" onClick={() => openIncidentReport(ev.id)} title="Preview this event as an incident investigation report (Reports tab)">
            <ClipboardList size={13} aria-hidden /> Incident report
          </button>
          <PdfButton eventId={ev.id} />
        </div>
      </header>

      <Step n={1} title="What happened" id={id('what')}>
        <p className="evd-lead">{S.text}</p>
        <KV
          cols={3}
          rows={[
            ['Started', S.start],
            ['Ended', S.end ?? <span className="muted">Condition ongoing</span>],
            ['Duration', `${S.duration}${S.end ? '' : ' so far'}`],
            ['Detected', S.historical ? 'Before this demo session (pre-rolled history)' : 'During this demo session'],
            ['Detection', `${D.rule} · ${D.ruleLabel}`],
            ['Threshold', D.threshold ? `${D.threshold.label}: ${fmtValue(D.threshold)}` : <span className="muted">Fires on the condition — no numeric threshold</span>],
          ]}
        />
        {(D.observed.length > 0 || G.facts.length > 0) && (
          <div className="evd-cols">
            {D.observed.length > 0 && (
              <div>
                <Sub>Observed at detection · {D.kind}</Sub>
                <dl className="facts">
                  {D.observed.map((o, i) => (
                    <div key={i}>
                      <dt>{o.label}</dt>
                      <dd>{fmtValue(o)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {G.facts.length > 0 && (
              <div>
                <Sub>Observed facts</Sub>
                <ul className="rp-list">
                  {G.facts.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Step>

      <Step n={2} title="Affected equipment & stage" id={id('where')}>
        <KV
          cols={3}
          rows={[
            [A.kind, <span>{A.kind === 'Vehicle' && ctx.vehicleLabel ? `${ctx.vehicleLabel} (${A.id})` : A.id === '—' ? A.name : `${A.id} · ${A.name}`}</span>],
            ['Production stage', stageName ?? <span className="muted">Not a production stage</span>],
            ['Zone', A.zone ?? '—'],
            ['Camera coverage', A.camera ? `${A.camera} · ${cameraName(A.camera)} (digital-twin view)` : <span className="muted">No camera covers this asset</span>],
          ]}
        />
        <div className="evd-links">
          <button className="btn sm" onClick={() => showEventInTwin(ev)}>
            <Box size={13} aria-hidden /> Show in 3D
          </button>
          {stage && (
            <button className="btn sm" onClick={() => openStage(stage)} title="Open the stage in Production and highlight it in the 3D model">
              <Factory size={13} aria-hidden /> {stageName} in Production
            </button>
          )}
        </div>
      </Step>

      <Step n={3} title="Evidence" id={id('evidence')} tag={<span className="muted">As captured with the event</span>}>
        <VisualEvidence r={r} records={records} />
        {supporting.length > 0 && (
          <>
            <Sub>Signals & measurements</Sub>
            <SupportingEvidence items={supporting} compact />
          </>
        )}
        <div className="evd-ref">
          <div className="evd-ref-h">
            <ProvenanceBadge kind="reference" />
            <b>Reference footage — not evidence</b>
          </div>
          <p className="evd-ref-t">
            Public footage of this kind of {ev.category === 'logistics' ? 'vehicle operation' : ev.category === 'quality' ? 'inspection' : 'process or equipment'}, for orientation only. It is not this plant, not a recording
            of this event and not evidence that it happened.
          </p>
          <ContextVideo context={video} compact title="Process reference video" />
        </div>
      </Step>

      <Step n={4} title="Associated KPIs" id={id('kpis')} tag={<span className="muted">Current shift · context, not caused by this event alone</span>}>
        <div className="mini-kpis">
          {ctx.kpis.map((k) => (
            <MiniKpi key={k.id} k={k} />
          ))}
        </div>
        {r.context.atDetection.length > 0 && (
          <>
            <Sub>At detection{ctxEvidence ? ` · ${ctxEvidence.title}` : ''}</Sub>
            <dl className="rp-kv c3">
              {r.context.atDetection.map((x, i) => (
                <div key={i}>
                  <dt>{x.label}</dt>
                  <dd className="num">{fmtValue(x)}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </Step>

      <Step n={5} title="Impact" id={id('impact')} tag={E && E.lines.length ? <ProvenanceBadge kind="estimate" /> : undefined}>
        {I.rows.length ? (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Measure</th>
                <th className="n">Value</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {I.rows.map((x, i) => (
                <tr key={i}>
                  <td>{x.label}</td>
                  <td className="n">{x.value}</td>
                  <td className="muted">{x.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No impact quantity applies to this event.</p>
        )}
        {I.notes.length > 0 && (
          <ul className="rp-list">
            {I.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {E && E.lines.length > 0 ? (
          <div className="evd-estimate">
            <div className="evd-estimate-h">
              <span>Estimated cost</span>
              <b className="num">{fmtMoney(E.currency, E.total)}</b>
            </div>
            <ul className="rp-list">
              {E.lines.map((l, i) => (
                <li key={i}>
                  {l.label}: <span className="num">{fmtMoney(E.currency, l.amount)}</span> <span className="muted">— {l.basis}</span>
                </li>
              ))}
            </ul>
            <Disclosure title="Assumptions and limitations" meta={`${E.assumptions.length + E.limitations.length + E.missing.length} items`}>
              <ul className="rp-list">
                {[...E.assumptions, ...E.missing.map((m) => `Missing: ${m}`), ...E.limitations].map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </Disclosure>
          </div>
        ) : (
          <p className="muted">{E ? 'No monetary loss is estimated for this event.' : 'No cost model applies to this event type — no monetary figure is given.'}</p>
        )}
      </Step>

      <Step n={6} title="Recommended investigation" id={id('investigate')}>
        {r.recommendations.length ? (
          <ol className="rp-recs">
            {r.recommendations.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        ) : (
          <p className="muted">No recommendation recorded.</p>
        )}
        <Sub>Suspected causes — hypotheses unless confirmed</Sub>
        {G.causes.length ? (
          <ul className="evd-causes">
            {G.causes.map((c, i) => (
              <li key={i}>
                <ConfidenceTag c={c.confidence} />
                <div>
                  <span>{c.text}</span>
                  <span className="muted" title={CONFIDENCE_HINT[c.confidence]}>
                    {c.basis}
                    {c.relatedEventId && (
                      <>
                        {' · '}
                        <button className="row-link mono" onClick={() => useApp.getState().selectEvent(c.relatedEventId!)}>
                          {c.relatedEventId}
                        </button>
                      </>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No cause suggested.</p>
        )}
        {G.uncertainty.length > 0 && (
          <ul className="rp-list muted">
            {G.uncertainty.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        )}
      </Step>

      <Step n={7} title="Related events & views" id={id('related')}>
        {r.context.related.length ? (
          <ul className="evd-related">
            {r.context.related.map((x) => (
              <li key={x.id}>
                <button className="row-link mono" onClick={() => useApp.getState().selectEvent(x.id)} title={`Open ${x.id}`}>
                  {x.id}
                </button>
                <span>{x.title}</span>
                <span className="muted">
                  {x.relation} · {x.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No related event recorded.</p>
        )}
        {(ev.category === 'quality' || ev.category === 'logistics') && (
          <div className="evd-links">
            {ev.category === 'quality' && (
              <button className="btn sm" onClick={() => openDefect(ev.id)} title="Open the defect evidence workspace for this event">
                <ShieldCheck size={13} aria-hidden /> Open in Quality & Defects
              </button>
            )}
            {ev.asset.vehicleId && (
              <button
                className="btn sm"
                onClick={() => openFleetVehicle(ev.asset.vehicleId!)}
                title={ctx.vehicleOnSite ? 'Open the vehicle in Fleet & Movement' : 'The vehicle has left the site — Fleet & Movement shows its last visit'}
              >
                <Truck size={13} aria-hidden /> {ctx.vehicleLabel ?? ev.asset.vehicleId} in Fleet & Movement
              </button>
            )}
            {ev.category === 'logistics' && !ev.asset.vehicleId && (
              <button className="btn sm" onClick={() => useApp.getState().go('fleet')} title="Open Fleet & Movement (yard, docks and trucks)">
                <Truck size={13} aria-hidden /> Fleet & Movement
              </button>
            )}
          </div>
        )}
      </Step>

      <Step n={8} title="History, lifecycle & resolution" id={id('lifecycle')}>
        <Lifecycle r={r} />
      </Step>

      <Disclosure title="Data provenance & limitations" meta={P.unavailable.length ? `${P.unavailable.length} item${P.unavailable.length === 1 ? '' : 's'} unavailable` : undefined}>
        <KV
          rows={[
            ['Origin', P.origin],
            ['Signals used', P.sources.length ? <span className="mono rp-wrap">{P.sources.join(', ')}</span> : <span className="muted">None (rule on records)</span>],
          ]}
        />
        {P.unavailable.length > 0 && (
          <div className="rp-na-list">
            {P.unavailable.map((u, i) => (
              <Unavailable key={i} title={u.title} reason={u.reason} />
            ))}
          </div>
        )}
        <ul className="rp-list">
          {P.disclaimers.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      </Disclosure>
    </article>
  );
}
