// src/shared/i18n/bidi.ts
// Signatures from docs/research/i18n-rtl.md 6.1-6.3 and 10.1 (owner W1-08). Pure, no I/O.
import type { Dir, Lang } from '../types';

/** Unicode isolate controls (Unicode 6.3). Exported so tests and callers never hand-write the code points. */
export const FSI = String.fromCharCode(0x2068); // FIRST STRONG ISOLATE - the plain-string equivalent of dir="auto"
export const LRI = String.fromCharCode(0x2066); // LEFT-TO-RIGHT ISOLATE
export const PDI = String.fromCharCode(0x2069); // POP DIRECTIONAL ISOLATE

const HEBREW_RE = /\p{Script=Hebrew}/gu;
const LATIN_RE = /\p{Script=Latin}/gu;
const URL_RE = /https?:\/\/\S+/g;
/** i18n-rtl.md 10.1: only the last 3-5 INBOUND messages are weighed. */
const MAX_DETECTION_TEXTS = 5;

function scriptCounts(text: string): { hebrew: number; latin: number } {
  const clean = text.replace(URL_RE, ''); // a Latin URL must not make a Hebrew message look English
  return { hebrew: clean.match(HEBREW_RE)?.length ?? 0, latin: clean.match(LATIN_RE)?.length ?? 0 };
}

/** Wraps a value in FSI (U+2068) ... PDI (U+2069): the plain-string equivalent of dir="auto" (tray tooltip, toasts, native dialogs). */
export function isolate(s: string): string {
  return `${FSI}${s}${PDI}`;
}

/** Wraps a value in LRI (U+2066) ... PDI (U+2069): phone numbers, JIDs, e-mail, URLs, paths, versions inside RTL text. */
export function ltr(s: string): string {
  return `${LRI}${s}${PDI}`;
}

/** Majority of strong characters after stripping URLs; 'rtl' when Hebrew >= Latin and Hebrew > 0, else 'ltr'. */
export function detectDir(text: string): Dir {
  const { hebrew, latin } = scriptCounts(text);
  return hebrew >= latin && hebrew > 0 ? 'rtl' : 'ltr';
}

/** texts = last 3-5 INBOUND messages, newest first; weighted script count (Hebrew vs Latin); fallback when no letters. */
export function detectLanguage(texts: string[], fallback: Lang): Lang {
  let hebrew = 0;
  let latin = 0;
  texts.slice(0, MAX_DETECTION_TEXTS).forEach((text, index) => {
    const weight = 1 / (index + 1); // the newest message weighs most
    const counts = scriptCounts(text);
    hebrew += weight * counts.hebrew;
    latin += weight * counts.latin;
  });
  if (hebrew === 0 && latin === 0) return fallback; // emoji / digits / punctuation only
  return hebrew >= latin ? 'he' : 'en';
}
