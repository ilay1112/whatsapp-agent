// VoiceNotes - Settings > AI engine > Voice notes (UX2 4.2, 9, 13; B18, B23; owner V2-W1-12).
// A missing model is never downloaded on a radio change; the app never switches tier by itself; sizes come from bytes.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VoiceState } from '@shared/types';
import { DEFAULT_SETTINGS, applySettingsPatch, type Settings } from '@shared/settings';
import { i18next, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { VoiceNotes, tierFact } from './VoiceNotes';

const HEBREW_BYTES = 1_624_555_275; // 1.5 GB with the v1 size rule
const voice = (patch: Partial<VoiceState> = {}): VoiceState => ({
  enabled: false,
  tier: 'auto',
  resolvedTier: 'voice-hebrew',
  model: { id: 'voice-hebrew', sizeBytes: HEBREW_BYTES, status: 'none', bytesDone: 0 },
  vad: { status: 'none' },
  secPerAudioSec: null,
  suggestLite: false,
  ...patch,
});
const withSettings = (patch: Partial<Settings['voice']> = {}) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, ...patch } } });

beforeEach(() => {
  withSettings();
  useHealthStore.setState({ downloads: {} });
  mockInvoke('settings:set', (patch) => ({
    ok: true,
    value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, patch as never),
  }));
});

describe('VoiceNotes - tierFact', () => {
  it('prefers a live download, then the resolved model row, else unknown', () => {
    expect(tierFact('voice-lite', voice(), undefined)).toEqual({ status: 'unknown', percent: null, sizeBytes: null });
    expect(tierFact('voice-hebrew', voice(), undefined).sizeBytes).toBe(HEBREW_BYTES);
    expect(tierFact('voice-lite', voice(), { status: 'downloading', bytesDone: 25, bytesTotal: 100 })).toEqual({
      status: 'downloading',
      percent: 25,
      sizeBytes: 100,
    });
    expect(tierFact('voice-lite', null, { status: 'paused', bytesDone: 0, bytesTotal: 0 }).percent).toBe(0);
  });
});

