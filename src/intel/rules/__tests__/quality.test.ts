/**
 * Quality rules (src/intel/rules/defs/quality.ts) on one pre-rolled simulation: clear and statistical in normal
 * operation; not evaluated with too few inspected tiles or without batch ids; a 'process-deviation' scenario on
 * kiln zone 3 (+35 °C, beyond its ±20 °C alarm band) fires the batch association ("to investigate", never a cause),
 * the reject-rate rise, the kiln-origin defect categories and — over a shorter window — the first-pass-yield decline.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PROCESS_SIGNAL_BY_ID } from '../../../model/catalog';
import type { TelemetrySource } from '../../../model/telemetry';
import type { ScenarioActivation } from '../../../model/types';
import { activateScenario, advance, batchAt, createSim, type SimState } from '../../../sim/engine';
import { simulatedSource } from '../../../sim/telemetry';
import { RULE_BY_ID, buildContext, evaluate, findingsFor, plantFindings, rulesFor, type FindingsOptions, type RuleFinding, type RuleScope } from '..';
import { ASSOCIATION_PVS, QUALITY_RULES } from '../defs/quality';

const START = 2 * 1440 + 240;
const s = createSim(41, START);
const SORTING: RuleScope = { kind: 'stage', stageNo: 10 };
const IDS = ['QL-REJECT-BASELINE', 'QL-FPY-DECLINE', 'QL-DEFECT-CATEGORY', 'QL-PROCESS-ASSOCIATION'];
const ZONE3 = 'H-KILN.zone3_temp_pv';

const quality = (opts?: FindingsOptions, st = s) => findingsFor(st, SORTING, opts).filter((f) => f.family === 'quality');
const finding = (ruleId: string, subject?: string, opts?: FindingsOptions, st = s): RuleFinding => {
  const f = quality(opts, st).find((x) => x.ruleId === ruleId && (subject === undefined || x.subject === subject));
  if (!f) throw new Error(`no ${ruleId}${subject ? ` (${subject})` : ''} finding`);
  return f;
};
const measurement = (f: RuleFinding, label: string) => f.measurements.find((m) => m.label === label);
/** Honest wording: statistical, never AI, no probabilities, no predictions, no causal claims. */
function honest(f: RuleFinding) {
  const text = `${f.title} ${f.explanation} ${f.next ?? ''} ${f.confidenceNote}`;
  expect(text, f.key).not.toMatch(/\bAI\b|machine learning|probabilit|predict|will fail|\bcaused by\b|root cause/i);
}

