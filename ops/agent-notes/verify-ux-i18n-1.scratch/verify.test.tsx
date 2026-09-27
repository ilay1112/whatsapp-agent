// SCRATCH ONLY - independent verification of review finding ux-i18n-1 (NOT part of the product suite).
// Control + subject: the same armed focus guard, two different approval controls.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemCard as ItemVM } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { ItemCard } from '../../../src/renderer/src/components/ItemCard';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { useFocusGuardStore } from '../../../src/renderer/src/store/health';
import { useSettingsStore } from '../../../src/renderer/src/store/settings';
import { defaultCard, defaultDetail, invokeMocks, mockInvoke } from '../../../tests/setup-renderer';

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });

beforeEach(() => {
  useDashboardStore.setState({ dirtyItemIds: new Set(), staleItemIds: new Set(), toast: null, openItemId: null, openItem: null });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
});

const conflictThenDone = () =>
  mockInvoke('action:approve', (req) => {
    const r = req as { confirmConflict?: true };
    return r.confirmConflict
      ? ({ ok: true, value: { outcome: 'done', item: structuredClone(defaultDetail) } } as never)
      : ({ ok: true, value: { outcome: 'needs_confirm_conflict', busy: [], item: structuredClone(defaultDetail) } } as never);
  });

describe('ux-i18n-1 verification', () => {
  it('CONTROL: the primary "Add to calendar" button is blocked while the guard is armed', async () => {
    const user = userEvent.setup();
    conflictThenDone();
    render(<ItemCard item={card()} mode="compact" />);
    useFocusGuardStore.getState().noteActivation(Date.now());
    await user.click(screen.getByTestId('approve-event-1'));
    await new Promise((r) => setTimeout(r, 30));
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });

  it('SUBJECT: "Add anyway" approves while the guard is armed (mouse)', async () => {
    const user = userEvent.setup();
    conflictThenDone();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    await screen.findByTestId('result-add-anyway');
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);

    // window regained focus 0 ms ago -> 500 ms of dead time for every approval control (UX 6.8 [R2])
    useFocusGuardStore.getState().noteActivation(Date.now());
    await user.click(screen.getByTestId('result-add-anyway'));
    await new Promise((r) => setTimeout(r, 30));
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
  });

  it('SUBJECT: "Add anyway" approves on Enter while the guard is armed (keyboard)', async () => {
    const user = userEvent.setup();
    conflictThenDone();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    const btn = await screen.findByTestId('result-add-anyway');
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);

    useFocusGuardStore.getState().noteActivation(Date.now());
    btn.focus();
    await user.keyboard('{Enter}');
    await new Promise((r) => setTimeout(r, 30));
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
  });

  it('SANITY: the 2nd approve really carries confirmConflict:true (the calendar write)', async () => {
    const user = userEvent.setup();
    conflictThenDone();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    await screen.findByTestId('result-add-anyway');
    useFocusGuardStore.getState().noteActivation(Date.now());
    await user.click(screen.getByTestId('result-add-anyway'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
    expect(invokeMocks['action:approve']).toHaveBeenLastCalledWith(expect.objectContaining({ confirmConflict: true }));
  });
});
