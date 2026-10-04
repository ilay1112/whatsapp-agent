// tests/fakes/stub-llm.ts - rule-based scripted LlmProvider (TESTS 3.3 + CONTRACTS 16; owner W1-10).
// Not spawnable, so it may import src/** types (type-only) and the virtual clock.
// [V2] v2 deltas (V2-W0-scaffold; owner V2-W1-03 from Wave 1 on): `loop` + `capabilities.images` (C2 9, StubLlmV2Additions of C2 17),
// `when.purpose 'read_image'`, `when.imageSha256`, image-part recording, and the null-event defaults for v1-shaped extraction fixtures.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { LlmError } from '../../src/main/llm/types.ts';
import type {
  CallOpts,
  LlmImagePart,
  LlmMessage,
  LlmProvider,
  LlmResponse,
  LlmTool,
  LlmToolCall,
} from '../../src/main/llm/types.ts';
import type { JsonSchemaLcd, ProviderId, ProviderLoop } from '../../src/shared/types.ts';
import type { ProviderErrorCode } from '../../src/shared/errors.ts';
import type { Clock } from '../../src/main/deps.ts';
import type { GoldenCase } from '../helpers/goldenLoader.ts';

export type StubRule = {
  when: {
    purpose?: 'extract' | 'draft' | 'read_image'; // [V2] + read_image (V1)
    /** [V2] sha256 hex of the decoded bytes of the (first) image part of the user turn (V1 READ-IMAGE). */
    imageSha256?: string;
    /** [V2] T2 3.1 step 5: the stage the spawned CLI fakes match on (derived from argv there). StubLlm matches it against
     *  `purpose`; `smoke` never matches here (only the CLI provider-start smoke run has that stage). */
    stage?: 'extract' | 'draft' | 'read_image' | 'smoke';
    contains?: string;
    notContains?: string;
    turn?: number;
    hasToolResultFor?: string;
  };
  respond:
    | { structured: Record<string, unknown> } // S1 (returned as-is: MAY be schema-invalid on purpose)
    | { text: string; stopReason?: LlmResponse['stopReason'] } // S3 terminal draft
    | {
        toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
        text?: string;
        stopReason?: 'tool_use' | 'max_tokens' | 'refusal';
      }
    | { error: ProviderErrorCode }
    | { hang: true }; // resolves only on abort -> tests Pause / timeouts
  times?: number; // default: unlimited
  delayMs?: number; // virtual (injected clock)
};
export interface StubLlmOptions {
  id?: ProviderId;
  model?: string;
  rules: StubRule[];
  clock?: Clock;
  /** [V2] C2 9 `loop` (default 'turn') and `capabilities.images` (default false). */
  loop?: ProviderLoop;
  capabilities?: { images: boolean };
}
export interface StubCall {
  kind: 'structured' | 'chat';
  purpose: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  schema?: unknown;
  opts: CallOpts;
  /** [V2] image parts seen in the user turn(s) of this call (mime + sha256 of the decoded bytes; the bytes are never kept). */
  images: Array<{ mime: LlmImagePart['mime']; sha256: string; bytes: number }>;
}

/** [V2] The four B20 fields S1 v2 always returns. A v1-shaped extraction fixture (no `change` key) gets the null-event defaults the
 *  S1 v2 few-shots use (C2 5: refersToExisting:false, change:'no_change', changeConfidence:'high'; confidence 'high') so v1 scenarios
 *  stay schema-valid under the v2 ExtractionSchema. A fixture that sets any of the four keeps its own values (and may stay invalid). */
export const V1_EXTRACTION_DEFAULTS = {
  refersToExisting: false,
  change: 'no_change',
  changeConfidence: 'high',
  confidence: 'high',
} as const;
function withV2ExtractionDefaults(purpose: string, value: unknown): unknown {
  if (purpose !== 'extract' || typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const o = value as Record<string, unknown>;
  if (!('intent' in o)) return value;
  const out: Record<string, unknown> = { ...o };
  for (const [k, v] of Object.entries(V1_EXTRACTION_DEFAULTS)) if (!(k in out)) out[k] = v;
  return out;
}
/** [V2] image parts of the user turns (V1 passes [image, text]). */
function imagePartsOf(messages: LlmMessage[]): LlmImagePart[] {
  const out: LlmImagePart[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const part of m.content) if (part.type === 'image') out.push(part);
  }
  return out;
}
function sha256OfBase64(b64: string): { sha256: string; bytes: number } {
  const buf = Buffer.from(b64, 'base64');
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength };
}

