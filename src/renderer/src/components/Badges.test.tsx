// UX 6.6 / 14.2: chips are built from ENUM CODES only - the model never supplies badge text - and each chip belongs to
// exactly one scope (the date tab, the draft box or the card itself).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BADGES, type Badge } from '@shared/types';
import { Badges } from './Badges';

describe('Badges - scoping', () => {
  it('renders nothing when no code belongs to the scope', () => {
    const { container } = render(<Badges codes={['time_assumed']} scope="draft" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('puts event badges under the event scope and draft badges under the draft scope', () => {
    render(<Badges codes={['time_assumed', 'manipulation', 'older_message']} scope="event" />);
    expect(screen.getByTestId('badge-time_assumed')).toBeInTheDocument();
    expect(screen.queryByTestId('badge-manipulation')).toBeNull();
    expect(screen.queryByTestId('badge-older_message')).toBeNull();
  });

  it('assigns every known badge to exactly one scope', () => {
    for (const code of BADGES) {
      const scopes = (['event', 'draft', 'card'] as const).filter((scope) => {
        const { container, unmount } = render(<Badges codes={[code]} scope={scope} />);
        const hit = container.querySelector(`[data-testid="badge-${code}"]`) !== null;
        unmount();
        return hit;
      });
      expect(scopes, code).toHaveLength(1);
    }
  });
});

describe('Badges - text comes from locale keys only', () => {
  it('labels every badge from label.badge.<code>', () => {
    render(<Badges codes={['manipulation']} scope="draft" />);
    expect(screen.getByTestId('badge-manipulation').textContent?.trim()).not.toBe('');
    expect(screen.getByTestId('badge-manipulation').textContent).not.toContain('label.badge');
  });

  it('shows the hold reason and the error title as card chips', () => {
    render(<Badges codes={[]} holdReason="waiting_llm" errorCode="LLM_BAD_OUTPUT" scope="card" />);
    expect(screen.getByTestId('hold-waiting_llm')).toBeInTheDocument();
    expect(screen.getByTestId('error-LLM_BAD_OUTPUT')).toBeInTheDocument();
  });

  it('shows the hold reason only on the card scope', () => {
    const { container } = render(<Badges codes={[]} holdReason="waiting_llm" scope="draft" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Badges - interaction', () => {
  it('makes only time_assumed actionable, and only when a handler is given', async () => {
    const user = userEvent.setup();
    const onBadgeAction = vi.fn();
    render(<Badges codes={['time_assumed', 'conflict']} scope="event" onBadgeAction={onBadgeAction} />);
    expect(screen.getByTestId('badge-time_assumed').tagName).toBe('BUTTON');
    expect(screen.getByTestId('badge-conflict').tagName).toBe('SPAN');
    await user.click(screen.getByTestId('badge-time_assumed'));
    expect(onBadgeAction).toHaveBeenCalledWith('time_assumed');
  });

  it('is a plain chip without a handler', () => {
    render(<Badges codes={['time_assumed']} scope="event" />);
    expect(screen.getByTestId('badge-time_assumed').tagName).toBe('SPAN');
  });

  it('is a list of chips', () => {
    render(<Badges codes={['time_assumed', 'conflict'] as Badge[]} scope="event" />);
    expect(screen.getByTestId('badges').tagName).toBe('UL');
    expect(screen.getByTestId('badges').querySelectorAll('li')).toHaveLength(2);
  });
});
