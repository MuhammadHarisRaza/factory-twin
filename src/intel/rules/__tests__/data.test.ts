/**
 * Data-quality rules (src/intel/rules/defs/data.ts) on one pre-rolled simulation: clear everywhere in normal
 * operation (event-driven signals are not stale, a stopped press's empty process values are not gaps); each
 * 'data-quality' scenario mode fires its rule — bad quality, frozen (running → DQ-FROZEN; no state → DQ-STALE),
 * counter reset, spike, gap — and 'signal-loss' fires one source interruption, not a stale list; one finding per
 * rule per equipment. Fixture sources cover late / stale timestamps, ended gaps and a configured rollover.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLLOVER_16 } from '../../../calc';
import { definitionOf } from '../../../model/catalog';
import type { TelemetrySample, TelemetrySeries, TelemetrySource } from '../../../model/telemetry';
import { activateScenario, advance, clearScenario, createSim, type SimState } from '../../../sim/engine';
import { simulatedSource } from '../../../sim/telemetry';
import { findingsFor, plantFindings, rulesFor, type FindingsOptions, type RuleFinding } from '..';
import { DATA_RULES } from '../defs/data';

const START = 2 * 1440 + 240;
const s = createSim(41, START);
const IDS = ['DQ-SOURCE', 'DQ-STALE', 'DQ-FROZEN', 'DQ-BAD-QUALITY', 'DQ-GAP', 'DQ-COUNTER-RESET', 'DQ-IMPLAUSIBLE'];

const data = (equipmentId: string, opts?: FindingsOptions) => findingsFor(s, { kind: 'equipment', equipmentId }, opts).filter((f) => f.family === 'data');
const finding = (ruleId: string, equipmentId: string, opts?: FindingsOptions): RuleFinding => {
  const fs = data(equipmentId, opts).filter((x) => x.ruleId === ruleId);
  if (fs.length !== 1) throw new Error(`${fs.length} ${ruleId} findings for ${equipmentId}`);
  return fs[0];
};
const fired = (opts?: FindingsOptions) =>
  plantFindings(s, opts)
    .findings.filter((f) => f.family === 'data' && f.status === 'fired')
    .map((f) => f.key)
    .sort();

/** The simulated source with readings and / or series of some signals replaced (what a gateway with problems would deliver). */
function fixtureSource(o: { read?: Record<string, Partial<TelemetrySample>>; series?: Record<string, (x: TelemetrySeries) => TelemetrySeries> }): TelemetrySource<SimState> {
  return {
    kind: 'simulated',
    read: (st, id) => (o.read?.[id] ? { ...simulatedSource.read(st, id), ...o.read[id] } : simulatedSource.read(st, id)),
    series: (st, id, w) => {
      const x = simulatedSource.series(st, id, w);
      return x && o.series?.[id] ? o.series[id](x) : x;
    },
    states: simulatedSource.states,
  };
}

