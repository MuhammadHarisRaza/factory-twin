/**
 * Compact list of rule-engine findings (src/intel/rules) for the Reliability and Data & connectivity tabs:
 * severity (or "Not evaluated") as icon + words, the title, the evidence-backed explanation, where and since
 * when, how it was decided (Rule-based / Statistical), the confidence, the next check, and — when a rule could
 * not be evaluated — the signals it needs and why. Findings are evaluations on simulated data, not events.
 */
import { CircleHelp } from 'lucide-react';
import { openEquipment, openEvent } from '../../app/store';
import { CLASSIFICATION_LABEL, FINDING_STATUS_LABEL, type RuleFinding } from '../../intel/rules';
import { STAGE_BY_NO } from '../../model/catalog';
import { formatDateTime } from '../../sim/time';
import { EmptyState } from '../../ui/kit/Page';
import { SeverityBadge, StatusBadge } from '../../ui/kit/Status';
import { assetName } from './reliability';

const CONFIDENCE_LABEL: Record<RuleFinding['confidence'], string> = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

function ScopeLabel({ f }: { f: RuleFinding }) {
  const sc = f.scope;
  if (sc.kind === 'equipment')
    return (
      <button className="row-link" onClick={() => openEquipment(sc.equipmentId)} title="Open the equipment panel in the Factory Twin">
        {sc.equipmentId} · {assetName(sc.equipmentId)}
      </button>
    );
  if (sc.kind === 'stage') return <span>Stage {sc.stageNo} · {STAGE_BY_NO[sc.stageNo]?.name}</span>;
  return <span>Whole plant</span>;
}

export function FindingList({ findings, empty, limit }: { findings: RuleFinding[]; empty: string; limit?: number }) {
  if (!findings.length) return <EmptyState title={empty} />;
  const rows = limit ? findings.slice(0, limit) : findings;
  return (
    <ul className="fd-list">
      {rows.map((f) => {
        const events = f.evidence.filter((e) => e.kind === 'event' && e.ref).slice(0, 2);
        return (
          <li key={f.key} className="fd">
            <div className="fd-h">
              {f.status === 'fired' ? <SeverityBadge severity={f.severity} /> : <StatusBadge tone="neutral" icon={CircleHelp} label={FINDING_STATUS_LABEL[f.status]} />}
              <b className="fd-title">{f.title}</b>
              <span className="tag">{CLASSIFICATION_LABEL[f.classification]}</span>
            </div>
            <p className="fd-x">{f.explanation}</p>
            <div className="fd-meta">
              <ScopeLabel f={f} />
              {f.firstSeen != null && <span>since {formatDateTime(f.firstSeen)}</span>}
              <span title={f.confidenceNote}>{CONFIDENCE_LABEL[f.confidence]}</span>
              <span title={f.provenance.note}>{f.provenance.source === 'simulated' ? 'Simulated data' : 'Source verified'}</span>
              {events.map((e) => (
                <button key={e.ref} className="row-link" onClick={() => openEvent(e.ref!)} title={e.label}>
                  {e.ref}
                </button>
              ))}
            </div>
            {f.missingSignals.length > 0 && (
              <ul className="fd-missing" aria-label="Signals the rule needs">
                {f.missingSignals.slice(0, 4).map((m) => (
                  <li key={m.signalId}>
                    <span className="mono">{m.signalId}</span> — {m.reason}
                  </li>
                ))}
              </ul>
            )}
            {f.next && <p className="fd-next">Next check: {f.next}</p>}
          </li>
        );
      })}
      {limit && findings.length > limit && <li className="fd-more muted">{findings.length - limit} more not shown</li>}
    </ul>
  );
}
