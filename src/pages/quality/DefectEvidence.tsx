/**
 * Evidence of the selected quality event or defect record — the dominant work area of Quality &
 * Defects. In order of importance: the inspection image (a simulated rendering, labelled so; box
 * and confidence only for a simulated inference record), the defect (category, severity, station,
 * modeled origin stage as a hypothesis, time, source, batch, related event), the inspection
 * metrics before / during / after with first-pass quality and the matching reference footage next
 * to them, the recommended quality action, the suspected causes with their confidence in words,
 * and the event's lifecycle actions. Correlation evidence and the detection rule are disclosed on
 * demand.
 */
import { useState } from 'react';
import { Box, CircleCheck, CircleDashed, CircleHelp, Factory, FileText, MessageSquareText, ScanSearch } from 'lucide-react';
import { openEvent, openStage, openStation, useApp, type NavMode } from '../../app/store';
import type { KpiModel } from '../../intel/kpis';
import { buildEventReport } from '../../intel/report';
import { DEFECTS, PRODUCTS, STAGE_BY_ID } from '../../model/plant';
import type { EventCause, OpEvent, QualityInspection } from '../../model/types';
import { CONFIDENCE_HINT, CONFIDENCE_LABEL } from '../../report/format';
import { EVENT_TYPE_LABEL, evidenceOf } from '../../sim/events';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { getImage } from '../../twin/bridge';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { Disclosure, EmptyState, Facts, ProvenanceBadge, Unavailable } from '../../ui/kit/Page';
import { EventStatusBadge, SeverityBadge } from '../../ui/kit/Status';
import { Lifecycle } from '../../ui/report/Lifecycle';
import { ContextVideo } from '../../video/ContextVideo';
import { DefectSeverity } from './badges';
import { EventCorrelation, RecordStates } from './Correlation';
import { contextStates, correlationEvidence, inspectionEventLinks, inspectionMethod, isVisionRecord, ruleChecks } from './derive';
import { FrameThumb } from './FrameArt';
import { frameForRecord } from './frames';
import { InspectionImage, type ImageView } from './InspectionImage';
import { evidenceFor, inspectionTopic, resolveSelection, type EvidenceModel, type RateStat, type Selection } from './investigate';
import { PRODUCT_BY_SKU, STATION_BY_ID } from './lookup';
import { SnapshotEvidence } from './SnapshotEvidence';
import { boxMm } from './tileGeometry';
import '../../ui/report/report.css';

type Props = {
  /** Selected event or record id (the route's, or the workspace's default). */
  id: string;
  /** First-pass quality of the reporting period (the shared KPI). */
  fpy: KpiModel;
  /** What to offer when the selection is no longer retained. */
  fallbackId: string | null;
  onSelect: (id: string, mode?: NavMode) => void;
};

export function DefectEvidence({ id, fpy, fallbackId, onSelect }: Props) {
  const d = useSimValue(
    (s) => {
      const sel = resolveSelection(s, id);
      const m = evidenceFor(s, sel, inspectionEventLinks(s));
      const snap = sel.kind === 'event' ? (evidenceOf(s, sel.ev).find((x) => x.kind === 'camera-snapshot') ?? null) : null;
      const fallback = !m && fallbackId ? resolveSelection(s, fallbackId).kind : null;
      return { sel, m, snap, snapImg: snap?.image ? getImage(snap.image.key) : null, now: s.minute, fallback };
    },
    [id, fallbackId],
  );
  if (!d.m) return <MissingSelection sel={d.sel} fallbackId={fallbackId} fallbackIsEvent={d.fallback === 'event'} onSelect={onSelect} />;
  return <EvidenceBody key={d.m.id} m={d.m} now={d.now} fpy={fpy} snap={d.snap} snapImg={d.snapImg} onSelect={onSelect} />;
}

function MissingSelection({ sel, fallbackId, fallbackIsEvent, onSelect }: { sel: Selection; fallbackId: string | null; fallbackIsEvent: boolean; onSelect: Props['onSelect'] }) {
  const other = sel.kind === 'missing' ? sel.other : null;
  return (
    <section className="qd-ev qd-ev-empty" aria-label="Defect evidence">
      <EmptyState
        title={other ? `${sel.id} is not a quality event` : `${sel.id} is not in the retained history`}
        action={
          <div className="qd-actions">
            {other && (
              <button type="button" className="btn sm" onClick={() => openEvent(other.id)}>
                <FileText size={13} aria-hidden /> Open its report
              </button>
            )}
            {fallbackId && fallbackId !== sel.id && (
              <button type="button" className="btn sm primary" onClick={() => onSelect(fallbackId)}>
                {fallbackIsEvent ? 'Show the newest quality event' : 'Show the newest defect record'}
              </button>
            )}
          </div>
        }
      >
        {other
          ? `${other.title} — Quality & Defects investigates quality events and inspection records.`
          : 'The simulation keeps the latest inspection records and events; this one has been replaced by newer data, or the demo was reset.'}
      </EmptyState>
    </section>
  );
}

