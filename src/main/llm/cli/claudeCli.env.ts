// src/main/llm/cli/claudeCli.env.ts - [V2 ADD] the literal job env builders of claudeCli.ts (owner V2-W1-06-claude-cli; helper file named
// <ownedFile>.<suffix>.ts per build plan 6). Split out so locator.ts can build probe envs without an import cycle.
import path from 'node:path';
import { CLAUDE_ENV_KEYS, CLAUDE_S3_ENV_KEYS } from '../../proc/jobRunner';

/** The constant values of the Claude env allow-list (the other keys are copied from the main process by name). */
export const CLAUDE_ENV_FIXED: Readonly<Record<string, string>> = {
  MCP_TIMEOUT: '10000',
  MCP_TOOL_TIMEOUT: '25000',
  ENABLE_TOOL_SEARCH: 'false',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_BUG_COMMAND: '1',
  CI: '1',
  // [F8/F15, U-C7] user memory and claude.ai connectors must not load.
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
const COPIED_BY_NAME = ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'] as const;

/** Case-insensitive env lookup (Windows env names are case-insensitive); '' when absent. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key === undefined ? undefined : env[key];
  return v ?? '';
}
function systemRootOf(env: Readonly<Record<string, string | undefined>>): string {
  const v = envValue(env, 'SystemRoot');
  return v.length > 0 ? v : 'C:\\Windows';
}

/**
 * The Claude job env: EXACTLY `CLAUDE_ENV_KEYS` (+ `WCA_MCP_TOKEN` when `token` is given - S3 in 'inline_env' mode). Never
 * `process.env` wholesale; PATH = %SystemRoot%\System32; TEMP/TMP = the run dir; the rest copied by name.
 */
export function buildClaudeEnv(input: {
  processEnv: Readonly<Record<string, string | undefined>>;
  tempDir: string;
  token: string | null;
}): Record<string, string> {
  const sysRoot = systemRootOf(input.processEnv);
  const env: Record<string, string> = {
    SystemRoot: sysRoot,
    PATH: path.win32.join(sysRoot, 'System32'),
    TEMP: input.tempDir,
    TMP: input.tempDir,
  };
  for (const k of COPIED_BY_NAME) env[k] = envValue(input.processEnv, k);
  Object.assign(env, CLAUDE_ENV_FIXED);
  if (input.token !== null) env.WCA_MCP_TOKEN = input.token;
  // Self-check: the key set must equal one of the two literal lists (a drift here is a programming error, fail closed).
  const want = input.token !== null ? CLAUDE_S3_ENV_KEYS : CLAUDE_ENV_KEYS;
  if ([...want].sort().join(',') !== Object.keys(env).sort().join(',')) throw new Error('claude_env_keyset_drift');
  return env;
}

/** Folder names under <userData> (paths.ts owns the absolute paths; these match AppPaths.agyWorkspaceDir and the runner's run dirs).
 *  Defined here (re-exported by antigravityCli.ts) so locator.ts can build the isolated probe profile without an import cycle. */
export const AGY_WORKSPACE_DIR = 'agy-workspace';
export const AGY_HOME_DIR = 'agy-home';
/** The four profile vars of the isolated agy profile. */
export type AgyHomeEnv = Record<'USERPROFILE' | 'HOME' | 'APPDATA' | 'LOCALAPPDATA', string>;

/**
 * [agy-provider-fix A] The Antigravity permissions policy of the app-owned isolated profile: deny every tool namespace agy documents
 * (precedence deny > ask > allow; allow and ask stay empty). agy 1.2.16 lists all of its 60 tools in init.tools whatever the agent file
 * says, so this policy - with the runner's runtime tool watch and the agent file's `tools: []` - is what an agy run's I11 proof rests on.
 * Whether agy honours `deny` in headless mode is undocumented: defence in depth, never the only control. Frozen; checked by
 * checkAgyPolicy() before EVERY agy job (fail closed: no spawn without it).
 */
export const AGY_DENY_ALL: readonly string[] = Object.freeze([
  'read_file(*)',
  'write_file(*)',
  'read_url(*)',
  'execute_url(*)',
  'command(*)',
  'unsandboxed(*)',
  'mcp(*)',
]);
/** The isolated settings.json path below an agy profile home. */
export function agySettingsPath(homeDir: string): string {
  return path.win32.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
}
/**
 * [agy-provider-fix A] What the isolated settings.json says about the permissions policy: 'deny_all' only for EXACTLY
 * {allow: [], ask: [], deny: AGY_DENY_ALL (any order, no duplicate, nothing extra)} and no other key in `permissions`; 'missing' when the
 * file / the block / the deny list is absent or unreadable; 'altered' for anything else. Pure; the text is the app's own file.
 */
export function checkAgyPolicy(text: string | null): 'deny_all' | 'missing' | 'altered' {
  if (text === null || text.length === 0) return 'missing';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return 'missing';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'missing';
  const perms = (parsed as Record<string, unknown>).permissions;
  if (perms === undefined || perms === null) return 'missing';
  if (typeof perms !== 'object' || Array.isArray(perms)) return 'altered';
  const p = perms as Record<string, unknown>;
  if (p.deny === undefined) return 'missing';
  if (Object.keys(p).sort().join(',') !== 'allow,ask,deny') return 'altered';
  const empty = (v: unknown): boolean => Array.isArray(v) && v.length === 0;
  if (!empty(p.allow) || !empty(p.ask) || !Array.isArray(p.deny)) return 'altered';
  const deny = p.deny as unknown[];
  if (deny.length !== AGY_DENY_ALL.length || new Set(deny).size !== deny.length) return 'altered';
  if (!deny.every((d) => typeof d === 'string' && AGY_DENY_ALL.includes(d))) return 'altered';
  return 'deny_all';
}

/** [F3] Isolated profile (default): creates <userData>\agy-home\ with ONLY .gemini\antigravity-cli\settings.json = {trustedWorkspaces:[workspaceDir],
 *  permissions: {allow: [], ask: [], deny: AGY_DENY_ALL}} (app-written, idempotent) and returns the env overrides (USERPROFILE, HOME, and
 *  APPDATA/LOCALAPPDATA per U-A7). Nothing of the user's profile is read. */
export function planAgyHome(
  userDataDir: string,
  workspaceDir: string,
): { homeDir: string; files: Array<{ path: string; text: string }>; env: AgyHomeEnv } {
  const homeDir = path.win32.join(userDataDir, AGY_HOME_DIR);
  const settings = {
    trustedWorkspaces: [workspaceDir],
    permissions: { allow: [], ask: [], deny: [...AGY_DENY_ALL] },
  };
  return {
    homeDir,
    files: [
      {
        path: agySettingsPath(homeDir),
        text: `${JSON.stringify(settings, null, 2)}\n`,
      },
    ],
    // U-A7 (M-AGY-1): APPDATA / LOCALAPPDATA point under the app-owned home as well, so no user-level agy/Gemini state is found there
    // either. The sign-in lives in Windows Credential Manager and is expected to survive the redirect (UNVERIFIED until M-AGY-1).
    env: {
      USERPROFILE: homeDir,
      HOME: homeDir,
      APPDATA: path.win32.join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.win32.join(homeDir, 'AppData', 'Local'),
    },
  };
}

/**
 * Probe env for `agy --version` / `agy -p /usage` (AGY_ENV_KEYS). [cli-sandbox-3] The profile vars come ONLY from `home`
 * (planAgyHome().env - the isolated <userData>\agy-home profile, F3/B14/I6'): the global ~/.gemini mcp_config.json / hooks.json load in
 * EVERY agy run (research v2-gemini-cli-backend), a probe included, so a probe never sees the user's real profile. V2-W1-09 owns the run env.
 */
export function buildAgyProbeEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  tempDir: string,
  home: Readonly<AgyHomeEnv>,
): Record<string, string> {
  const sysRoot = systemRootOf(processEnv);
  return {
    SystemRoot: sysRoot,
    PATH: path.win32.join(sysRoot, 'System32'),
    USERPROFILE: home.USERPROFILE,
    HOME: home.HOME,
    APPDATA: home.APPDATA,
    LOCALAPPDATA: home.LOCALAPPDATA,
    TEMP: tempDir,
    TMP: tempDir,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  };
}
