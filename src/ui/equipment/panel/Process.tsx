/**
 * The process now (the approved card's "Firing profile · now" block), from intel/panelData.ts processView:
 *
 *   kiln      the five zones along the kiln — actual (dot, glowing by its band) against the dashed setpoint curve with
 *             the heat under it and each zone's ±warning band — beside one deviation gauge per zone;
 *   PV / SP   any other process value with a setpoint (spray dryer, dryer, presses, glaze line, slip tanks): the
 *             deviation gauges only;
 *   buffers   silos, tanks and buffers: a level gauge (% of capacity only — never a mass) with the low / high lines,
 *             the 60-min trend in %/h and what the level means on its side of the kiln.
 *
 * A gauge's bar spans ±1.5 × the alarm band around the setpoint; the green band is the warning band; the white line
 * the setpoint. The band a value is in is said in words and with its icon (never colour alone); a missing, bad or
 * stale reading says why instead of a marker — never a zero standing in.
 */
import { memo, type ReactNode } from 'react';
import { pureIcon } from '../../kit/icon';
import { CircleCheck, CircleHelp, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Section } from './Shell';
import { deviationText, valueText, type IntelProcess, type LevelGauge, type ProcessGauge } from '../intel/panelData';
import { TONE_ICON } from './tone';

type Band = ProcessGauge['level'];
const BAND: Record<NonNullable<Band> | 'none', { tone: string; icon: LucideIcon; words: string }> = {
  within: { tone: 'good', icon: CircleCheck, words: 'within band' },
  warning: { tone: 'warning', icon: TriangleAlert, words: 'beyond the warning band' },
  alarm: { tone: 'critical', icon: OctagonX, words: 'beyond the alarm band' },
  none: { tone: 'neutral', icon: CircleHelp, words: 'not compared' },
};
const bandOf = (g: ProcessGauge) => BAND[g.level ?? 'none'];

/** One sentence per gauge (tooltip and screen readers). */
export function gaugeSentence(g: ProcessGauge): string {
  const u = g.unit ? ` ${g.unit}` : '';
  if (g.level == null) return `${g.label}: ${g.reason ?? 'not compared'}${g.pv != null && g.staleAt != null ? ` · last value ${valueText(g.pv, g.digits)}${u}` : ''}.`;
  const bands = g.warn != null ? ` (warning ±${valueText(g.warn, g.digits)}${u}${g.alarm != null ? `, alarm ±${valueText(g.alarm, g.digits)}${u}` : ''})` : '';
  return `${g.label}: actual ${valueText(g.pv, g.digits)}${u} vs setpoint ${valueText(g.sp, g.digits)}${u}, ${deviationText(g)} — ${bandOf(g).words}${bands}.`;
}

/** Half-width of a gauge's bar: 1.5 × the alarm band (the kiln's peak zones: ±30 °C), else 3 × the warning band, else the deviation. */
const spanOf = (g: ProcessGauge) => (g.alarm != null && g.alarm > 0 ? g.alarm * 1.5 : g.warn != null && g.warn > 0 ? g.warn * 3 : Math.max(Math.abs(g.dev ?? 0) * 1.5, 1));

function Gauge({ g }: { g: ProcessGauge }) {
  const b = bandOf(g);
  const Icon = pureIcon(b.icon);
  const R = spanOf(g);
  const band = g.warn != null ? Math.min(50, (g.warn / R) * 50) : null;
  const pos = g.dev != null ? 50 + Math.max(-1, Math.min(1, g.dev / R)) * 50 : null;
  const off = g.dev != null && Math.abs(g.dev) > R;
  const sentence = gaugeSentence(g);
  return (
    <li className={`eqp-gauge t-${b.tone}`} title={sentence}>
      <span className="eqp-gauge-l">
        <span className="n">{g.short}</span>
        <span className="pv num">
          {g.pv != null ? `${valueText(g.pv, g.digits)} / ${valueText(g.sp, g.digits)}${g.unit ? ` ${g.unit}` : ''}` : 'no value'}
        </span>
      </span>
      <span className="eqp-gauge-bar" aria-hidden>
        {band != null && <span className="band" style={{ left: `${50 - band}%`, width: `${band * 2}%` }} />}
        <span className="sp" />
        {pos != null && g.level != null && <span className={`mk ${off ? 'off' : ''}`} style={{ left: `${pos}%` }} />}
      </span>
      <span className={`eqp-gauge-d status ${b.tone} num`}>
        <Icon size={11} strokeWidth={2.2} aria-hidden />
        {g.level != null ? deviationText(g) : g.staleAt != null ? 'stale' : '—'}
        <span className="sr-only"> {sentence}</span>
      </span>
    </li>
  );
}

