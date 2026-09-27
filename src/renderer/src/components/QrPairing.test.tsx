// QrPairing - the QR plate reused by the wizard step and by Settings > WhatsApp > Re-link (UX 8.2, 14.2; owner W1-16).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QrPairing, formatCountdown, isDataUrl, type QrPairingState } from './QrPairing';

const QR = 'data:image/png;base64,iVBORw0KGgo=';

const show = (state: QrPairingState, onNewCode = vi.fn()) => {
  render(<QrPairing state={state} onNewCode={onNewCode} />);
  return onNewCode;
};

describe('formatCountdown', () => {
  it.each([
    [0, '0:00'],
    [1, '0:01'],
    [41_000, '0:41'],
    [60_000, '1:00'],
    [-5000, '0:00'],
  ])('%i ms -> %s', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});

describe('isDataUrl', () => {
  it('accepts only a data: image, never a remote or app URL', () => {
    expect(isDataUrl(QR)).toBe(true);
    expect(isDataUrl('https://example.test/qr.png')).toBe(false);
    expect(isDataUrl('data:text/html,<script>')).toBe(false);
    expect(isDataUrl(undefined)).toBe(false);
  });
});

describe('QrPairing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-21T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the code as a data: URL and never as a remote image', () => {
    show({ status: 'qr', qrDataUrl: QR, expiresAt: Date.now() + 41_000 });
    const img = screen.getByTestId('qr-image');
    expect(img).toHaveAttribute('src', expect.stringMatching(/^data:/));
    expect(img.getAttribute('src')).toBe(QR);
    expect(screen.getByTestId('qr-countdown')).toHaveTextContent('0:41');
  });

  it('a non-data src is treated as "no code yet"', () => {
    show({ status: 'qr', qrDataUrl: 'https://example.test/qr.png', expiresAt: Date.now() + 10_000 });
    expect(screen.queryByTestId('qr-image')).not.toBeInTheDocument();
    expect(screen.getByTestId('qr-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('qr-preparing')).toBeInTheDocument();
  });

  it('counts down once a second', () => {
    show({ status: 'qr', qrDataUrl: QR, expiresAt: Date.now() + 41_000 });
    expect(screen.getByTestId('qr-countdown')).toHaveTextContent('0:41');
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByTestId('qr-countdown')).toHaveTextContent('0:39');
  });

  it('offers a new code once the old one expired', async () => {
    const onNewCode = show({ status: 'timeout' });
    expect(screen.getByTestId('qr-expired')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('qr-new-code'));
    expect(onNewCode).toHaveBeenCalledOnce();
  });

  it('shows the connected and the error panels', () => {
    const { unmount } = render(<QrPairing state={{ status: 'connected' }} onNewCode={() => {}} />);
    expect(screen.getByTestId('qr-connected')).toBeInTheDocument();
    unmount();

    render(<QrPairing state={{ status: 'error', errorCode: 'BRIDGE_OUTDATED' }} onNewCode={() => {}} />);
    const alert = screen.getByTestId('qr-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('WhatsApp no longer accepts this version');
  });

  it('falls back to its own wording when health carries no code', () => {
    show({ status: 'error' });
    expect(screen.getByTestId('qr-error')).toHaveTextContent('Linking is not available');
  });

  // [repair ux-i18n-5] UX 11.4 gives every error row a title, a body AND one action. The error branch used to render
  // only the two <p>, so the one screen whose entire purpose is linking offered no way to link: WA_LOGGED_OUT's body
  // literally says "Link it again to continue" while `onNewCode` sat unused a few lines below in the timeout branch.
  it('offers the recovery action of UX 11.4 in the error state, not just a title and a body', async () => {
    const onNewCode = show({ status: 'error', errorCode: 'WA_LOGGED_OUT' });
    const button = screen.getByTestId('qr-new-code');
    expect(screen.getByTestId('qr-error')).toHaveTextContent('This computer was unlinked from WhatsApp');
    await userEvent.click(button);
    expect(onNewCode).toHaveBeenCalledOnce();
  });

  it('offers the same way out when the bridge answers "error" with no code at all', async () => {
    const onNewCode = show({ status: 'error' });
    await userEvent.click(screen.getByTestId('qr-new-code'));
    expect(onNewCode).toHaveBeenCalledOnce();
  });

  it('shows the preparing state while there is no code at all', () => {
    show({ status: 'preparing' });
    expect(screen.getByTestId('qr-preparing')).toBeInTheDocument();
    expect(screen.queryByTestId('qr-countdown')).not.toBeInTheDocument();
  });
});
