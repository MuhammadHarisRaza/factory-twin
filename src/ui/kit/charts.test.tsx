/**
 * The kit's time-based and distribution charts, server-rendered: each has its accessible name,
 * gaps stay gaps (a null mid-series lifts the pen), empty and insufficient-data states say so in
 * words, and status marks carry words / shapes as well as colour.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventStrip, Histogram, ScatterChart, Sparkline, StateTimeline, TimeSeriesChart, type StateLegendItem } from './charts';
import { TimeRange } from './TimeRange';

/** The d attribute of the path drawn for a series. */
const pathOf = (html: string, id: string) => html.match(new RegExp(`<path data-series="${id}" d="([^"]*)"`))?.[1] ?? '';
const moves = (d: string) => (d.match(/M/g) ?? []).length;

const T = Array.from({ length: 11 }, (_, i) => 600 + i);

describe('TimeSeriesChart', () => {
  const base = { label: 'Kiln zone 5 temperature', from: 600, to: 610, unit: '°C' } as const;

  it('is a named image with y ticks, the unit and a clock time axis', () => {
    const html = renderToStaticMarkup(<TimeSeriesChart {...base} series={[{ id: 'pv', label: 'PV', t: T, v: T.map((_, i) => 1180 + i) }]} />);
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Kiln zone 5 temperature"/);
    expect(html).toContain('>°C<');
    // Plant minute 600 = Monday 16:00 (the epoch is Monday 06:00); a 10-minute span shows hh:mm only.
    expect(html).toContain('>16:00<');
    expect(html).not.toContain('Mon 16:00');
    // One series: no legend.
    expect(html).not.toContain('chart-legend');
  });

  it('does not bridge a null: the series path has two segments', () => {
    const v = T.map((_, i) => (i === 5 ? null : 1180 + i));
    const d = pathOf(renderToStaticMarkup(<TimeSeriesChart {...base} series={[{ id: 'pv', label: 'PV', t: T, v }]} />), 'pv');
    expect(moves(d)).toBe(2);
    // The second segment starts again with a move, not a line from the last value before the gap.
    expect(d.split('M')[1]).not.toContain('NaN');
  });

  it('does not bridge a long run of missing samples either (the tooltip reads "no sample" there)', () => {
    const t = [600, 601, 602, 603, 640, 641, 642];
    const d = pathOf(renderToStaticMarkup(<TimeSeriesChart label="Draft" from={600} to={660} unit="mbar" series={[{ id: 'p', label: 'P', t, v: [1, 2, 3, 4, 5, 6, 7] }]} />), 'p');
    expect(moves(d)).toBe(2);
  });

  it('keeps a usable scale when a fixed bound lies beyond every value', () => {
    const series = [{ id: 'pv', label: 'PV', t: T, v: T.map((_, i) => 1180 + i) }];
    for (const html of [
      renderToStaticMarkup(<TimeSeriesChart {...base} series={series} yMin={2000} />),
      renderToStaticMarkup(<TimeSeriesChart {...base} series={series} yMax={100} />),
      renderToStaticMarkup(<TimeSeriesChart {...base} unit="mbar" series={[{ id: 'd', label: 'Draft', t: T, v: T.map(() => -4) }]} yMin={0} />),
    ]) {
      expect(html).toContain('role="img"');
      expect(html).not.toContain('NaN');
      expect(html.match(/<g class="grid">(.*?)<\/g>/)![1].match(/<line /g)!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('draws a step series held to the next sample, also lifting the pen at a null', () => {
    const v = T.map((_, i) => (i === 3 ? null : i < 6 ? 1180 : 1185));
    const d = pathOf(renderToStaticMarkup(<TimeSeriesChart {...base} series={[{ id: 'sp', label: 'SP', t: T, v, step: true }]} />), 'sp');
    expect(moves(d)).toBe(2);
    expect(d).toContain('H');
    expect(d).toContain('V');
  });

  it('shows a legend for two or more series, labelled reference lines and band labels', () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        {...base}
        series={[
          { id: 'pv', label: 'Process value', t: T, v: T.map(() => 1182) },
          { id: 'sp', label: 'Setpoint', t: T, v: T.map(() => 1180), dashed: true, step: true },
        ]}
        refLines={[
          { value: 1195, label: 'Alarm high 1195 °C', kind: 'alarm' },
          { value: 1190, label: 'Warning high 1190 °C', kind: 'warning' },
        ]}
        bands={[{ from: 602, to: 606, label: 'Deviation', tone: 'warning' }]}
        markers={[{ t: 604, label: 'Scenario started', tone: 'neutral' }]}
      />,
    );
    expect(html).toContain('chart-legend');
    expect(html).toContain('Process value');
    expect(html).toContain('Alarm high 1195 °C');
    expect(html).toContain('Warning high 1190 °C');
    expect(html).toContain('>Deviation<');
    expect(html).toMatch(/<pattern [^>]*id="[^"]+-band-warning"/);
  });

  it('adds the weekday to ticks over 24 h, and uses a provided clock', () => {
    const t = [0, 1440, 2880, 4320];
    const html = renderToStaticMarkup(<TimeSeriesChart label="Output" from={0} to={4320} unit="tiles/h" series={[{ id: 'r', label: 'Rate', t, v: [1, 2, 3, 4] }]} />);
    expect(html).toContain('Tue 06:00');
    const custom = renderToStaticMarkup(<TimeSeriesChart label="Output" from={0} to={60} unit={null} clock={(m) => `T+${m}`} series={[{ id: 'r', label: 'Rate', t: [0, 30, 60], v: [1, 2, 3] }]} />);
    expect(custom).toContain('T+0');
  });

  it('says there is no data when every value is null (and gives the reason when known)', () => {
    const empty = { id: 'pv', label: 'PV', t: T, v: T.map(() => null) };
    const html = renderToStaticMarkup(<TimeSeriesChart {...base} series={[empty]} />);
    expect(html).toContain('No data in this range');
    expect(html).toContain('aria-label="Kiln zone 5 temperature"');
    expect(html).not.toContain('<path data-series');
    const why = renderToStaticMarkup(<TimeSeriesChart {...base} series={[empty]} emptyReason="Feed stale since 10:20" />);
    expect(why).toContain('Feed stale since 10:20');
  });
});

describe('Sparkline', () => {
  it('lifts the pen at a null instead of bridging the gap', () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, 2, null, 3, 4]} />);
    const d = html.match(/<path d="([^"]*)"/)![1];
    expect(moves(d)).toBe(2);
    expect((d.match(/L/g) ?? []).length).toBe(2);
  });

  it('shows a sample between two gaps as a dot rather than dropping it', () => {
    const d = renderToStaticMarkup(<Sparkline values={[1, 2, null, 3, null, 4, 5]} />).match(/<path d="([^"]*)"/)![1];
    expect(moves(d)).toBe(3);
    expect(d).toContain('h0');
  });

  it('keeps a continuous line without gaps', () => {
    const d = renderToStaticMarkup(<Sparkline values={[1, 2, 3, 4]} />).match(/<path d="([^"]*)"/)![1];
    expect(moves(d)).toBe(1);
  });
});

