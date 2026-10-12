/**
 * Operational reports: each report model's KPIs are exactly the src/intel/kpis.ts values for the
 * chosen period (so a report never disagrees with the app), the significant events are real event
 * records of the period, scopes filter as stated, every PDF string is WinAnsi-safe, and every report
 * type renders to a real multi-section PDF document in node.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { constraintDowntimeKpi, factoryOeeKpi, firstPassQualityKpi, fleetKpis, goodOutputKpi, productionKpis, qualityKpis, targetAttainmentKpi } from '../../intel/kpis';
import { buildEventReport } from '../../intel/report';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { eventById, eventInMonitoredStage } from '../../sim/events';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import { assumptionList, DEFAULT_FINANCE } from '../../sim/finance';
import { lineMetrics, resolvePeriod } from '../../sim/metrics';
import { buildEventPdf, buildOpsPdf, type PdfLib } from '../build';
import { ASSUMPTIONS_LOCATION, fmtMoney } from '../format';
import { REPORT_PERIODS, REPORT_TYPES, buildOpsReport, effectiveScope, type OpsReport, type OpsReportType, type ReportBlock, type ReportPeriodKey } from '../ops';
import { EVENT_PREVIEW_ROWS } from '../ops/common';
import { opsPdfModel } from '../ops/pdf';
import { overlapsPeriod } from '../ops/select';
import type { AutoTableFn } from '../render';
import { isWinAnsiSafe, pdfText } from '../text';

/** A string as it appears inside a PDF text literal. */
const lit = (t: string) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const lib: PdfLib = { jsPDF, autoTable: autoTable as unknown as AutoTableFn };
const OPS: OpsReportType[] = ['shift', 'oee', 'quality', 'fleet'];

/** The KPI set each report type shows, straight from kpis.ts. */
function expectedKpis(s: SimState, type: OpsReportType, key: ReportPeriodKey) {
  const p = resolvePeriod(key, s.minute);
  const lm = lineMetrics(s, p);
  switch (type) {
    case 'shift':
      return productionKpis(s, p);
    case 'oee':
      return [factoryOeeKpi(s, p, lm), constraintDowntimeKpi(s, p, lm), firstPassQualityKpi(s, p), targetAttainmentKpi(s, p, lm), goodOutputKpi(s, p, lm)];
    case 'quality':
      return qualityKpis(s, p);
    case 'fleet':
      return fleetKpis(s, p);
  }
}

const strip = (r: OpsReport) => r.kpis.map(({ basis, ...k }) => (void basis, k));

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'dataUrl') strings(x, out);
  return out;
}

let s: SimState;

beforeAll(() => {
  s = createSim(51, 3 * 1440 + 600);
  s.liveFrom = s.minute;
  const t0 = s.minute;
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 35, label: 'Kiln infeed belt stop' });
  activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: t0 + 120, label: 'Glaze deterioration' });
  activateScenario(s, { kind: 'yard-congestion', count: 7, end: null, label: 'Yard congestion' });
  advance(s, t0 + 150);
  // Pre-rolling three simulated days takes a few seconds on a busy machine.
}, 120_000);

/** The significant-events table of a report section. */
const eventTable = (r: OpsReport) => {
  const sec = r.sections.find((x) => x.id === 'events')!;
  const t = sec.blocks.find((b): b is Extract<ReportBlock, { kind: 'table' }> => b.kind === 'table')!;
  return { sec, t };
};

describe('report models use the app KPIs for the chosen period', () => {
  for (const type of OPS)
    for (const key of REPORT_PERIODS)
      it(`${type} · ${key}`, () => {
        const r = buildOpsReport(s, type, { period: key, generatedAt: '2026-10-11T08:00:00.000Z' });
        expect(strip(r)).toEqual(expectedKpis(s, type, key));
        const p = resolvePeriod(key, s.minute);
        expect(r.period).toMatchObject({ key, from: p.from, to: p.to });
        expect(r.kpis.length).toBeGreaterThan(0);
        expect(r.kpis.length).toBeLessThanOrEqual(5);
        // The KPI block of the first section is the same list.
        const first = r.sections[0].blocks.find((b) => b.kind === 'kpis');
        expect(first && first.kind === 'kpis' ? first.items : null).toEqual(r.kpis);
      });

  it('keeps line KPIs (as context) when scoped to a stage', () => {
    const r = buildOpsReport(s, 'shift', { period: 'shift', scope: 'KILN' });
    expect(r.scope.id).toBe('KILN');
    expect(strip(r)).toEqual(expectedKpis(s, 'shift', 'shift'));
    expect(r.sections[0].title).toMatch(/context/);
  });
});

