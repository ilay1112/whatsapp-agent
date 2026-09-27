// src/main/proc/freePort.test.ts - TESTS 5.3 row `proc/freePort.ts` (owner W1-01).
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { FREE_PORT_MAX_ATTEMPTS, NEVER_PORTS, freePort } from './freePort';

const scripted = (...ports: number[]): (() => Promise<number>) => {
  let i = 0;
  return () => Promise.resolve(ports[Math.min(i++, ports.length - 1)] ?? 0);
};

describe('freePort', () => {
  it('never returns 8080 - the injected listener yields it first', async () => {
    expect(NEVER_PORTS).toContain(8080);
    const listen = scripted(8080, 8080, 51234);
    await expect(freePort({ listen })).resolves.toBe(51234);
  });

  it('skips every port in `exclude`', async () => {
    const listen = scripted(40001, 40002, 40003);
    await expect(freePort({ exclude: [40001, 40002], listen })).resolves.toBe(40003);
  });

  it('skips a listener that hands back a port outside 1..65535', async () => {
    const listen = scripted(0, -1, 70000, 40010);
    await expect(freePort({ listen })).resolves.toBe(40010);
  });

  it('gives up after maxAttempts instead of looping forever', async () => {
    const listen = scripted(8080);
    await expect(freePort({ listen, maxAttempts: 3 })).rejects.toThrow(/no usable loopback port after 3/);
  });

  it('defaults to 20 attempts', () => {
    expect(FREE_PORT_MAX_ATTEMPTS).toBe(20);
  });

  it('binds a real ephemeral loopback port and releases it again', async () => {
    const port = await freePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThanOrEqual(65_535);
    expect(port).not.toBe(8080);
    // The port was closed again, so a second call can hand out anything - including the same number.
    const second = await freePort({ exclude: [port] });
    expect(second).not.toBe(port);
  });

  it('propagates a listener failure', async () => {
    await expect(freePort({ listen: () => Promise.reject(new Error('EADDRINUSE')) })).rejects.toThrow('EADDRINUSE');
  });

  it('rejects when the real loopback bind fails', async () => {
    const closed = vi.fn();
    const spy = vi.spyOn(net, 'createServer').mockImplementation(() => {
      const server = new EventEmitter() as unknown as net.Server;
      Object.assign(server, {
        listen: () => {
          queueMicrotask(() => server.emit('error', new Error('EACCES')));
          return server;
        },
        close: closed,
        address: () => null,
      });
      return server;
    });
    try {
      await expect(freePort()).rejects.toThrow('EACCES');
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// frozen-signature conformance
// [FIX ROUND] W2-01-compose-integration asked to RATIFY OR REVERT the additive optional `listen` / `maxAttempts`. Ratified.
// ---------------------------------------------------------------------------------------------------------------------
describe('frozen-signature conformance', () => {
  /** wave0-seams section 9 pasted verbatim. Compile-time assertion: both added options must stay optional. */
  type FrozenFreePort = (opts?: { exclude?: number[] }) => Promise<number>;

  it('freePort still satisfies the verbatim wave0-seams section 9 declaration', () => {
    const frozen: FrozenFreePort = freePort;
    expect(frozen).toBe(freePort);
  });

  it('is still assignable to the consumer declaration in llm/local/llamaServer.ts', async () => {
    // `LlamaServerDeps.freePort: (opts: { exclude?: number[] }) => Promise<number>` - the only cross-package consumer type.
    const consumer: { freePort: (opts: { exclude?: number[] }) => Promise<number> } = { freePort };
    const port = await consumer.freePort({ exclude: [] });
    expect(port).toBeGreaterThan(1024);
    expect(port).not.toBe(8080);
  });
});
