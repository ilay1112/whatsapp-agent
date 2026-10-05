// src/main/llm/cli/{locator,runner,claudeCli,antigravityCli}.ts   [V2 ADD] (B12-B14, B26, I11)
// llm/cli/** MUST NOT import mcp/host, bridge/**, exec/** (ESLint + import-graph). The tool server arrives through AgenticRunInput / startToolServer injection.
// file 4 of 4 of the C2 9.2 block - owner V2-W1-09-antigravity (the Wave-0 stub bodies are replaced below the frozen declarations).
// Release of this provider stays gated on M-AGY-1 (user-run, only if the user installs agy). No code here ever runs agy: every test drives
// tests/fakes/fake-agy.mjs under the system node.exe (T8), with mkdtemp homes (T9).
import nodeFs from 'node:fs';
import path from 'node:path';
import type { CliSandboxProof, EpochMs, JsonSchemaLcd, LlmQuota, Result } from '../../../shared/types';
import { AgyModelSchema, DEFAULT_SETTINGS } from '../../../shared/settings';
import { LIMITS } from '../../../shared/types';
import type { ErrorCode } from '../../../shared/errors';
import type { CliRunRequest, CliRunResult, CliRunner } from './runner';
import { compareVersion, type CliLocator } from './locator';
import type { CallOpts, LlmMessage, LlmProvider, LlmResponse, ProviderErrorCode } from '../types';
import { LlmError } from '../types';
import type { AgyRunningFn, HomeDirFn } from '../../deps';
import type { JobRunner } from '../../proc/jobRunner';
import { AGY_ENV_KEYS } from '../../proc/jobRunner';
import { CLI_SMOKE_SCHEMA, CLI_SMOKE_SYSTEM, CLI_SMOKE_USER } from './claudeCli';
import { AGY_DENY_ALL, AGY_HOME_DIR, AGY_WORKSPACE_DIR, checkAgyPolicy, planAgyHome } from './claudeCli.env';

// ---------------- antigravityCli.ts (lane L10, built last, release-gated on M-AGY-1) ----------------
export const AGY_MIN_VERSION = '1.2.11';
/** [D-080] The effort level a model slug carries as its suffix (`gemini-3.8-flash-high` => 'high'), null when it has none
 *  (`gemini-3.8-flash`, `gemini-3.5-flash-lite`). Such a slug is never combined with `--effort` (agy 1.2.16 refuses the pair). */
export const AGY_EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|max)$/i;
export function agyModelEffort(model: string): string | null {
  const m = AGY_EFFORT_SUFFIX_RE.exec(model);
  return m === null ? null : (m[1] ?? '').toLowerCase();
}
/** argv: --agent wca-<stage> --model <slug> [--effort low, only when the slug carries no effort suffix - D-080] --output-format stream-json --input-format stream-json --print-timeout <wall-10 s>
 *  --disable-slash-commands [--json-schema <runDir>\schema.json] ; prompt = ONE stream-json user line on stdin, NEVER -p <text> (C11, U-A6:
 *  a stdin failure => provider not_ready, never an argv fallback). No .agents\mcp_config.json exists in v2. */
export function buildAgyArgs(
  req: CliRunRequest & { stage: 'extract' | 'draft' | 'smoke' },
  schemaPath: string | null,
): string[] {
  const stage = agyStageOf(req.stage);
  // The model slug is a settings value (AgyModelSchema), never message text; re-checked here so nothing option-like reaches argv.
  if (!isSafeAgyModel(req.model)) throw new Error('agy_bad_model');
  if (schemaPath !== null && (schemaPath.length === 0 || path.win32.basename(schemaPath) !== AGY_SCHEMA_FILE))
    throw new Error('agy_bad_schema_path');
  const args = [
    '--agent',
    agyAgentName(stage),
    '--model',
    req.model,
    // [D-080] live diagnostic (agy 1.2.16): a slug that already carries its effort (`agy models` lists e.g. gemini-3.8-flash-high) refuses
    // `--effort` ("--model X-high conflicts with --effort=low", exit 1). The slug's own effort is then the run's effort.
    ...(agyModelEffort(req.model) === null ? ['--effort', 'low'] : []),
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--print-timeout',
    agyPrintTimeout(req.wallClockMs),
    '--disable-slash-commands',
  ];
  if (schemaPath !== null) args.push('--json-schema', schemaPath);
  return args;
}
/** [F20] agy's own envelope, text only: {"event":"user","message":{"content":"<text>"}} (antigravity.google/docs/cli/headless; non-text blocks exit 1). */
export function buildAgyStdinLine(text: string): string {
  // JSON.stringify escapes \n / \r and lone surrogates, so the envelope is always exactly ONE line (the runner appends the '\n').
  return JSON.stringify({ event: 'user', message: { content: text } });
}
/** [F3] Isolated profile (default): planAgyHome lives in claudeCli.env.ts since cli-sandbox-3 (the locator's probes use the same profile
 *  and must not import this file - import cycle); re-exported here unchanged for every existing importer. */
export { planAgyHome };
/** [agy-provider-fix A] The deny-all permissions policy written into the isolated profile and its checker (claudeCli.env.ts, re-exported). */
export { AGY_DENY_ALL, checkAgyPolicy };
/** [F3] Global-profile FALLBACK mode only (chosen by M-AGY-1 if isolation breaks auth): run before EVERY job. Any enabled server in
 *  ~/.gemini/config/mcp_config.json, any hook in hooks.json, or an unparsable file => 'unsafe' (provider not_ready, CLI_UNSAFE_CONFIG, no spawn). */
