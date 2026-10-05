// src/main/llm/cli/{locator,runner,claudeCli,antigravityCli}.ts   [V2 ADD] (B12-B14, B26, I11)
// llm/cli/** MUST NOT import mcp/host, bridge/**, exec/** (ESLint + import-graph). The tool server arrives through AgenticRunInput / startToolServer injection.
// file 3 of 4 of the C2 9.2 block - owner V2-W1-06-claude-cli (the Wave-0 stub bodies are replaced below the frozen declarations).
import { createHash } from 'node:crypto';
import type { CliSandboxProof, EpochMs, JsonSchemaLcd, LlmQuota } from '../../../shared/types';
import { LIMITS } from '../../../shared/types';
import type { ErrorCode, ProviderErrorCode } from '../../../shared/errors';
import type { CliRunRequest, CliRunResult, CliRunner } from './runner';
import type { CliLocator } from './locator';
import { compareVersion } from './locator';
import {
  LlmError,
  type AgenticRunInput,
  type AgenticRunResult,
  type CallOpts,
  type LlmMessage,
  type LlmProvider,
  type LlmResponse,
} from '../types';

// ---------------- claudeCli.ts (argv builder is pure and literal-tested) ----------------
export const CLAUDE_DISALLOWED_TOOLS =
  'Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Skill,Monitor,Workflow,SendMessage,Artifact,SendUserFile,PushNotification,RemoteTrigger,EnterWorktree,ExitWorktree,TaskCreate,TaskUpdate,CronCreate';
export const CLAUDE_NEVER_ARGS = [
  '--bare',
  '--dangerously-skip-permissions',
  'bypassPermissions',
  '--add-dir',
  '--settings',
  '--continue',
  '--resume',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt-file',
] as const; // --system-prompt-file only if a constant ever exceeds 8 KB (decision; a W0 test pins every constant < 8 KB, F23)
export const CLAUDE_MIN_VERSION = '2.1.248'; // [F14] --restricted (mandatory argv) requires >= 2.1.248 ; 2.1.221-2.1.247 => CLI_VERSION + "Copy update command"
/** [F13, U-C8] The CLI's synthetic tool behind --json-schema. Allowed in init.tools of schema runs (S1, V1, smoke) only; its tool_use is never a strike. */
export const CLI_SCHEMA_TOOL = 'StructuredOutput';
/** [F16, U-C6] How the per-run MCP token reaches the CLI. 'inline_env' = --mcp-config '<json with Bearer ${WCA_MCP_TOKEN}>' + env (default);
 *  'run_file' = --mcp-config <runDir>\wca.mcp.json holding the literal token (user-only ACL, deleted in the run's finally) - pinned by M-CLI-1. */
export const CLAUDE_MCP_CONFIG_MODE: 'inline_env' | 'run_file' = 'inline_env';
export const CLAUDE_PERMISSION_PROMPTS_MIN = '2.1.259';
/** [claude-extract-debug] --max-turns of the S1 extract schema run (structured(), purpose extract). Each StructuredOutput attempt is one
 *  turn; with 1 the CLI has no room to retry a rejected attempt (live 2.1.258: the model wraps the whole answer under one made-up key such as
 *  `$PARAMETER_NAME`, research bug #87234), so the run ended error_max_turns. 2 = one in-run retry; bounded (never > 3): the run still has no tool
 *  but StructuredOutput (init proof unchanged), the wall clock is the same LIMITS value, and a run is at most two short answers. The
 *  provider-start smoke (B13) and V1 read_image (I12 pins --max-turns 1) stay at 1; the wrapper
 *  unwrap in the runner applies to every schema run. */
export const CLAUDE_EXTRACT_MAX_TURNS = 2;

// ---------------- pinned-after-M-CLI-1 constants (UNVERIFIED register; fail closed until pinned) ----------------
/** [U-C2] The `system/init.apiKeySource` literal of a subscription (OAuth) run, pinned by M-CLI-1. While null, a deny list applies:
 *  any value naming an API key, a key helper, a token or a cloud provider is a mismatch (`api_key_auth`). */
