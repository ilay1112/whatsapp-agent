// ConsentDialog - the blocking, versioned cloud consent (UX 8.1, UX 10, 14.2; owner W1-16).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONSENT_VERSIONS } from '@shared/types';
import { ConsentDialog } from './ConsentDialog';

const setup = (over: Partial<Parameters<typeof ConsentDialog>[0]> = {}) => {
  const onAccept = vi.fn();
  const onCancel = vi.fn();
  const props = {
    kind: 'cloud_claude' as const,
    version: CONSENT_VERSIONS.cloud_claude,
    open: true,
    onAccept,
    onCancel,
    ...over,
  };
  const view = render(<ConsentDialog {...props} />);
  return { onAccept, onCancel, view };
};

describe('ConsentDialog', () => {
  it('renders nothing while closed', () => {
    setup({ open: false });
    expect(screen.queryByTestId('consent-dialog')).not.toBeInTheDocument();
  });

  it('is a modal dialog with the versioned copy of its kind', () => {
    setup({ kind: 'cloud_gemini', version: CONSENT_VERSIONS.cloud_gemini });
    const dialog = screen.getByTestId('consent-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('data-kind', 'cloud_gemini');
    expect(dialog).toHaveAttribute('data-version', String(CONSENT_VERSIONS.cloud_gemini));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Send chats to Gemini');
    // the "what is sent / never sent / who" detail list and the free-tier note of UX 8.1
    expect(screen.getByTestId('consent-body')).toHaveTextContent('What is never sent');
    expect(screen.getByTestId('consent-body')).toHaveTextContent('free tier');
  });

  it('puts the initial focus on the least destructive button (UX 10)', () => {
    setup();
    expect(document.activeElement).toBe(screen.getByTestId('consent-cancel'));
  });

  it('accept and cancel only report - the dialog grants nothing by itself', async () => {
    const { onAccept, onCancel } = setup();
    await userEvent.click(screen.getByTestId('consent-accept'));
    expect(onAccept).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId('consent-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('Escape cancels', async () => {
    const { onCancel, onAccept } = setup();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog', async () => {
    setup();
    const cancel = screen.getByTestId('consent-cancel');
    const accept = screen.getByTestId('consent-accept');
    await userEvent.tab();
    expect(document.activeElement).toBe(accept);
    await userEvent.tab();
    expect(document.activeElement).toBe(cancel);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(accept);
  });

  it('requires a full read only when the body actually overflows', async () => {
    const { view } = setup();
    // jsdom gives every element a zero layout, so nothing overflows and Accept is live at once.
    expect(screen.getByTestId('consent-accept')).toBeEnabled();

    // With a real overflow the button waits for the scroll to reach the end.
    view.unmount();
    const body = { scrollHeight: 900, clientHeight: 300, scrollTop: 0 };
    for (const [k, v] of Object.entries(body)) {
      Object.defineProperty(HTMLDivElement.prototype, k, { configurable: true, get: () => v });
    }
    try {
      setup();
      expect(screen.getByTestId('consent-accept')).toBeDisabled();
    } finally {
      for (const k of Object.keys(body)) {
        Reflect.deleteProperty(HTMLDivElement.prototype, k);
      }
    }
  });

  it('a new kind gets its own unread panel', () => {
    const { view } = setup();
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude');
    view.rerender(
      <ConsentDialog
        kind="cloud_gemini"
        version={CONSENT_VERSIONS.cloud_gemini}
        open
        onAccept={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_gemini');
    expect(document.activeElement).toBe(screen.getByTestId('consent-cancel'));
  });
});
