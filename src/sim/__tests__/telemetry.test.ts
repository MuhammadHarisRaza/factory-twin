/**
 * Simulated telemetry source (src/sim/telemetry.ts): every signal reads without throwing and never turns a
 * missing value into 0; a stale feed freezes value and timestamp; each data-quality mode has its effect;
 * series have the step, resolution and coverage of their range; state timelines are contiguous and show a
 * product changeover as 'changeover'.
 */
import { describe, expect, it } from 'vitest';
import { PROCESS_SIGNALS, PROCESS_SIGNAL_BY_ID } from '../../model/catalog/process';
import { BUFFERS, BUFFER_LEVEL_SIGNAL, SIGNALS } from '../../model/plant';
import { RANGE_OPTIONS } from '../../model/telemetry';
import { LOG_MIN, activateScenario, advance, createSim } from '../engine';
import { operationalState } from '../metrics';
import { processValue } from '../process';
import { SPIKE_EVERY_MIN, STALE_AGE_MIN, TELEMETRY_SIGNAL_IDS, readSignal, seriesOf, simulatedSource, stateTimeline } from '../telemetry';

const START = 2 * 1440 + 240;

describe('reading every signal', () => {
  const s = createSim(21, START);

  it('reads every SIGNALS and PROCESS_SIGNALS id without throwing, simulated, and never a missing value as 0', () => {
    expect(TELEMETRY_SIGNAL_IDS.length).toBe(SIGNALS.length + PROCESS_SIGNALS.length);
    expect(simulatedSource.kind).toBe('simulated');
    for (const id of TELEMETRY_SIGNAL_IDS) {
      const r = readSignal(s, id);
      expect(r.signalId).toBe(id);
      expect(r.status, id).not.toBe('connected');
      expect(['simulated', 'not-modelled']).toContain(r.status);
      if (typeof r.value === 'number') expect(Number.isFinite(r.value), id).toBe(true);
      if (r.value == null) {
        expect(r.text, id).toBe('—');
        expect(r.note, id).toBeTruthy();
      }
      if (r.quality === 'missing' || r.status === 'not-modelled') expect(r.value, id).toBeNull();
      if (r.value != null) expect(r.timestamp, id).not.toBeNull();
      expect(() => seriesOf(s, id, '1h')).not.toThrow();
    }
    // The not-modelled process analogs: null, not a plausible number and not 0.
    expect(readSignal(s, 'H-KILN.temp_firing')).toMatchObject({ value: null, status: 'not-modelled', quality: 'missing' });
    expect(seriesOf(s, 'H-KILN.temp_firing', '1h')).toBeNull();
    // The process model replaces them.
    expect(readSignal(s, 'H-KILN.zone3_temp_pv').value as number).toBeGreaterThan(1100);
    expect(readSignal(s, 'D-TWR.powder_moisture_pv')).toMatchObject({ quality: 'good', unit: '%' });
    expect(readSignal(s, 'nope.signal')).toMatchObject({ value: null, status: 'unavailable' });
  });

  it('live readings carry the last simulated minute as their timestamp', () => {
    for (const id of ['H-KILN.rate', 'H-KILN.count_total', 'D-SILO.level', 'H-KILN.vibration', 'E-PRS1.cycle_time_target', 'J-PAL.run_command'])
      expect(readSignal(s, id), id).toMatchObject({ timestamp: s.minute - 1, quality: 'good' });
    expect(readSignal(s, 'J-PAL.run_command').text).toMatch(/^(On|Off)$/);
  });

  it('reads every buffer level — also the hosted ones of the buffers without equipment — from the fill and the buffer log', () => {
    for (const b of BUFFERS) {
      const id = BUFFER_LEVEL_SIGNAL[b.id];
      const r = readSignal(s, id);
      expect(r, id).toMatchObject({ quality: 'good', unit: '%', status: 'simulated', timestamp: s.minute - 1 });
      expect(r.value as number, id).toBeCloseTo((s.buffers[b.id] / b.capacity) * 100, 1);
      const x = seriesOf(s, id, '1h')!;
      expect(x.source, id).toBe('buffer log');
      expect(x.coverage, id).toEqual({ expected: 60, present: 60 });
      const t = s.minute - 10;
      expect(x.v[x.t.indexOf(t)]!, id).toBeCloseTo((s.bufferLog[b.id].level[t % LOG_MIN] / b.capacity) * 100, 6);
    }
    expect(BUFFER_LEVEL_SIGNAL['BUF-KOUT']).toBe('CV-SORT.outfeed_buffer_level');
    expect(readSignal(s, 'CV-SORT.outfeed_buffer_level').text).toMatch(/^\d+\.\d$/);
  });

  it('no series fabricates zeros for missing minutes: gaps are null with a quality', () => {
    for (const id of TELEMETRY_SIGNAL_IDS) {
      const x = seriesOf(s, id, { from: -30, to: 30, stepMin: 1 });
      if (!x) continue;
      for (let i = 0; i < 30; i++) {
        expect(x.v[i], `${id} before the start`).toBeNull();
        expect(x.q![i]).toBe('missing');
      }
      expect(x.coverage.expected).toBe(30);
    }
  });
});

