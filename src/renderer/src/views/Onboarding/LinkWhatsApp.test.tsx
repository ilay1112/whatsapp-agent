// LinkWhatsApp - step 2 (UX 8.2, ARCH 12.1; owner W1-16). Three numbered TEXT steps, no illustrations ([R2]).
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PairingState } from '@shared/health';
import { defaultHealth, emitPush, i18next, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { useHealthStore } from '../../store/health';
import { LinkWhatsApp, toPanelState } from './LinkWhatsApp';

const QR = 'data:image/png;base64,iVBORw0KGgo=';

describe('toPanelState', () => {
  it.each([
    [{ status: 'connected' } as PairingState, 'connected'],
    [{ status: 'timeout' } as PairingState, 'timeout'],
    [{ status: 'qr_pending', qrDataUrl: QR, expiresAt: 1 } as PairingState, 'qr'],
    [{ status: 'qr_pending' } as PairingState, 'preparing'],
    [{ status: 'connecting' } as PairingState, 'preparing'],
    [{ status: 'error' } as PairingState, 'error'],
    [{ status: 'logged_out' } as PairingState, 'error'],
  ])('%o -> %s', (pairing, expected) => {
    expect(toPanelState(pairing, undefined).status).toBe(expected);
  });

  it('with no pairing state at all the panel is still preparing', () => {
    expect(toPanelState(null, undefined)).toEqual({ status: 'preparing' });
  });

  it('carries the WhatsApp part error code of AppHealth into the panel', () => {
    expect(toPanelState({ status: 'error' }, 'BRIDGE_SPAWN_REFUSED')).toEqual({
      status: 'error',
      errorCode: 'BRIDGE_SPAWN_REFUSED',
    });
  });
});

describe('LinkWhatsApp', () => {
  it('is step 2, shows the rail and three numbered text steps with no image', async () => {
    mockInvoke('pairing:get', () => ({
      ok: true,
      value: { status: 'qr_pending', qrDataUrl: QR, expiresAt: Date.now() + 40_000 },
    }));
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    expect(screen.getByTestId('onboarding-step-2')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-rail-2')).toHaveAttribute('data-state', 'current');

    const list = screen.getByRole('list', { name: 'How to link from your phone' });
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(list.querySelector('img')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('qr-image')).toBeInTheDocument());
    expect(screen.getByTestId('qr-image').getAttribute('src')).toMatch(/^data:/);
  });

  it('there is no Skip - WhatsApp is the product', async () => {
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-link-whatsapp')).toBeInTheDocument());
    expect(screen.queryByText(/later/i)).not.toBeInTheDocument();
  });

  it('follows pairing:changed and offers Continue only once connected', async () => {
    mockInvoke('pairing:get', () => ({
      ok: true,
      value: { status: 'qr_pending', qrDataUrl: QR, expiresAt: Date.now() + 40_000 },
    }));
    const onDone = vi.fn();
    render(<LinkWhatsApp onDone={onDone} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pairing-waiting')).toBeInTheDocument());
    expect(screen.queryByTestId('pairing-continue')).not.toBeInTheDocument();

    emitPush('pairing:changed', { status: 'connected' });
    await waitFor(() => expect(screen.getByTestId('pairing-continue')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('pairing-continue'));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('asks main for a fresh code after a timeout', async () => {
    mockInvoke('pairing:get', () => ({ ok: true, value: { status: 'timeout' } }));
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('qr-new-code')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('qr-new-code'));
    expect(invokeMocks['pairing:newCode']).toHaveBeenCalledOnce();
  });

  it('explains the linked-device limit when the bridge reports no code and health has no reason', async () => {
    mockInvoke('pairing:get', () => ({ ok: true, value: { status: 'error' } }));
    useHealthStore.setState({ health: null });
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pairing-no-slot')).toBeInTheDocument());
  });

  // [repair ux-i18n-5] `connected` used to drive BOTH footer slots, so the error panel showed "Waiting for your
  // phone..." next to an alert saying the link is gone, with no primary button - and ERROR_ACTION routes
  // WA_LOGGED_OUT's "Re-link" straight into this step. The step must offer a way to link, and must not claim to be
  // waiting while it is not.
  it('a logged-out session offers a new code instead of claiming to wait for the phone', async () => {
    mockInvoke('pairing:get', () => ({ ok: true, value: { status: 'logged_out' } }));
    useHealthStore.setState({
      health: { ...defaultHealth, whatsapp: { state: 'logged_out', since: 0, code: 'WA_LOGGED_OUT' } },
    });
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('qr-error')).toBeInTheDocument());

    expect(screen.queryByTestId('pairing-waiting')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('qr-new-code'));
    expect(invokeMocks['pairing:newCode']).toHaveBeenCalled();
  });

  it('still says it is waiting while a code is actually on screen', async () => {
    mockInvoke('pairing:get', () => ({
      ok: true,
      value: { status: 'qr_pending', qrDataUrl: QR, expiresAt: Date.now() + 40_000 },
    }));
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('qr-image')).toBeInTheDocument());
    expect(screen.getByTestId('pairing-waiting')).toBeInTheDocument();
  });

  it('Back returns to the previous step', async () => {
    const onBack = vi.fn();
    render(<LinkWhatsApp onDone={() => {}} onBack={onBack} />);
    await userEvent.click(screen.getByTestId('onboarding-back'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('RTL snapshot', async () => {
    await i18next.changeLanguage('he');
    mockInvoke('pairing:get', () => ({ ok: true, value: { status: 'qr_pending', qrDataUrl: QR, expiresAt: 1 } }));
    const { container } = render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('qr-image')).toBeInTheDocument());
    // QrPairing measures the countdown bar's full scale once per code, in an effect, so for one microtask after the
    // image appears the bar still reads full (see QrPairing's comment). Snapshotting inside that window is a race -
    // wait for the settled width, which for this already-expired code is 0%.
    await waitFor(() =>
      expect(container.querySelector('.bg-accent')?.getAttribute('style')).toContain('inline-size: 0%'),
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
