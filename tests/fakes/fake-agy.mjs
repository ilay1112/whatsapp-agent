// tests/fakes/fake-agy.mjs - [V2] the only Antigravity CLI any automated test ever sees (T2 3.2). Owner V2-W1-09-antigravity.
// State/journal types: fake-agy.types.ts. Spawnable fake (T10): Node built-ins only; it opens no socket at all. Invocation:
//   node <abs>/tests/fakes/fake-agy.mjs --fake-journal <f> --fake-state <f> [--fake-script <f>] --fake-end <argv as the app builds it>
// Everything after --fake-end is parsed like the real CLI would (unknown option => exit 1). The fake reads NO env var of its own: the app's
// env is an allow-list and the fake only VALIDATES it. Violations are journaled; the cli-fakes-hook / ledger fails the test (rule 11).
// Journal: one JSON line when a run starts (phase 'started') and one when it ends (phase 'final'); readers keep the last line per
// `invocation` - a job killed before its first turn therefore leaves only the 'started' line with turnStarted:false (I11 proof).
//
// Everything about the real agy that is not documented is modelled from antigravity.google/docs/cli/headless as read on 2026-09-28 and
// marked // ASSUMED (U-A1 / U-A3 / U-A6 / U-A7); M-AGY-1 replaces those blocks from a scrubbed capture (never "corrected" to pass a test).
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const NOT_IMPLEMENTED_EXIT = 99; // kept for the invocation-shape error (no --fake-end)
export const DEFAULT_STATE = {
  version: '1.2.12',
  loggedIn: true,
  mode: 'ok',
  models: ['gemini-3.8-flash-high'],
  running: false,
};
/** = AGY_ENV_KEYS of src/main/proc/jobRunner.ts (duplicated: a spawnable fake may not import app source, T10; pinned by a test). */
export const EXPECTED_ENV_KEYS = [
  'SystemRoot',
  'PATH',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'AGY_CLI_DISABLE_AUTO_UPDATE',
];
/** libuv (Windows) copies these from the PARENT into every child env that lacks them: tolerated, reported apart, never a secret.
 *  HOMEDRIVE / HOMEPATH are on libuv's list too and are NOT in AGY_ENV_KEYS, so an agy job inherits the REAL user's values for them
 *  (the isolated profile is carried by USERPROFILE / HOME only) - ASSUMED harmless (U-A7), checked by M-AGY-1; see the W1-09 notes. */
export const OS_INJECTED_ENV = [
  'LOGONSERVER',
  'SYSTEMDRIVE',
  'USERDOMAIN',
  'USERNAME',
  'WINDIR',
  'HOMEDRIVE',
  'HOMEPATH',
];
const FORBIDDEN_ENV_RE =
  /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_PROJECT|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GEMINI_BASE_URL|ANTHROPIC_.*|CLAUDE_.*|HTTPS?_PROXY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|WCA_MCP_TOKEN|.*BRIDGE.*TOKEN.*|.*DOORBELL.*|LLAMA_API_KEY)$/i;
