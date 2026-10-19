/**
 * Smoke tests: the Production workspace renders (server-side) on every tab, in every Analysis view,
 * in the stage view of every stage and in the equipment drill-down — also while scenarios are active —
 * with its landmarks and honesty labels (simulated, estimate, modeled vs observed constraint).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { MONITORED_STAGES } from '../../model/plant';
import type { MonitoredStageId } from '../../model/types';
import { goodOutputKpi } from '../../intel/kpis';
import { constraintClaim } from '../../intel/summary';
import { activateScenario, advance, clearScenario } from '../../sim/engine';
import { resolvePeriod, stageIO } from '../../sim/metrics';
import { flowStages } from '../../ui/flow/derive';
import { fmtInt } from '../../ui/kit/format';
import { useSim } from '../../sim/store';
import { ProductionPage } from '../ProductionPage';
import { EquipmentDrawer } from './MachineDrawer';
import { quickDef } from './stage/derive';
import { ANALYSIS_VIEWS, useProductionUi, type AnalysisView } from './ui';

useSim.getState().pause();
const noop = () => {};

const sync = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useProductionUi.getInitialState(), useProductionUi.getState());
};

const render = (tab: 'flow' | 'oee' | 'analysis', stage: MonitoredStageId | null = null, analysis: AnalysisView = 'equipment') => {
  useApp.setState({ workspace: 'production', period: 'shift', productionStage: stage, tabs: tab === 'flow' ? {} : { production: tab } });
  useProductionUi.setState({ analysis });
  sync();
  return renderToStaticMarkup(<ProductionPage />);
};

const noLive = (html: string) => {
  expect(html).not.toMatch(/>Live</);
  expect(html).not.toMatch(/real-time telemetry|AI model detected/i);
};

describe('Production render', () => {
  it('Plan & flow: header, five KPIs, target vs actual, stage flow with the constraint, losses and events', () => {
    const html = render('flow');
    for (const text of [
      'Production',
      'Simulated',
      'Plan &amp; flow',
      'OEE &amp; losses',
      'Analysis',
      'Good output',
      'Target attainment',
      'Production rate',
      'Reject rate',
      'Downtime affecting output',
      'Target vs actual',
      'Output trend',
      'Stage flow',
      'Design constraint',
      'modeled design constraint',
      'Where output is lost',
      'Investigate:',
      'Edit assumptions',
      'Estimate',
      'Important production events',
      'All events',
      'Ask Copilot',
    ])
      expect(html, text).toContain(text);
    for (const ms of MONITORED_STAGES) expect(html, ms.id).toContain(ms.name.replace(/&/g, '&amp;'));
    // Retired workspaces and energy are gone from this page.
    expect(html).not.toMatch(/Energy Intelligence|OEE &amp; Loss Intelligence|Vehicle Monitoring|Production Monitoring/);
    expect(html).not.toMatch(/kWh/);
    noLive(html);
  });

  it('OEE & losses: A × P × Q with definitions and numbers, ten integrity checks, count reconciliation and top losses', () => {
    const html = render('oee');
    for (const text of [
      'Line OEE',
      'Availability',
      'Performance',
      'Quality',
      'Operating time divided by planned production time.',
      'Actual production rate relative to the defined ideal rate during operating time.',
      'Good output divided by total output, using consistent counting boundaries.',
      'OEE = ',
      'Target 88 %',
      'Integrity checks',
      'Availability does not exceed 100 %',
      'Performance is not capped (raw value shown)',
      'Quality counts are compatible (same boundary)',
      'Components share time scope, equipment scope and boundary',
      'Ideal cycle time defined per asset (no fallback)',
      'Planned downtime policy applied consistently',
      'No double counting of rejects, good and finished tiles',
      'Period totals reconcile with hour buckets and stop records',
      'Losses reconcile with capacity and planned time',
      'Financial estimates show their assumptions',
      'Constraint data fresh for the whole period',
      'The 11 OEE consistency and data checks',
      'Count reconciliation',
      'Fired at the kiln',
      'Palletised',
      'Sorting passes only accepted tiles downstream',
      'Counts reconcile',
      'Largest OEE losses',
      'pts of OEE',
    ])
      expect(html, text).toContain(text);
    expect(html).not.toContain('need attention</span>');
    noLive(html);
  });

  it('Analysis: every view renders (equipment OEE, capacity waterfall, downtime Pareto, shifts, assumptions)', () => {
    const expected: Record<AnalysisView, string[]> = {
      equipment: ['Equipment OEE — process machines', 'Conveyors', 'Not meaningful', 'Own lost output by machine', 'Loss at the kiln by causing asset'],
      capacity: ['Capacity waterfall', 'Loss ledger — basis, valuation and assumptions', 'Capacity gap'],
      downtime: ['Downtime Pareto', 'Downtime records', 'Show the raw stop records'],
      shifts: ['Shift comparison', 'Shift table'],
      finance: ['Financial assumptions', 'Reset assumptions', 'Improvement estimates', 'Eliminate the top downtime reason at the constraint'],
    };
    for (const v of ANALYSIS_VIEWS) {
      const html = render('analysis', null, v.value);
      for (const text of expected[v.value]) expect(html, `${v.value}: ${text}`).toContain(text);
      expect(html, v.value).not.toMatch(/Energy above the model|energy tariffs|kWh/);
      noLive(html);
    }
  });

  it('stage view: every stage with back, neighbours, I/O, machines, camera, reference video, events, losses and signals', () => {
    for (const ms of MONITORED_STAGES) {
      const html = render('flow', ms.id);
      for (const text of [
        'All stages',
        'Show in 3D',
        'Machines and conveyors',
        'Input → output',
        'Camera view',
        'Simulated view rendered from the digital twin',
        'Reference video',
        'Stage events',
        'Production trend',
        'Production losses',
        'Shift summary',
        'Download shift report (PDF)',
        'Simulate on this stage',
        'Signal trends',
        'How this stage is counted',
      ])
        expect(html, `${ms.id}: ${text}`).toContain(text);
      expect(html).toContain(`Plan &amp; flow · ${ms.name.replace(/&/g, '&amp;')}`);
      noLive(html);
    }
    expect(render('flow', 'KILN')).toContain('Design constraint');
    // The OEE tab keeps its line scope while a stage is open.
    expect(render('oee', 'PRESS')).toContain('Integrity checks');
  });

  it('renders under scenarios: a lost feed, a stopped conveyor and the shifted constraint', () => {
    const s = useSim.getState().sim;
    activateScenario(s, quickDef('signal-loss', 'E-PRS2', 0, s.minute));
    activateScenario(s, quickDef('conveyor-stop', 'CV-KIN', 0, s.minute));
    advance(s, s.minute + 60);
    useSim.setState({ version: s.version });
    const flow = render('flow');
    // The shared claim (constraintClaim) names the stage the trace ended at, in the Overview's words.
    const claim = constraintClaim(s);
    expect(claim.constraining).toBe(true);
    expect(flow).toContain(`Constraint · ${claim.name}`.replace(/&/g, '&amp;'));
    expect(flow).toContain(`${claim.name} is currently constraining output`.replace(/&/g, '&amp;'));
    expect(flow).not.toMatch(/Observed constraint|confirmed by the data|Design constraint · confirmed/);
    expect(flow).toContain('Feed stale: E-PRS2');
    // The partly stale press stage keeps its running count, marked like every aggregate figure.
    expect(flow).toMatch(/Not confirmed · E-PRS2 data stale since \d\d:\d\d/);
    const press = render('flow', 'PRESS');
    expect(press).toMatch(/Stale since \d\d:\d\d/);
    expect(press).toContain('Unknown — data stale');
    const kiln = render('flow', 'KILN');
    expect(kiln).toContain('CV-KIN');
    expect(kiln).toContain('Conveyor stoppage');
    const oee = render('oee');
    expect(oee).toContain('presenter-started scenario');
    for (const html of [flow, press, kiln, oee]) noLive(html);
  });

  it('OEE & losses with a stale kiln feed: Stale badge, "not confirmed" status and sentence, freshness check needs attention', () => {
    const s = useSim.getState().sim;
    const sc = activateScenario(s, quickDef('signal-loss', 'H-KILN', 0, s.minute));
    advance(s, s.minute + 20);
    useSim.setState({ version: s.version });
    const oee = render('oee');
    expect(oee).toContain('prov prov-stale');
    expect(oee).toMatch(/Not confirmed · kiln data stale since \d\d:\d\d/);
    expect(oee).toMatch(/The kiln’s data feed has not updated since|The kiln&#x27;s data feed has not updated since/);
    expect(oee).toMatch(/H-KILN data feed has not updated since \d\d:\d\d/);
    expect(oee).not.toContain('At or above target');
    // The Plan & flow downtime card carries the stale provenance (shared kpiCardProps).
    const flow = render('flow');
    expect(flow).toContain('prov prov-stale');
    expect(flow).toMatch(/Feed stale: H-KILN since \d\d:\d\d · state unknown/);
    // Stage-flow table and KILN stage view: the running kiln count with the flow strip's / KPI's mark;
    // the constraint as the modeled design constraint with its state unknown — never "confirmed".
    const p = resolvePeriod('shift', s.minute);
    const mark = flowStages(s, p).find((x) => x.id === 'KILN')!.stale!.label;
    expect(mark).toMatch(/^Not confirmed · kiln data stale since \d\d:\d\d$/);
    expect(flow).toContain(`<span>${mark}</span>`);
    expect(flow).toContain('Design constraint · Kiln firing &amp; cooling');
    expect(flow).toContain('its data feed is stale, so its current state is unknown');
    const kiln = render('flow', 'KILN');
    expect(kiln).toContain(`<span>${mark}</span>`);
    expect(kiln).toContain(`${fmtInt(stageIO(s, 'KILN', p).output)} <span class="muted">tiles</span>`);
    expect(kiln).toMatch(/output this shift not confirmed — kiln data stale since \d\d:\d\d \(simulated running total/);
    for (const html of [flow, kiln]) expect(html).not.toMatch(/confirmed by the data|Design constraint · confirmed|Observed constraint/);
    clearScenario(s, sc.id);
    advance(s, s.minute + 1);
    useSim.setState({ version: s.version });
  });

  it('SORT stage view and stage-flow table with a stale sorting feed carry the Good output KPI mark (Decision 1)', () => {
    const s = useSim.getState().sim;
    const sc = activateScenario(s, quickDef('signal-loss', 'I-SORT', 0, s.minute));
    advance(s, s.minute + 20);
    useSim.setState({ version: s.version });
    const p = resolvePeriod('shift', s.minute);
    const good = goodOutputKpi(s, p);
    expect(good.provenance).toBe('stale');
    expect(flowStages(s, p).find((x) => x.id === 'SORT')!.stale!.label).toBe(good.status!.label);
    const flow = render('flow');
    expect(flow).toContain(`<span>${good.status!.label}</span>`);
    expect(flow).toMatch(/Output vs plan not confirmed — sorting data stale since \d\d:\d\d/);
    const sort = render('flow', 'SORT');
    expect(sort).toContain(`<span>${good.status!.label}</span>`);
    expect(sort).toMatch(/output this shift not confirmed — sorting data stale since/);
    clearScenario(s, sc.id);
    advance(s, s.minute + 1);
    useSim.setState({ version: s.version });
  });

  it('equipment drill-down of a machine and a conveyor', () => {
    sync();
    const kiln = renderToStaticMarkup(<EquipmentDrawer id="H-KILN" periodKey="shift" onClose={noop} />);
    for (const text of ['Machine OEE', 'Contributing events', 'Open in Factory Twin', 'Share of the line loss at the constraint', 'Reference video']) expect(kiln, text).toContain(text);
    const cv = renderToStaticMarkup(<EquipmentDrawer id="CV-KIN" periodKey="shift" onClose={noop} />);
    for (const text of ['Not meaningful for a conveyor', 'Utilisation', 'Kiln infeed roller transfer', 'Latest event report']) expect(cv, text).toContain(text);
  });
});
