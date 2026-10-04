// tests/security/vision-no-tools.test.ts - T2 8.2 group 21 (the V1 half; owner V2-W1-08-vision, inherited by V2-W2-02).
// I12: V1 READ-IMAGE has ZERO tools on every provider. The V1 request / argv is captured per provider through the PRODUCTION stage
// (agent/readImage.ts createReadImageStage) and the production adapters:
//   local      - llm/local.ts over the in-process fake llama-server (vision on): no tools / tool_choice / functions, image_url first
//   claude     - llm/claude.ts over a recording SDK double: no tools, the base64 image block first
//   gemini     - llm/gemini.ts over a recording SDK double: no tools / function declarations, the inline picture first
//   claude_cli - llm/cli/claudeCli.ts + the real CliRunner + JobRunner spawning tests/fakes/fake-claude-cli.mjs (T8: never claude.exe):
//                --tools "" + --strict-mcp-config + --max-turns 1 + --json-schema IMAGE_READ_SCHEMA, never --mcp-config / --allowedTools
//   antigravity_cli - never receives a picture: V1 routes to Local
// plus: V1 never calls chat() / runAgentic(); readImage.ts is the only LlmImagePart builder (source grep); decompression bombs and
// non-JPEG/PNG bytes are rejected before the S-IMAGE facade (nativeImage) is touched; the 4 injection pictures => suspicious =>
// the red `manipulation` badge (scripted). Everything is synthetic (T5/T12); no network, no vendor binary.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPickImage,
  createReadImageStage,
  imageBadgesOf,
  readerOf,
  type NormalizedImage,
  type ReadImageDeps,
  type ReadImageOutcome,
} from '../../src/main/agent/readImage.ts';
import { createImageNormalizer } from '../../src/main/media/normalizeImage.ts';
import { readImageDims } from '../../src/main/media/imageDims.ts';
import { createLocalProvider, DEFAULT_LOCAL_SAMPLING } from '../../src/main/llm/local.ts';
import { createClaudeProvider, type ClaudeClientLike } from '../../src/main/llm/claude.ts';
import { createGeminiProvider, type GeminiClientLike } from '../../src/main/llm/gemini.ts';
import type { LlamaRuntime } from '../../src/main/llm/local/llamaServer.ts';
import type { LlmProvider } from '../../src/main/llm/types.ts';
import type { Clock, ClockTimer, ImageFacade, ImageHandle, Logger } from '../../src/main/deps.ts';
import { IMAGE_READ_SCHEMA, type ImageRead } from '../../src/shared/schemas.ts';
import type { ChatRef, EpochMs, Message, ProviderId, Sha256Hex } from '../../src/shared/types.ts';
import { startFakeLlamaServer, type FakeLlamaServer } from '../fakes/fake-llama-server.ts';
import { StubLlm } from '../fakes/stub-llm.ts';
import { gif, jpeg, jpegBomb, png, pngBomb, polyglot, tooBig, truncatedJpeg, webp } from '../fakes/image-fixtures.ts';
import { createClaudeFakeWorld, type ClaudeFakeWorld } from '../helpers/cli-fakes-hook.world.ts';
import { GOLDEN_IMAGES, absPathOf, imageReadOf } from '../../scripts/gen-golden-images.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SENTINEL = 'SENTINEL_V1_CAPTION_5c1e';
const NOW = Date.parse('2026-09-21T07:00:00.000Z') as EpochMs;
const NONCE = '0123456789abcdef';
const READ: ImageRead = imageReadOf(GOLDEN_IMAGES.find((s) => s.id === 'img-en-01')!) as ImageRead;
const TOOL_KEYS =
  /"(tools|tool_choice|tool_config|functions|function_declarations|functionDeclarations|parallel_tool_calls|mcp_servers)"/;

const quietLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quietLog,
};
const clock: Clock = {
  now: () => NOW,
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as ClockTimer,
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};
const runs: ReadImageDeps['repos']['runs'] = {
  start: () => 1,
  finish: () => undefined,
  cloudTokensSince: () => ({ inputTokens: 0, outputTokens: 0 }),
  finishCli: () => undefined,
  sandboxOfVersion: () => [],
};
const picture = (bytes: Uint8Array = jpeg(24, 16)): NormalizedImage => ({
  jpeg: bytes,
  width: 24,
  height: 16,
  sha256: createHash('sha256').update(bytes).digest('hex') as Sha256Hex,
  thumbDataUrl: 'data:image/jpeg;base64,AA==',
  sourceMime: 'image/jpeg',
});
const v1Input = (image = picture()) => ({
  chatId: 3 as ChatRef,
  itemId: 9,
  image,
  captionSanitised: `caption ${SENTINEL}`,
  nowMs: NOW,
  timeZone: 'Asia/Jerusalem',
  nonce: NONCE,
});

/** The production stage with `active` as the active provider and `local` as the projector route. */
function stage(active: LlmProvider, local: LlmProvider | null) {
  return createReadImageStage({
    images: () => ({ enabled: true, cloud: true }),
    activeProvider: async () => active,
    consentCurrent: () => true,
    local: { mmprojReady: () => local !== null, provider: () => local! },
    imagesPassed: () => false,
    repos: { runs },
    clock,
    log: quietLog,
  });
}
const expectOk = (o: ReadImageOutcome) => expect(o).toMatchObject({ ok: true, read: READ });

