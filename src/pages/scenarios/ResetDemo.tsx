import { useEffect, useRef, useState } from 'react';
import { CircleCheck, RotateCcw, TriangleAlert } from 'lucide-react';
import { useSimValue } from '../../sim/store';
import { DEFAULT_START, formatDateTime, formatDuration } from '../../sim/time';
import { Panel } from '../../ui/kit/Panel';
import { resetDemo } from './actions';

const START = formatDateTime(DEFAULT_START);
const EXPLAIN = `Restores the seeded starting point — ${START} with 7 days of simulated history — and removes every scenario with the events, alerts and vehicles it created. Twin selections are cleared; clock speed and energy tariffs are kept.`;

/**
 * Two-step Reset Demo: the first click only asks; the confirmation names what will be
 * discarded, defaults focus to Cancel and lapses after 10 s.
 */
export function ResetDemo({ variant = 'panel' }: { variant?: 'panel' | 'compact' }) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'done'>('idle');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const d = useSimValue((s) => ({ scenarios: s.scenarios.length, elapsed: Math.max(0, s.minute - DEFAULT_START) }));

  useEffect(() => {
    if (phase === 'idle') return;
    if (phase === 'confirm') cancelRef.current?.focus();
    const t = setTimeout(() => setPhase('idle'), phase === 'confirm' ? 10_000 : 6_000);
    return () => clearTimeout(t);
  }, [phase]);

  const body =
    phase === 'confirm' ? (
      <div className="scnp-confirm" role="alertdialog" aria-labelledby="scnp-confirm-t" aria-describedby="scnp-confirm-d">
        <b id="scnp-confirm-t">
          <TriangleAlert size={14} aria-hidden />
          Reset the demo?
        </b>
        <span id="scnp-confirm-d">
          Discards {d.scenarios} scenario{d.scenarios === 1 ? '' : 's'} and {formatDuration(d.elapsed)} of simulated time, and returns to {START}.
        </span>
        <div className="scnp-confirm-a">
          <button ref={cancelRef} className="btn" onClick={() => setPhase('idle')}>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={() => {
              resetDemo();
              setPhase('done');
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
          <button className="btn" onClick={() => setPhase('confirm')}>
            <RotateCcw size={14} aria-hidden />
            Reset demo…
          </button>
          {phase === 'done' && (
            <span className="scnp-done" role="status">
              <CircleCheck size={14} aria-hidden />
              Reset to {START}; all scenarios removed.
            </span>
          )}
        </div>
      </>
    );

  if (variant === 'compact')
    return (
      <section className="scnp-reset compact" aria-label="Reset demo">
        <h3>Reset demo</h3>
        {body}
      </section>
    );
  return (
    <Panel title="Reset demo" subtitle="Use between meetings or to start the story again">
      <div className="scnp-reset">{body}</div>
    </Panel>
  );
}