export function preflightAgyGlobalConfig(mcpConfigText: string | null, hooksText: string | null): 'safe' | 'unsafe' {
  if (mcpConfigText !== null) {
    const mcp = parseJsonObject(mcpConfigText);
    if (mcp === null) return 'unsafe';
    for (const [key, value] of Object.entries(mcp)) {
      if (key === '$schema') continue;
      if (key !== 'mcpServers') return 'unsafe'; // an unknown top-level key might register servers another way: fail closed
      if (!isRecord(value)) return 'unsafe';
      for (const server of Object.values(value)) {
        // only an explicitly disabled server is harmless; anything else (enabled, missing flag, odd shape) is unsafe
        if (!isRecord(server) || server.disabled !== true) return 'unsafe';
      }
    }
  }
  if (hooksText !== null) {
    const hooks = parseJsonObject(hooksText);
    if (hooks === null) return 'unsafe';
    if (!isEmptyish(hooks, 0)) return 'unsafe'; // any hook entry at all (enabled or not) - hooks see conversation ids and paths
  }
  return 'safe';
}
export const AGY_PROFILE_MODE: 'isolated' | 'global_checked' = 'isolated'; // flipped only by a decision after M-AGY-1
/** The per-run agent file .agents\agents\wca-<stage>.md: frontmatter {name, description, tools: [], commandExecutionPolicy: off,
 *  excludeDefaultComponents: true, mainAgent: true, subagent: false, model: inherit} + body = the verbatim constant. Pure; no untrusted parameter (I4'). */
export function buildAgentFile(
  stage: 'extract' | 'draft' | 'smoke',
  systemConstant: string,
  schema: object | null = null,
): string {
  const s = agyStageOf(stage);
  if (typeof systemConstant !== 'string' || systemConstant.length === 0) throw new Error('agy_empty_system');
  const frontmatter = [
    '---',
    `name: ${agyAgentName(s)}`,
    `description: WhatsApp Calendar Agent ${s} stage. Returns JSON only.`,
    'tools: []',
    'commandExecutionPolicy: off',
    'excludeDefaultComponents: true',
    'mainAgent: true',
    'subagent: false',
    'model: inherit',
    '---',
    '',
  ].join('\n');
  // Body = the verbatim S1 / S3 / smoke constant, byte for byte (no trailing newline added: the fake hashes exactly this), plus - for a
  // structured stage - the schema instruction (agySchemaInstruction; the schema is a code constant, never message text).
  return `${frontmatter}${systemConstant}${schema === null ? '' : agySchemaInstruction(schema)}`;
}
/** [agy-schema-loop] The answer format, appended to the agent body of a structured stage. agy 1.2.16 with `--json-schema` only accepts
 *  the answer through its built-in `finish` tool; an agent with `tools: []` cannot call it, so agy re-prompts after every valid answer
 *  until its print timeout (live capture 2026-10-05: smoke 4 turns + "print timeout", S1 the same object 4x in result.response). The
 *  app therefore never passes `--json-schema` to agy: the schema travels in the instructions, the answer is the JSON text in
 *  result.response (parseAgyResponse) and the caller zod-validates it like every provider's answer. The marker line is fixed and the
 *  schema is its LAST line (one JSON line), so the fake can read it back. */
export const AGY_SCHEMA_MARKER =
  'Answer format: reply with exactly ONE JSON object that validates against the JSON Schema on the next line, and nothing else (no prose, no code fence, no tool call).';
export function agySchemaInstruction(schema: object): string {
  return `\n\n${AGY_SCHEMA_MARKER}\n${JSON.stringify(schema)}`;
}
/** init.agent === 'wca-<stage>' && init.tools an array && no MCP server && init.permission_mode === 'request-review'.
 *  [agy-provider-fix B] agy 1.2.16 ALWAYS lists every available tool (60) in init.tools - Google's docs define it as "names of all available
 *  tools" - while the agent file's `tools: []` is enforced at call time. The list is therefore recorded as information only (toolsCount);
 *  the I11 proof of an agy run rests on (A) the deny-all permissions policy the runner re-reads before every spawn, (C) the runner's runtime
 *  tool watch (agyStepVerdict on every step_update), and the agent file. A missing / non-array list is still no proof (fail closed).
 *  Result: status 'WAITING', non-empty denied_actions or no parseable answer => bad_output (LLM_BAD_OUTPUT), never a permissions retry. */
export function checkAgyInit(init: unknown, stage: 'extract' | 'draft' | 'smoke'): CliSandboxProof {
  const fail = (mismatch: CliSandboxProof['mismatch'], toolsCount = 0, mcpServers = 0): CliSandboxProof => ({
    initOk: false,
    toolsCount,
    mcpServers,
    apiKeySource: 'unknown',
    mismatch,
  });
  // The FIRST stdout event must be the documented envelope {"event":"init","init":{...}} - anything else is "no init" (fail closed).
  if (!isRecord(init) || init.event !== 'init' || !isRecord(init.init)) return fail(null);
  const i = init.init;
  const tools = i.tools;
  const toolsCount = Array.isArray(tools) ? tools.length : 0;
  const servers = i.mcp_servers;
  const mcpServers = Array.isArray(servers) ? servers.length : 0;
  // A missing / non-array list is not the documented init: no proof. Its LENGTH is information only (agy-provider-fix B).
  if (!Array.isArray(tools)) return fail('extra_tool', toolsCount, mcpServers);
  if (servers !== undefined && (!Array.isArray(servers) || servers.length !== 0))
    return fail('extra_server', toolsCount, mcpServers);
  let expected: string;
  try {
    expected = agyAgentName(agyStageOf(stage));
  } catch {
    return fail('agent_mismatch', toolsCount, mcpServers);
  }
  if (i.agent !== expected) return fail('agent_mismatch', toolsCount, mcpServers);
  if (i.permission_mode !== 'request-review') return fail('permission_mode', toolsCount, mcpServers);
  // agy reports no credential source; the provider is never proven better than 'cli_unproven' in v2.0 anyway (B14/C4). The runner adds
  // policy:'deny_all' + runtimeWatch:true to this proof (it verified the policy before the spawn and watches every step after it).
  return { initOk: true, toolsCount, mcpServers: 0, apiKeySource: 'unknown', mismatch: null };
}

