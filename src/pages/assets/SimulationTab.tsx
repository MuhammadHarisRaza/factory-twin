import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { BASE_REJECT_RATE, BUFFERS, CHANGEOVER_EVERY_MIN, LINE, M2_PER_TILE, OPS_BY_ID, STAGES, STAGE_BY_ID, TARGET } from '../../model/plant';
import type { BufferDef, ProcessStage, ScenarioActivation, ScenarioKind } from '../../model/types';
import { SPEEDS, useSim, useSimValue } from '../../sim/store';
import { DEFAULT_START, MIN_PER_DAY, formatDateTime, formatDuration } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { SourceTag } from '../../ui/kit/Status';

const SCENARIO_KIND: Record<ScenarioKind, string> = {
  'machine-stop': 'Machine stop',
  'reduced-rate': 'Reduced rate',
  bottleneck: 'Bottleneck',
  'quality-deterioration': 'Quality deterioration',
  'truck-arrival': 'Truck arrival',
  'yard-congestion': 'Yard congestion',
  'prolonged-dock-stay': 'Prolonged dock stay',
};

const stageRate = (st: ProcessStage) => st.machines.reduce((a, id) => a + (OPS_BY_ID[id].idealRatePerHour ?? 0), 0);
const BUF_NAME = Object.fromEntries(BUFFERS.map((b) => [b.id, b.name]));

