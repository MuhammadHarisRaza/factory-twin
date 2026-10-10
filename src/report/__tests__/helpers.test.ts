/**
 * Pure helpers of the PDF export: WinAnsi text sanitising and the A4 pagination / chart maths.
 */
import { describe, expect, it } from 'vitest';
import { A4, LAYOUT, chartRange, columnWidth, contentHeight, contentWidth, fitBox, labelIndices, lineHeightMm, niceTicks, pageLabel, placeBlock, splitLines } from '../layout';
import { fileSafe, isWinAnsiSafe, pdfText, sanitizeDeep } from '../text';
import { fmtMoney, fmtValue } from '../format';

describe('pdfText (jsPDF standard fonts are WinAnsi)', () => {
  it('replaces characters the standard fonts cannot draw', () => {
    expect(pdfText('A → B')).toBe('A -> B');
    expect(pdfText('≈ 12 · ≥ 3 · ≤ 4')).toBe('~ 12 · >= 3 · <= 4');
    expect(pdfText('60×60 cm')).toBe('60x60 cm');
    expect(pdfText('−2.5 – 3 — 4')).toBe('-2.5 - 3 - 4');
    expect(pdfText('‘a’ “b”')).toBe(`'a' "b"`);
    expect(pdfText('Δ rate')).toBe('delta rate');
    expect(pdfText('wait…')).toBe('wait...');
    expect(pdfText('CO₂e')).toBe('CO2e');
  });
  it('keeps Latin-1 characters that WinAnsi supports', () => {
    expect(pdfText('12 m² · 850 °C · µm · café · ±1')).toBe('12 m² · 850 °C · µm · café · ±1');
  });
  it('never lets an unsupported character through', () => {
    const nasty = 'Kiln → sorting ≈ 3 % ≥ limit ✓ 🙂 中 ₂ ‑    ﬁ\r\n';
    const out = pdfText(nasty);
    expect(isWinAnsiSafe(out)).toBe(true);
    expect(out).toContain('->');
    expect(out).toContain('fi');
    expect(out).not.toContain('\r');
  });
  it('handles null, numbers and collapses doubled spaces', () => {
    expect(pdfText(null)).toBe('');
    expect(pdfText(undefined)).toBe('');
    expect(pdfText(12.5)).toBe('12.5');
    expect(pdfText('a  b')).toBe('a b');
  });
  it('sanitises nested data but leaves image data URLs untouched', () => {
    const v = sanitizeDeep({ a: ['x → y', 3], img: { dataUrl: 'data:image/png;base64,→' }, n: null });
    expect(v).toEqual({ a: ['x -> y', 3], img: { dataUrl: 'data:image/png;base64,→' }, n: null });
  });
  it('makes file-safe ids', () => {
    expect(fileSafe('EV-00012')).toBe('EV-00012');
    expect(fileSafe('a b/c')).toBe('a-b-c');
    expect(fileSafe('///')).toBe('report');
  });
});

describe('shared formatting', () => {
  it('formats money and observed values', () => {
    expect(fmtMoney('USD', 12.5)).toBe('USD 12.50');
    expect(fmtMoney('USD', 12345.4)).toBe('USD 12,345');
    expect(fmtMoney('USD', Number.NaN)).toBe('—');
    expect(fmtValue({ label: 'v', value: 4.567, unit: 'mm/s' })).toBe('4.57 mm/s');
    expect(fmtValue({ label: 's', value: 'Stopped' })).toBe('Stopped');
    expect(fmtValue(null)).toBe('—');
  });
});

describe('A4 layout and pagination', () => {
  it('has consistent page geometry', () => {
    expect(contentWidth()).toBe(A4.w - LAYOUT.ml - LAYOUT.mr);
    expect(contentHeight()).toBe(LAYOUT.bottom - LAYOUT.top);
    expect(LAYOUT.top).toBeGreaterThan(LAYOUT.headerH);
    expect(LAYOUT.footerY).toBeGreaterThan(LAYOUT.bottom);
    expect(lineHeightMm(10)).toBeCloseTo(10 * 0.3528 * 1.3, 6);
    expect(pageLabel(2, 5)).toBe('Page 2 of 5');
  });
  it('places a block on the current page or moves it to the next', () => {
    expect(placeBlock(100, 50)).toEqual({ y: 100, newPage: false });
    expect(placeBlock(LAYOUT.bottom - 10, 20)).toEqual({ y: LAYOUT.top, newPage: true });
    // A block taller than a page at the top of a page stays (the caller splits it).
    expect(placeBlock(LAYOUT.top, 400)).toEqual({ y: LAYOUT.top, newPage: false });
  });
  it('splits lines across pages without losing or repeating any', () => {
    const lh = 5;
    const y = LAYOUT.bottom - 12; // two lines fit
    const r = splitLines(120, lh, y);
    const perPage = Math.floor(contentHeight() / lh);
    expect(r.chunks[0]).toMatchObject({ page: 0, y, from: 0, to: 2 });
    expect(r.chunks[1]).toMatchObject({ page: 1, y: LAYOUT.top, from: 2, to: 2 + perPage });
    // Contiguous and complete.
    let next = 0;
    for (const c of r.chunks) {
      expect(c.from).toBe(next);
      next = c.to;
    }
    expect(next).toBe(120);
    expect(r.pages).toBe(r.chunks[r.chunks.length - 1].page);
    for (const c of r.chunks) expect(c.y + (c.to - c.from) * lh).toBeLessThanOrEqual(LAYOUT.bottom + 1e-6);
  });
  it('starts on the next page when not even one line fits', () => {
    const r = splitLines(3, 5, LAYOUT.bottom - 2);
    expect(r.chunks).toEqual([{ page: 1, y: LAYOUT.top, from: 0, to: 3 }]);
    expect(splitLines(0, 5, 100)).toEqual({ chunks: [], endY: 100, pages: 0 });
  });
  it('scales images to fit, keeping the aspect ratio', () => {
    expect(fitBox(640, 360, 182, 82)).toEqual({ w: (640 * 82) / 360, h: 82 });
    expect(fitBox(400, 400, 40, 44)).toEqual({ w: 40, h: 40 });
    const f = fitBox(0, 0, 100, 80);
    expect(f.w).toBe(100);
    expect(f.h).toBeLessThanOrEqual(80);
  });
  it('computes nice chart ticks and ranges', () => {
    expect(niceTicks(0, 97)).toEqual({ lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100] });
    const r = chartRange([[1, null, 3]], 8);
    expect(r!.lo).toBe(0);
    expect(r!.hi).toBeGreaterThanOrEqual(8);
    expect(chartRange([[null, null]])).toBeNull();
    const neg = chartRange([[-4, 2]]);
    expect(neg!.lo).toBeLessThanOrEqual(-4);
    const flat = niceTicks(5, 5);
    expect(flat.hi).toBeGreaterThan(flat.lo);
  });
  it('picks x labels and column widths', () => {
    expect(labelIndices(3)).toEqual([0, 1, 2]);
    expect(labelIndices(100, 4)).toEqual([0, 33, 66, 99]);
    expect(labelIndices(0)).toEqual([]);
    expect(columnWidth(182, 2, 6)).toBe(88);
  });
});
