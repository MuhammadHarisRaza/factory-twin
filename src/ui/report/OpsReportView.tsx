/**
 * In-app preview of an operational report (shift, OEE, quality, vehicles). Renders the OpsReport
 * model (src/report/ops) block by block — the PDF export (src/report/ops/pdf.ts) arranges the very
 * same object, so the preview and the document never differ. Every section says what kind of
 * information it holds (measured in simulation / simulated / estimated / illustrative).
 * Long event tables show their first rows with "Show all" (the PDF prints every row), and the
 * report's events can be opened as the same list in the Events tab.
 */
import { useId, useState, type ReactNode } from 'react';
import { CircleDashed, Calculator, Gauge, Image as ImageIcon, ListFilter } from 'lucide-react';
import { openFleetVehicle, openStage } from '../../app/store';
import { openEventRecord } from '../events/open';
import type { KpiModel } from '../../intel/kpis';
import { snapshotImage } from '../../report/images';
import { EVENT_CATEGORY_LABEL } from '../../sim/events';
import { SIGNIFICANT_LABEL } from '../../report/ops/select';
import { BASIS_LABEL, LEGEND, type Basis, type OpsReport, type ReportBlock, type ReportCell, type ReportEventQuery, type ReportEvidenceItem } from '../../report/ops/types';
import { useSim } from '../../sim/store';
import { LineChart, type LineSeries } from '../kit/charts';
import { KpiCard, KpiRow, ProvenanceBadge, kpiCardProps as sharedKpiCardProps } from '../kit/Page';
import { useInspectionImage } from './evidence';
import { Unavailable } from './parts';
import './ops.css';

const BASIS_ICON: Record<Basis, typeof Gauge> = { measured: Gauge, simulated: CircleDashed, estimated: Calculator, illustrative: ImageIcon };

/** Kind-of-information tag (icon + words; never colour alone). */
export function BasisTag({ basis, label }: { basis: Basis; label?: string }) {
  const Icon = BASIS_ICON[basis];
  const def = LEGEND.find((l) => l.basis === basis);
  return (
    <span className={`orp-basis orp-basis-${basis}`} title={def?.text}>
      <Icon size={11} strokeWidth={2.2} aria-hidden />
      {label ?? BASIS_LABEL[basis]}
    </span>
  );
}

/** KpiModel (src/intel/kpis.ts) → KpiCard props — the shared mapping of the kit (status icon, stale provenance). */
export const kpiCardProps = (k: KpiModel) => sharedKpiCardProps(k);

export type ReportLinks = {
  onEvent?: (id: string) => void;
  onStage?: (id: NonNullable<Extract<ReportCell, object>['stage']>) => void;
  onVehicle?: (id: string) => void;
  /** Opens the Events tab listing exactly the report's events (no button is shown without it). */
  onEvents?: (q: ReportEventQuery) => void;
};

function Cell({ c, links }: { c: ReportCell; links: ReportLinks }) {
  if (typeof c === 'string') return <>{c}</>;
  if (c.eventId)
    return (
      <button className="row-link mono" onClick={() => (links.onEvent ?? openEventRecord)(c.eventId!)} title={`Open ${c.eventId} in the Events tab`}>
        {c.text}
      </button>
    );
  if (c.stage)
    return (
      <button className="row-link" onClick={() => (links.onStage ?? openStage)(c.stage!)} title="Open the stage in Production">
        {c.text}
      </button>
    );
  if (c.vehicleId)
    return (
      <button className="row-link" onClick={() => (links.onVehicle ?? openFleetVehicle)(c.vehicleId!)} title="Open the vehicle in Fleet & Movement">
        {c.text}
      </button>
    );
  return <>{c.text}</>;
}

function EvidenceFigure({ x }: { x: ReportEvidenceItem }) {
  const ev = useSim((s) => s.sim.evidence.find((e) => e.id === x.evidenceId) ?? null);
  const rec = useSim((s) => (x.inspectionId ? (s.sim.inspections.find((r) => r.id === x.inspectionId) ?? null) : null));
  const snap = x.kind === 'camera-snapshot' && ev ? snapshotImage(ev) : null;
  const frame = useInspectionImage(x.kind === 'inspection-image' ? rec : null, x.kind === 'inspection-image' && !!rec, 240);
  const live = x.kind === 'camera-snapshot' && x.provenance.origin === 'live-camera';
  let body: ReactNode;
  if (x.kind === 'camera-snapshot')
    body = snap ? (
      <img src={snap.dataUrl} width={snap.width} height={snap.height} alt={live ? `Camera frame from the configured camera stream, captured with ${x.eventId}` : `Digital-twin render captured with ${x.eventId}`} />
    ) : (
      <Unavailable reason={live ? 'The camera frame is no longer held in this browser session' : 'The rendered image is no longer held in this browser session'} />
    );
  else if (frame.status === 'ready') body = <img src={frame.url!} width={240} height={240} alt={`Illustrative frame of inspection record ${x.inspectionId}, annotated`} />;
  else if (frame.status === 'loading') body = <Unavailable pending reason="Drawing the illustrative frame…" />;
  else body = <Unavailable reason={rec ? 'The illustrative frame could not be drawn' : 'Inspection record no longer retained'} />;
  return (
    <figure className={`orp-fig ${x.kind === 'camera-snapshot' ? 'snap' : 'frame'}`}>
      <figcaption className="orp-fig-t">{x.title}</figcaption>
      {body}
      <div className="orp-cap">
        {x.caption.map((c, i) => (
          <span key={i} className={i === x.caption.length - 1 ? 'orp-cap-prov' : undefined}>
            {c}
          </span>
        ))}
      </div>
    </figure>
  );
}

