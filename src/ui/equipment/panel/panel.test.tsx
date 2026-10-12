/**
 * The equipment intelligence panel (PANEL_SPEC "Panel UI"), server-rendered from real derived models:
 * one component for every kind of asset and for vehicles; one feed with no topic tabs and no caption
 * block; status and source said once in the header; no 0–100 score on the main view; the action bar
 * holds exactly Focus / Follow, Camera and Ask Copilot, and each is wired to the existing stores;
 * focus requests map to a section; selecting equipment keeps the stage context consistent.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarClock, CircleDashed } from 'lucide-react';

// The stores register browser listeners at import; a minimal window is enough for server rendering.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import type { ReactElement } from 'react';
import { useApp } from '../../../app/store';
import { activateScenario, advance, createSim, type SimState } from '../../../sim/engine';
import { useSim } from '../../../sim/store';
import { useTwin } from '../../../store';
import { useCopilot } from '../../copilot/store';
import { useLiveStatus } from '../../feeds/registry';
import { StagePanel } from '../../twin/StagePanel';
import { useTwinUi } from '../../twin/uiStore';
import { deriveEquipmentIntel, deriveVehicleIntel, type IntelContext } from '../intel/derive';
import type { EquipmentIntel } from '../intel/types';
import { OVERLAY_SELECTOR } from '../../../useKeyboardShortcuts';
import { EquipmentPanel, panelActions, panelFacets, sectionFor } from './EquipmentPanel';
import { FeedView } from './Feed';
import { splitObserved } from './Insights';
import { SEVERITY_META, TONE_ICON } from './tone';

useSim.getState().pause();

const START = 2 * 1440 + 4 * 60 + 20;
const normal = createSim(81, START);
const scenario = (seed: number, minutes: number, ...defs: Parameters<typeof activateScenario>[1][]) => {
  const s = createSim(seed, START);
  for (const d of defs) activateScenario(s, d);
  advance(s, START + minutes);
  return s;
};

const STORES = [useSim, useApp, useTwin, useTwinUi, useLiveStatus, useCopilot] as unknown as { getInitialState: () => object; getState: () => object }[];
const html = (el: ReactElement) => {
  for (const st of STORES) Object.assign(st.getInitialState(), st.getState());
  return renderToStaticMarkup(el);
};
const panel = (s: SimState, m: EquipmentIntel) => html(<EquipmentPanel intel={m} now={s.minute} />);
/** Visible text: tags and attributes (tooltips) removed. */
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length;
const bar = (h: string) => h.slice(h.indexOf('class="eqp-bar"'));

const ASSETS = ['H-KILN', 'E-PRS2', 'C-BM1', 'D-TWR', 'F-DRY', 'G-LINE', 'I-VIS', 'I-SORT', 'J-BOX', 'CV-PACK', 'I-BUF', 'A-COMP', 'A-STK', 'K-DOCK'];

const sv = createSim(7, 2 * 1440 + 400);
for (let i = 0; i < 40 && !sv.logistics.active.some((v) => sv.logistics.vehicles[v].class === 'external' && (sv.logistics.vehicles[v].visit?.gateIn ?? Infinity) <= sv.minute); i++) advance(sv, sv.minute + 10);
const truck = sv.logistics.active.find((v) => sv.logistics.vehicles[v].class === 'external' && (sv.logistics.vehicles[v].visit?.gateIn ?? Infinity) <= sv.minute) ?? null;