export function SimulationTab() {
  const seed = useSim((s) => s.seed);
  const speed = useSim((s) => s.speed);
  const running = useSim((s) => s.running);
  const reset = useSim((s) => s.reset);
  const [confirming, setConfirming] = useState(false);

  const { minute, buffers, scenarios } = useSimValue((s) => ({
    minute: s.minute,
    buffers: { ...s.buffers },
    scenarios: [...s.scenarios].reverse(),
  }));

  const speedLabel = SPEEDS.find((x) => x.value === speed);

  const stageCols: Column<ProcessStage>[] = [
    { key: 'step', header: 'Step', numeric: true, render: (st) => st.step, sort: (st) => st.step },
    { key: 'name', header: 'Stage', render: (st) => st.name, sort: (st) => st.name },
    { key: 'machines', header: 'Machines', render: (st) => <span className="mono">{st.machines.join(', ')}</span> },
    { key: 'rate', header: 'Ideal rate (tiles/h)', numeric: true, render: (st) => fmtInt(stageRate(st)), sort: (st) => stageRate(st) },
    {
      key: 'in',
      header: 'Input buffer',
      render: (st) => (st.inputBuffer ? BUF_NAME[st.inputBuffer] : <span className="muted">Raw-material supply</span>),
    },
    {
      key: 'c',
      header: '',
      render: (st) => (st.id === LINE.designConstraint ? <span className="tag">Design constraint</span> : null),
    },
  ];

  const bufferCols: Column<BufferDef>[] = [
    { key: 'name', header: 'Buffer', render: (b) => b.name, sort: (b) => b.name },
    { key: 'eq', header: 'Equipment', render: (b) => (b.equipmentId ? <span className="mono">{b.equipmentId}</span> : <span className="muted">Conveyor</span>) },
    { key: 'cap', header: 'Capacity (tiles)', numeric: true, render: (b) => fmtInt(b.capacity), sort: (b) => b.capacity },
    { key: 'init', header: 'Initial fill', numeric: true, render: (b) => fmtPct(b.initialFill, 0), sort: (b) => b.initialFill },
    { key: 'now', header: 'Current level', numeric: true, render: (b) => fmtPct(buffers[b.id] / b.capacity, 0), sort: (b) => buffers[b.id] / b.capacity },
  ];

  const scnCols: Column<ScenarioActivation>[] = [
    { key: 'id', header: 'Id', render: (sc) => <span className="mono">{sc.id}</span> },
    { key: 'label', header: 'Scenario', render: (sc) => <span title={sc.label}>{sc.label}</span> },
    { key: 'kind', header: 'Kind', render: (sc) => SCENARIO_KIND[sc.kind], sort: (sc) => sc.kind },
    { key: 'start', header: 'Start', render: (sc) => formatDateTime(sc.start), sort: (sc) => sc.start },
    {
      key: 'end',
      header: 'End',
      render: (sc) =>
        sc.end == null || sc.end > minute ? (
          <span className="dim">Active{sc.end != null ? ` until ${formatDateTime(sc.end)}` : ''}</span>
        ) : (
          <>
            {formatDateTime(sc.end)}
            <span className="sub">{formatDuration(sc.end - sc.start)}</span>
          </>
        ),
      sort: (sc) => sc.end ?? Infinity,
    },
    { key: 'src', header: 'Source', render: () => <SourceTag source="scenario" /> },
  ];

  return (
    <>
      <div className="col-4">
        <Panel title="Simulation run" subtitle="Deterministic, seeded model — same seed and scenario log, same plant">
          <dl className="dl">
            <dt>Seed</dt>
            <dd className="mono">{seed}</dd>
            <dt>Plant time</dt>
            <dd>{formatDateTime(minute)}</dd>
            <dt>Speed</dt>
            <dd>
              {speedLabel ? `${speedLabel.label} · ${speedLabel.hint}` : `${speed}×`}
              {!running && <span className="muted"> · paused</span>}
            </dd>
            <dt>Epoch</dt>
            <dd>{formatDateTime(0)} (minute 0)</dd>
            <dt>Run start</dt>
            <dd>
              {formatDateTime(DEFAULT_START)} · {fmt1(DEFAULT_START / MIN_PER_DAY)} days of history
            </dd>
            <dt>Line target</dt>
            <dd>
              {fmtInt(TARGET.goodPerHour)} tiles/h · {fmtInt(TARGET.goodPerHour * M2_PER_TILE)} m²/h (OEE target {fmtPct(TARGET.oeeTarget, 0)})
            </dd>
            <dt>Baseline reject rate</dt>
            <dd>{fmtPct(BASE_REJECT_RATE, 1)} of inspected tiles</dd>
            <dt>Product changeover</dt>
            <dd>Every {formatDuration(CHANGEOVER_EVERY_MIN)}</dd>
            <dt>Constraint</dt>
            <dd>{STAGE_BY_ID[LINE.designConstraint].name} (design)</dd>
          </dl>
          <div className="a-reset">
            {!confirming ? (
              <button className="btn" onClick={() => setConfirming(true)}>
                <RotateCcw size={13} /> Reset to baseline
              </button>
            ) : (
              <>
                <p>Rebuild the plant from seed {seed}? All scenarios and their effects are discarded.</p>
                <div className="a-reset-row">
                  <button
                    className="btn danger"
                    onClick={() => {
                      reset();
                      setConfirming(false);
                    }}
                  >
                    <RotateCcw size={13} /> Confirm reset
                  </button>
                  <button className="btn ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </Panel>
      </div>
      <div className="col-8">
        <Panel title="Process stages" subtitle="Ideal rates per stage (sum of machines)" flush>
          <DataTable columns={stageCols} rows={STAGES} rowKey={(st) => st.id} maxHeight="none" />
        </Panel>
      </div>
      <div className="col-6">
        <Panel title="WIP buffers" subtitle="Capacities in tile equivalents" flush>
          <DataTable columns={bufferCols} rows={BUFFERS} rowKey={(b) => b.id} maxHeight="none" />
        </Panel>
      </div>
      <div className="col-6">
        <Panel title="Scenario log" subtitle={`${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} since the last reset · newest first`} flush>
          <DataTable columns={scnCols} rows={scenarios} rowKey={(sc) => sc.id} maxHeight={380} empty="No scenarios activated — the plant is running its baseline" />
        </Panel>
      </div>
    </>
  );
}
