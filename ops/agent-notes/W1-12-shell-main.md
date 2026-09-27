# W1-12-shell-main - working notes

Package: the Electron shell + process-level plumbing (paths, logger, secrets, test seams, window / tray / autostart /
notifications / protocol / main i18n, the LLM provider factory + consent gate, the electron mock and the icon set).

Owned paths (build-plan section 6): `src/main/{paths,logger,secrets,testSeams}.ts`, `src/main/app/**`,
`src/main/llm/{factory,consent}.ts`, `tests/mocks/electron.ts`, `scripts/make-icons.mjs`, `resources/icons/**`,
`build/icon.ico`, plus the colocated tests of those files and this notes file.

Status: **done** (fix round 2026-09-23 applied - see the last section). 13 owned test files, 323 tests green; the
whole repo's `main` + `renderer` projects are green (133 files / 2,980 tests) and `npm run typecheck` is clean
repo-wide. No `NotImplementedError` is left in an owned source file.

---

## Reading actually done

build-plan 1, 1.1, 1.2, 6, 7 (`W1-12-shell-main`); wave0-seams sections 1-5 and 20; W0 notes; ARCH 3, 8, 12.3, 13, 14,
15.1, 15.3, A20; CONTRACTS 3, 8 (`Bootstrap`, `IpcContext`, push events), 9; UX 12 (+ 2.5 / 6.4 for the glyph); TESTS
3.7, 4.1, 4.2, 4.3, 5.3 (rows `logger.ts`, `secrets.ts`, `llm/factory.ts, consent.ts`, `app/*`, `scripts/*.mjs`), 8.2
items 5, 9, 10, 12a, 13; research `electron-stack.md` 4.1-4.3, 5.1-5.7, `security-threat-model.md` C-41.

---

## What was built, and the decisions behind it

### `paths.ts`
Pure `node:path.win32` arithmetic, no fs and no electron. Packaged: `resourcesDir = process.resourcesPath`. Unpackaged
it is **`<appRoot>\resources`** (not `appRoot` itself) - build-plan section 3 says the dev resources live in
`<appRoot>/{resources, vendor/llama/win-x64-vulkan, build-resources}`, and that is where W0 actually staged the bridge,
the icons and `links.json`. The `AppPaths` comment "else `<appRoot>`" is therefore read as "the dev resource root", and
`bridgeExe` / `iconsDir` / `linksJson` resolve correctly in both modes. `win32` is explicit so the tests are
deterministic and a path with a space is never re-quoted. `DEV_LLAMA_DIR`, `DEV_MCP_DIR`, `MCP_ENTRY_REL` are exported
so W1-05 / W1-07 / W2-04 can assert against the same constants instead of re-spelling them.

### `logger.ts` (safety-critical, 100 % line / 100 % branch)
One `redact()` choke point: an entry is formatted into `ts LEVEL scope.event key=value ...` and the **whole line** goes
through `redact()` once before it reaches the sink, so there is no path that writes unredacted text.

Pattern table = C-41 verbatim plus the JID / e-mail / user-path / OAuth rows the seam doc names. Two deliberate
deviations from the literal C-41 regexes, both to keep `redact()` **idempotent** (the seam doc requires it):
- the header rule ends at one token plus an optional `Bearer `/`Basic ` scheme word instead of C-41's `(\s+\S+)?` tail,
  which would swallow the *next* log field on a second pass;
- `code=`, `token=`, `client_id=`, `state=` are only redacted in query-string position (`?`/`&` prefix), because this
  logger renders an `ErrorCode` as `code=SEND_FAILED` and that must stay readable. `access_token`, `refresh_token`,
  `client_secret`, `api_key` are redacted anywhere.

A `tool` meta key is expanded through `toolMeta()`: the literal name only for `READ_TOOL_NAMES`, otherwise
`toolSha8` + `toolLen` ([R2] ARCH 14). `errorMeta(err)` returns `{code}` and never `err.message`.

**electron-log is injected, not imported.** `createLogger` takes the sink; `configureElectronLog(elog, {logsDir, fs})`
configures the injected instance (file transport only, `{text}` format, 1 MiB, `resolvePathFn` to `<logsDir>\main.log`,
`archiveLogFn` = `rotateLogFiles`, which keeps 5 files) and returns the sink. That keeps `logger.ts` Node-only and
unit-testable to 100 % without loading `electron` in vitest, and keeps the "one hook" rule. See REQUESTS for W2-01.

