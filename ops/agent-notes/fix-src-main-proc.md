# fix-src-main-proc — repair notes

Scope: the two confirmed defects in `src/main/proc` (process-lifecycle-1, process-lifecycle-2).
Both are **fixed and covered**. Nothing was skipped, deleted or weakened.

This pass resumed after a usage-limit interruption; part of the edit had already landed on disk
from my earlier pass. I re-derived the state from the files rather than trusting it, and I proved
every guard is load-bearing by reverting it and watching the matching test go red (below).

---

## process-lifecycle-1 — synchronous `onExit` re-entrancy wedged the entry in phantom `running`

### What was wrong
`startEntry` attached the exit callback and then unconditionally set `running`. A `ChildHandle`
that reports an already-known exit calls back **inline**, so the whole crash path
(`generation++`, `handle = null`, pid file removed, exit recorded, backoff armed) ran *during*
the attach and was then overwritten by `setState(e, 'running')`. From there nothing recovers:
the backoff timer's `startEntry` returns early on `state === 'running'`, and `killChild` returns
early on `!handle`.

### Fix — three guards, smallest surface

1. **`src/main/proc/supervisor.ts:518`** — re-check the generation immediately after
   `handle.onExit(...)` returns and bail out if the exit already landed:
   ```ts
   handle.onExit((info) => onExit(e, generation, info));
   if (e.generation !== generation) return;
   ```
   This is the authoritative guard: it protects the supervisor from *any* ChildSpec, not just
   llama's, so a future handle cannot reintroduce the wedge.

2. **`src/main/llm/local/llamaServer.ts` (`childSpec.start`)** — refuse to hand the supervisor a
   handle for a corpse: `if (exitInfo !== null) throw new LlamaRuntimeError('LLM_LOCAL_FAILED')`.
   A failed start is the honest answer; the supervisor counts it as an exit and backs off.

3. **`src/main/llm/local/llamaServer.ts` (`spawnOnce` readiness loop)** — re-check `currentExit()`
   **after** `await health()` returns 200, not only at the top of the loop. This is the root cause
   the verifier flagged: the 200 can already be on the wire when the process dies, and the `exit`
   event is delivered while that fetch is pending, so `state = 'ready'` was overwriting the exit
   handler's `'failed'`. Logs `llama_exit_raced_ready` and throws.

### Where I deliberately diverged from the proposed fix
The reviewer proposed making `llamaServer`'s `ChildHandle.onExit` asynchronous via `queueMicrotask`.
**I did not do that, on purpose.**

- The inline-callback behaviour is an asserted product contract:
  `llamaServer.test.ts:513-527` pins it. Deferring it would have meant weakening an existing test
  to make my change pass — exactly the thing the brief forbids.
- `queueMicrotask` only *narrows* the race; it does not close it. Any listener registered inside a
  synchronous stretch that outlives the microtask checkpoint (or a future handle that calls back
  inline) would wedge the supervisor again. Guard 1 closes the hole for every ChildSpec, which is
  strictly stronger and is where the invariant actually belongs.
- Guards 2 and 3 remove the *reachable precondition* rather than masking its timing, which is the
  deeper cause the verifier identified.

### The reviewer's severity call
Agreed with the verifier's correction: **major, not blocker**. Approval-first is untouched — no
path here can produce a WhatsApp send or a calendar write, and there is no data loss.

---

## process-lifecycle-2 — pid file stamped the readiness instant, so orphans were unreapable

### What was wrong
`writePidFile` stamped `startedAt: now()` at the moment `spec.start()` *resolved* — i.e. after the
readiness handshake. All three `ChildSpec.start()` implementations resolve after readiness
(llama polls `GET /health` for up to 180 s on a cold gguf; the bridge awaits `waitForReadiness()`;
the MCP host awaits `connect()` + `listTools()`). `reaper.matches()` requires
`|Win32_Process.CreationDate - startedAt| <= 2000 ms`, so after an abnormal termination the orphan
was never reaped: the reaper logged `reaper_pidfile_stale`, deleted the pid file and killed nothing.

### Fix
Carry the true spawn instant on the handle and stamp *that*.

- **`src/main/proc/supervisor.ts:27`** — `ChildHandle.spawnedAt?: EpochMs`, **additive and optional**,
  so every handle written against the frozen four-key CONTRACTS section 13 shape still compiles.
  (The frozen-signature conformance tests at the foot of `supervisor.test.ts` still pass.)
- **`src/main/proc/supervisor.ts:276-292`** (`writePidFile`) — honour `handle.spawnedAt` only when
  `parsePidFile` would accept it back (safe integer `> 0`); otherwise fall back to `now()`. This
  matters because the value reaches the pid file, which is untrusted input on the next boot — I did
  not want a handle to be able to write a `startedAt` the parser would reject.
- The same value is stored on `e.startedAt`, which `taskkillVeto` already compares against
  `Win32_Process.CreationDate`. Using the true spawn instant makes that veto *more* accurate too:
  previously a legitimately-slow child looked like a recycled pid.
