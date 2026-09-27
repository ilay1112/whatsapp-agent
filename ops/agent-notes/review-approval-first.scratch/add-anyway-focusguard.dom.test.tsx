// SCRATCH - adversarial review "approval-first", finding approval-first-2.
//
// Claim: "Add anyway" (data-testid="result-add-anyway") is an approval control - clicking it issues
// `action:approve` with confirmConflict:true, which writes the event to the user's calendar - but it is rendered by
// `ResultRowView` as a bare `<button onClick={a.run}>`, so it never consults `isActivationBlocked()`.
// The rule stated at the top of src/renderer/src/components/ItemCard.tsx and in src/renderer/src/store/health.ts is
// that EVERY approval control ignores activation for LIMITS.focusGuardRendererMs after the window gained focus.
// Main's own guard does not cover this: it only fires for a window opened by a NOTIFICATION click
// (IpcContext.shownByNotificationAt + LIMITS.focusGuardMainMs), not for an ordinary focus-steal click.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemCard as ItemVM } from '@shared/types';
import { ItemCard } from '../../../src/renderer/src/components/ItemCard';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { useFocusGuardStore } from '../../../src/renderer/src/store/health';
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

describe('[scratch] "Add anyway" and the renderer focus-steal guard', () => {
  it('must not approve while the focus guard is armed', async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', () => ({
      ok: true,
      value: {
        outcome: 'needs_confirm_conflict',
        busy: [{ startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00' }],
        item: structuredClone(defaultDetail),
      },
    }));

    render(<ItemCard item={eventOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    await waitFor(() => expect(screen.getByTestId('result-add-anyway')).toBeInTheDocument());
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);

    // The user alt-tabs away and the window is re-activated by the very click that lands on "Add anyway".
    useFocusGuardStore.getState().noteActivation(Date.now());
    screen.getByTestId('result-add-anyway').click();

    // Every approval control must ignore this click: no second action:approve.
    await new Promise((r) => setTimeout(r, 10));
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
  });
});
