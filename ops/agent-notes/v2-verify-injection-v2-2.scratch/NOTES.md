# v2-verify-injection-v2-2 (skeptic pass) - verdict: CONFIRMED, severity major

- runner.ts consume() claude branch (now line ~465): `if (req.stage === 'draft' && name.startsWith(CLI_MCP_TOOL_PREFIX)) st.toolCalls += 1;`
  req.exposedNames is only used for the init proof (checkClaudeInit), never per tool_use.
- Spec text (v2-pipeline 8.x "Strikes" row, ARCH2 section 4 result-check row, v2-contracts runner blockedCalls comment) defines runner strikes
  as non-mcp__wca__ tool_use + permission_denials only; it relies on the gate (via the tool server) for unexposed mcp__wca__ names
  (draft.ts runAgenticDraft comment: "every tools/call arrives at the tool server"). The init proof pins init.tools to the exposed
  mcp__wca__ names, so the CLI has no tool object for an unexposed name and resolves it locally as an unknown-tool error, not a forward
  and not a permission_denials entry. The fake CLI forwards raw tools/call probes, which is why the suite never sees the gap.
- Reproduced: copied the reviewer's scratch test here; injection-v2-2 is red (blockedCalls 0).
- No downstream guard: draft.ts / claudeCli.ts / orchestrator.ts take max(res.blockedCalls, ctx.blockedCalls); both 0.
- Severity: major (B17 "unexposed name -> strike" + B28 taint broken on one transport); not a blocker - no send/write without approval.
