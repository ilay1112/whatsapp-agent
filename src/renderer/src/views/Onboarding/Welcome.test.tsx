// Welcome - step 0 (UX 8.0, ARCH 12.1; owner W1-16). The first structural gate of the approval-first design:
// no bridge is ever spawned without the `whatsapp_tos` consent record this screen creates.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONSENT_VERSIONS } from '@shared/types';
import { i18next, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { useSettingsStore } from '../../store/settings';
import { Welcome } from './Welcome';

beforeEach(() => {
  useSettingsStore.setState({ settings: null, saveError: null, savedAt: 0 });
});

describe('Welcome', () => {
  it('is step 0 of the wizard and has no progress rail yet', () => {
    render(<Welcome onDone={() => {}} />);
    expect(screen.getByTestId('onboarding-step-0')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-rail')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-welcome')).toBeInTheDocument();
  });

  it('names the ban risk before the accept box', () => {
    render(<Welcome onDone={() => {}} />);
    const section = screen.getByRole('heading', { name: 'Before you start' }).closest('section')!;
    expect(section).toHaveTextContent('unofficial component');
    expect(section).toHaveTextContent('limited or blocked');
    expect(section).toContainElement(screen.getByTestId('welcome-accept'));
  });

  it('cannot start until the risk is explicitly accepted', async () => {
    const onDone = vi.fn();
    render(<Welcome onDone={onDone} />);
    expect(screen.getByTestId('welcome-start')).toBeDisabled();

    await userEvent.click(screen.getByTestId('welcome-accept'));
    expect(screen.getByTestId('welcome-start')).toBeEnabled();
    expect(invokeMocks['consent:accept']).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('records the versioned consent and only then moves on', async () => {
    const onDone = vi.fn();
    render(<Welcome onDone={onDone} />);
    await userEvent.click(screen.getByTestId('welcome-accept'));
    await userEvent.click(screen.getByTestId('welcome-start'));

    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(invokeMocks['consent:accept']).toHaveBeenCalledExactlyOnceWith({
      kind: 'whatsapp_tos',
      version: CONSENT_VERSIONS.whatsapp_tos,
    });
  });

  it('a refused consent shows the error and does not move on', async () => {
    const onDone = vi.fn();
    mockInvoke('consent:accept', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    render(<Welcome onDone={onDone} />);
    await userEvent.click(screen.getByTestId('welcome-accept'));
    await userEvent.click(screen.getByTestId('welcome-start'));

    await waitFor(() => expect(screen.getByTestId('welcome-error')).toBeInTheDocument());
    expect(screen.getByTestId('welcome-error')).toHaveAttribute('role', 'alert');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('the language choice goes to main and flips the document direction', async () => {
    render(<Welcome onDone={() => {}} />);
    // The endonyms are never translated (i18n-rtl.md 4.3).
    expect(screen.getByText('עברית')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('welcome-language-he'));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ general: { language: 'he' } });
  });

  it('RTL snapshot', async () => {
    await i18next.changeLanguage('he');
    const { container } = render(<Welcome onDone={() => {}} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ברוכים הבאים');
    expect(container.firstChild).toMatchSnapshot();
  });
});
