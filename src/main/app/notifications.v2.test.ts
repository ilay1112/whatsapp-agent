// src/main/app/notifications.v2.test.ts - T2 5 row app/notifications.ts v2 (UX2 5, B11 door 1): the automatic-mode toasts are app text
// only (property test with random titles: the notifier never even receives a title), shown with notifications 'off', a burst of 3+
// writes in 10 min collapses into ONE summary toast, action 0 => undoAuto(id,'user_toast'), 1 => Show (with the focus-steal guard).
import { describe, expect, it } from 'vitest';
import { createNotifier, type Notifier, type NotifierDeps } from './notifications';
import { createMainI18n } from './i18n';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { LIMITS, type ItemId } from '../../shared/types';
import type { TFn } from './tray';

interface Toast {
  title: string;
  body: string;
  actions: string[];
  act(i: number): void;
  click(): void;
}
function harness(opts: { enabled?: boolean; withActions?: boolean; lang?: 'en' | 'he' } = {}) {
  const i18n = createMainI18n(opts.lang ?? 'en');
  const t: TFn = (k, o) => i18n.t(k, o);
  const clock = createVirtualClock(Date.UTC(2026, 9, 5, 7, 0, 0));
  const toasts: Toast[] = [];
  const plain: Array<{ title: string; body: string }> = [];
  const undos: Array<[string, string]> = [];
  const shows: ItemId[] = [];
  const clicks: Array<ItemId | null> = [];
  const deps: NotifierDeps = {
    electron: { notify: (title, body) => void plain.push({ title, body }) },
    t: () => t,
    clock,
    enabled: () => opts.enabled ?? true,
    onClick: (id) => void clicks.push(id),
    onUndo: (id, by) => void undos.push([id, by]),
    onShow: (id) => void shows.push(id),
    ...(opts.withActions === false
      ? {}
      : {
          notifyWithActions: (toast, onAction, onClick) =>
            void toasts.push({ ...toast, act: onAction, click: onClick }),
        }),
  };
  const notifier: Notifier = createNotifier(deps);
  return { notifier, toasts, plain, undos, shows, clicks, clock };
}

