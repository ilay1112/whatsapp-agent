# Electron stack research — WhatsApp Calendar Agent

Research date: 2026-09-21. Target: Windows 11 x64, Node 24.19 / npm 11.17 on the dev machine.
All versions below were read from the npm registry on the research date (`npm view <pkg> version`) and
cross-checked against the vendor docs. Items I could not confirm are tagged **UNVERIFIED**.
Items tagged **PROBED** were confirmed empirically by running a throw-away Electron 44.4.3 project in a
temp directory (no WhatsApp, no network services, deleted afterwards).

---

## 0. TL;DR decisions

| Topic | Decision | Exact version |
|---|---|---|
| Runtime | Electron (stable line 44, supported until 2027-03-02) | `electron@44.4.3` (Chromium 152.0.7977.130, Node 24.21.0, V8 15.2) |
| Build tooling | **electron-vite** (not Forge+Vite) | `electron-vite@5.0.0` + `vite@7.3.6` |
| Packager | **electron-builder**, NSIS target, per-user one-click installer | `electron-builder@26.15.3` |
| UI | React + TypeScript | `react@19.3.0`, `react-dom@19.3.0`, `@vitejs/plugin-react@5.2.0` |
| Language | TypeScript **6.0.3** (NOT 7.x, see 1.4) | `typescript@6.0.3` |
| State | Zustand (renderer only); main process is the source of truth, pushed over IPC | `zustand@5.0.15` |
| Styling | Tailwind CSS v4 via Vite plugin, logical (RTL-safe) utilities only | `tailwindcss@4.3.3`, `@tailwindcss/vite@4.3.3` |
| i18n | i18next + react-i18next, `he` + `en`, `dir` switched on `<html>` | `i18next@26.4.2`, `react-i18next@17.0.14` |
| App-state DB | **built-in `node:sqlite`** (no native module, no rebuild) | ships inside Electron 44 (SQLite 3.53.4) |
| Secrets | `safeStorage` (DPAPI-protected key), async API, ciphertext stored in the app DB | built-in |
| Validation | zod at every IPC boundary | `zod@4.6.5` |
| Logging | electron-log (file + console, redaction hook) | `electron-log@5.4.4` |
| Unit tests | Vitest 4 (two projects: `node` for main, `jsdom` for renderer) | `vitest@4.1.11`, `jsdom@30.1.0` |
| E2E | Playwright `_electron` against the built (unpackaged) app | `@playwright/test@1.63.0` |
| Main-process module format | **ESM** (`"type": "module"`); preload is **CJS** (`.cjs`) because it is sandboxed | — |

---

## 1. Version facts (verified 2026-09-21)

### 1.1 Electron

- `electron@latest` = **44.4.3** (published 2026-09-18). 44.0.0 went stable 2026-08-25; 45.0.0 is scheduled
  for 2026-10-20; 44 is supported until 2027-03-02. Source: https://releases.electronjs.org/schedule
- 44.4.3 bundles Chromium 152.0.7977.130, **Node.js 24.21.0**, V8 15.2.124.28.
  Source: https://releases.electronjs.org/release/v44.4.3 — **PROBED**: `process.versions` printed
  `node 24.21.0, electron 44.4.3, chrome 152.0.7977.130, sqlite 3.53.4, napi 10, modules 149`.
