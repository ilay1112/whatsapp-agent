// V2-W1-11: "Done automatically - last 7 days" (UX2 3.1, 11.1, 13, 15.1/15.3/15.4; B11 door 2; T2 5 "Renderer").
//   - absent (not in the DOM) when nothing qualifies; NOT a list: no counts per list, no cards, no approvals;
//   - rows: app-rendered date tab + untrusted title (dir="auto", literal) + time range + verb phrase + relative time;
//   - Undo = one onUndo per activation, behind the focus-steal guard; Pause only while the policy is `on`, no guard;
//   - collapsible (aria-expanded), default open while any row is undoable; > 5 rows => "Show all in Automatic activity".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutoState, AutoWriteView, EventContentView } from '@shared/types';
import { AutoStrip, STRIP_MAX_ROWS } from './AutoStrip';
import { useAutoStore } from '../store/auto';
import { useDashboardStore } from '../store/dashboard';
import { useFocusGuardStore } from '../store/health';
import { i18next, invokeMocks } from '../../../../tests/setup-renderer';

const NOW = Date.UTC(2026, 8, 28, 9, 0); // Mon 28 Sep 12:00 Asia/Jerusalem
const ev = (patch: Partial<EventContentView> = {}): EventContentView => ({
  title: 'Dentist',
  startLocal: '2026-10-01T16:00:00',
  endLocal: '2026-10-01T17:00:00',
  timeZone: 'Asia/Jerusalem',
  location: '',
  status: 'confirmed',
  ...patch,
});
let seq = 0;
const row = (patch: Partial<AutoWriteView> = {}): AutoWriteView => ({
  autoWriteId: `00000000-0000-4000-8000-00000000000${seq++}`,
  itemId: 40 + seq,
  kind: 'create',
  event: ev(),
  before: null,
  writtenAt: NOW - 12 * 60_000,
  undoState: 'available',
  undoUntil: NOW + 3_600_000,
  revisionId: 9,
  ...patch,
});
const policy = (state: NonNullable<AutoState['policy']>['state']): AutoState['policy'] => ({
  id: 'p1',
  state,
  enabledAt: NOW - 86_400_000,
  expiresAt: NOW + 20 * 86_400_000,
  shadowUntil: NOW - 3_600_000,
  pausedReason: null,
  scope: { edits: true, cancels: true, quietHours: { start: 22, end: 7 } } as never,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  seq = 0;
  useAutoStore.setState({ state: null, rows: [], fetchedAt: NOW, undoing: new Set(), failed: new Set() });
  useDashboardStore.setState({ navRequest: null });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

const noop = (): void => undefined;

describe('AutoStrip - presence', () => {
  it('leaves the DOM entirely when no row qualifies', () => {
    const { container } = render(
      <AutoStrip
        rows={[row({ undoState: 'expired', writtenAt: NOW - 3 * 86_400_000 })]}
        policyState={policy('on')}
        onUndo={noop}
        onShow={noop}
        onPause={noop}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('autostrip')).toBeNull();
  });

  it('with no rows at all it renders nothing', () => {
    const { container } = render(<AutoStrip rows={[]} policyState={null} onUndo={noop} onShow={noop} onPause={noop} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an undoable row and a row written in the last 24 h (even when undone)', () => {
    const rows = [
      row(),
      row({ undoState: 'undone', writtenAt: NOW - 3_600_000 }),
      row({ undoState: 'expired', writtenAt: NOW - 2 * 86_400_000 }),
    ];
    render(<AutoStrip rows={rows} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />);
    const strip = screen.getByTestId('autostrip');
    expect(strip.tagName).toBe('SECTION');
    expect(strip).toHaveAttribute('aria-labelledby', 'autostrip-title');
    expect(screen.getByRole('heading', { name: 'Done automatically - last 7 days (2)' })).toBeInTheDocument();
    expect(within(strip).getAllByRole('listitem')).toHaveLength(2);
  });

  it('is not a list at page level and carries no approval button', () => {
    render(<AutoStrip rows={[row()]} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />);
    const strip = screen.getByTestId('autostrip');
    expect(strip).not.toHaveAttribute('role');
    expect(strip.querySelector('[data-primary-approve], .btn-primary')).toBeNull();
    expect(within(strip).getAllByRole('list')).toHaveLength(1); // the rows container only
  });
});

describe('AutoStrip - rows', () => {
  it('verb phrases: added / moved from {when} / place changed / cancelled, with a relative time', () => {
    const rows = [
      row({ kind: 'create' }),
      row({ kind: 'update', before: ev({ startLocal: '2026-09-30T15:00:00', endLocal: '2026-09-30T16:00:00' }) }),
      row({ kind: 'update', before: ev({ location: 'Old' }) }),
      row({ kind: 'update', before: null }),
      row({ kind: 'cancel', event: ev({ status: 'cancelled' }), before: ev() }),
    ];
    render(<AutoStrip rows={rows} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />);
    expect(screen.getByTestId(`autostrip-verb-${rows[0]!.autoWriteId}`)).toHaveTextContent(/^added · 12 min\. ago$/);
    expect(screen.getByTestId(`autostrip-verb-${rows[1]!.autoWriteId}`)).toHaveTextContent('moved from Wed 15:00');
    expect(screen.getByTestId(`autostrip-verb-${rows[2]!.autoWriteId}`)).toHaveTextContent('place changed');
    expect(screen.getByTestId(`autostrip-verb-${rows[3]!.autoWriteId}`)).toHaveTextContent('place changed');
    expect(screen.getByTestId(`autostrip-verb-${rows[4]!.autoWriteId}`)).toHaveTextContent('cancelled');
    expect(screen.getByTestId(`autostrip-title-${rows[4]!.autoWriteId}`)).toHaveClass('event-cancelled');
  });

  it('the title is untrusted: dir="auto", literal, never markup', () => {
    const hostile = '<img src=x onerror=alert(1)> [click](http://evil.example)';
    const r = row({ event: ev({ title: hostile }) });
    const { container } = render(
      <AutoStrip rows={[r]} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />,
    );
    const title = screen.getByTestId(`autostrip-title-${r.autoWriteId}`);
    expect(title).toHaveAttribute('dir', 'auto');
    expect(title).toHaveTextContent(hostile);
    expect(container.querySelector('img, a')).toBeNull();
  });

  it('Undo: one onUndo per click, never while the focus guard is armed', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const r = row();
    render(<AutoStrip rows={[r]} policyState={policy('on')} onUndo={onUndo} onShow={noop} onPause={noop} />);
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId(`autostrip-undo-${r.autoWriteId}`));
    screen.getByTestId(`autostrip-undo-${r.autoWriteId}`).focus();
    await user.keyboard('{Enter}');
    expect(onUndo).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    await user.dblClick(screen.getByTestId(`autostrip-undo-${r.autoWriteId}`));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledWith(r.autoWriteId);
  });

  it('Show opens the item', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onShow = vi.fn();
    const r = row();
    render(<AutoStrip rows={[r]} policyState={policy('on')} onUndo={noop} onShow={onShow} onPause={noop} />);
    await user.click(screen.getByTestId(`autostrip-show-${r.autoWriteId}`));
    expect(onShow).toHaveBeenCalledWith(r.itemId);
  });

  // ux-i18n-v2-10: UX2 3.4 - "After two automatic edits of one event the card and the AutoStrip row also show Restore
  // original"; the strip never offered it.
  it('after two automatic edits of one event its newest row offers a guarded "Restore original" (item:restoreOriginal)', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const first = row({ itemId: 90, kind: 'update', writtenAt: NOW - 3 * 3_600_000, undoState: 'blocked_changed' });
    const second = row({ itemId: 90, kind: 'update', writtenAt: NOW - 3_600_000 });
    const other = row({ itemId: 91, kind: 'update' });
    render(
      <AutoStrip rows={[first, second, other]} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />,
    );
    expect(screen.queryByTestId(`autostrip-restore-${first.autoWriteId}`)).toBeNull();
    expect(screen.queryByTestId(`autostrip-restore-${other.autoWriteId}`)).toBeNull();
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId(`autostrip-restore-${second.autoWriteId}`));
    expect(invokeMocks['item:restoreOriginal']).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    await user.click(screen.getByTestId(`autostrip-restore-${second.autoWriteId}`));
    await waitFor(() => expect(invokeMocks['item:restoreOriginal']).toHaveBeenCalledExactlyOnceWith({ itemId: 90 }));
  });

  it('one automatic edit (or an undone newest write) offers no "Restore original"', () => {
    const single = row({ itemId: 92, kind: 'update' });
    const a = row({ itemId: 93, kind: 'update', writtenAt: NOW - 3_600_000 });
    const undone = row({ itemId: 93, kind: 'update', undoState: 'undone' });
    render(
      <AutoStrip rows={[single, a, undone]} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />,
    );
    expect(screen.queryByTestId(/autostrip-restore-/)).toBeNull();
  });

  it('every undo_state has its own trailing actions', () => {
    const rows = [
      row({ undoState: 'available' }),
      row({ undoState: 'undone' }),
      row({ undoState: 'expired' }),
      row({ undoState: 'blocked_changed' }),
      row({ undoState: 'blocked_started' }),
    ];
    render(<AutoStrip rows={rows} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />);
    const state = (r: AutoWriteView): HTMLElement => screen.getByTestId(`autostrip-state-${r.autoWriteId}`);
    expect(state(rows[0]!)).toHaveAttribute('data-state', 'available');
    expect(within(state(rows[1]!)).getByText('Undone')).toHaveClass('chip-ok');
    expect(within(state(rows[2]!)).getByText('Undo no longer available')).toBeInTheDocument();
    expect(within(state(rows[3]!)).getByText('You changed this in Google after it was added')).toHaveClass(
      'note-amber',
    );
    expect(within(state(rows[4]!)).getByText('It has already started')).toHaveClass('note-amber');
    // Show is on every row
    for (const r of rows) expect(screen.getByTestId(`autostrip-show-${r.autoWriteId}`)).toBeInTheDocument();
  });

  it('failed from main: red line + Try again', () => {
    const f = row({ undoState: 'failed' });
    render(<AutoStrip rows={[f]} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />);
    const st = screen.getByTestId(`autostrip-state-${f.autoWriteId}`);
    expect(within(st).getByText('Could not undo')).toHaveClass('text-danger');
    expect(within(st).getByTestId(`autostrip-undo-${f.autoWriteId}`)).toHaveTextContent('Try again');
  });

  it('in flight: "Undoing..." and both buttons disabled; a failed click offers Try again', () => {
    const a = row();
    const b = row();
    useAutoStore.setState({ undoing: new Set([a.autoWriteId]), failed: new Set([b.autoWriteId]) });
    render(<AutoStrip rows={[a, b]} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />);
    const sa = screen.getByTestId(`autostrip-state-${a.autoWriteId}`);
    expect(sa).toHaveAttribute('data-state', 'undoing');
    expect(within(sa).getByText('Undoing...')).toBeInTheDocument();
    for (const button of within(sa).getAllByRole('button')) expect(button).toBeDisabled();
    expect(screen.getByTestId(`autostrip-state-${b.autoWriteId}`)).toHaveAttribute('data-state', 'failed');
  });
});