describe('StateTimeline', () => {
  const legend: StateLegendItem[] = [
    { state: 'running', label: 'Running', tone: 'good' },
    { state: 'down', label: 'Down', tone: 'critical' },
    { state: 'starved', label: 'Starved', tone: 'warning' },
    { state: 'blocked', label: 'Blocked', tone: 'warning' },
  ];
  const lanes = [
    {
      id: 'E-PRS1',
      label: 'Press 1',
      segments: [
        { from: 600, to: 640, state: 'running' },
        { from: 640, to: 655, state: 'down', label: 'Down · die change overrun' },
        { from: 655, to: 660, state: 'starved' },
      ],
    },
  ];

  it('is a named image with a text summary and a legend in words with time in state', () => {
    const html = renderToStaticMarkup(<StateTimeline label="Press 1 state" from={600} to={660} lanes={lanes} legend={legend} />);
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Press 1 state"[^>]*aria-describedby="([^"]+)"/);
    const id = html.match(/aria-describedby="([^"]+)"/)![1];
    expect(html).toMatch(new RegExp(`<p id="${id}" class="chart-sr">Press 1: Running 40 min, Down 15 min, Starved 5 min</p>`));
    expect(html).toContain('Running<b class="num">40 min</b>');
    // An unused legend state is not listed; time with no record is not invented.
    expect(html).not.toContain('Blocked');
    expect(html).not.toContain('No record');
  });

  it('tells states apart by pattern as well as colour (two warning states get different patterns)', () => {
    const html = renderToStaticMarkup(
      <StateTimeline label="Press 1 state" from={600} to={660} legend={legend} lanes={[{ ...lanes[0], segments: [...lanes[0].segments.slice(0, 2), { from: 655, to: 658, state: 'blocked' }, { from: 658, to: 660, state: 'starved' }] }]} />,
    );
    expect(html).toMatch(/<pattern [^>]*id="[^"]+-critical-dots"/);
    expect(html).toMatch(/<pattern [^>]*id="[^"]+-warning-hatch"/);
    expect(html).toMatch(/fill="url\(#[^"]+-warning-hatch\)"/);
    // Blocked shares Starved's tone, so it moves on to the next free pattern (solid amber, not a second hatch).
    expect(html).toContain('fill="var(--warning)"');
    expect(html.match(/<pattern [^>]*id="[^"]+-warning-hatch"/g)).toHaveLength(1);
  });

  it('labels lanes when there are several and shows uncovered time as "No record"', () => {
    const html = renderToStaticMarkup(
      <StateTimeline
        label="Presses"
        from={600}
        to={660}
        legend={legend}
        lanes={[lanes[0], { id: 'E-PRS2', label: 'Press 2', segments: [{ from: 600, to: 630, state: 'running' }] }]}
      />,
    );
    expect(html).toContain('>Press 2<');
    expect(html).toContain('No record');
    expect(html).toContain('Press 2: Running 30 min, no record 30 min');
  });

  it('has an honest empty state', () => {
    const html = renderToStaticMarkup(<StateTimeline label="Press 1 state" from={600} to={660} lanes={[{ id: 'x', label: 'X', segments: [] }]} legend={legend} />);
    expect(html).toContain('No state records in this range');
    expect(html).toContain('aria-label="Press 1 state"');
  });
});

