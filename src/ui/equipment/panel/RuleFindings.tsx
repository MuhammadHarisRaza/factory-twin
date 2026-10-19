/**
 * The rule engine's findings for a scope (src/intel/rules findingsFor): what fired, what recently cleared, what
 * could not be evaluated and why, and how many rules were checked with no issue. A fired finding shows its severity
 * (icon + word), title, classification ('Rule-based' / 'Statistical' — never AI), the first sentence of its
 * explanation (the rest behind "Details"), its measurements with their windows, the confidence, the next check,
 * evidence links (signal row, chart over the finding's window, event record), the provenance and since when.
 */
import { useState } from 'react';
import { Activity, ArrowRight, ChartLine, ChevronDown, FileText, Gauge, ListChecks } from 'lucide-react';
import type { Window } from '../../../calc/types';
import { CLASSIFICATION_LABEL, type Evidence, type Measurement, type RuleFinding } from '../../../intel/rules/types';
import { formatClock } from '../../../sim/time';
import { SEVERITY } from '../../kit/Status';
import { splitObserved } from './Insights';

const span = (w: Window) => `${formatClock(w.from)}–${formatClock(w.to)}`;
const NF = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/** "1,152 °C · 09:10–10:10", "Unavailable" for a measurement without a value (never a zero). */
export function measurementText(m: Measurement): string {
  const v = m.value == null ? 'no value' : typeof m.value === 'number' ? `${NF.format(m.value).replace(/^-/, '−')}${m.unit ? ` ${m.unit}` : ''}` : `${m.value}${m.unit ? ` ${m.unit}` : ''}`;
  const when = m.window ? ` · ${span(m.window)}` : m.at != null ? ` · at ${formatClock(m.at)}` : '';
  return `${m.label} ${v}${when}`;
}

const CONFIDENCE: Record<RuleFinding['confidence'], string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
const EV_ICON = { signal: Activity, event: FileText, chart: ChartLine, metric: Gauge, rule: ListChecks } as const;

/** The findings grouped as the panel shows them. */
export function groupFindings(findings: RuleFinding[]) {
  const fired = findings.filter((f) => f.status === 'fired');
  const resolved = findings.filter((f) => f.status === 'clear' && f.resolvedAt != null);
  const notEvaluated = findings.filter((f) => f.status === 'insufficient-data');
  const clear = findings.filter((f) => f.status === 'clear' && f.resolvedAt == null);
  return { fired, resolved, notEvaluated, clearRules: new Set(clear.map((f) => f.ruleId)).size };
}

type Links = { onSignal: (id: string) => void; onChart: (id: string, window: Window | null) => void; onEvent: (id: string) => void; hasSignal?: (id: string) => boolean };

function EvidenceLink({ e, f, links }: { e: Evidence; f: RuleFinding; links: Links }) {
  const Icon = EV_ICON[e.kind];
  const ref = e.ref;
  const act =
    ref && e.kind === 'signal' && (!links.hasSignal || links.hasSignal(ref))
      ? () => links.onSignal(ref)
      : ref && e.kind === 'chart'
        ? () => links.onChart(ref, e.window ?? f.window)
        : ref && e.kind === 'event'
          ? () => links.onEvent(ref)
          : null;
  if (!act)
    return (
      <li>
        <span className="eqp-chip" title={ref}>
          <Icon size={11} aria-hidden />
          {e.label}
        </span>
      </li>
    );
  return (
    <li>
      <button type="button" className="eqp-chip link" onClick={act} title={`${e.kind === 'chart' ? 'Show the chart' : e.kind === 'event' ? 'Open the event' : 'Show the signal'} ${ref}${e.window ? ` · ${span(e.window)}` : ''}`}>
        <Icon size={11} aria-hidden />
        {e.label}
      </button>
    </li>
  );
}

