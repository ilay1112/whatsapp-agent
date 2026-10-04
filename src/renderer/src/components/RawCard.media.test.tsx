// V2-W1-11: the "Voice message" / "Photo" raw cards and their ONE action (UX2 3.5, 3.6, 9, 10). None of these actions
// writes to WhatsApp or the calendar: they download a model, re-queue a transcript / an analysis, or open Settings.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ErrorCode } from '@shared/errors';
import type { ItemCard as ItemVM, ModelPlan, VoiceState } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { RawCard, resetAnalyseExplanations } from './RawCard';
import { MediaActions, imageUnreadCause } from './RawCard.media';
import { useDashboardStore } from '../store/dashboard';
import { useSettingsStore } from '../store/settings';
import { defaultCard, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const voiceCard = (errorCode: ErrorCode | null, patch: Partial<ItemVM> = {}): ItemVM => ({
  ...structuredClone(defaultCard),
  card: 'raw',
  analysis: 'held',
  triggerKind: 'voice',
  trigger: { ts: Date.now() - 60_000, text: '' },
  voice: { seconds: 42, language: null, transcript: null, status: 'pending' },
  errorCode,
  draft: null,
  event: null,
  eventState: 'none',
  badges: [],
  actions: [],
  ...patch,
});
const photoCard = (errorCode: ErrorCode | null = null, patch: Partial<ItemVM> = {}): ItemVM => ({
  ...structuredClone(defaultCard),
  card: 'raw',
  analysis: 'failed',
  triggerKind: 'image',
  trigger: { ts: Date.now() - 60_000, text: '' },
  image: null,
  errorCode,
  draft: null,
  event: null,
  eventState: 'none',
  badges: ['image_unread'],
  actions: [],
  ...patch,
});
const voiceState = (patch: Partial<VoiceState> = {}): VoiceState => ({
  enabled: true,
  tier: 'auto',
  resolvedTier: 'voice-hebrew',
  model: { id: 'voice-hebrew', sizeBytes: 1_624_555_275, status: 'none', bytesDone: 0 },
  vad: { status: 'none' },
  secPerAudioSec: null,
  suggestLite: false,
  ...patch,
});
const plan = (mmproj: ModelPlan['mmproj']): ModelPlan => ({
  recommendedTier: 'small',
  selectedTier: 'small',
  tiers: [],
  suggestSmaller: false,
  mmproj,
});
const setSettings = (patch: { voice?: boolean; images?: boolean }): void => {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (patch.voice !== undefined) s.voice.enabled = patch.voice;
  if (patch.images !== undefined) s.images.enabled = patch.images;
  useSettingsStore.setState({ settings: s });
};

beforeEach(() => {
  resetAnalyseExplanations();
  useDashboardStore.setState({
    navRequest: null,
    arrivedItemIds: new Set(),
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
  });
  setSettings({ voice: true, images: true });
});

describe('voice raw card', () => {
  it('shows the VoiceBubble header, the reason chip, and no "Analyse this chat"', () => {
    render(<RawCard item={voiceCard('VOICE_TIMEOUT')} onOpen={() => undefined} />);
    expect(screen.getByTestId('voice-bubble-1')).toHaveTextContent('Voice message · 0:42');
    expect(screen.getByTestId('error-VOICE_TIMEOUT')).toBeInTheDocument();
    expect(screen.queryByTestId('analyse-1')).toBeNull();
  });

  it('model missing + voice on: "Download (1.5 GB)" starts the resolved voice tier', async () => {
    const user = userEvent.setup();
    mockInvoke('voice:getState', () => ({ ok: true, value: voiceState() }));
    render(<RawCard item={voiceCard('VOICE_MODEL_MISSING')} onOpen={() => undefined} />);
    const b = await screen.findByText('Download (1.5 GB)');
    expect(b).toHaveAttribute('data-testid', 'voice-download-1');
    await user.click(b);
    await waitFor(() => expect(invokeMocks['model:startDownload']).toHaveBeenCalledWith({ tier: 'voice-hebrew' }));
  });

  it('model missing while it downloads: the action is disabled', async () => {
    mockInvoke('voice:getState', () => ({
      ok: true,
      value: voiceState({
        model: { id: 'voice-hebrew', sizeBytes: 1_624_555_275, status: 'downloading', bytesDone: 5 },
      }),
    }));
    render(<RawCard item={voiceCard('VOICE_MODEL_MISSING')} onOpen={() => undefined} />);
    await screen.findByText('Download (1.5 GB)');
    expect(screen.getByTestId('voice-download-1')).toBeDisabled();
  });

  it('model missing + voice off: "Turn on in Settings" asks the shell for Settings > Voice notes', async () => {
    const user = userEvent.setup();
    setSettings({ voice: false });
    render(<RawCard item={voiceCard('VOICE_MODEL_MISSING')} onOpen={() => undefined} />);
    await user.click(screen.getByTestId('voice-download-1'));
    expect(useDashboardStore.getState().navRequest).toEqual({ view: 'settings', section: 'voice' });
    expect(invokeMocks['voice:getState']).not.toHaveBeenCalled();
  });

  it.each([
    ['VOICE_AUDIO_MISSING', 'Try again'],
    ['VOICE_TIMEOUT', 'Try again'],
    ['VOICE_DECODE_FAILED', 'Analyse again'],
    ['VOICE_LOCAL_FAILED', 'Analyse again'],
  ] as const)('%s: "%s" re-runs the transcript (voice:retry)', async (code, label) => {
    const user = userEvent.setup();
    render(<RawCard item={voiceCard(code)} onOpen={() => undefined} />);
    const b = screen.getByTestId('voice-retry-1');
    expect(b).toHaveTextContent(label);
    await user.click(b);
    await waitFor(() => expect(invokeMocks['voice:retry']).toHaveBeenCalledWith({ itemId: 1 }));
  });

  it('too long for this computer: "Use Lite" opens Settings > Voice notes', async () => {
    const user = userEvent.setup();
    render(<RawCard item={voiceCard('VOICE_TOO_LONG_FOR_DEVICE')} onOpen={() => undefined} />);
    await user.click(screen.getByTestId('voice-lite-1'));
    expect(useDashboardStore.getState().navRequest).toEqual({ view: 'settings', section: 'voice' });
  });

  it('too long (> 15 min): no action at all', () => {
    render(
      <RawCard
        item={voiceCard('VOICE_TOO_LONG', {
          voice: { seconds: 1025, language: null, transcript: null, status: 'pending' },
        })}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByTestId('voice-muted')).toHaveTextContent('Longer than 15 minutes - not transcribed');
    expect(screen.queryByTestId('voice-retry-1')).toBeNull();
    expect(screen.queryByTestId('voice-download-1')).toBeNull();
  });

  it('empty transcript: "No speech detected", Copy / [...] only', () => {
    render(
      <RawCard
        item={voiceCard(null, { voice: { seconds: 3, language: null, transcript: '', status: 'empty' } })}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByTestId('voice-muted')).toHaveTextContent('No speech detected');
    expect(screen.getByTestId('copy-1')).toBeInTheDocument();
  });
});

describe('photo raw card', () => {
  it('imageUnreadCause maps error, setting and projector state to the one cause', () => {
    expect(imageUnreadCause('MEDIA_UNAVAILABLE', true, null)).toBe('media_unavailable');
    expect(imageUnreadCause('LLM_BAD_OUTPUT', true, null)).toBe('read_failed');
    expect(imageUnreadCause(null, false, null)).toBe('disabled');
    expect(
      imageUnreadCause(null, true, { id: 'mmproj-small' as never, sizeBytes: 1, status: 'none', bytesDone: 0 }),
    ).toBe('no_local_reader');
    expect(
      imageUnreadCause(null, true, { id: 'mmproj-small' as never, sizeBytes: 1, status: 'ready', bytesDone: 1 }),
    ).toBe('provider_cannot');
    expect(imageUnreadCause(null, true, null)).toBe('provider_cannot');
  });

  it('the picture header shows; "Analyse this chat" stays available', () => {
    render(<RawCard item={photoCard()} onOpen={() => undefined} />);
    expect(screen.getByTestId('quoted-placeholder')).toHaveTextContent('Photo');
    expect(screen.getByTestId('analyse-1')).toBeInTheDocument();
  });

  it('local reading not downloaded: "Download picture reading (0.2 GB)" -> model:startDownload {tier:"mmproj"}', async () => {
    const user = userEvent.setup();
    mockInvoke('model:getPlan', () => ({
      ok: true,
      value: plan({ id: 'mmproj-small' as never, sizeBytes: 175_115_840, status: 'none', bytesDone: 0 }),
    }));
    render(<RawCard item={photoCard()} onOpen={() => undefined} />);
    const b = await screen.findByText('Download picture reading (0.2 GB)');
    expect(b).toHaveAttribute('data-cause', 'no_local_reader');
    expect(screen.getByTestId('image-unread-cause-1')).toHaveTextContent(
      'Picture not read - picture reading is not downloaded',
    );
    await user.click(b);
    await waitFor(() => expect(invokeMocks['model:startDownload']).toHaveBeenCalledWith({ tier: 'mmproj' }));
  });

  it('turned off: "Turn on in Settings" -> Settings > Pictures', async () => {
    const user = userEvent.setup();
    setSettings({ images: false });
    render(<RawCard item={photoCard()} onOpen={() => undefined} />);
    const b = screen.getByTestId('image-unread-action-1');
    expect(b).toHaveAttribute('data-cause', 'disabled');
    await user.click(b);
    expect(useDashboardStore.getState().navRequest).toEqual({ view: 'settings', section: 'pictures' });
  });

  it('provider cannot read pictures: "Choose an AI that can read pictures" -> Settings > AI', async () => {
    const user = userEvent.setup();
    render(<RawCard item={photoCard()} onOpen={() => undefined} />);
    const b = screen.getByTestId('image-unread-action-1');
    expect(b).toHaveTextContent('Choose an AI that can read pictures');
    await user.click(b);
    expect(useDashboardStore.getState().navRequest).toEqual({ view: 'settings', section: 'ai' });
  });

  it.each([
    ['MEDIA_UNAVAILABLE', 'media_unavailable', 'Try again'],
    ['LLM_BAD_OUTPUT', 'read_failed', 'Analyse again'],
  ] as const)('%s: "%s" re-queues the analysis (item:retriage)', async (code, cause, label) => {
    const user = userEvent.setup();
    render(<MediaActions item={photoCard(code)} />);
    const b = screen.getByTestId('image-unread-action-1');
    expect(b).toHaveAttribute('data-cause', cause);
    expect(b).toHaveTextContent(label);
    await user.click(b);
    await waitFor(() => expect(invokeMocks['item:retriage']).toHaveBeenCalledWith({ itemId: 1 }));
  });

  it('a read picture or a text trigger gets no media action', () => {
    const { container, rerender } = render(<MediaActions item={photoCard(null, { badges: ['from_image'] })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<MediaActions item={structuredClone(defaultCard)} />);
    expect(container).toBeEmptyDOMElement();
    expect(invokeMocks['model:getPlan']).not.toHaveBeenCalled();
  });

  it('never calls a sending or calendar-writing channel', async () => {
    const user = userEvent.setup();
    render(<MediaActions item={photoCard('MEDIA_UNAVAILABLE')} />);
    await user.click(screen.getByTestId('image-unread-action-1'));
    await waitFor(() => expect(invokeMocks['item:retriage']).toHaveBeenCalled());
    for (const c of ['action:approve', 'item:undoChange', 'auto:undo', 'settings:set'] as const)
      expect(invokeMocks[c]).not.toHaveBeenCalled();
  });
});
