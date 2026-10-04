// tests/fakes/fake-llama-server.ts - OpenAI-compatible llama-server double + fake model host (TESTS 3.5; owner W1-07).
// [V2] v2 deltas (T2 3.8; owner V2-W1-08-vision): `--mmproj <file> --mmproj-device none --image-max-tokens 1120|560` (+ mid batch 2048)
// asserted by checkVisionArgv(); `GET /props` answers `modalities.vision` true only for a vision server; chat requests with an
// `image_url` part are matched by `when.imageSha256` (sha256 of the decoded data-URL bytes) and `when.purpose 'read_image'`; an image
// part together with `tools` => violation `vision_with_tools`; an image part on a text-only server => 500 + `image_without_vision`;
// scenario `vision_garbage` answers image requests with non-JSON. The fake model host serves GGUF-magic bodies (text models and
// projectors) and GGML-magic bodies (`lmgg`, voice `*.bin` files).
// Spawnable-fake rules (TESTS 2.3): Node built-ins + tests/fakes only; erasable TS only (no enums, no parameter properties,
// no namespaces) so `node --experimental-strip-types tests/fakes/fake-llama-server.ts --port <p>` runs in child mode.
// Child: node tests/fakes/fake-llama-server.ts --port <p> ... (records the real flag set; key must arrive via env LLAMA_API_KEY).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

export type FakeLlamaScenario = 'default' | 'garbage' | 'exit_on_first_call' | 'vision_garbage' | `load_ms:${number}`;
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
  when: {
    purpose?: 'extract' | 'draft' | 'read_image'; // [V2] read_image = a request carrying an image_url part
    contains?: string;
    notContains?: string;
    turn?: number;
    imageSha256?: string; // [V2] sha256 (hex) of the first image_url part's decoded bytes
  };
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
  /** [V2] in-process mode: this server was "started with --mmproj" (GET /props reports vision). Child mode derives it from argv. */
  vision?: boolean;
  /** [V2] called once per chat request after the contract checks (child mode writes it to --fake-journal). Never the bytes or text. */
  onCompletion?: (entry: FakeLlamaCompletionEntry) => void;
}
/** [V2] one chat request as the child-mode journal records it: structure only (no message text, no picture bytes). */
export interface FakeLlamaCompletionEntry {
  kind: 'completion';
  authorized: boolean;
  hasTools: boolean;
  hasResponseFormat: boolean;
  partTypes: string[]; // content part types of every user turn, in order ('text' for a string content)
  images: Array<{ mime: string; sha256: string; bytes: number }>;
  violations: string[]; // the server's violations so far
}
export interface FakeLlamaServer {
  readonly url: string; // http://127.0.0.1:<port>
  readonly port: number;
  readonly requests: Array<{ at: number; method: string; path: string; authorized: boolean; body?: unknown }>;
  readonly argv: string[]; // child mode: the flags it was started with
  readonly violations: string[]; // e.g. 'tools_and_response_format', 'tool_choice_not_auto', 'thinking_enabled', 'log_file_flag', 'key_in_argv', [V2] 'vision_with_tools', 'image_without_vision'
  /** [V2] one entry per image_url part received: mime and sha256 of the decoded bytes (never the bytes). */
  readonly images: Array<{ mime: string; sha256: string; bytes: number }>;
  /** [V2] sha256 / size of the body the model host serves for a file name (GGML magic for `*.bin`, GGUF otherwise). */
  modelSha256For(file: string): string;
  modelSizeFor(file: string): number;
  setVision(on: boolean): void;
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

/** [V2] B19 / C2 9.1 picture flags per tier (the fake cannot know the tier from argv alone, so the caller may name it). */
export const VISION_MAX_TOKENS: Readonly<Record<'tiny' | 'small' | 'mid', string>> = {
  tiny: '560',
  small: '1120',
  mid: '1120',
};

/** [V2] T2 3.8: when `--mmproj` is present the flag set must be exactly `--mmproj <file> --mmproj-device none --image-max-tokens
 *  1120|560` (+ `--batch-size 2048 --ubatch-size 2048` for mid, and never `--image-min-tokens`). Returns violation names. */
export function checkVisionArgv(argv: readonly string[], tier?: 'tiny' | 'small' | 'mid'): string[] {
  const v: string[] = [];
  const at = argv.indexOf('--mmproj');
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (at === -1) {
    for (const flag of ['--mmproj-device', '--image-max-tokens', '--image-min-tokens']) {
      if (argv.includes(flag)) v.push(`vision_flag_without_mmproj:${flag}`);
    }
    return v;
  }
  const file = argv[at + 1];
  if (file === undefined || file.startsWith('-') || !/mmproj.*\.gguf$/i.test(file)) v.push('bad_mmproj_file');
  if (valueOf('--mmproj-device') !== 'none') v.push('mmproj_device_not_none');
  const maxTokens = valueOf('--image-max-tokens');
  if (maxTokens === undefined) v.push('missing_flag:--image-max-tokens');
  else if (tier !== undefined ? maxTokens !== VISION_MAX_TOKENS[tier] : maxTokens !== '1120' && maxTokens !== '560')
    v.push('bad_flag_value:--image-max-tokens');
  if (argv.includes('--image-min-tokens')) v.push('image_min_tokens');
  const batch = valueOf('--batch-size');
  const ubatch = valueOf('--ubatch-size');
  if (tier === 'mid' && (batch !== '2048' || ubatch !== '2048')) v.push('mid_batch_missing');
  if (tier !== undefined && tier !== 'mid' && (batch !== undefined || ubatch !== undefined)) v.push('batch_on_non_mid');
  if ((batch === undefined) !== (ubatch === undefined) || (batch !== undefined && batch !== ubatch))
    v.push('batch_ubatch_mismatch');
  return v;
}

/** [V2] The image_url parts of an OpenAI chat request (data URLs), decoded. */
function imagesOf(messages: unknown): Array<{ mime: string; bytes: Buffer }> {
  const out: Array<{ mime: string; bytes: Buffer }> = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages as Array<{ content?: unknown }>) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content as Array<{ type?: unknown; image_url?: { url?: unknown } }>) {
      if (part?.type !== 'image_url') continue;
      const url = part.image_url?.url;
      const match = typeof url === 'string' ? /^data:([a-z/]+);base64,([A-Za-z0-9+/=]*)$/.exec(url) : null;
      out.push(
        match === null
          ? { mime: '', bytes: Buffer.alloc(0) }
          : { mime: match[1]!, bytes: Buffer.from(match[2]!, 'base64') },
      );
    }
  }
  return out;
}

