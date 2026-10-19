/**
 * Material flow (Production ?tab=material, brief §8 Material Flow): the stage chain upstream → downstream with
 * each stage's output rate in its physical unit and each buffer's level, trend, time to empty / full and inflow vs
 * outflow; the bottleneck ranking of the shared trace; the starvation / blockage findings of the rule engine with
 * their evidence; a time-range-controlled chart area for one buffer (level, inflow vs outflow); and the brief's
 * 12-stage mapping. Everything is simulated and labelled so; figures come from material.ts.
 */
import { ArrowRight, ChartLine, CircleHelp, CircleSlash, FileText, Landmark, TriangleAlert } from 'lucide-react';
import { openEquipment, openEvent, openStage } from '../../app/store';
import { CLASSIFICATION_LABEL, FINDING_STATUS_LABEL, type RuleFinding } from '../../intel/rules';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime } from '../../sim/time';
import { TimeSeriesChart } from '../../ui/kit/charts';
import { fmtPct } from '../../ui/kit/format';
import { Disclosure, EmptyState, ProvenanceBadge, Unavailable } from '../../ui/kit/Page';
import { OPERATIONAL_STATE, SeverityBadge, StatusBadge } from '../../ui/kit/Status';
import { TimeRange } from '../../ui/kit/TimeRange';
import type { Calc } from '../../calc';
import { Block } from './common';
import {
  bufferChart,
  bufferOfFinding,
  flowText,
  type ChainItem,
  type MaterialBuffer,
  type MaterialFlowData,
  type MaterialStage,
  type MappingRow,
  type Ranking,
} from './material';
import { MASS_DISCLOSURE, MASS_NOTE, NO_CALIBRATION } from './units';
import { useProductionUi } from './ui';