/** [agy-provider-fix C] The one tool step agy 1.2.16 makes by itself even in a plain run (orchestrator capture): manage_task with
 *  parameters EXACTLY {"Action":"list"} (output "No background tasks are currently running."). Nothing else is ever tolerated. */
export const AGY_TOLERATED_TOOL = 'manage_task';
export type AgyStepVerdict = { kind: 'none' } | { kind: 'allowed' } | { kind: 'blocked'; name: string };
const AGY_NON_TOOL_STEPS: readonly unknown[] = ['agent_response', 'user_input'];
/**
 * [agy-provider-fix C] The runtime tool watch over ONE stream-json event (pure). Non-step events => none. A step_update whose step_type
 * is 'agent_response' / 'user_input' and that carries no tool field => none. Every other step_update is a tool step (an unknown step kind
 * or a malformed payload too - fail closed): 'allowed' only for tool_name 'manage_task' (tool_info.name absent or equal) with
 * tool_info.parameters exactly {"Action":"list"}, in ANY state (ACTIVE / DONE / ERROR); everything else => blocked with the name the
 * runner hashes for the audit (B26: never stored in clear). A DONE step is judged on its own, so a missed ACTIVE step changes nothing.
 */
export function agyStepVerdict(ev: unknown): AgyStepVerdict {
  if (!isRecord(ev) || ev.event !== 'step_update') return { kind: 'none' };
  const s = ev.step_update;
  if (!isRecord(s)) return { kind: 'blocked', name: '' };
  const info = s.tool_info;
  const hasToolFields = s.tool_name !== undefined || info !== undefined;
  if (AGY_NON_TOOL_STEPS.includes(s.step_type) && !hasToolFields) return { kind: 'none' };
  const name =
    typeof s.tool_name === 'string'
      ? s.tool_name
      : isRecord(info) && typeof info.name === 'string'
        ? info.name
        : s.step_type !== 'tool' && typeof s.step_type === 'string'
          ? `step:${s.step_type}`
          : '';
  if (
    s.step_type === 'tool' &&
    s.tool_name === AGY_TOLERATED_TOOL &&
    isRecord(info) &&
    (info.name === undefined || info.name === AGY_TOLERATED_TOOL) &&
    isRecord(info.parameters) &&
    Object.keys(info.parameters).length === 1 &&
    info.parameters.Action === 'list'
  )
    return { kind: 'allowed' };
  return { kind: 'blocked', name };
}
/** cli:allowWorkspace (AGY_PROFILE_MODE 'global_checked' ONLY; in 'isolated' mode the app-owned profile already trusts the workspace and the
 *  channel answers BAD_REQUEST): read-merge-write of ONLY `trustedWorkspaces` in %USERPROFILE%\.gemini\antigravity-cli\settings.json (backup
 *  written next to it first; refused while an agy process runs). Returns the one-line diff shown in the native dialog. */
export function planWorkspaceTrust(
  currentJsonText: string | null,
  workspaceDir: string,
): { diffLine: string; nextJsonText: string } | { error: 'unparsable' } {
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) return { error: 'unparsable' };
  // UX2 7.4 display text (app-built from the app's own folder, never from the file): `+ "trustedWorkspaces": [ ..., "<dir>" ]`.
  const addLine = (keepsOthers: boolean): string =>
    `+ "trustedWorkspaces": [ ${keepsOthers ? '..., ' : ''}"${workspaceDir}" ]`;
  if (currentJsonText === null) {
    return {
      diffLine: addLine(false),
      nextJsonText: `${JSON.stringify({ trustedWorkspaces: [workspaceDir] }, null, 2)}\n`,
    };
  }
  const text = stripBom(currentJsonText);
  const current = parseJsonObject(text);
  if (current === null) return { error: 'unparsable' };
  // Round-trip guard: a file that JSON.parse + JSON.stringify would NOT reproduce key-for-key (duplicate keys, integer-like keys that
  // JavaScript re-orders, non-canonical numbers or escapes) is refused - rewriting it could change more than the one key.
  if (minifyJson(text) !== JSON.stringify(current)) return { error: 'unparsable' };
  const existing = current.trustedWorkspaces;
  if (existing !== undefined && !(Array.isArray(existing) && existing.every((w) => typeof w === 'string')))
    return { error: 'unparsable' };
  const list = (existing ?? []) as string[];
  if (list.includes(workspaceDir))
    return { diffLine: `= "trustedWorkspaces" already contains "${workspaceDir}"`, nextJsonText: text };
  const diffLine = addLine(list.length > 0);
  const next: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(current)) {
    if (k === 'trustedWorkspaces') {
      next[k] = [...list, workspaceDir];
      placed = true;
    } else next[k] = v;
  }
  if (!placed) next.trustedWorkspaces = [workspaceDir];
  return { diffLine, nextJsonText: `${JSON.stringify(next, null, 2)}\n` };
}

