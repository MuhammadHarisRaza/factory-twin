/**
 * Reliability rules (src/intel/rules/defs/reliability.ts) on one pre-rolled simulation: in normal operation nothing is
 * repeated, too long, commanded without feedback or above its drive limits, and a recurring fault reason fires only where
 * the stop records of the MTBF model show it; fixture stop records for the long-stop percentile baseline ('statistical')
 * and for recurring reasons, fixture sources for the drive current and an unusable vibration signal; a 'data-quality'
 * command without running feedback fires RL-COMMAND-FEEDBACK and resolves when cleared; a 'degradation' fires RL-DRIVE
 * without any failure probability; repeated 'machine-stop' scenarios fire RL-REPEAT-STOPS and RL-RECURRING-FAULT, and an
 * open one RL-LONG-STOP.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { HEALTH_ASSETS } from '../../../sim/health';
import { REASON_BY_CODE } from '../../../model/plant';
import type { TelemetrySample, TelemetrySource } from '../../../model/telemetry';
import type { ScenarioActivation } from '../../../model/types';
import { activateScenario, advance, clearScenario, createSim, type SimState } from '../../../sim/engine';
import { simulatedSource } from '../../../sim/telemetry';
import {
  ALL_EQUIPMENT,
  CHART,
  RELIABILITY_RULES,
  RULE_BY_ID,
  buildContext,
  evaluate,
  findingsFor,
  plantFindings,
  rulesFor,
  type FindingsOptions,
  type RuleContext,
  type RuleFinding,
  type RuleStop,
} from '..';

const START = 2 * 1440 + 240;
const s = createSim(41, START);

const reliability = (equipmentId: string, opts?: FindingsOptions) => findingsFor(s, { kind: 'equipment', equipmentId }, opts).filter((f) => f.family === 'reliability');
const finding = (ruleId: string, equipmentId: string, subject?: string, opts?: FindingsOptions): RuleFinding => {
  const f = reliability(equipmentId, opts).find((x) => x.ruleId === ruleId && (subject === undefined || x.subject === subject));
  if (!f) throw new Error(`no ${ruleId} finding for ${equipmentId} ${subject ?? ''}`);
  return f;
};
const measurement = (f: RuleFinding, label: string) => f.measurements.find((m) => m.label === label);

/** A stop record as the rule context returns it. */
const stop = (equipmentId: string, code: string, start: number, end: number | null): RuleStop => ({
  start,
  end,
  equipmentId,
  reasonCode: code,
  reasonLabel: REASON_BY_CODE[code].label,
  planned: false,
  downtimeId: `FX-${equipmentId}-${start}`,
  kind: 'down',
  category: REASON_BY_CODE[code].category,
  source: 'simulation',
});

/** The context of the current state with its stop records replaced by fixtures. */
function withStops(stops: RuleStop[]): RuleContext {
  const ctx = buildContext(s);
  return { ...ctx, stops: (id, w) => stops.filter((x) => x.equipmentId === id && x.start < w.to && (x.end ?? Infinity) > w.from) };
}
const run = (ruleId: string, ctx: RuleContext, equipmentId: string) => evaluate([RULE_BY_ID[ruleId]], ctx, { kind: 'equipment', equipmentId });

/** The simulated source with some current readings and one signal's recent samples replaced. */
function fixtureSource(reads: Record<string, Partial<TelemetrySample>>, series?: { signalId: string; from: number; value: number }): TelemetrySource<SimState> {
  return {
    kind: 'simulated',
    read: (st, id) => (reads[id] ? { ...simulatedSource.read(st, id), ...reads[id] } : simulatedSource.read(st, id)),
    series: (st, id, w) => {
      const x = simulatedSource.series(st, id, w);
      return series && id === series.signalId && x ? { ...x, v: x.v.map((v, i) => (x.t[i] >= series.from ? series.value : v)) } : x;
    },
    states: simulatedSource.states,
  };
}

