// src/renderer/src/components/LanguageToggle.tsx - two-segment "עב | EN" control (UX 5.1, 14.2; owner W1-14).
// The two labels are NEVER translated (i18n-rtl.md 4.3: each language is shown in its own name) and each carries its own
// `lang` attribute so Windows picks the right shaping. Switching goes through settings:set -> main -> ui:languageChanged;
// this component only reports the user's choice.
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Lang } from '@shared/types';

const LANGS: readonly Lang[] = ['he', 'en'];
const LABEL: Record<Lang, string> = { he: 'עב', en: 'EN' };

export interface LanguageToggleProps {
  value: Lang;
  onChange(lang: Lang): void;
  compact?: boolean;
}

export function LanguageToggle({ value, onChange, compact }: LanguageToggleProps) {
  const { t } = useTranslation();
  const groupRef = useRef<HTMLDivElement>(null);

  // Roving arrow-key behaviour of a radiogroup (UX 13.2). Left/Right are VISUAL directions in both scripts, so the
  // browser's own reading order is used: next/previous in DOM order.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = LANGS.indexOf(value);
    const rtl = document.documentElement.dir === 'rtl';
    const forward = event.key === 'ArrowDown' || (rtl ? event.key === 'ArrowLeft' : event.key === 'ArrowRight');
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? LANGS.length - 1
          : (index + (forward ? 1 : LANGS.length - 1)) % LANGS.length;
    const lang = LANGS[next]!;
    onChange(lang);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-lang="${lang}"]`)?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={t('language.label')}
      data-testid="lang-toggle"
      data-value={value}
      onKeyDown={onKeyDown}
      className="inline-flex items-center overflow-hidden rounded-sm border border-line-strong"
    >
      {LANGS.map((lang) => (
        <button
          key={lang}
          type="button"
          role="radio"
          lang={lang}
          data-lang={lang}
          aria-checked={value === lang}
          aria-label={t(`language.${lang}`)}
          tabIndex={value === lang ? 0 : -1}
          onClick={() => onChange(lang)}
          className={`focus-ring min-h-8 px-2 text-xs font-semibold ${compact ? 'min-w-8' : 'min-w-10'} ${
            value === lang ? 'bg-accent text-on-accent' : 'bg-surface text-text-muted'
          }`}
        >
          {LABEL[lang]}
        </button>
      ))}
    </div>
  );
}