// ---- v2-build-plan section 3 seam (W1-09) ----
/** Parses `agy models` output; never a hard-coded list. */
export function listAgyModels(runner: CliRunner, probe?: AgyModelsProbe): Promise<string[]> {
  // [V2-W1-09] `agy models` is not a CliRunner stage (the runner only runs agent jobs), so the listing needs the JobRunner + the located exe
  // (the additive `probe`). Without it there is nothing to ask: an empty list (the renderer keeps the current setting), never a guess.
  void runner;
  if (probe === undefined) return Promise.resolve([]);
  return runAgyModels(probe);
}
export interface AgyWorkspace {
  preview(): Promise<{ diffLine: string } | { error: string }>;
  allow(confirmed: true): Promise<Result<void>>;
}
/** Built on planWorkspaceTrust (C2 9.2); home via S-HOME, "is agy running" via S-PROC. */
export function createAgyWorkspace(deps: {
  home: HomeDirFn /* S-HOME */;
  proc: AgyRunningFn /* S-PROC */;
  fs: {
    readFileSync(p: string, enc: 'utf8'): string;
    writeFileSync(p: string, text: string): void;
    existsSync(p: string): boolean;
  };
  userDataDir: string;
  // ---- [V2-W1-09] additive, optional ----
  /** default AGY_PROFILE_MODE; only 'global_checked' ever edits the user's settings.json. */
  mode?: 'isolated' | 'global_checked';
  /** creates the settings folder when the file does not exist yet (default: none -> a missing folder fails the write). */
  mkdirSync?: (p: string, o: { recursive: true }) => void;
}): AgyWorkspace {
  const mode = deps.mode ?? AGY_PROFILE_MODE;
  const workspaceDir = path.win32.join(deps.userDataDir, AGY_WORKSPACE_DIR);
  let lastShown: { diffLine: string; current: string | null } | null = null;

  const settingsPath = (): string | null => {
    const home = deps.home();
    // Only an absolute S-HOME path; the settings path is derived from it and nothing else (never a renderer value).
    if (typeof home !== 'string' || !path.win32.isAbsolute(home) || /(^|[\\/])\.\.([\\/]|$)/.test(home)) return null;
    return path.win32.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  };
  const readCurrent = (file: string): { text: string | null } | null => {
    try {
      return { text: deps.fs.existsSync(file) ? deps.fs.readFileSync(file, 'utf8') : null };
    } catch {
      return null;
    }
  };
  const plan = ():
    { file: string; current: string | null; diffLine: string; nextJsonText: string } | { error: string } => {
    if (mode !== 'global_checked') return { error: 'isolated_profile' };
    const file = settingsPath();
    if (file === null) return { error: 'no_home' };
    const cur = readCurrent(file);
    if (cur === null) return { error: 'unreadable' };
    const p = planWorkspaceTrust(cur.text, workspaceDir);
    if ('error' in p) return { error: p.error };
    return { file, current: cur.text, diffLine: p.diffLine, nextJsonText: p.nextJsonText };
  };
  const failed = (code: ErrorCode, reason?: string): Result<void> => ({
    ok: false,
    error: reason === undefined ? { code } : { code, params: { reason } },
  });

  return {
    async preview() {
      const p = plan();
      if ('error' in p) {
        lastShown = null;
        return { error: p.error };
      }
      lastShown = { diffLine: p.diffLine, current: p.current };
      return { diffLine: p.diffLine };
    },
    async allow(confirmed: true) {
      if (confirmed !== true) return failed('BAD_REQUEST', 'not_confirmed');
      if (mode !== 'global_checked') return failed('BAD_REQUEST', 'isolated_profile');
      let running: boolean;
      try {
        running = await deps.proc();
      } catch {
        running = true; // cannot tell => refuse (fail closed)
      }
      if (running) return failed('BAD_REQUEST', 'agy_running');
      const p = plan();
      if ('error' in p) return failed('BAD_REQUEST', p.error);
      // The dialog showed `lastShown`; if the file changed in ANY byte since, refuse - never write something the user did not see.
      if (lastShown === null || lastShown.diffLine !== p.diffLine || lastShown.current !== p.current)
        return failed('BAD_REQUEST', 'diff_changed');
      lastShown = null;
      if (p.current !== null && p.nextJsonText === p.current) return { ok: true, value: undefined }; // already trusted: nothing written
      try {
        if (p.current === null) deps.mkdirSync?.(path.win32.dirname(p.file), { recursive: true });
        else deps.fs.writeFileSync(backupPathFor(p.file, deps.fs.existsSync), p.current); // backup FIRST, exact original bytes
        deps.fs.writeFileSync(p.file, p.nextJsonText);
        if (deps.fs.readFileSync(p.file, 'utf8') !== p.nextJsonText) return failed('INTERNAL', 'verify');
      } catch {
        return failed('INTERNAL', 'write');
      }
      return { ok: true, value: undefined };
    },
  };
}
/** [W0 seam] The antigravity_cli LlmProvider (loop 'prefetch', capabilities.images false); built only by llm/factory.ts (makeAgy). */
export function createAgyProvider(deps: {
  runner: CliRunner;
  locator: CliLocator;
  model: string;
  exePath: string;
  userDataDir: string;
  // ---- [V2-W1-09] additive, optional ----
  /** the version the locator read when the provider was built (factory cache key, floor); absent => validate() asks the locator. */
  observedVersion?: string;
  now?: () => EpochMs;
  onSmoke?: (r: { ok: boolean; at: EpochMs; ms: number | null }) => void;
  onQuota?: (q: LlmQuota) => void;
  /** default AGY_PROFILE_MODE. 'global_checked' runs preflightAgyGlobalConfig() over readGlobalConfig() before EVERY job. */
  profileMode?: 'isolated' | 'global_checked';
  /** S-HOME reads of ~/.gemini/config/{mcp_config,hooks}.json (null = file absent); fallback mode only. */
  readGlobalConfig?: () => { mcpConfigText: string | null; hooksText: string | null };
}): AgyProvider {
  const now = deps.now ?? ((): EpochMs => Date.now());
  const runner = deps.runner as CliRunner & { health?: () => { code: ErrorCode; retryAtMs: EpochMs | null } | null };
  const profileMode = deps.profileMode ?? AGY_PROFILE_MODE;
  let observedVersion: string | null = deps.observedVersion ?? null;
  let disposed = new AbortController();
  let smokeOkAt: EpochMs | null = null;

  const signalFor = (s: AbortSignal): AbortSignal => AbortSignal.any([s, disposed.signal]);
  const reportQuota = (res: CliRunResult, opts: CallOpts | null): void => {
    if (res.quota === null) return;
    opts?.onQuota?.(res.quota);
    deps.onQuota?.(res.quota);
  };
  /** Fail-closed guards run before EVERY job: the version floor and (fallback mode only) the global-config preflight. */
  const guard = (): void => {
    if (observedVersion !== null && compareVersion(observedVersion, AGY_MIN_VERSION) < 0) throw new LlmError('version');
    if (profileMode === 'global_checked') {
      let verdict: 'safe' | 'unsafe';
      try {
        const g = deps.readGlobalConfig?.();
        verdict = g === undefined ? 'unsafe' : preflightAgyGlobalConfig(g.mcpConfigText, g.hooksText);
      } catch {
        verdict = 'unsafe';
      }
      // CLI_UNSAFE_CONFIG has no ProviderErrorCode (REQUEST in the notes); 'sandbox' keeps it a non-retried refusal with no spawn.
      if (verdict === 'unsafe') throw new LlmError('sandbox');
    }
  };
  const runJob = async (
    stage: AgyStage,
    system: string,
    text: string,
    schema: object,
    wallClockMs: number,
    model: string,
    signal: AbortSignal,
  ): Promise<CliRunResult> =>
    deps.runner.run(
      {
        provider: 'antigravity_cli',
        stage,
        exePath: deps.exePath,
        model,
        system,
        stdinLine: buildAgyStdinLine(text),
        jsonSchema: schema,
        maxTurns: 1,
        wallClockMs,
        toolServer: null,
        observedVersion: observedVersion ?? '',
      },
      signalFor(signal),
    );

  const provider: AgyProvider = {
    id: 'antigravity_cli',
    model: deps.model,
    loop: 'prefetch',
    capabilities: { images: false },
    exePath: deps.exePath,
    get observedVersion(): string {
      return observedVersion ?? '';
    },

    async structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T> {
      // Pictures never go to agy in v2.0 (U-A2): readImage routes antigravity_cli to Local; a V1 call here is a programming error.
      if (opts.purpose === 'read_image') throw new LlmError('unsupported');
      const split = splitAgyMessages(messages);
      if (split === null) throw new LlmError('unsupported');
      guard();
      const stage: AgyStage = opts.purpose === 'draft' ? 'draft' : 'extract';
      const res = await runJob(
        stage,
        split.system,
        split.text,
        schema,
        stage === 'draft' ? LIMITS.cliWallClockDraftMs : LIMITS.cliWallClockExtractMs,
        deps.model,
        opts.signal,
      );
      opts.onSandbox?.(res.sandbox);
      reportQuota(res, opts);
      if (res.usage !== null) opts.onUsage?.(res.usage);
      if (!res.sandbox.initOk) throw new LlmError(res.error ?? 'sandbox');
      if (res.error !== null) throw new LlmError(res.error);
      if (res.structured === null || res.structured === undefined) throw new LlmError('bad_output'); // bug #794: never a retry with tools
      return res.structured as T;
    },

    chat(): Promise<LlmResponse> {
      // ARCH2 4.2: loop 'prefetch' - draft.ts never calls chat() for a CLI provider; there is no turn loop and no tool at all (B14).
      return Promise.reject(new LlmError('unsupported'));
    },

    async validate(
      signal: AbortSignal,
    ): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
      try {
        if (observedVersion === null)
          observedVersion = await deps.locator.version(deps.exePath, signal).catch(() => null);
        if (observedVersion === null || compareVersion(observedVersion, AGY_MIN_VERSION) < 0)
          return { ok: false, reason: 'version' };
        guard();
        const started = now();
        // Provider-start smoke (B12/B13): constant prompt, 1-field schema, the configured model (default the Flash slug), no user data.
        const res = await runJob(
          'smoke',
          CLI_SMOKE_SYSTEM,
          CLI_SMOKE_USER,
          CLI_SMOKE_SCHEMA,
          LIMITS.cliTestWallClockMs,
          deps.model,
          signal,
        );
        reportQuota(res, null);
        let outcome: { ok: true; model: string } | { ok: false; reason: ProviderErrorCode };
        if (!res.sandbox.initOk) outcome = { ok: false, reason: res.error ?? 'sandbox' };
        else if (res.error !== null) outcome = { ok: false, reason: res.error };
        else if (!isRecord(res.structured) || typeof res.structured.ok !== 'boolean')
          outcome = { ok: false, reason: 'bad_output' };
        else outcome = { ok: true, model: deps.model };
        smokeOkAt = outcome.ok ? now() : null;
        deps.onSmoke?.({ ok: outcome.ok, at: now(), ms: now() - started });
        return outcome;
      } catch (e) {
        if (e instanceof LlmError) return { ok: false, reason: e.code };
        return { ok: false, reason: signal.aborted ? 'aborted' : 'not_ready' };
      }
    },

    async dispose(): Promise<void> {
      // Kills the in-flight job (the runner observes the abort, tree-kills by PID and removes the run dir).
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

// =====================================================================================================================
// Implementation details (V2-W1-09-antigravity) - additive exports, no frozen name changed
// =====================================================================================================================

export type AgyStage = 'extract' | 'draft' | 'smoke';
/** Extra, non-contract members of the antigravity_cli provider object (the factory reads exePath / observedVersion / cliHealth). */
export interface AgyProviderInfo {
  readonly exePath: string;
  readonly observedVersion: string;
  cliHealth(): { code: ErrorCode; retryAtMs: EpochMs | null } | null;
  lastSmokeOkAt(): EpochMs | null;
}
export type AgyProvider = LlmProvider & AgyProviderInfo;

/** Folder names under <userData> (paths.ts owns the absolute paths; these match AppPaths.agyWorkspaceDir and the runner's run dirs).
 *  AGY_WORKSPACE_DIR / AGY_HOME_DIR are defined in claudeCli.env.ts (cli-sandbox-3) and re-exported. */
export { AGY_WORKSPACE_DIR, AGY_HOME_DIR };
export const AGY_SCHEMA_FILE = 'schema.json';
/** The agy job env key set (= AGY_ENV_KEYS of proc/jobRunner.ts). */
export const AGY_ENV_KEY_SET: readonly string[] = AGY_ENV_KEYS;

const STAGES: readonly AgyStage[] = ['extract', 'draft', 'smoke'];
function agyStageOf(stage: string): AgyStage {
  if (!(STAGES as readonly string[]).includes(stage)) throw new Error('agy_bad_stage'); // read_image never reaches agy (images: false)
  return stage as AgyStage;
}
/** `wca-<stage>` - the only agent names the app ever writes or accepts in init.agent. */
export function agyAgentName(stage: AgyStage): string {
  return `wca-${stage}`;
}
/** `--print-timeout` = the job wall clock minus 10 s, in whole seconds (>= 1 s): agy returns its partial output before our kill. */
export function agyPrintTimeout(wallClockMs: number): string {
  const s = Number.isFinite(wallClockMs) ? Math.floor((wallClockMs - 10_000) / 1000) : 1;
  return `${Math.max(1, s)}s`;
}
/** A settings slug that may appear on argv: AgyModelSchema and not option-like. */
export function isSafeAgyModel(model: unknown): model is string {
  return typeof model === 'string' && AgyModelSchema.safeParse(model).success && !model.startsWith('-');
}

/**
 * The agy job env (B26 allow-list, literally AGY_ENV_KEYS): PATH = %SystemRoot%\System32, TEMP/TMP = the run dir,
 * AGY_CLI_DISABLE_AUTO_UPDATE=true, the profile vars from `home` (planAgyHome().env in isolated mode). Never GEMINI_API_KEY / GOOGLE_API_KEY,
 * never process.env wholesale. Self-checked against the literal key list.
 */
export function buildAgyEnv(input: {
  processEnv: Readonly<Record<string, string | undefined>>;
  tempDir: string;
  home: Record<string, string>;
}): Record<string, string> {
  const pick = (name: string): string => {
    const key = Object.keys(input.processEnv).find((k) => k.toLowerCase() === name.toLowerCase());
    return (key === undefined ? undefined : input.processEnv[key]) ?? '';
  };
  const sysRoot = pick('SystemRoot').length > 0 ? pick('SystemRoot') : 'C:\\Windows';
  const env: Record<string, string> = {
    SystemRoot: sysRoot,
    PATH: path.win32.join(sysRoot, 'System32'),
    USERPROFILE: pick('USERPROFILE'),
    HOME: pick('USERPROFILE'),
    APPDATA: pick('APPDATA'),
    LOCALAPPDATA: pick('LOCALAPPDATA'),
    TEMP: input.tempDir,
    TMP: input.tempDir,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  };
  for (const [k, v] of Object.entries(input.home)) {
    if (!['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'].includes(k)) throw new Error('agy_env_keyset_drift');
    env[k] = v;
  }
  if ([...AGY_ENV_KEYS].sort().join(',') !== Object.keys(env).sort().join(',')) throw new Error('agy_env_keyset_drift');
  return env;
}

/** The result object of one stream-json event: the documented envelope {"event":"result","result":{...}} (research 5.3). */
export function agyEventResult(ev: unknown): Record<string, unknown> | null {
  if (!isRecord(ev) || ev.event !== 'result' || !isRecord(ev.result)) return null;
  return ev.result;
}
/** Result table (B14, C2 9.2): exit 0 + status SUCCESS + empty denied_actions + no error + an answer => ok; WAITING, non-empty
 *  denied_actions, an error or no parseable answer (bug #794) => bad_output (never a permissions retry).
 *  [agy-provider-fix D] agy 1.2.16 prints NO structured_output, even with --json-schema: the answer is the JSON STRING in result.response
 *  (parseAgyResponse: one code fence stripped, JSON.parse). A structured_output, if a later version adds it, still wins. The value is
 *  UNTRUSTED either way - the caller validates it with the stage's strict zod schema. */
export function classifyAgyResult(
  result: Record<string, unknown> | null,
): { ok: true; structured: unknown } | { ok: false; error: 'bad_output' } {
  if (result === null) return { ok: false, error: 'bad_output' };
  const denied = result.denied_actions;
  if (result.status !== 'SUCCESS') return { ok: false, error: 'bad_output' };
  if (denied !== undefined && !(Array.isArray(denied) && denied.length === 0))
    return { ok: false, error: 'bad_output' };
  if (result.error !== undefined && result.error !== null && result.error !== '')
    return { ok: false, error: 'bad_output' };
  const structured = result.structured_output;
  if (structured !== undefined && structured !== null) return { ok: true, structured };
  const parsed = parseAgyResponse(result.response);
  if (parsed === null) return { ok: false, error: 'bad_output' };
  return { ok: true, structured: parsed };
}
/** One whole-text code fence (```json ... ``` / ``` ... ```), CRLF tolerated; a second fence inside means "not one block". */
const AGY_FENCE_RE = /^```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;
/** [agy-provider-fix D] result.response (a STRING) -> the parsed JSON value, or null when it is not exactly one JSON value (optionally in
 *  ONE code fence). A truncated (print-timeout partial) or prose answer is null; JSON `null` is null too. Pure. */
export function parseAgyResponse(response: unknown): unknown {
  if (typeof response !== 'string') return null;
  let text = response.trim();
  const fence = AGY_FENCE_RE.exec(text);
  if (fence !== null) {
    text = (fence[1] ?? '').trim();
    if (text.includes('```')) return null;
  }
  if (text.length === 0) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}
