import { X } from 'lucide-react';
import { SCENARIO_KIND_LABELS } from '../../model/plant';
import type { ScenarioActivation } from '../../model/types';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock, formatDuration } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Panel } from '../../ui/kit/Panel';
import { openEvent } from '../../app/store';
import type { OpEvent } from '../../model/types';
import {
  ONE_OFF_KINDS,
  isClearable,
  outcomeOf,
  paramSummary,
  scenarioDuration,
  scenarioEvents,
  scenarioFocus,
  scenarioStatus,
  when,
  type ScenarioStatus,
  type ShowTarget,
} from './catalogue';
import { ORIGIN_LABEL, originOf } from './actions';
import { ScenarioState, ShowButton, targetLabel } from './ui';

type Row = {
  sc: ScenarioActivation;
  st: ScenarioStatus;
  params: string;
  outcome: string | null;
  duration: number | null;
  origin: string;
  target: { t: ShowTarget; label: string } | null;
  /** Operational events the scenario produced (same records as Events & Reports). */
  events: OpEvent[];
  clearable: boolean;
};

/** Every scenario activated since the last reset, newest first. */
export function ScenarioLog() {
  const resets = useSim((s) => s.resets);
  const clear = useSim((s) => s.clear);
  const d = useSimValue(
    (s) => {
      const rows: Row[] = s.scenarios.map((sc) => {
        const t = scenarioFocus(s, sc);
        const o = originOf(resets, sc.id);
        return {
          sc,
          st: scenarioStatus(s, sc),
          params: paramSummary(sc),
          outcome: outcomeOf(s, sc),
          duration: scenarioDuration(s, sc),
          origin: o ? ORIGIN_LABEL[o] : 'Other workspace',
          target: t ? { t, label: targetLabel(t, s) } : null,
          events: scenarioEvents(s, sc),
          clearable: isClearable(s, sc),
        };
      });
      // Newest first; equal start minutes keep activation order under the stable sort.
      return { now: s.minute, rows: rows.reverse() };
    },
    [resets],
  );
  const now = d.now;

  const columns: Column<Row>[] = [
    { key: 'id', header: 'ID', render: (r) => <span className="mono dim">{r.sc.id}</span>, sort: (r) => r.sc.id, width: 96 },
    { key: 'kind', header: 'Scenario', render: (r) => SCENARIO_KIND_LABELS[r.sc.kind], sort: (r) => SCENARIO_KIND_LABELS[r.sc.kind] },
    { key: 'params', header: 'Parameters', render: (r) => <span title={r.params}>{r.params}</span> },
    { key: 'start', header: 'Started', numeric: true, render: (r) => when(r.sc.start, now), sort: (r) => r.sc.start },
    {
      key: 'end',
      header: 'Ends / ended',
      numeric: true,
      render: (r) =>
        ONE_OFF_KINDS.includes(r.sc.kind) ? (
          <span className="muted">One-off</span>
        ) : r.sc.end == null ? (
          <span className="muted">Until cleared</span>
        ) : r.sc.end > now ? (
          <span>until {formatClock(r.sc.end)}</span>
        ) : (
          when(r.sc.end, now)
        ),
      sort: (r) => r.sc.end ?? Number.MAX_SAFE_INTEGER,
    },
    { key: 'dur', header: 'Duration', numeric: true, render: (r) => (r.duration == null ? '—' : formatDuration(r.duration)), sort: (r) => r.duration },
    { key: 'status', header: 'Status', render: (r) => <ScenarioState st={r.st} now={now} time={false} />, sort: (r) => r.st.key },
    { key: 'outcome', header: 'Outcome', render: (r) => <span title={r.outcome ?? undefined}>{r.outcome ?? <span className="muted">See impact band</span>}</span> },
    {
      key: 'events',
      header: 'Events',
      render: (r) => {
        const main = r.events.find((e) => !e.consequenceOf) ?? r.events[0];
        if (!main) return <span className="muted">None yet</span>;
        return (
          <span className="scnp-log-ev">
            <button className="row-link mono" onClick={() => openEvent(main.id)} title={`Open the report of ${main.id}: ${main.title}`}>
              {main.id}
            </button>
            {r.events.length > 1 && <span className="muted"> +{r.events.length - 1}</span>}
          </span>
        );
      },
      sort: (r) => r.events.length,
    },
    { key: 'source', header: 'Source', render: (r) => r.origin, sort: (r) => r.origin },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <span className="scnp-log-a">
          {r.target && <ShowButton target={r.target.t} label={r.target.label} />}
          {r.clearable && (
            <button className="btn sm" onClick={() => clear(r.sc.id)} title="End this scenario now">
              <X size={13} aria-hidden />
              Clear
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <Panel
      className="col-12"
      title="Scenario log"
      subtitle="Every scenario input since the last reset — all simulated; nothing is sent to equipment"
      actions={<span className="muted num">{d.rows.length} logged</span>}
      flush
    >
      <DataTable
        columns={columns}
        rows={d.rows}
        rowKey={(r) => r.sc.id}
        initialSort={{ key: 'start', dir: 'desc' }}
        maxHeight={360}
        empty="No scenarios yet. Activate one above, or follow the presenter guide."
      />
    </Panel>
  );
}