describe('stale feed', () => {
  it("serves every signal of the asset as last received: quality 'stale', timestamp frozen at the last update", () => {
    const s = createSim(22, START);
    const since = s.minute;
    const ids = [...SIGNALS.filter((x) => x.equipmentId === 'H-KILN').map((x) => x.id), ...PROCESS_SIGNALS.filter((p) => p.equipmentId === 'H-KILN').map((p) => p.id)];
    const before = Object.fromEntries(ids.map((id) => [id, readSignal(s, id)]));
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln PLC link loss' });
    advance(s, since + 20);
    const at20 = Object.fromEntries(ids.map((id) => [id, readSignal(s, id)]));
    advance(s, since + 40);
    for (const id of ids) {
      if (id === 'H-KILN.temp_firing' || id === 'H-KILN.temp_preheat') continue;
      const r = readSignal(s, id);
      expect(r.quality, id).toBe('stale');
      expect(r.timestamp, id).toBe(since - 1);
      expect(r.value, id).toEqual(at20[id].value);
      expect(r.value, id).toEqual(before[id].value);
      expect(r.note).toMatch(/Feed stale since/);
    }
    // History: the minutes of the outage are stale gaps, the minutes before it are present.
    const x = seriesOf(s, 'H-KILN.zone3_temp_pv', '1h')!;
    const i = x.t.indexOf(since);
    expect(x.v[i - 1]).not.toBeNull();
    for (let k = i; k < x.t.length; k++) {
      expect(x.v[k]).toBeNull();
      expect(x.q![k]).toBe('stale');
    }
    expect(x.note).toMatch(/Feed stale/);
    expect(processValue(s, 'H-KILN.zone3_temp_pv', since - 1)).toEqual(readSignal(s, 'H-KILN.zone3_temp_pv').value);
    // The display text is the one received too (e.g. 'Running', 'No active alarm' — not the raw code).
    for (const id of ['H-KILN.state', 'H-KILN.alarm', 'H-KILN.count_total']) expect(readSignal(s, id).text, id).toBe(before[id].text);
  });

  it('a source with no simulated minute yet delivers nothing (no 0 from the initial runtime)', () => {
    const s0 = createSim(32, 0);
    for (const id of ['H-KILN.rate', 'H-KILN.count_total', 'H-KILN.zone3_temp_pv', 'H-KILN.run_command'])
      expect(readSignal(s0, id), id).toMatchObject({ value: null, text: '—', quality: 'missing', timestamp: null });
  });
});

