/**
 * Equipment intelligence derivation (PANEL_SPEC "Derivation"): the model is complete for every kind of
 * asset and for vehicles, built from the shared simulation only (the same KPI tiles as equipmentKpis),
 * the feed follows its order, insights follow the rules with honest wording (observed vs possible cause,
 * rule / scenario / event basis, no failure probability, component — not process — temperature,
 * placeholder and energy values only as "not modelled"), the stale-feed and constraint rules hold, and
 * the analytics add up (time in state = window, stops and MTBF / MTTR from the asset's own records).
 */
import { describe, expect, it } from 'vitest';
import { EQUIPMENT } from '../../../data/equipment';
import { CONVEYOR_BY_ID, GEOFENCES, OPS_BY_ID, SIGNALS, cameraFor } from '../../../model/plant';
import { activateScenario, advance, createSim, type SimState } from '../../../sim/engine';
import { clippedDuration, operationalState, resolvePeriod, sumBuckets } from '../../../sim/metrics';
import { formatClock } from '../../../sim/time';
import { ask } from '../../../intel/copilot';
import { constraintClaim } from '../../../intel/summary';
import { eventsOfAsset } from '../context';
import { equipmentKpis, ownStops, vehicleKpis } from '../kpis';
import { basisOf } from '../signals';
import { deriveEquipmentIntel, deriveVehicleIntel, eventRows, type IntelContext } from './derive';
import { intelProfileFor, NOT_MODELLED_SIGNALS } from './profiles';
import { assetProfile } from '../profile';
import type { EquipmentIntel } from './types';

/** The Overview test's seeded normal state: production ahead, nothing open, the kiln not held up. */
const START = 2 * 1440 + 4 * 60 + 20;
const ASSETS = ['H-KILN', 'E-PRS2', 'C-BM1', 'D-TWR', 'F-DRY', 'G-LINE', 'I-VIS', 'I-SORT', 'J-BOX', 'CV-PACK', 'I-BUF', 'A-COMP'];
const TRACKED = ['H-KILN', 'E-PRS2', 'C-BM1', 'D-TWR', 'F-DRY', 'G-LINE', 'I-SORT', 'J-BOX', 'CV-PACK'];

const normal = createSim(81, START);
const scenario = (seed: number, minutes: number, ...defs: Parameters<typeof activateScenario>[1][]) => {
  const s = createSim(seed, START);
  for (const d of defs) activateScenario(s, d);
  advance(s, START + minutes);
  return s;
};

/** Every text the derivation produced for the main view (not the shared KPI tiles, not the raw event records). */
function derivedText(m: EquipmentIntel): string {
  const parts: string[] = [m.header.title, m.header.subtitle, m.header.state.label, m.header.source.label];
  if (m.feed.kind !== 'none') parts.push(m.feed.badge, ...m.feed.details.map((d) => `${d.label} ${d.value}`));
  else parts.push(m.feed.reason);
  for (const f of m.facets) parts.push(f.label, f.value, f.hint);
  for (const i of m.insights) parts.push(i.title, i.observed, i.why, i.next ?? '', i.basisLabel, ...i.evidence.map((e) => e.label));
  if (m.analytics) {
    parts.push(m.analytics.window.label, m.analytics.stops?.basis ?? '', m.analytics.loss?.basis ?? '', ...(m.analytics.facts ?? []).map((f) => `${f.label} ${f.value} ${f.hint}`));
    for (const b of m.analytics.loss?.breakdown ?? []) parts.push(b.label, b.hint);
  }
  for (const r of m.signals.rows) parts.push(r.label, r.value ?? '', r.unit ?? '', r.interpretation?.label ?? '', r.limits ?? '', r.freshness);
  for (const n of m.signals.notModelled) parts.push(n.label, n.reason);
  for (const r of m.events.rows) parts.push(r.impact ?? '');
  return parts.join('\n');
}

function expectComplete(m: EquipmentIntel, label: string) {
  expect(m.header.title, label).toBeTruthy();
  expect(m.header.subtitle, label).toMatch(/ · /);
  expect(['good', 'warning', 'critical', 'neutral']).toContain(m.header.state.tone);
  // Wave 3: assets without operating data say 'unavailable' / 'reference', never 'simulated'; nothing is 'connected'.
  expect(['simulated', 'stale', 'unavailable', 'reference']).toContain(m.header.source.kind);
  expect(['live-stream', 'recording', 'twin-view', 'reference', 'none']).toContain(m.feed.kind);
  if (m.feed.kind === 'none') {
    expect(m.feed.badge).toBeNull();
    expect(m.feed.reason.length).toBeGreaterThan(10);
  } else expect(m.feed.badge.length).toBeGreaterThan(0);
  expect(m.facets.length, label).toBeLessThanOrEqual(5);
  for (const f of m.facets) {
    expect(f.value, `${label} ${f.key}`).toBeTruthy();
    expect(f.hint.length, `${label} ${f.key}`).toBeGreaterThan(10);
  }
  expect(m.insights.length, label).toBeLessThanOrEqual(3);
  for (const i of m.insights) {
    expect(i.observed.length, `${label} ${i.id}`).toBeGreaterThan(10);
    expect(i.why.length, `${label} ${i.id}`).toBeGreaterThan(10);
    expect(['rule', 'scenario', 'event']).toContain(i.basis);
    expect(i.basisLabel.length).toBeGreaterThan(3);
    expect(['observed', 'likely', 'possible']).toContain(i.certainty);
  }
  expect(m.events.rows.length).toBeLessThanOrEqual(5);
  expect(m.events.total).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(m.signals.rows) && Array.isArray(m.signals.notModelled)).toBe(true);
}

