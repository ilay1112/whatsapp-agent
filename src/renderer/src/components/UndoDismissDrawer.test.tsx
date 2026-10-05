// UX 6.10 `[R2]`: the drawer lists the LAST 20 items the user DISMISSED and offers exactly one action, Restore.
// It is a labelled modal dialog whose initial focus is its close button (UX 7 / 13.3).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemCard as ItemVM } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { UndoDismissDrawer } from './UndoDismissDrawer';
import { useDashboardStore } from '../store/dashboard';
import { useSettingsStore } from '../store/settings';
import { defaultCard, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const dismissed = (itemId: number, patch: Partial<ItemVM> = {}): ItemVM => ({
  ...structuredClone(defaultCard),
  itemId,
  status: 'dismissed',
  closedReason: 'dismissed',
  actions: [],
  ...patch,
});

beforeEach(() => {
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
});

describe('UndoDismissDrawer - open / closed', () => {
  it('renders nothing and fetches nothing while closed', () => {
    render(<UndoDismissDrawer open={false} onClose={() => {}} />);
    expect(screen.queryByTestId('undo-dismiss-drawer')).toBeNull();
    expect(invokeMocks['dashboard:getIgnored']).not.toHaveBeenCalled();
  });

  it('fetches dashboard:getIgnored exactly once when it opens', async () => {
    render(<UndoDismissDrawer open onClose={() => {}} />);
    await waitFor(() => expect(invokeMocks['dashboard:getIgnored']).toHaveBeenCalledTimes(1));
  });

  it('is a labelled modal dialog titled "Dismissed"', async () => {
    render(<UndoDismissDrawer open onClose={() => {}} />);
    const dialog = await screen.findByTestId('undo-dismiss-drawer');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Dismissed');
  });
});

describe('UndoDismissDrawer - rows (UX 6.10)', () => {
  it('shows the name, a one-line excerpt with dir="auto", the time and Restore', async () => {
    mockInvoke('dashboard:getIgnored', () => ({
      ok: true,
      value: { items: [dismissed(4, { chat: { ...defaultCard.chat, displayName: 'Dana Levi' } })] },
    }));
    render(<UndoDismissDrawer open onClose={() => {}} />);
    const row = await screen.findByTestId('dismissed-4');
    expect(row).toHaveTextContent('Dana Levi');
    const excerpt = screen.getByTestId('dismissed-excerpt-4');
    expect(excerpt).toHaveAttribute('dir', 'auto');
    expect(excerpt).toHaveTextContent('coffee Thursday at 5?');
    expect(screen.getByTestId('restore-4')).toBeInTheDocument();
  });

  it('offers no approval control: only Restore', async () => {
    mockInvoke('dashboard:getIgnored', () => ({ ok: true, value: { items: [dismissed(4)] } }));
    render(<UndoDismissDrawer open onClose={() => {}} />);
    await screen.findByTestId('dismissed-4');
    expect(screen.queryByTestId('approve-send-4')).toBeNull();
    expect(screen.queryByTestId('approve-event-4')).toBeNull();
    expect(screen.queryByTestId('draft-box')).toBeNull();
  });

  it('renders an untrusted excerpt literally', async () => {
    mockInvoke('dashboard:getIgnored', () => ({
      ok: true,
      value: { items: [dismissed(4, { trigger: { ts: 0, text: '<img src=x onerror=alert(1)>' } })] },
    }));
    const { container } = render(<UndoDismissDrawer open onClose={() => {}} />);
    await screen.findByTestId('dismissed-4');
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByTestId('dismissed-excerpt-4')).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('falls back to a muted sentence when retention removed the text', async () => {
    mockInvoke('dashboard:getIgnored', () => ({
      ok: true,
      value: { items: [dismissed(4, { trigger: { ts: 0, text: null } })] },
    }));
    render(<UndoDismissDrawer open onClose={() => {}} />);
    expect(await screen.findByTestId('dismissed-excerpt-4')).toHaveTextContent('removed after 30 days');
  });

  it('shows "Nothing to undo." when the list is empty', async () => {
    render(<UndoDismissDrawer open onClose={() => {}} />);
    expect(await screen.findByTestId('undo-dismiss-empty')).toHaveTextContent('Nothing to undo.');
  });

  it('offers a retry when the fetch fails', async () => {
    const user = userEvent.setup();
    mockInvoke('dashboard:getIgnored', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    render(<UndoDismissDrawer open onClose={() => {}} />);
    const box = await screen.findByTestId('undo-dismiss-error');
    expect(box).toHaveAttribute('role', 'alert');
    await user.click(screen.getByTestId('undo-dismiss-retry'));
    await waitFor(() => expect(invokeMocks['dashboard:getIgnored']).toHaveBeenCalledTimes(2));
  });
});

describe('UndoDismissDrawer - Restore', () => {
  it('calls item:restore, reloads the drawer and refreshes the dashboard', async () => {
    const user = userEvent.setup();
    const refresh = vi.fn(async () => {});
    useDashboardStore.setState({ refresh });
    mockInvoke('dashboard:getIgnored', () => ({ ok: true, value: { items: [dismissed(4)] } }));
    render(<UndoDismissDrawer open onClose={() => {}} />);
    await user.click(await screen.findByTestId('restore-4'));
    expect(invokeMocks['item:restore']).toHaveBeenCalledWith({ itemId: 4 });
    await waitFor(() => expect(invokeMocks['dashboard:getIgnored']).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalled();
  });
});

describe('UndoDismissDrawer - dialog chrome (UX 7, 13.3)', () => {
  it('moves initial focus to the close button', async () => {
    render(<UndoDismissDrawer open onClose={() => {}} />);
    const close = await screen.findByTestId('undo-dismiss-close');
    await waitFor(() => expect(document.activeElement).toBe(close));
  });

  it('closes on Escape and on the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<UndoDismissDrawer open onClose={onClose} />);
    await screen.findByTestId('undo-dismiss-close');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('undo-dismiss-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('traps Tab inside the panel, in both directions', async () => {
    const user = userEvent.setup();
    mockInvoke('dashboard:getIgnored', () => ({ ok: true, value: { items: [dismissed(4)] } }));
    render(<UndoDismissDrawer open onClose={() => {}} />);
    const close = await screen.findByTestId('undo-dismiss-close');
    const restore = screen.getByTestId('restore-4');

    // forward from the last focusable wraps to the first
    restore.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);

    // and backward from the first wraps to the last
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(restore);
  });

  it("disables the row's Restore button while that restore is in flight", async () => {
    const user = userEvent.setup();
    let release!: (v: unknown) => void;
    mockInvoke('dashboard:getIgnored', () => ({ ok: true, value: { items: [dismissed(4)] } }));
    mockInvoke('item:restore', () => new Promise((r) => (release = r)) as never);
    render(<UndoDismissDrawer open onClose={() => {}} />);
    await user.click(await screen.findByTestId('restore-4'));
    expect(screen.getByTestId('restore-4')).toBeDisabled();
    release({ ok: true, value: structuredClone(defaultCard) });
    await waitFor(() => expect(screen.getByTestId('restore-4')).toBeEnabled());
  });

  it('falls back to the phone number when the contact has no display name', async () => {
    mockInvoke('dashboard:getIgnored', () => ({
      ok: true,
      value: { items: [dismissed(4, { chat: { ...defaultCard.chat, displayName: '' } })] },
    }));
    render(<UndoDismissDrawer open onClose={() => {}} />);
    expect(await screen.findByTestId('dismissed-4')).toHaveTextContent(defaultCard.chat.phoneDisplay);
  });

  it('shows a clock time for today and a day label for an older dismissal', async () => {
    // Pin the clock (Date only, so waitFor / user-event timers stay real): "today" = now - 1 h used to fall on YESTERDAY
    // when the suite ran between 00:00 and 01:00 local. 09:00 UTC on 2026-10-05 is 12:00 in Asia/Jerusalem (the default
    // zone), so now - 1 h is 11:00 the same day, whatever the time of day of the run.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-05T09:00:00Z'));
      expect(useSettingsStore.getState().settings?.general.timeZone).toBe('Asia/Jerusalem');
      const now = Date.now();
      mockInvoke('dashboard:getIgnored', () => ({
        ok: true,
        value: {
          items: [
            dismissed(4, { trigger: { ts: now - 3600_000, text: 'today' } }),
            dismissed(5, { trigger: { ts: now - 5 * 86_400_000, text: 'last week' } }),
          ],
        },
      }));
      render(<UndoDismissDrawer open onClose={() => {}} />);
      const today = (await screen.findByTestId('dismissed-4')).textContent ?? '';
      const older = screen.getByTestId('dismissed-5').textContent ?? '';
      expect(today).toMatch(/\d{1,2}:\d{2}/);
      expect(today).toContain('11:00');
      expect(older).not.toBe(today);
      expect(older).not.toMatch(/\d{1,2}:\d{2}/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps "today" a clock time just after local midnight (the case that used to flake)', async () => {
    // 21:30 UTC on 2026-10-05 = 00:30 on 2026-10-06 in Asia/Jerusalem: a dismissal 10 minutes ago is today (00:20);
    // one 1 h ago (23:30 on the 5th) is yesterday and gets a day label.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-05T21:30:00Z'));
      const now = Date.now();
      mockInvoke('dashboard:getIgnored', () => ({
        ok: true,
        value: {
          items: [
            dismissed(4, { trigger: { ts: now - 600_000, text: 'just now' } }),
            dismissed(5, { trigger: { ts: now - 3600_000, text: 'before midnight' } }),
          ],
        },
      }));
      render(<UndoDismissDrawer open onClose={() => {}} />);
      expect((await screen.findByTestId('dismissed-4')).textContent ?? '').toContain('00:20');
      expect(screen.getByTestId('dismissed-5').textContent ?? '').not.toMatch(/\d{1,2}:\d{2}/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns focus to the opener when it closes', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<UndoDismissDrawer open onClose={() => {}} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('undo-dismiss-close')));
    rerender(<UndoDismissDrawer open={false} onClose={() => {}} />);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });
});
