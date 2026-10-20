// [V4] T-908 group A (spec v4-calendar-handover 2.2, 2.3): Settings > General gains the Appearance radio row (system / light /
// dark, saved through settings:set and applied to <html data-theme> at once), and the page no longer owns a scroller - the app
// shell's content wrapper does - so its section nav sticks with a LOGICAL inset.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS, applySettingsPatch } from '@shared/settings';
import { defaultHealth, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { Settings } from './Settings';

beforeEach(() => {
  useHealthStore.setState({ health: defaultHealth, progress: null, hiddenSetupTasks: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, saveError: null, savedAt: 0 });
  mockInvoke('settings:set', (patch) => ({
    ok: true,
    value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, patch as never),
  }));
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
});

const paint = async () => {
  render(<Settings />);
  await waitFor(() => expect(screen.getByTestId('settings')).toBeInTheDocument());
};

describe('[v4] Settings > General - Appearance', () => {
  it('renders the three radios in the General group, labelled by the row', async () => {
    await paint();
    const row = screen.getByTestId('settings-theme');
    expect(within(screen.getByTestId('settings-group-general')).getByTestId('settings-theme')).toBe(row);
    expect(within(row).getByText('Appearance')).toBeInTheDocument();
    const group = within(row).getByRole('radiogroup', { name: 'Appearance' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('data-testid'))).toEqual([
      'settings-theme-system',
      'settings-theme-light',
      'settings-theme-dark',
    ]);
    expect(screen.getByTestId('settings-theme-system')).toBeChecked();
    expect(within(group).getByLabelText('Dark')).toBe(screen.getByTestId('settings-theme-dark'));
  });

  it('saves the choice through settings:set and applies it to <html data-theme>', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('settings-theme-dark'));
    expect(invokeMocks['settings:set']).toHaveBeenLastCalledWith({ general: { theme: 'dark' } });
    await waitFor(() => expect(screen.getByTestId('settings-theme-dark')).toBeChecked());
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(screen.getByTestId('settings-theme-system'));
    expect(invokeMocks['settings:set']).toHaveBeenLastCalledWith({ general: { theme: 'system' } });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('[v4] Settings - layout under the sticky shell', () => {
  it('<main> owns no scroller and the nav sticks with a logical inset', async () => {
    await paint();
    const main = screen.getByTestId('settings');
    expect(main.className).not.toMatch(/overflow-/);
    const nav = within(main).getByRole('navigation');
    expect(nav).toHaveClass('sticky', 'inset-bs-4');
    expect(nav.className).not.toMatch(/(^|\s)top-/);
  });
});