describe('the model is complete for every kind of asset', () => {
  it('builds header, feed, facets, metrics, insights, analytics, signals and events from the shared state', () => {
    for (const id of ASSETS) {
      const m = deriveEquipmentIntel(normal, id);
      expectComplete(m, id);
      expect(m.subject).toEqual({ type: 'equipment', id, profile: assetProfile(id) });
      // The KPI tiles are the shared equipmentKpis set, never a second calculation.
      expect(m.metrics).toEqual(equipmentKpis(normal, id, resolvePeriod('shift', normal.minute), constraintClaim(normal)));
      expect(m.cameraId).toBe(cameraFor(id)?.id ?? null);
      expect(!!m.analytics, id).toBe(TRACKED.includes(id));
      expect(m.health != null, id).toBe(assetProfile(id).conditionMonitored);
      // Facets come from the asset's profile, in its order.
      const keys = intelProfileFor(assetProfile(id)).facets;
      expect(m.facets.map((f) => f.key).every((k) => keys.includes(k)), id).toBe(true);
    }
  });

  it('names the asset and its production stage in the header, with the state from assetStatus', () => {
    const kiln = deriveEquipmentIntel(normal, 'H-KILN');
    expect(kiln.header.title).toBe('Single-layer roller kiln');
    expect(kiln.header.subtitle).toBe('Kiln firing & cooling · H-KILN');
    expect(kiln.header.state).toEqual({ label: 'Running', tone: 'good', op: 'running' });
    expect(kiln.header.source).toEqual({ kind: 'simulated', label: 'Simulated' });
    expect(kiln.header.zone?.id).toBe('H');
    expect(deriveEquipmentIntel(normal, 'A-COMP').header.state).toEqual({ label: 'No operating state modelled', tone: 'neutral', op: null });
    expect(deriveEquipmentIntel(normal, 'I-BUF').header.state.op).toBeNull();
    const stopped = scenario(81, 15, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press stop' });
    const press = deriveEquipmentIntel(stopped, 'E-PRS2');
    expect(press.header.state.label).toBe('Stopped · simulated breakdown (scenario)');
    expect(press.header.state.tone).toBe('critical');
    expect(press.header.since).toBe(stopped.machines['E-PRS2'].since);
  });

  it('shows nothing kiln-specific on other assets', () => {
    const KILN_TEXT = /Single-layer roller kiln|H-KILN|gearmotor|temp_firing|firing temperature|pre-heating|Tiles fired|Kiln camera|Firing-cycle/i;
    for (const id of ASSETS.filter((x) => x !== 'H-KILN')) {
      const m = deriveEquipmentIntel(normal, id);
      expect(derivedText(m), id).not.toMatch(KILN_TEXT);
      if (m.feed.kind === 'recording' || m.feed.kind === 'reference') expect(m.feed.video.equipment.includes('H-KILN') && !m.feed.video.equipment.includes(id), id).toBe(false);
    }
    // The kiln shows its own component and its not-modelled thermal parameters.
    expect(derivedText(deriveEquipmentIntel(normal, 'H-KILN'))).toMatch(/roller drive gearmotor/);
  });
});

describe('every selectable asset and every vehicle', () => {
  it('derives a complete model for all of them, in several plant states', () => {
    const sims = [normal, scenario(83, 90, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: null, label: 'Infeed stop' }, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 4, end: null, label: 'Glaze defects' })];
    for (const s of sims) {
      for (const e of EQUIPMENT) {
        const m = deriveEquipmentIntel(s, e.id);
        expectComplete(m, e.id);
        expect(derivedText(m), e.id).not.toMatch(/undefined|NaN|\[object/);
      }
      for (const vid of Object.keys(s.logistics.vehicles)) {
        const m = deriveVehicleIntel(s, vid);
        expectComplete(m, vid);
        expect(derivedText(m), vid).not.toMatch(/undefined|NaN|\[object/);
        if (m.analytics) expect(m.analytics.timeInState.reduce((x, t) => x + t.minutes, 0), vid).toBe(m.analytics.window.to - m.analytics.window.from);
      }
    }
  });
});

describe('feed: exactly one, in the configured order', () => {
  it('kiln → its recording; packaging → its recording; a camera without stream or recording → reference clip; a utility → none', () => {
    const kiln = deriveEquipmentIntel(normal, 'H-KILN').feed;
    expect(kiln.kind).toBe('recording');
    if (kiln.kind === 'recording') {
      expect(kiln.video.id).toBe('vid-kiln-camera-1');
      expect(kiln.video.sourceType).toBe('client-recording');
      expect(kiln.badge).toBe('Recorded');
      expect(kiln.details.map((d) => d.value).join(' ')).toMatch(/a recording — not a live feed; its overlays come from the system that recorded it/i);
      expect(kiln.details.find((d) => d.label === 'Camera')?.value).toBe('Unit 2 Camera 01 Kiln');
    }
    for (const id of ['J-BOX', 'CV-PACK']) {
      const f = deriveEquipmentIntel(normal, id).feed;
      expect(f.kind, id).toBe('recording');
      if (f.kind === 'recording') expect(f.video.id).toBe('vid-packaging-camera-1');
    }
    const press = deriveEquipmentIntel(normal, 'E-PRS2').feed;
    // A camera without a configured stream or recording: the client's reference clip of the process (never a twin render).
    expect(press.kind).toBe('reference');
    if (press.kind === 'reference') {
      expect(press.video.id).toBe('vid-pressing-client-1');
      expect(press.details.map((d) => d.value).join(' ')).toMatch(/comparable process — not this plant, not live/i);
    }
    // A camera without a stream and without footage of its process: no image, with how to configure one.
    const sort = deriveEquipmentIntel(normal, 'I-SORT').feed;
    if (sort.kind === 'none') expect(sort.reason).toMatch(/No stream is configured|no footage/i);
    expect(deriveEquipmentIntel(normal, 'A-COMP').feed.kind).toBe('none');
    // An asset without a camera or a recording: no footage (no public reference clips are registered).
    expect(deriveEquipmentIntel(normal, 'A-STK').feed.kind).toBe('none');
  });

  it('uses a configured stream first (shown Live only by the player while it plays)', () => {
    const ctx: IntelContext = { finance: deriveCtx().finance, cameraSources: { 'CAM-E1': { url: 'https://gw.example/cam-e1.mp4', kind: 'auto' } } };
    const press = deriveEquipmentIntel(normal, 'E-PRS2', ctx);
    expect(press.feed).toMatchObject({ kind: 'live-stream', cameraId: 'CAM-E1', badge: 'Live stream' });
    // The derivation never claims a connected source; the UI upgrades it while the stream plays.
    expect(press.header.source.kind).toBe('simulated');
    // The kiln's own camera has no stream: still its recording.
    expect(deriveEquipmentIntel(normal, 'H-KILN', ctx).feed.kind).toBe('recording');
  });
});

function deriveCtx(): IntelContext {
  return { finance: { currency: 'USD', sellingPricePerM2: 8, variableCostPerM2: 4.8, soldOutShare: 1, scrapCostPerM2: 3.9, reworkShare: 0.25, reworkCostPerM2: 1.2, truckWaitCostPerHour: 35 }, cameraSources: {} };
}

describe('signals: PLC-style rows from the registry, honest about what is not modelled', () => {
  it('never shows a placeholder process value or an energy counter as a row', () => {
    for (const id of [...ASSETS, 'D-TWR', 'F-DRY', 'A-SUB']) {
      const m = deriveEquipmentIntel(normal, id);
      const ids = new Set(SIGNALS.filter((d) => d.equipmentId === id).map((d) => d.id));
      for (const r of m.signals.rows) {
        expect(ids.has(r.id), r.id).toBe(true);
        const name = r.id.slice(r.id.indexOf('.') + 1);
        expect(['placeholder', 'energy-model'], r.id).not.toContain(basisOf(name));
      }
      for (const d of SIGNALS.filter((x) => x.equipmentId === id && ['placeholder', 'energy-model'].includes(basisOf(x.name))))
        expect(m.signals.notModelled.map((n) => n.label), `${id} ${d.name}`).toContain(NOT_MODELLED_SIGNALS[d.name].label);
    }
    const kiln = deriveEquipmentIntel(normal, 'H-KILN').signals;
    expect(kiln.rows.some((r) => r.id === 'H-KILN.temp_firing')).toBe(false);
    // Wave 3: the single firing temperature is superseded by the simulated zone temperatures, and says so.
    expect(kiln.notModelled.find((n) => n.label === 'Firing temperature profile (single value)')?.reason).toMatch(/five simulated zone temperatures/);
  });

  it('labels the condition temperature with its component, never as a process temperature', () => {
    for (const id of ['H-KILN', 'E-PRS2', 'C-BM1', 'D-TWR', 'F-DRY']) {
      const rows = deriveEquipmentIntel(normal, id).signals.rows;
      const temp = rows.find((r) => r.id === `${id}.temperature`)!;
      expect(temp.label, id).toMatch(/^Temperature · [a-z]/);
      expect(temp.label, id).not.toMatch(/firing|process|deck|inlet/i);
      expect(temp.limits, id).toMatch(/component, not process/);
      const vib = rows.find((r) => r.id === `${id}.vibration`)!;
      expect(vib.unit).toBe('mm/s RMS');
      expect(vib.limits).toMatch(/^expected [\d.]+ · alarm [\d.]+ · trip [\d.]+ mm\/s$/);
      expect(vib.trend?.length).toBeGreaterThan(5);
    }
    const kilnTemp = deriveEquipmentIntel(normal, 'H-KILN').signals.rows.find((r) => r.id === 'H-KILN.temperature')!;
    expect(kilnTemp.label).toBe('Temperature · roller drive gearmotor');
    expect(kilnTemp.limits).toMatch(/— roller drive gearmotor \(firing zone\) \(component, not process\)$/);
  });

  it('orders rows by usefulness and interprets them against the configured limits', () => {
    const rows = deriveEquipmentIntel(normal, 'H-KILN').signals.rows;
    expect(rows.map((r) => r.id.split('.')[1])).toEqual(['state', 'rate', 'alarm', 'vibration', 'temperature', 'motor_current', 'count_total']);
    const rate = rows.find((r) => r.id === 'H-KILN.rate')!;
    expect(rate.unit).toBe('tiles/h');
    expect(rate.limits).toBe('ideal 1,250 tiles/h');
    expect(rate.interpretation?.label).toMatch(/% of ideal/);
    expect(rate.freshness).toBe('Simulated · now');
    for (const r of rows) expect(r.stale).toBe(false);
    const conv = deriveEquipmentIntel(normal, 'CV-PACK').signals.rows;
    expect(conv.find((r) => r.id === 'CV-PACK.speed')?.limits).toBe(`nominal ${CONVEYOR_BY_ID['CV-PACK'].speedMpm} m/min`);
    const buf = deriveEquipmentIntel(normal, 'I-BUF').signals.rows.find((r) => r.id === 'I-BUF.level')!;
    expect(buf.unit).toBe('%');
    expect(buf.trend?.length).toBeGreaterThan(5);
    const vis = deriveEquipmentIntel(normal, 'I-VIS').signals.rows.find((r) => r.id === 'I-VIS.count_rejected')!;
    expect(vis.interpretation?.label).toMatch(/% of inspected this shift/);
  });
});

describe('insights: what matters, with evidence and honest wording', () => {
  const HONESTY = /probabilit|predict|\bAI\b|machine learning|\/100|\bscore\b/i;

  it('normal state: "Operating normally" with the evidence, no generic text', () => {
    const kiln = deriveEquipmentIntel(normal, 'H-KILN');
    const top = kiln.insights[0];
    expect(top.title).toBe('Operating normally');
    expect(top.severity).toBe('positive');
    // The rate itself is the rate tile's (one home per figure): the insight says it in words only.
    expect(top.observed).toMatch(/^Motor current \d+ A \(\d+ % of rated 60 A\) and vibration [\d.]+ mm\/s \(expected [\d.]+, alarm 4\.5\) within limits; running at \d+ % of ideal; no open event\.$/);
    expect(top.evidence.map((e) => e.ref)).toEqual(['H-KILN.motor_current', 'H-KILN.vibration']);
    // Link chips are named by their signal; the value is in the text.
    expect(top.evidence.map((e) => e.short)).toEqual(['Motor current', 'Vibration']);
    expect(top.why).toContain('modeled design constraint');
    expect(top.next).toBeNull();
    for (const id of ['E-PRS2', 'J-BOX', 'CV-PACK', 'I-VIS']) expect(deriveEquipmentIntel(normal, id).insights[0].title, id).toBe('Operating normally');
    // No insight for an asset without operating data.
    expect(deriveEquipmentIntel(normal, 'A-COMP').insights).toEqual([]);
    for (const id of ASSETS) for (const i of deriveEquipmentIntel(normal, id).insights) expect(`${i.title} ${i.observed} ${i.why}`, id).not.toMatch(HONESTY);
  });

  it('machine stop (scenario): the event insight comes first, from the event record, basis scenario', () => {
    const s = scenario(82, 25, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    const top = m.insights[0];
    const ev = s.events.find((e) => e.end == null && e.asset.equipmentId === 'H-KILN' && e.type === 'machine-stop')!;
    expect(top.id).toBe(`event:${ev.id}`);
    expect(top.title).toBe(ev.title);
    expect(top.severity).toBe('critical');
    expect(top.basis).toBe('scenario');
    expect(top.basisLabel).toBe('Scenario input · event rule R-STOP');
    expect(top.evidence[0]).toEqual({ kind: 'event', label: `${ev.id} · Unexpected machine stop`, ref: ev.id });
    // The headline is the event's impact (the event row's line); the why explains it.
    expect(top.observed).toMatch(/^Kiln held up \d+ min · [\d.,]+ m² line output lost so far\. At detection \(\d\d:\d\d\): /);
    expect(top.observed.split('. ')[0]).toBe(m.events.rows.find((r) => r.event.id === ev.id)!.impact);
    expect(top.why).toMatch(/^The kiln is the line constraint: every minute it is held up is line output lost\./);
    expect(top.next).toBe(ev.recommendations[0]);
    expect(m.ask).toEqual({ prompt: `What should we do about ${ev.id} on H-KILN?`, eventId: ev.id });
    // The kiln's stop is "constraining output" — the one constraint statement.
    expect(m.facets.find((f) => f.key === 'role')).toMatchObject({ value: 'Constraining output', tone: 'warning' });
    // A press stop: its event first; no line output claimed while the buffers cover it.
    const p = scenario(81, 15, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press stop' });
    const press = deriveEquipmentIntel(p, 'E-PRS2').insights[0];
    expect(press.basis).toBe('scenario');
    expect(press.title).toBe('Hydraulic press 2 stopped');
    expect(press.observed).toMatch(/^[\d,]+ tiles \([\d.,]+ m²\) not made · no line output lost so far\. /);
    expect(press.why).toMatch(/^The buffers between it and the kiln hold [\d,]+ tiles ≈ /);
  });

  it('starvation: the insight names the upstream stage and its buffer, the cause only as possible / likely', () => {
    const s = scenario(81, 40, { kind: 'machine-stop', equipmentId: 'G-LINE', end: null, label: 'Glaze stop' });
    expect(operationalState(s, 'G-INK')).toBe('starved');
    const dec = deriveEquipmentIntel(s, 'G-INK').insights.find((i) => i.id === 'flow:G-INK')!;
    expect(dec.title).toBe('Upstream material starvation');
    expect(dec.certainty).toBe('observed');
    expect(dec.observed).toMatch(/Input buffer Glaze → decoration transfer \(BUF-GLZ\) at 0 %/);
    expect(dec.observed).toMatch(/Upstream, glazing is stopped \(G-LINE/);
    expect(dec.why).toMatch(/Likely cause|Possible contributing factor/);
    expect(operationalState(s, 'H-KILN')).toBe('starved');
    const kiln = deriveEquipmentIntel(s, 'H-KILN');
    const k = kiln.insights[0];
    expect(k.title).toBe('Upstream material starvation');
    expect(k.severity).toBe('serious');
    expect(k.observed).toMatch(/Kiln infeed \(BUF-KIN\) at 0 % of 700 tiles/);
    expect(k.observed).toMatch(/Upstream, digital decoration is/);
    expect(k.why).toMatch(/^The kiln is the line constraint: every minute it is starved is line output lost/);
    expect(k.why).toMatch(/(Possible contributing factor|Likely cause)[^.]*G-LINE/);
    expect(k.next).toMatch(/^Restore G-LINE first/);
    expect(kiln.facets.find((f) => f.key === 'material')?.value).toBe('Starved — kiln infeed empty');
  });

  it('degradation (scenario): the condition insight with the trend and the ETA, never a probability', () => {
    const s = scenario(81, 50, { kind: 'degradation', equipmentId: 'C-BM1', end: null, label: 'Developing fault' });
    const m = deriveEquipmentIntel(s, 'C-BM1');
    const c = m.insights.find((i) => i.id === 'condition:C-BM1')!;
    expect(c).toBeTruthy();
    expect(m.insights[0]).toBe(c);
    expect(c.basis).toBe('scenario');
    expect(c.basisLabel).toMatch(/rule-based/);
    expect(c.observed).toMatch(/Vibration [\d.]+ mm\/s RMS at the mill gearbox \(output-shaft bearing\): [\d.]+× expected \([\d.]+ mm\/s at this load\)/);
    expect(c.observed).toMatch(/rising [\d.]+ mm\/s per hour/);
    expect(c.why).toMatch(/trip limit in ≈ [\d.]+ (h|min|days)/);
    expect(c.why).toMatch(/Possible contributing factor/);
    expect(`${c.title} ${c.observed} ${c.why}`).not.toMatch(HONESTY);
    expect(c.next).toMatch(/^Inspect the gearbox output-shaft bearing/);
    expect(c.evidence.some((e) => e.ref === 'C-BM1.vibration')).toBe(true);
    expect(m.facets.find((f) => f.key === 'condition')?.tone).not.toBe('good');
  });

  it('stale feed: the stale insight first, the stale source, last values and no trend after the freeze', () => {
    const s = scenario(81, 30, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'Feed lost' });
    const since = s.feeds['E-PRS2'].since;
    const m = deriveEquipmentIntel(s, 'E-PRS2');
    expect(m.header.source).toEqual({ kind: 'stale', label: `Stale since ${formatClock(since)}`, since });
    expect(m.header.state.op).toBe('unknown');
    expect(m.insights[0].id).toBe('stale:E-PRS2');
    expect(m.insights[0].title).toBe(`Data feed stale since ${formatClock(since)}`);
    expect(m.insights[0].basis).toBe('scenario');
    expect(m.insights.some((i) => i.title === 'Operating normally')).toBe(false);
    for (const r of m.signals.rows) {
      expect(r.stale, r.id).toBe(true);
      expect(r.freshness).toBe(`Last value ${formatClock(since)} (feed stale)`);
      expect(r.interpretation?.tone ?? 'neutral', r.id).toBe('neutral');
    }
    const rate = m.signals.rows.find((r) => r.id === 'E-PRS2.rate')!;
    expect(rate.value).toBe(Math.round(s.feeds['E-PRS2'].lastRate ?? 0).toLocaleString('en-GB'));
    // The timeline knows nothing after the freeze.
    const unknown = m.analytics!.timeInState.find((x) => x.state === 'unknown');
    expect(unknown?.minutes).toBe(s.minute - since);
    expect(m.analytics!.rate!.points.at(-1)).toBeNull();
    expect(m.analytics!.loss!.reachedLine).toBe('unknown');
    // The silo beside it: its figures rest on the stale feed, said once.
    const silo = deriveEquipmentIntel(s, 'D-SILO');
    expect(silo.insights[0].title).toBe('Figures not confirmed — E-PRS2 data stale');
    expect(silo.header.source.kind).toBe('simulated');
  });

  it('a stale kiln feed: no constraint claim beyond the modeled design constraint', () => {
    const s = scenario(81, 30, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed lost' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    expect(m.facets.find((f) => f.key === 'role')).toMatchObject({ value: 'Design constraint (modeled)', tone: 'neutral' });
    expect(derivedText(m)).not.toMatch(/Constraining output|currently constraining/);
  });

  it('constraint: "Constraining output" only where the claim says so; normal state → design constraint (modeled)', () => {
    expect(constraintClaim(normal).constraining).toBe(false);
    for (const id of ASSETS) {
      const m = deriveEquipmentIntel(normal, id);
      expect(derivedText(m), id).not.toMatch(/Constraining output|currently constraining/);
    }
    expect(deriveEquipmentIntel(normal, 'H-KILN').facets.find((f) => f.key === 'role')).toMatchObject({ value: 'Design constraint (modeled)', tone: 'neutral' });
    // Blocking traced downstream to sorting (seed 90): sorting is constraining, the kiln is not called so.
    const b = createSim(90, START);
    const claim = constraintClaim(b);
    expect(claim.constraining).toBe(true);
    expect(claim.processStage).toBe('SORT');
    const sort = deriveEquipmentIntel(b, 'I-SORT');
    expect(sort.facets.find((f) => f.key === 'role')).toMatchObject({ value: 'Constraining output', tone: 'warning' });
    const role = sort.insights.find((i) => i.id === 'role:I-SORT')!;
    expect(role.title).toBe('Constraining line output');
    expect(role.why).toMatch(/^Every minute lost here is lost line output/);
    expect(role.certainty).toBe('likely');
    expect(deriveEquipmentIntel(b, 'H-KILN').facets.find((f) => f.key === 'role')?.value).not.toBe('Constraining output');
  });

  it('below its own set rate (scenario): performance loss in tiles/h and m²/h, against the line pace', () => {
    const s = scenario(81, 5, { kind: 'reduced-rate', equipmentId: 'J-BOX', factor: 0.6, end: null, label: 'slow' });
    const m = deriveEquipmentIntel(s, 'J-BOX');
    const r = m.insights.find((i) => i.id === 'rate:J-BOX')!;
    expect(r.title).toBe('Running below its set rate');
    expect(r.basis).toBe('scenario');
    expect(r.why).toMatch(/^Performance loss ≈ [\d,]+ tiles\/h \([\d,]+ m²\/h\)/);
    expect(r.why).toMatch(/below the kiln's 1,250 tiles\/h/);
    expect(m.facets.find((f) => f.key === 'rate')).toMatchObject({ tone: 'warning' });
  });

  it('supply-paced machines below their ideal rate are neutral, in words', () => {
    for (const id of ['I-SORT', 'J-BOX', 'C-BM1']) {
      const rate = deriveEquipmentIntel(normal, id).facets.find((f) => f.key === 'rate')!;
      if (rate.value.includes('paced by')) expect(rate.tone, id).toBe('neutral');
      expect(rate.tone, id).not.toBe('warning');
    }
  });

  it('a buffer is read on its side of the kiln — no "normal" next to a warning', () => {
    for (const id of ['I-BUF', 'D-SILO', 'C-SLIP', 'F-BUF']) {
      const m = deriveEquipmentIntel(normal, id);
      expect(m.facets.map((f) => f.key), id).toEqual(['material', 'rate']);
      const lvl = m.facets[0];
      expect(lvl.label).toBe('Level');
      if (lvl.tone === 'warning') expect(m.insights.some((i) => i.severity === 'positive'), id).toBe(false);
      expect(m.insights.length, id).toBeGreaterThan(0);
    }
  });
});

describe('analytics add up', () => {
  const states = [normal, scenario(82, 25, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' })];

  it('time in state sums to the window; the timeline is contiguous; the rate trend has one point per 10 min', () => {
    for (const s of states)
      for (const id of TRACKED) {
        const a = deriveEquipmentIntel(s, id).analytics!;
        const span = a.window.to - a.window.from;
        expect(span, id).toBe(Math.min(240, s.minute));
        expect(a.timeInState.reduce((x, t) => x + t.minutes, 0), id).toBe(span);
        expect(a.timeline[0].from).toBe(a.window.from);
        expect(a.timeline.at(-1)!.to).toBe(a.window.to);
        for (let i = 1; i < a.timeline.length; i++) {
          expect(a.timeline[i].from, id).toBe(a.timeline[i - 1].to);
          expect(a.timeline[i].state, id).not.toBe(a.timeline[i - 1].state);
        }
        expect(a.rate!.points.length).toBe(Math.ceil(span / 10));
        expect(a.rate!.ideal).toBe(OPS_BY_ID[id]?.idealRatePerHour ?? CONVEYOR_BY_ID[id].capacityPerHour);
      }
  });

  it('stops and MTBF / MTTR agree with the asset’s own downtime records', () => {
    for (const s of states)
      for (const id of TRACKED) {
        const st = deriveEquipmentIntel(s, id).analytics!.stops!;
        const p = resolvePeriod('shift', s.minute);
        const own = ownStops(s, id, p);
        expect(st.shiftCount, id).toBe(own.count);
        expect(st.shiftMinutes, id).toBe(own.minutes);
        if (st.topReason) expect(st.topReason.minutes).toBeLessThanOrEqual(st.shiftMinutes + 1e-9);
        const from = Math.max(0, s.minute - 7 * 1440);
        const fails = s.downtime.filter((d) => d.equipmentId === id && ['Mechanical', 'Electrical & control', 'Process'].includes(d.category) && (d.end ?? s.minute) > from);
        if (fails.length < 2) {
          expect(st.mtbfH, id).toBeNull();
          expect(st.mttrMin, id).toBeNull();
        } else {
          const down = fails.reduce((x, d) => x + clippedDuration(d, { from, to: s.minute, label: '' }, s.minute), 0);
          expect(st.mtbfH!, id).toBeCloseTo((s.minute - from - down) / fails.length / 60, 6);
          const closed = fails.filter((d) => d.end != null);
          expect(st.mttrMin!, id).toBeCloseTo(closed.reduce((x, d) => x + (d.end! - d.start), 0) / closed.length, 6);
        }
      }
  });

  it('lost output = planned time × ideal rate − count, split into stops, waiting and pace; the kiln reaches line output', () => {
    for (const s of states)
      for (const id of TRACKED.filter((x) => !CONVEYOR_BY_ID[x])) {
        const loss = deriveEquipmentIntel(s, id).analytics!.loss!;
        const t = sumBuckets(s, id, resolvePeriod('shift', s.minute));
        const ideal = OPS_BY_ID[id].idealRatePerHour!;
        expect(loss.tiles, id).toBeCloseTo(Math.max(0, (t.planned * ideal) / 60 - t.count), 6);
        expect(loss.breakdown!.reduce((x, b) => x + b.tiles, 0), id).toBeCloseTo(loss.tiles, 6);
        for (const b of loss.breakdown!) expect(b.tiles, `${id} ${b.key}`).toBeGreaterThanOrEqual(0);
      }
    expect(deriveEquipmentIntel(normal, 'H-KILN').analytics!.loss!.reachedLine).toBe('yes');
    expect(deriveEquipmentIntel(normal, 'E-PRS2').analytics!.loss!.reachedLine).toBe('no');
    expect(deriveEquipmentIntel(normal, 'CV-PACK').analytics!.loss).toBeNull();
    expect(deriveEquipmentIntel(normal, 'I-BUF').analytics).toBeNull();
  });
});

describe('events: open first, repeated resolved types collapsed, at most five', () => {
  it('orders and collapses the asset’s event records', () => {
    const s = scenario(81, 40, { kind: 'machine-stop', equipmentId: 'G-LINE', end: null, label: 'Glaze stop' });
    for (const id of ['H-KILN', 'G-INK', 'G-LINE', 'E-PRS2', 'I-VIS']) {
      const ev = deriveEquipmentIntel(s, id).events;
      const rows = ev.rows;
      expect(rows.length).toBeLessThanOrEqual(5);
      const group = (r: (typeof rows)[number]) => (r.event.end == null ? 0 : r.event.status !== 'resolved' ? 1 : 2);
      for (let i = 1; i < rows.length; i++) expect(group(rows[i]), id).toBeGreaterThanOrEqual(group(rows[i - 1]));
      const resolved = rows.filter((r) => group(r) === 2);
      expect(new Set(resolved.map((r) => r.event.type)).size, id).toBe(resolved.length);
      expect(ev.openCount, id).toBe(eventsOfAsset(s, id).filter((e) => e.status !== 'resolved').length);
      expect(ev.total, id).toBeGreaterThanOrEqual(rows.length);
    }
    const kiln = deriveEquipmentIntel(s, 'H-KILN').events.rows[0];
    expect(kiln.event.end).toBeNull();
    expect(kiln.impact).toMatch(/^Kiln held up \d+ min · [\d.,]+ m² line output lost so far$/);
    // Collapsed counts: the older resolved events of the same type.
    const all = eventRows(s, s.events.filter((e) => e.asset.equipmentId === 'G-LINE'), deriveCtx().finance, 50);
    for (const r of all.filter((x) => x.earlier))
      expect(r.earlier).toBe(s.events.filter((e) => e.asset.equipmentId === 'G-LINE' && e.status === 'resolved' && e.type === r.event.type).length - 1);
  });
});

describe('vehicles', () => {
  const sv: SimState = createSim(7, 2 * 1440 + 400);
  for (let i = 0; i < 40 && !sv.logistics.active.some((v) => sv.logistics.vehicles[v].class === 'external' && (sv.logistics.vehicles[v].visit?.gateIn ?? Infinity) <= sv.minute); i++) advance(sv, sv.minute + 10);

  it('FL-02: location, movement, task and dwell; analytics of moving / stationary that sum to the window', () => {
    const m = deriveVehicleIntel(sv, 'FL-02');
    expectComplete(m, 'FL-02');
    expect(m.subject).toEqual({ type: 'vehicle', id: 'FL-02' });
    expect(m.header.title).toBe('FL-02 · Forklift');
    expect(m.header.source).toEqual({ kind: 'simulated', label: 'Simulated' });
    expect(m.facets.map((f) => f.key).slice(0, 3)).toEqual(['location', 'movement', 'trip']);
    expect(m.metrics).toEqual(vehicleKpis(sv, 'FL-02'));
    expect(m.signals.rows).toEqual([]);
    expect(m.signals.notModelled.map((n) => n.label)).toContain('GPS / telematics position');
    expect(m.insights.length).toBeGreaterThan(0);
    const a = m.analytics!;
    expect(a.timeInState.reduce((x, t) => x + t.minutes, 0)).toBe(a.window.to - a.window.from);
    for (const seg of a.timeline) expect(['Moving', 'Stationary', 'No route record']).toContain(seg.label);
    expect(a.facts?.map((f) => f.label)).toEqual(expect.arrayContaining(['Moves · last hour', 'Loaded moves · last hour']));
    expect(m.ask?.prompt).toBe('What is forklift FL-02 doing?');
  });

  it('a truck: visit phase and dwell against the limits, its events, one feed', () => {
    const id = sv.logistics.active.find((v) => sv.logistics.vehicles[v].class === 'external' && (sv.logistics.vehicles[v].visit?.gateIn ?? Infinity) <= sv.minute)!;
    expect(id).toBeTruthy();
    const m = deriveVehicleIntel(sv, id);
    expectComplete(m, id);
    expect(m.header.title).toMatch(/ · (Outbound truck|Inbound tipper)$/);
    expect(m.facets.map((f) => f.key)).toEqual(expect.arrayContaining(['location', 'movement', 'trip', 'dwell']));
    expect(m.facets.find((f) => f.key === 'dwell')?.value).toMatch(/limit 150 min$/);
    expect(m.metrics).toEqual(vehicleKpis(sv, id));
    expect(m.insights.length).toBeGreaterThan(0);
    expect(m.events.total).toBeGreaterThanOrEqual(m.events.rows.length);
    expect(derivedText(m)).not.toMatch(/GPS fix|live position/i);
  });

  it('an unknown vehicle id yields an explicit, empty model', () => {
    const m = deriveVehicleIntel(sv, 'NOPE-1');
    expect(m.header.state.label).toBe('No longer simulated');
    expect(m.feed.kind).toBe('none');
    expect(m.insights).toEqual([]);
  });
});

// ── Review findings (FIX: equipment intelligence panel, second review) ─────────────────────────────

describe('review fixes: one reading of each fact', () => {
  const kilnStop = scenario(82, 25, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
  const MACHINES = EQUIPMENT.filter((e) => assetProfile(e.id).kind === 'machine').map((e) => e.id);

  it('"reached line output" follows the event engine’s attribution, never a stop overlapping a kiln stall in time', () => {
    const sims = [kilnStop, scenario(81, 40, { kind: 'machine-stop', equipmentId: 'G-LINE', end: null, label: 'Glaze stop' }), normal];
    for (const s of sims)
      for (const id of MACHINES) {
        const m = deriveEquipmentIntel(s, id);
        const loss = m.analytics?.loss;
        if (!loss) continue;
        expect(loss.basis, id).not.toMatch(/held up the kiln \(constraint impact/);
        if (loss.reachedLine !== 'yes' || assetProfile(id).stage === 'KILN' || m.facets.some((f) => f.key === 'role' && f.value === 'Constraining output')) continue;
        // "yes" for any other machine: its own production events hold kiln minutes (the event rows say so too).
        const p = resolvePeriod('shift', s.minute);
        const own = s.events.filter((e) => e.category === 'production' && !e.consequenceOf && e.asset.equipmentId === id && e.start < p.to && (e.end ?? s.minute) > p.from);
        expect(own.reduce((a, e) => a + e.acc.constraintMin, 0), id).toBeGreaterThan(0);
      }
    // G-INK: its changeover overlapped the kiln stop — not attributed (no event record), so not known;
    // its stop events credit no kiln minute.
    const ink = deriveEquipmentIntel(kilnStop, 'G-INK');
    expect(ink.analytics!.loss!.reachedLine).toBe('unknown');
    expect(ink.analytics!.loss!.basis).toMatch(/without an event record \(product changeover\) overlapped a kiln stall — not attributed/);
    for (const r of ink.events.rows.filter((x) => x.event.category === 'production' && !x.event.consequenceOf)) expect(r.impact ?? '').toMatch(/no line output lost/);
  });

  it('the rate tile and the line-role facet make one constraint statement (process stage, not monitored stage)', () => {
    const sims = [
      scenario(81, 120, { kind: 'reduced-rate', equipmentId: 'J-BOX', factor: 0.5, end: null, label: 'slow' }),
      scenario(81, 150, { kind: 'reduced-rate', equipmentId: 'G-INK', factor: 0.5, end: null, label: 'slow' }),
      scenario(81, 40, { kind: 'machine-stop', equipmentId: 'G-LINE', end: null, label: 'Glaze stop' }),
      kilnStop,
    ];
    for (const s of sims)
      for (const id of MACHINES) {
        const m = deriveEquipmentIntel(s, id);
        const tile = m.metrics.kpis.find((k) => k.key === 'rate');
        const role = m.facets.find((f) => f.key === 'role');
        const tileSays = /Constraining output/.test(tile?.status?.label ?? '');
        // A stopped machine's tile says "Stopped" (critical) — its own state comes first, the role facet carries the claim.
        const ownState = tile?.status?.tone === 'critical' || /^(Planned stop|Last value)/.test(tile?.status?.label ?? '');
        if (tileSays || !ownState) expect(tileSays, `${id} tile "${tile?.status?.label}" vs role "${role?.value}"`).toBe(role?.value === 'Constraining output');
        if (tileSays) expect(m.insights.some((i) => i.title === 'Operating normally'), id).toBe(false);
      }
  });

  it('a stopped asset’s condition insight quotes the running samples before the stop, without a trip ETA', () => {
    const s = scenario(81, 120, { kind: 'degradation', equipmentId: 'H-KILN', end: null, label: 'Developing fault' });
    expect(operationalState(s, 'H-KILN')).toBe('fault');
    const c = deriveEquipmentIntel(s, 'H-KILN').insights.find((i) => i.id === 'condition:H-KILN')!;
    expect(c).toBeTruthy();
    expect(c.title).toMatch(/before the stop$/);
    expect(c.observed).toMatch(/^Stopped since \d\d:\d\d; before the stop, vibration averaged [\d.]+ mm\/s RMS at the roller drive gearmotor \(firing zone\): [\d.]+× expected \([\d.]+ mm\/s at that load\)\. That is the mean of its running samples of the last 60 min\./);
    // Not the idle reading of the stopped drive, no extrapolation from a stopped machine.
    expect(c.observed).not.toMatch(/Vibration 0\.\d mm\/s/);
    expect(`${c.observed} ${c.why}`).not.toMatch(/reaches|trip limit in|rising/);
    expect(c.evidence[0].label).toMatch(/60-min running mean before the stop/);
    // Never "reaches beyond the alarm limit" anywhere.
    for (const sim of [s, scenario(81, 50, { kind: 'degradation', equipmentId: 'C-BM1', end: null, label: 'fault' })])
      for (const id of ['H-KILN', 'C-BM1']) for (const i of deriveEquipmentIntel(sim, id).insights) expect(i.why, id).not.toMatch(/reaches beyond/);
  });

  it('a buffer is "operating normally" only while both neighbours run with flow and no key figure warns', () => {
    const m = deriveEquipmentIntel(kilnStop, 'I-BUF');
    expect(operationalState(kilnStop, 'I-SORT')).toBe('starved');
    expect(m.insights.some((i) => i.title === 'Operating normally')).toBe(false);
    const i = m.insights[0];
    expect(i.title).toBe('Not filled — sorting & inspection itself starved');
    expect(i.severity).toBe('info');
    expect(i.why).toMatch(/^It covers ≈ \d+ min of packing at its current [\d,]+ tiles\/h; behind the kiln, packing waiting for tiles loses no line output\./);
    for (const s of [normal, kilnStop, scenario(81, 40, { kind: 'machine-stop', equipmentId: 'G-LINE', end: null, label: 'Glaze stop' })])
      for (const id of ['C-SLIP', 'D-SILO', 'F-BUF', 'I-BUF']) {
        const b = deriveEquipmentIntel(s, id);
        if (!b.insights.some((x) => x.title === 'Operating normally')) continue;
        expect(b.metrics.kpis.some((k) => k.status && ['warning', 'critical', 'serious'].includes(k.status.tone)), id).toBe(false);
        // "keep running" only when both neighbours do (or one is paced by this buffer's normal level).
        expect(b.insights[0].why, id).toMatch(/(keeps? running|waits for (room in it|tiles) \(normal (ahead of|after) the kiln\))\.$/);
        expect(b.insights[0].why, id).not.toMatch(/starved|blocked|stopped/);
      }
  });

  it('a buffer level reads the same on its facet, tile, signal row and insight (its side of the kiln)', () => {
    for (const id of ['C-SLIP', 'D-SILO', 'F-BUF', 'I-BUF']) {
      const m = deriveEquipmentIntel(normal, id);
      const facet = m.facets.find((f) => f.key === 'material')!;
      const row = m.signals.rows.find((r) => r.id === `${id}.level`)!;
      const tile = m.metrics.kpis.find((k) => k.key === 'level')!;
      // A warning on one is a warning on all of them; "normal here" is never amber anywhere.
      expect(row.interpretation!.tone === 'warning', id).toBe(facet.tone === 'warning');
      expect(tile.status?.tone === 'warning', id).toBe(facet.tone === 'warning');
      if (/· (full|low)$/.test(facet.value)) expect(row.interpretation!.label, id).toMatch(/normal (ahead of|after) the kiln/);
    }
  });

  it('the kiln’s starvation states one lost-output figure — the event impact model’s, as its event row', () => {
    const s = scenario(81, 40, { kind: 'machine-stop', equipmentId: 'G-LINE', end: null, label: 'Glaze stop' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    const k = m.insights.find((i) => i.id === 'flow:H-KILN')!;
    const fig = /— ([\d.,]+ m²) so far \((EV-\d+): kiln held up (\d+) min, event impact model\)/.exec(k.why);
    expect(fig, k.why).not.toBeNull();
    const row = m.events.rows.find((r) => r.event.id === fig![2]);
    if (row) expect(row.impact).toBe(`Kiln held up ${fig![3]} min · ${fig![1]} line output lost so far`);
    else expect(m.events.rows.some((r) => (r.impact ?? '').includes(fig![1]))).toBe(true);
  });

  it('evidence chips point at the signal each observation describes; a shift reject rate of the line is a figure', () => {
    const top = deriveEquipmentIntel(kilnStop, 'H-KILN').insights[0];
    expect(top.evidence.find((e) => e.label.startsWith('Alarm / reason code'))?.ref).toBe('H-KILN.alarm');
    expect(top.evidence.find((e) => e.label.startsWith('State '))?.ref).toBe('H-KILN.state');
    const q = scenario(83, 90, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 4, end: null, label: 'Glaze defects' });
    for (const s of [normal, q]) for (const i of deriveEquipmentIntel(s, 'I-SORT').insights) for (const e of i.evidence) expect(e.ref, i.id).not.toBe('I-SORT.count_good');
  });

  it('one motor-current figure: the insight’s share of rated equals the signal row’s', () => {
    const m = deriveEquipmentIntel(normal, 'H-KILN');
    const ins = /Motor current (\d+) A \((\d+) % of rated/.exec(m.insights[0].observed)!;
    const row = m.signals.rows.find((r) => r.id === 'H-KILN.motor_current')!;
    expect(row.value).toBe(ins[1]);
    expect(row.interpretation!.label).toBe(`${ins[2]} % of rated`);
  });

  it('an event insight quotes the record’s summary as of its detection', () => {
    for (const i of deriveEquipmentIntel(kilnStop, 'H-KILN').insights.filter((x) => x.id.startsWith('event:'))) expect(i.observed).toMatch(/(^|\. )At detection \(\d\d:\d\d\): /);
  });

  it('a product changeover is "Changeover" in the header, the timeline and the stoppages tile — never an unplanned stop', () => {
    const ink = deriveEquipmentIntel(kilnStop, 'G-INK');
    expect(ink.header.state).toEqual({ label: 'Changeover', tone: 'neutral', op: 'changeover' });
    expect(ink.analytics!.timeline.some((sg) => sg.label === 'Changeover')).toBe(true);
    expect(ink.analytics!.timeInState.some((t) => t.label === 'Changeover')).toBe(true);
    const own = ownStops(kilnStop, 'G-INK', resolvePeriod('shift', kilnStop.minute));
    expect(own.changeovers).toBeGreaterThan(0);
    const sub = ink.metrics.kpis.find((k) => k.key === 'stops')!.sub!;
    expect(sub).toContain(`${own.changeovers} changeover`);
    const unplanned = own.count - own.changeovers;
    if (unplanned) expect(sub).toContain(`${unplanned} unplanned stop`);
    else expect(sub).not.toMatch(/unplanned/);
    // The timeline stays contiguous with distinct neighbours (state and label).
    const tl = ink.analytics!.timeline;
    for (let i = 1; i < tl.length; i++) expect(`${tl[i].state}|${tl[i].label ?? ''}`).not.toBe(`${tl[i - 1].state}|${tl[i - 1].label ?? ''}`);
  });

  it('no empty facet: a stopped machine has no "Material · —"', () => {
    for (const s of [kilnStop, normal]) for (const e of EQUIPMENT) for (const f of deriveEquipmentIntel(s, e.id).facets) expect(f.value.trim(), `${e.id} ${f.key}`).not.toMatch(/^—?$/);
  });
});

describe('review fixes: a stale feed (Decision 1) everywhere', () => {
  it('quality facets and station counters rest on the sorting line’s feed: neutral, not confirmed', () => {
    const s = scenario(81, 40, { kind: 'signal-loss', equipmentId: 'I-SORT', end: null, label: 'Sorting feed lost' });
    const since = formatClock(s.feeds['I-SORT'].since);
    for (const id of ['I-SORT', 'I-VIS', 'I-GAUGE']) {
      const m = deriveEquipmentIntel(s, id);
      expect(m.metrics.stale?.label, id).toBe(`Not confirmed · sorting data stale since ${since}`);
      const q = m.facets.find((f) => f.key === 'quality');
      if (q) {
        expect(q.tone, id).toBe('neutral');
        expect(q.value, id).toMatch(/not confirmed$/);
      }
      for (const r of m.signals.rows.filter((x) => /\.count_(inspected|rejected|good)$/.test(x.id))) {
        expect(r.stale, r.id).toBe(true);
        expect(r.interpretation?.tone ?? 'neutral', r.id).toBe('neutral');
        expect(r.interpretation?.label ?? 'not confirmed', r.id).toMatch(/not confirmed/);
        expect(r.freshness, r.id).not.toBe('Simulated · now');
      }
    }
  });

  it('analytics after a freeze say what they cover and carry the not-confirmed mark', () => {
    const s = scenario(81, 30, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'Feed lost' });
    const since = formatClock(s.feeds['E-PRS2'].since);
    const a = deriveEquipmentIntel(s, 'E-PRS2').analytics!;
    const out = a.facts!.find((f) => f.label.startsWith('Output'))!;
    expect(out.label).toMatch(new RegExp(`^Output · .* to ${since}$`));
    expect(out.hint).toContain(`after the feed went stale at ${since} are excluded`);
    expect(a.facts!.find((f) => f.label.startsWith('Mean rate'))!.label).toMatch(new RegExp(` to ${since}$`));
    expect(a.stops!.notConfirmed).toBe(`Not confirmed · E-PRS2 data stale since ${since}`);
    expect(a.loss!.notConfirmed).toBe(`Not confirmed · E-PRS2 data stale since ${since}`);
    // A fresh asset carries no mark.
    expect(deriveEquipmentIntel(normal, 'E-PRS2').analytics!.loss!.notConfirmed).toBeUndefined();
  });

  it('the header of a stale feed says "Unknown" once (the source pill says since when)', () => {
    const s = scenario(81, 30, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed lost' });
    const m = deriveEquipmentIntel(s, 'H-KILN');
    expect(m.header.state.label).toBe('Unknown');
    expect(m.facets.find((f) => f.key === 'condition')?.value).toBe('Unknown');
  });
});

describe('review fixes: vehicles', () => {
  const sv: SimState = createSim(7, 2 * 1440 + 400);

  it('time in state keeps every leg’s exact duration (short driving legs are not dropped)', () => {
    const s = createSim(7, 2 * 1440 + 400);
    advance(s, 3317);
    for (const vid of ['WL-01', 'FL-05']) {
      const a = deriveVehicleIntel(s, vid).analytics!;
      const v = s.logistics.vehicles[vid];
      const moving = v.legs.filter((l) => l.moving).reduce((x, l) => x + Math.max(0, Math.min(l.end, a.window.to) - Math.max(l.start, a.window.from)), 0);
      const shown = a.timeInState.find((t) => t.state === 'running')?.minutes ?? 0;
      expect(shown, vid).toBeCloseTo(moving, 6);
      expect(a.timeInState.reduce((x, t) => x + t.minutes, 0), vid).toBeCloseTo(a.window.to - a.window.from, 6);
      // Between legs the vehicle stands where the last one ended: no "no route record" slivers.
      expect(a.timeline.filter((t) => t.state === 'unknown').length, vid).toBe(0);
    }
    const wl = deriveVehicleIntel(s, 'WL-01').analytics!;
    expect(wl.timeInState.find((t) => t.state === 'running')!.minutes).toBeGreaterThan(5);
  });

  it('a vehicle off site has no feed; on site a recording only of the place it is in', () => {
    const left = Object.keys(sv.logistics.vehicles).filter((v) => deriveVehicleIntel(sv, v).header.state.label === 'Left site');
    expect(left.length).toBeGreaterThan(0);
    for (const vid of left) expect(deriveVehicleIntel(sv, vid).feed).toEqual({ kind: 'none', reason: 'Left the site — no feed.', badge: null, details: [] });
    for (const vid of sv.logistics.active) {
      const m = deriveVehicleIntel(sv, vid);
      if (m.feed.kind !== 'recording') continue;
      const gf = GEOFENCES.find((g) => g.id === [...sv.logistics.vehicles[vid].legs].reverse().find((l) => l.start <= sv.minute)?.zone);
      expect(m.feed.video.equipment, vid).toContain(gf?.equipmentId);
    }
  });

  it('Ask Copilot about a vehicle gets an answer about that vehicle', () => {
    const s = createSim(7, 2 * 1440 + 400);
    for (let i = 0; i < 40 && !s.logistics.active.some((v) => s.logistics.vehicles[v].class === 'external' && (s.logistics.vehicles[v].visit?.gateIn ?? Infinity) <= s.minute); i++) advance(s, s.minute + 10);
    const truck = s.logistics.active.find((v) => s.logistics.vehicles[v].class === 'external' && (s.logistics.vehicles[v].visit?.gateIn ?? Infinity) <= s.minute)!;
    for (const vid of ['FL-02', 'WL-01', truck]) {
      const m = deriveVehicleIntel(s, vid);
      const a = ask(s, m.ask!.prompt, undefined, { equipmentId: null });
      if (m.ask!.eventId) continue;
      expect(a.intent, `${vid}: ${m.ask!.prompt}`).toBe('vehicle');
      expect(a.sections[0].text, vid).toContain(s.logistics.vehicles[vid].label);
      expect(a.links.some((l) => l.kind === 'fleet-vehicle' && l.id === vid), vid).toBe(true);
    }
    // "This truck" while one is selected in the twin.
    expect(ask(s, 'Is this truck on time?', undefined, { vehicleId: truck }).intent).toBe('vehicle');
  });
});