describe('Histogram', () => {
  const bins = [
    { from: 10, to: 12, count: 20 },
    { from: 12, to: 14, count: 60 },
    { from: 14, to: 16, count: 40 },
  ];
  it('shows n and the bins, with labelled markers', () => {
    const html = renderToStaticMarkup(
      <Histogram
        label="Press 1 cycle time"
        bins={bins}
        unit="s"
        n={120}
        markers={[
          { value: 13, label: 'P50 13 s', kind: 'p50' },
          { value: 12, label: 'Target 12 s', kind: 'target' },
        ]}
      />,
    );
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Press 1 cycle time"/);
    expect(html).toContain('n = 120');
    expect(html).toContain('bins of 2 s');
    expect(html).toContain('P50 13 s');
    expect(html).toContain('Target 12 s');
    expect(html).toContain('>16 s<');
  });

  it('shows the insufficient-samples state below minSamples (default 20)', () => {
    const html = renderToStaticMarkup(<Histogram label="Press 1 cycle time" bins={[{ from: 10, to: 12, count: 7 }]} unit="s" n={7} />);
    expect(html).toContain('n = 7');
    expect(html).toContain('Not enough samples for a distribution');
    expect(html).toContain('At least 20 samples are needed; this range has 7.');
    expect(html).not.toContain('role="img"');
    expect(renderToStaticMarkup(<Histogram label="h" bins={[{ from: 10, to: 12, count: 7 }]} unit="s" n={7} minSamples={5} />)).toContain('role="img"');
  });

  it('calls a few samples "not enough" even without usable bins', () => {
    const html = renderToStaticMarkup(<Histogram label="Stop durations" bins={[]} unit="min" n={3} />);
    expect(html).toContain('Not enough samples for a distribution');
    expect(html).not.toContain('No samples in this range');
  });

  it('says when there are no samples at all', () => {
    const html = renderToStaticMarkup(<Histogram label="Stop durations" bins={[]} unit="min" n={0} />);
    expect(html).toContain('n = 0');
    expect(html).toContain('No samples in this range');
  });
});

