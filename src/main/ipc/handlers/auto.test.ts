// src/main/ipc/handlers/auto.test.ts - T2 5 row ipc/handlers/auto.ts (C2 8 automatic-mode channels, I10): requestEnable / resume /
// endShadow / undo need a focused, visible window outside the focus-steal guard (re-checked here, defence in depth); disable / pause
// work unfocused; listWrites returns app rows with inert event text; export is metadata only (no titles). Real repos + real services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_SCOPE } from '../../../shared/schemas';
import { LIMITS } from '../../../shared/types';
import { createAutoHandlers, type AutoExportJson } from './auto';
import { createAutoPolicyService } from '../../exec/autoPolicy';
import { createUndo } from '../../exec/undo';
import { CTX, RIG_SNAPSHOT, makeExecRig } from '../../../../tests/helpers/ledger.execRig';
import type { Rig } from '../../../../tests/helpers/ledger.execRig';
import type { HandlerDepsV2 } from '../register';
import type { IpcContext } from '../../../shared/ipc';
import type { EpochMs, ItemDetail, Result } from '../../../shared/types';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});

async function setup(
  opts: {
    confirm?: boolean;
    savePath?: string | null;
    detailThrows?: boolean;
    detailFails?: boolean;
    ext?: boolean;
  } = {},
) {
  const r = await makeExecRig();
  rigs.push(r);
  const audits: Array<{ kind: string; detail: unknown }> = [];
  const written: Array<{ path: string; text: string }> = [];
  const warnings: string[] = [];
  const dialogWins: unknown[] = [];
  const autoPolicy = createAutoPolicyService({
    repos: r.repos,
    clock: r.clock,
    random: { bytes: (n) => new Uint8Array(n).fill(3), int: () => 0, float: () => 0 },
    dialog: {
      confirmEnable: (win) => {
        dialogWins.push(win);
        return Promise.resolve(opts.confirm ?? true);
      },
      confirmWorkspaceTrust: () => Promise.resolve(false),
      confirmSetting: () => Promise.resolve(false),
      recorded: () => [],
    },
    rate: {
      record: (b, k, n) => r.repos.rate.record(b, k, n),
      countSince: (b, k, s) => r.repos.rate.countSince(b, k, s),
    },
    calendarRoles: () => ({ primary: 'owner' }),
    updateSurfaceAvailable: () => true,
    snapshotSha: () => RIG_SNAPSHOT,
    audit: (kind, _ref, detail) => void audits.push({ kind, detail }),
    notify: () => undefined,
    calendarConnected: () => true,
  });
  const undo = createUndo({ repos: r.repos, executor: r.exec, clock: r.clock, audit: () => undefined });
  const deps = {
    repos: r.repos,
    clock: r.clock,
    log: {
      info: () => undefined,
      warn: (e: string) => void warnings.push(e),
      error: () => undefined,
      child: () => deps.log,
    },
    audit: (kind: string, _ref: string | null, detail: unknown) => void audits.push({ kind, detail }),
    autoPolicy,
    undo,
    items: {
      detail: (id: number): Result<ItemDetail> => {
        if (opts.detailThrows) throw new Error('x');
        if (opts.detailFails) return { ok: false, error: { code: 'NOT_FOUND' } };
        return { ok: true, value: { itemId: id, fresh: true } as unknown as ItemDetail };
      },
    },
    electron: {
      showSaveDialog: () => Promise.resolve(opts.savePath === undefined ? 'C:\\out\\auto.json' : opts.savePath),
    },
  } as unknown as HandlerDepsV2;
  const h =
    opts.ext === false
      ? createAutoHandlers(deps)
      : createAutoHandlers(deps, {
          dialogParent: () => ({ id: 'focused-window' }),
          writeFile: (path, text) => void written.push({ path, text }),
        });
  return { r, h, audits, written, warnings, dialogWins };
}

const UNFOCUSED: IpcContext = { windowFocused: false, windowVisible: true, shownByNotificationAt: null };
const HIDDEN: IpcContext = { windowFocused: true, windowVisible: false, shownByNotificationAt: null };
const REQ = { scope: DEFAULT_AUTO_SCOPE, trial: true };

