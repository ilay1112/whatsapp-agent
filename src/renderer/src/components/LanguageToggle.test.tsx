// UX 5.1 / 14.2 / 13.2: a two-segment radiogroup whose labels are never translated.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LanguageToggle } from './LanguageToggle';
import { i18next } from '../../../../tests/setup-renderer';

describe('LanguageToggle', () => {
  it('renders a radiogroup with the two untranslated labels and marks the active one', () => {
    render(<LanguageToggle value="en" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup');
    expect(group).toHaveAttribute('data-testid', 'lang-toggle');
    const [he, en] = screen.getAllByRole('radio');
    expect(he).toHaveTextContent('עב');
    expect(he).toHaveAttribute('lang', 'he');
    expect(en).toHaveTextContent('EN');
    expect(en).toHaveAttribute('lang', 'en');
    expect(en).toHaveAttribute('aria-checked', 'true');
    expect(he).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps the labels in Latin/Hebrew script after the UI language changes', async () => {
    await i18next.changeLanguage('he');
    render(<LanguageToggle value="he" onChange={() => {}} />);
    expect(screen.getAllByRole('radio').map((b) => b.textContent)).toEqual(['עב', 'EN']);
  });

  it('reports the chosen language on click', async () => {
    const onChange = vi.fn();
    render(<LanguageToggle value="en" onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('עברית'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('he');
  });

  it('moves with the arrow keys (roving radiogroup)', async () => {
    const onChange = vi.fn();
    render(<LanguageToggle value="he" onChange={onChange} />);
    const he = screen.getByLabelText('עברית');
    he.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('en');
    expect(he).toHaveAttribute('tabindex', '0');
    expect(screen.getByLabelText('English')).toHaveAttribute('tabindex', '-1');
  });
});
