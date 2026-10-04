// V2-W1-11: the v2 badge codes (UX2 1.2, 3.3.2, 3.6, 14.2; F28, F31). Text comes from locale keys only.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BADGES, type Badge } from '@shared/types';
import { Badges, toneOf } from './Badges';
import { i18next } from '../../../../tests/setup-renderer';

describe('Badges v2', () => {
  it('every badge code has a short label and a tone', () => {
    render(
      <>
        <Badges codes={[...BADGES]} scope="card" />
        <Badges codes={[...BADGES]} scope="event" />
        <Badges codes={[...BADGES]} scope="draft" />
      </>,
    );
    for (const code of BADGES) {
      expect(screen.getByTestId(`badge-${code}`)).toHaveTextContent(i18next.t(`label.badge.${code}`));
      expect(toneOf(code)).not.toBe('');
    }
  });

  it.each([
    ['change_unclear', 'bg-warn-soft', 'Not sure this changes the event - the draft asks'],
    [
      'change_target_unclear',
      'bg-warn-soft',
      'Which event? This chat has more than one - the change would apply to the latest',
    ],
    ['image_unclear', 'bg-warn-soft', 'Hard to read - check the picture'],
    ['from_image', 'chip-info', 'Read from a picture'],
    ['image_unread', 'chip-info', 'The picture was not read'],
  ] as const)('%s: card scope, %s tone, long sentence as its title', (code, tone, long) => {
    render(<Badges codes={[code]} scope="card" />);
    const chip = screen.getByTestId(`badge-${code}`);
    expect(chip).toHaveClass(tone);
    expect(chip).toHaveAttribute('title', long);
  });

  it('automatic / auto_shadow live with the event; auto_shadow is the dashed outline', () => {
    render(<Badges codes={['automatic', 'auto_shadow']} scope="event" />);
    expect(screen.getByTestId('badge-automatic')).toHaveClass('chip-info');
    expect(screen.getByTestId('badge-auto_shadow')).toHaveClass('chip-shadow');
    expect(screen.getByTestId('badge-auto_shadow')).toHaveAttribute('title', 'Would have been automatic');
  });

  it('image_unclear is a button (like time_assumed); from_image is not', async () => {
    const user = userEvent.setup();
    const onBadgeAction = vi.fn<(code: Badge) => void>();
    render(<Badges codes={['image_unclear', 'from_image']} scope="card" onBadgeAction={onBadgeAction} />);
    await user.click(screen.getByTestId('badge-image_unclear'));
    expect(onBadgeAction).toHaveBeenCalledWith('image_unclear');
    expect(screen.getByTestId('badge-from_image').tagName).toBe('SPAN');
  });

  it('the self-trigger line (F28) is app text on the card scope only', () => {
    const { rerender } = render(<Badges codes={[]} scope="card" selfTriggered />);
    expect(screen.getByTestId('badge-self-trigger')).toHaveTextContent('You changed this in the chat');
    rerender(<Badges codes={[]} scope="event" selfTriggered />);
    expect(screen.queryByTestId('badge-self-trigger')).toBeNull();
  });

  it('he labels', async () => {
    await i18next.changeLanguage('he');
    render(<Badges codes={['change_unclear', 'from_image']} scope="card" />);
    expect(screen.getByTestId('badge-change_unclear')).toHaveTextContent('שינוי לא ברור');
    expect(screen.getByTestId('badge-from_image')).toHaveTextContent('מתמונה');
  });
});

describe('Badges - adoptScopes (REQUEST 8)', () => {
  it('a card row adopting the draft scope shows manipulation; without it the code stays out', () => {
    const { rerender } = render(<Badges codes={['manipulation', 'older_message']} scope="card" />);
    expect(screen.queryByTestId('badge-manipulation')).toBeNull();
    rerender(<Badges codes={['manipulation', 'older_message']} scope="card" adoptScopes={['draft']} />);
    expect(screen.getByTestId('badge-manipulation')).toBeInTheDocument();
    expect(screen.getByTestId('badge-older_message')).toBeInTheDocument();
  });

  it('a row with only adopted codes is still drawn', () => {
    render(<Badges codes={['conflict']} scope="card" adoptScopes={['event']} />);
    expect(screen.getByTestId('badge-conflict')).toBeInTheDocument();
  });
});
