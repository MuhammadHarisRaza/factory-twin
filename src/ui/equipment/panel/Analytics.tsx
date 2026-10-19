/**
 * How the subject has behaved: a slim state timeline over the minute log with time in state, the
 * output rate in 10-min steps against the ideal rate, and compact facts — main stop reason and lost
 * output in the shift, MTBF / MTTR over the retained history, mean rate and output over the window.
 * Vehicles: moving / stationary over their route legs and their handling in the last hour.
 * Every mark carries its figure in a tooltip; nothing is drawn without samples.
 */
import { CircleHelp } from 'lucide-react';
import type { OperationalState } from '../../../model/types';
import { OPERATIONAL_STATE_LABEL } from '../../../sim/metrics';
import { formatClock, formatDuration } from '../../../sim/time';
import { fmt1, fmtInt } from '../../kit/format';
import type { IntelAnalytics, TimelineSegment } from '../intel/types';

const stateLabel = (state: OperationalState, label?: string) => label ?? OPERATIONAL_STATE_LABEL[state];
/** A duration in the legend: exact leg minutes can be under one minute (a short driving leg). */
const legendDuration = (min: number) => (min > 0 && min < 0.5 ? '< 1 min' : formatDuration(min));

function Timeline({ a, vehicle }: { a: IntelAnalytics; vehicle: boolean }) {
  const span = Math.max(1, a.window.to - a.window.from);
  const segs: TimelineSegment[] = a.timeline.filter((s) => s.to > s.from);
  if (!segs.length) return null;
  return (
    <div className="eqp-tl">
      <div className="eqp-tl-bar" role="img" aria-label={`State over the ${a.window.label.toLowerCase()}: ${a.timeInState.map((t) => `${stateLabel(t.state, t.label)} ${legendDuration(t.minutes)}`).join(', ')}`}>
        {segs.map((s) => (
          <span
            key={s.from}
            className={`eqp-seg ${vehicle ? 'eqp-v' : 'eqp-m'}-${s.state}`}
            style={{ left: `${((s.from - a.window.from) / span) * 100}%`, width: `${((s.to - s.from) / span) * 100}%` }}
            title={`${stateLabel(s.state, s.label)} · ${formatClock(s.from)}–${formatClock(s.to)} (${legendDuration(s.to - s.from)})`}
          />
        ))}
      </div>
      <div className="eqp-tl-axis num" aria-hidden>
        <span>{formatClock(a.window.from)}</span>
        <span>now</span>
      </div>
      <ul className="eqp-tl-legend">
        {a.timeInState.map((t) => (
          <li key={t.state}>
            <span className={`eqp-sw ${vehicle ? 'eqp-v' : 'eqp-m'}-${t.state}`} aria-hidden />
            {stateLabel(t.state, t.label)}
            <b className="num">{legendDuration(t.minutes)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RateTrend({ rate, from }: { rate: NonNullable<IntelAnalytics['rate']>; from: number }) {
  const vals = rate.points.filter((v): v is number => v != null);
  if (vals.length < 2) return null;
  const W = 300;
  const H = 46;
  const top = Math.max(rate.ideal ?? 0, ...vals) * 1.08 || 1;
  const n = rate.points.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - 2 - (v / top) * (H - 6);
  let d = '';
  let pen = false;
  rate.points.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const last = [...rate.points].reverse().find((v) => v != null) ?? null;
  const idealLabel = rate.idealLabel ?? 'ideal rate';
  return (
    <div className="eqp-rate">
      <div className="eqp-rate-h">
        <span>Output rate · {rate.unit} · {rate.stepMin}-min means</span>
        <span className="num">
          {last != null && (
            <>
              latest <b>{fmtInt(last)}</b>
            </>
          )}
          {rate.ideal != null && (
            <>
              {' '}
              <span className="ideal-key" aria-hidden />
              {idealLabel} {fmtInt(rate.ideal)}
            </>
          )}
        </span>
      </div>
      <svg className="eqp-rate-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Output rate over the window, last ${last != null ? fmtInt(last) : '—'} ${rate.unit}${rate.ideal != null ? ` against the ${idealLabel} ${fmtInt(rate.ideal)}` : ''}`}>
        <line className="base" x1={0} x2={W} y1={H - 2} y2={H - 2} vectorEffect="non-scaling-stroke" />
        {rate.ideal != null && <line className="ideal" x1={0} x2={W} y1={y(rate.ideal)} y2={y(rate.ideal)} vectorEffect="non-scaling-stroke" />}
        <path className="line" d={d} vectorEffect="non-scaling-stroke" />
        {rate.points.map((v, i) => (
          <rect key={i} className="hit" x={x(i) - W / n / 2} y={0} width={W / n} height={H}>
            <title>{`${formatClock(from + i * rate.stepMin)}–${formatClock(from + (i + 1) * rate.stepMin)} · ${v == null ? 'no sample' : `${fmtInt(v)} ${rate.unit}`}`}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

/** The not-confirmed mark of a figure resting on a stale feed (the KPI tiles' mark, Decision 1). */
function NotConfirmed({ label }: { label: string }) {
  return (
    <span className="eqp-nc" title={label}>
      <CircleHelp size={11} strokeWidth={2.2} aria-hidden />
      Not confirmed
    </span>
  );
}

const REACHED: Record<'yes' | 'no' | 'unknown', string> = { yes: 'reached line output', no: 'absorbed by buffers', unknown: 'line impact unknown' };

/**
 * `figuresOnly` (added): the compact figures next to the range-controlled charts — stops, MTBF / MTTR and the
 * shift's loss breakdown, each with its own window — without the fixed-window timeline, rate trend and facts.
 */
export function Analytics({ a, vehicle, figuresOnly = false }: { a: IntelAnalytics; vehicle: boolean; figuresOnly?: boolean }) {
  const st = a.stops;
  const loss = a.loss;
  // Slip and powder are tile-equivalents, never tiles.
  const unit = loss?.unit ?? 'tiles';
  const parts = loss?.breakdown?.filter((b) => b.tiles >= 0.5) ?? [];
  return (
    <div className="eqp-an">
      {!figuresOnly && <Timeline a={a} vehicle={vehicle} />}
      {!figuresOnly && a.rate && <RateTrend rate={a.rate} from={a.window.from} />}
      {(st || loss) && (
        <div className="eqp-stats">
          {st && st.topReason && (
            // The main stop reason only when there is one ("no unplanned stop" is the Stoppages tile's).
            <div className="cell" title={st.basis}>
              <span className="l">Main stop reason · shift</span>
              <b>{st.topReason.label}</b>
              <small className="num">
                {formatDuration(st.topReason.minutes)}
                {st.notConfirmed && <NotConfirmed label={st.notConfirmed} />}
              </small>
            </div>
          )}
          {st && (
            <div className="cell" title={st.basis}>
              <span className="l">MTBF / MTTR</span>
              <b className="num">
                {st.mtbfH != null ? `${fmt1(st.mtbfH)} h` : '—'} / {st.mttrMin != null ? formatDuration(st.mttrMin) : '—'}
              </b>
              <small>
                {st.mtbfH == null ? 'fewer than 2 own breakdowns & process stops' : 'own breakdowns & process stops · retained history'}
                {st.notConfirmed && !st.topReason && <NotConfirmed label={st.notConfirmed} />}
              </small>
            </div>
          )}
          {loss && (
            <div className="cell wide" title={loss.basis}>
              <span className="l">Output not made at the ideal rate · shift</span>
              <b className="num">
                {fmtInt(loss.tiles)} {unit} <span className="muted">· {fmtInt(loss.m2)} m²{unit === 'tiles' ? '' : ' eq.'}</span>
                <small className={`reach ${loss.reachedLine}`}>{REACHED[loss.reachedLine]}</small>
                {loss.notConfirmed && <NotConfirmed label={loss.notConfirmed} />}
              </b>
              {parts.length > 0 && loss.tiles >= 1 && (
                <>
                  <span className="eqp-loss-bar" aria-hidden>
                    {parts.map((b) => (
                      <i key={b.key} className={`eqp-p-${b.key}`} style={{ flexGrow: b.tiles }} />
                    ))}
                  </span>
                  <ul className="eqp-loss-parts">
                    {parts.map((b) => (
                      <li key={b.key} title={b.hint}>
                        <span className={`eqp-sw eqp-p-${b.key}`} aria-hidden />
                        {b.label} <b className="num">{fmtInt(b.tiles)}</b>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {!figuresOnly && a.facts && a.facts.length > 0 && (
        <dl className="eqp-facts">
          {a.facts.map((f) => (
            <div key={f.label} title={f.hint}>
              <dt>{f.label}</dt>
              <dd className="num">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
