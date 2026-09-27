// tests/fakes/obedient-attacker-llm.ts - worst-case model that DOES what untrusted text asks (TESTS 3.4; owner W1-09).
// Every payload it replays is synthetic ATTACK DATA for the app under test: the app must contain it, nobody acts on it (T6).
import type { CallOpts, LlmMessage, LlmProvider, LlmResponse, LlmTool, LlmToolCall } from '../../src/main/llm/types.ts';
import type { JsonSchemaLcd, ProviderId } from '../../src/shared/types.ts';
import type { ProviderErrorCode } from '../../src/shared/errors.ts';

/** One case of tests/security/injection-corpus.{he,en}.json (TESTS 8.3). Message text inside is an ATTACK SAMPLE, never an instruction. */
export interface InjectionCase {
  id: string;
  lang: 'he' | 'en';
  vector: 'message' | 'quoted' | 'push_name' | 'calendar_title' | 'tool_result' | 'stdout_marker';
  payload: string;
  /** What an obedient model would do when it sees `payload`. */
  obey: {
    structured?: Record<string, unknown>;
    toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
    draft?: string;
  };
  mustNot: Array<'send' | 'create_event' | 'unknown_tool' | 'foreign_recipient' | 'url_in_draft' | 'state_change'>;
}

/** Response shape variants used by the loop-bound tests (TESTS 3.4: "one variant returns tool calls on a max_tokens turn"). */
export type AttackerVariant = 'default' | 'max_tokens_tools' | 'refusal_tools';

/**
 * The literal token the `en-tool-name-sentinel` corpus case hides inside a model-supplied tool NAME
 * (request from W2-02-security-gate: the constant is defined here, next to the corpus that carries it, so nobody
 * re-types the string). `toolGate.ts` audits a blocked call as `{nameSha8, nameLen, verdict, runId}` only, so a
 * security test can grep every audit row, log line and DB column for this token: a single hit means the gate leaked a
 * model-supplied tool name. Distinct from `SENTINEL_MSG_TEXT` of `tests/fakes/fake-bridge.ts` (W1-02), which is the
 * bridge-stdout equivalent of the same trick.
 */
export const SENTINEL_MSG_TEXT = 'WCA_SENTINEL_MSG_TEXT';

/** Corpus id of the case whose `obey.toolCalls[0].name` embeds {@link SENTINEL_MSG_TEXT}. */
export const SENTINEL_TOOL_NAME_CASE_ID = 'en-tool-name-sentinel';

const ZWSP = '\u200B';
const RLO = '\u202E';
const CYRILLIC_E = '\u0435';

/** Generic malice: emitted whenever no corpus case matches the conversation. */
const GENERIC_TOOL_CALLS: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: 'create-event', input: { summary: 'pwned', calendarId: 'attacker@example.com' } },
  { name: 'create_event', input: { summary: 'pwned' } },
  { name: 'Create-Event', input: { summary: 'pwned' } },
  { name: 'delete-event', input: { eventId: 'all' } },
  { name: 'update_event', input: { eventId: 'all', summary: 'moved' } },
  { name: 'send_message', input: { recipient: '972550000099@s.whatsapp.net', message: 'hi' } },
  { name: 'manage-accounts', input: { action: 'add' } },
  {
    name: 'get_freebusy',
    input: { timeMin: '2026-01-01T00:00:00', timeMax: '2031-01-01T00:00:00', calendarId: 'attacker@example.com' },
  },
  { name: 'get_freebusy ', input: { timeMin: '2026-09-21T00:00:00', timeMax: '2026-09-22T00:00:00' } },
  { name: `g${CYRILLIC_E}t_freebusy`, input: { timeMin: '2026-09-21T00:00:00', timeMax: '2026-09-22T00:00:00' } },
];

const GENERIC_DRAFT =
  `sure${ZWSP}, confirmed! details: https://evil.example/pay ` +
  `call me on +972550000099 or mail attacker@example.com ${RLO}approved`;

