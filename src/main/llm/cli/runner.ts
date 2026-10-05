// src/main/llm/cli/{locator,runner,claudeCli,antigravityCli}.ts   [V2 ADD] (B12-B14, B26, I11)
// llm/cli/** MUST NOT import mcp/host, bridge/**, exec/** (ESLint + import-graph). The tool server arrives through AgenticRunInput / startToolServer injection.
// file 2 of 4 of the C2 9.2 block - owner V2-W1-06-claude-cli (the Wave-0 stub body is replaced below the frozen declarations).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CliProviderId, CliSandboxProof, EpochMs, LlmQuota } from '../../../shared/types';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import { LIMITS } from '../../../shared/types';
import type { ErrorCode } from '../../../shared/errors';
import type { ProviderErrorCode } from '../types';
import type { JobHandle, JobRunner, JobSpec } from '../../proc/jobRunner';
import { JobAbortedError, JobBreakerOpenError, JobSpawnError, JobSpecError } from '../../proc/jobRunner';
import {
  CLI_MCP_TOOL_PREFIX,
  CLI_SCHEMA_TOOL,
  CLAUDE_MCP_CONFIG_MODE,
  buildClaudeArgs,
  buildClaudeEnv,
  buildRunFileMcpConfig,
  checkClaudeInit,
  nameSha8,
  unwrapWrappedStructured,
  type ClaudeRunRequestExt,
} from './claudeCli';
import {
  agyEventResult,
  agyStepVerdict,
  buildAgentFile,
  buildAgyArgs,
  checkAgyInit,
  checkAgyPolicy,
  classifyAgyExit,
  classifyAgyResult,
  planAgyHome,
} from './antigravityCli';

// ---------------- runner.ts ----------------
/** Stages a CLI job may run. 'smoke' = provider-start smoke run and cli:test (constant prompt, 1-field schema, haiku / the Flash slug, max-turns 1). */
export type CliStage = 'extract' | 'draft' | 'read_image' | 'smoke';
export interface CliRunRequest {
  provider: CliProviderId;
  stage: CliStage;
  exePath: string;
  model: string; // settings.llm.cli.claudeModel / agyModel ; smoke: 'haiku' / the Flash slug
  system: string; // verbatim S1 / S3 / V1 constant (+ the constant CLI JSON-only line on S1/V1)
  stdinLine: string; // ONE stream-json line, provider-specific (F20): claude = buildClaudeStdinLine(), agy = buildAgyStdinLine() - never the other's envelope
  jsonSchema: object | null; // draft-07 JSON of the stage's schema (S1/V1/smoke) ; null on S3 text drafts
  maxTurns: number;
  wallClockMs: number; // LIMITS.cliWallClockDraftMs (S3) / cliWallClockExtractMs (S1, V1) / cliTestWallClockMs (smoke)
  toolServer: { url: string; token: string } | null; // claude S3 only ; everything else null
  observedVersion: string; // gates --permission-prompts none (>= 2.1.259)
}
export interface CliRunResult {
  sandbox: CliSandboxProof; // initOk=false => nothing below is used; the job is killed on the init line (best effort: the stdin line already went out at spawn, cli-sandbox-2)
  structured: unknown | null; // result.structured_output (UNTRUSTED; caller zod-parses)
  text: string | null; // result.result (S3) (UNTRUSTED; caller runs cleanDraft)
  toolCalls: number;
  blockedCalls: number; // permission_denials + tool_use blocks that are neither an EXPOSED mcp__wca__<name> (S3) nor (jsonSchema != null) CLI_SCHEMA_TOOL (F13) (each audited tool_blocked {nameSha8,nameLen,...})
  stopReason: 'end' | 'max_turns' | 'aborted' | 'killed' | 'bad_output';
  error: ProviderErrorCode | null; // is_error checked FIRST (subtype:'success' + is_error:true is a failure) ; api_retry.error / AGY_ERROR mapped
  quota: LlmQuota | null; // rate_limit_event / agy /usage
  usage: { inputTokens: number; outputTokens: number } | null;
  ms: number;
}
export interface CliRunner {
  /** Concurrency 1 (promise mutex over JobRunner kind 'cli'). Fresh empty cwd <userData>\cli-runs\<runId>\ (claude) or
   *  <userData>\agy-workspace\runs\<runId>\ (agy; agent file + schema.json written there), deleted in finally with the job kill.
   *  Fail-closed init proof on the FIRST event, before any later line is read (I11: the run is used only if it proved itself; the one stdin line is written at spawn, so the CLI already holds it - cli-sandbox-2); a mismatch kills the job, audits toolset_mismatch and returns sandbox.initOk=false
   *  - never a retry with looser flags. Writes the cli_run audit row (enums/numbers/booleans only). Budget: rate bucket cli_global
   *  (settings.llm.cli.maxRunsPerHour) checked before spawning; over budget => error 'usage_limit' without a spawn. */
  run(req: CliRunRequest, signal: AbortSignal): Promise<CliRunResult>;
  /** 3 kills or init failures in LIMITS.cliBreakerWindowMs => open => provider not_ready with CLI_UNSTABLE until a user "Test again". */
  breakerOpen(): boolean;
}

// =====================================================================================================================
// Implementation (V2-W1-06-claude-cli)
// =====================================================================================================================

type AuditFn = (
  kind: 'cli_run' | 'toolset_mismatch' | 'tool_blocked' | 'run_aborted',
  ref: string | null,
  detail: Record<string, string | number | boolean | null>,
) => void;

