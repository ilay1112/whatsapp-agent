# leftovers - workflow 9 (D-080 round): signing docs, README v2, verify chain, midnight flake, read-tools guard

Date: 2026-10-05. Owner files: `README.md`, `docs/WINDOWS-SECURITY.md`, `package.json` (scripts block + `license`),
`src/main/ipc/handlers/settings.ts` + its tests, `src/renderer/src/components/UndoDismissDrawer.test.tsx`.
No CLI, bridge, packaged app or user data touched. No dependency / version change. No commit.

Resumed after a usage-limit interruption: at resume the tree was clean (`git status` empty), so nothing of this task had
landed on disk yet; started from the top.

## Plan
1. WINDOWS-SECURITY.md section 3 from `signing-pipeline.md` + `signing-fix.md` (+ D-078 SAC facts).
2. README: features already describe v2 (an earlier session moved them); remaining = licence MIT, code-signing section,
   CLI sign-in note, Smart App Control limit, citable test counts (PROGRESS 69: Vitest 7587 passed twice, e2e 47/47).
3. `verify`: add `npm run test:defender` after `test:smoke`. `"license": "MIT"`.
4. UndoDismissDrawer midnight flake: fake the clock.
5. settings:set guard for `readTools.enabled` with stored `all_chats` (failing test first).

## Done
1. **docs/WINDOWS-SECURITY.md section 3** replaced the orchestrator placeholder: what this PC lacks (a Trusted Root Program
   certificate; signtool - re-checked read-only 2026-10-05: no `C:\Program Files (x86)\Windows Kits` folder; the per-file
   pins `--pin-files` / `--pin-crt`), the full env table (WCA_SIGN_MODE, _TIMESTAMP_URL, WCA_SIGNTOOL_PATH, _CERT_SHA1,
   _PUBLISHER, WCA_AZURE_ENDPOINT/_ACCOUNT/_PROFILE/_DLIB; names checked against `SIGN_ENV` in scripts/sign-windows.mjs),
   the enforced rules (same WCA_SIGN_MODE for build + pack, every PE by header, provenance first, signed bridge pin in
   app.asar with asar integrity on, failed build = never ship), a PowerShell run-through with placeholders only, and the
   Defender enforcement rule. Section 6 now states SAC DID block the unsigned exe (CodeIntegrity 3033/3077/3118, PROGRESS 65).
   No thumbprint, PIN, secret or personal value anywhere.
2. **README.md**: v2 features were already under Features (an earlier session moved them); added Licence row + MIT licence
   section, "Signing in to Claude Code / Antigravity" (own login in a visible window, never sees credentials, Claude sessions
   expire, Antigravity's isolated profile, refused model -> model choice), "Code signing and Windows security" (contains the
   phrase "Code signing", which sign-windows.mjs error text points to), a roadmap bullet, `test:defender` row, test counts
   cited from PROGRESS 69 only (Vitest 7587 passed twice, e2e 47/47) + the smoke/SAC limit, updated weaknesses and
   troubleshooting rows (SAC block, false positive, expired Claude session, refused model).
3. **package.json**: `"license": "MIT"`; `verify` = ... `test:smoke && test:defender && audit:prod`.
4. **UndoDismissDrawer.test.tsx**: the today/older test pins Date only (`vi.useFakeTimers({ toFake: ['Date'] })`,
   2026-10-05T09:00Z = 12:00 Asia/Jerusalem) and now asserts MORE (today shows `11:00`, older shows no clock time). A second
   test pins 00:30 local and proves the formerly flaky case: 10 min ago = `00:20` today, 1 h ago = day label.
5. **settings:set guard (ux-i18n-v2-5)**: failing test first (red: scope stayed `all_chats`). Fix in `settings.ts`: when the
   patch sets `readTools.enabled=true`, reading is stored OFF and the stored scope is `all_chats`, main narrows the scope to
   `trigger_chat` (setInternal + audit `whatsapp.readTools.scope`) BEFORE the patch, so no write ever pairs enabled with an
   unconfirmed all_chats; widening again needs wa:setReadScope (consent + native dialog). The merged patch is pre-validated
   on the narrowed view, so a refused patch writes nothing (tested: VOICE_MODEL_MISSING and a merged BAD_REQUEST leave
   `{enabled:false, scope:'all_chats'}` and no audit). Guard is narrow (tested): already-on all_chats, trigger_chat, or a
   patch that does not enable keep the stored scope. Consistent with the renderer's ReadTools flow (it narrows first itself).

## Verification (2026-10-05 ~02:20 local)
- `npm run lint`: 0.
- `npm run typecheck`: 1 error, NOT mine: `src/renderer/src/components/ConnectCard.signin.test.tsx(55)` `lastError` prop
  (a parallel D-080 renderer agent's failing-first test).
- `npm run format:check`: 3 files, NOT mine (cliSignIn.ts, ConnectCard.signin.test.tsx, ChooseAi.signin.test.tsx). All my
  files pass `prettier --check`.
- `npx vitest run`: 334 files, **7736 passed, 42 failed** (7 files), 1 expected fail, 1 skipped, 2 errors. Every failure is
  in a parallel D-080 agent's in-progress file: antigravityCli.test.ts, locator.test.ts, runner.test.ts,
  shared/errors.d080.test.ts, ConnectCard.signin.test.tsx, ChooseAi.signin.test.tsx, Settings.test.tsx (new voiceIntent
  test). My files: settings.test.ts + settings.v2.test.ts 24 passed; UndoDismissDrawer.test.tsx 18 passed; ipc handlers +
  register 263 passed.

## Hand-off (orchestrator)
- `package-lock.json` root (`packages[""]`) has no `license`; the next `npm install` will add `"license": "MIT"` there. Not
  my file; harmless for `npm ci`.
- README "Signing in" + troubleshooting describe the D-080 sign-in session and CLI_MODEL_REJECTED as specified for this
  round (Sign in button, visible console, auto re-test on close, "choose another model"). If the main/renderer agents land a
  different UX, adjust those lines.
- The guard writes twice (setInternal, then patch) -> two onChange notifications and two audits; both carry the narrowed
  scope. A single-write variant would need a SettingsBus change (not mine).
