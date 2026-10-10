import { useEffect, useId, useRef, useState } from 'react';
import { Forklift, Package, Search, Truck, X } from 'lucide-react';
import { useTwin } from '../../store';
import { ZONE_BY_ID } from '../../data/layout';
import { useSimValue } from '../../sim/store';
import { searchTwin, type SearchResult } from './derive';

const KIND_LABEL: Record<SearchResult['kind'], string> = { equipment: 'Asset', zone: 'Zone', vehicle: 'Vehicle', batch: 'Batch' };

function go(r: SearchResult) {
  const tw = useTwin.getState();
  if (r.target.kind === 'zone') tw.selectZone(r.target.id);
  else if (r.target.kind === 'vehicle') tw.selectVehicle(r.target.id, true);
  else tw.select(r.target.id);
}

function ResultIcon({ r }: { r: SearchResult }) {
  if (r.zone && r.kind !== 'batch') {
    const z = ZONE_BY_ID[r.zone];
    return (
      <span className="chip" style={{ background: z.color }} aria-hidden>
        {z.id}
      </span>
    );
  }
  const Icon = r.kind === 'batch' ? Package : r.subtitle.toLowerCase().includes('truck') ? Truck : Forklift;
  return (
    <span className="tw-res-i" aria-hidden>
      <Icon size={13} />
    </span>
  );
}

/**
 * Global twin search (header): assets by id or name, zones, vehicles on site and
 * production batches. Arrow keys move, Enter flies there, Esc clears. Shortcut: / or Ctrl+K.
 */
export function TwinSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useSimValue((s) => searchTwin(s, q), [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable);
      const ctrlK = e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey;
      const slash = e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!ctrlK && !slash) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choose = (r: SearchResult | undefined) => {
    if (!r) return;
    go(r);
    setQ('');
    setOpen(false);
    input.current?.blur();
  };
  const show = open && q.trim().length > 0;
  const idx = Math.min(active, Math.max(0, results.length - 1));

  return (
    <div className="tw-search">
      <Search className="tw-search-i" size={14} aria-hidden />
      <input
        ref={input}
        className="input"
        type="search"
        value={q}
        placeholder="Search assets, zones, vehicles, batches"
        aria-label="Search the factory twin"
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show && results.length ? `${listId}-${idx}` : undefined}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive(results.length ? (idx + 1) % results.length : 0);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(results.length ? (idx - 1 + results.length) % results.length : 0);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(results[idx]);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            if (q) setQ('');
            else input.current?.blur();
          }
        }}
      />
      {q ? (
        <button className="tw-search-x" onMouseDown={(e) => e.preventDefault()} onClick={() => setQ('')} title="Clear" aria-label="Clear search">
          <X size={13} />
        </button>
      ) : (
        <kbd className="tw-search-k" title="Press / or Ctrl+K to search">
          /
        </kbd>
      )}
      {show && (
        <div className="tw-search-pop overlay-panel" id={listId} role="listbox" aria-label="Search results">
          {results.length ? (
            results.map((r, i) => (
              <div
                key={r.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === idx}
                className={`tw-res ${i === idx ? 'on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
              >
                <ResultIcon r={r} />
                <span className="tw-res-m">
                  <b>{r.title}</b>
                  <small>{r.subtitle}</small>
                </span>
                <span className="tw-res-k">{KIND_LABEL[r.kind]}</span>
              </div>
            ))
          ) : (
            <div className="tw-res-empty">No asset, zone, vehicle or batch matches “{q.trim()}”.</div>
          )}
          <div className="tw-res-foot">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move · <kbd>Enter</kbd> fly to · <kbd>Esc</kbd> clear
          </div>
        </div>
      )}
    </div>
  );
}