describe('EventStrip', () => {
  const events = [
    { id: 'EV-1', t: 610, label: 'Kiln roller jam', severity: 'critical' as const, end: 625 },
    { id: 'EV-2', t: 630, label: 'Glaze density low', severity: 'warning' as const, kind: 'Quality' },
    { id: 'EV-3', t: 640, label: 'Press 2 stopped', severity: 'serious' as const, end: null },
  ];

  it('display only: a named image with a severity summary and a worded legend', () => {
    const html = renderToStaticMarkup(<EventStrip label="Events this shift" from={600} to={660} events={events} />);
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Events this shift"/);
    expect(html).toContain('3 events: 1 critical, 1 serious, 1 warning');
    expect(html).not.toContain('tabindex');
    expect(html).toContain('Critical<b class="num">1</b>');
    // Severity shapes: a square (critical), a diamond (serious) and a triangle (warning).
    expect(html).toContain('<rect x="');
    expect(html.match(/<polygon /g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('selectable: one Tab stop (the latest event), named buttons inside a group', () => {
    const html = renderToStaticMarkup(<EventStrip label="Events this shift" from={600} to={660} events={events} onSelect={() => {}} />);
    expect(html).toMatch(/<svg[^>]*role="group"[^>]*aria-label="Events this shift"/);
    expect(html.match(/role="button"/g)).toHaveLength(3);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="16:10 · Critical: Kiln roller jam, 15 min"');
    expect(html).toContain('aria-label="16:30 · Warning: Glaze density low (Quality)"');
    expect(html).toContain('aria-label="16:40 · Serious: Press 2 stopped, ongoing"');
  });

  it('says when no event is recorded in the range', () => {
    const html = renderToStaticMarkup(<EventStrip label="Events" from={0} to={60} events={events} />);
    expect(html).toContain('No events recorded in this range');
  });
});

describe('ScatterChart', () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ x: 1170 + i, y: 0.02 + i * 0.001, label: `Batch ${i + 1}` }));
  const props = { label: 'Kiln temperature vs reject rate', xLabel: 'Zone 5 temperature', yLabel: 'Reject rate', xUnit: '°C', yUnit: '%' };

  it('draws the points with axis titles and n, without a trend line', () => {
    const html = renderToStaticMarkup(<ScatterChart {...props} points={pts} note="Association only; not a cause." />);
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Kiln temperature vs reject rate"/);
    expect(html.match(/<circle /g)).toHaveLength(10);
    expect(html).toContain('Zone 5 temperature (°C)');
    expect(html).toContain('Reject rate (%)');
    expect(html).toContain('n = 10');
    expect(html).toContain('Association only; not a cause.');
    expect(html).not.toMatch(/<path /);
  });

  it('shows the insufficient-data state below minPoints (default 8)', () => {
    const html = renderToStaticMarkup(<ScatterChart {...props} points={pts.slice(0, 5)} />);
    expect(html).toContain('Not enough paired samples');
    expect(html).toContain('5 paired samples of Zone 5 temperature and Reject rate; at least 8 are needed');
    expect(html).not.toContain('<circle');
    expect(renderToStaticMarkup(<ScatterChart {...props} points={pts.slice(0, 5)} minPoints={4} />)).toContain('<circle');
  });
});

describe('TimeRange', () => {
  it('is a named radio group with the default ranges, the selection checked', () => {
    const html = renderToStaticMarkup(<TimeRange value="1h" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup" aria-label="Time range"');
    for (const l of ['15 min', '1 h', '8 h', '24 h', '7 days']) expect(html).toContain(`>${l}</button>`);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true" tabindex="0" class="on" title="1 h · minute data">1 h</);
    expect(html).toContain('title="8 h · 5-min steps from minute data"');
  });

  it('renders an unavailable range disabled, with its reason as the tooltip', () => {
    const html = renderToStaticMarkup(<TimeRange value="1h" onChange={() => {}} disabled={{ '7d': 'Hourly history covers the last 24 h' }} />);
    expect(html).toMatch(/aria-disabled="true" tabindex="-1" class="off" title="Hourly history covers the last 24 h">7 days</);
    expect(html.match(/aria-disabled/g)).toHaveLength(1);
  });
});