describe('VoiceNotes', () => {
  it('Off is checked while disabled; the known size is shown from bytes; the fixed facts are text', async () => {
    mockInvoke('voice:getState', () => ({ ok: true, value: voice() }));
    render(<VoiceNotes />);
    expect(screen.getByTestId('settings-voice-off')).toBeChecked();
    await waitFor(() => expect(screen.getByTestId('settings-voice')).toHaveTextContent('1.5 GB'));
    expect(screen.getByTestId('settings-voice-status-voice-hebrew')).toHaveTextContent('not downloaded');
    expect(screen.getByTestId('settings-voice')).toHaveTextContent('Notes longer than 15 minutes are not transcribed.');
    expect(screen.getByTestId('settings-voice')).toHaveTextContent('Nothing is sent anywhere.');
  });

  it('choosing a missing tier ASKS first; nothing is downloaded until Download is clicked', async () => {
    mockInvoke('voice:getState', () => ({ ok: true, value: voice() }));
    render(<VoiceNotes />);
    await waitFor(() => expect(screen.getByTestId('settings-voice-status-voice-hebrew')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('settings-voice-voice-hebrew'));
    expect(screen.getByTestId('settings-voice-confirm')).toHaveTextContent('Download the Hebrew voice model (1.5 GB)?');
    expect(invokeMocks['model:startDownload']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('settings-voice-confirm-cancel'));
    expect(screen.queryByTestId('settings-voice-confirm')).not.toBeInTheDocument();
    expect(invokeMocks['model:startDownload']).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('settings-voice-voice-lite'));
    expect(screen.getByTestId('settings-voice-confirm')).toHaveTextContent('Download the lite voice model?');
    await userEvent.click(screen.getByTestId('settings-voice-confirm-download'));
    await waitFor(() =>
      expect(invokeMocks['model:startDownload']).toHaveBeenCalledExactlyOnceWith({ tier: 'voice-lite' }),
    );
    expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ voice: { tier: 'voice-lite' } });
    // voice.enabled=true is main's decision once the file is ready (C2 4): never sent for a missing tier
    for (const call of invokeMocks['settings:set'].mock.calls)
      expect(JSON.stringify(call[0])).not.toContain('"enabled":true');
    expect(screen.getByTestId('settings-voice-voice-lite')).toBeChecked();
  });

  it('a downloading tier says voice notes wait as plain cards', async () => {
    mockInvoke('voice:getState', () => ({ ok: true, value: voice({ tier: 'voice-hebrew' }) }));
    withSettings({ tier: 'voice-hebrew' });
    useHealthStore.setState({
      downloads: {
        'voice-hebrew': {
          tier: 'voice-hebrew',
          status: 'downloading',
          bytesDone: 43,
          bytesTotal: 100,
          bytesPerSec: 1,
          etaSec: 1,
          errorCode: null,
        },
      },
    });
    render(<VoiceNotes />);
    expect(screen.getByTestId('settings-voice-status-voice-hebrew')).toHaveTextContent(
      'Downloading 43 % - voice notes wait as plain cards',
    );
  });

  it('choosing a READY tier enables voice with that tier; Off disables', async () => {
    mockInvoke('voice:getState', () => ({
      ok: true,
      value: voice({
        model: { id: 'voice-hebrew', sizeBytes: HEBREW_BYTES, status: 'ready', bytesDone: HEBREW_BYTES },
      }),
    }));
    render(<VoiceNotes />);
    await waitFor(() => expect(screen.getByTestId('settings-voice-status-voice-hebrew')).toHaveTextContent('ready'));
    await userEvent.click(screen.getByTestId('settings-voice-voice-hebrew'));
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ voice: { enabled: true, tier: 'voice-hebrew' } }),
    );
    expect(invokeMocks['model:startDownload']).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('settings-voice-voice-hebrew')).toBeChecked());
    await userEvent.click(screen.getByTestId('settings-voice-off'));
    await waitFor(() => expect(invokeMocks['settings:set']).toHaveBeenLastCalledWith({ voice: { enabled: false } }));
  });

  it('a ready, unselected tier offers Delete behind a confirm that names the size', async () => {
    mockInvoke('voice:getState', () => ({
      ok: true,
      value: voice({
        model: { id: 'voice-hebrew', sizeBytes: HEBREW_BYTES, status: 'ready', bytesDone: HEBREW_BYTES },
      }),
    }));
    render(<VoiceNotes />);
    await userEvent.click(await screen.findByTestId('settings-voice-delete-voice-hebrew'));
    expect(screen.getByTestId('settings-voice-delete-dialog')).toHaveTextContent('Delete the voice model (1.5 GB)?');
    await userEvent.click(screen.getByTestId('settings-voice-delete-dialog-cancel'));
    expect(invokeMocks['model:delete']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('settings-voice-delete-voice-hebrew'));
    await userEvent.click(screen.getByTestId('settings-voice-delete-dialog-confirm'));
    await waitFor(() => expect(invokeMocks['model:delete']).toHaveBeenCalledExactlyOnceWith({ tier: 'voice-hebrew' }));
  });

  it('a failed download offers "Download again"', async () => {
    mockInvoke('voice:getState', () => ({
      ok: true,
      value: voice({ model: { id: 'voice-hebrew', sizeBytes: HEBREW_BYTES, status: 'failed', bytesDone: 0 } }),
    }));
    render(<VoiceNotes />);
    await userEvent.click(await screen.findByTestId('settings-voice-retry-voice-hebrew'));
    await waitFor(() => expect(invokeMocks['model:startDownload']).toHaveBeenCalledWith({ tier: 'voice-hebrew' }));
  });

  it('Test runs voice:selfTest and reports seconds per minute; slow suggests Lite but never switches', async () => {
    mockInvoke('voice:getState', () => ({ ok: true, value: voice() }));
    mockInvoke('voice:selfTest', () => ({ ok: true, value: { ok: true, secPerAudioSec: 2.5 } }));
    render(<VoiceNotes />);
    expect(screen.getByTestId('settings-voice-bench')).toHaveTextContent('not measured yet');
    await userEvent.click(screen.getByTestId('settings-voice-test'));
    await waitFor(() => expect(screen.getByTestId('settings-voice-bench')).toHaveTextContent('about 150 s per minute'));
    expect(screen.getByTestId('settings-voice-suggest-lite')).toBeInTheDocument();
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Use Lite' }));
    expect(screen.getByTestId('settings-voice-confirm')).toBeInTheDocument(); // same path as the radio: ask first
  });

  it('renders nothing without settings; Hebrew copy', async () => {
    useSettingsStore.setState({ settings: null });
    const { container, unmount } = render(<VoiceNotes />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    withSettings();
    await i18next.changeLanguage('he');
    render(<VoiceNotes />);
    expect(screen.getByTestId('settings-voice')).toHaveTextContent('הודעות קוליות');
  });
});
