# v5 W2 — main UpdateService + installer script (T-909)

Worker: Opus 5.5 (v5 W2), 2026-10-20. Spec: `docs/specs/v5-updates-handover.md` §2.2 / §4 W2. No commit, no push.

## Files

| File | What |
|---|---|
| `src/shared/update.ts` (+test) | `UPDATE_REPO`, `UPDATE_API_BASE`, `UPDATE_HOST_ALLOWLIST`, `ReleaseManifestSchema`, `GithubReleaseSchema`, `VersionSchema`, `isVersion`, `semverCompare`, `UPDATE_EXE_NAME`, asset prefix/caps. zod only (renderer-safe; asserted in `tests/security/update.test.ts`). |
| `src/shared/types.ts` | `UPDATE_STATUSES`, `UpdateStatus`, `UpdateState`; META_KEYS `update_last_check_at`, `update_ignored_version`, `update_latest_seen`; AUDIT_KINDS `update_install_started`, `update_installed`, `update_ignored`; `LIMITS.updateCheckIntervalMs`. |
| `src/shared/errors.ts` + both locales | `UPDATE_CHECK_FAILED`, `UPDATE_VERIFY_FAILED` (action `try_again`); `errors.<code>.{title,body,action}` added in en + he (the locale parity test needs them). **W3: please review the Hebrew wording.** |
| `src/shared/ipc.ts`, `src/preload/index.ts` | 6 channels + 1 event (below). `update:install` is in `FOCUS_GATED_CHANNELS`; `'update:'` added to `NEVER_ON_MCP_PREFIXES`. Count test now 89 / 12. |
| `src/main/net/pinnedDownload.ts` (+test) | **Shared helper extracted from `llm/local/download.ts`**: `isAllowedUrl(raw, allowList, allowHttpLoopback)` (now also refuses `user:pw@`), `transferToPart` (one hop `redirect:'manual'` then `'error'`, Range resume, 416 / 200-restart, optional `maxBytes` size pin), `sha256OfFile`, `fetchSmall` (capped GET, one hop). `download.ts` now uses it; its HF pins (x-linked-*), sidecar, retry and magic stay in download.ts. gguf-download + download tests unchanged and green. |
| `src/main/update/zip.ts` (+test, `zip.fixtures.ts`) | Minimal extractor over `inflateRawSync`: EOCD/central dir (+zip64 extra/EOCD), methods 0/8, CRC-32, exact size, `maxOutputLength` bomb guard, refuses traversal / absolute / drive / UNC / `:` / device names / trailing dot-space, symlinks (unix S_IFLNK + Windows reparse attr), encryption, duplicates (case-insensitive), header mismatch, limits. Creates the dest; removes it on any refusal. Tested against PowerShell `Compress-Archive` (backslash names) AND the exact .NET `ZipArchive` step of W1's `release.yml`. |
| `src/main/update/updaterScript.ts` (+test) | `UPDATER_SCRIPT` (CommonJS string), `UPDATER_EXIT`, `updaterArgs()`. Test runs it for real with Node against temp folders. |
| `src/main/update/updateService.ts` (+test) | check / download / install / ignore / schedule. |
| `src/main/ipc/handlers/update.ts` (+test) | thin; absent service ⇒ every channel `INTERNAL`. `register.handlers.ts`: `IpcHandlersExtV2.update?`. |
| `src/main/compose.ts`, `src/main/index.ts` | wiring (§ "Wiring"). |
| `src/main/testSeams.ts` (+`testSeams.v5.test.ts`) | `WCA_UPDATE_BASE_URL`, `WCA_UPDATE_SPAWN_JOURNAL`, `WCA_TIMERS.updateFirstCheckMs`. |
| `tests/fakes/fake-github-releases.ts` | fake GitHub Releases host. |
| `tests/security/update.test.ts` | review focus 1 + 2, traversal zip, production allow-list, logs/audit without URL/path, IPC schemas without url/path. |
| `tests/setup-renderer.ts` | only `DEFAULT_UPDATE_STATE` + the six `IPC_DEFAULTS` rows (typecheck needs every channel). W3 owns the rest. |

## IPC (exact names)

