/**
 * Equipment-specific KPIs: the selection per stage / asset type follows master prompt §7, every
 * figure comes from the shared model, and parameters the simulation does not have are labelled
 * unavailable (not modelled) with a reason instead of a value.
 */
import { describe, expect, it } from 'vitest';
import { EQUIPMENT } from '../../data/equipment';
import { CONVEYOR_IDS, INSPECTION_STATIONS, M2_PER_TILE, MONITORED_STAGES, PROCESS_MACHINES } from '../../model/plant';
import type { StageId } from '../../model/types';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { conveyorMetrics, internalActivity, lineMetrics, machineMetrics, operationalState, resolvePeriod, stageIO } from '../../sim/metrics';
import { formatClock, formatDuration } from '../../sim/time';
import { factoryOeeKpi, firstPassQualityKpi, goodOutputKpi } from '../../intel/kpis';
import { constraintClaim } from '../../intel/summary';
import { flowStages } from '../flow/derive';
import { NOT_CONFIRMED, NOT_MODELLED, NO_OPERATING_DATA, equipmentKpis, ownStops, stageCountingAssets, stageKpis, vehicleKpis, type EqKpi } from './kpis';
import { assetProfile, monitoredOf } from './profile';

const keys = (ks: EqKpi[]) => ks.map((k) => k.key);

/** The KPI set chosen for each process stage (master §7 table, limited to what the model contains). */
const BY_STAGE: Record<StageId, string[]> = {
  PREP: ['output', 'rate', 'availability', 'stops', 'slip-density'],
  SPRAY: ['output', 'rate', 'availability', 'stops', 'moisture'],
  PRESS: ['rate', 'good', 'rejects', 'stops'],
  DRY: ['output', 'rate', 'availability', 'stops', 'conditions'],
  GLAZE: ['rate', 'output', 'rejects', 'stops'],
  DECOR: ['rate', 'output', 'rejects', 'stops'],
  KILN: ['rate', 'availability', 'stops', 'output', 'profile'],
  SORT: ['inspected', 'rejected', 'fpq', 'inspection-rate'],
  PACK: ['output', 'rate', 'backlog', 'stops'],
  PAL: ['output', 'rate', 'backlog', 'stops'],
};