describe('normal simulation', () => {
  it('evaluates the four quality rules for the sorting & inspection stage — statistical, clear, on simulated data', () => {
    const fs = quality();
    expect(fs.map((f) => f.ruleId).sort()).toEqual([...IDS].sort());
    for (const f of fs) {
      expect(f.status, f.key).toBe('clear');
      expect(f.classification, f.key).toBe('statistical');
      expect(f.scope).toEqual(SORTING);
      expect(f.provenance.source).toBe('simulated');
      expect(f.provenance.note).toMatch(/^Simulated data/);
      expect(f.lastSeen).toBeNull();
      honest(f);
    }
    // Reached from the plant view too (through stage 10), not from an equipment item.
    const plant = plantFindings(s).findings.filter((f) => f.family === 'quality');
    expect(plant.map((f) => f.key).sort()).toEqual(fs.map((f) => f.key).sort());
    expect(rulesFor({ kind: 'plant' }).map((d) => d.id)).toEqual(expect.arrayContaining(IDS));
    expect(rulesFor({ kind: 'equipment', equipmentId: 'I-VIS' }).filter((d) => d.family === 'quality')).toEqual([]);
    expect(QUALITY_RULES.map((d) => d.id)).toEqual(IDS);
    for (const id of IDS) expect(RULE_BY_ID[id].requiredSignals(SORTING, null)).toEqual(['I-VIS.count_inspected', 'I-VIS.count_rejected', 'I-GAUGE.count_rejected']);
  });

  it('states rates, sample sizes, z and the critical value in the clear verdicts', () => {
    const rr = finding('QL-REJECT-BASELINE');
    expect(rr.title).toBe('Reject rate within its baseline');
    expect(rr.explanation).toMatch(
      /^Reject rate \d+\.\d % over the last 60 min \([\d,]+ of [\d,]+ tiles, \d\d:\d\d–\d\d:\d\d\) vs \d+\.\d % in the 24 h to \d\d:\d\d \([\d,]+ of [\d,]+ tiles\): \d+\.\d\d× the baseline, z = −?\d+\.\d — not significant \(reported when significant \(\|z\| ≥ 2\.58\) and at least 1\.35× the baseline\)\.$/,
    );
    expect(measurement(rr, 'Tiles inspected (recent window)')!.value as number).toBeGreaterThan(800);
    expect(measurement(rr, 'Tiles inspected (baseline)')!.value as number).toBeGreaterThan(20000);
    expect(rr.confidenceNote).toMatch(/^Two-proportion z-test on [\d,]+ and [\d,]+ inspected tiles; it assumes independent tiles/);
    const fpy = finding('QL-FPY-DECLINE');
    // Two days of history: the 168 h baseline is shorter, and says so.
    expect(fpy.explanation).toMatch(/^First-pass yield \d+\.\d\d % over the last 8 h 00 min \([\d,]+ of [\d,]+ tiles accepted, \d\d:\d\d–\d\d:\d\d\) vs \d+\.\d\d % in the \d+ h to \d\d:\d\d \(the history starts on \w{3}, \d+ \w{3} \d\d:\d\d; 168 h requested\)/);
    expect(fpy.explanation).toMatch(/[+−]\d+\.\d\d pts, z = −?\d+\.\d/);
    expect(finding('QL-DEFECT-CATEGORY').explanation).toMatch(/^No defect category rises significantly over the last 120 min .* Largest change: [a-z (&)]+ \d+\.\d+ % of inspected tiles vs \d+\.\d+ %, z = −?\d+\.\d\.$/);
    const assoc = finding('QL-PROCESS-ASSOCIATION');
    expect(assoc.title).toBe('No process deviation to associate');
    expect(assoc.explanation).toMatch(new RegExp(`while its machine ran in the last 8 h 00 min \\(\\d\\d:\\d\\d–\\d\\d:\\d\\d; ${ASSOCIATION_PVS.length} of ${ASSOCIATION_PVS.length} process values checked\\)`));
    expect(ASSOCIATION_PVS).toEqual(expect.arrayContaining([ZONE3, 'E-PRS1.press_pressure_pv', 'D-TWR.powder_moisture_pv', 'G-LINE.glaze_density_pv']));
    expect(ASSOCIATION_PVS).not.toContain('E-PRS1.oil_temp'); // no setpoint
  });
});

describe('too few inspections', () => {
  it('is not evaluated below the minimum number of inspected tiles (no baseline in the first hour)', () => {
    const young = createSim(43, 45);
    for (const id of ['QL-REJECT-BASELINE', 'QL-FPY-DECLINE', 'QL-DEFECT-CATEGORY']) {
      const f = finding(id, undefined, undefined, young);
      expect(f.status, id).toBe('insufficient-data');
      expect(f.severity).toBe('info');
      expect(f.confidence).toBe('low');
      expect(f.title).toBe(`${id}: not evaluated`);
      expect(f.explanation).toMatch(/ not evaluated — [\d,]+ tiles inspected in the last \d+ min, 0 in the 0 h to \d\d:\d\d \(the history starts on \w{3}, \d+ \w{3} \d\d:\d\d; \d+ h requested\): needs at least \d+ in each window .* A significance test on fewer tiles would be a guess\.$/);
      expect(f.missingSignals[0]).toMatchObject({ signalId: 'I-VIS.count_inspected' });
      expect(f.firstSeen).toBeNull();
    }
    // No deviation either: the association has nothing to compare (clear, not a guess).
    expect(finding('QL-PROCESS-ASSOCIATION', undefined, undefined, young).status).toBe('clear');
  });

  it('the association is not evaluated when no process value has a usable history (fixture source: every PV sample bad)', () => {
    const pvs = new Set(ASSOCIATION_PVS);
    const source: TelemetrySource<SimState> = {
      kind: 'simulated',
      read: simulatedSource.read,
      series: (st, id, w) => {
        const x = simulatedSource.series(st, id, w);
        return x && pvs.has(id) ? { ...x, v: x.v.map(() => null), q: x.v.map(() => 'bad' as const) } : x;
      },
      states: simulatedSource.states,
    };
    const f = finding('QL-PROCESS-ASSOCIATION', undefined, { source });
    expect(f.status).toBe('insufficient-data');
    expect(f.explanation).toBe('Not evaluated — no process value with a setpoint has a usable history for at least half of the last 8 h 00 min, so deviations cannot be told from missing data.');
    expect(f.missingSignals.map((m) => m.signalId).sort()).toEqual([...ASSOCIATION_PVS].sort());
    expect(f.missingSignals[0].reason).toMatch(/^0 of 480 minutes with a usable value in the last 8 h 00 min$/);
  });
});

