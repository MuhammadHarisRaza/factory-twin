/**
 * Internal vehicles table with a forklift inside a restricted zone (verify follow-up of review #30):
 * the Zone cell's flag is short ("In restricted zone", the zone named in its title and for screen
 * readers), it may wrap with its cell (so the table never widens past the work area at 1280 px) and
 * the long zone names with their own brackets ("Palletiser cell (no entry)") are never followed by a
 * second bracket ("(restricted)"). The vehicle detail names the zone without doubled brackets too.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 };
});

import { useApp } from '../../app/store';
import { activateScenario, advance } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { FleetPage } from '../FleetPage';
import { geofenceName } from './derive';
import { RESTRICTED_VEHICLE, restrictedEntryGate } from './pipeline';

useSim.getState().pause();

const s = useSim.getState().sim;
const gate = restrictedEntryGate(s);
if (gate.ok) activateScenario(s, { kind: 'restricted-entry', vehicleId: RESTRICTED_VEHICLE, end: null, label: 'Restricted render test' });
// Step until the forklift is inside the restricted geofence (it starts on its next empty-pallet run).
for (let i = 0; i < 120 && !s.logistics.restrictedOpen[RESTRICTED_VEHICLE]; i++) advance(s, s.minute + 1);
useSim.setState({ version: s.version });
const zone = s.logistics.restrictedOpen[RESTRICTED_VEHICLE]?.geofenceId ?? null;

const render = (fleetVehicleId: string | null) => {
  useApp.setState({ workspace: 'fleet', period: 'shift', fleetVehicleId, tabs: { fleet: 'internal' } });
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  return renderToStaticMarkup(<FleetPage />);
};

/** The Internal vehicles panel's table body. */
const table = (html: string) => {
  const part = html.slice(html.indexOf('<h2>Internal vehicles</h2>'));
  return part.slice(part.indexOf('<tbody'), part.indexOf('</tbody>'));
};

describe('Internal vehicles: restricted-zone flag in the Zone cell', () => {
  it('the scenario puts the forklift inside a restricted zone', () => {
    expect(gate.ok).toBe(true);
    expect(zone).not.toBeNull();
  });

  it('is a short badge that may wrap; the zone is named in its title and for screen readers', () => {
    const body = table(render(null));
    const name = geofenceName(zone!).replace(/&/g, '&amp;');
    const flag = new RegExp(
      `<span class="fv-c2 wrap"[^>]*><span class="fv-c2-m">[^<]*</span><span class="fv-c2-s"><span class="fv-zone-flag" title="Inside the restricted zone: ${name.replace(/[()]/g, '\\$&')} — simulated position"><span class="status warning"><svg[^]*?</svg>In restricted zone</span><span class="sr-only">: ${name.replace(/[()]/g, '\\$&')}</span></span></span></span>`,
    );
    expect(body).toMatch(flag);
    // No long "Inside <zone> (restricted)" label, and never two bracket groups in a row.
    expect(body).not.toContain('(restricted)');
    expect(body).not.toMatch(/\) \(/);
  });

  it('the badge on a wrapping cell is allowed to wrap (fleet.css overrides the nowrap .status)', async () => {
    const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync(path: URL, encoding: 'utf8'): string };
    const css = fs.readFileSync(new URL('./fleet.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const at = css.indexOf('\n.fv-c2.wrap .fv-c2-s .status {');
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf('}', at))).toContain('white-space: normal');
  });

  it('the vehicle detail names the zone without doubled brackets', () => {
    const html = render(RESTRICTED_VEHICLE);
    const drawer = html.slice(html.indexOf('class="drawer fl-drawer"'));
    expect(drawer).toContain(`In restricted zone now: ${geofenceName(zone!).replace(/&/g, '&amp;')}`);
    expect(drawer).not.toContain('now (restricted zone)');
    expect(drawer).not.toContain('(no entry) (');
  });
});
