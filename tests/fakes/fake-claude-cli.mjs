// tests/fakes/fake-claude-cli.mjs - [V2] the only "Claude Code" any automated test ever sees (T2 3.1). Owner V2-W1-06-claude-cli.
// State/journal types: fake-claude-cli.types.ts. Spawnable fake (T10): Node built-ins + ./mcp-client-core.mjs only; connects only to
// 127.0.0.1. Invocation:
//   node <abs>/tests/fakes/fake-claude-cli.mjs --fake-journal <f> --fake-state <f> [--fake-script <f>] --fake-end <argv as the app builds it>
// Everything after --fake-end is parsed like the real CLI would (unknown option => exit 1). The fake reads NO env var of its own: the app's
// env is an allow-list, and the fake only VALIDATES it (violations are journaled; the ledger fails the test, rule 11).
// Journal: one JSON line when the run starts (phase 'started') and one when it ends (phase 'final'); readers keep the last line per
// `invocation` - a job killed before its first turn therefore leaves only the 'started' line with turnStarted:false (I11 proof).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

export const FAKE_OAUTH_SOURCE = 'none';
const NOT_IMPLEMENTED_EXIT = 99;
export const NON_LOOPBACK_EXIT = 97;
const DEFAULT_STATE = { version: '2.1.258', loggedIn: true, mode: 'ok' };
const MEMORY_SWITCHES = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
/** = CLAUDE_ENV_KEYS of src/main/proc/jobRunner.ts (duplicated: a spawnable fake may not import app source, T10; pinned by a test). */
export const EXPECTED_ENV_KEYS = [
  'SystemRoot',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'ENABLE_TOOL_SEARCH',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_AUTOUPDATER',
  'DISABLE_BUG_COMMAND',
  'CI',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
];
const FORBIDDEN_ENV_RE =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_PROFILE|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_.*|HTTPS?_PROXY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|GEMINI_API_KEY|GOOGLE_API_KEY|.*BRIDGE.*TOKEN.*|.*DOORBELL.*|LLAMA_API_KEY)$/i;
/** The subset of `claude --help` 2.1.258 the app may use: flag -> takes a value. */
const FLAGS = {
  '-p': false,
  '--print': false,
  '--restricted': false,
  '--strict-mcp-config': false,
  '--tools': true,
  '--permission-mode': true,
  '--permission-prompts': true,
  '--disallowedTools': true,
  '--allowedTools': true,
  '--disable-slash-commands': false,
  '--no-session-persistence': false,
  '--system-prompt': true,
  '--max-turns': true,
  '--output-format': true,
  '--input-format': true,
  '--verbose': false,
  '--model': true,
  '--fallback-model': true,
  '--effort': true,
  '--json-schema': true,
  '--mcp-config': true,
  '--version': false,
  '--json': false,
  '--claudeai': false,
};
/** Known but forbidden (accepted so the app does not simply crash, and journaled as violations). */
const FORBIDDEN_FLAGS = {
  '--bare': false,
  '--dangerously-skip-permissions': false,
  '--add-dir': true,
  '--settings': true,
  '--continue': false,
  '--resume': true,
  '--append-system-prompt': true,
  '--append-system-prompt-file': true,
  '--system-prompt-file': true,
};
const REQUIRED_RUN_FLAGS = [
  '-p',
  '--restricted',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--verbose',
];
export const FAKE_CLAUDE_MODES = [
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
const INIT_FAILURE_MODES = new Set([
  'extra_tool',
  'extra_server',
  'plugins_present',
  'mcp_server_error',
  'api_key_leak',
  'init_not_first',
]);
const ATTACKER_PROBES = [
  'send_message',
  'create-event',
  'create_event',
  'update-event',
  'delete-event',
  'get-event',
  'list-events',
  'manage-accounts',
  'mcp__wca__wa_search_messages',
  'wa_list_chats',
  'auto_enable',
  'approve',
  'undo',
  'settings_set',
  'x'.repeat(300),
  'wа_search_messages', // Cyrillic a homoglyph
];

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

export function compareVersion(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  }
  return 0;
}

