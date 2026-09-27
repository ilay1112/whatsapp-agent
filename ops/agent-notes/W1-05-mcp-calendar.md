# W1-05-mcp-calendar - builder notes

Owned paths: `src/main/mcp/**`, `tests/fakes/fake-mcp-calendar.ts`, `tests/integration/mcp-real-toolslist.test.ts`.
Read: ARCH 5, A4, A9, A10; CONTRACTS 11 (+13 for the supervisor policy, 16 for the fake); `docs/research/calendar-mcp.md`;
TESTS 3.2, 4.2, 5.3 row `mcp/*`, 13, concern C7; `docs/specs/wave0-seams.md` section 18.

## Status

Done. All six source files implemented, six colocated test files, the fake and the real-server contract test.

**Fix round (2026-09-23, second pass).** The repo-wide audit attributed exactly one item to me: the
`npx prettier --check .` failure. Its own text says the root cause is W0's verbatim CONTRACTS blocks and that only
W2-01 can format the tree in one pass. What I *could* do inside my ownership, I did: I ran `npx prettier --write` on
my 14 owned files only (build-plan rule 8 forbids running a formatter on paths you do NOT own; running it on your own
paths is allowed). Repo-wide the count went **212 -> 198**; my paths are now `prettier --check` clean and stay out of
W2-01's single pass. Nothing else changed - no source logic altered, no test touched, weakened or deleted. All
153 + 7 tests are still green after the reformat, eslint is still clean, coverage still meets TESTS 13.

| Command | Result |
|---|---|
| `npx vitest run --project main src/main/mcp/` | 6 files, **153 tests green** |
| `npx vitest run --project integration tests/integration/mcp-real-toolslist.test.ts` | **7 tests green** (spawns the real staged server) |
| `npx eslint src/main/mcp tests/fakes/fake-mcp-calendar.ts tests/integration/mcp-real-toolslist.test.ts --max-warnings 0` | clean |
| `npx prettier --check` over the same paths | **clean** (fix round) |
| `npm run typecheck` | **no error in any file I own** (errors elsewhere listed below) |
| coverage (lines / functions / branches) | `host.ts` 100 / 95.3 / 92.5 - `readClient.ts` 100 / 100 / 100 - `writeClient.ts` 100 / 100 / 100 - `adminClient.ts` 100 / 100 / 99.0 - `projection.ts` 100 / 100 / 97.7 - `googleAuth.ts` 100 / 100 / 100 |

TESTS 13 requires 100 % lines on `writeClient.ts`, `projection.ts` and `host.ts` `callerFor`: all three are at 100 % lines.
`src/main/mcp/**` needs 90/85/90; the directory is at 100 lines / 96+ branches / 98+ functions.

No `BLOCKED-BY`: nothing I own depends on another package's Wave 0 stub. `shared/when.ts` (`epochMsToLocal`) and
`shared/schemas.ts` (`stripInvisible`) were already implemented by W1-08 / W0 when I ran, so `projection.ts` is tested
against the real implementations.

## What was already there when I resumed

An earlier interrupted attempt had left all six `src/main/mcp/*.ts` files and `tests/fakes/fake-mcp-calendar.ts`
implemented but **no tests at all**. I continued from that code rather than rewriting it: I reviewed every file against
CONTRACTS 11 / ARCH 5 / the seams file, then wrote the test suite and fixed the three defects the tests exposed (below).

## Design notes and decisions

### `callerFor(cls)` is the only exit (ARCH 5.2 `[R2]`)

`host.ts` keeps the SDK `Client`, the transport and the child in a closure. The returned host object has exactly
`start, stop, status, onStatus, pid, callerFor, childSpec` (asserted by a test) - no `caller`, no `client`, no getter.
The wrapper does two things before anything else happens: (1) `MCP_TOOLS[tool] !== cls` => audit `tool_blocked`
`{nameSha8, nameLen, verdict:'blocked_not_exposed', runId:0}` and `throw new McpCapabilityError(cls)`; (2) unless the
status is `connected | needs_sign_in | signing_in`, answer `{ok:false,'unavailable'}` without touching the transport.
Tests prove the fake records **zero** calls when a monkey-patched read client asks for `create-event`, and that the
tool name itself never appears in an audit row (it is attacker/bug-supplied text).

