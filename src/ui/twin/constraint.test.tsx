/**
 * Review findings #4 / #16: every Factory Twin surface that marks the line constraint — the line
 * strip, the stage panel, the equipment workspace, the 3D constraint chip and the quick view — uses
 * constraintClaim (src/intel/summary.ts), the Overview's wording. In a normal state the kiln is the
 * modeled design constraint (neutral, never "current bottleneck" / "Current constraint"); amber and
 * "constraining output" only with traced evidence; with a stale kiln feed nothing is claimed beyond
 * the design label.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import type { ReactElement } from 'react';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { bottleneck } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { constraintClaim, constraintPhrase, executiveSummary } from '../../intel/summary';
import { constraintChipTitle } from '../../scene/status/model';
import { constraintRole } from '../equipment/context';
import { EquipmentWorkspace } from '../equipment/EquipmentWorkspace';
import { assetProfile } from '../equipment/profile';
import { ACTIVE_CONSTRAINT_LABEL, DESIGN_CONSTRAINT_LABEL, constraintMarker } from './constraint';
import { lineStatus } from './derive';
import { LineStrip } from './LineStrip';
import { StagePanel } from './StagePanel';
import { useTwinUi } from './uiStore';

useSim.getState().pause();

/** The Overview test's seeded normal state: nothing open, the kiln not held up. */
const START = 2 * 1440 + 4 * 60 + 20;
const normal = () => createSim(81, START);
const kilnStopped = () => {
  const s = createSim(82, START);
  activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
  advance(s, START + 25);
  return s;
};
const kilnStale = () => {
  const s = createSim(81, START);
  activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed lost' });
  advance(s, START + 30);
  return s;
};

const html = (sim: SimState, el: ReactElement) => {
  useSim.setState({ sim, version: sim.version + 1 });
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useTwin.getInitialState(), useTwin.getState());
  Object.assign(useTwinUi.getInitialState(), useTwinUi.getState());
  return renderToStaticMarkup(el);
};

/** Wording that asserts the kiln limits the line now — allowed only with evidence. */
const LIVE_CLAIM = /current bottleneck|Current constraint|Bottleneck|limits the (whole )?line|Line constraint now|currently constraining|Constraining output/i;

describe('constraint marker (single source: constraintClaim)', () => {
  it('names the kiln the modeled design constraint in a normal state, in the Overview summary wording', () => {
    const s = normal();
    expect(bottleneck(s).cause).toBe('constraint');
    const m = constraintMarker(s);
    expect(m.active).toBe(false);
    expect(m.stage).toBe('KILN');
    expect(m.machines).toEqual(['H-KILN']);
    expect(m.label).toBe(DESIGN_CONSTRAINT_LABEL);
    expect(m.sentence).toBe(`Kiln firing & cooling is the modeled design constraint — ${constraintClaim(s).evidence}.`);
    // The same phrase as the Overview's executive summary.
    expect(executiveSummary(s).text).toContain(constraintPhrase(m.claim));
    expect(`${m.label} ${m.sentence} ${m.title}`).not.toMatch(LIVE_CLAIM);
  });

  it('says "constraining output" with the evidence only when the claim supports it (kiln stopped)', () => {
    const m = constraintMarker(kilnStopped());
    expect(m.active).toBe(true);
    expect(m.label).toBe(ACTIVE_CONSTRAINT_LABEL);
    expect(m.sentence).toMatch(/^Kiln firing & cooling is currently constraining output — the kiln has been (stopped|in fault) since \d\d:\d\d/);
    expect(m.title).toContain('kiln starved');
  });

  it('claims nothing beyond the design label while the kiln feed is stale', () => {
    const m = constraintMarker(kilnStale());
    expect(m.claim.kind).toBe('kiln-unknown');
    expect(m.active).toBe(false);
    expect(m.label).toBe(DESIGN_CONSTRAINT_LABEL);
    expect(m.sentence).toBe('Kiln firing & cooling is the modeled design constraint; its data feed is stale, so its current state is unknown.');
    expect(`${m.sentence} ${m.title}`).not.toMatch(LIVE_CLAIM);
  });

  it('marks the traced stage on the line strip when the kiln was held up', () => {
    const s = createSim(90, START);
    expect(bottleneck(s).cause).toBe('blocking');
    const ls = lineStatus(s);
    const marked = ls.stages.filter((x) => x.constraint);
    expect(marked.map((x) => x.def.key)).toEqual(['SORT']);
    expect(marked[0].constraint!.active).toBe(true);
  });

  it('marks exactly the claimed chip on the line strip, neutral in a normal state', () => {
    const ls = lineStatus(normal());
    const marked = ls.stages.filter((x) => x.constraint);
    expect(marked.map((x) => x.def.key)).toEqual(['KILN']);
    expect(marked[0].constraint!.active).toBe(false);
    expect(lineStatus(kilnStopped()).stages.find((x) => x.def.key === 'KILN')!.constraint!.active).toBe(true);
  });

  it('gives the 3D chip the claim and its evidence, never "Bottleneck" by default', () => {
    const t = constraintChipTitle(constraintMarker(normal()), 'Single-layer roller kiln');
    expect(t).toContain('Design constraint (modeled) · Kiln firing & cooling');
    expect(t).toContain('No other stage held the kiln up in the last 2 h');
    expect(t).toContain('Select Single-layer roller kiln.');
    expect(t).not.toMatch(LIVE_CLAIM);
    // A stopped kiln reads as stopped (down), never as producing 100 %.
    const k = constraintChipTitle(constraintMarker(kilnStopped()), 'Single-layer roller kiln');
    expect(k).toContain('Constraining output · Kiln firing & cooling');
    expect(k).toMatch(/The kiln has been (stopped|in fault) since/);
    expect(k).not.toContain('100 %');
  });

  it('gives the equipment workspace the same role and wording', () => {
    const prof = assetProfile('H-KILN');
    const r = constraintRole(normal(), prof);
    expect(r?.kind).toBe('constraint');
    expect(r?.kind === 'constraint' && r.marker.active).toBe(false);
    const stale = constraintRole(kilnStale(), prof);
    expect(stale?.kind === 'constraint' && stale.marker.claim.kind).toBe('kiln-unknown');
    expect(constraintRole(kilnStopped(), prof)?.marker.active).toBe(true);
    // A machine outside the claimed stage is not called the constraint.
    expect(constraintRole(normal(), assetProfile('E-PRS1'))?.kind).not.toBe('constraint');
  });
});

