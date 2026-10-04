// SCRATCH failing tests for the v2 adversarial review, lens "injection-v2". NOT part of npm test; product files untouched.
// Each `it` asserts the SAFE behaviour; a red test = the finding is real. All data below is synthetic.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '../../../src/shared/types';
import { crossChatLeak } from '../../../src/main/agent/validate';
import { triggerKindOfRun } from '../../../src/main/agent/orchestrator';
import { resolveExtractionWithImage } from '../../../src/main/agent/resolve';
import type { Extraction, ImageRead } from '../../../src/shared/schemas';
import { createCliRunner } from '../../../src/main/llm/cli/runner';
import { buildClaudeStdinLine, CLI_SCHEMA_TOOL, type ClaudeRunRequestExt } from '../../../src/main/llm/cli/claudeCli';
import type { JobHandle, JobRunner, JobSpec } from '../../../src/main/proc/jobRunner';

// ---------------------------------------------------------------------------------------------------------------------
// injection-v2-1: the S4 cross-chat leak guard misses every other-chat row (or excerpt) shorter than 24 normalised chars
// ---------------------------------------------------------------------------------------------------------------------
describe('injection-v2-1 crossChatLeak (validate.ts)', () => {
  it('a short other-chat row quoted VERBATIM in the draft is a leak (I5\': "A draft can never contain text read from another chat")', () => {
    const otherChat = ['gate code 4242#']; // 15 chars, served by wa_search_messages under all_chats
    const draft = 'Sure! gate code 4242# - see you there';
    expect(crossChatLeak(draft, otherChat, LIMITS.crossChatLeakWindow)).toBe(true); // RED today: false
  });

  it('a 23-char excerpt of a long other-chat row (the secret part only) is a leak', () => {
    const otherChat = ['my address is 12 Fake St and the door code is 4242, come by after 8'];
    const draft = 'ok! the door code is 4242'; // "the door code is 4242" = 21 chars
    expect(crossChatLeak(draft, otherChat, LIMITS.crossChatLeakWindow)).toBe(true); // RED today: false
  });

  it('a homoglyph copy (Cyrillic a/o/e for Latin) of a long row is a leak', () => {
    const otherChat = ['my address is 12 Fake St and the door code is 4242'];
    // the attacker's message tells the model to "copy it but write a/o/e in Cyrillic"
    const draft = 'my \u0430ddress is 12 F\u0430ke St \u0430nd the d\u043e\u043er c\u043ede is 4242';
    expect(crossChatLeak(draft, otherChat, LIMITS.crossChatLeakWindow)).toBe(true); // RED today: false
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// injection-v2-2: claude_cli S3 - a tool_use of an UNEXPOSED / unknown mcp__wca__* name is counted as a tool call, never a strike
// ---------------------------------------------------------------------------------------------------------------------
function scriptedJobs(lines: string[]): JobRunner {
  return {
    async run<T>(_spec: JobSpec, use: (job: JobHandle) => Promise<T>): Promise<T> {
      let killed = false;
      let i = 0;
      const handle: JobHandle = {
        pid: 1,
        lines: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () =>
              killed || i >= lines.length ? { value: undefined, done: true as const } : { value: lines[i++]!, done: false as const },
          }),
        }),
        write: () => undefined,
        kill: () => {
          killed = true;
        },
        get done() {
          return Promise.resolve({ exitCode: killed ? null : 0, killed, timedOut: false, stderrMarkers: [], ms: 1 });
        },
      };
      return use(handle);
    },
    breaker: () => ({ open: false, failures: 0, openedAt: null }),
    resetBreaker: () => undefined,
    killAll: async () => undefined,
    jobPids: () => ({ cli: [], voice: [] }),
  } as unknown as JobRunner;
}
const j = (o: unknown): string => JSON.stringify(o);
const s3init = j({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'none',
  tools: ['mcp__wca__get_current_time', 'mcp__wca__get_freebusy'],
  mcp_servers: [{ name: 'wca', status: 'connected' }],
  mcp_server_errors: [],
  plugins: [],
});
const toolUse = (name: string): string =>
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input: {} }] } });
const result = j({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
  permission_denials: [],
});

