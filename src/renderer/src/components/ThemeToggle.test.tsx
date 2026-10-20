// [V4] T-908 T1 (spec v4-calendar-handover 2.3): the header theme switch - a three-segment radiogroup modelled on LanguageToggle
// (roving arrow keys, one tab stop), translated labels, and applyDocumentTheme, which sets or removes <html data-theme>.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { applyDocumentTheme, ThemeToggle } from './ThemeToggle';
import { i18next } from '../../../../tests/setup-renderer';

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.dir = 'ltr';
});

describe('ThemeToggle', () => {
  it('renders a radiogroup with system / light / dark and marks the active one', () => {
    render(<ThemeToggle value="dark" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup');
    expect(group).toHaveAttribute('data-testid', 'theme-toggle');
    expect(group).toHaveAttribute('data-value', 'dark');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('data-testid'))).toEqual(['theme-system', 'theme-light', 'theme-dark']);
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('theme-system')).toHaveAttribute('tabindex', '-1');
  });

  it('names each segment from the locale (icons only on screen)', async () => {
    await i18next.changeLanguage('en');
    const first = render(<ThemeToggle value="system" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'System' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeInTheDocument();
    first.unmount();
    await i18next.changeLanguage('he');
    render(<ThemeToggle value="system" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'כהה' })).toBeInTheDocument();
    await i18next.changeLanguage('en');
  });

  it('reports the chosen theme on click', async () => {
    const onChange = vi.fn();
    render(<ThemeToggle value="system" onChange={onChange} />);
    await userEvent.click(screen.getByTestId('theme-light'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('light');
  });

  it('moves with the arrow keys, wraps, and honours Home / End', async () => {
    const onChange = vi.fn();
    render(<ThemeToggle value="system" onChange={onChange} />);
    screen.getByTestId('theme-system').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('light');
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('dark'); // wraps backwards from the first segment
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('dark');
    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('system');
  });

  it('ArrowLeft moves forward in RTL (visual direction)', async () => {
    document.documentElement.dir = 'rtl';
    const onChange = vi.fn();
    render(<ThemeToggle value="system" onChange={onChange} />);
    screen.getByTestId('theme-system').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('light');
  });
});

describe('applyDocumentTheme', () => {
  it('sets data-theme for light / dark and removes it for system', () => {
    applyDocumentTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyDocumentTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    applyDocumentTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