/** `AGY_ERROR: {...}` (exit 3) text -> ProviderErrorCode: RESOURCE_EXHAUSTED|429|quota => usage_limit (CLOUD_QUOTA), authentication =>
 *  not_logged_in (CLI_NOT_SIGNED_IN), else network (CLOUD_UNAVAILABLE). Field names // ASSUMED (U-A3): only substrings are used. */
export function classifyAgyErrorText(text: string): ProviderErrorCode {
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(text)) return 'usage_limit';
  if (/authentication|UNAUTHENTICATED/i.test(text)) return 'not_logged_in';
  return 'network';
}
/**
 * The same classification from the JobRunner's MARKER-ONLY stderr view (B26: stderr text never leaves the job). AGY_ERROR is printed on
 * STDERR (research 5.6), so this is the form the runner can use: exit 3 + marker 'agy_error' => quota markers => usage_limit, an auth
 * marker => not_logged_in, else network; exit 1 + an auth marker => not_logged_in; exit 1/2 + malformed_input => not_ready (U-A6).
 * null = not an agy error exit. Marker names the runner needs from JOB_STDERR_MARKERS: agy_error, quota, http_429, auth_required,
 * malformed_input (REQUEST to V2-W1-06 - today only agy_error / quota / authentication_failed exist).
 */
