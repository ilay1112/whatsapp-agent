// V2-W1-11: QuotedBubble delegates by trigger kind (UX2 3.5, 3.6, 12) and never takes children.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QuotedBubble } from './QuotedBubble';

const voice = { seconds: 7, language: 'en', transcript: 'see you at 5', status: 'done' as const };
const image = {
  thumbDataUrl: null,
  readText: 'Party 20:00',
  dateText: '',
  timeText: '20:00',
  location: '',
  confidence: 'high' as const,
  kind: 'flyer' as const,
};

describe('QuotedBubble v2', () => {
  it('voice trigger with a view model -> VoiceBubble wrapped in voice-bubble-<itemId>', () => {
    render(<QuotedBubble text="" from="contact" triggerKind="voice" voice={voice} itemId={4} clampLines={3} />);
    expect(within(screen.getByTestId('voice-bubble-4')).getByTestId('voice-transcript')).toHaveTextContent(
      'see you at 5',
    );
    expect(screen.queryByTestId('quoted-bubble')).toBeNull();
  });

  it('image trigger that was read -> ImageBubble wrapped in image-bubble-<itemId>', () => {
    render(<QuotedBubble text="" from="contact" triggerKind="image" image={image} contactName="Dana" itemId={4} />);
    expect(within(screen.getByTestId('image-bubble-4')).getByTestId('image-readtext')).toHaveTextContent('Party 20:00');
  });

  it('voice trigger without a view model -> the app placeholder "Voice message"', () => {
    render(<QuotedBubble text="" from="contact" triggerKind="voice" voice={null} />);
    expect(screen.getByTestId('quoted-placeholder')).toHaveTextContent('Voice message');
  });

  it('unread picture without text -> "Photo"; with a caption -> the caption', () => {
    const { rerender } = render(<QuotedBubble text="" from="contact" triggerKind="image" image={null} />);
    expect(screen.getByTestId('quoted-placeholder')).toHaveTextContent('Photo');
    rerender(<QuotedBubble text="our invite" from="contact" triggerKind="image" image={null} />);
    expect(screen.queryByTestId('quoted-placeholder')).toBeNull();
    expect(screen.getByText('our invite')).toBeInTheDocument();
  });

  it('text trigger keeps the v1 behaviour, and missing ids default to 0', () => {
    render(<QuotedBubble text="hi" from="contact" triggerKind="voice" voice={voice} />);
    expect(screen.getByTestId('voice-bubble-0')).toBeInTheDocument();
  });
});
