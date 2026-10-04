// Pictures - Settings > AI engine > Pictures (UX2 4.3, 9, 13; B19, B21, F24; owner V2-W1-12).
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelPlan, ProviderId } from '@shared/types';
import { DEFAULT_SETTINGS, applySettingsPatch } from '@shared/settings';
import { IPC_DEFAULTS, defaultHealth, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { CLOUD_PICTURE_PROVIDERS, Pictures, vendorKeyOf } from './Pictures';

const MMPROJ_BYTES = 985_654_080; // 0.9 GB with the v1 size rule
const plan = (status: 'none' | 'ready' | 'failed' | 'downloading' | null): Partial<ModelPlan> => ({
  mmproj:
    status === null
      ? null
      : { id: 'mmproj-small', sizeBytes: MMPROJ_BYTES, status, bytesDone: status === 'ready' ? MMPROJ_BYTES : 0 },
});
const withProvider = (provider: ProviderId) =>
  useHealthStore.setState({ health: { ...defaultHealth, llm: { ...defaultHealth.llm, provider } }, downloads: {} });
const withPlan = (p: Partial<ModelPlan>) =>
  mockInvoke('model:getPlan', () => ({ ok: true, value: { ...IPC_DEFAULTS['model:getPlan'], ...p } }));

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  withProvider('local');
  mockInvoke('settings:set', (patch) => ({
    ok: true,
    value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, patch as never),
  }));
});

describe('Pictures', () => {
  it('helpers: which providers read pictures in the cloud, and their vendor', () => {
    expect(CLOUD_PICTURE_PROVIDERS).toEqual(['claude', 'gemini', 'claude_cli']);
    expect(vendorKeyOf('gemini')).toBe('cli.vendor.antigravity_cli');
    expect(vendorKeyOf('claude_cli')).toBe('cli.vendor.claude_cli');
  });

  it('local provider: no cloud row; the projector size of the CURRENT tier; Download only on click', async () => {
    withPlan(plan('none'));
    render(<Pictures />);
    expect(screen.queryByTestId('settings-images-cloud')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('settings-row-images-local')).toHaveTextContent('0.9 GB'));
    expect(screen.getByTestId('settings-images-local-status')).toHaveTextContent('not downloaded');
    expect(invokeMocks['model:startDownload']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('settings-images-download'));
    await waitFor(() => expect(invokeMocks['model:startDownload']).toHaveBeenCalledExactlyOnceWith({ tier: 'mmproj' }));
    await waitFor(() => expect(screen.getByTestId('settings-images-restart')).toHaveTextContent('restarts'));
  });

  it('"Read pictures" is images.enabled through settings:set; toggling it with the projector ready notes the restart', async () => {
    withPlan(plan('ready'));
    render(<Pictures />);
    await waitFor(() =>
      expect(screen.getByTestId('settings-images-local-status')).toHaveAttribute('data-status', 'ready'),
    );
    await userEvent.click(screen.getByTestId('settings-images-enabled'));
    await waitFor(() => expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ images: { enabled: false } }));
    expect(screen.getByTestId('settings-images-restart')).toBeInTheDocument();
  });

  it('a cloud provider shows "Read pictures with <vendor>" with the consent date', async () => {
    withProvider('claude_cli');
    mockInvoke('consent:get', () => ({
      ok: true,
      value: { kind: 'cloud_claude_cli', currentVersion: 1, acceptedVersion: 1, acceptedAt: Date.UTC(2026, 8, 28, 9) },
    }));
    withPlan(plan(null));
    render(<Pictures />);
    await waitFor(() => expect(screen.getByTestId('settings-row-images-cloud')).toHaveTextContent('Agreed on'));
    expect(screen.getByTestId('settings-row-images-cloud')).toHaveTextContent('Read pictures with Anthropic');
    expect(invokeMocks['consent:get']).toHaveBeenCalledWith({ kind: 'cloud_claude_cli' });
    await userEvent.click(screen.getByTestId('settings-images-cloud'));
    await waitFor(() => expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ images: { cloud: false } }));
  });

  it('without a current consent the cloud row says pictures wait for it', async () => {
    withProvider('gemini');
    withPlan(plan(null));
    render(<Pictures />);
    await waitFor(() =>
      expect(screen.getByTestId('settings-row-images-cloud')).toHaveTextContent('only after you agree'),
    );
    expect(screen.getByTestId('settings-row-images-cloud')).toHaveTextContent('Google');
  });

  it('antigravity_cli replaces the cloud row with the fixed line', () => {
    withProvider('antigravity_cli');
    render(<Pictures />);
    expect(screen.getByTestId('settings-images-local-only')).toHaveTextContent('read on this computer');
    expect(screen.queryByTestId('settings-images-cloud')).not.toBeInTheDocument();
  });

  it.each([
    ['downloading', 'Downloading'],
    ['failed', 'Download failed'],
  ] as const)('local reader %s', async (status, text) => {
    withPlan(plan(status));
    render(<Pictures />);
    await waitFor(() => expect(screen.getByTestId('settings-images-local-status')).toHaveTextContent(text));
  });

  it('a live projector download from the queue wins over the plan', async () => {
    withPlan(plan('none'));
    useHealthStore.setState({
      downloads: {
        'mmproj-small': {
          tier: 'mmproj-small',
          status: 'paused',
          bytesDone: 50,
          bytesTotal: 100,
          bytesPerSec: 1,
          etaSec: 1,
          errorCode: null,
        },
      },
    });
    render(<Pictures />);
    expect(screen.getByTestId('settings-images-local-status')).toHaveTextContent('Paused 50 %');
  });
});
