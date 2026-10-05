// src/main/testSeams.ts - the ONLY module with E2E seam code (TESTS 4.1: two locks). Owner W1-12; readSeams() implemented by W0.
// Imported by compose.ts / index.ts behind `if (import.meta.env.MODE === 'e2e')` so a production build constant-folds it away
// (build-time lock); readSeams() itself returns null unless WCA_E2E === '1' && !isPackaged (run-time lock).
import type { AppHealth } from '../shared/health';
import type { DialogRecord } from './app/autoDialog';

export interface SeamCommand {
  command: string;
  args: string[];
  sha256?: string;
}
export interface SeamTimers {
  debounceMs?: number;
  debounceCapMs?: number;
  scanMs?: number;
  pairingPollMs?: number;
  healthPollMs?: number;
  sendJitterMs?: [number, number];
  googlePollMs?: number;
  coachMarkMs?: number;
  // [V2] T2 4.1 - DELAYS ONLY. Never a count or a window with safety meaning (auto budgets, perChatPerDay, the 3/h dialog
  // limit, maxRunsPerHour, breaker thresholds, shadow count, undo_until, policy expiry, taint cooldown, quiet hours, cage).
  cliStatusCacheMs?: number;
  authStatusMinIntervalMs?: number;
  mediaRetryMs?: number;
  jobGraceMs?: { cli: number; voice: number };
}
export interface SeamHardware {
  ramGiB: number;
  freeDiskGiB: number;
  gpus: Array<{ name: string; vramGiB: number | null }>;
}
export interface SeamModelEntry {
  /** [V2] widened: every MODEL_FILE_IDS entry (llm tiers, mmproj-*, voice-*) - T2 4.1 "WCA_MODEL_MANIFEST (extended)". */
  tier: import('../shared/types').ModelFileId;
  url: string;
  size: number;
  sha256: string;
  kind?: import('../shared/types').ModelFileKind; // [V2]
  magic?: 'GGUF' | 'GGML'; // [V2] the fake model host serves 256 KiB files with this magic
}
/** [V2] WCA_DIALOG_SCRIPT entry (T2 4.1): the next scripted answer of the main-process dialog facade. */
export interface SeamDialogAnswer {
  match: 'auto_enable' | 'agy_workspace' | 'any';
  response: 0 | 1;
  checkboxChecked: boolean;
}
/** [V2] WCA_CLI_CMD (T2 4.1): per CLI provider the fake to spawn, or null (= that CLI is not_installed). */
export interface SeamCliCmd {
  claude_cli: SeamCommand | null;
  antigravity_cli: SeamCommand | null;
}

/** Everything of TESTS 4.2, already parsed. Absent seams are undefined. */
export interface Seams {
  userDataDir: string | undefined; // --user-data-dir=<abs>
  bridgeCmd: SeamCommand | undefined; // WCA_BRIDGE_CMD (child mode; wins over attach mode)
  fakeBridge: { url: string; token: string } | undefined; // WCA_FAKE_BRIDGE_URL + WCA_FAKE_BRIDGE_TOKEN (attach mode)
  mcpCmd: SeamCommand | undefined; // WCA_MCP_CMD
  llm: 'stub' | 'attacker' | undefined; // WCA_LLM
  llmScript: string | undefined; // WCA_LLM_SCRIPT
  llamaCmd: SeamCommand | undefined; // WCA_LLAMA_CMD
  modelManifest: string | undefined; // WCA_MODEL_MANIFEST (path)
  hardware: SeamHardware | undefined; // WCA_HW
  timers: SeamTimers | undefined; // WCA_TIMERS
  now: number | undefined; // WCA_NOW as EpochMs
  focusCheck: 'visible-only' | undefined; // WCA_FOCUS_CHECK
  // ---- [V2] T2 4.1 ----
  /** WCA_CLI_CMD - validated per entry (node.exe + <appPath>\tests\fakes\fake-claude-cli.mjs|fake-agy.mjs + last arg --fake-end). In
   *  e2e mode the locator uses ONLY this (never probes the disk, never runs where.exe); undefined = both CLIs not_installed. */
  cliCmd: SeamCliCmd | undefined;
  /** WCA_WHISPER_CMD - validated (node.exe + <appPath>\tests\fakes\whisper-cli.mjs + --fake-end); undefined = voice disabled in e2e. */
  whisperCmd: SeamCommand | undefined;
  /** WCA_DIALOG_SCRIPT - FIFO answers for app/autoDialog.ts; an exhausted script answers Cancel. Never for approve/undo/consent. */
  dialogScript: SeamDialogAnswer[] | undefined;
  /** [D-080] WCA_CONSOLE_DIR - absolute drive path. Set: the e2e S-CONSOLE recorder is TRACKED (writes console-<n>.json with argv / cwd /
   *  env, never spawns anything; `exited` resolves once console-<n>.exit appears). Unset: record-only, untracked (T2 4.2). */
  consoleDir?: string | undefined;
}

