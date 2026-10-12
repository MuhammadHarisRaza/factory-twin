/**
 * Keyboard access of the kit's interactive table and charts (server-rendered markup): sortable
 * headers are buttons inside a header cell that keeps aria-sort, selectable ranked-bar rows have a
 * button, and selectable columns are focusable named buttons (the chart is then not an opaque image).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColumnChart, RankedBars } from './charts';
import { DataTable, type Column } from './DataTable';

type Row = { id: string; name: string; n: number };
const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', n: 3 },
  { id: 'b', name: 'Beta', n: 7 },
];
const COLS: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sort: (r) => r.name },
  { key: 'n', header: 'Count', numeric: true, render: (r) => r.n, sort: (r) => r.n },
  { key: 'note', header: 'Note', render: () => '—' },
];

describe('DataTable', () => {
  it('renders sortable headers as buttons and keeps aria-sort on the header cell', () => {
    const html = renderToStaticMarkup(<DataTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} initialSort={{ key: 'n', dir: 'desc' }} />);
    const heads = html.match(/<th[^>]*>.*?<\/th>/g)!;
    expect(heads).toHaveLength(3);
    expect(heads[0]).toMatch(/<button type="button" class="th-sort"[^>]*>Name<\/button>/);
    expect(heads[0]).not.toContain('aria-sort');
    expect(heads[1]).toContain('aria-sort="descending"');
    expect(heads[1]).toMatch(/<button type="button" class="th-sort"[^>]*>Count<svg/);
    // An unsortable column has no button.
    expect(heads[2]).not.toContain('<button');
    // Sorted by count, descending.
    expect(html.indexOf('Beta')).toBeLessThan(html.indexOf('Alpha'));
  });

  it('makes clickable rows focusable', () => {
    const html = renderToStaticMarkup(<DataTable columns={COLS} rows={ROWS} rowKey={(r) => r.id} onRowClick={() => {}} />);
    expect(html.match(/<tr class="clickable [^"]*" tabindex="0"/g)).toHaveLength(2);
  });
});

describe('RankedBars', () => {
  const rows = [
    { key: 'x', label: 'Glaze pinholes', value: 12, share: 0.6 },
    { key: 'y', label: 'Cracks', value: 8, share: 0.4 },
  ];
  it('gives each selectable row a named button, with the selection as aria-pressed', () => {
    const html = renderToStaticMarkup(<RankedBars rows={rows} format={String} onSelect={() => {}} selectedKey="x" showCumulative={false} />);
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Glaze pinholes: 12"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('aria-selected');
  });

  it('renders plain rows without buttons when nothing can be selected', () => {
    const html = renderToStaticMarkup(<RankedBars rows={rows} format={String} />);
    expect(html).not.toContain('<button');
    expect(html).toContain('role="cell"');
  });
});

describe('ColumnChart', () => {
  const data = [
    { key: 'T1', label: '0001', value: 42, target: 60 },
    { key: 'T2', label: '0002', value: 75, target: 60 },
  ];
  it('selectable columns: focusable buttons with a name, inside a group rather than an image', () => {
    const html = renderToStaticMarkup(<ColumnChart data={data} format={(v) => `${v} min`} onSelect={() => {}} label="Turnaround per visit" />);
    expect(html).toMatch(/<svg[^>]*role="group"[^>]*aria-label="Turnaround per visit"/);
    expect(html).not.toContain('role="img"');
    expect(html.match(/<g [^>]*role="button" tabindex="0"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="0001: 42 min, target 60 min"');
    expect(html).toContain('aria-label="0002: 75 min, target 60 min"');
  });

  it('a display-only chart stays an image with no focus stops', () => {
    const html = renderToStaticMarkup(<ColumnChart data={data} format={String} />);
    expect(html).toContain('role="img"');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('role="button"');
  });
});
