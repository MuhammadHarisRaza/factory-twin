import { followLink } from '../copilot/links';
import {
  CircleCheck,
  CirclePause,
  ExternalLink,
  Eye,
  LocateFixed,
  OctagonX,
  Scan,
  TriangleAlert,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { useApp } from '../../app/store';
import { useTwin } from '../../store';
import { HEALTH_BY_ID, formatH, sensorHistory, type HealthAssessment, type HealthLevel } from '../../sim/health';
import type { Insight, InsightSeverity } from '../../intel/insights';
import { useSimValue } from '../../sim/store';
import { Sparkline } from '../kit/charts';
import { SEVERITY, StatusBadge, type Tone } from '../kit/Status';
import { fmt1, fmtInt } from '../kit/format';
import { assetEvents, vehicleEvents } from './derive';
import { AssetEventList } from './EventRows';

// ── Health ────────────────────────────────────────────────────────────────────

export const HEALTH_LEVEL: Record<HealthLevel, { label: string; tone: Tone; icon: LucideIcon }> = {
  normal: { label: 'Normal', tone: 'good', icon: CircleCheck },
  watch: { label: 'Watch', tone: 'warning', icon: Eye },
  warning: { label: 'Warning', tone: 'serious', icon: TriangleAlert },
  alarm: { label: 'Alarm', tone: 'critical', icon: OctagonX },
  offline: { label: 'Not running', tone: 'neutral', icon: CirclePause },
};

export const HealthBadge = ({ level }: { level: HealthLevel }) => <StatusBadge {...HEALTH_LEVEL[level]} />;

const HONEST_HEALTH = 'Rule-based detection on simulated signals — no trained model or physical sensors.';

/** Condition-monitoring view of one asset: score, readings vs expected, findings, projection. */
export function HealthTab({ id, a }: { id: string; a: HealthAssessment }) {
  const asset = HEALTH_BY_ID[id];
  const hist = useSimValue((s) => sensorHistory(s, id, 360, 10), [id]);
  const vib = hist.map((h) => (h.running ? h.vibration : null));
  const temp = hist.map((h) => h.temperature);
  const cur = hist.map((h) => (h.running ? h.current : null));
  const peak = (xs: (number | null)[], floor: number) => Math.max(floor, ...xs.filter((x): x is number => x != null));
  return (
    <>
      <div className="insp-sec">
        <h3>Condition · {asset.component}</h3>
        <div className="tw-health-top">
          {a.level === 'offline' ? (
            <div className="tw-score" title="Not running, so not assessed (no recent running samples)">
              <b className="num">—</b>
            </div>
          ) : (
            <div className="tw-score" title="Health score 0–100 from the rule-based assessment">
              <b className="num">{a.score}</b>
              <span>/100</span>
            </div>
          )}
          <HealthBadge level={a.level} />
          {a.vibrationRatio != null && a.level !== 'offline' && (
            <span className="muted num">vibration {a.vibrationRatio.toFixed(2)}× expected</span>
          )}
        </div>
      </div>
      <div className="insp-sec">
        <h3>Latest readings vs expected · last 6 h</h3>
        <div className="tw-read">
          <span className="h">Signal</span>
          <span className="h n">Now</span>
          <span className="h n">Expected</span>
          <span className="h n">Alarm</span>
          <span className="h">Trend</span>

          <span>Vibration</span>
          <span className="n num">{fmt1(a.reading.vibration)}</span>
          <span className="n num muted">{fmt1(a.expectedVibration)}</span>
          <span className="n num muted">{fmt1(asset.vib.alarm)}</span>
          <Sparkline values={vib} width={64} height={18} color="var(--series-1)" max={peak(vib, asset.vib.alarm)} />

          <span>Temperature</span>
          <span className="n num">{a.reading.temperature.toFixed(0)}</span>
          <span className="n num muted">—</span>
          <span className="n num muted">{asset.temp.alarm}</span>
          <Sparkline values={temp} width={64} height={18} color="var(--series-1)" max={peak(temp, asset.temp.alarm)} />

          <span>Motor current</span>
          <span className="n num">{fmtInt(a.reading.current)}</span>
          <span className="n num muted">≤ {asset.currentRated}</span>
          <span className="n num muted">—</span>
          <Sparkline values={cur} width={64} height={18} color="var(--series-1)" max={peak(cur, asset.currentRated)} />
        </div>
        <p className="tw-fine">
          {a.reading.running ? '' : 'Not running at the moment, so “now” shows idle readings; the findings use the last hour of running samples. '}
          Units: mm/s RMS · °C · A. Expected vibration is corrected for the current load; current is shown against the motor rating.
        </p>
      </div>
      <div className="insp-sec">
        <h3>Findings</h3>
        {a.findings.length ? (
          <ul className="tw-list">
            {a.findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <p className="insp-desc">{a.level === 'offline' ? 'Asset not running — no recent running samples to assess.' : 'No abnormal pattern in the last 3 h of running.'}</p>
        )}
        {(a.etaAlarmH != null || a.etaTripH != null) && (
          <dl className="dl" style={{ marginTop: 8 }}>
            <dt>Alarm limit in</dt>
            <dd>{a.etaAlarmH != null ? `≈ ${formatH(a.etaAlarmH)}` : 'Reached'}</dd>
            <dt>Trip limit in</dt>
            <dd>{a.etaTripH != null ? `≈ ${formatH(a.etaTripH)}` : '—'}</dd>
          </dl>
        )}
        {a.impact && <p className="insp-desc" style={{ marginTop: 8 }}>{a.impact}</p>}
        {a.recommendation && (
          <div className="tw-action">
            <b>Recommended action</b>
            <p>{a.recommendation}</p>
          </div>
        )}
      </div>
      <div className="insp-sec">
        <h3>Maintenance</h3>
        <dl className="dl">
          <dt>Run time since PM</dt>
          <dd>{fmtInt(a.runtimeSincePmH)} h</dd>
          <dt>Next PM</dt>
          <dd>{a.pmDueH >= 0 ? `due in ${fmtInt(a.pmDueH)} run hours` : `overdue by ${fmtInt(-a.pmDueH)} run hours`}</dd>
        </dl>
      </div>
      <p className="tw-honest">{HONEST_HEALTH}</p>
    </>
  );
}

// ── Events ────────────────────────────────────────────────────────────────────

/** Operational events (src/sim/events.ts) of one asset: open ones, then the last 24 h. */
export function EventsTab({ id }: { id: string }) {
  const data = useSimValue((s) => ({ events: assetEvents(s, id), now: s.minute }), [id]);
  return (
    <div className="insp-sec">
      <h3>Operational events · open and last 24 h</h3>
      <AssetEventList events={data.events} now={data.now} empty="No events for this asset in the last 24 h: its detection rules stayed within thresholds." />
      <p className="tw-fine">
        One record per event — its report, evidence, impact and lifecycle open in Events & Reports. Detection rules run on simulated signals.
      </p>
    </div>
  );
}

/** Operational events of one vehicle (waiting, dock stay, turnaround, restricted-zone entry). */
export function VehicleEvents({ id }: { id: string }) {
  const data = useSimValue((s) => ({ events: vehicleEvents(s, id), now: s.minute }), [id]);
  return (
    <div className="insp-sec">
      <h3>Events · open and last 24 h</h3>
      <AssetEventList events={data.events} now={data.now} empty="No events for this vehicle." />
    </div>
  );
}

// ── Recommendations ──────────────────────────────────────────────────────────

const INSIGHT_BADGE: Record<InsightSeverity, { label: string; tone: Tone; icon: LucideIcon }> = {
  critical: SEVERITY.critical,
  serious: SEVERITY.serious,
  warning: SEVERITY.warning,
  info: SEVERITY.info,
  positive: { label: 'Positive', tone: 'good', icon: CircleCheck },
};

/** Rule-based recommendations that concern this asset (src/intel/insights.ts). */
export function RecsTab({ id, recs }: { id: string; recs: Insight[] }) {
  const go = useApp((s) => s.go);
  return (
    <div className="insp-sec">
      <h3>AI recommendations · rule-based</h3>
      {recs.length ? (
        <div className="tw-recs">
          {recs.map((r) => (
            <article key={r.id} className="tw-rec">
              <header>
                <StatusBadge {...INSIGHT_BADGE[r.severity]} />
                <b>{r.title}</b>
              </header>
              <p>{r.summary}</p>
              {r.evidence.length > 0 && (
                <ul className="tw-list">
                  {r.evidence.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              {r.impact && (
                <p className="tw-rec-impact">
                  <span className="muted">Impact · </span>
                  {r.impact}
                  {r.estimate?.length ? (
                    <span className="tag sim" title={r.estimate.join(' ')} style={{ marginLeft: 6 }}>
                      estimate · assumptions shown
                    </span>
                  ) : null}
                </p>
              )}
              {r.recommendation && (
                <div className="tw-action">
                  <b>Recommended action</b>
                  <p>{r.recommendation}</p>
                </div>
              )}
              {r.links.length > 0 && (
                <div className="tw-rec-links">
                  {r.links.map((l) => {
                    const Icon = l.kind === 'workspace' ? ExternalLink : l.kind === 'vehicle' ? LocateFixed : l.id === id ? Scan : Waypoints;
                    return (
                      <button
                        key={l.kind + l.id}
                        className="btn sm"
                        onClick={() => {
                          const tw = useTwin.getState();
                          if (l.kind === 'equipment') {
                            if (l.id === id) tw.focusEquipment(id);
                            else tw.select(l.id);
                          } else if (l.kind === 'vehicle') tw.selectVehicle(l.id, true);
                          else if (l.kind === 'workspace') go(l.id);
                          else followLink(l);
                        }}
                      >
                        <Icon size={13} />
                        {l.kind === 'equipment' && l.id === id ? 'Focus' : l.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="insp-desc">No open recommendation for this asset: its stoppage, health, quality, energy and flow rules are within thresholds.</p>
      )}
      <p className="tw-honest">Deterministic rules over the current demo state — no language or predictive model is connected.</p>
    </div>
  );
}