type Respond = StubRule['respond'];
const isStructured = (r: Respond): r is { structured: Record<string, unknown> } => 'structured' in r;
const isToolTurn = (r: Respond): r is Extract<Respond, { toolCalls: unknown[] }> => 'toolCalls' in r;
const isError = (r: Respond): r is { error: ProviderErrorCode } => 'error' in r;
const isHang = (r: Respond): r is { hang: true } => 'hang' in r;

/** Concatenated `user`-role content: the nonce data block, so a rule can key on a message's text. */
function userText(messages: LlmMessage[]): string {
  return messages
    .filter((m): m is Extract<LlmMessage, { role: 'user' }> => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n'),
    )
    .join('\n');
}
/** Turn index of THIS call: 0 for the first model turn of the stage, +1 per assistant message already in the history. */
function turnOf(messages: LlmMessage[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}
function toolResultNames(messages: LlmMessage[]): string[] {
  return messages.flatMap((m) => (m.role === 'tool' ? m.results.map((r) => r.name) : []));
}

export class StubLlm implements LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** [V2] C2 9 / C2 17 StubLlmV2Additions. Mutable through setLoop / setCapabilities (tests only). */
  loop: ProviderLoop;
  capabilities: { images: boolean };
  readonly calls: StubCall[] = [];
  /** CONTRACTS 16 view of `calls` (kind + messages + tool names). */
  readonly seen: Array<{ kind: 'structured' | 'chat'; messages: LlmMessage[]; toolNames: string[] }> = [];
  unmatched = 0; // > 0 fails the test via the ledger hook
  protected rules: StubRule[];
  protected readonly clock: Clock | undefined;
  /** How often each rule has fired (index-aligned with `rules`), so `times` is honoured without mutating the input. */
  private readonly used: number[] = [];
  /** Sequence-style scripting (`script()`); consumed before the rules. */
  private readonly queuedStructured: unknown[] = [];
  private readonly queuedChat: Array<Partial<LlmResponse>> = [];
  /** Every `providerData` object this stub ever issued - the history must replay them BY IDENTITY. */
  private readonly issued = new Set<object>();
  private toolCallSeq = 0;

  constructor(opts: StubLlmOptions) {
    this.id = opts.id ?? 'local';
    this.model = opts.model ?? 'stub-model';
    this.rules = [...opts.rules];
    this.used = this.rules.map(() => 0);
    this.clock = opts.clock;
    this.loop = opts.loop ?? 'turn';
    this.capabilities = { images: opts.capabilities?.images ?? false };
  }

  /** [V2] C2 17 StubLlmV2Additions. */
  setLoop(loop: ProviderLoop): void {
    this.loop = loop;
  }
  setCapabilities(c: { images: boolean }): void {
    this.capabilities = { images: c.images };
  }

  /** CONTRACTS 16: sequence-style scripting on top of the rules (structured answers / chat responses consumed in order). */
  script(s: { structured?: unknown[]; chat?: Array<Partial<LlmResponse>> }): void {
    if (s.structured) this.queuedStructured.push(...s.structured);
    if (s.chat) this.queuedChat.push(...s.chat);
  }

  async structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T> {
    this.record('structured', messages, [], opts, schema);
    if (this.queuedStructured.length > 0) {
      await this.pause(0, opts.signal);
      return withV2ExtractionDefaults(opts.purpose, this.queuedStructured.shift()) as T;
    }
    const hit = this.match(messages, opts);
    if (hit === null) {
      this.unmatched += 1;
      throw new LlmError('bad_output');
    }
    await this.pause(hit.rule.delayMs ?? 0, opts.signal);
    const r = hit.rule.respond;
    if (isError(r)) throw new LlmError(r.error);
    if (isHang(r)) return await this.hang<T>(opts.signal);
    if (isStructured(r)) {
      opts.onUsage?.({ inputTokens: 200, outputTokens: 40 });
      return withV2ExtractionDefaults(opts.purpose, r.structured) as T;
    }
    // A draft-shaped rule answered a structured call: that is a scripting mistake, not a model failure.
    this.unmatched += 1;
    throw new LlmError('bad_output');
  }

  async chat(messages: LlmMessage[], tools: LlmTool[], opts: CallOpts): Promise<LlmResponse> {
    this.assertVerbatimReplay(messages);
    this.record('chat', messages, tools, opts);
    if (this.queuedChat.length > 0) {
      await this.pause(0, opts.signal);
      return this.reportUsage(this.responseFrom(this.queuedChat.shift()!), opts);
    }
    const hit = this.match(messages, opts);
    if (hit === null) {
      this.unmatched += 1;
      throw new LlmError('bad_output');
    }
    await this.pause(hit.rule.delayMs ?? 0, opts.signal);
    const r = hit.rule.respond;
    if (isError(r)) throw new LlmError(r.error);
    if (isHang(r)) return await this.hang<LlmResponse>(opts.signal);
    if (isToolTurn(r)) {
      return this.reportUsage(
        this.responseFrom({
          text: r.text ?? '',
          stopReason: r.stopReason ?? 'tool_use',
          toolCalls: r.toolCalls.map((c) => ({ id: `stub-${++this.toolCallSeq}`, name: c.name, input: c.input })),
        }),
        opts,
      );
    }
    if (isStructured(r)) {
      this.unmatched += 1;
      throw new LlmError('bad_output');
    }
    return this.reportUsage(this.responseFrom({ text: r.text, stopReason: r.stopReason ?? 'end' }), opts);
  }

  validate(_signal: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
    return Promise.resolve({ ok: true, model: this.model });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /** [V2-W1-03] T2 7.2: the case's rules, played by a stub that looks like the provider under test (`id` / `loop` / `capabilities`,
   *  default `local` / `turn` / no images). A case that carries a full V1 read (`imageRead`, P2 15.2) and no `read_image` rule gets one,
   *  so the picture stage answers exactly what the row states. */
  static fromGoldenCase(
    c: GoldenCase,
    opts: {
      id?: ProviderId;
      model?: string;
      loop?: ProviderLoop;
      capabilities?: { images: boolean };
      clock?: Clock;
    } = {},
  ): StubLlm {
    const rules = [...c.stub.rules];
    const read = (c as GoldenCase & { imageRead?: Record<string, unknown> }).imageRead;
    if (read !== undefined && !rules.some((r) => r.when.purpose === 'read_image' || r.when.stage === 'read_image'))
      rules.unshift({ when: { purpose: 'read_image' }, respond: { structured: read } });
    return new StubLlm({
      rules,
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.loop !== undefined ? { loop: opts.loop } : {}),
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
      ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    });
  }
  /** [V2-W1-03] The rules this stub plays (read-only view; the parity suite writes them with `toCliScript`). */
  get scriptRules(): readonly StubRule[] {
    return this.rules;
  }
  /** [V2] T2 3.9: writes the rules as the `--fake-script` file of the spawned CLI fakes (3.1/3.2) so one golden case runs
   *  unchanged on local (this stub), claude_cli and antigravity_cli. `when.stage` defaults to `when.purpose`. */
  toCliScript(path: string): void {
    const rules = this.rules.map((r) => ({
      ...r,
      when: {
        ...r.when,
        ...(r.when.stage === undefined && r.when.purpose !== undefined ? { stage: r.when.purpose } : {}),
      },
    }));
    writeFileSync(path, JSON.stringify({ id: this.id, model: this.model, rules }), 'utf8');
  }
  static fromScriptFile(path: string): StubLlm {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: ProviderId; model?: string; rules?: StubRule[] };
    if (!Array.isArray(parsed.rules)) throw new Error(`stub-llm script file has no rules[]: ${path}`);
    return new StubLlm({
      rules: parsed.rules,
      ...(parsed.id ? { id: parsed.id } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------------------------------------------
  private record(
    kind: 'structured' | 'chat',
    messages: LlmMessage[],
    tools: LlmTool[],
    opts: CallOpts,
    schema?: unknown,
  ): void {
    this.calls.push({
      kind,
      purpose: opts.purpose,
      messages: [...messages],
      tools: [...tools],
      opts,
      ...(schema === undefined ? {} : { schema }),
      images: imagePartsOf(messages).map((p) => ({ mime: p.mime, ...sha256OfBase64(p.base64) })),
    });
    this.seen.push({ kind, messages: [...messages], toolNames: tools.map((t) => t.name) });
  }

  private match(messages: LlmMessage[], opts: CallOpts): { rule: StubRule; index: number } | null {
    const text = userText(messages);
    const turn = turnOf(messages);
    const results = toolResultNames(messages);
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i]!;
      if (rule.times !== undefined && this.used[i]! >= rule.times) continue;
      const w = rule.when;
      if (w.purpose !== undefined && w.purpose !== opts.purpose) continue;
      if (w.stage !== undefined && w.stage !== opts.purpose) continue; // [V2]
      if (w.contains !== undefined && !text.includes(w.contains)) continue;
      if (w.notContains !== undefined && text.includes(w.notContains)) continue;
      if (w.turn !== undefined && w.turn !== turn) continue;
      if (w.hasToolResultFor !== undefined && !results.includes(w.hasToolResultFor)) continue;
      if (w.imageSha256 !== undefined) {
        const first = imagePartsOf(messages)[0];
        if (first === undefined || sha256OfBase64(first.base64).sha256 !== w.imageSha256) continue;
      }
      this.used[i] = this.used[i]! + 1;
      return { rule, index: i };
    }
    return null;
  }

  /** Real adapters report token usage through `opts.onUsage`; the stub does the same so `runs` rows are exercised. */
  private reportUsage(res: LlmResponse, opts: CallOpts): LlmResponse {
    if (res.usage) opts.onUsage?.(res.usage);
    return res;
  }

  /** A fresh opaque `providerData` per assistant message; the history must hand exactly this object back. */
  private responseFrom(partial: Partial<LlmResponse>): LlmResponse {
    const providerData = { stub: true };
    this.issued.add(providerData);
    const toolCalls: LlmToolCall[] = partial.toolCalls ?? [];
    const text = partial.text ?? '';
    return {
      text,
      toolCalls,
      stopReason: partial.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end'),
      usage: partial.usage ?? { inputTokens: 100, outputTokens: 20 },
      assistantMessage: { role: 'assistant', content: text, toolCalls, providerData },
    };
  }

  /** TESTS 3.3: proves the verbatim-replay rule without a real provider. Throws a PLAIN Error: it is a caller bug. */
  private assertVerbatimReplay(messages: LlmMessage[]): void {
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      const pd = m.providerData;
      if (typeof pd !== 'object' || pd === null || !this.issued.has(pd)) {
        throw new Error('StubLlm: assistant providerData was not replayed by identity (verbatim-replay rule violated)');
      }
    }
  }

  /** Virtual delay: with an injected clock the test must advance it; without one it resolves on the microtask queue. */
  private pause(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const clock = this.clock;
    if (clock === undefined) return new Promise<void>((resolve) => setTimeout(resolve, ms));
    return new Promise<void>((resolve, reject) => {
      const t = clock.setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clock.clearTimeout(t);
        reject(new LlmError('aborted'));
      };
      if (signal.aborted) {
        clock.clearTimeout(t);
        reject(new LlmError('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** `{hang:true}`: never settles until the call is aborted. */
  private hang<T>(signal: AbortSignal): Promise<T> {
    return new Promise<T>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new LlmError('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new LlmError('aborted')), { once: true });
    });
  }
}