### Statuses

- `statusForAccountList()` (new, exported): a `manage-accounts list` answer that shows `personal` as **`expired` or
  `error`** now yields `reconnect_required`, not `needs_sign_in`. Rationale: the credentials file is fine, the stored
  refresh token is not - the UI must offer "Reconnect Google" (`CAL_RECONNECT`), and `calendar-mcp.md` "OAuth flow"
  describes exactly this state. `needs_sign_in` stays for "the server does not know the account at all".
  `listShowsActiveAccount()` is kept as a thin wrapper so nothing that already reads it breaks.
- `invalid_grant` in a tool result or a thrown error flips the host to `reconnect_required` and **never** restarts the
  child (a restart would re-read the same dead token file). `EADDRINUSE` / "ports 3500-3505" => `port_busy`.
- A toolset mismatch is terminal for the Supervisor (`childSpec().terminal()` is true): respawning a wrong or upgraded
  server can only fail the same way. The toolset is re-verified on **every** start, so an upgrade that lands between
  two spawns is caught (test: `re-verifies the toolset after every restart`).

### Projection (`projection.ts`, safety-critical)

Raw server text never leaves the module - every exported function returns typed app values or `bad_response`.
Free/busy: a calendar the server reported an `errors[]` for is **never** projected as free (fail closed).
Events: only `startLocal`, `endLocal` and a sanitised, 60-char-capped title survive; description, location, attendees,
organiser, conferencing and `htmlLink` are dropped (asserted by serialising the result and grepping for the hostile
strings). `htmlLink` survives only for `AppEventRef`/`CreateEventResult`, and only when it is `https:` on a
`*.google.com` host. `waAction`/`waAgent` tags are **re-checked** in `projectAppEvent`: the server-side
`privateExtendedProperty` filter is a request, not a guarantee.

### Write facade

`createEvent` builds the outbound object key by key from the ARCH 5.4 whitelist - never spread, never `Object.assign`.
`account`, `sendUpdates:'none'` and `extendedProperties.private.waAgent:'1'` are re-asserted from constants, and
`allowDuplicates` is `=== true` (so a truthy `1` from a cast becomes `false`). A test feeds a hostile `CreateEventArgs`
carrying `attendees`, `recurrence`, `conferenceData`, `calendarsToCheck`, `sendUpdates:'all'` and proves none reaches
the call. `location` is included only when it is a non-empty string.

### Google wizard

`validateCredentialsJson` checks the **endpoints first** (`[R2] bad_endpoint`), before the friendlier
`no_localhost_redirect`, so a phished file naming `token_uri: https://evil.example/token` cannot hide behind a missing
redirect list. Nothing is written to disk when validation fails. The `auth_url` from `manage-accounts add` is untrusted
server text: it is opened only when `protocol === 'https:' && hostname === 'accounts.google.com'`, otherwise it is
refused, audited (`spawn_refused {what:'auth_url', reason:'bad_host'}`) and the URL itself is **not** stored in the
audit row. The sign-in poll uses the injected `Clock`, so the 5-minute budget is instantaneous in tests.

## Defects found and fixed by the tests

1. `tests/fakes/fake-mcp-calendar.ts`: `clientTransport()` handed the client half of the `InMemoryTransport` pair to
   `mcp/host.ts` while `connect()` still attached the fake's own `Client` to the same half - two clients fighting over
   one transport. `connect()` now connects only the server half once `clientTransport()` has been taken. (The dead
   `clientHalfTakenOver` flag from the interrupted attempt was the leftover of this unfinished fix; it was also the
   only lint error in my paths.)
2. `host.ts`: expired tokens were reported as `needs_sign_in` (see `statusForAccountList` above).
3. `tests/fakes/fake-mcp-calendar.ts`: the fake's tool `annotations` did not match the real server's. Corrected from a
   real `tools/list` capture (see the finding below).

## C7 finding: the real server's `tools/list`, captured 2026-09-23

