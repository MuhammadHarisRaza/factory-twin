/**
 * Smoke test: OEE & Loss Intelligence renders (server-side) at every level and in the drill-down,
 * also while scenarios are active, with its honesty labels.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { activateScenario, advance } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { ProductionPage } from '../ProductionPage';
import { EquipmentView } from './EquipmentView';
import { FactoryView } from './FactoryView';
import { LineView } from './LineView';
import { EquipmentDrawer } from './MachineDrawer';

useSim.getState().pause();
const noop = () => {};

const sync = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
};

describe('OEE & loss intelligence render', () => {
  it('opens on the factory level with the capacity story, investigation and estimates', () => {
    useApp.setState({ workspace: 'production', period: 'shift' });
    sync();
    const html = renderToStaticMarkup(<ProductionPage />);
    for (const text of [
      'Factory',
      'Production line',
      'Equipment',
      'Good-tile output',
      'Target attainment',
      'Capacity utilisation',
      'Quality yield',
      'Factory OEE',
      'Not an average of machine OEEs',
      'Production loss',
      'Est. financial impact',
      'Loss investigation',
      'Why are we below target?',
      'Which equipment contributes most to the capacity gap?',
      'Which loss category is largest?',
      'What is constraining good output?',
      'Ask the copilot',
      'Theoretical capacity vs plan vs actual vs good',
      'Basis of every bar',
      'Missing data (not connected)',
      'Loss &amp; cost intelligence',
      'Valued once.',
      'Financial assumptions',
      'Reset assumptions',
      'Improvement scenarios',
      'Eliminate the top downtime reason at the constraint',
      'Halve the largest defect category',
      'Estimate · assumptions shown',
      'Simulated data',
    ])
      expect(html, text).toContain(text);
    expect(html).not.toMatch(/>Live</);
  });

  it('renders the line and equipment levels and the drill-down of a machine and a conveyor', () => {
    const s = useSim.getState().sim;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: s.minute + 40, label: 'Kiln infeed stop' });
    advance(s, s.minute + 30);
    useSim.setState({ version: s.version });
    sync();
    const line = renderToStaticMarkup(<LineView periodKey="shift" onAsset={noop} />);
    for (const text of ['Line throughput', 'Bottleneck (traced)', 'WIP in process', 'How OEE is calculated', 'Line flow &amp; bottleneck trace', 'Downtime Pareto', 'Downtime events', 'Shift performance'])
      expect(line, text).toContain(text);
    const eq = renderToStaticMarkup(<EquipmentView periodKey="shift" selected={null} onAsset={noop} />);
    for (const text of ['Process machines', 'Conveyors', 'Not meaningful', 'CV-KIN', 'H-KILN', 'Line loss m²']) expect(eq, text).toContain(text);
    const kiln = renderToStaticMarkup(<EquipmentDrawer id="H-KILN" periodKey="shift" onClose={noop} />);
    for (const text of ['Machine OEE', 'Contributing events', 'View in 3D', 'Share of the line loss at the constraint']) expect(kiln, text).toContain(text);
    const cv = renderToStaticMarkup(<EquipmentDrawer id="CV-KIN" periodKey="shift" onClose={noop} />);
    for (const text of ['Not meaningful for a conveyor', 'Utilisation', 'Kiln infeed roller transfer', 'Consequences elsewhere', 'Latest event report']) expect(cv, text).toContain(text);
    const factory = renderToStaticMarkup(<FactoryView periodKey="shift" onLevel={noop} onAsset={noop} />);
    expect(factory).toContain('Compare with baseline');
  });
});
