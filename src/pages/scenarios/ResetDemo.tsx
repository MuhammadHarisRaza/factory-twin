import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleDashed, Loader2, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useSim, useSimValue } from '../../sim/store';
import { DEFAULT_START, formatDateTime, formatDuration } from '../../sim/time';
import { StatusBadge } from '../../ui/kit/Status';
import { resetChecks, type CheckResult } from './demos';
import { resetDemo, useResetCheck } from './actions';

const START = formatDateTime(DEFAULT_START);
/** Element id of the reset card (the presenter guide scrolls to it). */
export const RESET_CARD_ID = 'scnp-reset-card';
const EXPLAIN = `Restores the seeded starting point — ${START} with 7 days of simulated history — and removes every scenario with the events, evidence, alerts and vehicles it created. Twin selections, guided-demo set-ups and the copilot conversation are cleared; clock speed and financial assumptions are kept.`;

function Check({ c }: { c: CheckResult }) {
  return (
    <li className="scnp-check">
      {c.ok === true ? (
        <StatusBadge tone="good" icon={CircleCheck} label={c.label} />
      ) : c.ok === false ? (
        <StatusBadge tone="critical" icon={TriangleAlert} label={c.label} />
      ) : (
        <StatusBadge tone="neutral" icon={CircleDashed} label={c.label} />
      )}
      <span>{c.detail}</span>
    </li>
  );
}

/** Checks of the last completed reset, against the plant now and its baseline. */
function ResetChecks() {
  const snapshot = useResetCheck((s) => s.snapshot);
  const dismiss = useResetCheck((s) => s.dismiss);
  const baseline = useSim((s) => s.baseline);
  const checks = useSimValue((s) => (snapshot ? resetChecks(snapshot, s, baseline) : []), [snapshot, baseline]);
  if (!snapshot) return null;
  const ok = checks.every((c) => c.ok !== false);
  return (
    <div className="scnp-checks" role="status" aria-label="After-reset checks">
      <div className="scnp-checks-h">
        <b>
          {ok ? <CircleCheck size={14} aria-hidden className="scnp-ok" /> : <TriangleAlert size={14} aria-hidden className="scnp-warn" />}
          Reset to {formatDateTime(snapshot.at)}
        </b>
        <button type="button" className="btn ghost sm icon" onClick={dismiss} title="Dismiss the checks" aria-label="Dismiss the checks">
          <X size={12} />
        </button>
      </div>
      <ul>
        {checks.map((c) => (
          <Check key={c.key} c={c} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Two-step Reset Demo: the first click only asks; the confirmation names what will be discarded,
 * defaults focus to Cancel and lapses after 10 s. The rebuild runs in the background ("Resetting…")
 * and the after-reset checks follow: no active scenario, no events after the session start,
 * counters at baseline.
 */
export function ResetDemo() {
  const [confirm, setConfirm] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const resetting = useSim((s) => s.resetting);
  const phase = useResetCheck((s) => s.phase);
  const d = useSimValue((s) => ({ scenarios: s.scenarios.length, elapsed: Math.max(0, s.minute - DEFAULT_START) }));

  useEffect(() => {
    if (!confirm) return;
    cancelRef.current?.focus();
    const t = setTimeout(() => setConfirm(false), 10_000);
    return () => clearTimeout(t);
  }, [confirm]);

  const body = resetting ? (
    <div className="scnp-resetting" role="status">
      <Loader2 size={15} className="spin" aria-hidden />
      <span>
        <b>Resetting…</b> Rebuilding the seeded plant and its 7-day history in the background. Scenario controls are paused until it is in place.
      </span>
    </div>
  ) : confirm ? (
    <div className="scnp-confirm" role="alertdialog" aria-labelledby="scnp-confirm-t" aria-describedby="scnp-confirm-d">
      <b id="scnp-confirm-t">
        <TriangleAlert size={14} aria-hidden />
        Reset the demo?
      </b>
      <span id="scnp-confirm-d">
        Discards {d.scenarios} scenario{d.scenarios === 1 ? '' : 's'}, every event and acknowledgement of this session and {formatDuration(d.elapsed)} of simulated time, and returns to {START}.
      </span>
      <div className="scnp-confirm-a">
        <button type="button" ref={cancelRef} className="btn" onClick={() => setConfirm(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            setConfirm(false);
            resetDemo();
          }}
        >
          <RotateCcw size={14} aria-hidden />
          Reset demo
        </button>
      </div>
    </div>
  ) : (
    <>
      <p className="scnp-reset-p">{EXPLAIN}</p>
      <div className="scnp-reset-a">
        <button type="button" className="btn" onClick={() => setConfirm(true)}>
          <RotateCcw size={14} aria-hidden />
          Reset demo…
        </button>
      </div>
      {phase === 'done' && <ResetChecks />}
    </>
  );

  return (
    <article className="scnp-card scnp-demo scnp-reset" id={RESET_CARD_ID} aria-label="Demonstration E: reset">
      <header className="scnp-card-h">
        <span className="scnp-letter" aria-hidden>
          E
        </span>
        <h3>Reset</h3>
        <span className="scnp-uc">Between meetings or to start again</span>
      </header>
      {body}
    </article>
  );
}