### `secrets.ts`
Validation (printable ASCII, 8-512 chars) -> `BAD_REQUEST`; encryption unavailable, an `encryptString` throw, an empty
ciphertext, or a "ciphertext" that equals the plaintext bytes -> `KEY_MISSING` and **nothing is written**. Decrypt
failure (other Windows user, corrupt blob) reads as "no key" and the ciphertext is kept, never destroyed. `set`/`get`
are async and `await` the facade result, so a facade built on `safeStorage.encryptStringAsync` works unchanged even
though the frozen `SafeStorageLike` in `deps.ts` is typed synchronously (see REQUESTS).
**Fix round 2026-09-23:** the *decrypt* half of that claim was wrong - see "Fix round" at the bottom of this file.

### `llm/consent.ts` + `llm/factory.ts` (safety-critical, 100 % line / 100 % branch)
`assertConsent` uses `repos.consents.isCurrent(kind)` only - exact version, never `max(version) >=`; an older **and** a
future accepted version both throw. Factory order: consent -> model id -> key -> cache lookup -> construct. The key is
never read before consent passes. The cache key is `id|model|sha256(key)[0..16]`, so a provider, model or key change
rebuilds and disposes the old provider, and nothing else does. A concurrent `get()` shares one in-flight construction.
There is no catch-and-fallback anywhere: a failing provider is simply returned again. `usable()` is synchronous, never
constructs anything and never starts llama-server; it maps to `CONSENT_REQUIRED` / `MODEL_NOT_FOUND` / `KEY_MISSING`.
`seamProvider` is consulted **after** the consent check, so an E2E stub under a cloud id still needs its consent row.

### `testSeams.ts`
`readSeams()` was already implemented by W0 and is untouched. `installTestHooks` builds a **fresh frozen facade** with
exactly the eight hooks of TESTS 4.2 and installs it as a non-enumerable, non-writable `globalThis.__wcaTest`, so
nothing the caller carries (repos, tokens, an approve function) leaks through and the page cannot bolt one on.
`uninstallTestHooks()` added for tests.

### `app/*`
- **window.ts**: `buildWebPreferences()` is a pure function so the exact ARCH 15.1 object can be asserted key for key;
  `isAppUrl` + `hardenWebContents` deny `will-navigate` (anything but `app://bundle`), `window.open`,
  `will-attach-webview` and every permission request/check. `installCloseToTray` does `preventDefault(); hide()`
  **every** time including the first, and fires `onFirstHide` only while `trayHintSeen()` is false.
  `installTrayHintCoachMark` sends the coach mark on the **next** `show`, never keeping the window open for it.
  `runQuitSequence` is the ARCH 13 order with every step an injected thunk; a throwing step is logged and skipped, the
  whole sequence is raced against `timeoutMs`, and `exit()` runs exactly once. `isHiddenStart(argv)` and the
  `render-process-gone` callback are additive exports for `compose.ts`/`index.ts`.
- **tray.ts**: `buildTrayTemplate` / `trayIconFor` / `trayStatusKey` are pure and serialisable. Status precedence:
  setup -> paused -> WhatsApp not online -> attention -> active-<provider>. Icons differ by shape, not only colour;
  the tooltip carries at most a count. No GUID (unsigned exe). `createTray` only swaps the image when the icon changes.
- **notifications.ts**: `generic` copy only (`with_name` does not exist), one toast per item coalesced to one per 60 s
  with a count, attention toasts deduplicated per `ErrorCode` for 60 s, `firstHide` always shown (it is app chrome, not
  an item notification). `handleClick()` records `shownByNotificationAt` for the 300 ms `LIMITS.focusGuardMainMs` guard
  and routes to the single item, or to the dashboard for a coalesced toast.
- **protocol.ts**: the CSP constant is byte-for-byte ARCH 15.1. `resolveBundlePath` refuses `..`/`.` segments,
  backslashes, C0 controls, any `:` (drive letters, ADS), malformed percent-encoding and anything that does not
  normalise to a path under `rendererDir`. The handler answers 403 for a refused path, 404 for a foreign host or a
  missing file, and sets the CSP header on **every** response, including the denials. The file reader is injected so
  the handler is testable without a built bundle. `registerAppSchemes()` is exported separately for the top-level
  (before-ready) call.
- **i18n.ts**: own `createInstance()` over the merged `RESOURCES`, throwing `missingKeyHandler` outside production,
  `bdi` registered through `services.formatter.add` (i18next >= 21 no longer routes named formats through
  `interpolation.format`). No locale fragment was needed: every key this package uses (`tray.*`, `notify.*`,
  `errors.<CODE>.title`) already exists in both `en.json` and `he.json`, verified for all 45 error codes.

