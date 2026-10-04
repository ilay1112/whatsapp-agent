// src/renderer/src/components/ChangeLine.tsx - the Change card line (UX2 3.3, 11.2, 14.1; B20; owner V2-W1-11).
//
//   en: "Change: Wed 15:00 -> 17:00"        he: "שינוי: יום רביעי 15:00 ← 17:00"
//
// Rules:
//   - every side is its own <bdi>, so in Hebrew the old value is read first (at the right) and the arrow points at the
//     new value (left); the arrow is a TEXT glyph (U+2192 en / U+2190 he), muted and aria-hidden, never an icon;
//   - the visible line is aria-hidden; a visually hidden sibling carries the full sentence (UX2 11.2);
//   - dates and times are app-formatted from structured fields; the only untrusted values (a place, a title) sit in
//     their own <bdi> (direction auto by default) and are handed to React as children - the locale template never sees them (UX 16.5).
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChangeView, Lang } from '@shared/types';
import { SENTINEL, renderBdiTemplate } from './ItemCard.bdi';
import { formatWhen, rescheduleSides, startMsOf } from './ChangeLine.format';

export interface ChangeLineProps {
  change: ChangeView;
  lang: Lang;
}

export const ARROW_EN = '→';
export const ARROW_HE = '←';
const ARROW_TOKEN = '<arrow/>';

/** Splits a locale value on `<arrow/>` and renders every piece with the `<bdi>` template renderer. */
function renderLine(raw: string, values: readonly ReactNode[], arrow: string): ReactNode[] {
  const out: ReactNode[] = [];
  raw.split(ARROW_TOKEN).forEach((piece, index) => {
    if (index > 0)
      out.push(
        <span key={`arrow-${index}`} className="change-arrow" aria-hidden="true" data-testid="change-arrow">
          {arrow}
        </span>,
      );
    out.push(<span key={`piece-${index}`}>{renderBdiTemplate(piece, values)}</span>);
  });
  return out;
}

/** Real test id is `change-line-<itemId>` (UX2 13), rendered by ItemCard around this line. */
export function ChangeLine({ change, lang }: ChangeLineProps) {
  const { t } = useTranslation();
  const arrow = lang === 'he' ? ARROW_HE : ARROW_EN;
  // 'undo' is a payload-only change (never a model value); it reads like a reschedule back to the older slot.
  const kind = change.kind === 'undo' ? 'reschedule' : change.kind;
  const { from, to } = change;

  let visible: ReactNode[];
  let sentence: string;
  if (kind === 'move') {
    // The two places are untrusted contact text: children of <bdi dir="auto">, never template input.
    const place = (v: string): string => (v !== '' ? v : '-');
    visible = renderLine(
      t('change.line.move', { from: SENTINEL(0), to: SENTINEL(1) }),
      [place(from.location), place(to.location)],
      arrow,
    );
    sentence = t('change.a11y.move', { from: from.location || '-', to: to.location || '-' });
  } else if (kind === 'cancel') {
    const when = formatWhen(startMsOf(from), lang, from.timeZone);
    visible = renderBdiTemplate(t('change.line.cancel', { title: SENTINEL(0), when: SENTINEL(1) }), [from.title, when]);
    sentence = t('change.a11y.cancel', { title: from.title, when });
  } else {
    const sides = rescheduleSides(from, to, lang);
    visible = renderLine(
      t('change.line.reschedule', { from: SENTINEL(0), to: SENTINEL(1) }),
      [sides.from, sides.to],
      arrow,
    );
    sentence = t('change.a11y.reschedule', { from: sides.fromA11y, to: sides.toA11y });
  }

  return (
    <p className="m-0 text-sm text-text" data-testid="change-line" data-kind={kind} lang={lang}>
      <span aria-hidden="true" data-testid="change-line-visible">
        {visible}
      </span>
      <span className="sr-only" data-testid="change-line-sentence">
        {sentence}
      </span>
    </p>
  );
}
