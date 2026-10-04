// HealthPill v2 - the status-panel sub-lines (UX2 2.2, C13/C14, 13 `health-subline-<part>`; owner V2-W1-12).
// Each row keeps one sentence + at most one action and gains AT MOST ONE muted sub-line, facts joined with " · ".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppHealth } from '@shared/health';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { IPC_DEFAULTS, defaultHealth, i18next, mockInvoke } from '../../../../tests/setup-renderer';
import { useAutoStore } from '../store/auto';
import { useCliStore } from '../store/cli';
import { useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { HealthPill, aiSublineParts, calendarSublineParts, errorValuesOf } from './HealthPill';

const t = (key: string, values?: Record<string, unknown>) => i18next.t(key, values);
const NOW = Date.UTC(2026, 8, 29, 9, 0);
const DAY = 86_400_000;
const h = (patch: Partial<AppHealth> = {}): AppHealth => ({ ...defaultHealth, ...patch });
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

beforeEach(() => {
  useHealthStore.setState({ health: defaultHealth, progress: null, downloads: {} });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutoStore.setState({ state: null });
  useCliStore.setState({ status: {}, checkedAt: {}, error: {} });
});

describe('HealthPill v2 - pure sub-line builders', () => {
  it('errorValuesOf names the CLI and the vendor for every provider', () => {
    expect(errorValuesOf('claude_cli', t, '2.1.150', '2.1.248')).toEqual({
      cli: 'Claude Code',
      vendor: 'Anthropic',
      version: '2.1.150',
      min: '2.1.248',
    });
    expect(errorValuesOf('antigravity_cli', t).vendor).toBe('Google');
    expect(errorValuesOf('claude', t).vendor).toBe('Anthropic');
    expect(errorValuesOf('gemini', t).vendor).toBe('Google');
    expect(errorValuesOf('local', t)).toEqual({ cli: '', vendor: '', version: '?', min: '' });
  });

  it('AI: usage reset · voice · pictures, each only when true', () => {
    const quota = h({
      llm: { ...defaultHealth.llm, provider: 'claude_cli', quota: { resetsAt: NOW + 3_600_000, usingOverage: false } },
    });
    const parts = aiSublineParts(quota, settings(), { t, now: NOW, lang: 'en', voicePercent: null, mmprojReady: null });
    expect(parts[0]).toMatch(/^usage resets \d\d:\d\d$/);
    expect(parts).toContain('Voice notes: off');
    expect(parts).toContain('Pictures: ready'); // claude_cli reads pictures in the cloud
    const voice = h({ voice: { state: 'downloading', since: NOW } });
    expect(aiSublineParts(voice, null, { t, now: NOW, lang: 'en', voicePercent: 43, mmprojReady: null })).toEqual([
      'Voice notes: downloading 43 %',
    ]);
    const ready = h({ voice: { state: 'transcribing', since: NOW } });
    expect(
      aiSublineParts(ready, settings(), { t, now: NOW, lang: 'en', voicePercent: null, mmprojReady: false }),
    ).toEqual(['Voice notes: ready', 'Pictures: not downloaded']);
    const off = settings({ images: { enabled: false, cloud: true } });
    expect(aiSublineParts(h(), off, { t, now: NOW, lang: 'en', voicePercent: null, mmprojReady: true })).toContain(
      'Pictures: off',
    );
    expect(
      aiSublineParts(h(), settings(), { t, now: NOW, lang: 'en', voicePercent: null, mmprojReady: true }),
    ).toContain('Pictures: ready');
    expect(
      aiSublineParts(h({ voice: { state: 'failed', since: NOW } }), null, {
        t,
        now: NOW,
        lang: 'en',
        voicePercent: null,
        mmprojReady: null,
      }),
    ).toEqual([]);
  });

  it('Calendar: the update guard and the automatic-mode fragment (omitted when no policy ever existed)', () => {
    expect(calendarSublineParts(h(), t, NOW, 0)).toEqual([]);
    expect(
      calendarSublineParts(h({ calendar: { ...defaultHealth.calendar, updatesAvailable: false } }), t, NOW, 0),
    ).toEqual(['Changes to events are unavailable (component version)']);
    expect(
      calendarSublineParts(h({ auto: { state: 'on', expiresAt: NOW + 23 * DAY, pausedReason: null } }), t, NOW, 0),
    ).toEqual(['Automatic mode: on - ends in 23 days']);
    expect(
      calendarSublineParts(h({ auto: { state: 'on', expiresAt: null, pausedReason: null } }), t, NOW, 0)[0],
    ).toMatch(/0 days/);
    expect(
      calendarSublineParts(h({ auto: { state: 'shadow', expiresAt: null, pausedReason: null } }), t, NOW, 2),
    ).toEqual(['Automatic mode: trial - 2 of 3 seen']);
    expect(
      calendarSublineParts(h({ auto: { state: 'paused', expiresAt: null, pausedReason: 'unattended' } }), t, NOW, 0)[0],
    ).toContain('the app was not opened for a week');
    expect(
      calendarSublineParts(h({ auto: { state: 'paused', expiresAt: null, pausedReason: null } }), t, NOW, 0)[0],
    ).toContain('you paused it');
    for (const state of ['disabled', 'expired'] as const)
      expect(calendarSublineParts(h({ auto: { state, expiresAt: null, pausedReason: null } }), t, NOW, 0)).toEqual([
        'Automatic mode: off',
      ]);
  });
});

describe('HealthPill v2 - rendered sub-lines', () => {
  it('one sub-line per row, facts joined with " · "; clicking it reports the part', async () => {
    const onSubline = vi.fn();
    const health = h({
      voice: { state: 'ready', since: NOW },
      auto: { state: 'on', expiresAt: Date.now() + 5 * DAY, pausedReason: null },
    });
    mockInvoke('model:getPlan', () => ({
      ok: true,
      value: {
        ...IPC_DEFAULTS['model:getPlan'],
        mmproj: { id: 'mmproj-small', sizeBytes: 1, status: 'ready', bytesDone: 1 },
      },
    }));
    render(<HealthPill health={health} onAction={() => {}} onSubline={onSubline} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-subline-whatsapp')).toHaveTextContent('Reading older messages: this chat only');
    await waitFor(() =>
      expect(screen.getByTestId('health-subline-llm')).toHaveTextContent('Voice notes: ready · Pictures: ready'),
    );
    expect(screen.getByTestId('health-subline-calendar')).toHaveTextContent('Automatic mode: on - ends in 5 days');
    for (const part of ['whatsapp', 'llm', 'calendar']) {
      expect(
        screen.getByTestId(`health-row-${part}`).querySelectorAll('[data-testid^="health-subline-"]'),
      ).toHaveLength(1);
    }
    await userEvent.click(screen.getByTestId('health-subline-calendar'));
    expect(onSubline).toHaveBeenCalledExactlyOnceWith('calendar');
    expect(screen.queryByTestId('health-panel')).not.toBeInTheDocument();
  });

  it('without a navigation callback the sub-line is plain text', async () => {
    render(<HealthPill health={h()} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-subline-whatsapp').tagName).toBe('SPAN');
  });

  it('CLI states read as sentences ("Claude - your subscription - not signed in")', async () => {
    render(
      <HealthPill
        health={h({ llm: { ...defaultHealth.llm, provider: 'claude_cli', state: 'not_signed_in', quota: null } })}
        onAction={() => {}}
      />,
    );
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-row-llm')).toHaveTextContent('Claude - your subscription - not signed in');
  });

  it('CLOUD_QUOTA with a known reset uses the bodyReset variant and "Open usage page" for Claude', async () => {
    const onAction = vi.fn();
    useCliStore.setState({
      status: { claude_cli: { ...IPC_DEFAULTS['cli:getStatus'], state: 'ready', version: '2.1.258' } },
    });
    render(
      <HealthPill
        health={h({
          overall: 'attention',
          llm: {
            ...defaultHealth.llm,
            provider: 'claude_cli',
            state: 'failed',
            code: 'CLOUD_QUOTA',
            quota: { resetsAt: Date.now() + 3_600_000, usingOverage: false },
          },
        })}
        onAction={onAction}
      />,
    );
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-row-llm')).toHaveTextContent('It continues by itself at');
    await userEvent.click(screen.getByTestId('health-action-llm'));
    expect(onAction).toHaveBeenCalledWith('llm', 'CLOUD_QUOTA');
    expect(screen.queryByTestId('health-panel')).not.toBeInTheDocument();
  });

  it('a voice download in the queue feeds the AI sub-line percentage', async () => {
    useHealthStore.setState({
      downloads: {
        'voice-hebrew': {
          tier: 'voice-hebrew',
          status: 'downloading',
          bytesDone: 62,
          bytesTotal: 100,
          bytesPerSec: 1,
          etaSec: 1,
          errorCode: null,
        },
      },
    });
    render(<HealthPill health={h({ voice: { state: 'downloading', since: NOW } })} onAction={() => {}} />);
    await userEvent.click(screen.getByTestId('health-pill'));
    expect(screen.getByTestId('health-subline-llm')).toHaveTextContent('Voice notes: downloading 62 %');
  });
});
