/**
 * Machine Health — equipment intelligence / predictive maintenance demo. Rule-based
 * detection on the simulated condition-monitoring signals of the shared simulation:
 * fleet condition first, then the selected asset's signals, assessment, actions and
 * history. Nothing here is a trained model and no physical sensor is connected.
 */
import { useState } from 'react';
import { CalendarClock, CircleCheck, Info, Siren, TriangleAlert, Eye, type LucideIcon } from 'lucide-react';
import { formatH } from '../sim/health';
import { useSim, useSimValue } from '../sim/store';
import { fmtInt } from '../ui/kit/format';
import { StatusBadge, type Tone } from '../ui/kit/Status';
import { AssessmentPanel, SelectedAsset, type Feedback } from './health/AssetDetail';
import { AssetTable } from './health/AssetTable';
import { LEVEL_META, levelColor } from './health/badges';
import { assetRows, fleetSummary, PM_SOON_H, type AssetRow } from './health/derive';
import { ConditionEvents } from './health/ConditionEvents';
import { AlarmHistory, MaintenanceHistory } from './health/Histories';
import { SignalCharts } from './health/SignalCharts';
import './health.css';

export function MachineHealthPage() {
  // Reset Demo replays the baseline: drop selections and action confirmations with it.
  const resets = useSim((s) => s.resets);
  return <HealthWorkspace key={resets} />;
}

function HealthWorkspace() {
  const d = useSimValue((s) => ({ now: s.minute, rows: assetRows(s) }));
  const [picked, setPicked] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [faultAt, setFaultAt] = useState<Record<string, number>>({});

  const row = d.rows.find((r) => r.id === picked) ?? d.rows[0];
  const select = (id: string) => {
    setPicked(id);
    if (feedback && feedback.id !== id) setFeedback(null);
  };

  return (
    <div className="page mh">
      <div className="toolbar-row">
        <div className="notice mh-notice" role="note">
          <Info size={14} aria-hidden />
          <span>
            <b>Rule-based detection on simulated condition-monitoring signals</b> — no trained model or physical sensors are connected.
          </span>
        </div>
      </div>

      <Summary rows={d.rows} onSelect={select} />

      <AssetTable rows={d.rows} selected={row.id} onSelect={select} />

      <SelectedAsset
        row={row}
        auto={picked == null}
        now={d.now}
        faultAt={faultAt[row.id] ?? null}
        feedback={feedback}
        onFeedback={(f) => {
          setFeedback(f);
          // Keep the asset selected after an action, even if another one becomes the most at risk.
          if (f) setPicked(f.id);
        }}
        onFaultStarted={(id, minute) => setFaultAt((m) => ({ ...m, [id]: minute }))}
      />
      <SignalCharts row={row} />
      <AssessmentPanel row={row} />
      <ConditionEvents id={row.id} />
      <AlarmHistory id={row.id} />
      <MaintenanceHistory id={row.id} />
    </div>
  );
}

// ── Summary band ─────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function AssetLink({ r, onSelect }: { r: AssetRow; onSelect: (id: string) => void }) {
  return (
    <button className="row-link" onClick={() => onSelect(r.id)} title={`Inspect ${r.id}`}>
      <span className="mono">{r.id}</span> {r.name}
    </button>
  );
}

function Summary({ rows, onSelect }: { rows: AssetRow[]; onSelect: (id: string) => void }) {
  const f = fleetSummary(rows);
  const abnormal = f.alarm + f.warning + f.watch;
  const verdict: { tone: Tone; icon: LucideIcon; text: string } = f.alarm
    ? { tone: 'critical', icon: Siren, text: `${plural(f.alarm, 'asset')} at an alarm limit` }
    : f.warning
      ? { tone: 'warning', icon: TriangleAlert, text: `${plural(f.warning, 'asset')} with an abnormal trend` }
      : f.watch
        ? { tone: 'warning', icon: Eye, text: `${plural(f.watch, 'asset')} on watch` }
        : { tone: 'good', icon: CircleCheck, text: 'All assets within limits' };
  const VIcon = verdict.icon;
  const lowest = f.lowest;
  const trip = f.nextTrip;
  const pm = f.pmSoon[0] ?? f.nextPm;

  return (
    <section className="summary mh-summary" aria-label="Machine health summary">
      <div>
        <div className="kpi-label">Assets monitored</div>
        <div className={`mh-verdict ${verdict.tone}`}>
          <VIcon size={16} strokeWidth={2.2} aria-hidden />
          {verdict.text}
        </div>
        <div className="kpi-value">
          {f.monitored}
          <small>condition-monitored assets</small>
        </div>
        <div className="kpi-sub">
          <span>{f.monitored - f.notRunning} assessed</span>
          {f.notRunning > 0 && <span>· {f.notRunning} not running</span>}
          {f.inMaintenance.length > 0 && <span>· {f.inMaintenance.length} in maintenance</span>}
        </div>
      </div>

      <div>
        <div className="kpi-label">Abnormal condition</div>
        <div className="kpi-value">
          {abnormal}
          <small>of {f.monitored}</small>
        </div>
        <div className="kpi-sub mh-levels">
          <StatusBadge tone={LEVEL_META.alarm.tone} icon={LEVEL_META.alarm.icon} label={`${f.alarm} alarm`} />
          <StatusBadge tone={LEVEL_META.warning.tone} icon={LEVEL_META.warning.icon} label={`${f.warning} warning`} />
          <StatusBadge tone={LEVEL_META.watch.tone} icon={LEVEL_META.watch.icon} label={`${f.watch} watch`} />
        </div>
      </div>

      <div>
        <div className="kpi-label">Lowest health score</div>
        <div className="kpi-value">
          {lowest ? lowest.h.score : '—'}
          <small>/ 100</small>
        </div>
        {lowest && (
          <div className="meter" aria-hidden>
            <i style={{ width: `${lowest.h.score}%`, background: levelColor(lowest.h.level) }} />
          </div>
        )}
        <div className="kpi-sub">{lowest ? <AssetLink r={lowest} onSelect={onSelect} /> : <span>No asset running</span>}</div>
      </div>

      <div>
        <div className="kpi-label" title="Soonest time to a vibration trip limit, extrapolating each asset's 3-h trend">
          Next predicted trip
        </div>
        <div className="kpi-value">{trip ? `≈ ${formatH(trip.h.etaTripH!)}` : 'None'}</div>
        <div className="kpi-sub">
          {trip ? (
            <>
              <AssetLink r={trip} onSelect={onSelect} />
              <span>if the trend continues</span>
            </>
          ) : (
            <span>No rising vibration trend towards a trip limit</span>
          )}
        </div>
      </div>

      <div>
        <div className="kpi-label" title={`Assets with fewer than ${PM_SOON_H} run hours to their next preventive maintenance`}>
          Maintenance due soon
        </div>
        <div className="kpi-value">
          {f.pmSoon.length}
          <small>
            {f.pmSoon.length === 1 ? 'asset' : 'assets'} · PM within {PM_SOON_H} h
          </small>
        </div>
        <div className="kpi-sub">
          {pm && (
            <>
              <CalendarClock size={13} aria-hidden className="mh-ico" />
              <span>{f.pmSoon.length ? 'Soonest' : 'Next PM'}:</span>
              <AssetLink r={pm} onSelect={onSelect} />
              <span>{pm.h.pmDueH < 0 ? `overdue ${fmtInt(-pm.h.pmDueH)} h` : `in ${fmtInt(pm.h.pmDueH)} h`}</span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
