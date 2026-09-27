// src/main/app/notifications.ts - Windows toasts (build-plan section 3; owner W1-12). Never message text, draft text or names (UX 12.3).
import type { Clock, ClockTimer, ElectronFacade } from '../deps';
import type { ErrorCode } from '../../shared/errors';
import type { ItemId } from '../../shared/types';
import type { TFn } from './tray';

export interface NotifierDeps {
  electron: Pick<ElectronFacade, 'notify'>;
  t: () => TFn;
  clock: Clock;
  enabled: () => boolean; // settings.general.notifications === 'generic'
  /** Show window + ui:navigate {view:'dashboard', itemId}; records shownByNotificationAt for the focus guard. */
  onClick: (itemId: ItemId | null) => void;
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

  return {
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
