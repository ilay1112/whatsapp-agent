// src/main/agent/sanitize.ts - text hygiene before anything reaches a model (build-plan section 3; owner W1-09). Safety-critical (TESTS 13).
import { LIMITS } from '../../shared/types';
import { stripInvisible as sharedStripInvisible } from '../../shared/schemas';

export interface SanitizeReport {
  text: string;
  linkRemoved: boolean; // badge 'link_removed'
  personalDetails: boolean; // badge 'personal_details' (phone numbers / e-mails / ids seen)
  truncated: boolean; // LIMITS.messageChars
}

// [R2] PIPELINE section 2: \u escapes ONLY - never a literal invisible code point inside a character class.
const TAG_BLOCK_RE = /[\u{E0000}-\u{E007F}]/gu; //            Unicode TAG block (invisible ASCII smuggling)
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g; //         LRE..RLO, LRI..PDI (embeddings / overrides / isolates)
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g; //   ZWSP/ZWNJ/ZWJ, word joiner, BOM. KEEPS U+200E/U+200F (legit he/en mixing)
const C0_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g; // C0 controls + DEL, keeping \t \n \r
/** `[+]` LINE SEPARATOR / PARAGRAPH SEPARATOR. `JSON.stringify` escapes \n and \r but emits these two RAW, so a
 *  contact could otherwise author real LINES inside the nonce data block and reproduce the app's own trusted layout
 *  ("free/busy (app-computed, trusted):"). Spotlighting rests on every line outside the JSON strings being ours. */
const LINE_SEPARATOR_RE = /[\u2028\u2029]/g;

/** `[truncated]` marker appended when the 2,000-char cut fires; the cut leaves room for it so the result is idempotent. */
const TRUNCATION_MARKER = ' [truncated]';
const LINK_PLACEHOLDER = '[link]';
const NUMBER_PLACEHOLDER = '[number]';
const EMAIL_PLACEHOLDER = '[email]';

/** Protected while the phone pass runs (a scheduling date must survive; U+0001 cannot occur - C0 is stripped first). */
const SENTINEL = '\u0001';
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/g;

/** `[+]` Label separators IDNA and WhatsApp both treat as a real `.`. NFKC folds U+FF0E and U+2024 but NOT U+3002
 *  (U+FF61 folds INTO U+3002), so `evil\u3002com/x` would otherwise pass the link gate as plain text and leave RULE 6 of
 *  the draft prompt ("do not include links") as the only control - which the project's rules forbid. */
const DOT = '[.\\u3002\\uFF61\\uFF0E\\u2024]';
const URL_RE = new RegExp(
  `\\b(?:https?:\\/\\/|www${DOT})[^\\s<>"'\\u0590-\\u05FF]{1,512}` +
    `|\\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:${DOT}[a-z]{2,24}){1,4}\\/[^\\s<>"']{0,512}`,
  'gi',
);
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/g;
/** Candidate digit run; the replacer decides (>= 9 digits, or a leading `+` and >= 7) so "17:00" and "24/9" survive.
 *  `[+]` `\p{Nd}`, not `\d`: NFKC folds FULLWIDTH digits but not Arabic-Indic (U+0660..) or Persian (U+06F0..) ones,
 *  which are ordinary in this product's own locale - I5 says a cloud payload carries no phone numbers, in any script. */
const PHONE_CANDIDATE_RE = /\+?\p{Nd}[\p{Nd}\u00A0 ()\-.]{4,}\p{Nd}/gu;
const DECIMAL_DIGIT_RE = /\p{Nd}/u;

function cut(s: string): string {
  return s.slice(0, LIMITS.messageChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** `[+]` Counts DECIMAL digits in any script, matching PHONE_CANDIDATE_RE: an ASCII-only count would let
 *  "٠٥٢..." reach the >= 9 test with 0 and slip the mask. DATE_RE stays ASCII on purpose - a date in
 *  Arabic-Indic digits is not lifted into a sentinel, and widening it would let the phone pass swallow it as [number]. */
function countDigits(s: string): number {
  let n = 0;
  for (const ch of s) if (DECIMAL_DIGIT_RE.test(ch)) n += 1;
  return n;
}

/** Strips invisible/bidi controls, replaces URLs with [link], masks phone numbers / e-mail addresses, caps length. Pure, idempotent. */
export function sanitizeForModel(text: string): SanitizeReport {
  let out = text
    .normalize('NFKC')
    .replace(TAG_BLOCK_RE, '')
    .replace(BIDI_RE, '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(LINE_SEPARATOR_RE, '')
    .replace(C0_RE, '');

  // The cut happens BEFORE the masking passes: a 50 KB message must never be walked by the URL / e-mail /
  // phone regexes (cost, and their backtracking is only bounded because the input here is <= LIMITS.messageChars).
  let truncated = false;
  if (out.length > LIMITS.messageChars) {
    out = cut(out);
    truncated = true;
  }

  let linkRemoved = false;
  let personalDetails = false;

  out = out.replace(EMAIL_RE, () => {
    personalDetails = true;
    return EMAIL_PLACEHOLDER;
  });
  out = out.replace(URL_RE, () => {
    linkRemoved = true;
    return LINK_PLACEHOLDER;
  });

  // Dates are lifted out so the phone pass cannot eat "2026-09-24 10" or "24/9".
  const dates: string[] = [];
  out = out.replace(DATE_RE, (m) => {
    dates.push(m);
    return `${SENTINEL}${dates.length - 1}${SENTINEL}`;
  });
  out = out.replace(PHONE_CANDIDATE_RE, (m) => {
    const digits = countDigits(m);
    if (digits >= 9 || (m.startsWith('+') && digits >= 7)) {
      personalDetails = true;
      return NUMBER_PLACEHOLDER;
    }
    return m;
  });
  out = out.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g'), (_m, i: string) => dates[Number(i)]!);

  if (out.length > LIMITS.messageChars) {
    out = cut(out); // masking can add at most a few characters ([email] for a 6-char address); idempotent afterwards
    truncated = true;
  }
  return { text: out, linkRemoved, personalDetails, truncated };
}

/** Same character classes as src/shared/schemas.ts stripInvisible (re-exported here for agent/** consumers). */
export function stripInvisible(text: string): string {
  return sharedStripInvisible(text);
}