describe('equipment KPI selection', () => {
  const s = createSim(11, 3 * 1440 + 9 * 60);
  const p = resolvePeriod('shift', s.minute);

  it('picks the stage-specific set for every process machine', () => {
    for (const id of PROCESS_MACHINES) {
      const prof = assetProfile(id);
      expect(prof.kind, id).toBe('machine');
      expect(keys(equipmentKpis(s, id, p).kpis), id).toEqual(BY_STAGE[prof.stage!]);
    }
  });

  it('gives conveyors, buffers, stations, raw materials and logistics their own sets', () => {
    for (const id of CONVEYOR_IDS) expect(keys(equipmentKpis(s, id, p).kpis), id).toEqual(['availability', 'utilisation', 'stops', 'moved']);
    for (const id of ['C-SLIP', 'D-SILO', 'F-BUF', 'I-BUF']) expect(keys(equipmentKpis(s, id, p).kpis), id).toEqual(['level', 'inflow', 'outflow', 'cover']);
    expect(keys(equipmentKpis(s, 'I-GAUGE', p).kpis)).toEqual(['inspected', 'rejected', 'reject-rate', 'top-defect']);
    expect(keys(equipmentKpis(s, 'I-VIS', p).kpis)).toEqual(['inspected', 'rejected', 'reject-rate', 'top-defect']);
    expect(keys(equipmentKpis(s, 'I-QC', p).kpis)).toEqual(['samples', 'last', 'counts']);
    for (const id of ['B-RCV', 'B-BAYS', 'B-LOAD', 'B-FEED', 'B-SILO']) expect(keys(equipmentKpis(s, id, p).kpis), id).toEqual(['deliveries', 'feed-rate', 'stock', 'incoming-quality']);
    expect(keys(equipmentKpis(s, 'A-GATE', p).kpis)).toEqual(['on-site', 'gate-in', 'gate-out', 'dwell']);
    expect(keys(equipmentKpis(s, 'A-HOLD', p).kpis)).toEqual(['waiting', 'delayed', 'avg-wait']);
    expect(keys(equipmentKpis(s, 'K-DOCK', p).kpis)).toEqual(['occupied', 'utilisation', 'dock-time', 'dispatched']);
    expect(keys(equipmentKpis(s, 'K-FLT', p).kpis)).toEqual(['on-duty', 'moving', 'utilisation']);
    expect(keys(equipmentKpis(s, 'K-RACK', p).kpis)).toEqual(['stock', 'in', 'out']);
  });

  it('shows three to five figures, or says there is no operating data', () => {
    for (const e of EQUIPMENT) {
      const set = equipmentKpis(s, e.id, p);
      expect(set.scope).toBe(p.label);
      if (set.note) {
        expect(set.note).toBe(NO_OPERATING_DATA);
        expect(set.kpis).toEqual([]);
        expect(['utility', 'support', 'storage']).toContain(assetProfile(e.id).kind);
      } else {
        expect(set.kpis.length, e.id).toBeGreaterThanOrEqual(3);
        expect(set.kpis.length, e.id).toBeLessThanOrEqual(5);
      }
    }
  });

  it('takes every figure from the shared model', () => {
    const mm = machineMetrics(s, 'E-PRS1', p);
    const press = equipmentKpis(s, 'E-PRS1', p).kpis;
    expect(press.find((k) => k.key === 'good')!.value).toBe(Math.round(mm.totals.count - mm.totals.rejects).toLocaleString('en-GB'));
    expect(press.find((k) => k.key === 'rejects')!.value).toBe(Math.round(mm.totals.rejects).toLocaleString('en-GB'));
    expect(press.find((k) => k.key === 'stops')!.value).toBe(formatDuration(ownStops(s, 'E-PRS1', p).minutes));
    // The sorting machine shows THE first-pass quality KPI of the Overview / Quality, not its own version.
    const fpq = firstPassQualityKpi(s, p);
    const tile = equipmentKpis(s, 'I-SORT', p).kpis.find((k) => k.key === 'fpq')!;
    expect(tile.label).toBe(fpq.label);
    expect(tile.value).toBe(fpq.display);
    expect(tile.status).toEqual(fpq.status);
    const cm = conveyorMetrics(s, 'CV-KIN', p);
    expect(equipmentKpis(s, 'CV-KIN', p).kpis[0].value).toBe((cm.availability! * 100).toFixed(1));
    // Stage panel figures are the stage's counting points, in m² with the tile count next to it.
    const io = stageIO(s, 'KILN', p);
    const kiln = stageKpis(s, 'KILN', p).kpis[0];
    expect(kiln.value).toBe(Math.round(io.output! * M2_PER_TILE).toLocaleString('en-GB'));
    expect(kiln.unit).toBe('m²');
    expect(kiln.sub).toContain(`${Math.round(io.output!).toLocaleString('en-GB')} tiles`);
  });

  it('labels parameters the model does not contain as not modelled, with the reason and no value', () => {
    const na = (id: string, key: string) => equipmentKpis(s, id, p).kpis.find((k) => k.key === key)!;
    const expected: [string, string, string][] = [
      ['H-KILN', 'profile', NOT_MODELLED.kilnProfile],
      ['D-TWR', 'moisture', NOT_MODELLED.powderMoisture],
      ['C-BM2', 'slip-density', NOT_MODELLED.slipDensity],
      ['F-DRY', 'conditions', NOT_MODELLED.dryerConditions],
      ['B-FEED', 'feed-rate', NOT_MODELLED.feedRate],
      ['B-BAYS', 'stock', NOT_MODELLED.rawStock],
      ['B-RCV', 'incoming-quality', NOT_MODELLED.incomingQuality],
      ['I-QC', 'counts', NOT_MODELLED.qcCounts],
    ];
    for (const [id, key, reason] of expected) {
      const k = na(id, key);
      expect(k.notModelled, `${id} ${key}`).toBe(true);
      expect(k.unavailable).toBe(reason);
      expect(k.value).toBeUndefined();
      expect(k.unit).toBeUndefined();
    }
    expect(NOT_MODELLED.kilnProfile).toMatch(/without a value/);
    // No tile anywhere carries both a value and an unavailable reason, and no temperature / moisture / pressure value is shown.
    for (const e of EQUIPMENT)
      for (const k of equipmentKpis(s, e.id, p).kpis) {
        expect(k.value != null && k.unavailable != null, `${e.id} ${k.key}`).toBe(false);
        if (k.notModelled) expect(k.unavailable, `${e.id} ${k.key}`).toMatch(/^Not in the model/);
        expect(k.unit ?? '', `${e.id} ${k.key}`).not.toMatch(/°C|bar|Nm³/);
      }
  });

  it('says "no data yet" (not "not modelled") when a modelled figure has no data in the period', () => {
    const fresh = createSim(11, 3 * 1440 + 6 * 60 + 1);
    const q = resolvePeriod('shift', fresh.minute);
    const gauge = equipmentKpis(fresh, 'I-GAUGE', q).kpis.find((k) => k.key === 'reject-rate')!;
    if (gauge.unavailable) expect(gauge.notModelled).toBeFalsy();
    for (const e of EQUIPMENT) for (const k of equipmentKpis(fresh, e.id, q).kpis) if (k.unavailable && !k.notModelled) expect(k.unavailable.length).toBeGreaterThan(10);
  });

  it('shows a stale feed as the last value received', () => {
    const t = createSim(5, 2 * 1440 + 8 * 60);
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'feed' });
    advance(t, t.minute + 10);
    const set = equipmentKpis(t, 'E-PRS2');
    expect(set.staleSince).toBe(t.feeds['E-PRS2'].since);
    expect(set.stale?.label).toBe(`Not confirmed · E-PRS2 data stale since ${formatClock(t.feeds['E-PRS2'].since)}`);
    const rate = set.kpis.find((k) => k.key === 'rate')!;
    expect(rate.status?.label).toMatch(/^Last value/);
    expect(rate.value).toBe(Math.round(t.feeds['E-PRS2'].lastRate ?? 0).toLocaleString('en-GB'));
  });
});

