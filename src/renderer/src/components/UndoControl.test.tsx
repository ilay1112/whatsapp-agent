// V2-W1-11: one Undo door (UX2 3.4, 8, 11.4, 11.5, 15.1; B10, F1, F32).
//   - Undo is approval-class: exactly ONE IPC per activation, disabled synchronously (aria-disabled, still focusable),
//     `event.detail > 1` ignored, the 500 ms focus-steal guard read at click time (mouse AND keyboard);
//   - it is never called from an effect or a timer: rendering and waiting send nothing;
//   - Undo -> "Undoing..." -> "Undone"; failures show "Could not undo" + Try again;
//   - blocked_changed / blocked_started are amber lines; blocked_started offers the guarded "Cancel event" (item:cancelEvent).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Result, UndoView } from '@shared/types';
import { GuardedButton, UndoControl, undoSucceeded } from './UndoControl';
import { useFocusGuardStore } from '../store/health';
import { defaultDetail, i18next, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const UNTIL = Date.UTC(2026, 8, 23, 14, 0); // Wed 17:00 in Asia/Jerusalem
const undo = (patch: Partial<UndoView> = {}): UndoView => ({
  revisionId: 5,
  until: UNTIL,
  state: 'available',
  automatic: false,
  ...patch,
});
const done: Result<unknown> = { ok: true, value: { outcome: 'done', item: defaultDetail } };

beforeEach(() => {
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});

describe('UndoControl - one deliberate click, one IPC', () => {
  it('available: Undo button + the deadline line it is described by', () => {
    render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Undo' });
    expect(button).toHaveAttribute('data-testid', 'undo-7');
    const until = screen.getByTestId('undo-until-7');
    expect(until).toHaveTextContent('Undo available until Wed 17:00');
    expect(button.getAttribute('aria-describedby')).toBe(until.id);
    expect(screen.getByTestId('undo-state-7')).toHaveAttribute('data-state', 'available');
    expect(button.className).not.toMatch(/btn-primary/); // Undo is never accent (UX2 1.2)
  });

  it('a click sends exactly one onUndo; the button turns aria-disabled synchronously and says "Undoing..."', async () => {
    let resolve!: (r: Result<unknown>) => void;
    const onUndo = vi.fn(() => new Promise<Result<unknown>>((r) => (resolve = r)));
    render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={onUndo} />);
    const button = screen.getByTestId('undo-7');
    act(() => {
      button.click();
      button.click();
      button.click();
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveTextContent('Undoing...');
    expect(screen.getByTestId('undo-state-7')).toHaveAttribute('data-state', 'undoing');
    await act(async () => resolve(done));
    expect(screen.getByTestId('undo-done-7')).toHaveTextContent('Undone');
    expect(screen.getByTestId('undo-state-7')).toHaveAttribute('data-state', 'undone');
  });

  it('ignores the second click of a double-click', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn(async () => done);
    render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={onUndo} />);
    await user.dblClick(screen.getByTestId('undo-7'));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('refuses activation while the focus-steal guard is armed (mouse and keyboard)', async () => {
    const user = userEvent.setup();
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    const onUndo = vi.fn(async () => done);
    render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={onUndo} />);
    await user.click(screen.getByTestId('undo-7'));
    screen.getByTestId('undo-7').focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('never undoes on its own: rendering and waiting send nothing', () => {
    vi.useFakeTimers();
    try {
      const onUndo = vi.fn(async () => done);
      render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={onUndo} />);
      vi.advanceTimersByTime(120_000);
      expect(onUndo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed answer shows "Could not undo" + Try again (a new click)', async () => {
    const user = userEvent.setup();
    const onUndo = vi
      .fn<() => Promise<Result<unknown>>>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'CAL_UPDATE_FAILED' } })
      .mockResolvedValueOnce(done);
    render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={onUndo} />);
    await user.click(screen.getByTestId('undo-7'));
    await waitFor(() => expect(screen.getByTestId('undo-state-7')).toHaveAttribute('data-state', 'failed'));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not undo');
    await user.click(screen.getByTestId('undo-retry-7'));
    await waitFor(() => expect(screen.getByTestId('undo-state-7')).toHaveAttribute('data-state', 'undone'));
    expect(onUndo).toHaveBeenCalledTimes(2);
  });

  it('a rejected promise also lands on "failed"', async () => {
    const user = userEvent.setup();
    render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={() => Promise.reject(new Error('x'))} />);
    await user.click(screen.getByTestId('undo-7'));
    await waitFor(() => expect(screen.getByTestId('undo-state-7')).toHaveAttribute('data-state', 'failed'));
  });

  it('a non-done outcome (needs_confirm_drift) is not a success', () => {
    expect(undoSucceeded({ ok: true, value: { outcome: 'needs_confirm_drift' } })).toBe(false);
    expect(undoSucceeded({ ok: true, value: null })).toBe(false);
    expect(undoSucceeded(done)).toBe(true);
  });

  it('a refresh with a new view model replaces the in-window overlay', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn(async (): Promise<Result<unknown>> => ({ ok: false, error: { code: 'CAL_UPDATE_FAILED' } }));
    const { rerender } = render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={onUndo} />);
    await user.click(screen.getByTestId('undo-7'));
    await waitFor(() => expect(screen.getByTestId('undo-state-7')).toHaveAttribute('data-state', 'failed'));
    rerender(<UndoControl undo={undo({ state: 'blocked_changed' })} itemId={7} door="card" onUndo={onUndo} />);
    expect(screen.getByTestId('undo-state-7')).toHaveAttribute('data-state', 'blocked_changed');
  });
});

