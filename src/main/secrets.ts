// src/main/secrets.ts - SecretStore over safeStorage (DPAPI) + repos.secrets (build-plan section 3; owner W1-12).
// One of the five files allowed to import `electron` (build-plan rule 10); it takes safeStorage by injection instead, so
// nothing here loads `electron` under vitest. The plaintext key leaves this module ONLY through get(), for llm/factory.ts.
import type { SafeStorageLike } from './deps';
import type { Repos } from './db/index';
import type { KeyStatus, Result, SecretName } from '../shared/types';

export interface SecretStore {
  /** Validates (printable ASCII, 8-512 chars), encrypts with safeStorage, stores the ciphertext. KEY_MISSING when encryption is unavailable. */
  set(name: SecretName, value: string): Promise<Result<KeyStatus>>;
  /** Plain text for the provider factory ONLY; never crosses IPC, never logged. null when absent or undecryptable. */
  get(name: SecretName): Promise<string | null>;
  has(name: SecretName): KeyStatus;
  clear(name: SecretName): KeyStatus;
}
export interface SecretStoreDeps {
  repos: Pick<Repos, 'secrets'>;
  safeStorage: SafeStorageLike;
}

export const SECRET_MIN_CHARS = 8;
export const SECRET_MAX_CHARS = 512;
/** Printable ASCII only: an API key with whitespace or a control character is a paste accident, not a key. */
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

const ABSENT: KeyStatus = { present: false, last4: '' };
const statusOf = (plain: string): KeyStatus => ({ present: true, last4: plain.slice(-4) });

/** True when the "ciphertext" is just the plaintext bytes - a broken safeStorage double must never reach the database. */
function looksLikePlaintext(cipher: Uint8Array, plain: string): boolean {
  const raw = Buffer.from(plain, 'utf8');
  return cipher.length === raw.length && Buffer.from(cipher).equals(raw);
}

// ARCHITECTURE 390 / TESTS 5.3 want the ASYNC safeStorage API, but the frozen `SafeStorageLike` seam (deps.ts, W0) types
// decryptString synchronously and `has()` is a synchronous call. So this module accepts BOTH shapes of facade:
// a bare string (safeStorage.decryptString) and a thenable (safeStorage.decryptStringAsync, which in Electron 44
// resolves to `{ shouldReEncrypt, result }` rather than a bare string). Nothing here ever assumes one of them.
type DecryptResult = string | { result: string } | Promise<string | { result: string }>;

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/** Unwraps a settled decrypt result of either API; null for anything that is not a non-empty string. */
function plainOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'object' && value !== null) {
    const inner = (value as { result?: unknown }).result;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return null;
}

export function createSecretStore(deps: SecretStoreDeps): SecretStore {
  const { repos, safeStorage } = deps;

  // last4 of every plaintext this store has seen, keyed by name and pinned to the exact ciphertext it came from.
  // ONLY the synchronous has() reads it: with an async facade it cannot await, so it answers from the memo instead
  // of blowing up on a Promise. A changed ciphertext invalidates the entry, so a stale last4 is never served.
  const seen = new Map<SecretName, { cipher: Buffer; last4: string }>();
  const remember = (name: SecretName, cipher: Uint8Array, plain: string): void => {
    seen.set(name, { cipher: Buffer.from(cipher), last4: plain.slice(-4) });
  };
  const recall = (name: SecretName, cipher: Buffer): string | null => {
    const hit = seen.get(name);
    return hit && hit.cipher.equals(cipher) ? hit.last4 : null;
  };

  /** The stored ciphertext, or null when nothing decryptable is stored (absent, empty, or encryption unavailable). */
  const cipherOf = (name: SecretName): Buffer | null => {
    const raw = repos.secrets.get(name);
    if (!raw || raw.length === 0) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return Buffer.from(raw);
  };

  /** Decrypts; every failure mode (unavailable, corrupt blob, wrong Windows user) is "key missing", never a throw. */
  const decrypt = async (name: SecretName): Promise<string | null> => {
    const cipher = cipherOf(name);
    if (cipher === null) return null;
    let settled: unknown;
    try {
      settled = await (safeStorage.decryptString(cipher) as DecryptResult);
    } catch {
      return null;
    }
    const plain = plainOf(settled);
    if (plain !== null) remember(name, cipher, plain);
    return plain;
  };

  return {
    async set(name, value) {
      if (typeof value !== 'string' || value.length < SECRET_MIN_CHARS || value.length > SECRET_MAX_CHARS) {
        return { ok: false, error: { code: 'BAD_REQUEST', params: { min: SECRET_MIN_CHARS, max: SECRET_MAX_CHARS } } };
      }
      if (!PRINTABLE_ASCII_RE.test(value)) return { ok: false, error: { code: 'BAD_REQUEST' } };
      if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: { code: 'KEY_MISSING' } };
      let cipher: Uint8Array;
      try {
        // `await` so a facade built on the async safeStorage API (encryptStringAsync) works unchanged.
        cipher = await (safeStorage.encryptString(value) as Buffer | Promise<Buffer>);
      } catch {
        return { ok: false, error: { code: 'KEY_MISSING' } };
      }
      if (!cipher || cipher.length === 0 || looksLikePlaintext(cipher, value)) {
        return { ok: false, error: { code: 'KEY_MISSING' } };
      }
      repos.secrets.put(name, cipher);
      remember(name, cipher, value);
      return { ok: true, value: statusOf(value) };
    },

    async get(name) {
      return decrypt(name);
    },

    has(name) {
      const cipher = cipherOf(name);
      if (cipher === null) {
        seen.delete(name);
        return ABSENT;
      }
      let settled: unknown;
      try {
        settled = safeStorage.decryptString(cipher);
      } catch {
        return ABSENT;
      }
      if (isThenable(settled)) {
        // Async facade: warm the memo for the next call and never leave the rejection floating (an unhandled
        // rejection in main is a crash). The status itself comes from what this store has already seen.
        void settled.then(
          (value) => {
            const plain = plainOf(value);
            if (plain !== null) remember(name, cipher, plain);
          },
          () => {},
        );
        return { present: true, last4: recall(name, cipher) ?? '' };
      }
      const plain = plainOf(settled);
      if (plain === null) return ABSENT;
      remember(name, cipher, plain);
      return statusOf(plain);
    },

    clear(name) {
      repos.secrets.delete(name);
      seen.delete(name);
      return ABSENT;
    },
  };
}
