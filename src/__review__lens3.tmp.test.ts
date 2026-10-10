import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from './sim/engine';
import { DEFAULT_START } from './sim/time';
import { buildEventReport } from './intel/report';
import { inspectionRecords } from './report/images';
import { EQUIPMENT_BY_ID } from './data/equipment';
import { CONVEYOR_IDS, DOCKS, GEOFENCES, INSPECTION_STATIONS, MONITORED_STAGES, PROCESS_MACHINES, STAGES } from './model/plant';
import { DEFAULT_FILTERS, PAGE_SIZE, filterEvents } from './pages/events/filters';
import { DEFAULT_FINANCE } from './sim/finance';
import { DEFAULT_TARIFFS } from './sim/energy';
import { HEALTH_ASSETS } from './sim/health';
import { ENERGY_CONSUMERS } from './pages/scenarios/catalogue';

describe('review probe', () => {
  it('ids and paging and clone', () => {
    const s = createSim(20261012, DEFAULT_START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: t0 + 30, label: 'x' });
    activateScenario(s, { kind: 'restricted-entry', vehicleId: 'FL-05', end: null, label: 'y' });
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 6, end: null, label: 'z' });
    advance(s, t0 + 90);
    const missing: string[] = [];
    const ids = [
      ...CONVEYOR_IDS,
      ...PROCESS_MACHINES,
      ...STAGES.map((x) => x.machines[0]),
      ...INSPECTION_STATIONS.map((x) => x.equipmentId),
      ...GEOFENCES.map((g) => g.equipmentId).filter(Boolean),
      ...DOCKS.map((d) => d.equipmentId).filter(Boolean),
      ...HEALTH_ASSETS.map((a) => a.id),
      ...ENERGY_CONSUMERS,
      ...MONITORED_STAGES.flatMap((m) => [...m.equipment, ...m.conveyors]),
      ...s.events.map((e) => e.asset.equipmentId).filter(Boolean),
    ] as string[];
    for (const id of ids) if (!EQUIPMENT_BY_ID[id]) missing.push(id);
    console.log('missing equipment ids', [...new Set(missing)]);

    const ctx = { now: s.minute };
    const d24 = filterEvents(s.events, DEFAULT_FILTERS, ctx);
    const all = filterEvents(s.events, { ...DEFAULT_FILTERS, window: 'all' }, ctx);
    const older = all.findIndex((e) => !d24.includes(e));
    console.log('24h rows', d24.length, 'all rows', all.length, 'first index outside 24h in all', older, 'page', Math.floor(older / PAGE_SIZE), 'PAGE', PAGE_SIZE);

    let cloneFail = 0;
    for (const e of s.events) {
      const r = buildEventReport(s, e.id, { finance: DEFAULT_FINANCE, tariffs: DEFAULT_TARIFFS, generatedAt: 'x' });
      try {
        structuredClone(r);
        structuredClone(inspectionRecords(s, r!.visualEvidence));
      } catch (err) {
        cloneFail++;
        if (cloneFail < 3) console.log('clone fail', e.id, e.type, String(err));
      }
    }
    console.log('clone failures', cloneFail, 'of', s.events.length);

    // Stale selection across reset: session event ids in run A vs fresh run B at the same minute.
    const session = s.events.filter((e) => !e.historical);
    const b = createSim(20261012, DEFAULT_START);
    advance(b, t0 + 90);
    const diff = session
      .map((e) => ({ id: e.id, a: e.title, b: b.events.find((x) => x.id === e.id)?.title ?? '(none)' }))
      .filter((x) => x.a !== x.b);
    console.log('session events', session.length, 'id collisions with different meaning', diff.slice(0, 5));
    // Events never ending (Resolve permanently disabled)
    const neverEnd = s.events.filter((e) => e.end == null && e.status !== 'resolved' && s.minute - e.start > 1440);
    console.log('open conditions older than 24h', neverEnd.map((e) => `${e.id} ${e.type} ${e.title}`).slice(0, 10));
    expect(true).toBe(true);
  });
});