export function classifyAgyExit(exitCode: number | null, stderrMarkers: readonly string[]): ProviderErrorCode | null {
  const has = (m: string): boolean => stderrMarkers.includes(m);
  const auth = has('auth_required') || has('authentication_failed');
  if (exitCode === 3 && has('agy_error')) {
    if (has('quota') || has('http_429') || has('usage_limit') || has('rate_limit')) return 'usage_limit';
    if (auth) return 'not_logged_in';
    return 'network';
  }
  if (exitCode === 1 && auth) return 'not_logged_in';
  // exit 1 "malformed input" / exit 2 "unsupported stream message" (research 5.3/5.6): our ONE stdin line was refused => the provider is
  // not ready (U-A6) - never retried with the prompt on argv.
  if ((exitCode === 1 || exitCode === 2) && has('malformed_input')) return 'not_ready';
  return null;
}

/** `agy models` stdout -> slugs (U-A3: format UNVERIFIED - one slug per line, optionally bulleted, optionally followed by a description,
 *  or a JSON array / {models:[...]}). Only strings that pass AgyModelSchema, are lower-case, contain a '-' and are not option-like survive.
 *  Order kept, duplicates dropped, at most 50. Never a hard-coded fallback. */
export function parseAgyModels(lines: readonly string[]): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(s) || !s.includes('-') || !isSafeAgyModel(s)) return;
    if (!out.includes(s) && out.length < 50) out.push(s);
  };
  const joined = lines.join('\n').trim();
  if (joined.startsWith('[') || joined.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(joined);
      const list = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.models)
          ? parsed.models
          : [];
      for (const m of list) add(isRecord(m) ? (m.slug ?? m.id ?? m.name) : m);
      return out;
    } catch {
      /* not JSON: fall through to the line format */
    }
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.endsWith(':')) continue;
    const token = line.replace(/^[*>•-]\s+/, '').split(/\s+/)[0] ?? '';
    add(token);
  }
  return out;
}

