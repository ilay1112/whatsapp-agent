// SetupStrip rows 4-9 (UX2 2.3, 13; owner V2-W1-12). Still max two rows, most blocking first; rows 5-9 can be hidden.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18next } from '../../../../tests/setup-renderer';
import { SetupStrip, type SetupRowDetails } from './SetupStrip';

const details: SetupRowDetails = {
  consent_v2: { vendor: 'Anthropic' },
  auto_paused: { reason: 'you paused it' },
  auto_trial: { seen: 1, wouldAuto: 0, ready: false },
  auto_expiring: { days: 2 },
  voice_download: { percent: 43 },
  auto_expired: { date: '28 Sept 2026' },
};

describe('SetupStrip v2 rows', () => {
  it.each([
    ['consent_v2', 'Your approval is needed again for Anthropic', 'Review', null, false],
    ['auto_paused', 'Automatic mode is paused - you paused it.', 'Resume', 'Settings', true],
    ['auto_trial', '1 of 3 decisions seen so far', 'Review', null, true],
    ['auto_expiring', 'Automatic mode ends in 2 days.', 'Renew', null, true],
    ['voice_download', 'Voice notes: model downloading 43 %.', null, null, true],
    ['auto_expired', 'Automatic mode ended on', 'Renew', null, true],
  ] as const)('%s: text, actions and Hide', (task, text, primary, secondary, hideable) => {
    render(<SetupStrip tasks={[task]} details={details} onAction={() => {}} onHide={() => {}} />);
    expect(screen.getByTestId(`setup-strip-${task}`)).toHaveTextContent(text);
    if (primary) expect(screen.getByTestId(`setup-action-${task}`)).toHaveTextContent(primary);
    else expect(screen.queryByTestId(`setup-action-${task}`)).not.toBeInTheDocument();
    if (secondary) expect(screen.getByTestId(`setup-secondary-${task}`)).toHaveTextContent(secondary);
    else expect(screen.queryByTestId(`setup-secondary-${task}`)).not.toBeInTheDocument();
    expect(Boolean(screen.queryByTestId(`setup-hide-${task}`))).toBe(hideable);
  });

  it('the trial row with >= 3 decisions offers "Turn on for real" + "Stop" (secondary)', async () => {
    const onAction = vi.fn();
    render(
      <SetupStrip
        tasks={['auto_trial']}
        details={{ auto_trial: { seen: 4, wouldAuto: 3, ready: true } }}
        onAction={onAction}
        onHide={() => {}}
      />,
    );
    expect(screen.getByTestId('setup-strip-auto_trial')).toHaveTextContent('3 would have been done automatically');
    await userEvent.click(screen.getByTestId('setup-action-auto_trial'));
    await userEvent.click(screen.getByTestId('setup-secondary-auto_trial'));
    expect(onAction.mock.calls).toEqual([['auto_trial'], ['auto_trial', true]]);
  });

  it('keeps the priority order (consent before automatic mode before the voice download) and max two rows', async () => {
    const onHide = vi.fn();
    render(
      <SetupStrip
        tasks={['voice_download', 'auto_paused', 'consent_v2']}
        details={details}
        onAction={() => {}}
        onHide={onHide}
      />,
    );
    expect(screen.getByTestId('setup-strip-consent_v2')).toBeInTheDocument();
    expect(screen.getByTestId('setup-strip-auto_paused')).toBeInTheDocument();
    expect(screen.queryByTestId('setup-strip-voice_download')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('setup-hide-auto_paused'));
    expect(onHide).toHaveBeenCalledExactlyOnceWith('auto_paused');
  });

  it('works without details (defaults) and in Hebrew', async () => {
    await i18next.changeLanguage('he');
    render(<SetupStrip tasks={['auto_trial', 'auto_expired']} onAction={() => {}} onHide={() => {}} />);
    expect(screen.getByTestId('setup-strip-auto_trial')).toHaveTextContent('0 מתוך 3');
    expect(screen.getByTestId('setup-strip-auto_expired').querySelector('bdi')).not.toBeNull();
  });

  it('defaults for every detail-driven row', () => {
    render(<SetupStrip tasks={['consent_v2', 'auto_paused']} onAction={() => {}} onHide={() => {}} />);
    expect(screen.getByTestId('setup-strip-consent_v2')).toBeInTheDocument();
    const { unmount } = render(
      <SetupStrip tasks={['auto_expiring', 'voice_download']} onAction={() => {}} onHide={() => {}} />,
    );
    expect(screen.getByTestId('setup-strip-voice_download')).toHaveTextContent('0 %');
    unmount();
  });
});
