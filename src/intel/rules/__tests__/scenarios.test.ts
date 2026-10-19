/**
 * The rule engine end to end (src/intel/rules) on one pre-rolled simulation — the app's default seed and start (7 days
 * of history, Monday 10:30) — through plantFindings and every registered rule, no fixtures:
 *
 * - Registry: six families, each registered once; unique ids that never reuse an event-engine id; every threshold with
 *   a default.
 * - Normal baseline (no scenario): no serious or critical finding. At 10:30 the shift's planned cleaning of the glaze
 *   line and the printer (10:00–10:25) has drawn the kiln infeed down; the printer restarted and the infeed refills, so
 *   the infeed trend and balance are 'clear' (the trend no longer holds), not "falling — empty in 50 min". Honest
 *   wording, named signals, simulated provenance and units over every finding. Performance on the 7-day state.
 * - The brief's examples, each from its scenario alone, one phase after another on the same simulation: a run command
 *   without running feedback → RL-COMMAND-FEEDBACK (the brief's "R-COMMAND-FEEDBACK"; R-* names the event engine's
 *   rules); the data-quality modes and a feed loss → DQ-*, with the dependent rules not evaluated, naming the signals; a
 *   kiln zone deviation → PC-SETPOINT and the batch association QL-PROCESS-ASSOCIATION (the brief's
 *   "Q-PROCESS-ASSOCIATION"; Q-* is the event engine's); a sorting slowdown → F-DOWNSTREAM-CONSTRAINT; the spray dryer at
 *   reduced rate → the silos drain over the following hours → F-POWDER-STARVATION once the presses run short.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioActivation } from '../../../model/types';
import { activateScenario, advance, clearScenario, createSim, DEFAULT_SEED, type SimState } from '../../../sim/engine';
import { EVENT_RULE_DEFS } from '../../../sim/events';
import { simulatedSource } from '../../../sim/telemetry';
import { DEFAULT_START, formatClock } from '../../../sim/time';
import {
  ALL_EQUIPMENT,
  DATA_RULES,
  FLOW_RULES,
  PROCESS_RULES,
  PRODUCTION_RULES,
  QUALITY_RULES,
  RELIABILITY_RULES,
  RULE_FAMILIES,
  RULE_PARAM_BY_KEY,
  RULE_PARAM_DEFAULTS,
  RULES,
  findingsFor,
  plantFindings,
  type RuleFinding,
  type RuleScope,
} from '..';

const s: SimState = createSim(DEFAULT_SEED);
const eq = (equipmentId: string): RuleScope => ({ kind: 'equipment', equipmentId });
const plant = () => plantFindings(s, { top: 40 });
const byKey = (fs: RuleFinding[], key: string): RuleFinding => {
  const f = fs.find((x) => x.key === key);
  if (!f) throw new Error(`no finding ${key}`);
  return f;
};
const firedKeys = (fs: RuleFinding[], pred: (f: RuleFinding) => boolean = () => true) => fs.filter((f) => f.status === 'fired' && pred(f)).map((f) => f.key).sort();
const measurement = (f: RuleFinding, label: string) => f.measurements.find((m) => m.label === label);
const SERIOUS = (f: RuleFinding) => f.severity === 'serious' || f.severity === 'critical';

/** What a text claims: its words without the honest negations ("no failure probability", "not a forecast"). */
const claims = (text: string) => text.replace(/\b(no|not an?|never an?|without an?y?)\s+(\w+\s+)?(probabilit|predict|forecast|cause)\w*/gi, '');
const DISHONEST = /\bAI\b|machine learning|probabilit|predict|forecast|will fail|\bcaused by\b|root cause|\blive\b/i;

