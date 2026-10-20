# v5: in-app updates from GitHub Releases — spec + plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. Planned by Fable 5.1 on 2026-10-20; executed by Opus 5.5 workers. Ticket T-909, decision D-090.

**Goal:** every push to `main` produces a GitHub Release with a portable build; the app notices a newer release (on launch + every 6 h, or "Check now"), shows a banner with an X (ignore that version) and a Settings page, downloads the zip, verifies its SHA-256, and on "Install and restart" swaps its own folder and relaunches.

**Architecture:** (1) a GitHub Actions workflow on push to `main` (Windows runner) that fetches the pinned vendor binaries, bundles the VC++ CRT (U10 closed), packages `win-unpacked`, zips it, writes `release.json` and publishes a release `v0.1.<run_number>`. (2) A main-process `UpdateService` (the only place that talks to GitHub — the renderer keeps `connect-src 'none'`), built on the existing pinned-download rules (host allow-list, one redirect hop, size + sha256 check, `.part` resume, no URL in logs). (3) A folder-swap installer: the NEW build's own exe run as Node (`ELECTRON_RUN_AS_NODE=1`) executes `updater.cjs`, waits for the old pid, renames folders, relaunches. (4) Renderer: banner + Settings › Updates over `update:*` IPC and an `update:changed` push.

**Tech stack:** as before; GitHub Actions `windows-latest`, `gh release create` with `GITHUB_TOKEN` (no secrets), Node `zlib`-free zip handling via a pinned pure-JS unzip already in deps or `tar`? — see §2.3 (use `Expand-Archive`-free Node code: add `yauzl`-class dependency only if nothing in `node_modules` already unzips; prefer the existing `adm-zip`/`yauzl` if present — check `npm ls`).

---

## 1. Decisions (user, option dialogs 2026-10-20)
| # | Decision |
|---|---|
| 1 | **Portable folder update**: release = `win-unpacked` zip + SHA-256; the app swaps its own folder; no NSIS/electron-updater. |
| 2 | **Check on launch + every 6 h**, banner with X (ignores that version only), Settings › Updates with Check now / Install / stop ignoring. |
| 3 | (Orchestrator) Version scheme `0.1.<run_number>` written by CI; repo `package.json` stays `0.1.0`. The update check sends no identifier beyond `User-Agent: WhatsAppCalendarAgent/<version>`. Dev/unpackaged runs check but never install. |

## 2. Behaviour

### 2.1 CI release (`.github/workflows/release.yml`)
- Trigger: `push` to `main` (and `workflow_dispatch`). Concurrency group `release` (cancel in progress). Runner `windows-latest`, Node 24 (`actions/setup-node`, cache npm).
- Steps: `npm ci`; `node scripts/fetch-llama.mjs` and `npm run fetch:whisper` (pinned, network to GitHub releases of llama.cpp/whisper.cpp); set `VC_REDIST_CRT_DIR` by globbing `C:\Program Files\Microsoft Visual Studio\*\*\VC\Redist\MSVC\*\x64\Microsoft.VC143.CRT` (fail the job if not found — U10 closes only when the three DLLs ship); `npm run stage:mcp`; `node scripts/hash-bridge.mjs`; `npm run lint && npm run typecheck && npx vitest run --project main --project renderer --project shared` (keep under ~10 min; e2e not in CI); version: `npm version 0.1.${{ github.run_number }} --no-git-tag-version`; `npm run build && npx electron-builder --win --x64 --dir`; `node scripts/smoke-packaged.mjs dist/win-unpacked` (gate); zip `dist/win-unpacked` → `WhatsAppCalendarAgent-win-x64-<version>.zip` (deterministic order, `Compress-Archive` is fine); `node scripts/release-manifest.mjs` → `release.json`; `gh release create v<version> --title "v<version>" --notes "<commit subject + sha>" <zip> release.json`.
- `release.json` (new `scripts/release-manifest.mjs`, tested): `{ "schema": 1, "version": "0.1.N", "commit": "<sha>", "publishedAt": "<ISO>", "asset": { "name": "<zip>", "size": <bytes>, "sha256": "<hex>" }, "minVersion": "0.1.0", "notes": "<subject>" }`.
- Secrets: none (`GITHUB_TOKEN` default; `permissions: contents: write`). Signing stays off (`WCA_SIGN_MODE` unset).