describe('normal simulation', () => {
  it('registers the reliability rules and applies each only where its signals exist', () => {
    expect(RELIABILITY_RULES.map((d) => d.id)).toEqual(['RL-REPEAT-STOPS', 'RL-RECURRING-FAULT', 'RL-LONG-STOP', 'RL-COMMAND-FEEDBACK', 'RL-DRIVE']);
    for (const d of RELIABILITY_RULES) {
      expect(RULE_BY_ID[d.id]).toBe(d);
      expect(d.family).toBe('reliability');
      expect(d.classification).toBe('rule-based');
    }
    expect(rulesFor({ kind: 'equipment', equipmentId: 'E-PRS2' }, RELIABILITY_RULES).map((d) => d.id)).toEqual(RELIABILITY_RULES.map((d) => d.id));
    const drive = ALL_EQUIPMENT.filter((id) => RULE_BY_ID['RL-DRIVE'].appliesTo({ kind: 'equipment', equipmentId: id }, null));
    expect(drive.sort()).toEqual(HEALTH_ASSETS.map((a) => a.id).sort());
    // Conveyors have stop records but no run command signal in the catalogue.
    expect(rulesFor({ kind: 'equipment', equipmentId: 'CV-SORT' }, RELIABILITY_RULES).map((d) => d.id)).toEqual(['RL-REPEAT-STOPS', 'RL-RECURRING-FAULT', 'RL-LONG-STOP']);
  });

  it('plant-wide: nothing repeated, too long, without feedback or above drive limits; recurring reasons only where the stop records show them', () => {
    const all = plantFindings(s).findings.filter((f) => f.family === 'reliability');
    expect(all.length).toBeGreaterThan(70);
    expect(all.filter((f) => f.status === 'insufficient-data')).toEqual([]);
    for (const f of all.filter((x) => x.status === 'fired')) {
      expect(f.ruleId, f.key).toBe('RL-RECURRING-FAULT');
      expect(f.provenance.scenarioId, f.key).toBeUndefined();
      const id = f.scope.kind === 'equipment' ? f.scope.equipmentId : '';
      const records = s.downtime.filter((d) => d.equipmentId === id && d.reasonCode === f.subject && d.start >= s.minute - 1440 && d.start < s.minute);
      expect(records.length, f.key).toBeGreaterThanOrEqual(3);
      expect(f.explanation).toMatch(new RegExp(`stopped ${id} ${records.length} times in the last 24 h`));
    }
  });

  it('fewer stops than the threshold is "not repeated" (clear), never insufficient data', () => {
    const f = finding('RL-REPEAT-STOPS', 'E-PRS2');
    expect(f.status).toBe('clear');
    expect(f.explanation).toMatch(/of E-PRS2 in the last 4 h \(\d\d:\d\d–\d\d:\d\d\) — below the repeat threshold of 3: not repeated\./);
    expect(f.missingSignals).toEqual([]);
    expect(f.chartRef).toBe(CHART.states);
    expect(finding('RL-COMMAND-FEEDBACK', 'E-PRS2').explanation).toBe('E-PRS2.run_command On and E-PRS2.state reports Running — running feedback present.');
    expect(finding('RL-DRIVE', 'H-KILN').explanation).toMatch(/^H-KILN\.vibration \d\.\d mm\/s \(warning 3\.6 mm\/s, alarm 4\.5 mm\/s\) and H-KILN\.motor_current \d+ A \(rated 60 A\) — within limits while running/);
  });

  it('a lost feed: the stop records are not trusted, so the rules are not evaluated (insufficient-data naming the state signal)', () => {
    const source = fixtureSource({ 'E-PRS2.state': { quality: 'stale', timestamp: s.minute - 15, note: 'Feed stale' } });
    for (const rule of ['RL-REPEAT-STOPS', 'RL-RECURRING-FAULT', 'RL-LONG-STOP', 'RL-COMMAND-FEEDBACK']) {
      const f = finding(rule, 'E-PRS2', undefined, { source });
      expect(f.status, rule).toBe('insufficient-data');
      expect(f.staleSignals.map((x) => x.signalId), rule).toEqual(['E-PRS2.state']);
    }
  });
});

