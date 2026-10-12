/**
 * Condition monitoring in the equipment workspace (consolidated from the retired Machine Health
 * page): the current rule-based assessment of a condition-monitored asset with its simulated
 * sensors, and — under Technical details — the 24-h signal charts, alarm and maintenance history.
 */
import { useState, type ReactNode } from 'react';
import { CalendarClock, FastForward, OctagonX, Repeat, Wrench, X, type LucideIcon } from 'lucide-react';
import { REASON_BY_CODE, SCENARIO_KIND_LABELS } from '../../model/plant';
import type { DowntimeEvent } from '../../model/types';
import { HEALTH_BY_ID, formatH, sensorHistory, type HealthAssessment } from '../../sim/health';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { LineChart, Sparkline } from '../kit/charts';
import { fmt1, fmtInt } from '../kit/format';
import { SourceTag, StatusBadge, type Tone } from '../kit/Status';
import {
  CBM_DURATION_MIN,
  HONEST_CONDITION,
  LEVEL_META,
  PM_SOON_H,
  SCORE_MEANING,
  alarmHistory,
  etaText,
  lastMaintenance,
  maintenanceGate,
  maintenanceHistory,
  maintenanceUntil,
  niceAxisMax,
  signalSeries,
  type HistoryRow,
} from './monitoring';
import type { AssetProfile } from './profile';

export function LevelBadge({ level }: { level: HealthAssessment['level'] }) {
  const m = LEVEL_META[level];
  return (
    <span title={m.hint}>
      <StatusBadge tone={m.tone} icon={m.icon} label={m.label} />
    </span>
  );
}

/** Confirmation of a condition-based maintenance stop scheduled from the workspace. */
type Scheduled = { id: string; at: number; until: number };

/** Current condition: level, score and its meaning, findings, simulated sensors, PM status and the maintenance action. */
export function ConditionSection({ prof, h }: { prof: AssetProfile; h: HealthAssessment | null }) {
  if (!prof.conditionMonitored || !h)
    return (
      <section className="insp-sec" aria-label="Current condition">
        <h3>Current condition</h3>
        <p className="insp-desc">
          No condition monitoring on this asset.
          {prof.tracked ? ' Its operating state comes from its simulated PLC signals only; no vibration or temperature sensors are modelled.' : ''}
        </p>
      </section>
    );
  return <MonitoredCondition id={prof.id} h={h} />;
}