### `scripts/make-icons.mjs` + `resources/icons/**` + `build/icon.ico`
Everything is generated from code: a tiny RGBA canvas, a hand-written PNG encoder (`node:zlib` + CRC-32) and the pinned
dev dependency `png-to-ico`. No network, no spawn, no binary source asset, no new dependency. The glyph is the UX 6.4
date tab (accent header band, light body, two hanger ticks, a day bar); variants differ in shape - attention = amber
disc, paused = two grey bars, error = red exclamation - and the day bar is shortened for a variant so the mark never
sits on top of it. Tray icons ship 16/20/24/32/48 px, `build/icon.ico` 16...256 px (electron-builder needs the 256
entry). `resources/icons/tray.svg` is the same glyph as an inline SVG string for W1-14 / W1-16, with no script, no
external reference and no `url()`. Ran once for real: the five `.ico` files, `notification.png` and `tray.svg` exist
and match the paths in `electron-builder.yml` (`resources/icons` -> `icons`, `win.icon: build/icon.ico`).

### `tests/mocks/electron.ts`
Kept complete per TESTS 3.7 and extended minimally: `safeStorage.encryptStringAsync` / `decryptStringAsync` (3.7 asks
for the async API), and `resetElectronMock()` now also clears `protocol.privileged` and restores
`app.loginItemSettings` / `app.preferredSystemLanguages` / `app.singleInstanceLock`. Nothing existing was changed, so
other packages' tests are unaffected (the full unit suite is green).

---

## Assumptions (call them out if wrong)

1. `AppPaths.resourcesDir` unpackaged = `<appRoot>\resources` (reasoning above). W1-02 / W1-05 / W1-07 / W2-01 all
   consume this; `src/main/bridge/launcher.test.ts` already builds its fixture paths with `createPaths` and is green.
2. `usable()` reports `ok` for the Local provider without checking that a GGUF is present - the factory has no model
   repository and must not start llama-server. Model readiness stays with `ModelManager` / `HealthHub` (W1-07 / W1-01).
3. `Notifier.attention(code)` is deduplicated per code for 60 s. "Once per occurrence" is otherwise not decidable
   inside the notifier, which cannot see when an occurrence ends.
4. The first-hide toast ignores `settings.general.notifications === 'off'`: UX 12.2 / ARCH 13 describe it as a
   one-time app-chrome explanation, not as an item notification.
5. `createMainI18n` throws on a missing key unless `process.env.NODE_ENV === 'production'`.

## Dead ends

- Importing `electron-log/main` directly in `logger.ts` - it pulls `electron` into every vitest run of a safety-critical
  file that must reach 100 % coverage. Replaced by the injected `ElectronLogLike` (see above).
- Using `shared/i18n/bidi.isolate` for the `bdi` formatter: it is W1-08's file and still a throwing Wave 0 stub, which
  would have made `app/i18n.ts` BLOCKED-BY. The formatter uses the two isolate characters directly (two constants,
  `FSI`/`PDI`, exported for reuse) - no re-implementation of W1-08's module.
- Writing unicode escapes (` `, `⁨`) into a source file through the editing tool produced *literal* control
  characters in the file. Both places were rewritten with `charCodeAt` comparisons and `String.fromCharCode`, and the
  sources were re-scanned for stray control characters.

---

## REQUESTS

- **W2-01-compose-integration**: in `compose.ts`, wire the logger as
  `const sink = configureElectronLog(electronLog, { logsDir: paths.logsDir, fs: nodeFs }); const log = createLogger({ logsDir: paths.logsDir, sink });`
  (`electron-log/main` is the only place that module should be imported; `logger.ts` stays Node-only on purpose).
- **W2-01-compose-integration**: the `ElectronFacade.notify(title, body)` signature has no click callback, so the
  notifier cannot learn about a toast click by itself. Implement the facade's `notify` so that the `Notification`'s
  `click` event calls `notifier.handleClick()` (exported beside the frozen `Notifier` members). `handleClick()` records
  `shownByNotificationAt` and calls the injected `onClick(itemId)`; `ipc/register.ts` then samples
  `notifier.shownByNotificationAt()` into `IpcContext`.
- **W2-01-compose-integration**: build the `ElectronFacade.safeStorage` on the **async** API
  (`encryptStringAsync` / `decryptStringAsync`) where available; `createSecretStore` awaits the result, so a facade
  returning a promise works although the frozen `SafeStorageLike` in `deps.ts` is typed synchronously. If you prefer a
  typed async seam instead, that is a `deps.ts` change and therefore yours.