type BodyProps = {
  m: EvidenceModel;
  now: number;
  fpy: KpiModel;
  snap: ReturnType<typeof evidenceOf>[number] | null;
  snapImg: ReturnType<typeof getImage>;
  onSelect: Props['onSelect'];
};

function EvidenceBody({ m, now, fpy, snap, snapImg, onSelect }: BodyProps) {
  const openCopilot = useApp((s) => s.openCopilot);
  const [pick, setPick] = useState<string | null>(null);
  const [view, setView] = useState<ImageView>('annotated');
  const ev = m.ev;
  // The record on screen: the one picked in the event's strip, else the event's primary record, else the selected record.
  const shown: QualityInspection | null = m.records.find((r) => r.id === (pick ?? m.primaryId)) ?? m.records[0] ?? m.rec;
  const station = m.stationId ? STATION_BY_ID[m.stationId] : null;
  const defect = shown?.defect ?? m.defect;
  const label = defect ? DEFECTS[defect].label : null;
  const method = inspectionMethod(shown?.stationId ?? m.stationId ?? 'ST-VIS');
  const vision = isVisionRecord(shown);
  const batch = shown ? (m.batches[shown.id] ?? null) : m.eventBatch;
  const sku = batch?.sku ?? PRODUCTS[0].sku;
  const topic = inspectionTopic(shown?.stationId ?? m.stationId, defect);
  // An all-category event (reject rate) has no origin of its own: the shown record's category gives one.
  const originId = m.origin ?? (defect ? DEFECTS[defect].origin : null);
  const origin = originId ? STAGE_BY_ID[originId] : null;
  const lineRate = !!ev && !m.defect;
  const box = shown?.box && m.records.some((r) => r.id === shown.id) ? boxMm(shown.box) : null;
  const title = ev ? ev.title : `${label ?? 'Inspection result'} at ${station?.name ?? m.stationId}`;
  const askCopilot = () =>
    ev ? openCopilot(`Why did ${ev.id} happen?`, { eventId: ev.id }) : openCopilot(label ? `Why are we seeing ${label.toLowerCase()} rejects?` : 'What quality problems are occurring, and where?');

  return (
    <section className="qd-ev" aria-label={`Evidence for ${m.id}`}>
      <header className="qd-ev-h">
        <div className="qd-ev-badges">
          {ev ? <SeverityBadge severity={ev.severity} /> : <DefectSeverity severity={shown?.severity ?? null} />}
          {ev && <EventStatusBadge status={ev.status} />}
          <span className="mono qd-ev-id">{m.id}</span>
          <span className="dim">{ev ? EVENT_TYPE_LABEL[ev.type] : 'Inspection record'}</span>
          <span className="spacer" />
          <ProvenanceBadge kind={m.source === 'scenario' ? 'scenario' : 'simulated'} />
        </div>
        <h3 className="qd-ev-title">{title}</h3>
        {ev ? <p className="qd-ev-sum">{ev.summary}</p> : shown?.measurement ? <p className="qd-ev-sum">{shown.measurement}</p> : null}
        <p className="qd-ev-when">
          {ev ? 'Detected' : 'Inspected'} {formatDateTime(m.time)}
          {ev &&
            (m.end == null
              ? ` · condition active for ${formatDuration(now - m.time)}`
              : ` · condition cleared ${formatClock(m.end)} after ${formatDuration(m.end - m.time)}`)}
          {ev?.owner ? ` · owner ${ev.owner}` : ''}
        </p>
        <div className="qd-actions">
          {ev && (
            <button type="button" className="btn sm primary" onClick={() => openEvent(ev.id)}>
              <FileText size={13} aria-hidden /> Open report
            </button>
          )}
          {!ev && m.related[0] && (
            <button type="button" className="btn sm primary" onClick={() => onSelect(m.related[0].id)} title={m.related[0].title}>
              <FileText size={13} aria-hidden /> Open event {m.related[0].id}
            </button>
          )}
          {m.stationId && (
            <button type="button" className="btn sm" onClick={() => openStation(m.stationId!)} title={station ? `${station.name} (${station.equipmentId}) in the Factory Twin` : undefined}>
              <Box size={13} aria-hidden /> Show station in 3D
            </button>
          )}
          {origin && (
            <button type="button" className="btn sm" onClick={() => openStage(origin.id)} title={`Open ${origin.name} in Production and highlight it in the 3D model`}>
              <Factory size={13} aria-hidden /> Modeled origin: {origin.name}
            </button>
          )}
          <button type="button" className="btn sm ghost" onClick={askCopilot} title="Ask the rule-based copilot">
            <MessageSquareText size={13} aria-hidden /> Ask copilot
          </button>
        </div>
      </header>

      <div className="qd-ev-main">
        <div className="qd-ev-image">
          {shown && m.records.some((r) => r.id === shown.id) ? (
            <InspectionImage rec={shown} sku={sku} view={view === 'closeup' && !shown.box ? 'annotated' : view} onView={setView} />
          ) : (
            <div className="qd-noimg">
              <EmptyState title="No inspection image" icon={ScanSearch}>
                {m.noImage}
              </EmptyState>
            </div>
          )}
          {m.records.length > 1 && <RecordStrip records={m.records} batches={m.batches} selected={shown?.id ?? null} onPick={setPick} />}
          {m.missing.length > 0 && (
            <p className="qd-note">
              {m.missing.length} referenced record{m.missing.length === 1 ? ' is' : 's are'} no longer retained: <span className="mono">{m.missing.join(', ')}</span>
            </p>
          )}
        </div>

        <div className="qd-ev-facts">
          <h4 className="qd-h">Defect</h4>
          <Facts
            rows={[
              ...(lineRate ? [{ label: 'Event scope', value: 'All categories (line reject rate)' }] : []),
              {
                label: lineRate && shown ? 'Record category' : 'Category',
                value: label ? (
                  <>
                    {label} <span className="dim">· {method.kind === 'vision' ? 'vision class' : method.kind === 'gauge' ? 'gauge measurement' : 'lab check'}</span>
                  </>
                ) : (
                  <span className="muted">No defect category</span>
                ),
              },
              ...(shown ? [{ label: m.kind === 'record' ? 'Severity' : 'Record severity', value: <DefectSeverity severity={shown.severity} /> }] : []),
              { label: 'Classification', value: <span className="mono" title={method.note}>{method.source}</span>, hint: method.note },
              // Confidence only exists for a (simulated) inference record of the vision tunnel.
              ...(shown && vision && shown.confidence != null
                ? [
                    {
                      label: 'Simulated confidence',
                      value: (
                        <span title="Produced by deterministic simulation rules — not the output of a model">
                          {fmtPct(shown.confidence, 1)} <span className="tag sim">simulated confidence</span>
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(shown?.measurement ? [{ label: 'Measurement', value: shown.measurement }] : []),
              ...(box ? [{ label: vision ? 'Simulated box' : 'Measured location', value: `${box.w} × ${box.h} mm at ${box.x}, ${box.y} mm`, hint: 'On the 600 mm tile, from the simulated record' }] : []),
              {
                label: 'Station',
                value: station ? (
                  <>
                    {station.name} <span className="mono muted">{station.equipmentId}</span>
                  </>
                ) : (
                  <span className="muted">—</span>
                ),
              },
              { label: 'Detected at stage', value: STAGE_BY_ID.SORT.name },
              {
                label: 'Modeled origin',
                value: origin ? (
                  <span title="Process knowledge of the defect category — a hypothesis to check, not a confirmed cause">
                    {origin.name} <span className="dim">· hypothesis</span>
                  </span>
                ) : (
                  <Unavailable reason="No defect category is recorded, so no origin stage applies">Not applicable</Unavailable>
                ),
              },
              ...(shown && shown.id !== m.id ? [{ label: 'Record', value: <><span className="mono">{shown.id}</span> · {formatDateTime(shown.time)} · {fmtInt(shown.tiles)} tiles</> }] : []),
              ...(m.kind === 'record' && shown ? [{ label: 'Tiles in record', value: `${fmtInt(shown.tiles)} · tile serial not tracked` }] : []),
              {
                label: 'Source',
                value: m.scenario ? (
                  <span title={`Raised while the scenario "${m.scenario.label}" ran`}>
                    Simulation · scenario <span className="dim">{m.scenario.label}</span>
                  </span>
                ) : m.source === 'scenario' ? (
                  <span title="The engine flags every record made while a quality scenario runs; this category does not originate at the scenario's stage">
                    Simulation · recorded while a quality scenario ran
                  </span>
                ) : (
                  'Simulation (deterministic rules)'
                ),
              },
              {
                label: 'Batch',
                value: batch ? (
                  <span title={shown ? 'Batch recorded with the inspection record' : 'Batch at inspection: tiles inspected now were pressed about 3 h earlier'}>
                    <span className="mono">{batch.id}</span> <span className="dim">· {PRODUCT_BY_SKU[batch.sku]?.name ?? batch.sku}</span>
                  </span>
                ) : (
                  <Unavailable reason="The batch is no longer in the retained production history" />
                ),
              },
              {
                label: m.kind === 'record' ? 'Quality event' : 'Related events',
                value: m.related.length ? (
                  <span className="qd-links">
                    {m.related.slice(0, 3).map((e) => (
                      <button key={e.id} type="button" className="row-link mono" onClick={() => onSelect(e.id)} title={e.title}>
                        {e.id}
                      </button>
                    ))}
                    {m.related.length > 3 && <span className="muted">+{m.related.length - 3}</span>}
                  </span>
                ) : (
                  <span className="muted">{m.kind === 'record' ? 'Not part of a quality event' : 'None'}</span>
                ),
              },
            ]}
          />
        </div>
      </div>

      <div className="qd-ev-metrics">
        <div className="qd-ev-stats">
          <h4 className="qd-h">Inspection metrics · {m.stats.measure.toLowerCase()}</h4>
          <div className="mini-kpis">
            <Stat label="Before" s={m.stats.before} />
            <Stat label={ev ? 'Event window' : 'Last 60 min'} s={m.stats.during} />
            <Stat label="After" s={m.stats.after} />
            {ev && (
              <div className="mini-kpi">
                <span>Excess rejects</span>
                <b>{m.stats.excess != null ? fmtInt(m.stats.excess) : '—'}{m.stats.excess != null && <small>tiles</small>}</b>
                <em>above the 24 h rate</em>
              </div>
            )}
            <div className="mini-kpi" title={fpy.definition}>
              <span>{fpy.label}</span>
              <b>{fpy.unavailable ? <Unavailable reason={fpy.unavailable} /> : <>{fpy.display}<small>{fpy.unit}</small></>}</b>
              <em>{fpy.scope}</em>
            </div>
          </div>
          <p className="qd-note">Rates are rejected ÷ inspected tiles at sorting, from the simulated inspection counters.</p>
        </div>
        <div className="qd-ev-video">
          <ContextVideo context={{ topic }} compact title="Inspection reference video" />
          <p className="qd-note">Reference footage of the inspection type — not this plant, not a live feed and not evidence of this defect.</p>
        </div>
      </div>

      <div className="qd-ev-two">
        <section>
          <h4 className="qd-h">Recommended quality action</h4>
          {m.actions.length ? (
            <ol className="qd-steps">
              {m.actions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ol>
          ) : (
            <p className="muted">No action recommended — the record passed.</p>
          )}
        </section>
        <section>
          <h4 className="qd-h">Suspected causes</h4>
          <Causes causes={m.causes} onOpen={(eid) => onSelect(eid)} />
          <p className="qd-note">Confirmed = directly observed or a recorded scenario input. Likely and possible are hypotheses to verify on the line.</p>
        </section>
      </div>

      <div className="qd-ev-more">
        {ev && (
          <Disclosure title="Actions & history" defaultOpen={ev.status !== 'resolved'} meta={`${ev.status} · ${ev.owner ?? 'unassigned'} · ${ev.notes.length} note${ev.notes.length === 1 ? '' : 's'}`}>
            <LifecycleBlock id={ev.id} />
          </Disclosure>
        )}
        <Disclosure title="Correlation evidence" meta="supports or weakens a hypothesis — not proof of a cause">
          {ev ? <EventCorrelationBlock ev={ev} onSelect={onSelect} /> : m.rec ? <RecordStatesBlock rec={m.rec} /> : null}
        </Disclosure>
        <Disclosure title="How it was detected" meta={ev ? ev.trigger.ruleId : 'rules at the record'}>
          {ev && m.rule ? (
            <div className="qd-detect">
              <p>
                <span className="mono">{m.rule.id}</span> {m.rule.label} — {m.rule.description}
              </p>
              <p className="dim">
                Observed: {m.rule.observed.map((o) => `${o.label} ${o.value}${o.unit ? ` ${o.unit}` : ''}`).join(' · ')}
                {m.rule.threshold && ` · ${m.rule.threshold.label} ${m.rule.threshold.value}${m.rule.threshold.unit ? ` ${m.rule.threshold.unit}` : ''}`}
              </p>
              {snap && <SnapshotEvidence x={snap} img={snapImg} />}
            </div>
          ) : m.rec ? (
            <RecordRulesBlock rec={m.rec} />
          ) : null}
        </Disclosure>
      </div>
    </section>
  );
}

function Stat({ label, s }: { label: string; s: RateStat }) {
  return (
    <div className="mini-kpi" title={s.unavailable}>
      <span>{label}</span>
      <b>{s.unavailable ? <Unavailable reason={s.unavailable} /> : s.value != null ? fmtPct(s.value, 2) : '—'}</b>
      <em>{s.unavailable ?? s.note}</em>
    </div>
  );
}

const CONF_ICON = { confirmed: CircleCheck, likely: CircleHelp, possible: CircleDashed } as const;

function Causes({ causes, onOpen }: { causes: EventCause[]; onOpen: (id: string) => void }) {
  if (!causes.length) return <p className="muted">No cause suggested by the rules.</p>;
  return (
    <ul className="qd-causes">
      {causes.map((c, i) => {
        const Icon = CONF_ICON[c.confidence];
        return (
          <li key={i}>
            <span className={`qd-conf ${c.confidence}`} title={CONFIDENCE_HINT[c.confidence]}>
              <Icon size={12} aria-hidden /> {CONFIDENCE_LABEL[c.confidence]}
            </span>
            <div>
              <div>
                {c.confidence === 'confirmed' ? '' : 'Hypothesis: '}
                {c.text}
              </div>
              <div className="qd-sub">Basis: {c.basis}</div>
              {c.relatedEventId && (
                <button type="button" className="row-link mono" onClick={() => onOpen(c.relatedEventId!)} title="Show the related event">
                  {c.relatedEventId}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Distinct records of an event (one small image each) to switch the inspection image. */
function RecordStrip({ records, batches, selected, onPick }: { records: QualityInspection[]; batches: EvidenceModel['batches']; selected: string | null; onPick: (id: string) => void }) {
  return (
    <div className="qd-strip" role="group" aria-label="Inspection records of this event">
      <span className="qd-k">Records in this event · {records.length}</span>
      <div className="qd-strip-row">
        {records.map((r) => {
          const frame = frameForRecord(r, batches[r.id]?.sku ?? PRODUCTS[0].sku);
          if (!frame) return null;
          const on = r.id === selected;
          return (
            <button
              key={r.id}
              type="button"
              className={`qd-thumb ${on ? 'on' : ''}`}
              aria-pressed={on}
              onClick={() => onPick(r.id)}
              title={`${r.id} · ${r.defect ? DEFECTS[r.defect].label : 'record'} · ${formatDateTime(r.time)}`}
            >
              <FrameThumb frame={frame} />
              <span className="num">{formatClock(r.time)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LifecycleBlock({ id }: { id: string }) {
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const r = useSimValue((s) => buildEventReport(s, id, { finance, tariffs }), [id, finance, tariffs]);
  if (!r) return <p className="muted">The event is no longer retained.</p>;
  return (
    <div className="qd-life">
      <Lifecycle r={r} />
    </div>
  );
}

function EventCorrelationBlock({ ev, onSelect }: { ev: OpEvent; onSelect: Props['onSelect'] }) {
  const corr = useSimValue((s) => correlationEvidence(s, ev), [ev]);
  return <EventCorrelation corr={corr} onOpenEvent={(e) => (e.category === 'quality' ? onSelect(e.id) : openEvent(e.id))} />;
}

function RecordStatesBlock({ rec }: { rec: QualityInspection }) {
  const states = useSimValue((s) => contextStates(s, rec), [rec]);
  return <RecordStates states={states} time={rec.time} />;
}

function RecordRulesBlock({ rec }: { rec: QualityInspection }) {
  const rules = useSimValue((s) => ruleChecks(s, { time: rec.time, rec }), [rec]);
  return (
    <ul className="qd-plain qd-rules">
      {rules.map((r) => (
        <li key={r.id} className={r.over ? 'over' : ''}>
          <span className="mono">{r.id}</span> {r.label}: <b className="num">{r.value ?? '—'}</b> <span className="muted">({r.threshold})</span>
          {r.over && <span className="qd-met"> condition met</span>}
          {r.value == null && r.note && <span className="muted"> · {r.note}</span>}
        </li>
      ))}
    </ul>
  );
}