/** Honesty over findings: never AI, no probabilities or predictions, no causal claims; named signals; simulated provenance. */
function expectHonest(fs: RuleFinding[]) {
  for (const f of fs) {
    const text = `${f.title} ${f.explanation} ${f.next ?? ''} ${f.confidenceNote}`;
    expect(claims(text), f.key).not.toMatch(DISHONEST);
    expect(['rule-based', 'statistical'], f.key).toContain(f.classification);
    expect(f.provenance.source, f.key).toBe('simulated');
    expect(f.provenance.note, f.key).toMatch(/^Simulated data — /);
    if (f.status === 'insufficient-data') {
      const named = [...f.missingSignals, ...f.staleSignals];
      expect(named.length, f.key).toBeGreaterThan(0);
      for (const m of named) expect(f.explanation, `${f.key} names ${m.signalId}`).toContain(m.signalId);
      expect(f.lastSeen, f.key).toBeNull();
    }
    if (f.status === 'fired') {
      expect(f.lastSeen, f.key).toBe(s.minute);
      expect(f.firstSeen!, f.key).toBeLessThanOrEqual(s.minute);
    }
    // An association is something to investigate, never a cause.
    if (f.ruleId === 'QL-PROCESS-ASSOCIATION' && f.status === 'fired') expect(f.explanation, f.key).toMatch(/^Association to investigate — not a demonstrated cause/);
  }
}

/**
 * Stage 1–2 (slip, powder): their signals' figures in t/h or tile-equivalents — never tiles — the flows into and out
 * of the slip tanks and powder silos in t/h, and a silo / tank level never turned into a mass or a tile quantity.
 * (A press's own output is tiles: "below 354 tiles/h" for a press is its unit.)
 */
function expectUnits(fs: RuleFinding[]) {
  const stage12 = /^(C-BM\d|C-SLIP|D-HAG|D-TWR|D-CYC|D-SILO|D-BELT)\./;
  for (const f of fs) {
    for (const m of f.measurements) if (m.signalId && stage12.test(m.signalId)) expect(['tiles/h', 'tiles'], `${f.key} · ${m.label}`).not.toContain(m.unit);
    if (f.scope.kind !== 'equipment' || (f.scope.equipmentId !== 'D-SILO' && f.scope.equipmentId !== 'C-SLIP')) continue;
    for (const m of f.measurements) {
      if (m.unit === 't' || m.unit === 'kg' || m.unit === 'tiles' || m.unit === 'tile-eq') expect(m.value, `${f.key} · ${m.label}`).toBeNull();
      if (/^(Inflow|Outflow|Net flow|Deadband)/.test(m.label)) expect(m.unit, `${f.key} · ${m.label}`).toBe('t/h');
    }
    if (f.ruleId === 'F-BALANCE' || f.ruleId === 'F-BUFFER-TREND') expect(`${f.title} ${f.explanation}`, f.key).not.toMatch(/\btiles\/h\b/);
    if (f.family === 'flow' && f.status !== 'insufficient-data') expect(f.explanation, f.key).toMatch(/no level-to-mass calibration configured, so no mass or tile quantity is derived from it/);
  }
}

describe('registry', () => {
  it('registers the six families once, with unique ids that never reuse an event-engine id, and a default for every threshold', () => {
    const families = [PRODUCTION_RULES, FLOW_RULES, PROCESS_RULES, RELIABILITY_RULES, QUALITY_RULES, DATA_RULES];
    expect(RULES).toEqual(families.flat());
    expect(families.map((f) => [...new Set(f.map((d) => d.family))])).toEqual(RULE_FAMILIES.map((f) => [f]));
    const ids = RULES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prefix = { production: /^P-/, flow: /^F-/, process: /^PC-/, reliability: /^RL-/, quality: /^QL-/, data: /^DQ-/ };
    for (const d of RULES) expect(d.id, d.id).toMatch(prefix[d.family]);
    const eventIds = new Set(EVENT_RULE_DEFS.map((d) => d.id));
    for (const id of ids) expect(eventIds.has(id), id).toBe(false);
    for (const d of RULES) {
      expect(['rule-based', 'statistical'], d.id).toContain(d.classification);
      expect(claims(d.description), d.id).not.toMatch(DISHONEST);
      for (const p of d.params) {
        const k = `${d.id}.${p.key}`;
        expect(RULE_PARAM_DEFAULTS[k], k).toBe(p.default);
        expect(RULE_PARAM_BY_KEY[k]?.ruleId, k).toBe(d.id);
      }
    }
    expect(Object.keys(RULE_PARAM_DEFAULTS)).toHaveLength(RULES.reduce((n, d) => n + d.params.length, 0));
  });
});

