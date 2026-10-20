# v5 W3 — renderer + e2e + docs (T-909)

Worker: Opus 5.5 (v5 W3), 2026-10-20. Spec: `docs/specs/v5-updates-handover.md` §2.3 / §2.4 / §4 W3. Inputs: `v5-update-main.md` (W2), `v5-ci.md` (W1). No commit, no push.

## Files

| File | What |
|---|---|
| `src/renderer/src/store/update.ts` (+test) | `useUpdateStore` mirror of main's `UpdateState` (hydrate, `update:changed` subscribe, check / download / install / ignore / unignore, one action in flight). Renderer-only: `bannerHidden` (X during downloading / ready = this run only), `installNoticeShown`, `actionError`. Pure helpers `bannerModeOf`, `downloadPercent`, `hasNewer` (uses shared `semverCompare`), `installLabelOf`. `install()` refuses locally unless `ready && canInstall`. |
| `src/renderer/src/components/UpdateBanner.tsx` (+test) | Its own component (NOT a SetupStrip row). available: text + `update-banner-install` (download) + X `update-banner-ignore` = `update:ignore {version}`. downloading: % + `role=progressbar` + X `update-banner-hide`. ready: `update-banner-restart` (disabled + `update-banner-devonly` when `!canInstall`; focus guard `isActivationBlocked()` + `detail>1` read at click time) + X hide. Errors / idle / checking / up_to_date / installing: nothing. |
| `src/renderer/src/views/settings/Updates.tsx` (+test) | Settings › Updates group (hydrates on mount). Test ids per ux.md §16. Error line maps `DOWNLOAD_FAILED` / `DISK_FULL` to update-specific copy (the `errors.*` copy for those is about the model). |
| `src/renderer/src/views/Settings.tsx` | `SettingsGroup` + `SETTINGS_GROUPS` += `'updates'` (last); renders `<Updates />` after Privacy. |
| `src/renderer/src/App.tsx` (+`App.v5.test.tsx`) | `UpdateBanner` right after SetupStrip in the fixed top block (outside `app-scroll`, not in onboarding); hydrate after bootstrap + `update:changed` subscription; footer `app-version-update` "Restart to update" when `ready` -> `openSettings('updates')`; `lastInstall` -> one toast per window. |
| `src/renderer/src/store/dashboard.ts` | **Outside my list, additive**: `toast.values?` (interpolation for `update.installed {version}`); App renders `t(toast.key, toast.values)`. |
| `src/renderer/src/api.ts` (+test) | `getUpdateState`, `checkUpdate`, `downloadUpdate`, `installUpdate`, `ignoreUpdate(version)`, `unignoreUpdate`, `events.onUpdateChanged`. Preload already had the channels (W2). |
| locales en + he | `update.*` (+ `bannerLabel`, `hide`), `footer.restartToUpdate`, `settings.group.updates`, `settings.update.*` (+ `notChecked`, `checking`, `restartAction`, `downloadFailed`, `diskFull`, `actionFailed`). **Hebrew review of W2's keys**: `errors.UPDATE_CHECK_FAILED.body` -> "בדקו את החיבור ונסו שוב." and `UPDATE_VERIFY_FAILED.body` -> "הקובץ נמחק. נסו שוב מאוחר יותר." (the file's imperative-plural voice; "הוא נמחק" was ambiguous). Privacy line: "האפליקציה בודקת ב-github.com כל 6 שעות ושולחת רק את מספר הגרסה." |
| `src/renderer/src/views/Settings.v2.test.tsx`, `Settings.test.tsx` (+ RTL snapshot) | group lists += updates; snapshot regenerated (additions only). |
| `tests/e2e/v5-updates.spec.ts` | (1) banner -> X -> relaunch still gone (Settings shows "Show version 0.1.9 again") -> `publish('0.1.10')` -> relaunch -> back -> unignore. (2) Check now -> Download and install -> ready -> Install disabled + devOnly, banner ready + Restart disabled, footer link -> Settings › Updates, direct `update:install` invoke refused, spawn journal empty, every request version-only UA and no Authorization. Screens: `update-banner-{en,he}.png`, `settings-updates-{en,he}.png` (reviewed: layout fine in both directions). |
| Docs | README privacy row "Update check" + weakness "Updates are not code-signed" (removed "No auto-update", and "no update check" from "Anything else"); ARCHITECTURE A23 rewritten, §9 "Update downloader" bullet, §19 weakness list; ux.md §5.4a (new), §5.5, §9 table, §14.2/14.3, §16 test ids; contracts.md §20 `update:*`; DECISIONS D-090. |

## Decisions / notes

- Banner X semantics: `available` = persisted ignore (main); downloading / ready = session hide (renderer memory). Distinct test ids (`update-banner-ignore` vs `update-banner-hide`) so e2e can never confuse them.
- Settings "Download and install" is enabled in a dev copy (download + verify work, W2 allows it); only the restart is disabled with the devOnly line (review focus 4).
- The second e2e test does NOT set `updateFirstCheckMs`, so Check now is the first real check (the 60 s manual rate limit would otherwise swallow it).
- Footer keeps `bootstrap.version` (= `app.getVersion()`, the running version).

## Verification (2026-10-20)

`npx vitest run src/renderer src/shared src/main/ipc` 124 files / 2499+ tests green; typecheck, lint, format:check clean; `build:e2e` + playwright `v5-updates`, `app`, `i18n-rtl`, `v4-shell` 12/12 green.