/** The subset of `agy --help` the app may use: flag -> takes a value (T2 3.2 flag table). */
const FLAGS = {
  '--agent': true,
  '--model': true,
  '--effort': true,
  '--output-format': true,
  '--input-format': true,
  '--print-timeout': true,
  '--disable-slash-commands': false,
  '--json-schema': true,
  '--version': false,
};
/** Known but forbidden (accepted so the app does not simply crash, and journaled as violations). -p / --print / --prompt take a value. */
const FORBIDDEN_FLAGS = {
  '-p': true,
  '--print': true,
  '--prompt': true,
  '--dangerously-skip-permissions': false,
  '--sandbox': false,
};
/** [D-080] `--effort` is required only for a slug WITHOUT an effort suffix (agy 1.2.16 refuses it next to a suffixed slug). */
const REQUIRED_RUN_FLAGS = [
  '--agent',
  '--model',
  '--output-format',
  '--input-format',
  '--print-timeout',
  '--disable-slash-commands',
];
export const FAKE_AGY_MODES = [
  'ok',
  'waiting',
  'denied',
  'no_structured',
  'exit3',
  'exit3_auth',
  'exit3_other',
  'extra_tools',
  'agent_mismatch',
  'perm_mode',
  'not_signed_in',
  'hang',
  'garbage_lines',
  'global_mcp_present',
  // [D-080] an error event INSTEAD of the init (the shape agy 1.2.16 printed in the live diagnostic): auth / quota / anything else
  'result_error_auth',
  'result_error_quota',
  'result_error_other',
];
const INIT_FAILURE_MODES = new Set(['extra_tools', 'agent_mismatch', 'perm_mode']);
/** // ASSUMED (U-A3): the AGY_ERROR payloads (field names unverified; the app classifies by substrings only). */
export const AGY_ERROR_LINES = {
  exit3: 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"fake-quota"}',
  exit3_auth:
    'AGY_ERROR: {"status":"UNAUTHENTICATED","code":401,"message":"authentication required","error_id":"fake-auth"}',
  exit3_other: 'AGY_ERROR: {"status":"INTERNAL","code":500,"retryable":true,"error_id":"fake-internal"}',
};
/** [D-080] Live diagnostic, agy 1.2.16: a model slug that carries its effort (as `agy models` lists them) refuses `--effort`. */
export const EFFORT_SUFFIX_RE = /-(minimal|low|medium|high|xhigh|max)$/i;
export const effortConflictLine = (model, effort) =>
  `error: invalid model selection (--model "${model}" --effort "${effort}"): --model ${model} conflicts with --effort=${effort}`;
/** [D-080 e2e] A refused model (state.rejectedModels). // ASSUMED: only the prefix up to `(--model "X"` is from the live capture. */
export const rejectedModelLine = (model) =>
  `error: invalid model selection (--model "${model}"): model ${model} is not available for this account`;
/** [D-080] The FIRST stdout event of a refused start: keys exactly as captured (conversation_id, status, response, error, duration_seconds,
 *  num_turns, usage) and NO init before it. The VALUES of status / response / usage are // ASSUMED (only the keys were recorded). */
export function errorResultEvent(conversationId, error) {
  return {
    event: 'result',
    conversation_id: conversationId,
    status: 'ERROR',
    response: '',
    error,
    duration_seconds: 0.01,
    num_turns: 0,
    usage: {},
  };
}
/** // ASSUMED: the error texts of the result_error_* modes (the app classifies by substrings only). */
export const RESULT_ERROR_TEXTS = {
  result_error_auth: 'authentication required: sign in with agy first',
  result_error_quota: 'RESOURCE_EXHAUSTED: quota exceeded (429)',
  result_error_other: 'internal error',
};
const AUTH_REQUIRED_LINE = 'Error: authentication required. Run `agy` once in a terminal to sign in.';
const NONCE_BLOCK_RE = /<<DATA-([0-9a-f]{8,64})>>[\s\S]*?<<END-DATA-\1>>/g;
const RUN_DIR_RE = /[\\/]agy-workspace[\\/]runs[\\/][^\\/]+$/i;

/** Splits argv at --fake-end: [fake flags (key -> value), the app's argv]. */
export function splitFakeArgv(argv) {
  const end = argv.indexOf('--fake-end');
  const own = end === -1 ? argv : argv.slice(0, end);
  const app = end === -1 ? [] : argv.slice(end + 1);
  const flags = {};
  for (let i = 0; i < own.length; i += 1) {
    const a = own[i];
    if (a.startsWith('--fake-')) {
      flags[a.slice('--fake-'.length)] = own[i + 1] ?? '';
      i += 1;
    }
  }
  return { flags, app, hasEnd: end !== -1 };
}