- **W2-01-compose-integration**: call `registerAppSchemes()` at module top level in `index.ts` (before `ready`) and
  `registerAppProtocol({ rendererDir })` after `ready`; `createMainWindow({ onRenderProcessGone })` should recreate the
  window, and `isHiddenStart(process.argv)` provides `startHidden`.
- **W1-13-ipc-preload**: `app:ackTrayHint` should clear the pending flag that `installTrayHintCoachMark`'s `pending()`
  reads (`meta.tray_hint_seen` marks the toast as shown; the coach mark needs its own "already displayed" flag, which
  compose owns in memory).
- **W1-14-renderer-shell**: `resources/icons/tray.svg` holds the tray glyph as an inline SVG string for the coach mark
  and the tray explanation - it is generated by `scripts/make-icons.mjs` and must not be hand-edited.
- **W2-04-packaging**: `resources/icons/{tray,tray-attention,tray-paused,tray-error}.ico`, `notification.png`,
  `tray.svg` and `build/icon.ico` now exist and are committed; regenerate with `node scripts/make-icons.mjs`.

## BLOCKED-BY

None. Nothing in this package depends on another package's Wave 0 stub at run time: every collaborator
(`Repos`, `SafeStorageLike`, `Clock`, `ElectronFacade`, the provider makers) arrives by injection and is a test double
in the unit tests.

---

## Verification (this machine, 2026-09-22)

| Command | Result |
|---|---|
| `npx vitest run --project main <owned paths>` | 13 files, **298 tests green** |
| `npx vitest run --project main --project renderer` (whole repo) | 73 files, **1,618 tests green** |
| `npm run typecheck` | **no error in an owned file**. At the end of this run the only remaining repo error is in `src/shared/when.test.ts` (W1-08, three `TS2532 Object is possibly 'undefined'` around lines 129/140/141) - reported, not fixed. |
| `npx eslint <owned paths> --max-warnings 0` | **clean** |
| `npx prettier --check <owned paths>` | **clean** |
| Coverage (TESTS 13) | `logger.ts`, `llm/factory.ts`, `llm/consent.ts` = **100 % lines / 100 % branches / 100 % functions** (the safety-critical requirement is 100 / 95 / 100). `paths.ts`, `secrets.ts`, `testSeams.ts` are also at 100 %. `src/main/app/**` is excluded from the coverage numbers by `vitest.config.ts` by design (TESTS 13) - its logic-bearing pure functions are unit-tested anyway. |
| `node scripts/make-icons.mjs` | wrote 4 `.ico` + `notification.png` + `tray.svg` + `build/icon.ico`, exit 0 |

---

# Fix round (2026-09-23) - the two audit items attributed to W1-12

`ops/agent-notes/wave1-audit.md` section 5 lists both items under **"deferred to Wave 2 by design"**: they are
requests **from** W1-12 **to** W2-01, and they land in `src/main/compose.ts` and `src/main/index.ts`, which the
ownership matrix (build-plan section 6) assigns to **W2-01-compose-integration**. Both are still Wave-0 throwing
stubs. I did not touch them. What I did instead was verify - and where it was wrong, repair - **my** half of each
seam, so that when W2-01 writes the four lines they cannot mis-fire.

## Item 1 - "electron-log/main imported only in compose.ts"