export const CLI_OAUTH_API_KEY_SOURCE: string | null = null;
/** [U-C1] Neutral CLI internals observed once in `init.tools` and pinned by M-CLI-1. Empty = none tolerated (fail closed). */
export const CLI_NEUTRAL_INTERNALS: readonly string[] = [];
/** The MCP server name of the loopback tool server (= mcp/toolServer.ts TOOL_SERVER_NAME; duplicated because llm/cli/** must not import mcp/**). */
export const CLI_TOOL_SERVER_NAME = 'wca';
export const CLI_MCP_TOOL_PREFIX = `mcp__${CLI_TOOL_SERVER_NAME}__`;

// ---------------- smoke run (provider start + cli:test) ----------------
/** B13: the provider-start smoke run - constant prompt, 1-field schema, haiku, --max-turns 1. Contains no user data, ever. */
export const CLI_SMOKE_MODEL = 'haiku';
export const CLI_SMOKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
} as const satisfies JsonSchemaLcd;
export const CLI_SMOKE_SYSTEM =
  'You are a connectivity check. Answer with the JSON object {"ok": true}. Return the JSON object only, on one line, no markdown.';
/** The constant smoke data block (fixed nonce: the smoke carries no untrusted data, so no per-run nonce is needed). */
export const CLI_SMOKE_USER = '<<DATA-00000000000000a5>>\n{"check":"connectivity"}\n<<END-DATA-00000000000000a5>>';

// ---------------- env (B26 / ARCH2 4.3): claudeCli.env.ts (no import cycle with locator.ts) ----------------
export { CLAUDE_ENV_FIXED, buildAgyProbeEnv, buildClaudeEnv } from './claudeCli.env';

// ---------------- stdin (F20) ----------------
type ClaudeImage = { mime: 'image/jpeg' | 'image/png'; base64: string };
/** [F20] {"type":"user","message":{"role":"user","content":[<image block?>, {"type":"text","text":<nonce block>}]}} - one line, no newline inside. */
export function buildClaudeStdinLine(text: string, image: ClaudeImage | null): string {
  return buildClaudeStdinLineParts([text], image);
}
/** Same envelope with several text blocks (the S1 repair retry adds a second text block, P2 13.1). The image block is FIRST. */
export function buildClaudeStdinLineParts(texts: readonly string[], image: ClaudeImage | null): string {
  const content: unknown[] = [];
  if (image !== null)
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } });
  for (const t of texts) content.push({ type: 'text', text: t });
  // JSON.stringify escapes every control character incl. \n, so the envelope is exactly one line.
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

// ---------------- argv ----------------
/** ARCH-v2 4.3 verbatim: -p --restricted --strict-mcp-config --tools "" --permission-mode dontAsk [--permission-prompts none]
 *  --disallowedTools <CLAUDE_DISALLOWED_TOOLS> --disable-slash-commands --no-session-persistence --system-prompt <constant> --max-turns N
 *  --output-format stream-json --input-format stream-json --verbose --model <m> --fallback-model haiku --effort low|medium [--json-schema <json>]
 *  [S3: --mcp-config '{"mcpServers":{"wca":{"type":"http","url":"<url>","headers":{"Authorization":"Bearer ${WCA_MCP_TOKEN}"}}}}' --allowedTools mcp__wca__*]
 *  (or, in CLAUDE_MCP_CONFIG_MODE 'run_file', --mcp-config <runDir>\wca.mcp.json)
 *  The token itself is NEVER in argv (the literal string ${WCA_MCP_TOKEN} or the file path is).
 *  [V2-W1-06] `opts` is additive: `mode` (default CLAUDE_MCP_CONFIG_MODE) and the run_file path. `--fallback-model haiku` is omitted when
 *  the model itself is haiku (the smoke run): Claude Code refuses a fallback equal to the main model (UNVERIFIED, recorded in notes). */
