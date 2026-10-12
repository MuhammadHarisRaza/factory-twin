/**
 * Truck movement flow under the site layout: the seven steps of a visit (the same numbers as the
 * map's area badges) with the trucks in each step now. Trucks past a limit or with an active alert
 * carry the warning icon and its text in the button's name; selecting a truck opens its detail.
 */
import { ArrowDownToLine, ArrowUpFromLine, Boxes, FileQuestion, ListOrdered, LogIn, LogOut, Scale, SquareParking, TriangleAlert, Warehouse, type LucideIcon } from 'lucide-react';
import { fmtInt } from '../../ui/kit/format';
import { DOCK_NAME } from './derive';
import { PIPELINE_STAGES, type Pipeline, type PipelineTruck, type StageKey } from './pipeline';
import type { MapFlag } from './SiteMap';

const ICON: Record<StageKey, LucideIcon> = {
  gate: LogIn,
  checkin: Scale,
  holding: SquareParking,
  queue: ListOrdered,
  dock: Warehouse,
  staging: Boxes,
  exit: LogOut,
};

const SHORT: Record<StageKey, string> = {
  gate: 'Entry gate',
  checkin: 'Check-in · weighbridge',
  holding: 'Holding',
  queue: 'Queue',
  dock: 'Dock / bay',
  staging: 'Dispatch staging',
  exit: 'Exit gate',
};

const SHOWN = 4;

export function FlowStrip({
  pipe,
  flags,
  selected,
  onSelect,
  onMore,
}: {
  pipe: Pipeline;
  flags: Map<string, MapFlag>;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Opens the full truck pipeline (Trucks & docks tab). */
  onMore: () => void;
}) {
  return (
    <ol className="fl-flow" aria-label="Truck movement flow, now">
      {PIPELINE_STAGES.map((st, i) => {
        const Icon = ICON[st.key];
        if (st.key === 'staging') {
          return (
            <li key={st.key} className="fl-flow-st" title={st.def}>
              <header>
                <span className="fl-step">{i + 1}</span>
                <Icon size={13} aria-hidden />
                <b>{SHORT[st.key]}</b>
                <span className={`fl-flow-n ${pipe.loads.length ? '' : 'zero'}`} title="Outbound loads in progress">
                  {pipe.loads.length}
                </span>
              </header>
              <p className="fl-flow-sub">{pipe.loads.length ? `${fmtInt(pipe.palletsToLoad)} pallets still to load` : 'No load in progress'}</p>
              <div className="fl-flow-trucks">
                {pipe.loads.slice(0, SHOWN).map((l) => (
                  <button key={l.v.id} type="button" className={`fl-tk ${selected === l.v.id ? 'sel' : ''}`} aria-pressed={selected === l.v.id} onClick={() => onSelect(l.v.id)} title={`${l.v.id} · ${l.loaded} / ${l.load} pallets · ${DOCK_NAME[l.dockId]}`}>
                    <span className="mono">{l.v.id}</span>
                    <span className="fl-tk-sub">
                      {l.loaded}/{l.load}
                    </span>
                  </button>
                ))}
              </div>
            </li>
          );
        }
        const rows = pipe.stages[st.key];
        const due = rows.filter((r) => r.place.due).length;
        const count = rows.length - due;
        const more = rows.length - SHOWN;
        return (
          <li key={st.key} className="fl-flow-st" title={st.def}>
            <header>
              <span className="fl-step">{i + 1}</span>
              <Icon size={13} aria-hidden />
              <b>{SHORT[st.key]}</b>
              <span className={`fl-flow-n ${count ? '' : 'zero'}`}>{count}</span>
            </header>
            <p className="fl-flow-sub">
              {st.sub}
              {due > 0 && <span className="fl-due"> · +{due} due</span>}
            </p>
            <div className="fl-flow-trucks">
              {rows.slice(0, SHOWN).map((r) => (
                <TruckButton key={r.v.id} r={r} flag={flags.get(r.v.id)} sel={selected === r.v.id} onSelect={onSelect} />
              ))}
              {more > 0 && (
                <button type="button" className="fl-tk more" onClick={onMore} title="Show every truck in the full pipeline (Trucks & docks)">
                  +{more} more
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TruckButton({ r, flag, sel, onSelect }: { r: PipelineTruck; flag?: MapFlag; sel: boolean; onSelect: (id: string) => void }) {
  const out = r.v.visit!.direction === 'outbound';
  const Dir = out ? ArrowUpFromLine : ArrowDownToLine;
  const FlagIcon = flag?.kind === 'record' ? FileQuestion : TriangleAlert;
  return (
    <button
      type="button"
      className={`fl-tk ${sel ? 'sel' : ''} ${r.place.due ? 'due' : ''} ${flag ? `flag ${flag.tone}` : ''}`}
      aria-pressed={sel}
      onClick={() => onSelect(r.v.id)}
      title={`${r.v.id} · ${out ? 'outbound' : 'inbound'} · ${r.place.status}${flag ? ` · ${flag.text}` : ''}`}
    >
      <Dir size={11} aria-label={out ? 'Outbound' : 'Inbound'} />
      <span className="mono">{r.v.id}</span>
      {r.place.queuePos != null && <span className="fl-tk-pos">#{r.place.queuePos}</span>}
      {flag && (
        <span className="fl-tk-flag">
          <FlagIcon size={11} aria-hidden />
          <span className="fl-sr">{flag.text}</span>
        </span>
      )}
    </button>
  );
}
