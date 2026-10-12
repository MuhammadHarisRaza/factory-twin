/**
 * Round 2 — reports follow the one stale-feed rule (Decision 1): a figure that rests on a feed which
 * stopped updating keeps the KPI card's running value and carries the card's mark ("Not confirmed ·
 * <asset> data stale since hh:mm") — in the OEE components and kiln-minutes tables, in the incident
 * report's operational context (in-app and PDF model) and in the report text; and the stage shift report
 * prints a previous plant day's "Since" time with its date.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { factoryOeeKpi, goodOutputKpi } from '../../intel/kpis';
import { buildEventReport } from '../../intel/report';
import { activateScenario, advance, createSim, DEFAULT_SEED, type SimState } from '../../sim/engine';
import { OPERATIONAL_STATE_LABEL, resolvePeriod } from '../../sim/metrics';
import { formatClock, formatDateTime } from '../../sim/time';
import { eventPdfModel } from '../model';
import { stageShiftModel } from '../stageShift';
import { buildOpsReport, type OpsReport, type ReportBlock } from '../ops';
import { opsPdfModel } from '../ops/pdf';
import { equipmentRows } from '../ops/shift';
import { isWinAnsiSafe, pdfText } from '../text';

const SHORT = 2 * 1440 + 4 * 60 + 30;
const low1 = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'dataUrl') strings(x, out);
  return out;
}
const section = (r: OpsReport, id: string) => r.sections.find((x) => x.id === id)!;
const block = <K extends ReportBlock['kind']>(r: OpsReport, id: string, kind: K) => section(r, id).blocks.find((b) => b.kind === kind) as Extract<ReportBlock, { kind: K }>;
const texts = (r: OpsReport, id: string) => section(r, id).blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : []));

let plain: SimState;
let kilnStale: SimState;
let sortStale: SimState;

function lose(id: string) {
  const s = createSim(DEFAULT_SEED, SHORT);
  activateScenario(s, { kind: 'signal-loss', equipmentId: id, end: null, label: `${id} feed lost` });
  advance(s, s.minute + 30);
  return s;
}

beforeAll(() => {
  plain = createSim(DEFAULT_SEED, SHORT);
  kilnStale = lose('H-KILN');
  sortStale = lose('I-SORT');
}, 180_000);

describe('OEE report: the components and kiln-minutes tables carry the stale mark', () => {
  it('kiln feed stale: availability, performance, OEE and the kiln minutes are "not confirmed", with the card\'s note', () => {
    const r = buildOpsReport(kilnStale, 'oee', { period: 'shift' });
    const mark = `Not confirmed · kiln data stale since ${formatClock(kilnStale.feeds['H-KILN'].since)}`;
    expect(r.kpis[0].status?.label).toBe(mark);
    const rows = Object.fromEntries(block(r, 'components', 'table').rows.map((row) => [row[0] as string, row[1] as string]));
    expect(rows.Availability).toMatch(/ % · not confirmed$/);
    expect(rows.Performance).toMatch(/ % · not confirmed$/);
    expect(rows.OEE).toMatch(/ % · not confirmed$/);
    expect(rows.Quality).not.toContain('not confirmed');
    expect(texts(r, 'components').some((t) => t.startsWith(`${mark}: availability and performance`))).toBe(true);
    expect(section(r, 'components').tag).toContain('not confirmed');
    const kv = Object.fromEntries(block(r, 'downtime', 'kv').rows);
    for (const k of ['Kiln stopped (own downtime)', 'Kiln starved (no tiles in)', 'Kiln blocked (no room out)']) expect(kv[k], k).toMatch(/ min · not confirmed$/);
    expect(kv['Kiln planned stops']).not.toContain('not confirmed');
    expect(texts(r, 'downtime').some((t) => t.startsWith(`${mark}: the kiln minutes above`))).toBe(true);
    // The summary never states the unconfirmed OEE as a fact.
    expect(r.summary).toMatch(new RegExp(`^Line OEE not confirmed — kiln data stale since ${formatClock(kilnStale.feeds['H-KILN'].since)} \\(simulated running figure [\\d.]+ %`));
    // The PDF model prints the same marks, in WinAnsi-safe text.
    const pdf = strings(opsPdfModel(r));
    expect(pdf.some((t) => t.includes('not confirmed'))).toBe(true);
    expect(pdf.some((t) => t.includes('kiln data stale since'))).toBe(true);
    expect(pdf.filter((t) => !isWinAnsiSafe(t))).toEqual([]);
  });

  it('sorting feed stale: quality and OEE are "not confirmed", availability and performance are not', () => {
    const r = buildOpsReport(sortStale, 'oee', { period: 'shift' });
    const rows = Object.fromEntries(block(r, 'components', 'table').rows.map((row) => [row[0] as string, row[1] as string]));
    expect(rows.Quality).toMatch(/ · not confirmed$/);
    expect(rows.OEE).toMatch(/ · not confirmed$/);
    expect(rows.Availability).not.toContain('not confirmed');
    expect(texts(r, 'components').some((t) => t.startsWith(`Not confirmed · sorting data stale since ${formatClock(sortStale.feeds['I-SORT'].since)}: quality`))).toBe(true);
    expect(Object.values(Object.fromEntries(block(r, 'downtime', 'kv').rows)).join(' ')).not.toContain('not confirmed');
  });

  it('fresh feeds: no stale mark on the figures or in the summary of the OEE and shift reports', () => {
    for (const type of ['oee', 'shift'] as const) {
      const r = buildOpsReport(plain, type, { period: 'shift' });
      // Event titles and recommendations are records, not figures: only the figure sections are checked.
      const figures = r.sections.filter((x) => x.id !== 'events' && x.id !== 'actions');
      expect(strings([r.summary, figures]).join(' '), type).not.toMatch(/not confirmed/i);
    }
  });
});

describe('shift report text and stage-flow table follow the same rule', () => {
  it('sorting feed stale: output vs plan is "not confirmed" in the summary and the SORT row is marked', () => {
    const r = buildOpsReport(sortStale, 'shift', { period: 'shift' });
    const since = formatClock(sortStale.feeds['I-SORT'].since);
    expect(r.summary).toMatch(new RegExp(`^Output vs plan not confirmed — sorting data stale since ${since} \\(simulated running total [\\d,]+ m² of [\\d,]+ m² planned to date\\)`));
    const sortRow = block(r, 'flow', 'table').rows.find((row) => typeof row[0] !== 'string' && row[0].stage === 'SORT')!;
    expect(sortRow[1]).toMatch(/ tiles · not confirmed$/);
    expect(texts(r, 'flow').some((t) => t.startsWith(`Sorting & inspection: Not confirmed · sorting data stale since ${since}`))).toBe(true);
  });
});

describe('incident report "Operational context" uses the KPI models and their stale status', () => {
  const lineNow = (s: SimState) => {
    const ev = [...s.events].reverse().find((e) => !e.historical) ?? s.events.at(-1)!;
    const r = buildEventReport(s, ev.id)!;
    return { r, rows: Object.fromEntries(r.context.lineNow.map((x) => [x.label, String(x.value)])) };
  };

  it('fresh feeds: the Line OEE and Good output cards\' values, unmarked', () => {
    const p = resolvePeriod('shift', plain.minute);
    const { rows } = lineNow(plain);
    const oee = factoryOeeKpi(plain, p);
    const good = goodOutputKpi(plain, p);
    expect(rows['Line OEE (shift to date)']).toBe(`${oee.display} %`);
    expect(rows['Output vs plan (shift to date)']).toBe(`${good.display} m² · ${good.target}`);
  });

  it('kiln feed stale: Line OEE carries the card\'s "not confirmed" mark (in-app and PDF model)', () => {
    const p = resolvePeriod('shift', kilnStale.minute);
    const { r, rows } = lineNow(kilnStale);
    const oee = factoryOeeKpi(kilnStale, p);
    expect(oee.provenance).toBe('stale');
    expect(rows['Line OEE (shift to date)']).toBe(`${oee.display} % — ${low1(oee.status!.label)}`);
    expect(rows['Line OEE (shift to date)']).toContain(`not confirmed · kiln data stale since ${formatClock(kilnStale.feeds['H-KILN'].since)}`);
    expect(rows['Output vs plan (shift to date)']).not.toContain('not confirmed');
    // The PDF model is sanitised for WinAnsi fonts (— is printed as -).
    expect(strings(eventPdfModel(r)).some((t) => t.includes(pdfText(`${oee.display} % — not confirmed · kiln data stale since`)))).toBe(true);
  });

  it('sorting feed stale: Output vs plan and Line OEE are marked "not confirmed · sorting data stale since hh:mm"', () => {
    const p = resolvePeriod('shift', sortStale.minute);
    const { rows } = lineNow(sortStale);
    const good = goodOutputKpi(sortStale, p);
    const mark = `not confirmed · sorting data stale since ${formatClock(sortStale.feeds['I-SORT'].since)}`;
    expect(rows['Output vs plan (shift to date)']).toBe(`${good.display} m² · ${good.target} — ${mark}`);
    expect(rows['Line OEE (shift to date)']).toContain(mark);
  });
});

describe('stage shift report: "Since" prints the date when it is another plant day', () => {
  it('a stop that began before midnight shows its day; a stale feed shows when its state became unknown', () => {
    // 23:30 on the third day: stop E-PRS1 and lose E-PRS2's feed, then run past midnight.
    const s = createSim(DEFAULT_SEED, 2 * 1440 + 23 * 60 + 30);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS1', end: null, label: 'Press 1 stop' });
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'Press 2 feed lost' });
    advance(s, s.minute + 60);
    const p = resolvePeriod('shift', s.minute);
    const rows = Object.fromEntries(equipmentRows(s, 'PRESS', p).map((r) => [r[0], r]));
    const m1 = s.machines['E-PRS1'];
    expect(Math.floor(m1.since / 1440)).toBeLessThan(Math.floor(s.minute / 1440));
    expect(rows['E-PRS1'][3]).toBe(formatDateTime(m1.since));
    expect(rows['E-PRS1'][3]).not.toBe(formatClock(m1.since));
    // The stale feed: one "Unknown (data stale)" (not doubled), since the feed went stale, figures not confirmed.
    const f = s.feeds['E-PRS2'];
    expect(f.status).toBe('stale');
    expect(rows['E-PRS2'][2]).toBe(OPERATIONAL_STATE_LABEL.unknown);
    expect(rows['E-PRS2'][3]).toBe(formatDateTime(f.since));
    expect(rows['E-PRS2'][4]).toMatch(/ · not confirmed$/);
    // The stage shift summary (PDF) prints the same dated times (the model is WinAnsi-sanitised: – stays readable as -).
    const model = stageShiftModel(s, 'PRESS')!;
    const eq = model.sections.find((x) => x.title === 'Equipment states')!.blocks.find((b) => b.kind === 'table') as { rows: string[][] } | undefined;
    const pdfRows = Object.fromEntries((eq?.rows ?? []).map((r) => [r[0], r]));
    expect(pdfRows['E-PRS1'][3]).toBe(pdfText(formatDateTime(m1.since)));
    expect(pdfRows['E-PRS2'][4]).toBe(pdfText(`Stale since ${formatDateTime(f.since)}`));
    // A state that began today prints the clock time only.
    const today = equipmentRows(plain, 'PRESS', resolvePeriod('shift', plain.minute));
    for (const r of today) {
      const m = plain.machines[r[0]];
      if (m && Math.floor(m.since / 1440) === Math.floor(plain.minute / 1440)) expect(r[3]).toBe(formatClock(m.since));
    }
  });
});
