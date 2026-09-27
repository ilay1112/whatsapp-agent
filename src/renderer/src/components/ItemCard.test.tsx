// Build-plan W1-15 acceptance + UX section 16 items 3, 5 and 6, and the `[R2]` focus-guard / Copy rows.
//
// The rules under test are the approval-first invariants of ARCH 6.6 / UX 6.8, so each of them gets its own assertion:
//   - one click => exactly ONE `action:approve`, carrying the `shownHash` of the VM that was rendered and the textarea
//     content at click time;
//   - a second synchronous click sends nothing;
//   - two buttons are two approvals (approving the event does not send the reply);
//   - nothing sends while the focus guard is armed, by mouse OR by keyboard;
//   - no send happens from an effect, a timer or Ctrl+Enter.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LIMITS, type ItemCard as ItemVM, type ItemDetail } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { ItemCard, SENTINEL, pendingAction, renderBdiTemplate } from './ItemCard';
import { useDashboardStore } from '../store/dashboard';
import { useFocusGuardStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { defaultCard, defaultDetail, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const SEND_HASH = 'a'.repeat(64);
const EVENT_HASH = 'b'.repeat(64);

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });
const detail = (patch: Partial<ItemDetail> = {}): ItemDetail => ({ ...structuredClone(defaultDetail), ...patch });

/** Only the `send_reply` action is pending. */
const sendOnly = (patch: Partial<ItemVM> = {}): ItemVM =>
  card({
    actions: structuredClone(defaultCard.actions).filter((a) => a.kind === 'send_reply'),
    event: null,
    eventState: 'none',
    ...patch,
  });