describe('injection-v2-2 CLI runner strike accounting (runner.ts consume)', () => {
  it('mcp__wca__send_message / mcp__wca__wa_list_chats (not exposed in this run) are strikes like on the in-process gate', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-scratch-'));
    try {
      let strikes = 0;
      const runner = createCliRunner({
        jobs: scriptedJobs([s3init, toolUse('mcp__wca__send_message'), toolUse('mcp__wca__wa_list_chats'), result]),
        userDataDir: userData,
        now: () => 1_800_000_000_000,
        audit: () => undefined,
        processEnv: { SystemRoot: 'C:\\Windows' },
      });
      const req: ClaudeRunRequestExt = {
        provider: 'claude_cli',
        stage: 'draft',
        exePath: 'C:\\fakehome\\.local\\bin\\claude.exe',
        model: 'sonnet',
        system: 'SYSTEM',
        stdinLine: buildClaudeStdinLine('<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>', null),
        jsonSchema: null,
        maxTurns: 5,
        wallClockMs: LIMITS.cliWallClockDraftMs,
        toolServer: { url: 'http://127.0.0.1:50123/mcp', token: 'T'.repeat(43) },
        observedVersion: '2.1.258',
        exposedNames: ['get_current_time', 'get_freebusy'],
        runId: 1,
        auditRef: '1',
        onStrike: () => {
          strikes += 1;
          return strikes >= LIMITS.blockedCallsAbort;
        },
      };
      void CLI_SCHEMA_TOOL;
      const res = await runner.run(req, new AbortController().signal);
      // In-process, the gate scores BOTH names as strikes (blocked_unknown_tool / blocked_not_exposed) => manipulation + 7-day taint.
      expect(res.blockedCalls).toBeGreaterThan(0); // RED today: 0 (and res.toolCalls === 2)
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// injection-v2-3: a picture whose digits complete the slot but whose readText is '' is labelled trigger_kind 'text'
// ---------------------------------------------------------------------------------------------------------------------
describe('injection-v2-3 trigger_kind of a picture-derived slot (orchestrator.ts / resolve.ts)', () => {
  it('imageMerge.used => trigger kind must be image (media-derived), not text', () => {
    const x: Extraction = {
      intent: 'schedule_request',
      needsReply: true,
      title: 'meeting',
      dateKind: 'none',
      isoDate: '',
      weekday: 0,
      weekOffset: 0,
      daysFromToday: 0,
      time24h: '',
      timeAmbiguous: false,
      durationMin: 0,
      location: '',
      missing: ['date', 'time'],
      suspicious: false,
      refersToExisting: false,
      change: 'no_change',
      changeConfidence: 'high',
      confidence: 'high',
    };
    // V1 (steered by the picture) reports digits but an EMPTY readText: orchestrator.ts attaches no imageText => imageInWindow false
    const read: ImageRead = {
      readable: true,
      kind: 'flyer',
      readText: '',
      language: 'en',
      title: '',
      dateText: '',
      day: 5,
      month: 10,
      year: 2026,
      weekday: 7,
      timeText: '',
      hour: 10,
      minute: 0,
      timeAmbiguous: false,
      endHour: 11,
      endMinute: 0,
      location: '',
      confidence: 'high',
      suspicious: false,
    };
    const merged = resolveExtractionWithImage(x, read, {
      nowMs: Date.UTC(2026, 9, 1, 6, 0, 0),
      timeZone: 'Asia/Jerusalem',
      defaultDurationMin: 60,
      ambiguousHour: 'assume',
    });
    expect(merged.imageMerge?.used).toBe(true);
    expect(merged.state).toBe('complete'); // the slot came ONLY from the picture
    // orchestrator.ts: imageInWindow = extractCtx.imageInWindow (false: readText ''), imageTriggerUnread = false (V1 ok)
    const kind = triggerKindOfRun({ voiceInWindow: false, imageInWindow: false, imageTriggerUnread: false });
    expect(kind).toBe('image'); // RED today: 'text'
  });
});