// ---- provider builders --------------------------------------------------------------------------------------------------------
const LLAMA_KEY = 'b'.repeat(64);
const fakes: FakeLlamaServer[] = [];
const worlds: ClaudeFakeWorld[] = [];
afterEach(async () => {
  while (fakes.length > 0) await fakes.pop()!.stop();
  for (const w of worlds.splice(0)) w.cleanup();
});
async function localProvider(): Promise<{ provider: LlmProvider; fake: FakeLlamaServer }> {
  const fake = await startFakeLlamaServer({
    apiKey: LLAMA_KEY,
    vision: true,
    rules: [{ when: { purpose: 'read_image' }, respond: { structured: READ as unknown as Record<string, unknown> } }],
  });
  fakes.push(fake);
  const runtime: LlamaRuntime = {
    ensureStarted: async () => ({ port: fake.port, apiKey: LLAMA_KEY }),
    stop: async () => undefined,
    childSpec: () => {
      throw new Error('unused');
    },
    status: () => ({ state: 'ready', code: null, device: 'cpu' }),
    vision: () => ({ requested: true, ready: true, stale: false }),
  };
  return {
    fake,
    provider: createLocalProvider({
      runtime,
      modelLabel: 'gemma-test',
      sampling: DEFAULT_LOCAL_SAMPLING,
      fetch,
      log: quietLog,
    }),
  };
}
function claudeProvider(): { provider: LlmProvider; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const client: ClaudeClientLike = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        requests.push(params);
        return {
          content: [{ type: 'text', text: JSON.stringify(READ) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
    models: { list: async () => ({ data: [] }), retrieve: async () => ({}) },
  } as unknown as ClaudeClientLike;
  return {
    requests,
    provider: createClaudeProvider({ apiKey: 'sk-ant-TESTONLY-v1', model: 'claude-opus-5', client, log: quietLog }),
  };
}
function geminiProvider(): { provider: LlmProvider; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const client: GeminiClientLike = {
    interactions: {
      create: async (params: Record<string, unknown>) => {
        requests.push(params);
        return { id: 'int_TESTONLY', status: 'completed', output_text: JSON.stringify(READ), steps: [], usage: {} };
      },
    },
    models: { generateContent: async () => ({}), get: async () => ({}), list: async () => ({}) },
  } as unknown as GeminiClientLike;
  return {
    requests,
    provider: createGeminiProvider({
      apiKey: 'AIzaTESTONLYv1visionnotoolsxxxxxxxxxxx',
      model: 'gemini-3.8-flash',
      client,
      log: quietLog,
    }),
  };
}
/** A provider double that must never be used (antigravity_cli in v2.0, and every chat()/runAgentic() path of V1). */
function forbidden(id: ProviderId, images: boolean) {
  const structured = vi.fn(() => Promise.reject(new Error(`${id}.structured must not be called`)));
  const chat = vi.fn(() => Promise.reject(new Error(`${id}.chat must not be called`)));
  const runAgentic = vi.fn(() => Promise.reject(new Error(`${id}.runAgentic must not be called`)));
  const p = {
    id,
    model: `${id}-m`,
    loop: 'turn',
    capabilities: { images },
    structured,
    chat,
    runAgentic,
    validate: async () => ({ ok: true, model: 'x' }),
    dispose: async () => undefined,
  } as unknown as LlmProvider;
  return { p, structured, chat, runAgentic };
}

// =================================================================================================================================
describe('I12: the V1 request / argv per provider carries no tools', () => {
  it('local: image_url FIRST, response_format only - no tools, tool_choice, functions or parallel_tool_calls', async () => {
    const { provider, fake } = await localProvider();
    const img = picture();
    expectOk(await stage(provider, provider)(v1Input(img), new AbortController().signal));
    const bodies = fake.requests
      .filter((r) => r.path === '/v1/chat/completions')
      .map((r) => r.body as Record<string, unknown>);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(Object.keys(body).sort()).toEqual(
      expect.arrayContaining(['messages', 'model', 'response_format', 'max_tokens', 'temperature']),
    );
    expect(JSON.stringify(body)).not.toMatch(TOOL_KEYS);
    const user = (body.messages as Array<{ role: string; content: unknown }>)[1]!;
    expect((user.content as Array<{ type: string }>).map((p) => p.type)).toEqual(['image_url', 'text']);
    expect(fake.images).toEqual([{ mime: 'image/jpeg', sha256: img.sha256, bytes: img.jpeg.length }]);
    expect(fake.violations).toEqual([]); // includes vision_with_tools
    // I4': the caption only inside the nonce block of the user turn, never in the system prompt
    expect(JSON.stringify((body.messages as Array<{ role: string }>)[0])).not.toContain(SENTINEL);
  });

  it('claude API: the native base64 image block FIRST, output_config.format only - no tools', async () => {
    const { provider, requests } = claudeProvider();
    expectOk(await stage(provider, null)(v1Input(), new AbortController().signal));
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(Object.keys(req).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(JSON.stringify(req)).not.toMatch(TOOL_KEYS);
    const msgs = req.messages as Array<{ content: Array<{ type: string }> }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content.map((c) => c.type)).toEqual(['image', 'text']);
    expect(JSON.stringify(req.system)).not.toContain(SENTINEL);
  });

  it('gemini API: the inline picture FIRST, response_format only - no tools, no function declarations', async () => {
    const { provider, requests } = geminiProvider();
    expectOk(await stage(provider, null)(v1Input(), new AbortController().signal));
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(JSON.stringify(req)).not.toMatch(TOOL_KEYS);
    for (const k of Object.keys(req))
      expect(['model', 'input', 'system_instruction', 'response_format', 'generation_config', 'store']).toContain(k);
    const input = req.input as Array<{ content: Array<{ type: string }> }>;
    expect(input[0]!.content.map((c) => c.type)).toEqual(['image', 'text']);
    expect(String(req.system_instruction)).not.toContain(SENTINEL);
  });

  it('claude_cli (spawned fake): --tools "" --strict-mcp-config --max-turns 1 --json-schema IMAGE_READ_SCHEMA, never --mcp-config', async () => {
    const w = createClaudeFakeWorld({
      script: [{ when: { stage: 'read_image' }, respond: { structured: READ as unknown as Record<string, unknown> } }],
    });
    worlds.push(w);
    const out = await stage(w.provider(), null)(v1Input(), new AbortController().signal);
    expectOk(out);
    const run = w.journal().find((e) => e.stage === 'read_image')!;
    expect(run).toBeDefined();
    expect(run.violations).toEqual([]); // includes stdin_shape:image_not_first / missing_image
    const argv = run.argv;
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('1');
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1]!)).toEqual(IMAGE_READ_SCHEMA);
    for (const banned of ['--mcp-config', '--allowedTools', '--dangerously-skip-permissions', '--add-dir'])
      expect(argv).not.toContain(banned);
    // the caption and the picture travel on stdin only - never in an argv element (B26)
    expect(argv.join('\n')).not.toContain(SENTINEL);
    expect(run.stdinLines).toBe(1);
    expect(run.stdinNonceWrapped).toBe(true);
  });

  it('antigravity_cli never receives a picture: V1 routes to Local', async () => {
    const agy = forbidden('antigravity_cli', false);
    const { provider: local, fake } = await localProvider();
    expectOk(await stage(agy.p, local)(v1Input(), new AbortController().signal));
    expect(agy.structured).not.toHaveBeenCalled();
    expect(fake.images).toHaveLength(1);
    expect(readerOf('local', 'antigravity_cli')).toBe('local');
  });

  it('V1 never calls chat() or runAgentic() on any provider (structured only)', async () => {
    for (const id of ['claude', 'gemini', 'claude_cli'] as const) {
      const f = forbidden(id, true);
      f.structured.mockImplementation(() => Promise.resolve(READ as never));
      expectOk(await stage(f.p, null)(v1Input(), new AbortController().signal));
      expect(f.structured).toHaveBeenCalledTimes(1);
      expect(f.chat).not.toHaveBeenCalled();
      expect(f.runAgentic).not.toHaveBeenCalled();
    }
  });

  it('the providers themselves refuse a picture on chat() (the tool-bearing path), before any request', async () => {
    const c = claudeProvider();
    const g = geminiProvider();
    const { provider: l, fake } = await localProvider();
    const msgs = [
      { role: 'system' as const, content: 's' },
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, mime: 'image/jpeg' as const, base64: 'AA==' },
          { type: 'text' as const, text: 't' },
        ],
      },
    ];
    const opts = { signal: new AbortController().signal, maxOutputTokens: 64, purpose: 'read_image' as const };
    const tool = {
      name: 'get_freebusy',
      description: 'x',
      inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
    };
    for (const p of [c.provider, g.provider, l])
      await expect(p.chat(msgs, [tool], opts)).rejects.toMatchObject({ code: 'unsupported' });
    expect(c.requests).toEqual([]);
    expect(g.requests).toEqual([]);
    expect(fake.requests.filter((r) => r.path === '/v1/chat/completions')).toEqual([]);
  });
});

