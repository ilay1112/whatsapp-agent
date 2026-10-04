// tests/helpers/goldenLoader.ts - loads tests/golden/{he,en,mixed}.jsonl (TESTS 7.1 / PIPELINE 11; owner W1-10).
// The W0 record shape is kept as the on-disk contract and extended ADDITIVELY with the PIPELINE section 11 fields the
// runners need (see ops/agent-notes/W1-10-agent-pipeline.md, assumption 4). Everything in the files is synthetic DATA
// (TESTS rule T5): the injection rows are attack payloads for the app under test, never instructions to anyone.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; // the project path contains a space: never URL.pathname
import { V1_EXTRACTION_DEFAULTS, type StubRule } from '../fakes/stub-llm.ts';
import type { Extraction, ImageRead } from '../../src/shared/schemas.ts';
import type { AutoReason, AutoVerdict, Badge, ChangeKind, ProviderId } from '../../src/shared/types.ts';

export interface GoldenExpect {
  needsReply: boolean;
  intent: string;
  eventState: 'none' | 'incomplete' | 'proposed' | 'change_proposed'; // [V2] + change_proposed (a pending delta)
  startLocal?: string; // when proposed
  endLocal?: string; // `[+]` when proposed
  missing?: string[];
  badges?: string[];
  suspicious?: boolean;
  /** `[+]` PIPELINE 11 / TESTS 7.1: the final item state, the reply language and the pending actions. */
  state?: 'needs_reply' | 'info_missing' | 'ignored' | 'in_calendar';
  replyLang?: 'he' | 'en';
  actions?: Array<'send_reply' | 'create_event' | 'update_event'>; // [V2] + update_event (T2 7.1)
  /** `[+]` the load-bearing S1 fields; the loader checks `stub` satisfies every one of them. */
  extraction?: Partial<Extraction>;
  /** `[+]` live mode only (7.3): regex sources the produced draft must / must not match. */
  draft?: { mustMatch?: string[]; mustNotMatch?: string[] };
  // ---- [V2] T2 7.1 / P2 15.2 (types frozen in Wave 0; the v2 runners are golden.v2.test.ts, V2-W1-03) ----
  change?: {
    kind: 'no_change' | 'reschedule' | 'move' | 'cancel' | 'new_event';
    toStartLocal?: string;
    toEndLocal?: string;
    toStatus?: 'cancelled';
    toLocation?: string;
    confidence?: 'high' | 'medium' | 'low';
    /** [V2-W1-03] P2 15.2: the delta's confidence must be one of these */
    confidenceIn?: Array<'high' | 'medium' | 'low'>;
  };
  /** the load-bearing V1 fields */
  imageRead?: Partial<ImageRead>;
  /** voice: NFKC, niqqud/punctuation stripped, case-folded */
  transcriptKeyPhrases?: string[];
  /** run with a live policy (7.2 auto pass); `null` = no calendar action, no decision row (P2 15.2) */
  auto?: { verdict: AutoVerdict; reason?: AutoReason; verdictIn?: AutoVerdict[]; reasonIfUpdate?: AutoReason } | null;
  /** [F31] rows whose kind may legitimately be any of these */
  changeKindIn?: ChangeKind[];
  badgesIfUpdate?: Badge[];
  /** zero create/update calls even with a live policy */
  neverWrite?: true;
  /** exact LLM runs */
  llmStages?: Array<'extract' | 'draft' | 'read_image'>;
  // ---- [V2-W1-03] P2 15.2 GoldenExpect additions used by the edits / voice / images rows ----
  /** the item state must be one of these */
  stateIn?: Array<'needs_reply' | 'info_missing' | 'ignored' | 'in_calendar'>;
  /** kinds that must exist (others allowed) / must NOT exist */
  actionsInclude?: Array<'send_reply' | 'create_event' | 'update_event'>;
  actionsNot?: Array<'send_reply' | 'create_event' | 'update_event'>;
  /** at least one of these badges */
  badgesAnyOf?: string[];
  /** B28: the chat is tainted after the run */
  chatTainted?: boolean;
  /** zero sends, zero calendar writes without an approval record, zero delete-event ever */
  noSideEffect?: boolean;
  /** tokens of forbidden outcomes (security corpus vocabulary) */
  mustNot?: string[];
  /** P2 2: items.trigger_kind of the proposal version */
  triggerKind?: 'text' | 'voice' | 'image';
  /** exact number of LLM runs */
  llmRuns?: number;
}
export interface GoldenCase {
  id: string; // unique, e.g. 'he-012'
  lang: 'he' | 'en' | 'mixed';
  chatJid: string; // 9725500000NN@s.whatsapp.net (T5)
  nowIso: string; // the frozen "now" of the case
  timeZone: string;
  /** [V2] `kind` (P2 15.2): 'voice' = an audio row whose transcript is `text`; 'image' = a picture whose caption is `text`;
   *  'reaction' = a reaction row (never a trigger, never in the window). Absent = a text row. */
  messages: Array<{ fromMe: boolean; text: string; agoMin: number; kind?: 'text' | 'voice' | 'image' | 'reaction' }>;
  expect: GoldenExpect;
  /** Scripted-mode answers (7.2): rules the StubLlm plays for this case. */
  stub: { rules: StubRule[] };
  injection?: boolean;
  /** `[+]` PIPELINE 11 grouping + the two settings knobs a case may need. */
  category?: string;
  settings?: { ambiguousHour?: 'assume' | 'ask'; defaultDurationMin?: number };
  /** `[+]` busy blocks the fake calendar answers for this case (drives the `conflict` badge). */
  calendar?: { busy: Array<{ startLocal: string; endLocal: string }> };
  /** `[+]` free-text rationale; never read by a runner. */
  note?: string;
  // ---- [V2] T2 7.1 ----
  /** harness seeds a done create_event + in_calendar item + the event in the fake MCP (tagged, owned) */
  existingEvent?: { title: string; startLocal: string; endLocal: string; location?: string };
  media?:
    { kind: 'voice'; oggSeconds: number } | { kind: 'image'; file: string /* tests/golden/images/<id>.png|jpg */ };
  /** scripted parity providers; default ['local','claude_cli','antigravity_cli'] */
  provider?: ProviderId[];
  /** [F28] 'self' rows put the trigger on a from:'me' message (default 'contact') */
  triggerAuthor?: 'contact' | 'self';
  /** [F31] seeded as done, tagged, older in_calendar items of the same chat */
  olderEvents?: Array<{ title: string; startLocal: string; endLocal: string; location?: string }>;
  // ---- [V2-W1-03] P2 15.2 harness knobs (defaults: recentMe true, policy 'on' with the default scope, provider = the stub, track record 3) ----
  harness?: GoldenHarness;
  /** [V2-W1-03] P2 15.2 wa_row vector (tools.jsonl): rows seeded into the bridge db of the trigger chat or of another chat */
  seedRows?: Array<{ chat: 'trigger' | 'other'; rowsBack?: number; ageDays: number; fromMe: boolean; text: string }>;
  /** settings.whatsapp.readTools.scope for the row (default 'trigger_chat') */
  scope?: 'trigger_chat' | 'all_chats';
  /** the S3 loops the row runs on (tools.jsonl: 'turn' and 'agentic') */
  transports?: Array<'turn' | 'agentic'>;
  /** auto-pass variants of the same row (P2 15.2) */
  variants?: Array<{ harness: GoldenHarness; auto: NonNullable<GoldenExpect['auto']> }>;
}
/** [V2-W1-03] P2 15.2 `harness`. `recentMe` (default true) prepends one from-me context row ('היי' / 'hey') 60 minutes before the first
 *  listed message, so context_from_me_recent = 1. */
