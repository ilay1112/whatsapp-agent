// src/main/testSeams.ts - the ONLY module with E2E seam code (TESTS 4.1: two locks). Owner W1-12; readSeams() implemented by W0.
// Imported by compose.ts / index.ts behind `if (import.meta.env.MODE === 'e2e')` so a production build constant-folds it away
// (build-time lock); readSeams() itself returns null unless WCA_E2E === '1' && !isPackaged (run-time lock).
import type { AppHealth } from '../shared/health';

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
}
export interface SeamHardware {
  ramGiB: number;
  freeDiskGiB: number;
  gpus: Array<{ name: string; vramGiB: number | null }>;
}
export interface SeamModelEntry {
  tier: 'tiny' | 'small' | 'mid';
  url: string;
  size: number;
  sha256: string;
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
}

export interface ReadSeamsInput {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  isPackaged: boolean;
  mode: string; // import.meta.env.MODE
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
  };
}

/** globalThis.__wcaTest (TESTS 4.2): read-only hooks for Playwright `app.evaluate`. Exposes no token, key or approve function. */
export interface WcaTestHooks {
  trayTemplate(): unknown;
  trayClick(id: 'open' | 'pause' | 'settings' | 'quit'): void;
  trayState(): { icon: string; tooltip: string };
  doorbellUrl(): string;
  health(): AppHealth;
  notifications(): Array<{ title: string; body: string }>;
  openedExternal(): string[];
  childPids(): Record<string, number>;
}
export function installTestHooks(hooks: WcaTestHooks): void {
  // A fresh, frozen facade: exactly the eight read hooks of TESTS 4.2 and nothing the caller happens to carry along
  // (no token, no key, no approve function, no repo handle). `trayClick` is the only state-changing entry.
  const facade: WcaTestHooks = Object.freeze({
    trayTemplate: () => hooks.trayTemplate(),
    trayClick: (id: Parameters<WcaTestHooks['trayClick']>[0]) => hooks.trayClick(id),
    trayState: () => hooks.trayState(),
    doorbellUrl: () => hooks.doorbellUrl(),
    health: () => hooks.health(),
    notifications: () => hooks.notifications(),
    openedExternal: () => hooks.openedExternal(),
    childPids: () => hooks.childPids(),
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
