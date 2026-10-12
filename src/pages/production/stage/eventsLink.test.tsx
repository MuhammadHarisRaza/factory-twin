/**
 * The stage view's "Events & Reports" button opens the Events tab listing that stage's events (stage
 * filter, all recorded time) — not the unfiltered list with whatever filters were used last — and that
 * list holds exactly the events the stage view counts (same membership rule).
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

const spy = vi.hoisted(() => ({ openEventsFor: vi.fn() }));
vi.mock('../../../ui/events/open', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../ui/events/open')>()), openEventsFor: spy.openEventsFor }));

import { MONITORED_STAGES, MONITORED_STAGE_BY_ID } from '../../../model/plant';
import { activateScenario, advance, createSim } from '../../../sim/engine';
import { eventFiltersFor, eventsForSubject } from '../../../ui/events/open';
import { stageEvents } from './derive';
import { StageEventsButton } from './StageView';

describe('stage view → Events & Reports', () => {
  it('opens the Events tab filtered to the stage', () => {
    for (const ms of [MONITORED_STAGE_BY_ID.KILN, MONITORED_STAGE_BY_ID.PRESS]) {
      spy.openEventsFor.mockClear();
      const el = StageEventsButton({ ms }) as ReactElement<{ onClick: () => void; children: unknown }>;
      el.props.onClick();
      expect(spy.openEventsFor).toHaveBeenCalledTimes(1);
      expect(spy.openEventsFor).toHaveBeenCalledWith({ stage: ms.id });
    }
    expect(eventFiltersFor({ stage: 'KILN' })).toMatchObject({ stage: 'KILN', window: 'all', query: '', category: 'all', status: 'all' });
  });

  it('lists exactly the events the stage view counts', () => {
    const s = createSim(62, 2 * 1440 + 240);
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: s.minute + 30, label: 'Kiln infeed stop' });
    advance(s, s.minute + 45);
    for (const ms of MONITORED_STAGES) {
      const listed = eventsForSubject(s, { stage: ms.id }).map((e) => e.id).sort();
      expect(listed, ms.id).toEqual(stageEvents(s, ms).map((e) => e.id).sort());
    }
  });
});