- Producers now record it: `bridge/launcher.ts:578` (the value it already captured and simply never
  passed on), `llm/local/llamaServer.ts:232`, `mcp/host.ts:420` (stamped inside `connect()`, the
  closest instant to `StdioClientTransport` actually spawning).

### Note on the reviewer's cited evidence
The verifier was right that the report's evidence was not real — there is no `lifecycle.test.ts`
and no test named `process-lifecycle-2` in `tests/`. The existing
`supervisor.test.ts:324` assertion `startedAt === clock.now()` passes only because its scripted
`start()` resolves instantly, which is precisely why the case was uncovered. I wrote the coverage
from the behaviour, not from the cited artefact.

---

## Tests added (all in the existing suite, colocated with the file they cover)

`src/main/proc/supervisor.test.ts`:

- `a ChildHandle that reports an already-known exit (process-lifecycle-1)`
  - end-to-end: crash bookkeeping survives the attach, state is `backoff`, `proc_crash` +
    `proc_backoff` logged, pid file gone, **the armed backoff timer really respawns**, and the
    respawn is tracked so `stop()`/`killAllSync()` can reach it (the orphan half of the defect).
  - `keeps the breaker and the probe honest across three dead-on-arrival starts` — the breaker
    still latches `failed` and logs `proc_breaker_open` instead of the entry going phantom-running.
- `pid-file startedAt (process-lifecycle-2)`
  - `records the spawn instant, not the readiness instant` — drives a start that resolves 45 s after
    the child exists, asserts `pidFileOf('llama').startedAt === spawnedAt`, then runs the **real
    `reapOrphans`** against a live process whose `CreationDate` is the true spawn instant and
    asserts `{ killed: ['llama'], stalePidFiles: 0 }` with `taskkill /T` on pid 909.
  - `falls back to now() when the ChildHandle carries no spawn instant` (the optional-field path).
  - `ignores a spawn instant that parsePidFile would reject` (`spawnedAt: 0`).

`src/main/llm/local/llamaServer.test.ts` already pins the companion behaviour
(`start() either throws or returns a handle for a LIVE child`, line ~538).

### Proof the guards are load-bearing
I reverted each guard in isolation and confirmed the matching test fails, then restored the file
byte-for-byte (`diff -q` clean):

| Guard reverted | Result |
|---|---|
| `if (e.generation !== generation) return;` after `onExit` | 2 failed — `expected 'running' to be 'backoff'`, `expected 'running' to be 'failed'` |
| `handle.spawnedAt` honoured in `writePidFile` | 1 failed — `expected 1789981245000 to be 1789981200000` (readiness instant vs spawn instant) |
| `exitInfo !== null` throw + post-`health()` `currentExit()` re-check in `llamaServer` | 1 failed — `ensureStarted()` resolved `{port, apiKey}` instead of rejecting |

---

## Companion file: `src/main/llm/local/supervised.ts`

`createSupervisedLlama` (wired at `compose.ts:699`) exists to close consequence (b) of
process-lifecycle-1: `supervisor.start()` is typed `Promise<void>` and resolves *silently* when it
refuses, so `compose`'s old `supervisor.start('llama')` **then** `llamaRuntime.ensureStarted()`
sequence would spawn an **untracked** llama-server behind a refused supervised start — no pid file,
so `reapOrphans` and `killAllSync` could never reach it, leaving an orphan holding the model in
VRAM after the app exits. The wrapper turns a refusal into the runtime's own `ErrorCode` instead of
reaching past it. Covered by `src/main/llm/local/supervised.test.ts`.

---

## Verification

```
npx vitest run src/main/proc src/main/llm/local src/main/bridge src/main/mcp \
  src/main/compose.breaker.test.ts tests/security/crash-recovery.test.ts tests/integration
  -> 41 files, 864 tests, all passing
npx eslint src/main/proc src/main/llm/local src/main/bridge/launcher.ts src/main/mcp/host.ts
  -> clean (exit 0)
npx tsc -p tsconfig.node.json --noEmit  (filtered to my files)
  -> no errors in proc/ llm/local/ launcher.ts mcp/host.ts
```

No binary was executed, no network call was made, no dependency added, no git commit.

### Repo-wide gates are RED — but not from this change (reporting honestly)

Other agents are editing the repo concurrently; `npm run lint` gave a *different* answer on two
runs minutes apart. Neither failing file is one I touched, and I left them alone:

- `npm run typecheck` — errors in `src/main/agent/prompt.purity.test.ts` (missing `slot` on
  `BuildContextInput`, 2x) and `src/renderer/src/components/ItemCard.test.tsx`
  (`lastError: string` not assignable to the `ErrorCode` union, 3x).
- `npm run lint` — first run: 2 errors in `src/main/llm/local/supervised.ts` (unused
  `LlamaRuntimeError` / `STARTABLE`) + 1 warning in `src/main/bridge/ingest.ts`; second run those
  were gone and instead `src/main/agent/validate.ts:73` had `no-irregular-whitespace`. The
  `supervised.ts` errors were a transient mid-edit state — a direct `npx eslint` on that file is
  clean, and both symbols are genuinely used.

Owners of `agent/` and `renderer/` need to clear those; `npm run lint` and `npm run typecheck`
will not go green repo-wide until they do.