describe('auto:getState / requestEnable', () => {
  it('getState answers the service state', async () => {
    const { h } = await setup();
    expect(await h['auto:getState'](undefined, CTX)).toMatchObject({ ok: true, value: { policy: null } });
  });
  it('requestEnable from an unfocused / hidden window / inside the focus-steal guard => WINDOW_NOT_FOCUSED, no dialog, no row', async () => {
    const { r, h, dialogWins, audits } = await setup();
    await r.trackRecord();
    const guard = { ...CTX, shownByNotificationAt: r.clock.now() };
    for (const ctx of [UNFOCUSED, HIDDEN, guard]) {
      expect(await h['auto:requestEnable'](REQ, ctx)).toEqual({ ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } });
    }
    expect(dialogWins).toEqual([]);
    expect(r.repos.autoPolicies.newest()).toBeNull();
    expect(audits.filter((a) => a.kind === 'ipc_rejected')).toHaveLength(3);
  });
  it('requestEnable from a focused window: the dialog is parented to the main-owned focused window; the row is created', async () => {
    const { r, h, dialogWins } = await setup();
    await r.trackRecord();
    const res = await h['auto:requestEnable'](REQ, CTX);
    expect(res).toMatchObject({ ok: true, value: { policy: { state: 'shadow' } } });
    expect(dialogWins).toEqual([{ id: 'focused-window' }]);
  });
  it('without the dialog-parent extension the parent is null (the dialog refuses to show)', async () => {
    const { r, h, dialogWins } = await setup({ ext: false });
    await r.trackRecord();
    await h['auto:requestEnable'](REQ, CTX);
    expect(dialogWins).toEqual([null]);
  });
});

describe('the fail-safe direction and the focused-only channels', () => {
  it('disable / pause work from an unfocused window', async () => {
    const { r, h } = await setup();
    r.policy('on');
    expect(await h['auto:pause']({ reason: 'user' }, UNFOCUSED)).toMatchObject({
      ok: true,
      value: { policy: { state: 'paused' } },
    });
    expect(await h['auto:disable']({ reason: 'user' }, UNFOCUSED)).toMatchObject({
      ok: true,
      value: { policy: { state: 'disabled' } },
    });
  });
  it('resume / endShadow / undo need focus', async () => {
    const { r, h } = await setup();
    await r.trackRecord();
    r.policy('paused');
    for (const ch of ['auto:resume', 'auto:endShadow'] as const) {
      expect(await h[ch]({ confirm: true }, UNFOCUSED)).toEqual({ ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } });
    }
    expect(await h['auto:undo']({ autoWriteId: '00000000-0000-4000-8000-000000000001' }, UNFOCUSED)).toEqual({
      ok: false,
      error: { code: 'WINDOW_NOT_FOCUSED' },
    });
    expect(await h['auto:resume']({ confirm: true }, CTX)).toMatchObject({
      ok: true,
      value: { policy: { state: 'on' } },
    });
    expect(await h['auto:endShadow']({ confirm: true }, CTX)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
  });
  it('a throwing service is INTERNAL, never a success', async () => {
    const { r, h, warnings } = await setup();
    r.db.close(); // every repo call now throws
    expect(await h['auto:getState'](undefined, CTX)).toEqual({ ok: false, error: { code: 'INTERNAL' } });
    expect(warnings).toContain('auto_handler_failed');
    // reopen nothing: the rig's stop() tolerates the closed DB
    (r as { stop: () => Promise<void> }).stop = () => r.cal.stop();
  });
});

