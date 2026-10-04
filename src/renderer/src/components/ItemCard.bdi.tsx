// src/renderer/src/components/ItemCard.bdi.tsx - the `<bdi>` locale-template renderer shared by the cards, the Change
// line, the bubbles and the AutoStrip (UX 16.5; owner V2-W1-11-renderer-dashboard, split out of ItemCard.tsx so the
// v2 components can use it without an import cycle; ItemCard.tsx re-exports both names).
import type { ReactNode } from 'react';

/** Private-use delimiters: an interpolated value can never collide with them, and they are invisible if one leaks. */
export const SENTINEL = (index: number): string => `${index}`;
const SENTINEL_RE = /(<bdi(?: dir="(?:ltr|rtl)")?>)?(\d)(<\/bdi>)?/g;

/**
 * Renders a locale value whose ONLY markup is `<bdi>` / `<bdi dir="ltr">` around interpolated values.
 * `<Trans>` is deliberately not used: it interpolates first and parses the RESULT as HTML, so an untrusted contact name
 * containing `<img src=x onerror=...>` would be parsed into nodes. Here the untrusted values never touch the template -
 * they are handed to React as children (UX 16.5).
 */
export function renderBdiTemplate(raw: string, values: readonly ReactNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  SENTINEL_RE.lastIndex = 0;
  for (let m = SENTINEL_RE.exec(raw); m !== null; m = SENTINEL_RE.exec(raw)) {
    if (m.index > last) out.push(raw.slice(last, m.index));
    const node = values[Number(m[2])] ?? null;
    const dir = m[1] !== undefined && m[1].includes('dir="ltr"') ? 'ltr' : undefined;
    out.push(
      <bdi key={key++} dir={dir}>
        {node}
      </bdi>,
    );
    last = SENTINEL_RE.lastIndex;
  }
  if (last < raw.length) out.push(raw.slice(last));
  return out;
}