const n1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const signed = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${digits ? n1.format(Math.abs(v)) : Math.round(Math.abs(v)).toLocaleString('en-GB')}`;
const share = (v: number | null) => (v == null ? '—' : fmtPct(v, 0));

/** A Calc figure as text, or the honest reason when there is none (never 0). */
function CalcText({ c, render, label = 'Unavailable' }: { c: Calc<number>; render: (v: number) => string; label?: string }) {
  if (c.status === 'ok') return <span className="num" title={c.note}>{render(c.value)}</span>;
  return <Unavailable reason={c.reason}>{c.status === 'insufficient' ? 'Insufficient data' : label}</Unavailable>;
}

/** The Material flow tab; `d` is computed once per simulated minute by ProductionPage (materialFlow). */
export function MaterialFlow({ d }: { d: MaterialFlowData }) {
  const picked = useProductionUi((s) => s.materialBuffer);
  const setBuffer = useProductionUi((s) => s.setMaterialBuffer);
  const bufferId = picked && d.buffers.some((b) => b.id === picked) ? picked : d.focus;
  return (
    <>
      <Chain d={d} selected={bufferId} onSelect={setBuffer} />
      <div className="prod-2col">
        <BufferCharts d={d} bufferId={bufferId} onSelect={setBuffer} />
        <Findings d={d} onSelect={setBuffer} />
      </div>
      <div className="prod-2col even">
        <RankingBlock r={d.ranking} />
        <MappingBlock rows={d.mapping} />
      </div>
    </>
  );
}

// ── The stage chain ──────────────────────────────────────────────────────────

function StageRowView({ st }: { st: MaterialStage }) {
  const state = st.state ? OPERATIONAL_STATE[st.state] : null;
  return (
    <tr className="mf-stage">
      <td>
        <span className="mf-name">
          {st.monitored ? (
            <button type="button" className="row-link" onClick={() => openStage(st.monitored!)} title="Open the stage view">
              {st.name}
            </button>
          ) : (
            st.name
          )}
        </span>
        <span className="sub">
          Brief stage {st.briefNos.join(', ')} · {st.machines.map((m) => m.id).join(', ')}
        </span>
      </td>
      <td>{state ? <StatusBadge tone={state.tone} icon={state.icon} label={state.label} /> : <span className="muted">No state signal</span>}</td>
      <td className="n" title={st.basis}>
        <CalcText c={st.rate} render={(v) => flowText(v, st.unit)!} />
        {st.unit === 't/h' ? (
          <span className="sub mf-disclosure">{MASS_DISCLOSURE}</span>
        ) : (
          st.m2PerHour != null && <span className="sub">{Math.round(st.m2PerHour).toLocaleString('en-GB')} m²/h</span>
        )}
      </td>
      <td className="n">
        <span className="num">{share(st.share)}</span>
        <span className="sub">of {flowText(st.design, st.unit)} design</span>
      </td>
      <td colSpan={3} className="muted wrap">
        Stage output · mean rate over the window
      </td>
    </tr>
  );
}

const DIRECTION_WORD = { rising: '▲ rising', falling: '▼ falling', steady: 'steady' } as const;

function BufferRowView({ b, selected, onSelect }: { b: MaterialBuffer; selected: boolean; onSelect: (id: string) => void }) {
  const fired = b.findings.filter((f) => f.status === 'fired');
  const warn = b.horizon.kind === 'empty' ? b.ahead : b.horizon.kind === 'full' ? !b.ahead : false;
  return (
    <tr className={`mf-buffer${selected ? ' on' : ''}`}>
      <td>
        <span className="mf-name">
          <button type="button" className="row-link" onClick={() => onSelect(b.id)} title="Show this buffer's level and inflow vs outflow in the charts">
            <ChartLine size={11} aria-hidden /> {b.name}
          </button>
        </span>
        <span className="sub">
          {b.briefNo != null ? `Brief stage ${b.briefNo}` : 'Buffer'} · <span className="mono">{b.levelSignal}</span>
        </span>
      </td>
      <td>
        {fired.length ? (
          <span className="mf-flag">
            <TriangleAlert size={12} aria-hidden /> {fired.length} finding{fired.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="muted">No finding</span>
        )}
      </td>
      <td className="n">
        {b.level.status === 'ok' ? (
          <span className="mf-level">
            <span className="prod-buf-track" aria-hidden>
              <i style={{ width: `${Math.max(0, Math.min(100, b.level.value))}%` }} />
            </span>
            <span className="num">{n1.format(b.level.value)} %</span>
          </span>
        ) : (
          <Unavailable reason={b.level.reason}>Level not available</Unavailable>
        )}
        {b.bulk ? (
          <span className="sub" title={b.mass?.status !== 'ok' ? b.mass?.reason : undefined}>
            % only · {NO_CALIBRATION.toLowerCase()}
          </span>
        ) : (
          b.capacityTiles != null && <span className="sub">capacity {b.capacityTiles.toLocaleString('en-GB')} tiles</span>
        )}
      </td>
      <td className="n">
        <CalcText c={b.trend} render={(v) => `${signed(v)} %/h`} label="No trend" />
        <span className="sub">{b.direction ? DIRECTION_WORD[b.direction] : 'trend unknown'}</span>
      </td>
      <td className="wrap">
        <span className={warn ? 'mf-warn' : undefined}>
          {warn && <TriangleAlert size={12} aria-hidden />} {b.horizon.text}
        </span>
      </td>
      <td className="n">
        <span className="mf-io">
          <CalcText c={b.inflow} render={(v) => flowText(v, b.unit)!} label="Not measured" />
          <span className="muted"> in · </span>
          <CalcText c={b.outflow} render={(v) => flowText(v, b.unit)!} label="Not measured" />
          <span className="muted"> out</span>
        </span>
        {b.unit === 't/h' && <span className="sub mf-disclosure">{MASS_DISCLOSURE}</span>}
      </td>
      <td>
        {b.balance.status === 'ok' ? (
          <span title={`Net = inflow − outflow; within ±${flowText(b.deadband, b.unit)} counts as balanced`}>
            <span className="num">
              {signed(b.balance.value.net, b.unit === 't/h' ? 1 : 0)} {b.unit}
            </span>
            <span className="sub">{b.balance.value.direction}</span>
          </span>
        ) : (
          <Unavailable reason={b.balance.reason}>No balance</Unavailable>
        )}
      </td>
    </tr>
  );
}

function Chain({ d, selected, onSelect }: { d: MaterialFlowData; selected: string; onSelect: (id: string) => void }) {
  return (
    <Block
      title="Stage chain"
      subtitle={`Upstream → downstream · rates, levels and balance over the last ${d.window.minutes} min (${formatClock(d.window.from)}–${formatClock(d.window.to)}) · simulated`}
      actions={<ProvenanceBadge kind="simulated" />}
      note={
        <>
          <span>{MASS_NOTE}</span>
          <span>
            Slip tanks and powder silos are shown as level % only — {NO_CALIBRATION.toLowerCase()}, so no mass is derived from a level. Trend = least-squares slope of the
            level signal; time to empty / full is a linear extrapolation of that trend, not a forecast. Balance = inflow − outflow (rule F-BALANCE deadband).
          </span>
          <span>After pressing, rates are tiles/h with m²/h. Stage 8 (cooling buffer) is the kiln outfeed storage — partial; stage 9 is not present on this line.</span>
        </>
      }
      flush
    >
      <p className="prod-pad mf-summary">{d.summary}</p>
      <div className="mf-table-wrap">
        <table className="table mf-table">
          <thead>
            <tr>
              <th>Stage / buffer</th>
              <th>State · findings</th>
              <th className="n">Rate · level</th>
              <th className="n">vs design · trend</th>
              <th>Time to empty / full</th>
              <th className="n">Inflow vs outflow</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
            {d.chain.map((c: ChainItem) =>
              c.kind === 'stage' ? (
                <StageRowView key={c.stage.id} st={c.stage} />
              ) : c.kind === 'buffer' ? (
                <BufferRowView key={c.buffer.id} b={c.buffer} selected={c.buffer.id === selected} onSelect={onSelect} />
              ) : (
                <tr key={`absent-${c.def.no}`} className="mf-absent">
                  <td>
                    <span className="mf-name">
                      <CircleSlash size={12} aria-hidden /> {c.def.name}
                    </span>
                    <span className="sub">Brief stage {c.def.no}</span>
                  </td>
                  <td colSpan={6} className="wrap muted">
                    Not present — flagged for configuration. {c.def.note}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

// ── Chart area ───────────────────────────────────────────────────────────────

function BufferCharts({ d, bufferId, onSelect }: { d: MaterialFlowData; bufferId: string; onSelect: (id: string) => void }) {
  const range = useProductionUi((s) => s.materialRange);
  const setRange = useProductionUi((s) => s.setMaterialRange);
  const c = useSimValue((s) => bufferChart(s, bufferId, range), [bufferId, range]);
  const b = d.buffers.find((x) => x.id === bufferId);
  return (
    <Block
      title="Buffer over time"
      subtitle={c ? `${c.name} · level and inflow vs outflow · ${c.resolution === 'hour' ? 'hourly' : c.stepMin === 1 ? 'minute' : `${c.stepMin}-min`} data · simulated` : 'Select a buffer'}
      actions={
        <>
          <label className="mf-select">
            <span className="sr-only">Buffer</span>
            <select value={bufferId} onChange={(e) => onSelect(e.target.value)} aria-label="Buffer">
              {d.buffers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <TimeRange value={range} onChange={setRange} label="Chart range" />
        </>
      }
      note={
        <>
          <span>Gaps are missing, stale or bad-quality samples — never drawn as zero. Inflow = the feeding stage’s output; outflow = what the drawing stage takes.</span>
          {c?.notes.map((x) => (
            <span key={x}>{x}</span>
          ))}
          {b?.bulk && <span>{NO_CALIBRATION}: the level is a percentage, not a quantity of material.</span>}
        </>
      }
    >
      {!c ? (
        <EmptyState title="No buffer level signal configured" />
      ) : (
        <div className="mf-charts">
          <TimeSeriesChart
            label={`${c.name} level, %`}
            from={c.from}
            to={c.to}
            unit="%"
            yMin={0}
            yMax={100}
            height={150}
            formatValue={(v) => n1.format(v)}
            series={[{ id: 'level', label: `Level · ${c.level.signalId}`, t: c.level.t, v: c.level.v, color: 'var(--series-1)' }]}
            emptyReason="No level sample in this range"
          />
          <TimeSeriesChart
            label={`${c.name} inflow vs outflow, ${c.unit}`}
            from={c.from}
            to={c.to}
            unit={c.unit}
            yMin={0}
            height={170}
            formatValue={(v) => (c.unit === 't/h' ? n1.format(v) : Math.round(v).toLocaleString('en-GB'))}
            series={[
              { id: 'in', label: c.inflow.label, t: c.inflow.t, v: c.inflow.v, color: 'var(--series-3)' },
              { id: 'out', label: c.outflow.label, t: c.outflow.t, v: c.outflow.v, color: 'var(--series-2)', dashed: true },
            ]}
            emptyReason="No inflow / outflow sample in this range"
          />
        </div>
      )}
    </Block>
  );
}

// ── Findings ─────────────────────────────────────────────────────────────────

function EvidenceLinks({ f, onSelect }: { f: RuleFinding; onSelect: (id: string) => void }) {
  const buf = bufferOfFinding(f);
  return (
    <span className="mf-ev">
      {f.evidence.slice(0, 4).map((e, i) =>
        e.kind === 'event' && e.ref ? (
          <button key={i} type="button" className="row-link" onClick={() => openEvent(e.ref!)} title="Open the event report">
            <FileText size={11} aria-hidden /> {e.label}
          </button>
        ) : (
          <span key={i} className="muted" title={e.ref}>
            {e.label}
          </span>
        ),
      )}
      {buf && (
        <button type="button" className="row-link" onClick={() => onSelect(buf)}>
          <ChartLine size={11} aria-hidden /> Chart
        </button>
      )}
      {f.scope.kind === 'equipment' && (
        <button type="button" className="row-link" onClick={() => openEquipment((f.scope as { equipmentId: string }).equipmentId)} title="Open the equipment panel in the Factory Twin">
          Open in Factory Twin <ArrowRight size={11} aria-hidden />
        </button>
      )}
    </span>
  );
}

function Findings({ d, onSelect }: { d: MaterialFlowData; onSelect: (id: string) => void }) {
  const { fired, insufficient } = d.findings;
  return (
    <Block
      title="Starvation and blockage findings"
      subtitle={`Rule engine · flow family · ${fired.length} detected, ${d.findings.clear} clear${insufficient.length ? `, ${insufficient.length} not evaluated` : ''} · simulated data`}
      note={<span>Findings are rule evaluations of simulated signals (Rule-based), hypotheses to check — not events and not confirmed causes.</span>}
      flush
    >
      {fired.length ? (
        <ul className="mf-findings">
          {fired.map((f) => (
            <li key={f.key}>
              <div className="mf-f-h">
                <SeverityBadge severity={f.severity} />
                <b>{f.title}</b>
                <span className="tag">{CLASSIFICATION_LABEL[f.classification]}</span>
              </div>
              <p>{f.explanation}</p>
              <div className="mf-f-meta">
                {f.firstSeen != null && <span>since {formatDateTime(f.firstSeen)}</span>}
                <span title={f.confidenceNote}>{f.confidence} confidence</span>
                {f.next && <span>Next: {f.next}</span>}
              </div>
              <EvidenceLinks f={f} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No starvation or blockage finding detected" icon={Landmark}>
          All {d.findings.total} flow checks are clear or could not be evaluated.
        </EmptyState>
      )}
      {insufficient.length > 0 && (
        <div className="prod-pad">
          <Disclosure title="Not evaluated" meta={`${insufficient.length} checks · insufficient data`}>
            <ul className="mf-ne">
              {insufficient.map((f) => (
                <li key={f.key}>
                  <StatusBadge tone="neutral" icon={CircleHelp} label={FINDING_STATUS_LABEL[f.status]} /> <b>{f.title}</b>
                  <span className="muted"> — {f.missingSignals.map((m) => `${m.signalId}: ${m.reason}`).join('; ') || f.explanation}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </Block>
  );
}

// ── Bottleneck ranking ───────────────────────────────────────────────────────

function RankingBlock({ r }: { r: Ranking }) {
  return (
    <Block
      title="Bottleneck ranking"
      subtitle={`Shared bottleneck trace · ${r.windowLabel} · share of planned time · simulated`}
      note={
        <span>
          From the minute log (src/sim/metrics bottleneck): partial starvation and blocking count as the held-back fraction of a minute. A stage held up more than{' '}
          {fmtPct(r.heldUpShare, 0)} of the window points the trace further along the line. {r.claim.charAt(0).toUpperCase() + r.claim.slice(1)}.
        </span>
      }
      flush
    >
      <table className="table mf-rank">
        <thead>
          <tr>
            <th>#</th>
            <th>Stage</th>
            <th className="n">Working</th>
            <th className="n">Down</th>
            <th className="n">Starved</th>
            <th className="n">Blocked</th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((x, i) => (
            <tr key={x.stage} className={x.traced ? 'on' : undefined}>
              <td className="num muted">{i + 1}</td>
              <td>
                {x.monitored ? (
                  <button type="button" className="row-link" onClick={() => openStage(x.monitored!)}>
                    {x.name}
                  </button>
                ) : (
                  x.name
                )}
                {x.traced && <span className="tag">trace ends here</span>}
                {x.design && <span className="tag">design constraint</span>}
                {x.activeShare == null && <span className="sub">No planned time in the window</span>}
              </td>
              <td className="n num">{share(x.workingShare)}</td>
              <td className="n num">{share(x.downShare)}</td>
              <td className="n num">{share(x.starvedShare)}</td>
              <td className="n num">{share(x.blockedShare)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Block>
  );
}

// ── 12-stage mapping ─────────────────────────────────────────────────────────

function MappingBlock({ rows }: { rows: MappingRow[] }) {
  return (
    <Block
      title="Brief stages on this line"
      subtitle="Which of the twelve production stages each monitored stage covers"
      note={<span>A sorting-line slowdown that fills the kiln outfeed (stage 8) stands in for the brief’s “polishing slowdown → cooling buffer fills” — this line has no polishing.</span>}
      flush
    >
      <table className="table mf-map">
        <thead>
          <tr>
            <th className="n">No</th>
            <th>Brief stage</th>
            <th>Monitored stage</th>
            <th>Present</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.no} className={r.present !== 'yes' ? 'mf-partial' : undefined}>
              <td className="n num">{r.no}</td>
              <td className="wrap">
                {r.name}
                {r.present !== 'yes' && <span className="sub">{r.note}</span>}
              </td>
              <td>
                {r.monitored ? (
                  <button type="button" className="row-link" onClick={() => openStage(r.monitored!.id)}>
                    {r.monitored.name}
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {r.present === 'yes' ? (
                  <span>{r.flag}</span>
                ) : (
                  <span className="mf-warn">
                    {r.present === 'partial' ? <TriangleAlert size={12} aria-hidden /> : <CircleSlash size={12} aria-hidden />} {r.flag}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Block>
  );
}
