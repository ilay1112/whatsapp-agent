# fix-src-main-agent — repair of 7 confirmed defects in `src/main/agent`

Phase 3 (repair + adversarial review). All 7 findings were **fixed**; none turned out to be wrong,
though two carried factual corrections from the skeptics that changed the implementation (see below).

**Result: `npx vitest run` = 167 files / 3827 passed / 1 skipped / 0 failed.** `npm run typecheck` and
`npx eslint src/main/agent src/main/db src/shared --max-warnings 0` are clean for everything I touched;
prettier reports no issues in those trees.

---

## 0. This run resumed an interrupted one

A previous session hit its usage limit mid-task. It had already:

- finished **injection-1** (contextBuilder + orchestrator) and its tests;
- written the **failing TDD tests for all seven findings** (good — that is the required order);
- *declared* `LINE_SEPARATOR_RE` (sanitize.ts:20) and `DECIMAL_DIGIT_RE` (sanitize.ts:46) **but never
  applied either one**, so injection-2 and injection-4 were half-done and the constants were dead code;
- left `sanitize.test.ts:51` with a **raw U+2028/U+2029 inside a regex literal**, which is both a parse
  error (esbuild: "Unterminated regular expression", the whole file failed to collect) and a direct
  violation of the project's own `[R2]` rule at sanitize.ts:12 — *"\u escapes ONLY, never a literal
  invisible code point inside a character class"*. Rewritten to `/[\r\n  ]/u`.

Baseline when I picked it up: **11 failing tests / 5 failing files** under `src/main/agent`.

---

## 1. injection-1 [major] — S3 draft message carried no app-computed slot

**Already fixed by the previous session; I verified rather than re-did it.** `BuildContextInput` is now a
discriminated union whose `draft` arm requires `slot: ResolvedSlot` (contextBuilder.ts:23-29), so the
compiler enforces it at the call site; `appComputed()` renders `slot_state` / `proposed_slot` /
`missing` / `assumptions` labelled `"app-computed, trusted - NOT from the contact"` *inside* the nonce
block, and orchestrator.ts passes `slot` at the S3 `buildContext` call.

Making `slot` required surfaced one stale call site the previous run had not reached:
`prompt.purity.test.ts` built two `stage:'draft'` contexts without it, which threw
`Cannot read properties of undefined (reading 'event')`. I added a fixed app-computed `SLOT` constant
there. Holding it constant across all 500 iterations is deliberate: it is what lets the I4 property test
still attribute any byte that moves to the untrusted messages alone.

Union-arm choice is right: keeping `slot` optional would have let this exact omission compile.

## 2. injection-2 [minor] — U+2028 / U+2029 not stripped

`LINE_SEPARATOR_RE` is now actually applied in `sanitizeForModel` (between the zero-width and C0 passes),
and `  ` added to the shared `stripInvisible` in `src/shared/schemas.ts`.

I agree with the skeptic that **minor** is the right severity and that the reviewer's headline scenario
does not reproduce verbatim: the busy-time line the reviewer forged gets mangled by the phone mask and
lights `personal_details`. The defensible core — a contact must not be able to author a *line* of the
rendered prompt, because every line outside the JSON string literals is supposed to be ours — is real and
now holds. C-04 (cannot close the block) was never broken and still is not.

## 3. injection-4 [major] — phone mask was ASCII-digit only

`PHONE_CANDIDATE_RE` was already `\p{Nd}`; `countDigits` was still `ch >= '0' && ch <= '9'`, so an
Arabic-Indic number matched the candidate regex and then counted **zero** digits and fell through the
`>= 9` test. `countDigits` now tests `DECIMAL_DIGIT_RE` (`/\p{Nd}/u`).

Output side (`validate.ts`): `LONG_DIGITS_RE` → `/\p{Nd}{6,}/u`, `PHONE_RE` → `/\+\p{Nd}[\p{Nd}  ()\-.]{5,}\p{Nd}/u`.

Two deliberate deviations from the proposed fix:

- **`DATE_RE` left ASCII**, exactly as the skeptic warned: widening it would stop lifting dates into the
  sentinel and the phone pass would swallow them as `[number]`.
- **`PHONE_RE` keeps its mandatory leading `+`.** The reviewer's patch made it `\+?`. That is wrong: with
  `+` optional, `\+?\p{Nd}[\p{Nd} ... \-.]{5,}\p{Nd}` matches a bare date like `2026-09-24` (`-` and `.`
  are in the class), so every draft naming an ISO date would have raised a false `personal_details`.
  `LONG_DIGITS_RE` already catches unprefixed runs of 6+, which is what actually covers the finding's own
  scenario (`٠٥٢١٢٣٤٥٦٧`). Test `'נתראה ב-١٧:٠٠'` → `false` pins this.

## 4. injection-5 [major] — link gate missed U+3002

`sanitize.ts` already had the shared `DOT` class. I applied the same to `validate.ts` `scrubDraft`, and
the skeptic is right that **scrubDraft needs all four separators, not just U+3002**, because unlike
`sanitizeForModel` it never NFKC-normalises — so `．` and `․` slipped the *output* gate too.

Per the skeptic I did **not** touch `exec/buildCreateEventArgs.ts`: its `URL_RE` requires a scheme or
`www.` and never stripped a bare `evil.com/x` either, so the homoglyph adds nothing there. That file has a
separate, broader pre-existing gap which is **not** this finding and which I left alone.

I did not add NFKC to `scrubDraft`: it would change user-visible draft text well beyond the defect.

## 5. correctness-pipeline-2 [major] — `remove()` deleted a row re-armed mid-run

Fixed as a compare-and-set, but **not** on `first_enqueued_at` as proposed — that field deliberately does
not move on a re-arm, so it cannot discriminate. I also rejected a CAS on `due_at`, which looks adequate
and is not:

> once the 60 s debounce cap is in force, `enqueue` recomputes `min(now+20s, first+60s)` to the **same**
> `due_at` the worker dequeued (dequeue implies `due_at <= now`, so `t+20000` always loses to the cap).
> That is precisely the chatty conversation the cap exists for — i.e. CAS-on-`due_at` fails in exactly the
> scenario the finding is about.

So `triage_queue` gained a monotonic `rev` (**migration 3**, `triage_queue_rev`): `enqueue` bumps it on the
UPDATE path, `nextDue` returns it, and `remove(chatId, rev?)` deletes only `WHERE chat_id=? AND rev=?`.

