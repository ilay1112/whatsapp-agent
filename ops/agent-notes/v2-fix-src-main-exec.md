# v2-fix-src-main-exec — v2 phase 3 repair notes (src/main/exec)

Scope: the 14 confirmed findings filed against `src/main/exec` (auto-mode-2..5, editing-undo-1/2/3/4/5/8/9/10,
data-integrity-v4-4/5). Method per finding: a failing test first (all in the new
`src/main/exec/actionExecutor.v2fix.test.ts`, plus `autoGate.test.ts` / `outcome.test.ts`), then the product fix, then the
surrounding suites. No new dependency, no version change, no commit, nothing run but Vitest / tsc / eslint / prettier.

Final state: `npm run typecheck` 0, `npm run lint` 0, prettier clean on every touched file, `vitest src/main/exec` 462/462,
`--project main --project integration --project security` 6443 pass; the only reds in that full run were 11 timeouts
(`tests/security/media-text-isolation.test.ts` voice groups, `src/main/bridge/bridgeDb.test.ts` SQLITE_BUSY), both of which pass
when re-run alone (load from the parallel run / other agents), and neither touches exec.

## Fixed

| Finding | Fix (file) | Test |
|---|---|---|
| auto-mode-2 | `runUndo`: a no-baseline newest revision is accepted ONLY when it is a `create` row, Google's copy carries THIS create's chain tag (`waAgent=1`, `waAction` = chain root of the create action) and `sameContent(pf, newest.next)`. Anything else stays fail-closed (K4/F5). I did not take the reviewer's "end as unknown_outcome" option: the event demonstrably exists, unknown_outcome would clone an "Add again" and pause the policy for a write that succeeded. (actionExecutor.ts) | v2fix "auto-mode-2" (untouched => Undo cancels; edited in Google => still blocked_changed, zero writes) |
| auto-mode-3 | `tryAuto`: the persisted facts (live policy, chat row incl. auto_policy / taint, item, proposal, budgets, snapshotSha, editable-event count ...) are built by `gateInputAt(now)` and built AGAIN after the Google reads; the full gate runs on the fresh input with no await before the decision transaction. Covers the S4 manipulation-taint case the verifier mentioned too. (actionExecutor.ts) | v2fix "auto-mode-3" (opt-out => `chat_opted_out`, taint => `chat_tainted`, zero creates) |
| auto-mode-4 | `approveUpdate`: right after the write-ahead of an `undo` whose `revertOf` revision belongs to an automatic write, `auto_chat` (chat key) + `auto_global` are recorded. A refused undo counts nothing. Note: an "Apply again" retry of such an undo records again (one more write attempt) - budgets get stricter, never looser. (actionExecutor.ts) | v2fix "auto-mode-4" (create + undo => 2/2; click change + undo => 0) |
| auto-mode-5 | `autoGate.ts`: the zero-badges rule exempts `from_image` on an item whose `triggerKind === 'image'`; `media_derived` still refuses every picture item while the images gate is closed (so the closed-gate reason stays the informative `media_derived`, as v2-contracts 19 note 15 intended). `image_unclear` / `image_unread` / `manipulation` are never exempt. The D-068 unit test now uses the badge set S4 writes (`['from_image']`). | autoGate.test.ts D-068 block + new narrowness case |
| editing-undo-9 | `applySendSuccess`: an item whose event is `created/updated/cancelled` (in_calendar, ARCH-v2 5.1) is not closed `replied`; `change_proposed` now also counts as an event pending. ARCH 7 says "any OPEN item"; in_calendar is not open. The v1 integration assertion `tests/integration/pipeline-happy.test.ts:146` (`closedReason 'replied'` after create + send) encoded the old behaviour and was revisited (now `closedReason null`, status `in_calendar`), as the verifier predicted. | v2fix "editing-undo-9" (+ `newestEditableEvent` = the findExistingEvent source), outcome.test.ts each-case |
| editing-undo-1 (T-401) | `approveAs` create path: a retry clone (`retryOf !== null`) first looks for an earlier attempt of its chain that is `done` / `unknown_outcome` (`earlierAttemptOf`). An unknown one is resolved read-only exactly like reconcile (new export `resolveLandedCreate` in reconcile.ts, findAppEvent on the chain root). Found + unedited => done, no write (B24 correction offered as reconcile would). Found + edited => an `update_event` from the recorded content to the edited content, approved by the SAME click (`approveConverted`). Not found => the v1 create. Lookup failed => an edited retry is refused `CAL_UNAVAILABLE` (it could duplicate), an unedited one proceeds (the deterministic eventId's 409 protects it). (actionExecutor.ts, reconcile.ts) | v2fix "editing-undo-1" (edited => 1 event at FRI, rev 2 prev WED; unedited => done, 1 create call, no conflict prompt; not landed => v1 create) |
| editing-undo-2 | `approveUpdate` → `retryOfLandedUpdate`: for a retry clone whose earlier attempt is `unknown_outcome` and whose pre-flight shows `waUpdate === chain root` + the earlier `to`, the earlier attempt is committed done right there (commitUpdateDone, audit `action_reconciled`, revision prev = the ORIGINAL approved `from`). Unedited clone => done, no PATCH, no drift prompt. Edited clone => a fresh update from the now-recorded content (rev 3). Also: after "Apply anyway" replaces `from`, a `to` that Google already holds is refused `ACTION_STALE` (never a no-op PATCH with prev == next). | v2fix "editing-undo-2" (Undo restores WED; edited variant rev 3 prev THU, rev 2 prev WED) |
| editing-undo-3 | `runUndo`: the idempotency guard still refuses any approved/executing/done undo of the revision, but an `unknown_outcome` one now routes the Undo click to that undo's pending retry clone (same undo chain, same gates; a landed one is recognised by retryOfLandedUpdate). Without a live clone a fresh undo is allowed (its pre-flight sees any landed write as drift - no write). The automatic F1 baseline pre-check is skipped for that retry (its own earlier PATCH may have moved the etag). | v2fix "editing-undo-3"; edges test renamed (see below) |
| editing-undo-4 | `runUndo`: when the fresh undo action is still `pending` after approveAs (no write-ahead: CAL_UNAVAILABLE, rate, 412, conflict/drift - an undo has no confirm path), `revertCard` supersedes it and inserts a proposal version (provider 'user') carrying the pre-undo proposal's content, carrying a pending draft over again. I kept REQUEST 3's "the undo's proposal shows the restore target" for the success path. Rollback (vs. "gates first") was chosen because it covers every refusal, including the ones that need the pre-flight read. | v2fix "editing-undo-4" (card content unchanged, no orphan pending undo, draft still approvable; retry then shows WED) |
| editing-undo-8 / data-integrity-v4-4 | new `currentRevisionOf(repos, eventId, item)` (outcome.ts) = max(item.event_revision, newest event_revisions.revision). Used by commitUpdateDone (next revision number), approveUpdate's CAS and reconcile's superseded guard. Reconcile now supersedes the chain's pending retry clones when an action resolves done or superseded (`supersedeChainClones`), and `reconcileUnknown` catches per row (audit `db_recovery`, row stays unknown) so one bad row never aborts the pass. | v2fix "editing-undo-8 / data-integrity-v4-4" (4 cases incl. a stale card pinned to the source, and a throwing row followed by a resolvable one) |
| editing-undo-10 | `resolveLandedCreate` (reconcileCreate) supersedes the chain's pending create clones in the markDone transaction. Same for `reconcileSend` (a delivered reply's "Send again" clone would send twice) and the update paths. | v2fix "editing-undo-10" |
| data-integrity-v4-5 | `restoreSpanReverts(repos, p)` (outcome.ts) recomputes the restore span at commit time when the in-memory `undoExtras` is empty (reconcile, retry clone, crash): an undo is a Restore original when `revertOf` is the span's newest revision and `to` equals the span's restore target (oldest.prev, or the cancel when that prev is null) and not `revertOf`'s own prev. The two targets always differ because a no-op change is refused at approve. Schema left untouched (the persisted-payload alternative would change `UpdateEventPayloadSchema` in src/shared). | v2fix "data-integrity-v4-5" (restore => both undone; plain undo of the newest => only it) |