describe('AutoStrip - header', () => {
  it('Pause only while the policy is on; no guard (fail-safe direction)', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onPause = vi.fn();
    const { rerender } = render(
      <AutoStrip rows={[row()]} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={onPause} />,
    );
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId('autostrip-pause'));
    expect(onPause).toHaveBeenCalledTimes(1);
    for (const s of ['shadow', 'paused', 'disabled', 'expired'] as const) {
      rerender(<AutoStrip rows={[row()]} policyState={policy(s)} onUndo={noop} onShow={noop} onPause={onPause} />);
      expect(screen.queryByTestId('autostrip-pause')).toBeNull();
    }
  });

  it('disclosure: open by default while something can be undone, collapsed otherwise; aria-expanded follows', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { unmount } = render(
      <AutoStrip rows={[row()]} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />,
    );
    const toggle = screen.getByTestId('autostrip-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Hide');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listitem')).toBeNull();
    unmount();
    render(
      <AutoStrip
        rows={[row({ undoState: 'undone', writtenAt: Date.now() - 60_000 })]}
        policyState={policy('on')}
        onUndo={noop}
        onShow={noop}
        onPause={noop}
      />,
    );
    expect(screen.getByTestId('autostrip-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('autostrip-toggle')).toHaveTextContent('Show');
  });

  it(`at most ${STRIP_MAX_ROWS} rows; "Show all in Automatic activity" asks the shell for the activity page`, async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const rows = Array.from({ length: STRIP_MAX_ROWS + 2 }, () => row({ writtenAt: Date.now() - 60_000 }));
    render(<AutoStrip rows={rows} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(STRIP_MAX_ROWS);
    await user.click(screen.getByTestId('autostrip-more'));
    expect(useDashboardStore.getState().navRequest).toEqual({ view: 'activity' });
  });
});

describe('AutoStrip - RTL snapshots', () => {
  const rows = (): AutoWriteView[] => [
    row({ kind: 'update', before: ev({ startLocal: '2026-09-30T15:00:00', endLocal: '2026-09-30T16:00:00' }) }),
    row({
      kind: 'create',
      event: ev({ title: 'Coffee', startLocal: '2026-10-05T09:00:00', endLocal: '2026-10-05T09:30:00' }),
      writtenAt: NOW - 3_600_000,
    }),
    row({
      kind: 'cancel',
      event: ev({ title: 'Book club', status: 'cancelled' }),
      undoState: 'undone',
      writtenAt: NOW - 20 * 3_600_000,
    }),
  ];
  it('he', async () => {
    await i18next.changeLanguage('he');
    document.documentElement.dir = 'rtl';
    const { container } = render(
      <AutoStrip rows={rows()} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />,
    );
    expect(screen.getByRole('heading')).toHaveTextContent('(3)');
    expect(container.firstChild).toMatchSnapshot();
  });
  it('en', () => {
    const { container } = render(
      <AutoStrip rows={rows()} policyState={policy('on')} onUndo={noop} onShow={noop} onPause={noop} />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
