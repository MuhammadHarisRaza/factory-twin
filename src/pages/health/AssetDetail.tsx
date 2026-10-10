import { FastForward, FlaskConical, Info, MapPin, MessageSquareText, Wrench, X } from 'lucide-react';
import { openEquipment, useApp } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { OPS_BY_ID, SCENARIO_KIND_LABELS, STAGE_BY_ID } from '../../model/plant';
import { formatH, type MaintenanceRecord } from '../../sim/health';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock, formatDateTime } from '../../sim/time';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { MachineStatus } from '../../ui/kit/Status';
import { CBM_DURATION_MIN, PM_SOON_H, faultGate, lastMaintenance, maintenanceGate, maintenanceHistory, signed, type AssetRow } from './derive';
import { LevelBadge, levelColor } from './badges';
import { PmDue, etaText } from './AssetTable';

export const COPILOT_QUESTION = 'Is any machine at risk of failure?';

/** Confirmation of an action started from this page; `until` = minute the "skip ahead" helper jumps to. */
export type Feedback = { id: string; kind: 'cbm' | 'fault'; at: number; until: number };

/** Selected-asset strip: identity, condition, live state and the actions. */
export function SelectedAsset({
  row,
  auto,
  now,
  faultAt,
  feedback,
  onFeedback,
  onFaultStarted,
}: {
  row: AssetRow;
  auto: boolean;
  now: number;
  faultAt: number | null;
  feedback: Feedback | null;
  onFeedback: (f: Feedback | null) => void;
  onFaultStarted: (id: string, minute: number) => void;
}) {
  const { id, h } = row;
  const eq = EQUIPMENT_BY_ID[id];
  const stage = OPS_BY_ID[id]?.stage;
  const cbm = maintenanceGate(row);
  const fault = faultGate(row, faultAt, now);
  const reasons = [...new Set([cbm.reason, fault.reason].filter((x): x is string => !!x))];
  const fb = feedback && feedback.id === id ? feedback : null;

  const scheduleCbm = () => {
    const sc = useSim.getState().activate({
      kind: 'maintenance',
      equipmentId: id,
      count: CBM_DURATION_MIN,
      end: null,
      label: `${SCENARIO_KIND_LABELS.maintenance} · ${id}`,
    });
    // +1: the stop closes while minute start + duration is simulated.
    onFeedback({ id, kind: 'cbm', at: sc.start, until: sc.start + CBM_DURATION_MIN + 1 });
  };
  const simulateFault = () => {
    const sc = useSim.getState().activate({ kind: 'degradation', equipmentId: id, end: null, label: `${SCENARIO_KIND_LABELS.degradation} · ${id}` });
    onFaultStarted(id, sc.start);
    onFeedback({ id, kind: 'fault', at: sc.start, until: sc.start + 30 });
  };

  return (
    <section className="panel col-12 mh-sel" aria-label="Selected asset">
      <div className="mh-sel-main">
        <div className="mh-sel-id">
          <span className="mh-eyebrow">{auto ? 'Most at-risk asset · auto-selected' : 'Selected asset'}</span>
          <h2>
            <span className="mono">{id}</span> · {row.name}
          </h2>
          <p>
            {row.asset.component}
            {stage ? ` · ${STAGE_BY_ID[stage].name}` : ''}
            {eq ? ` · Zone ${eq.zone}` : ''}
          </p>
        </div>
        <dl className="mh-sel-facts">
          <div>
            <dt>Condition</dt>
            <dd>
              <LevelBadge level={h.level} />
            </dd>
          </div>
          <div>
            <dt>Health score</dt>
            <dd>
              <b className="num">{h.level === 'offline' ? '—' : h.score}</b>
              {h.level !== 'offline' && <small>/ 100</small>}
            </dd>
          </div>
          <div>
            <dt>Machine</dt>
            <dd>
              <MachineStatus state={row.state} />
            </dd>
          </div>
          <div>
            <dt title="Extrapolating the 3-h vibration trend to the trip limit">Next trip (trend)</dt>
            <dd>
              <b className="num">{h.etaTripH != null ? `≈ ${formatH(h.etaTripH)}` : 'None'}</b>
            </dd>
          </div>
        </dl>
        <div className="spacer" />
        <div className="mh-actions">
          <button className="btn primary" disabled={!cbm.enabled} title={cbm.reason ?? `Plan a ${CBM_DURATION_MIN}-min condition-based maintenance stop now (scenario input)`} onClick={scheduleCbm}>
            <Wrench size={14} aria-hidden />
            Schedule condition-based maintenance
          </button>
          <button className="btn" disabled={!fault.enabled} title={fault.reason ?? 'Scenario input: start a developing component fault on this asset'} onClick={simulateFault}>
            <FlaskConical size={14} aria-hidden />
            Simulate developing fault
          </button>
          <button className="btn" onClick={() => openEquipment(id)} title="Locate the asset in the Factory Twin">
            <MapPin size={14} aria-hidden />
            View in Factory Twin
          </button>
          <button className="btn" onClick={() => useApp.getState().openCopilot(COPILOT_QUESTION)} title={`Ask the copilot: “${COPILOT_QUESTION}”`}>
            <MessageSquareText size={14} aria-hidden />
            Ask copilot
          </button>
        </div>
      </div>
      {(fb || reasons.length > 0) && (
        <div className="mh-sel-foot">
          {fb ? (
            <span className="mh-feedback" role="status">
              <Info size={13} aria-hidden />
              {fb.kind === 'cbm' ? (
                <span>
                  Condition-based maintenance scheduled on <b>{id}</b>: planned stop {formatClock(fb.at)}–{formatClock(fb.at + CBM_DURATION_MIN)} (scenario input). The
                  developing fault is cleared when the work completes.
                </span>
              ) : (
                <span>
                  Developing fault started on <b>{id}</b> at {formatClock(fb.at)} (scenario input). Detection works on the observed signals only — expect the
                  level to rise within about 10–30 simulated minutes.
                </span>
              )}
              {now < fb.until && (
                <button className="btn sm" onClick={() => useSim.getState().skip(fb.until - now)} title={`Advance the simulation clock to ${formatClock(fb.until)}`}>
                  <FastForward size={12} aria-hidden />
                  {fb.kind === 'cbm' ? 'Skip to completion' : `Skip ahead ${fb.until - now} min`}
                </button>
              )}
              <button className="btn ghost sm icon" onClick={() => onFeedback(null)} title="Dismiss" aria-label="Dismiss">
                <X size={12} />
              </button>
            </span>
          ) : (
            reasons.map((r) => (
              <span key={r} className="mh-why">
                <Info size={12} aria-hidden />
                {r}
              </span>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function lastLabel(m: MaintenanceRecord | null) {
  if (!m) return 'none recorded';
  return `${formatDateTime(m.start)} · ${m.type.toLowerCase()}`;
}

/** Rule-based assessment of the selected asset: readings, findings, impact, recommendation, PM status. */
export function AssessmentPanel({ row }: { row: AssetRow }) {
  const { id, asset: a, h } = row;
  const last = useSimValue((s) => lastMaintenance(maintenanceHistory(s, id), Math.max(0, s.minute - 1)), [id]);
  const running = h.reading.running;
  const offline = h.level === 'offline';
  const pmShare = Math.min(1, Math.max(0, h.runtimeSincePmH / a.pmIntervalH));
  const eta = etaText(row);
  return (
    <Panel className="col-4 mh-assess" title="Condition assessment" subtitle={`${id} · rule-based, on the current signals`} actions={<LevelBadge level={h.level} />}>
      <dl className="dl">
        <dt>Vibration</dt>
        <dd>
          {fmt1(h.reading.vibration)} mm/s RMS
          <span className="muted"> · expected {fmt1(h.expectedVibration)} {running ? `at ${fmtPct(h.reading.load, 0)} load` : '(not running)'}</span>
        </dd>
        <dt>Observed ÷ expected</dt>
        <dd>
          {h.vibrationRatio == null ? '—' : `${h.vibrationRatio.toFixed(2)}×`}
          <span className="muted"> · mean of the last 60 min of running</span>
        </dd>
        <dt>Trend</dt>
        <dd>
          {h.trend == null ? '—' : `${signed(h.trend)} mm/s per h`}
          <span className="muted"> · last 3 h</span>
        </dd>
        <dt>To alarm / trip</dt>
        <dd>{eta ?? <span className="muted">No rising trend towards the limits</span>}</dd>
        <dt>Temperature</dt>
        <dd>
          {fmtInt(h.reading.temperature)} °C<span className="muted"> · alarm {a.temp.alarm} °C</span>
        </dd>
        <dt>Motor current</dt>
        <dd>
          {fmtInt(h.reading.current)} A<span className="muted"> · rated {a.currentRated} A</span>
        </dd>
        <dt>Vibration limits</dt>
        <dd>
          Alarm {a.vib.alarm} · trip {a.vib.trip} mm/s
        </dd>
      </dl>

      <section className="mh-sec">
        <h3>Findings</h3>
        {h.findings.length ? (
          <ul className="mh-findings">
            {h.findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            {offline ? 'Not running in the last 60 min — the condition is assessed only while the machine runs.' : 'No abnormal findings — signals are within the expected band for the current load.'}
          </p>
        )}
      </section>

      <section className="mh-sec">
        <h3>Operational impact</h3>
        <p className={h.impact ? '' : 'muted'}>{h.impact ?? 'None expected at the current condition.'}</p>
      </section>

      <section className={`mh-sec mh-reco ${h.recommendation ? 'on' : ''}`}>
        <h3>Recommended action (rule-based)</h3>
        <p className={h.recommendation ? '' : 'muted'}>{h.recommendation ?? 'No action required — continue routine monitoring and the planned PM interval.'}</p>
      </section>

      <section className="mh-sec">
        <h3>Runtime &amp; PM interval</h3>
        <div className="mh-pm">
          <span>
            <b className="num">{fmtInt(h.runtimeSincePmH)} h</b> run since last maintenance <span className="muted">of a {fmtInt(a.pmIntervalH)} h PM interval</span>
          </span>
          <PmDue h={h.pmDueH} />
        </div>
        <div className="meter" title={`${fmtPct(pmShare, 0)} of the PM interval used`}>
          <i style={{ width: `${pmShare * 100}%`, background: h.pmDueH < PM_SOON_H ? levelColor('warning') : undefined }} />
        </div>
        <p className="mh-last">Last maintenance: {lastLabel(last)}</p>
      </section>
    </Panel>
  );
}
