// src/main/app/notifications.ts - Windows toasts (build-plan section 3; owner W1-12; v2 owner V2-W1-04). Never message text, draft text
// or names (UX 12.3, UX2 5): every automatic-mode toast is app copy with Undo / Show buttons wired IN MAIN (never through IPC).
import type { Clock, ClockTimer, ElectronFacade } from '../deps';
import type { ErrorCode } from '../../shared/errors';
import type { ItemId } from '../../shared/types';
import type { TFn } from './tray';
import { LIMITS } from '../../shared/types';

export interface NotifierDeps {
  electron: Pick<ElectronFacade, 'notify'>;
  t: () => TFn;
  clock: Clock;
  enabled: () => boolean; // settings.general.notifications === 'generic'
  /** Show window + ui:navigate {view:'dashboard', itemId}; records shownByNotificationAt for the focus guard. */
  onClick: (itemId: ItemId | null) => void;
  // ---- [V2 ADD] v2-build-plan 3 seam (V2-W1-04): toast action index 0 -> onUndo(autoWriteId, 'user_toast'), 1 -> onShow(itemId).
  // [W0 refinement] optional so the v1 wiring and tests compile; V2-W2-01 passes both.
  onUndo?: (autoWriteId: string, by: 'user_toast') => void;
  onShow?: (itemId: ItemId) => void;
  /** [V2-W1-04 addition, optional] A toast WITH action buttons (Electron 44 Windows toast actions). The facade calls `onAction(index)` on
   *  the toast's 'action' event and `onClick()` on its 'click' event. Absent => the plain `electron.notify` toast without buttons (the
   *  card, the AutoStrip and the activity page stay the other Undo doors - UX2 5, U-N1). */
  notifyWithActions?: (
    toast: { title: string; body: string; actions: string[] },
    onAction: (index: number) => void,
    onClick: () => void,
  ) => void;
}
export interface Notifier {
  /** One per item creation at most, coalesced to one per 60 s ("N chats need your reply"). */
  itemCreated(itemId: ItemId): void;
  /** Once per occurrence of WA_LOGGED_OUT / KEY_INVALID / CAL_RECONNECT: title = ErrorCode title, body notify.attention.body. */
  attention(code: ErrorCode): void;
  firstHide(): void; // UX 12.2 toast
  shownByNotificationAt(): number | null;
  /** Called by the ElectronFacade when the user clicks the toast we last showed (compose wires the Notification 'click'). */
  handleClick(): void;
  /** Cancels a pending coalesced toast (quit / pause). */
  dispose(): void;
  // ---- [V2 ADD] v2-build-plan 3 seam - Wave 0 stubs, owner V2-W1-04-exec-auto. Shown even when notifications are 'off' (B11: a control).
  /** [V2-W1-04] `itemId` (optional) is the Show target; `burstCount` = automatic writes the caller counted in the burst window. */
  autoWrite(e: {
    kind: import('../../shared/types').AutoWriteKind;
    autoWriteId: string;
    burstCount: number;
    itemId?: ItemId;
  }): void;
  autoUndone(ok: boolean): void;
  /** App-initiated policy change: 'paused' shows "Automatic mode paused" (shown even with notifications off); other states are silent. */
  autoPolicy(state: import('../../shared/types').AutoPolicyState | 'off'): void;
  /** [V2-W1-04 addition] 3 days before expiry, once (UX2 5: only when notifications are on). */
  autoExpiring(): void;
}

/** UX 12.3: at most one "needs your reply" toast per minute. */
export const COALESCE_MS = 60_000;
/** The same attention code is not repeated inside this window. */
export const ATTENTION_REPEAT_MS = 60_000;

