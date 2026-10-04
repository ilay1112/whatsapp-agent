// src/shared/i18n/autoCopy.ts - the ONE list of automatic-mode bullets (UX2 4.5 / 4.5.1; owner V2-W1-12).
//
// UX2 4.5.1: the native enable dialog's `detail` is "the six 'What happens without asking you' bullets, one per line,
// prefixed '- ' (same keys as the settings list; no information appears only in the dialog), then an empty line and
// 'Ends on {{date}}.'". Settings (renderer) and `app/autoDialog.ts` (main, V2-W1-04) both build their text from the key
// lists below, so the dialog can never say something the settings page does not (locales.test.ts asserts it).
// Pure: takes a translate function, never imports i18next or electron.

/** "What happens without asking you" - settings column 1 and the dialog detail, in this order. */
export const AUTO_HAPPENS_KEYS = [
  'auto.happens.people',
  'auto.happens.window',
  'auto.happens.limits',
  'auto.happens.notify',
  'auto.happens.replies',
  'auto.happens.ends',
] as const;

/** "What never happens" - settings column 2. */
export const AUTO_NEVER_KEYS = [
  'auto.never.delete',
  'auto.never.invite',
  'auto.never.send',
  'auto.never.media',
  'auto.never.unsure',
  'auto.never.foreign',
] as const;

export type AutoCopyT = (key: string, values?: Record<string, unknown>) => string;

/** The dialog `detail`: each bullet on its own line prefixed "- ", an empty line, then "Ends on {{date}}.". */
export function autoDialogDetail(t: AutoCopyT, opts: { validityDays: number; endsOn: string }): string {
  const bullets = AUTO_HAPPENS_KEYS.map((key) => `- ${t(key, { days: opts.validityDays })}`);
  return `${bullets.join('\n')}\n\n${t('auto.dialog.ends', { date: opts.endsOn })}`;
}
