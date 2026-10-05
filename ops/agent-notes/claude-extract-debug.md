# claude-extract-debug — S1 EXTRACT `LLM_BAD_OUTPUT` on claude_cli (Claude Code 2.1.258)

Agent label: `claude-extract-debug`. Date: 2026-10-05. No commit / push (orchestrator's job).

## Defect

provider `claude_cli`, model sonnet: S1 EXTRACT fails with `LLM_BAD_OUTPUT` in 6 of the last 8 runs (runs table: sandbox_ok 1, init
tools `[StructuredOutput]`, output_tokens 196-1027, stopReason `bad_output`). Users see "Could not analyse this chat". S3 draft works.

## Method

Real `claude.exe` (the user's own install), run headlessly through the app's own builders (`buildClaudeArgs`, `buildClaudeEnv`,
`buildClaudeStdinLineParts`, `buildSystemPrompt`, `buildContext`, `createCliRunner`, `createJobRunner`) from a scratch vitest file
(deleted afterwards). Input was ONLY synthetic: golden fixtures `tests/golden/{he,en,mixed}.jsonl` (he-01, he-04, he-09, he-12, he-15,
en-02, mix-06). A JobRunner wrapper teed stdout lines into memory; only STRUCTURE was recorded (result subtype / is_error /
stop_reason / num_turns, structured_output presence, ExtractionSchema zod result, tool_use names, StructuredOutput input KEY names,
tool_result is_error). 17 real calls in total. No user data, no app DB, no credentials read.

## Evidence (structure only)

Every run: init tools `[StructuredOutput]`, init proof OK, the only tool_use name ever seen is `StructuredOutput`.

| run | --max-turns | StructuredOutput input keys per attempt | CLI tool_result | result | app outcome (shipped code) |
|---|---|---|---|---|---|
| he-01 | 1 | 18 schema keys | ok | success, num_turns 2, zod pass | ok |
| he-09 | 1 | 18 schema keys | ok | success, zod pass | ok |
| he-04 | 1 | 18 schema keys | ok | success, zod pass | ok |
| en-02 | 1 | 18 schema keys | ok | success, zod pass | ok |
| he-12 | 1 | `["$PARAMETER_NAME"]` | is_error | **error_max_turns, is_error true**, stop_reason tool_use, num_turns 2, no structured_output, out 243 tok | bad_output |
| he-15 | 1 | `["$PARAMETER_NAME","$PARAMETER_NAME2"]` | is_error | error_max_turns, is_error true, out 186 tok | bad_output |
| he-12 | 2 | `$PARAMETER_NAME` x2 | is_error x2 | error_max_turns, is_error true, num_turns 3, out 545 tok | bad_output |
| he-15 | 2 | `$PARAMETER_NAME` x2 | is_error x2 | error_max_turns, is_error true, out 426 tok | bad_output |
| he-01 | 2 | 18 schema keys | ok | success, zod pass | ok |
| mix-06 | 2 | `$PARAMETER_NAME` x2 | is_error x2 | error_max_turns, is_error true, out 490 tok | bad_output |
| he-12 | 3 | `$PARAMETER_NAME`, `$PARAMETER_NAME`, 18 keys | is_error, is_error, ok | success, num_turns 4, zod pass, out 1271 tok | ok |

Key finding from the he-12 / max-turns-3 run: the value under `$PARAMETER_NAME` is a plain OBJECT that is the complete answer and
**passes the strict ExtractionSchema** (both attempts). The model has the right answer; it only wraps it under one made-up key.

## Root cause

Claude Code returns `--json-schema` answers through its internal `StructuredOutput` tool. On these tool-less runs Sonnet often calls
that tool with the whole answer wrapped under ONE made-up key (`$PARAMETER_NAME` — the placeholder of the tool-call format, research
bug #87234 — and, seen after the fix, the tool's own name `StructuredOutput`). The CLI's JSON-schema check rejects the call
("must have required property ..."), and:

1. `structured()` ran with `--max-turns 1`, so the CLI had no turn left to retry: the run ends `subtype error_max_turns` with
   **`is_error: true`** and no `structured_output`.
2. The runner checks `is_error` FIRST, maps the empty result text to `bad_output` and sets stopReason `bad_output` (this is why the runs
   table shows stopReason `bad_output`, not `max_turns`; the old unit test modelled error_max_turns with is_error false).
3. `runExtract` gets `LlmError('bad_output')` from the provider, which is returned at once (the repair turn only follows a zod failure).

Raising `--max-turns` alone is NOT a fix: at max-turns 2 the model repeated the same wrapper on its second attempt in 3 of 3 failing
runs (it copies its own previous call); only at 3 did one run heal, at ~5x the output tokens. Other candidates were ruled out: no
run returned text (no fence problem), the schema itself is accepted (clean attempts pass), Hebrew output did not overflow (all answers
< 600 output tokens), and no repair turn was ever reached.

## Fix

- `src/main/llm/cli/claudeCli.ts`
  - `CLAUDE_EXTRACT_MAX_TURNS = 2` used by `structured()` for S1 extract only. One in-run retry for the CLI (he-15 after the fix:
    attempt 1 = a partial answer, attempt 2 = clean). Bounded (test pins <= 3). Smoke (B13) and V1 read_image stay `--max-turns 1`
    (V1's value is a pinned I12 security invariant in tests/security/vision-no-tools.test.ts and tests/integration/pipeline-image.test.ts,
    so it was not changed; V1 still benefits from the wrapper unwrap below).
  - `unwrapWrappedStructured(input, schema)` (pure): returns the inner object only when the StructuredOutput input has EXACTLY one key,
    that key is NOT a declared property of the run's schema, and its value is a plain object. Split answers (two keys), strings, arrays,
    partial answers (a real field) => undefined.
- `src/main/llm/cli/runner.ts` (Claude branch only): on schema runs, each `StructuredOutput` tool_use (still never a strike, F13)
  records the last unwrappable answer in memory (`ParseState.schemaWrapped`, never logged / audited). It is used ONLY when the result
  has no `structured_output`: (1b) `subtype error_max_turns` and no usage-window hit => `structured = wrapped`, error null, stopReason
  `end`; (5) success without structured_output => wrapped before the text backstop. Every other `is_error` result is unchanged (rate
  limit, auth, usage limit still classified first). The caller still zod-validates strictly (ExtractionSchema / ImageReadSchema / the
  smoke's `ok` boolean), so nothing that fails the app's own schema is ever accepted.
- Unchanged: init proof (I11 / `checkClaudeInit`), tools allow-list (schema runs: only StructuredOutput; any other tool_use is a strike
  and kills on the 2nd), argv (no new flag, no `--bare`), env, wall clock (`LIMITS.cliWallClockExtractMs` 60 s; 2-turn runs took 6-8 s),
  `extract.ts` (not edited), the agy code paths.

## Tests (failing first, then green)

- `tests/fakes/fake-claude-cli.mjs` + `.types.ts`: new modes reproducing the live stream — `placeholder_keys` (every attempt
  `{"$PARAMETER_NAME": answer}`, is_error tool_result, then error_max_turns + is_error true, num_turns = attempts + 1),
  `tool_name_wrapper` (`{"StructuredOutput": answer}`), `placeholder_split` (two placeholder keys), `placeholder_then_heal` (clean on
  attempt 2). Attempts = `--max-turns`, as observed live.
- `tests/integration/cli-provider.test.ts`: the three recoverable modes resolve through the production provider/runner/JobRunner with
  `--max-turns 2`, `--tools ""`, no violations, no tool_blocked audit; `placeholder_split` => LLM_BAD_OUTPUT. (Failed before the fix
  with `LlmError: bad_output`.)
- `src/main/llm/cli/runner.test.ts`: new describe — wrapper after error_max_turns+is_error => wrapped object; last attempt wins;
  tool-name wrapper; split / partial answer => bad_output; structured_output wins; success-without-structured_output; never salvaged
  for a real is_error, a usage-window hit, or an S3 draft (StructuredOutput there is still a strike); another tool on a schema run is
  still a strike and kills the run.
- `src/main/llm/cli/claudeCli.test.ts`: `unwrapWrappedStructured` table; `CLAUDE_EXTRACT_MAX_TURNS` = 2 and <= 3; the S1 request
  maxTurns pinned to the constant, the V1 request pinned to 1.
- `tests/security/cli.sandbox.test.ts`: S1 argv literal now built with `CLAUDE_EXTRACT_MAX_TURNS`; V1 argv additionally pins
  `--max-turns 1`; smoke still pins `--max-turns 1`.

## Before / after (real claude.exe, synthetic input)

- Before (shipped code, max-turns 1): 4/6 runs ok (he-12, he-15 failed). Max-turns 2 without the unwrap: 1/4 (all 3 failures were the
  single-key wrapper, which the fix recovers). Max-turns 3 without the unwrap: 1/1 (healed on attempt 3, 1271 output tokens).
  On the hard cases (he-12, he-15, mix-06): 0/5 runs ok before.
- After (through `runExtract` + production provider): first pass, with an intermediate unwrap that only knew `$PARAMETER_NAME`:
  3/4 (he-12 ok, he-15 ok — healed on attempt 2, mix-06 failed with a NEW wrapper key `StructuredOutput`, he-01 ok). That variant led to
  the general single-non-schema-key rule. Final fix: 2/2 (mix-06 ok; he-12 ok **recovered from two `{"StructuredOutput": {...}}`
  attempts whose inner object passed ExtractionSchema** — direct proof of the recovery path on a real run). Hard cases after: 5/6 runs
  ok overall, 4/4 with the final rule. Output tokens after: 475-632 per run (2 short attempts at most).
- Small samples (17 real calls by budget); the residual risk is a split answer over two keys on BOTH attempts, which fails closed as
  LLM_BAD_OUTPUT as before.

## Suite results

See "Suite results (final)" below.

## Hand-off notes for the orchestrator

- `ops/PROGRESS.md` and `src/main/compose.ts` were already modified in the working tree by someone else during this work; not touched.
- Consider a DECISIONS entry: "S1/V1 Claude runs: --max-turns 2 + single-key wrapper unwrap (zod still the gate)". The research table
  line "error_max_turns: raise maxTurns only for draft, never for extract" is superseded for schema runs by this evidence.
- Not changed, possible follow-up: `runExtract` returns provider `bad_output` without the repair turn; with this fix the remaining
  failure (split answer twice) could get one fresh repair run if wanted — a cross-provider change, so left out.

## Suite results (final)
- `npm run typecheck`: clean. `npm run lint` (--max-warnings 0): clean.
- `npx vitest run` (all projects): 336/336 files, 7841 passed, 1 expected fail, 1 skipped, 0 failed.
- An intermediate full run (extra turn also on V1) failed 2 tests that pin V1 `--max-turns 1` (I12); V1 was reverted to 1, then all green.
