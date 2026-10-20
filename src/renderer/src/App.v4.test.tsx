// [V4] T-908 group A (spec v4-calendar-handover 2.2, 2.3): the theme reaches <html data-theme> at boot and on change, the header
// switch persists through settings:set (the documented header exception, like the language toggle), and the shell is a
// fixed-height column whose ONE content scroller sits between the header / setup strip and the footer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { App } from './App';
import { useHealthStore } from './store/health';
import { useDashboardStore } from './store/dashboard';
import { useSettingsStore } from './store/settings';
import { defaultHealth, invokeMocks, mockInvoke } from '../../../tests/setup-renderer';

const withTheme = (theme: Settings['general']['theme']): Settings => ({
  ...DEFAULT_SETTINGS,
  general: { ...DEFAULT_SETTINGS.general, theme },
});

const bootWith = (settings: Settings) =>
  mockInvoke('app:getBootstrap', () => ({
    ok: true as const,
    value: {
      lang: 'en' as const,
      dir: 'ltr' as const,
      onboardingStep: 'done' as const,
      health: defaultHealth,
      settingsPublic: settings,
      version: '0.1.0-test',
      trayHintSeen: true,
    },
  }));

beforeEach(() => {
  useHealthStore.setState({ health: null, progress: null, hiddenSetupTasks: [] });
  useSettingsStore.setState({ settings: null, saveError: null, savedAt: 0 });
  useDashboardStore.setState({ ignoredCount: 0, toast: null, arrivedItemIds: new Set() });
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('[v4] App - theme', () => {
  it("boots with theme 'dark' -> <html data-theme='dark'>", async () => {
    bootWith(withTheme('dark'));
    render(<App />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-value', 'dark');
  });

  it("boots with theme 'system' -> no data-theme attribute (the media query decides)", async () => {
    document.documentElement.dataset.theme = 'light'; // a stale value from an earlier render must be cleared
    bootWith(withTheme('system'));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme')).toBe(false));
  });

  it('the header switch persists through settings:set and applies at once', async () => {
    bootWith(withTheme('system'));
    mockInvoke('settings:set', () => ({ ok: true, value: withTheme('light') }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('theme-toggle')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('theme-light'));
    expect(invokeMocks['settings:set']).toHaveBeenCalledExactlyOnceWith({ general: { theme: 'light' } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-value', 'light');
  });
});

describe('[v4] App - sticky shell layout', () => {
  it('the root is a fixed-height column and the content wrapper is the scroller between header and footer', async () => {
    bootWith(DEFAULT_SETTINGS);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    const root = screen.getByTestId('app');
    expect(root).toHaveClass('h-full', 'overflow-hidden', 'flex', 'flex-col');
    expect(root).not.toHaveClass('min-h-full');

    const scroller = screen.getByTestId('app-scroll');
    expect(scroller).toHaveClass('min-h-0', 'grow', 'overflow-y-auto');
    expect(scroller.contains(screen.getByTestId('dashboard'))).toBe(true);
    // header (and setup strip) before the scroller, footer after it - none of them inside it
    expect(scroller.contains(screen.getByRole('banner'))).toBe(false);
    expect(scroller.contains(screen.getByRole('contentinfo'))).toBe(false);
    expect(screen.getByRole('banner')).toHaveClass('shrink-0');
  });

  it('the dashboard toolbar sticks to the block-start of the scroller on an opaque canvas background', async () => {
    bootWith(DEFAULT_SETTINGS);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('dash-toolbar')).toBeInTheDocument());
    expect(screen.getByTestId('dash-toolbar')).toHaveClass('sticky', 'inset-bs-0', 'z-10', 'bg-canvas');
    // the dashboard fills the scroller and lets its columns scroll on their own
    expect(screen.getByTestId('dashboard')).toHaveClass('min-h-0', 'grow');
  });
});
