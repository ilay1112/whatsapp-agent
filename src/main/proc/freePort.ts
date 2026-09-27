// src/main/proc/freePort.ts - free loopback port (build-plan section 3; owner W1-01). Never returns 8080 (the user's other bridge).
import net from 'node:net';

export const NEVER_PORTS: readonly number[] = [8080];

/** Default number of binds attempted before giving up (a machine that hands out 8080 twenty times in a row is broken). */
export const FREE_PORT_MAX_ATTEMPTS = 20;

/** One candidate-port attempt. Production binds 127.0.0.1:0 exclusively; tests inject a scripted sequence (TESTS 5.3). */
export type ListenForPort = () => Promise<number>;

/**
 * `exclude` is the frozen option (CONTRACTS / wave0-seams section 9). `listen` and `maxAttempts` are additive, optional
 * test seams: every caller written against `{ exclude?: number[] }` keeps compiling and behaves identically.
 */
export interface FreePortOpts {
  exclude?: number[];
  listen?: ListenForPort;
  maxAttempts?: number;
}

/** Binds 127.0.0.1:0 exclusively, reads the port, closes. */
const bindEphemeral: ListenForPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    server.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      server.close();
      reject(err);
    });
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((closeErr) => {
        if (settled) return;
        settled = true;
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });

/** Binds 127.0.0.1:0 exclusively, reads the port, closes; retries when the port is 8080 or in `exclude`. */
export async function freePort(opts: FreePortOpts = {}): Promise<number> {
  const blocked = new Set<number>([...NEVER_PORTS, ...(opts.exclude ?? [])]);
  const listen = opts.listen ?? bindEphemeral;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? FREE_PORT_MAX_ATTEMPTS);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = await listen();
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
    if (blocked.has(port)) continue;
    return port;
  }
  throw new Error(`freePort: no usable loopback port after ${maxAttempts} attempts`);
}
