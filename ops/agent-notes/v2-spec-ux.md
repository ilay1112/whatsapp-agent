# Agent notes - v2 SPEC "ux" (`v2-spec-ux`)

Date: 2026-09-28. Deliverable: `docs/specs/v2-ux.md` (delta over `docs/specs/ux.md`). Label chosen as `v2-spec-ux` because `v2-ux.md` belongs to the v2 UX *proposal* agent.

## What I read
- `docs/ARCHITECTURE-v2.md` in full (B1-B32, I1'-I12, sections 3-18) - binding.
- `docs/specs/ux.md` in full (v1 R2 spec: tokens, card anatomy, copy rules, a11y, concerns C1-C13).
- `docs/proposals/v2-ux.md` in full (the source of the grafted UX pieces).
- `docs/research/v2-auto-mode-safety.md` 5.5 (exhaustive `AUTO_REASONS`) and 6.
- `docs/research/v2-claude-cli-backend.md` / `v2-gemini-cli-backend.md` (install/sign-in lines only).
- Live renderer: component list, `data-testid` inventory, `src/shared/locales/en.json` + `he.json` key namespaces (the real files use `label.badge.*`, `errors.<CODE>.{title,body,action}`, `label.errorAction.*`, not the illustrative keys of ux.md), `src/shared/health.ts`, `src/shared/ipc.ts` (`action:reject` exists - used for "Keep 15:00").
- `ops/CONTEXT.md` v2 request.

## Web checks (read-only, 2026-09-28)
- code.claude.com/docs/en/setup: native install `irm https://claude.ai/install.ps1 | iex`; WinGet `winget install Anthropic.ClaudeCode` does not auto-update (`winget upgrade Anthropic.ClaudeCode`); `claude update` for native/npm. -> concern C2 (update command depends on install kind).
- antigravity.google/docs/cli/install: `irm https://antigravity.google/cli/install.ps1 | iex`, binary `%LOCALAPPDATA%\agy\bin`, sign-in = first interactive `agy` opens the browser.
Nothing was installed or run; no vendor CLI invoked; the reference `store` was not touched.

## Decisions taken in the spec (all inside ARCH-v2)
- Fourth "voice" of text: machine-transcribed contact text = contact bubble + app header strip + **dotted** rule + fixed caution line. Keeps "three voices" distinguishable in forced colours.
- Undo is never accent; "Approve change" is outline when "Approve & send" is on the card.
- Hebrew Undo = "ביטול השינוי" (bare "ביטול" next to an event reads as "cancel the event"). Regression test requested.
- Status panel keeps one sub-line per row; multiple AI facts joined with " · ".
- Sizes always interpolated with the v1 bytes/2^30 formula (1.5 GB voice, 0.9 GB projector) - ARCH literals 1.6/0.99 flagged (C1).
- Scope controls read-only while a policy is live (no scope-update IPC) - C6.
- Enable buttons are outline (the native dialog is the decision), trial listed first.
- Gemini CLI: one muted help line saying it cannot use the subscription (B14), pointing to Antigravity (experimental) or API key.

## Architecture concerns raised (section 16 of the spec)
C1 size literals; C2 update command / install kind; C3 sign-in detection latency (auth status 1/min); C4 enabling auto with antigravity active; C5 `auto:getState` lacks preconditions; C6 no scope narrowing IPC; C7 quiet hours toggle vs schema; C8 no ErrorCode for 3/h dialog limit; C9 no channel for "Cancel event" after `blocked_started`; C10 thumbnails in list payload; C11 who sets `voice.enabled`; C12 `no_user_echo` unreachable; C13 one sub-line vs three facts; C14 no pictures fact in AppHealth; C15 state after rejecting an update_event; C16 toast-Undo result toast (addition); C17 agy sign-in console cwd; C18 `auto:listWrites` row shape; C19 opaque event key for de-dup; C20 dated Gemini CLI sentence.

## Hand-off
- L9 owns both locale files; section 14 is the key list (en + he). Parity + exhaustiveness tests over `AUTO_REASONS`, new ErrorCodes and badge codes.
- L4 needs section 5 (toasts) and 4.5.1 (native dialog copy, FSI/PDI wrapping of the calendar name).
- Orchestrator: C5, C9, C15, C18 are contract gaps that block exact L9 wiring; the rest have spec-side fallbacks.