describe('data-quality scenarios', () => {
  it("'bad-quality' flags the asset's samples bad (series: null, quality 'bad')", () => {
    const s = createSim(23, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'data-quality', mode: 'bad-quality', equipmentId: 'E-PRS1', end: null, label: 'Bad quality' });
    advance(s, t0 + 10);
    expect(readSignal(s, 'E-PRS1.rate').quality).toBe('bad');
    expect(readSignal(s, 'E-PRS1.press_pressure_pv').quality).toBe('bad');
    expect(readSignal(s, 'E-PRS2.rate').quality).toBe('good');
    const x = seriesOf(s, 'E-PRS1.rate', '15m')!;
    const tail = x.t.map((t, i) => [t, x.v[i], x.q![i]] as const).filter(([t]) => t >= t0);
    expect(tail.length).toBe(10);
    for (const [, v, q] of tail) {
      expect(v).toBeNull();
      expect(q).toBe('bad');
    }
    // Production is unchanged.
    expect(s.machines['E-PRS1'].ratePerHour).toBeGreaterThan(0);
  });

  it("'frozen' stops the value and its timestamp; it reads stale once older than the stale age", () => {
    const s = createSim(24, START);
    const t0 = s.minute;
    const id = 'D-TWR.inlet_temp_pv';
    const v0 = processValue(s, id, t0 - 1);
    activateScenario(s, { kind: 'data-quality', mode: 'frozen', equipmentId: 'D-TWR', signalId: id, end: null, label: 'Frozen' });
    advance(s, t0 + 3);
    expect(readSignal(s, id)).toMatchObject({ value: v0, timestamp: t0 - 1, quality: 'good' });
    expect(readSignal(s, 'D-TWR.outlet_temp_pv').timestamp).toBe(s.minute - 1);
    advance(s, t0 + STALE_AGE_MIN + 5);
    expect(readSignal(s, id)).toMatchObject({ value: v0, timestamp: t0 - 1, quality: 'stale' });
    // A frozen counter of a configured signal keeps its snapshot value (and a frozen state its display text).
    const c0 = readSignal(s, 'G-LINE.count_total').value;
    const st0 = readSignal(s, 'G-LINE.state').text;
    activateScenario(s, { kind: 'data-quality', mode: 'frozen', equipmentId: 'G-LINE', end: null, label: 'Frozen line' });
    advance(s, s.minute + 2);
    expect(readSignal(s, 'G-LINE.count_total').value).toBe(c0);
    expect(readSignal(s, 'G-LINE.state').text).toBe(st0);
  });

  it("'counter-reset' restarts the asset's production counters from 0 at the start (a one-off event)", () => {
    const s = createSim(25, START);
    const t0 = s.minute;
    const total = s.machines['H-KILN'].countTotal;
    const sc = activateScenario(s, { kind: 'data-quality', mode: 'counter-reset', equipmentId: 'H-KILN', end: null, label: 'Counter reset' });
    expect(sc.end).toBe(sc.start + 1);
    advance(s, t0 + 30);
    const made = s.machines['H-KILN'].countTotal - total;
    const r = readSignal(s, 'H-KILN.count_total').value as number;
    expect(r).toBeGreaterThan(0);
    expect(Math.abs(r - made)).toBeLessThanOrEqual(1);
    expect(r).toBeLessThan(total);
    // The series shows the reset as a drop to near zero, then counting again.
    const x = seriesOf(s, 'H-KILN.count_total', '1h')!;
    const i = x.t.indexOf(t0);
    expect(x.v[i - 1]!).toBeGreaterThan(total - 100);
    expect(x.v[i]!).toBeLessThan(100);
    expect(x.v[x.v.length - 1]!).toBeGreaterThan(x.v[i]!);
    // Other signals of the asset (rate) are not reset.
    expect(readSignal(s, 'H-KILN.rate').value as number).toBeGreaterThan(100);
  });

  it("'spike' reads implausibly outside the engineering range every few minutes", () => {
    const s = createSim(26, START);
    const t0 = s.minute;
    const id = 'H-KILN.zone2_temp_pv';
    activateScenario(s, { kind: 'data-quality', mode: 'spike', equipmentId: 'H-KILN', signalId: id, end: null, label: 'Spike' });
    advance(s, t0 + 1);
    const max = PROCESS_SIGNAL_BY_ID[id].engineeringMax!;
    expect(readSignal(s, id).value as number).toBeGreaterThan(max);
    advance(s, t0 + 2);
    expect(readSignal(s, id).value as number).toBeLessThanOrEqual(max);
    advance(s, t0 + 2 * SPIKE_EVERY_MIN + 1);
    const x = seriesOf(s, id, '15m')!;
    const spikes = x.v.filter((v) => v != null && v > max).length;
    expect(spikes).toBe(2);
  });

  it("'gap' delivers no samples: missing in readings and series, coverage short", () => {
    const s = createSim(27, START);
    const t0 = s.minute;
    activateScenario(s, { kind: 'data-quality', mode: 'gap', equipmentId: 'G-LINE', end: null, label: 'Gap' });
    advance(s, t0 + 8);
    expect(readSignal(s, 'G-LINE.rate')).toMatchObject({ value: null, text: '—', quality: 'missing', timestamp: t0 - 1 });
    const x = seriesOf(s, 'G-LINE.line_speed', '15m')!;
    expect(x.coverage).toEqual({ expected: 15, present: 7 });
    expect(x.q!.slice(-8).every((q) => q === 'missing')).toBe(true);
    // Without state samples the state timeline does not claim a state: 'unknown' over the gap.
    const tl = stateTimeline(s, 'G-LINE', { from: t0 - 5, to: s.minute });
    expect(tl[tl.length - 1]).toMatchObject({ state: 'unknown', from: t0, to: s.minute });
    expect(tl[tl.length - 1].label).toMatch(/gap/);
  });

  it("'command-no-feedback' holds the machine stopped while its run command stays on", () => {
    const s = createSim(28, START);
    activateScenario(s, { kind: 'data-quality', mode: 'command-no-feedback', equipmentId: 'E-PRS2', end: null, label: 'No feedback' });
    advance(s, s.minute + 10);
    expect(readSignal(s, 'E-PRS2.run_command')).toMatchObject({ value: true, quality: 'good' });
    expect(readSignal(s, 'E-PRS2.state').value).toBe('down');
    expect(readSignal(s, 'E-PRS2.rate').value).toBe(0);
    expect(operationalState(s, 'E-PRS2')).toBe('stopped');
    expect(readSignal(s, 'E-PRS1.run_command').value).toBe(true);
  });
});