beforeEach(() => {
  useDashboardStore.setState({
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    openItemId: null,
    openItem: null,
    arrivedItemIds: new Set(),
  });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    saveError: null,
    savedAt: 0,
    calendars: [],
    calendarsLoaded: false,
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// UX 16.3 - one click, one approval, with the rendered shownHash
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard - approval is exactly one deliberate act', () => {
  it('sends exactly one action:approve carrying the shownHash of the rendered VM', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={sendOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['action:approve']).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'send_reply',
        shownHash: SEND_HASH,
        actionId: '11111111-1111-4111-8111-111111111111',
      }),
    );
  });

  it('sends the textarea content as it was at click time', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={sendOnly()} mode="compact" />);
    const box = screen.getByTestId('draft-1');
    await user.clear(box);
    await user.type(box, 'edited by hand');
    await user.click(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['action:approve']).toHaveBeenCalledWith(
      expect.objectContaining({ edit: { text: 'edited by hand' } }),
    );
  });

  it('a second synchronous click sends nothing', async () => {
    let resolve!: (v: unknown) => void;
    mockInvoke('action:approve', () => new Promise((r) => (resolve = r)) as never);
    render(<ItemCard item={sendOnly()} mode="compact" />);
    const button = screen.getByTestId('approve-send-1');
    button.click();
    button.click();
    button.click();
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
    resolve({ ok: true, value: { outcome: 'done', item: detail() } });
  });

  it('ignores the second click of a double-click (event.detail > 1)', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={sendOnly()} mode="compact" />);
    await user.dblClick(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
  });

  it('two buttons are two approvals: approving the event does not send the reply', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['action:approve']).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'create_event', shownHash: EVENT_HASH }),
    );
    expect(invokeMocks['action:approve']).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send_reply' }));
  });

  it('approves nothing on its own: rendering and waiting send no IPC', async () => {
    vi.useFakeTimers();
    try {
      render(<ItemCard item={card()} mode="compact" />);
      vi.advanceTimersByTime(60_000);
      expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Ctrl+Enter in the textarea only MOVES FOCUS to the primary approve button', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={sendOnly()} mode="compact" />);
    await user.click(screen.getByTestId('draft-1'));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(document.activeElement).toBe(screen.getByTestId('approve-send-1'));
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });

  it('shows no optimistic result: the button stays busy until main answers', async () => {
    let resolve!: (v: unknown) => void;
    mockInvoke('action:approve', () => new Promise((r) => (resolve = r)) as never);
    render(<ItemCard item={sendOnly()} mode="compact" />);
    screen.getByTestId('approve-send-1').click();
    await waitFor(() => expect(screen.getByTestId('approve-send-1')).toHaveTextContent('Sending'));
    expect(screen.queryByTestId('result-1')).toBeNull();
    resolve({ ok: true, value: { outcome: 'done', item: detail() } });
    await waitFor(() => expect(screen.getByTestId('result-1')).toHaveTextContent('Sent'));
  });

  // A compact card never receives the answer VM (`applyItem` only replaces the OPEN item), so its props still carry the
  // executed action as `pending`. The confirmation row is the only thing that knows the send happened - so it is what
  // keeps the button out of reach until the list refresh takes the card away (UX 6.8).
  it('leaves no clickable approve button under the "Sent." row of a compact card', async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', () => ({ ok: true, value: { outcome: 'done', item: detail() } }));
    render(<ItemCard item={sendOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(screen.getByTestId('result-1')).toHaveTextContent('Sent'));

    expect(screen.getByTestId('approve-send-1')).toBeDisabled();
    await user.click(screen.getByTestId('approve-send-1'));
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('result-1')).toHaveAttribute('data-tone', 'ok');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [R2] focus guard
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard - focus-steal guard (UX 6.8, LIMITS.focusGuardRendererMs)', () => {
  it('a click within 500 ms of the window gaining focus sends nothing', async () => {
    const user = userEvent.setup();
    useFocusGuardStore.getState().noteActivation(Date.now());
    render(<ItemCard item={sendOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-send-1'));
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });

  it('Enter within 500 ms sends nothing; after 500 ms the same key sends exactly once', async () => {
    const user = userEvent.setup();
    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(t0);
    useFocusGuardStore.getState().noteActivation(t0);
    render(<ItemCard item={sendOnly()} mode="compact" />);
    const button = screen.getByTestId('approve-send-1');
    button.focus();

    await user.keyboard('{Enter}');
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();

    nowSpy.mockReturnValue(t0 + LIMITS.focusGuardRendererMs + 1);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    nowSpy.mockRestore();
  });

  it('reads the guard at CLICK time, not at render time', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={sendOnly()} mode="compact" />); // rendered while unblocked
    useFocusGuardStore.getState().noteActivation(Date.now()); // armed afterwards, without a re-render
    await user.click(screen.getByTestId('approve-send-1'));
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });

  // "Add anyway" is an approval control by name (UX 6.8 lists it), and it writes the event to the calendar, so the
  // guard has to cover the inline result row exactly as it covers ApproveButton.
  describe('the recovery buttons of the result row are approval controls too', () => {
    const conflictThenDone = (): void => {
      mockInvoke('action:approve', (req) => {
        const r = req as { confirmConflict?: true };
        return r.confirmConflict
          ? { ok: true, value: { outcome: 'done', item: detail() } }
          : { ok: true, value: { outcome: 'needs_confirm_conflict', busy: [], item: detail() } };
      });
    };

    it('"Add anyway" sends nothing when it is clicked within 500 ms of the window gaining focus', async () => {
      const user = userEvent.setup();
      conflictThenDone();
      render(<ItemCard item={card()} mode="compact" />);
      await user.click(screen.getByTestId('approve-event-1'));
      await screen.findByTestId('result-add-anyway');
      expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);

      useFocusGuardStore.getState().noteActivation(Date.now()); // the stealing click activates the window
      await user.click(screen.getByTestId('result-add-anyway'));
      expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
      expect(invokeMocks['action:approve']).not.toHaveBeenCalledWith(
        expect.objectContaining({ confirmConflict: true }),
      );
    });

    it('"Add anyway" sends nothing on Enter while the guard is armed, and sends once after it expires', async () => {
      const user = userEvent.setup();
      conflictThenDone();
      const t0 = Date.now();
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(t0);
      render(<ItemCard item={card()} mode="compact" />);
      await user.click(screen.getByTestId('approve-event-1'));
      const button = await screen.findByTestId('result-add-anyway');
      button.focus();

      useFocusGuardStore.getState().noteActivation(t0);
      await user.keyboard('{Enter}');
      expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(t0 + LIMITS.focusGuardRendererMs + 1);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
      expect(invokeMocks['action:approve']).toHaveBeenLastCalledWith(
        expect.objectContaining({ confirmConflict: true }),
      );
      nowSpy.mockRestore();
    });

    it('"Refresh card" is not an approval control and stays usable while the guard is armed', async () => {
      const user = userEvent.setup();
      mockInvoke('action:approve', () => ({ ok: false, error: { code: 'ACTION_STALE' } }));
      render(<ItemCard item={sendOnly()} mode="compact" />);
      await user.click(screen.getByTestId('approve-send-1'));
      await screen.findByTestId('result-refresh');

      useFocusGuardStore.getState().noteActivation(Date.now());
      await user.click(screen.getByTestId('result-refresh'));
      await waitFor(() => expect(screen.queryByTestId('result-1')).toBeNull());
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [R2] Copy is one clipboard:writeText, never navigator.clipboard
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard - Copy', () => {
  it('sends exactly one clipboard:writeText with the textarea value', async () => {
    const user = userEvent.setup();
    const navWrite = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: navWrite }, configurable: true });
    render(<ItemCard item={sendOnly()} mode="compact" />);
    const box = screen.getByTestId('draft-1');
    await user.clear(box);
    await user.type(box, 'copy me');
    await user.click(screen.getByTestId('copy-1'));
    expect(invokeMocks['clipboard:writeText']).toHaveBeenCalledTimes(1);
    expect(invokeMocks['clipboard:writeText']).toHaveBeenCalledWith({ text: 'copy me' });
    expect(navWrite).not.toHaveBeenCalled();
  });

  it('is disabled while the draft is empty', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={sendOnly({ draft: null })} mode="compact" />);
    expect(screen.getByTestId('copy-1')).toBeDisabled();
    await user.click(screen.getByTestId('copy-1'));
    expect(invokeMocks['clipboard:writeText']).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// UX 16.5 - untrusted strings render literally, never as markup
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard - untrusted text (UX 16.5)', () => {
  const XSS = '<img src=x onerror="alert(1)">';
  const MARKDOWN = '[click me](https://evil.example/steal)';

  it('renders an HTML fixture literally, with no <img> and no <a> anywhere in the card', () => {
    const { container } = render(
      <ItemCard
        item={sendOnly({
          chat: { ...defaultCard.chat, displayName: XSS },
          trigger: { ts: defaultCard.trigger.ts, text: `${XSS} ${MARKDOWN}` },
          draft: { text: XSS, lang: 'en', proposalVersion: 1 },
        })}
        mode="compact"
      />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(screen.getByTestId('quoted-bubble')).toHaveTextContent(XSS);
    expect(screen.getByTestId('quoted-bubble')).toHaveTextContent(MARKDOWN);
    expect(screen.getByTestId('card-name')).toHaveTextContent(XSS);
    expect(screen.getByTestId('draft-1')).toHaveValue(XSS);
  });

  it('never produces a link inside a quoted bubble', () => {
    render(<ItemCard item={sendOnly({ trigger: { ts: 0, text: 'see https://evil.example/x now' } })} mode="compact" />);
    expect(screen.getByTestId('quoted-bubble').querySelector('a')).toBeNull();
  });

  it('puts the contact name in <bdi> and the phone in <bdi dir="ltr">', () => {
    render(<ItemCard item={sendOnly()} mode="compact" />);
    expect(screen.getByTestId('card-name').tagName).toBe('BDI');
    const phone = screen.getByTestId('card-phone');
    expect(phone.tagName).toBe('BDI');
    expect(phone).toHaveAttribute('dir', 'ltr');
  });

  it('renderBdiTemplate hands untrusted values to React as children, never to the parser', () => {
    // The template is what i18next produces when the values are the private-use sentinels, exactly as ItemCard does it.
    const raw = `Sends to <bdi>${SENTINEL(0)}</bdi>, <bdi dir="ltr">${SENTINEL(1)}</bdi>`;
    const nodes = renderBdiTemplate(raw, [XSS, '+972 55-000-0001']);
    const { container } = render(<p>{nodes}</p>);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.textContent).toContain(XSS);
    expect(container.textContent).not.toContain('<bdi>');
    expect(container.querySelectorAll('bdi')).toHaveLength(2);
    expect(container.querySelectorAll('bdi')[1]).toHaveAttribute('dir', 'ltr');
  });

  it('the sheet\'s "Sends to" line renders through that path, with no literal markup on screen', () => {
    render(<ItemCard item={detail({ chat: { ...defaultCard.chat, displayName: XSS } })} mode="expanded" />);
    const line = screen.getByTestId('sends-to');
    expect(line.textContent).toContain(XSS);
    expect(line.textContent).not.toContain('<bdi>');
    expect(line.querySelector('img')).toBeNull();
    expect(line.querySelectorAll('bdi').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// card anatomy and per-list behaviour
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard - anatomy and per-list actions (UX 6.5, 6.7)', () => {
  it('message text and the textarea carry dir="auto"', () => {
    render(<ItemCard item={sendOnly()} mode="compact" />);
    expect(screen.getByTestId('quoted-bubble').querySelector('.msg-text')).toHaveAttribute('dir', 'auto');
    expect(screen.getByTestId('draft-1')).toHaveAttribute('dir', 'auto');
  });

  it('reports focus and blur of an event input through item:setEditing', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={detail()} mode="expanded" />);
    await user.click(screen.getByTestId('event-title'));
    await waitFor(() => expect(invokeMocks['item:setEditing']).toHaveBeenCalledWith({ itemId: 1, editing: true }));
    await user.tab();
    await waitFor(() => expect(invokeMocks['item:setEditing']).toHaveBeenCalledWith({ itemId: 1, editing: false }));
  });

  it('an in_calendar card hides the pending reply behind "Reply not sent yet" / Show', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card({ status: 'in_calendar' })} mode="compact" />);
    expect(screen.queryByTestId('approve-send-1')).toBeNull();
    expect(screen.getByText('Reply not sent yet')).toBeInTheDocument();
    await user.click(screen.getByTestId('show-send-1'));
    expect(screen.getByTestId('approve-send-1')).toBeInTheDocument();
  });

  it('an in_calendar card with no pending send_reply shows no "Reply not sent yet" affordance', () => {
    render(<ItemCard item={card({ status: 'in_calendar', actions: [] })} mode="compact" />);
    expect(screen.queryByTestId('show-send-1')).toBeNull();
    expect(screen.queryByText('Reply not sent yet')).toBeNull();
  });

  it('"Open in calendar" goes through external:open with no link in the VM', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card({ status: 'in_calendar' })} mode="compact" />);
    await user.click(screen.getByTestId('open-calendar-1'));
    expect(invokeMocks['external:open']).toHaveBeenCalledWith({ itemId: 1, target: 'calendarEvent' });
  });

  it('an @lid / non-sendable chat is copy-only and has no Send button', () => {
    render(
      <ItemCard item={sendOnly({ chat: { ...defaultCard.chat, sendable: false, phoneDisplay: '' } })} mode="compact" />,
    );
    expect(screen.queryByTestId('approve-send-1')).toBeNull();
    expect(screen.getByTestId('copy-only-reason')).toBeInTheDocument();
    expect(screen.getByTestId('copy-1')).toBeInTheDocument();
  });

  it('an info_missing card offers "Ask for details" instead of "Approve & send"', () => {
    render(<ItemCard item={sendOnly({ status: 'info_missing' })} mode="compact" />);
    expect(screen.getByTestId('approve-send-1')).toHaveTextContent('Ask for details');
  });

  // UX 6.5 (line 524): there is no edit MODE - the draft is always editable in place - but the sheet still offers an
  // explicit "Edit" button that moves focus into the draft, for keyboard and screen-reader users.
  it('the sheet offers "Edit", which focuses the draft textarea', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={detail()} mode="expanded" />);
    await user.click(screen.getByTestId('sheet-edit-1'));
    expect(document.activeElement).toBe(screen.getByTestId('draft-1'));
  });

  it('a compact card has no "Edit" button: clicking into the box is the edit', () => {
    render(<ItemCard item={card()} mode="compact" />);
    expect(screen.queryByTestId('sheet-edit-1')).toBeNull();
  });

  it('the older_message badge is rendered on the card', () => {
    render(<ItemCard item={sendOnly({ badges: ['older_message'] })} mode="compact" />);
    expect(screen.getByTestId('badge-older_message')).toBeInTheDocument();
  });

  it('the manipulation badge collapses the draft behind "show anyway"', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={sendOnly({ badges: ['manipulation'] })} mode="compact" />);
    expect(screen.getByTestId('draft-collapsed')).toBeInTheDocument();
    expect(screen.queryByTestId('draft-box')).toBeNull();
    await user.click(screen.getByTestId('draft-show-anyway'));
    expect(screen.getByTestId('draft-box')).toBeInTheDocument();
  });

  it('dismisses through item:dismiss and closes the sheet', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ItemCard item={detail()} mode="expanded" onClose={onClose} />);
    await user.click(screen.getByTestId('sheet-dismiss-1'));
    expect(invokeMocks['item:dismiss']).toHaveBeenCalledWith({ itemId: 1 });
    expect(onClose).toHaveBeenCalled();
    expect(useDashboardStore.getState().toast).toEqual({ key: 'action.dismissed', itemId: 1 });
  });

  it('the expanded card shows the conversation snapshot, oldest first', () => {
    render(
      <ItemCard
        item={detail({
          messages: [
            { seq: 0, fromMe: true, ts: 1, text: 'are you around this week?' },
            { seq: 1, fromMe: false, ts: 2, text: 'coffee Thursday at 5?' },
          ],
        })}
        mode="expanded"
      />,
    );
    const bubbles = screen.getAllByTestId('quoted-bubble');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toHaveAttribute('data-from', 'me');
    expect(bubbles[1]).toHaveAttribute('data-from', 'contact');
  });

  it('pendingAction only sees actions that are still pending', () => {
    const done = card({ actions: [{ ...defaultCard.actions[0]!, state: 'done' }] });
    expect(pendingAction(done, 'send_reply')).toBeNull();
    expect(pendingAction(card(), 'send_reply')?.kind).toBe('send_reply');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// failures: the inline result row (UX 6.8, 13.3)
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard - rejected approvals', () => {
  it('shows the one-sentence row with a Refresh action and takes focus, when the hash is stale', async () => {
    mockInvoke('action:approve', () => ({ ok: false, error: { code: 'ACTION_STALE' } }));
    render(<ItemCard item={sendOnly()} mode="compact" />);
    screen.getByTestId('approve-send-1').click();
    const row = await screen.findByTestId('result-1');
    expect(row).toHaveAttribute('data-tone', 'error');
    expect(row).toHaveAttribute('role', 'alert');
    expect(row).toHaveTextContent('changed');
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.getByTestId('result-refresh')).toBeInTheDocument();
  });

  it('explains a focus-steal rejection from main without retrying by itself', async () => {
    mockInvoke('action:approve', () => ({ ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } }));
    render(<ItemCard item={sendOnly()} mode="compact" />);
    screen.getByTestId('approve-send-1').click();
    await screen.findByTestId('result-1');
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
  });

  it('offers "Add anyway" on a calendar conflict and re-approves ONLY on that explicit second click', async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', (req) => {
      const r = req as { confirmConflict?: true };
      // `needs_confirm_conflict` also carries the busy blocks main found; the card only needs the outcome.
      return r.confirmConflict
        ? { ok: true, value: { outcome: 'done', item: detail() } }
        : { ok: true, value: { outcome: 'needs_confirm_conflict', busy: [], item: detail() } };
    });
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    await screen.findByTestId('result-1');
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('result-add-anyway'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
    expect(invokeMocks['action:approve']).toHaveBeenLastCalledWith(expect.objectContaining({ confirmConflict: true }));
  });

  it('offers "Change time" next to "Add anyway" and focuses the start field with it (UX 6.8)', async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', () => ({
      ok: true,
      value: { outcome: 'needs_confirm_conflict', busy: [], item: detail() },
    }));
    render(<ItemCard item={detail()} mode="expanded" />);
    await user.click(screen.getByTestId('approve-event-1'));
    await screen.findByTestId('result-add-anyway');

    await user.click(screen.getByTestId('result-change-time'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('event-start')));
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1); // it is not an approval
  });

  it('"Change time" opens the sheet when the conflict was hit on a compact card', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    mockInvoke('action:approve', () => ({
      ok: true,
      value: { outcome: 'needs_confirm_conflict', busy: [], item: detail() },
    }));
    render(<ItemCard item={card()} mode="compact" onOpen={onOpen} />);
    await user.click(screen.getByTestId('approve-event-1'));
    await screen.findByTestId('result-change-time');
    await user.click(screen.getByTestId('result-change-time'));
    expect(onOpen).toHaveBeenCalled();
  });

  // CAL_DUPLICATE and ACTION_UNKNOWN_OUTCOME arrive as `outcome: 'failed'`, and main has already cloned the action for
  // a retry. The row's action approves THAT clone - a new actionId, a new shownHash, one new deliberate click.
  const retryClone = (kind: 'send_reply' | 'create_event', lastError: ErrorCode, actionId: string, hash: string) => ({
    ...structuredClone(defaultCard.actions.find((a) => a.kind === kind)!),
    actionId,
    shownHash: hash,
    attempt: 2,
    lastError,
  });

  it('offers "Create anyway" on CAL_DUPLICATE and re-approves the clone with confirmDuplicate', async () => {
    const user = userEvent.setup();
    const clone = retryClone('create_event', 'CAL_DUPLICATE', '33333333-3333-4333-8333-333333333333', 'c'.repeat(64));
    const answer = detail({
      actions: [{ ...structuredClone(defaultCard.actions[1]!), state: 'failed', lastError: 'CAL_DUPLICATE' }, clone],
    });
    mockInvoke('action:approve', (req) =>
      (req as { confirmDuplicate?: true }).confirmDuplicate
        ? { ok: true, value: { outcome: 'done', item: detail() } }
        : { ok: true, value: { outcome: 'failed', item: answer } },
    );
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    expect(await screen.findByTestId('result-1')).toHaveTextContent('already exists');

    await user.click(screen.getByTestId('result-create-anyway'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
    expect(invokeMocks['action:approve']).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmDuplicate: true, actionId: clone.actionId, shownHash: clone.shownHash }),
    );
  });

  it('the CAL_DUPLICATE row also offers Dismiss', async () => {
    const user = userEvent.setup();
    const clone = retryClone('create_event', 'CAL_DUPLICATE', '33333333-3333-4333-8333-333333333333', 'c'.repeat(64));
    mockInvoke('action:approve', () => ({
      ok: true,
      value: { outcome: 'failed', item: detail({ actions: [clone] }) },
    }));
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('approve-event-1'));
    await screen.findByTestId('result-dismiss');
    await user.click(screen.getByTestId('result-dismiss'));
    expect(invokeMocks['item:dismiss']).toHaveBeenCalledWith({ itemId: 1 });
  });

  it('offers "Send again" on an unknown outcome and approves the fresh action', async () => {
    const user = userEvent.setup();
    const clone = retryClone(
      'send_reply',
      'ACTION_UNKNOWN_OUTCOME',
      '44444444-4444-4444-8444-444444444444',
      'd'.repeat(64),
    );
    const answer = detail({
      actions: [{ ...structuredClone(defaultCard.actions[0]!), state: 'unknown_outcome' }, clone],
    });
    let first = true;
    mockInvoke('action:approve', () => {
      if (!first) return { ok: true, value: { outcome: 'done', item: detail() } };
      first = false;
      return { ok: true, value: { outcome: 'failed', item: answer } };
    });
    render(<ItemCard item={sendOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-send-1'));
    expect(await screen.findByTestId('result-1')).toHaveTextContent('could not confirm');

    await user.click(screen.getByTestId('result-send-again'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
    expect(invokeMocks['action:approve']).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionId: clone.actionId, shownHash: clone.shownHash }),
    );
  });

  it('shows the stale notice with a Refresh card button once the inputs are no longer focused', async () => {
    useDashboardStore.setState({ staleItemIds: new Set([1]) });
    render(<ItemCard item={sendOnly()} mode="compact" />);
    expect(screen.getByTestId('stale-1')).toHaveTextContent('changed');
    expect(screen.getByTestId('refresh-1')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [repair ux-i18n-3] the approval sheet names the target calendar (UX 7.2 "target calendar name", mock 6.7)
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard - the sheet names the target calendar, never its API id', () => {
  const secondary = 'abc123def@group.calendar.google.com';

  it('resolves the default "primary" target to the calendar NAME Google reports', async () => {
    render(<ItemCard item={detail()} mode="expanded" />);
    const sheet = screen.getByTestId('sheet-event');
    await waitFor(() => expect(sheet).toHaveTextContent('Calendar: Personal'));
    expect(sheet.textContent).not.toContain('primary');
  });

  it('resolves a secondary calendar id to its name', async () => {
    mockInvoke('google:listCalendars', () => ({
      ok: true,
      value: {
        calendars: [
          { id: 'primary', name: 'Personal', primary: true, timeZone: 'Asia/Jerusalem', writable: true },
          { id: secondary, name: 'Work', primary: false, timeZone: 'Asia/Jerusalem', writable: true },
        ],
      },
    }));
    useSettingsStore.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        calendar: { ...structuredClone(DEFAULT_SETTINGS.calendar), targetCalendarId: secondary },
      },
    });
    render(<ItemCard item={detail()} mode="expanded" />);
    const sheet = screen.getByTestId('sheet-event');
    await waitFor(() => expect(sheet).toHaveTextContent('Calendar: Work'));
    expect(sheet.textContent).not.toContain('group.calendar.google.com');
  });

  // Google may be unreachable or not configured at all; the sheet still must not print "primary" at the user.
  it('falls back to a translated name for "primary" when the list cannot be fetched', async () => {
    mockInvoke('google:listCalendars', () => ({ ok: false, error: { code: 'GOOGLE_CREDENTIALS_INVALID' } }));
    render(<ItemCard item={detail()} mode="expanded" />);
    const sheet = screen.getByTestId('sheet-event');
    await waitFor(() => expect(sheet).toHaveTextContent('Calendar: Main calendar'));
    expect(sheet.textContent).not.toContain('primary');
  });

  // UX 15.1: an interpolated UNTRUSTED value (CalendarInfo.name is marked UNTRUSTED in CONTRACTS) is always isolated,
  // or a Latin id reorders the surrounding Hebrew sentence.
  it('isolates the name in a <bdi> so it cannot reorder the Hebrew sentence', async () => {
    mockInvoke('google:listCalendars', () => ({ ok: false, error: { code: 'GOOGLE_CREDENTIALS_INVALID' } }));
    useSettingsStore.setState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        calendar: { ...structuredClone(DEFAULT_SETTINGS.calendar), targetCalendarId: secondary },
      },
    });
    render(<ItemCard item={detail()} mode="expanded" />);
    const sheet = screen.getByTestId('sheet-event');
    await waitFor(() => expect(sheet).toHaveTextContent(secondary));
    const isolated = [...sheet.querySelectorAll('bdi')].map((b) => b.textContent);
    expect(isolated).toContain(secondary);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [repair ux-i18n-9] UX 2.4: a card that arrived or changed while the window was visible shows the fading 3 px edge
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard - arrival edge', () => {
  it('wears the card-arrival utility while its id is in the arrived set, and only then', () => {
    const { rerender } = render(<ItemCard item={sendOnly()} mode="compact" />);
    expect(screen.getByTestId('card-1').className).not.toContain('card-arrival');

    useDashboardStore.setState({ arrivedItemIds: new Set([1]) });
    rerender(<ItemCard item={sendOnly()} mode="compact" />);
    expect(screen.getByTestId('card-1').className).toContain('card-arrival');
  });

  it('never puts the edge on the expanded sheet - the edge is a list cue (UX 2.4)', () => {
    useDashboardStore.setState({ arrivedItemIds: new Set([1]) });
    render(<ItemCard item={detail()} mode="expanded" />);
    expect(screen.getByTestId('sheet-card-1').className).not.toContain('card-arrival');
  });
});
