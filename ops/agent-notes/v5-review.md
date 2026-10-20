# v5 review (T-909, in-app updates) - security-minded reviewer, 2026-10-20

Read-only review of the uncommitted v5 diff (W1 CI, W2 main, W3 UI). Nothing edited except this note. No commit.

## Blocker

1. **Folder swap can move or delete a user folder.** Where: `src/main/update/updateService.ts:186-205` (canInstall) and
   `updaterScript.ts` steps 2 and 5. canInstall only checks `isPackaged`, the exe name and that the folder can be written.
   The release zip puts its files at the zip root (no top folder; W1 note 7). So a user who picks "Extract here" into
   `Downloads` or `Desktop` gets installDir = `Downloads`. The update then renames the whole `Downloads` folder to
   `Downloads.old-<from>`, and the next update `rmSync`s it, which deletes the user's files.
   Fix: set canInstall only when the install folder holds the packaged build and nothing else (for example, every
   top-level entry is in an allow-list: exe, `resources/`, `locales/`, `*.dll`, `*.pak`, `*.bin`, `*.dat`, `LICENSE*`, the
   `.json` files). The updater script should repeat the same check before the rename. Alternatively, nest the zip under
   one top folder.

## Should-fix

2. **No timeout on the zip download.** `updateService.ts:349-386` and `pinnedDownload.ts:110-123`. The only signal is
   the abort from stop(). A stalled TCP read leaves status `downloading` forever, and download() and check() both no-op
   in that state. Fix: an idle timeout that resets in onBytes (for example 60 s) through `AbortSignal.any`.
3. **The updater gets the whole parent environment.** `updateService.ts:518-520` copies all of process.env (every
   `ELECTRON_*`, `WCA_*` and the user's tokens). The relaunch in `updaterScript.ts:153-157` passes all of it on as well.
   The spec asks for a minimal env. Fix: an allow-list (`SystemRoot`, `windir`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`,
   `LOCALAPPDATA`, `PATH`, `PATHEXT`, `ComSpec`) plus `ELECTRON_RUN_AS_NODE=1`.
   (NODE_OPTIONS is already neutralised: the `enableNodeOptionsEnvironmentVariable:false` fuse is set.)
4. **The release job holds `contents: write` while it runs `npm ci` lifecycle scripts.** `release.yml:68-82`. checkout
   persists the token in `.git/config` by default. Fix: `persist-credentials: false`. Better: split the work into a build
   job (read-only) that uploads an artifact and a publish job (write) that only runs `gh release create`.
5. **Actions are pinned by tag only.** `release.yml:38,39,74,76` use `@v4`. Fix: pin each to a full commit SHA, with the
   tag in a comment.

## Nit

6. A dev copy can download the full update but can never install it. The banner Update button at `available` and
   Settings "Download and install" are both enabled when `!canInstall`. Show devOnly and disable Download at `available`.
7. `zip.ts:291` inflates each entry in memory (the ~190 MB exe blocks main for about 1 s; the cap is 2 GiB per entry).
   Acceptable for now; a streaming inflate later.
8. `transferToPart` does not check that a 206 `Content-Range` starts at the offset. The final sha256 catches a splice,
   so this is defence in depth only.
9. `zip.test.ts:124,162` are `skipIf(!powershellAvailable)`. This is fine on Windows CI.

## Verified OK

- Download safety: https-only allow-list (exact host or real subdomain suffix, no credentials in the URL); one
  redirect hop, then `redirect:'error'`; size pin from release.json; streamed sha256 compared over the full digest;
  the `.part` sidecar is bound to size+sha; zod validates the manifest before any URL from it is used; the asset name
  pattern is exact; asset URLs are restricted to `github.com/ilay1112/whatsapp-agent/releases/download/`; the API
  base must equal `https://api.github.com` unless both seam locks (`!isPackaged` and `WCA_E2E=1`) are open; 10 s check
  timeout; a 403/429 becomes `error` with the next try in 6 h and manual checks limited to one per 60 s (no retry
  storm).
- Zip: refuses traversal, absolute, drive, UNC, `:`, NUL and control characters, device names, trailing dot or space,
  symlinks or reparse points, encryption, methods other than 0/8, case-insensitive duplicates and local/central name
  mismatches; caps entry count, total size and per-entry size; `maxOutputLength` stops bombs; checks CRC and exact
  size; validates CD/EOCD64 offsets against the file size; writes with `wx`; on failure removes its own folder.
  Nothing from the zip is executed except the verified exe.
- Updater: argv validated (pid, absolute non-root folders, no nesting, a strict exe-name regex, versions); waits for
  the pid, and after 60 s exits 3 without touching anything; rolls back on every path; `shell:false`, detached + unref,
  cwd `<userData>\updates`; the log carries events and numbers only; it is not spawned through the Supervisor, so
  killAllSync cannot reach it.
- CI: top-level `contents: read`, so `crt-pins` cannot publish; zip built after the smoke gate; release.json is
  computed from the same file that is uploaded; concurrency group; timeouts; no `pull_request` trigger; the commit
  subject reaches the shell as a variable, never through `${{ }}`.
- Privacy and UI: logs and audit carry enums, versions and numbers only (asserted); User-Agent is name/version; CSP is
  `connect-src 'none'`; no IPC schema accepts a URL or path; ignoredVersion is persisted in meta; banner X means
  ignore at `available` and hide during download/ready (separate test ids); review focus 1-5 each have a meaningful
  test.