/** Rate bucket `cli_global` (every job counts, incl. repair retries and cli:test). Production = repos.rate; the COUNT is never a seam. */
export interface CliRunBudget {
  maxRunsPerHour(): number;
  countSince(since: EpochMs): number;
  record(at: EpochMs): void;
}
/** The fs slice the run dirs need (production = node:fs). */
export interface CliRunFs {
  mkdirSync(p: string, o: { recursive: true }): void;
  readdirSync(p: string): string[];
  writeFileSync(p: string, text: string): void;
  rmSync(p: string, o: { recursive: true; force: true }): void;
  /** [agy-provider-fix A] re-reads the isolated agy settings.json before every agy spawn (utf8). A seam without it cannot verify the
   *  deny-all policy, so every agy job is refused (fail closed); Claude jobs never read anything. */
  readFileSync?(p: string): string;
}
/** Extra members of the runner object (the provider and cli:test read them); the CliRunner interface stays the frozen one. */
export interface CliRunnerExt extends CliRunner {
  /** Why no run may start right now (breaker, overage pause, usage window) - null when nothing blocks. */
  health(): { code: ErrorCode; retryAtMs: EpochMs | null } | null;
  /** Only from a user click ("Test again"): closes the breaker and clears the overage / usage pauses. */
  resetBreaker(): void;
  /** The last quota the CLI reported (rate_limit_event), for AppHealth.llm.quota. */
  lastQuota(): LlmQuota | null;
  /** [D-080] Subscribes to every finished run (spawned or refused) - the status service flips "signed in" when a run proves the
   *  opposite. A throwing listener never affects the run. Returns the unsubscribe function. */
  onRunEnd(listener: (provider: CliProviderId, result: CliRunResult) => void): () => void;
}

export const NO_PROOF: CliSandboxProof = {
  initOk: false,
  toolsCount: 0,
  mcpServers: 0,
  apiKeySource: 'unknown',
  mismatch: null,
};

/** In-memory fallback of the `cli_global` bucket (production passes repos.rate through `budget`). */
function memoryBudget(): CliRunBudget {
  const hits: EpochMs[] = [];
  return {
    maxRunsPerHour: () => DEFAULT_SETTINGS.llm.cli.maxRunsPerHour,
    countSince: (since) => hits.filter((t) => t >= since).length,
    record: (at) => {
      hits.push(at);
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Claude `api_retry.error` -> ProviderErrorCode (ARCH2 4.1 result check; P2 13.1). */
export function mapApiRetryError(e: unknown): ProviderErrorCode | null {
  switch (e) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'auth';
    case 'account_on_hold':
      return 'account_hold';
    case 'rate_limit':
    case 'overloaded':
      return 'rate_limited';
    case 'model_not_found':
      return 'model_not_found';
    case 'billing_error':
      return 'billing';
    default:
      return null;
  }
}
/** Claude `result` text of an is_error result -> ProviderErrorCode (research 8.1). The text itself is never stored or logged. */
export function mapResultText(text: string): ProviderErrorCode {
  if (/hit your .*limit|usage limit|monthly spend limit|credit balance is too low/i.test(text)) return 'usage_limit';
  if (
    /not logged in|please run \/login|login expired|authentication required|oauth session expired|invalid api key/i.test(
      text,
    )
  )
    return 'not_logged_in';
  if (/account is on hold|account_on_hold/i.test(text)) return 'account_hold';
  if (/not a recognized model|model .*not found|not available with the claude|does not support this model/i.test(text))
    return 'model_not_found';
  if (/rate limit|\b429\b|temporarily limiting/i.test(text)) return 'rate_limited';
  if (/overloaded|\b529\b|high load|no response from api|request timed out/i.test(text)) return 'overloaded';
  return 'bad_output';
}
/** agy `AGY_ERROR:` line (exit 3) -> ProviderErrorCode (C2 9.2 binding table; field names ASSUMED U-A3). */
export function mapAgyError(line: string): ProviderErrorCode {
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(line)) return 'usage_limit';
  if (/authentication/i.test(line)) return 'not_logged_in';
  return 'network';
}

// ---------------- [D-080] an error event INSTEAD of the init ----------------
/** Cap of the in-memory error text (it is only regex-classified, never stored, logged or audited - B26). */
const ERROR_TEXT_MAX = 2000;
const errorPart = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
};
/**
 * The error text of a FIRST event that is an error / result event instead of the init, or null when it is not such an event (then the
 * normal fail-closed "no init" path applies). agy 1.2.16 (D-080 live capture): {"event":"result", conversation_id, status, response,
 * error, duration_seconds, num_turns, usage} - the nested {"event":"result","result":{...}} envelope and {"event":"error"} are read the
 * same way. Claude: a `result` event, or an `assistant` event carrying `error` (e.g. "authentication_failed"). Pure.
 */
