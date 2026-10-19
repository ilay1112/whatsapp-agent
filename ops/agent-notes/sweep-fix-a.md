# sweep-fix-a (2026-10-19) - ui-sweep findings 1, 2, 4

Implementer. Scope: `ops/agent-notes/ui-sweep.md` "Findings" items 1, 2 and 4, test-first. Did not touch Settings.tsx,
`src/main/mcp/**`, ConnectCard or the voice handler (second worker). No commit or push.

## 1. Restore after Dismiss lost the approval buttons
- Root cause: `dismiss()` supersedes every pending action; `restore()` only cleared `closed_reason`.
- Fix: `src/main/agent/validate.ts` now has ONE builder for the `send_reply` / `create_event` payloads (`insertReplyAndCreate`, used
  by S4 `validateAndPersist`, no behaviour change there) and a new export `reofferCurrentProposal()`. `ItemService.restore()` runs
  it in the same transaction that clears `closed_reason`.
- How it decides (same as S4): `send_reply` only for a non-empty draft, a sendable chat, `replyState === 'draft'`, and not for a
  self-triggered run. `create_event` only for `eventState === 'proposed'`, a complete slot and a connected calendar.
- Why it writes a new proposal version: `actions.idempotency_key` (`itemId:kind:proposalVersion`) is UNIQUE and the dismissed rows
  still hold the current version's keys. So the current proposal is copied as version+1 with provider `'user'` / model `'user'`.
  This follows the executor's `insertChange` / `revertCard`. AutoGate refuses `provider === 'user'` (`provider_unsafe`), and the
  provenance fields are copied, never relaxed. The new rows are plain `insertPending` rows (fresh 24 h TTL, `approved_at` NULL,
  attempt 1). `shownHash` is their `content_sha256`, so the normal approve path validates them. Nothing is approved, executed or
  queued.
- Also changed: `restore()` now refuses `ACTION_STALE` unless `closed_reason === 'dismissed'`. Restore is "Undo dismiss", so an
  expired, superseded, past or replied card must not come back approvable. Only the toast Undo and the Undo-dismiss drawer call it.
- Not re-offered: `update_event`. Dismiss nulls `proposals.delta_json` at once (ARCH-v2 9.3), so a restored change card has no
  ChangeView. Re-creating the action would give an approvable write with nothing on screen. The user can use "Analyse again".
  The executor-made correction offers on created events are not restored either.
- Tests (`items.test.ts`, "restore() re-offers the current proposal"):
  - proposed card: one pending send_reply + one pending create_event for the current proposal, `approved_at` null, card
    `shownHash` == row hash;
  - draft-only card: exactly one send_reply;
  - newer proposal written while dismissed: only the newer content;
  - calendar down: no create_event;
  - non-dismissed closure: refused;
  - in every case nothing ran (no approved / executing rows, no queue row, no retriage poke).

## 2. "Analyse again" on an In-calendar card made it vanish
- Choice: hide it and refuse it. Do NOT make it run.
- Why the spec supports this:
  - ux.md 6.7 gives In calendar "Open in calendar ... nothing to approve" and no re-analysis.
  - v2-ux 3.4 lists that card's actions as Undo / Open in calendar / Cancel event / Restore original.
  - ux.md 992 and the error deck describe "Analyse again" as recovery for a failed or raw card.
  - The pipeline is built so it never re-analyses a booked item: `runChat` takes only the chat's OPEN item, and validate keeps
    `created` / `updated` / `cancelled` sticky.
  - A change to a booked event comes from a new inbound message (a change card), not from re-analysing the in-calendar card.
- Fix:
  - `items.retriage()` returns `ACTION_STALE` for `state === 'in_calendar'`. It writes nothing and leaves the card listed.
  - `OverflowMenu` (ItemCard.tsx) no longer renders `retriage-<id>` for `status === 'in_calendar'`.
- Tests: `items.test.ts` (refused, untouched, still in inCalendar) and `ItemCard.test.tsx` (menu item present on Needs reply,
  absent on in_calendar).

## 4. "Remove the rule" did nothing for known contacts
- Root cause: the list keys on `policy <> 'default' OR force_known = 1 OR auto_policy = 'never'`, but Remove sent
  `{policy:'default'}`.
- Fix:
  - New repo member `repos.chats.clearRules(id, now)`: one transaction sets `policy='default'`, `force_known=0` and
    `auto_policy='inherit'`, and appends one `chat_rules_cleared` audit row. The row's detail holds the cleared values (enums and
    booleans only); `AUDIT_KINDS` +1.
  - New `chat:setPolicy` request member `{chatRef, removeRule: true}` (`src/shared/ipc.ts`), routed in
    `ItemService.setChatPolicy`.
  - `{policy:'default'}` is unchanged on purpose. The per-row policy SELECT uses it too, and changing the dropdown must not silently
    drop "known" or the automatic-mode opt-out.
- Tests:
  - `chats.test.ts`: clearRules resets and delists, audit rows, NOT_FOUND.
  - `items.test.ts`: force_known only, policy never only and mixed all leave the list, one audit row, the select still only
    changes the policy, NOT_FOUND.
  - `ipc/handlers/items.test.ts`: forwarded verbatim; the schema accepts only `true` and no mixing.

### HAND-OFF REQUIRED (not my file)
`src/renderer/src/views/Settings.tsx` ~L786: the "Remove the rule" button (`settings-policy-remove-<n>`) must call
`api.setChatPolicy({ chatRef: chat.chatRef, removeRule: true })` and then re-list, the same shape as `setPolicy`. It must not
call `setPolicy(chat.chatRef, 'default')`. Until that one-line change lands, the main-side fix is in place but the button still
sends the old request. A Settings test for it belongs with that change.

## Verification
- `npx vitest run src/main/agent src/main/db src/main/ipc src/renderer/src/components/ItemCard* src/shared`: 88 files, 2388
  passed + 1 expected fail.
- Broader run (`src/main/exec tests/integration tests/security src/renderer`): green apart from two failures, neither from my
  files:
  - `i18n.usage "has no dead keys"`: `settings.voice.testNeedsModel` / `testFailed`, the other worker's in-progress voice keys.
  - `mcp-real-toolslist`: passes when re-run alone (timing under load).
- `npm run -s typecheck` 0, `npm run -s lint` 0, prettier on every touched file.
- No locale keys added.