/** Parses the app argv like the real CLI: {opts, positionals, unknown, violations, printValue}. `unknown` = the first unknown option. */
export function parseAppArgv(app) {
  const opts = {};
  const positionals = [];
  const violations = [];
  let unknown = null;
  let printValue = null;
  for (let i = 0; i < app.length; i += 1) {
    const a = app[i];
    if (a.startsWith('-')) {
      if (a in FORBIDDEN_FLAGS) {
        const value = FORBIDDEN_FLAGS[a] ? (app[i + 1] ?? '') : null;
        if (FORBIDDEN_FLAGS[a]) i += 1;
        // `-p "/usage"` is the documented login/quota probe (a CLI slash command, no agent turn, no message text): the ONLY allowed -p.
        if ((a === '-p' || a === '--print' || a === '--prompt') && value === '/usage') printValue = value;
        else violations.push(`forbidden_flag:${a}`);
        continue;
      }
      if (!(a in FLAGS)) {
        // `--output-format json` belongs to the /usage probe only; everything else unknown => exit 1 like the real CLI
        unknown = unknown ?? a;
        continue;
      }
      if (FLAGS[a]) {
        opts[a] = app[i + 1] ?? '';
        i += 1;
      } else opts[a] = true;
    } else positionals.push(a);
  }
  return { opts, positionals, unknown, violations, printValue };
}

/** Stage from argv only (never from the prompt): --agent wca-<stage>. */
export function detectStage(opts) {
  const m = /^wca-(extract|draft|smoke)$/.exec(typeof opts['--agent'] === 'string' ? opts['--agent'] : '');
  return m ? m[1] : 'unknown';
}

/** Parses the agent file: frontmatter (simple `key: value` lines between the first two `---` lines) + the body after them. */
export function parseAgentFile(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const fm = {};
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(l);
    if (!m) return null;
    fm[m[1]] = m[2];
  }
  return { frontmatter: fm, body: lines.slice(end + 1).join('\n') };
}
/** Exactly {tools: [], commandExecutionPolicy: off, excludeDefaultComponents: true, mainAgent: true} + name, and nothing that adds power
 *  (no mcpServers, skills, plugins, other tools). description / subagent:false / model:inherit are tolerated. */
export function frontmatterOk(fm, agentName) {
  if (!fm) return false;
  const required = {
    name: agentName,
    tools: '[]',
    commandExecutionPolicy: 'off',
    excludeDefaultComponents: 'true',
    mainAgent: 'true',
  };
  for (const [k, v] of Object.entries(required)) if (fm[k] !== v) return false;
  const tolerated = { description: null, subagent: 'false', model: 'inherit' };
  for (const [k, v] of Object.entries(fm)) {
    if (k in required) continue;
    if (!(k in tolerated)) return false;
    if (tolerated[k] !== null && tolerated[k] !== v) return false;
  }
  return true;
}

/** A minimal value satisfying a draft-07 LCD schema (first enum member, 0, false, '', [], required keys recursively). */
export function minimalFor(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      return '';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const out = {};
      for (const k of Array.isArray(schema.required) ? schema.required : [])
        out[k] = minimalFor(schema.properties?.[k]);
      return out;
    }
    default:
      return null;
  }
}

/** Validates the ONE stream-json stdin line in agy's own envelope (F20). */
export function checkStdin(raw, stage) {
  const violations = [];
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length !== 1) violations.push(`stdin_shape:lines_${lines.length}`);
  let msg = null;
  try {
    msg = JSON.parse(lines[0] ?? '');
  } catch {
    violations.push('stdin_shape:not_json');
  }
  let envelope = 'other';
  let text = '';
  if (msg && typeof msg === 'object') {
    if (msg.event === 'user' && msg.message && typeof msg.message.content === 'string' && msg.type === undefined) {
      envelope = 'agy';
      text = msg.message.content;
    } else if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
      envelope = 'claude';
      violations.push('stdin_claude_envelope');
    } else violations.push('stdin_shape:envelope');
  }
  const blocks = [...text.matchAll(NONCE_BLOCK_RE)];
  const nonces = new Set(blocks.map((b) => b[1]));
  // S1 / smoke: exactly one data block. S3 (prefetch loop): the S3 data block + the inlined WhatsApp prefetch block of the SAME run
  // nonce (draft.ts appends gate.prefetchWaContext() as its own block) - never a second nonce.
  const maxBlocks = stage === 'draft' ? 2 : 1;
  if (envelope === 'agy' && (blocks.length < 1 || blocks.length > maxBlocks || nonces.size !== 1))
    violations.push(`stdin_shape:nonce_blocks_${blocks.length}_${nonces.size}`);
  return { lines: lines.length, envelope, text, nonceBlocks: blocks.length, violations };
}

