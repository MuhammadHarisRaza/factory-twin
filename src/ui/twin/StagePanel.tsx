/**
 * Contextual panel of a production stage highlighted in the model (useTwin.stage — set from the
 * line strip, the Overview flow strip or Production), in the equipment panel's shell: a fixed header
 * (state, constraint role, source), a scrolling body — the stage's one feed, its key figures, the
 * equipment and conveyors that make it up (each opens its panel), its open events and the way into
 * Production — and an action bar (Frame stage). Esc or the header's Close clears the highlight; the
 * camera stays where it is. Wide (src/ui/twin/panelWidth.ts) the feed runs across the top and the key
 * figures and equipment sit beside the open events.
 *
 * Wave 3: the brief's 12-stage mapping line ("Covers brief stages 5 · … and 6 · …"), the stage's rule findings
 * (findingsFor each brief stage it covers: fired, recently resolved, not evaluated) and a stage chart set over the
 * viewer's time range (state lanes of its equipment, buffer levels, output rate).
 */
import { useMemo, useRef, useState } from 'react';
import { Circle, Crosshair, Hourglass } from 'lucide-react';
import { useApp } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { CAMERAS, CONVEYOR_BY_ID, MONITORED_STAGE_BY_ID, cameraFor } from '../../model/plant';
import type { MonitoredStageId } from '../../model/types';
import { clockLabel, constraintClaim } from '../../intel/summary';
import { dedupeFindings, liveFindingsFor, compareFindings, type RuleFinding } from '../../intel/rules';
import { liveCharts } from '../equipment/intel/live';

import { STAGES_12, type ProductionStageDef } from '../../model/catalog';
import type { Window } from '../../calc/types';
import { RANGE_BY_KEY } from '../../model/telemetry';
import { panelCharts } from '../equipment/intel/panelData';
import { rangeCovering } from '../equipment/intel/ranges';
import { Charts, type ChartHighlight } from '../equipment/panel/Charts';
import { RuleFindings } from '../equipment/panel/RuleFindings';
import { openEventRecord } from '../events/open';
import { useTwinUi } from './uiStore';
import { eventInMonitoredStage } from '../../sim/events';
import type { SimState } from '../../sim/engine';
import { useSimValue } from '../../sim/store';

import { useTwin } from '../../store';
import { STAGE_TOPICS } from '../../video/topics';
import { chooseFeed, eventRows } from '../equipment/intel/derive';
import { stageKpis } from '../equipment/kpis';
import { FeedView } from '../equipment/panel/Feed';
import { EventList } from '../equipment/panel/Events';
import { stageLinks } from '../equipment/panel/links';
import { MetricTiles, MetricsScope, notModelledKpis } from '../equipment/panel/Metrics';
import { NotModelled } from '../equipment/panel/Signals';
import { BarButton, ContinueIn, PanelHeader, PanelShell, Section, SourcePill } from '../equipment/panel/Shell';
import { eventsForSubject, openEventsFor } from '../events/open';

/** The brief's stages a monitored stage covers ("5 · Glazing & engobe and 6 · Digital printing"), with the partial-stage note. */
export function briefStagesOf(id: MonitoredStageId): ProductionStageDef[] {
  return STAGES_12.filter((st) => st.monitoredStage === id);
}
export function briefStageLine(id: MonitoredStageId): string | null {
  const xs = briefStagesOf(id);
  if (!xs.length) return null;
  const words = xs.map((st) => `${st.no} · ${st.name}${st.present === 'partial' ? ' (kiln outfeed storage; no dedicated cooling-buffer machine)' : ''}`);
  return `Covers brief stage${xs.length > 1 ? 's' : ''} ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0]}`;
}
import { OperationalStatus, StatusBadge } from '../kit/Status';
import { constraintMarker } from './constraint';
import { useWidePanel } from './panelWidth';
import { OP_RANK, assetStatus, sortEvents, worstOf } from './derive';
import '../equipment/equipment.css';
import '../equipment/panel/panel.css';

