/**
 * The event report — one OpEvent record, its evidence, impact and lifecycle, rendered from the
 * shared report model (src/intel/report.ts buildEventReport with the live financial assumptions and
 * tariffs). The PDF (src/report/pdf.ts) renders the SAME model, section by section, in the same order.
 *
 * `compact`: a narrower read-only variant for previews inside other workspaces (no lifecycle form,
 * no section index), with a link to the full report in Events & Reports.
 */
import { useMemo } from 'react';
import { Box, ExternalLink, MessageSquareText } from 'lucide-react';
import { openEvent, useApp } from '../../app/store';
import { buildEventReport, cameraName, type EventReport } from '../../intel/report';
import { CONFIDENCE_HINT, LABELS, fmtMoney, fmtValue, plantTime, wallClock } from '../../report/format';
import { inspectionRecords } from '../../report/images';
import { EVENT_SECTION_TITLES, contextEvidenceId } from '../../report/model';
import { useSim, useSimValue } from '../../sim/store';
import { Empty } from '../kit/Panel';
import { EventStatusBadge, SeverityBadge, SourceTag } from '../kit/Status';
import { SupportingEvidence, VisualEvidence } from './evidence';
import { Lifecycle } from './Lifecycle';
import { ConditionBadge, ConfidenceTag, KV, PdfButton, Prov, Sec, Sub, Unavailable, showEventInTwin } from './parts';
import './report.css';

const T = EVENT_SECTION_TITLES;
const COPILOT_QUESTION = 'What happened and what should we do?';

export function EventReportView({ eventId, compact = false }: { eventId: string; compact?: boolean }) {
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const resetting = useSim((s) => s.resetting);
  const report = useSimValue((s) => buildEventReport(s, eventId, { finance, tariffs }), [eventId, finance, tariffs]);
  if (!report)
    return (
      <div className="rp rp-missing">
        <Empty title={resetting ? 'Rebuilding the demo state…' : `Event ${eventId} is not in the current demo state`}>
          {resetting ? 'Reset Demo is rebuilding the seeded history; events reappear when it completes.' : 'Reset Demo rebuilds the history with new records, and closed events older than eight days are pruned.'}
        </Empty>
      </div>
    );
  return <ReportBody r={report} compact={compact} />;
}

