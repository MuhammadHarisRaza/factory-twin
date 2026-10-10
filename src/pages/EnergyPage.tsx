/**
 * Energy Intelligence — energy, cost and CO₂e for the shared reporting period against an
 * illustrative energy model. Answers: are we on model, which consumer is off, what does it
 * cost (now and per month if it continues), what to check, and how production losses
 * (an idling kiln) waste energy. Every figure derives from the one simulation state; the
 * tariffs are editable assumptions shared with every other workspace.
 */
import { useCallback, useState } from 'react';
import { ArrowRight, CircleCheck, Info, Locate, OctagonX, TriangleAlert } from 'lucide-react';
import { openEquipment, useApp } from '../app/store';
import { insights } from '../intel/insights';
import { CONSUMERS, CONSUMER_BY_ID, powerNow, type Tariffs } from '../sim/energy';
import { scenariosActive } from '../sim/engine';
import { energyIn, resolvePeriod, type Period, type PeriodKey } from '../sim/metrics';
import { useSimValue } from '../sim/store';
import { formatDuration } from '../sim/time';
import { LineChart, RankedBars, type RankedRow } from '../ui/kit/charts';
import { fmt1, fmtInt, fmtPct } from '../ui/kit/format';
import { Empty, Panel } from '../ui/kit/Panel';
import { StatusBadge, type Tone } from '../ui/kit/Status';
import { AnomalyPanel } from './energy/AnomalyPanel';
import { ConsumerTable } from './energy/ConsumerTable';
import { DevBadge, ELEC_COLOR, GAS_COLOR } from './energy/badges';
import {
  devLevel,
  findAnomalies,
  fmtAmount,
  fmtMoney,
  fmtRate,
  fmtSigned,
  hourlyEnergy,
  isGas,
  kilnIdle,
  recentWindow,
  secTrend,
  worstLevel,
  type AnomalyRow,
  type DevLevel,
} from './energy/derive';
import { SimulatePanel } from './energy/SimulatePanel';
import { TariffPanel } from './energy/TariffPanel';
import './energy.css';

type Energy = ReturnType<typeof energyIn>;

const TREND_ID = 'en-hourly';
const TABLE_ID = 'en-consumers';
const KILN_IDLE_KW = CONSUMER_BY_ID['H-KILN'].thermal![0];
/** Shown when the kiln-idle insight (current shift, > 1,500 kWh) is not raised for this period. */
const KILN_IDLE_ACTION = 'Reduce kiln starvation by protecting the glazing and decoration feed; use idle-mode firing setpoints for planned gaps.';