describe('series per range', () => {
  const s = createSim(29, 7 * 1440 + 270);

  it('has the step, resolution and coverage of each RangeKey', () => {
    for (const r of RANGE_OPTIONS) {
      for (const id of ['H-KILN.rate', 'H-KILN.zone3_temp_pv', 'H-KILN.vibration', 'D-SILO.level', 'I-SORT.count_good']) {
        const x = seriesOf(s, id, r.key)!;
        const n = r.minutes / r.stepMin;
        expect(x.t.length, `${id} ${r.key}`).toBe(n);
        expect(x.v.length).toBe(n);
        expect(x.stepMin).toBe(r.stepMin);
        expect(x.resolution, `${id} ${r.key}`).toBe(r.resolution);
        for (let i = 1; i < n; i++) expect(x.t[i] - x.t[i - 1]).toBe(r.stepMin);
        expect(x.coverage.expected).toBe(n);
        expect(x.coverage.present, `${id} ${r.key}`).toBe(n);
        expect(x.status).toBe('simulated');
      }
      // Minute ranges end at the last simulated minute; hourly ones at the current hour.
      const x = seriesOf(s, 'H-KILN.rate', r.key)!;
      if (r.resolution === 'minute') expect(x.t[x.t.length - 1]).toBe(s.minute - r.stepMin);
      else expect(x.t[x.t.length - 1]).toBe(Math.floor((s.minute - 1) / 60) * 60);
    }
    expect(LOG_MIN).toBe(480);
  });

  it('8 h are 5-minute means of the minute data; 24 h means of the hourly buckets', () => {
    const m = seriesOf(s, 'H-KILN.rate', '1h')!;
    const e = seriesOf(s, 'H-KILN.rate', '8h')!;
    const last5 = m.v.slice(-5) as number[];
    expect(e.v[e.v.length - 1]!).toBeCloseTo(last5.reduce((a, b) => a + b, 0) / 5, 6);
    const d = seriesOf(s, 'H-KILN.rate', '24h')!;
    const h = d.t[d.t.length - 2] / 60;
    expect(d.v[d.v.length - 2]!).toBeCloseTo(s.hours['H-KILN'].get(h)!.count, 6);
    expect(d.source).toMatch(/hourly/);
    // Energy keeps hourly totals only: minute ranges say so instead of inventing minute values.
    const kwh = seriesOf(s, 'H-KILN.energy_kwh', '15m')!;
    expect(kwh.coverage.present).toBe(0);
    expect(kwh.note).toMatch(/hourly totals only/);
    expect(seriesOf(s, 'H-KILN.energy_kwh', '24h')!.coverage.present).toBe(24);
    // States and events have no numeric history.
    expect(seriesOf(s, 'H-KILN.state', '1h')).toBeNull();
    expect(seriesOf(s, 'A-GATE.gate_event', '1h')).toBeNull();
  });
});

