# v3 Task 1 — `intent` on the card view model (T-904)

Date: 2026-10-18. Scope: handover §4 Task 1 only (Task 2 not started). No commit made.

## What changed
- `src/shared/types.ts` — `ItemCard.intent: Intent | null` (after `event`), with the `[V3]` comment.
- `src/main/agent/items.ts` `cardOf` — `intent: proposal?.extraction?.intent ?? null`.
- `src/main/exec/actionExecutor.ts` `fallbackDetail` — `intent: null`. This is the row-only `ItemDetail` fallback, which the real app never shows. The plan didn't list it, but typecheck required it.
- `tests/setup-renderer.ts` `defaultCard` — `intent: 'schedule_request'`.

## Tests (test-first; both failed with `undefined` before the change)
`src/main/agent/items.test.ts` (chose this over `items.v2.test.ts` because it has the `triage()` helper and the base view-model cases):
- `carries the current proposal's intent on the card ([V3])`: triage with `intent:'smalltalk'` gives `needsReply[0].intent === 'smalltalk'`.
- `sets intent to null on a card that has no proposal yet ([V3])`: a held item with no proposal gives `intent === null`.

## Notes / surprises
- `actionExecutor.ts` `fallbackDetail` is a second `ItemCard` builder that the plan didn't mention. Its test (`actionExecutor.test.ts`) uses `toMatchObject`, so it didn't need an edit.
- The proposal row's field is `extraction` (parsed via `storedExtraction`). It is nullable, hence the `?.` on it.
- No other `ItemCard` literals exist. Renderer fixtures spread `defaultCard`.

## Verification
- `npx vitest run src/main/agent tests/setup-renderer.ts src/renderer/src/components/ItemCard.test.tsx`: 32 files, 938 passed + 1 expected fail.
- `npx vitest run src/main tests/setup-renderer.ts`: 173 files, 4084 passed + 1 expected fail.
- `npm run -s typecheck`, `npm run -s lint`: exit 0. Prettier made no changes to the touched files.