export function createNotifier(deps: NotifierDeps): Notifier {
  let lastShownAt: number | null = null; // last "needs your reply" toast
  let pending: ItemId[] = [];
  let timer: ClockTimer | null = null;
  let clickTarget: ItemId | null = null;
  let shownAt: number | null = null;
  const attentionAt = new Map<ErrorCode, number>();

  const show = (title: string, body: string, target: ItemId | null): void => {
    clickTarget = target;
    deps.electron.notify(title, body);
  };

  const flush = (): void => {
    timer = null;
    const ids = pending;
    pending = [];
    if (ids.length === 0) return;
    const t = deps.t();
    lastShownAt = deps.clock.now();
    if (ids.length === 1) {
      show(t('notify.needsReply.title'), t('notify.needsReply.body'), ids[0]!);
    } else {
      // A count is allowed; a name or any message text is not.
      show(t('notify.needsReplyMany.title', { count: ids.length }), t('notify.needsReply.body'), null);
    }
  };

  // ---- [V2] automatic-mode toasts (B11 door 1): shown even when notifications are 'off' - it is a control ----
  const autoWrites: number[] = []; // times of recent automatic-write toasts (burst window)
  /** Show from a toast: the same focus-steal guard as a click on a plain toast (LIMITS.focusGuardMainMs). */
  const showFromToast = (itemId: ItemId | null): void => {
    shownAt = deps.clock.now();
    if (itemId !== null && deps.onShow !== undefined) deps.onShow(itemId);
    else deps.onClick(itemId);
  };
  const toast = (
    title: string,
    body: string,
    buttons: Array<{ label: string; run: () => void }>,
    click: () => void,
  ): void => {
    if (buttons.length > 0 && deps.notifyWithActions !== undefined) {
      deps.notifyWithActions(
        { title, body, actions: buttons.map((b) => b.label) },
        (index) => buttons[index]?.run(),
        click,
      );
      return;
    }
    // Without toast actions the toast still says what happened; a click opens the app (the Undo doors are the card / strip / page).
    clickTarget = null;
    deps.electron.notify(title, body);
  };
  const WRITE_TITLE_KEY = {
    create: 'notify.auto.added.title',
    update: 'notify.auto.added.moved.title',
    cancel: 'notify.auto.added.cancelled.title',
  } as const;

  return {
    autoWrite(e) {
      const now = deps.clock.now();
      while (autoWrites.length > 0 && now - autoWrites[0]! >= LIMITS.autoToastBurstWindowMs) autoWrites.shift();
      autoWrites.push(now);
      const burst = Math.max(autoWrites.length, e.burstCount);
      const t = deps.t();
      const itemId = e.itemId ?? null;
      if (burst >= LIMITS.autoToastBurstCount) {
        // 3+ writes in 10 min: ONE summary toast replaces the individual ones (its Show opens the dashboard with the AutoStrip).
        toast(
          t('notify.auto.burst.title', { count: burst }),
          t('notify.auto.burst.body'),
          [{ label: t('notify.auto.show'), run: () => showFromToast(null) }],
          () => showFromToast(null),
        );
        return;
      }
      toast(
        t(WRITE_TITLE_KEY[e.kind]),
        t('notify.auto.body'),
        [
          { label: t('notify.auto.undo'), run: () => deps.onUndo?.(e.autoWriteId, 'user_toast') },
          { label: t('notify.auto.show'), run: () => showFromToast(itemId) },
        ],
        () => showFromToast(itemId),
      );
    },

    autoUndone(ok) {
      const t = deps.t();
      if (ok) {
        toast(t('notify.auto.undone.title'), '', [], () => showFromToast(null));
        return;
      }
      toast(
        t('notify.auto.undone.undoFailed.title'),
        t('notify.auto.undone.undoFailed.body'),
        [{ label: t('notify.auto.show'), run: () => showFromToast(null) }],
        () => showFromToast(null),
      );
    },

    autoPolicy(state) {
      if (state !== 'paused') return;
      const t = deps.t();
      toast(
        t('notify.auto.paused.title'),
        t('notify.auto.paused.body'),
        [{ label: t('notify.auto.show'), run: () => showFromToast(null) }],
        () => showFromToast(null),
      );
    },

    autoExpiring() {
      if (!deps.enabled()) return;
      const t = deps.t();
      toast(
        t('notify.auto.expiring.title'),
        t('notify.auto.expiring.body'),
        [{ label: t('notify.auto.show'), run: () => showFromToast(null) }],
        () => showFromToast(null),
      );
    },

    itemCreated(itemId) {
      if (!deps.enabled()) return;
      pending.push(itemId);
      const now = deps.clock.now();
      if (lastShownAt !== null && now - lastShownAt < COALESCE_MS) {
        if (timer === null) timer = deps.clock.setTimeout(flush, COALESCE_MS - (now - lastShownAt));
        return;
      }
      flush();
    },

    attention(code) {
      if (!deps.enabled()) return;
      const now = deps.clock.now();
      const previous = attentionAt.get(code);
      if (previous !== undefined && now - previous < ATTENTION_REPEAT_MS) return;
      attentionAt.set(code, now);
      const t = deps.t();
      show(t(`errors.${code}.title`), t('notify.attention.body'), null);
    },

    firstHide() {
      // App chrome, not an item notification: shown even when item notifications are off (UX 12.2 / ARCHITECTURE 13).
      const t = deps.t();
      show(t('notify.firstHide.title'), t('notify.firstHide.body'), null);
    },

    shownByNotificationAt() {
      return shownAt;
    },

    handleClick() {
      shownAt = deps.clock.now(); // arms the 300 ms focus-steal guard of LIMITS.focusGuardMainMs
      deps.onClick(clickTarget);
    },

    dispose() {
      if (timer !== null) deps.clock.clearTimeout(timer);
      timer = null;
      pending = [];
    },
  };
}
