// AutomaticMode - Settings > Automatic mode (UX2 4.5, 11.5, 13, 15 items 1/2/8; B7, I10; owner V2-W1-12).
// The rules under test are structural: the ONLY way on is `auto:requestEnable` from the two enable buttons' click
// handlers (never `settings:set`, never an effect), both are focus-steal guarded, Pause/Stop are one unguarded click, and
// the scope is read-only while a policy is live.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutoState } from '@shared/types';
import { DEFAULT_AUTO_SCOPE } from '@shared/schemas';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { i18next, invokeMocks, listRepoFiles, mockInvoke, readRepoFile } from '../../../../../tests/setup-renderer';
import { useAutoStore } from '../../store/auto';
import { useFocusGuardStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { AutomaticMode, daysLeft, firstPrecondition, isLive } from './AutomaticMode';

const DAY = 86_400_000;
const NOW = Date.now();
const base: AutoState = {
  policy: null,
  preconditions: {
    calendarConnected: true,
    calendarOwned: true,
    approvedCreates: 3,
    approvedCreatesNeeded: 3,
    providerAllowsAuto: true,
    updatesAvailable: true,
  },
  shadowTally: null,
  usedToday: { writes: 0, limit: 15 },
  undoableCount: 0,
};
const policy = (
  state: NonNullable<AutoState['policy']>['state'],
  patch: Partial<NonNullable<AutoState['policy']>> = {},
) => ({
  id: 'p1',
  state,
  enabledAt: NOW - DAY,
  expiresAt: NOW + 23 * DAY,
  shadowUntil: NOW + 12 * 3_600_000,
  pausedReason: null,
  scope: { ...DEFAULT_AUTO_SCOPE, cancels: true },
  ...patch,
});
const withPolicy = (p: AutoState['policy'], patch: Partial<AutoState> = {}): AutoState => ({
  ...base,
  policy: p,
  ...patch,
});

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, calendars: [], calendarsLoaded: false });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useAutoStore.setState({ state: null });
});

describe('AutomaticMode - pure helpers', () => {
  it('firstPrecondition follows the UX2 4.5 priority order', () => {
    expect(firstPrecondition(base, false)).toBeNull();
    const pre = (p: Partial<AutoState['preconditions']>) => ({
      ...base,
      preconditions: { ...base.preconditions, ...p },
    });
    expect(firstPrecondition(pre({ calendarConnected: false, calendarOwned: false }), true)).toBe('connect');
    expect(firstPrecondition(pre({ updatesAvailable: false, calendarOwned: false }), false)).toBe('updates');
    expect(firstPrecondition(pre({ calendarOwned: false, approvedCreates: 0 }), false)).toBe('notOwned');
    expect(firstPrecondition(pre({ approvedCreates: 1 }), false)).toBe('trackRecord');
    expect(firstPrecondition(base, true)).toBe('rate');
  });

  it('isLive and daysLeft', () => {
    expect(isLive(base)).toBe(false);
    for (const s of ['shadow', 'on', 'paused'] as const) expect(isLive(withPolicy(policy(s)))).toBe(true);
    for (const s of ['disabled', 'expired'] as const) expect(isLive(withPolicy(policy(s)))).toBe(false);
    expect(daysLeft(NOW + 23 * DAY - 1000, NOW)).toBe(23);
    expect(daysLeft(NOW - DAY, NOW)).toBe(0);
  });
});

