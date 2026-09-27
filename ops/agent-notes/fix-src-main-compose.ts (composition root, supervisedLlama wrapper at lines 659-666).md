# fix - compose.ts supervisedLlama wrapper (finding process-lifecycle-5)

Scope: ONE confirmed defect, `src/main/compose.ts:659-666`. Phase 3 repair. No dependency, no version, no commit.

## Verdict

CONFIRMED and FIXED. The reviewer's and the skeptic's reading of the fall-through is correct.

## What was wrong

```ts
const supervisedLlama: LlamaRuntime = {
  ...llamaRuntime,
  async ensureStarted() {
    await supervisor.start('llama');   // typed Promise<void>; a REFUSAL also resolves
    return llamaRuntime.ensureStarted(); // ... so this always ran
  },
};
```

`startEntry()` (proc/supervisor.ts) begins with `if (e.breakerOpen) { log('proc_start_refused'); return; }` - a silent
resolve. The refusal is therefore invisible at the call site, and the second statement spawned `llama-server.exe`
through the RAW runtime. `writePidFile` lives only in `startEntry`, so that child never got
`<userData>\run\llama.pid.json`: `killAllSync()` (`e.handle === null`) and `reapOrphans()` (purely pid-file driven)
can both never reach it, which breaks A3 and the section 14 breaker contract. Every LLM call goes through
`runtime.ensureStarted()` (llm/local.ts `post()`/`validate()`), the runtime's `starting` promise only dedupes
*concurrent* calls, and nothing gates the provider on llama health - so a crashing model turned into one raw multi-GB
spawn per queued triage item.

## The fix

New 32-line module `src/main/llm/local/supervised.ts` holding the wrapper, and compose.ts now calls
`createSupervisedLlama({ supervisor, runtime: llamaRuntime })`. The wrapper consults the raw runtime only when the
supervisor's own state says a child is up or a supervised start is in flight:

```ts
await supervisor.start('llama');
if (!STARTABLE.includes(supervisor.state('llama'))) {      // STARTABLE = ['running', 'starting']
  throw new LlamaRuntimeError(runtime.status().code ?? 'LLM_LOCAL_FAILED');
}
return runtime.ensureStarted();
```

Why this shape, and why NOT the reviewer's first suggestion:

- The reviewer's option A ("make `Supervisor.start` return a boolean or reject") changes a signature frozen in
  docs/specs/contracts.md section 13 (`start(name): Promise<void>`) that every other caller and supervisor.test.ts is
  written against. Option B (gate on `state()`) closes the same hole inside the composition root, which is where the
  defect lives. Smallest surface wins; `state()` is already on the frozen interface.
- Gating on `!== 'failed'` alone is too narrow: `stopped` / `stopping` after a raced `stop()` would also fall through
  and resurrect a child the supervisor is tearing down. Gating on `=== 'running'` alone is too strict: a CONCURRENT
  second caller finds the entry in `starting` (startEntry returns early) and must be allowed to join the runtime's
  in-flight `starting` promise instead of being failed. Hence the allow-list of the two healthy states.
- Throwing `LlamaRuntimeError` keeps the existing UX: `createLocalProvider` catches anything from `ensureStarted()`
  and maps it to `not_ready`, so the health pill and the triage item behave exactly as they did *after* the wasted
  spawn - only the spawn is gone. `runtime.status().code` is forwarded so `LLM_VCREDIST_MISSING` (terminal) is not
  flattened into `LLM_LOCAL_FAILED`.
- The `backoff` half of the finding: as the skeptic said, it is overstated. With the breaker closed, `startEntry`
  clears the backoff timer and starts THROUGH the supervisor (pid file written). What the old code additionally broke
  is the case where the supervised attempt itself fails inside this very call: the entry lands in `backoff` and the
  old fall-through then spawned raw and untracked. The new guard refuses that too and leaves the retry to the
  supervisor's timer.

## Tests (written red first)

`src/main/llm/local/supervised.test.ts` - 8 tests, real `createSupervisor` + real `createLlamaRuntime`, a virtual
supervisor clock, an in-process child double and an inline `/health`. No binary is ever executed, no network.
It drives the genuine crash loop over `LLAMA_BACKOFF_MS` [2000, 10000] until `LLAMA_BREAKER` (3 exits / 10 min) opens
and then asserts: the call rejects with `LlamaRuntimeError` / `LLM_LOCAL_FAILED`, the spawn count does NOT move, no
child is left alive, `llama.pid.json` never reappears, `killAllSync()` leaves nothing untracked, and `resetBreaker()`
restores a normal supervised start WITH a pid file.

