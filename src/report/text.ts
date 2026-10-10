/**
 * Text helpers for the PDF export.
 *
 * jsPDF's 14 standard fonts are encoded as WinAnsi: characters up to U+00FF (outside the C1 range
 * U+0080–U+009F) are written as single bytes and render correctly; anything else (arrows, ≈, ≥,
 * typographic quotes and dashes, subscripts …) would be written as UTF-16 and show as garbage.
 * Every string that reaches the PDF goes through `pdfText`.
 */

/** Explicit replacements, checked before the generic fallback. */
const MAP: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '⇒': '=>',
  '↑': 'up',
  '↓': 'down',
  '≈': '~',
  '∼': '~',
  '≥': '>=',
  '≤': '<=',
  '≠': '!=',
  '×': 'x',
  '−': '-',
  '–': '-',
  '—': '-',
  '‒': '-',
  '―': '-',
  '‐': '-',
  '‑': '-',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '″': '"',
  '…': '...',
  '•': '-',
  '‣': '-',
  '◦': '-',
  '∙': '·',
  '⋅': '·',
  'Δ': 'delta ',
  'δ': 'delta ',
  'Σ': 'sum ',
  '€': 'EUR',
  '™': '(TM)',
  '✓': 'yes',
  '✔': 'yes',
  '✗': 'no',
  '✕': 'x',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '​': '',
  '‍': '',
  '﻿': '',
};

/** True when the character is written correctly by jsPDF's WinAnsi standard fonts. */
const safeChar = (c: string) => {
  const code = c.codePointAt(0) ?? 0;
  if (code === 9 || code === 10) return true;
  return (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff);
};

/** Sanitises one string for jsPDF standard fonts (see module comment). */
export function pdfText(input: string | number | null | undefined): string {
  if (input == null) return '';
  const s = String(input);
  let out = '';
  for (const c of s) {
    // Explicit replacements first (× is in WinAnsi but reads better as x next to ASCII digits).
    const mapped = MAP[c];
    if (mapped != null) {
      out += mapped;
      continue;
    }
    if (safeChar(c)) {
      out += c;
      continue;
    }
    // Generic fallback: compatibility decomposition (₂ → 2, ﬁ → fi, é stays é), accents dropped
    // when the base letter is ASCII; otherwise a visible placeholder.
    const d = c.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += d && [...d].every(safeChar) ? d : c === '\r' ? '' : '?';
  }
  return out.replace(/ {2,}/g, ' ');
}

/** True when every character of the string is WinAnsi-safe. */
export const isWinAnsiSafe = (s: string) => [...s].every(safeChar);

/** Deep-sanitises every string inside a plain data structure (arrays / objects); numbers and other values are kept. */
export function sanitizeDeep<T>(value: T, skipKeys: ReadonlySet<string> = new Set(['dataUrl'])): T {
  if (typeof value === 'string') return pdfText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, skipKeys)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = skipKeys.has(k) ? v : sanitizeDeep(v, skipKeys);
    return out as T;
  }
  return value;
}

/** File-name-safe id (EV-00012 stays as it is). */
export const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