/** Env validation (records, never refuses). */
export function checkEnv(env, cwd, isRun) {
  const violations = [];
  const keys = Object.keys(env)
    .filter((k) => !OS_INJECTED_ENV.includes(k.toUpperCase()))
    .sort();
  const lower = new Map(keys.map((k) => [k.toLowerCase(), k]));
  const forbiddenKeys = keys.filter((k) => FORBIDDEN_ENV_RE.test(k));
  for (const k of forbiddenKeys) violations.push(`env_forbidden:${k}`);
  const expected = new Set(EXPECTED_ENV_KEYS);
  for (const k of keys) if (!expected.has(k) && !forbiddenKeys.includes(k)) violations.push(`env_extra:${k}`);
  for (const k of expected) if (!lower.has(k.toLowerCase())) violations.push(`env_missing:${k}`);
  const autoUpdateOff = env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true';
  if (!autoUpdateOff) violations.push('env_auto_update_not_disabled');
  const sysRoot = env.SystemRoot ?? '';
  const pathIsSystem32 =
    typeof env.PATH === 'string' && env.PATH.toLowerCase() === `${sysRoot}\\System32`.toLowerCase();
  if (!pathIsSystem32) violations.push('env_path_not_system32');
  const tempIsCwd =
    path.resolve(env.TEMP ?? '') === path.resolve(cwd) && path.resolve(env.TMP ?? '') === path.resolve(cwd);
  if (isRun && !tempIsCwd) violations.push('env_temp_not_run_dir');
  if ((env.USERPROFILE ?? '') !== (env.HOME ?? '')) violations.push('env_home_not_userprofile');
  return { envKeys: keys, envChecks: { pathIsSystem32, tempIsCwd, autoUpdateOff, forbiddenKeys }, violations };
}

/** Every file named mcp_config.json (any case) under `root`, depth-limited. */
export function findMcpConfigs(root, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...findMcpConfigs(p, depth + 1));
    else if (e.name.toLowerCase() === 'mcp_config.json') out.push(p);
  }
  return out;
}

