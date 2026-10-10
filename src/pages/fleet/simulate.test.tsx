/**
 * Vehicle Monitoring "Simulate …" bar during Reset Demo (review finding #20): while the seeded
 * state is being rebuilt every button is disabled, and an activation is refused instead of landing
 * on the state the reset is about to discard.
 */
import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useSim } from '../../sim/store';
import { SimulateBar } from './Simulate';
import { RESTRICTED_VEHICLE, type DockHoldTarget } from './pipeline';

useSim.getState().pause();

const HOLD: DockHoldTarget = { dockId: 'K-DOCK1', name: 'Dock 1', truckId: 'TR-01', held: false };
type Btn = ReactElement<{ disabled?: boolean; onClick?: () => void; children?: ReactNode }>;

/** Renders the bar server-side and keeps its element tree so a button's onClick can be invoked. */
function renderBar() {
  Object.assign(useSim.getInitialState(), useSim.getState());
  let tree: ReactNode = null;
  const Probe = () => {
    tree = SimulateBar({ hold: HOLD, restricted: { ok: true }, onSelect: () => {} });
    return tree as ReactElement;
  };
  const html = renderToStaticMarkup(<Probe />);
  const buttons: Btn[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    if (n.type === 'button') buttons.push(n as Btn);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(tree);
  return { html, buttons };
}

const text = (b: Btn): string => {
  const flat = (n: ReactNode): string => (Array.isArray(n) ? n.map(flat).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : '');
  return flat(b.props.children);
};

describe('vehicle monitoring simulate bar', () => {
  it('disables every simulate button and refuses activations while the demo is resetting', () => {
    useSim.setState({ resetting: true });
    try {
      const { html, buttons } = renderBar();
      expect(buttons).toHaveLength(4);
      for (const b of buttons) expect(b.props.disabled, text(b)).toBe(true);
      expect(html).toContain('Demo is resetting');
      const before = useSim.getState().sim.scenarios.length;
      for (const b of buttons) b.props.onClick?.();
      expect(useSim.getState().sim.scenarios.length).toBe(before);
    } finally {
      useSim.setState({ resetting: false });
    }
  });

  it('activates the scenario when the demo is not resetting', () => {
    const { buttons } = renderBar();
    for (const b of buttons) expect(b.props.disabled, text(b)).toBe(false);
    const truck = buttons.find((b) => text(b).includes('Simulate truck arrival'))!;
    const zone = buttons.find((b) => text(b).includes(RESTRICTED_VEHICLE))!;
    const before = useSim.getState().sim.scenarios.length;
    truck.props.onClick?.();
    zone.props.onClick?.();
    const added = useSim.getState().sim.scenarios.slice(before).map((sc) => sc.kind);
    expect(added).toEqual(['truck-arrival', 'restricted-entry']);
  });
});