// =================================================================================================================================
describe('readImage.ts is the ONLY builder of an LlmImagePart (source grep over src/)', () => {
  it('no other source file builds a {type:"image", mime:...} part', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__fixtures__' && e.name !== 'node_modules') walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts'))
          files.push(p);
      }
    };
    walk(path.join(ROOT, 'src'));
    const builders = files
      .filter((f) => /type:\s*['"]image['"]\s*,\s*mime\s*:/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(builders).toEqual(['src/main/agent/readImage.ts']);
    // and only the stage module and the type itself name the type in code (comments aside)
    const named = files
      .filter((f) => /^(?!\s*(\/\/|\*|\/\*)).*\bLlmImagePart\b/m.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .sort();
    expect(named).toEqual(['src/main/agent/readImage.ts', 'src/main/llm/types.ts']);
  });
});

// =================================================================================================================================
describe('I12: hostile bytes never reach nativeImage (S-IMAGE facade spy)', () => {
  function facadeSpy(): { facade: ImageFacade; calls: number[] } {
    const calls: number[] = [];
    const handle = (w: number, h: number): ImageHandle => ({
      isEmpty: () => false,
      getSize: () => ({ width: w, height: h }),
      resize: (o) =>
        handle(o.width ?? Math.round((w * (o.height ?? h)) / h), o.height ?? Math.round((h * (o.width ?? w)) / w)),
      toJPEG: () => jpeg(Math.min(w, 64), Math.min(h, 64)),
    });
    return {
      calls,
      facade: {
        fromBuffer: (bytes) => {
          calls.push(bytes.length);
          const d = readImageDims(bytes)!;
          return handle(d.width, d.height);
        },
      },
    };
  }
  const window: Message[] = [
    {
      rowid: 1,
      waMsgId: '3EB0BOMB0001',
      chatJid: '972550000059@s.whatsapp.net',
      senderUser: '972550000059',
      text: '',
      ts: NOW,
      fromMe: false,
      mediaType: 'image',
      deleted: false,
    },
  ];
  function picker(bytes: Uint8Array, facade: ImageFacade, audits: unknown[]) {
    return createPickImage({
      images: () => ({ enabled: true }),
      chatJidOf: () => '972550000059@s.whatsapp.net',
      media: { fetch: async () => ({ ok: true, bytes, sniffed: 'jpeg' }) },
      normalize: createImageNormalizer({
        image: facade,
        hash: (b) => createHash('sha256').update(b).digest('hex') as Sha256Hex,
      }),
      cache: { put: () => ({}) as never },
      alreadyRead: () => false,
      audit: (kind, detail) => void audits.push([kind, detail]),
    });
  }

  it.each([
    ['jpegBomb (26.4 MP header)', jpegBomb()],
    ['pngBomb (100 MP header)', pngBomb()],
    ['gif', gif()],
    ['webp', webp()],
    ['10 MiB + 1', tooBig()],
    ['polyglot (JPEG + trailing ZIP)', polyglot()],
    ['truncated JPEG', truncatedJpeg()],
  ])('%s => rejected, audited, the facade never called', async (_name, bytes) => {
    const spy = facadeSpy();
    const audits: unknown[] = [];
    expect(await picker(bytes, spy.facade, audits)(3 as ChatRef, window)).toBeNull();
    expect(spy.calls).toEqual([]);
    expect(audits).toHaveLength(1);
    expect((audits[0] as [string])[0]).toBe('media_rejected');
  });

  it('every golden picture passes the header gate and reaches the facade exactly once', async () => {
    for (const spec of GOLDEN_IMAGES) {
      const spy = facadeSpy();
      const audits: unknown[] = [];
      const out = await picker(
        new Uint8Array(fs.readFileSync(absPathOf(spec))),
        spy.facade,
        audits,
      )(3 as ChatRef, window);
      expect(out).not.toBeNull();
      expect(spy.calls).toHaveLength(1);
      expect(audits).toEqual([]);
    }
    expect(png(2, 2).length).toBeGreaterThan(0);
  });
});