describe('normal baseline: 7 days, default seed, no scenario', () => {
  it('starts at the default plant time with no scenario', () => {
    expect(s.minute).toBe(DEFAULT_START);
    expect(s.scenarios).toEqual([]);
  });

  it('has no serious or critical finding; what is not evaluated is what the simulation does not model, named once per item', () => {
    const { findings, summary } = plant();
    expect(findings.length).toBeGreaterThan(400);
    expect(firedKeys(findings, SERIOUS)).toEqual([]);
    expect(summary.bySeverity.serious + summary.bySeverity.critical).toBe(0);
    // Only the catalogue's process measurements the simulation does not model are not evaluated.
    const ins = findings.filter((f) => f.status === 'insufficient-data');
    expect(ins.length).toBeGreaterThan(0);
    for (const f of ins) {
      expect(f.key, f.explanation).toMatch(/^PC-MEASUREMENT\|eq:[A-Z0-9-]+\|not-available$/);
      expect(f.missingSignals.every((m) => /^not modelled in this simulation|^unavailable/.test(m.reason)), f.key).toBe(true);
    }
    expectHonest(findings);
    expectUnits(findings);
  });

  it('the kiln infeed drawn down by the planned cleaning of the glaze line and printer is refilling: clear, not "falling"', () => {
    // The baseline event behind it: planned stops of the printer (and the glaze line) that ended minutes ago.
    const planned = (id: string) => s.downtime.filter((d) => d.equipmentId === id && d.reasonCode === 'PLN_CLEAN' && d.end != null && d.end <= s.minute && d.end > s.minute - 30);
    expect(planned('G-INK')).toHaveLength(1);
    expect(planned('G-LINE')).toHaveLength(1);
    const fs = findingsFor(s, eq('CV-KIN'));
    const trend = byKey(fs, 'F-BUFFER-TREND|eq:CV-KIN|BUF-KIN');
    expect(trend.status).toBe('clear');
    expect(trend.title).toBe('Kiln infeed refilling after a fall');
    expect(measurement(trend, 'Level trend')!.value as number).toBeLessThan(-30);
    expect(measurement(trend, 'Level trend (recent)')!.value as number).toBeGreaterThan(15);
    expect(trend.explanation).toMatch(/falling faster than the 30\.0 %\/h threshold over the window \(conveyor accumulation\), but it is rising again: \+[\d.]+ %\/h over the last 5 min \(\d\d:\d\d–\d\d:\d\d\), from its lowest [\d.]+ % at \d\d:\d\d/);
    expect(trend.explanation).toMatch(/The fall no longer holds, so no time to empty is extrapolated from it\. Digital inkjet decoration \(G-INK\), filling it: G-INK running since \d\d:\d\d\./);
    expect(trend.resolvedAt!).toBeGreaterThan(s.minute - 10);
    const balance = byKey(fs, 'F-BALANCE|eq:CV-KIN|BUF-KIN');
    expect(balance.status).toBe('clear');
    expect(balance.title).toBe('Kiln infeed: inflow recovered');
    expect(measurement(balance, 'Inflow (recent)')!.value as number).toBeGreaterThan(measurement(balance, 'Outflow (recent)')!.value as number);
    // The kiln was not starved.
    expect(byKey(findingsFor(s, eq('H-KILN')), 'F-STARVE|eq:H-KILN|BUF-KIN').status).toBe('clear');
  });

  it('performance: one equipment item well under 30 ms and the plant well under 400 ms on the 7-day state (loose bounds)', () => {
    plantFindings(s, { values: {} }); // warm-up: JIT, catalogue and rule memos
    const per = ALL_EQUIPMENT.map((id) => {
      const t = performance.now();
      findingsFor(s, eq(id), { values: {} }); // explicit values: not memoised, a fresh context each time
      return performance.now() - t;
    }).sort((a, b) => a - b);
    const plantMs = [0, 1, 2]
      .map(() => {
        const t = performance.now();
        plantFindings(s, { values: {} });
        return performance.now() - t;
      })
      .sort((a, b) => a - b);
    const p90 = per[Math.floor(per.length * 0.9)];
    // Measured ≈ 3–10 ms per item and ≈ 100–150 ms for the plant; the bounds allow for files running in parallel.
    expect(p90, `per-item p90 ${p90.toFixed(1)} ms`).toBeLessThan(150);
    expect(plantMs[1], `plant median ${plantMs[1].toFixed(0)} ms`).toBeLessThan(2000);
    // Repeated renders in the same minute are free (memoised).
    const a = findingsFor(s, eq('H-KILN'));
    expect(findingsFor(s, eq('H-KILN'))).toBe(a);
  });
});