export interface GoldenHarness {
  recentMe?: boolean;
  policy?: 'on' | 'shadow' | null;
  scope?: Record<string, unknown>;
  provider?: ProviderId;
  trackRecord?: number;
  chatAutoPolicy?: 'inherit' | 'never';
}

/** [V2] + edits | images | voice (T2 7.1). The v1 runner and the default of loadGoldenCases() stay on V1_GOLDEN_FILES; the
 *  v2 files are created by their owners (edits: V2-W1-03, images: V2-W1-08, voice: V2-W1-07) and read by golden.v2.test.ts. */
export type GoldenFile = 'he' | 'en' | 'mixed' | 'edits' | 'images' | 'voice';
export const V1_GOLDEN_FILES: readonly GoldenFile[] = ['he', 'en', 'mixed'];
export const GOLDEN_FILES: readonly GoldenFile[] = [...V1_GOLDEN_FILES, 'edits', 'images', 'voice'];
const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));

/** The structured answer the stub plays for this case - the "ideal model" extraction of TESTS 7.2. */
export function stubExtractionOf(c: GoldenCase): Record<string, unknown> | null {
  for (const rule of c.stub.rules) {
    if ('structured' in rule.respond) return withV1Defaults(rule.respond.structured);
  }
  return null;
}

/** [V2] the StubLlm fills the four B20 fields of a v1-shaped extraction (stub-llm.ts V1_EXTRACTION_DEFAULTS); the expectation
 *  derived from the same rule gets the same fill so the stored extraction and the expected one agree. */
