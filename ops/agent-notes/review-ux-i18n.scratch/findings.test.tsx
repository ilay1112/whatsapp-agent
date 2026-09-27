// SCRATCH ONLY - adversarial review "ux-i18n". These tests are expected to FAIL against the current code;
// each one pins one reported defect. They are NOT part of the product suite (they live outside tests/ and src/).
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemCard as ItemVM } from '@shared/types';
import type { AppHealth } from '@shared/health';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { ItemCard } from '../../../src/renderer/src/components/ItemCard';
import { HealthPill } from '../../../src/renderer/src/components/HealthPill';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { useFocusGuardStore, useHealthStore } from '../../../src/renderer/src/store/health';
import { useSettingsStore } from '../../../src/renderer/src/store/settings';
import { defaultCard, defaultDetail, invokeMocks, mockInvoke } from '../../../tests/setup-renderer';

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });

beforeEach(() => {
  useDashboardStore.setState({ dirtyItemIds: new Set(), staleItemIds: new Set(), toast: null, openItemId: null, openItem: null });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
  useHealthStore.setState({ health: null, progress: null, hiddenSetupTasks: [] });
});

// ---------------------------------------------------------------------------------------------------------------------
// ux-i18n-1 : "Add anyway" is an approval control and must honour the [R2] renderer focus guard
// ---------------------------------------------------------------------------------------------------------------------
describe('ux-i18n-1 - the conflict "Add anyway" button bypasses the focus-steal guard', () => {
  it('does not call action:approve while the focus guard is armed', async () => {
    const user = userEvent.setup();
    let call = 0;
    mockInvoke('action:approve', async () => {
      call += 1;
      return call === 1
        ? ({ ok: true, value: { outcome: 'needs_confirm_conflict', item: structuredClone(defaultDetail) } } as never)
        : ({ ok: true, value: { outcome: 'done', item: structuredClone(defaultDetail) } } as never);
    });

    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    await screen.findByTestId('result-add-anyway');
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);

    // The window just regained focus (alt-tab, a closing dialog, a notification): 500 ms of dead time (LIMITS.focusGuardRendererMs).
    useFocusGuardStore.getState().noteActivation(Date.now());
    screen.getByTestId('result-add-anyway').click();

    await new Promise((r) => setTimeout(r, 30));
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1); // FAILS: a 2nd approve is sent -> calendar write
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ux-i18n-2 : every red health row must offer exactly one action (HealthPill file header + UX 5.2)
// ---------------------------------------------------------------------------------------------------------------------
const health = (patch: Partial<AppHealth>): AppHealth => ({
  overall: 'attention',
  whatsapp: { state: 'online', since: 0 },
  llm: { state: 'ready', since: 0, provider: 'local', model: '' },
  calendar: { state: 'connected', since: 0 },
  queue: { pending: 0, running: 0 },
  paused: false,
  ...patch,
});

describe('ux-i18n-2 - red calendar rows have no action button', () => {
  it.each(['reconnect_required', 'unavailable', 'port_busy', 'toolset_mismatch'] as const)(
    'calendar state %s is red and still offers an action',
    async (state) => {
      const user = userEvent.setup();
      const h = health({ calendar: { state, since: 0 } }); // compose.ts calls setCalendar({state}) - never with a code
      render(<HealthPill health={h} onAction={() => {}} />);
      await user.click(screen.getByTestId('health-pill'));
      expect(screen.getByTestId('health-row-calendar')).toHaveAttribute('data-status', 'attention');
      expect(screen.queryByTestId('health-action-calendar')).not.toBeNull(); // FAILS: no button is rendered
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// ux-i18n-3 : the approval sheet shows the raw Google calendar id instead of a calendar name
// ---------------------------------------------------------------------------------------------------------------------
describe('ux-i18n-3 - "Calendar: primary" is shown to the user', () => {
  it('does not print the raw calendar id', async () => {
    useDashboardStore.setState({ openItemId: 1, openItem: structuredClone(defaultDetail) });
    render(<ItemCard item={structuredClone(defaultDetail)} mode="expanded" />);
    const editor = await screen.findByTestId('event-editor');
    await waitFor(() => expect(editor.textContent ?? '').not.toContain('primary')); // FAILS: "Calendar: primary"
  });
});