describe('stage panel KPIs (findings #20, #21)', () => {
  /** The Overview test's seeded normal state: production ahead, nothing open, the kiln not held up. */
  const START = 2 * 1440 + 4 * 60 + 20;

  it('shows no amber rate in normal operation: other stages have spare capacity by design (#20)', () => {
    const s = createSim(81, START);
    expect(constraintClaim(s).constraining).toBe(false);
    const p = resolvePeriod('shift', s.minute);
    for (const ms of MONITORED_STAGES) {
      const rate = stageKpis(s, ms.id, p).kpis.find((k) => k.key === 'rate');
      if (!rate) continue;
      expect(rate.status?.tone, ms.id).not.toBe('warning');
      expect(`${rate.sub ?? ''} ${rate.status?.label ?? ''}`, ms.id).not.toMatch(/expected/);
      const io = stageIO(s, ms.id, p);
      if (io.expectedPerHour) expect(rate.sub, ms.id).toMatch(/% of ideal capacity/);
    }
  });

  it('warns on the rate only at the stage the constraint claim names as constraining output (#20)', () => {
    const s = createSim(82, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, START + 25);
    const claim = constraintClaim(s);
    expect(claim.constraining).toBe(true);
    const p = resolvePeriod('shift', s.minute);
    const warned = MONITORED_STAGES.filter((ms) => stageKpis(s, ms.id, p, claim).kpis.find((k) => k.key === 'rate')?.status?.tone === 'warning').map((ms) => ms.id);
    expect(warned).toEqual([claim.stage]);
    expect(stageKpis(s, claim.stage, p, claim).kpis.find((k) => k.key === 'rate')!.status!.label).toBe('Constraining output');
  });

  it('reports sorting at the flow strip boundary: good output in m² with the rejected tiles as a subline (#21)', () => {
    const s = createSim(81, START);
    const p = resolvePeriod('shift', s.minute);
    const strip = flowStages(s, p);
    const lm = lineMetrics(s, p);
    const sort = stageKpis(s, 'SORT', p).kpis[0];
    expect(sort.label).toBe('Good output');
    expect(sort.unit).toBe('m²');
    expect(sort.value).toBe(Math.round(strip.find((x) => x.id === 'SORT')!.output!).toLocaleString('en-GB'));
    expect(sort.sub).toBe(`${Math.round(lm.output).toLocaleString('en-GB')} tiles accepted · rejected ${Math.round(lm.rejected).toLocaleString('en-GB')} tiles`);
    // Every tile stage shows the strip's m² figure; slip and powder are tile-equivalents, never "tiles".
    for (const st of strip) {
      const out = stageKpis(s, st.id, p).kpis[0];
      expect(out.value, st.id).toBe(Math.round(st.output!).toLocaleString('en-GB'));
      expect(out.unit, st.id).toBe(st.unit === 'pallets' ? 'pallets' : st.tileEquivalent ? 'm² eq.' : 'm²');
      if (st.tileEquivalent) expect(out.sub, st.id).toMatch(/ tile-eq\.$/);
    }
  });
});