describe('autoWrite', () => {
  it('each kind has its own app title, body "Open the app to see it.", buttons Undo / Show', () => {
    const h = harness();
    h.notifier.autoWrite({ kind: 'create', autoWriteId: 'w1', burstCount: 1, itemId: 5 as ItemId });
    h.notifier.autoWrite({ kind: 'update', autoWriteId: 'w2', burstCount: 1 });
    expect(h.toasts.map((t) => [t.title, t.body, t.actions])).toEqual([
      ['Calendar: an event was added automatically', 'Open the app to see it.', ['Undo', 'Show']],
      ['Calendar: an event was moved automatically', 'Open the app to see it.', ['Undo', 'Show']],
    ]);
  });
  it('the cancel title; Hebrew copy', () => {
    const h = harness({ lang: 'he' });
    h.notifier.autoWrite({ kind: 'cancel', autoWriteId: 'w1', burstCount: 1 });
    expect(h.toasts[0]!.title).toBe('יומן: אירוע בוטל אוטומטית');
    expect(h.toasts[0]!.actions).toEqual(['ביטול השינוי', 'הצגה']);
  });
  it('is shown even when notifications are off (it is a control, B11)', () => {
    const h = harness({ enabled: false });
    h.notifier.autoWrite({ kind: 'create', autoWriteId: 'w1', burstCount: 1 });
    expect(h.toasts).toHaveLength(1);
  });
  it('action 0 => undoAuto(id, user_toast); action 1 => Show the item and arm the focus-steal guard', () => {
    const h = harness();
    h.notifier.autoWrite({ kind: 'create', autoWriteId: 'w-9', burstCount: 1, itemId: 5 as ItemId });
    h.toasts[0]!.act(0);
    expect(h.undos).toEqual([['w-9', 'user_toast']]);
    expect(h.notifier.shownByNotificationAt()).toBeNull();
    h.toasts[0]!.act(1);
    expect(h.shows).toEqual([5]);
    expect(h.notifier.shownByNotificationAt()).toBe(h.clock.now());
    h.toasts[0]!.act(7); // an unknown index does nothing
    expect(h.undos).toHaveLength(1);
  });
  it('a click on the toast body shows the item; without an item id it opens the dashboard', () => {
    const h = harness();
    h.notifier.autoWrite({ kind: 'create', autoWriteId: 'w', burstCount: 1, itemId: 8 as ItemId });
    h.notifier.autoWrite({ kind: 'create', autoWriteId: 'w2', burstCount: 1 });
    h.toasts[0]!.click();
    h.toasts[1]!.click();
    expect(h.shows).toEqual([8]);
    expect(h.clicks).toEqual([null]);
  });
  it('3+ writes in 10 minutes => one summary toast with Show only; outside the window individual toasts again', async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.notifier.autoWrite({ kind: 'create', autoWriteId: `w${String(i)}`, burstCount: 0 });
    expect(h.toasts.map((t) => t.title)).toEqual([
      'Calendar: an event was added automatically',
      'Calendar: an event was added automatically',
      '3 automatic calendar changes',
      '4 automatic calendar changes',
    ]);
    expect(h.toasts[2]!.actions).toEqual(['Show']);
    expect(h.toasts[2]!.body).toBe('Open the app to review them.');
    h.toasts[2]!.act(0);
    h.toasts[2]!.click();
    expect(h.clicks).toEqual([null, null]);
    await h.clock.advance(LIMITS.autoToastBurstWindowMs);
    h.notifier.autoWrite({ kind: 'update', autoWriteId: 'later', burstCount: 0 });
    expect(h.toasts.at(-1)!.actions).toEqual(['Undo', 'Show']);
  });
  it('a caller-counted burst also collapses (burstCount)', () => {
    const h = harness();
    h.notifier.autoWrite({ kind: 'create', autoWriteId: 'w', burstCount: 5 });
    expect(h.toasts[0]!.title).toBe('5 automatic calendar changes');
  });
  it('without toast actions the plain toast still says what happened (no buttons)', () => {
    const h = harness({ withActions: false });
    h.notifier.autoWrite({ kind: 'create', autoWriteId: 'w', burstCount: 1 });
    expect(h.plain).toEqual([{ title: 'Calendar: an event was added automatically', body: 'Open the app to see it.' }]);
  });
  it('property: whatever the event title, no toast string ever carries text the notifier was not built with', () => {
    const h = harness();
    const allowed = new Set([
      'Calendar: an event was added automatically',
      'Calendar: an event was moved automatically',
      'Calendar: an event was cancelled automatically',
      'Open the app to see it.',
      'Undo',
      'Show',
    ]);
    const kinds = ['create', 'update', 'cancel'] as const;
    for (let i = 0; i < 60; i++) {
      h.notifier.autoWrite({ kind: kinds[i % 3]!, autoWriteId: `SECRET-${String(i)}-\u202Etitle`, burstCount: 1 });
      if (i % 2 === 0) void h.clock.advance(LIMITS.autoToastBurstWindowMs);
    }
    for (const t of h.toasts) {
      for (const s of [t.title, t.body, ...t.actions]) {
        expect(s).not.toContain('SECRET');
        if (!/automatic calendar changes$|review them\.$/.test(s)) expect(allowed.has(s)).toBe(true);
      }
    }
  });
});

describe('autoUndone / autoPolicy / autoExpiring', () => {
  it('undone: title only; failed: title + body + Show', () => {
    const h = harness({ enabled: false });
    h.notifier.autoUndone(true);
    h.notifier.autoUndone(false);
    expect(h.plain).toEqual([{ title: 'Calendar change undone', body: '' }]);
    expect(h.toasts.map((t) => [t.title, t.body, t.actions])).toEqual([
      ['Could not undo the calendar change', 'Open the app to see why.', ['Show']],
    ]);
    h.toasts[0]!.act(0);
    h.toasts[0]!.click();
    expect(h.clicks).toEqual([null, null]);
  });
  it('a paused policy toasts even with notifications off; other states are silent', () => {
    const h = harness({ enabled: false });
    for (const s of ['on', 'shadow', 'disabled', 'expired', 'off'] as const) h.notifier.autoPolicy(s);
    expect(h.toasts).toEqual([]);
    h.notifier.autoPolicy('paused');
    expect(h.toasts.map((t) => [t.title, t.body])).toEqual([['Automatic mode paused', 'Open the app to see why.']]);
    h.toasts[0]!.act(0);
    h.toasts[0]!.click();
    expect(h.clicks).toHaveLength(2);
  });
  it('the expiry reminder only when notifications are on', () => {
    const off = harness({ enabled: false });
    off.notifier.autoExpiring();
    expect(off.toasts).toEqual([]);
    const on = harness();
    on.notifier.autoExpiring();
    expect(on.toasts.map((t) => [t.title, t.body, t.actions])).toEqual([
      ['Automatic mode ends in 3 days', 'You can renew it in Settings.', ['Show']],
    ]);
    on.toasts[0]!.act(0);
    on.toasts[0]!.click();
    expect(on.clicks).toEqual([null, null]);
  });
});