describe("a run command without running feedback → RL-COMMAND-FEEDBACK (the brief's R-COMMAND-FEEDBACK)", () => {
  let t0 = 0;
  let sc: ScenarioActivation;
  beforeAll(() => {
    t0 = s.minute;
    sc = activateScenario(s, { kind: 'data-quality', mode: 'command-no-feedback', equipmentId: 'E-PRS2', end: null, label: 'Press 2 start without feedback' });
    advance(s, t0 + 10);
  });

  it('fires on that press only, from the scenario start, and the other rules read it as a stopped press', () => {
    const { findings, top } = plant();
    expect(firedKeys(findings, (f) => f.ruleId === 'RL-COMMAND-FEEDBACK')).toEqual(['RL-COMMAND-FEEDBACK|eq:E-PRS2']);
    const f = byKey(findings, 'RL-COMMAND-FEEDBACK|eq:E-PRS2');
    expect(f).toMatchObject({ family: 'reliability', classification: 'rule-based', severity: 'warning', firstSeen: t0, lastSeen: s.minute });
    expect(f.title).toBe('Hydraulic press 2: run command on, no running feedback');
    expect(f.explanation).toMatch(/^E-PRS2\.run_command has been On for 10 min \(since \d\d:\d\d\) while E-PRS2\.state reports Stopped/);
    expect(f.provenance.scenarioId).toBe(sc.id);
    expect(top.map((x) => x.key)).toContain(f.key);
    // A press held stopped: no counter fault (not running) and no output verdict guessed from it.
    expect(byKey(findings, 'P-COUNTER|eq:E-PRS2').status).toBe('clear');
    expectHonest(findings);
  });

  it('is reported as resolved once the fault clears', () => {
    clearScenario(s, sc.id);
    advance(s, s.minute + 5);
    const f = byKey(findingsFor(s, eq('E-PRS2')), 'RL-COMMAND-FEEDBACK|eq:E-PRS2');
    expect(f.status).toBe('clear');
    expect(f.resolvedAt).toBe(t0 + 10);
    expect(f.explanation).toMatch(new RegExp(`from ${formatClock(t0)} to ${formatClock(t0 + 10)} \\(10 min\\)`));
  });
});

