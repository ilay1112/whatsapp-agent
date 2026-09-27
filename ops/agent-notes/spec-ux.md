# Agent notes - spec-ux (2026-09-21)

Output: `docs/specs/ux.md`. Nothing else in the repo was touched except this file.

## What I read
- `docs/ARCHITECTURE.md` in full (binding). Key sections for UX: 2 (taint rule), 6.1 (visibility rule, raw cards), 6.6 (card + approval), 7 (state machine), 11 (IPC), 12 (onboarding, settings, i18n), 13 (tray), 14 (ErrorCode table), 15.1 (window), 18 (renderer file list).
- `docs/proposals/ux.md` sections 7, 8, 10, 15; `docs/research/i18n-rtl.md` sections 5 and 7; `docs/research/calendar-mcp.md` 6.3.
- frontend-design skill for direction.

## Design decisions and why
- Direction: "desk diary". Cool paper-grey canvas, white leaves, ink-indigo accent. Avoided WhatsApp green/logos on purpose (unofficial app must not look official) and the generic cream/terracotta and black/acid-green looks.
- One signature element: the date tab (weekday / day / month leaf), reused as the tray icon glyph. Everything else flat, no card shadows.
- "Three voices" rule: contact = sunken bubble with tail corner, AI = dashed-edge editable box, app = flat chrome. This is the visual form of the architecture's taint rule and also survives Windows forced-colors (solid vs dashed vs none).
- All palette contrast ratios were computed with a small node script (WCAG luminance); values are in section 2.1 of the spec.
- Hebrew gets +1 px on every text token via `:root:lang(he)`; spacing tokens unchanged so layout is identical.
- Ctrl+Enter in the draft moves focus to the approval button instead of sending: keeps "explicit click" meaningful while staying keyboard-fast (two keys).
- Column order kept as the user wrote it: Needs reply, In calendar, Information missing. In one-column mode "In calendar" is collapsed by default.
- RTL wireframes are mirrored with English placeholders: Hebrew in monospace boxes gets bidi-reordered in most viewers. Hebrew copy lives in the copy tables.
- No new component files: primitives are CSS recipes in `styles.css`; sheet = `ItemCard mode="expanded"` inside `Dashboard.tsx`; toast/live regions/coach mark in `App.tsx`; `EventChip` exported from `EventEditor.tsx`.

## Conflicts between the task brief and the architecture (architecture followed)
- Onboarding order (brief: pair before LLM; architecture: AI first so the download runs in the background).
- Window size (brief ~960x640; architecture 980x680, min 420x560).
- "Status strip" implemented as the architecture's single HealthPill + three-row panel.

## Gaps found in the architecture (listed as C1-C13 in the spec)
Most important for the orchestrator: C1 (raw card "Send" has no action row to approve), C2 (info-missing "Add to calendar" has no action row), C3 (no IPC for the ignored list), C4 (no IPC listing per-chat policies), C9 (first-close coach mark cannot be seen in a hidden window).

## Assumptions
- `dashboard:get` list entries include draft text, trigger text, badges and the pending actions with `shownHash` (needed for inline approval on the card). Documented as the `ItemVM` shape; Wave 0 owns the real types.
- Lane 13 owns `styles.css`, `App.tsx` and both locale files; lane 14 contributes through the orchestrator.
- Hebrew copy in the spec is a first draft and falls under UNVERIFIED V11 (user skims `he.json`).

## Not done / out of scope
- No locale JSON, no code, no images. Onboarding screenshots and tray icons are described, not produced.
