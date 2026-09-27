# fix-src-main-index.ts (W2-01 main entry)

Phase 3 repair lane. One confirmed finding: **process-lifecycle-10 [minor]** — `onRenderProcessGone` in
`src/main/index.ts` rebuilt the window without destroying the crashed one, without a `quitting` guard and without a
crash-loop cap.

## Verdict: finding confirmed, fixed

I re-read the two files before touching anything and the skeptic's reading is exact:

- `src/main/index.ts:230-233` (before the fix): `onRenderProcessGone: () => { log.warn('render_process_gone', {}); win = buildWindow(false); }` — no `destroy()`, no `quitting`, no counter, and `startHidden` hard-coded to `false`.
- `src/main/app/window.ts:95-98`: the factory only logs `renderer.gone` and forwards to the callback; it never touches the window. Neither side of the seam disposes the crashed window.
- `src/main/compose.ts:363-366`: `attachWindow` is a bare `windowRef = win` assignment — no dispose of the previous ref.

I agree with the skeptic on the one benign limb too: this is **not** a security or approval-first problem.
`isTrustedSender` (`src/main/ipc/sender.ts`) compares `event.sender.id` against the *current* `windowRef.webContents.id`,
so a stale renderer's IPC would be rejected even if a dead renderer could send any. Nothing here can send a WhatsApp
message or write a calendar event. Severity stays **minor**.

## What I changed

### 1. New, unit-tested policy object in `src/main/app/window.ts`

`createRendererRecovery(deps): RendererRecovery` with `REBUILD_WINDOW_MS = 60_000` and `REBUILD_MAX_ATTEMPTS = 3`.

- `start()` builds the first window and begins tracking its visibility.
- `recover(crashed, reason)` returns the replacement or `null`, and **always** disposes the crashed window.
  - `isQuitting()` → log `renderer.gone.quitting`, dispose, return `null`. No window is born mid-teardown.
  - budget spent → log **`renderer.rebuild_limit`** at error level, dispose, call `onExhausted?.(reason)`, return `null`.
  - otherwise → record the attempt, build the replacement **first**, then dispose the crashed one.

Three deliberate details, each pinned by a test:

- **`destroy()`, never `close()`.** `installCloseToTray` is attached to the crashed window too, and its `isQuitting`
  is `false` during normal operation, so `close()` would `preventDefault(); hide()` — an un-closable ghost. Worse, if
  that ghost were the first window hidden, its close handler would call `repos.meta.set('tray_hint_seen','1')` and burn
  the one-shot tray coach mark. `destroy()` bypasses the `close` handler entirely.
- **Build before dispose.** If `build` throws, the user is left with the (dead-renderer) window rather than with no
  window at all.
- **Visibility is preserved, not forced.** The recovery tracks the launch intent (`--hidden`) and then the live
  window's own `show`/`hide`, and rebuilds with that. `buildWindow(false)` used to pop a visible window onto the screen
  when the app was sitting minimised in the tray. The `show`/`hide` listeners are guarded by `current === win`, so a
  crashed window can never move the flag after its replacement exists.

### 2. `src/main/index.ts` wiring (the smallest surface that closes the defect)

```ts
onRenderProcessGone: (reason) => {
  log.warn('render_process_gone', {});
  win = recovery.recover(created, reason);
  if (win === null) rt.attachWindow(null); // nothing to push to and nothing to trust any more
},
```

and `win = buildWindow(isHiddenStart(process.argv))` became

```ts
const recovery = createRendererRecovery({
  build: buildWindow, isQuitting: () => quitting, now: () => realClock.now(),
  log, startHidden: isHiddenStart(process.argv),
});
win = recovery.start();
```

`rt.attachWindow(null)` is new: when no replacement is built, `windowRef` would otherwise keep pointing at a destroyed
window. `showWindow()` already guards with `isDestroyed()`, so this is belt-and-braces, but it keeps compose's view of
the world honest and costs one line.

## Where I deviated from the proposed fix, and why

**"surface an error instead of looping"** — I did *not* add a dialog, a toast or an `ErrorCode`.

- `docs/ARCHITECTURE.md:636` gives the `Renderer gone` row a UI column of `-`: the contract is "recreate window", with
  no user-visible surface specified.
- Every user-visible error in this app goes through an `ErrorCode` + `errors.<CODE>.{title,body,action}` in
  `src/shared/locales/{en,he}.json` (with a parity test). Inventing a new code for a minor row would touch shared types,
  both locale files, the renderer error map and the notifier — far past "the smallest surface that closes the defect",
  and an untranslated `dialog.showErrorBox` would break the multilanguage requirement (UX 12.1).
- So exhaustion surfaces as `log.error('renderer.rebuild_limit', …)`, which reaches the log files and the diagnostics
  export. The app stays alive in the tray and **Quit still works**; `win` is `null`, so the tray's Open, the toast click
  and every `sender.send` are no-ops rather than throws.

`onExhausted` is kept as an *optional* dep so a future ticket can hang UI off it without reshaping the object. It is
not wired in `index.ts` today.

**Why the policy lives in `window.ts` and not in `index.ts`.** `src/main/index.ts` is a top-level ESM module with
`registerAppSchemes()`, `requestSingleInstanceLock()` and a top-level `await` — it cannot be imported by a unit test,
and it is excluded from coverage in `vitest.config.ts`. It has no `.test.ts` and can't have one. Putting the policy in
`app/window.ts` (which already owns `createMainWindow`, `installCloseToTray` and `runQuitSequence`, and has a colocated
`window.test.ts`) is what makes the behaviour pinnable at all. `index.ts` keeps only the wiring.

## Tests (written red first, then made green)

