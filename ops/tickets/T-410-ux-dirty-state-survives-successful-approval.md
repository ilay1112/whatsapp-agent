# T-410 — ux dirty state survives successful approval

**Kind:** product decision · **Status:** todo · **Raised by:** `final-e2e`

## Problem
After (v) Sent with an EDITED draft the card keeps This card changed - review again and only moves after Refresh card (ux.md L421 vs L542 as written). A successful approval does not clear the dirty state of the input it consumed. Product decision: clear dirty on success, or keep the explicit refresh.

## Log
| Date | Event |
|---|---|
| 2026-09-27 | Filed from workflow ④ residuals |