describe('equipment rate tile: the stage panel rule (finding #20)', () => {
  const START = 2 * 1440 + 4 * 60 + 20;
  const rateOf = (s: ReturnType<typeof createSim>, id: string) => equipmentKpis(s, id).kpis.find((k) => k.key === 'rate');

  it('shows a machine below its ideal rate neutrally in normal operation, the kiln included', () => {
    const s = createSim(81, START);
    expect(constraintClaim(s).constraining).toBe(false);
    let below = 0;
    for (const id of PROCESS_MACHINES) {
      const rate = rateOf(s, id);
      if (!rate) continue; // sorting shows its inspection rate instead
      const op = operationalState(s, id);
      if (op === 'stopped' || op === 'fault' || op === 'reduced') continue;
      expect(rate.status?.tone, `${id} ${op} ${rate.status?.label}`).not.toBe('warning');
      if (op === 'running' && /% of ideal$/.test(rate.status?.label ?? '')) {
        below++;
        expect(rate.status!.tone, id).toBe('neutral');
        expect(rate.status!.label, id).toMatch(/^\d+ % of ideal$/);
      }
    }
    // The probe of the finding: most machines run below their ideal rate here, paced by the line.
    expect(below).toBeGreaterThan(3);
    // The kiln's workspace and its stage panel agree: neither is amber.
    expect(rateOf(s, 'H-KILN')!.status?.tone).not.toBe('warning');
    expect(stageKpis(s, 'KILN').kpis.find((k) => k.key === 'rate')!.status?.tone).not.toBe('warning');
  });

  it('warns only for the constraining stage, an asset below its own set rate, or a stop', () => {
    // Kiln stopped: the claim names the kiln; its tile is critical, no other machine is amber unless below its own rate.
    const s = createSim(82, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, START + 25);
    const claim = constraintClaim(s);
    expect(claim.constraining).toBe(true);
    expect(rateOf(s, 'H-KILN')!.status).toEqual({ tone: 'critical', label: 'Stopped' });
    for (const id of PROCESS_MACHINES) {
      const op = operationalState(s, id);
      if (op === 'reduced' || assetProfile(id).monitored === claim.stage) continue;
      expect(rateOf(s, id)?.status?.tone ?? 'none', `${id} ${op}`).not.toBe('warning');
    }

    // A packer slowed below its own set rate: a warning in words, with the share of ideal.
    const r = createSim(81, START);
    activateScenario(r, { kind: 'reduced-rate', equipmentId: 'J-BOX', factor: 0.6, end: null, label: 'slow' });
    advance(r, START + 5);
    expect(operationalState(r, 'J-BOX')).toBe('reduced');
    expect(rateOf(r, 'J-BOX')!.status).toMatchObject({ tone: 'warning', label: expect.stringMatching(/^Running below rate · \d+ % of ideal$/) });

    // The kiln slowed: the claim says it is constraining output, and the kiln's tile says so too.
    const k = createSim(81, START);
    activateScenario(k, { kind: 'reduced-rate', equipmentId: 'H-KILN', factor: 0.6, end: null, label: 'slow kiln' });
    advance(k, START + 5);
    const kc = constraintClaim(k);
    expect(kc.kind).toBe('kiln-slow');
    expect(rateOf(k, 'H-KILN')!.status).toMatchObject({ tone: 'warning', label: expect.stringMatching(/^Constraining output · \d+ % of ideal$/) });
    expect(stageKpis(k, 'KILN', undefined, kc).kpis.find((x) => x.key === 'rate')!.status).toEqual({ tone: 'warning', label: 'Constraining output' });
  });
});