`tests/integration/mcp-real-toolslist.test.ts` spawns the **real** staged
`build-resources/calendar-mcp/node_modules/@cocal/google-calendar-mcp/build/index.js` through `process.execPath` with a
dummy `installed` credentials fixture and a temp token path, and performs `initialize` + `tools/list` only. Results:

- **(a)** With `ENABLED_TOOLS` set to our six names, `tools/list` returns **exactly those six**. Confirmed.
- **(b)** `get-current-time`, `get-freebusy`, `list-events` (and `list-calendars`) carry `readOnlyHint: true`. Confirmed.
- **(c)** Required fields match `REQUIRED_INPUT_FIELDS` (`get-freebusy: calendars/timeMin/timeMax`,
  `list-events: calendarId`, `create-event: calendarId/summary/start/end`, `manage-accounts: action`). Confirmed.
- `verifyToolset()` from `host.ts` accepts the real server unchanged.
- **Annotations (was UNVERIFIED, now captured)** - the fake was corrected to match exactly:

  | tool | annotations |
  |---|---|
  | `get-current-time`, `get-freebusy`, `list-events`, `list-calendars` | `readOnlyHint:true, openWorldHint:false` |
  | `create-event` | `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false` |
  | `manage-accounts` | `readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false` |

- **Passivity (TESTS 3.2 / concern C7, was UNVERIFIED): the real server stays passive during `initialize`.** With dummy
  credentials and no token file it opened **no listener on 3500-3505**, wrote no `awaiting_authentication` /
  `oauth2callback` line to stderr, and started no browser. The test asserts this every run, so a regression in a future
  server version becomes a red test rather than a surprise OAuth window. The fixture credentials must keep
  `redirect_uris[0]` - the server dereferences it before the handshake (TESTS section 11 `[R2]`).
- The response **body** shapes of `tools/call` remain UNVERIFIED (no Google account in an automated test): `projection.ts`
  and the fake's `// RESPONSE SHAPES (cocal 2.6.3)` section are still the assumed shapes, to be corrected in those two
  places after manual run M6.

Nothing in the test ever issues `tools/call`; a source-grep test guards that against a future edit. The child is closed
inside `beforeAll`'s `finally`, because the T7 leak guard fails the first `afterEach` otherwise.

## Assumptions

- `McpHostExtras` (`transportFactory`, `clientFactory`, `spawnOverride`, `audit`, `clock`, `log`, `callTimeoutMs`,
  `startupTimeoutMs`, `appVersion`) is **additive and all-optional**, so `createMcpHost(deps: McpHostDeps)` from the
  frozen seam still compiles and gets the production defaults. `transportFactory` is the S-MCP seam of TESTS 4.3 and
  `spawnOverride` is the `WCA_MCP_CMD` seam of TESTS 4.2 (it replaces command+args only; the ARCH 5.1 env block is
  unchanged - there is a test for that).
- `McpHostWithChildSpec = McpHost & { childSpec(): ChildSpec }` is the seams-file addition; `compose.ts` (W2-01) is the
  only consumer. `ChildSpec.start(attempt)` is satisfied by a zero-arg `start()`.
- The three READ-class tools are the ones that must advertise `readOnlyHint:true` (ARCH 5.1 wording). The real server
  also sets it on `list-calendars`; `verifyToolset` does not forbid that.
- Over an `InMemoryTransport` there is no child, so `pid()` is `null` and `childSpec().start()` reports `pid: 0`.

## REQUESTS

**W2-01-compose-integration**

1. Wire the calendar exactly as ARCH 5.2 `[R2]`: `createMcpReadClient(host.callerFor('read'))`,
   `createMcpWriteClient(host.callerFor('write'))`, `createMcpAdminClient(host.callerFor('admin'))`. Never pass the host
   itself to a facade, and never construct `McpWriteClient` anywhere but `compose.ts`.
2. `createMcpHost` needs `{ execPath: process.execPath, mcpRoot: paths.mcpRoot, credentialsPath: paths.googleCredentials,
   tokenPath: paths.googleTokens, onStderrMarker }` plus, in Wave 2, `audit`, `clock`, `log`, `appVersion` and the
   `spawnOverride` read from `WCA_MCP_CMD` (dev/e2e only). Register `host.childSpec()` with the Supervisor.
