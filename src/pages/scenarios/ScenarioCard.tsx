import { Activity, Eye, Info, ListChecks, Play, RefreshCw, Wrench, X } from 'lucide-react';
import { CLASSIFICATION_LABEL, RULE_BY_ID } from '../../intel/rules';
import { SCENARIO_KIND_LABELS } from '../../model/plant';
import type { SimState } from '../../sim/engine';
import { HEALTH_BY_ID, assess, formatH } from '../../sim/health';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import {
  entryMatches,
  maintenanceDef,
  outcomeOf,
  paramOptions,
  resolveValues,
  sameTarget,
  scenarioEvents,
  scenarioStatus,
  targetKey,
  when,
  type CatalogueEntry,
  type ShowTarget,
} from './catalogue';
import { runScenario, useScenarioParams, type Origin } from './actions';
import { LevelBadge, ParamSelect, ScenarioState, ShowButton, targetLabel } from './ui';
// The card brings its own styles.
import './scenarios.css';

/** What the condition signals show for the chosen asset, and whether maintenance can be scheduled. */
function healthOf(s: SimState, id: string) {
  const asset = HEALTH_BY_ID[id];
  if (!asset) return null;
  const a = assess(s, id);
  const running = s.scenarios.find((m) => m.kind === 'maintenance' && m.equipmentId === id && (m.end ?? s.minute) > s.minute) ?? null;
  const fault = s.scenarios.some((sc) => sc.kind === 'degradation' && sc.equipmentId === id && scenarioStatus(s, sc).key === 'active');
  const flagged = a.level === 'watch' || a.level === 'warning' || a.level === 'alarm';
  const blocked = running
    ? `Maintenance in progress until ${formatClock(running.end ?? s.minute)}; the fault is removed when it ends.`
    : s.machines[id]?.state === 'down'
      ? `${id} is stopped (unplanned). Maintenance can be scheduled once it runs again.`
      : !fault && !flagged
      ? 'Signals are normal on this asset. Start a developing fault first.'
      : null;
  return { id, level: a.level, etaTripH: a.etaTripH, repair: asset.repair, blocked };
}

/**
 * One scenario (Scenarios panel → Catalogue): what it does, its parameters, Activate / Clear,
 * current status and "Show me" links to where the effect is visible — including the report of the
 * operational event the scenario produced (the same record everywhere).
 * Only instances still in effect can be cleared; a fault that broke down or was removed is over.
 */