describe('state timeline', () => {
  const s = createSim(30, 7 * 1440 + 270);

  it('is contiguous over the window, in the product state vocabulary, and shows a product changeover as changeover', () => {
    const w = { from: s.minute - 1440, to: s.minute };
    for (const id of ['E-PRS1', 'G-LINE', 'H-KILN', 'CV-SORT']) {
      const tl = stateTimeline(s, id, w);
      expect(tl[0].from, id).toBe(w.from);
      expect(tl[tl.length - 1].to, id).toBe(w.to);
      for (let i = 1; i < tl.length; i++) {
        expect(tl[i].from, id).toBe(tl[i - 1].to);
        expect(`${tl[i].state}|${tl[i].label}|${tl[i].reason}`).not.toBe(`${tl[i - 1].state}|${tl[i - 1].label}|${tl[i - 1].reason}`);
      }
    }
    const chg = s.downtime.filter((d) => d.equipmentId === 'E-PRS1' && d.reasonCode === 'CHG_PRODUCT' && d.start >= w.from && d.end != null);
    expect(chg.length).toBeGreaterThan(0);
    const tl = stateTimeline(s, 'E-PRS1', w);
    for (const d of chg) {
      const seg = tl.find((x) => x.from <= d.start && x.to > d.start)!;
      expect(seg.state).toBe('changeover');
      expect(seg.reason).toBe('CHG_PRODUCT');
      expect(seg.to).toBe(d.end);
    }
    // Inside and beyond the minute log: both changeovers older than 8 h and recent ones are classified.
    expect(chg.some((d) => d.start < s.minute - LOG_MIN)).toBe(true);
    expect(simulatedSource.states(s, 'E-PRS1', w)).toEqual(tl);
    // No state signal → no timeline; a window in the future is clipped to the simulated minutes.
    expect(stateTimeline(s, 'K-RACK', w)).toEqual([]);
    expect(stateTimeline(s, 'E-PRS1', { from: s.minute + 10, to: s.minute + 20 })).toEqual([]);
  });

  it("shows a stale feed as 'unknown' and a breakdown as fault / stopped with its reason", () => {
    const s2 = createSim(31, START);
    const t0 = s2.minute;
    activateScenario(s2, { kind: 'machine-stop', equipmentId: 'F-DRY', end: t0 + 20, label: 'Dryer stop' });
    advance(s2, t0 + 30);
    activateScenario(s2, { kind: 'signal-loss', equipmentId: 'F-DRY', end: null, label: 'Feed loss' });
    advance(s2, t0 + 40);
    const tl = stateTimeline(s2, 'F-DRY', { from: t0 - 5, to: s2.minute });
    expect(tl.find((x) => x.from <= t0 && x.to > t0)).toMatchObject({ state: 'stopped', reason: 'SCN_STOP' });
    expect(tl[tl.length - 1]).toMatchObject({ state: 'unknown', label: 'Data feed stale', to: s2.minute });
  });
});