/** What `agy models` needs (additive to the frozen listAgyModels(runner) seam; V2-W2-01 wires it from compose). */
export interface AgyModelsProbe {
  jobs: JobRunner;
  exePath: string;
  userDataDir: string;
  processEnv?: Readonly<Record<string, string | undefined>>;
  /** e2e WCA_CLI_CMD: the fake's argv prefix (locator.seamArgsPrefix). */
  argsPrefix?: readonly string[];
  signal?: AbortSignal;
  wallClockMs?: number;
  /** writes the isolated profile + creates the app-owned workspace folder (default node:fs). */
  fs?: { mkdirSync(p: string, o: { recursive: true }): unknown; writeFileSync(p: string, text: string): void };
}
async function runAgyModels(p: AgyModelsProbe): Promise<string[]> {
  // The listing runs under the SAME isolated profile as the jobs (F3): the user's global MCP / hooks config is never in reach. cwd is the
  // app-owned (trusted, empty) workspace folder - never the agy install folder, never the user's home.
  const cwd = path.win32.join(p.userDataDir, AGY_WORKSPACE_DIR);
  const home = planAgyHome(p.userDataDir, cwd);
  const wfs = p.fs ?? {
    mkdirSync: (d: string, o: { recursive: true }) => nodeFs.mkdirSync(d, o),
    writeFileSync: (f: string, t: string) => nodeFs.writeFileSync(f, t, { encoding: 'utf8', mode: 0o600 }),
  };
  try {
    wfs.mkdirSync(cwd, { recursive: true });
    for (const f of home.files) {
      wfs.mkdirSync(path.win32.dirname(f.path), { recursive: true });
      wfs.writeFileSync(f.path, f.text);
    }
    const lines = await p.jobs.run(
      {
        kind: 'cli',
        exePath: p.exePath,
        args: [...(p.argsPrefix ?? []), 'models'],
        env: buildAgyEnv({ processEnv: p.processEnv ?? process.env, tempDir: cwd, home: home.env }),
        cwd,
        stdin: null,
        stdout: 'ndjson',
        wallClockMs: p.wallClockMs ?? 20_000,
        graceMs: LIMITS.cliKillGraceMs,
        belowNormal: false,
      },
      async (job) => {
        const got: string[] = [];
        for await (const l of job.lines()) if (got.length < 200) got.push(l);
        const d = await job.done;
        return d.exitCode === 0 ? got : [];
      },
      p.signal ?? AbortSignal.timeout((p.wallClockMs ?? 20_000) + 5_000),
    );
    return parseAgyModels(lines);
  } catch {
    return []; // not installed / breaker open / refused spec: nothing to offer, never a guessed list
  }
}