function ReportBody({ r, compact }: { r: EventReport; compact: boolean }) {
  const ev = r.event;
  const sim = useSim((s) => s.sim);
  const records = useMemo(() => inspectionRecords(sim, r.visualEvidence), [sim, r.visualEvidence]);
  const ctxId = contextEvidenceId(r);
  const ctxEvidence = r.supportingEvidence.find((x) => x.id === ctxId);
  const supporting = r.supportingEvidence.filter((x) => x.id !== ctxId);
  const S = r.summary;
  const A = r.asset;
  const D = r.detection;
  const C = r.context;
  const I = r.impact;
  const E = I.estimate;
  const G = r.diagnosis;
  const P = r.provenance;
  const sid = (n: number) => `rp-${ev.id}-${n}`;
  const jump = (n: number) => document.getElementById(sid(n))?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <article className={`rp ${compact ? 'compact' : ''}`} aria-label={`Event report ${ev.id}`}>
      <header className="rp-head">
        <div className="rp-kicker">
          <span className="mono">{ev.id}</span>
          <span>{S.type}</span>
          <span>{S.category}</span>
        </div>
        <h2 className="rp-title">{ev.title}</h2>
        <p className="rp-lead">{S.text}</p>
        <div className="rp-badges">
          <SeverityBadge severity={ev.severity} />
          <EventStatusBadge status={ev.status} />
          <ConditionBadge ev={ev} />
          <SourceTag source={ev.source} />
          {ev.historical && (
            <span className="tag" title="Detected in the pre-rolled history, before this demo session started">
              Pre-rolled history
            </span>
          )}
        </div>
        <div className="rp-actions">
          <button className="btn sm" onClick={() => showEventInTwin(ev)} title="Open the Factory Twin on the affected asset, station, vehicle or zone">
            <Box size={13} aria-hidden /> Show in 3D
          </button>
          <button className="btn sm" onClick={() => useApp.getState().openCopilot(COPILOT_QUESTION, { eventId: ev.id })} title={`Copilot · ${LABELS.copilot}`}>
            <MessageSquareText size={13} aria-hidden /> Ask the copilot about this event
          </button>
          <PdfButton eventId={ev.id} />
          {compact ? (
            <button className="btn sm ghost" onClick={() => openEvent(ev.id)}>
              <ExternalLink size={13} aria-hidden /> Open full report
            </button>
          ) : (
            <button className="btn sm ghost" onClick={() => jump(11)} title="Acknowledge, assign, investigate, add notes, resolve">
              Acknowledge & resolve
            </button>
          )}
        </div>
        {!compact && (
          <nav className="rp-toc" aria-label="Report sections">
            {T.map((t, i) => (
              <button key={t} onClick={() => jump(i + 1)}>
                <span className="num">{i + 1}</span> {t}
              </button>
            ))}
          </nav>
        )}
      </header>

      <Sec n={1} title={T[0]} id={sid(1)}>
        <KV
          cols={compact ? 2 : 3}
          rows={[
            ['Event id', <span className="mono">{S.id}</span>],
            ['Type', S.type],
            ['Category', S.category],
            ['Severity', <SeverityBadge severity={ev.severity} />],
            ['Status', <EventStatusBadge status={ev.status} />],
            ['Condition', <ConditionBadge ev={ev} />],
            ['Start', S.start],
            ['End', S.end ?? <span className="muted">Ongoing</span>],
            ['Duration', `${S.duration}${S.end ? '' : ' so far'}`],
            ['Source', S.source === 'Scenario' ? 'Simulation — demo scenario' : 'Simulation'],
            ['Detected', S.historical ? 'Before this demo session (pre-rolled history)' : 'During this demo session'],
            ['Last update', plantTime(ev.lastUpdate)],
          ]}
        />
      </Sec>

      <Sec n={2} title={T[1]} id={sid(2)}>
        <KV
          cols={compact ? 2 : 3}
          rows={[
            ['Kind', A.kind],
            ['Id', <span className="mono">{A.id}</span>],
            ['Name', A.name],
            ['Stage', A.stage ?? '—'],
            ['Zone', A.zone ?? '—'],
            ['Camera', A.camera ? `${A.camera} · ${cameraName(A.camera)}` : <span className="muted">No camera covers this asset</span>],
          ]}
        />
      </Sec>

      <Sec n={3} title={T[2]} id={sid(3)}>
        <KV
          rows={[
            ['Source', D.kind],
            ['Rule', `${D.rule} · ${D.ruleLabel}`],
            ['Rule logic', D.description],
            ['Signal', D.signalId ? <span className="mono">{D.signalId}</span> : <span className="muted">No single signal — rule on records</span>],
            ['Threshold', D.threshold ? `${D.threshold.label}: ${fmtValue(D.threshold)}` : <span className="muted">No numeric threshold</span>],
          ]}
        />
        {D.observed.length > 0 ? (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Observed at detection</th>
                <th className="n">Value</th>
              </tr>
            </thead>
            <tbody>
              {D.observed.map((o, i) => (
                <tr key={i}>
                  <td>{o.label}</td>
                  <td className="n">{fmtValue(o)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No observed values recorded</p>
        )}
      </Sec>

      <Sec n={4} title={T[3]} id={sid(4)}>
        <VisualEvidence r={r} records={records} />
      </Sec>

      <Sec n={5} title={T[4]} id={sid(5)}>
        <SupportingEvidence items={supporting} compact={compact} />
      </Sec>

      <Sec n={6} title={T[5]} id={sid(6)}>
        <KV rows={[['Shift at detection', C.shift], ...C.lineNow.map((x) => [x.label, fmtValue(x)] as [string, string])]} />
        {C.atDetection.length > 0 && (
          <>
            <Sub>At detection{ctxEvidence ? ` · ${ctxEvidence.title}` : ''}</Sub>
            {ctxEvidence && (
              <Prov>
                {ctxEvidence.originLabel} — {ctxEvidence.provenance.label} · captured {plantTime(ctxEvidence.capturedAt)}
              </Prov>
            )}
            <dl className="rp-kv c2">
              {C.atDetection.map((x, i) => (
                <div key={i}>
                  <dt>{x.label}</dt>
                  <dd className="num">{fmtValue(x)}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <Sub>Related events</Sub>
        {C.related.length ? (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Title</th>
                <th>Relation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {C.related.map((x) => (
                <tr key={x.id}>
                  <td>
                    <button className="row-link mono" onClick={() => openEvent(x.id)} title={`Open the report of ${x.id}`}>
                      {x.id}
                    </button>
                  </td>
                  <td>{x.title}</td>
                  <td className="muted">{x.relation}</td>
                  <td>{x.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No related events</p>
        )}
      </Sec>

      <Sec n={7} title={T[6]} id={sid(7)}>
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
          <p className="muted">No impact quantities apply</p>
        )}
        {I.notes.length > 0 && (
          <ul className="rp-list">
            {I.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </Sec>

      <Sec n={8} title={T[7]} id={sid(8)} tag={<span className="tag sim">{LABELS.estimate}</span>}>
        {!E ? (
          <p className="muted">No cost model applies to this event type — no monetary figure is given.</p>
        ) : (
          <>
            {E.lines.length ? (
              <table className="rp-table">
                <thead>
                  <tr>
                    <th>Cost line</th>
                    <th className="n">Amount</th>
                    <th>Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {E.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.label}</td>
                      <td className="n">{fmtMoney(E.currency, l.amount)}</td>
                      <td className="muted">{l.basis}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Estimated total</td>
                    <td className="n">{fmtMoney(E.currency, E.total)}</td>
                    <td className="muted">Estimate from the assumptions below — not a verified business loss</td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <p className="muted">No monetary loss is estimated for this event.</p>
            )}
            <div className="rp-cols">
              <div>
                <Sub>Assumptions</Sub>
                <ul className="rp-list">
                  {E.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
              <div>
                {E.missing.length > 0 && (
                  <>
                    <Sub>Missing data</Sub>
                    <ul className="rp-list">
                      {E.missing.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </>
                )}
                {E.limitations.length > 0 && (
                  <>
                    <Sub>Limitations</Sub>
                    <ul className="rp-list">
                      {E.limitations.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </Sec>

      <Sec n={9} title={T[8]} id={sid(9)}>
        <Sub>Observed facts</Sub>
        {G.facts.length ? (
          <ul className="rp-list">
            {G.facts.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No facts recorded</p>
        )}
        <Sub>Suspected causes — hypotheses unless confirmed</Sub>
        {G.causes.length ? (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Cause</th>
                <th>Confidence</th>
                <th>Basis</th>
                <th>Related</th>
              </tr>
            </thead>
            <tbody>
              {G.causes.map((c, i) => (
                <tr key={i}>
                  <td>{c.text}</td>
                  <td title={CONFIDENCE_HINT[c.confidence]}>
                    <ConfidenceTag c={c.confidence} />
                  </td>
                  <td className="muted">{c.basis}</td>
                  <td>
                    {c.relatedEventId ? (
                      <button className="row-link mono" onClick={() => openEvent(c.relatedEventId!)}>
                        {c.relatedEventId}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No cause suggested</p>
        )}
        <Sub>Uncertainty</Sub>
        {G.uncertainty.length ? (
          <ul className="rp-list">
            {G.uncertainty.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">None stated</p>
        )}
      </Sec>

      <Sec n={10} title={T[9]} id={sid(10)}>
        {r.recommendations.length ? (
          <ol className="rp-recs">
            {r.recommendations.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        ) : (
          <p className="muted">No recommendation recorded.</p>
        )}
      </Sec>

      <Sec n={11} title={T[10]} id={sid(11)}>
        <Lifecycle r={r} readOnly={compact} />
        {compact && (
          <p className="rp-hint">
            Manage the lifecycle in{' '}
            <button className="row-link" onClick={() => openEvent(ev.id)}>
              Events & Reports
            </button>
            .
          </p>
        )}
      </Sec>

      <Sec n={12} title={T[11]} id={sid(12)}>
        <KV
          rows={[
            ['Origin', P.origin],
            ['Signals used', P.sources.length ? <span className="mono rp-wrap">{P.sources.join(', ')}</span> : <span className="muted">None (rule on records)</span>],
          ]}
        />
        <Sub>Unavailable evidence</Sub>
        {P.unavailable.length ? (
          <div className="rp-na-list">
            {P.unavailable.map((u, i) => (
              <Unavailable key={i} title={u.title} reason={u.reason} />
            ))}
          </div>
        ) : (
          <p className="muted">Nothing missing</p>
        )}
        <Sub>Limitations</Sub>
        <ul className="rp-list">
          {P.disclaimers.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      </Sec>

      <footer className="rp-foot">
        Report generated {wallClock(r.generatedAt)} (wall clock) · {r.generatedAtPlant}. Built from event record <span className="mono">{ev.id}</span> and its evidence — the PDF renders this same model.
      </footer>
    </article>
  );
}