describe("'process-deviation': kiln zone 3 beyond its alarm band", () => {
  let t0 = 0;
  let sc: ScenarioActivation;
  beforeAll(() => {
    t0 = s.minute;
    sc = activateScenario(s, { kind: 'process-deviation', signalId: ZONE3, offset: 35, end: null, label: 'Kiln zone 3 over-firing' });
    advance(s, t0 + 60);
  });

  it('fires the batch association — statistical, "to investigate", never a cause — naming batch, episode and rates', () => {
    const spec = PROCESS_SIGNAL_BY_ID[ZONE3];
    expect(35).toBeGreaterThan(spec.alarmHigh! - spec.nominal!);
    const f = finding('QL-PROCESS-ASSOCIATION', 'H-KILN');
    // The batch the inspection records of those minutes carry (the simulation tags them batchAt(t − 180)).
    const batch = batchAt(s, t0 + 30 - 180).id;
    expect(f.status).toBe('fired');
    expect(f.classification).toBe('statistical');
    expect(f.severity).toBe('warning');
    expect(f.confidence).toBe('medium');
    expect(f.key).toBe('QL-PROCESS-ASSOCIATION|stage:10|H-KILN');
    expect(f.title).toBe(`Association to investigate: batch ${batch} · H-KILN zone 3 temperature deviation`);
    expect(f.explanation).toMatch(
      new RegExp(
        `^Association to investigate — not a demonstrated cause: the tiles of batch ${batch} made during the H-KILN zone 3 temperature deviation since \\d\\d:\\d\\d \\(ongoing\\) \\(up to \\+3\\d °C from its setpoint of 1,195 °C, beyond its ±10 °C warning band\\) have a reject rate of \\d+\\.\\d % vs \\d\\.\\d % for the tiles made outside it: \\d\\.\\d×, z = \\d+\\.\\d — a significant difference`,
      ),
    );
    expect(f.explanation).toMatch(/Defects that originate at firing \(chip & edge damage and planarity deviation\): \d+\.\d+ % of the tiles made during the deviation vs \d\.\d+ %/);
    expect(f.explanation).toMatch(/Batch attribution from the batch ids on the inspection records; tiles matched by the minute they passed sorting \(this simulation models no transit or residence time/);
    expect(f.explanation).toMatch(/can explain the same difference/);
    expect(f.explanation).toMatch(/A simulated scenario acts on H-KILN in this window: Kiln zone 3 over-firing \(/);
    honest(f);
    expect(f.confidenceNote).toMatch(/Correlation in time and batch only/);
    const z = measurement(f, 'z (two-proportion test)')!.value as number;
    expect(z).toBeGreaterThan(2.58);
    const during = measurement(f, 'Reject rate — made during the deviation')!.value as number;
    const outside = measurement(f, 'Reject rate — made outside any deviation')!.value as number;
    expect(during).toBeGreaterThan(1.5 * outside);
    expect(measurement(f, 'Tiles inspected — made during the deviation')!.value as number).toBeGreaterThan(800);
    expect(measurement(f, 'Largest deviation from the setpoint')).toMatchObject({ signalId: ZONE3, unit: '°C' });
    expect(f.firstSeen).toBe(t0);
    expect(f.lastSeen).toBe(s.minute);
    expect(f.next).toMatch(new RegExp(`^Hold the pallets of batch ${batch} for a quality review .* check the zone 3 temperature control of H-KILN`));
    expect(f.evidence.map((e) => e.ref)).toEqual(expect.arrayContaining([ZONE3, 'H-KILN.zone3_temp_sp', `chart:process:${ZONE3}`]));
    expect(f.provenance.signals).toEqual(expect.arrayContaining([ZONE3, 'H-KILN.zone3_temp_sp', 'I-VIS.count_inspected']));
    // One finding for the kiln; only the deviating zone is named (the other zones stay inside their bands).
    expect(quality().filter((x) => x.ruleId === 'QL-PROCESS-ASSOCIATION' && x.status === 'fired').map((x) => x.subject)).toEqual(['H-KILN']);
    expect(f.explanation).not.toMatch(/Also outside their warning bands/);
    expect(sc.signalId).toBe(ZONE3);
  });

  it('fires the reject-rate rise against the day before, naming the largest contribution and its origin stage', () => {
    const f = finding('QL-REJECT-BASELINE');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('serious'); // above the Q-RATE limit of 5 %
    expect(f.title).toMatch(/^Reject rate \d+\.\d % — \d\.\d× its baseline$/);
    expect(f.explanation).toMatch(/z = \d+\.\d — a significant rise \(reported when significant \(\|z\| ≥ 2\.58\) and at least 1\.35× the baseline\)\./);
    expect(f.explanation).toMatch(/The largest contribution: (chip & edge damage|planarity deviation) \(originates at firing — H-KILN, stage 7\)/);
    expect(f.next).toMatch(/^Check the (chip & edge damage|planarity deviation) rejects first:/);
    expect(f.firstSeen).toBe(s.minute - 60);
    honest(f);
  });

  it('fires the defect categories that originate at the kiln — and only those', () => {
    const fired = quality().filter((x) => x.ruleId === 'QL-DEFECT-CATEGORY' && x.status === 'fired');
    expect(fired.map((x) => x.subject).sort()).toEqual(['chip', 'planarity']);
    for (const f of fired) {
      expect(f.title).toMatch(/^(Chip & edge damage|Planarity deviation) rising — \d\.\d× · origin firing$/);
      expect(f.explanation).toMatch(/of inspected tiles over the last 120 min \([\d,]+ of [\d,]+ tiles, \d\d:\d\d–\d\d:\d\d\) vs \d\.\d+ % in the 24 h to \d\d:\d\d/);
      expect(f.explanation).toMatch(/originates at firing — H-KILN, stage 7\) by the modelled defect attribution — where it usually starts, not a confirmed cause/);
      expect(measurement(f, 'Ratio to the baseline')!.value as number).toBeGreaterThanOrEqual(2);
      honest(f);
    }
  });

  it('first-pass yield: a sustained decline over a shorter window; over the default shift only when large enough', () => {
    const f = finding('QL-FPY-DECLINE', undefined, { values: { 'QL-FPY-DECLINE.windowMin': 120 } });
    expect(f.status).toBe('fired');
    expect(f.title).toMatch(/^First-pass yield down \d\.\d pts to \d+\.\d %$/);
    expect(f.explanation).toMatch(/^First-pass yield \d+\.\d\d % over the last 2 h 00 min .*: −\d\.\d\d pts, z = −\d+\.\d — a significant decline \(reported when significant \(\|z\| ≥ 2\.58\) and at least 1\.0 pts lower\)/);
    expect(measurement(f, 'Change')!.unit).toBe('percentage points');
    const dflt = finding('QL-FPY-DECLINE');
    expect(dflt.explanation).toMatch(/over the last 8 h 00 min/);
    expect(['fired', 'clear']).toContain(dflt.status);
    if (dflt.status === 'clear') expect(dflt.explanation).toMatch(/significant but less than 1\.0 pts lower/);
  });

  it('is not evaluated with too few tiles made during the deviation, or without batch ids on the inspection records', () => {
    const few = finding('QL-PROCESS-ASSOCIATION', 'H-KILN', { values: { 'QL-PROCESS-ASSOCIATION.minInspected': 20000 } });
    expect(few.status).toBe('insufficient-data');
    expect(few.explanation).toMatch(/^The association not evaluated — [\d,]+ tiles inspected that were made during the H-KILN zone 3 temperature deviation since \d\d:\d\d \(ongoing\) .*; [\d,]+ made outside every deviation in the last 8 h 00 min: needs at least 20000 in each window/);
    expect(few.missingSignals[0].signalId).toBe('I-VIS.count_inspected');
    // A records source without batch ids (fixture context): the deviation cannot be tied to a batch.
    const ctx = { ...buildContext(s), inspections: () => [] };
    const [f] = evaluate([RULE_BY_ID['QL-PROCESS-ASSOCIATION']], ctx, SORTING).filter((x) => x.subject === 'H-KILN');
    expect(f.status).toBe('insufficient-data');
    expect(f.explanation).toMatch(/^Not evaluated — the H-KILN zone 3 temperature deviation since \d\d:\d\d \(ongoing\) .*, but no inspection record in or around those minutes carries a batch id/);
    expect(f.missingSignals[0]).toMatchObject({ name: 'Inspection records (batch ids)' });
    expect(f.next).toMatch(/batch \(lot\) id/);
  });

  it("counting points that are not current make the rules 'insufficient-data' (engine validation), not a guess", () => {
    const t1 = s.minute;
    activateScenario(s, { kind: 'data-quality', mode: 'bad-quality', equipmentId: 'I-VIS', end: null, label: 'Vision tunnel bad quality' });
    advance(s, t1 + 2);
    for (const id of IDS) {
      const f = quality().find((x) => x.ruleId === id)!;
      expect(f.status, id).toBe('insufficient-data');
      expect(f.explanation).toMatch(/^Not evaluated — requires I-VIS\.count_inspected \(.*\): bad quality flag/);
    }
  });
});