function withV1Defaults(s: Record<string, unknown>): Record<string, unknown> {
  if (!('intent' in s)) return s;
  const out: Record<string, unknown> = { ...s };
  for (const [k, v] of Object.entries(V1_EXTRACTION_DEFAULTS)) if (!(k in out)) out[k] = v;
  return out;
}

/** A case's chat window, oldest first, as absolute epoch milliseconds derived from `nowIso` + `agoMin`. */
export function goldenTimeline(c: GoldenCase): Array<{ fromMe: boolean; text: string; ts: number }> {
  const now = Date.parse(c.nowIso);
  return c.messages
    .map((m) => ({ fromMe: m.fromMe, text: m.text, ts: now - m.agoMin * 60_000 }))
    .sort((a, b) => a.ts - b.ts);
}

class GoldenDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenDataError';
  }
}

function parseLine(file: GoldenFile, lineNo: number, line: string): GoldenCase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new GoldenDataError(`${file}.jsonl:${lineNo}: not valid JSON (${(e as Error).message})`);
  }
  const c = parsed as GoldenCase;
  if (typeof c.id !== 'string' || c.id === '') throw new GoldenDataError(`${file}.jsonl:${lineNo}: missing id`);
  if (!Array.isArray(c.messages) || c.messages.length === 0) throw new GoldenDataError(`${c.id}: messages[] is empty`);
  if (!Array.isArray(c.stub?.rules) || c.stub.rules.length === 0)
    throw new GoldenDataError(`${c.id}: stub.rules[] is empty`);
  if (typeof c.nowIso !== 'string' || Number.isNaN(Date.parse(c.nowIso)))
    throw new GoldenDataError(`${c.id}: bad nowIso`);
  // T5: every JID in the corpus is synthetic.
  if (!/^9725500000\d{2}@s\.whatsapp\.net$/.test(c.chatJid))
    throw new GoldenDataError(`${c.id}: chatJid is not a T5 synthetic JID`);
  // TESTS 7.2: `stub.extraction` must satisfy every field of `expect.extraction`, or the case is lying to itself.
  const stub = stubExtractionOf(c);
  const want = c.expect.extraction;
  if (want !== undefined) {
    if (stub === null) throw new GoldenDataError(`${c.id}: expect.extraction without a structured stub rule`);
    for (const [k, v] of Object.entries(want)) {
      const got = stub[k];
      const equal = Array.isArray(v) ? JSON.stringify(v) === JSON.stringify(got) : v === got;
      if (!equal)
        throw new GoldenDataError(
          `${c.id}: stub.extraction.${k} = ${JSON.stringify(got)} but expect.extraction.${k} = ${JSON.stringify(v)}`,
        );
    }
  }
  return c;
}

/** [V2-W1-03] P2 15.1 `tools.jsonl` (2 injection rows through the wa_* READ tools). Kept out of GOLDEN_FILES on purpose: its consumers
 *  are the wa-tools pipeline test and the injection corpus runner, not the golden plumbing runners. */
export const TOOLS_GOLDEN_FILE = 'tools' as const;
export function loadToolCases(): GoldenCase[] {
  return loadGoldenCases(TOOLS_GOLDEN_FILE as unknown as GoldenFile);
}

export function loadGoldenCases(file?: GoldenFile): GoldenCase[] {
  const files = file === undefined ? V1_GOLDEN_FILES : [file]; // [V2] default = the v1 files (the v1 counts stay valid)
  const cases: GoldenCase[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const text = readFileSync(`${GOLDEN_DIR}${f}.jsonl`, 'utf8');
    let lineNo = 0;
    for (const raw of text.split('\n')) {
      lineNo += 1;
      const line = raw.trim();
      if (line === '') continue;
      const c = parseLine(f, lineNo, line);
      if (seen.has(c.id)) throw new GoldenDataError(`duplicate case id: ${c.id}`);
      seen.add(c.id);
      cases.push(c);
    }
  }
  return cases;
}

// ======================= [V2-W1-03] v2 loader checks (T2 7.2 part 4) + the P2 15.2 harness timeline =======================