export function EnergyPage() {
  const periodKey = useApp((s) => s.period);
  const tariffs = useApp((s) => s.tariffs);
  const [focus, setFocus] = useState<string | null>(null);

  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const e = energyIn(s, p, tariffs);
      const energyInsights = insights(s, { period: p, tariffs }).filter((i) => i.kind === 'energy');
      return {
        p,
        e,
        recent: recentWindow(s.minute),
        anomalies: findAnomalies(s, p, tariffs, energyInsights),
        kilnInsight: energyInsights.find((i) => i.id === 'energy-kiln-idle') ?? null,
        power: Object.fromEntries(CONSUMERS.map((c) => [c.id, powerNow(s, c.id)])),
        scenarioIds: scenariosActive(s)
          .filter((sc) => sc.kind === 'energy-anomaly' && sc.equipmentId)
          .map((sc) => sc.equipmentId!),
      };
    },
    [periodKey, tariffs],
  );

  /** Focus the hourly chart on one consumer and bring it into view. */
  const showTrend = useCallback((id: string) => {
    setFocus(id);
    requestAnimationFrame(() => document.getElementById(TREND_ID)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }, []);

  return (
    <div className="page energy-page">
      <div className="col-12 notice">
        <Info size={14} aria-hidden />
        <span>
          <b>Illustrative energy model.</b> Consumption is simulated from machine states and throughput; tariffs and emission factors are configurable
          assumptions; no meters are connected.
        </span>
      </div>

      <Summary p={d.p} e={d.e} anomalies={d.anomalies} currency={tariffs.currency} />

      <div className="col-8 en-cell">
        <AnomalyPanel rows={d.anomalies} all={d.e.rows} period={d.p} recent={d.recent} currency={tariffs.currency} scenarioIds={d.scenarioIds} onTrend={showTrend} />
      </div>
      <div className="col-4 en-cell">
        <SimulatePanel onActivated={setFocus} />
      </div>

      <div className="col-8 en-cell" id={TREND_ID}>
        <HourlyPanel periodKey={periodKey} focus={focus} setFocus={setFocus} />
      </div>
      <div className="col-4 en-cell">
        <ConsumerShare e={d.e} focus={focus} setFocus={setFocus} />
      </div>

      <div className="col-8 en-cell">
        <SecPanel periodKey={periodKey} e={d.e} />
      </div>
      <div className="col-4 en-cell">
        <KilnPanel periodKey={periodKey} tariffs={tariffs} recommendation={d.kilnInsight?.recommendation ?? null} />
      </div>

      <div className="col-8 en-cell" id={TABLE_ID}>
        <ConsumerTable
          e={d.e}
          power={d.power}
          currency={tariffs.currency}
          periodLabel={d.p.label}
          focus={focus}
          onFocus={(id) => (id ? showTrend(id) : setFocus(null))}
          scenarioIds={d.scenarioIds}
        />
      </div>
      <div className="col-4 en-cell">
        <TariffPanel totals={d.e} periodLabel={d.p.label} />
      </div>
    </div>
  );
}

// ── Summary band ─────────────────────────────────────────────────────────────

const VERDICT_TONE: Record<DevLevel, Tone> = { ok: 'good', warning: 'warning', critical: 'critical' };