describe('stale counting feeds: running figures, marked not confirmed (finding #21, decision 1)', () => {
  const START = 2 * 1440 + 4 * 60 + 20;
  const lose = (seed: number, id: string, min: number) => {
    const s = createSim(seed, START);
    activateScenario(s, { kind: 'signal-loss', equipmentId: id, end: null, label: 'feed lost' });
    advance(s, START + min);
    expect(s.feeds[id].status).toBe('stale');
    return s;
  };
  const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');
  const tile = (ks: EqKpi[], key: string) => ks.find((k) => k.key === key)!;

  it('kiln feed lost: the stage panel shows the running count, the same as the flow strip, marked like the OEE card', () => {
    const s = lose(81, 'H-KILN', 30);
    const p = resolvePeriod('shift', s.minute);
    const since = s.feeds['H-KILN'].since;
    const set = stageKpis(s, 'KILN', p);
    expect(set.staleSince).toBe(since);
    expect(set.stale!.assetIds).toEqual(['H-KILN']);
    expect(set.stale!.label).toBe(`Not confirmed · kiln data stale since ${formatClock(since)}`);
    // The KPI card says the same.
    expect(factoryOeeKpi(s, p).status?.label).toBe(set.stale!.label);
    // Running accounting (tiles fired after the freeze included): the same figure as the flow strip.
    const io = stageIO(s, 'KILN', p);
    const strip = flowStages(s, p).find((x) => x.id === 'KILN')!;
    expect(s.machines['H-KILN'].countTotal).toBeGreaterThan(s.feeds['H-KILN'].lastCount ?? 0);
    expect(tile(set.kpis, 'output').value).toBe(fmt(io.output! * M2_PER_TILE));
    expect(tile(set.kpis, 'output').value).toBe(fmt(strip.output!));
    expect(strip.stale?.label).toBe(set.stale!.label);
    for (const key of ['output', 'rate', 'lost']) expect(tile(set.kpis, key).status, key).toEqual(NOT_CONFIRMED);
    expect(tile(set.kpis, 'wip').status ?? null).not.toEqual(NOT_CONFIRMED);
    // The kiln's own workspace: the same mark; the rate is the frozen last value (a raw signal).
    const eq = equipmentKpis(s, 'H-KILN', p);
    expect(eq.stale!.label).toBe(set.stale!.label);
    expect(tile(eq.kpis, 'rate').value).toBe(fmt(s.feeds['H-KILN'].lastRate ?? 0));
    expect(tile(eq.kpis, 'rate').status?.label).toBe(`Last value · ${formatClock(since)}`);
    expect(tile(eq.kpis, 'output').value).toBe(fmt(machineMetrics(s, 'H-KILN', p).totals.count));
    expect(tile(eq.kpis, 'output').status).toEqual(NOT_CONFIRMED);
    // Other stages are not marked.
    expect(stageKpis(s, 'PRESS', p).stale).toBeNull();
  });

  it('press feed lost: the press stage is marked, the running output includes the lost press', () => {
    const s = lose(81, 'E-PRS1', 60);
    const p = resolvePeriod('shift', s.minute);
    const set = stageKpis(s, 'PRESS', p);
    expect(set.stale!.label).toBe(`Not confirmed · E-PRS1 data stale since ${formatClock(s.feeds['E-PRS1'].since)}`);
    const io = stageIO(s, 'PRESS', p);
    const strip = flowStages(s, p).find((x) => x.id === 'PRESS')!;
    expect(tile(set.kpis, 'output').value).toBe(fmt(io.output! * M2_PER_TILE));
    expect(tile(set.kpis, 'output').value).toBe(fmt(strip.output!));
    expect(strip.stale?.label).toBe(set.stale!.label);
    expect(tile(set.kpis, 'output').status).toEqual(NOT_CONFIRMED);
    // The lost press's workspace is marked; a fresh press beside it is not.
    expect(equipmentKpis(s, 'E-PRS1', p).stale!.assetIds).toEqual(['E-PRS1']);
    expect(equipmentKpis(s, 'E-PRS2', p).stale).toBeNull();
    // The silo feeding the presses: the drawing rate includes E-PRS1's last value received, not its live rate.
    const silo = equipmentKpis(s, 'D-SILO', p);
    const out = tile(silo.kpis, 'outflow');
    expect(out.status?.label).toBe('Incl. last value of E-PRS1');
    expect(out.value).toBe(fmt((s.feeds['E-PRS1'].lastRate ?? 0) + s.machines['E-PRS2'].ratePerHour + s.machines['E-PRS3'].ratePerHour));
    expect(silo.stale!.assetIds).toEqual(['E-PRS1']);
  });

  it('sorting feed lost: good output equals the Good output KPI card and the flow strip, with the card mark', () => {
    const s = lose(81, 'I-SORT', 60);
    const p = resolvePeriod('shift', s.minute);
    const set = stageKpis(s, 'SORT', p);
    const card = goodOutputKpi(s, p);
    expect(card.provenance).toBe('stale');
    expect(set.stale!.label).toBe(card.status!.label);
    const out = tile(set.kpis, 'output');
    expect(out.value).toBe(card.display);
    expect(out.value).toBe(fmt(lineMetrics(s, p).outputM2));
    expect(out.value).toBe(fmt(flowStages(s, p).find((x) => x.id === 'SORT')!.output!));
    expect(out.status).toEqual(NOT_CONFIRMED);
    // The sorting machine and the inspection stations on the sorting line carry the same mark.
    for (const id of ['I-SORT', 'I-GAUGE', 'I-VIS']) {
      const eq = equipmentKpis(s, id, p);
      expect(eq.stale?.label, id).toBe(card.status!.label);
      expect(tile(eq.kpis, 'inspected').status, id).toEqual(NOT_CONFIRMED);
    }
    // The first-pass quality tile keeps the shared KPI's own not-confirmed status.
    expect(tile(equipmentKpis(s, 'I-SORT', p).kpis, 'fpq').status).toEqual(firstPassQualityKpi(s, p).status);
    expect(equipmentKpis(s, 'I-QC', p).stale).toBeNull();
  });

  it('names the counting assets of every stage, and leaves fresh stages unmarked', () => {
    expect(stageCountingAssets('GLAZE')).toEqual(['G-LINE', 'G-INK']);
    expect(stageCountingAssets('PACK')).toEqual(['J-BOX', 'J-PAL']);
    expect(stageCountingAssets('WH')).toEqual(['J-PAL']);
    const s = createSim(81, START);
    for (const ms of MONITORED_STAGES) {
      const set = stageKpis(s, ms.id);
      expect(set.stale, ms.id).toBeNull();
      expect(set.staleSince ?? null, ms.id).toBeNull();
    }
  });
});