export interface ReadSeamsInput {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  isPackaged: boolean;
  mode: string; // import.meta.env.MODE
  /** [V2] app.getAppPath(): the repo root in an unpackaged e2e run. Missing => the CLI / whisper command seams are dropped. */
  appPath?: string;
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
function parseCommand(raw: string | undefined): SeamCommand | undefined {
  const v = parseJson<Partial<SeamCommand>>(raw);
  if (!v || typeof v !== 'object' || typeof v.command !== 'string' || !Array.isArray(v.args)) return undefined;
  if (!v.args.every((a) => typeof a === 'string')) return undefined;
  const out: SeamCommand = { command: v.command, args: v.args as string[] };
  if (typeof v.sha256 === 'string') out.sha256 = v.sha256;
  return out;
}

// ---- [V2] command-seam validation (T2 4.1 "Safety rule") ----
const normPath = (s: string): string => s.replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
const baseName = (s: string): string => normPath(s).split('\\').pop() ?? '';
/** Resolves `.`/`..` segments of an absolute Windows path (pure; no fs). null when the path is not absolute. */
function resolveWin(p: string): string | null {
  const s = normPath(p);
  const m = /^([a-z]:)\\(.*)$/.exec(s);
  if (m === null) return null;
  const out: string[] = [];
  for (const seg of m[2]!.split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return [m[1]!, ...out].join('\\');
}
/** The fake-command rule: basename(command) === node.exe, args[0] resolves to <appPath>\tests\fakes\<one of names>, last arg --fake-end. */
export function validFakeCommand(
  cmd: SeamCommand | undefined,
  appPath: string | undefined,
  names: readonly string[],
): SeamCommand | undefined {
  if (cmd === undefined || appPath === undefined || appPath === '') return undefined;
  if (baseName(cmd.command) !== 'node.exe') return undefined;
  if (cmd.args.length < 2 || cmd.args[cmd.args.length - 1] !== '--fake-end') return undefined;
  const root = resolveWin(appPath);
  const script = resolveWin(cmd.args[0]!);
  if (root === null || script === null) return undefined;
  const dir = `${root}\\tests\\fakes\\`;
  if (!script.startsWith(dir)) return undefined;
  const rest = script.slice(dir.length);
  if (!names.includes(rest)) return undefined; // directly in tests\fakes\, exact file name
  return cmd;
}
function parseCliCmd(raw: string | undefined, appPath: string | undefined): SeamCliCmd | undefined {
  const v = parseJson<Record<string, unknown>>(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const one = (key: 'claude_cli' | 'antigravity_cli', file: string): SeamCommand | null => {
    const entry = v[key];
    if (entry === null || entry === undefined) return null;
    return validFakeCommand(parseCommand(JSON.stringify(entry)), appPath, [file]) ?? null;
  };
  return {
    claude_cli: one('claude_cli', 'fake-claude-cli.mjs'),
    antigravity_cli: one('antigravity_cli', 'fake-agy.mjs'),
  };
}
function parseDialogScript(raw: string | undefined): SeamDialogAnswer[] | undefined {
  const v = parseJson<unknown>(raw);
  if (!Array.isArray(v)) return undefined;
  const ok = v.every(
    (e: unknown) =>
      typeof e === 'object' &&
      e !== null &&
      ['auto_enable', 'agy_workspace', 'any'].includes((e as SeamDialogAnswer).match) &&
      ((e as SeamDialogAnswer).response === 0 || (e as SeamDialogAnswer).response === 1) &&
      typeof (e as SeamDialogAnswer).checkboxChecked === 'boolean' &&
      Object.keys(e).length === 3,
  );
  return ok
    ? (v as SeamDialogAnswer[]).map((e) => ({
        match: e.match,
        response: e.response,
        checkboxChecked: e.checkboxChecked,
      }))
    : undefined;
}

/** Pure. Returns null (every seam ignored) unless BOTH locks are open: mode === 'e2e' AND env.WCA_E2E === '1' AND !isPackaged. */
export function readSeams(input: ReadSeamsInput): Seams | null {
  if (input.isPackaged) return null;
  if (input.mode !== 'e2e') return null;
  if (input.env.WCA_E2E !== '1') return null;
  const env = input.env;
  const udd = input.argv.find((a) => a.startsWith('--user-data-dir='));
  const fakeUrl = env.WCA_FAKE_BRIDGE_URL;
  const fakeToken = env.WCA_FAKE_BRIDGE_TOKEN;
  const llm = env.WCA_LLM === 'stub' || env.WCA_LLM === 'attacker' ? env.WCA_LLM : undefined;
  const nowMs = env.WCA_NOW ? Date.parse(env.WCA_NOW) : Number.NaN;
  const hw = parseJson<SeamHardware>(env.WCA_HW);
  // [D-080] an absolute drive path with no `..` segment (no UNC, no relative path), kept verbatim
  const rawConsoleDir = env.WCA_CONSOLE_DIR ?? '';
  const consoleDir =
    /^[A-Za-z]:\\/.test(rawConsoleDir) && !/(^|[\\/])\.\.([\\/]|$)/.test(rawConsoleDir) ? rawConsoleDir : undefined;
  return {
    userDataDir: udd ? udd.slice('--user-data-dir='.length) || undefined : undefined,
    bridgeCmd: parseCommand(env.WCA_BRIDGE_CMD),
    fakeBridge:
      fakeUrl && fakeToken && /^http:\/\/127\.0\.0\.1:\d+$/.test(fakeUrl) && /^[0-9a-f]{64}$/.test(fakeToken)
        ? { url: fakeUrl, token: fakeToken }
        : undefined,
    mcpCmd: parseCommand(env.WCA_MCP_CMD),
    llm,
    llmScript: env.WCA_LLM_SCRIPT || undefined,
    llamaCmd: parseCommand(env.WCA_LLAMA_CMD),
    modelManifest: env.WCA_MODEL_MANIFEST || undefined,
    hardware: hw && typeof hw === 'object' && typeof hw.ramGiB === 'number' && Array.isArray(hw.gpus) ? hw : undefined,
    timers: parseJson<SeamTimers>(env.WCA_TIMERS),
    now: Number.isFinite(nowMs) ? nowMs : undefined,
    focusCheck: env.WCA_FOCUS_CHECK === 'visible-only' ? 'visible-only' : undefined,
    cliCmd: parseCliCmd(env.WCA_CLI_CMD, input.appPath),
    whisperCmd: validFakeCommand(parseCommand(env.WCA_WHISPER_CMD), input.appPath, ['whisper-cli.mjs']),
    dialogScript: parseDialogScript(env.WCA_DIALOG_SCRIPT),
    ...(consoleDir === undefined ? {} : { consoleDir }),
  };
}

/** globalThis.__wcaTest (TESTS 4.2): read-only hooks for Playwright `app.evaluate`. Exposes no token, key or approve function. */
export interface WcaTestHooks {
  trayTemplate(): unknown;
  trayClick(id: 'open' | 'pause' | 'settings' | 'quit'): void;
  trayState(): { icon: string; tooltip: string };
  doorbellUrl(): string;
  health(): AppHealth;
  /** [V2] entries gain `actions` (the toast buttons, T2 4.2); the facade always reports the key (`[]` when absent). */
  notifications(): Array<{ title: string; body: string; actions?: string[] }>;
  openedExternal(): string[];
  childPids(): Record<string, number>;
}

/**
 * [V2] T2 4.2 additions, passed as a SECOND argument so the v1 call site keeps compiling (a hook the caller does not wire
 * answers its empty value). `trayClickAutoPause` is what the facade's `trayClick('autoPause')` calls - the B11 tray item,
 * present only while a policy is live. Toast ACTION activation is deliberately not here: it would be an undo entry point.
 */
export interface WcaTestHooksV2 {
  /** The main-owned native dialogs the app built (app/autoDialog.ts `recorded()`), app-built text only. */
  dialogs(): DialogRecord[];
  /** The argv the app WOULD have opened in a visible console for cli:signIn (the e2e build never opens one). */
  consoles(): string[][];
  /** Live job pids per kind, for the "no job survives quit" assertion. */
  jobPids(): Record<'cli' | 'voice', number[]>;
  trayClickAutoPause(): void;
}
export type WcaTrayClickId = Parameters<WcaTestHooks['trayClick']>[0] | 'autoPause';
/** The object actually installed on globalThis: the eight v1 hooks + the three v2 reads, `trayClick` widened by 'autoPause'. */
export type WcaTestFacade = Omit<WcaTestHooks, 'trayClick' | 'notifications'> &
  Omit<WcaTestHooksV2, 'trayClickAutoPause'> & {
    trayClick(id: WcaTrayClickId): void;
    notifications(): Array<{ title: string; body: string; actions: string[] }>;
  };
const V1_TRAY_CLICK_IDS: ReadonlySet<string> = new Set(['open', 'pause', 'settings', 'quit']);

export function installTestHooks(hooks: WcaTestHooks, v2: Partial<WcaTestHooksV2> = {}): void {
  // A fresh, frozen facade: exactly the eleven read hooks of TESTS 4.2 (eight v1 + three v2) and nothing the caller happens to
  // carry along (no token, no key, no approve / undo function, no repo handle). `trayClick` is the only state-changing entry,
  // and it accepts only the five known ids - an arbitrary string never reaches the tray.
  const facade: WcaTestFacade = Object.freeze({
    trayTemplate: () => hooks.trayTemplate(),
    trayClick: (id: WcaTrayClickId) => {
      if (id === 'autoPause') {
        if (v2.trayClickAutoPause === undefined) throw new Error('__wcaTest.trayClick: autoPause is not wired');
        v2.trayClickAutoPause();
        return;
      }
      if (!V1_TRAY_CLICK_IDS.has(id)) throw new Error('__wcaTest.trayClick: unknown id');
      hooks.trayClick(id);
    },
    trayState: () => hooks.trayState(),
    doorbellUrl: () => hooks.doorbellUrl(),
    health: () => hooks.health(),
    notifications: () =>
      hooks.notifications().map((n) => ({ title: n.title, body: n.body, actions: [...(n.actions ?? [])] })),
    openedExternal: () => hooks.openedExternal(),
    childPids: () => hooks.childPids(),
    // ---- [V2] T2 4.2 - copies, so a caller can never mutate the recorders behind them ----
    dialogs: () => (v2.dialogs === undefined ? [] : v2.dialogs().map((d) => ({ ...d, buttons: [...d.buttons] }))),
    consoles: () => (v2.consoles === undefined ? [] : v2.consoles().map((argv) => [...argv])),
    jobPids: () => {
      const pids = v2.jobPids?.() ?? { cli: [], voice: [] };
      return { cli: [...pids.cli], voice: [...pids.voice] };
    },
  });
  Object.defineProperty(globalThis, '__wcaTest', {
    value: facade,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/** Removes the hooks again (used by tests; a production build never reaches installTestHooks at all). */
export function uninstallTestHooks(): void {
  Reflect.deleteProperty(globalThis, '__wcaTest');
}