describe('data-quality modes and a feed loss → DQ-*, with the dependent rules not evaluated', () => {
  const ids: ScenarioActivation[] = [];
  beforeAll(() => {
    const add = (def: Parameters<typeof activateScenario>[1]) => ids.push(activateScenario(s, def));
    add({ kind: 'data-quality', mode: 'bad-quality', equipmentId: 'E-PRS1', end: null, label: 'Press 1 bad quality' });
    add({ kind: 'data-quality', mode: 'frozen', equipmentId: 'D-TWR', signalId: 'D-TWR.inlet_temp_pv', end: null, label: 'Inlet temperature frozen' });
    add({ kind: 'data-quality', mode: 'counter-reset', equipmentId: 'J-BOX', end: null, label: 'Packing counters reset' });
    add({ kind: 'data-quality', mode: 'spike', equipmentId: 'H-KILN', signalId: 'H-KILN.zone2_temp_pv', end: null, label: 'Zone 2 spikes' });
    add({ kind: 'data-quality', mode: 'gap', equipmentId: 'G-LINE', signalId: 'G-LINE.line_speed', end: null, label: 'Line speed gap' });
    add({ kind: 'signal-loss', equipmentId: 'F-DRY', end: null, label: 'Dryer feed loss' });
    advance(s, s.minute + 12);
  });

  it('fires exactly one data rule per mode, on its asset', () => {
    const { findings } = plant();
    expect(firedKeys(findings, (f) => f.family === 'data')).toEqual(
      ['DQ-BAD-QUALITY|eq:E-PRS1', 'DQ-COUNTER-RESET|eq:J-BOX', 'DQ-FROZEN|eq:D-TWR', 'DQ-GAP|eq:G-LINE', 'DQ-IMPLAUSIBLE|eq:H-KILN', 'DQ-SOURCE|eq:F-DRY'].sort(),
    );
    for (const f of findings.filter((x) => x.family === 'data' && x.status === 'fired')) {
      expect(f.classification).toBe('rule-based');
      expect(f.next, f.key).toBeTruthy();
      expect(f.provenance.scenarioId, f.key).toBeDefined();
    }
    expectHonest(findings);
  });

  it('rules that read a bad, frozen or stale signal are not evaluated and name it; a spiked reading is a measurement problem, not a deviation', () => {
    const { findings } = plant();
    const bad = byKey(findings, 'P-OUTPUT|eq:E-PRS1');
    expect(bad.status).toBe('insufficient-data');
    expect(bad.missingSignals.find((m) => m.signalId === 'E-PRS1.count_total')?.reason).toMatch(/^bad quality flag/);
    const lost = byKey(findings, 'P-OUTPUT|eq:F-DRY');
    expect(lost.status).toBe('insufficient-data');
    expect(lost.staleSignals.map((x) => x.signalId)).toEqual(expect.arrayContaining(['F-DRY.count_total', 'F-DRY.state']));
    expect(lost.next).toMatch(/data feed \(PLC \/ gateway link\) of F-DRY/);
    const frozen = byKey(findings, 'PC-SETPOINT|eq:D-TWR|D-TWR.inlet_temp_pv');
    expect(frozen.status).toBe('insufficient-data');
    expect(frozen.staleSignals.map((x) => x.signalId)).toEqual(['D-TWR.inlet_temp_pv']);
    // The other spray-dryer PV is still evaluated.
    expect(byKey(findings, 'PC-SETPOINT|eq:D-TWR|D-TWR.outlet_temp_pv').status).toBe('clear');
    expect(byKey(findings, 'PC-MEASUREMENT|eq:H-KILN|H-KILN.zone2_temp_pv').status).toBe('fired');
    expect(byKey(findings, 'PC-SETPOINT|eq:H-KILN|H-KILN.zone2_temp_pv').status).toBe('clear');
    // Nothing is guessed: no fired finding on the press with bad data or the dryer with the lost feed, but the data rule.
    expect(firedKeys(findings, (f) => f.scope.kind === 'equipment' && (f.scope.equipmentId === 'E-PRS1' || f.scope.equipmentId === 'F-DRY'))).toEqual([
      'DQ-BAD-QUALITY|eq:E-PRS1',
      'DQ-SOURCE|eq:F-DRY',
    ]);
  });

  it('clears when the faults clear (an ended gap or bad flag stays visible for the window, as information)', () => {
    for (const x of ids) clearScenario(s, x.id);
    advance(s, s.minute + 20);
    const { findings } = plant();
    expect(byKey(findings, 'DQ-SOURCE|eq:F-DRY').status).toBe('clear');
    expect(byKey(findings, 'DQ-FROZEN|eq:D-TWR').status).toBe('clear');
    expect(byKey(findings, 'P-OUTPUT|eq:F-DRY').status).not.toBe('insufficient-data');
    for (const k of ['DQ-BAD-QUALITY|eq:E-PRS1', 'DQ-GAP|eq:G-LINE']) {
      const f = byKey(findings, k);
      expect(f.status, k).toBe('fired');
      expect(f.severity, k).toBe('info');
    }
  });
});