describe('constraint marker render', () => {
  it('stage panel: neutral "Design constraint (modeled)" in a normal state, no live claim', () => {
    const out = html(normal(), <StagePanel id="KILN" />);
    expect(out).toContain('<span class="status neutral">');
    expect(out).toContain('Design constraint (modeled)');
    expect(out).toContain('Kiln firing &amp; cooling is the modeled design constraint');
    expect(out).not.toMatch(LIVE_CLAIM);
    // Another stage carries no constraint marker.
    expect(html(normal(), <StagePanel id="PRESS" />)).not.toMatch(/Design constraint|Constraining output/);
  });

  it('stage panel: amber "Constraining output" with the evidence while the kiln is stopped', () => {
    const out = html(kilnStopped(), <StagePanel id="KILN" />);
    expect(out).toMatch(/<span class="status warning">.*?Constraining output<\/span>/);
    expect(out).toContain('is currently constraining output');
    expect(out).toContain('Every minute lost here is lost line output.');
  });

  it('stage panel: nothing beyond the design label while the kiln feed is stale', () => {
    const out = html(kilnStale(), <StagePanel id="KILN" />);
    expect(out).toContain('Design constraint (modeled)');
    expect(out).toContain('its data feed is stale, so its current state is unknown');
    expect(out).not.toMatch(LIVE_CLAIM);
  });

  it('line strip: the kiln chip reads "design constraint (modeled)", never "current bottleneck"', () => {
    useTwin.getState().reset();
    const out = html(normal(), <LineStrip />);
    expect(out).toMatch(/aria-label="Firing: [^",]*, design constraint \(modeled\)/);
    expect(out).toMatch(/class="tw-stage\s+bn\s+"/);
    expect(out).not.toMatch(/bottleneck/i);
    const stopped = html(kilnStopped(), <LineStrip />);
    expect(stopped).toMatch(/aria-label="Firing: [^",]*, constraining output/);
    expect(stopped).toMatch(/class="tw-stage\s+bn active\s+"/);
  });

  it('equipment workspace: no "Line constraint now" for the kiln in a normal state', () => {
    useTwin.getState().reset();
    const out = html(normal(), <EquipmentWorkspace id="H-KILN" />);
    expect(out).toContain('Design constraint (modeled)');
    expect(out).toContain('Kiln firing &amp; cooling is the modeled design constraint');
    expect(out).not.toMatch(LIVE_CLAIM);
    const stopped = html(kilnStopped(), <EquipmentWorkspace id="H-KILN" />);
    expect(stopped).toContain('Constraining output');
    expect(stopped).toContain('is currently constraining output');
  });
});
