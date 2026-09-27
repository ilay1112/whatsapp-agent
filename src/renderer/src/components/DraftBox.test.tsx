// UX 6.5 item 5, 6.6, 13.2, 13.5: the draft box owns the text that an approval will send, tells the card when it is
// being edited, and makes Ctrl+Enter a FOCUS move rather than a send.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LIMITS } from '@shared/types';
import { DraftBox } from './DraftBox';

const base = {
  value: '',
  suggestion: null,
  onChange: () => {},
  onEditingChange: () => {},
  label: 'draft' as const,
};

describe('DraftBox - the text the user owns', () => {
  it('reports every keystroke so the card can send the text at click time', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DraftBox {...base} onChange={onChange} />);
    await user.type(screen.getByTestId('draft-box'), 'hi');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith('i'); // controlled input: the parent owns the value
  });

  it('reports focus and blur so the card can take the edit lock', async () => {
    const user = userEvent.setup();
    const onEditingChange = vi.fn();
    render(<DraftBox {...base} onEditingChange={onEditingChange} />);
    await user.click(screen.getByTestId('draft-box'));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    await user.tab();
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it('caps the text at the contract limit', () => {
    render(<DraftBox {...base} />);
    expect(screen.getByTestId('draft-box')).toHaveAttribute('maxlength', String(LIMITS.draftChars));
  });

  it('carries dir="auto" so a Hebrew draft reads in its own direction inside an English UI', () => {
    render(<DraftBox {...base} value="שלום" />);
    expect(screen.getByTestId('draft-box')).toHaveAttribute('dir', 'auto');
  });
});

describe('DraftBox - the three voices (UX 6.5)', () => {
  it("uses a dashed edge for an AI draft and a solid one for the user's own reply", () => {
    const { rerender } = render(<DraftBox {...base} label="draft" />);
    expect(screen.getByTestId('draft-block').className).toContain('border-dashed');
    rerender(<DraftBox {...base} label="own" />);
    expect(screen.getByTestId('draft-block').className).toContain('border-solid');
    expect(screen.getByTestId('draft-block')).toHaveAttribute('data-label', 'own');
  });

  it('offers "Reset to suggestion" only once the text differs from the suggestion', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <DraftBox {...base} suggestion="Thursday works." value="Thursday works." onChange={onChange} />,
    );
    expect(screen.queryByTestId('draft-reset')).toBeNull();
    rerender(<DraftBox {...base} suggestion="Thursday works." value="Friday works." onChange={onChange} />);
    await user.click(screen.getByTestId('draft-reset'));
    expect(onChange).toHaveBeenCalledWith('Thursday works.');
  });
});

describe('DraftBox - counter (UX 13.5)', () => {
  it('appears only near the limit and is never announced', () => {
    const { rerender } = render(<DraftBox {...base} value={'x'.repeat(100)} />);
    expect(screen.queryByTestId('draft-counter')).toBeNull();
    rerender(<DraftBox {...base} value={'x'.repeat(520)} />);
    const counter = screen.getByTestId('draft-counter');
    expect(counter).toHaveTextContent(`520 / ${LIMITS.draftChars}`);
    expect(counter).toHaveAttribute('aria-live', 'off');
    expect(screen.getByTestId('draft-box').getAttribute('aria-describedby')).toContain(counter.id);
  });
});

describe('DraftBox - the manipulation collapse (UX 6.6)', () => {
  it('hides the draft until the user asks for it', async () => {
    const user = userEvent.setup();
    render(<DraftBox {...base} value="trust me" collapsedReason="manipulation" />);
    expect(screen.getByTestId('draft-collapsed')).toBeInTheDocument();
    expect(screen.queryByTestId('draft-box')).toBeNull();
    await user.click(screen.getByTestId('draft-show-anyway'));
    expect(screen.getByTestId('draft-box')).toHaveValue('trust me');
  });

  it('"Write my own" clears the suggested text and focuses the box', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <DraftBox {...base} value="trust me" collapsedReason="manipulation" onChange={onChange} />,
    );
    await user.click(screen.getByTestId('draft-write-own'));
    expect(onChange).toHaveBeenCalledWith('');
    rerender(<DraftBox {...base} value="" collapsedReason="manipulation" onChange={onChange} />);
    expect(document.activeElement).toBe(screen.getByTestId('draft-box'));
  });
});

describe('DraftBox - Ctrl+Enter (UX 13.2)', () => {
  it("moves focus to the card's primary approve button and sends nothing", async () => {
    const user = userEvent.setup();
    render(
      <div data-card-root>
        <DraftBox {...base} value="ready" />
        <button type="button" data-primary-approve="true" data-testid="primary">
          Approve &amp; send
        </button>
      </div>,
    );
    await user.click(screen.getByTestId('draft-box'));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(document.activeElement).toBe(screen.getByTestId('primary'));
  });

  it('does nothing when the card has no primary approval button', async () => {
    const user = userEvent.setup();
    render(
      <div data-card-root>
        <DraftBox {...base} value="ready" />
      </div>,
    );
    const box = screen.getByTestId('draft-box');
    await user.click(box);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(document.activeElement).toBe(box);
  });

  it('a plain Enter just types a newline', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DraftBox {...base} onChange={onChange} />);
    await user.click(screen.getByTestId('draft-box'));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('\n');
  });
});