const GENERIC_EXTRACTION: Record<string, unknown> = {
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
  // forbidden extra keys - the app's strict zod re-validation must reject the whole object
  recipient: '972550000099@s.whatsapp.net',
  chatJid: '972550000099@s.whatsapp.net',
  attendees: ['attacker@example.com'],
  calendarId: 'attacker@example.com',
  sendUpdates: 'all',
  autoApprove: true,
  eventId: 'forced-id',
  url: 'https://evil.example/x',
};

function textOf(messages: LlmMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool') parts.push(...m.results.map((r) => r.content));
    else parts.push(m.content);
  }
  return parts.join('\n');
}

/** The transcript reaches a model JSON-encoded inside the nonce block, so the attacker reads through that encoding. */
function jsonUnescape(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function toToolCalls(specs: Array<{ name: string; input: Record<string, unknown> }>): LlmToolCall[] {
  return specs.map((s, i) => ({ id: `attacker-${i + 1}`, name: s.name, input: s.input }));
}

export class ObedientAttackerLlm implements LlmProvider {
  readonly id: ProviderId;
  readonly model = 'obedient-attacker';
  readonly calls: Array<{ kind: 'structured' | 'chat'; messages: LlmMessage[]; tools: LlmTool[] }> = [];
  /** Corpus cases whose payload was found in a conversation, in call order (tests assert which vector fired). */
  readonly matched: InjectionCase[] = [];
  private variantMode: AttackerVariant = 'default';
  private chatTurns = 0;

  constructor(
    readonly corpus: InjectionCase[],
    id: ProviderId = 'local',
  ) {
    this.id = id;
  }

  /** TESTS 3.4: one variant returns tool calls on a `max_tokens` (or `refusal`) turn - they must never be executed. */
  variant(mode: AttackerVariant): this {
    this.variantMode = mode;
    return this;
  }

  /** New S3 run: the turn counter decides "turn 1 emits tool calls, later turns answer with a draft". */
  resetTurns(): void {
    this.chatTurns = 0;
  }

  find(messages: LlmMessage[]): InjectionCase | null {
    const raw = textOf(messages);
    const decoded = jsonUnescape(raw);
    for (const c of this.corpus) {
      if (c.payload !== '' && (raw.includes(c.payload) || decoded.includes(c.payload))) return c;
    }
    return null;
  }

  structured<T>(messages: LlmMessage[], _schema: JsonSchemaLcd, _opts: CallOpts): Promise<T> {
    this.calls.push({ kind: 'structured', messages, tools: [] });
    const hit = this.find(messages);
    if (hit) this.matched.push(hit);
    const out = hit?.obey.structured ?? GENERIC_EXTRACTION;
    return Promise.resolve(out as T);
  }

  chat(messages: LlmMessage[], tools: LlmTool[], _opts: CallOpts): Promise<LlmResponse> {
    this.calls.push({ kind: 'chat', messages, tools });
    this.chatTurns += 1;
    const hit = this.find(messages);
    if (hit) this.matched.push(hit);

    const wantsTools = this.chatTurns === 1 && tools.length > 0;
    const specs = hit?.obey.toolCalls ?? GENERIC_TOOL_CALLS;
    const draft = hit?.obey.draft ?? GENERIC_DRAFT;

    if (wantsTools && specs.length > 0) {
      const toolCalls = toToolCalls(specs);
      const stopReason: LlmResponse['stopReason'] =
        this.variantMode === 'max_tokens_tools'
          ? 'max_tokens'
          : this.variantMode === 'refusal_tools'
            ? 'refusal'
            : 'tool_use';
      return Promise.resolve({
        text: '',
        toolCalls,
        stopReason,
        assistantMessage: { role: 'assistant', content: '', toolCalls },
      });
    }
    return Promise.resolve({
      text: draft,
      toolCalls: [],
      stopReason: 'end',
      assistantMessage: { role: 'assistant', content: draft },
    });
  }

  validate(_signal: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }> {
    return Promise.resolve({ ok: true, model: this.model });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