describe('vehicle KPIs', () => {
  const s = createSim(7, 2 * 1440 + 400);

  it('reports stationary time at the current stop, never zone residency, and labels positions simulated', () => {
    const internal = s.logistics.active.map((id) => s.logistics.vehicles[id]).filter((v) => v.class === 'internal');
    expect(internal.length).toBeGreaterThan(0);
    for (const v of internal) {
      const set = vehicleKpis(s, v.id);
      expect(keys(set.kpis)).toEqual(['location', 'movement', 'task', 'utilisation']);
      expect(set.kpis[0].sub).toBe('simulated · zone level');
      const act = internalActivity(v, s.minute);
      const mv = set.kpis[1];
      if (act.moving) expect(mv.value).toBe('Moving');
      else expect(mv.value).toBe(formatDuration(act.stationaryMin));
      for (const k of set.kpis) expect(`${k.label} ${k.value ?? ''}`).not.toMatch(/dwell/i);
    }
  });

  it('gives trucks their visit phase and durations', () => {
    const truck = s.logistics.active.map((id) => s.logistics.vehicles[id]).find((v) => v.class === 'external');
    if (!truck) return;
    expect(keys(vehicleKpis(s, truck.id).kpis)).toEqual(['location', 'phase', 'waiting', 'dock', 'on-site']);
  });
});

describe('asset profile', () => {
  it('maps every asset to its production stage', () => {
    expect(monitoredOf('E-PRS2')).toBe('PRESS');
    expect(monitoredOf('G-INK')).toBe('GLAZE');
    expect(monitoredOf('J-PAL')).toBe('PACK');
    expect(monitoredOf('D-SILO')).toBe('PRESS');
    expect(monitoredOf('C-SLIP')).toBe('SPRAY');
    expect(monitoredOf('I-VIS')).toBe('SORT');
    expect(monitoredOf('K-FLT')).toBe('WH');
    expect(monitoredOf('CV-KIN')).toBe('KILN');
    expect(monitoredOf('A-PARK')).toBeNull();
    for (const ms of MONITORED_STAGES) for (const id of ms.equipment) expect(monitoredOf(id)).toBe(ms.id);
    for (const st of INSPECTION_STATIONS) expect(assetProfile(st.equipmentId).kind).toBe('station');
    expect(assetProfile('H-KILN').conditionMonitored).toBe(true);
    expect(assetProfile('CV-SORT').conditionMonitored).toBe(false);
  });
});