describe('report contents', () => {
  it('lists real root events of the period, most severe first, within the scope', () => {
    const p = resolvePeriod('shift', s.minute);
    for (const type of OPS) {
      const r = buildOpsReport(s, type, { period: 'shift' });
      for (const row of r.events) {
        const ev = eventById(s, row.id)!;
        expect(ev).toBeDefined();
        expect(ev.consequenceOf).toBeUndefined();
        expect(ev.start).toBeLessThanOrEqual(s.minute);
        expect(ev.end ?? s.minute).toBeGreaterThanOrEqual(p.from);
        expect(overlapsPeriod(ev, p, s.minute)).toBe(true);
      }
      const rank = { info: 0, warning: 1, serious: 2, critical: 3 } as const;
      for (let i = 1; i < r.events.length; i++) expect(rank[r.events[i - 1].severity]).toBeGreaterThanOrEqual(rank[r.events[i].severity]);
    }
    const shift = buildOpsReport(s, 'shift', { period: 'shift' });
    expect(shift.events.some((e) => e.title.toLowerCase().includes('kiln') || e.where.includes('CV-KIN'))).toBe(true);
    const kiln = buildOpsReport(s, 'shift', { period: 'shift', scope: 'KILN' });
    for (const row of kiln.events) expect(eventInMonitoredStage(MONITORED_STAGE_BY_ID.KILN, eventById(s, row.id)!)).toBe(true);
    const fleet = buildOpsReport(s, 'fleet', { period: 'shift' });
    expect(fleet.events.every((e) => e.category === 'logistics')).toBe(true);
    const quality = buildOpsReport(s, 'quality', { period: 'shift' });
    expect(quality.events.every((e) => e.category === 'quality')).toBe(true);
    expect(quality.events.length).toBeGreaterThan(0);
  });

  it('supports the scopes each type states, and falls back to the whole line otherwise', () => {
    for (const def of REPORT_TYPES) {
      if (def.id === 'incident') continue;
      for (const sc of def.scopes) expect(buildOpsReport(s, def.id, { period: 'shift', scope: sc }).scope.id).toBe(sc);
    }
    expect(effectiveScope('fleet', 'KILN')).toBe('line');
    expect(buildOpsReport(s, 'quality', { period: 'shift', scope: 'WH' }).scope.id).toBe('line');
    const glaze = buildOpsReport(s, 'quality', { period: 'shift', scope: 'GLAZE' });
    const defects = glaze.sections.find((x) => x.id === 'defects')!;
    const table = defects.blocks.find((b) => b.kind === 'table');
    expect(table && table.kind === 'table' ? table.rows.map((r) => r[6]) : []).toEqual(expect.arrayContaining(['Glazing']));
  });

  it('has a summary, actions, a legend of the four kinds of information and a dated file name', () => {
    for (const type of OPS) {
      const r = buildOpsReport(s, type, { period: '24h' });
      expect(r.summary.length).toBeGreaterThan(20);
      expect(r.sections.some((x) => x.id === 'actions')).toBe(true);
      expect(r.legend.map((l) => l.basis)).toEqual(['measured', 'simulated', 'estimated', 'illustrative']);
      expect(r.fileName).toMatch(new RegExp(`^wAI-report-${type}-line-24h-\\d{4}-\\d\\d-\\d\\d\\.pdf$`));
    }
  });

  it('only puts WinAnsi-safe text into the PDF model', () => {
    const bad: string[] = [];
    for (const type of OPS)
      for (const key of REPORT_PERIODS) for (const t of strings(opsPdfModel(buildOpsReport(s, type, { period: key })))) if (!isWinAnsiSafe(t)) bad.push(`${type}/${key}: ${t}`);
    expect(bad).toEqual([]);
    // …and no character of the model is replaced by the "?" placeholder (every symbol used has a mapping).
    const lost: string[] = [];
    for (const type of OPS) for (const t of strings(buildOpsReport(s, type, { period: '24h' }))) if (pdfText(t).includes('?') && !t.includes('?')) lost.push(`${type}: ${t}`);
    expect(lost).toEqual([]);
  });
});