export function buildClaudeArgs(
  req: CliRunRequest,
  opts: { mode?: 'inline_env' | 'run_file'; mcpConfigPath?: string } = {},
): string[] {
  const args = ['-p', '--restricted', '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk'];
  if (compareVersion(req.observedVersion, CLAUDE_PERMISSION_PROMPTS_MIN) >= 0)
    args.push('--permission-prompts', 'none');
  args.push(
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS,
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt',
    req.system,
    '--max-turns',
    String(req.maxTurns),
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--model',
    req.model,
  );
  if (req.model.toLowerCase() !== CLI_SMOKE_MODEL) args.push('--fallback-model', CLI_SMOKE_MODEL);
  args.push('--effort', req.stage === 'draft' ? 'medium' : 'low');
  if (req.jsonSchema !== null) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  if (req.stage === 'draft' && req.toolServer !== null) {
    const mode = opts.mode ?? CLAUDE_MCP_CONFIG_MODE;
    if (mode === 'run_file') {
      if (opts.mcpConfigPath === undefined) throw new Error('claude_mcp_config_path_missing');
      args.push('--mcp-config', opts.mcpConfigPath);
    } else {
      args.push('--mcp-config', buildInlineMcpConfig(req.toolServer.url));
    }
    args.push('--allowedTools', `${CLI_MCP_TOOL_PREFIX}*`);
  }
  return args;
}

/** The inline --mcp-config JSON: the Authorization header is the LITERAL `Bearer ${WCA_MCP_TOKEN}` (expanded by the CLI from env). */
export function buildInlineMcpConfig(url: string): string {
  return JSON.stringify({
    mcpServers: {
      [CLI_TOOL_SERVER_NAME]: { type: 'http', url, headers: { Authorization: 'Bearer ${WCA_MCP_TOKEN}' } },
    },
  });
}
/** [F16] run_file mode: the file body holds the literal token (written to <runDir>\wca.mcp.json, deleted with the run dir). */
export function buildRunFileMcpConfig(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: { [CLI_TOOL_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
  });
}

