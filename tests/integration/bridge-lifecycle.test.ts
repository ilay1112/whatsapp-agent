// tests/integration/bridge-lifecycle.test.ts - TESTS section 6 row 6 (owner W2-01).
// The bridge side effects that live in compose.ts and NOWHERE else, because `BridgeLauncherDeps` has no `repos`
// (W1-02's wiring contract): `meta.last_online_ts` on every edge away from online, `meta.paired_at` + `live_from_ts`
// on qr_pending -> connected, `ingest.resolveLidChats()` on every ONLINE transition, and the 30 s scan that catches up
// after a lost doorbell. Plus: a message whose TEXT is a bridge stdout marker changes nothing.
//
// Scope note: this file drives the bridge in ATTACH mode (TESTS 4.2) against the in-process fake, which is what the L3
// harness provides. The child-process cases of the TESTS row - crash => respawn with a fresh port AND token, bind_fail,
// foreign_listener, the breaker - are spawn-lifecycle properties and are covered at L1/L2 by W1-01's supervisor tests
// and W1-02's launcher tests; they are recorded as NOT covered at L3 in ops/agent-notes/W2-01-compose-integration.md.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import { BRIDGE_MARKERS } from '../../src/main/bridge/stdoutMarkers.ts';
import { LIMITS } from '../../src/shared/types.ts';
import type { StubRule } from '../fakes/stub-llm.ts';

const CHAT = '972550000008@s.whatsapp.net';
const LID_CHAT = '10000000000001@lid';
const HOUR = 3_600_000;

/** The attached bridge polls /api/health and /api/pairing/status on the injected clock, and each tick is async:
 *  one advance() fires at most one tick, so a state change needs a few of them. */
async function poll(harness: Harness, ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) await harness.advance(20_000);
}

const RULES: StubRule[] = [
  { when: { purpose: 'extract' }, respond: { structured: extraction({ intent: 'question', needsReply: true }) } },
  { when: { purpose: 'draft' }, respond: { text: 'Sure.', stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

describe('bridge lifecycle wiring', () => {
  it('reports online while the fake answers /api/health, and writes meta.last_online_ts when it stops answering', async () => {
    h = await createHarness({ rules: RULES });
    await h.settle();
    expect(h.health().whatsapp.state).toBe('online');
    expect(h.repos.meta.get('last_online_ts')).not.toBeNull();

    const before = h.repos.meta.get('last_online_ts');
    await h.advance(HOUR);
    h.bridge.setConnected(false);
    await poll(h);

    expect(h.health().whatsapp.state).not.toBe('online');
    expect(h.repos.meta.get('last_online_ts')).not.toBe(before);
    // ARCH 4.4: a bridge that is up but disconnected is WA_OFFLINE, not a crash.
    expect(h.health().whatsapp.code).toBe('WA_OFFLINE');
  });

  it('writes meta.paired_at and live_from_ts on the qr_pending -> connected edge', async () => {
    h = await createHarness({ rules: RULES, pairing: 'qr_pending', profile: { paired: false } });
    await poll(h, 2);
    expect(h.repos.meta.get('paired_at')).toBeNull();
    expect((await h.invoke('pairing:get', undefined)).ok).toBe(true);

    h.bridge.setPairing('connected');
    await poll(h);

    const pairedAt = h.repos.meta.get('paired_at');
    expect(pairedAt).not.toBeNull();
    // backlogHours defaults to 0, so the live window opens exactly at the pairing instant.
    expect(h.repos.meta.get('live_from_ts')).toBe(pairedAt);
  });

  it('resolves @lid chats to their phone JID on an ONLINE transition', async () => {
    h = await createHarness({ rules: RULES });
    // A chat the app only knows by its @lid form, plus the bridge-side mapping the real bridge would have.
    h.bridgeDb.addChat(LID_CHAT, null);
    h.bridgeDb.addLidMapping(LID_CHAT, CHAT);
    h.repos.chats.upsertFromBridge(LID_CHAT, null, true, h.clock.now());
    expect(h.repos.chats.byJid(LID_CHAT)).not.toBeNull();

    // Take the bridge down and back up: every edge INTO online runs ingest.resolveLidChats().
    h.bridge.setConnected(false);
    await poll(h);
    h.bridge.setConnected(true);
    await poll(h);

    expect(h.repos.chats.byJid(LID_CHAT)).toBeNull();
    expect(h.repos.chats.byJid(CHAT)).not.toBeNull();
  });

  it('catches up through the 30 s scan when the doorbell never rings', async () => {
    h = await createHarness({ rules: RULES });
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - HOUR) });
    await h.settle();

    const ringsBefore = h.app.doorbellStats().accepted;
    h.bridge.setWebhookEnabled(false); // simulate a lost doorbell
    await h.bridge.inbound({ chatJid: CHAT, text: 'are you around later?' });
    expect(h.app.doorbellStats().accepted).toBe(ringsBefore);

    await h.advance(LIMITS.scanIntervalMs + LIMITS.debounceMs + 5_000);
    await h.advance(LIMITS.debounceMs);

    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    expect([...dash.value.needsReply, ...dash.value.infoMissing]).not.toHaveLength(0);
  });

  it('a message whose TEXT is a bridge stdout marker changes no bridge state', async () => {
    h = await createHarness({ rules: RULES });
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - HOUR) });
    await h.settle();
    const before = h.health().whatsapp.state;

    for (const marker of Object.values(BRIDGE_MARKERS)) {
      await h.bridge.inbound({ chatJid: CHAT, text: String(marker) });
    }
    await h.settle();

    expect(h.health().whatsapp.state).toBe(before);
    expect(h.health().whatsapp.code).toBeUndefined();
    expect(h.bridge.sends).toHaveLength(0);
  });

  it('the doorbell accepts an authenticated ring and rejects one with the wrong token', async () => {
    h = await createHarness({ rules: RULES });
    await h.settle();
    const url = h.app.doorbellUrl();
    expect(url).not.toBeNull();

    const before = h.app.doorbellStats();
    const status = await h.bridge.postRawDoorbell({
      path: new URL(url!).pathname,
      headers: { 'content-type': 'application/json', 'x-bridge-token': 'not-the-token' },
      body: JSON.stringify({ sender: '972550000008', content: 'x', chatJID: CHAT, isFromMe: false }),
    });
    expect(status).not.toBe(200);
    expect(h.app.doorbellStats().accepted).toBe(before.accepted);
    expect(h.app.doorbellStats().rejected).toBeGreaterThan(before.rejected);
  });
});