function Summary({ p, e, anomalies, currency }: { p: Period; e: Energy; anomalies: AnomalyRow[]; currency: string }) {
  const worst = anomalies.reduce<DevLevel>((l, a) => worstLevel(l, a.level), 'ok');
  const n = anomalies.length;
  const verdict =
    e.total <= 0
      ? { tone: 'neutral' as Tone, icon: Info, text: 'No consumption recorded yet' }
      : n === 0
        ? { tone: 'good' as Tone, icon: CircleCheck, text: 'On model · all consumers within ±8 %' }
        : { tone: VERDICT_TONE[worst], icon: worst === 'critical' ? OctagonX : TriangleAlert, text: `${n} ${n === 1 ? 'consumer' : 'consumers'} off model` };
  const VIcon = verdict.icon;
  const elecShare = e.total > 0 ? e.elec / e.total : 0;
  const excessKwh = e.total - e.expected;

  return (
    <section className="summary en-summary" aria-label="Energy summary">
      <div>
        <div className="kpi-label">Energy vs model · {p.label}</div>
        <div className={`en-verdict ${verdict.tone}`}>
          <VIcon size={16} strokeWidth={2.2} aria-hidden />
          {verdict.text}
        </div>
        <div className="kpi-value">
          {fmtInt(e.total)}
          <small>kWh</small>
        </div>
        <div className="en-split" role="img" aria-label={`Electricity ${fmtPct(elecShare, 0)}, gas ${fmtPct(1 - elecShare, 0)}`}>
          <i style={{ width: `${elecShare * 100}%`, background: ELEC_COLOR }} />
          <i style={{ width: `${(1 - elecShare) * 100}%`, background: GAS_COLOR }} />
        </div>
        <div className="kpi-sub">
          <span>
            <i className="en-sw" style={{ background: ELEC_COLOR }} />
            Electricity {fmtInt(e.elec)} kWh · {fmtPct(elecShare, 0)}
          </span>
          <span>
            <i className="en-sw" style={{ background: GAS_COLOR }} />
            Gas {fmtInt(e.thermal)} kWh · {fmtPct(e.total > 0 ? 1 - elecShare : null, 0)}
          </span>
        </div>
      </div>

      <div>
        <div className="kpi-label">Energy cost</div>
        <div className="kpi-value">
          <small className="en-pre">{currency}</small>
          {fmtAmount(e.cost)}
        </div>
        <div className="kpi-sub">
          <span>Model {fmtMoney(e.expectedCost, currency)}</span>
        </div>
        <div className="kpi-sub">
          <span>
            Blended {e.total > 0 ? fmtRate(e.cost / e.total) : '—'} {currency}/kWh
          </span>
        </div>
      </div>

      <div>
        <div className="kpi-label">Deviation vs energy model</div>
        <div className="kpi-value">{fmtSigned(e.deviation)}</div>
        <div className="kpi-sub">
          {devLevel(e.deviation) === 'ok' ? <StatusBadge tone="good" icon={CircleCheck} label="Within ±8 %" /> : <DevBadge d={e.deviation} />}
        </div>
        <div className="kpi-sub">Model {fmtInt(e.expected)} kWh</div>
      </div>

      <div>
        <div className="kpi-label">Excess cost vs model</div>
        <div className="kpi-value">
          <small className="en-pre">{currency}</small>
          {fmtAmount(e.excessCost)}
        </div>
        <div className="kpi-sub">
          <span>
            {fmtInt(Math.abs(excessKwh))} kWh {excessKwh >= 0 ? 'above' : 'below'} model
          </span>
        </div>
        <div className="kpi-sub">{n ? `${n} flagged ${n === 1 ? 'consumer' : 'consumers'}` : 'No flagged consumers'}</div>
      </div>

      <div>
        <div className="kpi-label" title="Specific energy consumption: kWh per good (first-quality) m²">
          Specific energy (SEC)
        </div>
        <div className="kpi-value">
          {fmt1(e.sec)}
          <small>kWh/m²</small>
        </div>
        <div className="kpi-sub">
          <span>Model {fmt1(e.expectedSec)} kWh/m²</span>
        </div>
        <div className="kpi-sub">{e.sec == null ? 'No good output in this period' : `${fmtInt(e.goodM2)} good m²`}</div>
      </div>

      <div>
        <div className="kpi-label">CO₂e emissions</div>
        <div className="kpi-value">
          {fmt1(e.co2Kg / 1000)}
          <small>t</small>
        </div>
        <div className="kpi-sub">
          <span>{e.goodM2 > 0 ? `${fmt1(e.co2Kg / e.goodM2)} kg per good m²` : '—'}</span>
        </div>
        <div className="kpi-sub">From configurable emission factors</div>
      </div>
    </section>
  );
}

// ── Hourly actual vs model ───────────────────────────────────────────────────

function HourlyPanel({ periodKey, focus, setFocus }: { periodKey: PeriodKey; focus: string | null; setFocus: (id: string | null) => void }) {
  const h = useSimValue((s) => hourlyEnergy(s, resolvePeriod(periodKey, s.minute), focus ?? undefined), [periodKey, focus]);
  const tickEvery = Math.max(1, Math.ceil(h.length / 12));
  const act = h.reduce((a, x) => a + x.actual, 0);
  const exp = h.reduce((a, x) => a + x.expected, 0);
  const dev = exp > 1 ? act / exp - 1 : null;
  const partial = h.length > 0 && h[h.length - 1].minutes < 60;
  const who = focus ? `${focus} · ${CONSUMER_BY_ID[focus]?.label ?? focus}` : 'All consumers';
  return (
    <Panel
      title="Hourly energy · actual vs model"
      subtitle={`kWh per hour · ${who} · period deviation ${fmtSigned(dev)}${partial ? ' · in-progress hour pro-rated' : ''}`}
      actions={
        <div className="en-actions">
          <select className="select" aria-label="Consumer" value={focus ?? ''} onChange={(e) => setFocus(e.target.value || null)}>
            <option value="">All consumers (plant)</option>
            {CONSUMERS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} · {c.label}
              </option>
            ))}
          </select>
        </div>
      }
      footer={<span>Model = expected consumption for the same machine states and throughput, without anomalies. The in-progress hour is shown as its rate so far.</span>}
    >
      {h.length >= 2 ? (
        <LineChart
          labels={h.map((x) => x.label)}
          series={[
            { id: 'act', label: 'Actual', color: 'var(--series-1)', points: h.map((x) => x.actualRate) },
            { id: 'model', label: 'Energy model', color: 'var(--text-2)', points: h.map((x) => x.expectedRate), dashed: true },
          ]}
          format={fmtInt}
          tickEvery={tickEvery}
          height={230}
        />
      ) : (
        <Empty title="Hourly trend starts after the first hour of the period">
          {h[0] && (
            <span>
              So far: {fmtInt(h[0].actual)} kWh actual vs {fmtInt(h[0].expected)} kWh model ({h[0].minutes} min)
            </span>
          )}
        </Empty>
      )}
    </Panel>
  );
}