// ---------------- init proof ----------------
/** Maps the observed `apiKeySource` literal (U-C2) to the enum stored on the run. 'other' => initOk=false. */
export function mapApiKeySource(value: unknown): CliSandboxProof['apiKeySource'] {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  if (CLI_OAUTH_API_KEY_SOURCE !== null) return value === CLI_OAUTH_API_KEY_SOURCE ? 'oauth' : 'other';
  if (/api[_ -]?key|helper|token|anthropic|bedrock|vertex|foundry|console|user|project|org|temporary/i.test(value))
    return 'other';
  if (value === 'none') return 'none';
  if (/oauth|claude\.ai|subscription/i.test(value)) return 'oauth';
  return 'other';
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * [claude-extract-debug] The answer inside a StructuredOutput input that WRAPS it under one made-up key - live 2.1.258 (synthetic S1
 * capture): {"$PARAMETER_NAME": {...}} (the placeholder of the tool-call format, research bug #87234) and {"StructuredOutput": {...}}
 * (the tool's own name). Unwrapped only when the input has EXACTLY one key, that key is NOT a declared property of the run's schema, and
 * its value is a plain object; anything else (a split answer over two keys, a string, an array, a real field) => undefined, never
 * guessed at. The result is model output exactly like structured_output (UNTRUSTED): every caller zod-validates it strictly
 * (ExtractionSchema / ImageReadSchema / the smoke's `ok` boolean). Pure.
 */
export function unwrapWrappedStructured(input: unknown, schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== 1) return undefined;
  const key = keys[0] as string;
  const declared = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  if (Object.prototype.hasOwnProperty.call(declared, key)) return undefined;
  const inner = input[key];
  return isRecord(inner) ? inner : undefined;
}

/** Init proof (U-C1 / U-C2 / U-C8 pinned after M-CLI-1): mcp_servers exactly [] (S1/V1/smoke) or [{name:'wca', status:'connected'|'pending'}] (S3)
 *  - a claude.ai connector server therefore always fails (U-C7); mcp_server_errors absent; plugins empty; tools ⊆ [CLI_SCHEMA_TOOL] (S1/V1/smoke,
 *  F13) or a subset of mcp__wca__<exposed names> plus the pinned neutral internals (S3); apiKeySource = the pinned OAuth literal. The proof also
 *  records sandbox_json.memoryLoaded (false only when the U-C7 switches are pinned as effective; true => the proposal is cli_unproven). */
export function checkClaudeInit(
  init: unknown,
  req: Pick<CliRunRequest, 'stage' | 'toolServer'>,
  exposedNames: readonly string[],
): CliSandboxProof {
  const fail = (
    mismatch: CliSandboxProof['mismatch'],
    toolsCount = 0,
    mcpServers = 0,
    apiKeySource: CliSandboxProof['apiKeySource'] = 'unknown',
  ): CliSandboxProof => ({
    initOk: false,
    toolsCount,
    mcpServers,
    apiKeySource,
    mismatch,
  });
  if (!isRecord(init) || init.type !== 'system' || init.subtype !== 'init') return fail(null);
  const tools = init.tools;
  const servers = init.mcp_servers;
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string')) return fail('extra_tool');
  if (!Array.isArray(servers)) return fail('missing_server', tools.length);
  const apiKeySource = mapApiKeySource(init.apiKeySource);
  const counts = (m: CliSandboxProof['mismatch']): CliSandboxProof =>
    fail(m, tools.length, servers.length, apiKeySource);

  // mcp_servers: S3 = exactly the one loopback server; everything else = none (a claude.ai connector always fails, U-C7).
  const isDraft = req.stage === 'draft';
  if (isDraft) {
    if (servers.length === 0) return counts('missing_server');
    if (servers.length > 1) return counts('extra_server');
    const s = servers[0];
    if (!isRecord(s) || s.name !== CLI_TOOL_SERVER_NAME) return counts('extra_server');
    if (s.status !== 'connected' && s.status !== 'pending') return counts('server_error');
  } else if (servers.length > 0) {
    return counts('extra_server');
  }
  const errors = init.mcp_server_errors;
  if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0))
    return counts('server_error');
  const plugins = init.plugins;
  if (plugins !== undefined && plugins !== null && !(Array.isArray(plugins) && plugins.length === 0))
    return counts('extra_tool');

  // tools: schema runs ⊆ {StructuredOutput} (F13) ; S3 ⊆ {mcp__wca__<exposed>} ; plus the pinned neutral internals (U-C1).
  const allowed = new Set<string>(CLI_NEUTRAL_INTERNALS);
  if (isDraft) for (const n of exposedNames) allowed.add(`${CLI_MCP_TOOL_PREFIX}${n}`);
  else allowed.add(CLI_SCHEMA_TOOL);
  if (!(tools as string[]).every((t) => allowed.has(t))) return counts('extra_tool');
  if (apiKeySource === 'other') return counts('api_key_auth');
  return { initOk: true, toolsCount: tools.length, mcpServers: servers.length, apiKeySource, mismatch: null };
}

/** Strips exactly one leading ```/```json fence and one trailing ``` (P2 6.3: two fences => parse failure, never stripped twice). */
export function stripOneCodeFence(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(t);
  return m === null ? t : (m[1] ?? '').trim();
}

// ---------------- provider ----------------
/** [V2-W1-06] Extra, non-contract members of the claude_cli provider object: the factory reads them for its cache key and usable(). */
export interface ClaudeCliProviderInfo {
  readonly exePath: string;
  readonly observedVersion: string;
  /** Sync readiness from this provider's own runner (breaker, overage pause, usage window). null = nothing blocks a run. */
  cliHealth(): { code: ErrorCode; retryAtMs: EpochMs | null } | null;
  /** When the last provider-start smoke passed (null = never / failed). */
  lastSmokeOkAt(): EpochMs | null;
}
export type ClaudeCliProvider = LlmProvider & ClaudeCliProviderInfo;

/** Extended run request understood by createCliRunner (additive over the frozen CliRunRequest). */
export type ClaudeRunRequestExt = CliRunRequest & {
  exposedNames?: readonly string[];
  runId?: number | null;
  auditRef?: string | null;
  /** Called for every runner strike (non-mcp__wca__ tool_use, permission_denials entry); returns true when the run must abort. */
  onStrike?: () => boolean;
};

/** Runner extras the provider reads when present (createCliRunner returns them). */
interface RunnerExtras {
  health?: () => { code: ErrorCode; retryAtMs: EpochMs | null } | null;
}

function toStage(purpose: CallOpts['purpose']): 'extract' | 'read_image' {
  return purpose === 'read_image' ? 'read_image' : 'extract';
}

/** Splits the messages of a structured() call into the verbatim system constant, the user text blocks and the (single) image. */
function splitMessages(messages: LlmMessage[]): { system: string; texts: string[]; image: ClaudeImage | null } {
  let system = '';
  const texts: string[] = [];
  let image: ClaudeImage | null = null;
  for (const m of messages) {
    if (m.role === 'system') system = system.length === 0 ? m.content : `${system}\n\n${m.content}`;
    else if (m.role === 'user') {
      if (typeof m.content === 'string') texts.push(m.content);
      else
        for (const part of m.content) {
          if (part.type === 'text') texts.push(part.text);
          else if (image === null) image = { mime: part.mime, base64: part.base64 };
        }
    }
    // assistant / tool messages never travel to a CLI (one-shot runs, no session)
  }
  return { system, texts, image };
}

/** [W0 seam] The claude_cli LlmProvider (loop 'agentic', capabilities.images true); built only by llm/factory.ts (makeClaudeCli). */
export function createClaudeCliProvider(deps: {
  runner: CliRunner;
  locator: CliLocator;
  model: string;
  exePath: string;
  observedVersion: string;
  startToolServer: (
    input: import('../types').AgenticRunInput,
  ) => Promise<{ url: string; token: string; close(): Promise<void> }>;
  /** [V2-W1-06, additive] clock for lastSmokeOkAt (default Date.now) and the smoke outcome sink (CliStatusRecorder.recordTest). */
  now?: () => EpochMs;
  onSmoke?: (r: { ok: boolean; at: EpochMs; ms: number | null }) => void;
  onQuota?: (q: LlmQuota) => void;
}): ClaudeCliProvider {
  const now = deps.now ?? ((): EpochMs => Date.now());
  const runner = deps.runner as CliRunner & RunnerExtras;
  let disposed = new AbortController();
  let smokeOkAt: EpochMs | null = null;

  const signalFor = (s: AbortSignal): AbortSignal => AbortSignal.any([s, disposed.signal]);
  const reportQuota = (res: CliRunResult, opts: CallOpts | null): void => {
    if (res.quota === null) return;
    opts?.onQuota?.(res.quota);
    deps.onQuota?.(res.quota);
  };
  const reportUsage = (res: CliRunResult, opts: CallOpts): void => {
    if (res.usage !== null) opts.onUsage?.(res.usage);
  };
  const assertFloor = (): void => {
    if (compareVersion(deps.observedVersion, CLAUDE_MIN_VERSION) < 0) throw new LlmError('version');
  };

  const smoke = async (signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: ProviderErrorCode }> => {
    const started = now();
    const res = await runner.run(
      {
        provider: 'claude_cli',
        stage: 'smoke',
        exePath: deps.exePath,
        model: CLI_SMOKE_MODEL,
        system: CLI_SMOKE_SYSTEM,
        stdinLine: buildClaudeStdinLine(CLI_SMOKE_USER, null),
        jsonSchema: CLI_SMOKE_SCHEMA,
        maxTurns: 1,
        wallClockMs: LIMITS.cliTestWallClockMs,
        toolServer: null,
        observedVersion: deps.observedVersion,
      },
      signalFor(signal),
    );
    reportQuota(res, null);
    let outcome: { ok: true } | { ok: false; reason: ProviderErrorCode };
    // A run without a proof is a sandbox failure - unless the runner refused before any spawn (pause, budget, abort): then its code.
    if (!res.sandbox.initOk) outcome = { ok: false, reason: res.error ?? 'sandbox' };
    else if (res.error !== null) outcome = { ok: false, reason: res.error };
    else if (!isRecord(res.structured) || typeof res.structured.ok !== 'boolean')
      outcome = { ok: false, reason: 'bad_output' };
    else outcome = { ok: true };
    smokeOkAt = outcome.ok ? now() : null;
    deps.onSmoke?.({ ok: outcome.ok, at: now(), ms: now() - started });
    return outcome;
  };

  const provider: ClaudeCliProvider = {
    id: 'claude_cli',
    model: deps.model,
    loop: 'agentic',
    capabilities: { images: true },
    exePath: deps.exePath,
    observedVersion: deps.observedVersion,

    async structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T> {
      if (opts.purpose === 'draft') throw new LlmError('unsupported'); // claude_cli drafts through runAgentic (B15)
      assertFloor();
      const stage = toStage(opts.purpose);
      const { system, texts, image } = splitMessages(messages);
      if (stage !== 'read_image' && image !== null) throw new LlmError('unsupported'); // only V1 carries a picture (B19)
      const res = await runner.run(
        {
          provider: 'claude_cli',
          stage,
          exePath: deps.exePath,
          model: deps.model,
          system,
          stdinLine: buildClaudeStdinLineParts(texts, image),
          jsonSchema: schema,
          maxTurns: stage === 'extract' ? CLAUDE_EXTRACT_MAX_TURNS : 1, // V1 stays at 1 (I12)
          wallClockMs: stage === 'read_image' ? LIMITS.readImageWallClockCliMs : LIMITS.cliWallClockExtractMs,
          toolServer: null,
          observedVersion: deps.observedVersion,
        },
        signalFor(opts.signal),
      );
      opts.onSandbox?.(res.sandbox);
      reportQuota(res, opts);
      reportUsage(res, opts);
      if (!res.sandbox.initOk) throw new LlmError(res.error ?? 'sandbox');
      if (res.error !== null) throw new LlmError(res.error);
      if (res.structured !== null && res.structured !== undefined) return res.structured as T;
      // P2 6.3 backstop: one code fence stripped, then JSON.parse; the caller zod-validates either way.
      if (res.text !== null && res.text.length > 0) {
        try {
          return JSON.parse(stripOneCodeFence(res.text)) as T;
        } catch {
          throw new LlmError('bad_output');
        }
      }
      throw new LlmError('bad_output');
    },

    chat(): Promise<LlmResponse> {
      // ARCH2 4.2 / concern 6: a CLI provider never runs the in-process turn loop; draft.ts branches on `loop` first.
      return Promise.reject(new LlmError('unsupported'));
    },

    async runAgentic(input: AgenticRunInput, opts: CallOpts): Promise<AgenticRunResult> {
      assertFloor();
      let server: { url: string; token: string; close(): Promise<void> };
      try {
        server = await deps.startToolServer(input);
      } catch {
        // EADDRINUSE after the port attempts / listener failure: the provider is not ready; Local is unaffected (I7').
        throw new LlmError('not_ready');
      }
      try {
        const req: ClaudeRunRequestExt = {
          provider: 'claude_cli',
          stage: 'draft',
          exePath: deps.exePath,
          model: deps.model,
          system: input.system,
          stdinLine: buildClaudeStdinLine(input.user, null),
          jsonSchema: input.jsonSchema ?? null,
          maxTurns: input.maxTurns,
          wallClockMs: LIMITS.cliWallClockDraftMs,
          toolServer: { url: server.url, token: server.token },
          observedVersion: deps.observedVersion,
          exposedNames: input.specs.map((s) => s.name),
          runId: input.ctx.runId,
          auditRef: String(input.ctx.itemId),
          onStrike: () => {
            input.ctx.blockedCalls += 1;
            return input.ctx.blockedCalls >= LIMITS.blockedCallsAbort;
          },
        };
        const res = await runner.run(req, signalFor(opts.signal));
        opts.onSandbox?.(res.sandbox);
        reportQuota(res, opts);
        reportUsage(res, opts);
        const blockedCalls = Math.max(res.blockedCalls, input.ctx.blockedCalls);
        const base = {
          toolCalls: res.toolCalls,
          blockedCalls,
          ...(res.usage === null ? {} : { usage: res.usage }),
          ...(res.quota === null
            ? {}
            : { rateLimit: { resetsAt: res.quota.resetsAt, usingOverage: res.quota.usingOverage } }),
        };
        if (!res.sandbox.initOk) {
          // a refusal before any spawn (pause / budget / abort) is its own provider error, never a sandbox verdict
          if (res.error !== null && res.error !== 'sandbox') throw new LlmError(res.error);
          return { ...base, text: '', sandboxOk: false, stopReason: res.stopReason };
        }
        // A strike-aborted run is not a provider error: the caller turns it into `aborted_manipulation`.
        if (input.ctx.blockedCalls >= LIMITS.blockedCallsAbort)
          return { ...base, text: '', sandboxOk: true, stopReason: 'killed' };
        if (res.error !== null && res.error !== 'bad_output') throw new LlmError(res.error);
        if (res.error === 'bad_output' && res.stopReason !== 'max_turns') throw new LlmError('bad_output');
        return {
          ...base,
          text: res.text ?? '',
          ...(res.structured === null ? {} : { structured: res.structured }),
          sandboxOk: true,
          stopReason: res.stopReason,
        };
      } finally {
        // The listener dies in the same finally as the job (the runner already killed the job and removed the run dir).
        await server.close().catch(() => undefined);
      }
    },

    async validate(
      signal: AbortSignal,
    ): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
      if (compareVersion(deps.observedVersion, CLAUDE_MIN_VERSION) < 0) return { ok: false, reason: 'version' };
      try {
        const r = await smoke(signal);
        return r.ok ? { ok: true, model: deps.model } : r;
      } catch (e) {
        if (e instanceof LlmError) return { ok: false, reason: e.code };
        return { ok: false, reason: signal.aborted ? 'aborted' : 'not_ready' };
      }
    },

    async dispose(): Promise<void> {
      // Kills the in-flight job (the runner observes the abort, tree-kills by PID, removes the run dir).
      disposed.abort();
      disposed = new AbortController();
      smokeOkAt = null;
    },

    cliHealth() {
      return runner.health?.() ?? (runner.breakerOpen() ? { code: 'CLI_UNSTABLE', retryAtMs: null } : null);
    },
    lastSmokeOkAt: () => smokeOkAt,
  };
  return provider;
}

