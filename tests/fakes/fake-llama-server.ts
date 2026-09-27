// tests/fakes/fake-llama-server.ts - OpenAI-compatible llama-server double + fake model host (TESTS 3.5; owner W1-07).
// Spawnable-fake rules (TESTS 2.3): Node built-ins + tests/fakes only; erasable TS only (no enums, no parameter properties,
// no namespaces) so `node --experimental-strip-types tests/fakes/fake-llama-server.ts --port <p>` runs in child mode.
// Child: node tests/fakes/fake-llama-server.ts --port <p> ... (records the real flag set; key must arrive via env LLAMA_API_KEY).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

export type FakeLlamaScenario = 'default' | 'garbage' | 'exit_on_first_call' | `load_ms:${number}`;
export type FakeDeviceFixture = 'nvidia_8g' | 'intel_igpu_only' | 'igpu_plus_dgpu' | 'unparseable';
export type FakeModelHostScenario =
  | 'default'
  | `drop_at:${number}`
  | 'expired_redirect_on_resume'
  | 'foreign_redirect_host'
  | 'corrupt_byte'
  | 'wrong_size'
  | 'no_range_support';

/** Same rule shape as stub-llm.ts (duplicated as a plain type so this file stays spawnable without src/** or other test imports). */
export type FakeLlamaRule = {
  when: { purpose?: 'extract' | 'draft'; contains?: string; notContains?: string; turn?: number };
  respond:
    | { structured: Record<string, unknown> }
    | { text: string; finishReason?: 'stop' | 'length' }
    | { toolCalls: Array<{ name: string; input: Record<string, unknown> }> }
    | { status: number; body?: string }
    | { hang: true };
  times?: number;
};
export interface FakeLlamaServerOptions {
  port?: number; // 0 = free port, never 8080
  apiKey: string; // expected via env LLAMA_API_KEY in child mode; Bearer check on every request
  loadMs?: number; // /health answers 503 "loading" for this long
  rules?: FakeLlamaRule[];
  scenario?: FakeLlamaScenario;
  modelHost?: { scenario?: FakeModelHostScenario; sizeBytes?: number }; // fake GGUF host (256 KiB by default)
}
export interface FakeLlamaServer {
  readonly url: string; // http://127.0.0.1:<port>
  readonly port: number;
  readonly requests: Array<{ at: number; method: string; path: string; authorized: boolean; body?: unknown }>;
  readonly argv: string[]; // child mode: the flags it was started with
  readonly violations: string[]; // e.g. 'tools_and_response_format', 'tool_choice_not_auto', 'thinking_enabled', 'log_file_flag', 'key_in_argv'
  /** The fake model host: GET /<repo>/resolve/<commit>/<file> -> 302 -> /cdn/<signed> ; Range support ; scenarios. */
  modelUrl(file?: string): string;
  readonly modelSha256: string; // sha256 of the served fake GGUF
  readonly modelSize: number;
  setScenario(s: FakeLlamaScenario): void;
  setModelHostScenario(s: FakeModelHostScenario): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------
// flag contract (TESTS 3.5) - the child asserts it, the in-process mode exports it so llamaServer tests reuse one list
// ---------------------------------------------------------------------------------------------------------------------
export const REQUIRED_LLAMA_FLAGS: readonly string[] = [
  '--jinja',
  '--no-webui',
  '--offline',
  '-c',
  '8192',
  '-np',
  '1',
  '--sleep-idle-seconds',
  '600',
  '--reasoning-budget',
  '0',
];
export const FORBIDDEN_LLAMA_FLAGS: readonly string[] = ['--log-file', '--api-key', '--api-key-file'];

/** Checks a llama-server argv against the contract; returns the violation names (empty = fine). */
export function checkLlamaArgv(argv: readonly string[], apiKey?: string): string[] {
  const v: string[] = [];
  for (let i = 0; i < REQUIRED_LLAMA_FLAGS.length; i += 1) {
    const flag = REQUIRED_LLAMA_FLAGS[i]!;
    if (!flag.startsWith('-')) continue;
    const at = argv.indexOf(flag);
    if (at === -1) {
      v.push(`missing_flag:${flag}`);
      continue;
    }
    const next = REQUIRED_LLAMA_FLAGS[i + 1];
    if (next !== undefined && !next.startsWith('-') && argv[at + 1] !== next) v.push(`bad_flag_value:${flag}`);
  }
  for (const forbidden of FORBIDDEN_LLAMA_FLAGS) if (argv.includes(forbidden)) v.push('log_file_flag');
  if (apiKey !== undefined && apiKey !== '' && argv.some((a) => a.includes(apiKey))) v.push('key_in_argv');
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------
// device fixtures
// ---------------------------------------------------------------------------------------------------------------------
const DEVICE_FIXTURES: Record<FakeDeviceFixture, string> = {
  nvidia_8g: [
    'ggml_vulkan: Found 1 Vulkan devices:',
    'ggml_vulkan: 0 = NVIDIA GeForce RTX 4060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | warp size: 32',
    'Available devices:',
    '  Vulkan0: NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB, 7609 MiB free)',
    '',
  ].join('\n'),
  intel_igpu_only: [
    'ggml_vulkan: Found 1 Vulkan devices:',
    'ggml_vulkan: 0 = Intel(R) Iris(R) Xe Graphics (Intel) | uma: 1 | fp16: 1 | warp size: 32',
    'Available devices:',
    '  Vulkan0: Intel(R) Iris(R) Xe Graphics (16250 MiB, 15980 MiB free)',
    '',
  ].join('\n'),
  igpu_plus_dgpu: [
    'ggml_vulkan: Found 2 Vulkan devices:',
    'Available devices:',
    '  Vulkan0: Intel(R) UHD Graphics (7900 MiB, 7700 MiB free)',
    '  Vulkan1: NVIDIA GeForce RTX 3050 Laptop GPU (6144 MiB, 5901 MiB free)',
    '',
  ].join('\n'),
  unparseable: 'llama-server: unrecognised output\n<<<binary garbage>>>\nAvailable devices:\n  ???\n',
};

/** Text that `llama-server.exe --list-devices` would print for the fixture. */
export function listDevicesFixture(name: FakeDeviceFixture): string {
  const text = DEVICE_FIXTURES[name];
  if (text === undefined) throw new Error(`unknown device fixture: ${String(name)}`);
  return text;
}

// ---------------------------------------------------------------------------------------------------------------------
// fake GGUF body
// ---------------------------------------------------------------------------------------------------------------------
export const FAKE_GGUF_REPO = 'fake-org/fake-model-GGUF';
export const FAKE_GGUF_COMMIT = '0123456789abcdef0123456789abcdef01234567';
export const FAKE_GGUF_FILE = 'fake-model-Q4_K_M.gguf';
const DEFAULT_MODEL_BYTES = 256 * 1024;

/** `GGUF` magic + deterministic filler, so every run hashes to the same sha256. */
export function fakeGgufBytes(size = DEFAULT_MODEL_BYTES): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('GGUF', 0, 'ascii');
  for (let i = 4; i < size; i += 1) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

// ---------------------------------------------------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------------------------------------------------
interface RuleState {
  rule: FakeLlamaRule;
  used: number;
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > cap) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export async function startFakeLlamaServer(opts: FakeLlamaServerOptions): Promise<FakeLlamaServer> {
  const requests: Array<{ at: number; method: string; path: string; authorized: boolean; body?: unknown }> = [];
  const violations: string[] = [];
  const rules: RuleState[] = (opts.rules ?? []).map((rule) => ({ rule, used: 0 }));
  let scenario: FakeLlamaScenario = opts.scenario ?? 'default';
  let modelScenario: FakeModelHostScenario = opts.modelHost?.scenario ?? 'default';
  const modelBody = fakeGgufBytes(opts.modelHost?.sizeBytes ?? DEFAULT_MODEL_BYTES);
  const modelSha256 = createHash('sha256').update(modelBody).digest('hex');
  const startedAt = Date.now();
  const loadMs = opts.loadMs ?? (scenario.startsWith('load_ms:') ? Number(scenario.slice('load_ms:'.length)) : 0);
  let turn = 0;
  let signedIssued = 0;

  const pickRule = (body: Record<string, unknown>): FakeLlamaRule | null => {
    const purpose = body.response_format === undefined ? 'draft' : 'extract';
    const haystack = JSON.stringify(body.messages ?? []);
    for (const st of rules) {
      const w = st.rule.when;
      if (st.rule.times !== undefined && st.used >= st.rule.times) continue;
      if (w.purpose !== undefined && w.purpose !== purpose) continue;
      if (w.turn !== undefined && w.turn !== turn) continue;
      if (w.contains !== undefined && !haystack.includes(w.contains)) continue;
      if (w.notContains !== undefined && haystack.includes(w.notContains)) continue;
      st.used += 1;
      return st.rule;
    }
    return null;
  };

  const completionFromRule = (rule: FakeLlamaRule | null, body: Record<string, unknown>): unknown => {
    const usage = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 };
    const wrap = (message: Record<string, unknown>, finish: string): unknown => ({
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: Math.floor(startedAt / 1000),
      model: 'local',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage,
    });
    if (rule !== null && 'structured' in rule.respond) {
      return wrap({ role: 'assistant', content: JSON.stringify(rule.respond.structured) }, 'stop');
    }
    if (rule !== null && 'text' in rule.respond) {
      return wrap(
        { role: 'assistant', content: rule.respond.text },
        rule.respond.finishReason === 'length' ? 'length' : 'stop',
      );
    }
    if (rule !== null && 'toolCalls' in rule.respond) {
      const toolCalls = rule.respond.toolCalls.map((tc, i) => ({
        id: `call_${String(i)}`,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
      return wrap({ role: 'assistant', content: '', tool_calls: toolCalls }, 'tool_calls');
    }
    if (scenario === 'garbage') return wrap({ role: 'assistant', content: 'not json at all {{{' }, 'stop');
    if (body.response_format !== undefined) return wrap({ role: 'assistant', content: '{"ok":true}' }, 'stop');
    return wrap({ role: 'assistant', content: 'ok' }, 'stop');
  };

  const handleCompletions = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const authorized = req.headers.authorization === `Bearer ${opts.apiKey}`;
    const raw = await readBody(req, 8 * 1024 * 1024);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      body = {};
    }
    requests.push({ at: Date.now(), method: req.method ?? 'POST', path: url.pathname, authorized, body });
    if (!authorized) {
      json(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } });
      return;
    }
    if (scenario === 'exit_on_first_call') {
      req.socket.destroy();
      return;
    }
    // contract checks
    const responseFormat = body.response_format as { type?: string; json_schema?: { schema?: unknown } } | undefined;
    if (body.tools !== undefined && responseFormat !== undefined) violations.push('tools_and_response_format');
    if (body.tool_choice !== undefined && body.tool_choice !== 'auto') violations.push('tool_choice_not_auto');
    const kwargs = body.chat_template_kwargs as { enable_thinking?: unknown } | undefined;
    if (kwargs?.enable_thinking !== false) violations.push('thinking_enabled');
    // [R2] llama-server b10964 reads response_format.json_schema.schema; an absent schema means NO grammar -> treat as a 400.
    if (responseFormat?.type === 'json_schema' && responseFormat.json_schema?.schema === undefined) {
      json(res, 400, {
        error: { message: 'response_format.json_schema.schema is required', type: 'invalid_request_error' },
      });
      return;
    }
    const rule = pickRule(body);
    turn += 1;
    if (rule !== null && 'hang' in rule.respond) return; // never answers
    if (rule !== null && 'status' in rule.respond) {
      const text = rule.respond.body ?? '{"error":{"message":"fake"}}';
      res.writeHead(rule.respond.status, { 'content-type': 'application/json' });
      res.end(text);
      return;
    }
    json(res, 200, completionFromRule(rule, body));
  };