// ── Energy by consumer ───────────────────────────────────────────────────────

const SHOWN = 9;

function ConsumerShare({ e, focus, setFocus }: { e: Energy; focus: string | null; setFocus: (id: string | null) => void }) {
  const sorted = [...e.rows].sort((a, b) => b.total - a.total);
  const rest = sorted.slice(SHOWN);
  const restKwh = rest.reduce((a, r) => a + r.total, 0);
  const share = (v: number) => (e.total > 0 ? v / e.total : 0);
  const rows: RankedRow[] = sorted.slice(0, SHOWN).map((r) => ({ key: r.id, label: r.label, value: r.total, share: share(r.total), color: isGas(r.id) ? GAS_COLOR : ELEC_COLOR }));
  // A focused consumer outside the top rows highlights the "smaller consumers" row.
  const selected = focus == null ? null : sorted.slice(0, SHOWN).some((r) => r.id === focus) ? focus : '__rest';
  if (rest.length)
    rows.push({
      key: '__rest',
      label: (
        <span title={selected === '__rest' ? `Focused on ${focus} — click to show all consumers again` : 'Listed one by one in the consumer table — click to go there'}>
          {rest.length} smaller consumers{selected === '__rest' && focus ? ` · ${focus} focused` : ''}
        </span>
      ),
      value: restKwh,
      share: share(restKwh),
      color: 'var(--text-4)',
    });
  return (
    <Panel title="Energy by consumer" subtitle="kWh in the period · share of plant total · click to focus the hourly chart">
      <div className="chart-legend">
        <span>
          <i style={{ background: ELEC_COLOR }} />
          Electric
        </span>
        <span>
          <i style={{ background: GAS_COLOR }} />
          Gas-fired (gas + elec.)
        </span>
        {rest.length > 0 && (
          <span>
            <i style={{ background: 'var(--text-4)' }} />
            Others
          </span>
        )}
      </div>
      {e.total > 0 ? (
        <RankedBars
          rows={rows}
          format={fmtInt}
          valueHeader="kWh"
          labelHeader="Consumer"
          showCumulative={false}
          selectedKey={selected}
          onSelect={(r) => {
            // The grouped row has no single consumer to focus (finding #32): it clears a focus on one of
            // its consumers, otherwise it scrolls to the consumer table where each one can be picked.
            if (r.key === '__rest') {
              if (selected === '__rest') setFocus(null);
              else document.getElementById(TABLE_ID)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return;
            }
            setFocus(focus === r.key ? null : r.key);
          }}
        />
      ) : (
        <Empty title="No consumption recorded in this period yet" />
      )}
    </Panel>
  );
}

// ── SEC trend ────────────────────────────────────────────────────────────────

