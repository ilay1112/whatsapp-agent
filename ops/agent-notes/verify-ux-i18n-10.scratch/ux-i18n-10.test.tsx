// Scratch verification of review finding ux-i18n-10 (compact card: approval button re-enabled during the
// 1.2 s confirmation window). Read-only probe: no product file is touched.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemCard as ItemVM, ItemDetail } from '@shared/types';
import { ItemCard } from '../../../src/renderer/src/components/ItemCard';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { useFocusGuardStore } from '../../../src/renderer/src/store/health';
import { useSettingsStore } from '../../../src/renderer/src/store/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { defaultCard, defaultDetail, invokeMocks, mockInvoke } from '../../../tests/setup-renderer';

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });
const detail = (patch: Partial<ItemDetail> = {}): ItemDetail => ({ ...structuredClone(defaultDetail), ...patch });
const sendOnly = (patch: Partial<ItemVM> = {}): ItemVM =>
  card({
    actions: structuredClone(defaultCard.actions).filter((a) => a.kind === 'send_reply'),
    event: null,
    eventState: 'none',
    ...patch,
  });

beforeEach(() => {
  vi.useRealTimers();
  useDashboardStore.setState({
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    openItemId: null, // dashboard list card: NO open item -> applyItem must early-return
    openItem: null,
  });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
});

describe('ux-i18n-10 probe', () => {
  it('compact card: after outcome=done the approve button is enabled again while "Sent." is shown', async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', () => ({ ok: true, value: { outcome: 'done', item: detail() } }) as never);
    render(<ItemCard item={sendOnly()} mode="compact" />);

    await user.click(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(screen.getByTestId('result-1')).toHaveTextContent('Sent'));

    const button = screen.getByTestId('approve-send-1') as HTMLButtonElement;
    // eslint-disable-next-line no-console
    console.log('[probe] button.disabled after success =', button.disabled);
    expect(button.disabled).toBe(false); // <- the finding's premise
  });

  it('compact card: a SECOND click in that window fires a second action:approve and replaces the green row', async () => {
    let call = 0;
    mockInvoke('action:approve', () => {
      call += 1;
      return call === 1
        ? ({ ok: true, value: { outcome: 'done', item: detail() } } as never)
        : ({ ok: false, error: { code: 'ACTION_STALE' } } as never);
    });
    render(<ItemCard item={sendOnly()} mode="compact" />);

    const first = userEvent.setup();
    await first.click(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(screen.getByTestId('result-1')).toHaveTextContent('Sent'));

    // Fresh pointer state = a deliberate later click (detail === 1), like a real click after the OS
    // double-click interval has elapsed but before the CONFIRM_MS refresh lands.
    const second = userEvent.setup();
    await second.click(screen.getByTestId('approve-send-1'));

    // eslint-disable-next-line no-console
    console.log('[probe] approve calls =', invokeMocks['action:approve'].mock.calls.length);
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('result-1')).toHaveTextContent('review again'));
    // eslint-disable-next-line no-console
    console.log('[probe] result row now =', screen.getByTestId('result-1').textContent);
  });

  it('control: on the OPEN (expanded) card applyItem replaces the item and the button goes away', async () => {
    const user = userEvent.setup();
    const d = detail();
    useDashboardStore.setState({ openItemId: d.itemId, openItem: d });
    const sent: ItemDetail = {
      ...structuredClone(d),
      actions: structuredClone(d.actions).map((a) =>
        a.kind === 'send_reply' ? { ...a, state: 'done' as const } : a,
      ),
    };
    mockInvoke('action:approve', () => ({ ok: true, value: { outcome: 'done', item: sent } }) as never);
    render(<ItemCard item={d} mode="expanded" />);
    await user.click(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(screen.getByTestId('result-1')).toHaveTextContent('Sent'));
    // eslint-disable-next-line no-console
    console.log('[probe] store openItem send_reply state =',
      useDashboardStore.getState().openItem?.actions.find((a) => a.kind === 'send_reply')?.state);
  });
});

describe('ux-i18n-10 probe - how long the stale compact props survive', () => {
  it('a DIRTY compact card is pinned by mergeColumn, so refresh() never replaces its pending action', async () => {
    const old = sendOnly();
    useDashboardStore.setState({
      lists: {
        needs_reply: { items: [old], count: 1 },
        in_calendar: { items: [], count: 0 },
        info_missing: { items: [], count: 0 },
      },
      dirtyItemIds: new Set([old.itemId]), // the user edited the draft before sending -> draft !== suggestion
      staleItemIds: new Set(),
    });
    const sentCard: ItemVM = {
      ...structuredClone(old),
      updatedAt: old.updatedAt + 1,
      status: 'in_calendar',
      actions: structuredClone(old.actions).map((a) => ({ ...a, state: 'done' as const })),
    };
    mockInvoke('dashboard:get', () => ({
      ok: true,
      value: {
        needsReply: [],
        inCalendar: [sentCard],
        infoMissing: [],
        counts: { needsReply: 0, inCalendar: 1, infoMissing: 0, ignored: 0 },
        analysing: 0,
      },
    }) as never);

    await useDashboardStore.getState().refresh();
    const s = useDashboardStore.getState();
    const kept = [...s.lists.needs_reply.items, ...s.lists.in_calendar.items].find((c) => c.itemId === old.itemId);
    // eslint-disable-next-line no-console
    console.log('[probe] after refresh: kept send_reply state =',
      kept?.actions.find((a) => a.kind === 'send_reply')?.state, '| stale flagged =', s.staleItemIds.has(old.itemId));
    expect(kept?.actions.find((a) => a.kind === 'send_reply')?.state).toBe('pending');
    expect(s.staleItemIds.has(old.itemId)).toBe(true);
  });
});
