// src/main/agent/minimize.ts - payload minimisation (I5) before a cloud call (build-plan section 3; owner W1-09). Safety-critical.
import type { Message } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import { sanitizeForModel } from './sanitize';

export interface MinimizedMessage {
  role: 'contact' | 'me';
  text: string; // sanitised, capped
  ageLabel: string; // relative label ("2 h ago"), never an absolute timestamp with seconds
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative, coarse and app-generated: `now | N m ago | N h ago | N d ago | unknown`. Never an absolute instant (I5). */
export function ageLabelFor(ts: number | null, anchorMs: number): string {
  if (ts === null) return 'unknown';
  const delta = anchorMs - ts;
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} h ago`;
  return `${Math.floor(delta / DAY)} d ago`;
}

/** The rows that reach the model: sanitised, non-empty, ordered oldest -> newest. Exported for contextBuilder's snapshot zip.
 *  [V2] `keepEmpty` (optional): a row whose sanitised text is empty but that still carries app-attached content - the picture row of an
 *  image run (its `imageText` lives next to the empty caption, P2 4.5) - is kept with text ''. Without it the v1 rule stands. */
export function sanitizedNonEmpty(
  messages: Message[],
  keepEmpty?: (m: Message) => boolean,
): Array<{ message: Message; text: string }> {
  const rows: Array<{ message: Message; text: string }> = [];
  for (const m of messages) {
    if (m.deleted) continue;
    const text = sanitizeForModel(m.text).text.trim();
    if (text === '' && keepEmpty?.(m) !== true) continue; // deleted / media-only / empty rows carry no analysable text and no metadata may leak
    rows.push({ message: m, text });
  }
  return rows;
}

/** Last LIMITS.contextMessages rows, LIMITS.contextChars total; no names, no JIDs, no message ids, no media metadata. */
export function minimize(messages: Message[], keepEmpty?: (m: Message) => boolean): MinimizedMessage[] {
  const rows = sanitizedNonEmpty(messages, keepEmpty);
  const windowed = rows.slice(Math.max(0, rows.length - LIMITS.contextMessages));

  // Drop from the OLDEST end until the window fits LIMITS.contextChars.
  let total = windowed.reduce((n, r) => n + r.text.length, 0);
  let first = 0;
  while (first < windowed.length - 1 && total > LIMITS.contextChars) {
    total -= windowed[first]!.text.length;
    first += 1;
  }
  const kept = windowed.slice(first);

  let anchor = 0;
  for (const r of kept) if (r.message.ts !== null && r.message.ts > anchor) anchor = r.message.ts;

  return kept.map((r) => ({
    role: r.message.fromMe ? ('me' as const) : ('contact' as const),
    text: r.text,
    ageLabel: ageLabelFor(r.message.ts, anchor),
  }));
}
