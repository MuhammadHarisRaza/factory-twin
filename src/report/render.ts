/**
 * Draws a PdfDocModel (model.ts) with jsPDF + jspdf-autotable on A4 portrait.
 *
 * Layout: graphite header band on every page (product name, document type and id, generation time
 * in wall clock and plant time, "SIMULATED DATA" marker), numbered sections, tables through
 * autoTable (wrapped cells, rows kept whole, header repeated on every page), images scaled to fit
 * with captions and provenance, explicit "Not available — reason" boxes, small line charts drawn
 * with jsPDF lines, and a footer with the disclaimer and "Page n of N".
 *
 * Works in the browser and in node (tests) — it only needs a jsPDF instance and autoTable.
 */
import type { jsPDF } from 'jspdf';
import type { UserOptions } from 'jspdf-autotable';
import { axisFormat } from './format';
import { A4, LAYOUT, chartRange, columnWidth, contentHeight, contentWidth, fitBox, labelIndices, lineHeightMm, pageLabel, placeBlock, splitLines } from './layout';
import { PRODUCT_NAME, type PdfBlock, type PdfChart, type PdfDocModel, type PdfFigure, type PdfSection } from './model';
import { pdfText } from './text';

export type AutoTableFn = (doc: jsPDF, options: UserOptions) => void;

type RGB = [number, number, number];
const C: Record<string, RGB> = {
  ink: [24, 30, 36],
  text: [48, 56, 64],
  muted: [102, 112, 122],
  line: [208, 214, 219],
  fill: [245, 247, 248],
  head: [232, 236, 239],
  band: [20, 25, 30],
  bandText: [231, 235, 238],
  bandMuted: [160, 171, 181],
  accent: [64, 140, 168],
  amber: [250, 178, 25],
  s1: [57, 135, 229],
  s2: [120, 130, 140],
  limit: [86, 94, 102],
  grid: [229, 233, 236],
};

const BODY_PT = 8.5;
const SMALL_PT = 7;
const SECTION_HEAD_H = 9;
const SUBHEAD_H = 6.5;
const CHART_H = 46;

class Renderer {
  y = LAYOUT.top;
  readonly cw = contentWidth();
  readonly x0 = LAYOUT.ml;

  constructor(
    private doc: jsPDF,
    private autoTable: AutoTableFn,
    private m: PdfDocModel,
  ) {}