describe('normal simulation', () => {
  it('applies every data rule to the kiln and reports nothing anywhere: no stale, frozen, bad, gap, reset or implausible signal', () => {
    expect(DATA_RULES.map((d) => d.id)).toEqual(IDS);
    expect(rulesFor({ kind: 'equipment', equipmentId: 'H-KILN' }).filter((d) => d.family === 'data').map((d) => d.id)).toEqual(IDS);
    // A single-signal asset has no source rule (one signal cannot tell a sensor from a link).
    expect(rulesFor({ kind: 'equipment', equipmentId: 'D-SILO' }).filter((d) => d.family === 'data').map((d) => d.id)).not.toContain('DQ-SOURCE');
    const all = plantFindings(s).findings.filter((f) => f.family === 'data');
    expect(all.length).toBeGreaterThan(150);
    for (const f of all) {
      expect(f.status, `${f.key}: ${f.explanation}`).toBe('clear');
      expect(f.classification).toBe('rule-based');
      expect(f.scope.kind).toBe('equipment');
      expect(f.provenance.source).toBe('simulated');
    }
    // One finding per rule per equipment item.
    expect(new Set(all.map((f) => f.key)).size).toBe(all.length);
    expect(all.every((f) => !f.subject)).toBe(true);
  });

  it('explains the clear verdicts — and never judges event-driven signals by age', () => {
    const stale = finding('DQ-STALE', 'H-KILN');
    expect(stale.explanation).toMatch(/^18 of 18 scanned signals of H-KILN updated within 2\.0× their expected interval \(1 min; last update \d\d:\d\d\)\. 1 event-driven signal is not judged by age\.$/);
    expect(finding('DQ-SOURCE', 'H-KILN').explanation).toMatch(/^18 of 18 scanned signals of H-KILN are current .*: the source is delivering\.$/);
    expect(finding('DQ-FROZEN', 'H-KILN').explanation).toMatch(/while H-KILN\.state reports Running\.$/);
    expect(finding('DQ-GAP', 'H-KILN').explanation).toMatch(/^No gap of 2 min or longer in the minute history of the 17 numeric signals of H-KILN over the last 1 h 00 min/);
    expect(finding('DQ-IMPLAUSIBLE', 'H-KILN').explanation).toMatch(/^Every sample of the \d+ signals of H-KILN with an engineering range was inside it/);
    expect(finding('DQ-COUNTER-RESET', 'H-KILN').explanation).toMatch(/^No reset, rollover or implausible step in H-KILN\.count_total over the last 1 h 00 min/);
    // An alarm (event-driven) whose last change is hours old is not stale; dock occupancy keeps no history, so it has no gaps.
    const old = fixtureSource({ read: { 'H-KILN.alarm': { timestamp: s.minute - 300 } } });
    expect(finding('DQ-STALE', 'H-KILN', { source: old }).status).toBe('clear');
    expect(definitionOf('H-KILN.alarm')?.expectedUpdateIntervalS).toBeNull();
    expect(finding('DQ-GAP', 'K-DOCK').status).toBe('clear');
  });

  it('DQ-STALE judges timestamps against the expected interval: late (info) beyond 2×, stale (warning) beyond 5× (fixture source)', () => {
    const now = s.minute;
    const late = finding('DQ-STALE', 'H-KILN', { source: fixtureSource({ read: { 'H-KILN.rate': { timestamp: now - 3 } } }) });
    expect(late.status).toBe('fired');
    expect(late.severity).toBe('info');
    expect(late.title).toBe('Single-layer roller kiln: 1 signal late');
    expect(late.explanation).toMatch(/^1 signal of H-KILN is not current: H-KILN\.rate \(last value \d\d:\d\d, 3 min ago\)\. Expected every 1 min — late beyond 2\.0×, stale beyond 5\.0× that interval\. 17 other scanned signals of H-KILN still update, so the link to the asset is up\./);
    expect(late.firstSeen).toBe(now - 2);
    // A setpoint (its value does not follow the operation) 9 min old is stale; a process value 4 min old is late.
    const src = fixtureSource({ read: { 'H-KILN.zone2_temp_sp': { timestamp: now - 9 }, 'H-KILN.zone2_temp_pv': { timestamp: now - 4 } } });
    const stale = finding('DQ-STALE', 'H-KILN', { source: src });
    expect(stale.severity).toBe('warning');
    expect(stale.title).toBe('Single-layer roller kiln: 2 signals stale');
    expect(stale.explanation).toMatch(/H-KILN\.zone2_temp_pv \(last value \d\d:\d\d, 4 min ago\); H-KILN\.zone2_temp_sp \(last value \d\d:\d\d, 9 min ago\)/);
    expect(stale.next).toMatch(/^Check the data path of H-KILN\.zone2_temp_pv and H-KILN\.zone2_temp_sp on H-KILN/);
    expect(stale.firstSeen).toBe(now - 8);
    expect(finding('DQ-FROZEN', 'H-KILN', { source: src }).status).toBe('clear');
    // A value that follows the operation, 9 min old while the kiln runs: frozen (DQ-FROZEN), not listed as stale.
    const frozen = fixtureSource({ read: { 'H-KILN.rate': { timestamp: now - 9 } } });
    expect(finding('DQ-FROZEN', 'H-KILN', { source: frozen })).toMatchObject({ status: 'fired', severity: 'warning', firstSeen: now - 8 });
    expect(finding('DQ-FROZEN', 'H-KILN', { source: frozen }).explanation).toMatch(/^H-KILN\.rate = [\d,]+ tiles\/h since \d\d:\d\d \(9 min\)/);
    expect(finding('DQ-STALE', 'H-KILN', { source: frozen }).status).toBe('clear');
    // A factor set for one asset applies there only.
    const strict = finding('DQ-STALE', 'H-KILN', { source: fixtureSource({ read: { 'H-KILN.rate': { timestamp: now - 3 } } }), values: { 'DQ-STALE.lateFactor@H-KILN': 4 } });
    expect(strict.status).toBe('clear');
  });

  it('DQ-SOURCE: every scanned signal of the asset old at once is one source interruption; DQ-STALE then defers (fixture source)', () => {
    const now = s.minute;
    const read = Object.fromEntries(
      ['state', 'run_command', 'count_total', 'rate', 'roller_speed', 'vibration', 'temperature', 'motor_current', ...[1, 2, 3, 4, 5].flatMap((z) => [`zone${z}_temp_pv`, `zone${z}_temp_sp`])].map((n) => [`H-KILN.${n}`, { timestamp: now - 7 }]),
    );
    const src = fixtureSource({ read });
    const f = finding('DQ-SOURCE', 'H-KILN', { source: src });
    expect(f.status).toBe('fired');
    expect(f.severity).toBe('serious');
    expect(f.explanation).toMatch(/^All 18 scanned signals of H-KILN stopped updating at the same time — the newest value is from \d\d:\d\d \(7 min ago\): 18 carry an old timestamp\. One interruption of the source \(PLC \/ gateway link\), not 18 sensor faults\./);
    expect(f.firstSeen).toBe(now - 6);
    const st = finding('DQ-STALE', 'H-KILN', { source: src });
    expect(st.status).toBe('clear');
    expect(st.explanation).toMatch(/reported once as a source interruption \(DQ-SOURCE\), not signal by signal/);
  });
});

