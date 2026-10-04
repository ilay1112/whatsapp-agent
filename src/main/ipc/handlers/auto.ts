// src/main/ipc/handlers/auto.ts   ADD (C2 8 automatic-mode channels; v2-build-plan 3 createAutoHandlers) - owner V2-W1-04-exec-auto.
// Safety-critical (T2 13). None of these channels exists on any MCP surface (B29, NEVER_ON_MCP_PREFIXES). Focus gating is register.ts's
// (FOCUS_GATED_CHANNELS) and is RE-CHECKED here for the channels that change or confirm something (defence in depth, like
// action:approve): auto:requestEnable / resume / endShadow / undo need a focused, visible window outside the focus-steal guard;
// auto:disable / auto:pause deliberately work from anywhere (the fail-safe direction, B7). Bodies return Result<T>, never throw.
import fs from 'node:fs';
import { LIMITS } from '../../../shared/types';
import type { IpcHandlers, IpcContext } from '../../../shared/ipc';
import type {
  AutoWriteRecord,
  AutoWriteView,
  EpochMs,
  EventContentView,
  ItemDetail,
  ItemId,
  Result,
} from '../../../shared/types';
import type { CreateEventPayload } from '../../../shared/schemas';
import { parseFinalPayload } from '../../exec/outcome';
import { contentOfSnapshot, viewOf } from '../../exec/eventContent';
import { fail, ok, type HandlerDepsV2 } from '../register';

export type AutoChannels =
  | 'auto:getState'
  | 'auto:requestEnable'
  | 'auto:disable'
  | 'auto:pause'
  | 'auto:resume'
  | 'auto:endShadow'
  | 'auto:undo'
  | 'auto:listWrites'
  | 'auto:export';

/** [V2-W1-04 addition] What HandlerDepsV2 (frozen by W0) does not carry: the focused BrowserWindow the native dialog is parented to,
 *  and the file writer auto:export uses after the main-owned save dialog. Absent parent => the dialog is never shown (AUTO_NOT_CONFIRMED). */
export interface AutoHandlersExtV2 {
  dialogParent?: () => unknown;
  writeFile?: (path: string, text: string) => void;
}

/** The export is metadata only (C2 8): ids, kinds, verdicts, reasons, timestamps - never titles, locations or any other text. */
export interface AutoExportJson {
  format: 'wca-auto-export';
  version: 1;
  exportedAt: EpochMs;
  policies: Array<{
    id: string;
    state: string;
    enabledAt: number;
    expiresAt: number;
    shadowUntil: number;
    pausedReason: string | null;
    disabledAt: number | null;
    disabledReason: string | null;
  }>;
  decisions: Array<{
    id: string;
    policyId: string;
    actionId: string;
    itemId: number;
    kind: string;
    verdict: string;
    reason: string;
    decidedAt: number;
  }>;
  writes: Array<{
    id: string;
    decisionId: string;
    actionId: string;
    itemId: number;
    kind: string;
    undoState: string;
    undoUntil: number;
    writtenAt: number;
    revisionId: number | null;
  }>;
}

