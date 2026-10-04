// tests/security/cli-env-poisoning.test.ts - T2 8.2 group 23 (env poisoning half; owner V2-W1-06-claude-cli).
// ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, GEMINI_API_KEY, GOOGLE_API_KEY, HTTPS_PROXY (and friends) planted in the
// app's own process.env never reach a CLI child: the job env is built from a literal allow-list (B26), and the JobRunner refuses any
// spec that carries a forbidden name for every kind (claude / agy / whisper). The fake's journal (envKeys, names only) is the witness.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGY_ENV_KEYS,
  CLAUDE_ENV_KEYS,
  JOB_ENV_FORBIDDEN,
  JobSpecError,
  WHISPER_ENV_KEYS,
  createJobRunner,
  envKeysAllowed,
} from '../../src/main/proc/jobRunner.ts';
import { buildAgyProbeEnv, buildClaudeEnv } from '../../src/main/llm/cli/claudeCli.ts';
import {
  createClaudeFakeWorld,
  S1_MESSAGES,
  S1_SCHEMA,
  type ClaudeFakeWorld,
} from '../helpers/cli-fakes-hook.world.ts';

const POISON: Record<string, string> = {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/poison',
  ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-poison',
  ANTHROPIC_AUTH_TOKEN: 'TESTONLY-poison',
  ANTHROPIC_PROFILE: 'poison',
  CLAUDE_CODE_OAUTH_TOKEN: 'TESTONLY-poison',
  CLAUDE_CONFIG_DIR: 'C:\\poison-config',
  CLAUDE_CODE_USE_BEDROCK: '1',
  GEMINI_API_KEY: 'AIzaTESTONLY-poison',
  GOOGLE_API_KEY: 'AIzaTESTONLY-poison2',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  NODE_OPTIONS: '--require poison',
  ELECTRON_RUN_AS_NODE: '1',
};
const worlds: ClaudeFakeWorld[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const w of worlds.splice(0)) w.cleanup();
});

describe('a CLI child never sees a poisoned parent env', () => {
  it('S1 through the production runner with process.env as the source: the fake saw only the allow-list', async () => {
    for (const [k, v] of Object.entries(POISON)) vi.stubEnv(k, v);
    const w = createClaudeFakeWorld({ processEnv: process.env });
    worlds.push(w);
    await w.provider().structured(S1_MESSAGES, S1_SCHEMA as never, {
      signal: new AbortController().signal,
      maxOutputTokens: 256,
      purpose: 'extract',
    });
    const [e] = w.journal();
    expect(e!.envKeys).toEqual([...CLAUDE_ENV_KEYS].sort());
    expect(e!.envChecks.forbiddenKeys).toEqual([]);
    for (const k of Object.keys(POISON)) expect(e!.envKeys.map((x) => x.toUpperCase())).not.toContain(k);
    expect(e!.violations).toEqual([]);
  });

  it('the env builders ignore every poisoned name, whatever its case', () => {
    const src = {
      ...POISON,
      https_proxy: 'x',
      Anthropic_Api_Key: 'y',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\wca-fake-home',
    };
    const claude = buildClaudeEnv({ processEnv: src, tempDir: 'C:\\r', token: null });
    const agy = buildAgyProbeEnv(src, 'C:\\t');
    expect(Object.keys(claude).sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
    expect(Object.keys(agy).sort()).toEqual([...AGY_ENV_KEYS].sort());
    expect(JSON.stringify({ claude, agy })).not.toMatch(/poison|TESTONLY/i);
  });

  it.each([
    ['cli', CLAUDE_ENV_KEYS],
    ['cli', AGY_ENV_KEYS],
    ['voice', WHISPER_ENV_KEYS],
  ] as const)('the JobRunner refuses a %s spec that carries a forbidden name (no spawn)', async (kind, keys) => {
    for (const bad of JOB_ENV_FORBIDDEN) {
      const env = Object.fromEntries([...keys, bad.toLowerCase()].map((k) => [k, 'x']));
      expect(envKeysAllowed(kind, env)).toBe('env_forbidden');
    }
    const spawn = vi.fn();
    const runner = createJobRunner({
      runDir: 'C:\\never',
      now: () => 0,
      log: () => undefined,
      proc: { spawn, killPid: vi.fn(), setPriority: vi.fn() },
    });
    const env = Object.fromEntries([...keys, 'GEMINI_API_KEY'].map((k) => [k, 'x']));
    await expect(
      runner.run(
        {
          kind,
          exePath: 'C:\\x\\a.exe',
          args: [],
          env,
          cwd: 'C:\\x',
          stdin: null,
          stdout: 'ignore',
          wallClockMs: 1000,
          graceMs: 1,
          belowNormal: false,
        },
        async () => 1,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(JobSpecError);
    expect(spawn).not.toHaveBeenCalled();
  });
});
