/**
 * `Number.prototype.toLocaleString('en-GB', options)` with the Intl.NumberFormat built once per option set: the
 * engine builds a new formatter for every call with options (tens of µs each), and these run thousands of times per
 * simulated minute (event impact lines, signal tables, threshold lists). Identical output.
 */
const FORMATS = new Map<string, Intl.NumberFormat>();

export function localeNumber(v: number, min: number | undefined, max: number | undefined): string {
  const key = `${min ?? ''}|${max ?? ''}`;
  let f = FORMATS.get(key);
  if (!f) {
    const opts: Intl.NumberFormatOptions = {};
    if (max !== undefined) opts.maximumFractionDigits = max;
    if (min !== undefined) opts.minimumFractionDigits = min;
    FORMATS.set(key, (f = new Intl.NumberFormat('en-GB', opts)));
  }
  return f.format(v);
}
