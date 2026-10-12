/**
 * Fleet & Movement renders (server-side): the primary view (header, four KPIs, site layout with the
 * simulated-positions badge, movement flow, delay review, docks & alerts — no table first), the
 * vehicle detail with the location kind made explicit (simulated now vs last known historical),
 * internal-vehicle dwell as time at the current stop, the not-found state and every secondary tab.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { fleetKpis } from '../../intel/kpis';
import { activateScenario, advance } from '../../sim/engine';
import type { TruckRuntime } from '../../sim/logistics';
import { resolvePeriod } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { ContextVideo, clipsFor } from '../../video/ContextVideo';
import { TOPIC_LABEL } from '../../video/topics';
import { FLEET_TABS, FleetPage, type FleetTab } from '../FleetPage';
import { videoTopicFor } from './movement';

useSim.getState().pause();

const sync = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
};

const render = (fleetVehicleId: string | null, tab: FleetTab | null = null) => {
  useApp.setState({ workspace: 'fleet', period: 'shift', fleetVehicleId, tabs: tab ? { fleet: tab } : {} });
  sync();
  return renderToStaticMarkup(<FleetPage />);
};

// A truck on site past gate-in (a scenario arrival keeps the test independent of the seeded traffic).
const s = useSim.getState().sim;
const sc = activateScenario(s, { kind: 'truck-arrival', end: null, label: 'Render test arrival' });
advance(s, s.minute + 12);
useSim.setState({ version: s.version });
const onSite = Object.values(s.logistics.vehicles).find((v) => v.visit?.scenarioId === sc.id) as TruckRuntime;
const departed = s.logistics.departed.at(-1)!;

describe('Fleet & Movement page', () => {
  it('opens on the site layout: summary, four KPIs, simulated positions, flow, delay review — no table first', () => {
    const html = render(null);
    for (const text of [
      'Fleet &amp; Movement',
      'docks occupied',
      'Vehicles on site',
      'Waiting or delayed',
      'Average truck dwell',
      'Completed truck visits',
      'Site layout',
      'Simulated positions — no tracking system connected',
      'not GPS coordinates',
      'Step 1 · 2 · 7 · Main gate',
      'Weighbridge (inbound)',
      'Holding &amp; queue',
      'Overflow queue (road shoulder)',
      'Dispatch staging',
      'Truck → assigned dock',
      'Movement flow now',
      'Check-in · weighbridge',
      'Delay review',
      'Docks &amp; alerts now',
      'Active vehicle alerts',
      'Simulate a vehicle scenario',
      'Trucks &amp; docks',
      'Gate &amp; dock log',
      'Rules &amp; safety',
    ])
      expect(html, text).toContain(text);
    expect(html).toMatch(/\d+ trucks? on site and \d+ internal vehicles? \(simulated positions\)\./);
    expect(html.match(/class="kc[ "]/g)?.length).toBe(4);
    expect(html).not.toContain('<table');
    expect(html).not.toMatch(/>Live</);
    expect(html).not.toMatch(/real-time|telemetry connected|GPS position/i);
  });

  it('shows an on-site truck with "Simulated position (now)", its trip, dwell, footage and Follow in 3D', () => {
    expect(onSite.visit!.gateIn).toBeLessThanOrEqual(s.minute);
    const html = render(onSite.id);
    for (const text of [
      onSite.id,
      'Outbound truck',
      'External vehicle (carrier)',
      'Simulated position (now)',
      'not a GPS fix',
      'Movement',
      'Visit',
      'Stage ',
      'Visit record',
      'Active visit',
      'Dwell',
      'On site',
      'since gate-in',
      'Waiting for a dock',
      'Visit timeline',
      'Events for this vehicle',
      'Reference footage',
      'Follow in 3D',
    ])
      expect(html, text).toContain(text);
    // Labelled reference footage when the registry has a clip for the activity; otherwise the player's own "no video" state.
    if (clipsFor({ topic: videoTopicFor(s, onSite) }).length) expect(html).toContain('not this vehicle, not this plant and not evidence of its location');
    else expect(html).toContain('No reference video available');
    expect(html).not.toContain('Last known (historical)');
    // The detail replaces the docks & alerts column.
    expect(html).not.toContain('Docks &amp; alerts now');
  });

  it('shows a truck that has left as "Last known (historical) · <time>" — never as a current position', () => {
    const html = render(departed.id);
    expect(html).toContain('Last known (historical) · ');
    expect(html).toContain('Main gate · checked out');
    expect(html).toContain('Completed visit');
    expect(html).toContain('Turnaround');
    expect(html).toContain('Not on site — no current movement');
    expect(html).not.toContain('Simulated position (now)');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Follow in 3D/);
  });

  it('shows an internal vehicle with time at the current stop as dwell; zone residency only as context', () => {
    const html = render('WL-01');
    for (const text of [
      'Wheel loader',
      'Internal vehicle (site fleet)',
      'Simulated position (now)',
      'At current stop',
      'Working in Raw-material shed since',
      'zone residency, shown as context; it is not a dwell',
      'Pickups &amp; drop-offs',
      '<h4>Reference footage</h4>',
    ])
      expect(html, text).toContain(text);
    expect(html).not.toContain('Dwell in zone');
    const fl = render('FL-02');
    expect(fl).toContain('<h4>Reference footage</h4>');
    expect(fl).toContain('At current stop');
  });

  it('says so when the selected vehicle is not in this run', () => {
    const html = render('TRK-99999');
    expect(html).toContain('Vehicle not in this simulation run');
  });

  it('renders every secondary tab (tables and logs live there, not on the primary view)', () => {
    const expected: Record<Exclude<FleetTab, 'map'>, string[]> = {
      trucks: ['Truck visit pipeline', 'Dock board', 'External vehicles', '<table'],
      internal: ['Internal vehicles', 'At current stop', 'in zone since', 'Pickups &amp; drop-offs'],
      records: ['Gate, dock &amp; zone records'],
      events: ['Vehicle events'],
      analytics: ['Gate movements per hour', 'Dock occupancy', 'Which docks carry the load?'],
      safety: ['Detection rules &amp; restricted zones', 'Not available in this demo'],
    };
    for (const tab of FLEET_TABS) {
      if (tab === 'map') continue;
      const html = render(null, tab);
      for (const text of expected[tab]) expect(html, `${tab}: ${text}`).toContain(text);
      expect(html, tab).not.toContain('Dwell in zone');
      // With a vehicle selected the detail opens in the drawer over the tab (never a column beside it).
      const sel = render(onSite.id, tab);
      expect(sel, tab).toContain('Simulated position (now)');
      expect(sel, tab).toContain('class="drawer fl-drawer"');
      expect(sel, tab).not.toContain('class="work"');
    }
  });
});

/** Header cells of each vehicle table (dock board, external, internal), keyed by the panel title. */
const tableHeaders = (html: string) => {
  const out: Record<string, string[]> = {};
  for (const part of html.split('<section class="panel fv-tbl').slice(1)) {
    const title = /<h2>([^<]*)<\/h2>/.exec(part)?.[1] ?? '?';
    const head = part.slice(part.indexOf('<thead>'), part.indexOf('</thead>'));
    out[title] = [...head.matchAll(/<th(?:\s[^>]*)?>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  }
  return out;
};

describe('Fleet & Movement table tabs with a vehicle selected (review #30)', () => {
  it('Trucks & docks: the truck opens in an overlay drawer; the tables keep the full width with ≤ 8 columns', () => {
    const html = render(onSite.id, 'trucks');
    // Drawer pattern of the Scenarios / Copilot drawers: scrim + modal dialog, the vehicle detail inside.
    expect(html).toContain('class="drawer-scrim"');
    expect(html).toMatch(new RegExp(`<div class="drawer fl-drawer" role="dialog" aria-modal="true" aria-label="Vehicle ${onSite.id}">`));
    const drawer = html.slice(html.indexOf('class="drawer fl-drawer"'));
    for (const text of ['Simulated position (now)', 'Visit timeline', 'Arrival at the gate approach', 'Gate in', 'Gate out', 'At the dock', 'Follow in 3D'])
      expect(drawer, text).toContain(text);
    // No side column: the work area is one column and the detail is not rendered as the sticky side panel.
    expect(html).toContain('class="fl-solo"');
    expect(html).not.toContain('class="work"');
    expect(html).not.toContain('fl-side');
    // The tables are still there, with the selected truck's row highlighted, each ≤ 8 columns.
    const heads = tableHeaders(html);
    expect(Object.keys(heads)).toEqual(['Dock board', 'External vehicles']);
    for (const [title, cols] of Object.entries(heads)) expect(cols.length, `${title}: ${cols.join(' | ')}`).toBeLessThanOrEqual(8);
    expect(heads['External vehicles']).toEqual(['Vehicle', 'Stage', 'Dock', 'Loading', 'Gate in', 'Waiting', 'Turnaround', 'Event']);
    expect(html).toMatch(/<tr class="clickable sel"/);
  });

  it('Internal vehicles: the vehicle opens in the drawer; task, idle time and restricted entries live in the detail', () => {
    const html = render('FL-02', 'internal');
    expect(html).toContain('aria-label="Vehicle FL-02"');
    expect(html).not.toContain('class="work"');
    const heads = tableHeaders(html);
    const cols = heads['Internal vehicles'];
    expect(cols).toEqual(['Vehicle', 'Zone', 'Movement', 'Current activity', 'Last pickup / drop-off', 'Handling, 60 min', 'At current stop', 'Event']);
    const drawer = html.slice(html.indexOf('class="drawer fl-drawer"'));
    for (const text of ['Task', 'Idle, last hour', 'Restricted-zone entries today', 'At current stop', 'Forklift']) expect(drawer, text).toContain(text);
    // Zone residency stays context in the table, never a dwell.
    expect(html).toContain('in zone since');
  });

  it('Site & movement keeps the detail as the column beside the layout (no drawer)', () => {
    const html = render(onSite.id, 'map');
    expect(html).toContain('class="work"');
    expect(html).toContain('fl-vd fl-side');
    expect(html).not.toContain('fl-drawer');
    expect(html).not.toContain('aria-modal');
  });
});

/** The footage section of the vehicle detail: its heading and the note under the player. */
const footage = (html: string) => {
  const at = html.indexOf('<h4>Reference footage');
  const sec = html.slice(at, html.indexOf('</div>', html.indexOf('fl-video-note', at)));
  return { heading: /<h4>(.*?)<\/h4>/.exec(sec)?.[1] ?? '', note: /<p class="fl-video-note">(.*?)<\/p>/.exec(sec)?.[1] ?? '' };
};

describe('Vehicle footage names no topic of its own (verify: held clip vs live topic)', () => {
  it('heading and note never name the live topic — the player caption names the clip actually shown', () => {
    for (const id of [onSite.id, 'WL-01', 'FL-02']) {
      const html = render(id);
      const v = s.logistics.vehicles[id];
      const label = TOPIC_LABEL[videoTopicFor(s, v)];
      const { heading, note } = footage(html);
      expect(heading, id).toBe('Reference footage');
      expect(note, id).toContain('Public footage of this kind of operation');
      expect(note, id).toContain('not this vehicle, not this plant and not evidence of its location');
      // A held clip of an earlier activity would otherwise sit under the new activity's topic name.
      expect(note.toLowerCase(), id).not.toContain(label.toLowerCase());
      expect(note, id).not.toMatch(/illustrating/i);
    }
  });

  it('the note is hidden by CSS only when the player shows its own "no reference video" state', async () => {
    // ContextVideo's no-clip state carries .cv-none; fleet.css hides the note right after it.
    expect(renderToStaticMarkup(<ContextVideo context={{}} compact />)).toMatch(/^<div class="cv cv-none/);
    const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync(path: URL, encoding: 'utf8'): string };
    const css = fs.readFileSync(new URL('./fleet.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\n\.cv-none \+ \.fl-video-note \{\n {2}display: none;/);
  });
});

/** The KPI cards of a render, keyed by label → { scope, unit, target }. */
const kpiCards = (html: string) => {
  const out: Record<string, { scope: string; unit: string; target: string }> = {};
  for (const part of html.split(/<(?:div|button) [^>]*class="kc[ "]/).slice(1)) {
    const label = /<span class="kc-label">([^<]*)<\/span>/.exec(part)?.[1] ?? '?';
    out[label.replace(/&amp;/g, '&')] = {
      scope: (/<div class="kc-scope">(.*?)<\/div>/.exec(part)?.[1] ?? '').replace(/&amp;/g, '&'),
      unit: /<small>([^<]*)<\/small>/.exec(part)?.[1] ?? '',
      target: (/<span class="kc-target">([^<]*)<\/span>/.exec(part)?.[1] ?? '').replace(/&amp;/g, '&'),
    };
  }
  return out;
};

describe('Fleet KPI cards (verify: scopes to date, units, plurals)', () => {
  it('render the shared fleet KPI models: running-period scopes read "(to date)", vehicles carry a unit', () => {
    const html = render(null);
    const cards = kpiCards(html);
    const p = resolvePeriod('shift', s.minute);
    expect(p.to).toBeGreaterThanOrEqual(s.minute); // the shift is still running at this plant minute
    const models = fleetKpis(s, p);
    expect(Object.keys(cards)).toEqual(models.map((k) => k.label));
    // Same scope, unit and target text as the KPI models (kpiCardProps), nothing recomputed on the page.
    for (const k of models) {
      expect(cards[k.label].scope, k.id).toBe(k.scope);
      if (!k.unavailable) expect(cards[k.label].unit, k.id).toBe(k.unit ?? '');
      expect(cards[k.label].target, k.id).toBe(k.target ?? '');
    }
    expect(cards['Average truck dwell'].scope).toMatch(/\(to date\) · completed visits$/);
    expect(cards['Completed truck visits'].scope).toMatch(/\(to date\)$/);
    expect(cards['Vehicles on site'].unit).toMatch(/^vehicles?$/);
    // Never "1 trucks": the truck count in the target is pluralised correctly.
    expect(cards['Vehicles on site'].target).toMatch(/^(1 truck|(?!1 )\d+ trucks) · \d+ internal$/);
    // The full-shift window never appears as a KPI scope while the shift is running.
    for (const c of Object.values(cards)) expect(c.scope).not.toBe(p.label);
  });
});

describe('Fleet & Movement contrast (review #31)', () => {
  it('informational text never uses --text-4 (≈3:1 on the panel background)', async () => {
    // Read from disk: vitest serves CSS imports (also ?raw) as empty strings. The specifier is built at
    // run time so the browser-only tsconfig (no Node types) does not need to resolve 'node:fs'.
    const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync(path: URL, encoding: 'utf8'): string };
    const css = fs.readFileSync(new URL('./fleet.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    for (const rule of ['.fv-none', '.fv-steps li.pending .t']) {
      const at = css.indexOf(`\n${rule} {`);
      expect(at, rule).toBeGreaterThan(-1);
      const body = css.slice(at, css.indexOf('}', at));
      expect(body, rule).toContain('color: var(--text-3)');
    }
    expect(css).not.toMatch(/(^|[^-])color:\s*var\(--text-4\)/m);
  });
});
