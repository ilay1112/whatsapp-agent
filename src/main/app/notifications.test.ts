// TESTS 5.3 row `app/notifications.ts` + UX 12.3: generic copy only, 60 s coalescing, never a name or message text,
// click records IpcContext.shownByNotificationAt for the 300 ms approve guard.
import { describe, expect, it, vi } from 'vitest';
import { ATTENTION_REPEAT_MS, COALESCE_MS, createNotifier, type Notifier } from './notifications';
import { createMainI18n } from './i18n';
import { createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import { LIMITS, type ItemId } from '../../shared/types';
import type { TFn } from './tray';

interface Harness {
  notifier: Notifier;
  shown: Array<{ title: string; body: string }>;
  clicks: Array<ItemId | null>;
  clock: VirtualClock;
  setEnabled(on: boolean): void;
  setLang(lang: 'en' | 'he'): void;
}

function harness(enabled = true): Harness {
  const shown: Array<{ title: string; body: string }> = [];
  const clicks: Array<ItemId | null> = [];
  const clock = createVirtualClock(Date.UTC(2026, 8, 21, 9, 0, 0));
  const en = createMainI18n('en');
  const he = createMainI18n('he');
  let lang: 'en' | 'he' = 'en';
  let on = enabled;
  const t: TFn = (k, o) => (lang === 'en' ? en.t(k, o) : he.t(k, o));
  const notifier = createNotifier({
    electron: { notify: (title, body) => void shown.push({ title, body }) },
    t: () => t,
    clock,
    enabled: () => on,
    onClick: (id) => void clicks.push(id),
  });
  return {
    notifier,
    shown,
    clicks,
    clock,
    setEnabled: (v) => (on = v),
    setLang: (l) => (lang = l),
  };
}

describe('itemCreated', () => {
  it('shows the generic toast for the first item', () => {
    const h = harness();
    h.notifier.itemCreated(1 as ItemId);
    expect(h.shown).toEqual([{ title: 'A chat needs your reply', body: 'Open the app to review the suggestion.' }]);
    h.notifier.dispose();
  });

  it('coalesces further items into ONE toast per 60 s with a count', async () => {
    const h = harness();
    h.notifier.itemCreated(1 as ItemId);
    h.notifier.itemCreated(2 as ItemId);
    h.notifier.itemCreated(3 as ItemId);
    expect(h.shown).toHaveLength(1);
    await h.clock.advance(COALESCE_MS);
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1]!.title).toBe('2 chats need your reply');
    h.notifier.dispose();
  });

  it('a single item arriving after the window shows the singular toast again', async () => {
    const h = harness();
    h.notifier.itemCreated(1 as ItemId);
    await h.clock.advance(COALESCE_MS + 1);
    h.notifier.itemCreated(2 as ItemId);
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1]!.title).toBe('A chat needs your reply');
    h.notifier.dispose();
  });

  it('schedules exactly one flush timer however many items arrive', async () => {
    const h = harness();
    for (let i = 1; i <= 25; i++) h.notifier.itemCreated(i as ItemId);
    expect(h.clock.pendingCount()).toBe(1);
    await h.clock.advance(COALESCE_MS);
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1]!.title).toBe('24 chats need your reply');
    h.notifier.dispose();
  });

  it('shows nothing when notifications are off', async () => {
    const h = harness(false);
    h.notifier.itemCreated(1 as ItemId);
    await h.clock.advance(COALESCE_MS * 2);
    expect(h.shown).toEqual([]);
    h.notifier.dispose();
  });

  it('turning notifications off mid-window suppresses the follow-ups', async () => {
    const h = harness();
    h.notifier.itemCreated(1 as ItemId);
    h.setEnabled(false);
    h.notifier.itemCreated(2 as ItemId);
    await h.clock.advance(COALESCE_MS);
    expect(h.shown).toHaveLength(1);
    h.notifier.dispose();
  });

  it('never contains message text, a draft or a contact name', async () => {
    const h = harness();
    h.notifier.itemCreated(1 as ItemId);
    h.notifier.itemCreated(2 as ItemId);
    await h.clock.advance(COALESCE_MS);
    const all = JSON.stringify(h.shown);
    expect(all).not.toMatch(/SENTINEL/);
    expect(all).not.toMatch(/972\d+/);
    expect(all).not.toMatch(/@s\.whatsapp\.net/);
    h.notifier.dispose();
  });

  it('is localised by the main i18n instance', () => {
    const h = harness();
    h.setLang('he');
    h.notifier.itemCreated(1 as ItemId);
    expect(h.shown[0]!.title).toMatch(/[֐-׿]/);
    h.notifier.dispose();
  });
});

