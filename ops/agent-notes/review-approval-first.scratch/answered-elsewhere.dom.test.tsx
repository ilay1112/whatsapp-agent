// SCRATCH - adversarial review "approval-first", finding approval-first-3.
//
// src/main/bridge/ingest.ts `handleOutbound` marks the item `replyState: 'answered_elsewhere'` when the user replied by
// hand from their phone, but only supersedes the item's pending actions when NO event is pending:
//     if (!eventPending) repos.actions.supersedePending(item.id, now);
// (the guard exists because `supersedePending(itemId)` is item-wide and would also kill the pending create_event).
// So on the common card that carries BOTH a drafted reply and a proposed event, the pending `send_reply` survives.
// This test shows the renderer half: such a card still offers the Send button, and main's `approve` has no
// replyState / closedReason gate - one click sends a duplicate reply to a conversation already answered.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ItemCard as ItemVM } from '@shared/types';
import { ItemCard } from '../../../src/renderer/src/components/ItemCard';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { useFocusGuardStore } from '../../../src/renderer/src/store/health';
import { useSettingsStore } from '../../../src/renderer/src/store/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { defaultCard } from '../../../tests/setup-renderer';

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

describe('[scratch] a card the user already answered from their phone', () => {
  it('must not still offer Send', () => {
    // exactly what ingest.handleOutbound leaves behind when an event is still pending
    const item: ItemVM = { ...structuredClone(defaultCard), replyState: 'answered_elsewhere', eventState: 'proposed' };
    expect(item.actions.some((a) => a.kind === 'send_reply' && a.state === 'pending')).toBe(true);

    render(<ItemCard item={item} mode="compact" />);
    expect(screen.queryByTestId('approve-send-1')).toBeNull();
  });
});
