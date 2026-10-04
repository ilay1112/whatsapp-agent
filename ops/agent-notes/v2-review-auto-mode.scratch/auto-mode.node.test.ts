// SCRATCH ONLY - adversarial review "auto-mode". Each `it` asserts what the contract requires; RED = the finding is proven.
// Uses the same exec rig as src/main/exec/actionExecutor.*.test.ts (real in-memory DB + production triggers + fake calendar v2).
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../../src/shared/schemas';
import { LIMITS } from '../../../src/shared/types';
import type { EpochMs } from '../../../src/shared/types';
import { evaluateAutoGate } from '../../../src/main/exec/autoGate';
import { allClearCreate } from '../../../src/main/exec/autoGate.fixtures';
import { createAutoPolicyService } from '../../../src/main/exec/autoPolicy';
import type { AutoDialog } from '../../../src/main/app/autoDialog';
import type { McpReadClient } from '../../../src/main/mcp/readClient';
import { CTX, RIG_SNAPSHOT, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});
async function rig(opts: RigOptions = {}): Promise<Rig> {
  const r = await makeExecRig(opts);
  rigs.push(r);
  return r;
}
const MIN = 60_000;
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-1: toast Undo reports success when the undo did not happen', () => {
  it('undoAuto(..., user_toast) of an automatic reschedule whose old slot is now busy must not answer ok:true (compose.ts maps r.ok to the "Calendar change undone" toast)', async () => {
    const r = await rig();
    await r.trackRecord();
    const source = await r.createByClick({ slot: WED });
    r.policy('on');
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const o = await r.exec.tryAuto(d.action.id);
    expect(o).toMatchObject({ verdict: 'auto', result: 'done' });
    if (o.verdict === 'none') throw new Error('unreachable');
    // the user (or anything) books the freed Wednesday slot
    await r.createByClick({ chatN: 3, slot: WED, title: 'Other' });
    // the toast's Undo button: compose.ts:646-648 calls executor.undoAuto(id,'user_toast',null) then notifier.autoUndone(r.ok)
    const res = await r.exec.undoAuto(o.autoWriteId!, 'user_toast', null);
    const toastSaysUndone = res.ok; // exactly what compose.ts:648 passes to notifier.autoUndone
    const eventId = source.calendarEventId!;
    const stillMoved = r.stored(eventId)!.start === THU.startLocal;
    const writeState = r.repos.autoWrites.byId(o.autoWriteId!)!.undoState;
    // contract: the toast may only say "undone" when the event is back (auto_writes.undo_state = 'undone')
    expect({ toastSaysUndone, stillMoved, writeState }).toEqual({
      toastSaysUndone: false,
      stillMoved: true,
      writeState: 'available',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-2: an automatic create whose readback failed can never be undone', () => {
  it('one transient get-event failure right after the automatic create => Undo must still work (or the policy must pause)', async () => {
    let failNextGet = false;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: (cal, id) => {
          if (failNextGet) {
            failNextGet = false;
            return Promise.resolve({ ok: false, error: 'unavailable' });
          }
          return real.getEvent(cal, id);
        },
      }),
    });
    await r.trackRecord();
    r.policy('on');
    const { item, action } = r.seedCreate({ chatN: 1, slot: WED });
    failNextGet = true; // the readback inside runCreate
    const o = await r.exec.tryAuto(action.id);
    expect(o).toMatchObject({ verdict: 'auto', result: 'done' });
    if (o.verdict === 'none') throw new Error('unreachable');
    const eventId = r.repos.items.byId(item.id)!.calendarEventId!;
    expect(r.stored(eventId)).toMatchObject({ status: 'confirmed' }); // the event is live in Google and untouched since
    const res = await r.exec.undoAuto(o.autoWriteId!, 'user', CTX);
    const policyState = r.repos.autoPolicies.live()?.state ?? null;
    const undoState = r.repos.autoWrites.byId(o.autoWriteId!)!.undoState;
    // contract (B10/B11): every automatic write is undoable within its window; if it is not, the policy must not keep writing.
    const undoWorked = res.ok && res.value.outcome === 'done';
    expect(undoWorked || policyState === 'paused').toBe(true);
    // observed today: ACTION_STALE + undo_state 'blocked_changed' ("you changed this event in Google") + policy still 'on'
    expect({ res, undoState, policyState }).not.toEqual({
      res: { ok: false, error: { code: 'ACTION_STALE' } },
      undoState: 'blocked_changed',
      policyState: 'on',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-3: chat opt-out / taint set while tryAuto awaits its Google reads is ignored', () => {
  const run = async (mutate: (r: Rig, chatId: number) => void) => {
    let hook: (() => void) | null = null;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getFreeBusy: async (w) => {
          const h = hook;
          hook = null;
          h?.();
          return real.getFreeBusy(w);
        },
      }),
    });
    await r.trackRecord();
    r.policy('on');
    const { action } = r.seedCreate({ chatN: 1, slot: WED });
    const chatId = r.chat(1).id;
    hook = () => mutate(r, chatId); // fires inside Phase B's fresh free/busy read (after Phase A passed)
    const o = await r.exec.tryAuto(action.id);
    return { r, o, creates: r.cal.calls.filter((c) => c.tool === 'create-event').length };
  };

  it('"Never automatic for this contact" clicked during the read => no automatic write', async () => {
    const { o, creates } = await run((r, chatId) => void r.repos.chats.setAutoPolicy(chatId as never, 'never'));
    expect(o.verdict).not.toBe('auto');
    expect(creates).toBe(3); // the three track-record clicks only
  });

  it('the chat is tainted (an undo of an earlier automatic write) during the read => no automatic write', async () => {
    const { o, creates } = await run(
      (r, chatId) => void r.repos.chats.taint(chatId as never, (r.clock.now() + LIMITS.autoTaintMs) as EpochMs),
    );
    expect(o.verdict).not.toBe('auto');
    expect(creates).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-4: undos of automatic writes are not counted in auto_chat / auto_global', () => {
  it('C2 rate rules / B9 / G31: "creates + edits + undos of automatic writes count together"', async () => {
    const r = await rig();
    await r.trackRecord();
    r.policy('on');
    const { action } = r.seedCreate({ chatN: 1, slot: WED });
    const o = await r.exec.tryAuto(action.id);
    if (o.verdict === 'none') throw new Error('unreachable');
    await r.clock.advance(5 * MIN);
    expect(await r.exec.undoAuto(o.autoWriteId!, 'user', CTX)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const chatKey = String(r.chat(1).id);
    const since = (r.clock.now() - 24 * 3_600_000) as EpochMs;
    expect(r.repos.rate.countSince('auto_global', 'global', since)).toBe(2);
    expect(r.repos.rate.countSince('auto_chat', chatKey, since)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-5: D-068 picture gate is unreachable - every picture that contributed carries the info badge from_image', () => {
  it('triggerKind image + from_image (what S4 writes for a readable picture) + imagesPassed => ok', () => {
    const i = allClearCreate();
    const input = {
      ...i,
      item: { ...i.item, triggerKind: 'image' as const, badges: ['from_image' as const] },
      mediaGates: { voicePassed: false, imagesPassed: true },
    };
    expect(evaluateAutoGate(input).reason).toBe('ok');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-7: the native enable dialog never sees the renderer-supplied scope', () => {
  it('requestEnable({cancels:true, quietHours:null, validityDays:90}) => the dialog must be told about cancels / no quiet hours', async () => {
    const r = await rig();
    await r.trackRecord();
    const seen: Array<Record<string, unknown>> = [];
    const dialog: AutoDialog = {
      confirmEnable: (_w, p) => {
        seen.push(p as Record<string, unknown>);
        return Promise.resolve(true);
      },
      confirmWorkspaceTrust: () => Promise.resolve(false),
      confirmSetting: () => Promise.resolve(false),
      recorded: () => [],
    };
    const svc = createAutoPolicyService({
      repos: r.repos,
      clock: r.clock,
      random: { bytes: (n) => new Uint8Array(n).fill(7), int: () => 0, float: () => 0.5 },
      dialog,
      rate: {
        record: (b, k, now) => r.repos.rate.record(b, k, now),
        countSince: (b, k, since) => r.repos.rate.countSince(b, k, since),
      },
      calendarRoles: () => ({ primary: 'owner' }),
      updateSurfaceAvailable: () => true,
      snapshotSha: () => RIG_SNAPSHOT,
      audit: () => undefined,
      notify: () => undefined,
      calendarConnected: () => true,
    });
    const res = await svc.requestEnable(
      { scope: { ...DEFAULT_AUTO_SCOPE, cancels: true, quietHours: null, validityDays: 90 }, trial: false },
      { id: 1 },
    );
    expect(res.ok).toBe(true);
    expect(r.repos.autoPolicies.live()!.scope).toMatchObject({ cancels: true, quietHours: null });
    // what the user confirmed: no field of the dialog input names cancels or quiet hours
    expect(Object.keys(seen[0]!)).toEqual(expect.arrayContaining(['cancels', 'quietHours']));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auto-mode-8: "Resume" on an app-paused TRIAL turns real automatic writes on (no "Turn on for real" click)', () => {
  it('shadow -> paused(calendar_disconnected) -> auto:resume must not yield state on', async () => {
    const r = await rig();
    await r.trackRecord();
    const p = r.policy('shadow');
    for (const n of [1, 2, 3]) {
      const { action } = r.seedCreate({ chatN: n, slot: { startLocal: `2026-10-0${String(6 + n)}T12:00:00`, endLocal: `2026-10-0${String(6 + n)}T13:00:00` } });
      expect(await r.exec.tryAuto(action.id)).toMatchObject({ verdict: 'shadow' });
    }
    // the app pauses the trial (calendar disconnected for a moment; or 7 days unattended)
    r.repos.autoPolicies.setState(p.id, { state: 'paused', reason: 'calendar_disconnected' });
    const dialog: AutoDialog = {
      confirmEnable: () => Promise.resolve(false),
      confirmWorkspaceTrust: () => Promise.resolve(false),
      confirmSetting: () => Promise.resolve(false),
      recorded: () => [],
    };
    const svc = createAutoPolicyService({
      repos: r.repos,
      clock: r.clock,
      random: { bytes: (n) => new Uint8Array(n).fill(7), int: () => 0, float: () => 0.5 },
      dialog,
      rate: {
        record: (b, k, now) => r.repos.rate.record(b, k, now),
        countSince: (b, k, since) => r.repos.rate.countSince(b, k, since),
      },
      calendarRoles: () => ({ primary: 'owner' }),
      updateSurfaceAvailable: () => true,
      snapshotSha: () => RIG_SNAPSHOT,
      audit: () => undefined,
      notify: () => undefined,
      calendarConnected: () => true,
    });
    // the Settings page shows "Paused - the calendar was disconnected" + [Resume] (AutomaticMode.tsx 'paused' branch)
    await svc.resume({ id: 1 });
    const { action } = r.seedCreate({ chatN: 5, slot: { startLocal: '2026-10-12T12:00:00', endLocal: '2026-10-12T13:00:00' } });
    const o = await r.exec.tryAuto(action.id);
    // contract (B7/F34): only auto:endShadow ("Turn on for real") or the dialog's "Turn on now" may ever produce `on`
    expect(r.repos.autoPolicies.live()!.state).not.toBe('on');
    expect(o.verdict).not.toBe('auto');
  });
});