  const serveModel = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const isResolve = /\/resolve\/[0-9a-f]{40}\//.test(url.pathname);
    if (isResolve) {
      signedIssued += 1;
      const size = modelScenario === 'wrong_size' ? modelBody.length + 999 : modelBody.length;
      const location =
        modelScenario === 'foreign_redirect_host'
          ? 'https://hf.co.evil.example/cdn/signed-1'
          : `http://127.0.0.1:${String(port)}/cdn/signed-${String(signedIssued)}`;
      res.writeHead(302, {
        location,
        'x-repo-commit': FAKE_GGUF_COMMIT,
        'x-linked-size': String(size),
        'x-linked-etag': `"${modelSha256}"`,
        'accept-ranges': 'bytes',
        'content-length': '0',
      });
      res.end();
      return;
    }
    if (!url.pathname.startsWith('/cdn/')) {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    if (modelScenario === 'expired_redirect_on_resume' && url.pathname !== `/cdn/signed-${String(signedIssued)}`) {
      res.writeHead(403, { 'content-length': '0' });
      res.end();
      return;
    }
    let payload = modelBody;
    if (modelScenario === 'corrupt_byte') {
      payload = Buffer.from(modelBody);
      payload[Math.floor(payload.length / 2)] = (payload[Math.floor(payload.length / 2)]! ^ 0xff) & 0xff;
    }
    const range = req.headers.range;
    let start = 0;
    let status = 200;
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
    if (range !== undefined && modelScenario !== 'no_range_support') {
      const m = /^bytes=(\d+)-/.exec(range);
      if (m) {
        start = Number(m[1]);
        status = 206;
        headers['content-range'] = `bytes ${String(start)}-${String(payload.length - 1)}/${String(payload.length)}`;
      }
    }
    const slice = payload.subarray(start);
    headers['content-length'] = String(slice.length);
    res.writeHead(status, headers);
    const dropAt = modelScenario.startsWith('drop_at:') ? Number(modelScenario.slice('drop_at:'.length)) : -1;
    if (dropAt >= 0 && dropAt > start && dropAt < start + slice.length) {
      // Destroy only AFTER the partial body has been flushed to the socket, otherwise the client loses every byte and
      // the downloader can never demonstrate a Range resume (the real failure mode drops a connection mid-stream).
      res.write(slice.subarray(0, dropAt - start), () => {
        setTimeout(() => res.socket?.destroy(), 10).unref();
      });
      return;
    }
    res.end(slice);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      requests.push({ at: Date.now(), method: req.method ?? 'GET', path: url.pathname, authorized: true });
      if (Date.now() - startedAt < loadMs) {
        json(res, 503, { status: 'loading model', error: { message: 'Loading model' } });
        return;
      }
      json(res, 200, { status: 'ok' });
      return;
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      void handleCompletions(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/cdn/') || /\/resolve\/[0-9a-f]{40}\//.test(url.pathname)) {
      requests.push({ at: Date.now(), method: req.method ?? 'GET', path: url.pathname, authorized: true });
      serveModel(req, res, url);
      return;
    }
    res.writeHead(404, { 'content-length': '0' });
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 8080) throw new Error('fake-llama-server: refusing port 8080');

