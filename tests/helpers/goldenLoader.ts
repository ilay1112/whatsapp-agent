// tests/helpers/goldenLoader.ts - loads tests/golden/{he,en,mixed}.jsonl (TESTS 7.1 / PIPELINE 11; owner W1-10).
// The W0 record shape is kept as the on-disk contract and extended ADDITIVELY with the PIPELINE section 11 fields the
// runners need (see ops/agent-notes/W1-10-agent-pipeline.md, assumption 4). Everything in the files is synthetic DATA
// (TESTS rule T5): the injection rows are attack payloads for the app under test, never instructions to anyone.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; // the project path contains a space: never URL.pathname
import type { StubRule } from '../fakes/stub-llm.ts';
import type { Extraction } from '../../src/shared/schemas.ts';

export interface GoldenExpect {
  needsReply: boolean;
  intent: string;
  eventState: 'none' | 'incomplete' | 'proposed';
  startLocal?: string; // when proposed
  endLocal?: string; // `[+]` when proposed
  missing?: string[];
  badges?: string[];
  suspicious?: boolean;
  /** `[+]` PIPELINE 11 / TESTS 7.1: the final item state, the reply language and the pending actions. */
  state?: 'needs_reply' | 'info_missing' | 'ignored' | 'in_calendar';
  replyLang?: 'he' | 'en';
  actions?: Array<'send_reply' | 'create_event'>;
  /** `[+]` the load-bearing S1 fields; the loader checks `stub` satisfies every one of them. */
  extraction?: Partial<Extraction>;
  /** `[+]` live mode only (7.3): regex sources the produced draft must / must not match. */
  draft?: { mustMatch?: string[]; mustNotMatch?: string[] };
}
export interface GoldenCase {
  id: string; // unique, e.g. 'he-012'
  lang: 'he' | 'en' | 'mixed';
  chatJid: string; // 9725500000NN@s.whatsapp.net (T5)
  nowIso: string; // the frozen "now" of the case
  timeZone: string;
  messages: Array<{ fromMe: boolean; text: string; agoMin: number }>;
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
}

export type GoldenFile = 'he' | 'en' | 'mixed';
export const GOLDEN_FILES: readonly GoldenFile[] = ['he', 'en', 'mixed'];
const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));

/** The structured answer the stub plays for this case - the "ideal model" extraction of TESTS 7.2. */
export function stubExtractionOf(c: GoldenCase): Record<string, unknown> | null {
  for (const rule of c.stub.rules) {
    if ('structured' in rule.respond) return rule.respond.structured;
  }
  return null;
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

export function loadGoldenCases(file?: GoldenFile): GoldenCase[] {
  const files = file === undefined ? GOLDEN_FILES : [file];
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