describe('fixtures', () => {
  const now = () => s.minute;
  const earlier = (code: string, durations: number[]) => durations.map((d, i) => stop('E-PRS1', code, now() - (i + 1) * 1200, now() - (i + 1) * 1200 + d));

  it('RL-LONG-STOP: a stop longer than the 90th percentile of its reason (≥ 5 earlier stops) is statistical; beyond the limit, rule-based', () => {
    const base = earlier('MECH_HYD', [10, 12, 14, 16, 18, 20]);
    const [stat] = run('RL-LONG-STOP', withStops([...base, stop('E-PRS1', 'MECH_HYD', now() - 30, null)]), 'E-PRS1');
    expect(stat.status).toBe('fired');
    expect(stat.classification).toBe('statistical');
    expect(stat.severity).toBe('warning');
    expect(stat.firstSeen).toBe(now() - 30);
    expect(stat.title).toBe('Hydraulic press 1: stop 30 min — longer than usual for this reason');
    expect(stat.explanation).toMatch(
      /^E-PRS1 has been stopped for 30 min \(since \d\d:\d\d; Hydraulic pressure fault, MECH_HYD\) — longer than 90 % of its 6 earlier Hydraulic pressure fault stops over the last 7 days \(90th percentile 19 min, median 15 min, longest 20 min\)\. The configured limit is 1 h\./,
    );
    expect(stat.explanation).toMatch(/not a forecast of how long it will last/);
    expect(stat.confidence).toBe('low');
    expect(stat.confidenceNote).toMatch(/Empirical 90th percentile of 6 earlier stops/);
    expect(measurement(stat, '90th percentile of their durations')).toMatchObject({ value: 19, unit: 'min' });

    const [limit] = run('RL-LONG-STOP', withStops([...base, stop('E-PRS1', 'MECH_HYD', now() - 70, null)]), 'E-PRS1');
    expect(limit.status).toBe('fired');
    expect(limit.classification).toBe('rule-based');
    expect(limit.explanation).toMatch(/— longer than the configured limit of 1 h; its 6 earlier Hydraulic pressure fault stops over the last 7 days lasted 10–20 min \(median 15 min, 90th percentile 19 min\)\./);

    const [usual] = run('RL-LONG-STOP', withStops([...base, stop('E-PRS1', 'MECH_HYD', now() - 12, null)]), 'E-PRS1');
    expect(usual.status).toBe('clear');
    expect(usual.explanation).toMatch(/: within the configured limit of 1 h and the 90th percentile of 19 min of its 6 earlier Hydraulic pressure fault stops\.$/);
  });

  it('RL-LONG-STOP: no percentile from fewer than 5 stops, none below the minimum duration, and an ended long stop is resolved', () => {
    const [few] = run('RL-LONG-STOP', withStops([...earlier('MECH_DIE', [5, 6, 7]), stop('E-PRS1', 'MECH_DIE', now() - 40, null)]), 'E-PRS1');
    expect(few.status).toBe('clear');
    expect(few.explanation).toMatch(/no percentile baseline \(3 earlier Die \/ punch damage stops over the last 7 days; the percentile check needs 5\)/);
    const [short] = run('RL-LONG-STOP', withStops([...earlier('MECH_DIE', [5, 6, 7, 8, 9, 10]), stop('E-PRS1', 'MECH_DIE', now() - 12, null)]), 'E-PRS1');
    expect(short.status).toBe('clear');
    expect(short.explanation).toMatch(/Above the 90th percentile \(10 min\), but the percentile check starts at 15 min\./);
    const [ended] = run('RL-LONG-STOP', withStops([stop('E-PRS1', 'MECH_HYD', now() - 95, now() - 20)]), 'E-PRS1');
    expect(ended.status).toBe('clear');
    expect(ended.resolvedAt).toBe(now() - 20);
    expect(ended.explanation).toMatch(/The last long stop \(Hydraulic pressure fault, 1 h 15 min from \d\d:\d\d\) ended at \d\d:\d\d — longer than the configured limit of 1 h\./);
  });

  it('RL-RECURRING-FAULT: one finding per reason that recurs; planned stops and changeovers never count', () => {
    const stops = [
      ...[60, 300, 700, 1100].map((ago) => stop('E-PRS1', 'ELEC_SENSOR', now() - ago, now() - ago + 6)),
      ...[200, 900].map((ago) => stop('E-PRS1', 'MECH_DIE', now() - ago, now() - ago + 10)),
      ...[100, 400, 800].map((ago) => ({ ...stop('E-PRS1', 'PLN_CLEAN', now() - ago, now() - ago + 20), planned: true, kind: 'planned' as const })),
    ];
    const out = run('RL-RECURRING-FAULT', withStops(stops), 'E-PRS1');
    expect(out.map((f) => [f.status, f.subject])).toEqual([['fired', 'ELEC_SENSOR']]);
    const f = out[0];
    expect(f.key).toBe('RL-RECURRING-FAULT|eq:E-PRS1|ELEC_SENSOR');
    expect(f.severity).toBe('warning');
    expect(f.firstSeen).toBe(now() - 1100);
    expect(f.explanation).toMatch(/^Sensor fault \(ELEC_SENSOR\) stopped E-PRS1 4 times in the last 24 h \(.+\), 24 min in total — at .+\. Threshold: the same reason 3 times in 24 h\. Other unplanned stops in the window: Die \/ punch damage ×2\.$/);
    expect(f.next).toMatch(/^Check the device behind 'sensor fault' on E-PRS1 — the sensor \/ drive, its wiring and connectors/);
    // The same records are 6 unplanned stops in 24 h but not 3 in the last 4 h: not repeated.
    const [rep] = run('RL-REPEAT-STOPS', withStops(stops), 'E-PRS1');
    expect(rep.status).toBe('clear');
  });

  it('RL-DRIVE: motor current above the catalogue rating fires; an unusable vibration signal is named, not guessed', () => {
    const now0 = s.minute;
    const hot = fixtureSource({}, { signalId: 'H-KILN.motor_current', from: now0 - 15, value: 70 });
    const cur = finding('RL-DRIVE', 'H-KILN', undefined, { source: hot });
    expect(cur.status).toBe('fired');
    expect(cur.severity).toBe('warning');
    expect(cur.title).toBe('Single-layer roller kiln: motor current above rated');
    expect(cur.explanation).toMatch(/^H-KILN\.motor_current has been above the rated current of 60 A for 15 min \(since \d\d:\d\d\) while running: now 70 A \(117 % of rated\), up to 70 A\./);
    expect(cur.explanation).toMatch(/no failure probability and no time to failure is estimated/);
    expect(cur.next).toMatch(/current above rated at normal output can come from mechanical drag or from the supply/);
    expect(cur.chartRef).toBe(CHART.process('H-KILN.motor_current'));
    expect(cur.firstSeen).toBe(now0 - 15);

    const badVib = finding('RL-DRIVE', 'H-KILN', undefined, { source: fixtureSource({ 'H-KILN.vibration': { quality: 'bad', note: 'Sensor fault' } }) });
    expect(badVib.status).toBe('clear');
    expect(badVib.confidence).toBe('medium');
    expect(badVib.missingSignals.map((m) => m.signalId)).toEqual(['H-KILN.vibration']);
    expect(badVib.explanation).toMatch(/Not evaluated: H-KILN\.vibration \(Vibration\): bad quality flag — Sensor fault\./);
    const both = finding('RL-DRIVE', 'H-KILN', undefined, {
      source: fixtureSource({ 'H-KILN.vibration': { quality: 'bad' }, 'H-KILN.motor_current': { quality: 'missing', value: null, timestamp: null } }),
    });
    expect(both.status).toBe('insufficient-data');
    expect(both.missingSignals.map((m) => m.signalId).sort()).toEqual(['H-KILN.motor_current', 'H-KILN.vibration']);
  });
});

