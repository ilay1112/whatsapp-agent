# v4-shell — T-908 task group A (T1 theme, T2 sticky shell)

Spec: `docs/specs/v4-calendar-handover.md` §2.2, §2.3. Worker notes only; orchestrator owns PROGRESS/BOARD/DECISIONS.

## What was done (test-first; every new test was run red first)

### T1 theme
- `src/shared/settings.ts`: `THEMES`, `ThemeSchema`, `Theme`; `general.theme` = `ThemeSchema.default('system')` in `SettingsSchema`,
  `theme: 'system'` in `DEFAULT_SETTINGS`, `theme` in `SettingsPatchSchema.general`.
  - **Why `.default`:** `repos/settings.ts` falls back to the WHOLE `DEFAULT_SETTINGS` when the stored row fails to parse. Without
    a default every existing install would silently lose all its settings on upgrade. With it no migration is needed (group D owns
    `migrations.ts`, so this also avoids a conflict). Tested in `settings.test.ts`.
- `components/ThemeToggle.tsx` (new): radiogroup like `LanguageToggle` (roving arrows in visual order, Home/End, one tab stop),
  `theme-toggle` / `theme-{system,light,dark}`, icons `icon-auto` / `icon-sun` / `icon-moon`, aria-labels from `theme.*`, group
  label `settings.general.themeLabel`. Also exports `applyDocumentTheme(theme)` (sets/removes `<html data-theme>`).
- `App.tsx`: one effect applies `settings.general.theme` (boot + every change, optimistic and rollback alike); header `onTheme`
  calls `setSettings({general:{theme}})` (the documented header exception). The header toggle is hidden below the `roomy`
  breakpoint (`max-roomy:hidden`): at 420 px a third control group would overflow the header; Settings > General has the same choice.
- `Settings.tsx` General: radio row `settings-theme` with `settings-theme-{system,light,dark}`, saves + applies at once.
- `styles.css`: OS dark block guarded `:root:not([data-theme="light"])` inside the media query (`styles.test.ts:94` still true),
  byte-identical copy under `:root[data-theme="dark"]`, `color-scheme` light / dark / `light dark`. Test compares the two token sets.
  New `icon-sun`, `icon-moon` utilities; `docs/specs/v2-ux.md` §1.3 lists them.
- Main: `app/window.ts` `applyNativeTheme(target, theme, log)` (no-op when unchanged, logs `ui.theme {theme}`),
  `windowBackground(dark)` + `MainWindowDeps.dark` → `backgroundColor` (no white flash in dark). `compose.ts`: optional
  `ComposeDeps.nativeTheme`, applied after the settings bus is built and in the existing `settingsBus.onChange` block.
  `index.ts` passes electron's `nativeTheme` and `dark: nativeTheme.shouldUseDarkColors`.
  - **Deviation from the brief:** the handler does NOT set nativeTheme. `handlers/settings.ts` documents (and its test asserts) that
    it owns no side effect — language/tray/autostart hang off `SettingsBus.onChange` in compose.ts — so theme does the same. The
    handler test covers that `general.theme` is accepted without a Google round trip; the nativeTheme behaviour is unit-tested in
    `window.test.ts` and end-to-end in `v4-shell.spec.ts` (`nativeTheme.themeSource` polled from main).

### T2 sticky shell
- `App.tsx` root `flex h-full flex-col overflow-hidden`; content wrapper `flex min-h-0 grow flex-col overflow-y-auto`
  `data-testid="app-scroll"`; header/strip/footer outside it. Toast `bottom-10` → `inset-be-10`.
- `Dashboard.tsx` (only the two allowed spots): `<main>` `... overflow-y-auto px-4 pb-4` (was `p-4`); toolbar
  `sticky inset-bs-0 z-10 bg-canvas pt-4`.
  - Why main scrolls itself: `<main>` is bounded (`min-h-0 grow`) so the wide columns keep their own scrolling (UX 6.1). When its
    content still overflows (the calendar's 70vh grid at small heights) a sticky toolbar whose containing block is a non-scrolling
    main would scroll away with it. Making main the overflow scroller keeps the toolbar fixed in every case.
  - Why `pt-4` moved onto the toolbar: with `p-4` on main the sticky toolbar jumped 16 px up when scrolling began.
- `dashboard.css`: `[data-layout='narrow'] .dash-column { flex-shrink: 0 }` — the stacked one-column container is now bounded, and
  without this its sections were squeezed into nested scrollers; now the container scrolls them as one (sticky h2s still work).
- `Settings.tsx` `<main>` `flex grow gap-6 p-4` (no `overflow-auto`, no `min-h-full`); nav `sticky inset-bs-4` — spec says
  `inset-block-start-0` but `4` matches main's padding, so the nav does not jump 16 px when the page starts scrolling (e2e caught it).
- Tailwind 4.3 names: `inset-bs-*` / `inset-be-*` (there is no `inset-block-start-0` utility).
- `Dashboard.static.test.ts`: new `SHELL` list (App.tsx, ThemeToggle.tsx, LanguageToggle.tsx) checked for physical utilities incl.
  `top-*`/`bottom-*`. App.tsx is NOT in `OWNED` because it legitimately calls `setSettings` (header exception) — adding it there
  would fail the "never calls settings:set" guard.

## Tests
- New: `ThemeToggle.test.tsx`, `App.v4.test.tsx`, `views/Settings.v4.test.tsx`, `tests/e2e/v4-shell.spec.ts`; additions in
  `settings.test.ts`, `styles.test.ts`, `window.test.ts`, `handlers/settings.test.ts`, `Dashboard.static.test.ts`.
- Snapshot updated: `views/__snapshots__/Settings.test.tsx.snap` (RTL snapshot: new theme row + main/nav classes only).
- e2e `v4-shell.spec.ts`: appends a test-only 2400 px spacer to the scrolling region (removed after), scrolls every scroller to its
  end, compares the block-axis box (y, height) of header / toolbar / settings nav — width legitimately shrinks by the scrollbar.
  Theme test uses `page.emulateMedia` for the "OS" scheme. Screenshots: `shell-{en,he}-{top,bottom}`, `theme-dark-{dashboard,
  settings,calendar}`, `theme-light-dashboard` (reviewed: no light leak in header/toolbar/h2/nav backgrounds).

## Results at hand-off (2026-10-19)
- `vitest src/renderer src/shared src/main/ipc src/main/app`: all mine green. One red that is group C's: `styles.test.ts`
  "adds no colour token beyond the v1 set" (their `--color-cal-0..7` hue tokens; spec §2.4 asks them to add tokens, so that test
  needs their update). Earlier transient reds in `register*.test.ts` were C's in-progress `calendar:*` channels.
- typecheck / lint / format:check: clean for my files; remaining errors are in group C files (CalendarWeek.tsx, calendarView.ts,
  calendarEvents*.ts, CalendarPicker.tsx, EventPopover.tsx, fake-mcp-calendar.ts …).
- `build:e2e` + `v4-shell.spec.ts` (3/3), `i18n-rtl.spec.ts` + `app.spec.ts` (7/7) green.

## Notes for others / open
- Calendar view at small heights shows two scrollbars (main + the 70vh `cal-grid`); harmless, but group C may want the grid to fill
  the remaining height instead of `70vh`.
- The header "System" segment reuses `icon-auto` per spec; if the user finds the calendar-with-arcs glyph confusing, a dedicated
  half-filled-circle icon would be a one-line change.
