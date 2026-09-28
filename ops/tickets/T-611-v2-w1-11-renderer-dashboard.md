# T-611 — V2-W1-11-renderer-dashboard

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-11-renderer-dashboard`

## Goal
Dashboard: Change card, Undo/Restore original/Cancel event, AutoStrip, bubbles.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-11-renderer-dashboard`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/renderer/src/store/{dashboard,auto}.ts`
- `src/renderer/src/views/{Dashboard.tsx,dashboard.css}`
- `src/renderer/src/components/{ItemList,ItemCard,RawCard,DraftBox,EventEditor,Badges,QuotedBubble,UndoDismissDrawer,AutoStrip,ChangeLine,UndoControl,VoiceBubble,ImageBubble}.tsx`

## Acceptance
- RTL snapshots he/en
- bubbles inert
- no calendar-write control bound to settings:set

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
