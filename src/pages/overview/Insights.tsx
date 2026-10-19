/**
 * Operational insights: the top plant-wide rule findings (src/intel/rules) as a compact feed — severity,
 * title, Rule-based / Statistical, one line of evidence, where, since when — with the counts by severity and
 * a family filter. Each finding opens where it continues (the equipment in the Factory Twin, a stage, Quality).
 * Rule findings are evaluations of the simulated signals; the event records stay in "Issues requiring attention".
 */
import { useState } from 'react';
import { ArrowRight, Inbox } from 'lucide-react';
import { openEquipment, openStage, openView } from '../../app/store';
import { livePlantFindings } from '../../intel/rules';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { EmptyState, ProvenanceBadge, Section } from '../../ui/kit/Page';
import { Segmented } from '../../ui/kit/Panel';
import { SEVERITY, SeverityBadge, StatusBadge } from '../../ui/kit/Status';
import { INSIGHTS_TOP, insightFeed, type InsightFilter, type InsightRow, type InsightTarget } from './findings';


export const INSIGHTS_ID = 'ov-insights';

function follow(t: InsightTarget) {
  if (t.kind === 'equipment') openEquipment(t.equipmentId);
  else if (t.kind === 'stage') openStage(t.stageId);
  else openView(t.workspace, t.tab);
}

function InsightItem({ r }: { r: InsightRow }) {
  const confidence = r.confidence === 'high' ? null : `${r.confidence} confidence`;
  return (
    <li className={`ov-in sev-${r.severity}`}>
      <div className="ov-in-top">
        <SeverityBadge severity={r.severity} />
        <span className="tag" title={r.classification === 'Statistical' ? 'Decided by a significance test on the simulated data' : 'Decided by a configured threshold or limit'}>
          {r.classification}
        </span>
        <span className="ov-in-fam">{r.familyLabel}</span>
        {r.scenario && <ProvenanceBadge kind="scenario" />}
        <span className="ov-in-id mono">{r.ruleId}</span>
      </div>
      <h4 className="ov-in-title">{r.title}</h4>
      <p className="ov-in-line" title={r.explanation}>
        {r.line}
      </p>
      <div className="ov-in-foot">
        <span className="ov-in-where">
          {r.where}
          {r.since && <span className="num"> · {r.since}</span>}
          {confidence && (
            <span className="muted" title={r.confidenceNote}>
              {' '}
              · {confidence}
            </span>
          )}
        </span>
        <button type="button" className="row-link" onClick={() => follow(r.target)} title={r.next ? `Next check: ${r.next}` : undefined}>
          {r.target.label}
          <ArrowRight size={12} aria-hidden />
        </button>
      </div>
    </li>
  );
}

export function InsightsPanel() {
  const [filter, setFilter] = useState<InsightFilter>('all');
  // The live evaluation (re-run at most every few simulated minutes, at once on a material change); the subtitle says when.
  const d = useSimValue((s) => insightFeed(s, filter, INSIGHTS_TOP, livePlantFindings(s, INSIGHTS_TOP)), [filter]);

  const options = [{ value: 'all' as InsightFilter, label: `All ${d.firedTotal}` }, ...d.byFamily.map((f) => ({ value: f.family as InsightFilter, label: `${f.label} ${f.count}` }))];
  return (
    <Section
      id={INSIGHTS_ID}
      className="ov-insights"
      title={
        <>
          Operational insights
          {d.firedTotal > 0 && <span className="ov-count num">{d.firedTotal}</span>}
        </>
      }
      subtitle={`Rule findings plant-wide · thresholds (Rule-based) and significance tests (Statistical) on simulated signals · evaluated ${formatClock(d.at)}`}
      actions={
        <button type="button" className="btn ghost sm" onClick={() => openView('events', 'rules')} title="Open the detection rules and their thresholds in Events & Reports">
          Detection rules
          <ArrowRight size={12} aria-hidden />
        </button>
      }
      flush
    >
      {d.firedTotal > 0 && (
        <div className="ov-in-bar">
          <span className="ov-in-sev" aria-label="Findings by severity">
            {d.bySeverity.map((x) => (
              <span key={x.severity} className="ov-in-sevc">
                <StatusBadge {...SEVERITY[x.severity]} label={`${SEVERITY[x.severity].label} ${x.count}`} />
              </span>
            ))}
          </span>
          {options.length > 2 && (
            <span className="ov-in-filter">
              <Segmented<InsightFilter> label="Filter the findings by rule family" value={d.filter} options={options} onChange={setFilter} />
            </span>
          )}
        </div>
      )}
      {d.rows.length === 0 ? (
        <EmptyState icon={Inbox} title="No rule finding needs attention">
          {d.evaluated} checks evaluated on the simulated signals at {formatClock(d.at)}
          {d.notEvaluated > 0 ? `; ${d.notEvaluated} not evaluated for lack of data (measurements not modelled or not current)` : ''}. A check that has not fired is
          not proof that no fault exists.
        </EmptyState>
      ) : (
        <>
          <ol className="ov-ins">
            {d.rows.map((r) => (
              <InsightItem key={r.key} r={r} />
            ))}
          </ol>
          <div className="ov-iss-foot muted">
            {d.rows.length < d.fired ? `${d.rows.length} of ${d.fired} shown (most severe, most recent first)` : `${d.fired} shown`} · {d.evaluated} checks evaluated
            {d.notEvaluated > 0 && (
              <span title="Checks whose required signals are not modelled, unavailable, not current or flagged bad give no verdict">
                {' '}
                · {d.notEvaluated} not evaluated (insufficient data)
              </span>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