describe('AutomaticMode - off, preconditions met', () => {
  it('renders the state card, the two columns, the scope toggles and two OUTLINE enable buttons (trial at the inline-end)', () => {
    render(<AutomaticMode state={base} />);
    expect(screen.getByTestId('settings-group-auto')).toBeInTheDocument();
    expect(screen.getByTestId('auto-state-card')).toHaveAttribute('data-state', 'none');
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('Off - events wait for your approval.');
    expect(within(screen.getByTestId('auto-happens')).getAllByRole('listitem')).toHaveLength(6);
    expect(within(screen.getByTestId('auto-never')).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByTestId('auto-happens')).toHaveTextContent('ends by itself after 30 days');
    for (const id of ['auto-scope-edits', 'auto-scope-cancels', 'auto-scope-quiet', 'auto-scope-validity']) {
      expect(screen.getByTestId(id)).toBeEnabled();
    }
    const trial = screen.getByTestId('auto-enable-trial');
    const now = screen.getByTestId('auto-enable-now');
    for (const b of [trial, now]) {
      expect(b.className).toContain('btn-outline');
      expect(b.className).not.toContain('btn-primary');
    }
    // "Start a 24-hour trial" is listed first at the inline-end: it comes AFTER "Turn on now" in DOM order.
    expect(now.compareDocumentPosition(trial) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('auto-scope-locked')).not.toBeInTheDocument();
  });

  it('"Start a 24-hour trial" sends exactly one auto:requestEnable with the edited scope - never settings:set', async () => {
    mockInvoke('auto:requestEnable', () => ({ ok: true, value: withPolicy(policy('shadow')) }));
    render(<AutomaticMode state={base} />);
    await userEvent.click(screen.getByTestId('auto-scope-cancels'));
    await userEvent.click(screen.getByTestId('auto-scope-quiet'));
    await userEvent.selectOptions(screen.getByTestId('auto-scope-validity'), '90');
    await userEvent.click(screen.getByTestId('auto-enable-trial'));
    await waitFor(() => expect(invokeMocks['auto:requestEnable']).toHaveBeenCalledOnce());
    expect(invokeMocks['auto:requestEnable']).toHaveBeenCalledWith({
      scope: { ...DEFAULT_AUTO_SCOPE, cancels: true, quietHours: null, validityDays: 90 },
      trial: true,
    });
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
    await waitFor(() => expect(useAutoStore.getState().state?.policy?.state).toBe('shadow'));
  });

  it('"Turn on now" asks with trial:false and shows the waiting line while main\'s dialog is up', async () => {
    let answer: (v: unknown) => void = () => {};
    mockInvoke('auto:requestEnable', () => new Promise((r) => (answer = r as (v: unknown) => void)) as never);
    render(<AutomaticMode state={base} />);
    await userEvent.click(screen.getByTestId('auto-enable-now'));
    expect(await screen.findByTestId('auto-waiting-dialog')).toHaveTextContent(
      'Waiting for your answer in the Windows dialog',
    );
    expect(screen.getByTestId('auto-enable-now')).toBeDisabled();
    expect(invokeMocks['auto:requestEnable']).toHaveBeenCalledWith({ scope: DEFAULT_AUTO_SCOPE, trial: false });
    answer({ ok: false, error: { code: 'AUTO_NOT_CONFIRMED' } });
    await waitFor(() => expect(screen.queryByTestId('auto-waiting-dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('auto-error')).toHaveAttribute('data-code', 'AUTO_NOT_CONFIRMED');
    expect(screen.getByTestId('auto-error')).toHaveTextContent('Automatic mode was not turned on');
  });

  it('the enable buttons ignore activation inside the 500 ms focus-steal window and a double click', async () => {
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    render(<AutomaticMode state={base} />);
    await userEvent.click(screen.getByTestId('auto-enable-trial'));
    await userEvent.click(screen.getByTestId('auto-enable-now'));
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    fireEvent.click(screen.getByTestId('auto-enable-trial'), { detail: 2 });
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
  });

  it('a 4th request inside the hour (BAD_REQUEST) turns into "Try again in an hour."', async () => {
    mockInvoke('auto:requestEnable', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    render(<AutomaticMode state={base} />);
    await userEvent.click(screen.getByTestId('auto-enable-now'));
    await waitFor(() => expect(screen.getByTestId('auto-precondition')).toHaveAttribute('data-reason', 'rate'));
    expect(screen.getByTestId('auto-precondition')).toHaveTextContent('Try again in an hour.');
    expect(screen.queryByTestId('auto-enable-now')).not.toBeInTheDocument();
  });

  it('never enables from mount, a re-render or a push event', () => {
    const { rerender } = render(<AutomaticMode state={base} />);
    rerender(<AutomaticMode state={{ ...base, undoableCount: 1 }} />);
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
    expect(invokeMocks['auto:endShadow']).not.toHaveBeenCalled();
    expect(invokeMocks['auto:resume']).not.toHaveBeenCalled();
  });
});

describe('AutomaticMode - preconditions replace the buttons with one sentence', () => {
  it.each([
    [{ calendarConnected: false }, 'connect', 'Connect Google Calendar first.'],
    [{ updatesAvailable: false }, 'updates', 'Changes to events are unavailable'],
    [{ calendarOwned: false }, 'notOwned', 'Only for a calendar you own'],
    [{ approvedCreates: 1 }, 'trackRecord', '(1 of 3 so far)'],
  ] as const)('%o -> %s', (pre, reason, text) => {
    render(<AutomaticMode state={{ ...base, preconditions: { ...base.preconditions, ...pre } }} />);
    expect(screen.getByTestId('auto-precondition')).toHaveAttribute('data-reason', reason);
    expect(screen.getByTestId('auto-precondition')).toHaveTextContent(text);
    expect(screen.queryByTestId('auto-enable-trial')).not.toBeInTheDocument();
    expect(screen.queryByTestId('auto-enable-now')).not.toBeInTheDocument();
  });

  it('"Connect" scrolls to the Google Calendar group; the calendar name is isolated', async () => {
    const spy = vi.fn();
    const target = document.createElement('section');
    target.id = 'settings-group-calendar';
    target.scrollIntoView = spy;
    document.body.appendChild(target);
    render(<AutomaticMode state={{ ...base, preconditions: { ...base.preconditions, calendarConnected: false } }} />);
    await userEvent.click(screen.getByTestId('auto-precondition-connect'));
    expect(spy).toHaveBeenCalled();
    target.remove();
  });

  it('with antigravity_cli active the buttons stay enabled and a warning says nothing will happen', () => {
    render(<AutomaticMode state={{ ...base, preconditions: { ...base.preconditions, providerAllowsAuto: false } }} />);
    expect(screen.getByTestId('auto-provider-warning')).toHaveTextContent('nothing will happen automatically');
    expect(screen.getByTestId('auto-enable-trial')).toBeEnabled();
  });

  it('names the target calendar from the cached list (untrusted, inside <bdi>)', async () => {
    useSettingsStore.setState({
      calendars: [
        {
          id: 'primary',
          name: 'Family',
          primary: true,
          timeZone: 'Asia/Jerusalem',
          writable: true,
          accessRole: 'reader',
        },
      ],
      calendarsLoaded: true,
    });
    render(<AutomaticMode state={{ ...base, preconditions: { ...base.preconditions, calendarOwned: false } }} />);
    const bdi = screen.getByTestId('auto-precondition').querySelector('bdi');
    expect(bdi).toHaveTextContent('Family');
  });
});

describe('AutomaticMode - live states', () => {
  it('shadow < 3 decisions: trial line + Stop only; the scope is read-only', async () => {
    mockInvoke('auto:disable', () => ({ ok: true, value: withPolicy(policy('disabled')) }));
    render(
      <AutomaticMode
        state={withPolicy(policy('shadow'), {
          shadowTally: { decisions: 1, wouldAuto: 1, approvedUnchanged: 0, edited: 0, dismissed: 0 },
        })}
      />,
    );
    expect(screen.getByTestId('auto-state-card')).toHaveAttribute('data-state', 'shadow');
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('1 of 3 decisions seen');
    expect(screen.queryByTestId('auto-end-shadow')).not.toBeInTheDocument();
    for (const id of ['auto-scope-edits', 'auto-scope-cancels', 'auto-scope-quiet', 'auto-scope-validity'])
      expect(screen.getByTestId(id)).toBeDisabled();
    expect(screen.getByTestId('auto-scope-locked')).toBeInTheDocument();
    // the live policy's own scope is shown, not the draft
    expect(screen.getByTestId('auto-scope-cancels')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('auto-enable-trial')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('auto-stop'));
    await waitFor(() => expect(invokeMocks['auto:disable']).toHaveBeenCalledExactlyOnceWith({ reason: 'user' }));
  });

  it('shadow >= 3: "Turn on for real" is guarded and sends auto:endShadow {confirm:true}', async () => {
    const state = withPolicy(policy('shadow'), {
      shadowTally: { decisions: 4, wouldAuto: 3, approvedUnchanged: 2, edited: 1, dismissed: 0 },
    });
    render(<AutomaticMode state={state} />);
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('3 would have been done automatically');
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('You approved 2 of them unchanged');
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await userEvent.click(screen.getByTestId('auto-end-shadow'));
    expect(invokeMocks['auto:endShadow']).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    await userEvent.click(screen.getByTestId('auto-end-shadow'));
    await waitFor(() => expect(invokeMocks['auto:endShadow']).toHaveBeenCalledExactlyOnceWith({ confirm: true }));
  });

  it('on: used / limit / days, Pause and Stop are one click even inside the focus-steal window', async () => {
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    render(<AutomaticMode state={withPolicy(policy('on'), { usedToday: { writes: 4, limit: 15 } })} />);
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('On - 4 of 15 today · ends in 23 days.');
    await userEvent.click(screen.getByTestId('auto-pause'));
    await waitFor(() => expect(invokeMocks['auto:pause']).toHaveBeenCalledExactlyOnceWith({ reason: 'user' }));
    await userEvent.click(screen.getByTestId('auto-stop'));
    await waitFor(() => expect(invokeMocks['auto:disable']).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('auto-expiring')).not.toBeInTheDocument();
  });

  it('on, ending within 7 days: the "ends in" line is repeated under the card', () => {
    render(<AutomaticMode state={withPolicy(policy('on', { expiresAt: NOW + 2 * DAY }))} />);
    expect(screen.getByTestId('auto-expiring')).toHaveTextContent('2');
  });

  it('paused: the reason in words; Resume is guarded and sends auto:resume {confirm:true}', async () => {
    render(<AutomaticMode state={withPolicy(policy('paused', { pausedReason: 'circuit_breaker_undo' }))} />);
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('Paused - you undid two changes today');
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await userEvent.click(screen.getByTestId('auto-resume'));
    expect(invokeMocks['auto:resume']).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    await userEvent.click(screen.getByTestId('auto-resume'));
    await waitFor(() => expect(invokeMocks['auto:resume']).toHaveBeenCalledExactlyOnceWith({ confirm: true }));
  });

  it('a failed state change shows the ErrorCode line', async () => {
    mockInvoke('auto:resume', () => ({ ok: false, error: { code: 'AUTO_CALENDAR_NOT_OWNED' } }));
    render(<AutomaticMode state={withPolicy(policy('paused', { pausedReason: 'user' }))} />);
    await userEvent.click(screen.getByTestId('auto-resume'));
    await waitFor(() =>
      expect(screen.getByTestId('auto-error')).toHaveAttribute('data-code', 'AUTO_CALENDAR_NOT_OWNED'),
    );
  });

  it('expired: "Ended on" + Renew (a fresh dialog through auto:requestEnable)', async () => {
    render(<AutomaticMode state={withPolicy(policy('expired', { expiresAt: NOW - DAY }))} />);
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('Ended on');
    expect(screen.getByTestId('auto-state-card').querySelector('bdi')).not.toBeNull();
    await userEvent.click(screen.getByTestId('auto-renew'));
    await waitFor(() => expect(invokeMocks['auto:requestEnable']).toHaveBeenCalledOnce());
  });

  // ux-i18n-v2-3: an expired policy with an unmet precondition hid both Renew and the reason - a dead end.
  it('expired with an unmet precondition: no Renew, but the reason line is shown (never a bare "Ended on")', () => {
    const state = withPolicy(policy('expired', { expiresAt: NOW - DAY }), {
      preconditions: { ...base.preconditions, calendarConnected: false },
    });
    render(<AutomaticMode state={state} />);
    expect(screen.queryByTestId('auto-renew')).toBeNull();
    expect(screen.getByTestId('auto-precondition')).toHaveAttribute('data-reason', 'connect');
    // the enable buttons stay the state card's Renew - they are not shown a second time below
    expect(screen.queryByTestId('auto-enable-now')).toBeNull();
  });

  it('expired with every precondition met: Renew only, no second pair of enable buttons', () => {
    render(<AutomaticMode state={withPolicy(policy('expired', { expiresAt: NOW - DAY }))} />);
    expect(screen.getByTestId('auto-renew')).toBeInTheDocument();
    expect(screen.queryByTestId('auto-precondition')).toBeNull();
    expect(screen.queryByTestId('auto-enable-now')).toBeNull();
  });

  // ux-i18n-v2-2: BAD_REQUEST is not only the rate limit, and it must never be swallowed.
  it('with antigravity_cli active, a refused enable says why - never "Try again in an hour."', async () => {
    mockInvoke('auto:requestEnable', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    render(<AutomaticMode state={{ ...base, preconditions: { ...base.preconditions, providerAllowsAuto: false } }} />);
    await userEvent.click(screen.getByTestId('auto-enable-now'));
    await waitFor(() => expect(screen.getByTestId('auto-refused')).toHaveAttribute('data-reason', 'provider'));
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('auto-refused'));
    expect(screen.queryByText('Try again in an hour.')).toBeNull();
    // the buttons stay (UX2 4.5) - after choosing another AI the user can try again
    expect(screen.getByTestId('auto-enable-now')).toBeInTheDocument();
  });

  it.each([
    ['auto:resume', 'auto-resume', policy('paused', { pausedReason: 'snapshot_changed' })],
    ['auto:endShadow', 'auto-end-shadow', policy('shadow')],
  ] as const)('a refused %s (BAD_REQUEST) tells the user to Stop and turn it on again', async (channel, testId, p) => {
    mockInvoke(channel, () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    const tally = { decisions: 3, wouldAuto: 1, approvedUnchanged: 1, edited: 0, dismissed: 0 };
    render(<AutomaticMode state={withPolicy(p, { shadowTally: tally })} />);
    await userEvent.click(screen.getByTestId(testId));
    await waitFor(() => expect(invokeMocks[channel]).toHaveBeenCalledOnce());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'auto-refused');
    expect(alert).toHaveAttribute('data-reason', 'restart');
    expect(screen.getByTestId('auto-stop')).toBeInTheDocument();
  });

  it('disabled reads as off', () => {
    render(<AutomaticMode state={withPolicy(policy('disabled'))} />);
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('Off - events wait');
    expect(screen.getByTestId('auto-enable-trial')).toBeInTheDocument();
  });

  it('"See automatic activity" calls the navigation callback', async () => {
    const onOpen = vi.fn();
    const { rerender } = render(<AutomaticMode state={base} />);
    expect(screen.queryByTestId('auto-open-activity')).not.toBeInTheDocument();
    rerender(<AutomaticMode state={base} onOpenActivity={onOpen} />);
    await userEvent.click(screen.getByTestId('auto-open-activity'));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('AutomaticMode - the renderer never flips automatic mode (UX2 15.2)', () => {
  it('no settings:set payload in the renderer contains an `auto` key, and auto:requestEnable has exactly one caller', () => {
    const files = listRepoFiles('src/renderer/src', ['.ts', '.tsx']).filter((f) => !/\.test\.tsx?$/.test(f));
    const offenders: string[] = [];
    const enableCallers: string[] = [];
    for (const f of files) {
      const text = readRepoFile(f);
      if (/(?:setSettings|\bset)\(\s*\{\s*auto\b/.test(text) || /settings:set['"][^)]*\bauto\s*:/.test(text))
        offenders.push(f);
      if (/\brequestAutoEnable\(/.test(text) && !f.endsWith('/api.ts')) enableCallers.push(f);
      // only the one api.ts wrapper talks to the channel
      if (!f.endsWith('/api.ts')) expect(text, f).not.toMatch(/['"]auto:requestEnable['"]/);
    }
    expect(offenders).toEqual([]);
    expect(enableCallers).toEqual(['src/renderer/src/views/settings/AutomaticMode.tsx']);
  });
});

describe('AutomaticMode - RTL', () => {
  it('RTL snapshot (off) and (on)', async () => {
    await i18next.changeLanguage('he');
    const { container, rerender } = render(<AutomaticMode state={base} />);
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('כבוי');
    expect(container.firstChild).toMatchSnapshot();
    rerender(
      <AutomaticMode
        state={withPolicy(policy('on', { expiresAt: NOW + 2 * DAY }), { usedToday: { writes: 1, limit: 15 } })}
      />,
    );
    expect(screen.getByTestId('auto-state-card')).toHaveTextContent('יומיים');
  });
});
