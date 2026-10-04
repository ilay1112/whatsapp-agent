// tests/integration/auto-mode.flow.test.ts - T2 6 row `auto-mode.flow` (owner V2-W1-04 in Wave 1, fix-up right V2-W2-01).
// Through the production compose(): track record (three click approvals) -> auto:requestEnable {trial:true} -> the scripted native
// dialog [1, checked] -> a shadow policy -> three proposals => three shadow decisions, zero writes, auto_shadow chips -> auto:endShadow
// -> on -> the next eligible proposal is written by tryAuto BEFORE dashboard:changed, with a toast, pre-write rows committed at call
// time, readback post_*, an event_revisions row, and an AutoStrip row via auto:listWrites -> the toast's Undo (action 0) undoes it with
// approved_by 'user_toast' -> every pause trigger of B7; manual approvals keep working while paused.
// BLOCKED-BY V2-W2-01 until compose() wires tryAuto after S4, the auto:* handlers, the notifier's toast actions and the dialog seam.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../src/shared/schemas.ts';
import { LIMITS } from '../../src/shared/types.ts';
import { Notification, dialog } from '../mocks/electron.ts';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import type { EpochMs, ItemCard } from '../../src/shared/types.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});
const HOUR = 3_600_000;
const jid = (n: number): string => `9725500000${String(n).padStart(2, '0')}@s.whatsapp.net`;

/** Every message `[s<n>-<variant>]` asks for its OWN slot on <day> (a definite, eligible create - every v2 field high / clean):
 *  09:00 + n hours, + 30 min for variant 1, 20 minutes long. [V2-W2-01 fix-up] Distinct slots, because a second "Dentist at 15:00" is a
 *  real free/busy conflict with the first one (amber `conflict` => AutoGate falls back with badge_amber, correctly). 2026-09-21 = Monday. */
const TOKEN = (n: number, variant: number): string => `[s${String(n)}-${String(variant)}]`;
const RULES = (weekday: number): StubRule[] => [
  // variant 1 first: a chat's second message is triaged with its first one still in the window
  ...[1, 0].flatMap((variant) =>
    Array.from({ length: 12 }, (_x, i) => i + 1).map((n): StubRule => ({
      when: { purpose: 'extract', contains: TOKEN(n, variant) },
      respond: {
        structured: extraction({
          intent: 'schedule_request',
          needsReply: true,
          title: 'Dentist',
          dateKind: 'weekday',
          weekday,
          time24h: `${String(8 + n).padStart(2, '0')}:${variant === 1 ? '30' : '00'}`,
          durationMin: 20,
          refersToExisting: false,
          change: 'no_change',
          changeConfidence: 'low',
          confidence: 'high',
        }),
      },
    })),
  ),
  { when: { purpose: 'draft' }, respond: { text: 'See you then', stopReason: 'end' } },
];

async function inboundCard(harness: Harness, n: number, variant = 0): Promise<ItemCard> {
  // the user's own earlier "hey" makes the chat known + active (context only); never re-sent into a chat that already has an event,
  // where a live own message would be a self trigger (F28)
  if (variant === 0)
    await harness.bridge.outboundFromPhone({ chatJid: jid(n), text: 'hey', ts: new Date(harness.clock.now() - HOUR) });
  await harness.bridge.inbound({ chatJid: jid(n), text: `dentist? ${TOKEN(n, variant)}` });
  await harness.settle();
  const dash = await harness.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error('no dashboard');
  const all = [...dash.value.needsReply, ...dash.value.inCalendar];
  const card = all.find((c) => c.chat.chatRef === harness.repos.chats.byJid(jid(n))?.id);
  if (card === undefined) throw new Error(`no card for chat ${String(n)}`);
  return card;
}
async function clickCreate(harness: Harness, card: ItemCard): Promise<void> {
  const create = card.actions.find((a) => a.kind === 'create_event')!;
  const res = await harness.invoke('action:approve', {
    actionId: create.actionId,
    kind: 'create_event',
    shownHash: create.shownHash,
    confirmConflict: true,
  });
  if (!res.ok) throw new Error(JSON.stringify(res));
}
const creates = (harness: Harness): number => harness.calendar.calls.filter((c) => c.tool === 'create-event').length;

