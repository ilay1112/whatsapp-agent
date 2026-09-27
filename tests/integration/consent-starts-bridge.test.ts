// tests/integration/consent-starts-bridge.test.ts - permanent L3 guard for the phase-2 blocker "a fresh profile could
// never pair" (ops/agent-notes/repair-compose-defects.md section 1.1, REQUEST 3).
//
// `compose.start()` runs before the user has read the WhatsApp disclosure, so on a first run `startBridge()` finds no
// current `whatsapp_tos` consent and the launcher stays 'not_started' (src/shared/health.ts: "not_started = ToS not
// accepted yet"). The consent is written by the `consent:accept` handler, which owns no side effect by design (W1-13);
// the fix wraps that handler in compose() so a recorded `whatsapp_tos` consent starts the bridge immediately, without
// a restart. Without the wrapper the Link-WhatsApp wizard step sat in 'preparing' for ever and the app was unusable
// out of the box. Everything here runs through the PRODUCTION compose() via the L3 harness (attach mode, in-process
// fake bridge); nothing spawns, nothing leaves 127.0.0.1.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { CONSENT_VERSIONS } from '../../src/shared/types.ts';

/** A first run: no disclosure accepted, onboarding on its welcome step, never paired. */
const FRESH_PROFILE = { whatsappTos: false, onboardingDone: false, paired: false };

/** The attached launcher polls /api/health and /api/pairing/status on the injected clock; one advance() fires at most
 *  one tick, so reaching a settled phase takes a few of them. */
async function poll(harness: Harness, ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) await harness.advance(20_000);
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

describe('consent:accept(whatsapp_tos) on a fresh profile', () => {
  it('starts the bridge without a restart (the app could never pair before this)', async () => {
    h = await createHarness({ profile: FRESH_PROFILE, pairing: 'qr_pending' });

    // Precondition of the defect: start() ran, but with no consent the launcher refused and stayed 'not_started'.
    expect(h.app.started()).toBe(true);
    expect(h.repos.consents.isCurrent('whatsapp_tos')).toBe(false);
    expect(h.health().whatsapp.state).toBe('not_started');
    await poll(h, 2);
    expect(h.health().whatsapp.state).toBe('not_started'); // and time alone does not change that

    const res = await h.invoke('consent:accept', { kind: 'whatsapp_tos', version: CONSENT_VERSIONS.whatsapp_tos });
    expect(res.ok).toBe(true);
    expect(h.repos.consents.isCurrent('whatsapp_tos')).toBe(true);

    // The side effect is deliberately not awaited by the handler (the renderer must get its consent record back at
    // once), so give the launcher two virtual seconds: the bridge must have left 'not_started' on its own.
    await h.advance(1_000);
    await h.advance(1_000);
    expect(h.health().whatsapp.state).not.toBe('not_started');

    // ...and it carries on to the pairing phase with nobody calling start() again: the wizard can show the QR.
    // (Attach mode maps /api/health to online/reconnecting only; the QR phase comes from the pairing poller, which is
    // exactly what the Link-WhatsApp panel reads through pairing:get.)
    await poll(h);
    expect(h.health().whatsapp.state).not.toBe('not_started');
    expect(h.health().whatsapp.code).not.toBe('WA_TOS_REQUIRED');
    const pairing = await h.invoke('pairing:get', undefined);
    expect(pairing.ok && pairing.value.status).toBe('qr_pending');
    expect(
      h.pushes.some((p) => p.event === 'pairing' && (p.payload as { status: string }).status === 'qr_pending'),
    ).toBe(true);
    expect(h.logs.some((l) => l.includes('bridge_start_after_consent_failed'))).toBe(false);
  });

  it('is idempotent: accepting the disclosure again neither fails nor disturbs the running bridge', async () => {
    h = await createHarness({ profile: FRESH_PROFILE, pairing: 'connected' });
    expect(h.health().whatsapp.state).toBe('not_started');

    const first = await h.invoke('consent:accept', { kind: 'whatsapp_tos', version: CONSENT_VERSIONS.whatsapp_tos });
    expect(first.ok).toBe(true);
    await poll(h);
    expect(h.health().whatsapp.state).toBe('online');
    const onlineSince = h.repos.meta.get('last_online_ts');

    const again = await h.invoke('consent:accept', { kind: 'whatsapp_tos', version: CONSENT_VERSIONS.whatsapp_tos });
    expect(again.ok).toBe(true);
    await poll(h);
    expect(h.health().whatsapp.state).toBe('online');
    // No edge away from online happened in between (compose writes meta.last_online_ts on every such edge).
    expect(h.repos.meta.get('last_online_ts')).toBe(onlineSince);
    expect(h.logs.some((l) => l.includes('bridge_start_after_consent_failed'))).toBe(false);
  });

  it('only the WhatsApp disclosure starts the bridge: a cloud consent leaves it not_started', async () => {
    h = await createHarness({ profile: { ...FRESH_PROFILE, cloudConsent: false }, pairing: 'qr_pending' });
    expect(h.health().whatsapp.state).toBe('not_started');

    const res = await h.invoke('consent:accept', { kind: 'cloud_claude', version: CONSENT_VERSIONS.cloud_claude });
    expect(res.ok).toBe(true);
    await poll(h);

    expect(h.repos.consents.isCurrent('whatsapp_tos')).toBe(false);
    expect(h.health().whatsapp.state).toBe('not_started');
  });

  it('a rejected consent (stale version) starts nothing', async () => {
    h = await createHarness({ profile: FRESH_PROFILE, pairing: 'qr_pending' });

    // The request schema only admits positive integers, so the "wrong version" the handler rejects with BAD_REQUEST
    // ([R2] in src/shared/ipc.ts) is the current one plus one.
    const res = await h.invoke('consent:accept', {
      kind: 'whatsapp_tos',
      version: CONSENT_VERSIONS.whatsapp_tos + 1,
    });
    expect(res.ok).toBe(false);
    await poll(h);

    expect(h.repos.consents.isCurrent('whatsapp_tos')).toBe(false);
    expect(h.health().whatsapp.state).toBe('not_started');
  });
});