  // ── primitives ──
  private font(pt: number, style: 'normal' | 'bold' | 'italic' = 'normal', color: RGB = C.text) {
    this.doc.setFont('helvetica', style);
    this.doc.setFontSize(pt);
    this.doc.setTextColor(color[0], color[1], color[2]);
  }
  private split(text: string, width: number): string[] {
    return this.doc.splitTextToSize(pdfText(text), width) as string[];
  }
  private newPage() {
    this.doc.addPage();
    this.y = LAYOUT.top;
  }
  private ensure(need: number) {
    const p = placeBlock(this.y, need);
    if (p.newPage) this.newPage();
  }
  /** Writes wrapped lines from the current y at x, breaking pages between lines. */
  private lines(lines: string[], x: number, pt: number) {
    const lh = lineHeightMm(pt);
    const { chunks } = splitLines(lines.length, lh, this.y);
    let page = 0;
    for (const ch of chunks) {
      while (page < ch.page) {
        this.newPage();
        page++;
      }
      for (let i = ch.from; i < ch.to; i++) this.doc.text(lines[i], x, ch.y + (i - ch.from) * lh + lh * 0.72);
      this.y = ch.y + (ch.to - ch.from) * lh;
    }
  }
  private fill(c: RGB) {
    this.doc.setFillColor(c[0], c[1], c[2]);
  }
  private stroke(c: RGB, w = 0.2) {
    this.doc.setDrawColor(c[0], c[1], c[2]);
    this.doc.setLineWidth(w);
  }
  private lastTableY() {
    return (this.doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? this.y;
  }
  private tableBase(): UserOptions {
    return {
      startY: this.y,
      margin: { top: LAYOUT.top, bottom: A4.h - LAYOUT.bottom, left: LAYOUT.ml, right: LAYOUT.mr },
      rowPageBreak: 'avoid',
      showHead: 'everyPage',
      pageBreak: 'auto',
    };
  }

  // ── document parts ──
  titleBlock() {
    const m = this.m;
    this.font(7.5, 'bold', C.accent);
    this.doc.text(pdfText(`${m.docType.toUpperCase()} · ${m.docId}`), this.x0, this.y + 2.5);
    this.y += 5;
    this.font(15, 'bold', C.ink);
    this.lines(this.split(m.title, this.cw), this.x0, 15);
    this.y += 1;
    if (m.lead) {
      this.font(9, 'normal', C.text);
      this.lines(this.split(m.lead, this.cw), this.x0, 9);
      this.y += 1.5;
    }
    // Fact chips.
    this.font(7.5, 'normal', C.ink);
    let x = this.x0;
    const h = 5;
    for (const f of m.facts) {
      const w = this.doc.getTextWidth(f) + 4;
      if (x + w > this.x0 + this.cw) {
        x = this.x0;
        this.y += h + 1.5;
      }
      this.fill(C.fill);
      this.stroke(C.line, 0.2);
      this.doc.rect(x, this.y, w, h, 'FD');
      this.doc.text(f, x + 2, this.y + 3.4);
      x += w + 2;
    }
    this.y += h + 5;
  }

  section(s: PdfSection) {
    // Keep the heading with the start of its content (and any leading subheads).
    this.ensure(Math.min(contentHeight(), SECTION_HEAD_H + this.leadNeed(s.blocks, 0)));
    const y = this.y + 4;
    this.fill(C.accent);
    this.doc.rect(this.x0, y - 3.7, 1.2, 4.8, 'F');
    this.font(11, 'bold', C.ink);
    this.doc.text(s.num != null ? `${s.num}   ${s.title}` : s.title, this.x0 + 3.4, y);
    if (s.tag) {
      this.font(7.5, 'italic', C.muted);
      this.doc.text(s.tag, this.x0 + this.cw, y, { align: 'right' });
    }
    this.stroke(C.line, 0.25);
    this.doc.line(this.x0, y + 2, this.x0 + this.cw, y + 2);
    this.y = y + 5;
    s.blocks.forEach((b, i) => {
      if (b.kind === 'subhead') this.ensure(Math.min(contentHeight(), SUBHEAD_H + this.leadNeed(s.blocks, i + 1)));
      this.block(b);
    });
    this.y += 2;
  }

  /** Space the block at `i` needs at least on the page where it starts (subheads chain to the next block). */
  private leadNeed(blocks: PdfBlock[], i: number): number {
    const b = blocks[i];
    if (!b) return 0;
    const lh = lineHeightMm(BODY_PT);
    switch (b.kind) {
      case 'subhead':
        return SUBHEAD_H + this.leadNeed(blocks, i + 1);
      case 'text': {
        this.font(BODY_PT, 'normal');
        const h = Math.min(2, this.split(b.text, this.cw).length) * lh + 1.8;
        // A muted line under a subhead is its caption (provenance): keep it with what follows.
        const next = blocks[i + 1];
        return b.tone === 'muted' && next && next.kind !== 'subhead' ? h + this.leadNeed(blocks, i + 1) : h;
      }
      case 'list':
        return Math.min(2, b.items.length) * (lh + 0.7);
      case 'kv':
        return b.rows.length ? 12 : 0;
      case 'table':
        return b.rows.length ? 16 : lh + 2;
      case 'figures':
        return this.figureRows(b.items, b.columns).rows[0]?.h ?? 0;
      case 'charts':
        return CHART_H + 3;
      case 'missing':
        return 16;
      case 'total':
        return 14;
    }
  }

  private block(b: PdfBlock) {
    switch (b.kind) {
      case 'text':
        this.font(BODY_PT, 'normal', b.tone === 'muted' ? C.muted : C.text);
        this.ensure(lineHeightMm(BODY_PT));
        this.lines(this.split(b.text, this.cw), this.x0, BODY_PT);
        this.y += 1.8;
        return;
      case 'subhead':
        this.ensure(13);
        this.font(8.8, 'bold', C.ink);
        this.y += 1;
        this.lines(this.split(b.text, this.cw), this.x0, 8.8);
        this.y += 0.6;
        return;
      case 'list':
        return this.list(b.items, !!b.numbered);
      case 'kv':
        return this.kv(b.rows, b.columns ?? 2);
      case 'table':
        return this.table(b);
      case 'figures':
        return this.figures(b.items, b.columns);
      case 'charts':
        return this.charts(b.items, b.columns);
      case 'missing':
        return this.missing(b.title, b.reason, this.x0, this.cw, true);
      case 'total':
        return this.total(b.label, b.value, b.note);
    }
  }

  private list(items: string[], numbered: boolean) {
    const indent = numbered ? 6 : 4.5;
    const lh = lineHeightMm(BODY_PT);
    items.forEach((item, i) => {
      this.font(BODY_PT, 'normal', C.text);
      const lines = this.split(item, this.cw - indent);
      this.ensure(lh);
      if (numbered) {
        this.font(BODY_PT, 'bold', C.ink);
        this.doc.text(`${i + 1}.`, this.x0, this.y + lh * 0.72);
        this.font(BODY_PT, 'normal', C.text);
      } else {
        this.fill(C.muted);
        this.doc.circle(this.x0 + 1.3, this.y + lh * 0.5, 0.55, 'F');
      }
      this.lines(lines, this.x0 + indent, BODY_PT);
      this.y += 0.7;
    });
    this.y += 1.4;
  }

  private kv(rows: [string, string][], columns: 2 | 4) {
    if (!rows.length) return;
    this.ensure(10);
    const body: string[][] = [];
    if (columns === 4) for (let i = 0; i < rows.length; i += 2) body.push([rows[i][0], rows[i][1], rows[i + 1]?.[0] ?? '', rows[i + 1]?.[1] ?? '']);
    else for (const r of rows) body.push([r[0], r[1]]);
    const labelW = columns === 4 ? 24 : 36;
    const valueW = columns === 4 ? (this.cw - 2 * labelW) / 2 : this.cw - labelW;
    const label = { cellWidth: labelW, fontStyle: 'bold' as const, textColor: C.muted };
    this.autoTable(this.doc, {
      ...this.tableBase(),
      theme: 'plain',
      body: body.map((r) => r.map(pdfText)),
      styles: { fontSize: 8, cellPadding: { top: 1.1, bottom: 1.1, left: 1.6, right: 1.6 }, textColor: C.text, overflow: 'linebreak', valign: 'top' },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      columnStyles: columns === 4 ? { 0: label, 1: { cellWidth: valueW }, 2: label, 3: { cellWidth: valueW } } : { 0: label, 1: { cellWidth: valueW } },
      tableLineColor: C.line,
      tableLineWidth: 0.15,
    });
    this.y = this.lastTableY() + 3;
  }

  private table(b: Extract<PdfBlock, { kind: 'table' }>) {
    if (!b.rows.length) {
      this.font(BODY_PT, 'italic', C.muted);
      this.ensure(lineHeightMm(BODY_PT));
      this.lines(this.split(b.empty ?? 'No rows', this.cw), this.x0, BODY_PT);
      this.y += 2;
      return;
    }
    this.ensure(16);
    const columnStyles: NonNullable<UserOptions['columnStyles']> = {};
    b.widths?.forEach((w, i) => {
      columnStyles[i] = { cellWidth: w === 'auto' ? 'auto' : w };
    });
    this.autoTable(this.doc, {
      ...this.tableBase(),
      theme: 'grid',
      head: [b.head.map(pdfText)],
      body: b.rows.map((r) => r.map(pdfText)),
      styles: { fontSize: 7.6, cellPadding: { top: 1.3, bottom: 1.3, left: 1.5, right: 1.5 }, lineColor: C.line, lineWidth: 0.15, textColor: C.text, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: C.head, textColor: C.ink, fontStyle: 'bold', fontSize: 7.4 },
      columnStyles,
      tableWidth: this.cw,
    });
    this.y = this.lastTableY() + 3;
  }

  private missing(title: string, reason: string, x: number, w: number, advance: boolean, h?: number) {
    this.font(7.6, 'normal', C.text);
    const lines = this.split(`Not available — ${reason}`, w - 6);
    const lh = lineHeightMm(7.6);
    const boxH = h ?? 4 + (title ? lh : 0) + lines.length * lh + 2;
    if (advance) this.ensure(boxH + 2);
    const y = this.y;
    this.fill(C.fill);
    this.stroke(C.muted, 0.25);
    this.doc.setLineDashPattern([1.2, 0.9], 0);
    this.doc.rect(x, y, w, boxH, 'FD');
    this.doc.setLineDashPattern([], 0);
    let ty = y + 2.2;
    if (title) {
      this.font(7.6, 'bold', C.ink);
      const t = this.split(title, w - 6)[0] ?? '';
      this.doc.text(t, x + 3, ty + lh * 0.72);
      ty += lh;
    }
    this.font(7.6, 'normal', C.text);
    lines.forEach((l, i) => this.doc.text(l, x + 3, ty + i * lh + lh * 0.72));
    if (advance) this.y = y + boxH + 3;
    return boxH;
  }

  private total(label: string, value: string, note?: string) {
    this.ensure(14);
    const y = this.y;
    this.fill(C.head);
    this.doc.rect(this.x0, y, this.cw, 7.5, 'F');
    this.font(9, 'bold', C.ink);
    this.doc.text(pdfText(label), this.x0 + 2, y + 5);
    this.doc.text(pdfText(value), this.x0 + this.cw - 2, y + 5, { align: 'right' });
    this.y = y + 9;
    if (note) {
      this.font(7.4, 'italic', C.muted);
      this.lines(this.split(note, this.cw), this.x0, 7.4);
    }
    this.y += 2;
  }

  /** Measures figure rows: wrapped titles and captions, fitted image boxes, row heights. */
  private figureRows(items: PdfFigure[], columns: number) {
    const cols = Math.max(1, Math.min(columns, items.length || 1));
    const gap = 4;
    const w = columnWidth(this.cw, cols, gap);
    const lhT = lineHeightMm(7.6);
    const lhC = lineHeightMm(SMALL_PT);
    const rows: { cells: { f: PdfFigure; title: string[]; caption: string[]; img: { w: number; h: number } | null; missH: number; h: number }[]; h: number }[] = [];
    for (let r = 0; r < items.length; r += cols) {
      const cells = items.slice(r, r + cols).map((f) => {
        this.font(7.6, 'bold', C.ink);
        const title = this.split(f.title, w);
        this.font(SMALL_PT, 'normal', C.muted);
        const caption = f.caption.flatMap((c) => this.split(c, w));
        const img = f.image ? fitBox(f.image.width, f.image.height, w, f.maxH) : null;
        const missH = cols === 1 ? 18 : Math.min(f.maxH, w * 0.75);
        const h = title.length * lhT + 1 + (img ? img.h : missH) + 1.5 + caption.length * lhC;
        return { f, title, caption, img, missH, h };
      });
      rows.push({ cells, h: Math.max(...cells.map((c) => c.h)) + 2 });
    }
    return { rows, w, gap, lhT, lhC };
  }

  private figures(items: PdfFigure[], columns: number) {
    const { rows, w, gap, lhT, lhC } = this.figureRows(items, columns);
    for (const { cells, h } of rows) {
      const rowH = h - 2;
      this.ensure(h);
      const y0 = this.y;
      cells.forEach((c, i) => {
        const x = this.x0 + i * (w + gap);
        let y = y0;
        this.font(7.6, 'bold', C.ink);
        c.title.forEach((l, k) => this.doc.text(l, x, y + k * lhT + lhT * 0.72));
        y += c.title.length * lhT + 1;
        let drawn = false;
        if (c.f.image && c.img) {
          try {
            this.doc.addImage(c.f.image.dataUrl, c.f.image.format, x, y, c.img.w, c.img.h);
            this.stroke(C.line, 0.2);
            this.doc.rect(x, y, c.img.w, c.img.h, 'S');
            drawn = true;
            y += c.img.h;
          } catch {
            drawn = false;
          }
        }
        if (!drawn) {
          const saved = this.y;
          this.y = y;
          const h = this.missing('', c.f.missing ?? (c.f.image ? 'The image could not be embedded in the PDF' : 'No image'), x, w, false, c.missH);
          this.y = saved;
          y += h;
        }
        y += 1.5;
        this.font(SMALL_PT, 'normal', C.muted);
        c.caption.forEach((l, k) => this.doc.text(l, x, y + k * lhC + lhC * 0.72));
      });
      this.y = y0 + rowH + 3;
    }
  }

  private charts(items: PdfChart[], columns: number) {
    const cols = Math.max(1, Math.min(columns, items.length || 1));
    const gap = 6;
    const w = columnWidth(this.cw, cols, gap);
    const h = CHART_H;
    for (let r = 0; r < items.length; r += cols) {
      const row = items.slice(r, r + cols);
      this.ensure(h + 2);
      row.forEach((c, i) => this.chart(c, this.x0 + i * (w + gap), this.y, w, h, cols === 1 ? 7 : 4));
      this.y += h + 3;
    }
  }

  private chart(c: PdfChart, x: number, y: number, w: number, h: number, maxLabels: number) {
    const doc = this.doc;
    this.font(7.6, 'bold', C.ink);
    doc.text(pdfText(`${c.title} (${c.unit})`), x, y + 3);
    // Legend (two or more series only).
    if (c.series.length > 1) {
      this.font(6.4, 'normal', C.muted);
      let lx = x + w;
      for (const sr of [...c.series].reverse()) {
        const tw = doc.getTextWidth(pdfText(sr.label));
        lx -= tw;
        doc.text(pdfText(sr.label), lx, y + 3);
        lx -= 6;
        const col = sr.dashed ? C.s2 : C.s1;
        this.stroke(col, 0.5);
        if (sr.dashed) doc.setLineDashPattern([1, 0.8], 0);
        doc.line(lx, y + 2.1, lx + 4.5, y + 2.1);
        doc.setLineDashPattern([], 0);
        lx -= 3;
      }
    }
    const range = chartRange(
      c.series.map((s) => s.values),
      c.limit?.value,
    );
    const px0 = x + 12;
    const px1 = x + w - 1;
    const py0 = y + 7;
    const py1 = y + h - 7;
    if (!range) {
      const saved = this.y;
      this.y = py0;
      this.missing('', 'No samples in the window — chart omitted', x, w, false, py1 - py0);
      this.y = saved;
      return;
    }
    const yAt = (v: number) => py1 - ((v - range.lo) / (range.hi - range.lo)) * (py1 - py0);
    const fmt = axisFormat(Math.max(Math.abs(range.hi), Math.abs(range.lo)));
    this.font(6, 'normal', C.muted);
    for (const t of range.ticks) {
      const yy = yAt(t);
      this.stroke(C.grid, 0.15);
      doc.line(px0, yy, px1, yy);
      doc.text(fmt(t), px0 - 1.2, yy + 1, { align: 'right' });
    }
    this.stroke(C.line, 0.3);
    doc.line(px0, yAt(Math.max(range.lo, 0)), px1, yAt(Math.max(range.lo, 0)));
    // Limit.
    if (c.limit) {
      const yy = yAt(c.limit.value);
      this.stroke(C.limit, 0.3);
      doc.setLineDashPattern([1.4, 1], 0);
      doc.line(px0, yy, px1, yy);
      doc.setLineDashPattern([], 0);
      this.font(5.8, 'normal', C.limit);
      doc.text(pdfText(c.limit.label), px1, yy - 0.9, { align: 'right' });
    }
    // Series.
    for (const sr of c.series) {
      const n = sr.values.length;
      const xAt = (i: number) => px0 + (n > 1 ? i / (n - 1) : 0.5) * (px1 - px0);
      this.stroke(sr.dashed ? C.s2 : C.s1, sr.dashed ? 0.35 : 0.45);
      if (sr.dashed) doc.setLineDashPattern([1, 0.8], 0);
      let prev: [number, number] | null = null;
      sr.values.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) {
          prev = null;
          return;
        }
        const pt: [number, number] = [xAt(i), yAt(v)];
        if (prev) doc.line(prev[0], prev[1], pt[0], pt[1]);
        else if (sr.values[i + 1] == null) doc.circle(pt[0], pt[1], 0.35, 'F');
        prev = pt;
      });
      doc.setLineDashPattern([], 0);
    }
    // X labels.
    this.font(6, 'normal', C.muted);
    const n = c.xLabels.length;
    for (const i of labelIndices(n, maxLabels)) {
      const xx = px0 + (n > 1 ? i / (n - 1) : 0.5) * (px1 - px0);
      doc.text(pdfText(c.xLabels[i]), xx, py1 + 3.6, { align: i === 0 ? 'left' : i === n - 1 ? 'right' : 'center' });
    }
  }

  // ── page furniture (drawn last, when the page count is known) ──
  furniture() {
    const doc = this.doc;
    const total = doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      // Header band.
      this.fill(C.band);
      doc.rect(0, 0, A4.w, LAYOUT.headerH, 'F');
      this.fill(C.accent);
      doc.rect(0, LAYOUT.headerH, A4.w, 0.6, 'F');
      this.font(10, 'bold', C.bandText);
      doc.text(PRODUCT_NAME, LAYOUT.ml, 8.2);
      this.font(8.5, 'normal', C.bandText);
      doc.text(pdfText(`${this.m.docType} · ${this.m.docId}`), LAYOUT.ml, 13.4);
      this.font(6.6, 'normal', C.bandMuted);
      doc.text(pdfText(`Generated ${this.m.generatedAt} (wall clock) · ${this.m.generatedAtPlant}`), LAYOUT.ml, 17.8);
      // SIMULATED DATA marker.
      this.font(7.4, 'bold', C.band);
      const label = 'SIMULATED DATA';
      const pw = doc.getTextWidth(label) + 6;
      const px = A4.w - LAYOUT.mr - pw;
      this.fill(C.amber);
      doc.rect(px, 4.6, pw, 5.6, 'F');
      doc.text(label, px + 3, 8.5);
      this.font(6.6, 'normal', C.bandMuted);
      doc.text('Demonstration · no live plant data', A4.w - LAYOUT.mr, 14.2, { align: 'right' });
      // Footer.
      this.stroke(C.line, 0.25);
      doc.line(LAYOUT.ml, LAYOUT.footerY, A4.w - LAYOUT.mr, LAYOUT.footerY);
      this.font(6.2, 'normal', C.muted);
      const disc = (doc.splitTextToSize(pdfText(this.m.disclaimer), this.cw - 28) as string[]).slice(0, 3);
      disc.forEach((l, k) => doc.text(l, LAYOUT.ml, LAYOUT.footerY + 3.4 + k * 2.7));
      this.font(7.4, 'bold', C.ink);
      doc.text(pageLabel(i, total), A4.w - LAYOUT.mr, LAYOUT.footerY + 3.6, { align: 'right' });
    }
  }
}

/** Renders the model into `doc` (a fresh A4 portrait jsPDF in mm) and returns it. */
export function renderPdf(doc: jsPDF, autoTable: AutoTableFn, model: PdfDocModel): jsPDF {
  doc.setProperties({ title: pdfText(`${model.docType} ${model.docId} — ${model.title}`), subject: 'Simulated demonstration data', creator: PRODUCT_NAME });
  const r = new Renderer(doc, autoTable, model);
  r.titleBlock();
  for (const s of model.sections) r.section(s);
  r.furniture();
  return doc;
}
