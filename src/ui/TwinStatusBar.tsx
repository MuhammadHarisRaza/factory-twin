import type { ReactNode } from 'react';
import { Gauge, OctagonX, ScanSearch, Target, Timer, Truck, Zap, type LucideIcon } from 'lucide-react';
import { useApp, type WorkspaceId } from '../app/store';
import { useSimValue } from '../sim/store';
import { energyIn, fleetMetrics, lineMetrics, resolvePeriod, type PeriodKey } from '../sim/metrics';
import { M2_PER_TILE, TARGET } from '../model/plant';
import { formatDuration } from '../sim/time';
import { MetricText } from './kit/Status';
import { fmt1, fmtInt, fmtMetric, fmtPct } from './kit/format';
import { useTip } from './twin/Tip';

type ChipId = 'oee' | 'output' | 'downtime' | 'defects' | 'energy' | 'trucks';

const PERIODS: { value: PeriodKey; label: string }[] = [
  { value: 'shift', label: 'Shift' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
];
const OTHER_PERIOD: Partial<Record<PeriodKey, string>> = { 'prev-shift': 'Prev. shift', '24h': '24 h' };

/**
 * KPI chip strip over the twin (simulated): line OEE, output against target, downtime,
 * defect rate, specific energy and trucks on site for the shared reporting period.
 * Each chip opens the workspace that explains the figure.
 */
export function TwinStatusBar() {
  const period = useApp((s) => s.period);
  const setPeriod = useApp((s) => s.setPeriod);
  const tariffs = useApp((s) => s.tariffs);
  const go = useApp((s) => s.go);
  const tip = useTip<ChipId>();
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(period, s.minute);
      return { p, lm: lineMetrics(s, p), e: energyIn(s, p, tariffs), fm: fleetMetrics(s, p) };
    },
    [period, tariffs],
  );
  const { lm, e, fm } = d;
  const stops = lm.activeStops;
  const defectRate = lm.inspected > 0 ? lm.rejected / lm.inspected : null;
  const options = OTHER_PERIOD[period] ? [...PERIODS, { value: period, label: OTHER_PERIOD[period]! }] : PERIODS;
  const money = (v: number) => `${tariffs.currency} ${fmtInt(v)}`;

  const chips: { id: ChipId; icon: LucideIcon; tone?: string; label: string; short?: string; value: ReactNode; sub?: ReactNode; workspace: WorkspaceId; tip: ReactNode }[] = [
    {
      id: 'oee',
      icon: Gauge,
      label: 'OEE',
      value: <MetricText m={lm.oee.oee} />,
      workspace: 'production',
      tip: (
        <>
          <b>Line OEE · {lm.period.label}</b>
          <div className="tw-tip-row">
            A {fmtMetric(lm.oee.availability)} × P {fmtMetric(lm.oee.performance)} × Q {fmtMetric(lm.oee.quality)} = {fmtMetric(lm.oee.oee)}
          </div>
          <div className="tw-tip-note">
            Availability and performance at the line constraint (kiln), quality = first-pass yield at sorting. Target {fmtPct(TARGET.oeeTarget, 0)}.
          </div>
        </>
      ),
    },
    {
      id: 'output',
      icon: Target,
      label: 'Output vs target',
      short: 'Output',
      value: <span className="num">{lm.attainment == null ? '—' : fmtPct(lm.attainment, 0)}</span>,
      sub: <>{fmtInt(lm.outputM2)} m²</>,
      workspace: 'production',
      tip: (
        <>
          <b>First-quality output · {lm.period.label}</b>
          <div className="tw-tip-row">
            {fmtInt(lm.outputM2)} m² of {fmtInt(lm.targetM2)} m² target ({lm.attainment == null ? '—' : fmtPct(lm.attainment, 0)})
          </div>
          <div className="tw-tip-note">Target {fmtInt(TARGET.goodPerHour * M2_PER_TILE)} m² per planned hour, accepted at sorting.</div>
        </>
      ),
    },
    {
      id: 'downtime',
      icon: stops.length ? OctagonX : Timer,
      tone: stops.length ? 'critical' : undefined,
      label: 'Downtime',
      value: <span className="num">{formatDuration(lm.downtimeMin)}</span>,
      sub: stops.length ? <>{stops.length} stopped</> : undefined,
      workspace: 'production',
      tip: (
        <>
          <b>Unplanned stop time · {lm.period.label}</b>
          <div className="tw-tip-row">{formatDuration(lm.downtimeMin)} (excludes planned stops and starved / blocked time)</div>
          <div className="tw-tip-row">{stops.length ? `Stopped now: ${stops.map((x) => x.equipmentId).join(', ')}` : 'No machine stopped now.'}</div>
        </>
      ),
    },
    {
      id: 'defects',
      icon: ScanSearch,
      label: 'Defect rate',
      short: 'Defects',
      value: <span className="num">{fmtPct(defectRate, 1)}</span>,
      workspace: 'quality',
      tip: (
        <>
          <b>Rejects at sorting · {lm.period.label}</b>
          <div className="tw-tip-row">
            {fmtInt(lm.rejected)} of {fmtInt(lm.inspected)} tiles inspected ({fmtPct(defectRate, 2)})
          </div>
        </>
      ),
    },
    {
      id: 'energy',
      icon: Zap,
      label: 'Energy',
      value: <span className="num">{e.sec != null ? `${fmt1(e.sec)} kWh/m²` : money(e.cost)}</span>,
      sub: e.sec != null ? <>{money(e.cost)}</> : undefined,
      workspace: 'energy',
      tip: (
        <>
          <b>Specific energy · {lm.period.label}</b>
          <div className="tw-tip-row">
            {e.sec != null ? `${fmt1(e.sec)} kWh per good m² (model ${fmt1(e.expectedSec)})` : 'No good output yet in this period'}
          </div>
          <div className="tw-tip-row">
            {fmtInt(e.total)} kWh · {money(e.cost)}
            {e.deviation != null ? ` · ${e.deviation >= 0 ? '+' : ''}${(e.deviation * 100).toFixed(1)} % vs model` : ''}
          </div>
          <div className="tw-tip-note">Illustrative model; tariffs are assumptions.</div>
        </>
      ),
    },
    {
      id: 'trucks',
      icon: Truck,
      tone: fm.waiting >= 3 ? 'warning' : undefined,
      label: 'Trucks on site',
      short: 'Trucks',
      value: <span className="num">{fm.onSite}</span>,
      sub: <>{fm.waiting} waiting</>,
      workspace: 'fleet',
      tip: (
        <>
          <b>External vehicles · now</b>
          <div className="tw-tip-row">
            {fm.onSite} on site · {fm.waiting} waiting for a dock · {fm.atDock} at a dock · {fm.inbound} inbound
          </div>
        </>
      ),
    },
  ];

  return (
    <div className="tw-kpis" role="group" aria-label={`Key figures · ${lm.period.label} (simulated)`}>
      <div className="tw-period" role="radiogroup" aria-label="Reporting period">
        {options.map((o) => (
          <button key={o.value} role="radio" aria-checked={o.value === period} className={o.value === period ? 'on' : ''} onClick={() => setPeriod(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      {chips.map((c) => {
        const Icon = c.icon;
        return (
          <button key={c.id} className="tw-kpi" onClick={() => go(c.workspace)} {...tip.bind(c.id, 'bottom')}>
            <span className={c.tone ? `status ${c.tone}` : 'tw-kpi-i'}>
              <Icon size={15} strokeWidth={2} aria-hidden />
            </span>
            <span className="tw-kpi-t">
              <span className="l">
                {c.short ? (
                  <>
                    <span className="lg">{c.label}</span>
                    <span className="sh">{c.short}</span>
                  </>
                ) : (
                  c.label
                )}
              </span>
              <span className="v">
                {c.value}
                {c.sub && <small> · {c.sub}</small>}
              </span>
            </span>
          </button>
        );
      })}
      {tip.render((id) => {
        const c = chips.find((x) => x.id === id);
        return c ? (
          <>
            {c.tip}
            <div className="tw-tip-foot">Simulated · click to open the workspace</div>
          </>
        ) : null;
      })}
    </div>
  );
}