/** Parses the app argv like the real CLI: {opts, positionals, unknown, violations}. `unknown` = the first unknown option. */
export function parseAppArgv(app, version) {
  const opts = {};
  const positionals = [];
  const violations = [];
  let unknown = null;
  for (let i = 0; i < app.length; i += 1) {
    const a = app[i];
    if (a.startsWith('-')) {
      if (a === '--permission-prompts' && compareVersion(version, '2.1.259') < 0) {
        unknown = unknown ?? a; // the flag does not exist before 2.1.259: catches a missing version gate
        continue;
      }
      if (a in FORBIDDEN_FLAGS) {
        violations.push(`forbidden_flag:${a}`);
        if (FORBIDDEN_FLAGS[a]) i += 1;
        continue;
      }
      if (!(a in FLAGS)) {
        unknown = unknown ?? a;
        continue;
      }
      if (FLAGS[a]) {
        opts[a] = app[i + 1] ?? '';
        i += 1;
      } else opts[a] = true;
    } else positionals.push(a);
  }
  if (opts['--permission-mode'] === 'bypassPermissions') violations.push('forbidden_flag:bypassPermissions');
  return { opts, positionals, unknown, violations };
}

/** Stage from argv only (never from the prompt): --mcp-config => draft; IMAGE_READ_SCHEMA (has readText) => read_image; the 1-field
 *  smoke schema => smoke; any other --json-schema => extract. */
export function detectStage(opts) {
  if (typeof opts['--mcp-config'] === 'string') return 'draft';
  const raw = opts['--json-schema'];
  if (typeof raw !== 'string') return 'unknown';
  try {
    const schema = JSON.parse(raw);
    const props =
      schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
        ? Object.keys(schema.properties)
        : [];
    if (props.includes('readText')) return 'read_image';
    if (props.length === 1) return 'smoke';
    return 'extract';
  } catch {
    return 'unknown';
  }
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

const NONCE_BLOCK_RE = /<<DATA-([0-9a-f]{8,64})>>[\s\S]*?<<END-DATA-\1>>/g;
/** Validates the ONE stream-json stdin line (F20). Returns {texts, image, violations}. */
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
  const texts = [];
  let image = null;
  if (msg) {
    if (msg.type !== 'user' || !msg.message || msg.message.role !== 'user' || !Array.isArray(msg.message.content))
      violations.push('stdin_shape:envelope');
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    content.forEach((b, i) => {
      if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b && b.type === 'image') {
        if (i !== 0) violations.push('stdin_shape:image_not_first');
        const s = b.source;
        if (
          !s ||
          s.type !== 'base64' ||
          !['image/jpeg', 'image/png'].includes(s.media_type) ||
          typeof s.data !== 'string'
        )
          violations.push('stdin_shape:image_block');
        else if (Buffer.from(s.data, 'base64').length > 10 * 1024 * 1024) violations.push('stdin_shape:image_too_big');
        else image = Buffer.from(s.data, 'base64');
      } else violations.push('stdin_shape:block');
    });
    const nonceBlocks = texts.join('\n').match(NONCE_BLOCK_RE) ?? [];
    if (nonceBlocks.length !== 1) violations.push(`stdin_shape:nonce_blocks_${nonceBlocks.length}`);
    if (stage === 'read_image' && image === null) violations.push('stdin_shape:missing_image');
    if (stage !== 'read_image' && image !== null) violations.push('stdin_shape:unexpected_image');
  }
  return {
    texts,
    image,
    violations,
    lines: lines.length,
    nonceWrapped: texts.join('\n').match(NONCE_BLOCK_RE)?.length === 1,
  };
}

/** libuv (Windows) copies these from the PARENT into every child env that lacks them (uv_spawn `required_vars`): an allow-list can never
 *  exclude them, so they are tolerated and reported apart. None of them is a secret. */
