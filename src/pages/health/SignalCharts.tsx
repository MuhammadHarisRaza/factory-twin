import type { ReactNode } from 'react';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { LineChart } from '../../ui/kit/charts';
import { fmt1, fmtInt } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { niceAxisMax, signalSeries, type AssetRow } from './derive';

const TICK_EVERY = 18; // 10-min samples → a tick every 3 h

function ChartBlock({ title, unit, now, children }: { title: string; unit: string; now: ReactNode; children: ReactNode }) {
  return (
    <section className="mh-chart">
      <header>
        <h3>
          {title} <span className="muted">· {unit}</span>
        </h3>
        <span className="mh-now">
          Latest <b className="num">{now}</b>
        </span>
      </header>
      {children}
    </section>
  );
}

/** Selected asset: one chart per signal (one y-axis each), with the expected value for the load and the limits. */
export function SignalCharts({ row }: { row: AssetRow }) {
  const { id, asset: a, h } = row;
  const d = useSimValue((s) => signalSeries(s, id), [id]);
  const labels = d.t.map(formatClock);
  const flat = (v: number) => d.t.map(() => v);
  const top = (vals: number[], limit: number, min = 0) => niceAxisMax(Math.max(limit, ...vals), min);
  return (
    <Panel
      className="col-8 mh-signals"
      title="Condition signals · last 24 h"
      subtitle={`${id} · ${a.component} · 10-min samples`}
      footer={
        <span>
          <b className="mh-foot-b">How detection works (rule-based):</b> observed vibration is compared with the value expected for the machine’s current
          load; the slope over the last 3 h of running is extrapolated to the alarm and trip limits, which follow ISO 10816-style vibration severity zones;
          temperature is checked against a load-corrected expectation. Signals are simulated — no trained model or physical sensor is involved.
        </span>
      }
    >
      <div className="mh-charts">
        <ChartBlock title="Vibration velocity" unit="mm/s RMS" now={`${fmt1(h.reading.vibration)} mm/s`}>
          <LineChart
            labels={labels}
            height={170}
            yMax={top([...d.vibration, ...d.vibrationExpected], a.vib.trip)}
            tickEvery={TICK_EVERY}
            format={(v) => v.toFixed(1)}
            series={[
              { id: 'vib', label: 'Observed', color: 'var(--series-1)', points: d.vibration },
              { id: 'exp', label: 'Expected at current load', color: 'var(--series-2)', points: d.vibrationExpected, dashed: true },
              { id: 'trip', label: `Trip limit (${a.vib.trip})`, color: 'var(--text-3)', points: flat(a.vib.trip), dashed: true },
            ]}
            reference={{ value: a.vib.alarm, label: `Alarm ${a.vib.alarm} mm/s` }}
          />
        </ChartBlock>
        <ChartBlock title="Temperature" unit="°C · bearing / oil" now={`${fmtInt(h.reading.temperature)} °C`}>
          <LineChart
            labels={labels}
            height={150}
            yMin={20}
            yMax={top([...d.temperature, ...d.temperatureExpected], a.temp.alarm, 20)}
            tickEvery={TICK_EVERY}
            format={(v) => fmtInt(v)}
            series={[
              { id: 'temp', label: 'Observed', color: 'var(--series-1)', points: d.temperature },
              { id: 'exp', label: 'Expected at current load', color: 'var(--series-2)', points: d.temperatureExpected, dashed: true },
            ]}
            reference={{ value: a.temp.alarm, label: `Alarm ${a.temp.alarm} °C` }}
          />
        </ChartBlock>
        <ChartBlock title="Motor current" unit="A" now={`${fmtInt(h.reading.current)} A`}>
          <LineChart
            labels={labels}
            height={130}
            yMax={top(d.current, a.currentRated)}
            tickEvery={TICK_EVERY}
            format={(v) => fmtInt(v)}
            series={[{ id: 'cur', label: 'Motor current', color: 'var(--series-1)', points: d.current }]}
            reference={{ value: a.currentRated, label: `Rated ${a.currentRated} A` }}
          />
        </ChartBlock>
      </div>
    </Panel>
  );
}
