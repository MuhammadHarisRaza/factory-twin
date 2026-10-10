/**
 * Monitoring quick actions list (review finding #21): condition-based maintenance in effect on a
 * stage is listed as in progress without a Clear button (the rest of the app leaves it to complete),
 * while an ordinary scenario keeps its Clear button.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import { activateScenario, advance } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { ENTRY_BY_ID, maintenanceDef } from '../scenarios/catalogue';
import { quickDef } from './derive';
import { QuickActions } from './QuickActions';

useSim.getState().pause();

const render = () => {
  useSim.setState({ version: useSim.getState().sim.version });
  Object.assign(useSim.getInitialState(), useSim.getState());
  return renderToStaticMarkup(<QuickActions ms={MONITORED_STAGE_BY_ID.PRESS} />);
};
/** The list item of the scenario with this label. */
const row = (html: string, label: string) => html.split('<li').find((x) => x.includes(label)) ?? '';

describe('monitoring quick actions', () => {
  it('offers no Clear for condition-based maintenance, but does for a scenario', () => {
    const s = useSim.getState().sim;
    activateScenario(s, ENTRY_BY_ID.fault.build({ asset: 'E-PRS2', progression: 'typical' }, s.minute));
    advance(s, s.minute + 10);
    const cbm = activateScenario(s, maintenanceDef('E-PRS2', 45));
    const slow = activateScenario(s, quickDef('reduced-rate', 'E-PRS1', 30, s.minute));
    advance(s, s.minute + 1);
    const html = render();

    const m = row(html, cbm.label);
    expect(m, 'maintenance listed').not.toBe('');
    expect(m).toContain(`in progress until ${formatClock(cbm.end!)}`);
    expect(m).not.toContain('Clear');

    const r = row(html, slow.label);
    expect(r, 'reduced rate listed').not.toBe('');
    expect(r).toContain('Clear');
  });

  it('disables Clear and Simulate while the demo is resetting', () => {
    useSim.setState({ resetting: true });
    try {
      const html = render();
      expect(html).toContain('Demo is resetting');
      expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Clear/);
      expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Simulate /);
      // No enabled button that clears or starts a scenario.
      expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>(?:(?!<\/button>).)*(Clear|Simulate )/);
    } finally {
      useSim.setState({ resetting: false });
    }
  });
});
