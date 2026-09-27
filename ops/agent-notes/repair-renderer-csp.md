# repair-renderer-csp - builder notes

Repair package: **renderer-csp**. Date: 2026-09-23.
Owned paths this run: `src/main/app/protocol.ts`, `src/main/app/protocol.test.ts`, `src/renderer/index.html`,
the CSP section of `tests/security/electron-hardening.test.ts`, this file.
Trigger: REQUEST 8 in `ops/agent-notes/W2-03-e2e.md`.

## 1. The defect

`src/renderer/index.html` carried the full ARCH 15.1 policy in a `<meta http-equiv="Content-Security-Policy">` tag,
including `frame-ancestors 'none'`. Chromium **ignores** `frame-ancestors` in a meta tag (it is header-only by spec)
and reports it as a renderer console **error** on every single load:

> Content Security Policy directive 'frame-ancestors' is ignored when delivered via a `<meta>` element.

Consequence: `tests/e2e/helpers/fixtures.ts` had to keep a global `ALWAYS_ALLOWED_CONSOLE` entry, which weakened
"any renderer console error fails the spec" for **all** e2e specs, not just the one that caused it.

Note that the directive was **never** lost as a control: `createBundleHandler` has always set the full `CSP` string as
a `Content-Security-Policy` response header on every response, success and denial alike (ARCH 15.1 says
"Production CSP (response header)"). The meta tag is defence in depth behind that header. So this repair removes a
*no-op copy* of the directive, not the enforcement.

## 2. What changed

### `src/main/app/protocol.ts`

- `CSP` - **unchanged, byte for byte**, `frame-ancestors 'none'` still in it, still on every response header. Only its
  doc comment grew (it now says why the header is the enforced copy).
- **New** `META_IGNORED_DIRECTIVES = ['frame-ancestors', 'report-uri', 'sandbox']` - the directives Chromium refuses to
  honour in a meta tag. `report-uri`/`sandbox` are not in our policy; they are listed so a future directive added to
  `CSP` is handled rather than silently re-introducing a boot-time console error.
- **New** `META_CSP` - **derived** from `CSP` by filtering those directive names out and re-joining with `'; '`. It is
  never re-typed as a literal, so the meta tag and the header cannot drift; the derivation preserves order and every
  remaining directive byte for byte.

### `src/renderer/index.html`

The meta `content` attribute lost exactly one directive plus its separator. Nothing else in the file changed except an
added explanatory comment above the tag.

| | string |
|---|---|
| before (meta) | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'` |
| after (meta) = `META_CSP` | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'` |
| response header = `CSP` | unchanged, still `... form-action 'none'; frame-ancestors 'none'; object-src 'none'` |

`connect-src 'none'` is intact in both copies - `app.spec.ts` deliberately provokes a `connect-src` refusal and that
refusal still comes from the meta tag as well as the header.

## 3. Exactly which assertions moved, and why

| File | Assertion | Change |
|---|---|---|
| `src/main/app/protocol.test.ts` | `CSP` is byte-for-byte the ARCH 15.1 string; contains `frame-ancestors 'none'` | **untouched** - the header policy did not change |
| `src/main/app/protocol.test.ts` | new `describe('META_CSP')`, 4 tests | **added**: exact string; `frame-ancestors` is the *only* directive dropped (computed as a set difference, so adding a second dropped directive fails here); remaining directives equal `CSP`'s in order; `CSP !== META_CSP` so the enforceable copy can never be silently replaced by the meta one |
| `tests/security/electron-hardening.test.ts` | "is the exact header string" / "forbids every network sink" incl. `directives['frame-ancestors']` | **untouched** - still asserts `frame-ancestors 'none'` on the header |
| `tests/security/electron-hardening.test.ts` | "is sent on every protocol response, success or denial" | **untouched** |
| `tests/security/electron-hardening.test.ts` | new nested `describe('the renderer <meta> tag')`, 3 tests | **added**: parses the real `src/renderer/index.html` and asserts the tag content is exactly `META_CSP`; that `frame-ancestors` appears nowhere in the document (HTML comments stripped first, so the explanatory comment does not satisfy or break it); that every non-`frame-ancestors` directive of `CSP` is present verbatim |

No assertion was deleted, weakened or skipped. The only test-side edits are additions plus two import lines
(`META_CSP`, `META_IGNORED_DIRECTIVES`). Net effect on coverage of the CSP surface: the meta tag was previously
asserted by **nothing**; it now has a source-level pin.

## 4. Verification

| Command | Result |
|---|---|
| `npx vitest run --project main --project renderer --project security` | **151 files, 3525 tests, all passed**, 0 failed, 0 skipped |
| `npm run lint` (`eslint . --max-warnings 0`) | exit 0 |
| `npm run typecheck` (node + web + tests tsconfigs) | exit 0 - note the `tsconfig.tests.json` errors W2-03 reported in `electron-hardening.test.ts` are no longer present |
| `npx prettier --check` over the four touched files | clean (`protocol.ts` needed one `--write` for the wrapped `.filter(...)`) |

Baseline before the change, same two files: 101 tests green - so nothing was red going in and nothing is red going out.
No build was run, no binary executed, no network touched.

## 5. Hand-off / follow-ups for other owners

1. **`tests/e2e/helpers/fixtures.ts` (owner W2-03-e2e).** `ALWAYS_ALLOWED_CONSOLE` can now be emptied - the message it
   allow-lists can no longer be produced. I did **not** edit it: it is W2-03's owned path and I cannot run
   `npm run test:e2e` here to prove the removal (that needs a built bundle). Leaving the entry in place is harmless
   (it allows a string nothing emits) but it keeps the console rule looking weaker than it now is. Suggested patch:
   `const ALWAYS_ALLOWED_CONSOLE: string[] = [];` plus a comment pointing at this file. Per-launch opt-ins
   (`app.spec.ts`'s deliberate `connect-src` refusal) are unaffected.
2. **`out/` is stale.** `out/renderer/index.html` still carries the old meta tag, and the `out/.e2e-build` marker is now
   older than the source. Anyone running e2e must re-run `npm run build:e2e` first - `globalSetup.ts` will refuse
   otherwise, which is the correct behaviour. I deliberately did not run a build: a plain `npm run build` would have
   invalidated the e2e marker without producing an e2e bundle.
3. **`docs/ARCHITECTURE.md` 15.1** already says "Production CSP (**response header**)", so no doc change is owed. If the
   orchestrator wants the meta tag documented as defence-in-depth, that is a one-sentence addition to 15.1 - not mine
   to make.

## 6. Assumptions

- The meta tag is worth keeping at all: it is the only CSP in play during a Vite dev/HMR load, where the `app://`
  protocol handler is not serving the document. Dropping the tag entirely would have been the other valid reading of
  REQUEST 8 ("move it to the header **or** drop it from the meta tag"); I kept the tag minus the one ignored directive
  because that loses nothing and keeps dev-mode parity.
- Deriving `META_CSP` from `CSP` rather than writing a second literal is the anti-drift choice; the cost is that
  `META_CSP` is computed at module load in the main process, which is a two-call string operation on a constant.
