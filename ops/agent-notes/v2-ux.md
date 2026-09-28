# Agent notes - v2 architecture proposal, UX-FIRST angle (`v2-ux`)

Date: 2026-09-28. Output: `docs/proposals/v2-ux.md`. This file is my reasoning trail and hand-off; the proposal is the deliverable.

## What I read

All eight `docs/research/v2-*.md` (full text), `docs/ARCHITECTURE.md` sections 0-20 (all), `ops/CONTEXT.md` (v2 request + option dialog), `ops/DECISIONS.md` D-036..D-041, `docs/proposals/ux.md` (v1, for vocabulary continuity), `docs/specs/ux.md` sections 5.2-5.5, 6.5-6.7, 9, 10, 11.4, 12.3, 15.1 (status strip, card anatomy, badges, settings groups, dialogs, error deck, notifications, copy rules), `docs/specs/contracts.md` section 2 (ErrorCode list) and the constant locations (PROVIDER_IDS, BADGES, CONSENT_KINDS, LIMITS, AUDIT_KINDS). No binaries run, no vendor CLI invoked, nothing under the reference `store` touched. Web verification was already done by the research agents on 2026-09-27/28; I did not re-fetch and I say so by citing their dates.

## Assumptions

- The session was resumed after a usage-limit stop with no prior partial file (`docs/proposals/` had only the v1 proposals), so I wrote from scratch.
- Research facts are taken as verified where the report marks them verified; every UNVERIFIED item I rely on is carried into section 18 of the proposal with the manual gate.
- The orchestrator will judge three angle proposals (as in v1); I therefore took explicit sides on every open research question (section 16) rather than listing options.

## Decisions I took and why (UX angle) - summary for the judge

1. Auto mode = grant with trial + expiry, native dialog; **no fourth dashboard list** - an AutoStrip above the three lists plus an `automatic` chip. Reason: the user asked for a minimal three-list dashboard; a strip that disappears when there is nothing to undo keeps that promise.
2. One undo path (`item:undoChange`) with three doors (toast, card, activity page). Reason: undo must be the cheapest action; the auto-mode and editing research already converge on this.
3. CLI setup as a three-state Connect card; the app never installs or logs in; "Sign in" opens a *visible* console running the vendor's own command. Reason: the legal pages forbid intermediating credentials; a visible console is honest and needs no explanation.
4. F1 = vendored patch **plus** a runtime soft-cancel fallback that never disables the calendar write surface. Reason: a cancel-only gap must not cost "Add to calendar" (the research's fail-closed `CAL_TOOLSET_MISMATCH` would).
5. Media bytes file-first (bridge already writes them; `messages.filename` holds the name) + `POST /api/download` fallback for both audio and images; A16 becomes five endpoints; `GET /api/media` stays unimplemented. Reason: one media path, no streaming client. Marked as switchable (U-I3) because the image report preferred `/api/media` over mid-write risk; I added container validation + one retry to cover that.
6. Claude runs strictly tool-less (accept bug #87234's retry) so "the AI has no tools" is literally true in the settings copy.
7. Antigravity ships opt-in, experimental, tool-less, with the section 6 disclosure and the Terms date in the consent record; auto mode with either CLI is allowed only per run whose init assertion passed (`proposals.provider_proof`).
8. Voice cards: no playback in v2.0 (renderer holds display data only); "Transcribing a voice note (0:42)..." replaces "Analysing N chats" in the header so the visibility rule (queued/running items are not listed) survives without a mystery wait.
9. Pictures: projector download prompted from the placeholder card, never in onboarding; consent `cloud_images` asked once per cloud provider; thumbnails deleted with the item's text retention.

## Dead ends considered

- A fourth column "Automatic" (auto-mode research 6.1): rejected for the three-list promise; the strip gives the same visibility.
- Offering automatic mode during onboarding: rejected - the trial needs real cards, and the native dialog's bullets only make sense after the user has seen approvals work.
- Reading the store directory for images was argued against by the image report (mid-write); I kept file-first for both kinds but added validation + retry and a documented switch. The judge may prefer `/api/media`; the cost is one streaming client and a sixth endpoint.
- `whisper-server` as a fourth child: rejected per the whisper report (no auth, needs ffmpeg for `--convert`); documented swap if model load dominates.
- Showing the raw voice card while transcribing (v1 ux D1 idea): would relitigate the ARCH visibility rule; used the header line instead.
- A shared "AI cost" counter in the footer: cut in v1 (R2); I only surface `resetsAt` and the overage warning.

## Hand-off notes for the judge / build lanes

- The proposal names every `[V2+]` frozen-signature amendment in section 16's last paragraph; contracts.md must be the place where the DDL of section 11 and the IPC table of section 12 become binding.
- Hebrew copy in the proposal is illustrative; the i18n lane owns the final `he.json` (auto-mode Q7).
- The sixteen new `ErrorCode`s each need title/body/one action in both locales (parity test).
- The trial tally UI depends on `auto_decisions.checks_json.outcome` being written on edit/dismiss (auto-mode 5.4) - the executor/IPC lane must record it.
- Tests I expect to be added are listed inline per section (they mirror the research reports' test lists); the security gate of ARCH 18 grows by the auto-mode A1-A20, editing 5.2, WA 8.2-8.3, voice 9/11, image 5.4 items.

## Open questions I could not settle

- Whether the orchestrator accepts editing `~/.gemini/antigravity-cli/settings.json` (one key, with consent and a diff). Without it the Antigravity route may hang headless; with it the app touches a user-owned file for the first time. I chose "with consent" and listed it as weakness 16.
- Whether the judge wants the AutoStrip default-open or default-collapsed; I chose open while any row still has Undo.
