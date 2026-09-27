// Scratch probe for review finding ux-i18n-5. Read-only reproduction; asserts nothing about desired behaviour,
// it only prints what the error branch of step 2 actually renders.
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { mockInvoke } from '../../../tests/setup-renderer';
import { useHealthStore } from '../../../src/renderer/src/store/health';
import { LinkWhatsApp } from '../../../src/renderer/src/views/Onboarding/LinkWhatsApp';
import { defaultHealth } from '../../../tests/setup-renderer';

describe('ux-i18n-5 probe', () => {
  it('logged_out + WA_LOGGED_OUT: what buttons exist on step 2?', async () => {
    mockInvoke('pairing:get', () => ({ ok: true, value: { status: 'logged_out' } }));
    useHealthStore.setState({
      health: { ...defaultHealth, whatsapp: { state: 'logged_out', since: 0, code: 'WA_LOGGED_OUT' } },
    });
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('qr-error')).toBeInTheDocument());

    const buttons = screen.getAllByRole('button').map((b) => `${b.getAttribute('data-testid')}="${b.textContent}"`);
    // eslint-disable-next-line no-console
    console.log('ERROR-BOX TEXT :', screen.getByTestId('qr-error').textContent);
    console.log('BUTTONS        :', JSON.stringify(buttons));
    console.log('waiting footer :', screen.queryByTestId('pairing-waiting')?.textContent ?? '(none)');
    console.log('primary button :', screen.queryByTestId('pairing-continue')?.textContent ?? '(none)');
    console.log('new-code button:', screen.queryByTestId('qr-new-code')?.textContent ?? '(none)');
    expect(buttons).toEqual(['onboarding-back="Back"']);
  });

  it('BRIDGE_SPAWN_REFUSED as the reviewer describes it (pairing status "unavailable")', async () => {
    mockInvoke('pairing:get', () => ({ ok: true, value: { status: 'unavailable' } }));
    useHealthStore.setState({
      health: { ...defaultHealth, whatsapp: { state: 'refused', since: 0, code: 'BRIDGE_SPAWN_REFUSED' } },
    });
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('qr-pairing')).toBeInTheDocument());
    console.log('panel status   :', screen.getByTestId('qr-pairing').getAttribute('data-status'));
    console.log('error box?     :', screen.queryByTestId('qr-error') ? 'yes' : 'no');
    console.log('preparing?     :', screen.queryByTestId('qr-preparing')?.textContent ?? '(none)');
  });

  it('pairing status "error" + BRIDGE_SPAWN_REFUSED (bridge answers, then is refused)', async () => {
    mockInvoke('pairing:get', () => ({ ok: true, value: { status: 'error' } }));
    useHealthStore.setState({
      health: { ...defaultHealth, whatsapp: { state: 'refused', since: 0, code: 'BRIDGE_SPAWN_REFUSED' } },
    });
    render(<LinkWhatsApp onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('qr-error')).toBeInTheDocument());
    console.log('error box text :', screen.getByTestId('qr-error').textContent);
    console.log(
      'buttons        :',
      JSON.stringify(screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'))),
    );
  });
});
