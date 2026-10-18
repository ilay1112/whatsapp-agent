# bridge-outdated-fix (2026-10-18)

## Bug
Real bridge logs `ClientOutdated` (`[Client ERROR] ❌ Client outdated ...`, vendor main.go ~L2618) and then reconnects forever, never exiting.
Launcher only reached `'outdated'` via `openBreaker()` / readiness exhaustion (both need exits), so the UI stayed on "starting".

## Fix (src/main/bridge/launcher.ts)
- `handleMarker(marker, from)` now gets the emitting `ChildProcess`; `client_outdated` calls `confirmClientOutdated(from)`.
- `confirmClientOutdated`: acts only if `from === child`, not stopping, `ep !== null` (REST answered). Once per child per `ANNOTATION_WINDOW_MS`
  (`outdatedCheckAt`, reset in `teardownChildState`). Probes `GET /api/health` once:
  - 503 / connected:false => `terminal = true`, clear respawn timer, `log.error('bridge_client_outdated')`, `stopChild()` then `setStatus('outdated')`.
  - 200 connected => `bridge_client_outdated_unconfirmed{reason:'connected'}`; stays an annotation (breaker path still uses it).
  - probe error => `..._unconfirmed{reason:'probe_failed'}`.
- `healthTick` hardened: after the awaited probe (both branches) it returns if the child changed / stopping / terminal, so a late answer
  cannot overwrite 'outdated' (or 'logged_out') with 'online'/'reconnecting' or respawn.
- `resetBreaker()` already clears `terminal` (start / relink / restartForNewCode / unlinkAndWipe).

## Deviation from the brief (deliberate)
Brief said: act on the marker alone. That reopens the [R2] hole ARCHITECTURE 4.3 explicitly closed: `matchMarkers` cannot tell a bridge log
line from the continuation line of a multi-line message, so any contact could send "hi\nClient outdated" and permanently stop the bridge
(the existing test "every BRIDGE_MARKERS string ... as multi-line content, is inert" would fail). Corroboration: a message can only arrive
while the bridge is connected (health 200), whereas the genuine 405-at-connect leaves the socket closed (health 503). Residual risk: a typed
line arriving in the same instant as a real disconnect; the probe is immediate, so the window is milliseconds.

## Supervised mode
`stopChild()` nulls `child` first, so launcher `onChildExit` ignores the exit; the Supervisor's exit callback sees `terminal()` true =>
`proc_terminal`, state 'failed', no backoff. Status stays 'outdated' (test covers it).

## Tests added (launcher.test.ts, "client_outdated while the bridge is running (health-confirmed)")
marker+503 => outdated/killed/no respawn/logged; second (and third) marker => one probe, one kill; start() after => spawns again;
typed multi-line copy with health 200 => inert; rest_error alone => unchanged; supervised => terminal, not overwritten by backoff.
Two pre-existing breaker-selection tests pass unchanged (default health 200 => annotation only).

## Docs
stdoutMarkers.ts L11-15 + its verbatim copy in docs/specs/contracts.md; ARCHITECTURE 4.3 state list + [R2] note, 4.4 annotation
sentence, failure table row `Client outdated`. docs/research/bridge-contract.md had nothing wrong.

## Observations for the orchestrator
- `npm run lint` fails repo-wide (1260 parse errors) only because `.claude/worktrees/modest-fermat-cbe1c4` (another agent's worktree) gives
  typescript-eslint two tsconfig roots. `eslint --parser-options tsconfigRootDir:<repo> src tests scripts` is clean.
- `vendor/whatsapp-bridge-src/go.mod` / `go.sum` show as modified in the tree - not by me.
- Pre-existing: after a respawn of an already-paired bridge the pairing poller dedupes 'connected', so status sits on 'starting' until the
  first health tick (20 s) flips it to 'online'.
- Pre-existing gap: in supervised mode compose's `startBridge()` (plain retry) does not call launcher `resetBreaker()`, so `terminal` stays
  true and health ticks are skipped for the new child until Re-link / New code / Wipe. BRIDGE_OUTDATED's UI action is "How to update",
  so not hit by this fix, but worth a ticket.