describe("a kiln zone deviation → PC-SETPOINT and the batch association QL-PROCESS-ASSOCIATION (the brief's Q-PROCESS-ASSOCIATION)", () => {
  let t0 = 0;
  let sc: ScenarioActivation;
  const ZONE3 = 'H-KILN.zone3_temp_pv';
  beforeAll(() => {
    t0 = s.minute;
    sc = activateScenario(s, { kind: 'process-deviation', signalId: ZONE3, offset: 35, end: null, label: 'Kiln zone 3 over-firing' });
    advance(s, t0 + 60);
  });

  it('PC-SETPOINT and PC-LIMIT fire serious on zone 3 only, in the plant top list, with the PV, SP and times', () => {
    const { findings, top } = plant();
    const sp = byKey(findings, `PC-SETPOINT|eq:H-KILN|${ZONE3}`);
    expect(sp).toMatchObject({ status: 'fired', severity: 'serious', classification: 'rule-based', firstSeen: t0 });
    expect(sp.explanation).toMatch(/^H-KILN\.zone3_temp_pv has been above its setpoint by more than the warning band for 1 h 00 min \(since \d\d:\d\d\) while H-KILN is in operation: now 1,2\d\d °C against a setpoint of 1,195 °C/);
    expect(sp.explanation).not.toMatch(/restart/);
    expect(sp.provenance.scenarioId).toBe(sc.id);
    expect(byKey(findings, `PC-LIMIT|eq:H-KILN|${ZONE3}`)).toMatchObject({ status: 'fired', severity: 'serious' });
    expect(firedKeys(findings, (f) => f.family === 'process' && f.key.includes('|eq:H-KILN|'))).toEqual([`PC-LIMIT|eq:H-KILN|${ZONE3}`, `PC-SETPOINT|eq:H-KILN|${ZONE3}`]);
    expect(top.map((f) => f.key)).toEqual(expect.arrayContaining([sp.key]));
  });

  it('QL-PROCESS-ASSOCIATION names the batch and the deviation — statistical, an association to investigate, never a cause', () => {
    const { findings } = plant();
    const f = byKey(findings, 'QL-PROCESS-ASSOCIATION|stage:10|H-KILN');
    expect(f).toMatchObject({ status: 'fired', severity: 'warning', classification: 'statistical', confidence: 'medium' });
    expect(f.title).toMatch(/^Association to investigate: batch B-\d{6}-\d+ · H-KILN zone 3 temperature deviation$/);
    expect(f.explanation).toMatch(/^Association to investigate — not a demonstrated cause: the tiles of batch B-\d{6}-\d+ made during the H-KILN zone 3 temperature deviation since \d\d:\d\d \(ongoing\)/);
    expect(f.explanation).toMatch(/z = \d+\.\d — a significant difference/);
    expect(f.explanation).toMatch(/Other conditions that changed at the same time \(batch, recipe, other stages\) can explain the same difference/);
    expect(f.confidenceNote).toMatch(/Correlation in time and batch only/);
    expect(measurement(f, 'Reject rate — made during the deviation')!.value as number).toBeGreaterThan(1.5 * (measurement(f, 'Reject rate — made outside any deviation')!.value as number));
    expectHonest(findings);
  });

  it('PC-SETPOINT reports the deviation as resolved once it clears', () => {
    clearScenario(s, sc.id);
    advance(s, s.minute + 30);
    const f = byKey(findingsFor(s, eq('H-KILN')), `PC-SETPOINT|eq:H-KILN|${ZONE3}`);
    expect(f.status).toBe('clear');
    expect(f.resolvedAt!).toBeGreaterThan(t0 + 55);
    expect(f.explanation).toMatch(/It was beyond the warning band from \d\d:\d\d to \d\d:\d\d/);
  });
});

describe('a sorting slowdown → F-DOWNSTREAM-CONSTRAINT (stage 8: the kiln outfeed)', () => {
  let sc: ScenarioActivation;
  beforeAll(() => {
    sc = activateScenario(s, { kind: 'bottleneck', stage: 'SORT', factor: 0.55, end: null, label: 'Sorting slowdown' });
    advance(s, s.minute + 40);
  });

  it("fires 'Possible downstream constraint at sorting' (serious, in the top list) with the three conditions and the stage-8 mapping", () => {
    const { findings, top } = plant();
    const f = byKey(findings, 'F-DOWNSTREAM-CONSTRAINT|eq:CV-SORT');
    expect(f).toMatchObject({ status: 'fired', severity: 'serious', classification: 'rule-based', title: 'Possible downstream constraint at sorting' });
    expect(measurement(f, 'Sorting rate (recent)')!.value as number).toBeLessThan(measurement(f, 'Sorting below-rate limit')!.value as number);
    expect(measurement(f, 'Kiln outfeed level now')!.value as number).toBeGreaterThanOrEqual(80);
    expect(f.explanation).toMatch(/kiln outfeed roller storage \(BUF-KOUT, read by CV-SORT\.outfeed_buffer_level\)/);
    expect(f.explanation).toMatch(/no polishing \/ rectification stage \(stage 9\)/);
    expect(f.explanation).toMatch(/the sorting line is the likely constraint, to investigate/);
    expect(top.map((x) => x.key)).toContain(f.key);
    expect(byKey(findings, 'F-BLOCK|eq:H-KILN|BUF-KOUT')).toMatchObject({ status: 'fired', severity: 'serious' });
    expectHonest(findings);
  });

  it('clears once sorting draws again — the kiln output shortfall of the hour stays reported by P-OUTPUT', () => {
    clearScenario(s, sc.id);
    advance(s, s.minute + 20);
    const { findings } = plant();
    expect(byKey(findings, 'F-DOWNSTREAM-CONSTRAINT|eq:CV-SORT').status).toBe('clear');
    expect(byKey(findings, 'F-BLOCK|eq:H-KILN|BUF-KOUT').status).toBe('clear');
    expect(byKey(findings, 'P-OUTPUT|eq:H-KILN').status).toBe('fired');
  });
});

