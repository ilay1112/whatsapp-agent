// Ready v2 - the "Voice notes" checklist row (UX2 6 step 4, 13 `ready-voice`; owner V2-W1-12). Automatic mode is never
// offered in onboarding.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { OnboardingState } from '@shared/types';
import { defaultHealth, mockInvoke } from '../../../../../tests/setup-renderer';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { Ready } from './Ready';

const state = (voice: OnboardingState['checklist']['voice'], voicePercent: number | null = null): OnboardingState => ({
  step: 'ready',
  checklist: { ai: 'ready', aiPercent: null, whatsapp: 'ready', calendar: 'ready', voice, voicePercent },
  userDataCloudSynced: false,
});

beforeEach(() => {
  useHealthStore.setState({ health: defaultHealth, progress: null, hiddenSetupTasks: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, saveError: null, savedAt: 0 });
});

describe('Ready v2 - voice row', () => {
  it.each([
    ['off', null, 'off', '0'],
    ['downloading', 62, 'downloading 62 % - voice messages wait until it is ready', '0'],
    ['ready', null, 'ready', '1'],
  ] as const)('%s', async (voice, percent, text, ready) => {
    mockInvoke('onboarding:getState', () => ({ ok: true, value: state(voice, percent) }));
    render(<Ready onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('ready-voice')).toHaveTextContent(text));
    expect(screen.getByTestId('ready-voice')).toHaveAttribute('data-ready', ready);
    expect(screen.getByTestId('ready-voice')).toHaveTextContent('Voice notes');
    expect(document.querySelector('[data-testid^="auto-"]')).toBeNull();
  });

  it('a downloading row without a percentage says 0 %', async () => {
    mockInvoke('onboarding:getState', () => ({ ok: true, value: state('downloading', null) }));
    render(<Ready onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('ready-voice')).toHaveTextContent('downloading 0 %'));
  });
});