describe('auto-mode flow through compose()', () => {
  it('track record -> trial -> shadow decisions -> endShadow -> an automatic write -> the toast Undo', async () => {
    h = await createHarness({ rules: RULES(4) });
    for (const n of [1, 2, 3]) await clickCreate(h, await inboundCard(h, n));
    expect(creates(h)).toBe(3);

    dialog.__script([{ response: 1, checkboxChecked: true }]);
    const enabled = await h.invoke('auto:requestEnable', { scope: DEFAULT_AUTO_SCOPE, trial: true });
    expect(enabled).toMatchObject({ ok: true, value: { policy: { state: 'shadow' } } });

    for (const n of [4, 5, 6]) {
      const card = await inboundCard(h, n);
      expect(card.auto?.chip).toBe('auto_shadow');
    }
    expect(creates(h)).toBe(3);
    expect(await h.invoke('auto:endShadow', { confirm: true })).toMatchObject({
      ok: true,
      value: { policy: { state: 'on' } },
    });

    const seenAtCall: number[] = [];
    const off = h.calendar.onBeforeCall((tool) => {
      if (tool === 'create-event') seenAtCall.push(h!.repos.autoWrites.since(0 as EpochMs).length);
    });
    const pushesBefore = h.pushes.length;
    const card = await inboundCard(h, 7);
    off();
    expect(creates(h)).toBe(4);
    expect(seenAtCall).toEqual([1]); // the auto_writes row was committed BEFORE the call arrived (I8)
    expect(card.auto?.chip).toBe('automatic');
    const pushes = h.pushes.slice(pushesBefore).map((p) => p.event);
    expect(pushes.indexOf('auto:changed')).toBeGreaterThanOrEqual(0);
    expect(h.notifications.some((t) => t.title === 'Calendar: an event was added automatically')).toBe(true);
    const writes = await h.invoke('auto:listWrites', { sinceTs: 0 });
    if (!writes.ok) throw new Error('listWrites');
    expect(writes.value.writes).toHaveLength(1);
    const w = h.repos.autoWrites.byId(writes.value.writes[0]!.autoWriteId)!;
    expect(w.postEtag).not.toBeNull();
    expect(h.repos.eventRevisions.byId(w.revisionId!)).not.toBeNull();

    // the toast's Undo button (action index 0) - main-only, approved_by 'user_toast'
    const toastIndex = Notification.instances.findIndex(
      (n) => n.title === 'Calendar: an event was added automatically',
    );
    Notification.__emitAction(toastIndex, 0);
    await h.settle();
    const after = h.repos.autoWrites.byId(w.id)!;
    expect(after.undoState).toBe('undone');
    expect(h.repos.actions.byId(after.undoActionId!)!.approvedBy).toBe('user_toast');
  });

  it('each pause trigger of B7 pauses with its reason, and a click still works while paused', async () => {
    h = await createHarness({ rules: RULES(4) });
    for (const n of [1, 2, 3]) await clickCreate(h, await inboundCard(h, n));
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    await h.invoke('auto:requestEnable', { scope: DEFAULT_AUTO_SCOPE, trial: false });
    // budget: two automatic writes in one chat within 30 min
    await inboundCard(h, 10);
    await h.advance(10 * 60_000);
    const second = await inboundCard(h, 10, 1);
    const state = await h.invoke('auto:getState', undefined);
    expect(state).toMatchObject({
      ok: true,
      value: { policy: { state: 'paused', pausedReason: 'circuit_breaker_rate' } },
    });
    await clickCreate(h, second);
    // unattended: 7 days without focus
    await h.invoke('auto:resume', { confirm: true });
    h.setWindowState({ focused: false, visible: false });
    await h.advance(LIMITS.autoUnattendedMs + HOUR);
    h.setWindowState({ focused: true, visible: true });
    expect(await h.invoke('auto:getState', undefined)).toMatchObject({
      ok: true,
      value: { policy: { pausedReason: 'unattended' } },
    });
  }, 60_000); // [V2-W2-01] 7 virtual days of timers through the real compose(): allow for a loaded parallel run
});