describe('one panel for every asset and vehicle', () => {
  const cases: { label: string; s: SimState; m: EquipmentIntel }[] = [
    ...ASSETS.map((id) => ({ label: id, s: normal, m: deriveEquipmentIntel(normal, id) })),
    { label: 'FL-02', s: sv, m: deriveVehicleIntel(sv, 'FL-02') },
    ...(truck ? [{ label: truck, s: sv, m: deriveVehicleIntel(sv, truck) }] : []),
  ];

  it('renders the same shell: fixed header, one feed, a scrolling body and the three actions', () => {
    for (const { label, s, m } of cases) {
      const out = panel(s, m);
      expect(count(out, /class="inspector overlay-panel tw-insp eqp/g), label).toBe(1);
      expect(out, label).toContain('<header class="eqp-h">');
      expect(out, label).toContain('class="tw-insp-b eqp-b"');
      // Exactly one feed (or its unavailable state), no topic tabs, no title / description block under it.
      expect(count(out, /class="eqp-feed(-none)?[ "]/g), label).toBe(1);
      expect(out, label).not.toContain('role="tablist"');
      expect(out, label).not.toContain('<figcaption');
      expect(out, label).not.toContain('vp-meta');
      // The action bar: Focus (Follow for a vehicle), Camera, Ask Copilot — nothing else.
      expect(count(bar(out), /class="btn sm eqp-act/g), label).toBe(3);
      expect(bar(out), label).toMatch(m.subject.type === 'vehicle' ? />Follow</ : />Focus</);
      expect(bar(out), label).toContain('>Camera<');
      expect(bar(out), label).toContain('>Ask Copilot<');
      // Technical details collapsed at the bottom.
      expect(out, label).toContain('Technical details');
      expect(out, label).toContain('aria-expanded="false"');
      expect(text(out), label).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it('says the state and the source once, in the header', () => {
    for (const { label, s, m } of cases) {
      const out = panel(s, m);
      // One source pill (the feed has its own badge); the camera feed's own provenance chips are not shown.
      expect(count(out, /class="prov prov-/g), label).toBe(1);
      expect(out.indexOf(m.header.source.label), label).toBeLessThan(out.indexOf('class="tw-insp-b'));
      // The header's state words appear once as a pill; the machine facet is dropped when it would repeat them.
      expect(count(out, /eqp-state"/g), label).toBe(1);
      for (const f of panelFacets(m)) if (f.key === 'machine' && m.header.state.op) expect(m.header.state.label.toLowerCase().startsWith(f.value.toLowerCase()), label).toBe(false);
    }
    const kiln = panel(normal, deriveEquipmentIntel(normal, 'H-KILN'));
    expect(kiln).not.toContain('<span class="l">Machine</span>');
    expect(kiln).toContain('<span class="l">Material</span>');
    expect(kiln).toContain('<span class="l">Line role</span>');
  });

  it('shows no 0–100 condition score on the main view, and the condition only as a facet, signals and an insight', () => {
    const s = scenario(81, 50, { kind: 'degradation', equipmentId: 'C-BM1', end: null, label: 'Developing fault' });
    const m = deriveEquipmentIntel(s, 'C-BM1');
    const out = panel(s, m);
    expect(out).not.toMatch(/\/\s?100|Condition indicator|Current condition/);
    const c = m.insights.find((i) => i.id === 'condition:C-BM1')!;
    expect(out).toContain(`data-insight="condition:C-BM1"`);
    expect(text(out)).toContain(c.title);
    expect(out).toContain('Vibration · ');
    // The evidence chip of the vibration signal points at its row.
    expect(out).toContain('data-signal="C-BM1.vibration"');
    expect(out).toMatch(/<button type="button" class="eqp-chip link"[^>]*title="Show the signal C-BM1\.vibration[^"]*"/);
    expect(out).toContain('What matters');
  });

  it('lists what is not modelled once, with the reasons, and never as a tile', () => {
    const out = panel(normal, deriveEquipmentIntel(normal, 'H-KILN'));
    expect(count(out, /<b>Not modelled<\/b>/g)).toBe(1);
    expect(out).toContain('Firing temperature profile');
    expect(out).toContain('no thermal model of the kiln');
    expect(out.slice(out.indexOf('class="eqp-kpis"'), out.indexOf('</section>', out.indexOf('class="eqp-kpis"')))).not.toContain('Temperature profile');
    // No kiln wording on another asset.
    for (const id of ['E-PRS2', 'C-BM1', 'J-BOX', 'I-BUF']) expect(text(panel(normal, deriveEquipmentIntel(normal, id))), id).not.toMatch(/Firing temperature|Tiles fired/);
  });

  it('assets without operating data: the reason, no insights, no analytics', () => {
    const m = deriveEquipmentIntel(normal, 'A-COMP');
    const out = panel(normal, m);
    expect(out).toContain('No operating data is simulated for this asset');
    expect(out).toContain('No camera or footage');
    expect(out).not.toContain('What matters');
    expect(out).not.toContain('Operating normally');
    expect(out).toContain('No operating state modelled');
  });
});

describe('the one feed', () => {
  it('kiln: the client recording in the bare player with a badge and the source-details control', () => {
    const m = deriveEquipmentIntel(normal, 'H-KILN');
    expect(m.feed.kind).toBe('recording');
    const out = panel(normal, m);
    expect(out).toContain('class="vp compact bare"');
    expect(out).toContain('class="vp-poster"');
    expect(out).toMatch(/class="eqp-feed-badge k-recording[^"]*"[^>]*>.*?Recorded<\/span>/);
    expect(out).toContain('aria-label="Source details" aria-expanded="false"');
    // Nothing plays before play (the still is the file's metadata frame); the details are in the popover, not under the player.
    expect(out).not.toMatch(/<video(?![^>]*vp-still)/);
    expect(out).not.toMatch(/autoplay/i);
    expect(out).not.toContain('<iframe');
    expect(text(out)).not.toContain('Unit 2 Camera 01 Kiln');
  });

  it('a press: the simulated twin view of its camera; a utility: the unavailable state', () => {
    const p = panel(normal, deriveEquipmentIntel(normal, 'E-PRS2'));
    expect(p).toContain('data-camera="CAM-E1"');
    expect(p).toContain('Twin view · simulated');
    const stk = deriveEquipmentIntel(normal, 'A-STK');
    expect(stk.feed.kind).toBe('reference');
    expect(panel(normal, stk)).toContain('>Reference</span>');
  });

  it('a configured stream: "Live stream" and the connected source only while it actually plays', () => {
    const ctx: IntelContext = { finance: useApp.getState().finance, cameraSources: { 'CAM-E1': { url: 'https://gw.example/press.mp4', kind: 'auto' } } };
    const m = deriveEquipmentIntel(normal, 'E-PRS2', ctx);
    expect(m.feed.kind).toBe('live-stream');
    useApp.setState({ cameraSources: ctx.cameraSources });
    useLiveStatus.setState({ byCamera: {} });
    let out = panel(normal, m);
    expect(out).toContain('Stream · not playing');
    expect(out).not.toMatch(/>Live stream</);
    expect(out).toContain('>Simulated</span>');
    useLiveStatus.setState({ byCamera: { 'CAM-E1': { state: 'loading', at: 0 } } });
    out = panel(normal, m);
    expect(out).toContain('Stream · connecting');
    expect(out).not.toContain('camera connected');
    useLiveStatus.setState({ byCamera: { 'CAM-E1': { state: 'live', at: 0 } } });
    out = panel(normal, m);
    expect(out).toMatch(/>Live stream</);
    expect(out).toContain('Simulated · camera connected');
    useLiveStatus.setState({ byCamera: {} });
    useApp.setState({ cameraSources: {} });
  });
});

describe('states and insights', () => {
  it('a stale feed: the stale source in the header, the stale insight first, no "since" for a frozen state', () => {
    const s = scenario(81, 30, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed lost' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    const out = panel(s, m);
    expect(out).toContain('prov prov-stale');
    expect(out).toContain(m.header.source.label);
    expect(out).not.toContain('class="eqp-since');
    expect(out.indexOf('data-insight="stale:H-KILN"')).toBeGreaterThan(0);
    expect(out.indexOf('data-insight="stale:H-KILN"')).toBe(out.indexOf('data-insight='));
  });

  it('a kiln stop: the event insight first with its evidence, the event in the list, Ask Copilot about it', () => {
    const s = scenario(82, 25, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    const ev = m.insights[0].evidence.find((e) => e.kind === 'event')!;
    const out = panel(s, m);
    expect(out.indexOf(`data-insight="event:${ev.ref}"`)).toBe(out.indexOf('data-insight='));
    expect(out).toMatch(new RegExp(`<button type="button" class="eqp-chip link"[^>]*title="Open ${ev.ref}"`));
    expect(out).toContain(`data-event="${ev.ref}"`);
    expect(out).toContain('Scenario input');
    expect(out).toMatch(/View all \d+ events?/);
    // Ask Copilot: the event's question, in the event's context.
    const ask = panelActions(m, { follow: false, camera: null }).find((a) => a.key === 'ask')!;
    useApp.setState({ copilotOpen: false, copilotPrompt: null, copilotEventId: null });
    ask.run();
    expect(useApp.getState()).toMatchObject({ copilotOpen: true, copilotPrompt: `What should we do about ${ev.ref} on H-KILN?`, copilotEventId: ev.ref });
    useApp.setState({ copilotOpen: false, copilotPrompt: null, copilotEventId: null });
  });

  it('a vehicle: location, movement and task as facets, its activity over time, Follow', () => {
    const m = deriveVehicleIntel(sv, 'FL-02');
    const out = panel(sv, m);
    for (const f of panelFacets(m)) expect(text(out)).toContain(f.value);
    expect(out).toContain('class="eqp-tl-legend"');
    // Said once: the header's movement state is not repeated as a facet, a time at the stop once.
    const shown = panelFacets(m).map((f) => f.value);
    expect(new Set(shown).size).toBe(shown.length);
    if (/^Stationary/.test(m.header.state.label)) expect(shown.some((v) => /^Stationary/.test(v))).toBe(false);
    expect(text(out)).not.toMatch(/dwell/i);
    // Tiles that repeat a facet are not shown twice.
    expect(out).not.toContain('<span class="l">Location</span><b');
  });
});

describe('actions and navigation', () => {
  it('Focus frames the asset, Camera toggles the floating camera view, Ask Copilot carries the asset', () => {
    const m = deriveEquipmentIntel(normal, 'E-PRS2');
    const focus = vi.fn();
    const keep = useTwin.getState().focusEquipment;
    useTwin.setState({ focusEquipment: focus });
    const acts = panelActions(m, { follow: false, camera: null });
    expect(acts.map((a) => a.key)).toEqual(['focus', 'camera', 'ask']);
    acts[0].run();
    expect(focus).toHaveBeenCalledWith('E-PRS2');
    useTwin.setState({ focusEquipment: keep });
    acts[1].run();
    expect(useTwinUi.getState().camera).toBe('CAM-E1');
    panelActions(m, { follow: false, camera: 'CAM-E1' })[1].run();
    expect(useTwinUi.getState().camera).toBeNull();
    useCopilot.setState({ dismissed: ['equipment:E-PRS2'] });
    acts[2].run();
    expect(useApp.getState()).toMatchObject({ copilotOpen: true, copilotPrompt: 'How is E-PRS2 performing?', copilotEventId: null });
    expect(useCopilot.getState().dismissed).not.toContain('equipment:E-PRS2');
    useApp.setState({ copilotOpen: false, copilotPrompt: null });
    // No camera: the action stays, disabled with its reason.
    const util = panelActions(deriveEquipmentIntel(normal, 'A-COMP'), { follow: false, camera: null })[1];
    expect(util.disabled).toBe(true);
    expect(util.title).toBe('No camera position covers this asset');
    expect(bar(panel(normal, deriveEquipmentIntel(normal, 'A-COMP')))).toContain('aria-disabled="true"');
    // A vehicle: Follow.
    const v = panelActions(deriveVehicleIntel(sv, 'FL-02'), { follow: false, camera: null })[0];
    expect(v.label).toBe('Follow');
    v.run();
    expect(useTwin.getState().follow).toBe(true);
    useTwin.getState().setFollow(false);
  });

  it('maps focus requests to a section (condition → its insight or the signals, next → what matters)', () => {
    const m = deriveEquipmentIntel(normal, 'E-PRS2');
    expect(sectionFor('overview', m)).toBe('feed');
    expect(sectionFor('events', m)).toBe('events');
    expect(sectionFor('next', m)).toBe('insights');
    expect(sectionFor('condition', m)).toBe('signals');
    const d = deriveEquipmentIntel(scenario(81, 50, { kind: 'degradation', equipmentId: 'C-BM1', end: null, label: 'fault' }), 'C-BM1');
    expect(sectionFor('condition', d)).toBe('insights');
  });

  it('selecting equipment keeps the stage context consistent (no kiln under "Stage · Packaging")', () => {
    const tw = useTwin.getState();
    tw.selectStage('PACK', { frame: false });
    tw.select('H-KILN');
    expect(useTwin.getState().stage).toBeNull();
    tw.selectStage('KILN', { frame: false });
    tw.select('CV-KIN');
    expect(useTwin.getState().stage).toBe('KILN');
    tw.select('H-KILN');
    expect(useTwin.getState().stage).toBe('KILN');
    tw.reset();
  });

  it('the stage panel shares the shell: one feed without topic tabs, an action bar', () => {
    useSim.setState({ sim: normal, version: normal.version + 1 });
    const out = html(<StagePanel id="KILN" />);
    expect(out).toContain('<header class="eqp-h">');
    expect(count(out, /class="eqp-feed(-none)?[ "]/g)).toBe(1);
    expect(out).not.toContain('role="tablist"');
    expect(bar(out)).toContain('Frame stage');
    // The header's X clears the highlight; the bar does not repeat it.
    expect(bar(out)).not.toContain('Clear highlight');
    expect(count(bar(out), /class="btn sm eqp-act/g)).toBe(1);
  });
});

// ── Review findings (second review): one home per figure, readable cards, accessible controls ─────

/** A source file read from disk (vitest serves CSS imports, also ?raw, as empty strings; the specifier is built at run time). */
const readText = async (rel: string) => {
  const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
};
/** The visible text of the markup: hidden details (the insight "Details") removed. */
const visible = (h: string) => text(h.replace(/<div class="eqp-ins-d"[^>]*hidden=""[^>]*>[\s\S]*?<\/div>/g, ''));

describe('review fixes: the panel says each figure once', () => {
  const kilnStop = scenario(82, 25, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });

  it('rate vs ideal lives in the rate tile: no rate facet, no rate / run-state signal row, no repeated provenance', () => {
    const m = deriveEquipmentIntel(normal, 'H-KILN');
    const out = panel(normal, m);
    const rateFacet = m.facets.find((f) => f.key === 'rate')!;
    expect(panelFacets(m).some((f) => f.key === 'rate')).toBe(false);
    expect(out).not.toContain('<span class="l">Rate</span>');
    // The tile carries the facet's words (one statement of rate vs ideal).
    const tiles = out.slice(out.indexOf('class="eqp-kpis"'), out.indexOf('</section>', out.indexOf('class="eqp-kpis"')));
    expect(text(tiles)).toContain(rateFacet.value.charAt(0).toUpperCase() + rateFacet.value.slice(1));
    expect(out).not.toContain('data-signal="H-KILN.rate"');
    expect(out).not.toContain('data-signal="H-KILN.state"');
    expect(out).toContain('data-signal="H-KILN.vibration"');
    // The header says "Simulated"; the Signals heading does not repeat "Simulated · now".
    expect(visible(out)).not.toContain('Simulated · now');
    // "No own stop" is the Stoppages tile's (no analytics cell repeating it).
    expect(visible(out)).not.toMatch(/No own stop/);
    // The rate figure appears in the tile only (the insight says it in words).
    const rate = m.metrics.kpis.find((k) => k.key === 'rate')!.value!;
    expect(visible(out).split(`${rate} tiles/h`).length - 1).toBeLessThanOrEqual(1);
  });

  it('a stop: the stop code is the header’s, the event row an insight presents is collapsed', () => {
    const m = deriveEquipmentIntel(kilnStop, 'H-KILN');
    const out = panel(kilnStop, m);
    expect(m.header.state.label).toMatch(/^Stopped · /);
    expect(out).not.toContain('data-signal="H-KILN.alarm"');
    // The insight's chips do not restate the header (run state / stop code).
    const ins = out.slice(out.indexOf('data-insight='), out.indexOf('</section>', out.indexOf('data-insight=')));
    expect(ins).not.toMatch(/State STOPPED|Alarm \/ reason code/);
    const ev = m.insights[0].evidence.find((e) => e.kind === 'event')!.ref!;
    const row = out.slice(out.indexOf(`data-event="${ev}"`), out.indexOf('</li>', out.indexOf(`data-event="${ev}"`)));
    expect(row).not.toContain('class="imp"');
    expect(m.events.rows.find((r) => r.event.id === ev)!.impact).toBeTruthy();
  });

  it('insight cards: severity in words, a headline and the next step; why it matters behind "Details"', () => {
    const s = scenario(81, 50, { kind: 'degradation', equipmentId: 'C-BM1', end: null, label: 'Developing fault' });
    const m = deriveEquipmentIntel(s, 'C-BM1');
    const c = m.insights.find((i) => i.id === 'condition:C-BM1')!;
    const out = panel(s, m);
    const card = out.slice(out.indexOf('data-insight="condition:C-BM1"'), out.indexOf('</article>', out.indexOf('data-insight="condition:C-BM1"')));
    expect(card).toMatch(new RegExp(`class="status \\w+ eqp-sev">.*?${SEVERITY_META[c.severity].label}</span>`));
    expect(card).toMatch(/<button type="button" class="eqp-ins-more" aria-expanded="false" aria-controls="[^"]+">Details · why it matters/);
    expect(card).toMatch(/<div class="eqp-ins-d" id="[^"]+" hidden="">/);
    // The visible card is short: headline + next step, not the ~1,000-character paragraph.
    const shown = visible(card);
    expect(shown).not.toContain(c.why.slice(0, 40));
    expect(shown.length).toBeLessThan(560);
    expect(shown).toContain('Next step');
    // Event rows say their severity in words too.
    expect(panel(kilnStop, deriveEquipmentIntel(kilnStop, 'H-KILN'))).toMatch(/<span class="sevw critical">Critical<\/span>/);
  });

  it('the headline of an observation is its first sentence, or a cut at a word', () => {
    expect(splitObserved('Level 13 % (195 of 1,500 tiles). Sorting supplies 0 tiles/h.')).toEqual({ head: 'Level 13 % (195 of 1,500 tiles).', rest: 'Sorting supplies 0 tiles/h.', cut: false });
    const long = `${'word '.repeat(60)}end.`;
    const sp = splitObserved(long);
    expect(sp.cut).toBe(true);
    expect(sp.head.length).toBeLessThanOrEqual(142);
    expect(sp.head.endsWith('…')).toBe(true);
  });

  it('a stale feed: "Unknown" once in the header, no machine facet, one stale icon', () => {
    const s = scenario(81, 30, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed lost' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    expect(panelFacets(m).some((f) => f.key === 'machine')).toBe(false);
    const out = panel(s, m);
    const head = out.slice(0, out.indexOf('class="tw-insp-b'));
    expect(text(head)).toMatch(/Unknown Stale since \d\d:\d\d/);
    expect(head).toMatch(/class="prov prov-stale eqp-src"[^>]*><svg[^>]*lucide-circle-help/);
    expect(count(visible(out), /Unknown · feed stale/g)).toBe(0);
  });

  it('the feed badge tells a client recording from public reference footage; neutral and planned have their own icons', () => {
    expect(panel(normal, deriveEquipmentIntel(normal, 'H-KILN'))).toMatch(/class="eqp-feed-badge k-recording[^"]*"[^>]*><svg[^>]*lucide-film/);
    expect(panel(normal, deriveEquipmentIntel(normal, 'A-STK'))).toMatch(/class="eqp-feed-badge k-reference[^"]*"[^>]*><svg[^>]*lucide-globe/);
    expect(TONE_ICON.planned).toBe(CalendarClock);
    expect(TONE_ICON.neutral).not.toBe(CircleDashed);
  });

  it('no Events section and no "Events & Reports" link when nothing is recorded; View all covers the rest', () => {
    const m = deriveEquipmentIntel(normal, 'A-STK');
    const out = panel(normal, m);
    if (m.events.total === 0 && !m.events.rows.length) expect(out).not.toContain('id="eqp-ev-A-STK"');
    for (const id of ['H-KILN', 'E-PRS2', 'I-VIS']) expect(panel(normal, deriveEquipmentIntel(normal, id)), id).not.toMatch(/Continue in.*Events &amp; Reports/);
  });

  it('a vehicle: the idle time once (the utilisation tile), its task not repeated next to the header', () => {
    const m = deriveVehicleIntel(sv, 'FL-02');
    const out = panel(sv, m);
    const head = m.header.state.label.toLowerCase();
    for (const f of panelFacets(m)) if (f.key === 'trip' && f.value.length > 3) expect(head.includes(f.value.toLowerCase())).toBe(false);
    if (m.metrics.kpis.some((k) => k.key === 'utilisation' && !k.unavailable)) expect(visible(out)).not.toContain('Idle · last hour');
  });
});

describe('review fixes: controls and behaviour', () => {
  it('the action bar is a labelled group; Follow keeps its name while pressed', () => {
    const m = deriveVehicleIntel(sv, 'FL-02');
    useTwin.setState({ follow: true });
    const out = panel(sv, m);
    useTwin.setState({ follow: false });
    expect(out).toContain('class="eqp-bar" role="group" aria-label="Panel actions"');
    expect(out).not.toContain('role="toolbar"');
    expect(bar(out)).toMatch(/aria-pressed="true"[^>]*>.*?<span>Follow<\/span>/);
    expect(panelActions(m, { follow: true, camera: null })[0].label).toBe('Follow');
  });

  it('on a phone the feed is one "Show camera" line, so the figures stay in view', async () => {
    const g = globalThis as unknown as { window: { matchMedia?: unknown } };
    const keep = g.window.matchMedia;
    g.window.matchMedia = (q: string) => ({ matches: q.includes('max-width: 760px'), addEventListener() {}, removeEventListener() {} });
    try {
      const out = html(<FeedView feed={deriveEquipmentIntel(normal, 'H-KILN').feed} subject="H-KILN" />);
      expect(out).toMatch(/<button type="button" class="eqp-feed-show" aria-expanded="false"/);
      expect(out).toContain('Show camera');
      expect(out).not.toContain('class="eqp-feed-frame"');
    } finally {
      g.window.matchMedia = keep;
    }
    expect(await readText('./panel.css')).toMatch(/@media \(max-width: 760px\) \{\s*\.tw-right:has\(> \.eqp\) \{\s*max-height: 56vh;/);
  });

  it('the source details are a disclosure the twin’s Esc leaves to it; the other shortcuts keep working', async () => {
    expect(OVERLAY_SELECTOR).toContain('.eqp-pop');
    expect(await readText('./Feed.tsx')).not.toContain('role="dialog"');
  });

  it('stylesheet rules: docked details under their trigger, no smooth scroll under reduced motion, readable contrast, inner focus ring, back to stream', async () => {
    const p = await readText('./panel.css');
    expect(p).toMatch(/\.eqp-feed\.docked \.eqp-pop \{\s*top: calc\(100% \+ 4px\);/);
    expect(p).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.eqp-b \{\s*scroll-behavior: auto;/);
    expect(p).toMatch(/\.eqp-tl-axis \{[^}]*color: var\(--text-3\);/);
    expect(p).toMatch(/\.eqp-pop dt \{\s*color: var\(--text-2\);/);
    expect(p).toMatch(/\.eqp-pop-fine \{[^}]*color: var\(--text-2\);/);
    // The camera feed's footer stays only for "Stream" (back to a configured stream) — never a dead end.
    expect(p).toMatch(/\.eqp-feed \.feed-f:not\(:has\(\.feed-back\)\) \{\s*display: none;/);
    expect(p).not.toMatch(/\.eqp-feed \.feed-f \{\s*display: none;/);
    expect(await readText('../../feeds/CameraFeed.tsx')).toMatch(/className="btn ghost sm feed-back"/);
    expect(await readText('../../../video/video.css')).toMatch(/\.vp-poster:focus-visible \{\s*box-shadow:\s*inset 0 0 0 2px var\(--accent\)/);
  });

  it('a stage panel with no open event says so (not "no event recorded" above "View all N events")', () => {
    useSim.setState({ sim: normal, version: normal.version + 1 });
    const out = html(<StagePanel id="KILN" />);
    expect(out).not.toMatch(/No event recorded for/);
    if (!out.includes('class="eqp-evs"')) expect(out).toContain('No open event in this stage.');
  });

  it('the stage highlight and the selection stay consistent both ways', () => {
    const tw = useTwin.getState();
    tw.select('H-KILN');
    tw.selectStage('PACK', { frame: false });
    expect(useTwin.getState()).toMatchObject({ selected: null, stage: 'PACK' });
    // An asset of the stage keeps its selection.
    tw.select('J-BOX');
    tw.selectStage('PACK', { frame: false });
    expect(useTwin.getState()).toMatchObject({ selected: 'J-BOX', stage: 'PACK' });
    // A vehicle belongs to no stage: selecting one releases the highlight, highlighting a stage releases it.
    tw.selectVehicle('FL-02');
    expect(useTwin.getState()).toMatchObject({ vehicle: 'FL-02', stage: null });
    tw.selectStage('KILN', { frame: false });
    expect(useTwin.getState()).toMatchObject({ vehicle: null, follow: false, stage: 'KILN' });
    tw.reset();
  });

  it('two players of one camera report separately: closing the floating view keeps the panel’s state', () => {
    const r = useLiveStatus.getState().report;
    useLiveStatus.setState({ byCamera: {}, byPlayer: {} });
    r('CAM-E1', { state: 'live', at: 1 }, 'panel');
    r('CAM-E1', { state: 'loading', at: 2 }, 'window');
    expect(useLiveStatus.getState().byCamera['CAM-E1'].state).toBe('live');
    r('CAM-E1', null, 'window');
    expect(useLiveStatus.getState().byCamera['CAM-E1'].state).toBe('live');
    r('CAM-E1', null, 'panel');
    expect(useLiveStatus.getState().byCamera['CAM-E1']).toBeUndefined();
    useLiveStatus.setState({ byCamera: {}, byPlayer: {} });
  });

  it('analytics on a stale feed carry the not-confirmed mark', () => {
    const s = scenario(81, 30, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'Feed lost' });
    const out = panel(s, deriveEquipmentIntel(s, 'E-PRS2'));
    const an = out.slice(out.indexOf('class="eqp-an"'), out.indexOf('</section>', out.indexOf('class="eqp-an"')));
    expect(an).toMatch(/class="eqp-nc"[^>]*>.*?Not confirmed/);
  });
});
