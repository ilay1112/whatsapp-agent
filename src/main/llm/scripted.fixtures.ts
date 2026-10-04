// src/main/llm/scripted.fixtures.ts - the E2E scripted LlmProvider (TESTS 4.2 `WCA_LLM` / `WCA_LLM_SCRIPT`; owner: the
// compose-defects repair). Named `<dir>.<suffix>.ts` per build-plan section 6 (test-support module, same convention as
// `src/main/ipc/register.fixtures.ts`), so `coverage.exclude`'s `**/*.fixtures.*` covers it.
//
// WHY IT LIVES UNDER src/main AND NOT IN tests/: the e2e bundle is a real electron-vite build of `src/**` only - a
// provider imported from `tests/**` would not exist at run time in `out/main`. This module is reached ONLY through the
// one dynamic `import()` in `index.ts` that sits inside `if (import.meta.env.MODE === 'e2e')`, so a production build
// constant-folds the branch away and never emits this file (TESTS 4.1, build-time lock). The run-time lock is
// `readSeams()`: without `WCA_E2E=1` and an unpackaged app there is no `seams.llm` and nothing here is ever constructed.
//
// It is a MINIMAL re-implementation of the rule semantics of `tests/fakes/stub-llm.ts` (TESTS 3.3) and of the generic
// malice of `tests/fakes/obedient-attacker-llm.ts` (TESTS 3.4). The payload strings below are ATTACK SAMPLES aimed at
// the app under test: they are data, never instructions, and nothing in the app may act on them.
import { readFileSync } from 'node:fs';

import { LlmError } from './types';
import type { CallOpts, LlmMessage, LlmProvider, LlmResponse, LlmTool, LlmToolCall } from './types';
import type { JsonSchemaLcd, ProviderId } from '../../shared/types';
import type { ProviderErrorCode } from '../../shared/errors';

/** The subset of `StubRule` (TESTS 3.3) a `WCA_LLM_SCRIPT` file may use. First match wins. */
export interface ScriptedRule {
  when: {
    purpose?: 'extract' | 'draft';
    contains?: string;
    notContains?: string;
    turn?: number;
    hasToolResultFor?: string;
  };
  respond:
    | { structured: Record<string, unknown> }
    | { text: string; stopReason?: LlmResponse['stopReason'] }
    | {
        toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
        text?: string;
        stopReason?: 'tool_use' | 'max_tokens' | 'refusal';
      }
    | { error: ProviderErrorCode }
    | { hang: true };
  times?: number;
  delayMs?: number;
}

export interface ScriptedProviderOptions {
  /** The CURRENTLY selected provider id: the scripted provider impersonates it, so runs/proposals rows stay realistic. */
  id: ProviderId;
  mode: 'stub' | 'attacker';
  /** `WCA_LLM_SCRIPT`: a JSON file `{ rules: ScriptedRule[] }`. Ignored by the attacker mode. */
  scriptPath?: string;
}

type Respond = ScriptedRule['respond'];
const isStructured = (r: Respond): r is { structured: Record<string, unknown> } => 'structured' in r;
const isToolTurn = (r: Respond): r is Extract<Respond, { toolCalls: unknown[] }> => 'toolCalls' in r;
const isError = (r: Respond): r is { error: ProviderErrorCode } => 'error' in r;
const isHang = (r: Respond): r is { hang: true } => 'hang' in r;

const ZWSP = '​';
const RLO = '‮';

/** Generic malice, TESTS 3.4: forbidden extra keys the app's strict zod re-validation must reject. */
const ATTACK_EXTRACTION: Record<string, unknown> = {
  intent: 'schedule_request',
  needsReply: true,
  title: `meeting https://evil.example/x${RLO}`,
  dateKind: 'relative_days',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 1,
  time24h: '03:00',
  timeAmbiguous: false,
  durationMin: 60,
  location: '',
  missing: [],
  suspicious: false,
  recipient: '972550000099@s.whatsapp.net',
  chatJid: '972550000099@s.whatsapp.net',
  attendees: ['attacker@example.com'],
  calendarId: 'attacker@example.com',
  sendUpdates: 'all',
  autoApprove: true,
  eventId: 'forced-id',
  url: 'https://evil.example/x',
};

