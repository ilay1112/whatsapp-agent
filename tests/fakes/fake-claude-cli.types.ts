// tests/fakes/fake-claude-cli.types.ts - [V2] the frozen interface of the fake Claude Code CLI (T2 3.1). Wave 0
// (V2-W0-scaffold); owner V2-W1-06-claude-cli. Types only: fake-claude-cli.mjs is plain ESM and reads these shapes as JSON.

/** `--fake-state` file (JSON, re-read on every invocation so a test can flip it between runs). */
export interface FakeClaudeState {
  version: string; // printed by `--version` as `<version> (Claude Code)`; default '2.1.258'
  loggedIn: boolean | 'garbage'; // `auth status --json` -> {"loggedIn":...} | non-JSON text
  mode: FakeClaudeMode; // default 'ok'
  modeByStage?: Partial<Record<FakeClaudeStage, FakeClaudeMode>>;
  neutralInternals?: string[]; // extra names added to system/init.tools (models U-C1); default []
  apiKeySource?: string; // default FAKE_OAUTH_SOURCE
  rateLimit?: { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt: number; isUsingOverage: boolean };
}
export type FakeClaudeMode =
  | 'ok'
  | 'attacker'
  | 'no_tools'
  | 'extra_tool'
  | 'extra_server'
  | 'plugins_present'
  | 'mcp_server_error'
  | 'api_key_leak'
  | 'init_not_first'
  | 'no_init'
  | 'rate_limit'
  | 'usage_limit'
  | 'overage'
  | 'auth_failed'
  | 'account_on_hold'
  | 'model_not_found'
  | 'is_error_success'
  | 'refusal'
  | 'no_structured'
  | 'max_turns'
  | 'max_structured_retries'
  | 'garbage_lines'
  | 'hang'
  | 'kill_me'
  | 'crash_mid_stream'
  | 'stderr_flood'
  // [D-080] live diagnostic: the expired OAuth stream (init FIRST) and error events INSTEAD of the init
  | 'oauth_expired'
  | 'auth_error_before_init'
  | 'model_error_before_init'
  // [claude-extract-debug] live 2.1.258 schema runs: the model wraps the whole answer in ONE placeholder key {"$PARAMETER_NAME": {...}}
  // (every attempt), under the tool's own name {"StructuredOutput": {...}}, splits it over two placeholder keys, or heals on its second attempt. The CLI rejects each placeholder call with an
  // is_error tool_result; after --max-turns attempts it ends with result subtype error_max_turns + is_error true.
  | 'placeholder_keys'
  | 'tool_name_wrapper'
  | 'placeholder_split'
  | 'placeholder_then_heal';
export const FAKE_CLAUDE_MODES: readonly FakeClaudeMode[] = [
  'ok',
  'attacker',
  'no_tools',
  'extra_tool',
  'extra_server',
  'plugins_present',
  'mcp_server_error',
  'api_key_leak',
  'init_not_first',
  'no_init',
  'rate_limit',
  'usage_limit',
  'overage',
  'auth_failed',
  'account_on_hold',
  'model_not_found',
  'is_error_success',
  'refusal',
  'no_structured',
  'max_turns',
  'max_structured_retries',
  'garbage_lines',
  'hang',
  'kill_me',
  'crash_mid_stream',
  'stderr_flood',
  'oauth_expired',
  'auth_error_before_init',
  'model_error_before_init',
  'placeholder_keys',
  'tool_name_wrapper',
  'placeholder_split',
  'placeholder_then_heal',
];
/** Stage detection is from argv only (T2 3.1): --mcp-config => draft; IMAGE_READ_SCHEMA => read_image; smoke schema => smoke. */
export type FakeClaudeStage = 'extract' | 'draft' | 'read_image' | 'smoke';
/** The pinned apiKeySource literal once U-C2 closes; until then 'none'. */
export const FAKE_OAUTH_SOURCE = 'none';
export const FAKE_CLAUDE_DEFAULT_STATE: FakeClaudeState = { version: '2.1.258', loggedIn: true, mode: 'ok' };

/** One journal line per invocation (read by tests/helpers/cli-fakes-hook.ts). Never contains the token value. */
export interface FakeClaudeJournalEntry {
  argv: string[]; // post --fake-end
  argvHasToken: boolean;
  cwd: string;
  cwdEmptyAtStart: boolean;
  envKeys: string[]; // sorted names only
  envChecks: { pathIsSystem32: boolean; tempIsCwd: boolean; tokenPresent: boolean; forbiddenKeys: string[] };
  stdinLines: number;
  stdinSha256: string;
  stdinNonceWrapped: boolean;
  stage: FakeClaudeStage | 'version' | 'auth_status' | 'auth_login' | 'unknown';
  toolCalls: Array<{ name: string; allowedByServer: boolean; isError: boolean }>;
  rawServerProbes: Array<{ name: string; status: number | 'reset' }>;
  exit: number;
  violations: string[]; // e.g. 'forbidden_flag:--bare', 'env_forbidden:ANTHROPIC_API_KEY', 'stdin_shape:<detail>', 'get_not_405'
  // ---- [V2-W1-06, additive] ----
  /** Random id of one invocation: the fake writes a 'started' line before `init` and a 'final' line at exit; readers keep the last. */
  invocation?: string;
  phase?: 'started' | 'final';
  /** The mode the fake ran (state.modeByStage[stage] ?? state.mode). */
  mode?: FakeClaudeMode;
  /** true once the fake printed its first `assistant` event: a run killed on a failed init proof keeps false (I11 "no turn consumed"). */
  turnStarted?: boolean;
  /** kill_me: the pid of the grandchild the fake spawned (the tree kill must take it too). */
  grandchildPid?: number | null;
}

/** [V2-W1-06] Exit code when --mcp-config names a non-loopback URL (T10). */
export const FAKE_NON_LOOPBACK_EXIT = 97;

/** [V2-W1-06] Reads a journal file and keeps the LAST line per invocation (the 'final' line when the run ended normally). */
export function readFakeClaudeJournal(text: string): FakeClaudeJournalEntry[] {
  const byId = new Map<string, FakeClaudeJournalEntry>();
  const anonymous: FakeClaudeJournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let e: FakeClaudeJournalEntry;
    try {
      e = JSON.parse(line) as FakeClaudeJournalEntry;
    } catch {
      continue;
    }
    // Map.set on an existing key keeps its position: the result is in START order, holding each invocation's LAST line.
    if (typeof e.invocation === 'string') byId.set(e.invocation, e);
    else anonymous.push(e);
  }
  return [...anonymous, ...byId.values()];
}
/** Exit code of the Wave-0 skeleton (every invocation) until V2-W1-06 implements the fake. */
export const FAKE_NOT_IMPLEMENTED_EXIT = 99;