`src/main/app/window.test.ts`, new `describe('createRendererRecovery …')`, 9 cases — all 9 failed with
`createRendererRecovery is not a function` before the implementation landed:

1. destroys the crashed window instead of leaving a ghost (asserts it leaves `BrowserWindow.getAllWindows()`)
2. destroys it **even though close-to-tray would only hide it**, and does not fire `onFirstHide` (no burned coach mark)
3. builds no window once the quit sequence started
4. caps rebuilds at 3 inside the window, then stops looping (`onExhausted` once, one `renderer.rebuild_limit` error line)
5. the cap is a sliding window: a crash after `REBUILD_WINDOW_MS` rebuilds again
6. a crash while the app sits in the tray does not pop a visible window
7. a crash while the window is on screen brings a visible window back
8. a window hidden to the tray after start is rebuilt hidden
9. an already-destroyed crashed window is not destroyed twice

Not placed under `tests/security/` — this is not one of I1–I7; approval-first is untouched.

## Verification

| command | result |
|---|---|
| `npx eslint src/main/index.ts src/main/app/window.ts src/main/app/window.test.ts` | clean |
| `npx prettier --check` (same three files) | clean |
| `npx tsc --noEmit -p tsconfig.{node,web,tests}.json` | **no error in any file I touched** (see below) |
| `npx vitest run --project main src/main/app` | 6 files, 166 tests, all pass |
| `npx vitest run --project main` (whole main project) | 2669 pass, 8 fail — all pre-existing, in other lanes |
| `npx vitest run --project security tests/security/{electron-hardening,import-graph}.test.ts` | 63 pass |

**Red tests I did not cause and did not touch** (concurrent phase-3 repair lanes; reported, not hidden):

- `src/main/proc/supervisor.ts` / `supervisor.test.ts` — 3 failures + typecheck errors (`taskkillVeto` undefined,
  `Entry.startedAt` missing). Mid-edit by another agent.
- `src/main/db/retention.test.ts` — 2 failures; `src/main/db/repos/repos.test.ts` — 1 failure.
- `src/main/exec/buildCreateEventArgs.test.ts` — 1 failure + a signature change rippling into `tests/helpers/ledger.ts`,
  `tests/integration/recovery.test.ts`, `tests/security/crash-recovery.test.ts`.
- `src/main/llm/local/llamaServer.test.ts` — 1 failure.
- `src/main/mcp/host.test.ts` — typecheck error (`mcpStatusToErrorCode` not exported).

`npm run typecheck` therefore exits non-zero on `tsconfig.node.json` because of `supervisor.ts`, before it ever reaches
my files; `npx tsc -p tsconfig.web.json` is clean and neither `index.ts` nor `app/window*.ts` appears in any error list.

## Hand-off notes / open risks

- Only one window is ever live, and `render-process-gone` fires at most once per `webContents`, so I did not add a
  "stale crashed window" branch to `recover`. If a future ticket ever runs two windows, `recover` must compare
  `crashed` against the tracked `current` before disposing anything.
- The e2e specs never trigger a renderer crash. A `tray-lifecycle.spec.ts` case that kills the renderer and asserts
  "exactly one window, tray still works" would pin the real-Electron half of this (the mock in `tests/mocks/electron.ts`
  cannot prove that Electron keeps the BrowserWindow alive after the renderer dies). Left for W2-03; not in my scope.
- `3 rebuilds / 60 s` is the reviewer's suggested shape and is not written down in any spec. Both constants are
  exported, so a spec can adopt or change them without touching call sites.

## Re-verification after the session resumed (2026-09-27)

The fix from the first pass is intact on disk (`createRendererRecovery` in `src/main/app/window.ts`, wired at
`src/main/index.ts:239-243` and `:267-274`). Re-ran the gates on the current tree:

| command | result |
|---|---|
| `npx eslint src/main/index.ts src/main/app/window.ts src/main/app/window.test.ts` | clean (exit 0) |
| `npx prettier --check` (same three files) | clean |
| `npx vitest run --project main src/main/app/window.test.ts` | 45 pass / 0 fail |
| `npx vitest run --project main src/main/app` | 6 files, 166 pass / 0 fail |
| `npx vitest run --project security` | 16 files, 495 pass / 0 fail |
| `npm run lint` (whole repo) | **3 errors + 1 warning, none in my files** |
| `npm run typecheck` (whole repo) | **fails in `src/main/agent/sanitize.test.ts`, before reaching my files** |
| `npx vitest run --project main` (whole project) | 2671 pass, **11 fail — all in other lanes** |

Red elsewhere, reported not hidden (all outside my surface; the earlier list of 8 has shifted as concurrent lanes land):

- `src/main/agent/sanitize.test.ts:51` — `Parsing error: Unterminated regular expression literal`. The regex literal
  on that line contains raw U+2028/U+2029 inside its character class, which terminates the line for the parser. This
  one error is what makes both `npm run lint` and `npm run typecheck` exit non-zero for the whole repo.
- `src/main/agent/sanitize.ts` — `LINE_SEPARATOR_RE` (line 20) and `DECIMAL_DIGIT_RE` (line 46) assigned but unused.
- `src/main/bridge/ingest.ts:404` — unused `eslint-disable` directive (warning, but `--max-warnings 0`).
- Failing specs: `src/main/agent/{items,prompt.purity,queue,validate,sanitize}.test.ts` and
  `src/main/ipc/handlers/data.test.ts` (11 tests total).

The earlier failures I had recorded in `proc/supervisor`, `db/retention`, `db/repos`, `exec/buildCreateEventArgs`,
`llm/local/llamaServer` and `mcp/host` are now green — those lanes finished. Nothing I touched appears in any current
lint, typecheck or test failure.