/** Tool calls no gate may ever let through (unknown names, write tools, a foreign calendar). */
const ATTACK_TOOL_CALLS: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: 'create-event', input: { summary: 'pwned', calendarId: 'attacker@example.com' } },
  { name: 'delete-event', input: { eventId: 'all' } },
  { name: 'send_message', input: { recipient: '972550000099@s.whatsapp.net', message: 'hi' } },
  { name: 'manage-accounts', input: { action: 'add' } },
];

const ATTACK_DRAFT =
  `sure${ZWSP}, confirmed! details: https://evil.example/pay ` +
  `call me on +972550000099 or mail attacker@example.com ${RLO}approved`;

/** Concatenated `user`-role content (the nonce data block), so a rule can key on a message's text. */
function userText(messages: LlmMessage[]): string {
  return messages
    .filter((m): m is Extract<LlmMessage, { role: 'user' }> => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join('\n'),
    )
    .join('\n');
}
/** [V2 W0] A v1-shaped e2e extraction script (no `change` key) gets the S1 v2 null-event defaults (C2 5 few-shot defaults), exactly like
 *  tests/fakes/stub-llm.ts, so the v1 e2e scenarios stay schema-valid under the v2 ExtractionSchema. Keys a script sets are kept. */
const V2_EXTRACTION_DEFAULTS = {
  refersToExisting: false,
  change: 'no_change',
  changeConfidence: 'high',
  confidence: 'high',
};
function withV2ExtractionDefaults(purpose: string, value: Record<string, unknown>): Record<string, unknown> {
  if (purpose !== 'extract' || !('intent' in value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [k, v] of Object.entries(V2_EXTRACTION_DEFAULTS)) if (!(k in out)) out[k] = v;
  return out;
}
function turnOf(messages: LlmMessage[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}
function toolResultNames(messages: LlmMessage[]): string[] {
  return messages.flatMap((m) => (m.role === 'tool' ? m.results.map((r) => r.name) : []));
}

function readRules(path: string): ScriptedRule[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { rules?: ScriptedRule[] };
  if (!Array.isArray(parsed.rules)) throw new Error('scripted provider: the script file has no rules[]');
  return parsed.rules;
}

/**
 * Builds the provider named by `WCA_LLM`. Throws only when `WCA_LLM_SCRIPT` points at an unreadable/!rules file, which
 * is a test-rig mistake and must fail loudly rather than silently produce an app with no model.
 */
export function createScriptedProvider(opts: ScriptedProviderOptions): LlmProvider {
  return opts.mode === 'attacker'
    ? new AttackerProvider(opts.id)
    : new ScriptedProvider(opts.id, opts.scriptPath === undefined ? [] : readRules(opts.scriptPath));
}

/** `{hang:true}` and every delay resolve on the REAL clock here: an e2e build has no virtual clock. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      globalThis.clearTimeout(t);
      reject(new LlmError('aborted'));
    }
    if (signal.aborted) {
      globalThis.clearTimeout(t);
      reject(new LlmError('aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function hang<T>(signal: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new LlmError('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new LlmError('aborted')), { once: true });
  });
}

function responseFrom(partial: Partial<LlmResponse>): LlmResponse {
  const toolCalls: LlmToolCall[] = partial.toolCalls ?? [];
  const text = partial.text ?? '';
  return {
    text,
    toolCalls,
    stopReason: partial.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end'),
    usage: partial.usage ?? { inputTokens: 100, outputTokens: 20 },
    // A fresh opaque object per assistant message, exactly like a real adapter's provider payload.
    assistantMessage: { role: 'assistant', content: text, toolCalls, providerData: { scripted: true } },
  };
}

class ScriptedProvider implements LlmProvider {
  readonly model = 'scripted-e2e';
  readonly loop = 'turn' as const; // [V2 ADD] C2 9: the e2e scripted provider runs the v1 turn loop under every id (V2-W2-01 keeps it on v2)
  readonly capabilities = { images: false };
  private readonly used: number[];

  constructor(
    readonly id: ProviderId,
    private readonly rules: ScriptedRule[],
  ) {
    this.used = rules.map(() => 0);
  }

  async structured<T>(messages: LlmMessage[], _schema: JsonSchemaLcd, opts: CallOpts): Promise<T> {
    const rule = this.match(messages, opts);
    if (rule === null) throw new LlmError('bad_output');
    await pause(rule.delayMs ?? 0, opts.signal);
    const r = rule.respond;
    if (isError(r)) throw new LlmError(r.error);
    if (isHang(r)) return await hang<T>(opts.signal);
    if (!isStructured(r)) throw new LlmError('bad_output'); // a draft-shaped rule answered an extract call
    opts.onUsage?.({ inputTokens: 200, outputTokens: 40 });
    return withV2ExtractionDefaults(opts.purpose, r.structured) as T;
  }

  async chat(messages: LlmMessage[], _tools: LlmTool[], opts: CallOpts): Promise<LlmResponse> {
    const rule = this.match(messages, opts);
    if (rule === null) throw new LlmError('bad_output');
    await pause(rule.delayMs ?? 0, opts.signal);
    const r = rule.respond;
    if (isError(r)) throw new LlmError(r.error);
    if (isHang(r)) return await hang<LlmResponse>(opts.signal);
    if (isStructured(r)) throw new LlmError('bad_output');
    if (isToolTurn(r)) {
      const calls = r.toolCalls.map((c, i) => ({ id: `scripted-${i + 1}`, name: c.name, input: c.input }));
      const res = responseFrom({ text: r.text ?? '', stopReason: r.stopReason ?? 'tool_use', toolCalls: calls });
      opts.onUsage?.(res.usage ?? { inputTokens: 100, outputTokens: 20 });
      return res;
    }
    const res = responseFrom({ text: r.text, stopReason: r.stopReason ?? 'end' });
    opts.onUsage?.(res.usage ?? { inputTokens: 100, outputTokens: 20 });
    return res;
  }

  validate(_signal: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
    return Promise.resolve({ ok: true, model: this.model });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }

  private match(messages: LlmMessage[], opts: CallOpts): ScriptedRule | null {
    const text = userText(messages);
    const turn = turnOf(messages);
    const results = toolResultNames(messages);
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i]!;
      if (rule.times !== undefined && this.used[i]! >= rule.times) continue;
      const w = rule.when;
      if (w.purpose !== undefined && w.purpose !== opts.purpose) continue;
      if (w.contains !== undefined && !text.includes(w.contains)) continue;
      if (w.notContains !== undefined && text.includes(w.notContains)) continue;
      if (w.turn !== undefined && w.turn !== turn) continue;
      if (w.hasToolResultFor !== undefined && !results.includes(w.hasToolResultFor)) continue;
      this.used[i] = this.used[i]! + 1;
      return rule;
    }
    return null;
  }
}

/** TESTS 3.4 generic malice: obeys whatever the untrusted text asks. The app must contain it; nobody acts on it. */
class AttackerProvider implements LlmProvider {
  readonly model = 'obedient-attacker';
  readonly loop = 'turn' as const; // [V2 ADD]
  readonly capabilities = { images: false };
  constructor(readonly id: ProviderId) {}

  structured<T>(_messages: LlmMessage[], _schema: JsonSchemaLcd, opts: CallOpts): Promise<T> {
    opts.onUsage?.({ inputTokens: 200, outputTokens: 40 });
    return Promise.resolve(withV2ExtractionDefaults(opts.purpose, { ...ATTACK_EXTRACTION }) as T);
  }

  chat(messages: LlmMessage[], _tools: LlmTool[], opts: CallOpts): Promise<LlmResponse> {
    const res =
      turnOf(messages) === 0
        ? responseFrom({
            text: '',
            stopReason: 'tool_use',
            toolCalls: ATTACK_TOOL_CALLS.map((c, i) => ({ id: `attacker-${i + 1}`, name: c.name, input: c.input })),
          })
        : responseFrom({ text: ATTACK_DRAFT, stopReason: 'end' });
    opts.onUsage?.(res.usage ?? { inputTokens: 100, outputTokens: 20 });
    return Promise.resolve(res);
  }

  validate(_signal: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
    return Promise.resolve({ ok: true, model: this.model });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