/** Does the golden file exist yet? (images.jsonl lands with V2-W1-08; a missing v2 file is reported, never faked.) */
export function goldenFileExists(file: GoldenFile): boolean {
  return existsSync(`${GOLDEN_DIR}${file}.jsonl`);
}

/** The P2 15.2 harness context row: one from-me greeting 60 minutes before the first listed message (unless `recentMe === false`). */
export const RECENT_ME_TEXT: Readonly<Record<'he' | 'en', string>> = { he: 'היי', en: 'hey' };

export interface GoldenWindowRow {
  fromMe: boolean;
  text: string;
  ts: number;
  kind: 'text' | 'voice' | 'image' | 'reaction';
  /** true for the harness-prepended context row (never part of the case's own messages) */
  context?: true;
}
/** The chat window a v2 run sees, oldest first: the harness context row (P2 15.2) + the case's messages (1 minute apart, ending at nowIso). */
export function goldenWindow(c: GoldenCase, harness: GoldenHarness = c.harness ?? {}): GoldenWindowRow[] {
  const rows: GoldenWindowRow[] = goldenTimeline(c).map((r, i) => ({
    ...r,
    kind: [...c.messages].sort((a, b) => b.agoMin - a.agoMin)[i]?.kind ?? 'text',
  }));
  if (harness.recentMe !== false && rows.length > 0) {
    rows.unshift({
      fromMe: true,
      text: RECENT_ME_TEXT[c.lang === 'he' ? 'he' : 'en'],
      ts: rows[0]!.ts - 60 * 60_000,
      kind: 'text',
      context: true,
    });
  }
  return rows;
}

/** Every change kind a row can prove (its exact `change.kind`, or any of `changeKindIn`). */
export function changeKindsOf(c: GoldenCase): string[] {
  return [...(c.expect.change ? [c.expect.change.kind] : []), ...(c.expect.changeKindIn ?? [])];
}

/** T2 7.1 / 7.2 part 4 for edits.jsonl: 27 rows = 25 non-injection + 2 injection, every change kind covered, every row seeds an existing
 *  event, the four B20 fields present in every stub extraction. Returns the list of problems (empty = valid). */
export function checkEditsCorpus(cases: readonly GoldenCase[]): string[] {
  const problems: string[] = [];
  if (cases.length !== 27) problems.push(`edits: ${cases.length} rows, expected 27`);
  const injections = cases.filter((c) => c.injection === true).length;
  if (injections !== 2) problems.push(`edits: ${injections} injection rows, expected 2`);
  if (cases.length - injections !== 25)
    problems.push(`edits: ${cases.length - injections} non-injection rows, expected 25`);
  const kinds = new Set(cases.flatMap(changeKindsOf));
  for (const k of ['no_change', 'reschedule', 'move', 'cancel', 'new_event'])
    if (!kinds.has(k)) problems.push(`edits: change kind ${k} not covered`);
  for (const c of cases) {
    if (c.existingEvent === undefined) problems.push(`${c.id}: no existingEvent`);
    const s = stubExtractionOf(c);
    if (s === null) problems.push(`${c.id}: no structured stub rule`);
    else
      for (const k of ['refersToExisting', 'change', 'changeConfidence', 'confidence'])
        if (!(k in s)) problems.push(`${c.id}: stub lacks ${k}`);
    if (c.triggerAuthor === 'self' && !c.messages.some((m) => m.fromMe))
      problems.push(`${c.id}: self row without a from-me message`);
  }
  return problems;
}

/** T5 / T12 lint for any golden file: synthetic JIDs only, no real-looking key, no media bytes inline, no absolute path. */
export function lintGoldenCase(c: GoldenCase): string[] {
  const problems: string[] = [];
  const dump = JSON.stringify(c);
  if (!/^9725500000\d{2}@s\.whatsapp\.net$/.test(c.chatJid)) problems.push(`${c.id}: non-synthetic JID`);
  if (/sk-ant-(?!TESTONLY)|AIza(?!TESTONLY)/.test(dump)) problems.push(`${c.id}: real-looking key`);
  if (/\+?972\d{8,9}(?!@)/.test(dump.replaceAll(c.chatJid, ''))) problems.push(`${c.id}: phone-number-like digits`);
  if (/data:image\/|base64,/.test(dump)) problems.push(`${c.id}: inline media bytes (T12)`);
  if (/[A-Za-z]:\\|\/Users\//.test(dump)) problems.push(`${c.id}: absolute path`);
  return problems;
}
