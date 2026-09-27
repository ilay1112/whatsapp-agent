// UX 6.5 item 2 / 7.1 / 16.5: the bubble is the ONLY place untrusted message text is allowed, and it renders that text
// as an inert text node - no links, no markdown, no HTML, no children prop.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuotedBubble } from './QuotedBubble';

describe('QuotedBubble - inert text', () => {
  it('renders text as a text node with dir="auto"', () => {
    render(<QuotedBubble text="coffee Thursday at 5?" from="contact" />);
    const p = screen.getByTestId('quoted-bubble').querySelector('.msg-text')!;
    expect(p).toHaveTextContent('coffee Thursday at 5?');
    expect(p).toHaveAttribute('dir', 'auto');
  });

  it('renders HTML and markdown literally, producing no elements', () => {
    const { container } = render(
      <QuotedBubble
        text={'<img src=x onerror=alert(1)> <b>x</b> [a](https://evil.example) https://evil.example'}
        from="contact"
      />,
    );
    expect(container.querySelectorAll('img, b, a, script')).toHaveLength(0);
    expect(screen.getByTestId('quoted-bubble')).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('carries the chat language so a screen reader switches voice', () => {
    render(<QuotedBubble text="שלום" from="contact" lang="he" />);
    expect(screen.getByTestId('quoted-bubble').querySelector('.msg-text')).toHaveAttribute('lang', 'he');
  });

  it("prefixes the user's own messages for screen readers and aligns them to the inline end", () => {
    render(<QuotedBubble text="are you around?" from="me" />);
    const bubble = screen.getByTestId('quoted-bubble');
    expect(bubble).toHaveAttribute('data-from', 'me');
    expect(bubble.querySelector('.sr-only')).toHaveTextContent('You:');
  });

  it('marks the trigger message with an accent edge', () => {
    render(<QuotedBubble text="x" from="contact" isTrigger />);
    expect(screen.getByTestId('quoted-bubble')).toHaveAttribute('data-trigger', 'true');
    expect(screen.getByTestId('quoted-bubble').className).toContain('border-s-2');
  });

  it('clamps to the requested number of lines with logical CSS only', () => {
    render(<QuotedBubble text="long" from="contact" clampLines={3} />);
    const p = screen.getByTestId('quoted-bubble').querySelector<HTMLElement>('.msg-text')!;
    expect(p.style.getPropertyValue('-webkit-line-clamp')).toBe('3');
  });
});

describe('QuotedBubble - app-authored placeholders', () => {
  it('says the text was removed by retention when it is null', () => {
    render(<QuotedBubble text={null} from="contact" />);
    expect(screen.getByTestId('quoted-placeholder')).toHaveTextContent('removed after 30 days');
  });

  it('names the media kind instead of showing media', () => {
    render(<QuotedBubble text="" from="contact" mediaKind="voice" />);
    expect(screen.getByTestId('quoted-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('quoted-bubble').querySelector('audio, video, img')).toBeNull();
  });

  it('shows the optional time label with tabular numerals', () => {
    render(<QuotedBubble text="x" from="contact" timeLabel="14:02" />);
    expect(screen.getByTestId('quoted-time')).toHaveTextContent('14:02');
  });
});