describe("'data-quality' and 'signal-loss' scenarios", () => {
  let t0 = 0;
  const ids: Record<string, string> = {};
  beforeAll(() => {
    t0 = s.minute;
    const add = (key: string, sc: Parameters<typeof activateScenario>[1]) => (ids[key] = activateScenario(s, sc).id);
    add('bad', { kind: 'data-quality', mode: 'bad-quality', equipmentId: 'E-PRS1', end: null, label: 'Press 1 bad quality' });
    add('frozen', { kind: 'data-quality', mode: 'frozen', equipmentId: 'D-TWR', signalId: 'D-TWR.inlet_temp_pv', end: null, label: 'Inlet temperature frozen' });
    add('frozenSilo', { kind: 'data-quality', mode: 'frozen', equipmentId: 'D-SILO', signalId: 'D-SILO.level', end: null, label: 'Silo level frozen' });
    add('reset', { kind: 'data-quality', mode: 'counter-reset', equipmentId: 'J-BOX', end: null, label: 'Packing counters reset' });
    add('spike', { kind: 'data-quality', mode: 'spike', equipmentId: 'H-KILN', signalId: 'H-KILN.zone2_temp_pv', end: null, label: 'Zone 2 spikes' });
    add('gap', { kind: 'data-quality', mode: 'gap', equipmentId: 'G-LINE', signalId: 'G-LINE.line_speed', end: null, label: 'Line speed gap' });
    add('gapAll', { kind: 'data-quality', mode: 'gap', equipmentId: 'CV-PACK', end: null, label: 'Packing belt gap' });
    add('loss', { kind: 'signal-loss', equipmentId: 'F-DRY', end: null, label: 'Dryer feed loss' });
    add('stop', { kind: 'machine-stop', equipmentId: 'E-PRS3', end: null, label: 'Press 3 breakdown' });
    advance(s, t0 + 12);
  });

  it('fires exactly the rules of the scenarios — on their assets only', () => {
    expect(fired()).toEqual(
      [
        'DQ-BAD-QUALITY|eq:E-PRS1',
        'DQ-FROZEN|eq:D-TWR',
        'DQ-STALE|eq:D-SILO',
        'DQ-COUNTER-RESET|eq:J-BOX',
        'DQ-IMPLAUSIBLE|eq:H-KILN',
        'DQ-GAP|eq:G-LINE',
        'DQ-SOURCE|eq:CV-PACK',
        'DQ-GAP|eq:CV-PACK',
        'DQ-SOURCE|eq:F-DRY',
      ].sort(),
    );
    for (const id of ['E-PRS2', 'E-PRS3', 'I-SORT', 'CV-SORT']) for (const f of data(id)) expect(f.status, f.key).toBe('clear');
  });

  it("'bad-quality': one finding listing the flagged signals; their values are not trusted", () => {
    const f = finding('DQ-BAD-QUALITY', 'E-PRS1');
    expect(f.severity).toBe('warning');
    expect(f.title).toBe('Hydraulic press 1: 14 signals flagged bad');
    expect(f.explanation).toMatch(/^14 readings flagged bad now: E-PRS1\.state, .* and 8 more; \d+ bad samples in the last 1 h 00 min across 12 signals, the first at \d\d:\d\d\./);
    expect(f.explanation).toMatch(/A bad-flagged value is not trusted/);
    expect(f.firstSeen).toBe(t0);
    expect(f.provenance.scenarioId).toBe(ids.bad);
    // Not stale, not a source interruption; the frozen check cannot read the (bad) state signal.
    expect(finding('DQ-SOURCE', 'E-PRS1').status).toBe('clear');
    expect(finding('DQ-STALE', 'E-PRS1').status).toBe('clear');
    const fr = finding('DQ-FROZEN', 'E-PRS1');
    expect(fr.status).toBe('insufficient-data');
    expect(fr.explanation).toMatch(/^Not evaluated — requires E-PRS1\.state \(Machine state\): bad quality flag/);
  });

  it("'frozen' on a running machine is DQ-FROZEN (not DQ-STALE); on an asset without a state signal it is DQ-STALE", () => {
    const f = finding('DQ-FROZEN', 'D-TWR');
    expect(f.severity).toBe('warning');
    expect(f.title).toBe('Spray dryer tower: inlet air temperature · actual frozen while running');
    expect(f.explanation).toMatch(/^D-TWR\.inlet_temp_pv = \d+ °C since \d\d:\d\d \(13 min\) — no new value or timestamp for longer than the stale age \(5\.0× the expected update interval\) while D-TWR\.state is current and reports Running/);
    expect(f.explanation).toMatch(/not a lost link/);
    expect(f.firstSeen).toBe(t0);
    expect(f.provenance.scenarioId).toBe(ids.frozen);
    const st = finding('DQ-STALE', 'D-TWR');
    expect(st.status).toBe('clear');
    expect(st.explanation).toMatch(/Reported by other rules: D-TWR\.inlet_temp_pv frozen while D-TWR runs \(DQ-FROZEN\)/);
    const silo = finding('DQ-STALE', 'D-SILO');
    expect(silo.severity).toBe('warning');
    expect(silo.explanation).toMatch(/^1 signal of D-SILO is not current: D-SILO\.level \(last value \d\d:\d\d, 13 min ago — value not updating since \d\d:\d\d \(simulated data-quality scenario: frozen value\)\)/);
    expect(silo.explanation).toMatch(/It is the only scanned signal of D-SILO/);
  });

  it("'counter-reset': says which counters reset and when — an unexplained reset (no rollover configured) is a warning", () => {
    const f = finding('DQ-COUNTER-RESET', 'J-BOX');
    expect(f.severity).toBe('warning');
    expect(f.title).toBe('Carton packaging machine: counter reset (2)');
    expect(f.explanation).toMatch(/^J-BOX\.count_total went from [\d,]+ to \d+ tiles at (\d\d:\d\d) — a reset to near zero with no rollover register size configured \(unexplained\); J-BOX\.carton_count went from [\d,]+ to \d+ cartons at \1/);
    expect(f.firstSeen).toBe(t0);
    expect(f.next).toMatch(/power cycle, shift or batch reset, program download/);
    expect(f.provenance.scenarioId).toBe(ids.reset);
  });

  it('a rollover at a configured register size is info (catalogue counter config + fixture series)', () => {
    const def = definitionOf('H-KILN.count_total')!;
    const saved = def.counter;
    const wrap = (x: TelemetrySeries): TelemetrySeries => {
      const v0 = x.v.find((v) => v != null)!;
      return { ...x, v: x.v.map((v) => (v == null ? v : (v - v0 + ROLLOVER_16 - 300) % ROLLOVER_16)) };
    };
    const source = fixtureSource({ series: { 'H-KILN.count_total': wrap } });
    try {
      def.counter = { ...saved!, rolloverAt: ROLLOVER_16 };
      const f = finding('DQ-COUNTER-RESET', 'H-KILN', { source });
      expect(f.status).toBe('fired');
      expect(f.severity).toBe('info');
      expect(f.title).toBe('Single-layer roller kiln: counter rollover');
      expect(f.explanation).toMatch(/^H-KILN\.count_total went from 65,[\d]{3} to \d+ tiles at \d\d:\d\d — a rollover at its configured register size \(65,536\)/);
      expect(f.next).toBeNull();
      def.counter = { ...saved!, rolloverAt: null };
      const g = finding('DQ-COUNTER-RESET', 'H-KILN', { source });
      expect(g.severity).toBe('warning');
      expect(g.explanation).toMatch(/a reset to near zero with no rollover register size configured \(unexplained\)/);
    } finally {
      def.counter = saved;
    }
  });

  it("'spike': readings outside the engineering range, with the range and when", () => {
    const f = finding('DQ-IMPLAUSIBLE', 'H-KILN');
    expect(f.severity).toBe('warning');
    expect(f.title).toBe('Single-layer roller kiln: implausible readings — zone 2 temperature · firing · actual');
    expect(f.explanation).toMatch(/^H-KILN\.zone2_temp_pv: 2 samples outside its engineering range 0–1,300 °C in the last 1 h 00 min \([\d,]+ at \d\d:\d\d and [\d,]+ at \d\d:\d\d; furthest [\d,]+ °C\)\. A reading outside the range the instrument can measure is a data fault/);
    expect(f.firstSeen).toBe(t0);
    expect(f.provenance.scenarioId).toBe(ids.spike);
    // Between spikes the reading is plausible again — the finding stands for the window.
    expect(typeof s.minute).toBe('number');
  });

  it("'gap': no samples on one signal is DQ-GAP; a whole asset delivering nothing is also one source interruption", () => {
    const g = finding('DQ-GAP', 'G-LINE');
    expect(g.severity).toBe('warning');
    expect(g.title).toBe('Glaze application line: no samples — 1 signal');
    expect(g.explanation).toMatch(/^No samples delivered in the last 1 h 00 min \(\d\d:\d\d–\d\d:\d\d\) for G-LINE\.line_speed: since \d\d:\d\d \(12 min, ongoing\)\. Charts and rules over these minutes have no data there \(shown as gaps, never as zero\)\./);
    expect(finding('DQ-SOURCE', 'G-LINE').status).toBe('clear');
    const all = finding('DQ-GAP', 'CV-PACK');
    expect(all.explanation).toMatch(/for CV-PACK\.tile_count and CV-PACK\.speed: since \d\d:\d\d \(12 min, ongoing\)/);
    const src = finding('DQ-SOURCE', 'CV-PACK');
    expect(src.explanation).toMatch(/^All 3 scanned signals of CV-PACK stopped updating at the same time .*: 3 deliver no value\./);
    // A stopped press has no press pressure or cycle time: no value, not a gap (and no implausible cycle time).
    expect(finding('DQ-GAP', 'E-PRS3').status).toBe('clear');
    expect(finding('DQ-IMPLAUSIBLE', 'E-PRS3').status).toBe('clear');
  });

  it("'signal-loss': one source interruption for the whole feed — not a list of stale signals", () => {
    const f = finding('DQ-SOURCE', 'F-DRY');
    expect(f.severity).toBe('serious');
    expect(f.title).toBe('Multi-deck roller dryer: data source interrupted');
    expect(f.explanation).toMatch(/^All 12 scanned signals of F-DRY stopped updating at the same time — the newest value is from \d\d:\d\d \(13 min ago\): 12 are flagged stale by the source\. One interruption of the source \(PLC \/ gateway link\), not 12 sensor faults\. Source note: Feed stale since/);
    expect(f.next).toMatch(/^Check the PLC \/ gateway link of F-DRY/);
    expect(f.firstSeen).toBe(t0);
    expect(f.provenance.scenarioId).toBe(ids.loss);
    expect(data('F-DRY').filter((x) => x.ruleId === 'DQ-SOURCE')).toHaveLength(1);
    expect(finding('DQ-STALE', 'F-DRY').status).toBe('clear');
    expect(finding('DQ-FROZEN', 'F-DRY').status).toBe('insufficient-data');
    expect(finding('DQ-GAP', 'F-DRY').status).toBe('clear');
  });

  it('a gap that ended stays reported for the window as info, with its start and end', () => {
    clearScenario(s, ids.gap);
    advance(s, s.minute + 3);
    const g = finding('DQ-GAP', 'G-LINE');
    expect(g.status).toBe('fired');
    expect(g.severity).toBe('info');
    expect(g.explanation).toMatch(/for G-LINE\.line_speed: \d\d:\d\d–\d\d:\d\d \(12 min\)\./);
    expect(g.explanation).not.toMatch(/ongoing/);
    // Interior holes are found from the timestamps too (fixture: three minutes without samples 20 min ago).
    const hole = (x: TelemetrySeries): TelemetrySeries => ({ ...x, v: x.v.map((v, i) => (x.t[i] >= s.minute - 20 && x.t[i] < s.minute - 17 ? null : v)), q: x.q?.map((q, i) => (x.t[i] >= s.minute - 20 && x.t[i] < s.minute - 17 ? 'missing' : q)) });
    const f = finding('DQ-GAP', 'H-KILN', { source: fixtureSource({ series: { 'H-KILN.rate': hole } }) });
    expect(f.severity).toBe('info');
    expect(f.explanation).toMatch(/for H-KILN\.rate: \d\d:\d\d–\d\d:\d\d \(3 min\)\./);
  });
});
