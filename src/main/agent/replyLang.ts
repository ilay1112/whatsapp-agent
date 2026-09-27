// src/main/agent/replyLang.ts - reply language follows the SENDER (build-plan section 3; owner W1-08).
import { detectLanguage } from '../../shared/i18n/bidi';
import type { Lang } from '../../shared/types';

/** i18n-rtl.md 10.1: the last 3-5 inbound messages are weighed; more than that adds nothing and dilutes the newest. */
const WINDOW = 5;

/** inboundTexts = last 3-5 inbound messages, newest first; delegates to shared/i18n/bidi.ts detectLanguage with the fallback chain.
 *  `fallback` is the caller's chain result (own outgoing messages -> stored chat.lang -> UI language) and is returned whenever the
 *  window carries no Hebrew and no Latin letters at all (emoji / digits only). Pure. */
export function detectReplyLang(inboundTexts: string[], fallback: Lang): Lang {
  return detectLanguage(inboundTexts.slice(0, WINDOW), fallback);
}
