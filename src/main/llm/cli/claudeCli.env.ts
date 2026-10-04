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

/** Probe env for `agy --version` / `agy -p /usage` (AGY_ENV_KEYS; real profile: a probe reads no config). V2-W1-09 owns the run env. */
export function buildAgyProbeEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  tempDir: string,
): Record<string, string> {
  const sysRoot = systemRootOf(processEnv);
  const home = envValue(processEnv, 'USERPROFILE');
  return {
    SystemRoot: sysRoot,
    PATH: path.win32.join(sysRoot, 'System32'),
    USERPROFILE: home,
    HOME: home,
    APPDATA: envValue(processEnv, 'APPDATA'),
    LOCALAPPDATA: envValue(processEnv, 'LOCALAPPDATA'),
    TEMP: tempDir,
    TMP: tempDir,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  };
}
