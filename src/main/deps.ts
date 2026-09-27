// src/main/deps.ts - injected collaborator types (build-plan 1.3 / section 3, owner W0, frozen in Wave 1).
// Every module outside the Electron shell takes these by injection (TESTS 4.3: S-CLOCK, S-RAND, S-SPAWN, S-FETCH, S-LOG ...).
// Nothing in this file imports `electron`; the ElectronFacade is implemented in compose.ts (W2-01) and by tests/mocks/electron.ts.
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { EpochMs, Lang } from '../shared/types';

/** S-CLOCK. `now()` is EpochMs; timers are virtual in tests (tests/helpers/virtualClock.ts). */
export interface Clock {
  now(): EpochMs;
  setTimeout(fn: () => void, ms: number): ClockTimer;
  clearTimeout(t: ClockTimer): void;
}
/** Opaque timer handle (a real NodeJS.Timeout in production, an integer id in the virtual clock). */
export type ClockTimer = { readonly __clockTimer: true } | ReturnType<typeof globalThis.setTimeout> | number;

/** S-RAND. `bytes(n)` = crypto-quality bytes in production; deterministic in tests. */
export interface RandomSource {
  bytes(n: number): Uint8Array;
  /** Integer in [min, max) like node:crypto randomInt. */
  int(min: number, max: number): number;
  /** Float in [0, 1). */
  float(): number;
}

/** S-LOG. Metadata only: never message text, names, JIDs, tokens, keys or paths under userData (logger.ts redacts as a second line of defence). */
export type LogMeta = Record<string, string | number | boolean | null | undefined>;
export interface Logger {
  info(event: string, meta?: LogMeta): void;
  warn(event: string, meta?: LogMeta): void;
  error(event: string, meta?: LogMeta): void;
  child(scope: string): Logger;
}

/** S-SPAWN. Production: node:child_process.spawn. Tests: the fake child / a recorder. `shell` is never true. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** S-FETCH. Production: globalThis.fetch. Tests: loopback fakes or a recorder. */
export type FetchFn = typeof globalThis.fetch;

/** Process lookup / kill by PID only (never by image name). Used by proc/reaper.ts and proc/supervisor.ts. */
export interface ProcessInfo {
  pid: number;
  executablePath: string | null;
  /** Win32_Process.CreationDate as EpochMs, null when unavailable. */
  creationDate: EpochMs | null;
}
export interface ProcessQuery {
  query(pid: number): Promise<ProcessInfo | null>;
  /** `taskkill /PID <pid> /F` (+ `/T` when tree is true), shell:false. Resolves when the command exited. */
  kill(pid: number, tree: boolean): Promise<void>;
}

/** The small slice of Electron that non-shell modules need, behind an interface so vitest never loads `electron`. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}
export interface ElectronFacade {
  safeStorage: SafeStorageLike;
  /** Only ever called with a URL from resources/links.json or the app-built calendar day link (ARCHITECTURE section 11). */
  openExternal(url: string): Promise<void>;
  clipboardWrite(text: string): void;
  /** Native file picker opened IN MAIN; returns the chosen file's text content (never a path to the renderer) or null when cancelled. */
  showOpenDialog(opts: {
    title: string;
    filters: Array<{ name: string; extensions: string[] }>;
    maxBytes: number;
  }): Promise<string | null>;
  /** Native save dialog opened IN MAIN; returns the chosen path or null when cancelled. */
  showSaveDialog(opts: { title: string; defaultFileName: string }): Promise<string | null>;
  /** Windows toast; title/body come from locale keys only (never message text or names). */
  notify(title: string, body: string): void;
  setLoginItem(opts: { openAtLogin: boolean; args: readonly string[] }): void;
  /** app.getPreferredSystemLanguages(): BCP-47 tags, most preferred first. */
  preferredLanguages(): string[];
}

/** Convenience: the UI language pair resolved once in main and pushed to the renderer. */
export interface UiLanguage {
  lang: Lang;
  dir: 'ltr' | 'rtl';
}
