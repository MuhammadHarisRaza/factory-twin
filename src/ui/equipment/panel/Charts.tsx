/**
 * "How has it behaved" (brief §6B): the subject's chart set (intel/charts.ts specs) under one time-range control.
 * Each chart is a kit component (TimeSeriesChart, StateTimeline, Histogram, RankedBars, EventStrip) in a compact
 * figure that states its title, unit, resolution and coverage, plus its facts and disclosures; the provenance is the
 * header's source pill (and each figure's tooltip), said once. Every figure carries `data-chart` (its id) and `data-charts` (every id it answers), so a
 * finding's chart evidence can scroll to it; a highlighted window is marked on the time charts it belongs to.
 */
import { memo } from 'react';
import type { RangeKey } from '../../../model/telemetry';
import { RANGE_BY_KEY } from '../../../model/telemetry';
import { formatDuration } from '../../../sim/time';
import { EventStrip, Histogram, RankedBars, StateTimeline, TimeSeriesChart } from '../../kit/charts';
import { TimeRange } from '../../kit/TimeRange';
import { sameProps } from '../../kit/equal';

import { fmtInt } from '../../kit/format';
import { chartIds, type ChartSpec } from '../intel/charts';

export type ChartHighlight = { chartId?: string | null; from: number; to: number };

const FORMAT = { duration: (v: number) => formatDuration(v), count: (v: number) => fmtInt(v) } as const;

function Body({ spec, highlight, onEvent }: { spec: ChartSpec; highlight: ChartHighlight | null; onEvent?: (id: string) => void }) {
  const label = `${spec.title}${spec.unit ? ` (${spec.unit})` : ''}`;
  switch (spec.kind) {
    case 'time': {
      const tips = spec.tips;
      return (
        <TimeSeriesChart
          label={label}
          from={spec.from}
          to={spec.to}
          series={spec.series}
          unit={spec.unit}
          refLines={spec.refLines}
          bands={spec.bands}
          markers={spec.markers}
          highlight={highlight && (!highlight.chartId || chartIds(spec).includes(highlight.chartId)) ? { from: highlight.from, to: highlight.to } : null}
          height={150}
          yMin={spec.yMin}
          yMax={spec.yMax}
          emptyReason={spec.emptyReason ?? undefined}
          tipRows={tips ? (t) => (tips[t] ?? []).map((r) => ({ label: r.label, value: r.value })) : undefined}
        />
      );
    }
    case 'states':
      return <StateTimeline label={label} from={spec.from} to={spec.to} lanes={spec.lanes} legend={spec.legend} emptyReason={spec.emptyReason ?? undefined} />;
    case 'histogram':
      return <Histogram label={label} bins={spec.bins} unit={spec.unit ?? ''} n={spec.n} markers={spec.markers} minSamples={spec.minSamples} height={140} />;
    case 'ranked':
      return spec.rows.length ? (
        <RankedBars rows={spec.rows} format={FORMAT[spec.format]} valueHeader={spec.valueHeader} labelHeader={spec.labelHeader} />
      ) : (
        <p className="eqp-chart-empty">{spec.emptyReason}</p>
      );
    case 'events':
      return (
        <EventStrip
          label={label}
          from={spec.from}
          to={spec.to}
          events={spec.events}
          emptyReason={spec.emptyReason ?? undefined}
          onSelect={onEvent ? (id) => !id.startsWith('stop:') && onEvent(id) : undefined}
        />
      );
  }
}

const Figure = memo(function Figure({ spec, highlight, onEvent }: { spec: ChartSpec; highlight: ChartHighlight | null; onEvent?: (id: string) => void }) {
  const ids = chartIds(spec);
  const on = !!highlight?.chartId && ids.includes(highlight.chartId);
  return (
    <figure className={`eqp-chart ${on ? 'on' : ''}`} data-chart={spec.id} data-charts={ids.join(' ')} tabIndex={-1} aria-label={spec.title}>
      <div className="eqp-chart-h">
        <b>{spec.title}</b>
        {spec.unit && <span className="unit">{spec.unit}</span>}
      </div>
      <Body spec={spec} highlight={highlight} onEvent={onEvent} />
      {spec.facts && spec.facts.length > 0 && (
        <dl className="eqp-chart-facts">
          {spec.facts.map((f) => (
            <div key={f.label} title={f.hint}>
              <dt>{f.label}</dt>
              <dd className="num">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="eqp-chart-m" title={`Provenance: ${spec.provenance}`}>
        {[spec.resolution, spec.coverage].filter(Boolean).join(' · ')}
        {spec.note && <span className="note"> {spec.note}</span>}
      </p>
    </figure>
  );
}, sameProps);

export function Charts({
  specs,
  range,
  onRange,
  disabled,
  highlight = null,
  notCharted = [],
  onEvent,
  rangeControl = true,
  asOf = null,
}: {
  specs: ChartSpec[];
  range: RangeKey;
  onRange: (k: RangeKey) => void;
  /** Ranges the data cannot serve, with the reason (intel/ranges.ts rangeAvailability). */
  disabled?: Partial<Record<RangeKey, string>>;
  /** A window to mark (a finding's evidence), optionally on one chart only. */
  highlight?: ChartHighlight | null;
  /** Catalogue signals without a chart because the demo has no value for them. */
  notCharted?: { signalId: string; name: string; status: string }[];
  onEvent?: (id: string) => void;
  /** False when the panel shows the one time-range control elsewhere (the card's process block header). */
  rangeControl?: boolean;
  /** The clock the charts end at when it is earlier than now (a live card's throttled set, src/ui/equipment/intel/live.ts). */
  asOf?: string | null;
}) {
  return (
    <div className="eqp-charts">
      <div className="eqp-charts-bar">
        {rangeControl && <TimeRange value={range} onChange={onRange} disabled={disabled} label="Chart time range" />}
        <span className="eqp-sec-meta">
          Last {RANGE_BY_KEY[range].label}
          {asOf ? ` to ${asOf}` : null} · simulated
        </span>


      </div>
      {specs.length === 0 ? (
        <p className="eqp-chart-empty">No chart: the demo simulates no history for this asset.</p>
      ) : (
        // A grid: two charts per row in the wide card; timelines and event strips span the row.
        <div className="eqp-chart-grid">
          {specs.map((spec) => (
            <div key={spec.id} className={`eqp-chart-cell ${spec.kind === 'states' || spec.kind === 'events' ? 'span' : ''}`}>
              <Figure spec={spec} highlight={highlight} onEvent={onEvent} />
            </div>
          ))}
        </div>
      )}
      {notCharted.length > 0 && (
        <p className="eqp-chart-nc" title={notCharted.map((n) => `${n.name} (${n.signalId}) — ${n.status}`).join('\n')}>
          <b>Not charted</b> (no value in the demo): {notCharted.map((n) => `${n.name} · ${n.status.toLowerCase()}`).join(', ')}
        </p>
      )}
    </div>
  );
}