/** True when `p` is a claude_cli provider object built by createClaudeCliProvider (has the info members). */
export function isClaudeCliProvider(p: LlmProvider): p is ClaudeCliProvider {
  const x = p as Partial<ClaudeCliProviderInfo>;
  return p.id === 'claude_cli' && typeof x.exePath === 'string' && typeof x.cliHealth === 'function';
}

/**
 * The `makeClaudeCli` value for llm/factory.ts (W2-01 wires it): locate the exe (S-LOCATE / the e2e seam), read its version, refuse
 * below the floor, then build the provider. Throws LlmError('not_installed' | 'version'). `onLocated` lets compose record the path in
 * meta.cli_exe_paths_json (B31) before any job of this provider can run.
 */
export function makeClaudeCliFactory(deps: {
  locator: CliLocator;
  runner: CliRunner;
  startToolServer: (input: AgenticRunInput) => Promise<{ url: string; token: string; close(): Promise<void> }>;
  now?: () => EpochMs;
  onLocated?: (exePath: string) => void;
  onSmoke?: (r: { ok: boolean; at: EpochMs; ms: number | null }) => void;
  onQuota?: (q: LlmQuota) => void;
}): (input: { model: string }) => Promise<ClaudeCliProvider> {
  return async ({ model }) => {
    const loc = await deps.locator.find('claude_cli');
    if (loc === null) throw new LlmError('not_installed');
    if (loc.version === null || compareVersion(loc.version, CLAUDE_MIN_VERSION) < 0) throw new LlmError('version');
    deps.onLocated?.(loc.exePath);
    return createClaudeCliProvider({
      runner: deps.runner,
      locator: deps.locator,
      model,
      exePath: loc.exePath,
      observedVersion: loc.version,
      startToolServer: deps.startToolServer,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.onSmoke === undefined ? {} : { onSmoke: deps.onSmoke }),
      ...(deps.onQuota === undefined ? {} : { onQuota: deps.onQuota }),
    });
  };
}

/** sha256(name).slice(0,8) - the only form a model-supplied tool name is ever audited in ([R2]). */
export function nameSha8(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8);
}