Red-first proof: I temporarily restored the verbatim old body in the new module and re-ran - 4 of the tests failed
(`promise resolved { port: 51234 } instead of rejecting`, spawn count 4 instead of 3); restoring the guard made all 8
pass. The scratch repro that the verifier left in
`ops/agent-notes/verify-process-lifecycle-5.scratch/` was the starting point for the harness; that scratch directory is
untouched.

## Verification

Re-run on 2026-09-27, after this session was resumed following a usage-limit interruption, once the other repair
agents' in-flight edits had settled. The tree is now materially greener than when I first wrote these notes: every
failure I had reported as "not mine" has since been fixed by its owner, and nothing new appeared in my files.

| Check | Result |
|---|---|
| `npx vitest run --project main src/main/llm/local/supervised.test.ts` | 8 passed |
| `npx vitest run --project main src/main/llm src/main/proc` | 482 passed, 0 failed (was 477 passed / 4 failed) |
| `npx vitest run --project security` | 497 passed, 0 failed |
| `npx vitest run --project integration` | 149 passed, 0 failed |
| `npx prettier --check` on my three files | clean |
| `npm run lint` | 0 errors; 1 pre-existing warning at `src/main/bridge/ingest.ts:404` (unused eslint-disable) - NOT my file |
| `npm run typecheck` | red only in `src/main/agent/prompt.purity.test.ts` and `src/renderer/src/components/ItemCard.test.tsx` - NOT my files |

Two suites were red on their FIRST pass of this session and green on an immediate re-run with no edit from me
(`tests/integration/calendar-health.test.ts` expecting `CAL_UNAVAILABLE`, and `tests/security/redaction.test.ts`
around `data:purgeNow`): another agent landed its fix between the two runs. I re-ran rather than assumed, and I
report the green as the settled state. The `src/main/agent/sanitize.ts` / `sanitize.test.ts` lint+parse errors that
were red earlier in this same session have likewise been fixed by their owner.

### Red-first re-proof, repeated this session rather than merely recalled

To confirm the new test is a real regression guard and not a tautology, I restored the verbatim OLD wrapper body in
`supervised.ts`:

```ts
await supervisor.start('llama');
return runtime.ensureStarted();
```

and re-ran the suite: **5 of the 8 tests failed**. Putting the `STARTABLE` guard back returned all 8 to green and
`prettier --check` to clean. `supervised.ts` is back to the fixed version (verified by grep for the guard); the
backup used for the round-trip lives in the session scratchpad, never in the repo.

### One process note against myself

While updating these notes I ran a `node -e` one-liner through bash with backticks inside a double-quoted string;
the shell performed command substitution and mangled an earlier draft of this very section (it executed the sample
commands and pasted their stdout into the table). No product code was affected - I re-verified `supervised.ts` still
contains the guard and that `git status` showed no new or changed paths - and this section was then rewritten with a
file-write tool instead of a shell heredoc. Recording it because a silently corrupted notes file is exactly the kind
of thing the next agent would otherwise trust.

### Residual risk / what this fix does NOT cover

Unchanged from the original note, and still worth a ticket: nothing subscribes to `supervisor.onState('llama')` in
compose.ts, and `providerFactory.usable()` still returns `{ok:true}` for `local` regardless of runtime state. A
breaker-open llama therefore still presents as a usable provider, and each triage item still pays one refused start.
That refused start is now cheap (no multi-GB spawn) and observable (it rejects), which is the whole of this finding -
but the health pill does not yet surface the open breaker. Out of scope here; flagged for the orchestrator.

## Files

- `src/main/llm/local/supervised.ts` (new, 32 lines)
- `src/main/llm/local/supervised.test.ts` (new, 8 tests)
- `src/main/compose.ts` - one import line + the wrapper now one call (the 8-line inline object is gone)

## Notes for the orchestrator

- Approval-first is untouched: this path only feeds the LLM; no send and no calendar write is reachable from it.
- Follow-up worth a ticket (NOT done here, outside this finding): nothing subscribes to `supervisor.onState('llama')`
  in compose.ts and `providerFactory.usable()` returns `{ok:true}` for `local` regardless of runtime state, so a
  breaker-open llama still shows as a usable provider and every triage item still pays one refused start. The fix
  above makes that refusal cheap and observable, but the health pill still does not show it.