describe('auto:undo / auto:listWrites / auto:export', () => {
  async function withAutoWrite() {
    const s = await setup();
    await s.r.trackRecord();
    s.r.policy('on');
    const c = s.r.seedCreate({
      chatN: 1,
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
      title: 'Dentist',
    });
    const out = await s.r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    return { ...s, autoWriteId: out.autoWriteId!, item: c.item };
  }
  it('auto:undo goes through the item:undoChange path with approved_by user and re-reads the card', async () => {
    const { r, h, autoWriteId } = await withAutoWrite();
    const res = await h['auto:undo']({ autoWriteId }, CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done', item: { fresh: true } } });
    const w = r.repos.autoWrites.byId(autoWriteId)!;
    expect(r.repos.actions.byId(w.undoActionId!)!.approvedBy).toBe('user');
    expect(await h['auto:undo']({ autoWriteId }, CTX)).toMatchObject({ ok: false });
  });
  it('auto:undo keeps the executor card when the detail read fails', async () => {
    const s = await setup({ detailThrows: true });
    await s.r.trackRecord();
    s.r.policy('on');
    const c = s.r.seedCreate({
      chatN: 1,
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
    });
    const out = await s.r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    expect(await s.h['auto:undo']({ autoWriteId: out.autoWriteId! }, CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
  });
  it('listWrites: rows with the readback content, before = pre_json, an elapsed window reads expired', async () => {
    const { r, h, autoWriteId, item } = await withAutoWrite();
    const res = await h['auto:listWrites']({ sinceTs: 0 }, CTX);
    expect(res).toMatchObject({
      ok: true,
      value: {
        writes: [
          {
            autoWriteId,
            itemId: item.id,
            kind: 'create',
            before: null,
            undoState: 'available',
            event: { title: 'Dentist' },
          },
        ],
      },
    });
    await r.clock.advance(LIMITS.autoUndoWindowMs + 1);
    const later = await h['auto:listWrites']({ sinceTs: 0 }, CTX);
    expect(later).toMatchObject({ ok: true, value: { writes: [{ undoState: 'expired' }] } });
  });
  it('listWrites falls back to the approved payload when the revision is gone, and skips an unreadable row', async () => {
    const { r, h, autoWriteId } = await withAutoWrite();
    r.db.prepare(`UPDATE auto_writes SET revision_id = NULL WHERE id = ?`).run(autoWriteId);
    const res = await h['auto:listWrites']({ sinceTs: 0 }, CTX);
    expect(res).toMatchObject({ ok: true, value: { writes: [{ event: { title: 'Dentist', status: 'confirmed' } }] } });
  });
  it('listWrites of an automatic UPDATE shows the pre-write content as `before`', async () => {
    const s = await setup();
    await s.r.trackRecord();
    const source = await s.r.createByClick({
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
    });
    s.r.policy('on');
    const d = s.r.seedDelta({
      source,
      change: 'reschedule',
      to: { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' },
    });
    await s.r.exec.tryAuto(d.action.id);
    const res = await s.h['auto:listWrites']({ sinceTs: 0 }, CTX);
    expect(res).toMatchObject({
      ok: true,
      value: {
        writes: [
          {
            kind: 'update',
            before: { startLocal: '2026-10-07T15:00:00' },
            event: { startLocal: '2026-10-08T17:00:00' },
          },
        ],
      },
    });
    s.r.db.prepare(`UPDATE auto_writes SET revision_id = NULL`).run();
    expect(await s.h['auto:listWrites']({ sinceTs: 0 }, CTX)).toMatchObject({
      ok: true,
      value: { writes: [{ event: { startLocal: '2026-10-08T17:00:00' } }] },
    });
  });
  it('export writes metadata only (ids, kinds, verdicts, reasons, timestamps) - never a title - after the main-owned save dialog', async () => {
    const { h, written, autoWriteId } = await withAutoWrite();
    expect(await h['auto:export'](undefined, CTX)).toEqual({ ok: true, value: { saved: true } });
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe('C:\\out\\auto.json');
    expect(written[0]!.text).not.toContain('Dentist');
    const json = JSON.parse(written[0]!.text) as AutoExportJson;
    expect(json).toMatchObject({ format: 'wca-auto-export', version: 1 });
    expect(json.policies).toHaveLength(1);
    expect(json.decisions.some((d) => d.verdict === 'auto' && d.reason === 'ok')).toBe(true);
    expect(json.writes.map((w) => w.id)).toEqual([autoWriteId]);
  });
  it('a cancelled save dialog writes nothing', async () => {
    const { h, written } = await setup({ savePath: null });
    expect(await h['auto:export'](undefined, CTX)).toEqual({ ok: true, value: { saved: false } });
    expect(written).toEqual([]);
  });
  it('the event of a write whose action payload is unreadable is skipped', async () => {
    const { r, h, autoWriteId } = await withAutoWrite();
    r.db.prepare(`UPDATE auto_writes SET revision_id = NULL WHERE id = ?`).run(autoWriteId);
    const w = r.repos.autoWrites.byId(autoWriteId)!;
    // a retention-nulled action (terminal) no longer carries its payload
    r.db.prepare(`UPDATE actions SET canonical_json = NULL, approved_final_json = NULL WHERE id = ?`).run(w.actionId);
    expect(await h['auto:listWrites']({ sinceTs: 0 }, CTX)).toEqual({ ok: true, value: { writes: [] } });
    void (r.clock.now() as EpochMs);
  });
});

describe('the remaining edges', () => {
  it('auto:undo keeps the executor card when the card service answers not-ok', async () => {
    const s = await setup({ detailFails: true });
    await s.r.trackRecord();
    s.r.policy('on');
    const c = s.r.seedCreate({
      chatN: 1,
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
    });
    const out = await s.r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    const res = await s.h['auto:undo']({ autoWriteId: out.autoWriteId! }, CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    if (res.ok) expect(res.value.item).not.toHaveProperty('fresh');
  });
  it('auto:resume without the dialog-parent extension still resumes (resume needs no dialog)', async () => {
    const s = await setup({ ext: false });
    await s.r.trackRecord();
    s.r.policy('paused');
    expect(await s.h['auto:resume']({ confirm: true }, CTX)).toMatchObject({
      ok: true,
      value: { policy: { state: 'on' } },
    });
  });
  it('auto:export without a writer extension writes the file with node:fs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-auto-export-'));
    try {
      const target = path.join(dir, 'auto.json');
      const s = await setup({ ext: false, savePath: target });
      expect(await s.h['auto:export'](undefined, CTX)).toEqual({ ok: true, value: { saved: true } });
      expect((JSON.parse(fs.readFileSync(target, 'utf8')) as { format: string }).format).toBe('wca-auto-export');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