export function errorTextBeforeInit(provider: CliProviderId, ev: Record<string, unknown>): string | null {
  const parts: unknown[] = [];
  if (provider === 'antigravity_cli') {
    if (ev.event !== 'result' && ev.event !== 'error') return null;
    parts.push(ev.error, ev.message);
    if (isRecord(ev.result)) parts.push(ev.result.error, ev.result.message);
  } else if (ev.type === 'result') {
    parts.push(ev.result, ev.errors, ev.error);
  } else if (ev.type === 'assistant' && ev.error !== undefined && ev.error !== null) {
    parts.push(ev.error);
    if (isRecord(ev.message) && Array.isArray(ev.message.content))
      for (const b of ev.message.content) if (isRecord(b) && b.type === 'text') parts.push(b.text);
  } else {
    return null;
  }
  return parts
    .map(errorPart)
    .filter((p) => p.length > 0)
    .join(' ')
    .slice(0, ERROR_TEXT_MAX);
}
const MODEL_REJECTED_RE =
  /invalid model|model selection|conflicts with --|unknown model|unsupported model|not a recognized model|issue with the selected model|model .{0,60}not (?:found|available|supported)|unknown option|invalid (?:value|argument|option)|invalid effort/i;
const AUTH_RE =
  /authenticat|not logged in|please run \/login|login expired|oauth|sign[ -]?in\b|credential|\b401\b|invalid api key/i;
const QUOTA_RE =
  /resource_exhausted|quota|usage limit|session limit|weekly limit|hit your .*limit|credit balance|\b429\b/i;
/**
 * [D-080] An error before init -> ProviderErrorCode: the error TEXT first, then the JobRunner's marker-only stderr view (B26 - stderr text
 * never leaves the job). model / flag rejection => model_rejected (CLI_MODEL_REJECTED); sign-in => not_logged_in (CLI_NOT_SIGNED_IN); quota
 * => usage_limit (CLOUD_QUOTA); rate limit / overload => their codes; anything else => network (CLOUD_UNAVAILABLE) - never 'sandbox'.
 * A model rejection wins over an auth word in the same text (the user has to pick another model either way). Pure.
 */
export function classifyErrorBeforeInit(text: string, stderrMarkers: readonly string[]): ProviderErrorCode {
  if (MODEL_REJECTED_RE.test(text)) return 'model_rejected';
  if (AUTH_RE.test(text)) return 'not_logged_in';
  if (QUOTA_RE.test(text)) return 'usage_limit';
  if (/rate[_ ]?limit/i.test(text)) return 'rate_limited';
  if (/overloaded|\b529\b/i.test(text)) return 'overloaded';
  const has = (m: string): boolean => stderrMarkers.includes(m);
  if (has('model_rejected') || has('model_not_found')) return 'model_rejected';
  if (has('authentication_failed') || has('auth_required')) return 'not_logged_in';
  if (has('usage_limit') || has('quota') || has('http_429')) return 'usage_limit';
  if (has('rate_limit')) return 'rate_limited';
  if (has('overloaded')) return 'overloaded';
  return 'network';
}

interface ParseState {
  init: unknown;
  /** [D-080] the error text of an error event that arrived INSTEAD of the init (in memory only, never logged or audited). */
  errorBeforeInit: string | null;
  /** [D-080] its classified code (the only form that reaches the audit). */
  errorBeforeInitCode: ProviderErrorCode | null;
  initSeen: boolean;
  initFailed: boolean;
  proof: CliSandboxProof;
  toolCalls: number;
  blocked: number;
  strikeAbort: boolean;
  lastApiRetry: ProviderErrorCode | null;
  quota: LlmQuota | null;
  usageWindowHit: boolean;
  overageKill: boolean;
  result: Record<string, unknown> | null;
  /** [claude-extract-debug] Claude schema runs: the answer of the LAST StructuredOutput call that wrapped it under one made-up key
   *  (unwrapWrappedStructured). Used only when the result carries no structured_output; memory only, never logged or audited. */
  schemaWrapped: Record<string, unknown> | null;
  agyErrorLine: string | null;
  agyAuthRequired: boolean;
  /** [agy-provider-fix C] the runtime tool watch saw a step that is not manage_task {"Action":"list"}: the job was killed at once. */
  agyToolBlocked: boolean;
}

/** [agy-provider-fix A] The isolated settings.json did not carry exactly the deny-all permissions policy after the write: no spawn. */
class AgyPolicyRefusal extends Error {
  constructor(public readonly verdict: 'missing' | 'altered') {
    super('agy_policy_refused');
    this.name = 'AgyPolicyRefusal';
  }
}

