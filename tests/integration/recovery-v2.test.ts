// tests/integration/recovery-v2.test.ts - T2 6 row `recovery-v2` (owner V2-W1-04 in Wave 1, fix-up right V2-W2-01).
// Kill between the write-ahead and the PATCH (update) => unknown_outcome, reconciled read-only by get-event (never list-events, never a
// re-patch) => done or "Apply again"; crash_after_patch => reconcile done with exactly one applied version; an automatic write
// interrupted by a crash => policy paused circuit_breaker_unknown and post_* / revision_id filled by reconcile.
// The job-reaper rows of this file (stale job-*.pid.json, decoy pids, quit during a CLI / whisper job) are V2-W1-06 / V2-W1-07 wiring.
// BLOCKED-BY V2-W2-01: a real restart of compose() on the same userData with the v2 executor wired.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import type { EpochMs } from '../../src/shared/types.ts';

const opened: Harness[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!.dispose();
});
const CHAT = '972550000051@s.whatsapp.net';
const HOUR = 3_600_000;
const RULES: StubRule[] = [
  {
    when: { purpose: 'extract', contains: 'move it' },
    respond: {
      structured: extraction({
        intent: 'reschedule',
        needsReply: true,
        title: 'Dentist',
        dateKind: 'weekday',
        weekday: 5,
        time24h: '17:00',
        refersToExisting: true,
        change: 'reschedule',
        changeConfidence: 'high',
        confidence: 'high',
      }),
    },
  },
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'schedule_request',
        needsReply: true,
        title: 'Dentist',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '15:00',
        durationMin: 60,
        confidence: 'high',
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: 'OK', stopReason: 'end' } },
];

describe('recovery v2 through a restart of compose()', () => {
  it('crash_after_patch: the PATCH landed, the answer never came => after restart the update reconciles to done, one applied version', async () => {
    const first = await createHarness({ rules: RULES });
    opened.push(first);
    await first.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(first.clock.now() - HOUR) });
    await first.bridge.inbound({ chatJid: CHAT, text: 'dentist Thursday 15:00?' });
    await first.settle();
    const d1 = await first.invoke('dashboard:get', undefined);
    if (!d1.ok) throw new Error('dashboard');
    const card = d1.value.needsReply[0]!;
    const create = card.actions.find((a) => a.kind === 'create_event')!;
    await first.invoke('action:approve', {
      actionId: create.actionId,
      kind: 'create_event',
      shownHash: create.shownHash,
    });
    await first.bridge.inbound({ chatJid: CHAT, text: 'can we move it to Friday 17:00?' });
    await first.settle();
    const d2 = await first.invoke('dashboard:get', undefined);
    if (!d2.ok) throw new Error('dashboard');
    const change = d2.value.needsReply.find((c) => c.actions.some((a) => a.kind === 'update_event'))!;
    const upd = change.actions.find((a) => a.kind === 'update_event')!;
    first.calendar.scenario('crash_after_patch');
    await first.invoke('action:approve', { actionId: upd.actionId, kind: 'update_event', shownHash: upd.shownHash });
    const lists = first.calendar.calls.filter((c) => c.tool === 'list-events').length;
    const userData = first.userData;
    await first.runtime.shutdown();
    // the Google calendar outlives the app: the restarted app talks to a calendar holding the SAME events (the PATCH landed there)
    const second = await createHarness({
      rules: RULES,
      userData,
      events: first.calendar.fake.events.map((e) => structuredClone(e)),
    });
    opened.push(second);
    const action = second.repos.actions.byId(upd.actionId as never)!;
    expect(action.state).toBe('done');
    expect(second.calendar.calls.filter((c) => c.tool === 'update-event')).toHaveLength(0); // never a re-patch
    expect(second.calendar.calls.filter((c) => c.tool === 'list-events').length).toBeLessThanOrEqual(lists);
    void (0 as unknown as EpochMs);
  });
});
