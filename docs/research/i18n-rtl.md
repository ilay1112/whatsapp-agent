# Research: i18n + RTL (Hebrew / English) for WhatsApp Calendar Agent

Date: 2026-09-21. Scope: Electron + TypeScript + React renderer, two UI languages (`en`, `he`), Windows 11 only.
Everything marked **UNVERIFIED** could not be confirmed from a primary source or by a local probe during this research.

Verification methods used:
- `npm view <pkg> version` run locally on 2026-09-21 (Node v24.19.0, npm 11.17.0).
- Local `Intl` probes in Node 24.19 (ICU 78.3, CLDR 48.0). Electron 44.4.3 bundles Chromium 152.0.7977.130 / Node 24.21.0 (https://releases.electronjs.org/release/v44.4.3); its ICU/CLDR level should be equal or newer, but renderer output was not probed - re-run the probe script in the renderer once the app skeleton exists.
- Official docs (URLs in section 13).

---

## 1. TL;DR recommendation

| Concern | Decision |
|---|---|
| Library | `i18next@^26.4.2` + `react-i18next@^17.0.14` (peer: `i18next >= 26.2.0`, `react >= 16.8`, `typescript ^5 || ^6 || ^7`). No language-detector plugin, no backend plugin. |
| Resources | Two static JSON files, `src/shared/locales/en.json` and `he.json`, single `translation` namespace, bundled into BOTH the main-process and renderer bundles. |
| Main process | Own plain `i18next.createInstance()` (no React) for tray menu, native dialogs, notifications, window title. |
| Source of truth for language | `settings.ui.language: 'system' \| 'en' \| 'he'` persisted by the MAIN process. Renderer asks main; main broadcasts changes. |
| Direction | `<html lang dir>` set from `i18next.dir(lng)`; ONE stylesheet written only with CSS logical properties; `:dir(rtl)` only for icon mirroring. |
| User content (messages, names, phones) | Never inherits UI direction: `dir="auto"` on message paragraphs, `<bdi>` around interpolated names, `<bdi dir="ltr">`/`<span dir="ltr">` around phone numbers, FSI/PDI Unicode isolates in plain strings (tray tooltip, notifications, dialogs). |
| Fonts | Default: system `"Segoe UI"` (has Hebrew, zero bytes). Optional bundled `@fontsource-variable/heebo@5.3.0` (OFL-1.1) if the designer wants a more modern Hebrew. |
| Dates | `Intl.DateTimeFormat` with explicit locale (`he-IL` / `en-IL`), explicit `timeZone` (default `Asia/Jerusalem`), explicit `hourCycle: 'h23'`. Never rely on `navigator.language`. |
| LLM reply language | Follows the SENDER's language (script-count detection over recent inbound messages), independent of UI language. LLM returns enum codes for "missing info", UI localises them. |

---

## 2. Package versions (verified with `npm view` on 2026-09-21)

| Package | Version | License | Use |
|---|---|---|---|
| `i18next` | 26.4.2 | MIT | core |
| `react-i18next` | 17.0.14 | MIT | React bindings (`useTranslation`, `Trans`) |
| `i18next-browser-languagedetector` | 8.2.1 | MIT | NOT needed (language comes from settings/main process) |
| `i18next-resources-to-backend` | 1.2.3 | MIT | NOT needed (only 2 small JSON files - bundle statically) |
| `i18next-fs-backend` | 2.6.8 | MIT | NOT needed |
| `i18next-icu` | 2.4.4 | MIT | NOT needed (i18next native plurals via `Intl.PluralRules` are enough) |
| `@fontsource-variable/heebo` | 5.3.0 | OFL-1.1 | optional bundled Hebrew+Latin font, package unpacked size ~123 KB |
| `@fontsource-variable/assistant` | 5.3.0 | OFL-1.1 | alternative |
| `@fontsource-variable/rubik` | 5.3.0 | OFL-1.1 | alternative (rounded) |
| `@fontsource-variable/noto-sans-hebrew` | 5.3.0 | OFL-1.1 | alternative |
| `react` | 19.3.0 | MIT | |
| `electron` | 44.4.3 | MIT | Chromium 152 |
| `typescript` | 7.0.2 | Apache-2.0 | accepted by react-i18next peer range |

### Breaking changes that matter (i18next migration guide + changelogs)

- v24: `Intl` API is mandatory (fine in Electron); only JSON v4 plural format (`_one`, `_two`, `_other` ...); `initImmediate` renamed to `initAsync`; TypeScript >= 5 only.
- v25.4: new selector API (`enableSelector` in `CustomTypeOptions`); still opt-in in 26.x (default `false`, values `false | true | 'optimize' | 'strict'`). The docs state a tentative plan to deprecate string keys at the type level in v27 - not a concern for this project now; plain string keys `t('dashboard.title')` are fine.
- v26.0: removed `initImmediate`, removed legacy `interpolation.format` function (use `i18next.services.formatter.add(name, fn)`), removed `showSupportNotice`, removed `simplifyPluralSuffix`.
- react-i18next 17.0.0: only `<Trans>` auto-generated keys with kept basic HTML nodes changed (`<strong>{{name}}</strong>` no longer serialised as `<1>`). 16.3.3+: `useTranslation` compatible with React Compiler; 16.3.4: React 19 ref handling in `<Trans>`.

Sources: https://www.i18next.com/misc/migration-guide , https://github.com/i18next/i18next/blob/master/CHANGELOG.md , https://github.com/i18next/react-i18next/blob/master/CHANGELOG.md

---

## 3. File layout

```
src/
  shared/
    locales/
      en.json            <- source language, drives TS key types
      he.json
    i18n/
      languages.ts       <- SUPPORTED = ['en','he'], resolveLanguage(), localeFor()
      bidi.ts            <- isolate(), ltr(), detectDir(), detectLanguage()
      format.ts          <- Intl date/time/list/number helpers
  main/
    i18n.ts              <- main-process i18next instance (tray, dialogs, notifications)
    tray.ts              <- buildTrayMenu(t) rebuilt on language change
  renderer/
    i18n.ts              <- react-i18next init + <html dir/lang> sync
    @types/i18next.d.ts  <- CustomTypeOptions
    styles/              <- logical-properties-only CSS
```

Why one namespace: the whole app is < 250 strings. Namespaces, lazy loading and HTTP/fs backends only add async init and failure modes. Static import means `init` is synchronous (`initAsync: false`) and there is no flash of untranslated keys.

Parity check (recommended unit test): flatten both JSON files and assert identical key sets, except that `he` must additionally have `_two` for every key that has `_one`/`_other`.

---

## 4. Code shapes

### 4.1 Shared language helpers (`src/shared/i18n/languages.ts`)

```ts
export const SUPPORTED = ['en', 'he'] as const;
export type UiLang = (typeof SUPPORTED)[number];
export type LangSetting = 'system' | UiLang;

/** preferred = app.getPreferredSystemLanguages() in main. */
export function resolveLanguage(setting: LangSetting, preferred: string[]): UiLang {
  if (setting !== 'system') return setting;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'he' || base === 'iw') return 'he';   // 'iw' = legacy code for Hebrew
    if (base === 'en') return 'en';
  }
  return 'en';
}

/** Locale used for Intl formatting. en-IL = English words + Israeli conventions (24h, d/m, Sunday). */
export const localeFor = (lng: UiLang) => (lng === 'he' ? 'he-IL' : 'en-IL');
```

`app.getPreferredSystemLanguages()` returns the user's Windows language list, most preferred first; `app.getLocale()` is Chromium's UI locale and only valid after `ready` (https://www.electronjs.org/docs/latest/api/app).

### 4.2 Renderer init (`src/renderer/i18n.ts`)

```ts
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@shared/locales/en.json';
import he from '@shared/locales/he.json';
import { SUPPORTED, type UiLang } from '@shared/i18n/languages';

function applyDocumentLanguage(lng: string) {
  const root = document.documentElement;
  root.lang = lng;
  root.dir = i18next.dir(lng);            // 'rtl' for he, 'ltr' for en
}

export function initI18n(initial: UiLang) {
  i18next.on('languageChanged', applyDocumentLanguage);
  void i18next.use(initReactI18next).init({
    resources: { en: { translation: en }, he: { translation: he } },
    lng: initial,
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED],
    initAsync: false,                       // resources are in-memory -> synchronous init
    interpolation: { escapeValue: false },  // React already escapes
    returnNull: false,
  });
  // Bidi-isolating formatter for plain-string interpolation: t('x', { name }) with "{{name, bdi}}"
  i18next.services.formatter?.add('bdi', (value) => `⁨${String(value)}⁩`); // FSI ... PDI
  applyDocumentLanguage(initial);
  return i18next;
}
```

`i18next.dir(lng)` is documented: returns `'rtl'` or `'ltr'` (https://www.i18next.com/overview/api).

Avoiding a wrong-direction flash on startup: main resolves the language BEFORE creating the window and passes it via `webPreferences.additionalArguments: ['--ui-lang=he']` (read in preload from `process.argv`) or a synchronous preload getter; `index.html` ships with no `dir`, and `initI18n()` runs before `createRoot().render()`.

### 4.3 Runtime switch + persistence (IPC contract)

```
renderer: window.api.settings.setLanguage('he' | 'en' | 'system')
main:     settings.set('ui.language', value)                 // persist (JSON settings store in userData)
          const lng = resolveLanguage(value, app.getPreferredSystemLanguages())
          await mainI18n.changeLanguage(lng)
          rebuildTray()                                      // Menu.buildFromTemplate again + tray.setToolTip
          mainWindow.setTitle(mainI18n.t('app.name'))
          for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ui:languageChanged', lng)
renderer: window.api.onLanguageChanged(lng => i18next.changeLanguage(lng))
          // react-i18next re-renders every useTranslation() consumer; 'languageChanged' handler flips <html dir>
```

No restart is needed. `changeLanguage` returns a Promise; v25 fixed ordering of concurrent calls.

Language switcher UI: always show each language in its own name, never translated: `English` / `עברית`. Put `lang="he"` / `lang="en"` on the option labels so the right font/shaping is used.

### 4.4 Main-process instance (`src/main/i18n.ts`)

```ts
import i18next from 'i18next';
import en from '../shared/locales/en.json';
import he from '../shared/locales/he.json';
export const mainI18n = i18next.createInstance();
export async function initMainI18n(lng: 'en' | 'he') {
  await mainI18n.init({
    resources: { en: { translation: en }, he: { translation: he } },
    lng, fallbackLng: 'en', initAsync: false,
    interpolation: { escapeValue: false },
  });
  mainI18n.services.formatter?.add('bdi', (v) => `⁨${String(v)}⁩`);
}
```

Use `createInstance()` so main and any in-process tests never share global state.

### 4.5 TypeScript key safety (`src/renderer/@types/i18next.d.ts`)

```ts
import 'i18next';
import type en from '@shared/locales/en.json';
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
```

Requires `resolveJsonModule: true`, `strict: true`, recommended `skipLibCheck: true` (https://www.i18next.com/overview/typescript). The same `.d.ts` must be visible to the main-process tsconfig.

### 4.6 Plurals

i18next uses `Intl.PluralRules`. Local probe (CLDR 48): `new Intl.PluralRules('he').resolvedOptions().pluralCategories` = `['one','two','other']` (the old `many` category is gone). So:

- English keys: `key_one`, `key_other`.
- Hebrew keys: `key_one`, `key_two`, `key_other`. Hebrew has a real dual: "הודעה אחת" / "שתי הודעות" / "5 הודעות". If `_two` is missing i18next falls back to `_other` ("2 הודעות") which is acceptable but less natural.

Call as `t('dashboard.pendingCount', { count })`.

---

## 5. Direction and CSS: one stylesheet for both directions

### 5.1 Rules

1. Set direction ONLY in markup: `<html lang="he" dir="rtl">`. Do not use the CSS `direction` property for layout (MDN and W3C both say authors should use the `dir` attribute; `unicode-bidi` is the exception for user text, see section 6).
2. Never write physical `left/right` in CSS. Add a stylelint rule to enforce it (`stylelint-use-logical` or `csstools/use-logical`; plugin/version **UNVERIFIED**, pick at implementation time).
3. Flexbox and Grid follow `dir` automatically (`row` starts at the right in RTL). Do not add `row-reverse` for RTL.

### 5.2 Physical -> logical mapping

| Physical | Logical |
|---|---|
| `margin-left / margin-right` | `margin-inline-start / margin-inline-end` |
| `padding-left/right` | `padding-inline-start/end`, shorthand `padding-inline: 12px 16px` |
| `left / right` (positioned) | `inset-inline-start / inset-inline-end` |
| `border-left`, `border-top-left-radius` | `border-inline-start`, `border-start-start-radius` |
| `text-align: left/right` | `text-align: start/end` |
| `float: left` | `float: inline-start` |
| `width/height` (when flow-relative) | `inline-size / block-size` |
| `scroll-margin-left` | `scroll-margin-inline-start` |

All of these are long-standing in Chromium, no concern for Electron 44 / Chromium 152.

### 5.3 Things that do NOT flip automatically

- `transform: translateX(...)`, `background-position: left ...`, `box-shadow` x-offset, linear-gradient angles, `clip-path`: use a custom property, e.g. `--dir: 1` and `:dir(rtl) { --dir: -1 }`, then `translateX(calc(var(--dir) * 8px))`.
- Slide-in animations for the toast/side panel: same `--dir` trick.
- Directional icons (back/forward chevrons, "send" paper plane, "open in" arrow): mirror with
  ```css
  .icon--directional:dir(rtl) { transform: scaleX(-1); }
  ```
  `:dir()` is Baseline since Dec 2023 (Chrome 120) and, unlike `[dir="rtl"]`, matches inherited and `dir="auto"` directionality (https://developer.mozilla.org/en-US/docs/Web/CSS/:dir).
- Do NOT mirror: check marks, clocks, the WhatsApp / Google / Claude / Gemini logos, the QR code image, media-style icons, the download progress percentage text.
- Progress bar: a `<progress>` element or a flex child sized by `inline-size` fills from the right in RTL, which is correct for Hebrew.

### 5.4 Base CSS shape

```css
:root { --font-ui: "Segoe UI", system-ui, sans-serif; --dir: 1; }
:root:dir(rtl) { --dir: -1; }
html:lang(he) { --font-ui: "Heebo Variable", "Segoe UI", system-ui, sans-serif; } /* only if Heebo is bundled */
body { font-family: var(--font-ui); text-align: start; }

.card            { padding-inline: 16px; border-inline-start: 3px solid var(--accent); }
.card__actions   { display: flex; gap: 8px; justify-content: flex-end; } /* flex-end = left in RTL: correct */
.card__time      { font-variant-numeric: tabular-nums; }

/* user-generated text never inherits UI direction */
.msg-text        { unicode-bidi: plaintext; text-align: start; white-space: pre-wrap; overflow-wrap: anywhere; }
```

---

## 6. Bidi pitfalls with mixed Hebrew / English / numbers

The UI language and the CONTENT language are independent: a Hebrew UI will show English chats and vice versa. Every piece of user data must be directionally isolated.

### 6.1 Message bubbles and draft text

- Wrap each message paragraph in an element with `dir="auto"` (first-strong detection per element) - W3C's recommendation for runtime content of unknown direction (https://www.w3.org/International/articles/inline-bidi-markup/).
- For multi-line messages either split on `\n` and render each line as `<div dir="auto">`, or put the whole text in one `white-space: pre-wrap` element with `unicode-bidi: plaintext`, which applies the Unicode Bidi Algorithm rules P2/P3 per paragraph (https://developer.mozilla.org/en-US/docs/Web/CSS/unicode-bidi). MDN warns that `unicode-bidi` is generally not for authors; displaying pre-formatted plain text is exactly the exception it names. With `plaintext`, `text-align: start` follows each paragraph's own direction (**UNVERIFIED** in Chromium 152 - check visually; if it fails use the split-lines approach).
- Draft editor: `<textarea dir="auto">` so the caret and alignment follow what the user/LLM wrote.
- Known weakness of first-strong: "OK נתראה בחמש" is detected LTR because of the leading "OK". WhatsApp itself behaves the same, so it is acceptable. Optional upgrade: `detectDir(text)` in `bidi.ts` that strips URLs/emoji/digits and picks the MAJORITY of strong characters, then sets `dir` explicitly.

```ts
const HEB = /\p{Script=Hebrew}/gu, LAT = /\p{Script=Latin}/gu;
export function detectDir(text: string): 'rtl' | 'ltr' {
  const clean = text.replace(/https?:\/\/\S+/g, '');
  const h = clean.match(HEB)?.length ?? 0, l = clean.match(LAT)?.length ?? 0;
  return h >= l && h > 0 ? 'rtl' : 'ltr';
}
```

### 6.2 Names interpolated into UI sentences

Problem: "ההודעה תישלח אל John Smith (2)." or English UI + Hebrew name followed by a number/punctuation: neutrals and digits attach to the wrong run and appear on the wrong side.

- In React: use `<Trans>` with `<bdi>`:
  ```tsx
  <Trans i18nKey="item.confirmSend.body" values={{ name }} components={{ bdi: <bdi /> }} />
  // he.json: "ההודעה תישלח אל <bdi>{{name}}</bdi> ב-WhatsApp."
  ```
  `<bdi>` without `dir` behaves like `dir="auto"` and isolates the content from its surroundings (W3C article above).
- In plain strings (tray tooltip, `Notification` body, `dialog.showMessageBox` message, `title` attributes): wrap the value in FSI `U+2068` ... PDI `U+2069` - the `{{name, bdi}}` formatter from 4.2 does this. W3C lists FSI as the character equivalent of `dir="auto"`.
  **UNVERIFIED**: whether legacy Win32 surfaces (tray tooltip, classic message box) honour the isolate characters (Unicode 6.3). If they render as boxes or are ignored, fall back to `U+200E` LRM / `U+200F` RLM marks after the name. Test on the target machine.

### 6.3 Phone numbers and JIDs

`+972 54-123-4567` inside an RTL paragraph is reordered to something like `4567-123-54 972+` because `+`, `-` and spaces are weak/neutral separators between number runs.

- Always render as `<bdi dir="ltr">+972 54-123-4567</bdi>` (or `<span dir="ltr">`), in both UI languages.
- In plain strings: `⁦` (LRI) + number + `⁩` (PDI). Export `ltr(s)` from `bidi.ts`.
- Same for e-mail addresses, URLs, file paths, model file names (`*.gguf`), version numbers, API keys.

### 6.4 Times, ranges, dates

- A single time `17:00` is safe (`:` between digits is a common separator and stays inside the number).
- A range `17:00–18:00` in an RTL paragraph is displayed with the two numbers ordered right-to-left (the en dash is neutral and takes the paragraph direction), so it reads `18:00–17:00` to an LTR eye. Local probe: `Intl.DateTimeFormat('he-IL').formatRange()` returns `"17:00–18:00"` with NO embedded direction marks. Decision: wrap ranges in `<bdi>`; an all-neutral/number string under `dir=auto` resolves to LTR, so the range always reads `17:00–18:00` left-to-right, which is the common convention in Hebrew calendar apps (Google Calendar Hebrew UI does the same - **UNVERIFIED**, from memory).
- Full Hebrew dates from Intl ("יום חמישי, 24 בספטמבר 2026 בשעה 17:00") are safe inside RTL. Inside an ENGLISH UI sentence they must be wrapped in `<bdi>`, and vice versa.
- Negative numbers: `Intl.NumberFormat('he-IL').format(-5)` already prefixes `U+200E`; do not strip it.
- Percent: he-IL gives `42%` (same as English) - fine for the download progress label, but wrap in `<bdi>` when placed inside a Hebrew sentence.

### 6.5 Punctuation / typography inside he.json

- Hebrew quotation: use gershayim `״` (U+05F4) and geresh `׳` (U+05F3), e.g. `אחה״צ`, `יום ה׳`. This also avoids escaping ASCII `"` inside JSON.
- Prefix + Latin word: `ב-WhatsApp`, `ל-Google` with ASCII hyphen is the normal modern convention (maqaf `־` U+05BE is the formal form; do not mix both).
- Breadcrumb arrows: arrows are NOT mirrored by the bidi algorithm. Use `←` in he.json ("הגדרות ← מכשירים מקושרים") and `→`/`>` in en.json. Avoid `›`/`»` - those ARE bidi-mirrored characters and flip by themselves, which confuses translators.
- Ellipsis: `…` (U+2026) in both files.
- Keep brand names in Latin: WhatsApp, Google, Claude, Gemini, QR, API.

### 6.6 Test strings (put in a Storybook page / dev fixture)

```
he UI + "John Smith (2)"            en UI + "דנה כהן (2)"
"OK נתראה ב-17:30 ב-Aroma"          "Let's meet at קפה נחת at 5?"
"+972 54-123-4567"                  "https://example.com/path?x=1 תסתכל"
"מחר 17:00–18:00"                   "😀 קפה?"   (emoji-first message)
```

---

## 7. Fonts for Hebrew on Windows 11

### 7.1 System font (recommended default)

- **Segoe UI** supports Hebrew. Microsoft's font page lists script tags `'Latn','Grek','Cyrl','Armn','Geor','Geok','Arab','Hebr','Lisu'` and code page `1255 Hebrew` (https://learn.microsoft.com/en-us/typography/font-list/segoe-ui). Hebrew was added in the 2011 (Windows 8) revision (https://en.wikipedia.org/wiki/Segoe).
- **Segoe UI Variable** (the Windows 11 shell font): Hebrew coverage **UNVERIFIED** (Microsoft's per-font page returned 404). This does not matter in practice: if a font in the `font-family` list lacks Hebrew glyphs Chromium falls back per-glyph to the next family, so the stack `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` is safe. Simplest and most predictable: `"Segoe UI", system-ui, sans-serif`.
- Segoe UI is NOT redistributable (Microsoft page: "Exclusively included with Microsoft products"). Reference it by name only; never copy the TTF into the app. Fine for a Windows-only app.

### 7.2 Optional bundled font (all OFL-1.1, Hebrew + Latin subsets, variable weight)

| Font | npm (v5.3.0) | CSS family | Character |
|---|---|---|---|
| **Heebo** | `@fontsource-variable/heebo` | `"Heebo Variable"` | Hebrew by Oded Ezer designed to pair with Roboto (its Latin is Roboto). Neutral, the de-facto Israeli product-UI font. wght 100-900. Upstream https://github.com/OdedEzer/heebo |
| Assistant | `@fontsource-variable/assistant` | `"Assistant Variable"` | Lighter, slightly condensed; Latin derived from Source Sans. wght 200-800. |
| Rubik | `@fontsource-variable/rubik` | `"Rubik Variable"` | Rounded corners, friendlier/less neutral. |
| Noto Sans Hebrew | `@fontsource-variable/noto-sans-hebrew` | `"Noto Sans Hebrew Variable"` | Hebrew-only companion to Noto Sans. |

Recommendation if bundling: **Heebo** - one family covers both scripts with matching weights, so mixed he/en lines do not look patched together.

```ts
// renderer entry - Vite/webpack copies the woff2 files into the bundle
import '@fontsource-variable/heebo';        // defines font-family "Heebo Variable" (fontsource README)
```

- CSP: `font-src 'self'`. No Google Fonts CDN (offline-capable app, privacy).
- OFL-1.1 obligations: ship the license text + copyright ("Copyright 2014 The Heebo Project Authors") in the app's third-party notices; do not sell the font by itself. The fontsource package contains the LICENSE file.
- Exact family names for Assistant/Rubik/Noto follow the fontsource `"<Name> Variable"` convention - confirmed for Heebo from its README; the other three are **UNVERIFIED** (check each package README).

### 7.3 Hebrew typography rules for the stylesheet

- Hebrew has no italics and no upper case. Do not use `font-style: italic` (Chromium synthesises an ugly slant) or `text-transform: uppercase`/small caps for hierarchy; use weight and size.
- Avoid `letter-spacing` on Hebrew.
- Hebrew x-height looks smaller than Latin at the same size: use 14-15px base and `line-height: 1.5`.
- `font-variant-numeric: tabular-nums` for time columns.
- Niqqud (vowel points) is not used in UI text; no special handling.

---

## 8. Date and time formatting (Intl)

### 8.1 Verified behaviour (Node 24.19, ICU 78.3, CLDR 48; input 2026-09-24T14:00Z, tz Asia/Jerusalem)

| Call | Output |
|---|---|
| `he-IL`, `{dateStyle:'full', timeStyle:'short'}` | `יום חמישי, 24 בספטמבר 2026 בשעה 17:00` |
| `en-IL`, same | `Thursday, 24 September 2026 at 17:00` |
| `en-US`, same | `Thursday, September 24, 2026 at 5:00 PM` (do NOT use en-US) |
| `he-IL`, `{weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'}` | `יום ה׳, 24 בספט׳, 17:00` |
| `he-IL` `dateStyle:'short'` / `'medium'` | `24.9.2026` / `24 בספט׳ 2026` |
| `he-IL` `formatRange` (1h) | `17:00–18:00` (no bidi marks - see 6.4) |
| resolved `hourCycle` for `he-IL` and `en-IL` | `h23` |
| `new Intl.Locale('he-IL').getWeekInfo()` | `{ firstDay: 7, weekend: [5, 6] }` - week starts Sunday, weekend Fri-Sat. Same for `en-IL`. |
| `Intl.RelativeTimeFormat('he', {numeric:'auto'})` | `אתמול`, `היום`, `מחר`, `מחרתיים`, `לפני 5 דקות` |
| same, value 2 hours | `לפני שעתיים (2)` - CLDR 48 appends "(2)" to dual forms. Ugly. |
| `Intl.ListFormat('he')` | `דנה, Yossi ומיכל` |
| Default calendar for `he-IL` | `gregory` (Hebrew calendar only on request via `-u-ca-hebrew`) |
| DST | 24 Sep 2026 = GMT+3 (IDT); 25 Oct 2026 10:00 = GMT+2 (IST). Transition is the last Sunday of October. |

### 8.2 Helper shape (`src/shared/i18n/format.ts`)

```ts
export function makeFormatters(lng: UiLang, timeZone = 'Asia/Jerusalem') {
  const locale = localeFor(lng);                         // 'he-IL' | 'en-IL'
  const base = { timeZone, hourCycle: 'h23' as const };
  return {
    time:      new Intl.DateTimeFormat(locale, { ...base, hour: '2-digit', minute: '2-digit' }),
    dayShort:  new Intl.DateTimeFormat(locale, { ...base, weekday: 'short', day: 'numeric', month: 'short' }),
    full:      new Intl.DateTimeFormat(locale, { ...base, dateStyle: 'full', timeStyle: 'short' }),
    relative:  new Intl.RelativeTimeFormat(lng, { numeric: 'auto' }),
    list:      new Intl.ListFormat(lng, { type: 'conjunction' }),
    firstDay:  weekInfo(locale).firstDay,                // 7 = Sunday
  };
}
function weekInfo(locale: string) {
  const l = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => any; weekInfo?: any };
  return l.getWeekInfo?.() ?? l.weekInfo ?? { firstDay: 7, weekend: [5, 6] };
}
```

Rules:
- Always pass `timeZone` explicitly. Default setting value = `Intl.DateTimeFormat().resolvedOptions().timeZone` at first run (will be `Asia/Jerusalem` on the user's machine), editable in settings. Store instants as UTC ISO strings; pass `timeZone: 'Asia/Jerusalem'` (IANA name, never a fixed `+03:00`) to the calendar MCP tool so DST is handled by Google.
- Recreate the formatters on `languageChanged` (memoise per `lng + timeZone`).
- Because of the `(2)` quirk, either use relative time only for day granularity (`אתמול/היום/מחר/מחרתיים`) and show absolute times otherwise, or use own plural strings via i18next (`time.hoursAgo_one/_two/_other` - included in the key set below). Behaviour in Chromium 152's ICU is **UNVERIFIED**.
- Do not depend on `navigator.language` / default locale: Chromium's locale is fixed at process start by the OS language or the `--lang` switch and does not change when the user flips the in-app language.

### 8.3 Hebrew date vocabulary the LLM prompt must know (for the prompt/extraction agents)

| Hebrew in chat | Meaning |
|---|---|
| יום ראשון / א׳ ... יום שבת | Sunday ... Saturday (`יום ה׳` = Thursday, `יום ו׳`/`שישי` = Friday) |
| מחר / מחרתיים / אתמול | tomorrow / day after tomorrow / yesterday |
| שבוע הבא / בשבוע הבא | next week (week starts Sunday) |
| בבוקר / בצהריים / אחה״צ (אחר הצהריים) / בערב / בלילה | morning / noon / afternoon / evening / night |
| מוצ״ש (מוצאי שבת) | Saturday night after Shabbat ends |
| סופ״ש (סוף שבוע) | weekend = Friday-Saturday |
| ב-5 / בחמש | "at 5" - almost always 17:00 for social plans; ambiguous -> if no am/pm cue, either assume 17:00 and flag low confidence, or classify as "Information missing" |
| חצי / רבע ל- / ורבע | 5 וחצי = 17:30, רבע ל-6 = 17:45, 5 ורבע = 17:15 |
| ערב חג / חול המועד | holiday eves - leave to the LLM, no calendar logic in app |

The prompt must always inject: current ISO datetime, IANA tz, today's weekday name, and "week starts on Sunday".

---

## 9. Native surfaces: tray, dialogs, notifications, Chromium locale

### 9.1 Tray menu

- Labels come from `mainI18n.t('tray.*')`. Native menus are immutable snapshots: on language change (and whenever the pending count changes) rebuild with `Menu.buildFromTemplate(...)` and call `tray.setContextMenu(menu)` + `tray.setToolTip(...)` again (https://www.electronjs.org/docs/latest/api/tray).
- There is NO Electron API to force RTL layout of a native menu (https://github.com/electron/electron/issues/11912 closed without a solution; older RTL-Windows menu issue https://github.com/electron/electron/issues/2112). Windows lays out native menus RTL only when the Windows display language is RTL. Hebrew labels on an English Windows render correctly shaped but left-aligned. Accept this; a custom frameless-window tray menu is not worth the complexity for 5 items.
- Tooltip is a plain string: use the `bdi` formatter / `ltr()` for any name or number. Keep it short (Windows truncates long tray tooltips; historical limit 127 chars - **UNVERIFIED** for Windows 11).

```ts
function buildTrayMenu(t: TFunction, state: { paused: boolean; pending: number }) {
  return Menu.buildFromTemplate([
    { label: t('tray.open'), click: showMainWindow },
    { label: state.paused ? t('tray.resume') : t('tray.pause'), click: togglePause },
    { type: 'separator' },
    { label: t('tray.settings'), click: openSettings },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}
```

### 9.2 Native dialogs

- Prefer IN-RENDERER modals for all confirmations (approve & send, add to calendar): full RTL/bidi control, consistent styling, and they are part of the approval-first audit trail. Use native dialogs only when no window exists (e.g. fatal bridge error at startup, quit confirmation from tray).
- `dialog.showMessageBox` on Windows: Electron recognises common ENGLISH labels ("Cancel", "Yes", "No", "OK") as standard buttons and turns all other labels into command links; with translated labels the dialog therefore looks different (https://github.com/electron/electron/issues/21537). Fix: always pass `noLink: true`, and always pass explicit `defaultId` and `cancelId` - the automatic `cancelId` detection only matches the English words "cancel"/"no" (https://www.electronjs.org/docs/latest/api/dialog).
  ```ts
  dialog.showMessageBox(win, {
    type: 'question', noLink: true,
    message: t('quit.title'), detail: t('quit.detail'),
    buttons: [t('tray.quit'), t('common.cancel')], defaultId: 1, cancelId: 1,
  });
  ```
- File open/save dialogs are drawn by Windows in the Windows display language; only `title`, `buttonLabel` and filter names are ours. Not needed by this app at present.

### 9.3 Chromium locale (`--lang`)

- `app.commandLine.appendSwitch('lang', 'he')` must run before `ready` (https://www.electronjs.org/docs/latest/api/command-line-switches - "Set a custom locale"). It affects `app.getLocale()`, `navigator.language`, Chromium-provided strings (default context-menu/spellcheck items, `<input type="date">` popup, form validation bubbles) and the renderer's default Intl locale.
- Recommended: at startup read the persisted language setting synchronously and append the switch, so Chromium-owned strings match after the next restart; but NEVER depend on it - the in-app switch works live because every `Intl` call gets an explicit locale and the app avoids Chromium-owned UI (custom context menu, no native date inputs, `noValidate` forms).
- Packaging: Chromium locale `.pak` files live in `locales/`. If trimming with electron-builder's `electronLanguages`, keep both: `electronLanguages: ['en-US', 'he']` (option name from electron-builder docs; exact pak name `he.pak` **UNVERIFIED**).

### 9.4 Notifications and window title

- `new Notification({ title, body })` from main with `mainI18n`; isolate names with the `bdi` formatter. Windows toast alignment for RTL text follows the Windows display language, not the string (**UNVERIFIED**).
- `BrowserWindow.setTitle(t('app.name'))` on language change. `app.setAppUserModelId(...)` stays language-independent.
- The "still running in the tray" balloon/notification shown on the first X-click uses `tray.firstClose.*` keys.

---

## 10. LLM reply language follows the SENDER, not the UI

UI language = what the owner reads in buttons/labels. Reply language = what the CONTACT reads. They are independent; an English-UI user must still get Hebrew drafts for Hebrew chats.

### 10.1 Detection (deterministic, no LLM, no dependency)

```ts
export type ChatLang = 'he' | 'en';
export function detectLanguage(texts: string[], fallback: ChatLang): ChatLang {
  // texts = last 3-5 INBOUND messages of this chat, newest first
  let h = 0, l = 0;
  texts.forEach((t, i) => {
    const w = 1 / (i + 1);                                   // newest message weighs most
    const clean = t.replace(/https?:\/\/\S+/g, '');
    h += w * (clean.match(/\p{Script=Hebrew}/gu)?.length ?? 0);
    l += w * (clean.match(/\p{Script=Latin}/gu)?.length ?? 0);
  });
  if (h === 0 && l === 0) return fallback;                   // emoji / numbers only
  return h >= l ? 'he' : 'en';
}
```

Fallback chain when the inbound text has no letters: language of the owner's own last outgoing messages in that chat -> previously stored `chat.lang` -> UI language.
Script counting is sufficient because only two languages with disjoint scripts are supported. Known gap: transliterated Hebrew in Latin letters ("ma kore, nipagesh machar?") is classified `en`; the cloud LLMs will usually still answer sensibly; accept for v1. Other languages (Russian, Arabic, French): out of scope - classified by the same rule as `en`/`he` fallback; consider "reply in the same language as the sender" as the universal instruction so capable models handle them anyway.

### 10.2 Prompt contract

- System prompt (always English, models follow English instructions best) contains an explicit, computed directive, not "guess the language":
  `Write the draft reply in {{replyLanguageName}} - the language the contact writes in. Match their tone and formality. Keep names, places and brand names in their original script. Do not translate or transliterate.`
- Settings override `settings.replies.language: 'sender' | 'he' | 'en'` (default `'sender'`).
- Hebrew grammatical gender: first-person present-tense verbs are gendered ("אני יכול" / "אני יכולה"). Add an optional setting `settings.replies.userGender: 'm' | 'f' | 'unspecified'` and pass it to the prompt: `The user writes about themself in the {{masculine|feminine}} form.` For the RECIPIENT: `Infer the contact's gender only from earlier messages in this chat; if unknown, prefer gender-neutral phrasing (plural or infinitive forms).`
- Small local models (~4B) are noticeably weaker in Hebrew generation than Claude/Gemini: add 2-3 Hebrew few-shot examples to the local prompt, keep drafts short, and surface the "Edit" action prominently. Model-specific Hebrew quality is for the local-LLM research task; **UNVERIFIED** here.

### 10.3 What the LLM must NOT localise

Everything the UI renders about an item should come back as structured data, not prose, so it can be shown in the UI language:

```jsonc
{
  "category": "needs_reply" | "schedule_candidate" | "info_missing" | "ignore",
  "chatLanguage": "he",
  "missing": ["time", "location"],            // enum codes -> t('item.missing.time')
  "event": { "title": "קפה עם דנה", "start": "2026-09-24T17:00:00+03:00", "end": null, "location": null },
  "draftReply": "סבבה, חמישי ב-17:00 מתאים לי. איפה נפגשים?"   // in SENDER language
}
```

- `draftReply` -> sender language. `event.title` -> default to the chat language (it goes into the owner's own calendar; see open questions). Reason codes, categories, missing fields -> enums, localised by i18next.
- Free-text "why" explanations, if ever added, should be requested in the UI language (`Explain in {{uiLanguageName}}`).

---

## 11. Starter key set

Conventions used:
- Hebrew buttons/menu items use the gender-neutral ACTION NOUN (שם פעולה): "שליחה", "עריכה", "הוספה" - not the masculine imperative "שלח".
- Hebrew instructions addressed to the user use the PLURAL imperative ("סרקו", "בחרו"), which is gender-neutral.
- `{{name, bdi}}` = plain-string isolation formatter (4.2). Inside `<Trans>` strings use `<bdi>{{name}}</bdi>`.
- WhatsApp's own Hebrew menu wording ("מכשירים מקושרים", "קישור מכשיר") is from memory - **UNVERIFIED**, check on a Hebrew-language phone before release.

### 11.1 `src/shared/locales/en.json`

```json
{
  "app": {
    "name": "WhatsApp Calendar Agent",
    "tagline": "Drafts replies and calendar events from your chats. Nothing happens without your approval."
  },
  "common": {
    "ok": "OK", "cancel": "Cancel", "save": "Save", "close": "Close", "back": "Back", "next": "Next",
    "skip": "Skip for now", "retry": "Try again", "done": "Done", "loading": "Loading…",
    "copy": "Copy", "copied": "Copied", "learnMore": "Learn more", "yes": "Yes", "no": "No",
    "stepOf": "Step {{current}} of {{total}}"
  },
  "nav": { "dashboard": "Dashboard", "settings": "Settings" },
  "status": {
    "whatsapp": { "connected": "WhatsApp connected", "connecting": "Connecting to WhatsApp…", "disconnected": "WhatsApp disconnected", "needsPairing": "WhatsApp not linked" },
    "google": { "connected": "Google Calendar connected", "disconnected": "Google Calendar not connected" },
    "llm": { "ready": "{{provider}} ready", "loading": "Loading model…", "unavailable": "AI model unavailable" },
    "paused": "Monitoring paused"
  },
  "dashboard": {
    "title": "Dashboard",
    "approvalNotice": "No message is sent and no event is created without your approval.",
    "refresh": "Refresh",
    "lastUpdated": "Updated {{time}}",
    "showAll": "Show all",
    "pendingCount_one": "{{count}} item waiting for you",
    "pendingCount_other": "{{count}} items waiting for you",
    "lists": {
      "needsReply": { "title": "Needs reply", "hint": "Messages waiting for your answer, with a suggested draft.", "empty": "All caught up - nothing to reply to." },
      "inCalendar": { "title": "In calendar", "hint": "Appointments you approved and added to Google Calendar.", "empty": "No events added yet." },
      "infoMissing": { "title": "Information missing", "hint": "Plans that still lack a date, time or place.", "empty": "No open plans with missing details." }
    }
  },
  "item": {
    "from": "From {{name, bdi}}",
    "draftLabel": "Suggested reply",
    "suggestedEvent": "Suggested event",
    "when": "When", "where": "Where", "with": "With",
    "missingLabel": "Missing: {{fields}}",
    "missing": { "date": "date", "time": "time", "location": "place", "duration": "duration", "participants": "participants" },
    "calendarFree": "You are free at this time",
    "calendarConflict": "Conflicts with <bdi>{{title}}</bdi>",
    "actions": {
      "approveSend": "Approve & send",
      "edit": "Edit",
      "dismiss": "Dismiss",
      "addToCalendar": "Add to calendar",
      "askDetails": "Ask for details",
      "askDetailsHint": "Draft a message asking for the missing details",
      "regenerate": "Rewrite draft",
      "openInCalendar": "Open in Google Calendar",
      "undo": "Undo"
    },
    "confirmSend": { "title": "Send this message?", "body": "It will be sent to <bdi>{{name}}</bdi> on WhatsApp.", "confirm": "Send" },
    "confirmEvent": { "title": "Add this event to your calendar?", "body": "<bdi>{{title}}</bdi> - <bdi>{{when}}</bdi>", "confirm": "Add" },
    "toast": {
      "sent": "Message sent", "sendFailed": "Couldn't send the message",
      "added": "Added to calendar", "addFailed": "Couldn't add the event",
      "dismissed": "Dismissed"
    }
  },
  "time": {
    "allDay": "All day",
    "minutesAgo_one": "a minute ago", "minutesAgo_other": "{{count}} minutes ago",
    "hoursAgo_one": "an hour ago", "hoursAgo_other": "{{count}} hours ago"
  },
  "onboarding": {
    "welcome": { "title": "Welcome", "body": "Four short steps: link WhatsApp, connect Google Calendar, choose an AI model, and you're set.", "start": "Get started" },
    "whatsapp": {
      "title": "Link WhatsApp",
      "step1": "Open WhatsApp on your phone",
      "step2": "Go to Settings → Linked devices",
      "step3": "Tap \"Link a device\"",
      "step4": "Point the camera at the code shown here",
      "waiting": "Waiting for scan…",
      "expired": "The code expired",
      "refreshQr": "Show a new code",
      "connected": "WhatsApp linked",
      "privacy": "Your messages are stored on this computer only."
    },
    "google": {
      "title": "Connect Google Calendar",
      "body": "A browser window will open so you can sign in to Google and allow calendar access.",
      "connect": "Connect Google account",
      "waitingBrowser": "Waiting for you to finish in the browser…",
      "connected": "Connected as {{email, bdi}}",
      "failed": "The connection didn't complete"
    },
    "llm": {
      "title": "Choose an AI model",
      "body": "You can change this later in Settings.",
      "local": { "name": "Local (on this computer)", "desc": "Runs entirely on your computer; messages never leave it. One-time download of about {{size}}." },
      "claude": { "name": "Claude", "desc": "Anthropic's cloud model. Requires an API key." },
      "gemini": { "name": "Gemini", "desc": "Google's cloud model. Requires an API key." },
      "cloudNotice": "With Claude or Gemini, the content of relevant messages is sent to the provider for analysis.",
      "recommended": "Recommended",
      "apiKeyLabel": "API key",
      "apiKeyPlaceholder": "Paste your key here",
      "testKey": "Test key", "keyValid": "Key works", "keyInvalid": "Key isn't valid"
    },
    "download": {
      "title": "Download the model",
      "detected": "Detected: {{ram}} GB memory, {{gpu}}",
      "noGpu": "no dedicated GPU",
      "tierSmall": "Compact model - suited to this computer",
      "tierLarge": "Larger model - more accurate, suited to this computer",
      "size": "Download size: {{size}}",
      "start": "Download",
      "progress": "{{done}} of {{total}}",
      "speed": "{{speed}}/s",
      "eta": "About {{time}} left",
      "pause": "Pause", "resume": "Resume", "cancel": "Cancel download",
      "verifying": "Verifying file…",
      "done": "Model ready",
      "failed": "Download failed",
      "diskSpace": "Not enough disk space. {{size}} required."
    },
    "finish": { "title": "All set", "body": "The app keeps running in the background and shows here what needs your attention.", "open": "Open dashboard" }
  },
  "settings": {
    "title": "Settings",
    "general": {
      "title": "General",
      "language": "Interface language", "languageSystem": "Same as Windows",
      "startWithWindows": "Start with Windows",
      "closeToTray": "Closing the window keeps the app running in the tray",
      "timezone": "Time zone"
    },
    "llm": { "title": "AI model", "provider": "Provider", "localModel": "Local model", "changeModel": "Change model", "deleteModel": "Delete downloaded model", "apiKey": "API key" },
    "replies": {
      "title": "Replies",
      "language": "Reply language",
      "languageSender": "Same as the sender (recommended)", "languageHe": "Always Hebrew", "languageEn": "Always English",
      "userGender": "How I refer to myself in Hebrew",
      "userGenderHint": "In Hebrew, first-person verbs differ by gender.",
      "genderM": "Masculine", "genderF": "Feminine", "genderNone": "No preference"
    },
    "whatsapp": { "title": "WhatsApp", "linkedAs": "Linked as {{phone}}", "relink": "Link again", "unlink": "Unlink this device", "ignoreGroups": "Ignore group chats" },
    "calendar": { "title": "Google Calendar", "account": "Account", "defaultCalendar": "Add events to", "defaultDuration": "Default event length", "minutes": "{{count}} minutes", "disconnect": "Disconnect Google" },
    "about": { "title": "About", "version": "Version {{version}}", "licenses": "Open-source licenses" }
  },
  "tray": {
    "tooltip": "WhatsApp Calendar Agent",
    "tooltipPending_one": "WhatsApp Calendar Agent - {{count}} item waiting",
    "tooltipPending_other": "WhatsApp Calendar Agent - {{count}} items waiting",
    "open": "Open dashboard",
    "pause": "Pause monitoring",
    "resume": "Resume monitoring",
    "settings": "Settings",
    "quit": "Quit",
    "firstClose": { "title": "Still running in the background", "body": "Find the app under the hidden icons in the taskbar. To quit completely, right-click the icon and choose Quit." }
  },
  "quit": { "title": "Quit WhatsApp Calendar Agent?", "detail": "New messages won't be monitored until you open the app again." },
  "notifications": {
    "needsReply": { "title": "Message waiting for a reply", "body": "{{name, bdi}} - a draft is ready for your approval" },
    "suggestion": { "title": "Suggested calendar event", "body": "{{title, bdi}} - waiting for your approval" }
  },
  "errors": {
    "bridgeDown": "The WhatsApp connection stopped. Trying to reconnect…",
    "llmUnavailable": "The AI model isn't responding.",
    "calendarUnavailable": "Couldn't reach Google Calendar.",
    "network": "No internet connection.",
    "unknown": "Something went wrong."
  }
}
```

### 11.2 `src/shared/locales/he.json`

```json
{
  "app": {
    "name": "WhatsApp Calendar Agent",
    "tagline": "טיוטות תשובה ואירועי יומן מתוך השיחות שלך. שום דבר לא קורה בלי אישור שלך."
  },
  "common": {
    "ok": "אישור", "cancel": "ביטול", "save": "שמירה", "close": "סגירה", "back": "חזרה", "next": "המשך",
    "skip": "לא עכשיו", "retry": "ניסיון חוזר", "done": "סיום", "loading": "טוען…",
    "copy": "העתקה", "copied": "הועתק", "learnMore": "מידע נוסף", "yes": "כן", "no": "לא",
    "stepOf": "שלב {{current}} מתוך {{total}}"
  },
  "nav": { "dashboard": "לוח בקרה", "settings": "הגדרות" },
  "status": {
    "whatsapp": { "connected": "WhatsApp מחובר", "connecting": "מתחבר ל-WhatsApp…", "disconnected": "WhatsApp מנותק", "needsPairing": "WhatsApp לא מקושר" },
    "google": { "connected": "יומן Google מחובר", "disconnected": "יומן Google לא מחובר" },
    "llm": { "ready": "{{provider}} מוכן", "loading": "המודל נטען…", "unavailable": "מודל הבינה המלאכותית לא זמין" },
    "paused": "המעקב מושהה"
  },
  "dashboard": {
    "title": "לוח בקרה",
    "approvalNotice": "שום הודעה לא נשלחת ושום אירוע לא נוצר בלי אישור שלך.",
    "refresh": "רענון",
    "lastUpdated": "עודכן {{time}}",
    "showAll": "הצגת הכול",
    "pendingCount_one": "פריט אחד מחכה לך",
    "pendingCount_two": "שני פריטים מחכים לך",
    "pendingCount_other": "{{count}} פריטים מחכים לך",
    "lists": {
      "needsReply": { "title": "ממתינות לתשובה", "hint": "הודעות שמחכות לתשובה שלך, עם טיוטה מוצעת.", "empty": "הכול מטופל - אין הודעות שמחכות לתשובה." },
      "inCalendar": { "title": "ביומן", "hint": "פגישות שאישרת ונוספו ליומן Google.", "empty": "עדיין לא נוספו אירועים." },
      "infoMissing": { "title": "חסרים פרטים", "hint": "תוכניות שעדיין חסרים בהן תאריך, שעה או מקום.", "empty": "אין תוכניות פתוחות עם פרטים חסרים." }
    }
  },
  "item": {
    "from": "מאת {{name, bdi}}",
    "draftLabel": "תשובה מוצעת",
    "suggestedEvent": "אירוע מוצע",
    "when": "מתי", "where": "איפה", "with": "עם",
    "missingLabel": "חסר: {{fields}}",
    "missing": { "date": "תאריך", "time": "שעה", "location": "מקום", "duration": "משך", "participants": "משתתפים" },
    "calendarFree": "הזמן הזה פנוי ביומן",
    "calendarConflict": "מתנגש עם ״<bdi>{{title}}</bdi>״",
    "actions": {
      "approveSend": "אישור ושליחה",
      "edit": "עריכה",
      "dismiss": "התעלמות",
      "addToCalendar": "הוספה ליומן",
      "askDetails": "בקשת פרטים",
      "askDetailsHint": "ניסוח הודעה שמבקשת את הפרטים החסרים",
      "regenerate": "ניסוח מחדש",
      "openInCalendar": "פתיחה ביומן Google",
      "undo": "ביטול הפעולה"
    },
    "confirmSend": { "title": "לשלוח את ההודעה?", "body": "ההודעה תישלח אל <bdi>{{name}}</bdi> ב-WhatsApp.", "confirm": "שליחה" },
    "confirmEvent": { "title": "להוסיף את האירוע ליומן?", "body": "״<bdi>{{title}}</bdi>״ - <bdi>{{when}}</bdi>", "confirm": "הוספה" },
    "toast": {
      "sent": "ההודעה נשלחה", "sendFailed": "לא הצלחנו לשלוח את ההודעה",
      "added": "האירוע נוסף ליומן", "addFailed": "לא הצלחנו להוסיף את האירוע",
      "dismissed": "הפריט הוסר מהרשימה"
    }
  },
  "time": {
    "allDay": "כל היום",
    "minutesAgo_one": "לפני דקה", "minutesAgo_two": "לפני שתי דקות", "minutesAgo_other": "לפני {{count}} דקות",
    "hoursAgo_one": "לפני שעה", "hoursAgo_two": "לפני שעתיים", "hoursAgo_other": "לפני {{count}} שעות"
  },
  "onboarding": {
    "welcome": { "title": "ברוכים הבאים", "body": "ארבעה שלבים קצרים: קישור WhatsApp, חיבור יומן Google, בחירת מודל בינה מלאכותית - וזהו.", "start": "מתחילים" },
    "whatsapp": {
      "title": "קישור WhatsApp",
      "step1": "פתחו את WhatsApp בטלפון",
      "step2": "היכנסו אל הגדרות ← מכשירים מקושרים",
      "step3": "הקישו על ״קישור מכשיר״",
      "step4": "כוונו את המצלמה אל הקוד שמוצג כאן",
      "waiting": "ממתין לסריקה…",
      "expired": "פג תוקף הקוד",
      "refreshQr": "הצגת קוד חדש",
      "connected": "WhatsApp קושר בהצלחה",
      "privacy": "ההודעות שלך נשמרות במחשב הזה בלבד."
    },
    "google": {
      "title": "חיבור יומן Google",
      "body": "ייפתח חלון דפדפן שבו אפשר להתחבר ל-Google ולאשר גישה ליומן.",
      "connect": "חיבור חשבון Google",
      "waitingBrowser": "ממתין לסיום התהליך בדפדפן…",
      "connected": "מחובר בתור {{email, bdi}}",
      "failed": "החיבור לא הושלם"
    },
    "llm": {
      "title": "בחירת מודל בינה מלאכותית",
      "body": "אפשר לשנות את הבחירה בכל רגע בהגדרות.",
      "local": { "name": "מקומי (במחשב הזה)", "desc": "פועל כולו במחשב שלך, וההודעות לא יוצאות ממנו. נדרשת הורדה חד-פעמית של כ-{{size}}." },
      "claude": { "name": "Claude", "desc": "מודל ענן של Anthropic. נדרש מפתח API." },
      "gemini": { "name": "Gemini", "desc": "מודל ענן של Google. נדרש מפתח API." },
      "cloudNotice": "בבחירה ב-Claude או ב-Gemini, תוכן ההודעות הרלוונטיות נשלח לספק לצורך ניתוח.",
      "recommended": "מומלץ",
      "apiKeyLabel": "מפתח API",
      "apiKeyPlaceholder": "הדביקו כאן את המפתח",
      "testKey": "בדיקת המפתח", "keyValid": "המפתח תקין", "keyInvalid": "המפתח לא תקין"
    },
    "download": {
      "title": "הורדת המודל",
      "detected": "זוהו: {{ram}} GB זיכרון, {{gpu}}",
      "noGpu": "ללא כרטיס מסך ייעודי",
      "tierSmall": "מודל קומפקטי - מתאים למחשב הזה",
      "tierLarge": "מודל גדול ומדויק יותר - מתאים למחשב הזה",
      "size": "גודל ההורדה: {{size}}",
      "start": "הורדה",
      "progress": "{{done}} מתוך {{total}}",
      "speed": "{{speed}} לשנייה",
      "eta": "נותרו כ-{{time}}",
      "pause": "השהיה", "resume": "המשך", "cancel": "ביטול ההורדה",
      "verifying": "מאמת את הקובץ…",
      "done": "המודל מוכן",
      "failed": "ההורדה נכשלה",
      "diskSpace": "אין מספיק מקום פנוי בדיסק. נדרשים {{size}}."
    },
    "finish": { "title": "הכול מוכן", "body": "האפליקציה ממשיכה לפעול ברקע ומציגה כאן את מה שדורש את תשומת הלב שלך.", "open": "מעבר ללוח הבקרה" }
  },
  "settings": {
    "title": "הגדרות",
    "general": {
      "title": "כללי",
      "language": "שפת הממשק", "languageSystem": "לפי שפת Windows",
      "startWithWindows": "הפעלה אוטומטית עם עליית Windows",
      "closeToTray": "סגירת החלון משאירה את האפליקציה פועלת במגש המערכת",
      "timezone": "אזור זמן"
    },
    "llm": { "title": "מודל בינה מלאכותית", "provider": "ספק", "localModel": "מודל מקומי", "changeModel": "החלפת מודל", "deleteModel": "מחיקת המודל שהורד", "apiKey": "מפתח API" },
    "replies": {
      "title": "תשובות",
      "language": "שפת התשובות",
      "languageSender": "לפי שפת השולח (מומלץ)", "languageHe": "תמיד עברית", "languageEn": "תמיד אנגלית",
      "userGender": "ניסוח בגוף ראשון",
      "userGenderHint": "בעברית פעלים בגוף ראשון מוטים לפי מגדר (״אני יכול״ / ״אני יכולה״).",
      "genderM": "לשון זכר", "genderF": "לשון נקבה", "genderNone": "ללא העדפה"
    },
    "whatsapp": { "title": "WhatsApp", "linkedAs": "מקושר למספר {{phone}}", "relink": "קישור מחדש", "unlink": "ניתוק המכשיר הזה", "ignoreGroups": "התעלמות משיחות קבוצתיות" },
    "calendar": { "title": "יומן Google", "account": "חשבון", "defaultCalendar": "הוספת אירועים ליומן", "defaultDuration": "משך אירוע ברירת מחדל", "minutes": "{{count}} דקות", "disconnect": "ניתוק חשבון Google" },
    "about": { "title": "אודות", "version": "גרסה {{version}}", "licenses": "רישיונות קוד פתוח" }
  },
  "tray": {
    "tooltip": "WhatsApp Calendar Agent",
    "tooltipPending_one": "WhatsApp Calendar Agent - פריט אחד ממתין",
    "tooltipPending_two": "WhatsApp Calendar Agent - שני פריטים ממתינים",
    "tooltipPending_other": "WhatsApp Calendar Agent - {{count}} פריטים ממתינים",
    "open": "פתיחת לוח הבקרה",
    "pause": "השהיית המעקב",
    "resume": "חידוש המעקב",
    "settings": "הגדרות",
    "quit": "יציאה",
    "firstClose": { "title": "האפליקציה ממשיכה לפעול ברקע", "body": "אפשר למצוא אותה בסמלים המוסתרים שבשורת המשימות. ליציאה מלאה: לחיצה ימנית על הסמל ואז ״יציאה״." }
  },
  "quit": { "title": "לצאת מ-WhatsApp Calendar Agent?", "detail": "הודעות חדשות לא ייבדקו עד שהאפליקציה תיפתח שוב." },
  "notifications": {
    "needsReply": { "title": "הודעה ממתינה לתשובה", "body": "{{name, bdi}} - טיוטה מוכנה לאישור שלך" },
    "suggestion": { "title": "הצעה לאירוע ביומן", "body": "{{title, bdi}} - ממתין לאישור שלך" }
  },
  "errors": {
    "bridgeDown": "החיבור ל-WhatsApp נותק. מנסה להתחבר מחדש…",
    "llmUnavailable": "מודל הבינה המלאכותית לא מגיב.",
    "calendarUnavailable": "לא הצלחנו להתחבר ליומן Google.",
    "network": "אין חיבור לאינטרנט.",
    "unknown": "משהו השתבש."
  }
}
```

Notes on the Hebrew:
- `settings.linkedAs` `{{phone}}`: render through `<Trans>` with `<bdi dir="ltr">` or pass `ltr(phone)`; never raw.
- `settings.calendar.minutes` is used with fixed values (30/45/60/90), so no `_one/_two` forms are needed; if 1 or 2 ever become possible, add them.
- "פריט" is a deliberately neutral noun so one counter can cover messages and event suggestions.
- "התעלמות" (Dismiss) was chosen over "מחיקה" because nothing is deleted from WhatsApp; the toast says "הפריט הוסר מהרשימה".
- The app name stays in Latin script in both languages (brand). A Hebrew descriptive name, if wanted: "סוכן היומן ל-WhatsApp".
- A native Hebrew speaker (the user) should review the file once in context; strings were written to be natural but have not been user-tested.

---

## 12. Testing checklist

1. Unit: key-parity test en/he (+ `_two` rule); `resolveLanguage` incl. `iw`; `detectLanguage`/`detectDir` on the fixture strings in 6.6; formatter snapshot tests pinned to `timeZone: 'Asia/Jerusalem'` and both locales (include 2026-10-25 DST change).
2. Visual (Playwright against the renderer): screenshot every screen in `en` and `he`; assert `document.documentElement.dir`; assert no element has computed `margin-left != margin-right` caused by physical properties (or just run stylelint).
3. Manual on Windows 11: tray menu + tooltip in Hebrew, balloon on first close, native quit dialog with `noLink`, notification with a Latin name inside Hebrew text, language switch while the tray menu is open, phone number rendering in Hebrew UI.
4. Pseudo-check for truncation: Hebrew strings are usually SHORTER than English, so English is the layout-stress language here.

---

## 13. Sources

- i18next API (`dir`, `changeLanguage`, `createInstance`, events): https://www.i18next.com/overview/api
- i18next migration guide (v24-v26 breaking changes): https://www.i18next.com/misc/migration-guide
- i18next TypeScript guide: https://www.i18next.com/overview/typescript
- i18next changelog: https://github.com/i18next/i18next/blob/master/CHANGELOG.md
- react-i18next docs / changelog: https://react.i18next.com/getting-started , https://react.i18next.com/latest/usetranslation-hook , https://github.com/i18next/react-i18next/blob/master/CHANGELOG.md
- W3C "Inline markup and bidirectional text in HTML" (`dir`, `dir=auto`, `<bdi>`, RLI/LRI/FSI/PDI): https://www.w3.org/International/articles/inline-bidi-markup/
- MDN `unicode-bidi`: https://developer.mozilla.org/en-US/docs/Web/CSS/unicode-bidi
- MDN `:dir()`: https://developer.mozilla.org/en-US/docs/Web/CSS/:dir
- Microsoft Typography, Segoe UI (script tags incl. `Hebr`, code page 1255, redistribution): https://learn.microsoft.com/en-us/typography/font-list/segoe-ui
- Segoe history (Hebrew added 2011): https://en.wikipedia.org/wiki/Segoe
- Fontsource Heebo (OFL-1.1, Hebrew+Latin, wght 100-900, family "Heebo Variable"): https://fontsource.org/fonts/heebo , https://github.com/fontsource/font-files/tree/main/fonts/variable/heebo , upstream https://github.com/OdedEzer/heebo
- Electron `app` locale APIs: https://www.electronjs.org/docs/latest/api/app
- Electron command-line switches (`--lang`): https://www.electronjs.org/docs/latest/api/command-line-switches
- Electron `dialog` (`buttons`, `noLink`, `cancelId`): https://www.electronjs.org/docs/latest/api/dialog
- Electron localized message-box buttons issue: https://github.com/electron/electron/issues/21537
- Electron `Tray`: https://www.electronjs.org/docs/latest/api/tray
- Electron native menu RTL (no API): https://github.com/electron/electron/issues/11912 , https://github.com/electron/electron/issues/2112
- Electron 44.4.3 release (Chromium 152.0.7977.130, Node 24.21.0): https://releases.electronjs.org/release/v44.4.3
- Local probes: `npm view` and Node 24.19 `Intl` scripts run 2026-09-21 (results in sections 2, 4.6, 8.1).

## 14. UNVERIFIED list (consolidated)

1. Segoe UI Variable's own Hebrew coverage (harmless because of per-glyph fallback to Segoe UI).
2. `text-align: start` following per-paragraph direction under `unicode-bidi: plaintext` in Chromium 152.
3. Whether Win32 tray tooltips / classic message boxes / Windows toasts honour FSI/LRI/PDI isolate characters; and Windows 11 tray tooltip length limit.
4. Renderer (Chromium 152 ICU) output equality with the Node 24 probes, especially the `(2)` dual quirk in `Intl.RelativeTimeFormat('he')`.
5. Font-family names of the Assistant/Rubik/Noto fontsource variable packages; stylelint logical-properties plugin choice.
6. electron-builder `electronLanguages` exact pak identifiers for Hebrew.
7. WhatsApp's exact Hebrew menu wording for "Linked devices" / "Link a device".
8. Hebrew generation quality of the ~4B local model tier (belongs to the local-LLM research task).
9. Google Calendar Hebrew UI convention for time-range direction.