| Channel | Request | Answer |
|---|---|---|
| `update:getState` | none | `UpdateState` |
| `update:check` | none | `UpdateState` — real check at most once per 60 s (`UPDATE_MANUAL_MIN_GAP_MS`); a faster call (or one while a check runs) answers the current / in-flight state. Not run while `downloading` / `ready` / `installing`. |
| `update:download` | none | `UpdateState` (`status:'downloading'`, returns at once). `BAD_REQUEST` unless status `available` or `error` with a known release. Second call while running = no-op. |
| `update:install` | none (**focus-gated**) | `UpdateState` (`status:'installing'`), then the app quits ~200 ms later. `BAD_REQUEST` unless `ready && canInstall`; `INTERNAL` if the spawn throws. |
| `update:ignore` | `{ version: '0.1.9' }` (plain `MAJOR.MINOR.PATCH`, strict) | `UpdateState` (persisted, audit `update_ignored {version}`) |
| `update:unignore` | none | `UpdateState` (`ignoredVersion:null`) |

Push event: **`update:changed`** → `UpdateState` (every status change; progress ≤ 4 Hz). `AppRuntimeEvent` `'update:changed'` is mapped 1:1 in `index.ts`.

```ts
type UpdateStatus = 'idle'|'checking'|'up_to_date'|'available'|'downloading'|'ready'|'installing'|'error';
interface UpdateState {
  current: string;                 // app.getVersion()
  latest: string | null;           // newest seen (restored from meta at launch)
  status: UpdateStatus;            // 'idle' at launch
  progress: { bytesDone: number; bytesTotal: number } | null;
  errorCode: ErrorCode | null;     // UPDATE_CHECK_FAILED | UPDATE_VERIFY_FAILED | DOWNLOAD_FAILED | DISK_FULL (status 'error')
  ignoredVersion: string | null;
  lastCheckAt: EpochMs | null;     // last SUCCESSFUL check
  canInstall: boolean;             // isPackaged && exe name === 'WhatsApp Calendar Agent.exe' && install dir + its parent writable
  lastInstall: { outcome: 'installed' | 'failed'; from: string | null; to: string | null } | null; // ADDITIVE: this launch came from the updater
}
```

Renderer rules (spec §2.3): banner when `status==='available' && latest !== ignoredVersion`; errors never show a banner. `lastInstall.outcome==='installed'` ⇒ one toast `update.installed {version: to}`; `'failed'` ⇒ `update.failed`. Download failures: `DOWNLOAD_FAILED` (network, refused redirect — existing locale copy is model-flavoured, W3 may want a Settings-specific line), `UPDATE_VERIFY_FAILED` (sha / size / bad zip / no exe), `DISK_FULL`.

## Behaviour notes