describe('scenarios', () => {
  let t0 = 0;
  let noFeedback: ScenarioActivation;
  let degradation: ScenarioActivation;
  beforeAll(() => {
    t0 = s.minute;
    noFeedback = activateScenario(s, { kind: 'data-quality', mode: 'command-no-feedback', equipmentId: 'C-BM1', end: null, label: 'Mill 1 start without feedback' });
    degradation = activateScenario(s, { kind: 'degradation', equipmentId: 'H-KILN', end: null, label: 'Kiln roller drive wear' });
    advance(s, t0 + 60);
  });

  it("'data-quality' command-no-feedback: RL-COMMAND-FEEDBACK fires on that machine only", () => {
    const f = finding('RL-COMMAND-FEEDBACK', 'C-BM1');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('warning');
    expect(f.firstSeen).toBe(t0);
    expect(f.lastSeen).toBe(s.minute);
    expect(f.title).toBe('Continuous ball mill 1: run command on, no running feedback');
    expect(f.explanation).toMatch(
      /^C-BM1\.run_command has been On for 1 h 00 min \(since \d\d:\d\d\) while C-BM1\.state reports Stopped \(Run command without running feedback \(scenario\)\) — a commanded start without running feedback\. In a normal stop the run command drops; here the command stays on/,
    );
    expect(measurement(f, 'Command on without running feedback')).toMatchObject({ value: 60, unit: 'min' });
    expect(f.next).toMatch(/running-feedback contact .* at its PLC input, and the interlock chain/);
    expect(f.provenance.scenarioId).toBe(noFeedback.id);
    const fired = plantFindings(s).findings.filter((x) => x.ruleId === 'RL-COMMAND-FEEDBACK' && x.status === 'fired');
    expect(fired.map((x) => x.key)).toEqual(['RL-COMMAND-FEEDBACK|eq:C-BM1']);
  });

  it("'degradation': RL-DRIVE fires on the vibration above its warning (serious above the alarm level), without restating the condition alert", () => {
    const f = finding('RL-DRIVE', 'H-KILN');
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('serious');
    expect(f.title).toBe('Single-layer roller kiln: vibration above its alarm level');
    expect(f.explanation).toMatch(
      /^H-KILN\.vibration has been above its warning level of 3\.6 mm\/s for \d+ min \(since \d\d:\d\d\) while running: now \d\.\d mm\/s, up to \d\.\d mm\/s; alarm level 4\.5 mm\/s — above it for \d+ min/,
    );
    expect(f.explanation).toMatch(/A threshold check on the signals only — no failure probability and no time to failure is estimated\./);
    expect(f.explanation).not.toMatch(/trip limit|Projected|probability of|will fail|×.*expected/);
    expect(f.firstSeen!).toBeGreaterThan(t0);
    expect(measurement(f, 'Rated current')?.value).toBe(60);
    expect(f.next).toMatch(/^Check the drive train of H-KILN \(roller drive gearmotor · firing zone\) at the next opportunity/);
    expect(f.provenance.scenarioId).toBe(degradation.id);
    const cond = f.evidence.find((e) => e.kind === 'event');
    if (cond) expect(f.explanation).toContain(`The condition event ${cond.ref} (R-COND) carries the load-corrected assessment.`);
  });

  it('a cleared command fault is reported as recently resolved', () => {
    const t1 = s.minute;
    clearScenario(s, noFeedback.id);
    clearScenario(s, degradation.id);
    advance(s, t1 + 5);
    const f = finding('RL-COMMAND-FEEDBACK', 'C-BM1');
    expect(f.status).toBe('clear');
    expect(f.resolvedAt).toBe(t1);
    expect(f.explanation).toMatch(/^C-BM1\.run_command On and C-BM1\.state reports Running — running feedback present\. The command was on without running feedback from \d\d:\d\d to \d\d:\d\d \(\d+ min\)\./);
  });

  describe("repeated and long 'machine-stop'", () => {
    let t2 = 0;
    let long: ScenarioActivation;
    beforeAll(() => {
      t2 = s.minute;
      for (const k of [5, 25, 45]) activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS2', start: t2 + k, end: t2 + k + 8, label: `Press 2 stop ${k}` });
      long = activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS3', end: null, label: 'Press 3 breakdown' });
      advance(s, t2 + 75);
    });

    it('three unplanned stops in 4 h fire RL-REPEAT-STOPS, and the same reason three times fires RL-RECURRING-FAULT', () => {
      const rep = finding('RL-REPEAT-STOPS', 'E-PRS2');
      expect(rep.status).toBe('fired');
      expect(rep.severity).toBe('warning');
      expect(rep.firstSeen).toBe(t2 + 5);
      expect(rep.title).toBe('Hydraulic press 2: 3 unplanned stops in 4 h');
      expect(rep.explanation).toMatch(
        /^E-PRS2 stopped 3 times unplanned in the last 4 h \(\d\d:\d\d–\d\d:\d\d\): Simulated breakdown \(scenario\) ×3 \(24 min\); 24 min of unplanned downtime in the window\. Threshold: 3 stops in 4 h\./,
      );
      expect(rep.next).toMatch(/^Review the 3 stops of E-PRS2 together in the event log .*; compare with E-PRS1 and E-PRS3 over the same window\.$/);
      expect(rep.evidence.filter((e) => e.kind === 'event').length).toBeGreaterThan(0);
      expect(rep.provenance.source).toBe('simulated');

      const rec = finding('RL-RECURRING-FAULT', 'E-PRS2', 'SCN_STOP');
      expect(rec.status).toBe('fired');
      expect(rec.explanation).toMatch(/^Simulated breakdown \(scenario\) \(SCN_STOP\) stopped E-PRS2 3 times in the last 24 h/);
      expect(rec.next).toMatch(/a simulated scenario input/);

      // A per-equipment threshold override: 4 stops needed on E-PRS2.
      expect(finding('RL-REPEAT-STOPS', 'E-PRS2', undefined, { values: { 'RL-REPEAT-STOPS.minCount@E-PRS2': 4 } }).status).toBe('clear');
    });

    it('an open stop beyond the limit fires RL-LONG-STOP (rule-based); its run command dropped, so no command fault', () => {
      const f = finding('RL-LONG-STOP', 'E-PRS3');
      expect(f.status).toBe('fired');
      expect(f.classification).toBe('rule-based');
      expect(f.severity).toBe('warning');
      expect(f.firstSeen).toBe(t2);
      expect(f.title).toBe('Hydraulic press 3: stop 1 h 15 min — beyond the 1 h limit');
      expect(f.explanation).toMatch(
        /^E-PRS3 has been stopped for 1 h 15 min \(since \d\d:\d\d; Simulated breakdown \(scenario\), SCN_STOP\) — longer than the configured limit of 1 h; no percentile baseline \(0 earlier Simulated breakdown \(scenario\) stops over the last 7 days; the percentile check needs 5\)\./,
      );
      expect(f.next).toMatch(/^Check the repair status of E-PRS3 with maintenance .* on the stop event \(EV-\d+\)\.$/);
      expect(f.provenance.scenarioId).toBe(long.id);
      const cmd = finding('RL-COMMAND-FEEDBACK', 'E-PRS3');
      expect(cmd.status).toBe('clear');
      expect(cmd.explanation).toMatch(/^E-PRS3\.run_command Off while E-PRS3 reports Stopped \(Simulated breakdown \(scenario\)\): a normal stop — the run command dropped\./);
    });
  });
});