function MonitoredCondition({ id, h }: { id: string; h: HealthAssessment }) {
  const a = HEALTH_BY_ID[id];
  const d = useSimValue((s) => ({ hist: sensorHistory(s, id, 360, 10), until: maintenanceUntil(s, id), now: s.minute }), [id]);
  const [scheduled, setScheduled] = useState<Scheduled | null>(null);
  const vib = d.hist.map((x) => (x.running ? x.vibration : null));
  const temp = d.hist.map((x) => x.temperature);
  const cur = d.hist.map((x) => (x.running ? x.current : null));
  const peak = (xs: (number | null)[], floor: number) => Math.max(floor, ...xs.filter((x): x is number => x != null));
  const gate = maintenanceGate(h, d.until);
  const fb = scheduled && scheduled.id === id ? scheduled : null;
  const eta = etaText(h, formatH);
  const offline = h.level === 'offline';

  const schedule = () => {
    const sc = useSim.getState().activate({ kind: 'maintenance', equipmentId: id, count: CBM_DURATION_MIN, end: null, label: `${SCENARIO_KIND_LABELS.maintenance} · ${id}` });
    // +1: the stop closes while minute start + duration is simulated.
    setScheduled({ id, at: sc.start, until: sc.start + CBM_DURATION_MIN + 1 });
  };

  return (
    <section className="insp-sec" aria-label="Current condition">
      <h3>Current condition · {a.component}</h3>
      <div className="tw-health-top">
        <div className="tw-score" title={SCORE_MEANING}>
          <b className="num">{offline ? '—' : h.score}</b>
          {!offline && <span>/100</span>}
        </div>
        <LevelBadge level={h.level} />
        {h.vibrationRatio != null && !offline && <span className="muted num">vibration {h.vibrationRatio.toFixed(2)}× expected</span>}
      </div>
      <p className="tw-fine">{offline ? 'Not assessed: the asset has not run in the last 60 min, so there are no running samples to judge.' : SCORE_MEANING}</p>
      {h.findings.length ? (
        <ul className="tw-list">
          {h.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : (
        !offline && <p className="insp-desc">No abnormal pattern in the last 3 h of running.</p>
      )}
      {eta && <p className="insp-desc eqw-eta">Vibration trend: {eta} if it continues.</p>}

      <div className="tw-read eqw-read" role="group" aria-label="Simulated sensors, last 6 h">
        <span className="h">Simulated sensor</span>
        <span className="h n">Now</span>
        <span className="h n">Limit</span>
        <span className="h">6 h</span>

        <span title={`Expected ${fmt1(h.expectedVibration)} mm/s at the current load`}>Vibration · mm/s</span>
        <span className="n num">{fmt1(h.reading.vibration)}</span>
        <span className="n num muted">{fmt1(a.vib.alarm)}</span>
        <Sparkline values={vib} width={64} height={18} color="var(--series-1)" max={peak(vib, a.vib.alarm)} />

        <span>Temperature · °C</span>
        <span className="n num">{h.reading.temperature.toFixed(0)}</span>
        <span className="n num muted">{a.temp.alarm}</span>
        <Sparkline values={temp} width={64} height={18} color="var(--series-1)" max={peak(temp, a.temp.alarm)} />

        <span title="Shown against the motor rating">Motor current · A</span>
        <span className="n num">{fmtInt(h.reading.current)}</span>
        <span className="n num muted">≤ {a.currentRated}</span>
        <Sparkline values={cur} width={64} height={18} color="var(--series-1)" max={peak(cur, a.currentRated)} />
      </div>
      <dl className="dl eqw-pm">
        <dt>Run since last PM</dt>
        <dd>
          {fmtInt(h.runtimeSincePmH)} h <span className="muted">of a {fmtInt(a.pmIntervalH)} h interval</span>
        </dd>
        <dt>Next PM</dt>
        <dd className={h.pmDueH < PM_SOON_H ? 'eqw-warn' : ''}>{h.pmDueH >= 0 ? `due in ${fmtInt(h.pmDueH)} run hours` : `overdue by ${fmtInt(-h.pmDueH)} run hours`}</dd>
        {d.until != null && (
          <>
            <dt>Maintenance</dt>
            <dd>In progress until {formatClock(d.until)}</dd>
          </>
        )}
      </dl>
      {h.impact && <p className="insp-desc">{h.impact}</p>}
      <div className="eqw-cbm">
        <button
          type="button"
          className="btn sm"
          disabled={!gate.enabled}
          onClick={schedule}
          title={gate.reason ?? `Plan a ${CBM_DURATION_MIN}-min condition-based maintenance stop now (scenario input); the developing fault is cleared when it completes`}
        >
          <Wrench size={12} aria-hidden />
          Schedule condition-based maintenance
        </button>
        {!gate.enabled && gate.reason && <span className="tw-fine">{gate.reason}.</span>}
      </div>
      {fb && (
        <p className="eqw-feedback" role="status">
          Planned stop {formatClock(fb.at)}–{formatClock(fb.at + CBM_DURATION_MIN)} on {id} (scenario input).
          {d.now < fb.until && (
            <button type="button" className="btn sm" onClick={() => useSim.getState().skip(fb.until - d.now)} title={`Advance the simulation clock to ${formatClock(fb.until)}`}>
              <FastForward size={12} aria-hidden />
              Skip to completion
            </button>
          )}
          <button type="button" className="btn ghost sm icon" onClick={() => setScheduled(null)} aria-label="Dismiss">
            <X size={12} />
          </button>
        </p>
      )}
      <p className="tw-honest">{HONEST_CONDITION}</p>
    </section>
  );
}

// ── History (technical details) ──────────────────────────────────────────────

const STOP_KIND: Record<DowntimeEvent['category'], { label: string; tone: Tone; icon: LucideIcon }> = {
  Mechanical: { label: 'Breakdown', tone: 'critical', icon: OctagonX },
  'Electrical & control': { label: 'Breakdown', tone: 'critical', icon: OctagonX },
  Process: { label: 'Process stop', tone: 'critical', icon: OctagonX },
  Changeover: { label: 'Changeover', tone: 'neutral', icon: Repeat },
  Planned: { label: 'Planned stop', tone: 'neutral', icon: CalendarClock },
  Starved: { label: 'Starved', tone: 'warning', icon: OctagonX },
  Blocked: { label: 'Blocked', tone: 'warning', icon: OctagonX },
};

function ChartBlock({ title, now, children }: { title: string; now: ReactNode; children: ReactNode }) {
  return (
    <div className="eqw-chart">
      <div className="eqw-chart-h">
        <span>{title}</span>
        <span className="muted">
          latest <b className="num">{now}</b>
        </span>
      </div>
      {children}
    </div>
  );
}

/** 24-h condition signals with the expected value for the load and the limits (one axis per signal). */
function ConditionCharts({ id, h }: { id: string; h: HealthAssessment }) {
  const a = HEALTH_BY_ID[id];
  const d = useSimValue((s) => signalSeries(s, id), [id]);
  const labels = d.t.map(formatClock);
  const top = (vals: number[], limit: number, min = 0) => niceAxisMax(Math.max(limit, ...vals), min);
  return (
    <div className="eqw-charts">
      <ChartBlock title="Vibration velocity · mm/s RMS · 24 h" now={`${fmt1(h.reading.vibration)} mm/s`}>
        <LineChart
          labels={labels}
          height={130}
          yMax={top([...d.vibration, ...d.vibrationExpected], a.vib.trip)}
          tickEvery={36}
          format={(v) => v.toFixed(1)}
          series={[
            { id: 'vib', label: 'Observed (simulated)', color: 'var(--series-1)', points: d.vibration },
            { id: 'exp', label: 'Expected at load', color: 'var(--series-2)', points: d.vibrationExpected, dashed: true },
          ]}
          reference={[
            { value: a.vib.alarm, label: `Alarm ${a.vib.alarm}` },
            { value: a.vib.trip, label: `Trip ${a.vib.trip}` },
          ]}
        />
      </ChartBlock>
      <ChartBlock title="Temperature · °C · 24 h" now={`${fmtInt(h.reading.temperature)} °C`}>
        <LineChart
          labels={labels}
          height={110}
          yMin={20}
          yMax={top([...d.temperature, ...d.temperatureExpected], a.temp.alarm, 20)}
          tickEvery={36}
          format={(v) => fmtInt(v)}
          series={[
            { id: 'temp', label: 'Observed (simulated)', color: 'var(--series-1)', points: d.temperature },
            { id: 'exp', label: 'Expected at load', color: 'var(--series-2)', points: d.temperatureExpected, dashed: true },
          ]}
          reference={{ value: a.temp.alarm, label: `Alarm ${a.temp.alarm} °C` }}
        />
      </ChartBlock>
      <p className="tw-fine">
        Detection compares observed vibration with the value expected for the current load and extrapolates the 3-h trend to the alarm and trip limits
        (ISO 10816-style zones); temperature is checked against a load-corrected expectation. Signals are simulated.
      </p>
    </div>
  );
}

const alertSummary = (detail: string) => detail.split(' — ')[1]?.replace(/\s*\(.*\)\s*$/, '') || detail;

function HistoryRowView({ r, now }: { r: HistoryRow; now: number }) {
  if (r.kind === 'alert') {
    const m = LEVEL_META[r.level];
    return (
      <li>
        <span className="num muted">{formatDateTime(r.time)}</span>
        <StatusBadge tone={m.tone} icon={m.icon} label={`Condition ${m.label.toLowerCase()}`} size={12} />
        <span className="eqw-hist-d" title={r.alert.detail}>
          {alertSummary(r.alert.detail)}
        </span>
        <SourceTag source={r.alert.source} />
      </li>
    );
  }
  const k = STOP_KIND[r.ev.category];
  return (
    <li>
      <span className="num muted">{formatDateTime(r.time)}</span>
      <StatusBadge {...k} size={12} />
      <span className="eqw-hist-d">
        {REASON_BY_CODE[r.ev.reasonCode]?.label ?? r.ev.reasonCode} · {r.ev.end == null ? `active ${formatDuration(now - r.ev.start)}` : formatDuration(r.ev.end - r.ev.start)}
      </span>
      <SourceTag source={r.ev.source} />
    </li>
  );
}

/** Stops and condition alerts (newest first), and for monitored assets the 24-h charts and maintenance records. */
export function ConditionHistory({ prof, h }: { prof: AssetProfile; h: HealthAssessment | null }) {
  const id = prof.id;
  const d = useSimValue(
    (s) => ({
      now: s.minute,
      rows: alarmHistory(s, id, 'all').slice(0, 8),
      total: alarmHistory(s, id, 'all').length,
      maint: maintenanceHistory(s, id).slice(0, 4),
      last: lastMaintenance(maintenanceHistory(s, id), Math.max(0, s.minute - 1)),
    }),
    [id],
  );
  if (!prof.tracked && !prof.conditionMonitored) return <p className="insp-desc">No stop or maintenance history is simulated for this asset.</p>;
  return (
    <>
      {prof.conditionMonitored && h && <ConditionCharts id={id} h={h} />}
      <div className="eqw-sub-h">
        Stops and condition alerts · {d.total} since the start of the simulated week · newest first · starved / blocked spells excluded
      </div>
      {d.rows.length ? (
        <ul className="eqw-hist">
          {d.rows.map((r) => (
            <HistoryRowView key={r.key} r={r} now={d.now} />
          ))}
        </ul>
      ) : (
        <p className="insp-desc">No stops or condition alerts recorded.</p>
      )}
      {prof.conditionMonitored && (
        <>
          <div className="eqw-sub-h">Maintenance · last: {d.last ? `${formatDateTime(d.last.start)} · ${d.last.type.toLowerCase()}` : 'none recorded'}</div>
          {d.maint.length ? (
            <ul className="eqw-hist">
              {d.maint.map((m) => (
                <li key={m.id}>
                  <span className="num muted">{formatDateTime(m.start)}</span>
                  <span className="eqw-hist-k">{m.type}</span>
                  <span className="eqw-hist-d" title={m.description}>
                    {m.start <= d.now && m.end > d.now ? `In progress until ${formatClock(m.end)}` : formatDuration(m.end - m.start)} · {m.description}
                  </span>
                  <SourceTag source={m.source} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="insp-desc">No maintenance recorded for this asset.</p>
          )}
        </>
      )}
    </>
  );
}