export function StagePanel({ id }: { id: MonitoredStageId }) {
  const ms = MONITORED_STAGE_BY_ID[id];
  const select = useTwin((s) => s.select);
  const finance = useApp((s) => s.finance);
  const cameraSources = useApp((s) => s.cameraSources);
  const zone = ZONE_BY_ID[ms.zone];
  const wide = useWidePanel();
  const range = useTwinUi((s) => s.panelRange);
  /**
   * The live card's rule findings — of every brief stage the monitored stage covers (each includes its equipment), once
   * each — and its charts: re-evaluated at most every few simulated minutes (src/intel/rules/live.ts,
   * ../equipment/intel/live.ts); the card says when.
   */
  const liveStage = (s: SimState) => {
    const evals = briefStagesOf(id).map((st) => liveFindingsFor(s, { kind: 'stage', stageNo: st.no }));
    const h = liveCharts(s, `stage-charts:${id}:${range}`, '', range, () => ({ charts: panelCharts(s, { kind: 'stage', stageId: id }, range) }));
    return {
      findings: dedupeFindings(evals.flatMap((e): RuleFinding[] => e.value)).sort(compareFindings),
      findingsAt: evals.length ? Math.min(...evals.map((e) => e.at)) : s.minute,
      charts: h.value.charts,
      chartsAt: h.at,
    };
  };
  const d = useSimValue(

    (s) => {
      const assets = [...ms.equipment, ...ms.conveyors.filter((c) => !ms.equipment.includes(c))].map((a) => ({
        id: a,
        name: EQUIPMENT_BY_ID[a]?.name ?? CONVEYOR_BY_ID[a]?.name ?? a,
        status: s.machines[a] ? assetStatus(s, a) : null,
      }));
      const tracked = assets.flatMap((a) => (a.status ? [a.status] : []));
      // One constraint claim for the badge, the sentence and the rate tile (the Overview's wording).
      const claim = constraintClaim(s);
      const c = constraintMarker(s, claim);
      const open = sortEvents(s.events.filter((e) => e.status !== 'resolved' && !e.consequenceOf && eventInMonitoredStage(ms, e)));
      // The Events list "View all" opens (the stage filter, all recorded time): its count is the list's.
      const listed = eventsForSubject(s, { stage: id }).length;
      return {
        now: s.minute,
        assets,
        worst: worstOf(tracked)?.op ?? null,
        constraint: c.stage === id ? c : null,
        kpis: stageKpis(s, id, undefined, claim),
        events: { rows: eventRows(s, open, finance, 3), openCount: open.length, total: listed },
        ...liveStage(s),
      };
    },
    [id, finance, range],
  );
  // The stage's one feed, in the equipment panel's order (stream → recording → twin view → reference → none).
  const feed = useMemo(() => {
    const machine = ms.equipment[0] ?? null;
    const camera = CAMERAS.find((c) => c.stage === id) ?? cameraFor(machine);
    return chooseFeed({ equipmentId: machine, label: ms.name }, camera, STAGE_TOPICS[id] ?? [], cameraSources);
  }, [id, ms, cameraSources]);
  const clear = () => useTwin.getState().selectStage(null);
  const [openEv, setOpenEv] = useState<string | null>(null);
  const [hl, setHl] = useState<ChartHighlight | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const mapping = briefStageLine(id);
  /** A finding's signal opens its equipment's panel; a chart link scrolls to the stage chart (or opens the equipment). */
  const onSignal = (sig: string) => select(sig.slice(0, sig.indexOf('.')));
  const onChart = (chartId: string, w: Window | null) => {
    const charts = d.charts;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-charts~="${CSS.escape(chartId)}"]`);
    if (!charts || !el) {
      const sig = /^chart:(?:process|buffer):(.+)$/.exec(chartId)?.[1];
      if (sig) onSignal(sig);
      return;
    }
    if (w) {
      const need = rangeCovering(d.now, w, charts.disabled);
      if (RANGE_BY_KEY[need].minutes > RANGE_BY_KEY[charts.range].minutes) useTwinUi.getState().setPanelRange(need);
      setHl({ chartId, from: w.from, to: w.to });
    }
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  };

  const header = (
    <PanelHeader
      zone={{ id: zone.id, color: zone.color }}
      title={ms.name}
      subtitle={
        <>
          Production stage {ms.step} · highlighted in the model
          {mapping && (
            <span className="eqp-stage12" title={briefStagesOf(id).map((st) => `${st.no} · ${st.name}: ${st.note}`).join('\n')}>
              {' · '}
              {mapping}
            </span>
          )}
        </>
      }
      status={
        <>
          {d.worst ? (
            <OperationalStatus state={d.worst} />
          ) : (
            <span className="status neutral">
              <Circle size={13} aria-hidden /> No machine state modelled
            </span>
          )}
          {d.constraint && (
            <span title={d.constraint.title}>
              <StatusBadge tone={d.constraint.active ? 'warning' : 'neutral'} icon={Hourglass} label={d.constraint.label} size={12} />
            </span>
          )}
          <SourcePill kind="simulated" label="Simulated" title="Generated by the demo simulation engine — not plant telemetry." />
        </>
      }
      onClose={clear}
      closeLabel="Clear the stage highlight"
      closeTitle="Clear the stage highlight (Esc)"
    />
  );
  // The header's close button clears the highlight; the bar keeps only what the header cannot do.
  const actions = <BarButton icon={Crosshair} label="Frame stage" title="Frame the stage’s equipment and conveyors" onClick={() => useTwin.getState().selectStage(id)} />;

  const figures = (
    <Section id={`eqp-stage-kpi-${id}`} title="Key figures" meta={<MetricsScope set={d.kpis} />}>
      <MetricTiles set={d.kpis} label={`${ms.name} key figures`} />
      <NotModelled items={notModelledKpis(d.kpis)} />
      {d.constraint && (
        <p className="eqp-fine" title={d.constraint.title}>
          {d.constraint.sentence}
          {d.constraint.active ? ' Every minute lost here is lost line output.' : ''}
        </p>
      )}
    </Section>
  );

  const equipment = (
    <Section id={`eqp-stage-eq-${id}`} title="Equipment" meta={<span className="eqp-sec-meta">worst first</span>}>
      <ul className="eqp-assets">
        {[...d.assets]
          .sort((a, b) => (b.status ? OP_RANK[b.status.op] : 0) - (a.status ? OP_RANK[a.status.op] : 0))
          .map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => select(a.id)} title={`Open ${a.id}`}>
                <span className="n">
                  {a.name} <span className="mono muted">{a.id}</span>
                </span>
                {a.status ? <OperationalStatus state={a.status.op} /> : <span className="muted">—</span>}
              </button>
            </li>
          ))}
      </ul>
    </Section>
  );

  const checked = d.findingsAt < d.now ? clockLabel(d.findingsAt, d.now) : null;
  const matters = d.findings.length > 0 && (
    <Section id={`eqp-stage-rf-${id}`} title="What matters" meta={<span className="eqp-sec-meta">rule findings{checked ? ` · checked ${checked}` : null}</span>}>
      <RuleFindings findings={d.findings} now={d.findingsAt} onSignal={onSignal} onChart={onChart} onEvent={openEventRecord} />
    </Section>
  );

  const charts = d.charts && (
    <Section id={`eqp-stage-an-${id}`} title="How it has behaved">
      <Charts
        specs={d.charts.specs}
        range={d.charts.range}
        onRange={useTwinUi.getState().setPanelRange}
        disabled={d.charts.disabled}
        highlight={hl}
        onEvent={openEventRecord}
        asOf={d.chartsAt < d.now ? clockLabel(d.chartsAt, d.now) : null}
      />
    </Section>
  );

  const events = (
    <Section id={`eqp-stage-ev-${id}`} title="Open events" meta={<span className="eqp-sec-meta">{d.events.openCount} open</span>}>
      <EventList
        events={d.events}
        now={d.now}
        open={openEv}
        onToggle={(ev) => setOpenEv(openEv === ev ? null : ev)}
        onViewAll={() => openEventsFor({ stage: id })}
        subject={ms.name}
        empty="No open event in this stage."
      />
    </Section>
  );

  return (
    <PanelShell label={`${ms.name} · stage details`} header={header} actions={actions} bodyRef={bodyRef} className={`eqp-stage ${wide ? 'eqp-wide' : ''}`}>
      <div className="eqp-top">
        <FeedView feed={feed} subject={`stage:${id}`} />
      </div>
      {wide ? (
        <div className="eqp-cols">
          <div className="eqp-col eqp-col-a">
            {figures}
            {matters}
            {equipment}
          </div>
          <div className="eqp-col eqp-col-b">
            {charts}
            {events}
          </div>
        </div>
      ) : (
        <>
          {figures}
          {matters}
          {charts}
          {equipment}
          {events}
        </>
      )}
      <ContinueIn links={stageLinks(id)} />
    </PanelShell>
  );
}
