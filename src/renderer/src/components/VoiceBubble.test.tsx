// V2-W1-11: "the contact, as the app heard it" (UX2 1.1, 3.5, 11.6, 15.3; B18, B27; T2 5 "Renderer").
// The transcript is UNTRUSTED: one inert text node, dir="auto", no <a>, no markdown, a fixture `<img onerror>` stays text.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { VoiceView } from '@shared/types';
import { VoiceBubble, VOICE_MAX_SECONDS, voiceLangKey } from './VoiceBubble';
import { useSettingsStore } from '../store/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { i18next } from '../../../../tests/setup-renderer';

const voice = (patch: Partial<VoiceView> = {}): VoiceView => ({
  seconds: 42,
  language: 'en',
  transcript: "let's move it to 5, I'm busy until then",
  status: 'done',
  ...patch,
});

describe('VoiceBubble', () => {
  it('done: app header "Voice message · 0:42", language chip, dotted rule, transcript, caution line', () => {
    render(<VoiceBubble voice={voice()} />);
    const bubble = screen.getByTestId('voice-bubble');
    expect(bubble).toHaveTextContent('Voice message · 0:42');
    expect(bubble).toHaveClass('bg-quote'); // the contact surface, never app chrome or a draft
    expect(screen.getByTestId('voice-duration')).toHaveAttribute('aria-label', '0 minutes 42 seconds');
    expect(screen.getByTestId('voice-duration')).toHaveClass('tnum');
    expect(screen.getByTestId('voice-lang')).toHaveTextContent('English');
    expect(bubble.querySelector('.media-rule')).not.toBeNull();
    const text = screen.getByTestId('voice-transcript');
    expect(text).toHaveAttribute('dir', 'auto');
    expect(text).toHaveAttribute('lang', 'en');
    expect(screen.getByTestId('voice-caution')).toHaveTextContent(
      'Transcribed on this computer - may contain mistakes',
    );
  });

  it('the transcript is inert: HTML and markdown links stay literal, no <a>, no <img>', () => {
    const hostile = '<img src=x onerror=alert(1)> [pay here](https://evil.example) **bold**';
    const { container } = render(<VoiceBubble voice={voice({ transcript: hostile })} />);
    expect(screen.getByTestId('voice-transcript').textContent).toBe(hostile);
    expect(container.querySelector('a, img, strong, script')).toBeNull();
  });

  it('language chip: Hebrew / English / Other language; lang attribute only for he and en', () => {
    const { rerender } = render(<VoiceBubble voice={voice({ language: 'he' })} />);
    expect(screen.getByTestId('voice-lang')).toHaveTextContent('Hebrew');
    expect(screen.getByTestId('voice-transcript')).toHaveAttribute('lang', 'he');
    rerender(<VoiceBubble voice={voice({ language: 'ar' })} />);
    expect(screen.getByTestId('voice-lang')).toHaveTextContent('Other language');
    expect(screen.getByTestId('voice-transcript')).not.toHaveAttribute('lang');
    rerender(<VoiceBubble voice={voice({ language: null })} />);
    expect(screen.queryByTestId('voice-lang')).toBeNull();
    expect(voiceLangKey('')).toBeNull();
  });

  it('empty: "No speech detected", no dotted rule and no caution line', () => {
    const { container } = render(<VoiceBubble voice={voice({ status: 'empty', transcript: '' })} />);
    expect(screen.getByTestId('voice-muted')).toHaveTextContent('No speech detected');
    expect(container.querySelector('.media-rule')).toBeNull();
    expect(screen.queryByTestId('voice-caution')).toBeNull();
  });

  it('failed / aborted: "Not transcribed"', () => {
    const { rerender } = render(<VoiceBubble voice={voice({ status: 'failed', transcript: null })} />);
    expect(screen.getByTestId('voice-muted')).toHaveTextContent('Not transcribed');
    rerender(<VoiceBubble voice={voice({ status: 'aborted', transcript: null })} />);
    expect(screen.getByTestId('voice-muted')).toHaveTextContent('Not transcribed');
  });

  it('pending (model missing): header only', () => {
    render(<VoiceBubble voice={voice({ status: 'pending', transcript: null })} />);
    expect(screen.getByTestId('voice-bubble')).toHaveTextContent('Voice message · 0:42');
    expect(screen.queryByTestId('voice-transcript')).toBeNull();
    expect(screen.queryByTestId('voice-muted')).toBeNull();
  });

  it('too long: "Voice message · 17:05" + "Longer than 15 minutes - not transcribed"', () => {
    render(<VoiceBubble voice={voice({ seconds: 17 * 60 + 5, status: 'pending', transcript: null })} />);
    expect(screen.getByTestId('voice-bubble')).toHaveTextContent('Voice message · 17:05');
    expect(screen.getByTestId('voice-muted')).toHaveTextContent('Longer than 15 minutes - not transcribed');
    expect(VOICE_MAX_SECONDS).toBe(900);
  });

  it('retention: a done note whose text was nulled says so with the retention days', () => {
    useSettingsStore.setState({
      settings: { ...structuredClone(DEFAULT_SETTINGS), privacy: { ...DEFAULT_SETTINGS.privacy, retentionDays: 14 } },
    });
    render(<VoiceBubble voice={voice({ transcript: null })} />);
    expect(screen.getByTestId('voice-removed')).toHaveTextContent('Transcript was removed after 14 days');
  });

  it('clamps to N lines on the card, never in the sheet (full)', () => {
    const { rerender } = render(<VoiceBubble voice={voice()} clampLines={3} />);
    expect(screen.getByTestId('voice-transcript').style.webkitLineClamp).toBe('3');
    rerender(<VoiceBubble voice={voice()} clampLines={3} full />);
    expect(screen.getByTestId('voice-transcript').style.webkitLineClamp).toBe('');
  });

  it('has no play button (U-v2-6) and no interactive element at all', () => {
    render(<VoiceBubble voice={voice()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('RTL snapshot (he)', async () => {
    await i18next.changeLanguage('he');
    document.documentElement.dir = 'rtl';
    const { container } = render(
      <VoiceBubble voice={voice({ language: 'he', transcript: 'בוא נזיז ל-5, אני עסוקה עד אז' })} />,
    );
    expect(screen.getByTestId('voice-bubble')).toHaveTextContent('הודעה קולית · 0:42');
    expect(container.firstChild).toMatchSnapshot();
  });
});