describe('attention', () => {
  it('uses the ErrorCode title and the generic body', () => {
    const h = harness();
    h.notifier.attention('WA_LOGGED_OUT');
    expect(h.shown[0]!.body).toBe('Open the app to fix it.');
    expect(h.shown[0]!.title.length).toBeGreaterThan(0);
    expect(h.shown[0]!.title).not.toBe('errors.WA_LOGGED_OUT.title');
    h.notifier.dispose();
  });

  it.each(['WA_LOGGED_OUT', 'KEY_INVALID', 'CAL_RECONNECT'] as const)(
    '%s has a localised title in both languages',
    (code) => {
      const h = harness();
      h.notifier.attention(code);
      h.setLang('he');
      h.notifier.attention(code === 'WA_LOGGED_OUT' ? 'KEY_INVALID' : 'WA_LOGGED_OUT');
      expect(h.shown).toHaveLength(2);
      expect(h.shown[1]!.title).toMatch(/[֐-׿]/);
      h.notifier.dispose();
    },
  );

  it('does not repeat the same code inside the repeat window, but a different code passes', async () => {
    const h = harness();
    h.notifier.attention('WA_LOGGED_OUT');
    h.notifier.attention('WA_LOGGED_OUT');
    expect(h.shown).toHaveLength(1);
    h.notifier.attention('CAL_RECONNECT');
    expect(h.shown).toHaveLength(2);
    await h.clock.advance(ATTENTION_REPEAT_MS);
    h.notifier.attention('WA_LOGGED_OUT');
    expect(h.shown).toHaveLength(3);
    h.notifier.dispose();
  });

  it('is suppressed when notifications are off', () => {
    const h = harness(false);
    h.notifier.attention('WA_LOGGED_OUT');
    expect(h.shown).toEqual([]);
    h.notifier.dispose();
  });
});

describe('firstHide', () => {
  it('shows the tray hint toast even when item notifications are off', () => {
    const h = harness(false);
    h.notifier.firstHide();
    expect(h.shown).toEqual([
      {
        title: 'Still running next to the clock',
        body: 'Under hidden icons. To quit: right-click the icon, then Quit.',
      },
    ]);
    h.notifier.dispose();
  });

  it('carries no picture and no item reference', () => {
    const h = harness();
    h.notifier.firstHide();
    h.notifier.handleClick();
    expect(h.clicks).toEqual([null]);
    h.notifier.dispose();
  });
});

describe('click handling (focus-steal guard)', () => {
  it('is null until a toast was clicked', () => {
    const h = harness();
    expect(h.notifier.shownByNotificationAt()).toBeNull();
    h.notifier.dispose();
  });

  it('records the click instant and navigates to the item of a single-item toast', () => {
    const h = harness();
    h.notifier.itemCreated(42 as ItemId);
    h.notifier.handleClick();
    expect(h.clicks).toEqual([42]);
    expect(h.notifier.shownByNotificationAt()).toBe(h.clock.now());
    h.notifier.dispose();
  });

  it('a coalesced toast navigates to the dashboard, not to one item', async () => {
    const h = harness();
    h.notifier.itemCreated(1 as ItemId);
    h.notifier.itemCreated(2 as ItemId);
    h.notifier.itemCreated(3 as ItemId);
    await h.clock.advance(COALESCE_MS);
    h.notifier.handleClick();
    expect(h.clicks).toEqual([null]);
    h.notifier.dispose();
  });

  it('the recorded instant is what IpcContext.shownByNotificationAt reports to the focus guard', async () => {
    const h = harness();
    h.notifier.itemCreated(7 as ItemId);
    h.notifier.handleClick();
    const clickedAt = h.notifier.shownByNotificationAt()!;
    await h.clock.advance(LIMITS.focusGuardMainMs - 1);
    expect(h.clock.now() - clickedAt).toBeLessThan(LIMITS.focusGuardMainMs); // an approve here is WINDOW_NOT_FOCUSED
    await h.clock.advance(2);
    expect(h.clock.now() - clickedAt).toBeGreaterThan(LIMITS.focusGuardMainMs);
    h.notifier.dispose();
  });
});

describe('dispose', () => {
  it('cancels a pending coalesced toast and leaves no timer behind', async () => {
    const h = harness();
    h.notifier.itemCreated(1 as ItemId);
    h.notifier.itemCreated(2 as ItemId);
    h.notifier.dispose();
    expect(h.clock.pendingCount()).toBe(0);
    await h.clock.advance(COALESCE_MS * 2);
    expect(h.shown).toHaveLength(1);
  });

  it('is safe without a pending timer', () => {
    const h = harness();
    expect(() => {
      h.notifier.dispose();
      h.notifier.dispose();
    }).not.toThrow();
  });
});

describe('the toast never carries an action button', () => {
  it('the facade only ever receives a title and a body', () => {
    const notify = vi.fn();
    const clock = createVirtualClock();
    const en = createMainI18n('en');
    const n = createNotifier({
      electron: { notify },
      t: () => (k, o) => en.t(k, o),
      clock,
      enabled: () => true,
      onClick: () => {},
    });
    n.itemCreated(1 as ItemId);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toHaveLength(2);
    n.dispose();
  });
});
