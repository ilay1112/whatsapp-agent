# T-612 — V2-W1-12-renderer-settings

**Wave:** 1 · **Status:** todo · **Owner:** build agent `V2-W1-12-renderer-settings`

## Goal
Shell, tokens, locales, Settings v2, Connect card, onboarding.

## Brief (single source of truth)
`docs/specs/v2-build-plan.md` → heading `V2-W1-12-renderer-settings`. Global rules: v1 `docs/specs/build-plan.md` §1 + v2-build-plan deltas.

## Owns
- `src/renderer/index.html`
- `src/renderer/src/{main.tsx,App.tsx,styles.css,i18n.ts,api.ts,env.d.ts,i18n.usage.test.ts}`
- `src/renderer/src/store/{health,settings,cli}.ts`
- `src/renderer/src/components/{HealthPill,DownloadPill,SetupStrip,LanguageToggle,ConnectCard,ConsentDialog,QrPairing}.tsx`
- `src/renderer/src/views/{Settings.tsx,setup.css,AutoActivity.tsx}`
- `src/renderer/src/views/settings/**`
- `src/renderer/src/views/Onboarding/**`
- `src/shared/locales/{en,he}.json`
- `src/shared/locales/locales.test.ts`
- `src/shared/i18n/**`
- `tests/setup-renderer.ts`

## Acceptance
- no automatic-mode/overage/scope control bound to settings:set (spy)
- locale parity incl. new keys
- onboarding never offers automatic mode

## Log
| Date | Event |
|---|---|
| 2026-09-28 | Ticket created from the finalised v2 build plan |