type TableBlockModel = Extract<ReportBlock, { kind: 'table' }>;

/** A report table; a long one shows its first `collapseAfter` rows and a "Show all" control. */
function TableBlock({ b, links }: { b: TableBlockModel; links: ReportLinks }) {
  const [all, setAll] = useState(false);
  const id = useId();
  if (!b.rows.length) return <p className="orp-muted">{b.empty ?? 'No rows'}</p>;
  const cap = b.collapseAfter != null && b.rows.length > b.collapseAfter ? b.collapseAfter : null;
  const rows = cap != null && !all ? b.rows.slice(0, cap) : b.rows;
  return (
    <>
      <div className="orp-table-wrap" id={id}>
        <table className="rp-table orp-table">
          <thead>
            <tr>
              {b.head.map((h, i) => (
                <th key={i} className={b.align?.[i] === 'r' ? 'n' : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={b.align?.[j] === 'r' ? 'n' : undefined}>
                    <Cell c={c} links={links} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {b.foot && (
            <tfoot>
              <tr>
                {b.foot.map((c, i) => (
                  <td key={i} className={b.align?.[i] === 'r' ? 'n' : undefined}>
                    {c}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {cap != null && (
        <div className="orp-more">
          <span className="orp-muted">{all ? `All ${b.rows.length} rows shown` : `${cap} of ${b.rows.length} rows shown — the PDF lists all ${b.rows.length}`}</span>
          <button type="button" className="btn sm ghost" aria-expanded={all} aria-controls={id} onClick={() => setAll(!all)}>
            {all ? `Show the first ${cap}` : `Show all ${b.rows.length}`}
          </button>
        </div>
      )}
    </>
  );
}

/** "Open these events in the Events tab" — the same list, by the same rule (period, categories, stage, significance). */
function EventsLink({ count, query, links }: { count: number; query: ReportEventQuery; links: ReportLinks }) {
  if (!links.onEvents) return null;
  const open = links.onEvents;
  return (
    <div className="orp-more">
      <button type="button" className="btn sm" onClick={() => open(query)} title={`Events tab filtered to this report: its period, ${SIGNIFICANT_LABEL.toLowerCase()}${query.categories ? `, ${query.categories.map((c) => EVENT_CATEGORY_LABEL[c]).join(' / ')}` : ''}${query.stage ? `, stage ${query.stage}` : ''}`}>
        <ListFilter size={13} aria-hidden />
        Open these {count} event{count === 1 ? '' : 's'} in the Events tab
      </button>
    </div>
  );
}

function Block({ b, links }: { b: ReportBlock; links: ReportLinks }) {
  switch (b.kind) {
    case 'kpis':
      return (
        <>
          <KpiRow label="Report KPIs">
            {b.items.map((k) => (
              <KpiCard key={k.id} {...kpiCardProps(k)} />
            ))}
          </KpiRow>
          {b.note && <p className="orp-muted">{b.note}</p>}
        </>
      );
    case 'kv':
      return (
        <dl className="orp-kv">
          {b.rows.map(([k, v], i) => (
            <div key={i}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      );
    case 'table':
      return <TableBlock b={b} links={links} />;
    case 'events-link':
      return <EventsLink count={b.count} query={b.query} links={links} />;
    case 'bars': {
      const max = Math.max(1e-9, ...b.rows.map((r) => r.value));
      return (
        <div className="orp-bars">
          <div className="orp-bars-t">
            {b.title} <span className="muted">({b.unit})</span>
          </div>
          {b.rows.length ? (
            b.rows.map((r, i) => (
              <div key={i} className="orp-bar">
                <span className="orp-bar-l">{r.label}</span>
                <span className="orp-bar-track" aria-hidden>
                  <span style={{ width: `${(Math.max(0, r.value) / max) * 100}%` }} />
                </span>
                <span className="orp-bar-v num">{r.display}</span>
                <span className="orp-bar-n">{r.note}</span>
              </div>
            ))
          ) : (
            <p className="orp-muted">{b.empty ?? 'No values'}</p>
          )}
        </div>
      );
    }
    case 'chart': {
      const c = b.chart;
      const series: LineSeries[] = c.series.map((sr, i) => ({ id: `s${i}`, label: sr.label, color: sr.dashed ? 'var(--text-2)' : 'var(--series-1)', points: sr.values, dashed: sr.dashed }));
      const has = c.series.some((sr) => sr.values.some((v) => v != null));
      const max = Math.max(1, ...c.series.flatMap((sr) => sr.values.filter((v): v is number => v != null)), c.limit?.value ?? 0);
      const fmt = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: max < 10 ? 1 : 0 });
      return (
        <div className="orp-chart">
          <div className="orp-chart-q">{c.question}</div>
          <div className="orp-chart-h">
            <span className="orp-chart-t">
              {c.title} <span className="muted">({c.unit})</span>
            </span>
            {series.length > 1 && (
              <span className="orp-legend">
                {series.map((sr) => (
                  <span key={sr.id}>
                    <i className={sr.dashed ? 'dash' : ''} aria-hidden /> {sr.label}
                  </span>
                ))}
              </span>
            )}
          </div>
          {has ? (
            <LineChart labels={c.labels} series={series} height={180} format={fmt} tickEvery={Math.max(1, Math.ceil(c.labels.length / 8))} reference={c.limit ? { value: c.limit.value, label: c.limit.label } : undefined} />
          ) : (
            <Unavailable reason="No samples in the period yet — chart omitted" />
          )}
        </div>
      );
    }
    case 'text':
      return <p className={b.tone === 'muted' ? 'orp-muted' : 'orp-text'}>{b.text}</p>;
    case 'list':
      return b.numbered ? (
        <ol className="rp-recs">
          {b.items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ol>
      ) : (
        <ul className="rp-list">
          {b.items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      );
    case 'subhead':
      return <h4 className="rp-sub">{b.text}</h4>;
    case 'missing':
      return <Unavailable title={b.title} reason={b.reason} />;
    case 'total':
      return (
        <div className="orp-total">
          <div className="orp-total-h">
            <span>{b.label}</span>
            <b className="num">{b.value}</b>
            <ProvenanceBadge kind="estimate" />
          </div>
          {b.note && <p className="orp-muted">{b.note}</p>}
        </div>
      );
    case 'evidence':
      return (
        <div className="orp-figs">
          {b.items.map((x) => (
            <EvidenceFigure key={x.evidenceId} x={x} />
          ))}
        </div>
      );
  }
}

/** The legend of the four kinds of information (shown with every report). */
export function ReportLegend({ compact = false }: { compact?: boolean }) {
  return compact ? (
    <div className="orp-legend-row" aria-label="Kinds of information in this report">
      {LEGEND.map((l) => (
        <BasisTag key={l.basis} basis={l.basis} />
      ))}
    </div>
  ) : (
    <dl className="orp-legend-full">
      {LEGEND.map((l) => (
        <div key={l.basis}>
          <dt>
            <BasisTag basis={l.basis} />
          </dt>
          <dd>{l.text}</dd>
        </div>
      ))}
    </dl>
  );
}

export function OpsReportView({ report: r, links = {} }: { report: OpsReport; links?: ReportLinks }) {
  return (
    <article className="orp" aria-label={`${r.typeLabel} report preview`}>
      <header className="orp-head">
        <div className="orp-kicker">
          <span>{r.typeLabel}</span>
          <ProvenanceBadge kind="simulated" />
        </div>
        <h2 className="orp-title">{r.title}</h2>
        <p className="orp-summary">{r.summary}</p>
        <dl className="orp-meta">
          <div>
            <dt>Reporting period</dt>
            <dd>
              {r.period.label} · {r.period.text}
            </dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>{r.scope.label}</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>{r.generatedAtPlant}</dd>
          </div>
        </dl>
        <ReportLegend compact />
      </header>
      {r.sections.map((sec, i) => (
        <section key={sec.id} className="orp-sec" aria-labelledby={`orp-${sec.id}`}>
          <header className="orp-sec-h">
            <span className="rp-n num">{i + 1}</span>
            <h3 id={`orp-${sec.id}`}>{sec.title}</h3>
            {sec.basis && <BasisTag basis={sec.basis} label={sec.tag} />}
          </header>
          <div className="orp-sec-b">
            {sec.blocks.map((b, j) => (
              <Block key={j} b={b} links={links} />
            ))}
          </div>
        </section>
      ))}
      <section className="orp-sec" aria-labelledby="orp-legend">
        <header className="orp-sec-h">
          <span className="rp-n num">{r.sections.length + 1}</span>
          <h3 id="orp-legend">How to read this report · data provenance</h3>
        </header>
        <div className="orp-sec-b">
          <ReportLegend />
          <p className="orp-muted">{r.disclaimer}</p>
        </div>
      </section>
    </article>
  );
}
