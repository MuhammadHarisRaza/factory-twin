/**
 * Building blocks of the equipment / vehicle workspaces: the KPI tiles (with honest unavailable
 * labels), the recommended next steps and the workflow links.
 */
import { CircleCheck, CircleDashed, ExternalLink, Info, LocateFixed, OctagonX, Scan, TriangleAlert, Waypoints, type LucideIcon } from 'lucide-react';
import { useApp, type WorkspaceId } from '../../app/store';
import { followLink } from '../copilot/links';
import { useTwin } from '../../store';
import { ProvenanceBadge, Unavailable } from '../kit/Page';
import { SEVERITY, StatusBadge, type Tone } from '../kit/Status';
import { formatClock } from '../../sim/time';
import type { EqKpi, EqKpiSet } from './kpis';
import type { NextStep } from './context';

const TONE_ICON: Record<Tone, LucideIcon> = {
  good: CircleCheck,
  warning: TriangleAlert,
  serious: TriangleAlert,
  critical: OctagonX,
  neutral: CircleDashed,
  planned: CircleDashed,
};

function Tile({ k }: { k: EqKpi }) {
  return (
    <div className={`mini-kpi eqw-kpi ${k.unavailable ? 'na' : ''}`} title={k.unavailable ? `${k.unavailable}\n\n${k.hint}` : k.hint}>
      <span>{k.label}</span>
      {k.unavailable ? (
        <b className="eqw-na">
          <Unavailable reason={k.unavailable}>{k.notModelled ? 'Not modelled' : 'No data yet'}</Unavailable>
        </b>
      ) : (
        <b>
          {k.value}
          {k.unit && <small>{k.unit}</small>}
        </b>
      )}
      {k.status ? (
        <em>
          <StatusBadge tone={k.status.tone} icon={TONE_ICON[k.status.tone]} label={k.status.label} size={11} />
        </em>
      ) : k.sub ? (
        <em>{k.sub}</em>
      ) : null}
      {k.status && k.sub && <em className="eqw-kpi-sub">{k.sub}</em>}
      {k.unavailable && !k.notModelled && <em className="eqw-kpi-sub">{k.unavailable}</em>}
    </div>
  );
}

/** 3–5 context KPIs; parameters the model does not contain are listed with the reason below the tiles. */
export function KpiTiles({ set, label }: { set: EqKpiSet; label: string }) {
  if (set.note) return <p className="insp-desc">{set.note}</p>;
  const missing = set.kpis.filter((k) => k.notModelled);
  return (
    <>
      {set.stale ? (
        <p className="insp-desc tw-stale" role="note">
          <ProvenanceBadge kind="stale" title={`The (simulated) data feed of ${set.stale.assetIds.join(', ')} stopped updating at ${formatClock(set.stale.since)}`} /> <b>{set.stale.label}</b> — {set.stale.note}
        </p>
      ) : (
        set.staleSince != null && (
          <p className="insp-desc tw-stale" role="note">
            <ProvenanceBadge kind="stale" /> <b>Not confirmed · data stale since {formatClock(set.staleSince)}</b> — figures after that time are not confirmed by the feed.
          </p>
        )
      )}
      <div className="mini-kpis eqw-kpis" role="group" aria-label={label}>
        {set.kpis.map((k) => (
          <Tile key={k.key} k={k} />
        ))}
      </div>
      {missing.length > 0 && (
        <ul className="eqw-notes">
          {missing.map((k) => (
            <li key={k.key}>
              <Info size={12} aria-hidden />
              <span>
                <b>{k.label}</b> — {k.unavailable}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Follows an insight link from inside the twin (stays in the model for equipment and vehicles). */
function follow(link: NextStep['links'][number], current: string | null) {
  const tw = useTwin.getState();
  if (link.kind === 'equipment') {
    if (link.id === current) tw.focusEquipment(link.id);
    else tw.select(link.id);
  } else if (link.kind === 'vehicle') tw.selectVehicle(link.id, true);
  else followLink(link);
}

const linkIcon = (l: NextStep['links'][number], current: string | null): LucideIcon =>
  l.kind === 'workspace' || l.kind === 'stage' || l.kind === 'event' ? ExternalLink : l.kind === 'vehicle' ? LocateFixed : l.id === current ? Scan : Waypoints;

/** Recommended next steps: event recommendations (with their event) and rule-based insights. */
export function NextSteps({ steps, current, empty }: { steps: NextStep[]; current: string | null; empty: string }) {
  return (
    <section className="insp-sec" aria-label="Recommended next steps">
      <h3>Recommended next steps · rule-based</h3>
      {steps.length ? (
        <ol className="eqw-steps">
          {steps.map((st) => (
            <li key={st.key}>
              <div className="eqw-step-h">
                {st.severity !== 'positive' && <StatusBadge {...SEVERITY[st.severity]} size={12} />}
                <b>{st.title}</b>
              </div>
              <p>{st.text}</p>
              <div className="eqw-step-f">
                <small>{st.origin === 'event' ? `Recommendation of event ${st.eventId}` : 'Rule-based insight on the current state'}</small>
                {st.links.slice(0, 2).map((l) => {
                  const Icon = linkIcon(l, current);
                  return (
                    <button key={l.kind + l.id} type="button" className="btn sm" onClick={() => follow(l, current)}>
                      <Icon size={12} aria-hidden />
                      {l.kind === 'equipment' && l.id === current ? 'Focus' : l.label}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="insp-desc">{empty}</p>
      )}
      <p className="tw-honest">Deterministic rules over the simulated state — no language or predictive model is connected.</p>
    </section>
  );
}

export type FlowLink = { key: string; label: string; title: string; run: () => void };

/** "Continue in" links to the workspaces that explain or act on the selection. */
export function ContinueIn({ links }: { links: FlowLink[] }) {
  if (!links.length) return null;
  return (
    <section className="insp-sec" aria-label="Continue in">
      <h3>Continue in</h3>
      <div className="eqw-flow">
        {links.map((l) => (
          <button key={l.key} type="button" className="btn sm" onClick={l.run} title={l.title}>
            <ExternalLink size={12} aria-hidden />
            {l.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export const goTo = (w: WorkspaceId) => () => useApp.getState().go(w);
