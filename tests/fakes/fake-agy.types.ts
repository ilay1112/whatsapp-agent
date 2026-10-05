// tests/fakes/fake-agy.types.ts - [V2] the frozen interface of the fake Antigravity CLI (T2 3.2). Wave 0
// (V2-W0-scaffold); owner V2-W1-09-antigravity. Types only: fake-agy.mjs is plain ESM and reads these shapes as JSON.
// [V2-W1-09] additive: optional state fields (`modeByStage`, `expectIsolatedHome`), optional journal fields (`invocation`, `phase`, `stage`,
// `mode`, `turnStarted`, ...) and readFakeAgyJournal(). No frozen name or field was changed.

export interface FakeAgyState {
  version: string; // default '1.2.12'
  loggedIn: boolean;
  mode: FakeAgyMode;
  models: string[]; // the answer of `agy models`
  running: boolean; // whether an 'agy' process is "running" (S-PROC, workspace-trust precondition)
  /** sha256 of the S1/S3 constant the agent file body must equal (the fake checks .agents\\agents\\wca-<stage>.md). */
  expectedPromptSha256?: Partial<Record<'extract' | 'draft', string>>;
  /** [V2-W1-09] per-stage mode override (like FakeClaudeState.modeByStage). */
  modeByStage?: Partial<Record<'extract' | 'draft' | 'smoke', FakeAgyMode>>;
  /** [V2-W1-09] F3: runs must see USERPROFILE = HOME = <userData>\agy-home (default true; false only for the fallback-mode tests). */
  expectIsolatedHome?: boolean;
  /** [D-080 e2e] `--model` slugs this CLI refuses: stderr `error: invalid model selection (--model "X") ...` + an error result as the
   *  FIRST stdout event (no init), exit 1 - the shape of the agy 1.2.16 refusal. Not a violation (the app may pick any listed model). */
  rejectedModels?: string[];
}
export type FakeAgyMode =
  | 'ok'
  | 'waiting'
  | 'denied'
  | 'no_structured'
  | 'exit3'
  | 'exit3_auth'
  | 'exit3_other'
  | 'extra_tools'
  | 'agent_mismatch'
  | 'perm_mode'
  | 'not_signed_in'
  | 'hang'
  | 'garbage_lines'
  | 'global_mcp_present'
  // [D-080] an error result event INSTEAD of the init (agy 1.2.16 shape)
  | 'result_error_auth'
  | 'result_error_quota'
  | 'result_error_other';
export const FAKE_AGY_MODES: readonly FakeAgyMode[] = [
  'ok',
  'waiting',
  'denied',
  'no_structured',
  'exit3',
  'exit3_auth',
  'exit3_other',
  'extra_tools',
  'agent_mismatch',
  'perm_mode',
  'not_signed_in',
  'hang',
  'garbage_lines',
  'global_mcp_present',
  'result_error_auth',
  'result_error_quota',
  'result_error_other',
];
export const FAKE_AGY_DEFAULT_STATE: FakeAgyState = {
  version: '1.2.12',
  loggedIn: true,
  mode: 'ok',
  models: ['gemini-3.8-flash-high'],
  running: false,
};
export interface FakeAgyJournalEntry {
  argv: string[];
  cwd: string;
  agentFile: { exists: boolean; frontmatterOk: boolean; bodySha256: string | null };
  mcpConfigPresent: boolean;
  schemaFilePresent: boolean;
  envKeys: string[];
  home: { userProfile: string | null; home: string | null };
  stdinLines: number;
  stdinEnvelope: 'agy' | 'claude' | 'other';
  exit: number;
  violations: string[];
  // ---- [V2-W1-09] additive ----
  /** one id per process; the fake writes a 'started' line and a 'final' line - readers keep the last line per invocation. */
  invocation?: string;
  phase?: 'started' | 'final';
  /** 'version' | 'models' | 'usage_probe' | the run stage from --agent wca-<stage> | 'unknown'. */
  stage?: string;
  mode?: FakeAgyMode;
  /** false until the fake passed its init line AND the pause after it (I11 proof: an init mismatch is killed before any turn). */
  turnStarted?: boolean;
  stdinNonceBlocks?: number;
  stdinSha256?: string;
  /** the isolated settings.json under USERPROFILE trusts the run dir (or an ancestor of it) - ASSUMED prefix trust (U-A1). */
  workspaceTrusted?: boolean;
  /** an ENABLED server in <USERPROFILE>\.gemini\config\mcp_config.json (the real agy would start it - F3). */
  globalMcpVisible?: boolean;
  envChecks?: { pathIsSystem32: boolean; tempIsCwd: boolean; autoUpdateOff: boolean; forbiddenKeys: string[] };
}
/** Parses a fake-agy JSONL journal; unparsable lines are ignored; lines sharing an `invocation` collapse to the LAST one (start order). */
export function readFakeAgyJournal(text: string): FakeAgyJournalEntry[] {
  const byId = new Map<string, FakeAgyJournalEntry>();
  const anonymous: FakeAgyJournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let e: FakeAgyJournalEntry;
    try {
      e = JSON.parse(line) as FakeAgyJournalEntry;
    } catch {
      continue;
    }
    if (typeof e.invocation === 'string') byId.set(e.invocation, e);
    else anonymous.push(e);
  }
  return [...anonymous, ...byId.values()];
}
