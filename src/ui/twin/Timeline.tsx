import { FastForward } from 'lucide-react';
import { openEvent, useApp } from '../../app/store';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { SourceTag } from '../kit/Status';
import { TIMELINE_LANES, shiftTimeline, type TimelineLane, type TimelineMarker } from './derive';
import { useTip } from './Tip';

const LANE_LABEL: Record<TimelineLane, string> = {
  ...(Object.fromEntries(TIMELINE_LANES.map((l) => [l.id, l.label])) as Record<Exclude<TimelineLane, 'scenario'>, string>),
  scenario: 'Scenario inputs',
};
const LANE_ORDER: TimelineLane[] = [...TIMELINE_LANES.map((l) => l.id), 'scenario'];

function activate(m: TimelineMarker) {
  if (m.eventId) openEvent(m.eventId);
  else if (m.lane === 'scenario') useApp.getState().setScenariosOpen(true);
}

/**
 * Current-shift time strip: the operational events of the shift (one lane each for production
 * & equipment, quality, vehicles and data quality; colour = severity) and the scenario inputs,
 * on an 8-hour axis with a now marker, the simulated clock and "skip ahead 15 min" (play / pause
 * and speed live in the header). A marker opens its event record in Events & Reports.
 */
export function Timeline() {
  const running = useSim((s) => s.running);
  const tl = useSimValue((s) => shiftTimeline(s));
  const tip = useTip<string>();
  const span = tl.to - tl.from;
  const pct = (t: number) => (Math.max(0, Math.min(span, t - tl.from)) / span) * 100;
  const hours = Array.from({ length: span / 60 + 1 }, (_, i) => tl.from + i * 60);

  const marker = (m: TimelineMarker) => {
    const left = pct(m.t);
    const width = Math.max(0, pct(m.end) - left);
    return (
      <button
        key={m.lane + m.id}
        className={`tw-mk ${m.tone} ${m.open ? 'open' : ''}`}
        style={{ left: `${left}%`, width: `max(4px, ${width}%)` }}
        onClick={() => {
          tip.hide();
          activate(m);
        }}
        aria-label={`${formatClock(m.t)} ${m.title}${m.eventId ? ` (${m.eventId})` : ''}`}
        {...tip.bind(m.lane + m.id, 'top')}
      />
    );
  };

  return (
    <div className="tw-tl overlay-panel" role="group" aria-label={`Timeline of operational events · ${tl.shift.label} (simulated)`}>
      <div className="tw-tl-ctl">
        <button className="btn ghost sm" onClick={() => useSim.getState().skip(15)} title="Skip ahead 15 simulated minutes (play / pause and speed are in the header)">
          <FastForward size={13} />
          +15 min
        </button>
        <span className="tw-tl-clock" title={`${tl.shift.label} · simulated plant time${running ? '' : ' · paused'}`}>
          <b className="num">{formatClock(tl.now)}</b>
          <small>Shift {tl.shift.id}{running ? '' : ' · paused'}</small>
        </span>
      </div>
      <div className="tw-tl-main">
        <div className="tw-tl-track" title={`Rows: ${LANE_ORDER.map((l) => LANE_LABEL[l].toLowerCase()).join(' · ')}`}>
          <div className="tw-tl-past" style={{ width: `${pct(tl.now)}%` }} />
          {hours.slice(1, -1).map((h) => (
            <span key={h} className="tw-tl-tick" style={{ left: `${pct(h)}%` }} />
          ))}
          {LANE_ORDER.map((lane) => (
            <div key={lane} className={`tw-tl-lane ${lane}`} role="group" aria-label={LANE_LABEL[lane]}>
              {tl.markers.filter((m) => m.lane === lane).map(marker)}
            </div>
          ))}
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
        const m = tl.markers.find((x) => x.lane + x.id === key);
        if (!m) return null;
        return (
          <>
            <b>
              {formatClock(m.t)} · {m.title}
            </b>
            <div className="tw-tip-row">{m.detail}</div>
            <div className="tw-tip-foot">
              {m.eventId ? (
                <>
                  <span className="mono">{m.eventId}</span> · {LANE_LABEL[m.lane]}
                </>
              ) : (
                'Scenario input'
              )}{' '}
              <SourceTag source={m.source} />
              {m.eventId ? ' · click to open the event report' : ' · click to open scenarios'}
            </div>
          </>
        );
      })}
    </div>
  );
}
