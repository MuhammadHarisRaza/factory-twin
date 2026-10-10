import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Empty } from './Panel';

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Right-aligned tabular numbers. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sort?: (row: T) => number | string | null;
  width?: number | string;
  title?: string;
};

/**
 * Sortable table with sticky header, optional row selection/click and an empty
 * state. Rows are keyed by `rowKey`.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  maxHeight = 420,
  empty = 'No records in this period',
  initialSort,
  footer,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  maxHeight?: number | 'none';
  empty?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  footer?: ReactNode;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? r : -r;
    });
  }, [rows, sort, columns]);

  return (
    <div className="table-wrap" style={{ maxHeight: maxHeight === 'none' ? undefined : maxHeight }}>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={`${c.numeric ? 'n' : ''} ${c.sort ? 'sortable' : ''}`}
                  style={{ width: c.width }}
                  title={c.title}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  onClick={
                    c.sort
                      ? () => setSort(active ? { key: c.key, dir: sort!.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.numeric ? 'desc' : 'asc' })
                      : undefined
                  }
                >
                  {c.header}
                  {active && (sort!.dir === 'asc' ? <ArrowUp size={11} style={{ marginLeft: 4 }} /> : <ArrowDown size={11} style={{ marginLeft: 4 }} />)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const k = rowKey(row);
            return (
              <tr
                key={k}
                className={`${onRowClick ? 'clickable' : ''} ${selectedKey === k ? 'sel' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? 'n' : ''}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer}
      </table>
      {!rows.length && <Empty title={empty} />}
    </div>
  );
}
