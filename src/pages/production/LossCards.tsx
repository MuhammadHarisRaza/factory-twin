import { ArrowRight, FileText, Microscope } from 'lucide-react';
import { openDefect, openEvent, openStage, useApp } from '../../app/store';
import { assumptionList } from '../../sim/finance';
import { Disclosure, EmptyState } from '../../ui/kit/Page';
import { SourceTag } from '../../ui/kit/Status';
import { fmt1, fmtInt } from '../../ui/kit/format';
import { EstTag } from './common';
import { fmtMoney } from './loss';
import type { LossItem } from './lossItems';

/**
 * The largest losses as cards, most important first: category, affected stage, duration or lost
 * units, estimated value (with its basis), the related event record and a suggested investigation.
 */
export function LossCards({ items, limit = 3, mode, empty }: { items: LossItem[]; limit?: number; mode: 'capacity' | 'oee'; empty: string }) {
  const cur = useApp((s) => s.finance.currency);
  const shown = items.slice(0, limit);
  if (!shown.length) return <EmptyState title={empty} />;
  return (
    <ol className="prod-losses">
      {shown.map((l, i) => (
        <li key={l.key} className="prod-loss-card">
          <header className="prod-loss-h">
            <span className="prod-rank" aria-label={`Rank ${i + 1}`}>
              {i + 1}
            </span>
            <h4>{l.category}</h4>
            <span className="prod-loss-val">
              {l.value != null ? (
                <>
                  <b className="num">≈ {fmtMoney(l.value, cur)}</b>
                  <EstTag />
                </>
              ) : (
                <span className="muted">Not valued</span>
              )}
            </span>
          </header>
          <div className="prod-loss-qty">
            {l.minutesLabel && <span className="num">{l.minutesLabel}</span>}
            <span className="num">
              {fmtInt(l.m2)} m² <span className="muted">· {fmtInt(l.tiles)} tiles</span>
            </span>
            {mode === 'oee' && l.pts != null && <span className="num">{fmt1(l.pts)} pts of OEE</span>}
          </div>
          <div className="prod-loss-where">
            {l.stage ? (
              <button type="button" className="row-link" onClick={() => openStage(l.stage!)} title={`Open the ${l.stageName} stage view`}>
                {l.stageName}
              </button>
            ) : (
              <span>{l.stageName}</span>
            )}
            <span className="muted"> · {l.where}</span>
          </div>
          {l.facts.length > 0 && (
            <ul className="prod-loss-facts">
              {l.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          <div className="prod-loss-ev">
            {l.event ? (
              <>
                <button type="button" className="row-link" onClick={() => openEvent(l.event!.id)} title="Open the event report and its evidence">
                  <FileText size={12} aria-hidden /> <span className="mono">{l.event.id}</span> {l.event.title}
                </button>
                <SourceTag source={l.event.source} />
              </>
            ) : (
              <span className="muted">{l.eventNote}</span>
            )}
          </div>
          <p className="prod-loss-inv">
            <b>Investigate:</b> {l.investigation}
          </p>
          {l.quality && (
            <button type="button" className="btn sm ghost prod-loss-link" onClick={() => (l.event ? openDefect(l.event.id) : useApp.getState().go('quality'))}>
              <Microscope size={12} aria-hidden /> {l.event ? 'Defect evidence' : 'Quality & Defects'} <ArrowRight size={11} aria-hidden />
            </button>
          )}
          {l.lines.length > 0 && (
            <Disclosure title="How the estimate is calculated">
              <ul className="prod-loss-basis">
                {l.lines.map((x) => (
                  <li key={x.label}>
                    <b>
                      {x.label}: {fmtMoney(x.amount, cur)}
                    </b>{' '}
                    — {x.basis}
                  </li>
                ))}
                <li className="muted">{l.valueNote}.</li>
              </ul>
            </Disclosure>
          )}
          {l.value == null && <p className="prod-loss-basis muted">{l.valueNote}.</p>}
        </li>
      ))}
    </ol>
  );
}

/** The financial assumptions behind every estimate on the page, disclosed in one line with a way to edit them. */
export function FinanceNote({ onEdit }: { onEdit: () => void }) {
  const f = useApp((s) => s.finance);
  const list = assumptionList(f).slice(0, 3);
  return (
    <div className="prod-fin-note">
      <EstTag />
      <span>
        {list.join(' ')} Illustrative values, not ERP data; estimates are never savings.{' '}
        <button type="button" className="row-link" onClick={onEdit}>
          Edit assumptions
        </button>
      </span>
    </div>
  );
}