export const OS_INJECTED_ENV = ['LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'WINDIR'];

/** Env validation (records, never refuses). */
export function checkEnv(env, cwd, stage, isRun) {
  const violations = [];
  const keys = Object.keys(env)
    .filter((k) => !OS_INJECTED_ENV.includes(k.toUpperCase()))
    .sort();
  const lower = new Map(keys.map((k) => [k.toLowerCase(), k]));
  const forbiddenKeys = keys.filter((k) => FORBIDDEN_ENV_RE.test(k));
  for (const k of forbiddenKeys) violations.push(`env_forbidden:${k}`);
  for (const [k, v] of Object.entries(MEMORY_SWITCHES)) if (env[k] !== v) violations.push(`env_memory_switch:${k}`);
  const expected = new Set(
    stage === 'draft' && env.WCA_MCP_TOKEN !== undefined ? [...EXPECTED_ENV_KEYS, 'WCA_MCP_TOKEN'] : EXPECTED_ENV_KEYS,
  );
  for (const k of keys) if (!expected.has(k) && !forbiddenKeys.includes(k)) violations.push(`env_extra:${k}`);
  for (const k of expected) if (!lower.has(k.toLowerCase())) violations.push(`env_missing:${k}`);
  const sysRoot = env.SystemRoot ?? '';
  const pathIsSystem32 =
    typeof env.PATH === 'string' && env.PATH.toLowerCase() === `${sysRoot}\\System32`.toLowerCase();
  if (!pathIsSystem32) violations.push('env_path_not_system32');
  const tempIsCwd =
    path.resolve(env.TEMP ?? '') === path.resolve(cwd) && path.resolve(env.TMP ?? '') === path.resolve(cwd);
  if (isRun && !tempIsCwd) violations.push('env_temp_not_run_dir');
  const tokenPresent = typeof env.WCA_MCP_TOKEN === 'string' && env.WCA_MCP_TOKEN.length > 0;
  if (tokenPresent && stage !== 'draft') violations.push('env_token_outside_draft');
  return { envKeys: keys, envChecks: { pathIsSystem32, tempIsCwd, tokenPresent, forbiddenKeys }, violations };
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
  const token = typeof env.WCA_MCP_TOKEN === 'string' && env.WCA_MCP_TOKEN.length > 0 ? env.WCA_MCP_TOKEN : null;
  const parsed = parseAppArgv(app, state.version);
  const stageFromArgv = detectStage(parsed.opts);
  const isVersion = parsed.opts['--version'] === true;
  const isAuthStatus = parsed.positionals[0] === 'auth' && parsed.positionals[1] === 'status';
  const isAuthLogin = parsed.positionals[0] === 'auth' && parsed.positionals[1] === 'login';
  const stage = isVersion ? 'version' : isAuthStatus ? 'auth_status' : isAuthLogin ? 'auth_login' : stageFromArgv;
  const isRun = !isVersion && !isAuthStatus && !isAuthLogin;
  const mode = isRun ? (state.modeByStage?.[stage] ?? state.mode ?? 'ok') : 'ok';

  const entry = {
    invocation,
    phase: 'started',
    argv: app,
    argvHasToken: token !== null && app.some((a) => a.includes(token)),
    cwd,
    cwdEmptyAtStart: (() => {
      try {
        return readdirSync(cwd).filter((f) => f !== 'wca.mcp.json').length === 0;
      } catch {
        return false;
      }
    })(),
    envKeys: [],
    envChecks: { pathIsSystem32: false, tempIsCwd: false, tokenPresent: false, forbiddenKeys: [] },
    stdinLines: 0,
    stdinSha256: '',
    stdinNonceWrapped: false,
    stage,
    mode,
    toolCalls: [],
    rawServerProbes: [],
    turnStarted: false,
    grandchildPid: null,
    exit: -1, // -1 until the run ends (a killed run keeps -1)
    violations: [...parsed.violations],
  };
  const journal = () => {
    if (!journalFile) return;
    const copy = { ...entry };
    if (token !== null) {
      // the token value is NEVER journaled - only argvHasToken / tokenPresent booleans
      const s = JSON.stringify(copy).split(token).join('[token]');
      appendFileSync(journalFile, `${s}\n`, 'utf8');
    } else appendFileSync(journalFile, `${JSON.stringify(copy)}\n`, 'utf8');
  };
  const finish = (code) => {
    entry.phase = 'final';
    entry.exit = code;
    journal();
    process.exit(code);
  };
  if (!hasEnd) {
    entry.violations.push('fake_invocation:missing_fake_end');
    finish(NOT_IMPLEMENTED_EXIT);
    return;
  }
  if (entry.argvHasToken) entry.violations.push('argv_token');

  const envResult = checkEnv(env, cwd, stage, isRun);
  entry.envKeys = envResult.envKeys;
  entry.envChecks = envResult.envChecks;
  entry.violations.push(...envResult.violations);

  if (parsed.unknown !== null) {
    process.stderr.write(`error: unknown option '${parsed.unknown}'\n`);
    finish(1);
    return;
  }
  // ---- sub-commands ----
  if (isVersion) {
    out(`${state.version} (Claude Code)`);
    finish(0);
    return;
  }
  if (isAuthStatus) {
    if (state.loggedIn === 'garbage') out('Could not read the auth state %%% not json');
    else out({ loggedIn: state.loggedIn === true, authMethod: 'claude.ai', orgName: 'fake-org' });
    finish(state.loggedIn === true ? 0 : 1);
    return;
  }
  if (isAuthLogin) {
    if (flags.state) writeFileSync(flags.state, JSON.stringify({ ...state, loggedIn: true }), 'utf8');
    finish(0);
    return;
  }

  // ---- a run: argv shape ----
  for (const f of REQUIRED_RUN_FLAGS) if (parsed.opts[f] !== true) entry.violations.push(`missing_flag:${f}`);
  if (parsed.opts['--tools'] !== '') entry.violations.push('tools_not_empty');
  if (parsed.opts['--permission-mode'] !== 'dontAsk') entry.violations.push('permission_mode');
  if (parsed.opts['--output-format'] !== 'stream-json' || parsed.opts['--input-format'] !== 'stream-json')
    entry.violations.push('format');
  if (typeof parsed.opts['--system-prompt'] !== 'string' || parsed.opts['--system-prompt'].length === 0)
    entry.violations.push('missing_flag:--system-prompt');
  if (parsed.positionals.length > 0) entry.violations.push('forbidden_flag:positional');
  if (stage === 'unknown') entry.violations.push('stage_unknown');
  if (stage === 'draft' && parsed.opts['--allowedTools'] !== 'mcp__wca__*') entry.violations.push('allowed_tools');
  if (stage !== 'draft' && (parsed.opts['--allowedTools'] !== undefined || token !== null))
    entry.violations.push('mcp_outside_draft');

  // ---- stdin ----
  const raw = await readStdin();
  entry.stdinSha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
  const stdin = checkStdin(raw, stage);
  entry.stdinLines = stdin.lines;
  entry.stdinNonceWrapped = stdin.nonceWrapped;
  entry.violations.push(...stdin.violations);
  const stdinText = stdin.texts.join('\n');

  // ---- draft: the loopback MCP server BEFORE init (models the startup wait) ----
  let client = null;
  let mcpTools = [];
  if (stage === 'draft') {
    let cfg = null;
    const rawCfg = parsed.opts['--mcp-config'];
    let fileMode = false;
    try {
      if (rawCfg.trim().startsWith('{')) cfg = JSON.parse(rawCfg);
      else {
        fileMode = true;
        const abs = path.resolve(rawCfg);
        if (!abs.toLowerCase().startsWith(`${path.resolve(cwd).toLowerCase()}${path.sep}`))
          entry.violations.push('mcp_config_file_outside_run_dir');
        cfg = JSON.parse(readFileSync(abs, 'utf8'));
      }
    } catch {
      entry.violations.push('mcp_config_unparsable');
    }
    const servers = cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object' ? Object.entries(cfg.mcpServers) : [];
    if (servers.length !== 1 || servers[0][0] !== 'wca') entry.violations.push('mcp_config_servers');
    const srv = servers[0]?.[1] ?? {};
    if (srv.type !== 'http') entry.violations.push('mcp_config_type');
    let url = null;
    try {
      url = new URL(srv.url);
    } catch {
      entry.violations.push('mcp_config_url');
    }
    if (url && url.hostname !== '127.0.0.1') {
      entry.violations.push('non_loopback_url');
      finish(NON_LOOPBACK_EXIT);
      return;
    }
    const auth = srv.headers?.Authorization;
    let bearer = null;
    if (!fileMode) {
      if (auth !== 'Bearer ${WCA_MCP_TOKEN}') entry.violations.push('mcp_header_not_literal');
      // ASSUMED (U-C6/M-CLI-1): the real CLI expands env references in inline --mcp-config headers.
      bearer = token;
    } else {
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || auth.includes('${'))
        entry.violations.push('mcp_file_header');
      else bearer = auth.slice('Bearer '.length);
    }
    if (bearer === null) entry.violations.push('mcp_token_missing');
    if (url && bearer !== null) {
      try {
        const core = await import('./mcp-client-core.mjs');
        client = await core.connect({ url: url.href, token: bearer });
        mcpTools = (await client.listTools()).map((t) => t.name);
        // F17: an authenticated raw GET /mcp must answer 405 (the SDK client accepts only 405 for the optional SSE stream).
        const status = await new Promise((resolve) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port: url.port,
              path: url.pathname,
              method: 'GET',
              headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream' },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.on('error', () => resolve('reset'));
          req.end();
        });
        entry.rawServerProbes.push({ name: 'GET /mcp', status });
        if (status !== 405) entry.violations.push('get_not_405');
      } catch {
        entry.violations.push('mcp_client_error');
      }
      if (client && client.errors.length > 0) entry.violations.push('mcp_client_error');
    }
  }
  journal(); // phase 'started'

  // ---- init ----
  const neutral = Array.isArray(state.neutralInternals) ? state.neutralInternals : [];
  let tools = stage === 'draft' ? mcpTools.map((n) => `mcp__wca__${n}`) : ['StructuredOutput'];
  if (mode === 'no_tools') tools = [];
  tools = [...tools, ...neutral];
  if (mode === 'extra_tool') tools.push('Bash');
  const mcpServers = stage === 'draft' ? [{ name: 'wca', status: client ? 'connected' : 'failed' }] : [];
  if (mode === 'extra_server') mcpServers.push({ name: 'claude.ai Gmail', status: 'connected' });
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: `fake-${invocation}`,
    cwd,
    model: parsed.opts['--model'] ?? 'unknown',
    permissionMode: parsed.opts['--permission-mode'] ?? 'default',
    apiKeySource: mode === 'api_key_leak' ? 'ANTHROPIC_API_KEY' : (state.apiKeySource ?? FAKE_OAUTH_SOURCE),
    tools,
    mcp_servers: mcpServers,
    mcp_server_errors: mode === 'mcp_server_error' ? [{ server: 'wca', error: 'handshake failed' }] : [],
    plugins: mode === 'plugins_present' ? [{ name: 'x', path: 'plugin' }] : [],
    slash_commands: [],
  };
  const sessionId = init.session_id;
  const assistant = (content) => {
    entry.turnStarted = true;
    out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content } });
  };
  const result = (over) =>
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      session_id: sessionId,
      stop_reason: 'end_turn',
      num_turns: 1,
      duration_ms: 1234,
      usage: { input_tokens: 100, output_tokens: 20 },
      permission_denials: [],
      uuid: `fake-uuid-${invocation}`,
      ...over,
    });

  if (mode === 'init_not_first') assistant([{ type: 'text', text: 'hello before init' }]);
  // [D-080] an error event INSTEAD of the init: the app must classify it (not signed in / model rejected), never call it a toolset change
  if (mode === 'auth_error_before_init' || mode === 'model_error_before_init') {
    result({
      subtype: 'success',
      is_error: true,
      result:
        mode === 'auth_error_before_init'
          ? 'Failed to authenticate: OAuth session expired and could not be refreshed'
          : `There's an issue with the selected model (${parsed.opts['--model'] ?? 'unknown'}). It may not exist or you may not have access to it.`,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    finish(1);
    return;
  }
  if (mode !== 'no_init') out(init);
  // The app must kill an unproven run before its first turn: give it the chance (the kill arrives in milliseconds).
  if (INIT_FAILURE_MODES.has(mode)) await sleep(3000);

  if (state.rateLimit && mode !== 'usage_limit' && mode !== 'overage')
    out({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'five_hour', overageStatus: 'allowed', ...state.rateLimit },
    });

  const retry = (error, n = 1) => {
    for (let i = 0; i < n; i += 1)
      out({
        type: 'system',
        subtype: 'api_retry',
        attempt: i + 1,
        max_retries: 3,
        retry_delay_ms: 10,
        error_status: 429,
        error,
      });
  };
  switch (mode) {
    case 'hang':
      await hangForever();
      return;
    case 'kill_me': {
      const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)'], { stdio: 'ignore', windowsHide: true });
      entry.grandchildPid = g.pid ?? null;
      process.on('SIGTERM', () => undefined);
      journal();
      await hangForever();
      return;
    }
    case 'crash_mid_stream':
      assistant([{ type: 'text', text: 'partial' }]);
      process.stdout.write('{"type":"result","subtype":"succ');
      await sleep(50);
      finish(1);
      return;
    case 'rate_limit':
      retry('rate_limit', 3);
      result({ is_error: true, result: 'API Error: Rate limit reached' });
      finish(1);
      return;
    case 'usage_limit':
      out({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: state.rateLimit?.resetsAt ?? 1_900_000_000,
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          isUsingOverage: false,
        },
      });
      result({ is_error: true, result: "You've hit your session limit" });
      finish(1);
      return;
    case 'overage':
      out({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt: state.rateLimit?.resetsAt ?? 1_900_000_000,
          rateLimitType: 'five_hour',
          overageStatus: 'allowed',
          isUsingOverage: true,
        },
      });
      await sleep(1000);
      break; // then a normal answer (if the app did not stop the run)
    case 'auth_failed':
    case 'account_on_hold':
    case 'model_not_found':
      retry(mode === 'auth_failed' ? 'authentication_failed' : mode);
      result({ is_error: true, result: mode === 'auth_failed' ? 'Not logged in' : 'API Error' });
      finish(1);
      return;
    case 'oauth_expired':
      // [D-080] the live stream of an expired subscription session: init FIRST (apiKeySource "none"), then an assistant event with
      // error "authentication_failed", then an is_error result. Message wording from the diagnostic; the app classifies by substrings.
      out({
        type: 'assistant',
        session_id: sessionId,
        error: 'authentication_failed',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate' }] },
      });
      result({
        is_error: true,
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        num_turns: 0,
      });
      finish(1);
      return;
    case 'is_error_success':
      result({ is_error: true, result: 'API Error: Rate limit reached' });
      finish(0);
      return;
    case 'refusal':
      assistant([{ type: 'text', text: 'I cannot help with that.' }]);
      result({ stop_reason: 'refusal', result: 'I cannot help with that.' });
      finish(0);
      return;
    case 'no_structured':
      result({ result: '' });
      finish(0);
      return;
    case 'max_turns':
      result({ subtype: 'error_max_turns', result: undefined });
      finish(1);
      return;
    case 'max_structured_retries':
      result({ subtype: 'error_max_structured_output_retries', result: undefined });
      finish(1);
      return;
    case 'garbage_lines':
      out('this is not json');
      out('x'.repeat(1024 * 1024 + 10));
      out('{"type":"assistant","message":{"content":[{"type":"text","text":"\ud800"}]}');
      out('{"broken":');
      break;
    case 'stderr_flood':
      for (let i = 0; i < 5; i += 1)
        process.stderr.write(`${'e'.repeat(1024 * 1024)} SENTINEL_CLI_STDOUT token=sk-ant-oat01-FAKEBANNER\n`);
      break;
    default:
      break;
  }

  // ---- the answer: script rule, attacker, or a minimal valid answer ----
  const rules = (() => {
    if (!flags.script) return [];
    try {
      const s = JSON.parse(readFileSync(flags.script, 'utf8'));
      return Array.isArray(s.rules) ? s.rules : [];
    } catch {
      return [];
    }
  })();
  const imageSha = stdin.image ? createHash('sha256').update(stdin.image).digest('hex') : null;
  const toolResultsFor = new Set();
  const pick = (turn) =>
    rules.find((r) => {
      const w = r.when ?? {};
      if (w.stage !== undefined && w.stage !== stage) return false;
      if (w.purpose !== undefined && w.stage === undefined && w.purpose !== stage) return false;
      if (w.contains !== undefined && !stdinText.includes(w.contains)) return false;
      if (w.notContains !== undefined && stdinText.includes(w.notContains)) return false;
      if (w.imageSha256 !== undefined && w.imageSha256 !== imageSha) return false;
      if (w.turn !== undefined && w.turn !== turn) return false;
      if (w.hasToolResultFor !== undefined && !toolResultsFor.has(w.hasToolResultFor)) return false;
      return true;
    });
  const schema = (() => {
    try {
      return JSON.parse(parsed.opts['--json-schema']);
    } catch {
      return null;
    }
  })();
  const maxTurns = Number(parsed.opts['--max-turns'] ?? '1');
  const callTool = async (name, input) => {
    const id = `toolu_${randomBytes(4).toString('hex')}`;
    assistant([{ type: 'tool_use', id, name: `mcp__wca__${name}`, input }]);
    let isError = true;
    let text = '{"error":"no client"}';
    if (client) {
      try {
        const r = await client.call(name, input);
        isError = r.isError;
        text = JSON.stringify(r.content);
      } catch {
        isError = true;
      }
    }
    entry.toolCalls.push({ name, allowedByServer: !isError, isError });
    toolResultsFor.add(name);
    out({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
    });
  };

  if (mode === 'attacker') {
    const denials = [];
    for (const name of ['Bash', 'Read', 'WebFetch', 'mcp__gmail__send_message']) {
      assistant([{ type: 'tool_use', id: `toolu_${name}`, name, input: {} }]);
      denials.push({ tool_name: name, tool_use_id: `toolu_${name}`, tool_input: {} });
    }
    if (client) {
      for (const name of ATTACKER_PROBES) {
        const r = await client.call(name, {}).catch(() => ({ isError: true }));
        entry.toolCalls.push({
          name: name.length > 64 ? `${name.slice(0, 8)}...(${name.length})` : name,
          allowedByServer: !r.isError,
          isError: r.isError,
        });
      }
      try {
        const r = await client.call('wa_get_chat_messages', { chat: 'chat_77' });
        entry.toolCalls.push({ name: 'wa_get_chat_messages', allowedByServer: !r.isError, isError: r.isError });
      } catch {
        entry.toolCalls.push({ name: 'wa_get_chat_messages', allowedByServer: false, isError: true });
      }
    }
    const text = 'Sure! Book it here https://evil.example/pay and call +972-55-000-0000. SENTINEL_CLI_STDOUT';
    assistant([{ type: 'text', text }]);
    if (stage === 'draft') result({ result: text, permission_denials: denials });
    else result({ structured_output: schema ? minimalFor(schema) : {}, permission_denials: denials });
    await client?.close().catch(() => undefined);
    finish(0);
    return;
  }

  let turn = 0;
  for (;;) {
    const rule = pick(turn);
    const respond = rule?.respond ?? null;
    if (respond && 'hang' in respond) {
      await hangForever();
      return;
    }
    if (respond && 'error' in respond) {
      const e = respond.error;
      if (e === 'auth' || e === 'not_logged_in') retry('authentication_failed');
      else if (e === 'rate_limited' || e === 'overloaded') retry('rate_limit');
      else if (e === 'model_not_found') retry('model_not_found');
      result({ is_error: true, result: e === 'usage_limit' ? "You've hit your session limit" : 'API Error' });
      finish(1);
      return;
    }
    if (respond && 'toolCalls' in respond) {
      if (stage !== 'draft') {
        entry.violations.push('script_tool_calls_outside_draft');
        result({ subtype: 'error_during_execution', is_error: true, result: 'no tools' });
        finish(1);
        return;
      }
      for (const c of respond.toolCalls) await callTool(c.name, c.input ?? {});
      turn += 1;
      if (turn >= maxTurns) {
        result({ subtype: 'error_max_turns', num_turns: turn, result: undefined });
        await client?.close().catch(() => undefined);
        finish(1);
        return;
      }
      continue;
    }
    if (stage === 'draft') {
      const text = respond && 'text' in respond ? respond.text : 'Fake draft reply.';
      assistant([{ type: 'text', text }]);
      result({ result: text, num_turns: turn + 1 });
    } else {
      const structured =
        respond && 'structured' in respond ? respond.structured : stage === 'smoke' ? { ok: true } : minimalFor(schema);
      if (
        mode === 'placeholder_keys' ||
        mode === 'tool_name_wrapper' ||
        mode === 'placeholder_split' ||
        mode === 'placeholder_then_heal'
      ) {
        // [claude-extract-debug] Live 2.1.258 shape (synthetic capture): each StructuredOutput attempt is one turn; a placeholder input
        // is answered by an is_error tool_result and the model tries again until --max-turns attempts are used, then the run ends with
        // subtype error_max_turns + is_error true (num_turns = attempts + 1), no structured_output and no result text.
        for (let attempt = 0; attempt < maxTurns; attempt += 1) {
          const healed = mode === 'placeholder_then_heal' && attempt >= 1;
          const half = Math.ceil(Object.keys(structured ?? {}).length / 2);
          const entries = Object.entries(structured ?? {});
          const input = healed
            ? structured
            : mode === 'placeholder_split'
              ? {
                  $PARAMETER_NAME: Object.fromEntries(entries.slice(0, half)),
                  $PARAMETER_NAME2: Object.fromEntries(entries.slice(half)),
                }
              : mode === 'tool_name_wrapper'
                ? { StructuredOutput: structured }
                : { $PARAMETER_NAME: structured };
          const id = `toolu_structured_${attempt}`;
          assistant([{ type: 'tool_use', id, name: 'StructuredOutput', input }]);
          if (healed) {
            out({
              type: 'user',
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: id, content: 'Structured output provided successfully' }],
              },
            });
            result({ structured_output: structured, result: '', stop_reason: 'tool_use', num_turns: attempt + 2 });
            await client?.close().catch(() => undefined);
            finish(0);
            return;
          }
          out({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  is_error: true,
                  content: "Output does not match required schema: root: must have required property 'x'",
                },
              ],
            },
          });
        }
        result({
          subtype: 'error_max_turns',
          is_error: true,
          result: undefined,
          stop_reason: 'tool_use',
          num_turns: maxTurns + 1,
          errors: [`Reached maximum number of turns (${maxTurns})`],
        });
        await client?.close().catch(() => undefined);
        finish(1);
        return;
      }
      assistant([{ type: 'tool_use', id: 'toolu_structured', name: 'StructuredOutput', input: structured }]);
      result({ structured_output: structured, result: '' });
    }
    await client?.close().catch(() => undefined);
    finish(0);
    return;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop());
if (isMain) {
  main().catch(() => {
    process.stderr.write('fake-claude-cli.mjs: internal error\n');
    process.exit(98);
  });
}