/**
 * The `makeAgy` value for llm/factory.ts (V2-W2-01 wires it): locate (S-LOCATE / the e2e seam), read the version, refuse below the floor
 * (1.2.11), then build the provider. Throws LlmError('not_installed' | 'version'). `onLocated` lets compose record the exe path in
 * meta.cli_exe_paths_json (B31) before any job of this provider can run.
 */
export function makeAgyFactory(deps: {
  locator: CliLocator;
  runner: CliRunner;
  userDataDir: string;
  now?: () => EpochMs;
  onLocated?: (exePath: string) => void;
  onSmoke?: (r: { ok: boolean; at: EpochMs; ms: number | null }) => void;
  onQuota?: (q: LlmQuota) => void;
}): (input: { model: string }) => Promise<AgyProvider> {
  return async ({ model }) => {
    const loc = await deps.locator.find('antigravity_cli');
    if (loc === null) throw new LlmError('not_installed');
    if (loc.version === null || compareVersion(loc.version, AGY_MIN_VERSION) < 0) throw new LlmError('version');
    deps.onLocated?.(loc.exePath);
    return createAgyProvider({
      runner: deps.runner,
      locator: deps.locator,
      model: isSafeAgyModel(model) ? model : DEFAULT_SETTINGS.llm.cli.agyModel,
      exePath: loc.exePath,
      userDataDir: deps.userDataDir,
      observedVersion: loc.version,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.onSmoke === undefined ? {} : { onSmoke: deps.onSmoke }),
      ...(deps.onQuota === undefined ? {} : { onQuota: deps.onQuota }),
    });
  };
}

/** True when `p` is an antigravity_cli provider object built by createAgyProvider. */
export function isAgyProvider(p: LlmProvider): p is AgyProvider {
  const x = p as Partial<AgyProviderInfo>;
  return p.id === 'antigravity_cli' && typeof x.exePath === 'string' && typeof x.cliHealth === 'function';
}

// ---------------- helpers ----------------
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const stripBom = (t: string): string => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(stripBom(text));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}
/** true for null / [] / {} and objects or arrays whose members are all empty-ish (depth-limited; deeper => not empty). */
function isEmptyish(v: unknown, depth: number): boolean {
  if (v === null) return true;
  if (depth > 4) return false;
  if (Array.isArray(v)) return v.every((x) => isEmptyish(x, depth + 1));
  if (isRecord(v)) return Object.values(v).every((x) => isEmptyish(x, depth + 1));
  return false;
}
/** Removes insignificant JSON whitespace (outside strings) - the canonical form JSON.stringify(JSON.parse(text)) must equal. */
function minifyJson(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') out += ch;
  }
  return out;
}
/** settings.json.wca-backup, or .wca-backup-<n> for the first free n (an earlier backup is never overwritten). */
function backupPathFor(file: string, exists: (p: string) => boolean): string {
  const base = `${file}.wca-backup`;
  if (!exists(base)) return base;
  for (let n = 2; n < 100; n += 1) if (!exists(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error('agy_backup_slots_full');
}
/** The verbatim system constant and the user text of a structured() call; null when the call carries a picture (never to agy). */
function splitAgyMessages(messages: readonly LlmMessage[]): { system: string; text: string } | null {
  let system = '';
  const texts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') system = system.length === 0 ? m.content : `${system}\n\n${m.content}`;
    else if (m.role === 'user') {
      if (typeof m.content === 'string') texts.push(m.content);
      else
        for (const part of m.content) {
          if (part.type !== 'text') return null;
          texts.push(part.text);
        }
    }
    // assistant / tool messages never travel to a CLI (one-shot runs, no session)
  }
  return { system, text: texts.join('\n') };
}
