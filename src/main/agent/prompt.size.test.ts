// V2-W0-scaffold (build plan section 2 step 3; owner V2-W1-03-edit-pipeline afterwards). F23 / C2 19 item 28: every
// S1 / S3 / V1 system-prompt constant (incl. the v2 addenda and the CLI JSON-only line) is < 8 KB in UTF-8, so the
// Claude CLI never needs `--system-prompt-file` (it stays in CLAUDE_NEVER_ARGS). Also pins the v2 constants to the
// P2 text byte for byte (docs/specs/v2-pipeline.md 6.2, 8.3, 4.4) so a later edit cannot drift from the reviewed bytes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; // the project path contains a space: never URL.pathname
import { describe, expect, it } from 'vitest';
import {
  CLI_JSON_ONLY_LINE,
  EXTRACT_RULES_ADDENDUM,
  EXTRACT_RULES_ADDENDUM_V2,
  EXTRACT_V2_ADDENDUM,
  IMAGE_TEXT_SENTENCE,
  SYSTEM_PROMPT_EXTRACT,
  SYSTEM_PROMPT_DRAFT_V2,
  SYSTEM_PROMPT_EXTRACT_V2,
  V1_READ_IMAGE_SYSTEM,
  SYSTEM_PREFIX_DRAFT,
  SYSTEM_PREFIX_EXTRACT,
  SYSTEM_PREFIX_READ_IMAGE,
  buildSystemPrompt,
} from './prompt';

const KB8 = 8 * 1024;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

