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

// ======================= [V2 ADD] dependency-injection seams of v2-tests 4.3 (V2-W0-scaffold; frozen in Wave 1) =======================
// Types only. Production values are built in compose.ts (the only file besides app/** that may touch `electron`); tests inject doubles.

/** S-IMAGE: the `nativeImage` facade media/normalizeImage.ts receives (never an import of electron). Bytes in, JPEG bytes out. */
export interface ImageHandle {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(opts: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): ImageHandle;
  toJPEG(quality: number): Uint8Array;
}
export interface ImageFacade {
  /** nativeImage.createFromBuffer; an undecodable buffer yields an empty handle (isEmpty() === true), never a throw. */
  fromBuffer(bytes: Uint8Array): ImageHandle;
}

/** S-OPUS: decoder factory for voice/decode.ts (real opus-decoder@0.7.12 in production and in every test except two). */
export interface OpusFrameDecoder {
  readonly ready: Promise<void>;
  decodeFrame(frame: Uint8Array): {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
    errors: unknown[];
  };
  free(): void;
}
export type OpusDecoderFactory = (opts: {
  channels: number;
  preSkip: number;
  sampleRate: 16000 | 48000;
}) => OpusFrameDecoder;

/** S-DIALOG: electron dialog.showMessageBox as a function value (app/autoDialog.ts, the agy workspace dialog). */
export interface MessageBoxOptionsLike {
  type: 'none' | 'info' | 'error' | 'question' | 'warning';
  title?: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink?: boolean;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
}
export type ShowMessageBoxFn = (
  window: unknown,
  options: MessageBoxOptionsLike,
) => Promise<{ response: number; checkboxChecked: boolean }>;

/** S-CONSOLE: opens the vendor's own sign-in in a VISIBLE console (cli:signIn); the exe is spawned directly, never cmd.exe (F7). */
export type OpenVisibleConsoleFn = (exePath: string, args: readonly string[], opts: { cwd?: string }) => Promise<void>;

/** S-HOME: the home directory the agy workspace-trust handler resolves `~/.gemini/...` against (tests: mkdtemp). */
export type HomeDirFn = () => string;
/** S-PROC: "is an agy process running" query (refuses cli:allowWorkspace while true). */
export type AgyRunningFn = () => Promise<boolean>;

/** S-LOCATE: the CLI locator's view of the disk and PATH (tests: mkdtemp layouts; e2e: never probes the real disk). */
export interface LocateDeps {
  statFile(p: string): { isFile: boolean } | null;
  env: Readonly<Record<string, string | undefined>>;
  /** `where.exe <name>` - production only; NEVER called in tests or in e2e mode (T8). */
  runWhere(name: string): Promise<string[]>;
}

/** S-JOB: process primitives of proc/jobRunner.ts, llm/cli/runner.ts and voice/whisperCli.ts. */
export interface JobProcessDeps {
  spawn: SpawnFn;
  killPid(pid: number, tree: boolean): Promise<void>;
  queryProcess: ProcessQuery;
  setPriority(pid: number, priority: 'below_normal'): void;
  cpuCount(): number;
}
