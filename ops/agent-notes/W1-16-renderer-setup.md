# W1-16-renderer-setup - working notes

Owner of: `src/renderer/src/views/Onboarding/**`, `src/renderer/src/views/Settings.tsx`, `src/renderer/src/views/setup.css`,
`src/renderer/src/components/{QrPairing,ConsentDialog}.tsx` (+ their colocated tests, fixtures and snapshots) and
`src/shared/locales/pending/W1-16-renderer-setup.json`.

Read: build-plan 1, 1.1, 1.2, 6, 7 (W1-16 brief); ARCH 12.1, 12.2, A13, A20; CONTRACTS 1, 4, 8; UX 8, 9, 10, 13, 14, 16;
`docs/research/calendar-mcp.md` 6.3; TESTS 5.3 renderer row; `docs/specs/wave0-seams.md`; `ops/agent-notes/W0-scaffold.md`.

## Fix round (2026-09-23, after `ops/agent-notes/wave1-audit.md`)

The audit found **no genuine defect in W1-16**. The three items the fix round handed me are all rows of audit
section 4.1 whose *target* is **W1-14-renderer-shell** (`src/renderer/src/App.test.tsx`, `tests/setup-renderer.ts`,
`src/renderer/src/i18n.usage.test.ts` are W1-14's by the ownership matrix, row `renderer shell`); I filed them and may
not edit those files. Re-verified state of each on this run:

1. **App.test.tsx onboarding walk** - **fulfilled by W1-14.** `App.test.tsx:52-57` now asserts `welcome-start` is
   disabled, clicks `welcome-accept`, then `welcome-start`, and expects `onboarding:setStep {step:'choose_ai'}`. Green.
2. **Stateful `llm:setProvider` / `secrets:set` / `secrets:clear` fakes** - **fulfilled by W1-14.**
   `tests/setup-renderer.ts` now keeps one module-level `llmState` (rebuilt per `buildMocks()`), mutated by
   `llm:setProvider`, `secrets:set` and `secrets:clear`, plus an exported `getLlmState()`. My tests still teach both
   channels explicitly (they need provider-specific configs), so nothing of mine changed; the trap is gone for everyone.
3. **`i18n.usage.test.ts` allow-lists** - still carries `welcome.` / `ai.` / `pair.` / `google.` and `app.back` /
   `app.close`. Explicitly non-blocking (the test is green either way) and W1-14's file. Left as a standing request.

What I *did* fix in this round, inside my own paths:

- **`LinkWhatsApp.test.tsx` "RTL snapshot" was flaky** (it failed once in a full `--project renderer` run:
  `inline-size: 100%` received vs `0%` expected). Cause is mine and is a *test* race, not a component bug:
  `QrPairing` measures the countdown bar's full scale once per code in an effect, so the bar legitimately reads full
  for one microtask after the QR image appears; the snapshot was taken inside that window. The test now waits for the
  settled width (`.bg-accent` style contains `inline-size: 0%` for the already-expired code of that case) before
  snapshotting. The `.snap` file is unchanged, the component is unchanged, and the assertion was tightened, not
  weakened. 5 consecutive runs of the file and 3 of the whole owned set are green.

Verification after the fix (`$env:PATH` prefixed as required, from `"C:\dev\whatsapp agent"`):

- `npm run typecheck` - **exit 0, repo-wide clean** (the `when.test.ts` TS2532 trio and the `setup-renderer.ts`
  `SecretName` errors seen mid-run are both fixed by their owners).
- `npx eslint <owned .tsx paths> --max-warnings 0` - exit 0. (`views/setup.css` is not matched by the flat config, so it
  is linted by nothing; passing it explicitly produces the "File ignored" warning - config is W0/W2-01's, not a defect.)
- `npx vitest run --project renderer` (whole project) - **30 files, 422 tests, green**, twice in a row.
- Owned tests alone - 8 files, 137 tests, green, three times in a row.
- Coverage over my files (fresh run, v8): statements 91.65 %, **branches 83.08 %**, functions 86.84 %, **lines 94.25 %**
  - thresholds 75/70/75.
- `npx prettier --check` on the file I touched still reports the two pre-existing unformatted `mockInvoke(...)` calls
  (repo-wide condition, W2-01's single pass per audit 2.3); the lines I added are already Prettier-shaped.

## State

Done. Every owned file is implemented, no `NotImplementedError` anywhere in them.

- `npx tsc -b tsconfig.web.json tsconfig.tests.json` - **no error in any file I own** (errors elsewhere: see "Other packages" below).
- `npx eslint <all owned paths> --max-warnings 0` - clean (exit 0).
- `npx vitest run --project renderer <owned paths>` - 8 files, 137 tests, all green (6 RTL snapshots written).
- Coverage over my files (v8, renderer project): **lines 94.26 %, branches 83.09 %, functions 86.84 %** - thresholds are 75/70/75.
  Per file: `frame.tsx` 100/100/100, `Welcome.tsx` 100/100/100, `LinkWhatsApp.tsx` 100/95/100, `Ready.tsx` 100/87/100,
  `GoogleWizard.tsx` 96/87/91, `ChooseAi.tsx` 89/77/79, `Settings.tsx` 94/79/81, `QrPairing.tsx` 100/97/100,
  `ConsentDialog.tsx` 95/75/87.

Files:

| File | What it is |
|---|---|
| `views/Onboarding/frame.tsx` | private chrome of the five steps (progress rail, 560 px column, footer, `num`/`gib`, the three UX 2.5 icons). Not a UX 14.2 component - it exists so no step re-implements the rail. |
| `views/Onboarding/Welcome.tsx` | step 0: language + the explicit versioned `whatsapp_tos` accept. |
| `views/Onboarding/ChooseAi.tsx` | step 1 **and** the "AI engine" group of Settings (`embedded`). |
| `views/Onboarding/LinkWhatsApp.tsx` | step 2 + `toPanelState` (PairingState -> the five panel states of UX 8.2). |
| `views/Onboarding/GoogleWizard.tsx` | step 3: intro + five sub-steps + `repairStepOf` (the failure-rows map). |
| `views/Onboarding/Ready.tsx` | step 4: live checklist, tray explanation, autostart, storage notes. |
| `views/Settings.tsx` | the one settings page, seven groups, plus the colocated `Toggle` / `ConfirmDialog` parts. |
| `views/setup.css` | the one extra stylesheet allowed by build-plan 1.2: QR plate, drop zone, toggle, rail connector. Logical properties only. |
| `components/QrPairing.tsx`, `components/ConsentDialog.tsx` | the two UX 14.2 components I own. |

## Structural decisions (the ones that are load-bearing, not taste)

1. **Approval-first is enforced by shape, not by copy.** `ConsentDialog` cannot grant anything: it only reports Accept /
   Cancel, the caller is what calls `consent:accept`, and main refuses a cloud provider without a current-version record
   anyway (ARCH A20). Declining sets `selected = 'local'` and no IPC at all is sent - covered by a test.
2. **The key is a one-way street.** `checkKey()` sends the value to `secrets:set` and never keeps it: after a save the
   only thing any code path can render is `KeyStatus.last4`. A test asserts `document.body.textContent` no longer
   contains the key and that the input is gone.
3. **No URL, no path, no JID in the renderer.** Every "Open ..." button sends an `ExternalTarget` enum through
   `external:open`; the credentials file is read with `File.text()` and only its CONTENT goes to
   `google:importCredentials`; "Browse" is `google:pickCredentialsFile` (the dialog runs in main); chats are addressed by
   `chatRef`. There are tests for each of these, including one that greps the rendered DOM (text + every attribute value)
   for `@s.whatsapp.net` / `@lid`.
4. **`ChooseAi` has exactly one implementation.** UX 9 says the settings AI group is "three radio cards as in onboarding
   8.1", so Settings renders `<ChooseAi embedded />` rather than a second copy - consent and key handling exist once.
5. **The QR is only ever a `data:` URL.** `isDataUrl()` gates the `<img>`; anything else (including an `https:` URL that
   somehow reached the state) renders the skeleton. So a hostile pairing payload cannot turn the plate into a remote
   image load.
6. **`OAUTH_CLIENT_NAME` is a constant, not a locale key.** The wizard asks the user to type that exact name into
   Google's form and copies it to the clipboard through main; it is an identifier both sides must spell the same way, so
   translating it would be a bug. (It also cannot be a locale key: the parity test requires every Hebrew value to differ
   from its English one.)
7. **`CredentialsProblem` reuses `label.credentialsProblem.<value>`** (already enumerated by CONTRACTS 18.2 and asserted
   by `locales.test.ts`) instead of a second `google.credentials.*` family.
8. **Language endonyms reuse the seeded `language.he` / `language.en`.** Same reason as 6: `locales.test.ts` lists those
   two in `SAME_ON_PURPOSE`, and a private copy under `settings.general.lang.*` would trip the "untranslated he value"
   check. Only `settings.general.lang.system` ("Windows language") is mine and translated.

## Assumptions / small deviations, all deliberate

- **The tray glyph is drawn inline in `Ready.tsx`.** The brief points at "the inline SVG tray glyph exported by W1-12's
  icon script (`resources/icons/tray.svg`)". The renderer may not see a path and `resources/**` is not a renderer asset
  root, so the glyph is the same diary-leaf signature object drawn inline (24 px, `currentColor`, `aria-hidden`). It is
  the only graphic in the whole wizard; `Ready.test.tsx` asserts the tray section contains exactly one `<svg>` and no
  `<img>`. [R2] "no illustrations" is read as no raster/vector *illustrations*; the UX 2.5 UI icons (shield, check,
  pending clock) are not illustrations.
- **`ConsentDialog` "read to the end" only bites when the body really overflows.** jsdom gives every node a zero layout,
  so in tests (and in a window large enough to show the text) Accept is live at once; with a real overflow the button
  stays disabled until the scroll reaches the end. Both branches are tested.
- **`ConsentDialog` is split into a keyed inner panel.** The panel is mounted only while open and keyed on
  `kind.v<version>`, so "has this text been read?" can never leak from one consent text to another, and no reset effect
  is needed. This also satisfies `react-hooks/set-state-in-effect`, which the flat config treats as an error.
- **Three places start an async load from the promise chain** (`void Promise.resolve().then(() => load())` in
  `ChooseAi`, `Ready` and the QR bar measurement) rather than calling the loader straight from the effect body. Same
  rule: the linter rejects a call that can set state synchronously inside an effect. Behaviour is unchanged (one extra
  microtask).
- **`Settings` "Saved" is derived, not set from an effect**: `savedAt !== 0 && ackSavedAt !== savedAt`, with a timer that
  only marks the stamp acknowledged.
- **`settings.privacy.purged` interpolates `{{items}}`, not `{{count}}`.** `count` would make i18next pick a plural
  family, which would need `_one`/`_other` in English and `_one`/`_two`/`_other` in Hebrew for one chip; the number is
  formatted through `Intl` (ARCH 12.3) and inserted as plain text instead.
- The wizard's step *sequence* is owned by `App.tsx` (W1-14), which resumes from `bootstrap.onboardingStep` and calls
  `onboarding:setStep`. What I own resumes on its own inside step 3 (`GoogleWizard startAt`) and re-reads
  `onboarding:getState` on every health/download change in step 4; both are tested.

## Dead ends

- Tried keeping the "read to the end" measurement in an effect and resetting the two flags when `open` flipped: that is
  exactly the `react-hooks/set-state-in-effect` pattern the flat config bans. The keyed-panel + callback-ref version
  above replaced it.
- Tried holding the QR progress-bar full-scale in a ref written during render. `react-hooks/refs` rejects reading or
  writing a ref in the render body; the value is now measured once per code in an effect, and the bar reads full until
  that measurement lands - which is what a freshly issued code should look like anyway.

## Locale fragment

`src/shared/locales/pending/W1-16-renderer-setup.json` - 255 keys x 2 languages, prefixes `onboarding.*`, `consent.detail.*`,
`pairing.*`, `google.*`, `settings.*` (build-plan 1.2 assigns exactly these to me). Checked locally: identical key sets in
`en`/`he`, no empty value, no value equal across the two languages, identical `{{placeholders}}` per key, no markup.
W2-01 folds this into `en.json` / `he.json` and deletes `pending/`.

## BLOCKED-BY

None. Nothing I own depends on another package's Wave 0 stub.

## REQUESTS

### Closed in the fix round (verified fulfilled - keep for the audit trail)

- ~~**W1-14-renderer-shell**: rewrite the stale `App.test.tsx` onboarding walk against the real consent-gated step 0
  (`welcome-accept`, then `welcome-start`).~~ **Done** - `App.test.tsx:52-57`, green.
- ~~**W1-14-renderer-shell**: make the `llm:setProvider` / `secrets:set` / `secrets:clear` fakes in
  `tests/setup-renderer.ts` stateful over one shared `LlmConfig`.~~ **Done** - module-level `llmState` + `getLlmState()`.

### Still open

- **W1-14-renderer-shell** (cosmetic, explicitly non-blocking): the prefixes `welcome.`, `ai.`, `pair.` and `google.` in
  `SEEDED_FOR_OTHER_PACKAGES` (`src/renderer/src/i18n.usage.test.ts:39-53`) and the seeded keys `app.back` / `app.close`
  (`SEEDED_KEYS`) are now genuinely referenced by my screens, so they could be dropped to tighten the test. Still W1-14's
  file; the test is green either way, so this is a nicety, not debt. Alternatively W2-01 shrinks the allow-lists when it
  folds `src/shared/locales/pending/` in (audit section 5 already carries that item).

## Other packages' failures observed while verifying

Fix round, 2026-09-23: **none left.** `npm run typecheck` is exit 0 repo-wide and `npx vitest run --project renderer` is
30 files / 422 tests green. The items recorded here on the first pass are all fixed by their owners:

- `locales.test.ts` "every Hebrew value differs from the English one" - green; `card.provider.claude|gemini` are gone
  from `src/shared/locales/pending/W1-15-renderer-dashboard.json` (**W1-15-renderer-dashboard**).
- The `ItemCard.test.tsx` / `store/dashboard.test.ts` / `views/Dashboard.test.tsx` type errors
  (**W1-15-renderer-dashboard**) - gone.
- `src/shared/when.test.ts` TS2532 x3 (**W1-08-shared-utils**, audit 2.1) - gone.
- `tests/setup-renderer.ts` TS2304 `SecretName` x3 + TS7053 (**W1-14-renderer-shell**) - these appeared mid-run while
  W1-14 was landing the stateful fake and were gone by the end of this round.

The one repo-wide gate still red is `npx prettier --check .` (audit 2.3), which is **W2-01-compose-integration**'s
single pass by ownership; build-plan rule 8 forbids me from formatting anything outside my paths and formatting only my
paths would create a style island.