const P2 = readFileSync(fileURLToPath(new URL('../../../docs/specs/v2-pipeline.md', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);
/** The fenced block after the first occurrence of `marker`, without its fences. */
function fenceAfter(marker: string): string {
  const at = P2.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const open = P2.indexOf('```\n', at);
  const close = P2.indexOf('\n```', open + 4);
  return P2.slice(open + 4, close);
}

/** The trusted facts block the v1 builder appends (an upper bound for every stage: it carries the reply-language line
 *  V1 does not have and the gender line only S3 has). V2-W1-03's builder must stay within the same bytes. */
function factsOf(stage: 'extract' | 'draft', constantPrefix: string): string {
  const full = buildSystemPrompt({
    stage,
    nowIso: '2026-09-21T09:00:00.000+03:00',
    tz: 'America/Argentina/ComodRivadavia', // the longest common IANA shape
    replyLang: 'he',
    userGender: 'unspecified',
    nonce: 'f'.repeat(64),
  });
  expect(full.startsWith(constantPrefix)).toBe(true);
  return full.slice(constantPrefix.length);
}
// [V2-W1-03] buildSystemPrompt() now assembles the v2 constants (P2 6.2 / 8.3 / 4.4).
const EXTRACT_FACTS = factsOf('extract', SYSTEM_PREFIX_EXTRACT);

describe('v2 prompt constants are the P2 text byte for byte', () => {
  it.each([
    ['SYSTEM_PROMPT_EXTRACT_V2', SYSTEM_PROMPT_EXTRACT_V2, '**`SYSTEM_PROMPT_EXTRACT` (v2):**'],
    ['EXTRACT_RULES_ADDENDUM_V2', EXTRACT_RULES_ADDENDUM_V2, '**`EXTRACT_RULES_ADDENDUM` (v2)**'],
    ['EXTRACT_V2_ADDENDUM', EXTRACT_V2_ADDENDUM, '**`EXTRACT_V2_ADDENDUM` (new, VERBATIM):**'],
    ['SYSTEM_PROMPT_DRAFT_V2', SYSTEM_PROMPT_DRAFT_V2, '### 8.3 S3 system prompt v2'],
    ['V1_READ_IMAGE_SYSTEM', V1_READ_IMAGE_SYSTEM, '**System prompt** = `SYSTEM_PROMPT_READ_IMAGE`'],
  ])('%s', (_name, constant, marker) => {
    expect(constant).toBe(fenceAfter(marker));
  });

  it('V1_READ_IMAGE_SYSTEM equals docs/research/v2-image-events.md 4.3 too', () => {
    const rImg = readFileSync(
      fileURLToPath(new URL('../../../docs/research/v2-image-events.md', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(rImg.includes(V1_READ_IMAGE_SYSTEM)).toBe(true);
  });

  it('the imageText sentence ends rule 1 of S1 v2 and the CLI JSON-only line is the last line of the addendum', () => {
    const rule1 = SYSTEM_PROMPT_EXTRACT_V2.split('\n').find((l) => l.startsWith('1. '))!;
    expect(rule1.endsWith(` ${IMAGE_TEXT_SENTENCE}`)).toBe(true);
    expect(EXTRACT_V2_ADDENDUM.split('\n').at(-1)).toBe(CLI_JSON_ONLY_LINE);
    // S1 v2 differs from v1 only by that sentence and the four B20 fields in the few-shot outputs (P2 6.2 (a)-(b)).
    const strip = (s: string): string =>
      s
        .replace(` ${IMAGE_TEXT_SENTENCE}`, '')
        .replaceAll(',"refersToExisting":false,"change":"no_change","changeConfidence":"high"', '')
        .replace(/,"confidence":"(high|medium|low)"}/g, '}');
    expect(strip(SYSTEM_PROMPT_EXTRACT_V2)).toBe(SYSTEM_PROMPT_EXTRACT);
    expect(strip(EXTRACT_RULES_ADDENDUM_V2)).toBe(EXTRACT_RULES_ADDENDUM);
  });

  it('no v2 constant carries a template placeholder, a tool/file/session word or a policy word (B15, B29)', () => {
    for (const c of [SYSTEM_PROMPT_EXTRACT_V2, EXTRACT_RULES_ADDENDUM_V2, EXTRACT_V2_ADDENDUM, V1_READ_IMAGE_SYSTEM]) {
      expect(c).not.toMatch(/\$\{|\{\{/);
      expect(c).not.toMatch(/\b(automatic|auto-?approve|undo|settings|repository|session)\b/i);
    }
    expect(SYSTEM_PROMPT_DRAFT_V2).not.toMatch(/\$\{|\{\{|\bautomatic\b|\bundo\b/i);
  });
});

describe('F23 - every S1 / S3 / V1 system-prompt constant is < 8 KB (C2 19 item 28)', () => {
  it.each([
    ['SYSTEM_PROMPT_EXTRACT_V2', SYSTEM_PROMPT_EXTRACT_V2],
    ['EXTRACT_RULES_ADDENDUM_V2', EXTRACT_RULES_ADDENDUM_V2],
    ['EXTRACT_V2_ADDENDUM (incl. the CLI JSON-only line)', EXTRACT_V2_ADDENDUM],
    ['SYSTEM_PROMPT_DRAFT_V2', SYSTEM_PROMPT_DRAFT_V2],
    ['V1_READ_IMAGE_SYSTEM', V1_READ_IMAGE_SYSTEM],
  ])('%s', (_name, constant) => {
    expect(bytes(constant)).toBeLessThan(KB8);
  });

  it('assembled S3 (constant + facts incl. the gender line) < 8 KB', () => {
    const facts = factsOf('draft', SYSTEM_PREFIX_DRAFT);
    expect(bytes(`${SYSTEM_PROMPT_DRAFT_V2}${facts}`)).toBeLessThan(KB8);
    expect(facts.length).toBeGreaterThan(0);
  });

  it('assembled V1 (constant + facts + the CLI JSON-only line) < 8 KB', () => {
    expect(bytes(`${V1_READ_IMAGE_SYSTEM}\n\n${CLI_JSON_ONLY_LINE}${EXTRACT_FACTS}`)).toBeLessThan(KB8);
    // the real builder output (V1 has no reply-language line, so it is shorter than the bound above)
    const v1 = buildSystemPrompt({
      stage: 'read_image',
      nowIso: '2026-09-21T09:00:00.000+03:00',
      tz: 'America/Argentina/ComodRivadavia',
      replyLang: 'he',
      userGender: 'unspecified',
      nonce: 'f'.repeat(64),
    });
    expect(v1.startsWith(SYSTEM_PREFIX_READ_IMAGE)).toBe(true);
    expect(bytes(v1)).toBeLessThan(KB8);
  });

  it('assembled S1 prefix is exactly the three v2 constants joined by blank lines (B29: one prompt for every provider)', () => {
    expect(SYSTEM_PREFIX_EXTRACT).toBe(
      `${SYSTEM_PROMPT_EXTRACT_V2}\n\n${EXTRACT_RULES_ADDENDUM_V2}\n\n${EXTRACT_V2_ADDENDUM}`,
    );
    expect(SYSTEM_PREFIX_DRAFT).toBe(SYSTEM_PROMPT_DRAFT_V2);
    expect(SYSTEM_PREFIX_READ_IMAGE).toBe(`${V1_READ_IMAGE_SYSTEM}\n\n${CLI_JSON_ONLY_LINE}`);
  });

  // KNOWN SPEC CONFLICT (recorded in ops/agent-notes/V2-W0-scaffold.md, REQUEST R-PROMPT-SIZE): the build plan asks for
  // the ASSEMBLED S1 (v2 constant + existing-event addendum + imageText sentence + CLI JSON-only line) < 8 KB, but the
  // verbatim P2 6.2 bytes assemble to ~12.5 KB (P2 6.2 "Size" note and concern 1 say ~13 KB). W0 may not change the
  // verbatim bytes and may not re-introduce `--system-prompt-file` (F23). `it.fails` keeps the measurement visible and
  // turns RED as soon as the decision lands (trimmed S1 bytes, or a revised threshold) - V2-W1-03 then flips it to `it`.
  it.fails('assembled S1 (constant + rule-6a addendum + existing-event addendum + facts) < 8 KB', () => {
    const s1 = `${SYSTEM_PROMPT_EXTRACT_V2}\n\n${EXTRACT_RULES_ADDENDUM_V2}\n\n${EXTRACT_V2_ADDENDUM}${EXTRACT_FACTS}`;
    expect(bytes(s1)).toBeLessThan(KB8);
  });
});