function SecPanel({ periodKey, e }: { periodKey: PeriodKey; e: Energy }) {
  const h = useSimValue((s) => secTrend(s, resolvePeriod(periodKey, s.minute)), [periodKey]);
  const tickEvery = Math.max(1, Math.ceil(h.length / 12));
  const hasData = h.filter((x) => x.sec != null).length >= 2;
  return (
    <Panel
      title="Specific energy consumption per hour"
      subtitle={`kWh per good m² · dashed = model SEC for the period${e.expectedSec != null ? ` (${fmt1(e.expectedSec)})` : ''}`}
      footer={
        <span>
          SEC rises when output falls while the kiln and dryers keep burning gas. Gaps: hours with under 25 % of target output, where kWh per m² is not
          meaningful.
        </span>
      }
    >
      {hasData ? (
        <LineChart
          labels={h.map((x) => x.label)}
          series={[{ id: 'sec', label: 'SEC', color: 'var(--series-1)', points: h.map((x) => x.sec) }]}
          format={fmt1}
          tickEvery={tickEvery}
          height={200}
          reference={e.expectedSec != null ? { value: e.expectedSec, label: `Model ${fmt1(e.expectedSec)}` } : undefined}
        />
      ) : (
        <Empty title="Not enough production in this period for an hourly SEC trend" />
      )}
    </Panel>
  );
}

// ── Kiln idle burn ───────────────────────────────────────────────────────────

function KilnPanel({ periodKey, tariffs, recommendation }: { periodKey: PeriodKey; tariffs: Tariffs; recommendation: string | null }) {
  const k = useSimValue((s) => kilnIdle(s, resolvePeriod(periodKey, s.minute), tariffs), [periodKey, tariffs]);
  const idleMin = k.starvedMin + k.blockedMin;
  return (
    <Panel
      title="Kiln idle burn"
      subtitle="Gas burnt while the kiln was starved or blocked"
      footer={<span>Idle burn = starved + blocked kiln minutes × idle firing rate ({fmtInt(KILN_IDLE_KW)} kW thermal, model assumption).</span>}
    >
      <div className="en-kiln">
        <div className="en-kiln-figs">
          <div>
            <span className="kpi-label">Gas without output</span>
            <div className="kpi-value">
              {fmtInt(k.kwh)}
              <small>kWh</small>
            </div>
          </div>
          <div>
            <span className="kpi-label">Cost</span>
            <div className="kpi-value">
              <small className="en-pre">{tariffs.currency}</small>
              {fmtAmount(k.cost)}
            </div>
          </div>
        </div>
        <dl className="dl">
          <dt>Kiln waiting</dt>
          <dd>
            {formatDuration(idleMin)}
            <span className="muted">
              {' '}
              · starved {formatDuration(k.starvedMin)} · blocked {formatDuration(k.blockedMin)}
            </span>
          </dd>
          <dt>Share of kiln gas</dt>
          <dd>{fmtPct(k.shareOfKilnGas)}</dd>
          <dt>Adds to SEC</dt>
          <dd>{k.secPenalty != null ? `+${fmt1(k.secPenalty)} kWh per good m²` : '—'}</dd>
          <dt>CO₂e</dt>
          <dd>{fmt1(k.co2Kg / 1000)} t</dd>
        </dl>
        <p className="en-note">
          A roller kiln holds its firing temperature whether or not tiles arrive. Every minute it waits for tiles from an upstream stop, or cannot discharge to
          a full exit, burns gas without producing — production losses are energy losses.
        </p>
        {idleMin > 0 ? (
          <p className="en-anom-rec">
            <b>Recommendation</b>
            {recommendation ?? KILN_IDLE_ACTION}
          </p>
        ) : (
          <StatusBadge tone="good" icon={CircleCheck} label="Kiln was fed continuously in this period" />
        )}
        <div className="en-actions-row">
          <button className="btn sm" onClick={() => openEquipment('H-KILN')}>
            <Locate size={13} aria-hidden />
            Locate kiln in Factory Twin
          </button>
          <button className="btn sm ghost" onClick={() => useApp.getState().go('production')}>
            Starved / blocked causes
            <ArrowRight size={13} aria-hidden />
          </button>
        </div>
      </div>
    </Panel>
  );
}