export function createAutoHandlers(deps: HandlerDepsV2, ext: AutoHandlersExtV2 = {}): Pick<IpcHandlers, AutoChannels> {
  const writeFile = ext.writeFile ?? ((p: string, text: string): void => fs.writeFileSync(p, text, 'utf8'));

  /** Same window rule as action:approve (ARCH 6.6 step 1) + the focus-steal guard (LIMITS.focusGuardMainMs). */
  const refuseUnfocused = (channel: AutoChannels, ctx: IpcContext): Result<never> | null => {
    const now = deps.clock.now();
    const guard = ctx.shownByNotificationAt !== null && ctx.shownByNotificationAt + LIMITS.focusGuardMainMs > now;
    if (ctx.windowVisible && ctx.windowFocused && !guard) return null;
    deps.audit('ipc_rejected', null, { channel, reason: 'window_not_focused' }, now);
    return fail('WINDOW_NOT_FOCUSED');
  };

  /** A throwing collaborator is a bug, never a success: INTERNAL (register.ts would map a throw the same way). */
  const safe = async <T>(channel: AutoChannels, run: () => Promise<Result<T>> | Result<T>): Promise<Result<T>> => {
    try {
      return await run();
    } catch {
      deps.log.warn('auto_handler_failed', { channel });
      return fail('INTERNAL');
    }
  };

  const detailOr = (itemId: ItemId, fallback: ItemDetail): ItemDetail => {
    try {
      const res = deps.items.detail(itemId);
      return res.ok ? res.value : fallback;
    } catch {
      return fallback;
    }
  };

  /** The event content of a write: the readback of its revision, else the approved payload (UNTRUSTED title/location, inert data). */
  const eventOf = (w: AutoWriteRecord): EventContentView | null => {
    const rev = w.revisionId === null ? null : deps.repos.eventRevisions.byId(w.revisionId);
    if (rev?.next) return viewOf(rev.next);
    // no readback row (a failed write, or its JSON nulled by retention): the approved payload of the write's action. An automatic
    // write's action is always a calendar kind whose approved_final_json is canonical_json verbatim (F4); retention nulls it => no row.
    const p = parseFinalPayload(deps.repos.actions.byId(w.actionId)!);
    if (p === null) return null;
    if (p.kind === 'update_event') return viewOf(p.to);
    const c = p as CreateEventPayload;
    return viewOf({
      title: c.title,
      startLocal: c.startLocal,
      endLocal: c.endLocal,
      timeZone: c.timeZone,
      location: c.location,
      status: 'confirmed',
    });
  };

  const exportJson = (now: EpochMs): AutoExportJson => {
    const db = deps.repos.db;
    return {
      format: 'wca-auto-export',
      version: 1,
      exportedAt: now,
      policies: db
        .prepare<{
          id: string;
          state: string;
          enabled_at: number;
          expires_at: number;
          shadow_until: number;
          paused_reason: string | null;
          disabled_at: number | null;
          disabled_reason: string | null;
        }>(
          `SELECT id, state, enabled_at, expires_at, shadow_until, paused_reason, disabled_at, disabled_reason
             FROM auto_policies ORDER BY enabled_at ASC`,
        )
        .all()
        .map((r) => ({
          id: r.id,
          state: r.state,
          enabledAt: r.enabled_at,
          expiresAt: r.expires_at,
          shadowUntil: r.shadow_until,
          pausedReason: r.paused_reason,
          disabledAt: r.disabled_at,
          disabledReason: r.disabled_reason,
        })),
      decisions: db
        .prepare<{
          id: string;
          policy_id: string;
          action_id: string;
          item_id: number;
          kind: string;
          verdict: string;
          reason: string;
          decided_at: number;
        }>(
          `SELECT id, policy_id, action_id, item_id, kind, verdict, reason, decided_at FROM auto_decisions ORDER BY decided_at ASC`,
        )
        .all()
        .map((r) => ({
          id: r.id,
          policyId: r.policy_id,
          actionId: r.action_id,
          itemId: r.item_id,
          kind: r.kind,
          verdict: r.verdict,
          reason: r.reason,
          decidedAt: r.decided_at,
        })),
      writes: deps.repos.autoWrites.since(0 as EpochMs).map((w) => ({
        id: w.id,
        decisionId: w.decisionId,
        actionId: w.actionId,
        itemId: w.itemId,
        kind: w.kind,
        undoState: w.undoState,
        undoUntil: w.undoUntil,
        writtenAt: w.writtenAt,
        revisionId: w.revisionId,
      })),
    };
  };

  return {
    'auto:getState': () => safe('auto:getState', () => ok(deps.autoPolicy.getState())),

    'auto:requestEnable': (req, ctx) =>
      safe('auto:requestEnable', async () => {
        const refused = refuseUnfocused('auto:requestEnable', ctx);
        if (refused !== null) return refused;
        return deps.autoPolicy.requestEnable(req, ext.dialogParent?.() ?? null);
      }),

    // The fail-safe direction: no focus gate, no dialog (B7) - also reachable from the tray and the toast.
    'auto:disable': (req) => safe('auto:disable', () => deps.autoPolicy.disable(req.reason)),
    'auto:pause': (req) => safe('auto:pause', () => deps.autoPolicy.pause(req.reason)),

    'auto:resume': (_req, ctx) =>
      safe('auto:resume', async () => {
        const refused = refuseUnfocused('auto:resume', ctx);
        if (refused !== null) return refused;
        return deps.autoPolicy.resume(ext.dialogParent?.() ?? null);
      }),

    'auto:endShadow': (_req, ctx) =>
      safe('auto:endShadow', () => {
        const refused = refuseUnfocused('auto:endShadow', ctx);
        if (refused !== null) return refused;
        return deps.autoPolicy.endShadow();
      }),

    'auto:undo': (req, ctx) =>
      safe('auto:undo', async () => {
        const refused = refuseUnfocused('auto:undo', ctx);
        if (refused !== null) return refused;
        const res = await deps.undo.undoAuto(req.autoWriteId, 'user');
        if (!res.ok) return res;
        const itemId = res.value.item.itemId;
        return ok({ ...res.value, item: detailOr(itemId, res.value.item) });
      }),

    'auto:listWrites': (req) =>
      safe('auto:listWrites', () => {
        const now = deps.clock.now();
        // The strip / activity page never look further back than the retention of auto_writes.
        const since = Math.max(req.sinceTs, now - LIMITS.autoWritesRetentionMs) as EpochMs;
        const writes: AutoWriteView[] = [];
        for (const w of deps.repos.autoWrites.since(since)) {
          const event = eventOf(w);
          if (event === null) continue;
          const undoState = w.undoState === 'available' && now >= w.undoUntil ? 'expired' : w.undoState;
          writes.push({
            autoWriteId: w.id,
            itemId: w.itemId,
            kind: w.kind,
            event,
            before: w.pre === null ? null : viewOf(contentOfSnapshot(w.pre)),
            writtenAt: w.writtenAt,
            undoState,
            undoUntil: w.undoUntil,
            revisionId: w.revisionId,
          });
        }
        return ok({ writes });
      }),

    'auto:export': () =>
      safe<{ saved: boolean }>('auto:export', async () => {
        const now = deps.clock.now();
        const path = await deps.electron.showSaveDialog({
          title: 'Automatic activity',
          defaultFileName: 'automatic-activity.json',
        });
        if (path === null) return ok({ saved: false });
        writeFile(path, `${JSON.stringify(exportJson(now), null, 2)}\n`);
        return ok({ saved: true });
      }),
  };
}