### 2.2 Update check (main, `src/main/update/updateService.ts`)
- `UpdateState { current: string; latest: string | null; status: 'idle'|'checking'|'up_to_date'|'available'|'downloading'|'ready'|'installing'|'error'; progress: { bytesDone: number; bytesTotal: number } | null; errorCode: ErrorCode | null; ignoredVersion: string | null; lastCheckAt: EpochMs | null; canInstall: boolean /* false in dev/unpackaged or when the install dir is not writable */ }`.
- Check: `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` (owner/repo from `resources/links.json`'s repo entry or a new `UPDATE_REPO` constant in `src/shared/update.ts`), `Accept: application/vnd.github+json`, `User-Agent: WhatsAppCalendarAgent/<version>`, 10 s timeout, no auth; parse `tag_name`, find the `release.json` asset, fetch it (`browser_download_url`, one redirect hop like the model downloader), validate with zod (`ReleaseManifestSchema` in `src/shared/update.ts`), compare `semverCompare(latest, current) > 0` (own 10-line comparator, tests). Errors map to `UPDATE_CHECK_FAILED` (offline is not an error toast: status `error` with `errorCode` shown only in Settings; the banner never appears for errors).
- Schedule: first check 30 s after ready, then every 6 h (`LIMITS.updateCheckIntervalMs = 6*3600_000`), plus `update:check` on demand (rate: not more than once per 60 s). Persist `lastCheckAt`, `ignoredVersion`, `latestSeen` in the `meta` table.
- Host allow-list `UPDATE_HOST_ALLOWLIST = { exact: ['api.github.com', 'github.com'], suffix: ['.githubusercontent.com'] }`; https only; e2e seam `WCA_UPDATE_BASE_URL` (http loopback allowed only with the existing `allowHttpLoopback` e2e gate) replaces the api base.
- Download (`update:download`): into `<userData>\updates\<version>\<zip>` with the model downloader's rules reused (extract a shared helper from `download.ts` if needed: `.part` + Range resume, `Content-Length`/size pin, streamed sha256, atomic rename; one automatic retry; refuse redirects outside the allow-list). Progress at 4 Hz → `update:changed`. Then unzip to `<userData>\updates\<version>\win-unpacked\` and verify the unzipped exe exists; status `ready`. A sha mismatch deletes the file and sets `UPDATE_VERIFY_FAILED` (never installs).
- Install (`update:install`, requires `ready` and `canInstall`): write `<userData>\updates\<version>\updater.cjs` (a constant string in `src/main/update/updaterScript.ts`, tested), spawn `<staged>\WhatsApp Calendar Agent.exe` with `ELECTRON_RUN_AS_NODE=1` detached (`windowsHide:true`, stdio ignored, cwd `<userData>\updates`) with args `[updater.cjs, pid, installDir, stagedDir, exeName, logFile]`; audit `update_install_started {from, to}`; then the normal quit sequence. The script: wait up to 60 s for the pid to exit (poll `process.kill(pid, 0)`), rename `installDir` → `installDir + '.old-' + from`, move `stagedDir` → `installDir` (retry 10× over 10 s for OneDrive/AV locks), spawn the new exe detached with `--updated-from <from>`, delete `.old-*` folders older than the previous one (keep exactly one), write its own log to `<userData>\logs\updater.log`. If the move fails it moves `.old` back and starts the OLD exe with `--update-failed`. On start with `--updated-from`, main logs `update_installed {from, to}` and shows a one-time toast `t('update.installed', {version})`; with `--update-failed` → toast `update.failed`.
- `installDir` = `path.dirname(app.getPath('exe'))`; `canInstall` = `app.isPackaged && dir writable (fs.access W_OK) && exe name matches`. Never in dev / e2e (e2e asserts the helper argv through a seam `WCA_UPDATE_SPAWN_JOURNAL` and the process is never spawned).
- Logs: `update_check {status, latest?}`, `update_download {status}`, `update_verify_failed`, `update_install_started` — never a URL. Audit kinds added: `update_install_started`, `update_installed`, `update_ignored`.

### 2.3 Renderer
- Push `update:changed` → `useUpdateStore` (`src/renderer/src/store/update.ts`).
- Banner (`update-banner`, a row above the dashboard columns, both views; rendered by `App.tsx` next to SetupStrip): when `status === 'available' && latest !== ignoredVersion` → "Version {{version}} is ready to install" + `update-banner-install` ("Update") + `update-banner-ignore` (X, `aria-label` `t('update.ignore')`). `downloading` → progress bar; `ready` → "Restart to finish updating" + `update-banner-restart`; the X during download/ready hides the banner until the next launch (not an ignore). Ignore = `update:ignore {version}` persisted in main; the banner returns for the next version.
- Settings › **Updates** (`SETTINGS_GROUPS` += `'updates'`, key `settings.group.updates`): rows: current version (`settings-update-current`), latest + last checked (`settings-update-latest`), `settings-update-check` ("Check now"), `settings-update-install` ("Download and install" / "Restart to finish"), `settings-update-unignore` ("Show version X again") when ignored, error line, and the privacy sentence `settings.update.privacy` ("Checks github.com every 6 hours; sends only the app version."). When `!canInstall`: the line `settings.update.devOnly` ("Updates install only from a packaged copy.").
- Locale keys (both): `update.available "Version {{version}} is ready" / "גרסה {{version}} מוכנה"`, `update.install "Update" / "עדכון"`, `update.ignore "Ignore this version" / "התעלמות מגרסה זו"`, `update.downloading "Downloading update… {{pct}}%" / "מוריד עדכון… {{pct}}%"`, `update.ready "Restart to finish updating" / "הפעלה מחדש לסיום העדכון"`, `update.restart "Restart now" / "הפעלה מחדש"`, `update.installed "Updated to version {{version}}" / "עודכן לגרסה {{version}}"`, `update.failed "The update could not be installed; the previous version is running" / "העדכון לא הותקן; הגרסה הקודמת פועלת"`, `settings.group.updates "Updates" / "עדכונים"`, `settings.update.current "Current version" / "גרסה נוכחית"`, `settings.update.latest "Latest version" / "גרסה אחרונה"`, `settings.update.lastChecked "Checked {{when}}" / "נבדק {{when}}"`, `settings.update.check "Check now" / "בדיקה עכשיו"`, `settings.update.installAction "Download and install" / "הורדה והתקנה"`, `settings.update.unignore "Show version {{version}} again" / "הצגת גרסה {{version}} שוב"`, `settings.update.upToDate "You have the latest version" / "יש לך את הגרסה האחרונה"`, `settings.update.privacy`, `settings.update.devOnly`, `errors.UPDATE_CHECK_FAILED.{title,body,action}` ("Could not check for updates" / "Check your connection and try again." / "Try again"), `errors.UPDATE_VERIFY_FAILED.{title,body,action}` ("The downloaded update did not verify" / "It was deleted. Try again later." / "Try again").

### 2.4 Docs/privacy
- README "What leaves your PC": one request to `api.github.com` per 6 h (and on Check now) with the app version only; the update zip from `github.com`; nothing else. "Known weaknesses": "no auto-update" removed; add "updates are not code-signed: the zip is verified against the SHA-256 published by the same CI run (TLS + GitHub account are the trust root)". ARCHITECTURE A23 updated; §9 gets the update downloader rules; D-090.

## 3. Global constraints
- Approval invariants untouched (no calendar/WhatsApp write path involved). The renderer stays `connect-src 'none'`; only main talks to GitHub.
- Allow-list + https + one redirect hop + size/sha pins for every byte that lands on disk; the zip is never executed, only extracted; the only process launched is the app's own exe from the verified folder.
- No URL, token or path in logs; audit details are enums/numbers/ids.
- Logical CSS, locale keys, he+en screenshots; test ids as listed.
- Workers never commit/push. The workflow file is committed by the orchestrator; it runs only after the push.

## Review focus
1. A release whose `release.json` sha does not match the zip → deleted, `UPDATE_VERIFY_FAILED`, never `ready`. → W2 security test.
2. A redirect from `github.com` to a foreign host during the zip download → refused, no retry. → W2.
3. Ignore 0.1.7, then 0.1.8 appears → banner shows again; "Show again" clears. → W3.
4. App started from `dist/` (dev) → banner says available but Install is disabled with `devOnly` text; no spawn. → W3 e2e.
5. The updater script when the old process never exits (60 s) → it leaves everything untouched and exits non-zero (logged); the next launch shows nothing special. → W2 script test (run the script with Node against temp folders and a fake pid).

---

## 4. Plan

### W1 — CI + release manifest  *(owner: `.github/workflows/release.yml`, `scripts/release-manifest.mjs` (+test), `scripts/fetch-llama.mjs` CRT glob fallback, `package.json` scripts `release:manifest`, docs §15.4)*
- [ ] Test first: `release-manifest.test.mjs` (size + sha of a temp zip, schema fields, version arg validation `^0\.1\.\d+$`).
- [ ] Workflow per §2.1; `act`-style local dry run is not possible — instead run every step's command locally once in a scratch dir except `gh release create` (print the command). Verify the CRT glob on this PC too (`VC_REDIST_CRT_DIR` fallback: if the glob finds nothing locally, skip with a warning; in CI fail).
- [ ] Note `ops/agent-notes/v5-ci.md`.

### W2 — main UpdateService + installer script  *(owner: `src/main/update/**`, `src/shared/update.ts`, `src/shared/ipc.ts` (`update:*`), `src/shared/types.ts` (UpdateState, audit kinds, LIMITS.updateCheckIntervalMs), `src/shared/errors.ts`, `src/main/ipc/handlers/update.ts`, `compose.ts`/`index.ts` wiring (schedule, `--updated-from`/`--update-failed` args, quit sequence hook), `src/main/testSeams.ts` (`WCA_UPDATE_BASE_URL`, `WCA_UPDATE_SPAWN_JOURNAL`), `tests/fakes/fake-github-releases.ts`, `tests/security/update.test.ts`)*
- [ ] Tests first: semver compare; manifest schema; allow-list incl. seam; check → states; download with the fake server (sha ok / mismatch / foreign redirect / resume); unzip + exe present; install refused when `!canInstall`; spawn argv journaled; updater script run for real with Node against temp dirs (fake pid that exits; pid that never exits → no changes).
- [ ] Implement §2.2. Note `ops/agent-notes/v5-update-main.md` with the exact IPC names and `UpdateState`.

### W3 — renderer + e2e + docs  *(after W2; owner: `src/renderer/src/store/update.ts`, `components/UpdateBanner.tsx`, `views/Settings.tsx` (Updates group), `App.tsx` (banner slot + toasts on `--updated-from`), `api.ts`, locales, `tests/e2e/v5-updates.spec.ts`, README/ARCHITECTURE/ux.md/contracts.md, `ops/DECISIONS.md` D-090)*
- [ ] Tests first (jsdom): banner states, X = ignore, Settings rows and actions, `devOnly`; e2e with the fake release server via the seam: newer release → banner → X → gone → relaunch → still gone → newer version → back; Settings Check now / Download → `ready` → Install disabled in e2e with the devOnly line and the spawn journal empty; screenshots `update-banner-{en,he}.png`, `settings-updates-{en,he}.png`.
- [ ] Docs per §2.4. Note `ops/agent-notes/v5-update-ui.md`.

### W4 — orchestrator: review, proof, ship
- [ ] Fresh reviewer (security first: allow-list, sha, script behaviour, logs). Fix pass. Full proof, package, Defender, commit + push (the push triggers the first CI release — watch it; fix the workflow if it fails), swap Desktop, verify the app sees the release.
