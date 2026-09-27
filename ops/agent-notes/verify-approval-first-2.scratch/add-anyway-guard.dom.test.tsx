// SCRATCH - independent verification of review finding approval-first-2. Not part of `npm test`.
//
// Written to REFUTE the claim. The two cases are deliberately symmetric: the SAME armed focus guard, the SAME card,
// the SAME kind ('create_event'), only a different control. If the claim is wrong, both controls behave the same.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LIMITS, type ItemCard as ItemVM } from '@shared/types';
import { ItemCard } from '../../../src/renderer/src/components/ItemCard';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { isActivationBlocked, useFocusGuardStore } from '../../../src/renderer/src/store/health';
import { useSettingsStore } from '../../../src/renderer/src/store/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { defaultCard, defaultDetail, invokeMocks, mockInvoke } from '../../../tests/setup-renderer';

beforeEach(() => {
  useDashboardStore.setState({
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    openItemId: null,
    openItem: null,
  });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
});

const eventOnly = (): ItemVM => ({
  ...structuredClone(defaultCard),
  actions: structuredClone(defaultCard.actions).filter((a) => a.kind === 'create_event'),
  draft: null,
  replyState: 'none',
});

const conflictThenDone = (): void => {
  mockInvoke('action:approve', (req) => {
    const r = req as { confirmConflict?: true };
    return r.confirmConflict
      ? { ok: true, value: { outcome: 'done', item: structuredClone(defaultDetail) } }
      : {
          ok: true,
          value: {
            outcome: 'needs_confirm_conflict',
            busy: [{ startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00' }],
            item: structuredClone(defaultDetail),
          },
        };
  });
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('[scratch] approval-first-2: focus guard coverage of create_event controls', () => {
  it('CONTROL: "Add to calendar" (ApproveButton) ignores a click while the guard is armed', async () => {
    conflictThenDone();
    render(<ItemCard item={eventOnly()} mode="compact" />);
    useFocusGuardStore.getState().noteActivation(Date.now());
    expect(isActivationBlocked()).toBe(true);

    screen.getByTestId('approve-event-1').click();
    await settle();
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(0);
  });

  it('SUBJECT: "Add anyway" (ResultRowView) issues the calendar write while the guard is armed', async () => {
    conflictThenDone();
    render(<ItemCard item={eventOnly()} mode="compact" />);

    // 1. a real, deliberate approve while nothing is armed -> main answers needs_confirm_conflict
    screen.getByTestId('approve-event-1').click();
    await waitFor(() => expect(screen.getByTestId('result-add-anyway')).toBeInTheDocument());
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);

    // 2. window went behind another app; the stealing click first raises `focus` (arms the guard), then lands.
    useFocusGuardStore.getState().noteActivation(Date.now());
    expect(isActivationBlocked()).toBe(true);
    screen.getByTestId('result-add-anyway').click();
    await settle();

    // Observed behaviour (the defect): the second approve went out with confirmConflict:true.
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2);
    expect(invokeMocks['action:approve']).toHaveBeenLastCalledWith(expect.objectContaining({ confirmConflict: true }));
    // and it was accepted as done, i.e. a calendar write over a known conflict.
    await waitFor(() => expect(screen.getByTestId('result-1')).toHaveAttribute('data-tone', 'ok'));
  });

  it('SUBJECT/keyboard: Enter on "Add anyway" is not prevented either', async () => {
    conflictThenDone();
    render(<ItemCard item={eventOnly()} mode="compact" />);
    screen.getByTestId('approve-event-1').click();
    const btn = await screen.findByTestId('result-add-anyway');
    expect(btn.getAttribute('onkeydown')).toBeNull();

    useFocusGuardStore.getState().noteActivation(Date.now() + LIMITS.focusGuardRendererMs); // stay armed
    btn.click();
    await settle();
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2);
  });
});