/** [V2] content part types of the user turns, in order (a string content counts as one 'text'). */
function partTypesOf(messages: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages as Array<{ role?: unknown; content?: unknown }>) {
    if (m?.role !== 'user') continue;
    if (!Array.isArray(m.content)) out.push('text');
    else
      for (const p of m.content as Array<{ type?: unknown }>)
        out.push(typeof p?.type === 'string' ? p.type : 'unknown');
  }
  return out;
}

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
/** [V2] whisper.cpp `GGML` magic (`6c 6d 67 67` = 'lmgg') + deterministic filler, for the voice files (`*.bin`). */
export function fakeGgmlBytes(size = DEFAULT_MODEL_BYTES): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('lmgg', 0, 'ascii');
  for (let i = 4; i < size; i += 1) buf[i] = (i * 17 + 11) & 0xff;
  return buf;
}
/** [V2] which magic a model-host file gets: voice / VAD files are `.bin` (GGML), everything else (text GGUF, mmproj) is GGUF. */
export function isGgmlFile(file: string): boolean {
  return /\.bin$/i.test(file);
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
  const ggmlBody = fakeGgmlBytes(opts.modelHost?.sizeBytes ?? DEFAULT_MODEL_BYTES);
  const ggmlSha256 = createHash('sha256').update(ggmlBody).digest('hex');
  const bodyOf = (file: string): Buffer => (isGgmlFile(file) ? ggmlBody : modelBody);
  const shaOf = (file: string): string => (isGgmlFile(file) ? ggmlSha256 : modelSha256);
  let vision = opts.vision ?? false;
  const images: Array<{ mime: string; sha256: string; bytes: number }> = [];
  const startedAt = Date.now();
  const loadMs = opts.loadMs ?? (scenario.startsWith('load_ms:') ? Number(scenario.slice('load_ms:'.length)) : 0);
  let turn = 0;
  let signedIssued = 0;

  const pickRule = (body: Record<string, unknown>, imageSha: string | null): FakeLlamaRule | null => {
    const purpose = imageSha !== null ? 'read_image' : body.response_format === undefined ? 'draft' : 'extract';
    const haystack = JSON.stringify(body.messages ?? []);
    for (const st of rules) {
      const w = st.rule.when;
      if (st.rule.times !== undefined && st.used >= st.rule.times) continue;
      if (w.purpose !== undefined && w.purpose !== purpose) continue;
      if (w.imageSha256 !== undefined && w.imageSha256 !== imageSha) continue;
      if (w.turn !== undefined && w.turn !== turn) continue;
      if (w.contains !== undefined && !haystack.includes(w.contains)) continue;
      if (w.notContains !== undefined && haystack.includes(w.notContains)) continue;
      st.used += 1;
      return st.rule;
    }
    return null;
  };

  const completionFromRule = (rule: FakeLlamaRule | null, body: Record<string, unknown>, isImage: boolean): unknown => {
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
    if (scenario === 'vision_garbage' && isImage)
      return wrap({ role: 'assistant', content: 'I see a picture {{{' }, 'stop');
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
    // [V2] T2 3.8 picture checks
    const parts = imagesOf(body.messages);
    let imageSha: string | null = null;
    if (parts.length > 0) {
      for (const part of parts) {
        images.push({
          mime: part.mime,
          sha256: createHash('sha256').update(part.bytes).digest('hex'),
          bytes: part.bytes.length,
        });
      }
      imageSha = images[images.length - parts.length]!.sha256;
      if (body.tools !== undefined || body.tool_choice !== undefined) violations.push('vision_with_tools');
      if (!vision) {
        violations.push('image_without_vision');
        json(res, 500, { error: { message: 'image input is not supported by this server', type: 'server_error' } });
        return;
      }
    }
    opts.onCompletion?.({
      kind: 'completion',
      authorized,
      hasTools: body.tools !== undefined || body.tool_choice !== undefined,
      hasResponseFormat: body.response_format !== undefined,
      partTypes: partTypesOf(body.messages),
      images: images.slice(images.length - parts.length),
      violations: [...violations],
    });
    const rule = scenario === 'vision_garbage' && imageSha !== null ? null : pickRule(body, imageSha);
    turn += 1;
    if (rule !== null && 'hang' in rule.respond) return; // never answers
    if (rule !== null && 'status' in rule.respond) {
      const text = rule.respond.body ?? '{"error":{"message":"fake"}}';
      res.writeHead(rule.respond.status, { 'content-type': 'application/json' });
      res.end(text);
      return;
    }
    json(res, 200, completionFromRule(rule, body, imageSha !== null));
  };

  const serveModel = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const isResolve = /\/resolve\/[0-9a-f]{40}\//.test(url.pathname);
    if (isResolve) {
      signedIssued += 1;
      const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
      const size = modelScenario === 'wrong_size' ? bodyOf(file).length + 999 : bodyOf(file).length;
      const location =
        modelScenario === 'foreign_redirect_host'
          ? 'https://hf.co.evil.example/cdn/signed-1'
          : `http://127.0.0.1:${String(port)}/cdn/signed-${String(signedIssued)}${isGgmlFile(file) ? '.bin' : ''}`;
      res.writeHead(302, {
        location,
        'x-repo-commit': FAKE_GGUF_COMMIT,
        'x-linked-size': String(size),
        'x-linked-etag': `"${shaOf(file)}"`,
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
    if (
      modelScenario === 'expired_redirect_on_resume' &&
      url.pathname.replace(/\.bin$/, '') !== `/cdn/signed-${String(signedIssued)}`
    ) {
      res.writeHead(403, { 'content-length': '0' });
      res.end();
      return;
    }
    const served = url.pathname.endsWith('.bin') ? ggmlBody : modelBody;
    let payload = served;
    if (modelScenario === 'corrupt_byte') {
      payload = Buffer.from(served);
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
    if (url.pathname === '/props' && req.method === 'GET') {
      // [V2] C2 9.1 readiness probe; the real server reports the loaded modalities. The bearer is recorded, not enforced.
      const authorized = req.headers.authorization === `Bearer ${opts.apiKey}`;
      requests.push({ at: Date.now(), method: 'GET', path: url.pathname, authorized });
      json(res, 200, { model_path: 'fake.gguf', n_ctx: 8192, modalities: { vision, audio: false } });
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
    images,
    modelSha256For: (file) => shaOf(file),
    modelSizeFor: (file) => bodyOf(file).length,
    setVision: (on) => {
      vision = on;
    },
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
  const flagViolations = [...checkLlamaArgv(argv, apiKey), ...checkVisionArgv(argv)];
  if (apiKey === '') flagViolations.push('key_not_in_env');
  process.stdout.write(`FAKE_LLAMA_ARGV ${JSON.stringify(argv)}\n`);
  if (flagViolations.length > 0) {
    process.stdout.write(`FAKE_LLAMA_VIOLATIONS ${JSON.stringify(flagViolations)}\n`);
    process.exit(2);
  }
  const loadAt = argv.indexOf('--load-ms');
  // [V2] --fake-rules <file> ({rules:[...]}) scripts the answers; --fake-journal <file> gets one JSON line for the argv and one per
  // chat request (structure only). Both are test-only flags the real llama-server never sees.
  const rulesAt = argv.indexOf('--fake-rules');
  const journalAt = argv.indexOf('--fake-journal');
  const journal = journalAt === -1 ? null : argv[journalAt + 1]!;
  const rules =
    rulesAt === -1
      ? []
      : ((JSON.parse(readFileSync(argv[rulesAt + 1]!, 'utf8')) as { rules?: FakeLlamaRule[] }).rules ?? []);
  const writeJournal = (entry: unknown): void => {
    if (journal !== null) appendFileSync(journal, `${JSON.stringify(entry)}\n`);
  };
  writeJournal({ kind: 'argv', argv, visionViolations: checkVisionArgv(argv) });
  const fake = await startFakeLlamaServer({
    port,
    apiKey,
    rules,
    loadMs: loadAt === -1 ? 0 : Number(argv[loadAt + 1]),
    vision: argv.includes('--mmproj'), // [V2] GET /props reports vision only when started with the projector
    onCompletion: writeJournal,
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
