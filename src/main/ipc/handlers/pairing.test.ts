// TESTS 5.3 `ipc/*`: `pairing:relink` / `pairing:unlinkAndWipe` need `confirm: true` (schema-enforced, proven here against
// the real schema) and the handler passes NO path of any kind - the launcher owns the documented store paths.
import { describe, expect, it } from 'vitest';
import { IPC_REQUEST_SCHEMAS } from '../../../shared/ipc';
import type { PairingState } from '../../../shared/health';
import { makeFixture, NOW_0 } from '../register.fixtures';
import { createPairingHandlers } from './pairing';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

/** Records which launcher method ran; every one of them takes no argument, so nothing renderer-supplied can travel. */
function recordingLauncher(f: ReturnType<typeof makeFixture>, state: () => PairingState): string[] {
  const calls: string[] = [];
  for (const op of ['restartForNewCode', 'relink', 'unlinkAndWipe'] as const) {
    f.deps.launcher[op] = async (...args: unknown[]) => {
      calls.push(`${op}(${args.length})`);
    };
  }
  f.deps.launcher.pairing = state;
  return calls;
}

describe('confirmation is part of the contract, not the handler', () => {
  it('relink and unlinkAndWipe accept ONLY { confirm: true }', () => {
    for (const channel of ['pairing:relink', 'pairing:unlinkAndWipe'] as const) {
      const schema = IPC_REQUEST_SCHEMAS[channel];
      expect(schema.safeParse({ confirm: true }).success, channel).toBe(true);
      expect(schema.safeParse({ confirm: false }).success, channel).toBe(false);
      expect(schema.safeParse({}).success, channel).toBe(false);
      expect(schema.safeParse(undefined).success, channel).toBe(false);
      // No path, no JID, no "force" escape hatch can ride along.
      expect(schema.safeParse({ confirm: true, storeDir: 'C:\\Users\\x\\store' }).success, channel).toBe(false);
    }
  });

  it('pairing:get and pairing:newCode take no request at all', () => {
    for (const channel of ['pairing:get', 'pairing:newCode'] as const) {
      expect(IPC_REQUEST_SCHEMAS[channel].safeParse(undefined).success, channel).toBe(true);
      expect(IPC_REQUEST_SCHEMAS[channel].safeParse({ confirm: true }).success, channel).toBe(false);
    }
  });
});

describe('pairing handlers', () => {
  it('pairing:get reads the launcher snapshot and touches nothing else', async () => {
    const f = makeFixture();
    const qr: PairingState = {
      status: 'qr_pending',
      qrDataUrl: 'data:image/png;base64,AAA=',
      expiresAt: NOW_0 + 60_000,
    };
    const calls = recordingLauncher(f, () => qr);
    expect(await createPairingHandlers(f.deps)['pairing:get'](undefined, CTX)).toEqual({ ok: true, value: qr });
    expect(calls).toEqual([]);
    expect(f.rec.audits).toEqual([]);
  });

  it('pairing:newCode restarts the bridge and answers with the fresh state; it is not audited', async () => {
    const f = makeFixture();
    let state: PairingState = { status: 'connecting' };
    const calls = recordingLauncher(f, () => state);
    f.deps.launcher.restartForNewCode = async () => {
      calls.push('restartForNewCode(0)');
      state = { status: 'qr_pending', qrDataUrl: 'data:image/png;base64,BBB=' };
    };
    const res = await createPairingHandlers(f.deps)['pairing:newCode'](undefined, CTX);
    expect(res).toEqual({ ok: true, value: { status: 'qr_pending', qrDataUrl: 'data:image/png;base64,BBB=' } });
    expect(calls).toEqual(['restartForNewCode(0)']);
    expect(f.rec.audits).toEqual([]);
  });

  it('pairing:relink calls relink() with no argument and audits `relink`', async () => {
    const f = makeFixture();
    const calls = recordingLauncher(f, () => ({ status: 'qr_pending' }));
    const res = await createPairingHandlers(f.deps)['pairing:relink']({ confirm: true }, CTX);
    expect(res).toEqual({ ok: true, value: { status: 'qr_pending' } });
    expect(calls).toEqual(['relink(0)']);
    expect(f.rec.audits).toEqual([{ kind: 'relink', ref: null, detail: {}, now: NOW_0 }]);
  });

  it('pairing:unlinkAndWipe calls unlinkAndWipe() with no argument and audits `wipe`', async () => {
    const f = makeFixture();
    const calls = recordingLauncher(f, () => ({ status: 'logged_out' }));
    const res = await createPairingHandlers(f.deps)['pairing:unlinkAndWipe']({ confirm: true }, CTX);
    expect(res).toEqual({ ok: true, value: { status: 'logged_out' } });
    expect(calls).toEqual(['unlinkAndWipe(0)']);
    expect(f.rec.audits).toEqual([{ kind: 'wipe', ref: null, detail: {}, now: NOW_0 }]);
    // The audit detail carries no path, so a log line can never name the store directory.
    expect(JSON.stringify(f.rec.audits)).not.toMatch(/store|[A-Za-z]:\\\\/);
  });
});