// =================================================================================================================================
describe('the 4 injection pictures => suspicious => manipulation (scripted V1)', () => {
  const injections = GOLDEN_IMAGES.filter((s) => s.group === 'injection');

  it('there are exactly four, each with visible instruction text', () => {
    expect(injections.map((s) => s.id)).toEqual(['img-inj-01', 'img-inj-02', 'img-inj-03', 'img-inj-04']);
  });

  it.each(injections.map((s) => [s.id, s] as const))(
    '%s: the read is suspicious and the proposal badge is red manipulation',
    async (_id, spec) => {
      const bytes = new Uint8Array(fs.readFileSync(absPathOf(spec)));
      const img = picture(bytes);
      const read = imageReadOf(spec) as ImageRead;
      const stub = new StubLlm({
        id: 'claude_cli',
        capabilities: { images: true },
        rules: [
          {
            when: { purpose: 'read_image', imageSha256: img.sha256 },
            respond: { structured: read as unknown as Record<string, unknown> },
          },
        ],
      });
      const out = await stage(stub, null)(v1Input(img), new AbortController().signal);
      expect(out).toMatchObject({ ok: true, read: { suspicious: true } });
      const badges = imageBadgesOf(out, 'claude_cli', () => false);
      expect(badges).toContain('manipulation');
      expect(badges).toContain('image_unclear'); // F29: below the gate, still amber
      // the instruction text went to the model only inside the user turn's picture; nothing else carried it
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.tools).toEqual([]);
      expect(stub.unmatched).toBe(0);
    },
  );
});
