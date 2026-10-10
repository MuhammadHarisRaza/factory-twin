import { describe, it } from 'vitest';
import { advance, createSim, activateScenario } from './sim/engine';
import { DEFAULT_START } from './sim/time';
import { buildEventReport, eventImpact } from './intel/report';
import { DEFAULT_FINANCE } from './sim/finance';
import { DEFAULT_TARIFFS } from './sim/energy';
import { evidenceOf, eventsFor, eventInMonitoredStage } from './sim/events';
import { resolvePeriod } from './sim/metrics';
import { qualityEventsIn, inspectionEventLinks, impactFigures } from './pages/quality/derive';
import { filterEvents, facetCounts, DEFAULT_FILTERS } from './pages/events/filters';
import { MONITORED_STAGES } from './model/plant';

const time = (fn: () => unknown, n = 5) => {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
};

function measure(label: string, s: ReturnType<typeof createSim>) {
  const cats: Record<string, number> = {};
  for (const e of s.events) cats[e.category] = (cats[e.category] ?? 0) + 1;
  console.log(`\n=== ${label}: minute=${s.minute} events=${s.events.length} evidence=${s.evidence.length} inspections=${s.inspections.length} batches=${s.batches.length}`, cats);
  // buildEventReport over all events
  let tot = 0;
  let max = 0;
  let maxId = '';
  for (const e of s.events) {
    const t0 = performance.now();
    buildEventReport(s, e.id, { finance: DEFAULT_FINANCE, tariffs: DEFAULT_TARIFFS });
    const dt = performance.now() - t0;
    tot += dt;
    if (dt > max) {
      max = dt;
      maxId = `${e.id} ${e.category}`;
    }
  }
  console.log(`buildEventReport: avg ${(tot / s.events.length).toFixed(3)} ms, max ${max.toFixed(2)} ms (${maxId}), sum-all ${tot.toFixed(1)} ms`);
  const byCat: Record<string, number[]> = {};
  for (const e of s.events) {
    const t0 = performance.now();
    eventImpact(s, e, DEFAULT_FINANCE, DEFAULT_TARIFFS);
    (byCat[e.category] ??= []).push(performance.now() - t0);
  }
  for (const [c, xs] of Object.entries(byCat)) console.log(`eventImpact ${c}: n=${xs.length} avg ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)} ms max ${Math.max(...xs).toFixed(2)}`);
  const ev = s.events[s.events.length - 1];
  console.log('evidenceOf (last event):', time(() => evidenceOf(s, ev), 50).toFixed(3), 'ms');
  for (const pk of ['shift', '24h', '7d'] as const) {
    const p = resolvePeriod(pk, s.minute);
    const t = time(() => {
      const events = qualityEventsIn(s, p);
      for (const e of [...events.open, ...events.resolved]) impactFigures(eventImpact(s, e, DEFAULT_FINANCE, DEFAULT_TARIFFS));
    });
    const qe = qualityEventsIn(s, p);
    const tb = time(() =>
      s.batches
        .filter((b) => b.start < p.to && (b.end ?? s.minute) > p.from)
        .map((b) => s.inspections.filter((r) => r.batchId === b.id && r.result === 'reject')),
    );
    console.log(`Quality ${pk}: events=${qe.open.length + qe.resolved.length} impacts ${t.toFixed(2)} ms; batches loop ${tb.toFixed(2)} ms; links ${time(() => inspectionEventLinks(s)).toFixed(2)} ms`);
  }
  const ctx = { now: s.minute };
  console.log('Events filter+facets (24h):', time(() => (filterEvents(s.events, DEFAULT_FILTERS, ctx), facetCounts(s.events, DEFAULT_FILTERS, ctx))).toFixed(2), 'ms');
  console.log('Events filter+facets (all, query):', time(() => {
    const f = { ...DEFAULT_FILTERS, window: 'all' as const, query: 'kiln stop' };
    filterEvents(s.events, f, ctx);
    facetCounts(s.events, f, ctx);
  }).toFixed(2), 'ms');
  console.log('Stage event match all stages:', time(() => MONITORED_STAGES.map((ms) => s.events.filter((e) => eventInMonitoredStage(ms, e)))).toFixed(2), 'ms');
}

describe('perf probe', () => {
  it('measures', () => {
    const s = createSim(undefined, DEFAULT_START);
    measure('at start', s);
    const t0 = s.minute;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: t0 + 25, label: 'x' });
    advance(s, t0 + 1440);
    measure('+24h live', s);
    advance(s, s.minute + 6 * 1440);
    measure('+7d live', s);
  }, 300_000);
});