describe('the spray dryer at reduced rate → the powder silos drain → F-POWDER-STARVATION', () => {
  const steps: { t: number; level: number | null; chain: RuleFinding; trend: RuleFinding; balance: RuleFinding }[] = [];
  let sc: ScenarioActivation;
  beforeAll(() => {
    sc = activateScenario(s, { kind: 'reduced-rate', equipmentId: 'D-TWR', factor: 0.4, end: null, label: 'Spray dryer at 40 %' });
    // From the scenario alone: the silos drain over the following hours, then the presses run short.
    for (let k = 0; k < 64; k++) {
      advance(s, s.minute + 30);
      const fs = findingsFor(s, eq('D-SILO'));
      const level = simulatedSource.read(s, 'D-SILO.level').value;
      const chain = byKey(fs, 'F-POWDER-STARVATION|eq:D-SILO');
      steps.push({ t: s.minute, level: typeof level === 'number' ? level : null, chain, trend: byKey(fs, 'F-BUFFER-TREND|eq:D-SILO|BUF-SILO'), balance: byKey(fs, 'F-BALANCE|eq:D-SILO|BUF-SILO') });
      if (chain.status === 'fired') break;
    }
  });

  it('first only the balance and the silo trend: the chain needs the presses short of powder too', () => {
    const before = steps.slice(0, -1);
    expect(before.length).toBeGreaterThan(4);
    expect(before.every((x) => x.chain.status === 'clear')).toBe(true);
    const draining = before.find((x) => x.balance.status === 'fired')!;
    expect(draining.balance.title).toMatch(/^Powder silos: inflow below outflow by [\d.]+ t\/h$/);
    expect(draining.chain.explanation).toMatch(/^The chain needs all three in the same window \(\d\d:\d\d–\d\d:\d\d\); only spray dryer output below normal/);
  });

  it("fires 'Potential press starvation' once the silos run low and the presses are short of powder — in the plant top list", () => {
    const last = steps[steps.length - 1];
    expect(last.chain.status).toBe('fired');
    expect(last.level!).toBeLessThanOrEqual(10);
    const { findings, top } = plant();
    const f = byKey(findings, 'F-POWDER-STARVATION|eq:D-SILO');
    expect(f).toMatchObject({ severity: 'warning', classification: 'rule-based', title: 'Potential press starvation' });
    expect(f.explanation).toMatch(/^All three conditions of the powder chain hold in the same window \(\d\d:\d\d–\d\d:\d\d\), together since \d\d:\d\d: \(1\) Spray dryer: D-TWR\.powder_flow averaged [\d.]+ t\/h/);
    expect(f.explanation).toMatch(/\(2\) Powder silos: D-SILO\.level/);
    expect(f.explanation).toMatch(/\(3\) Presses: E-PRS1 short of powder \d+ min/);
    expect(f.explanation).toMatch(/An association in time across the chain — the powder supply is the likely source, to investigate\./);
    // Flows in t/h, the silo in % — no mass or tile quantity from the level (the disclosed kg-per-tile-equivalent factor aside).
    expect(f.explanation).not.toMatch(/\d\s(?:t|kg|tiles|tile-eq)(?![\w/])(?! per)/);
    expect(top.map((x) => x.key)).toContain(f.key);
    expect(firedKeys(findings, (x) => x.ruleId === 'F-STARVE' && /E-PRS\d/.test(x.key)).length).toBeGreaterThan(0);
    expectHonest(findings);
    expectUnits(findings);
    clearScenario(s, sc.id);
  });
});