export function ScenarioCard({ entry, origin, onNavigate }: { entry: CatalogueEntry; origin: Origin; onNavigate?: () => void }) {
  const values = useScenarioParams((s) => s.values[entry.id]);
  const setParam = useScenarioParams((s) => s.set);
  const clear = useSim((s) => s.clear);
  const resetting = useSim((s) => s.resetting);

  const d = useSimValue(
    (s) => {
      const v = resolveValues(entry, values, s);
      const rows = s.scenarios.filter((sc) => entryMatches(entry, sc)).map((sc) => ({ sc, st: scenarioStatus(s, sc) }));
      // Only instances still in effect: a fault that broke down or was removed is over (finding #24).
      const open = entry.oneOff ? [] : rows.filter((r) => r.st.key === 'active');
      const last = rows[rows.length - 1] ?? null;
      const def = entry.build(v, s.minute);
      const focus = entry.focus(v, open[open.length - 1]?.sc ?? null, s);
      // The operational event of the latest instance (first that is not a consequence of another).
      const evs = last ? scenarioEvents(s, last.sc) : [];
      const ev = evs.find((e) => !e.consequenceOf) ?? evs[0] ?? null;
      const targets: ShowTarget[] = [
        ...(focus ? [focus] : []),
        ...(ev ? [{ type: 'event', id: ev.id } as ShowTarget] : []),
        ...(entry.views ?? []),
        ...entry.workspaces.map((id): ShowTarget => ({ type: 'workspace', id })),
      ];
      return {
        now: s.minute,
        v,
        options: entry.params.map((p) => paramOptions(p, s)),
        open,
        last,
        lastOutcome: last && (entry.oneOff || !open.length) ? outcomeOf(s, last.sc) : null,
        replaces: open.some((r) => r.st.key === 'active' && sameTarget(r.sc, def)),
        blocked: entry.unavailable?.(v, s) ?? null,
        targets: targets.map((t) => ({ t, label: targetLabel(t, s) })),
        health: entry.kind === 'degradation' ? healthOf(s, String(v.asset)) : null,
      };
    },
    [entry, values],
  );

  const activate = () => {
    runScenario(entry.build(d.v, useSim.getState().sim.minute), origin);
  };
  const main = entry.params.map((p, i) => ({ p, i })).filter(({ p }) => p.section !== 'maintenance');
  const cbm = entry.params.map((p, i) => ({ p, i })).find(({ p }) => p.section === 'maintenance');
  const title = entry.title ?? SCENARIO_KIND_LABELS[entry.kind];

  return (
    <article className={`scnp-card ${d.open.length ? 'on' : ''}`} aria-label={`Scenario ${entry.ref}: ${title}`}>
      <header className="scnp-card-h">
        <span className="scnp-letter" aria-hidden>
          {entry.ref}
        </span>
        <h3>{title}</h3>
        <span className="tag sim" title="A scenario input of the simulation — not a measured plant event">
          Simulated scenario
        </span>
        <div className="spacer" />
        {d.open.length > 1 ? (
          <span className="scnp-state on">
            <Activity size={13} strokeWidth={2.2} aria-hidden />
            {d.open.length} active
          </span>
        ) : d.open.length === 1 ? (
          <ScenarioState st={d.open[0].st} now={d.now} />
        ) : d.last ? (
          <ScenarioState st={d.last.st} now={d.now} />
        ) : (
          <span className="scnp-state">Not active</span>
        )}
      </header>

      <p className="scnp-what">{entry.summary}</p>
      <p className="scnp-where">
        <Eye size={13} aria-hidden />
        <span>{entry.effect}</span>
      </p>
      {entry.detectedBy && entry.detectedBy.length > 0 && (
        <p className="scnp-where scnp-rules">
          <ListChecks size={13} aria-hidden />
          <span>Detected by</span>
          {entry.detectedBy.map((id) => (
            <span key={id} className="tag mono" title={RULE_BY_ID[id] ? `${RULE_BY_ID[id].title} · ${CLASSIFICATION_LABEL[RULE_BY_ID[id].classification]}` : id}>
              {id}
            </span>
          ))}
        </p>
      )}

      <div className="scnp-row">
        {main.map(({ p, i }) => (
          <ParamSelect key={p.key} label={p.label} value={d.v[p.key]} options={d.options[i]} onChange={(val) => setParam(entry.id, p.key, val)} />
        ))}
        <div className="spacer" />
        <button
          className="btn primary"
          onClick={activate}
          disabled={!!d.blocked || resetting}
          title={resetting ? 'Resetting the demo…' : (d.blocked ?? (d.replaces ? 'Replace the running instance on the same target with these parameters' : 'Start at the current plant time'))}
        >
          {d.replaces ? <RefreshCw size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          {d.replaces ? 'Replace active' : 'Activate'}
        </button>
      </div>
      {d.blocked && (
        <p className="scnp-hint">
          <Info size={13} aria-hidden />
          {d.blocked}
        </p>
      )}

      {d.open.length > 0 && (
        <ul className="scnp-inst" aria-label="Running instances">
          {d.open.map(({ sc, st }) => (
            <li key={sc.id}>
              <span className="scnp-inst-l" title={sc.label}>
                {sc.label}
              </span>
              <span className="scnp-inst-m">
                {d.open.length > 1 ? `since ${when(sc.start, d.now)}` : ''}
                {d.open.length > 1 && st.note ? ' · ' : ''}
                {st.note ?? ''}
              </span>
              <button className="btn sm" onClick={() => clear(sc.id)} title="End this scenario now; its effects stop from the current minute">
                <X size={13} aria-hidden />
                Clear
              </button>
            </li>
          ))}
        </ul>
      )}
      {d.last && d.lastOutcome && (
        <p className="scnp-last">
          Last: {d.last.sc.label} · {d.lastOutcome}
        </p>
      )}

      {d.health && cbm && (
        <div className="scnp-cbm">
          <div className="scnp-cbm-h">
            <span className="dim">Condition monitoring · {d.health.id}</span>
            <LevelBadge level={d.health.level} />
            {d.health.etaTripH != null && <span className="dim num">trip limit in ~{formatH(d.health.etaTripH)}</span>}
            <div className="spacer" />
            <span className="tag sim" title="Rule-based detection on simulated signals — no trained model or physical sensors">
              Rule-based · simulated
            </span>
          </div>
          <div className="scnp-row">
            <ParamSelect label={cbm.p.label} value={d.v[cbm.p.key]} options={d.options[cbm.i]} onChange={(val) => setParam(entry.id, cbm.p.key, val)} />
            <div className="spacer" />
            <button
              className="btn"
              disabled={!!d.health.blocked || resetting}
              title={d.health.blocked ?? 'Planned stop now; the developing fault is removed when it ends'}
              onClick={() => runScenario(maintenanceDef(d.health!.id, Number(d.v[cbm.p.key])), origin)}
            >
              <Wrench size={14} aria-hidden />
              Schedule condition-based maintenance
            </button>
          </div>
          <p className="scnp-hint">
            <Info size={13} aria-hidden />
            {d.health.blocked ??
              `A ${d.v[cbm.p.key]}-min planned stop now instead of an unplanned ${fmtH(d.health.repair[0])}–${fmtH(d.health.repair[1])} h repair if the fault reaches its trip limit.`}
          </p>
        </div>
      )}

      <footer className="scnp-card-f">
        <span className="scnp-show-l">Show me</span>
        {d.targets.map(({ t, label }) => (
          <ShowButton key={targetKey(t)} target={t} label={label} onNavigate={onNavigate} />
        ))}
      </footer>
    </article>
  );
}

const fmtH = (min: number) => (min / 60).toFixed(1);
