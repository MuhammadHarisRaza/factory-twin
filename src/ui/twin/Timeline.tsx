import { FastForward, Pause, Play } from 'lucide-react';
import { useApp } from '../../app/store';
import { useTwin } from '../../store';
import { SPEEDS, useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { SourceTag } from '../kit/Status';
import { shiftTimeline, type TimelineMarker } from './derive';
import { useTip } from './Tip';

const TONE_LABEL: Record<TimelineMarker['tone'], string> = {
  critical: 'Critical',
  serious: 'Serious',
  warning: 'Warning',
  neutral: 'Info',
  accent: 'Scenario',
};

function locate(m: TimelineMarker) {
  const tw = useTwin.getState();
  if (m.equipmentId) tw.select(m.equipmentId);
  else if (m.vehicleId) tw.selectVehicle(m.vehicleId, true);
  else if (m.kind === 'scenario') useApp.getState().setScenariosOpen(true);
}

/**
 * Current-shift time strip: stops, alerts and scenarios on an 8-hour axis with a now
 * marker, plus the demo clock controls (play / pause, speed, skip ahead 15 min).
 */
export function Timeline() {
  const running = useSim((s) => s.running);
  const speed = useSim((s) => s.speed);
  const tl = useSimValue((s) => shiftTimeline(s));
  const tip = useTip<string>();
  const span = tl.to - tl.from;
  const pct = (t: number) => (Math.max(0, Math.min(span, t - tl.from)) / span) * 100;
  const hours = Array.from({ length: span / 60 + 1 }, (_, i) => tl.from + i * 60);
  const clickable = (m: TimelineMarker) => !!(m.equipmentId || m.vehicleId || m.kind === 'scenario');

  const marker = (m: TimelineMarker) => {
    const left = pct(m.t);
    const width = m.end != null ? Math.max(0, pct(m.end) - left) : 0;
    return (
      <button
        key={m.kind + m.id}
        className={`tw-mk ${m.kind} ${m.tone} ${m.open ? 'open' : ''}`}
        style={{ left: `${left}%`, ...(m.kind !== 'alert' ? { width: `max(4px, ${width}%)` } : null) }}
        onClick={() => {
          tip.hide();
          locate(m);
        }}
        aria-label={`${formatClock(m.t)} ${m.title}`}
        aria-disabled={!clickable(m)}
        {...tip.bind(m.kind + m.id, 'top')}
      />
    );
  };

  return (
    <div className="tw-tl overlay-panel" role="group" aria-label={`Timeline · ${tl.shift.label} (simulated)`}>
      <div className="tw-tl-ctl">
        <button className="btn ghost sm icon" onClick={() => (running ? useSim.getState().pause() : useSim.getState().play())} title={running ? 'Pause the simulation' : 'Run the simulation'} aria-label={running ? 'Pause' : 'Play'}>
          {running ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <select className="select tw-speed" value={speed} onChange={(e) => useSim.getState().setSpeed(Number(e.target.value))} aria-label="Simulation speed" title="Simulation speed">
          {SPEEDS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn ghost sm" onClick={() => useSim.getState().skip(15)} title="Skip ahead 15 simulated minutes">
          <FastForward size={13} />
          +15 min
        </button>
        <span className="tw-tl-clock" title={tl.shift.label}>
          <b className="num">{formatClock(tl.now)}</b>
          <small>Shift {tl.shift.id}</small>
        </span>
      </div>
      <div className="tw-tl-main">
        <div className="tw-tl-track">
          <div className="tw-tl-past" style={{ width: `${pct(tl.now)}%` }} />
          {hours.slice(1, -1).map((h) => (
            <span key={h} className="tw-tl-tick" style={{ left: `${pct(h)}%` }} />
          ))}
          <div className="tw-tl-lane l1">{tl.markers.filter((m) => m.kind === 'downtime').map(marker)}</div>
          <div className="tw-tl-lane l2">{tl.markers.filter((m) => m.kind === 'alert').map(marker)}</div>
          <div className="tw-tl-lane l3">{tl.markers.filter((m) => m.kind === 'scenario').map(marker)}</div>
          <span className="tw-tl-now" style={{ left: `${pct(tl.now)}%` }} aria-hidden />
        </div>
        <div className="tw-tl-axis" aria-hidden>
          {hours.map((h, i) => (
            <span key={h} className={`${i % 2 ? 'odd' : ''} ${i === 0 ? 'first' : i === hours.length - 1 ? 'last' : ''}`} style={{ left: `${pct(h)}%` }}>
              {formatClock(h)}
            </span>
          ))}
        </div>
      </div>
      {tip.render((key) => {
        const m = tl.markers.find((x) => x.kind + x.id === key);
        if (!m) return null;
        return (
          <>
            <b>
              {formatClock(m.t)} · {m.title}
            </b>
            <div className="tw-tip-row">{m.detail}</div>
            <div className="tw-tip-foot">
              {m.kind === 'alert' ? `${TONE_LABEL[m.tone]} alert` : m.kind === 'downtime' ? 'Stoppage' : 'Scenario input'} <SourceTag source={m.source} />
              {clickable(m) ? (m.equipmentId ? ` · click to locate ${m.equipmentId}` : m.vehicleId ? ' · click to follow the vehicle' : ' · click to open scenarios') : ''}
            </div>
          </>
        );
      })}
    </div>
  );
}