function Finding({ f, links, now }: { f: RuleFinding; links: Links; now: number }) {
  const [open, setOpen] = useState(false);
  const sev = SEVERITY[f.severity];
  const Icon = sev.icon;
  const { head, rest } = splitObserved(f.explanation);
  const detailsId = `eqp-rf-${f.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  // A chart link the evidence lacks, from the finding's own chart reference.
  const evidence = f.chartRef && !f.evidence.some((e) => e.kind === 'chart') ? [...f.evidence, { kind: 'chart' as const, label: 'Chart', ref: f.chartRef, window: f.window ?? undefined }] : f.evidence;
  return (
    <article className={`eqp-ins eqp-rf ${sev.tone}`} data-finding={f.key} aria-label={`${sev.label}: ${f.title}`}>
      <header className="eqp-ins-h">
        <span className={`status ${sev.tone} eqp-sev`}>
          <Icon size={13} strokeWidth={2.2} aria-hidden />
          {sev.label}
        </span>
        <h4>{f.title}</h4>
        <span className="eqp-basis" title={`${CLASSIFICATION_LABEL[f.classification]} rule ${f.ruleId} evaluated on simulated data — not a prediction or a trained model.`}>
          {CLASSIFICATION_LABEL[f.classification]}
        </span>
      </header>
      <p className="obs">{head}</p>
      {rest && (
        <div className="eqp-ins-d" id={detailsId} hidden={!open}>
          <p className="obs">{rest}</p>
        </div>
      )}
      {f.measurements.length > 0 && (
        <ul className="eqp-chips eqp-meas" aria-label="Measurements">
          {f.measurements.slice(0, 4).map((m, i) => (
            <li key={`${m.label}:${i}`}>
              <span className="eqp-chip num">{measurementText(m)}</span>
            </li>
          ))}
        </ul>
      )}
      {evidence.length > 0 && (
        <ul className="eqp-chips" aria-label="Evidence">
          {evidence.slice(0, 5).map((e, i) => (
            <EvidenceLink key={`${e.kind}:${e.ref ?? e.label}:${i}`} e={e} f={f} links={links} />
          ))}
        </ul>
      )}
      {f.next && (
        <p className="next">
          <ArrowRight size={13} aria-hidden />
          <span>
            <b>Next check</b> {f.next}
          </span>
        </p>
      )}
      <p className="eqp-rf-m">
        <span title={f.confidenceNote}>{CONFIDENCE[f.confidence]}</span>
        {f.firstSeen != null && <span> · since {formatClock(f.firstSeen)}</span>}
        <span title={f.provenance.note}>
          {' '}
          · {f.provenance.source === 'connected' ? 'Connected data' : 'Simulated data'} · rule {f.ruleId}
          {f.provenance.scenarioId ? ` · scenario ${f.provenance.scenarioId}` : ''}
        </span>
        {f.lastSeen != null && f.lastSeen < now - 1 && <span> · last seen {formatClock(f.lastSeen)}</span>}
      </p>
      {rest && (
        <button type="button" className="eqp-ins-more" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'Details'}
          <ChevronDown size={12} aria-hidden className="chev" />
        </button>
      )}
    </article>
  );
}

export function RuleFindings({
  findings,
  now,
  onSignal,
  onChart,
  onEvent,
  hasSignal,
  showFired = true,
}: {
  findings: RuleFinding[];
  now: number;
  onSignal: (id: string) => void;
  onChart: (id: string, window: Window | null) => void;
  onEvent: (id: string) => void;
  hasSignal?: (id: string) => boolean;
  /** False when the fired findings are shown elsewhere (only resolved / not evaluated / checked here). */
  showFired?: boolean;
}) {
  const [nev, setNev] = useState(false);
  const g = groupFindings(findings);
  const links: Links = { onSignal, onChart, onEvent, hasSignal };
  if (!findings.length) return <p className="eqp-rf-none">No detection rule applies to this asset.</p>;
  return (
    <div className="eqp-rfs">
      {showFired && g.fired.map((f) => <Finding key={f.key} f={f} links={links} now={now} />)}
      {g.resolved.length > 0 && (
        <div className="eqp-rf-sub">
          <h4>Recently resolved</h4>
          <ul>
            {g.resolved.map((f) => (
              <li key={f.key} title={f.explanation}>
                <span className="status good">{CLASSIFICATION_LABEL[f.classification]}</span> {f.title}
                <span className="num"> · cleared {formatClock(f.resolvedAt!)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {g.notEvaluated.length > 0 && (
        <div className="eqp-rf-sub">
          <button type="button" className="eqp-nm-b" aria-expanded={nev} onClick={() => setNev(!nev)}>
            <span>
              <b>Not evaluated ({g.notEvaluated.length})</b> — insufficient data
            </span>
            <ChevronDown size={13} aria-hidden className="chev" />
          </button>
          {nev && (
            <ul>
              {g.notEvaluated.map((f) => (
                <li key={f.key}>
                  <b>{f.title}</b> <span className="muted">· rule {f.ruleId}</span>
                  {f.missingSignals.length > 0 && <div className="muted">Missing: {f.missingSignals.map((m) => `${m.name} (${m.reason})`).join('; ')}</div>}
                  {f.staleSignals.length > 0 && (
                    <div className="muted">Stale: {f.staleSignals.map((m) => `${m.name}${m.since != null ? ` since ${formatClock(m.since)}` : ' (never received)'}`).join('; ')}</div>
                  )}
                  {!f.missingSignals.length && !f.staleSignals.length && <div className="muted">{f.explanation}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="eqp-rf-none">
        {g.clearRules > 0 ? `${g.clearRules} rule${g.clearRules === 1 ? '' : 's'} checked with no issue` : 'No rule checked clear'}
        {g.fired.length === 0 && ' · no rule finding needs attention'} · rule-based and statistical checks on simulated data
      </p>
    </div>
  );
}
