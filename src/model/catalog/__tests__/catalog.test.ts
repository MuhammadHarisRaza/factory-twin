import { describe, expect, it } from 'vitest';
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../../../data/equipment';
import { HEALTH_ASSETS } from '../../../sim/health';
import { BUFFERS, BUFFER_LEVEL_SIGNAL, CONVEYORS, HOSTED_BUFFER_LEVELS, SIGNALS } from '../../plant';
import {
  CATALOG,
  CATALOG_BY_ID,
  CATEGORY_ORDER,
  CONDITION_LIMITS,
  ENERGY_SIGNAL_NAMES,
  PLACEHOLDER_SIGNAL_NAMES,
  PROCESS_SIGNALS,
  STAGE9_EQUIPMENT_ID,
  STAGES_12,
  STAGE_BY_NO,
  SUPPORT_EQUIPMENT,
  catalogFor,
  catalogForStage,
  coverage,
  definitionOf,
  isSimulated,
  stageOfBuffer,
  stageOfEquipment,
  type ProductionStageNo,
  type SignalCategory,
} from '..';

const STAGE_NOS = Array.from({ length: 12 }, (_, i) => (i + 1) as ProductionStageNo);
const occurrences = (id: string) => CATALOG.filter((d) => d.signalId === id).length;

describe('12-stage registry', () => {
  it('has the twelve stages in order with stable ids', () => {
    expect(STAGES_12.map((s) => s.no)).toEqual(STAGE_NOS);
    expect(STAGES_12.map((s) => s.id)).toEqual(STAGE_NOS.map((n) => `S${String(n).padStart(2, '0')}`));
    for (const n of STAGE_NOS) expect(STAGE_BY_NO[n].no).toBe(n);
  });

  it('references only existing equipment and buffers, each in one place', () => {
    const placed = [...STAGES_12.flatMap((s) => s.equipment), ...SUPPORT_EQUIPMENT];
    for (const id of placed) expect(EQUIPMENT_BY_ID[id], id).toBeDefined();
    expect(new Set(placed).size).toBe(placed.length);
    // Every 3D asset is either in a stage or a site utility / support asset.
    expect(new Set(placed)).toEqual(new Set(EQUIPMENT.map((e) => e.id)));
    const bufferIds = new Set(BUFFERS.map((b) => b.id));
    const buffers = STAGES_12.flatMap((s) => s.buffers);
    for (const id of buffers) expect(bufferIds.has(id), id).toBe(true);
    expect(new Set(buffers).size).toBe(buffers.length);
  });

  it('flags stage 8 as partial and stage 9 as absent, with notes', () => {
    expect(STAGE_BY_NO[8].present).toBe('partial');
    expect(STAGE_BY_NO[8].buffers).toContain('BUF-KOUT');
    expect(STAGE_BY_NO[8].note).toMatch(/cooling buffer/i);
    expect(STAGE_BY_NO[9].present).toBe('no');
    expect(STAGE_BY_NO[9].equipment).toEqual([]);
    expect(STAGE_BY_NO[9].note).toMatch(/flagged for configuration/);
    for (const s of STAGES_12.filter((x) => x.no !== 8 && x.no !== 9)) expect(s.present, s.id).toBe('yes');
  });

  it('maps equipment and buffers to their stage', () => {
    expect(stageOfEquipment('C-BM2')).toBe(1);
    expect(stageOfEquipment('D-SILO')).toBe(2);
    expect(stageOfEquipment('G-INK')).toBe(6);
    expect(stageOfEquipment('H-KILN')).toBe(7);
    expect(stageOfEquipment('CV-SORT')).toBe(8);
    expect(stageOfEquipment('I-SORT')).toBe(10);
    expect(stageOfEquipment('A-GATE')).toBe(12);
    expect(stageOfEquipment('A-COMP')).toBeNull();
    expect(stageOfEquipment('NOPE')).toBeNull();
    expect(stageOfBuffer('BUF-KOUT')).toBe(8);
    expect(stageOfBuffer('BUF-SILO')).toBe(2);
  });
});

