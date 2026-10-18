# v3 Task 5 — card changes: dismiss X, Edit time, Save time (T-904)

Spec: `docs/specs/v3-dashboard-handover.md` §2.1, §2.4, §4 Task 5. Test-first: `ItemCard.v3.test.tsx` written first, 19/22 red, then implemented.

## What changed
- `src/renderer/src/components/ItemCard.tsx`
  - **X (`dismiss-x-<id>`)**: rendered by `OverflowMenu` just before the `[...]` button. It is a 28x28 `icon-btn` (inline `inlineSize`/`blockSize`, logical), `aria-label` = `t('action.dismiss')`, and its click runs the same `onDismiss` as the menu item (`controller.dismiss`: item:dismiss + refresh + toast `action.dismissed` with Undo). New optional prop `dismissX` defaults to `onOpen !== undefined`. **That way RawCard (compact only, always passes `onOpen`) gets the X without me editing RawCard.tsx.** ItemCard passes `dismissX={!expanded}` explicitly, because tests render compact cards without `onOpen`. The sheet has no X and keeps `sheet-dismiss-<id>`.
  - **Edit time (`edit-event-<id>`)**: a quiet button in the action row, after the Add to calendar / Approve change buttons and before Keep. It appears only on a compact card with `eventState` proposed/change_proposed, an event VM, and a pending create_event (not addBack) or a pending non-cancel update_event. It has `aria-expanded`/`aria-controls` and is disabled while an approval is in flight. It toggles an inline `EventEditor` (`inline-editor-<id>`, mode `edit` or `change` through the existing `editorMode`) under the event chip. The edit reaches the existing `action:approve` through `setEventEdit`/`setEventValidity`. There is no new write path.
  - **Save time (`save-event-<id>`)**: an outline button under the fill form in both modes. The compact info-missing card now always shows the fill form (`fill-form-<id>`), as §2.3/§2.4b require. The button is enabled only when the editor reports valid AND start and end are set. The click goes to `api.completeEvent({itemId, event})`. On ok it clears the edit, calls `markDirty(false)`, `applyItem(detail)`, sets toast `action.timeSaved` and refreshes. On error it sets toast `errors.<CODE>.title` (`ACTION_STALE` uses `card.changed`) and leaves the card unchanged. `action:approve` is never called.
  - New exported helper `editOfVm(vm)` gives the EventEdit already in a VM. It is used when the user saves without touching the form.
- Controller (`useCardController`) new fields: `inlineEditorOpen: boolean`, `toggleInlineEditor(): void`, `saveTime(): Promise<void>`, `savingTime: boolean`.
  - `toggleInlineEditor` calls `item:setEditing(id, open)`. Closing **discards** the edit (eventEdit null, validity reset), so the approval carries what the card shows.
  - `onInputFocus` keeps `editing=true` on input blur while the inline editor is open (a ref).
  - `saveTime` uses single flight (`savingRef`) and re-checks validity, so no path sends an event the editor refused.
  - A successful event approval also closes the inline editor.
  - The dirty-card rule is extended: `eventEdit !== null && (change || inlineEditorOpen || eventState === 'incomplete')`. Without it, a refresh would remount the editor with the old fields while `eventEdit` still held the user's edit, and the approval would not match the screen.
- Locales: `action.editTime`, `action.saveTime`, `action.timeSaved` in en + he (only those three, inside `"action"`).
- `ItemCard.v2.test.tsx`:
  - 6 Change-card snapshots updated. The diff only adds the X and Edit time.
  - Added a `beforeEach` in the `"Change proposed - see Needs reply"` describe that keeps `dashboard:get` pending. **This fixes a pre-existing flake (it also fails on HEAD's ItemCard.tsx):** an earlier test's 1.2 s post-approval refresh timer fires inside these cases and replaces the seeded lists.

## Surprises / for the orchestrator
- `event.invalid` (named in §2.4b) does not exist. I used the existing `errors.EVENT_INVALID.title` and `errors.CAL_UNAVAILABLE.title`.
- EventEditor `fill` quirk: a field is editable only while empty (e.g. `title` when `fields.title === ''`). Typing the first character turns it read-only. So for an info-missing item with **no event at all**, the card builds a blank VM and opens the editor in `edit` mode, not `fill`. The same quirk exists today in the sheet for a model event with an empty title. That is not fixed here (EventEditor.tsx is not mine).
- The sheet's `sheet-event` section now also renders for an info-missing item whose `event` is null (blank form), so such items can be completed.

## Verification
- `npx vitest run src/renderer/src/components src/renderer/src/i18n.usage.test.ts src/shared/locales`: 37 files, 651 tests passed. `ItemCard.v3.test.tsx` has 22 tests.
- `ItemCard.v2.test.tsx` passed 5 runs in a row after the flake fix.
- `npm run -s typecheck`: exit 0. `npm run -s lint`: exit 0. Prettier: clean on all touched files.