## Not fixed (needs another module)

**editing-undo-5** — the B24 correction offer has no UI. The defect is real, but the card side lives in
`src/main/agent/items.ts` (`changeViewOf` requires `eventState === 'change_proposed'` + `proposal.delta`) and
`src/renderer/src/components/ItemCard.tsx` (Approve / Keep only for `change_proposed`), both owned by other repair lanes that
are editing those files right now. Switching the holder's own `eventState` to `change_proposed` from exec would push the live
event's card out of `in_calendar` (deriveState → needs_reply), break `findExistingEvent` and let a new message re-triage it.
What I did on the exec side: `reject()` no longer sets `eventState 'declined'` on an update_event whose acting item IS the target
(B24 offer, refused undo/cancel) — otherwise the future "Keep" button would turn the live event's card `ignored`. Change cards
(own delta item) are declined exactly as before. Tests: v2fix "editing-undo-5 (exec side)".

REQUEST (agent/items.ts + renderer owners): draw an in-calendar correction offer — an in_calendar item with a pending
`update_event` whose `itemId === targetItemId`, `change ∈ {reschedule, move}` and no `revertOf` — as a ChangeView built from the
ACTION payload (`from` = Google's found copy, `to` = the approved content, `baseRevision`), with Approve (action:approve) and
Keep (action:reject). Approve goes through approveUpdate unchanged; Keep is now safe.

## Existing tests whose assertion encoded a confirmed defect (revisited, not weakened)

- `actionExecutor.edges.test.ts` "an automatic create without a readback ... blocked_changed": now asserts the untouched event IS
  undoable; the changed-in-Google variant (still blocked_changed, zero writes) is in v2fix.
- `actionExecutor.edges.test.ts` "an undo that is still unknown blocks a second one": now asserts the second click retries the SAME
  undo chain (attempts [1,2], one chain root) — still never a second independent undo.
- `actionExecutor.edges.test.ts` "an undo payload is never evaluated": it obtained its pending undo from a refused undo, which no
  longer stays pending (editing-undo-4); the undo row is now inserted directly. The assertion is unchanged.
- `reconcile.test.ts` atomicity (2 cases): `reconcileUnknown` no longer rejects on a throwing row (per-row catch is the requested
  fix); the tests still assert the row stays `unknown_outcome`, no half-done item, no `action_reconciled`, plus `db_recovery`.
- `tests/integration/pipeline-happy.test.ts:146`: see editing-undo-9.
- Unused `LIMITS` import removed from edges test.

## Reviewer scratch tests (information only, not edited)

`v2-review-auto-mode`: auto-mode-2/3/4/5 green; 1/7/8 are other lanes. `v2-review-editing-undo`: 1/3/8/9 green; editing-undo-2's
scratch asserts the OLD intermediate `needs_confirm_drift` (now `done` straight away — better); editing-undo-4's dereferences
`proposal.event!` which is `null` for a delta card (my test asserts "unchanged from before the undo"); 5 is the UI part above.
`v2-review-data-integrity-v4`: v4-4 #2/#3 expect the clone `pending`/`done`; it is now `superseded` because the chain resolved
(the original carries the done revision) — the invariants they guard (no executing row, one PATCH, no throw) hold.

## Residuals / assumptions

- `retryOfLandedUpdate` adds one get-event per "Apply again" click whose earlier attempt is unknown (read class only).
- `approveConverted` inserts the converted update as the next attempt of the clicked clone's chain (`retryOf` = chain tip) so the
  idempotency key stays unique and the waUpdate tag is the chain root; if it does not reach the write-ahead it is superseded and
  the clicked clone stays pending, so the renderer's follow-up confirm click (same action id) works.
- `reject` parses the canonical payload with `UpdateEventPayloadSchema.safeParse`; an unparsable row falls back to the old
  behaviour (declined).