describe('UndoControl - view-model states', () => {
  it('undone: the ok chip', () => {
    render(<UndoControl undo={undo({ state: 'undone' })} itemId={7} door="card" onUndo={vi.fn()} />);
    expect(screen.getByTestId('undo-done-7')).toHaveClass('chip-ok');
    expect(screen.queryByTestId('undo-7')).toBeNull();
  });

  it('expired: muted text, no button', () => {
    render(<UndoControl undo={undo({ state: 'expired' })} itemId={7} door="card" onUndo={vi.fn()} />);
    expect(screen.getByText('Undo no longer available')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('blocked_changed: the long amber sentence on the card, the short one elsewhere', () => {
    const { rerender } = render(
      <UndoControl undo={undo({ state: 'blocked_changed' })} itemId={7} door="card" onUndo={vi.fn()} />,
    );
    expect(screen.getByText(/undo would overwrite your change/)).toHaveClass('note-amber');
    rerender(<UndoControl undo={undo({ state: 'blocked_changed' })} itemId={7} door="activity" onUndo={vi.fn()} />);
    expect(screen.getByText('You changed this in Google after it was added')).toBeInTheDocument();
    expect(screen.getByTestId('undo-state-activity-7')).toHaveAttribute('data-door', 'activity');
  });

  it('blocked_started on the card offers the guarded "Cancel event" (item:cancelEvent, F32)', async () => {
    const user = userEvent.setup();
    render(<UndoControl undo={undo({ state: 'blocked_started' })} itemId={7} door="card" onUndo={vi.fn()} />);
    expect(screen.getByText('The event has already started - undo is not available.')).toBeInTheDocument();
    const cancel = screen.getByTestId('undo-cancel-event-7');
    expect(cancel).toHaveClass('text-danger');
    expect(cancel.className).not.toMatch(/btn-danger|btn-primary/);
    await user.click(cancel);
    await waitFor(() => expect(invokeMocks['item:cancelEvent']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['item:cancelEvent']).toHaveBeenCalledWith({ itemId: 7 });
  });

  it('blocked_started in the strip / activity: short line, no cancel button', () => {
    render(<UndoControl undo={undo({ state: 'blocked_started' })} itemId={7} door="strip" onUndo={vi.fn()} />);
    expect(screen.getByText('It has already started')).toBeInTheDocument();
    expect(screen.queryByTestId('undo-cancel-event-7')).toBeNull();
  });

  it('strip / activity doors keep the deadline for screen readers only', () => {
    render(<UndoControl undo={undo()} itemId={7} door="strip" onUndo={vi.fn()} />);
    expect(screen.getByTestId('undo-until-strip-7')).toHaveClass('sr-only');
    expect(screen.getByTestId('undo-strip-7')).toBeInTheDocument();
  });

  it('failed from main: red line + Try again', () => {
    render(<UndoControl undo={undo({ state: 'failed' })} itemId={7} door="strip" onUndo={vi.fn()} />);
    expect(screen.getByText('Could not undo')).toHaveClass('text-danger');
    expect(screen.getByTestId('undo-retry-strip-7')).toBeInTheDocument();
  });

  it('he: the Undo button reads "ביטול השינוי", never the bare "ביטול"', async () => {
    await i18next.changeLanguage('he');
    render(<UndoControl undo={undo()} itemId={7} door="card" onUndo={vi.fn()} />);
    expect(screen.getByTestId('undo-7')).toHaveTextContent('ביטול השינוי');
    expect(screen.getByTestId('undo-until-7')).toHaveTextContent('אפשר לבטל עד');
  });
});

// ux-i18n-v2-9: the 7-day manual window read "until Wed 10:00" on that same Wednesday - it looked already over.
describe('UndoControl - the deadline names its date when a bare weekday would be ambiguous', () => {
  const DAY = 86_400_000;
  it.each([6, 7])('a deadline %i days away spells out the day of the month', (days) => {
    const until = Date.now() + days * DAY;
    render(<UndoControl undo={undo({ until })} itemId={7} door="card" onUndo={vi.fn()} />);
    const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'Asia/Jerusalem' }).format(until);
    // "Wed 23 Sept 10:00": the day number followed by the month name (not a digit of the time)
    expect(screen.getByTestId('undo-until-7').textContent).toMatch(new RegExp(` ${day} \\p{L}`, 'u'));
  });

  it('a deadline within 3 days (the automatic window) keeps the short "Wed 17:00" form', () => {
    const until = Date.now() + 2 * DAY;
    render(<UndoControl undo={undo({ until, automatic: true })} itemId={7} door="card" onUndo={vi.fn()} />);
    expect(screen.getByTestId('undo-until-7').textContent).toMatch(/until \w{3} \d{2}:\d{2}$/);
  });
});

describe('GuardedButton', () => {
  it('one IPC per activation, guard at click time, busy label while in flight', async () => {
    let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<GuardedButton testId="g" label="Restore original" busyLabel="Restoring..." run={run} />);
    const b = screen.getByTestId('g');
    act(() => {
      b.click();
      b.click();
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(b).toHaveTextContent('Restoring...');
    expect(b).toBeDisabled();
    await act(async () => resolve());
    expect(b).toHaveTextContent('Restore original');
    await waitFor(() => expect(invokeMocks['dashboard:get']).toHaveBeenCalled());
  });

  it('refuses while the focus guard is armed and ignores double clicks', async () => {
    const user = userEvent.setup();
    const run = vi.fn(async () => undefined);
    render(<GuardedButton testId="g" label="x" busyLabel="y" run={run} />);
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId('g'));
    expect(run).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    await user.dblClick(screen.getByTestId('g'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a rejected run still frees the button', async () => {
    const user = userEvent.setup();
    mockInvoke('dashboard:get', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    render(<GuardedButton testId="g" label="x" busyLabel="y" run={() => Promise.reject(new Error('no'))} />);
    await user.click(screen.getByTestId('g'));
    await waitFor(() => expect(screen.getByTestId('g')).not.toBeDisabled());
  });

  // ux-i18n-v2-6: main's refusal used to be swallowed - the button just came back with no message.
  it.each([
    ['CAL_UNAVAILABLE', { ok: false, error: { code: 'CAL_UNAVAILABLE' } }, 'The calendar connection stopped'],
    ['WINDOW_NOT_FOCUSED', { ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } }, 'Bring the window to the front first'],
  ] as const)('a refused item:cancelEvent (%s) is shown inline with role=alert', async (code, answer, title) => {
    mockInvoke('item:cancelEvent', () => answer as never);
    render(
      <UndoControl
        undo={undo({ state: 'blocked_started', automatic: true })}
        itemId={7}
        door="card"
        onUndo={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('undo-cancel-event-7'));
    await waitFor(() => expect(invokeMocks['item:cancelEvent']).toHaveBeenCalledOnce());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'undo-cancel-event-7-error');
    expect(alert).toHaveAttribute('data-code', code);
    expect(alert).toHaveTextContent(title);
  });

  it('an outcome other than "done" is a failure too (the failed action\'s own error); a success shows nothing', async () => {
    const failedItem = {
      ...defaultDetail,
      actions: [{ ...(defaultDetail.actions[0] ?? {}), lastError: 'CAL_EVENT_GONE' }],
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { outcome: 'failed', item: failedItem } })
      .mockResolvedValueOnce(done);
    render(<GuardedButton testId="g" label="Restore original" busyLabel="..." run={run} />);
    await userEvent.click(screen.getByTestId('g'));
    expect(await screen.findByRole('alert')).toHaveAttribute('data-code', 'CAL_EVENT_GONE');
    await userEvent.click(screen.getByTestId('g'));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