const readJson = (file) => {
  try {
    const t = readFileSync(file, 'utf8');
    return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  } catch {
    return undefined;
  }
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** // ASSUMED (U-A7): the real agy loads <USERPROFILE>\.gemini\config\{mcp_config,hooks}.json in every run. */
export function globalConfigVisible(userProfile) {
  if (!userProfile) return false;
  const cfg = readJson(path.join(userProfile, '.gemini', 'config', 'mcp_config.json'));
  const servers = isObj(cfg) && isObj(cfg.mcpServers) ? Object.values(cfg.mcpServers) : [];
  if (servers.some((s) => !isObj(s) || s.disabled !== true)) return true;
  const hooks = readJson(path.join(userProfile, '.gemini', 'config', 'hooks.json'));
  return isObj(hooks) && JSON.stringify(hooks) !== '{}';
}
/** // ASSUMED (U-A1): trustedWorkspaces trusts the listed folder and everything below it (M-AGY-1 checks the exact-path rule). */
export function workspaceTrusted(userProfile, cwd) {
  if (!userProfile) return false;
  const s = readJson(path.join(userProfile, '.gemini', 'antigravity-cli', 'settings.json'));
  if (!isObj(s) || !Array.isArray(s.trustedWorkspaces)) return false;
  const c = path.resolve(cwd).toLowerCase();
  return s.trustedWorkspaces.some((w) => {
    if (typeof w !== 'string') return false;
    const t = path.resolve(w).toLowerCase();
    return c === t || c.startsWith(`${t}${path.sep}`);
  });
}

function readState(file) {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const out = (o) => process.stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hangForever = () => new Promise(() => setInterval(() => undefined, 1000));

async function main() {
  const { flags, app, hasEnd } = splitFakeArgv(process.argv.slice(2));
  const journalFile = flags.journal;
  const state = flags.state ? readState(flags.state) : { ...DEFAULT_STATE };
  const invocation = randomBytes(6).toString('hex');
  const cwd = process.cwd();
  const env = { ...process.env };
  const parsed = parseAppArgv(app);
  const isVersion = parsed.opts['--version'] === true;
  const isModels = parsed.positionals[0] === 'models';
  const isUsageProbe = parsed.printValue === '/usage';
  const runStage = detectStage(parsed.opts);
  const stage = isVersion ? 'version' : isModels ? 'models' : isUsageProbe ? 'usage_probe' : runStage;
  const isRun = !isVersion && !isModels && !isUsageProbe;
  const mode = isRun ? (state.modeByStage?.[runStage] ?? state.mode ?? 'ok') : 'ok';

  const entry = {
    invocation,
    phase: 'started',
    argv: app,
    cwd,
    agentFile: { exists: false, frontmatterOk: false, bodySha256: null },
    mcpConfigPresent: false,
    schemaFilePresent: false,
    envKeys: [],
    envChecks: { pathIsSystem32: false, tempIsCwd: false, autoUpdateOff: false, forbiddenKeys: [] },
    home: { userProfile: env.USERPROFILE ?? null, home: env.HOME ?? null },
    stdinLines: 0,
    stdinEnvelope: 'other',
    stdinNonceBlocks: 0,
    stdinSha256: '',
    stage,
    mode,
    turnStarted: false,
    workspaceTrusted: false,
    globalMcpVisible: false,
    exit: -1, // -1 until the process ends (a killed run keeps -1)
    violations: [...parsed.violations],
  };
  const journal = () => {
    if (journalFile) appendFileSync(journalFile, `${JSON.stringify(entry)}\n`, 'utf8');
  };
  const finish = (code) => {
    entry.phase = 'final';
    entry.exit = code;
    journal();
    process.exit(code);
  };
  if (!hasEnd) {
    entry.violations.push('fake_invocation:missing_fake_end');
    process.stderr.write('fake-agy.mjs: missing --fake-end\n');
    finish(NOT_IMPLEMENTED_EXIT);
    return;
  }
  // Message text never belongs on argv (I4', C11): a nonce marker in any argv element is a violation whatever the flag.
  if (app.some((a) => a.includes('<<DATA-') || a.includes('<<END-DATA-'))) entry.violations.push('argv_message_text');
  if (parsed.unknown !== null && !(isUsageProbe && parsed.unknown === '--output-format')) {
    process.stderr.write(`error: unknown option '${parsed.unknown}'\n`);
    finish(1);
    return;
  }
  const envCheck = checkEnv(env, cwd, isRun);
  entry.envKeys = envCheck.envKeys;
  entry.envChecks = envCheck.envChecks;
  entry.violations.push(...envCheck.violations);

  // ---- sub-commands ----
  if (isVersion) {
    out(`${state.version}`); // ASSUMED (U-A3): `agy --version` prints the bare version on its first line
    finish(0);
    return;
  }
  if (isModels) {
    if (state.loggedIn !== true) {
      process.stderr.write(`${AUTH_REQUIRED_LINE}\n`);
      finish(1);
      return;
    }
    // ASSUMED (U-A3): a header line, then one slug per line (indented, optionally with a description).
    out('Available models:');
    for (const m of Array.isArray(state.models) ? state.models : []) out(`  ${m}`);
    finish(0);
    return;
  }
  if (isUsageProbe) {
    if (app.some((a) => a === '--agent')) entry.violations.push('usage_probe_with_agent');
    if (state.loggedIn !== true) {
      process.stderr.write(`${AUTH_REQUIRED_LINE}\n`);
      finish(1);
      return;
    }
    out({ status: 'SUCCESS', response: 'usage: as reported by the CLI', conversation_id: `fake-${invocation}` });
    finish(0);
    return;
  }

  // ---- a run: argv checks ----
  for (const f of REQUIRED_RUN_FLAGS) if (parsed.opts[f] === undefined) entry.violations.push(`missing_flag:${f}`);
  if (parsed.opts['--output-format'] !== undefined && parsed.opts['--output-format'] !== 'stream-json')
    entry.violations.push('output_format_not_stream_json');
  if (parsed.opts['--input-format'] !== undefined && parsed.opts['--input-format'] !== 'stream-json')
    entry.violations.push('input_format_not_stream_json');
  if (parsed.opts['--effort'] !== undefined && parsed.opts['--effort'] !== 'low')
    entry.violations.push('effort_not_low');
  const modelSlug = typeof parsed.opts['--model'] === 'string' ? parsed.opts['--model'] : '';
  const slugHasEffort = EFFORT_SUFFIX_RE.test(modelSlug);
  // [D-080] the app passes --effort exactly when the slug has no effort of its own
  if (!slugHasEffort && parsed.opts['--effort'] === undefined) entry.violations.push('missing_flag:--effort');
  const effortConflict = slugHasEffort && parsed.opts['--effort'] !== undefined;
  if (effortConflict) entry.violations.push('effort_with_suffixed_model');
  if (parsed.opts['--print-timeout'] !== undefined && !/^\d+(ms|s|m|h)$/.test(parsed.opts['--print-timeout']))
    entry.violations.push('print_timeout_format');
  if (typeof parsed.opts['--model'] === 'string' && !/^[A-Za-z0-9._-]{1,100}$/.test(parsed.opts['--model']))
    entry.violations.push('model_slug');
  if (parsed.positionals.length > 0) entry.violations.push('forbidden_flag:positional_prompt');
  if (runStage === 'unknown') entry.violations.push('agent_name');
  const agentName = `wca-${runStage}`;

  // ---- a run: workspace checks ----
  if (!RUN_DIR_RE.test(cwd)) entry.violations.push('cwd_not_run_dir');
  const workspaceRoot = path.resolve(cwd, '..', '..');
  const agentPath = path.join(cwd, '.agents', 'agents', `${agentName}.md`);
  if (existsSync(agentPath)) {
    entry.agentFile.exists = true;
    const text = readFileSync(agentPath, 'utf8');
    const p = parseAgentFile(text);
    entry.agentFile.frontmatterOk = p !== null && frontmatterOk(p.frontmatter, agentName);
    entry.agentFile.bodySha256 = p === null ? null : createHash('sha256').update(p.body, 'utf8').digest('hex');
    if (!entry.agentFile.frontmatterOk) entry.violations.push('agent_frontmatter');
    const want = state.expectedPromptSha256?.[runStage];
    if (typeof want === 'string' && want !== entry.agentFile.bodySha256) entry.violations.push('agent_body_mismatch');
  } else entry.violations.push('agent_file_missing');
  const mcpConfigs = [...findMcpConfigs(RUN_DIR_RE.test(cwd) ? workspaceRoot : cwd)];
  entry.mcpConfigPresent = mcpConfigs.length > 0;
  if (entry.mcpConfigPresent) entry.violations.push('mcp_config_present');
  for (const f of ['GEMINI.md', 'AGENTS.md'])
    if (existsSync(path.join(cwd, f))) entry.violations.push('context_file_present');
  const schemaInCwd = path.join(cwd, 'schema.json');
  entry.schemaFilePresent = existsSync(schemaInCwd);
  let schema = null;
  const schemaArg = parsed.opts['--json-schema'];
  if (typeof schemaArg === 'string') {
    if (path.resolve(schemaArg).toLowerCase() !== path.resolve(schemaInCwd).toLowerCase())
      entry.violations.push('schema_path');
    else if (!entry.schemaFilePresent) entry.violations.push('schema_missing');
    else {
      schema = readJson(schemaInCwd) ?? null;
      if (schema === null) entry.violations.push('schema_unparsable');
    }
  } else if (entry.schemaFilePresent) entry.violations.push('schema_unexpected');

  // ---- a run: profile (F3) ----
  const userProfile = env.USERPROFILE ?? '';
  if (state.expectIsolatedHome !== false) {
    const isolated =
      path.basename(userProfile).toLowerCase() === 'agy-home' &&
      path.resolve(path.dirname(userProfile)).toLowerCase() === path.resolve(workspaceRoot, '..').toLowerCase();
    if (!isolated) entry.violations.push('home_not_isolated');
  }
  entry.globalMcpVisible = globalConfigVisible(userProfile);
  if (entry.globalMcpVisible) entry.violations.push('global_config_loaded');
  entry.workspaceTrusted = workspaceTrusted(userProfile, cwd);
  if (!entry.workspaceTrusted) entry.violations.push('workspace_untrusted'); // the real agy would stop at the trust gate (U-A1)

  // ---- a run: stdin (F20, U-A6) ----
  const raw = await readStdin();
  const stdin = checkStdin(raw, runStage);
  entry.stdinLines = stdin.lines;
  entry.stdinEnvelope = stdin.envelope;
  entry.stdinNonceBlocks = stdin.nonceBlocks;
  entry.stdinSha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
  entry.violations.push(...stdin.violations);
  journal(); // phase 'started'
  if (stdin.envelope !== 'agy') {
    process.stderr.write('Error: malformed input\n');
    finish(1);
    return;
  }
  // [D-080] exactly what agy 1.2.16 did for `--model gemini-3.8-flash-high --effort low`: one stderr line, then a result event carrying
  // the error as the FIRST stdout event (no init), exit 1.
  if (effortConflict) {
    const line = effortConflictLine(modelSlug, parsed.opts['--effort']);
    process.stderr.write(`${line}\n`);
    out(errorResultEvent(`fake-${invocation}`, line.replace(/^error: /, '')));
    finish(1);
    return;
  }
  // [D-080 e2e] a model this CLI refuses (state.rejectedModels): the same SHAPE as the captured 1.2.16 refusal - one stderr line, then
  // an error result as the FIRST stdout event (no init), exit 1. // ASSUMED: the wording after `invalid model selection (--model "X"`.
  if (Array.isArray(state.rejectedModels) && state.rejectedModels.includes(modelSlug)) {
    const line = rejectedModelLine(modelSlug);
    process.stderr.write(`${line}\n`);
    out(errorResultEvent(`fake-${invocation}`, line.replace(/^error: /, '')));
    finish(1);
    return;
  }
  if (Object.hasOwn(RESULT_ERROR_TEXTS, mode)) {
    out(errorResultEvent(`fake-${invocation}`, RESULT_ERROR_TEXTS[mode]));
    finish(1);
    return;
  }
  if (mode === 'not_signed_in' || state.loggedIn !== true) {
    process.stderr.write(`${AUTH_REQUIRED_LINE}\n`);
    finish(1);
    return;
  }

  // ---- output ----
  const conversationId = `fake-${invocation}`;
  if (mode === 'garbage_lines') {
    out('not json at all');
    out('x'.repeat(1024 * 1024 + 16));
    out('\ud800 lone surrogate');
    out('{"broken":');
  }
  out({
    event: 'init',
    conversation_id: conversationId,
    init: {
      cwd,
      tools: mode === 'extra_tools' ? ['run_command'] : [],
      permission_mode: mode === 'perm_mode' ? 'always-proceed' : 'request-review',
      model: parsed.opts['--model'],
      agent: mode === 'agent_mismatch' ? 'default' : agentName,
      ...(schema === null ? {} : { json_schema: schema }),
    },
  });
  // An init the app must reject: give it time to kill us BEFORE the first turn (the journal keeps turnStarted:false when it does).
  if (INIT_FAILURE_MODES.has(mode)) await sleep(3000);
  if (mode === 'hang') {
    await hangForever();
    return;
  }
  entry.turnStarted = true;
  out({
    event: 'step_update',
    step_update: { conversation_id: conversationId, step_index: 0, state: 'DONE', step_type: 'user_input' },
  });
  if (mode === 'garbage_lines') out('<<not json between events>>');

  // the answer: script rule, or a minimal valid answer per stage
  const rules = (() => {
    if (!flags.script) return [];
    const s = readJson(flags.script);
    return isObj(s) && Array.isArray(s.rules) ? s.rules : [];
  })();
  const rule = rules.find((r) => {
    const w = (r && r.when) ?? {};
    if (w.stage !== undefined && w.stage !== runStage) return false;
    if (w.purpose !== undefined && w.stage === undefined && w.purpose !== runStage) return false;
    if (w.contains !== undefined && !stdin.text.includes(w.contains)) return false;
    if (w.notContains !== undefined && stdin.text.includes(w.notContains)) return false;
    if (w.imageSha256 !== undefined) return false; // agy never receives a picture (capabilities.images:false)
    return true;
  });
  const respond = rule?.respond ?? null;
  let errorMode = ['exit3', 'exit3_auth', 'exit3_other'].includes(mode) ? mode : null;
  if (respond && typeof respond.error === 'string') {
    errorMode =
      respond.error === 'usage_limit' ? 'exit3' : respond.error === 'not_logged_in' ? 'exit3_auth' : 'exit3_other';
  }
  if (respond && respond.hang === true) {
    await hangForever();
    return;
  }
  if (errorMode !== null) {
    out({
      event: 'step_update',
      step_update: { conversation_id: conversationId, step_index: 1, state: 'ACTIVE', step_type: 'agent_response' },
    });
    process.stderr.write(`${AGY_ERROR_LINES[errorMode]}\n`);
    finish(3);
    return;
  }
  let structured;
  if (respond && isObj(respond.structured)) structured = respond.structured;
  else if (respond && typeof respond.text === 'string')
    structured = runStage === 'draft' ? { reply: respond.text } : minimalFor(schema);
  else if (runStage === 'smoke') structured = { ok: true };
  else if (runStage === 'draft') structured = { reply: 'Fake agy draft reply.' };
  else structured = minimalFor(schema);
  if (respond && Array.isArray(respond.toolCalls)) entry.violations.push('script_tool_calls_on_agy'); // agy runs have no tools at all

  out({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: JSON.stringify(structured),
    },
  });
  const result = {
    conversation_id: conversationId,
    status: mode === 'waiting' ? 'WAITING' : 'SUCCESS',
    response: JSON.stringify(structured),
    duration_seconds: 1.5,
    num_turns: 1,
    denied_actions: mode === 'denied' ? [{ tool: 'run_command' }] : [], // ASSUMED (U-A3): denied_actions entry shape
    usage: { input_tokens: 120, output_tokens: 30, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 150 },
    ...(schema === null ? {} : { json_schema: schema }),
    ...(mode === 'no_structured' || mode === 'waiting' ? {} : { structured_output: structured }),
  };
  out({ event: 'result', result });
  finish(0);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop());
if (isMain) {
  main().catch(() => {
    process.stderr.write('fake-agy.mjs: internal error\n');
    process.exit(98);
  });
}