- Electron 44 breaking changes relevant to us (https://www.electronjs.org/blog/electron-44-0):
  - Windows x86 (ia32) binaries discontinued -> build **x64 only** (arm64 optional later).
  - `clipboard` module is no longer reachable from renderers (use `navigator.clipboard`); we do not need it.
  - New `windowStatePersistence: true` BrowserWindow option (saves position/size) — optional nicety.
- **The `electron` npm package no longer has a postinstall script** (PROBED: `scripts` is empty in
  `node_modules/electron/package.json`). The binary is downloaded lazily on first `require('electron')`/
  `npx electron` ("Downloading Electron binary..."). For CI/offline: run `npx install-electron --no` once
  after `npm ci` (the hint is printed by `node_modules/electron/index.js`).
- npm 11.17 prints `npm warn allow-scripts ... install scripts not yet covered by allowScripts`.
  Per `npm help approve-scripts` this is **advisory in the current release** (scripts still run) but a
  future npm will block unreviewed scripts. Packages in our tree with install scripts: `node-llama-cpp`,
  `esbuild`, `@google/genai`, `protobufjs`, `electron-winstaller`. Recommendation: after the first install
  run `npm approve-scripts node-llama-cpp esbuild` so the `allowScripts` field is committed in package.json.

### 1.2 Build tooling: electron-vite vs Electron Forge + Vite

| | electron-vite | Electron Forge + plugin-vite |
|---|---|---|
| Latest | `5.0.0` (2025-12-07); `6.0.0-beta.1` (2026-04-12) adds Vite 8/Rolldown | `@electron-forge/cli@7.11.2`; `8.0.0-alpha.10` in progress |
| Vite peer range | 5.0.0: `^5 \|\| ^6 \|\| ^7`; 6.0.0-beta: `^6 \|\| ^7 \|\| ^8` | not documented |
| Stability statement | stable | Vite plugin is **still marked experimental** since Forge 7.5.0: "Future minor releases may contain breaking changes" (https://www.electronforge.io/config/plugins/vite) |
| Installer | pairs with electron-builder (NSIS, locked decision) | Forge makers are Squirrel/WiX/MSIX — NSIS is not first-class |
| Recommended by node-llama-cpp | yes — "Electron Vite is preferred" (https://node-llama-cpp.withcat.ai/guide/electron) | — |

**Decision: `electron-vite@5.0.0` + `vite@7.3.6`.** Reasons: stable; one config file for main/preload/renderer;
auto-externalises `dependencies` for main/preload (required for `node-llama-cpp`, which must never be bundled);
`?modulePath` imports for worker/utility entry points; NSIS via electron-builder is the locked packager.
Do **not** jump to Vite 8: `electron-vite@5.0.0` does not accept it, and the only electron-vite that does is a
5-month-old beta. `vite@7.3.6` (2026-06-25) is the latest 7.x and still receives patches. Revisit when
electron-vite 6 goes stable.

Consequences of staying on Vite 7:
- `@vitejs/plugin-react` must be **5.2.0** (6.x requires `vite ^8`).
- `vitest@4.1.11` (peer `vite ^6 || ^7 || ^8`). `vitest@5.0.1` also accepts Vite 7 but was released
  2026-09-15 (6 days old) — prefer 4.1.11 for now.

**PROBED**: a project with `"type": "module"`, `electron-vite@5.0.0`, `vite@7.3.6`, `typescript@6.0.3` builds to
`out/main/index.js` (ESM, `import { DatabaseSync } from "node:sqlite"` preserved as an external builtin) and
`out/preload/index.cjs` (CJS) and runs under Electron 44.4.3.

Key electron-vite 5 facts (https://electron-vite.org/guide/ , CHANGELOG):
- `externalizeDepsPlugin` and `bytecodePlugin` are **deprecated**; use `build.externalizeDeps` / `build.bytecode`
  config. Externalising `dependencies` is already the default for main + preload.
- Everything in `dependencies` is left as `import`/`require` and shipped in `node_modules` by electron-builder;
  everything in `devDependencies` is bundled. **Rule for this repo: renderer-only libs (react, zustand,
  i18next, tailwind) go in `devDependencies`; main-process runtime libs go in `dependencies`.** That keeps
  the packaged `node_modules` small.
- Dev server URL is exposed to main as `process.env.ELECTRON_RENDERER_URL`.

### 1.3 Packager

- `electron-builder@26.15.3` is `latest` (a `v26` dist-tag points at 26.16.1; `27.0.0-alpha.8` is `next`).
  Pin `26.15.3`. Beware: the public docs site (https://www.electron.build/docs/) already describes some v27
  options (e.g. a `nativeModules` group) that **do not exist in 26.x** — verified by reading
  `app-builder-lib@26.15.3/scheme.json`: `nativeModules` is ABSENT; `npmRebuild` (default `true`),
  `nativeRebuilder` (default `"sequential"`, uses `@electron/rebuild`), `buildDependenciesFromSource`
  (default `false`), `asarUnpack`, `extraResources`, `electronFuses` are present.
- NSIS defaults from the same schema: `oneClick: true`, `perMachine: false`,
  `allowToChangeInstallationDirectory: false` (assisted only), `createDesktopShortcut: true`,
  `createStartMenuShortcut: true`, `runAfterFinish: true`, `deleteAppDataOnUninstall: false` (one-click only),
  `warningsAsErrors: true`. `guid` defaults to a deterministic UUIDv5 of `appId` — **never change `appId`
  after the first release** or upgrades/uninstall break. `win.icon` default is `build/icon.ico`.
- `electron-updater@6.8.9` is listed as optional (auto-update needs a publish target + ideally code signing;
  out of scope for v1, leave the dependency out until a release channel exists).

### 1.4 TypeScript 7 caveat

`typescript@latest` is **7.0.2** (the native compiler line). `typescript-eslint@8.70.0` declares
`typescript >=4.8.4 <6.1.0`, so TS 7 breaks typed linting. `react-i18next` and `node-llama-cpp` accept 5/6/7.
**Decision: `typescript@6.0.3`** (latest 6.x). electron-vite transpiles with esbuild, so the TS version only
affects `tsc --noEmit` and ESLint.

### 1.5 Dependency resolution check

A `package.json` with exactly the versions in section 12 was resolved with
`npm install --package-lock-only` on npm 11.17: **exit 0, no ERESOLVE**, 872 lockfile entries.

---

## 2. SQLite for app state: `node:sqlite` vs `better-sqlite3`

### Facts

- `node:sqlite` stability in the Node 24 line: added 22.5.0, unflagged in 22.13/23.4, and
  **"Release candidate" (stability 1.2) since v24.15.0**. Source: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
  Electron 44.4.3 embeds Node 24.21.0, so it gets the RC-level module.
- **PROBED in Electron 44.4.3 main process** (CJS and ESM):
  - `new DatabaseSync(':memory:')`, prepared statements, `get()/run()` work; **no ExperimentalWarning emitted**
    (a `process.on('warning')` listener collected nothing).
  - bundled SQLite **3.53.4**, **FTS5 available** (`CREATE VIRTUAL TABLE ... USING fts5` succeeded).
  - file DB + `PRAGMA journal_mode = WAL` returns `wal`; `{ readOnly: true }` open works.
- `better-sqlite3@13.0.3` (2026-08-05): v13 is the **first N-API release**; prebuilt `.node` files for
  win32-x64/arm64, darwin, linux ship **inside the npm tarball** (`prebuilds/win32-x64.node` etc.),
  `prebuild-install` was removed. Source: https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0
  **PROBED**: `require('better-sqlite3')` loads and queries inside Electron 44.4.3 **without
  `@electron/rebuild`** (N-API is ABI-stable). So the historical "electron-rebuild pain" argument is mostly
  gone in 2026 — but it is still a 2 MB native module that needs `asarUnpack`.
- Both are synchronous. Known concern (https://github.com/yinxulai/one-switch/issues/9): slow queries on the
  main thread freeze tray/IPC. Our data volume (hundreds of conversations, thousands of rows) is tiny;
  indexed queries are sub-millisecond.

### Decision

**Use `node:sqlite` (`DatabaseSync`) for the app's own state DB** at `<userData>/app.db`:
zero dependencies, nothing to rebuild or unpack, RC stability, FTS5 + WAL confirmed.
Wrap it behind a small `Db` interface (`src/main/db/`) so swapping to `better-sqlite3@13.0.3` is a
one-file change if an API gap appears (API shapes are nearly identical: `prepare().get/all/run`, `exec`).

Rules:
- Open with `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;`.
- Migrations: `PRAGMA user_version` + ordered `.sql` strings in `src/main/db/migrations.ts`.
- Transactions: `node:sqlite` has no `.transaction()` helper — use a 6-line
  `tx(fn){ db.exec('BEGIN IMMEDIATE'); try{ const r=fn(); db.exec('COMMIT'); return r }catch(e){ db.exec('ROLLBACK'); throw e } }`.
- The bridge's own `messages.db` (inside the app-owned store dir, never the user's live one) may be opened
  **read-only** with `new DatabaseSync(path, { readOnly: true })` for back-fill; the bridge writes it with the
  default rollback journal, so expect occasional `SQLITE_BUSY` -> set `busy_timeout` and retry. Prefer the
  webhook as the primary feed.
- Vite note: `node:sqlite` must only be imported from `src/main/**`. Importing it from renderer code produces
  "Module 'node:sqlite' has been externalized for browser compatibility"
  (https://github.com/vitejs/vite/discussions/19278).
- Unit tests for DB code run under plain Node 24.19 (Vitest `node` environment) where `node:sqlite` is the same
  RC module — no Electron needed.

---

## 3. Secrets (API keys, tokens)

Source: https://www.electronjs.org/docs/latest/api/safe-storage

- API: `isEncryptionAvailable()`, `encryptString()`, `decryptString()` plus the newer
  `isAsyncEncryptionAvailable()`, `encryptStringAsync()`, `decryptStringAsync()`. Docs: "We recommend using the
  asynchronous API ... the synchronous API may be deprecated in a future version." -> **use the async API.**
  Note `decryptStringAsync` resolves to an **object** (not a bare string) — check the typings
  (`electron.d.ts`) when implementing. **UNVERIFIED** exact field names (the doc summary only says `Promise<Object>`).
- Windows: key material protected by **DPAPI**; protects against other users on the machine, **not** against
  other processes running as the same user. **PROBED**: `isEncryptionAvailable() === true`, round-trip OK;
  ciphertext for an 11-char string was 42 bytes => `v10` + 12-byte nonce + data + 16-byte GCM tag, i.e.
  AES-GCM with a DPAPI-wrapped key held in `<userData>/Local State`. Consequence: deleting/moving `userData`
  or copying the DB to another PC/user makes secrets undecryptable -> handle decrypt failure by asking for the
  key again, never crash.
- Only callable after `app.whenReady()`.

Storage shape: table `secrets(name TEXT PRIMARY KEY, ciphertext BLOB, updated_at INTEGER)` in `app.db`.
Names: `anthropic_api_key`, `gemini_api_key`, `google_oauth_tokens` (if the MCP server lets us own token storage).

Hard rules:
1. Secrets **never cross IPC to the renderer**. Renderer can call `secrets.set(name, value)`,
   `secrets.has(name)`, `secrets.clear(name)` — there is no `get`. UI shows `••••last4` computed in main.
2. Bridge bearer token: generate `crypto.randomBytes(32).toString('hex')` **per launch**, pass via env
   `WHATSAPP_BRIDGE_TOKEN`, keep in memory only.
3. electron-log hook redacts `sk-ant-…`, `AIza…`, `Bearer …`, and phone-number JIDs from log lines.
4. Do not use `electron-store` (`11.0.2`) for secrets; not needed at all since settings live in SQLite.

---

## 4. Security baseline

Source: https://www.electronjs.org/docs/latest/tutorial/security (20-item checklist),
https://www.electronjs.org/docs/latest/tutorial/fuses

### 4.1 BrowserWindow

```ts
const win = new BrowserWindow({
  width: 980, height: 680, minWidth: 760, minHeight: 520,
  show: false,                        // show on 'ready-to-show' unless started with --hidden
  autoHideMenuBar: true,
  backgroundColor: '#0f1115',
  icon: join(process.resourcesPath ?? '', 'icon.ico'), // dev: resources/icon.ico
  webPreferences: {
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    contextIsolation: true,           // default since 12 — set explicitly anyway
    sandbox: true,                    // default since 20 — set explicitly
    nodeIntegration: false,           // default since 5
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
    devTools: !app.isPackaged,
  },
})
Menu.setApplicationMenu(null)          // no default menu / no reload+devtools accelerators in prod
```

Sandboxed preload constraints: only `electron` renderer modules (`contextBridge`, `ipcRenderer`) and a few
polyfilled Node APIs are available; **it must be CommonJS** (ESM preloads require `sandbox: false`).
electron-vite emits `out/preload/index.cjs` when package.json has `"type": "module"` and the preload output
format is `cjs` (PROBED). Keep the preload dependency-free (no zod, no node modules) so it bundles to one file.

### 4.2 Navigation / windows / permissions

```ts
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault() })
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) setImmediate(() => shell.openExternal(url)) // allow-list hosts if possible
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (e) => e.preventDefault())
})
session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)) // renderer needs none
session.defaultSession.setPermissionCheckHandler(() => false)
```

`isAppUrl` = `app://bundle/...` in production, `process.env.ELECTRON_RENDERER_URL` origin in dev.

### 4.3 Serving the renderer + CSP

Checklist item 18 recommends a custom protocol over `file://`. Shape:

```ts
protocol.registerSchemesAsPrivileged([          // must run BEFORE app ready
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])
// after ready:
const root = join(import.meta.dirname, '../renderer')
protocol.handle('app', async (req) => {
  const { host, pathname } = new URL(req.url)
  if (host !== 'bundle') return new Response(null, { status: 404 })
  const file = normalize(join(root, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)))
  if (!file.startsWith(root + sep)) return new Response(null, { status: 403 })   // traversal guard
  const res = await net.fetch(pathToFileURL(file).toString())
  const headers = new Headers(res.headers); headers.set('Content-Security-Policy', CSP)
  return new Response(res.body, { status: res.status, headers })
})
win.loadURL(app.isPackaged || !process.env.ELECTRON_RENDERER_URL ? 'app://bundle/' : process.env.ELECTRON_RENDERER_URL)
```

Production CSP (renderer does **zero** network I/O — everything goes through IPC):

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

- `data:` images are needed because the pairing QR is fetched by **main** from the bridge
  (`/api/pairing/qr.png`, needs the bearer token) and handed to the renderer as a data URL.
- `style-src 'unsafe-inline'` only covers React `style={{}}` attributes; Tailwind 4 emits a static CSS file.
- Dev mode (Vite HMR) needs `'unsafe-inline'` for the react-refresh preamble and `connect-src ws://localhost:*`;
  therefore the strict CSP is attached as a **response header in the `app://` handler (prod only)** instead of
  a `<meta>` tag that would also apply in dev. Bundle fonts locally (no Google Fonts). For Hebrew use the
  system stack: `font-family: "Segoe UI", "Segoe UI Variable", Arial, sans-serif` (Segoe UI has Hebrew glyphs).
- MVP fallback if the protocol handler causes trouble: `win.loadFile('out/renderer/index.html')` + the same CSP
  in a `<meta http-equiv>`; then keep fuse `grantFileProtocolExtraPrivileges` at its default (true).
  **UNVERIFIED**: whether Vite's `type="module" crossorigin` scripts load from `file://` with that fuse
  disabled — do not disable the fuse unless the `app://` protocol is in use.

### 4.4 Typed preload IPC

One shared contract file drives main, preload and renderer typings; every handler validates its sender and
its payload.

```ts
// src/shared/ipc.ts  (types only + channel names — importable from all three targets)
export interface IpcInvoke {                       // renderer -> main (request/response)
  'dashboard:get':        { req: void;                          res: DashboardSnapshot }
  'draft:approveSend':    { req: { draftId: string; text: string }; res: Result }   // explicit user click
  'draft:dismiss':        { req: { draftId: string };           res: Result }
  'event:approveCreate':  { req: { proposalId: string; patch?: EventPatch }; res: Result } // explicit click
  'settings:get':         { req: void;                          res: PublicSettings }
  'settings:set':         { req: Partial<PublicSettings>;       res: PublicSettings }
  'secrets:set':          { req: { name: SecretName; value: string }; res: Result }
  'secrets:has':          { req: { name: SecretName };          res: boolean }
  'agent:setPaused':      { req: { paused: boolean };           res: AgentStatus }
  'pairing:getQr':        { req: void;                          res: { dataUrl: string | null; status: PairingStatus } }
  'model:startDownload':  { req: { tier: ModelTier };           res: Result }
}
export interface IpcEvents {                       // main -> renderer (push)
  'dashboard:changed': DashboardSnapshot
  'agent:status':      AgentStatus                // bridge/mcp/llm health, paused flag
  'model:progress':    { receivedBytes: number; totalBytes: number; done: boolean; error?: string }
}
```

```ts
// src/preload/index.ts  (CJS output, sandboxed, no deps)
import { contextBridge, ipcRenderer } from 'electron'
const INVOKE = new Set([...])            // literal allow-list of channel names (duplicated on purpose)
const EVENTS = new Set([...])
contextBridge.exposeInMainWorld('api', {
  invoke: (ch: string, payload?: unknown) => {
    if (!INVOKE.has(ch)) throw new Error('blocked channel')
    return ipcRenderer.invoke(ch, payload)
  },
  on: (ch: string, cb: (data: unknown) => void) => {
    if (!EVENTS.has(ch)) throw new Error('blocked channel')
    const l = (_e: unknown, data: unknown) => cb(data)     // never leak the IpcRendererEvent
    ipcRenderer.on(ch, l)
    return () => ipcRenderer.removeListener(ch, l)
  },
})
```

```ts
// src/main/ipc/register.ts
function handle<K extends keyof IpcInvoke>(ch: K, schema: z.ZodType<IpcInvoke[K]['req']>,
    fn: (req: IpcInvoke[K]['req']) => Promise<IpcInvoke[K]['res']> | IpcInvoke[K]['res']) {
  ipcMain.handle(ch, (e, raw) => {
    if (!isTrustedSender(e.senderFrame)) throw new Error('untrusted sender')   // checklist #17
    return fn(schema.parse(raw))
  })
}
```

`isTrustedSender(frame)`: `frame` is non-null, is the main frame of **our** window, and `new URL(frame.url)`
is `app://bundle` (or the dev-server origin when `!app.isPackaged`).

**Approval-first is enforced in main, not in the UI**: the only code paths that call the bridge `/api/send`
or an MCP calendar *write* tool are the `draft:approveSend` / `event:approveCreate` handlers. The LLM tool
loop receives a filtered tool list containing **read-only** MCP tools; write tools are invoked by the handler
with the user-approved arguments. Add a unit test asserting no other module imports the send/create functions.

### 4.5 Fuses (electron-builder `electronFuses`, via `@electron/fuses@2.1.3`)

| Fuse | Release value | Why |
|---|---|---|
| `runAsNode` | **see note** | If the Google-Calendar MCP server is a Node script spawned over stdio, the only Node runtime on the user's PC is Electron itself: `spawn(process.execPath, [entry], { env: { ELECTRON_RUN_AS_NODE: '1' } })`. That needs this fuse **enabled**. `utilityProcess.fork` cannot replace it for stdio MCP because "Configuring stdin to any property other than ignore is not supported" (https://www.electronjs.org/docs/latest/api/utility-process). Set to `false` only if the MCP server runs in-process, over HTTP, or in a `utilityProcess` with a custom MessagePort transport. |
| `enableNodeOptionsEnvironmentVariable` | `false` | blocks `NODE_OPTIONS` injection |
| `enableNodeCliInspectArguments` | `false` | blocks `--inspect`. NOTE Playwright `_electron.launch` **times out** when this is false (https://playwright.dev/docs/api/class-electron) — so E2E runs against the *unpackaged* build where fuses are untouched. |
| `onlyLoadAppFromAsar` | `true` | |
| `enableEmbeddedAsarIntegrityValidation` | `true` | **UNVERIFIED** that electron-builder 26.15.3 writes the Windows integrity resource automatically; if the packaged app fails to start, set back to `false`. |
| `enableCookieEncryption` | `true` | harmless; we store no cookies |
| `grantFileProtocolExtraPrivileges` | `false` only with the `app://` protocol (4.3) | |

---

## 5. Tray, window lifecycle, single instance, autostart (Windows 11)

Sources: https://www.electronjs.org/docs/latest/api/tray , `/api/app`, `/api/browser-window`,
`/api/native-image`, `/tutorial/notifications`.

### 5.1 Behaviour spec

- Clicking the window **X hides the window**; the process stays alive with a tray icon. Real quit only via the
  tray menu "Quit" (and via installer/updater).
- **Windows 11 always places a new app's tray icon in the overflow flyout ("hidden icons", the `^` chevron).**
  There is **no API to promote** an icon; the user can drag it out or enable it in *Settings > Personalization >
  Taskbar > Other system tray icons* (state is kept under `HKCU\Control Panel\NotifyIconSettings`, `IsPromoted`).
  This matches the requirement ("minimized to hidden icons") with no extra work — do **not** touch that registry key.
  Sources: https://www.elevenforum.com/t/hide-or-show-system-tray-icons-in-taskbar-corner-overflow-menu-in-windows-11.415/ ,
  https://tech-champion.com/microsoft-windows/windows-11-taskbar-overflow-explained-why-some-icons-stay-hidden-even-after-you-enable-them/
- First time the user closes to tray, show one toast: "Still running in the tray (hidden icons)". Persist a
  `seen_tray_hint` flag.
- Tray: left-click / double-click = show window; right-click = context menu **Open / Pause agent (checkbox) /
  Quit**. Labels are localised (he/en) -> rebuild the menu on language change and on pause-state change.
- Do **not** pass a `guid` to `new Tray()` in v1: for an **unsigned** exe the GUID is bound to the executable
  path and tray creation fails if the path changes (dev vs installed). Revisit once the app is code-signed.
- Keep the `Tray` instance in a module-level variable — if it is garbage-collected the icon disappears
  (long-standing Electron FAQ behaviour; the API page does not restate it).

### 5.2 Code shape

```ts
// src/main/index.ts (ESM)
const startHidden = process.argv.includes('--hidden')
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

app.setAppUserModelId('com.ilay.whatsapp-calendar-agent')   // MUST equal electron-builder appId
let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function showMainWindow() {
  if (!win || win.isDestroyed()) win = createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show(); win.focus()
}

app.on('second-instance', () => showMainWindow())          // (event, argv, cwd, additionalData)

function createMainWindow() {
  const w = new BrowserWindow({ /* 4.1 */ })
  w.once('ready-to-show', () => { if (!startHidden) w.show() })
  w.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    w.hide()                                               // removes taskbar button too
    maybeShowTrayHintOnce()
  })
  w.on('session-end', () => supervisor.killAllSync())      // Windows logoff/shutdown, see 5.4
  return w
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(resourcePath('tray.ico')))
  tray.setToolTip(t('tray.tooltip'))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  refreshTrayMenu()
}
function refreshTrayMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.open'), click: showMainWindow },
    { label: t('tray.pause'), type: 'checkbox', checked: agent.paused, click: (i) => agent.setPaused(i.checked) },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => app.quit() },
  ]))
}

app.on('window-all-closed', () => { /* intentionally empty: tray app keeps running */ })
```

Notes:
- The renderer must not register `window.onbeforeunload` — a non-undefined return silently cancels close.
- Any updater path (`autoUpdater.quitAndInstall()`) must set `isQuitting = true` first.
- Tray state icon: ship `tray.ico` and `tray-paused.ico` (+ optional `tray-attention.ico` when "Needs reply" > 0)
  and swap with `tray.setImage()`.

### 5.3 Quit sequence with async cleanup

```ts
let cleaned = false
app.on('before-quit', (e) => {
  isQuitting = true
  if (cleaned) return
  e.preventDefault()
  supervisor.stopAll({ graceMs: 3000 })
    .catch(() => {})
    .finally(() => { cleaned = true; tray?.destroy(); app.quit() })
})
process.on('exit', () => supervisor.killAllSync())          // last-resort, sync only
```

Electron docs: `before-quit` -> `will-quit` -> `quit`; **"On Windows, this event will not be emitted if the app is
closed due to a shutdown/restart of the system or a user logout"** — hence the `session-end` hook in 5.2 and the
orphan reaper in 6.3.

### 5.4 Windows shutdown / logoff

`BrowserWindow` emits `query-session-end` then `session-end` (Windows only). After `session-end` the OS kills
us within seconds; do only synchronous work (`child.kill()`), no awaits. **UNVERIFIED**: that a *hidden* window
still receives `session-end` (it keeps its HWND, so it should) — the orphan reaper covers the gap.

### 5.5 Start with Windows (start hidden)

```ts
const LOGIN_ARGS = ['--hidden']
export function setAutoStart(enabled: boolean) {
  if (!app.isPackaged) return                      // never register electron.exe from node_modules
  app.setLoginItemSettings({ openAtLogin: enabled, args: LOGIN_ARGS })   // HKCU\...\Run, name = AUMID
}
export function getAutoStart() {
  const s = app.getLoginItemSettings({ args: LOGIN_ARGS })   // must pass the SAME args to match the entry
  return { enabled: s.openAtLogin, effective: s.executableWillLaunchAtLogin } // false if user disabled it in
}                                                                             // Settings > Apps > Startup
```

- `wasOpenedAtLogin` is **macOS-only** -> detect hidden start via `process.argv.includes('--hidden')`.
- NSIS per-user installs live at `%LOCALAPPDATA%\Programs\<productName>\<productName>.exe`; the path is stable
  across updates, so the Run key stays valid.
- Default: **off**; offer the toggle in Settings and in first-run onboarding.

### 5.6 Notifications

- Use the main-process `Notification` class: `new Notification({ title, body, icon, silent })`,
  `n.on('click', showMainWindow)`. **PROBED**: `Notification.isSupported() === true` on this machine.
- Windows requires a **Start Menu shortcut carrying the AppUserModelID**; the NSIS installer creates it with
  AUMID = `appId`, and `app.setAppUserModelId(appId)` must match exactly. In dev (`electron .`) toasts may be
  dropped or attributed to "electron.app.Electron"; docs suggest `app.setAppUserModelId(process.execPath)` in
  dev. Shape: `app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath)`.
- `tray.displayBalloon({ iconType, title, content, respectQuietTime: true })` exists but on Windows 10/11 it is
  rendered as a toast anyway — prefer `Notification`; use neither for anything that needs a decision.
- Approval-first: a notification click **only opens the window**. No action buttons that send/create anything
  (Electron's cross-platform `actions` are not supported on Windows without custom `toastXml` + COM activator anyway).
- Respect Focus Assist: nothing to do, Windows suppresses toasts itself. Throttle: max one toast per chat per
  N minutes; never include full message text if the user enables a "private notifications" setting.

### 5.7 ICO requirements

From https://www.electronjs.org/docs/latest/api/native-image ("It is recommended to use ICO icons to get best
visual effects" on Windows):

- **Tray (`tray.ico`)** — small sizes: **16x16 (100%), 20x20 (125%), 24x24 (150%), 32x32 (200%)**. Add 48 for 300%.
  Draw the 16 px glyph by hand/simplified — a downscaled 256 px logo is mush at 16 px. Use a shape that reads on
  both light and dark taskbars (Windows tray icons are not template images; give it its own contrast/outline).
- **App (`build/icon.ico`)** — large sizes: **32, 40, 48, 64, 256** (plus 16/20/24 so Explorer's small views are
  crisp). electron-builder requires the ICO to contain at least 256x256. 32-bit RGBA; the 256 entry may be PNG-compressed.
- Generation: keep a 1024 px master PNG/SVG in `resources/src/`; build ICOs with a script
  (`png-to-ico@3.0.2` as a devDependency, or ImageMagick if present) and **commit the generated .ico files** so
  builds do not depend on the tool.
- Tray/other runtime icons are loaded by path at runtime -> they must live **outside the asar** (`extraResources`)
  or under an `asarUnpack` glob. Use `extraResources` (section 7).

---

## 6. Long-lived child processes (bridge exe, MCP server)

### 6.1 Facts about the bridge (read from the Go source only — nothing executed, store dir untouched)

- Store paths are **relative to the process CWD**: `store/whatsapp.db`, `store/messages.db`, `store/<chat>/` media
  (`main.go` lines 49, 92-97, 1843, 2370-2375). => spawn with `cwd = <userData>/bridge` and the bridge creates its
  own fresh `store/` there. Nothing else is needed to isolate it from the user's live session.
- Env: `WHATSAPP_BRIDGE_PORT` (main.go:2448), `WHATSAPP_BRIDGE_TOKEN` (auth.go:55), `WEBHOOK_URL` (webhook.go:76).
  When `WEBHOOK_URL` is explicitly set, the bridge adds header **`X-Bridge-Token`** to webhook POSTs (webhook.go:98-102)
  -> the app's webhook receiver must verify it with a constant-time compare.
- REST binds to **127.0.0.1** only (main.go:2333) and also validates the `Host` header (auth.go) — keep calling it
  as `http://127.0.0.1:<port>`, not `localhost`.
- CLI flag: `--full-history-pair` (main.go:46). No stdin reader was found (`os.Stdin` has no matches in main.go), so
  `stdio[0] = 'ignore'` is safe. **UNVERIFIED** at runtime (HARD RULE: exe never executed during research).
- Graceful exit is wired to `SIGINT/SIGTERM` (main.go:2742). **On Windows, Node's `child.kill()` is
  `TerminateProcess` — the Go handler never runs.** Node cannot send CTRL_C to a windowless child without a native
  helper. Accept the hard kill: both DBs are SQLite (crash-safe journals) and whatsmeow reconnects cleanly.
  Mitigation: before killing, stop sending requests and wait ~300 ms for in-flight webhook deliveries.
- stdout/stderr contain UTF-8 emoji; decode with `setEncoding('utf8')`, strip ANSI, **redact before logging**
  (message bodies and JIDs may appear in bridge logs).

### 6.2 Supervisor design

```ts
// src/main/proc/supervisor.ts
export interface ManagedSpec {
  name: 'bridge' | 'mcp-calendar'
  command: string; args: string[]; cwd: string
  env: Record<string, string>               // merged over a MINIMAL env, not the whole process.env
  health?: () => Promise<boolean>           // bridge: GET /api/health with bearer -> 200
  startTimeoutMs: number                    // 20_000
  restart: { baseMs: 1000; maxMs: 60_000; stableAfterMs: 60_000; maxCrashes: 5; windowMs: 600_000 }
}
type State = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed' | 'stopping'
```

- `spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false })`.
  `windowsHide: true` prevents a console window flashing for the Go console exe. Never use `shell: true`.
  Paths with spaces (e.g. `C:\dev\whatsapp agent\...`, `C:\Users\x\AppData\...`) are safe with `spawn` + args array.
- State machine: `starting` -> poll `health()` every 500 ms until OK or `startTimeoutMs` -> `running`.
  On `exit` while not `stopping`: `backoff` with `delay = min(maxMs, baseMs * 2^n)` + jitter; reset `n` after
  `stableAfterMs` of uptime; if `maxCrashes` within `windowMs` -> `failed` (circuit open) and push
  `agent:status` so the dashboard shows "Bridge stopped — Restart" (a user click closes the circuit).
- Liveness while `running`: health probe every 30 s; 3 consecutive failures => kill + restart (covers hung process).
- `stop({ graceMs })`: mark `stopping`, `child.kill()`; if still alive after `graceMs` ->
  `spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true })`. `/T` kills the tree (relevant if the
  MCP server is launched through a wrapper). No `tree-kill` dependency needed (`tree-kill@1.2.2` does the same call).
- `killAllSync()`: synchronous `child.kill()` for each child; used from `process.on('exit')` and `session-end`.
- **Pause agent** (tray) does *not* stop the bridge (we'd miss messages): it only stops LLM processing/drafting.
- Emit structured events (`state`, `log`, `crash {code, signal, uptimeMs}`) — the supervisor has no Electron
  imports, so it is unit-testable in plain Node with a fake child (`node -e "setInterval(()=>{},1e3)"`).

### 6.3 Orphan reaper (main crashed / OS killed us)

Node has no Windows Job Object support, so children survive a hard crash of the main process. On every start,
**before** spawning:

1. Read `<userData>/bridge/bridge.pid` (written right after spawn, JSON `{ pid, exe, startedAt }`).
2. `tasklist /FI "PID eq <pid>" /FO CSV /NH` -> only if the image name equals `whatsapp-bridge.exe`
   -> `taskkill /PID <pid> /T /F`. (Never kill by image name alone: the user runs **another** copy of the same exe
   from `Documents\minime\...` for their own setup — killing by name would take down their live session.)
3. Pick a free port per launch (`net.createServer().listen(0, '127.0.0.1')` -> read port -> close) for both the
   bridge and the webhook receiver. Never use the bridge's default port — the user's other instance may own it.

### 6.4 Paths to the bundled exe

```ts
export const resourcePath = (...p: string[]) =>
  app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), 'resources', ...p)
// bridge exe: resourcePath('bridge', 'whatsapp-bridge.exe')
```

An exe **cannot be executed from inside `app.asar`**; ship it via `extraResources` (section 7). Verify at startup
(`fs.existsSync` + size + SHA-256 compared with a constant generated at build time) and show a clear error if an
antivirus quarantined it (unsigned Go binaries that talk to the network are a common false-positive — see Risks).

### 6.5 MCP server process

Decision belongs to the MCP research task; constraints from the Electron side:
- stdio MCP server written in Node => `spawn(process.execPath, [entry], { env: { ...minimalEnv, ELECTRON_RUN_AS_NODE: '1' } })`
  (fuse `runAsNode` must stay enabled), managed by the same supervisor (health = MCP `ping`). The server's package
  must be in `dependencies` and, if it reads its own files by path, under `asarUnpack`.
- Alternative without the fuse: run the server inside `utilityProcess.fork(modulePath, [], { serviceName: 'mcp-calendar', stdio: 'pipe' })`
  and implement a ~40-line MCP `Transport` over `process.parentPort` / `child.postMessage` (the SDK `Transport`
  interface is just `start/send/close` + `onmessage`). stdin is not available in utility processes.
- The user's machine has **no Node/npx** — never rely on `npx some-mcp-server`.

---

## 7. Packaging: electron-builder config

`electron-builder.yml` (project root):

```yaml
appId: com.ilay.whatsapp-calendar-agent        # == app.setAppUserModelId; never change after first release
productName: WhatsApp Calendar Agent
copyright: Copyright (c) 2026
directories:
  output: dist
  buildResources: build                        # build/icon.ico, build/installer.nsh (optional)
files:
  - out/**
  - package.json
  - "!**/*.map"
  - "!**/node_modules/@node-llama-cpp/{linux,mac}-*/**"          # other-OS llama.cpp binaries
  - "!**/node_modules/@node-llama-cpp/win-arm64/**"
  - "!**/node_modules/@node-llama-cpp/win-x64-cuda*/**"           # see note below (543 MB)
asar: true
asarUnpack:
  - "**/node_modules/node-llama-cpp/**"
  - "**/node_modules/@node-llama-cpp/**"
  - "**/*.node"
extraResources:
  - from: resources/bridge/whatsapp-bridge.exe
    to: bridge/whatsapp-bridge.exe
  - from: resources/bridge/LICENSE             # MIT notice of verygoodplugins/whatsapp-mcp
    to: bridge/LICENSE
  - from: resources/icons
    to: icons
    filter: ["*.ico", "*.png"]
npmRebuild: false                              # no node-gyp modules in the tree (node:sqlite is built in;
                                               # node-llama-cpp ships prebuilt N-API binaries)
electronLanguages: [en-US, he]                 # drops ~40 unused Chromium locale paks
electronFuses:
  runAsNode: true                              # flip to false if MCP does not need ELECTRON_RUN_AS_NODE (4.5)
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  onlyLoadAppFromAsar: true
  enableEmbeddedAsarIntegrityValidation: true  # UNVERIFIED on 26.15.3/Windows
  enableCookieEncryption: true
  grantFileProtocolExtraPrivileges: false      # only with the app:// protocol
win:
  target: [{ target: nsis, arch: [x64] }]
  icon: build/icon.ico
  requestedExecutionLevel: asInvoker
  signAndEditExecutable: true                  # rcedit sets icon/version even when unsigned
nsis:
  oneClick: true
  perMachine: false                            # per-user: no UAC prompt, stable path for autostart
  createDesktopShortcut: true
  createStartMenuShortcut: true                # REQUIRED for toasts (AUMID shortcut)
  shortcutName: WhatsApp Calendar Agent
  runAfterFinish: true
  deleteAppDataOnUninstall: false              # keeps WhatsApp pairing + multi-GB GGUF; offer "Reset data" in-app
  artifactName: "WhatsAppCalendarAgent-Setup-${version}.${ext}"
```

Notes:
- **`extraResources` vs `asarUnpack`**: `extraResources` copies files to `<install>/resources/...` (addressed via
  `process.resourcesPath`) — right for the exe and runtime icons. `asarUnpack` keeps *node_modules* content at
  `resources/app.asar.unpacked/...` while `require`/`import` still resolve through the asar — right for
  `node-llama-cpp` ("Native binaries must remain external to the asar archive",
  https://node-llama-cpp.withcat.ai/guide/electron). electron-builder auto-detects `.node` files, the explicit
  globs are belt-and-braces because node-llama-cpp also loads `.dll`s and spawns helper binaries.
- **Installer size**: llama.cpp binary packages for 3.21.1 (npm `dist.unpackedSize`): `win-x64` 48.6 MB,
  `win-x64-vulkan` 103 MB, `win-x64-cuda` 175 MB, `win-x64-cuda-ext` 368 MB. Recommendation: ship **CPU + Vulkan**
  (Vulkan covers NVIDIA, AMD and Intel GPUs on laptops) and exclude CUDA => ~150 MB of native payload instead of
  ~700 MB. Final call belongs to the local-LLM task; the `files` negation above implements it. If `getLlama()`
  is told `gpu: 'auto'` it falls back Vulkan -> CPU on its own.
- GGUF models are **not** packaged: downloaded at first run into `<userData>/models/`.
- NSIS closes the running app on upgrade/uninstall by process name; our children are separate images. Add
  `build/installer.nsh` with `!macro customInit` -> `nsExec::Exec 'taskkill /F /IM "WhatsApp Calendar Agent.exe" /T'`
  **only for our own main exe with /T** (tree kill takes the children with it). Do **not** `taskkill /IM
  whatsapp-bridge.exe` (would kill the user's other bridge). **UNVERIFIED**: exact macro needed; test an
  upgrade-while-running scenario before release — a locked `whatsapp-bridge.exe` makes the upgrade fail.
- **Code signing**: none in v1 => SmartScreen "Windows protected your PC" on first run and higher AV
  false-positive risk for the bundled Go exe. Acceptable for a personal build; for distribution use Azure
  Trusted Signing (`win.azureSignOptions`) or an OV/EV cert (`win.signtoolOptions`).
- The project path contains a space (`C:\dev\whatsapp agent`). electron-builder and NSIS handle it, but always
  quote paths in npm scripts and avoid tools that shell out unquoted. **UNVERIFIED** end-to-end on this path.
- Building NSIS on Windows needs no extra installs: electron-builder downloads its NSIS/rcedit/winCodeSign
  helpers into `%LOCALAPPDATA%\electron-builder\Cache` on first build (network required once).

---

## 8. UI stack (minimal)

- **React 19.3 + TS**: default recommendation stands. Three live lists + settings + onboarding is small, but
  React gives the other agents a common, well-known component model, first-class Testing Library support, and
  `react-i18next`. No router (3 views -> a `view` field in the store). No component library, no data-fetching lib.
- **State**: main process owns truth (SQLite). Renderer holds a **Zustand** store hydrated by
  `api.invoke('dashboard:get')` and updated by `api.on('dashboard:changed')` pushes (debounced ≥150 ms in main).
  Optimistic UI is forbidden for send/create actions — show "sending…" until main confirms.
- **Styling**: Tailwind 4.3 through `@tailwindcss/vite` (CSS-first config: `@import "tailwindcss";` + `@theme { … }`
  in `src/renderer/src/styles.css`, no `tailwind.config.js`, no PostCSS). RTL rule: **only logical utilities** —
  `ms-* me-* ps-* pe-* start-* end-* text-start text-end border-s border-e rounded-s rounded-e`; never
  `ml/mr/pl/pr/left/right/text-left`. Add an ESLint `no-restricted-syntax` regex for those class names.
  Alternative considered: hand-written CSS with logical properties (zero deps) — viable, but utility classes avoid
  merge conflicts on shared CSS files in a multi-agent build.
- **i18n/RTL**: `i18next` resources bundled as TS modules (`locales/en.ts`, `locales/he.ts`; no HTTP backend — CSP
  has `connect-src 'none'`). On language change: `document.documentElement.lang = lng; document.documentElement.dir
  = lng === 'he' ? 'rtl' : 'ltr'`. Mixed-direction chat text: render each message/draft with `dir="auto"`.
  Dates via `Intl.DateTimeFormat(lng, …)`. Main process needs the same strings for tray/notifications -> keep
  `src/shared/i18n/` importable by both, with a tiny `t()` in main (no react-i18next there).
  First-run default: `app.getLocale()` starts with `he` -> Hebrew, else English.
- Icons: inline SVG components (4-6 icons). Skip `lucide-react@1.47.0` unless more are needed.

---

## 9. Testing

### 9.1 Vitest (`vitest@4.1.11`)

One root `vitest.config.ts` with two projects:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'main', environment: 'node',
                include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
                alias: { electron: new URL('./tests/mocks/electron.ts', import.meta.url).pathname } } },
      { plugins: [react()],
        test: { name: 'renderer', environment: 'jsdom', setupFiles: ['tests/setup-renderer.ts'],
                include: ['src/renderer/**/*.test.{ts,tsx}'] } },
    ],
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['**/*.test.*', 'src/renderer/src/locales/**'] },
  },
})
```

- **Architecture rule that makes main testable**: only `src/main/index.ts`, `src/main/window.ts`,
  `src/main/tray.ts`, `src/main/ipc/register.ts`, `src/main/secrets.ts` may import `electron`. Everything else
  (supervisor, bridge client, webhook server, db, agent pipeline, LLM providers, MCP host) takes its dependencies
  by injection and runs in plain Node. `tests/mocks/electron.ts` stubs `app.getPath`, `safeStorage`, `ipcMain`.
- `node:sqlite` is available to Vitest because the dev machine runs Node 24.19 — use `':memory:'` DBs per test.
- Renderer tests: `@testing-library/react@16.3.3` + `@testing-library/dom@^10` + `@testing-library/user-event@14.6.7`
  + `@testing-library/jest-dom@7.0.1`; `tests/setup-renderer.ts` installs a fake `window.api`. Include an RTL test:
  switch to `he` and assert `document.documentElement.dir === 'rtl'`.
- HTTP fakes: a **fake bridge** (`tests/fakes/fake-bridge.ts`, `node:http` server implementing `/api/health`,
  `/api/send`, `/api/pairing/status`, `/api/pairing/qr.png` and able to POST webhooks). It doubles as the E2E
  bridge — the real exe is never run by tests (HARD RULE 2).

### 9.2 Playwright Electron (`@playwright/test@1.63.0`)

- Electron support is still labelled **experimental** but is the de-facto standard
  (https://playwright.dev/docs/api/class-electron , https://www.electronjs.org/docs/latest/tutorial/automated-testing).
  No browser download is needed (`npx playwright install` is unnecessary for `_electron`).
- Launch the **built, unpackaged** app (fuses untouched, so the inspector-based attach works):

```ts
// tests/e2e/app.spec.ts
import { test, expect, _electron as electron } from '@playwright/test'
test('close button hides to tray, app stays alive', async () => {
  const userData = await fs.mkdtemp(join(os.tmpdir(), 'wca-e2e-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, WCA_E2E: '1', WCA_FAKE_BRIDGE_URL: fake.url, WCA_LLM: 'stub' },
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('list-needs-reply')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
  expect(await app.evaluate(({ app }) => app.isReady())).toBe(true)      // still running
  await app.evaluate(({ app }) => app.quit())
})
```

- E2E seams in main (guarded by `process.env.WCA_E2E === '1' && !app.isPackaged`): do not spawn the real bridge —
  point the bridge client at `WCA_FAKE_BRIDGE_URL`; use a stub LLM provider and an in-memory fake MCP calendar
  server; honour `--user-data-dir` via `app.setPath('userData', …)` **before** `ready` so tests never touch the
  real profile; skip the single-instance lock.
- The tray itself is not reachable through Playwright (native UI). Test it indirectly: export the menu template
  builder and unit-test it; in E2E call its click handlers through `app.evaluate`.
- `playwright.config.ts`: `workers: 1`, `fullyParallel: false`, `timeout: 60_000`, `retries: 1`,
  `use.trace: 'retain-on-failure'`. `electron-playwright-helpers@3.1.2` is optional (only useful for packaged-app
  path discovery and menu helpers) — not needed.
- Packaged smoke test (manual or CI): since `enableNodeCliInspectArguments` is false, `_electron.launch` would
  time out; instead start the exe with `--remote-debugging-port=<p>` and attach with `chromium.connectOverCDP`.
  **UNVERIFIED** on Electron 44.

### 9.3 Must-have E2E scenarios for this task's scope

1. X hides window; process alive; `second-instance` re-shows it (launch a second `electron.launch` and assert the
   first window becomes visible, second exits).
2. `--hidden` start: no visible window, tray created (`app.evaluate` on an exported test hook).
3. Quit from tray handler: supervisor children (fake long-running node child) are gone afterwards.
4. Language switch flips `dir` and tray labels.
5. Approval-first: a fake inbound webhook produces a draft; fake bridge records **zero** `/api/send` calls until
   the "Send" button is clicked; exactly one after.

---

## 10. electron-vite config shape

```ts
// electron.vite.config.ts
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: { target: 'node24', sourcemap: true },           // deps in "dependencies" are externalised by default
  },
  preload: {
    resolve: { alias: shared },
    build: { sourcemap: false, rollupOptions: { output: { format: 'cjs' } } },  // -> out/preload/index.cjs
  },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: { target: 'chrome152' },
  },
})
```

Conventions (electron-vite defaults): entries `src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/index.html`; output `out/{main,preload,renderer}`; `package.json#main = "./out/main/index.js"`.
`tsconfig.node.json` (main+preload+shared, `module: "NodeNext"`, `types: ["node", "electron-vite/node"]`) and
`tsconfig.web.json` (renderer+shared, `lib: ["ES2023","DOM","DOM.Iterable"]`, `jsx: "react-jsx"`), referenced from a
solution-style `tsconfig.json`. `@electron-toolkit/*` helper packages (`utils@4.0.0`, `preload@3.0.2`,
`tsconfig@2.0.0`) from the scaffold are **not** used: the generic `electronAPI` preload they expose contradicts the
allow-listed typed bridge in 4.4.

Why ESM in main: `node-llama-cpp` is ESM-only with top-level await and must be `import`ed un-bundled; Electron has
supported ESM main since v28. Caveat from Electron's ESM guide: in an ESM main, code before `app.whenReady()` must
be synchronous-safe — `protocol.registerSchemesAsPrivileged` and `requestSingleInstanceLock` must execute at module
top level **before any top-level `await`**. Lazy-load heavy modules: `const { getLlama } = await import('node-llama-cpp')`
only when the Local provider is selected (keeps cold start fast and lets Claude/Gemini users run even if the native
binary fails to load).

---

## 11. Directory layout

```
C:\dev\whatsapp agent\
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json  tsconfig.node.json  tsconfig.web.json
├─ vitest.config.ts  playwright.config.ts  eslint.config.js  .prettierrc.json
├─ build/                          # electron-builder buildResources
│  ├─ icon.ico                     # 16,20,24,32,40,48,64,256
│  └─ installer.nsh                # optional NSIS hooks
├─ resources/                      # shipped via extraResources (outside asar)
│  ├─ bridge/
│  │  ├─ whatsapp-bridge.exe       # prebuilt, copied once by the user/another task — never executed by tests
│  │  ├─ LICENSE                   # MIT (verygoodplugins/whatsapp-mcp)
│  │  └─ SHA256SUMS
│  └─ icons/  tray.ico  tray-paused.ico  tray-attention.ico  notification.png
├─ vendor/whatsapp-bridge-src/     # Go source vendored for reference only (not built, not packaged)
├─ src/
│  ├─ shared/                      # no electron/node imports; usable by main, preload(types), renderer
│  │  ├─ ipc.ts                    # IpcInvoke / IpcEvents contract + channel lists
│  │  ├─ types.ts                  # DashboardSnapshot, Draft, EventProposal, AgentStatus, Settings…
│  │  ├─ schemas.ts                # zod schemas for the above
│  │  └─ i18n/  en.ts  he.ts  index.ts
│  ├─ main/
│  │  ├─ index.ts                  # lifecycle: lock, AUMID, protocol, ready, quit sequence
│  │  ├─ window.ts  tray.ts  autostart.ts  notifications.ts  protocol.ts  paths.ts  logger.ts
│  │  ├─ ipc/        register.ts  handlers/*.ts  sender.ts
│  │  ├─ security/   csp.ts  navigation.ts
│  │  ├─ secrets.ts                # safeStorage wrapper (async API)
│  │  ├─ db/         index.ts  migrations.ts  repos/*.ts          # node:sqlite
│  │  ├─ proc/       supervisor.ts  reaper.ts  free-port.ts
│  │  ├─ bridge/     launcher.ts  client.ts  webhook-server.ts  pairing.ts
│  │  ├─ mcp/        host.ts  calendar-tools.ts                   # MCP client; read/write tool split
│  │  ├─ llm/        provider.ts  local.ts  claude.ts  gemini.ts  model-download.ts  hardware.ts
│  │  └─ agent/      pipeline.ts  classifier.ts  drafts.ts  proposals.ts  approvals.ts
│  ├─ preload/
│  │  └─ index.ts                  # contextBridge allow-list (CJS output)
│  └─ renderer/
│     ├─ index.html
│     └─ src/
│        ├─ main.tsx  App.tsx  styles.css  env.d.ts (window.api typing)
│        ├─ store/      dashboard.ts  settings.ts                 # zustand
│        ├─ i18n.ts     # react-i18next init + dir switch
│        ├─ views/      Dashboard.tsx  Settings.tsx  Onboarding.tsx
│        └─ components/ ListCard.tsx  NeedsReplyItem.tsx  CalendarItem.tsx  MissingInfoItem.tsx
│                       DraftEditor.tsx  StatusBar.tsx  LanguageToggle.tsx  ModelDownload.tsx  QrPairing.tsx
├─ tests/
│  ├─ mocks/electron.ts  setup-renderer.ts
│  ├─ fakes/  fake-bridge.ts  fake-mcp-calendar.ts  stub-llm.ts
│  └─ e2e/    app.spec.ts  tray-lifecycle.spec.ts  approval-first.spec.ts  i18n-rtl.spec.ts
├─ scripts/   make-icons.mjs  hash-bridge.mjs
├─ docs/research/…
├─ out/        (build output, git-ignored)
└─ dist/       (installers, git-ignored)
```

Runtime data (never in the repo), all under `app.getPath('userData')` =
`%APPDATA%\WhatsApp Calendar Agent\`: `app.db`, `logs/`, `models/*.gguf`, `bridge/` (CWD of the bridge ->
`bridge/store/*.db`, `bridge/bridge.pid`), `mcp/` (OAuth token cache if the MCP server is file-based).

---

## 12. Exact `package.json`

```json
{
  "name": "whatsapp-calendar-agent",
  "productName": "WhatsApp Calendar Agent",
  "version": "0.1.0",
  "private": true,
  "description": "Approval-first personal assistant: WhatsApp -> drafts -> Google Calendar",
  "type": "module",
  "main": "./out/main/index.js",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "npm run typecheck && electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "electron-vite build && playwright test",
    "icons": "node scripts/make-icons.mjs",
    "pack:dir": "npm run build && electron-builder --win --x64 --dir",
    "dist": "npm run build && electron-builder --win --x64"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "0.127.0",
    "@google/genai": "2.23.0",
    "@modelcontextprotocol/sdk": "1.30.0",
    "electron-log": "5.4.4",
    "node-llama-cpp": "3.21.1",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@electron/fuses": "2.1.3",
    "@eslint/js": "10.0.1",
    "@playwright/test": "1.63.0",
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/dom": "^10.0.0",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/node": "24.13.6",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "@vitest/coverage-v8": "4.1.11",
    "electron": "44.4.3",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "eslint": "10.11.0",
    "eslint-plugin-react-hooks": "7.1.1",
    "globals": "17.12.0",
    "i18next": "26.4.2",
    "jsdom": "30.1.0",
    "png-to-ico": "3.0.2",
    "prettier": "3.9.8",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-i18next": "17.0.14",
    "tailwindcss": "4.3.3",
    "typescript": "6.0.3",
    "typescript-eslint": "8.70.0",
    "vite": "7.3.6",
    "vitest": "4.1.11",
    "zustand": "5.0.15"
  }
}
```

Notes on the list:
- `@types/node` is pinned to the **24.x** line (`24.13.6`) to match Electron's embedded Node 24.21 (Electron itself
  depends on `@types/node ^24.9.0`); `@types/node@latest` is 26.x and would advertise APIs that do not exist at runtime.
- The three LLM/MCP SDK versions are the npm `latest` on 2026-09-21; the LLM/MCP research tasks own the final call
  on them (and on whether a Google-Calendar MCP server package is added to `dependencies`).
- `better-sqlite3@13.0.3` and `@types/better-sqlite3@9.6.0` intentionally absent (section 2). Fallback only.
- `electron-updater@6.8.9` intentionally absent until a signed release channel exists.
- Renderer libraries are in `devDependencies` on purpose (bundled by Vite, keeps packaged `node_modules` small) —
  see 1.2.
- First install: `npm install` then `npm approve-scripts node-llama-cpp esbuild` (1.1) and, for CI,
  `npx install-electron --no`.

---

## 13. Risks / gotchas checklist for implementers

1. **Vite 8 / plugin-react 6 / vitest 5 / TypeScript 7 are all "latest" on npm but must NOT be used** with
   `electron-vite@5.0.0` + `typescript-eslint@8.70.0`. Pin exact versions (no `^`) and commit the lockfile.
2. Unsigned bundled Go exe + unsigned installer -> SmartScreen and possible Defender quarantine of
   `whatsapp-bridge.exe`. Detect "file missing / spawn EPERM/ENOENT" and show a specific help message.
3. Windows hard-kills children (no SIGTERM) — by design; rely on SQLite durability; never kill by image name.
4. The user runs a second, personal copy of the same bridge — random ports, per-launch token, own CWD, PID-scoped
   reaping are mandatory, not nice-to-have.
5. `before-quit` is not fired on Windows shutdown/logoff -> `session-end` + orphan reaper.
6. Toasts silently fail without the AUMID Start-Menu shortcut (dev mode!). Do not treat "no toast in `npm run dev`" as a bug.
7. `safeStorage` ciphertext is bound to the Windows user + `userData/Local State`; treat decrypt failure as "key missing".
8. ESM main: nothing async before `registerSchemesAsPrivileged` / single-instance lock; lazy-import `node-llama-cpp`.
9. Sandboxed preload must stay CJS and dependency-free.
10. electron-builder docs online partly describe v27; trust `app-builder-lib@26.15.3/scheme.json`.
11. `runAsNode` fuse vs MCP-over-stdio trade-off must be settled together with the MCP task (4.5 / 6.5).
12. Installer upgrade while the app (and its children) are running needs an explicit test (section 7).

---

## 14. Sources

- Electron releases / schedule: https://releases.electronjs.org/release/v44.4.3 , https://releases.electronjs.org/schedule , https://www.electronjs.org/blog/electron-44-0
- Electron docs: https://www.electronjs.org/docs/latest/tutorial/security , https://www.electronjs.org/docs/latest/tutorial/fuses ,
  https://www.electronjs.org/docs/latest/api/tray , https://www.electronjs.org/docs/latest/api/app ,
  https://www.electronjs.org/docs/latest/api/browser-window , https://www.electronjs.org/docs/latest/api/safe-storage ,
  https://www.electronjs.org/docs/latest/api/utility-process , https://www.electronjs.org/docs/latest/api/native-image ,
  https://www.electronjs.org/docs/latest/tutorial/notifications , https://www.electronjs.org/docs/latest/tutorial/automated-testing
- node:sqlite: https://nodejs.org/docs/latest-v24.x/api/sqlite.html , https://github.com/electron/electron/issues/45532 ,
  https://github.com/vitejs/vite/discussions/19278 , https://github.com/yinxulai/one-switch/issues/9
- better-sqlite3 v13 (N-API): https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0
- electron-vite: https://electron-vite.org/guide/ , https://electron-vite.org/guide/dev , https://electron-vite.org/guide/dependency-handling ,
  https://github.com/alex8088/electron-vite/blob/master/CHANGELOG.md
- Electron Forge Vite plugin (experimental): https://www.electronforge.io/config/plugins/vite
- electron-builder: https://www.electron.build/docs/configuration/ , https://www.electron.build/docs/nsis/ ,
  `app-builder-lib@26.15.3/scheme.json` (npm tarball)
- node-llama-cpp in Electron: https://node-llama-cpp.withcat.ai/guide/electron
- Playwright Electron: https://playwright.dev/docs/api/class-electron
- Windows 11 tray overflow: https://www.elevenforum.com/t/hide-or-show-system-tray-icons-in-taskbar-corner-overflow-menu-in-windows-11.415/ ,
  https://tech-champion.com/microsoft-windows/windows-11-taskbar-overflow-explained-why-some-icons-stay-hidden-even-after-you-enable-them/
- npm registry (`npm view`, 2026-09-21) for every version number in this document; `npm help approve-scripts` (npm 11.17).
- Bridge Go source (read-only): `main.go`, `auth.go`, `webhook.go` in the user's `whatsapp-bridge` folder (store dir not accessed).
