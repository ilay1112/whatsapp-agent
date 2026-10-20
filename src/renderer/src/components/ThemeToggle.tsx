// src/renderer/src/components/ThemeToggle.tsx - the header's three-segment colour-scheme switch (spec v4-calendar-handover 2.3;
// owner T-908 group A). Same radiogroup pattern as LanguageToggle: roving arrow keys in VISUAL order, one tab stop, and the
// component only reports the user's choice - App persists it through settings:set (the documented header exception) and
// main mirrors it into nativeTheme.themeSource. The segments are icons (auto / sun / moon from the closed icon list); each
// carries its translated name as aria-label, so no untrusted text is ever involved.
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { THEMES, type Theme } from '@shared/settings';

const ICON: Record<Theme, string> = { system: 'icon-auto', light: 'icon-sun', dark: 'icon-moon' };

/**
 * Applies a theme to the document: `light` / `dark` force the palette through `<html data-theme>`; `system` removes the
 * attribute so the `prefers-color-scheme` media query (which nativeTheme.themeSource also drives) decides.
 */
export function applyDocumentTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export interface ThemeToggleProps {
  value: Theme;
  onChange(theme: Theme): void;
}

export function ThemeToggle({ value, onChange }: ThemeToggleProps) {
  const { t } = useTranslation();
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = THEMES.indexOf(value);
    const rtl = document.documentElement.dir === 'rtl';
    const forward = event.key === 'ArrowDown' || (rtl ? event.key === 'ArrowLeft' : event.key === 'ArrowRight');
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? THEMES.length - 1
          : (index + (forward ? 1 : THEMES.length - 1)) % THEMES.length;
    const theme = THEMES[next]!;
    onChange(theme);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-theme-option="${theme}"]`)?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={t('settings.general.themeLabel')}
      data-testid="theme-toggle"
      data-value={value}
      onKeyDown={onKeyDown}
      className="inline-flex items-center overflow-hidden rounded-sm border border-line-strong"
    >
      {THEMES.map((theme) => (
        <button
          key={theme}
          type="button"
          role="radio"
          data-testid={`theme-${theme}`}
          data-theme-option={theme}
          aria-checked={value === theme}
          aria-label={t(`theme.${theme}`)}
          tabIndex={value === theme ? 0 : -1}
          onClick={() => onChange(theme)}
          className={`focus-ring inline-flex min-h-8 min-w-8 items-center justify-center px-2 ${
            value === theme ? 'bg-accent text-on-accent' : 'bg-surface text-text-muted'
          }`}
        >
          <span className={`icon ${ICON[theme]}`} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