- Check: `GET <base>/repos/ilay1112/whatsapp-agent/releases/latest` (`Accept: application/vnd.github+json`, `User-Agent: WhatsAppCalendarAgent/<version>`, no auth, 10 s). 404 ⇒ `up_to_date`. Tag must be `v<plain version>`; not newer ⇒ `up_to_date` (release.json not fetched). Newer ⇒ `release.json` asset (capped 64 KiB, one hop) → `ReleaseManifestSchema`; `manifest.version === tag`; zip asset name/size must match the manifest. Asset URLs must be `https://github.com/ilay1112/whatsapp-agent/releases/download/...` (under the e2e gate: the seam's own origin + same path). `current < minVersion` ⇒ `up_to_date`.
- Download into `<userData>\updates\<ver>\<zip>` via `transferToPart` (size pin = manifest size, `.part` + `.part.json` sidecar resume, one retry for network / truncation, **no retry** for a refused redirect, **no retry** for a sha mismatch: part deleted, `UPDATE_VERIFY_FAILED`). Then extract to `extract.partial`, accept the exe at the root or inside one top folder, rename to `<ver>\win-unpacked`. Free disk ≥ 3.2 × zip size.
- Install: writes `<userData>\updates\<ver>\updater.cjs`, spawns `<ver>\win-unpacked\WhatsApp Calendar Agent.exe` with `ELECTRON_RUN_AS_NODE=1`, detached, `windowsHide`, stdio ignored, cwd `<userData>\updates`, `.unref()` — through the plain S-SPAWN fn, **never the Supervisor** (no pid file, `killAllSync` cannot reach it). Audit `update_install_started {from,to}`, then `requestQuit()` = `app.quit()` (normal before-quit → shutdown → killAllSync → exit).
- Launch after install: `--updated-from <from>` ⇒ log + audit `update_installed {from,to}`, `lastInstall` set; `--update-failed <to>` ⇒ log `update_install_failed`. `start()` prunes `<userData>\updates\<v>` for every `v <= current`.
- Schedule: `start()` (end of compose `start()`): first check after 30 s, then every 6 h. `shutdown()` calls `updates.stop()` (timers + aborts a download). Logs: `update_check {status, latest?, reason?}`, `update_download {status, reason?, attempt?}`, `update_verify_failed {reason}`, `update_install_started {from,to}`, `update_installed`, `update_install_failed`, `update_ignored` — never a URL or path (asserted).

## Updater script

`<exe> updater.cjs <pid> <installDir> <stagedDir> <exeName> <logFile> <from> <to> [waitMs] [retryMs]` — main passes the first 7 (`updaterArgs()`); the two optional tail args are for tests only (clamped `[10, 60000]` / `[10, 1000]`; defaults 60 000 / 1 000).

Steps: validate argv → wait for pid (poll `process.kill(pid,0)` / 250 ms, ≤ 60 s) → rename `installDir` → `installDir.old-<from>` (10 tries) → rename staged → `installDir` (10 tries; `EXDEV` ⇒ copy + delete) → spawn `<installDir>\<exe> --updated-from <from>` detached, **without** `ELECTRON_RUN_AS_NODE` → delete every other `<install>.old-*` sibling (keeps exactly one). Log: `<userData>\logs\updater.log`, events + numbers only.

| Exit | Meaning | Left running |
|---|---|---|
| 0 | swapped, new build started | new build |
| 2 | bad argv / folder or exe missing — nothing touched | old build relaunched `--update-failed <to>` if the pid had exited and its exe exists; nothing for invalid argv |
| 3 | old pid still alive after the wait — nothing touched, nothing started | the old app (still running) |
| 4 | install folder locked — nothing changed | old `--update-failed <to>` |
| 5 | staged could not be moved in — rolled back | old `--update-failed <to>` |
| 6 | a rollback step failed (logged) | whatever exe exists, `--update-failed <to>` |
| 7 | new exe would not start — rolled back | old `--update-failed <to>` |

Verified on this PC: a folder containing a running exe CAN be renamed on Windows (so the staged exe running the script does not block its own move); a process whose cwd is inside a folder blocks it (EBUSY) — that is how the tests make locks.

## Seams (e2e only; both locks of readSeams apply)

- `WCA_UPDATE_BASE_URL=http://127.0.0.1:<port>` (exactly that shape) — replaces `https://api.github.com` and opens the http-loopback gate. **Unset in an e2e/harness run ⇒ no update request at all**: nothing scheduled; a manual Check now answers `UPDATE_CHECK_FAILED`.
- `WCA_UPDATE_SPAWN_JOURNAL=<abs drive path>` — `update:install` appends `{"command","args","cwd"}` JSON lines instead of spawning, and does NOT quit. In e2e `canInstall` is always false (unpackaged), so install is refused (`BAD_REQUEST`) and the journal stays empty / absent — assert that.
- `WCA_TIMERS={"updateFirstCheckMs":500}` — first automatic check delay (production 30 s). Delay only.

## How W3 drives the fake release server

```ts
import { startFakeGithubReleases } from '../fakes/fake-github-releases.ts';
const gh = await startFakeGithubReleases({ version: '0.1.9' });   // e2e app version = package.json 0.1.0 => newer
env.WCA_UPDATE_BASE_URL = gh.url;
env.WCA_TIMERS = JSON.stringify({ updateFirstCheckMs: 500 });     // banner without waiting 30 s
env.WCA_UPDATE_SPAWN_JOURNAL = join(tmp, 'update-spawn.jsonl');
// ... banner appears (status 'available', latest '0.1.9'); X => update:ignore {version:'0.1.9'} (persisted in meta)
gh.publish('0.1.10');                                             // relaunch (or Check now) => banner back for 0.1.10
gh.setScenario('sha_mismatch' | 'api_error' | 'no_release' | 'foreign_redirect' | 'drop_once_at:50000' | 'no_exe' | 'nested_layout' | ...);
gh.requests;                                                      // {method, path, range, userAgent, accept, hasAuthorization}[]
await gh.stop();
```

The served zip is real (fake exe ~300 KiB incompressible + `resources/app.asar` + `resources/version.txt`), so Download → `ready` works in e2e. Check now is rate-limited to once per 60 s per app run — use a relaunch or the first-check seam rather than two clicks. A `foreign_redirect` zip download points at `https://evil.example` — refused before any request, so it is safe in e2e too.

## Deviations / open points for the orchestrator

- Touched outside the W2 list because contracts force it: `src/preload/index.ts` (INVOKE/EVENTS parity test), `src/main/ipc/register.test.ts` (VALID table), `tests/setup-renderer.ts` (typed IPC_DEFAULTS), both locale files (errors.* parity), `src/main/llm/local/download.ts` (shared-helper extraction, behaviour unchanged).
- `inflateRawSync` per instructions: a ~190 MB exe entry blocks main for ~1 s during extraction (the extractor yields between entries).
- `UpdateState.lastInstall` is additive to the spec's shape (the renderer needs it for the one-time toast).
- `errorCode` may also be `DOWNLOAD_FAILED` / `DISK_FULL` (spec named only the two UPDATE_* codes).

## Review fix pass (2026-10-20, ops/agent-notes/v5-review.md 1-3 + nits 6-8)

1. **Install folder must be the app's own (blocker).**
   - New `src/main/update/updatePolicy.ts`: `PACKAGED_ROOT_DIRS` (locales, resources, swiftshader), `PACKAGED_ROOT_FILES`
     (`LICENSE*`, `version`, `chrome_*`, `*.dll|pak|bin|dat|json`, canInstall's own `.wca-write-probe-<hex>`), the exe,
     required `resources/app.asar`; derived from the real `dist/win-unpacked` top level (listed in the file header and as a
     constant in `updatePolicy.test.ts`). `inspectInstallDir` also refuses a drive root, the profile and its Desktop /
     Downloads / Documents (+ OneDrive variants, + `app.getPath('home'|'desktop'|'downloads'|'documents')` passed from
     index.ts via `ComposeDeps.updateProtectedDirs` -> `UpdateServiceDeps.protectedDirs`).
   - canInstall = packaged && exe name && inspectInstallDir ok && writable (log `update_install_unavailable {reason}`);
     `install()` re-checks the folder and drops canInstall if it changed since launch.
   - `updater.cjs` embeds the same lists as JSON (`${JSON.stringify(...)}` in the String.raw template) and, after the old pid
     exits and before any rename, requires installDir AND stagedDir to pass (new exit `notAnInstallDir: 8`, old build
     relaunched with `--update-failed`). An existing `.old-<from>` and every other `.old-*` sibling is deleted only when it
     passes the rule (`old_build_kept reason=...`, cleanup logs `removed=N kept=M`), otherwise the new previous build gets a
     unique `-<ts>` suffix. When `require`d (tests) the script exports `inspectInstallDir/protectedDirs/minimalEnv` and does
     nothing; `updatePolicy.test.ts` runs both implementations on the same fixtures.
   - Stager: the zip must hold exactly one top folder `WhatsAppCalendarAgent/` (`UPDATE_ZIP_TOP_FOLDER`), which must pass the
     same packaged-build rule (reasons `zip_layout`, `exe_missing`, `zip_foreign_entry`, `zip_asar_missing`). Fake server:
     default zip is nested; scenarios `flat_layout`, `other_top_folder`, `foreign_entry`, `stall_at:N` replace `nested_layout`.
   - **Found by the e2e (Electron main): the asar fs patch.** `stat('...\resources\app.asar')` reports the archive as a folder
     and `fs.open(app.asar, 'wx')` tries to open it as an archive. So "is a file" is read from the parent's directory listing
     (never stat), and streamed entries are written through `original-fs` (createRequire, only when
     `process.versions.electron` is set; node:fs in tests). The fake's app.asar is now 9 MiB (deflates to KiB) so the e2e
     streams an `.asar` exactly like production.
   - **Open risk (pre-existing, not changed):** `fsp.rm(..., {recursive})` in main (prune of `<userData>\updates\<old>`,
     stage's cleanup of an old `win-unpacked`) and the updater's `fs.rmSync` of an `.old-*` build both walk folders that
     contain `app.asar` under the asar patch. Not exercised by any test here; verify on a packaged dry run, or switch those
     calls to `original-fs` too.
2. **Idle timeout.** `UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000` on `deps.clock`, armed before the request and re-armed in
   `onBytes`; `AbortSignal.any([stop, idle])`; reason `idle_timeout`; counts as the one automatic retry (Range resume from the
   kept `.part`), then `error` + `DOWNLOAD_FAILED`; a later Download resumes. Test: `stall_at:40000` + virtual clock.
3. **Minimal env.** `minimalUpdaterEnv(src, runAsNode)`: SystemRoot, windir, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA,
   ProgramData, ComSpec, PATHEXT, USERNAME, HOMEDRIVE, HOMEPATH (looked up case-insensitively, emitted once in canonical
   spelling, so SystemRoot/SYSTEMROOT both work), PATH = `<SystemRoot>\System32`, + `ELECTRON_RUN_AS_NODE=1` for the helper
   only. The relaunch in updater.cjs uses the script's identical `minimalEnv(process.env, false)` (parity test).
4. Nits: dev copy at `available` - banner shows the devOnly line and disables Update; Settings disables "Download and
   install" (e2e now invokes `update:download` directly to still prove the download path; main still accepts it). Zip
   entries > 8 MiB stream (`ZipLimits.streamAboveBytes`, zlib.crc32 incremental, bomb = more output than declared, refused
   mid-stream). Resume-offset limitation documented at the transferToPart call. `unzip_failed_<CODE>` keeps an fs error code.

Commands (Git Bash, PATH prefix): `npx vitest run src/main/update src/main/net src/shared tests/security/update.test.ts
src/renderer src/main/ipc scripts/release-manifest.test.mjs` 131 files / 2704 tests green; `npx vitest run --project main
--project renderer --project security` 343 files green; typecheck, lint, format:check clean; `npm run -s build:e2e && npx
playwright test tests/e2e/v5-updates.spec.ts --reporter=line` 2 passed. Docs touched: ARCHITECTURE 9 (update downloader) +
15.4 (CI), contracts `canInstall` comment. E2E temp roots kept by my `E2E_KEEP_TMP=1` debug runs are under %TEMP%\wca-e2e-*
(deletion was not permitted from this session).

### Follow-up: original-fs everywhere in main (coordinator request, closes the open risk above)

- New `src/main/update/fsReal.ts`: `selectFs(isElectron, load)` -> `original-fs` inside Electron, `node:fs` under plain Node;
  exports `realFs`, `realFsp`, `FileHandle`. `updateService.ts` (staging, prune, failed-download cleanup, exe check, write
  probe), `zip.ts` (all reads/writes incl. streams) and `updatePolicy.ts` now use it; no other fs import remains.
- `fsReal.test.ts`: greps every production file under src/main/update for `node:fs`/`fs`/`fs/promises` imports, requires
  and dynamic imports, failing on any hit outside fsReal.ts (the only exemption is the exact line
  `const fs = require('node:fs');` inside the updater.cjs string); plus a test of the grep and of `selectFs`.
- `updateService.test.ts`: cleanup with dummy `app.asar` files (older staging pruned on start; a stale `win-unpacked` and a
  crashed `extract.partial` of the same version replaced by a fresh stage).
- **Correction to the brief:** the asar patch is NOT inactive under ELECTRON_RUN_AS_NODE. Probe with
  `node_modules/electron/dist/electron.exe` 44.4.3 + ELECTRON_RUN_AS_NODE=1 on a temp folder holding a dummy app.asar:
  `statSync(app.asar)` throws "Invalid package"; `readdirSync(withFileTypes)` (type file), `cpSync`, `renameSync` and
  recursive `rmSync` all work; `original-fs` is loadable there too. updater.cjs stays on plain fs as asked, never stats an
  .asar path, and its comment states the probe result instead of "the patch is inactive".
- `npx vitest run src/main/update tests/security/update.test.ts` 6 files / 153 tests green; typecheck, lint, format:check
  clean; `build:e2e` + `v5-updates.spec.ts` 2 passed (original-fs.promises works in Electron main).
