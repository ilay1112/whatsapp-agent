// tests/integration/fake-bridge-control.test.ts - the fake bridge's child-mode control server (TESTS 3.1 / 4.2).
// JSON carries no Date: a `ts` sent over `POST /__control/<verb>` arrives as an ISO string or an epoch number, and the
// fake must revive it before `db.formatTs()` sees it (repair-test-fakes hand-off: `inbound` and `outboundFromPhone`
// used to cast the parsed JSON straight to their parameter types). The child here is the system `node` running
// tests/fakes/fake-bridge.ts, exactly as `WCA_BRIDGE_CMD` does in e2e; nothing else is spawned, nothing leaves loopback.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { reviveDate } from '../fakes/fake-bridge.ts';

const FAKE_BRIDGE_TS = fileURLToPath(new URL('../fakes/fake-bridge.ts', import.meta.url));
const CHAT = '972550000031@s.whatsapp.net';
const ISO_TS = '2026-09-21T17:15:03.120Z';
const EPOCH_TS = Date.UTC(2026, 8, 22, 8, 30, 0, 0);

describe('reviveDate', () => {
  it('passes a Date through untouched', () => {
    const d = new Date(ISO_TS);
    expect(reviveDate(d)).toBe(d);
  });
  it('revives an ISO string and an epoch number to the same instant', () => {
    expect(reviveDate(ISO_TS).getTime()).toBe(Date.parse(ISO_TS));
    expect(reviveDate(EPOCH_TS).getTime()).toBe(EPOCH_TS);
  });
  it('rejects anything that is not a timestamp, naming the value', () => {
    for (const bad of ['nope', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, true]) {
      expect(() => reviveDate(bad)).toThrow(/fake-bridge control: not a timestamp/);
    }
    expect(() => reviveDate('nope')).toThrow('"nope"');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// child mode round trip
// ---------------------------------------------------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => (port > 0 && port !== 8080 ? resolve(port) : reject(new Error('no usable port'))));
    });
  });
}

interface BridgeChild {
  proc: ChildProcess;
  storeDir: string;
  output: string[];
  control(verb: string, body?: unknown): Promise<{ status: number; body: string }>;
  exited: Promise<number | null>;
}

const SECRET = 'a'.repeat(64);

async function startChild(cwd: string): Promise<BridgeChild> {
  const port = await freePort();
  const output: string[] = [];
  const proc = spawn(process.execPath, [FAKE_BRIDGE_TS, '--control-port', String(port), '--control-secret', SECRET], {
    cwd,
    env: { ...process.env, TZ: 'UTC', WHATSAPP_BRIDGE_PORT: '0', WHATSAPP_BRIDGE_TOKEN: 'b'.repeat(64) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (c: Buffer) => output.push(c.toString('utf8')));
  proc.stderr?.on('data', (c: Buffer) => output.push(c.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));

  const control = async (verb: string, body?: unknown): Promise<{ status: number; body: string }> => {
    const res = await fetch(`http://127.0.0.1:${port}/__control/${verb}`, {
      method: 'POST',
      headers: { 'X-Control-Secret': SECRET, 'Content-Type': 'application/json' },
      body: body === undefined ? '' : JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };

  // Wait (bounded, real time - the child is a real process) until the control server answers at all.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__control/ping`, { method: 'POST' });
      void res.body?.cancel().catch(() => undefined);
      break; // any answer (a 404 without the secret) means the socket is up
    } catch {
      if (proc.exitCode !== null) throw new Error(`fake bridge child exited early:\n${output.join('')}`);
      if (Date.now() > deadline) throw new Error(`fake bridge control port never came up:\n${output.join('')}`);
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }
  return { proc, storeDir: join(cwd, 'store'), output, control, exited };
}

function readRows(storeDir: string): Array<{ id: string; content: string; timestamp: string; is_from_me: number }> {
  const ro = new DatabaseSync(join(storeDir, 'messages.db'), { readOnly: true });
  try {
    return ro.prepare('SELECT id, content, timestamp, is_from_me FROM messages ORDER BY rowid').all() as Array<{
      id: string;
      content: string;
      timestamp: string;
      is_from_me: number;
    }>;
  } finally {
    ro.close();
  }
}

/** go-sqlite3 writes `YYYY-MM-DD HH:MM:SS[.fff][+HH:MM|Z]`; only the instant matters here. */
const instantOf = (goTs: string): number => Date.parse(goTs.replace(' ', 'T'));

let child: BridgeChild | null = null;
let cwd: string | null = null;
afterEach(async () => {
  if (child !== null && child.proc.exitCode === null) {
    try {
      await child.control('exit');
    } catch {
      child.proc.kill();
    }
    await child.exited;
  }
  child = null;
  if (cwd !== null) rmSync(cwd, { recursive: true, force: true });
  cwd = null;
});

describe('child-mode control verbs revive a JSON timestamp', () => {
  it('inbound / outboundFromPhone with ts as ISO string or epoch number store the right instant', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'wca-fake-bridge-child-'));
    child = await startChild(cwd);

    const inbound = await child.control('inbound', { chatJid: CHAT, text: 'free thursday?', ts: ISO_TS });
    expect(inbound, inbound.body).toMatchObject({ status: 200 });
    expect(JSON.parse(inbound.body)).toMatchObject({ id: expect.any(String), rowid: expect.any(Number) });

    const outbound = await child.control('outboundFromPhone', { chatJid: CHAT, text: 'yes', ts: EPOCH_TS });
    expect(outbound, outbound.body).toMatchObject({ status: 200 });
    expect(JSON.parse(outbound.body)).toMatchObject({ id: expect.any(String) });

    // A verb without ts still works (the fake picks its own "now").
    const plain = await child.control('inbound', { chatJid: CHAT, text: 'ok' });
    expect(plain, plain.body).toMatchObject({ status: 200 });

    const rows = readRows(child.storeDir);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ content: 'free thursday?', is_from_me: 0 });
    expect(instantOf(rows[0]!.timestamp)).toBe(Date.parse(ISO_TS));
    expect(rows[1]).toMatchObject({ content: 'yes', is_from_me: 1 });
    expect(instantOf(rows[1]!.timestamp)).toBe(EPOCH_TS);
    expect(rows[2]).toMatchObject({ content: 'ok', is_from_me: 0 });
    expect(Number.isNaN(instantOf(rows[2]!.timestamp))).toBe(false);

    // The child never died along the way and still serves the orderly exit (TESTS bridge-contract: exit code 0).
    const exit = await child.control('exit');
    expect(exit.status).toBe(200);
    expect(await child.exited).toBe(0);
  });

  it('a malformed ts fails the CALLING request with 500 and leaves the child alive', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'wca-fake-bridge-child-'));
    child = await startChild(cwd);

    const bad = await child.control('inbound', { chatJid: CHAT, text: 'x', ts: 'nope' });
    expect(bad.status).toBe(500);
    expect(JSON.parse(bad.body)).toMatchObject({ error: expect.stringContaining('not a timestamp') });
    const badOut = await child.control('outboundFromPhone', { chatJid: CHAT, text: 'x', ts: { nested: true } });
    expect(badOut.status).toBe(500);
    expect(readRows(child.storeDir)).toHaveLength(0);

    const exit = await child.control('exit');
    expect(exit.status).toBe(200);
    expect(await child.exited).toBe(0);
  });
});