describe('every significant event is listed, and the totals add up over the rows listed (#0, #23)', () => {
  it('the table holds every event of the report — the preview shows the first rows with "Show all", the PDF prints them all', () => {
    for (const type of OPS) {
      const r = buildOpsReport(s, type, { period: '7d' });
      const { sec, t } = eventTable(r);
      expect(t.rows.length, type).toBe(r.events.length);
      expect(t.rows.map((row) => (typeof row[0] === 'string' ? row[0] : row[0].text))).toEqual(r.events.map((e) => e.id));
      expect(t.collapseAfter).toBe(EVENT_PREVIEW_ROWS);
      // No "N more … listed elsewhere" line any more; the in-app link to the Events tab carries the report's query.
      expect(JSON.stringify(sec.blocks)).not.toMatch(/more significant event/);
      const link = sec.blocks.find((b) => b.kind === 'events-link');
      if (r.events.length) expect(link).toEqual({ kind: 'events-link', count: r.events.length, query: r.eventQuery });
      expect(r.eventQuery.period).toBe('7d');
      // The PDF model keeps every row and prints no in-app link.
      const pdfTable = opsPdfModel(r).sections.find((x) => x.title === sec.title)!.blocks.find((b) => b.kind === 'table');
      expect(pdfTable && pdfTable.kind === 'table' ? pdfTable.rows.length : -1).toBe(r.events.length);
    }
    // The 7-day period of this state has more significant events than the preview shows at first.
    expect(buildOpsReport(s, 'shift', { period: '7d' }).events.length).toBeGreaterThan(EVENT_PREVIEW_ROWS);
  });

  it('prints every event id of a long 7-day report, the table continuing across pages', () => {
    const r = buildOpsReport(s, 'shift', { period: '7d' });
    expect(r.events.length).toBeGreaterThan(EVENT_PREVIEW_ROWS);
    const { doc } = buildOpsPdf(lib, r, { compress: false });
    const raw = doc.output();
    const missing = r.events.filter((e) => !raw.includes(lit(e.id))).map((e) => e.id);
    expect(missing).toEqual([]);
    expect(raw).not.toContain('listed in Events & Reports');
    // The header fact counts the same events the table lists.
    expect(raw).toContain(`${r.events.length} significant events`);
  });

  it('shift: "Estimated cost of these events" is the sum of the Estimate column of the root production rows listed', () => {
    for (const scope of ['line', 'KILN'] as const) {
      const r = buildOpsReport(s, 'shift', { period: '7d', scope });
      const sec = r.sections.find((x) => x.id === 'events')!;
      const total = sec.blocks.find((b) => b.kind === 'total');
      if (!total || total.kind !== 'total') continue;
      const sum = r.events.filter((e) => e.category !== 'quality').reduce((a, e) => a + (e.estimate ?? 0), 0);
      const priced = r.events.filter((e) => e.category !== 'quality' && e.estimate != null).length;
      expect(total.value).toBe(fmtMoney(r.currency, sum));
      expect(total.note).toContain(`Sum of the ${priced} estimate`);
      expect(total.note).toContain(`${r.events.length} event${r.events.length === 1 ? '' : 's'} listed above`);
    }
  });

  it('oee: the kiln minutes and the "with a cost estimate" count cover exactly the rows listed', () => {
    const r = buildOpsReport(s, 'oee', { period: '7d' });
    const sec = r.sections.find((x) => x.id === 'events')!;
    const kv = sec.blocks.find((b) => b.kind === 'kv');
    expect(kv && kv.kind === 'kv' ? kv.rows.find(([k]) => k === 'Events with a cost estimate')?.[1] : null).toBe(`${r.events.filter((e) => e.estimate != null).length} of ${r.events.length}`);
    const total = sec.blocks.find((b) => b.kind === 'total');
    if (total && total.kind === 'total') {
      const sum = r.events.reduce((a, e) => a + (e.estimate ?? 0), 0);
      expect(total.value).toBe(fmtMoney(r.currency, sum));
    }
  });

  it('fleet: the detention total sums the truck-waiting rows listed', () => {
    const r = buildOpsReport(s, 'fleet', { period: '7d' });
    const sec = r.sections.find((x) => x.id === 'events')!;
    const total = sec.blocks.find((b) => b.kind === 'total');
    if (!total || total.kind !== 'total') return;
    const waiting = r.events.filter((e) => eventById(s, e.id)!.type === 'truck-waiting');
    const sum = waiting.reduce((a, e) => a + (e.estimate ?? 0), 0);
    expect(total.value).toBe(fmtMoney(r.currency, sum));
    expect(total.note).toContain(`Sum over the ${waiting.length} truck-waiting event`);
  });
});