3. `createGoogleAuth` needs `host` (the same instance), the three facades' admin + read clients, `paths`,
   `electron.openExternal`, `clock`, `log`, `audit` and `targetCalendarId: () => settings.calendar.targetCalendarId`.
4. **Repo-wide, still not mine to fix - but reduced.** `npx prettier --check .` was 212 files; in the fix round I
   formatted my 14 owned files, leaving **198**. The remainder is the verbatim CONTRACTS blocks W0 pasted, the
   W0-frozen root configs (`vitest.config.ts`, `tsconfig.json`, ...) and other packages' sources - none of it mine to
   touch. `npm run verify` runs `format:check`, so it still cannot pass until W2-01 formats the rest in one pass.
5. `npm run typecheck`, re-run in the fix round: every error I listed in the first pass has since been fixed by its
   owner. **One** error remains repo-wide and it is not in a file I own -
   `src/main/ipc/register.fixtures.ts(76,9): error TS2741: Property 'settingsNotified' is missing in type
   '{ audits: never[]; logs: never[]; opened: never[]; clipboard: never[]; openDialogs: never[]; saveDialogs: never[];
   notifications: never[]; timers: never[]; }' but required in type 'Recorders'` - owner **W1-13-ipc-preload**.

**W1-11-exec** - `McpWriteClient.createEvent` returns `{ok:false,'id_exists'}` for a 409 on our deterministic `eventId`
(the event exists from an earlier attempt of the same chain => record `done` and let reconcile fill in the details) and
`{ok:false,'duplicate'}` for the server's similarity heuristic (=> `CAL_DUPLICATE`, "Create anyway" as a new click with
`allowDuplicates:true`). `findAppEvent(chainRootActionId, w)` takes the **chain-root** action id and re-checks the
`waAgent='1'` + `waAction=<id>` tags itself; it returns the earliest matching event, or `null` when there is none.

**W1-09-agent-guard / W1-10-agent-pipeline** - `mcp/readClient.ts` is the only `mcp/*` module `agent/**` may import, and
it exports no value that can reach a write: `McpToolCaller<'read'>` values only ever come from `host.callerFor('read')`.
`listEvents()` does not exist on the facade (`[R2]`); `findAppEvent` is reconcile-only and is not in ToolGate's name
table. `projectEvents()` is exported from `projection.ts` for `exec/reconcile.ts`, not for the pipeline.

**W1-13-ipc-preload** - `GoogleAuthService` is the whole surface for the Google IPC handlers
(`wizardState`, `importCredentials`, `startSignIn`, `status`, `disconnect`, `listCalendars`, `onChange`). Failures come
back as `Result<...>` with an `ErrorCode` (`GOOGLE_CREDENTIALS_INVALID`, `GOOGLE_SIGNIN_TIMEOUT`, `CAL_RECONNECT`,
`CAL_PORT_BUSY`, `CAL_TOOLSET_MISMATCH`, `CAL_UNAVAILABLE`); `credentialsProblem` on the wizard state carries the
specific `CredentialsProblem` for the setup screen. The credentials JSON text must be read in **main** (native dialog)
and never pass through the renderer as a path.

Also (fix round): `src/main/ipc/register.fixtures.ts(76,9)` fails `npm run typecheck` - the `Recorders` literal is
missing `settingsNotified`. It is the only typecheck error left in the repo and it blocks `npm run verify` for W2-01.

## Dead ends

- Importing `McpCallerSource` from `src/main/mcp/readClient.ts` into the fake (as CONTRACTS 16 writes it) is not
  possible: TESTS 2.3 forbids any `src/**` import in a spawnable fake, type-only or not. The fake therefore mirrors the
  types locally (`FAKE_MCP_TOOLS`, `FakeMcpToolCaller`, ...); `host.test.ts` asserts the fake's `callerFor` is
  structurally a `McpCallerSource` and rejects an out-of-class tool the same way, so the mirror cannot drift silently.
- The first attempt at the real-server contract test closed the child in `afterAll`; the T7 leak guard failed the first
  `afterEach` with "child pid ... was still running". The handshake now happens entirely inside `beforeAll`.