Already satisfied on my side and re-verified: `src/main/logger.ts` has **no** import of `electron-log`; it exports
`ElectronLogLike`, `configureElectronLog(elog, { logsDir, fs })` and `createLogger({ logsDir, sink })`. The single
`electron-log/main` import in the repo is `src/main/index.ts:4` (W2-01's Wave-0 skeleton, for `log.initialize()`).
Nothing to change here; the wiring line itself is W2-01's to write.

## Item 2 - ElectronFacade: notification click, async safeStorage, protocol registration

`ElectronFacade` is constructed in `compose.ts` (stated in `deps.ts:3`), so the facade itself is W2-01's. My side:

- **Notification click** - `Notifier.handleClick()` is exported (`src/main/app/notifications.ts:23/93`) and already
  records `shownByNotificationAt` for the 300 ms focus guard. *Repaired here:* `tests/mocks/electron.ts`'s
  `Notification` recorded only `{title, body}`, so W2-01 had no handle on the constructed toast to assert the click
  wiring. It now keeps `Notification.instances` (mirroring `Tray.instances`), cleared by `resetElectronMock()`, so a
  facade test can do `Notification.instances.at(-1)!.emit('click')`. Purely additive; the full suite is unchanged.
- **`registerAppSchemes()` / `registerAppProtocol({ rendererDir })`** - both already exported from
  `src/main/app/protocol.ts:114/119`, the first safe to call at module top level before `ready`. Nothing to change.
- **async safeStorage** - *this one was a genuine defect in my own file* and is the substance of this fix round.

### The defect: `SecretStore.has()` would have crashed on an async facade

`src/main/secrets.ts` decrypted through a single **synchronous** `decrypt()`. `get()` is `async`, so a promised
plaintext flattened by accident and looked fine - but `has()` is synchronous (frozen seam, `wave0-seams.md`), and it
did `statusOf(plain)` -> `plain.slice(-4)` on a `Promise`. A facade built on `safeStorage.decryptStringAsync`, which
is exactly what ARCH 390 / TESTS 5.3 ask for and what the audit item asks W2-01 to build, would therefore have thrown
a `TypeError` out of the `secrets:status` IPC handler on the onboarding screen. Worse, Electron 44's
`decryptStringAsync` resolves to `{ shouldReEncrypt, result }`, **not** a bare string, so even an `await`ed value
needs unwrapping (checked against `node_modules/electron/electron.d.ts:12046`).

### The repair (inside `src/main/secrets.ts` only)

- `plainOf(value)` unwraps either shape - a bare string or the `{ result }` envelope - and returns `null` for
  anything that is not a non-empty string. `isThenable(value)` detects the async facade.
- `cipherOf(name)` is the one place that reads the row and checks `isEncryptionAvailable()`.
- `decrypt()` is now `async` and `await`s the facade result, so `get()` works with either API.
- `has()` stays synchronous. It reads the ciphertext; if the facade hands back a thenable it cannot await, so it
  answers from a **memo** of last4 values this store has already seen (`seen`, keyed by name and pinned to the exact
  ciphertext, so a rotated key never serves a stale last4), and attaches a handler to the pending decrypt to warm the
  memo for the next call - including a `() => {}` rejection arm, because an unhandled rejection in main is a crash.
  Cold (a row written by a previous run, not yet decrypted in this process) it reports `{ present: true, last4: '' }`,
  which is honest: the ciphertext exists, the last 4 characters are not known yet. The next `has()` has the real value.
- `set()` remembers the last4 it just stored, and `clear()` forgets it.
- The synchronous facade path is byte-for-byte the behaviour it had before, so no existing test changed.

### Assumption (6) added

`has()` returning `{ present: true, last4: '' }` for a not-yet-decrypted row under an async facade is the intended
degradation. The alternative - reporting the key absent - would be a lie that pushes the user to re-enter a key they
already have. If W2-01 builds the facade on the **synchronous** `decryptString`, this branch never executes and the
last4 is always exact.

### Verification (this machine, 2026-09-23)

| Command | Result |
|---|---|
| `npx vitest run --project main <owned paths>` | 13 files, **323 tests green** (`secrets.test.ts` 22 -> 37) |
| `npx vitest run --project main --project renderer` (whole repo) | 133 files, **2,980 tests green** |
| `npm run typecheck` | **clean, repo-wide** - the W1-08 `when.test.ts` and W1-13 `register.fixtures.ts` errors are both gone |
| `npx eslint <owned paths> --max-warnings 0` | clean |
| `npx prettier --check <owned paths>` | clean |
| Coverage | `secrets.ts`, `logger.ts`, `llm/factory.ts`, `llm/consent.ts` = **100 % lines / 100 % branches / 100 % functions** (secrets.ts dipped to 97.4/92.7 with the new code; the added edge-case tests took it back to 100) |

`src/main/secrets.test.ts` contains a literal NUL byte in one validation fixture (`'control character'`), which is
deliberate and load-bearing. It was appended to, never rewritten, so that byte survives - `grep` still reports the
file as binary and the fixture still passes.

## REQUESTS - revised

The five requests above stand, with these amendments:

- **W2-01-compose-integration** (`safeStorage`): build the facade on `encryptStringAsync` / `decryptStringAsync` if
  you want the async API - `secrets.ts` now handles the promise *and* the `{ shouldReEncrypt, result }` envelope on
  both paths. Be aware of the one trade-off above: with an async decrypt, `secrets:status` reports an empty `last4`
  for a stored key until the first decrypt of the process resolves. If you would rather the status always carry the
  exact last4, build `decryptString` on the **synchronous** API (the frozen `SafeStorageLike` is typed that way) and
  keep `encryptString` async - `set()` is async and `await`s it. Either choice works with no further change here.
- **W2-01-compose-integration** (`Notification`): `tests/mocks/electron.ts` now exposes `Notification.instances`, so
  the facade test can assert that a click reaches `notifier.handleClick()`.