describe('signal catalogue', () => {
  it('contains every registry and process signal exactly once', () => {
    for (const s of SIGNALS) expect(occurrences(s.id), s.id).toBe(1);
    for (const p of PROCESS_SIGNALS) expect(occurrences(p.id), p.id).toBe(1);
  });

  it('has unique, well-formed ids', () => {
    const ids = CATALOG.map((d) => d.signalId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of CATALOG) {
      expect(d.signalId, d.signalId).toMatch(/^[A-Z0-9-]+\.[a-z][a-z0-9_]*$/);
      expect(d.signalId.startsWith(`${d.equipmentId}.`), d.signalId).toBe(true);
    }
    expect(Object.keys(CATALOG_BY_ID)).toHaveLength(CATALOG.length);
  });

  it('never claims a connection or invents a tag', () => {
    for (const d of CATALOG) {
      expect(d.availabilityStatus, d.signalId).not.toBe('connected');
      expect(d.sourceTag, d.signalId).toBeNull();
    }
  });

  it('references only existing equipment (stage 9 uses its pseudo id)', () => {
    for (const d of CATALOG) if (d.equipmentId !== STAGE9_EQUIPMENT_ID) expect(EQUIPMENT_BY_ID[d.equipmentId], d.signalId).toBeDefined();
  });

  it('gives every entry its equipment stage', () => {
    for (const d of CATALOG) expect(d.stage, d.signalId).toBe(d.equipmentId === STAGE9_EQUIPMENT_ID ? 9 : stageOfEquipment(d.equipmentId));
  });

  it('documents every stage with at least eight entries', () => {
    for (const n of STAGE_NOS) expect(catalogForStage(n).length, `stage ${n}`).toBeGreaterThanOrEqual(8);
  });

  it('pairs every controlled process value with an existing setpoint', () => {
    const pvs = PROCESS_SIGNALS.filter((p) => p.role === 'pv' && p.category === 'process');
    expect(pvs.length).toBeGreaterThan(0);
    for (const p of pvs) {
      const d = CATALOG_BY_ID[p.id];
      expect(d.setpointSignalId, p.id).toBe(p.pairId);
      const sp = CATALOG_BY_ID[d.setpointSignalId!];
      expect(sp, p.id).toBeDefined();
      expect(sp.category).toBe('setpoint');
      expect(sp.equipmentId).toBe(d.equipmentId);
    }
    for (const d of CATALOG) if (d.setpointSignalId) expect(CATALOG_BY_ID[d.setpointSignalId], d.signalId).toBeDefined();
  });

  it('keeps limits ordered and inside the engineering range', () => {
    for (const d of CATALOG) {
      const { alarmLow: aL, warningLow: wL, warningHigh: wH, alarmHigh: aH, engineeringMin: eMin, engineeringMax: eMax } = d;
      if (aL != null && wL != null) expect(aL, d.signalId).toBeLessThanOrEqual(wL);
      if (wL != null && wH != null) expect(wL, d.signalId).toBeLessThan(wH);
      if (wH != null && aH != null) expect(wH, d.signalId).toBeLessThanOrEqual(aH);
      if (aL != null && aH != null) expect(aL, d.signalId).toBeLessThan(aH);
      if (eMin != null && eMax != null) expect(eMin, d.signalId).toBeLessThan(eMax);
      for (const v of [aL, wL, wH, aH]) {
        if (v == null) continue;
        if (eMin != null) expect(v, d.signalId).toBeGreaterThanOrEqual(eMin);
        if (eMax != null) expect(v, d.signalId).toBeLessThanOrEqual(eMax);
      }
    }
  });

  it('labels the update interval and status honestly', () => {
    for (const d of CATALOG) {
      if (d.availabilityStatus !== 'simulated') {
        expect(d.expectedUpdateIntervalS, d.signalId).toBeNull();
        expect(d.statusNote, d.signalId).toBeTruthy();
      } else expect([60, null], d.signalId).toContain(d.expectedUpdateIntervalS);
      if (d.dataType === 'enum') expect(d.enumValues?.length, d.signalId).toBeGreaterThan(0);
    }
    for (const s of SIGNALS.filter((x) => x.kind === 'event')) expect(CATALOG_BY_ID[s.id].expectedUpdateIntervalS, s.id).toBeNull();
    for (const s of SIGNALS.filter((x) => x.kind === 'counter' && isSimulated(x.id))) {
      const d = CATALOG_BY_ID[s.id];
      expect(d.dataType, s.id).toBe('integer');
      expect(d.counter, s.id).toEqual(expect.objectContaining({ rolloverAt: null }));
    }
    // A counter the demo does not produce has no simulated reset behaviour.
    for (const d of CATALOG.filter((x) => x.counter && x.availabilityStatus !== 'simulated')) expect(d.counter!.resetOn, d.signalId).not.toMatch(/simulation/i);
  });

  it('lists the old placeholder analogs as not modelled and energy as unavailable', () => {
    for (const s of SIGNALS.filter((x) => PLACEHOLDER_SIGNAL_NAMES.includes(x.name))) {
      const d = CATALOG_BY_ID[s.id];
      expect(d.availabilityStatus, s.id).toBe('not-modelled');
      expect(d.expectedUpdateIntervalS).toBeNull();
    }
    const firing = definitionOf('H-KILN.temp_firing');
    if (firing) expect(firing.statusNote).toMatch(/H-KILN\.zone\d_temp_pv/);
    for (const s of SIGNALS.filter((x) => ENERGY_SIGNAL_NAMES.includes(x.name))) {
      const d = CATALOG_BY_ID[s.id];
      expect(d.availabilityStatus, s.id).toBe('unavailable');
      expect(d.statusNote).toMatch(/Energy metering is not part of this demo's data/);
    }
  });

  it('simulates the registry and process signals that have a model', () => {
    for (const p of PROCESS_SIGNALS) expect(isSimulated(p.id), p.id).toBe(true);
    for (const id of ['H-KILN.state', 'H-KILN.count_total', 'D-SILO.level', 'CV-SORT.run_state', 'I-VIS.count_rejected', 'K-FLT.vehicle_zone'])
      if (SIGNALS.some((s) => s.id === id)) expect(isSimulated(id), id).toBe(true);
    expect(definitionOf('I-VIS.count_rejected')?.sourceSystem).toBe('vision');
    expect(definitionOf('I-QC.sample_result')?.sourceSystem).toBe('QMS');
    expect(definitionOf('K-FLT.vehicle_zone')?.statusNote).toMatch(/not GPS/);
    expect(definitionOf('nope.signal')).toBeNull();
    expect(isSimulated('nope.signal')).toBe(false);
  });

  it('mirrors the condition limits of the simulated health model', () => {
    for (const a of HEALTH_ASSETS) {
      const l = CONDITION_LIMITS[a.id];
      expect(l, a.id).toBeDefined();
      expect({ component: l.component, temp: l.temp, vib: l.vib, currentRated: l.currentRated }).toEqual({
        component: a.component,
        temp: a.temp,
        vib: a.vib,
        currentRated: a.currentRated,
      });
      const vib = definitionOf(`${a.id}.vibration`);
      if (vib) {
        expect(vib.alarmHigh).toBe(a.vib.alarm);
        expect(vib.warningHigh).toBeLessThan(a.vib.alarm);
        expect(vib.metadata?.tripLimit).toBe(a.vib.trip);
      }
      const temp = definitionOf(`${a.id}.temperature`);
      if (temp) expect(temp.alarmHigh).toBe(a.temp.alarm);
    }
    expect(Object.keys(CONDITION_LIMITS).sort()).toEqual(HEALTH_ASSETS.map((a) => a.id).sort());
  });

  it('does not treat silo level as mass', () => {
    const mass = definitionOf('D-SILO.powder_mass');
    expect(mass?.availabilityStatus).toBe('unavailable');
    expect(mass?.unit).toBe('t');
    expect(mass?.statusNote).toMatch(/calibration or load cells/);
  });

  it('never states slip or powder flows in tiles per hour', () => {
    for (const no of [1, 2] as const)
      for (const d of catalogForStage(no)) {
        expect(d.unit, d.signalId).not.toBe('tiles/h');
        expect(d.unit, d.signalId).not.toBe('tiles');
      }
    expect(definitionOf('D-TWR.powder_flow')?.unit).toBe('t/h');
  });

  it('keeps stage 9 unavailable until it is mapped to a machine', () => {
    const s9 = catalogForStage(9);
    expect(s9.length).toBeGreaterThanOrEqual(8);
    for (const d of s9) {
      expect(d.equipmentId).toBe(STAGE9_EQUIPMENT_ID);
      expect(d.availabilityStatus, d.signalId).toBe('unavailable');
      expect(d.statusNote).toMatch(/No polishing \/ rectification equipment in this representative line — map to a machine to enable/);
    }
  });

  it('simulates the cooling-buffer occupancy at stage 8 (kiln outfeed, on the sorting-line conveyor)', () => {
    const d = definitionOf('CV-SORT.outfeed_buffer_level');
    expect(d).toMatchObject({ availabilityStatus: 'simulated', stage: 8, unit: '%', availabilityClass: 'core', category: 'material', expectedUpdateIntervalS: 60 });
    expect(d?.name).toBe('Kiln outfeed storage occupancy');
    expect(d?.description).toMatch(/cooling buffer/);
    expect(d?.statusNote).toMatch(/BUF-KOUT/);
    expect(d?.metadata?.bufferId).toBe('BUF-KOUT');
    expect(BUFFER_LEVEL_SIGNAL['BUF-KOUT']).toBe('CV-SORT.outfeed_buffer_level');
  });

  it('gives every buffer a simulated level signal, on the conveyor that holds it when it has no equipment', () => {
    for (const b of BUFFERS) {
      const id = BUFFER_LEVEL_SIGNAL[b.id];
      expect(id, b.id).toBeDefined();
      const level = definitionOf(id)!;
      expect(level.availabilityStatus, b.id).toBe('simulated');
      expect(level.unit, b.id).toBe('%');
      expect(level.stage, b.id).toBe(stageOfBuffer(b.id));
      expect(SIGNALS.find((s) => s.id === id)?.metrics, b.id).toEqual(['buffer-level']);
      if (b.equipmentId) {
        expect(id, b.id).toBe(`${b.equipmentId}.level`);
        continue;
      }
      // Hosted on its conveyor with the documented id, name, description and class (now simulated).
      const host = CONVEYORS.find((c) => c.bufferId === b.id);
      expect(level.equipmentId, b.id).toBe(host?.id);
      expect(HOSTED_BUFFER_LEVELS.find((h) => h.bufferId === b.id)?.equipmentId, b.id).toBe(host?.id);
      expect(level.statusNote, b.id).toContain(b.id);
      expect(level.availabilityClass, b.id).toBe('core');
      expect(level.metadata?.bufferId, b.id).toBe(b.id);
    }
  });

  it('only refers to signal ids that exist', () => {
    const ref = /\b[A-Z]{1,2}-[A-Z0-9]+\.[a-z][a-z0-9_]*\b/g;
    for (const d of CATALOG)
      for (const m of `${d.description} ${d.statusNote ?? ''}`.match(ref) ?? []) expect(CATALOG_BY_ID[m], `${d.signalId} → ${m}`).toBeDefined();
  });

  it('never names the real plant', () => {
    const texts = [
      ...CATALOG.flatMap((d) => [d.name, d.description, d.statusNote ?? '', d.counter?.resetOn ?? '']),
      ...STAGES_12.flatMap((s) => [s.name, s.purpose, s.note]),
    ];
    for (const t of texts) expect(t).not.toMatch(/ghani/i);
  });
});

describe('catalogue lookups', () => {
  it('treats inherited object keys as unknown ids', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(definitionOf(k), k).toBeNull();
      expect(isSimulated(k), k).toBe(false);
      expect(stageOfEquipment(k), k).toBeNull();
      expect(stageOfBuffer(k), k).toBeNull();
    }
  });

  it('orders an equipment item by category with each setpoint after its process value', () => {
    for (const id of ['H-KILN', 'D-TWR', 'E-PRS2', 'C-BM1', 'I-SORT', 'S09']) {
      const list = catalogFor(id);
      expect(list.length, id).toBeGreaterThan(0);
      const group = (c: SignalCategory) => CATEGORY_ORDER.indexOf(c === 'setpoint' ? 'process' : c);
      for (let i = 1; i < list.length; i++) expect(group(list[i].category), `${id} ${list[i].signalId}`).toBeGreaterThanOrEqual(group(list[i - 1].category));
      list.forEach((d, i) => {
        if (d.setpointSignalId) expect(list[i + 1]?.signalId, d.signalId).toBe(d.setpointSignalId);
      });
      expect(new Set(list.map((d) => d.signalId)).size).toBe(list.length);
    }
    expect(catalogFor('H-KILN')[0].signalId).toBe('H-KILN.state');
    expect(catalogFor('A-PARK')).toEqual([]);
  });

  it('lists a stage by its equipment and covers the whole catalogue', () => {
    const kiln = catalogForStage(7);
    expect(kiln.every((d) => d.stage === 7)).toBe(true);
    const lastKiln = kiln.map((d) => d.equipmentId).lastIndexOf('H-KILN');
    expect(kiln.findIndex((d) => d.equipmentId === 'CV-KIN')).toBeGreaterThan(lastKiln);
    const staged = STAGE_NOS.reduce((n, no) => n + catalogForStage(no).length, 0);
    expect(staged + CATALOG.filter((d) => d.stage == null).length).toBe(CATALOG.length);
  });

  it('counts coverage by class and status consistently', () => {
    const c = coverage();
    expect(c).toBe(coverage());
    expect(c.total.total).toBe(CATALOG.length);
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    expect(sum(c.total.byClass)).toBe(CATALOG.length);
    expect(sum(c.total.byStatus)).toBe(CATALOG.length);
    expect(Object.values(c.total.matrix).reduce((n, r) => n + sum(r), 0)).toBe(CATALOG.length);
    expect(c.total.byStatus.connected).toBe(0);
    expect(c.stages.map((s) => s.no)).toEqual(STAGE_NOS);
    for (const s of c.stages) expect(s.total, s.id).toBe(catalogForStage(s.no).length);
    expect(c.stages.reduce((n, s) => n + s.total, 0) + c.support.total).toBe(CATALOG.length);
    expect(c.equipment.reduce((n, e) => n + e.total, 0)).toBe(CATALOG.length);
    const s9 = c.stages.find((s) => s.no === 9)!;
    expect(s9.byStatus.unavailable).toBe(s9.total);
    expect(c.equipment.find((e) => e.equipmentId === 'A-PARK')?.total).toBe(0);
    expect(c.equipment.find((e) => e.equipmentId === 'H-KILN')?.byStatus.simulated).toBeGreaterThan(10);
  });
});