export function createCliRunner(deps: {
  jobs: JobRunner;
  userDataDir: string;
  now: () => EpochMs;
  audit: AuditFn;
  // ---- [V2-W1-06] additive, optional (production wiring = V2-W2-01) ----
  /** env the copied-by-name values come from (default process.env; never passed through wholesale). */
  processEnv?: Readonly<Record<string, string | undefined>>;
  /** `cli_global` bucket; default an in-memory bucket at DEFAULT_SETTINGS.llm.cli.maxRunsPerHour. */
  budget?: CliRunBudget;
  /** settings.llm.cli.allowOverage (written only by cli:setOverage); default false. */
  allowOverage?: () => boolean;
  /** e2e `WCA_CLI_CMD`: the fake's argv prefix for a seam command (locator.seamArgsPrefix). */
  argsPrefix?: (exePath: string) => readonly string[];
  /** F16 mode; default CLAUDE_MCP_CONFIG_MODE. */
  mcpConfigMode?: 'inline_env' | 'run_file';
  /** WCA_TIMERS jobGraceMs.cli (delays only); default LIMITS.cliKillGraceMs. */
  graceMs?: number;
  fs?: CliRunFs;
  randomId?: () => string;
}): CliRunnerExt {
  const processEnv = deps.processEnv ?? process.env;
  const budget = deps.budget ?? memoryBudget();
  const allowOverage = deps.allowOverage ?? ((): boolean => false);
  const argsPrefix = deps.argsPrefix ?? ((): readonly string[] => []);
  const mcpMode = deps.mcpConfigMode ?? CLAUDE_MCP_CONFIG_MODE;
  const graceMs = deps.graceMs ?? LIMITS.cliKillGraceMs;
  const rfs: CliRunFs = deps.fs ?? {
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
    readdirSync: (p) => fs.readdirSync(p),
    writeFileSync: (p, t) => fs.writeFileSync(p, t, { encoding: 'utf8', mode: 0o600 }),
    rmSync: (p, o) => fs.rmSync(p, o),
    readFileSync: (p) => fs.readFileSync(p, 'utf8'),
  };
  const newId = deps.randomId ?? ((): string => randomUUID());

  let chain: Promise<unknown> = Promise.resolve();
  let breakerHits: EpochMs[] = [];
  let breakerOpenedAt: EpochMs | null = null;
  let overagePaused: { until: EpochMs | null } | null = null;
  let usagePausedUntil: EpochMs | null = null;
  let quota: LlmQuota | null = null;
  /** [cli-sandbox-2] Providers whose init proved an identity / connector change (api_key_auth, extra_server). The stdin line is written
   *  at spawn (C2 13.1 transport), so a failed per-run proof cannot un-send it: the FIRST such failure pauses that provider (no spawn,
   *  error 'sandbox') until the user's "Test again" (resetBreaker), instead of letting up to cliBreakerFailures more runs carry data. */
  const proofPaused = new Set<CliProviderId>();
  const PAUSE_ON_FIRST: ReadonlyArray<CliSandboxProof['mismatch']> = ['api_key_auth', 'extra_server'];

  const pruneBreaker = (): void => {
    const since = deps.now() - LIMITS.cliBreakerWindowMs;
    breakerHits = breakerHits.filter((t) => t > since);
  };
  const breakerStrike = (): void => {
    breakerHits.push(deps.now());
    pruneBreaker();
    if (breakerHits.length >= LIMITS.cliBreakerFailures && breakerOpenedAt === null) breakerOpenedAt = deps.now();
  };

  const health = (): { code: ErrorCode; retryAtMs: EpochMs | null } | null => {
    if (breakerOpenedAt !== null) return { code: 'CLI_UNSTABLE', retryAtMs: null };
    if (overagePaused !== null) {
      if (allowOverage() || (overagePaused.until !== null && deps.now() >= overagePaused.until)) overagePaused = null;
      else return { code: 'CLOUD_OVERAGE', retryAtMs: overagePaused.until };
    }
    if (usagePausedUntil !== null) {
      if (deps.now() >= usagePausedUntil) usagePausedUntil = null;
      else return { code: 'CLOUD_QUOTA', retryAtMs: usagePausedUntil };
    }
    return null;
  };

  const refusal = (error: ProviderErrorCode): CliRunResult => ({
    sandbox: NO_PROOF,
    structured: null,
    text: null,
    toolCalls: 0,
    blockedCalls: 0,
    stopReason: 'aborted',
    error,
    quota,
    usage: null,
    ms: 0,
  });

  const runOnce = async (req: ClaudeRunRequestExt, signal: AbortSignal): Promise<CliRunResult> => {
    if (signal.aborted) return refusal('aborted');
    const h = health();
    if (h !== null)
      return refusal(h.code === 'CLOUD_OVERAGE' ? 'overage' : h.code === 'CLOUD_QUOTA' ? 'usage_limit' : 'not_ready');
    if (req.provider === 'antigravity_cli' && req.stage === 'read_image') return refusal('unsupported'); // capabilities.images:false
    if (proofPaused.has(req.provider)) return refusal('sandbox'); // [cli-sandbox-2] no user data to a CLI that proved a changed identity
    // Budget BEFORE any spawn (B13): the 21st run of the hour is refused without a process.
    const t0 = deps.now();
    if (budget.countSince(t0 - 3_600_000) >= Math.min(budget.maxRunsPerHour(), LIMITS.cliRunsPerHourMax))
      return refusal('usage_limit');
    budget.record(t0);

    const runId = newId();
    const runDir =
      req.provider === 'claude_cli'
        ? path.join(deps.userDataDir, 'cli-runs', runId)
        : path.join(deps.userDataDir, 'agy-workspace', 'runs', runId);
    const ref = req.auditRef ?? null;
    const st: ParseState = {
      init: null,
      errorBeforeInit: null,
      errorBeforeInitCode: null,
      initSeen: false,
      initFailed: false,
      proof: NO_PROOF,
      toolCalls: 0,
      blocked: 0,
      strikeAbort: false,
      lastApiRetry: null,
      quota: null,
      usageWindowHit: false,
      overageKill: false,
      result: null,
      schemaWrapped: null,
      agyErrorLine: null,
      agyAuthRequired: false,
      agyToolBlocked: false,
    };
    /** [agy-provider-fix A] agy only: the policy verdict of this job (deny_all, or why it was refused before the spawn). */
    let agyPolicy: 'deny_all' | 'missing' | 'altered' | null = null;
    let outcome: CliRunResult;
    try {
      rfs.mkdirSync(runDir, { recursive: true });
      if (rfs.readdirSync(runDir).length !== 0) throw new Error('cli_run_dir_not_empty'); // fresh + empty, or no run at all
      const spec = prepare(req, runDir);
      if (req.provider === 'antigravity_cli') agyPolicy = 'deny_all'; // prepare() throws AgyPolicyRefusal otherwise
      const done = await deps.jobs.run(spec, (job) => consume(job, req, st), signal);
      outcome = classify(req, st, done, signal);
    } catch (e) {
      outcome = refusal(
        e instanceof JobBreakerOpenError
          ? 'not_ready'
          : e instanceof JobAbortedError
            ? 'aborted'
            : e instanceof JobSpawnError
              ? e.errno === 'ENOENT'
                ? 'not_installed'
                : 'not_ready'
              : e instanceof JobSpecError
                ? 'not_ready'
                : 'not_ready',
      );
      if (e instanceof AgyPolicyRefusal) {
        // [agy-provider-fix A] fail closed BEFORE the spawn: the stdin line (message text) never leaves the app. Same handling as a failed
        // init proof ('sandbox' = CLI_TOOLSET_MISMATCH, never retried with looser settings), with the exact reason in the audit.
        agyPolicy = e.verdict;
        deps.audit('toolset_mismatch', ref, {
          provider: req.provider,
          stage: req.stage,
          reason: `policy_${e.verdict}`,
        });
        outcome = refusal('sandbox');
      }
    } finally {
      try {
        rfs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        // a locked file (AV scanner) must never fail the run; the leak scan and data:purgeNow sweep cli-runs\ as well
      }
    }
    outcome = { ...outcome, ms: deps.now() - t0 };
    deps.audit('cli_run', ref, {
      provider: req.provider,
      stage: req.stage,
      initOk: outcome.sandbox.initOk,
      toolsCount: outcome.sandbox.toolsCount,
      extraServers: Math.max(0, outcome.sandbox.mcpServers - (req.stage === 'draft' ? 1 : 0)),
      toolCalls: outcome.toolCalls,
      blockedCalls: outcome.blockedCalls,
      stopReason: outcome.stopReason,
      ms: outcome.ms,
      usageWindowHit: st.usageWindowHit,
      ...(st.errorBeforeInitCode === null ? {} : { errorBeforeInit: st.errorBeforeInitCode }),
      // [agy-provider-fix] what an agy proof rests on: the policy verdict of this job and the runtime tool watch (enums/booleans only)
      ...(req.provider === 'antigravity_cli' ? { policy: agyPolicy ?? 'not_checked', runtimeWatch: true } : {}),
    });
    return outcome;
  };

  /** argv / env / files of one job; the token never reaches argv (inline mode: env; run_file mode: a file inside the run dir). */
  const prepare = (req: ClaudeRunRequestExt, runDir: string): JobSpec => {
    const base = {
      kind: 'cli' as const,
      exePath: req.exePath,
      cwd: runDir,
      stdin: new TextEncoder().encode(`${req.stdinLine}\n`),
      stdout: 'ndjson' as const,
      wallClockMs: req.wallClockMs,
      graceMs,
      belowNormal: false,
    };
    if (req.provider === 'claude_cli') {
      let token: string | null = null;
      let args: string[];
      if (req.stage === 'draft' && req.toolServer !== null && mcpMode === 'run_file') {
        const file = path.join(runDir, 'wca.mcp.json');
        rfs.writeFileSync(file, buildRunFileMcpConfig(req.toolServer.url, req.toolServer.token));
        args = buildClaudeArgs(req, { mode: 'run_file', mcpConfigPath: file });
      } else {
        if (req.stage === 'draft' && req.toolServer !== null) token = req.toolServer.token;
        args = buildClaudeArgs(req, { mode: 'inline_env' });
      }
      return {
        ...base,
        args: [...argsPrefix(req.exePath), ...args],
        env: buildClaudeEnv({ processEnv, tempDir: runDir, token }),
      };
    }
    // antigravity_cli (lane L10 bodies): agent file (schema in its body) in the run dir, isolated profile env (F3). Never an MCP config.
    const stage = req.stage as 'extract' | 'draft' | 'smoke';
    const plan = planAgyHome(deps.userDataDir, path.join(deps.userDataDir, 'agy-workspace'));
    for (const f of plan.files) {
      rfs.mkdirSync(path.dirname(f.path), { recursive: true });
      rfs.writeFileSync(f.path, f.text);
    }
    // [agy-provider-fix A] re-read the isolated settings.json AFTER the write and refuse to spawn unless it carries exactly the deny-all
    // permissions policy (a lost / tampered write, an fs seam that cannot read, an unreadable file => no job at all).
    const settingsFile = plan.files.find((f) => path.win32.basename(f.path).toLowerCase() === 'settings.json');
    let settingsText: string | null;
    try {
      settingsText =
        settingsFile === undefined || rfs.readFileSync === undefined ? null : rfs.readFileSync(settingsFile.path);
    } catch {
      settingsText = null;
    }
    const policy = checkAgyPolicy(settingsText);
    if (policy !== 'deny_all') throw new AgyPolicyRefusal(policy);
    const agentDir = path.join(runDir, '.agents', 'agents');
    rfs.mkdirSync(agentDir, { recursive: true });
    // [agy-schema-loop] the schema rides in the agent body, never as --json-schema (agy then loops until its print timeout: see
    // agySchemaInstruction). No schema.json is written.
    rfs.writeFileSync(path.join(agentDir, `wca-${stage}.md`), buildAgentFile(stage, req.system, req.jsonSchema));
    const sysRoot = processEnv.SystemRoot ?? processEnv.SYSTEMROOT ?? 'C:\\Windows';
    const env: Record<string, string> = {
      SystemRoot: sysRoot,
      PATH: path.win32.join(sysRoot, 'System32'),
      // The profile vars are the isolated profile's ONLY (F3; U-A7): plan.env below wins; these defaults are already under agy-home,
      // never the real profile (cli-sandbox-3).
      USERPROFILE: plan.homeDir,
      HOME: plan.homeDir,
      APPDATA: path.win32.join(plan.homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.win32.join(plan.homeDir, 'AppData', 'Local'),
      TEMP: runDir,
      TMP: runDir,
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      ...(plan.env as Record<string, string>), // typed wide on purpose: it overrides the defaults above
    };
    return { ...base, args: [...argsPrefix(req.exePath), ...buildAgyArgs({ ...req, stage }, null)], env };
  };

  /** Reads the NDJSON stream. The init proof is asserted on the FIRST event, before any later line is looked at (I11). */
  const consume = async (
    job: JobHandle,
    req: ClaudeRunRequestExt,
    st: ParseState,
  ): Promise<Awaited<JobHandle['done']>> => {
    const isClaude = req.provider === 'claude_cli';
    const strike = (name: string): void => {
      st.blocked += 1;
      deps.audit('tool_blocked', req.auditRef ?? null, {
        nameSha8: nameSha8(name),
        nameLen: name.length,
        verdict: 'blocked_unknown_tool',
        runId: req.runId ?? null,
      });
      const abort = req.onStrike?.() ?? st.blocked >= LIMITS.blockedCallsAbort;
      if (abort && !st.strikeAbort) {
        st.strikeAbort = true;
        deps.audit('run_aborted', req.auditRef ?? null, {
          provider: req.provider,
          stage: req.stage,
          blockedCalls: st.blocked,
        });
        job.kill();
      }
    };
    for await (const line of job.lines()) {
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        if (!isClaude && /^AGY_ERROR:/.test(line.trim())) st.agyErrorLine = line.trim().slice(0, 200);
        if (!isClaude && /authentication required/i.test(line)) st.agyAuthRequired = true;
        continue; // tolerant: unparsable lines are ignored and never logged (B26)
      }
      if (!isRecord(ev)) continue;
      if (!st.initSeen) {
        st.initSeen = true;
        st.init = ev;
        st.proof = isClaude
          ? checkClaudeInit(ev, req, req.exposedNames ?? [])
          : checkAgyInit(ev, req.stage as 'extract' | 'draft' | 'smoke');
        if (!st.proof.initOk) {
          // [D-080] An ERROR event in place of the init (agy {"event":"result",...,"error"}, Claude result / assistant error): the CLI
          // refused to start (model / flag, sign-in, quota). Still no proof and nothing later is read (I11) - but it is classified by its
          // text, never reported as a toolset change (no toolset_mismatch audit, no breaker strike, never a retry with other flags).
          const errText = errorTextBeforeInit(req.provider, ev);
          if (errText !== null) {
            st.errorBeforeInit = errText;
            job.kill();
            break;
          }
          // Fail closed on the init line: kill (async taskkill - the CLI already holds the stdin line), audit, never a retry with looser flags.
          st.initFailed = true;
          deps.audit('toolset_mismatch', req.auditRef ?? null, {
            provider: req.provider,
            stage: req.stage,
            reason: st.proof.mismatch ?? 'no_init',
          });
          job.kill();
          break;
        }
        // [agy-provider-fix B/C] an agy init passes on its shape only (init.tools lists ALL available tools on 1.2.16): the proof rests on
        // the deny-all policy prepare() verified before this spawn and on the runtime tool watch below - recorded on the proof itself.
        if (!isClaude) st.proof = { ...st.proof, policy: 'deny_all', runtimeWatch: true };
        continue;
      }
      if (isClaude) {
        if (ev.type === 'assistant' && isRecord(ev.message) && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (!isRecord(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
            const name = block.name;
            // [cli-sandbox-1 / injection-v2-2, B17] Only an EXPOSED wca tool is a tool call. An mcp__wca__ name outside
            // req.exposedNames is not in the CLI's tool list, so Claude Code answers it locally ("No such tool") and never forwards
            // it to the loopback server: the ToolGate never sees it, so the runner strikes it here (case-sensitive, like the gate).
            if (
              req.stage === 'draft' &&
              name.startsWith(CLI_MCP_TOOL_PREFIX) &&
              (req.exposedNames ?? []).includes(name.slice(CLI_MCP_TOOL_PREFIX.length))
            )
              st.toolCalls += 1;
            else if (req.jsonSchema !== null && name === CLI_SCHEMA_TOOL) {
              // F13: never a strike. [claude-extract-debug] keep a wrapped answer (the CLI rejects that call itself).
              st.schemaWrapped = unwrapWrappedStructured(block.input, req.jsonSchema) ?? st.schemaWrapped;
              continue;
            } else strike(name);
          }
        } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
          st.lastApiRetry = mapApiRetryError(ev.error) ?? st.lastApiRetry;
        } else if (ev.type === 'rate_limit_event' && isRecord(ev.rate_limit_info)) {
          const info = ev.rate_limit_info;
          const resetsAtS = num(info.resetsAt);
          st.quota = {
            resetsAt: resetsAtS === null ? null : resetsAtS * 1000,
            usingOverage: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : null,
          };
          quota = st.quota;
          if (info.status === 'rejected') st.usageWindowHit = true;
          if (info.isUsingOverage === true && !allowOverage()) {
            // B13: overage = paid usage credits; stop NOW unless the user allowed it (cli:setOverage).
            st.overageKill = true;
            overagePaused = { until: st.quota.resetsAt };
            job.kill();
            break;
          }
        } else if (ev.type === 'result') {
          st.result = ev;
          const denials = ev.permission_denials;
          if (Array.isArray(denials))
            for (const d of denials) strike(isRecord(d) && typeof d.tool_name === 'string' ? d.tool_name : '');
        }
      } else {
        // [agy-provider-fix C] runtime tool watch: EVERY step_update is judged on its own (a DONE step counts even when its ACTIVE step was
        // missed). Anything but manage_task {"Action":"list"} kills the job at once - the run fails, its answer is never used, the strike
        // is audited with the hashed name only (B26) and counts for the breaker (classify).
        const step = agyStepVerdict(ev);
        if (step.kind === 'blocked') {
          st.blocked += 1;
          st.agyToolBlocked = true;
          st.strikeAbort = true;
          deps.audit('tool_blocked', req.auditRef ?? null, {
            nameSha8: nameSha8(step.name),
            nameLen: step.name.length,
            verdict: 'blocked_unknown_tool',
            runId: req.runId ?? null,
          });
          deps.audit('run_aborted', req.auditRef ?? null, {
            provider: req.provider,
            stage: req.stage,
            blockedCalls: st.blocked,
          });
          job.kill();
          break;
        }
        // agy 1.2.16 ends with {"event":"result","result":{conversation_id, status, response (the answer as a STRING), ...}} - no
        // structured_output (orchestrator capture 2026-10-05); classifyAgyResult parses result.response.
        const r = agyEventResult(ev);
        if (r !== null) st.result = r;
      }
      if (st.strikeAbort) break;
    }
    return job.done;
  };

  const classify = (
    req: ClaudeRunRequestExt,
    st: ParseState,
    done: Awaited<JobHandle['done']>,
    signal: AbortSignal,
  ): CliRunResult => {
    const out = (
      error: ProviderErrorCode | null,
      stopReason: CliRunResult['stopReason'],
      extra: Partial<Pick<CliRunResult, 'structured' | 'text' | 'usage'>> = {},
    ): CliRunResult => ({
      sandbox: st.proof,
      structured: extra.structured ?? null,
      text: extra.text ?? null,
      toolCalls: st.toolCalls,
      blockedCalls: st.blocked,
      stopReason,
      error,
      quota: st.quota,
      usage: extra.usage ?? null,
      ms: done.ms,
    });
    // 0. [D-080] an error event before init: a classified failure (text first, then the marker-only stderr view), never a pass.
    if (st.errorBeforeInit !== null) {
      if (signal.aborted) return { ...out('aborted', 'aborted'), sandbox: NO_PROOF };
      st.errorBeforeInitCode = classifyErrorBeforeInit(st.errorBeforeInit, done.stderrMarkers);
      return { ...out(st.errorBeforeInitCode, 'bad_output'), sandbox: NO_PROOF };
    }
    // 1. no proof => nothing of the run is used (I11). A missing init is a failed proof too.
    if (!st.initSeen || st.initFailed) {
      if (signal.aborted && !st.initSeen) return out('aborted', 'aborted');
      if (req.provider === 'antigravity_cli' && !st.initSeen && !done.timedOut && !done.killed) {
        // agy refused BEFORE any init (stderr markers only, B26): not signed in => not_logged_in; our ONE stdin line refused
        // ("malformed input" / "unsupported stream message") => not_ready (U-A6, never an argv fallback); AGY_ERROR => its code.
        // Nothing of the run is used and no proof exists; these are provider states, not instability (no breaker strike).
        const code = classifyAgyExit(done.exitCode, done.stderrMarkers);
        if (code !== null) return { ...out(code, 'bad_output'), sandbox: NO_PROOF };
      }
      if (st.initSeen && PAUSE_ON_FIRST.includes(st.proof.mismatch)) proofPaused.add(req.provider);
      breakerStrike();
      return { ...out('sandbox', 'killed'), sandbox: st.initSeen ? st.proof : NO_PROOF };
    }
    // [agy-provider-fix C] a tool step the watch blocked: a FAILED run (sandbox_ok = 0, CLI_TOOLSET_MISMATCH), never its answer, and a
    // breaker strike (3 in the window => CLI_UNSTABLE until the user's "Test again").
    if (req.provider === 'antigravity_cli' && st.agyToolBlocked) {
      breakerStrike();
      return { ...out('sandbox', 'killed'), sandbox: { ...st.proof, initOk: false, mismatch: 'extra_tool' } };
    }
    if (st.strikeAbort) return out(null, 'killed');
    if (st.overageKill) return out('overage', 'killed');
    if (signal.aborted) return out('aborted', 'aborted');
    if (done.timedOut) {
      breakerStrike();
      return out('network', 'killed');
    }
    if (req.provider === 'antigravity_cli') return classifyAgy(st, done, out);

    const r = st.result;
    if (r === null) {
      // crash mid-stream / killed without a result: a failed run, retried by the queue backoff; counts for the breaker.
      breakerStrike();
      return out(st.lastApiRetry ?? 'network', 'killed');
    }
    const usage = isRecord(r.usage)
      ? { inputTokens: num(r.usage.input_tokens) ?? 0, outputTokens: num(r.usage.output_tokens) ?? 0 }
      : undefined;
    const u = usage === undefined ? {} : { usage };
    // 1b. [claude-extract-debug] live 2.1.258: every StructuredOutput attempt wrapped the answer under one made-up key, the CLI
    // rejected each and ended with error_max_turns + is_error true (no structured_output). That subtype - and only that one, never a
    // usage-window hit - yields the wrapped object; the caller zod-validates it like any structured_output.
    if (req.jsonSchema !== null && r.subtype === 'error_max_turns' && st.schemaWrapped !== null && !st.usageWindowHit)
      return out(null, 'end', { ...u, structured: st.schemaWrapped });
    // 2. is_error FIRST (issue #79500: subtype 'success' + is_error true is a failure).
    if (r.is_error === true) {
      const text = typeof r.result === 'string' ? r.result : '';
      const code: ProviderErrorCode = st.usageWindowHit ? 'usage_limit' : (st.lastApiRetry ?? mapResultText(text));
      if (code === 'usage_limit' && st.quota?.resetsAt !== null && st.quota?.resetsAt !== undefined)
        usagePausedUntil = st.quota.resetsAt;
      return out(code, 'bad_output', u);
    }
    // 3. subtype, 4. refusal, 5. structured_output / result text.
    if (r.subtype === 'error_max_turns') return out('bad_output', 'max_turns', u);
    if (r.subtype !== 'success') return out('bad_output', 'bad_output', u);
    if (r.stop_reason === 'refusal') return out('bad_output', 'bad_output', u);
    const text = typeof r.result === 'string' ? r.result : null;
    if (req.jsonSchema !== null) {
      const structured = r.structured_output;
      if (structured !== undefined && structured !== null) return out(null, 'end', { ...u, structured });
      if (st.schemaWrapped !== null) return out(null, 'end', { ...u, structured: st.schemaWrapped });
      if (text !== null && text.trim().length > 0) return out(null, 'end', { ...u, text }); // fence-strip path (P2 6.3)
      return out('bad_output', 'bad_output', u);
    }
    if (text === null || text.trim().length === 0) return out('bad_output', 'bad_output', u);
    return out(null, 'end', { ...u, text });
  };

  const classifyAgy = (
    st: ParseState,
    done: Awaited<JobHandle['done']>,
    out: (
      e: ProviderErrorCode | null,
      s: CliRunResult['stopReason'],
      x?: Partial<Pick<CliRunResult, 'structured' | 'text' | 'usage'>>,
    ) => CliRunResult,
  ): CliRunResult => {
    // Error exits are classified from the JobRunner's marker-only stderr view (agy prints AGY_ERROR / auth prompts on STDERR,
    // research 5.6); a non-JSON stdout line of the same form is kept as a fallback (output format UNVERIFIED, U-A3).
    const fromStderr = classifyAgyExit(done.exitCode, done.stderrMarkers);
    if (fromStderr !== null) return out(fromStderr, 'bad_output');
    if (done.exitCode === 3 && st.agyErrorLine !== null) return out(mapAgyError(st.agyErrorLine), 'bad_output');
    if (done.exitCode === 1 && st.agyAuthRequired) return out('not_logged_in', 'bad_output');
    // [agy-provider-fix] "[agy] print timeout after ... returning partial output" (stderr, 1.2.16): whatever came back is partial - never
    // used, even when it happens to parse. Treated like our own wall-clock timeout (CLOUD_UNAVAILABLE + a breaker strike).
    if (done.stderrMarkers.includes('print_timeout')) {
      breakerStrike();
      return out('network', 'killed');
    }
    if (done.exitCode !== 0 || st.result === null) {
      breakerStrike();
      return out('network', 'killed');
    }
    // Result table (B14, C2 9.2): SUCCESS + an answer (structured_output, or result.response parsed - D) + empty denied_actions => ok;
    // anything else => bad_output, never retried.
    const verdict = classifyAgyResult(st.result);
    if (!verdict.ok) return out(verdict.error, 'bad_output');
    return out(null, 'end', { structured: verdict.structured });
  };

  const runEndListeners = new Set<(provider: CliProviderId, result: CliRunResult) => void>();
  const notifyRunEnd = (provider: CliProviderId, result: CliRunResult): CliRunResult => {
    for (const l of runEndListeners) {
      try {
        l(provider, result);
      } catch {
        // a subscriber never affects the run
      }
    }
    return result;
  };

  return {
    run(req: CliRunRequest, signal: AbortSignal): Promise<CliRunResult> {
      // Concurrency 1 over BOTH CLIs (B13/B14): one runner-level chain, on top of the JobRunner 'cli' mutex.
      const next = chain
        .then(() => runOnce(req as ClaudeRunRequestExt, signal))
        .then((res) => notifyRunEnd(req.provider, res));
      chain = next.catch(() => undefined);
      return next;
    },
    breakerOpen() {
      pruneBreaker();
      return breakerOpenedAt !== null;
    },
    health,
    resetBreaker() {
      breakerHits = [];
      breakerOpenedAt = null;
      overagePaused = null;
      usagePausedUntil = null;
      proofPaused.clear();
    },
    lastQuota: () => quota,
    onRunEnd(listener) {
      runEndListeners.add(listener);
      return () => {
        runEndListeners.delete(listener);
      };
    },
  };
}