describe('previous shift (#1)', () => {
  it('is a report period: the completed shift, labelled as such, not "to date"', () => {
    expect(REPORT_PERIODS).toContain('prev-shift');
    const p = resolvePeriod('prev-shift', s.minute);
    for (const type of OPS) {
      const r = buildOpsReport(s, type, { period: 'prev-shift' });
      expect(r.period).toMatchObject({ key: 'prev-shift', from: p.from, to: p.to });
      expect(r.period.to).toBeLessThan(s.minute);
      expect(r.period.label).toBe(`Previous shift · ${p.label}`);
      expect(r.period.text).not.toMatch(/to date/);
      expect(r.fileName).toMatch(/-prev-shift-/);
      // Events of the completed shift only: none started after it ended.
      for (const row of r.events) expect(row.start).toBeLessThan(p.to);
    }
    const { doc } = buildOpsPdf(lib, buildOpsReport(s, 'shift', { period: 'prev-shift' }), { compress: false });
    expect(doc.output()).toContain('Previous shift');
  });
});

describe('fleet detention estimate points to where its assumption is edited (#6)', () => {
  it('names Production → Analysis → Assumptions & what-ifs, as the assumption list does', () => {
    expect(assumptionList(DEFAULT_FINANCE).join(' ')).toContain(ASSUMPTIONS_LOCATION);
    const r = buildOpsReport(s, 'fleet', { period: '7d' });
    const all = JSON.stringify(r);
    expect(all).not.toContain('OEE & losses');
    const total = r.sections.find((x) => x.id === 'events')!.blocks.find((b) => b.kind === 'total');
    if (total && total.kind === 'total') expect(total.note).toContain(`editable in ${ASSUMPTIONS_LOCATION}`);
  });
});

describe('incident report operational context (#24)', () => {
  it('labels plan to date as such, with the same figures and wording as the Good output KPI', () => {
    const ev = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-KIN' && !e.historical)!;
    const r = buildEventReport(s, ev.id)!;
    const row = r.context.lineNow.find((x) => /^Output vs/.test(x.label))!;
    expect(row.label).toBe('Output vs plan (shift to date)');
    const k = goodOutputKpi(s, resolvePeriod('shift', s.minute));
    expect(row.value).toBe(`${k.display} m² · ${k.target}`);
    expect(String(row.value)).toMatch(/Plan to date [\d,]+ m² · shift [\d,]+ m²/);
    expect(r.context.lineNow.map((x) => x.label)).not.toContain('Output vs target (shift)');
  });
});

describe('PDF documents of every report type (node)', () => {
  for (const type of OPS)
    it(`${type}: non-empty multi-section PDF with header, period, scope and SIMULATED marker`, () => {
      const r = buildOpsReport(s, type, { period: 'shift', generatedAt: '2026-10-11T08:00:00.000Z' });
      const { doc, model } = buildOpsPdf(lib, r, { compress: false });
      const bytes = new Uint8Array(doc.output('arraybuffer'));
      expect(bytes.length).toBeGreaterThan(5000);
      expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
      expect(model.sections.length).toBe(r.sections.length + 1);
      expect(model.sections.length).toBeGreaterThanOrEqual(5);
      const raw = doc.output();
      const pages = doc.getNumberOfPages();
      expect(pages).toBeGreaterThan(0);
      expect(raw.split('SIMULATED DATA').length - 1).toBeGreaterThanOrEqual(pages);
      expect(raw).toContain(`Page ${pages} of ${pages}`);
      expect(raw).toContain(r.typeLabel);
      for (const sec of model.sections.slice(0, 3)) expect(raw).toContain(lit(`${sec.num}   ${sec.title}`.slice(0, 20)));
      // KPI values of the model are printed.
      for (const k of r.kpis) if (!k.unavailable) expect(raw).toContain(lit(pdfText(k.display)));
    });

  it('incident investigation: the per-event PDF', () => {
    const ev = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-KIN' && !e.historical)!;
    const out = buildEventPdf(lib, s, ev.id, { compress: false })!;
    const bytes = new Uint8Array(out.doc.output('arraybuffer'));
    expect(bytes.length).toBeGreaterThan(5000);
    expect(out.model.sections.length).toBe(12);
    expect(out.doc.output()).toContain(ev.id);
  });

  it('paginates a long 7-day report', () => {
    const r = buildOpsReport(s, 'shift', { period: '7d' });
    const { doc } = buildOpsPdf(lib, r, { compress: false });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const raw = doc.output();
    expect(raw).toContain(`Page 1 of ${doc.getNumberOfPages()}`);
  });
});