  const fake: FakeLlamaServer = {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    requests,
    argv: [...process.argv.slice(2)],
    violations,
    modelUrl: (file = FAKE_GGUF_FILE) =>
      `http://127.0.0.1:${String(port)}/${FAKE_GGUF_REPO}/resolve/${FAKE_GGUF_COMMIT}/${file}`,
    modelSha256,
    modelSize: modelBody.length,
    setScenario: (s) => {
      scenario = s;
    },
    setModelHostScenario: (s) => {
      modelScenario = s;
    },
    stop: async () => {
      unregister?.();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };

  let unregister: (() => void) | undefined;
  try {
    const guards = (await import('../setup-guards.ts')) as {
      registerFake?: (f: { name: string; stop(): Promise<void> | void; violations?: string[] }) => () => void;
    };
    unregister = guards.registerFake?.({ name: 'fake-llama-server', stop: () => fake.stop(), violations });
  } catch {
    unregister = undefined;
  }
  return fake;
}

// ---------------------------------------------------------------------------------------------------------------------
// Child mode entry - only when executed directly.
// ---------------------------------------------------------------------------------------------------------------------
async function childMain(argv: string[]): Promise<void> {
  if (argv.includes('--list-devices')) {
    const at = argv.indexOf('--devices');
    const name = (at === -1 ? 'nvidia_8g' : argv[at + 1]) as FakeDeviceFixture;
    process.stdout.write(listDevicesFixture(name));
    process.exit(0);
  }
  const portAt = argv.indexOf('--port');
  const port = portAt === -1 ? 0 : Number(argv[portAt + 1]);
  const apiKey = process.env.LLAMA_API_KEY ?? '';
  const flagViolations = checkLlamaArgv(argv, apiKey);
  if (apiKey === '') flagViolations.push('key_not_in_env');
  process.stdout.write(`FAKE_LLAMA_ARGV ${JSON.stringify(argv)}\n`);
  if (flagViolations.length > 0) {
    process.stdout.write(`FAKE_LLAMA_VIOLATIONS ${JSON.stringify(flagViolations)}\n`);
    process.exit(2);
  }
  const loadAt = argv.indexOf('--load-ms');
  const fake = await startFakeLlamaServer({
    port,
    apiKey,
    loadMs: loadAt === -1 ? 0 : Number(argv[loadAt + 1]),
  });
  process.stdout.write(`FAKE_LLAMA_READY ${String(fake.port)}\n`);
  process.on('SIGTERM', () => {
    void fake.stop().then(() => process.exit(0));
  });
}

if (
  process.argv[1] !== undefined &&
  /fake-llama-server\.ts$/.test(process.argv[1]) &&
  (process.argv.includes('--port') || process.argv.includes('--list-devices'))
) {
  void childMain(process.argv.slice(2));
}