function Gauges({ gauges, caption }: { gauges: ProcessGauge[]; caption: string }) {
  return (
    <div className="eqp-gauges">
      <ul aria-label="Deviation from setpoint">
        {gauges.map((g) => (
          <Gauge key={g.pvId} g={g} />
        ))}
      </ul>
      <p className="eqp-fine">{caption}</p>
    </div>
  );
}

const ZW = 560;
const ZH = 180;
const niceDown = (v: number) => Math.floor(v / 100) * 100;
const niceUp = (v: number) => Math.ceil(v / 100) * 100;

/** The kiln's zones along the kiln: actual (dots) vs the setpoint curve (dashed), the heat under it, each zone's ±warning band. */
function ZoneProfile({ gauges }: { gauges: ProcessGauge[] }) {
  const vals = gauges.flatMap((g) => [g.pv, g.sp, g.sp != null && g.alarm != null ? g.sp + g.alarm : null, g.sp != null && g.alarm != null ? g.sp - g.alarm : null]).filter((v): v is number => v != null);
  const lo = vals.length ? Math.max(0, niceDown(Math.min(...vals) - 60)) : 0;
  const hi = vals.length ? niceUp(Math.max(...vals) + 40) : 100;
  const y = (v: number) => ZH - ((v - lo) / Math.max(1, hi - lo)) * ZH;
  const step = ZW / gauges.length;
  const xs = gauges.map((_, i) => step * (i + 0.5));
  const unit = gauges.find((g) => g.unit)?.unit ?? '';
  const pts = gauges.map((g, i) => (g.sp != null ? { x: xs[i], y: y(g.sp) } : null)).filter((p): p is { x: number; y: number } => p != null);
  const sp = pts.length ? `M0 ${pts[0].y.toFixed(1)} ${pts.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L${ZW} ${pts[pts.length - 1].y.toFixed(1)}` : '';
  const off = gauges.filter((g) => g.level === 'warning' || g.level === 'alarm');
  const unread = gauges.filter((g) => g.level == null);
  const summary = [
    `Zone temperatures along the kiln, actual against setpoint.`,
    off.length ? off.map((g) => `${g.short} ${deviationText(g)} ${bandOf(g).words}`).join('; ') + '.' : unread.length < gauges.length ? 'Every compared zone within its warning band.' : '',
    unread.length ? `${unread.map((g) => g.short).join(', ')} not compared.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const mid = (lo + hi) / 2;
  return (
    <svg className="eqp-zones" viewBox={`0 0 ${ZW + 56} ${ZH + 40}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet">
      <g transform="translate(46,12)">
        {[hi, mid, lo].map((v, i) => (
          <g key={i}>
            <line className={i === 2 ? 'axis' : 'grid'} x1={0} x2={ZW} y1={y(v)} y2={y(v)} />
            <text className="tick" x={-8} y={y(v) + 4} textAnchor="end">
              {valueText(v, 0)}
              {i === 2 && unit ? ` ${unit}` : ''}
            </text>
          </g>
        ))}
        {sp && <path className="heat" d={`${sp} L${ZW} ${ZH} L0 ${ZH} Z`} />}
        {sp && <path className="spl" d={sp} />}
        {gauges.map((g, i) => {
          const b = bandOf(g);
          const x = xs[i];
          const top = g.sp != null && g.warn != null ? y(g.sp + g.warn) : null;
          const cy = g.pv != null ? y(g.pv) : g.sp != null ? y(g.sp) : ZH / 2;
          return (
            <g key={g.pvId} className={`zone t-${b.tone}`}>
              <title>{gaugeSentence(g)}</title>
              {top != null && <rect className="zband" x={x - 25} y={top} width={50} height={Math.max(2, y(g.sp! - g.warn!) - top)} rx={4} />}
              {g.pv != null ? (
                <>
                  <circle className="glow" cx={x} cy={cy} r={13} />
                  <circle className="dot" cx={x} cy={cy} r={7} />
                </>
              ) : (
                <circle className="hollow" cx={x} cy={cy} r={6} />
              )}
              <text className="pvl num" x={x} y={Math.max(10, cy - 18)} textAnchor="middle">
                {g.pv != null ? valueText(g.pv, g.digits) : '—'}
              </text>
              <text className="zn" x={x} y={ZH + 24} textAnchor="middle">
                {g.short}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function Level({ l }: { l: LevelGauge }) {
  const tone = l.value == null ? 'neutral' : l.band?.concern ? 'warning' : 'good';
  const Icon = pureIcon(TONE_ICON[tone as 'good' | 'warning' | 'neutral']);
  const trend = l.trend != null ? `${l.trend >= 0 ? '+' : '−'}${valueText(Math.abs(l.trend), 1)} %/h` : null;
  const words = l.value == null ? (l.reason ?? 'No level value') : l.band?.label ?? '';
  return (
    <div className={`eqp-level t-${tone}`} title={`${l.name} · ${l.signalId} (simulated level signal, % of capacity).${l.bulk ? ' Level % only — no level-to-mass calibration is configured, so no mass is shown.' : ''}`}>
      <div className="eqp-level-h">
        <span className="n">{l.name}</span>
        <b className="v num">
          {l.value != null ? valueText(l.value, 0) : '—'}
          {l.value != null && <small>%</small>}
        </b>
      </div>
      <div
        className="eqp-level-bar"
        role="meter"
        aria-label={`${l.name} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={l.value ?? undefined}
        aria-valuetext={l.value != null ? `${valueText(l.value, 0)} % · ${words}` : words}
      >
        {l.value != null && <span className="fill" style={{ width: `${Math.max(0, Math.min(100, l.value))}%` }} />}
        <span className="lim low" style={{ left: `${l.low}%` }} title={`Low line ${valueText(l.low, 0)} %`} />
        <span className="lim high" style={{ left: `${l.high}%` }} title={`High line ${valueText(l.high, 0)} %`} />
      </div>
      <div className="eqp-level-f">
        <span className={`status ${tone}`}>
          <Icon size={11} strokeWidth={2.2} aria-hidden />
          {words}
          {l.staleAt != null && ' · last value of a stale feed'}
        </span>
        <span className="num">{trend ? `Trend ${trend} · last 60 min` : `Trend: ${l.trendReason ?? 'not available'}`}</span>
      </div>
      <p className="eqp-fine">
        Low line {valueText(l.low, 0)} % · high line {valueText(l.high, 0)} %{l.bulk ? ' · level % only — no mass calibration' : ''}
      </p>
    </div>
  );
}

const CAPTION = 'Bar: ±1.5 × the alarm band around the setpoint · green band = warning band · white line = setpoint';

export const ProcessBlock = memo(function ProcessBlock({ id, process, meta }: { id: string; process: IntelProcess; meta?: ReactNode }) {
  const { kind, gauges, level } = process;
  const title = kind === 'zones' ? 'Firing profile · now' : gauges.length && level ? 'Level and process values · now' : gauges.length ? 'Process values vs setpoint · now' : 'Level · now';
  return (
    <Section id={`eqp-proc-${id}`} title={title} meta={meta}>
      <div className={`eqp-proc k-${kind} ${level ? 'has-level' : ''}`}>
        {kind === 'zones' && <ZoneProfile gauges={gauges} />}
        {level && <Level l={level} />}
        {gauges.length > 0 && <Gauges gauges={gauges} caption={CAPTION} />}
      </div>
    </Section>
  );
});
