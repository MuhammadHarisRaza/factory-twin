import { ChartLine, CircleCheck, ClipboardList, Locate, OctagonX, TriangleAlert } from 'lucide-react';
import { openEquipment, openEvent } from '../../app/store';
import type { EnergyRow, Period } from '../../sim/metrics';
import { Panel } from '../../ui/kit/Panel';
import { EventStatusBadge, SourceTag, StatusBadge } from '../../ui/kit/Status';
import { fmtInt } from '../../ui/kit/format';
import { ConsumerType, DevBadge } from './badges';
import { MONTH_HOURS, fmtMoney, fmtSigned, largestDeviation, type AnomalyRow } from './derive';

/**
 * Consumers deviating more than 8 % from the energy model (period or last hour): how far,
 * what it costs now and per month if sustained, what to check, where it is, and the
 * energy-deviation event it raised (opened in Events & Reports — the same record as the PDF).
 */
export function AnomalyPanel({
  rows,
  all,
  period,
  recent,
  currency,
  scenarioIds,
  onTrend,
}: {
  rows: AnomalyRow[];
  all: EnergyRow[];
  period: Period;
  recent: Period;
  currency: string;
  /** Consumers with an active simulated energy-anomaly input. */
  scenarioIds: string[];
  onTrend: (id: string) => void;
}) {
  const top = largestDeviation(all);
  const ongoing = rows.filter((r) => r.active).length;
  return (
    <Panel
      title="Energy anomalies"
      subtitle={`Consumers more than ±8 % from the energy model · ${period.label} and last hour (${recent.label.toLowerCase()})`}
      actions={
        rows.length ? (
          <span className="en-count">
            {rows.length} flagged{ongoing ? ` · ${ongoing} ongoing` : ''}
          </span>
        ) : null
      }
      footer={
        <span>
          Excess cost per hour uses the last-hour rate; the monthly figure assumes that rate continues for {MONTH_HOURS} h (continuous three-shift operation).
          Recommendations are rule-based.
        </span>
      }
    >
      {rows.length === 0 ? (
        <div className="empty en-empty">
          <CircleCheck size={22} className="en-ok" aria-hidden />
          <b>All consumers within ±8 % of the model</b>
          {top ? (
            <span>
              Largest deviation in the period: {top.label} {fmtSigned(top.deviation)}
            </span>
          ) : (
            <span>No consumption recorded in this period yet</span>
          )}
        </div>
      ) : (
        <div className="en-anoms">
          {rows.map((r) => (
            <AnomalyItem key={r.id} r={r} currency={currency} scenario={scenarioIds.includes(r.id)} onTrend={onTrend} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function AnomalyItem({ r, currency, scenario, onTrend }: { r: AnomalyRow; currency: string; scenario: boolean; onTrend: (id: string) => void }) {
  const severe = r.level === 'critical';
  return (
    <article className={`en-anom ${severe ? 'critical' : 'warning'}`} aria-label={`${r.label} energy anomaly`}>
      <header className="en-anom-h">
        <StatusBadge tone={severe ? 'critical' : 'warning'} icon={severe ? OctagonX : TriangleAlert} label={severe ? 'Severe · over 15 %' : 'Deviating · over 8 %'} />
        <b className="en-anom-name">{r.label}</b>
        <span className="mono muted">{r.id}</span>
        <ConsumerType id={r.id} />
        {scenario && <SourceTag source="scenario" />}
        <span className="spacer" />
        <span className={`en-phase ${r.active ? 'on' : ''}`}>{r.active ? 'Ongoing in the last hour' : 'Earlier in the period · back within model now'}</span>
      </header>

      <dl className="en-anom-metrics">
        <div>
          <dt>Period deviation</dt>
          <dd>
            <DevBadge d={r.periodDev} label={false} />
          </dd>
        </div>
        <div>
          <dt>Last hour</dt>
          <dd>
            <DevBadge d={r.recentDev} label={false} />
          </dd>
        </div>
        <div>
          <dt>Excess energy · period</dt>
          <dd>
            {fmtInt(r.excessKwh)} kWh <span className="muted">{fmtMoney(r.excessCost, currency)}</span>
          </dd>
        </div>
        <div>
          <dt>Excess cost per hour</dt>
          <dd>{r.active ? fmtMoney(r.excessCostPerH, currency) : <span className="muted">Not ongoing</span>}</dd>
        </div>
        <div>
          <dt>Per month if sustained</dt>
          <dd>{r.projectedMonth != null ? <b>≈ {fmtMoney(r.projectedMonth, currency)}</b> : <span className="muted">—</span>}</dd>
        </div>
      </dl>

      <p className="en-anom-rec">
        <b>Recommended investigation</b>
        {r.recommendation}
        {r.recommendationSource === 'early' && (
          <span className="muted"> Early detection from the last hour; the 2-hour energy insight confirms it once the deviation is sustained.</span>
        )}
      </p>

      <div className="en-actions-row">
        {r.event ? (
          <>
            <button className="btn sm primary" onClick={() => openEvent(r.event!.id)} title={`Open the report of ${r.event.id}: ${r.event.title}`}>
              <ClipboardList size={13} aria-hidden />
              Event report · {r.event.id}
            </button>
            <EventStatusBadge status={r.event.status} />
          </>
        ) : (
          <span className="muted" title="The energy-deviation rule compares the last full hour with the model every 15 min">
            No event yet — the rule checks the last full hour
          </span>
        )}
        <span className="spacer" />
        <button className="btn sm" onClick={() => openEquipment(r.id)}>
          <Locate size={13} aria-hidden />
          Locate in Factory Twin
        </button>
        <button className="btn sm ghost" onClick={() => onTrend(r.id)}>
          <ChartLine size={13} aria-hidden />
          Show hourly trend
        </button>
      </div>
    </article>
  );
}