- `rev` is an **optional trailing argument**, so the frozen `CONTRACTS 15.1` signature stays compatible —
  the same technique `validate.ts` already uses for `ValidateOptions` ("arrives as an optional trailing
  argument so the frozen shape is untouched"). `QueueEntry` gains a field, which is additive.
- **Hole I found in my own fix:** `chats.mergeLidInto` re-arms the surviving chat's queue row via UPSERT.
  That is semantically a re-arm, so leaving `rev` alone would let an in-flight run delete the row now
  carrying the merged-in work — reintroducing the same class of bug through the data-integrity-3 repair
  path. The UPSERT now bumps `rev` too.
- The item's `analysis` needed attention as well, as the skeptic noted — handled in §6.

**Spec divergence to flag to the orchestrator:** this adds a column not present in
`docs/specs/contracts.md` 15.2. Migration 2 set the precedent of diverging for a repair and documenting it
in the migration comment; I did the same. I did not edit `contracts.md`, `DECISIONS.md`, `PROGRESS.md` or
`BOARD.md` — **D-0xx for `triage_queue.rev` is yours to record.**

## 6. correctness-pipeline-6 [major] — S4 derived state from the pre-LLM snapshot

`validateAndPersist` now re-reads the row **inside** the existing `repos.db.transaction` and the live
values win — the convention `exec/outcome.ts` already follows. Merged: `closedReason`, `eventState`,
`replyState`, the `older_message` badge, and `analysis`.

`analysis` is the part the reviewer's own fix sketch omitted and the skeptic flagged: a mid-run re-arm
writes `queued`, and S4 stamped `done` straight over it, so §5's queue fix alone would not have been
enough — the row would survive but the item would be `done`. Now
`analysis = live.analysis === 'queued' ? 'queued' : 'done'`.

Approval-first is untouched and worth stating explicitly: a detected closure only **withholds** pending
actions (`sendText`/`eventToPropose` already gate on `closedReason === null`); nothing here approves,
sends or writes. The proposal row is still recorded in every case — only the approvable actions are
withheld — which is what the dismissed-mid-run test asserts.

Deliberately **not** changed: when a chat is re-armed mid-run I still insert the pending actions for the
stale draft. The imminent re-run calls `supersedePending` and replaces them, the user must still approve,
and suppressing them would be a larger behavioural change than the defect warrants. Noted as a judgement
call rather than an oversight.

## 7. data-integrity-5 [minor] — `retriage()` guarded on `closedReason`, index keys on `state`

Guard is now `!isOpen(item.state) && open !== null && open.id !== id` → `ACTION_STALE`, using the same
predicate `ux_items_open` uses, so guard and constraint agree.

Per the skeptic's correction I **left `restore()` alone**: it returns early on
`item.closedReason === null` and never reaches the update, so it is not defective; applying `isOpen` there
would only convert a no-op return into a spurious `ACTION_STALE`. The reviewer's "same shape in
`restore()`" half is wrong and I did not act on it.

---

## Files changed

| File | Finding |
|---|---|
| `src/main/agent/sanitize.ts` | injection-2, injection-4 (applied the two dead regexes) |
| `src/main/agent/validate.ts` | injection-4, injection-5, correctness-pipeline-6 |
| `src/main/agent/items.ts` | data-integrity-5 |
| `src/main/agent/queue.ts` | correctness-pipeline-2 |
| `src/shared/schemas.ts` | injection-2 (`stripInvisible`) |
| `src/shared/types.ts` | correctness-pipeline-2 (`QueueEntry.rev`) |
| `src/main/db/migrations.ts` | correctness-pipeline-2 (migration 3) |
| `src/main/db/index.ts` | correctness-pipeline-2 (`remove(chatId, rev?)`) |
| `src/main/db/repos/queue.ts` | correctness-pipeline-2 (bump + CAS) |
| `src/main/db/repos/rows.ts` | correctness-pipeline-2 (`rev` mapping) |
| `src/main/db/repos/chats.ts` | correctness-pipeline-2 (UPSERT bumps `rev`) |
| `src/main/agent/sanitize.test.ts` | repaired the parse-breaking raw U+2028 |
| `src/main/agent/prompt.purity.test.ts` | supplied the now-required `slot` |
| `src/main/agent/contextBuilder.test.ts` | prettier only |

## Observed but NOT mine — for whoever owns the renderer lane

While running the full suite I saw `src/renderer/` churn under me (files changed on disk mid-run), so
these are someone's in-flight work, not regressions from this task. They were red at some point during my
run and are listed only so they are not lost:

- `src/renderer/src/components/ItemCard.test.tsx` — typecheck errors: `'calendars' does not exist in type
  'SettingsStore'`, and three `lastError: string` values that are not `ErrorCode`. Was failing 4–11 tests
  mid-run; **green by the end of my run.**
- `src/renderer/src/views/Settings.tsx:13` — eslint: `'CalendarInfo' is defined but never used`. **Still
  red at the end of my run**, so `npm run lint` over the whole repo is currently failing on that one line.
  Nothing in `src/main/agent`, `src/main/db` or `src/shared` contributes to it.

## Not done / out of scope

- No npm dependency, version change, git commit or global install.
- Nothing was run against WhatsApp, Google, Anthropic or Google AI; no binary was executed; no installer
  was built; `whatsapp-bridge/store` was never read, listed or touched.
- Scratch verification dirs from the reviewers/skeptics (`ops/agent-notes/verify-*.scratch/`) were left
  untouched; I added none of my own — every assertion lives in the real suite.
