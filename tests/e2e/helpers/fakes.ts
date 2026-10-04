// tests/e2e/helpers/fakes.ts - starting the fakes an E2E launch is allowed to see (owner W2-03).
//
// Three modes, all of them fakes (TESTS 4.2): ATTACH (an in-process `fake-bridge` already listening, the app only points
// its REST clients at it), CHILD (`WCA_BRIDGE_CMD`: the system `node` runs the same fake as a real child process) and the
// MCP child (`WCA_MCP_CMD`: `fake-mcp-calendar.ts` over stdio, journalled to a file).
// Nothing here can reach WhatsApp, Google or a model: no real exe, no network target other than 127.0.0.1.
// [V2] T2 10.0: `cliFakes()` (WCA_CLI_CMD - the fake Claude Code / Antigravity CLIs), `whisperFake()` (WCA_WHISPER_CMD) and
// `dialogScript()` (WCA_DIALOG_SCRIPT). The vendor CLIs and whisper are ALWAYS the `.mjs` fakes under the system node.exe (T8): the
// app spawns them itself through its production JobRunner, exactly as it would spawn the real binary.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { startFakeBridge, type FakeBridge, type FakeBridgeOptions } from '../../fakes/fake-bridge.ts';
import { FAKE_CLAUDE_DEFAULT_STATE, type FakeClaudeState } from '../../fakes/fake-claude-cli.types.ts';
import { FAKE_AGY_DEFAULT_STATE, type FakeAgyState } from '../../fakes/fake-agy.types.ts';
import type { WhisperFakeMode } from '../../fakes/whisper-cli.types.ts';
import {
  calendarControl,
  calendarControlArgv,
  newCalendarControlSecret,
  waitForCalendarControl,
  type CalendarControlArgs,
  type CalendarControlEndpoint,
  type CalendarControlVerb,
} from '../../fakes/fake-mcp-calendar-control.ts';
import type { SeamDialogAnswer } from '../../../src/main/testSeams.ts';
import { wca, type E2eContext } from './fixtures.ts';
import { FAKE_AGY_MJS, FAKE_CLAUDE_CLI_MJS, FAKE_LLAMA_TS, FAKE_MCP_TS, FAKE_WHISPER_MJS } from './paths.ts';

/** A free loopback port for the child-mode fake's `__control` server (never 8080, which the bridge invariants forbid). */
export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => (port > 0 && port !== 8080 ? resolve(port) : reject(new Error('no usable port'))));
    });
  });
}

/** 64 lowercase hex - exactly what `readSeams` accepts as `WCA_FAKE_BRIDGE_TOKEN`. */
export function newBridgeToken(): string {
  return randomBytes(32).toString('hex');
}

export interface AttachedBridge {
  fake: FakeBridge;
  /** The profile this fake serves (its sends / media requests are checked against that profile's app.db only). */
  userDataDir: string;
  /** `WCA_FAKE_BRIDGE_URL` + `WCA_FAKE_BRIDGE_TOKEN`, ready to spread into `launch({ env })`. */
  env: Record<string, string>;
  token: string;
  /**
   * An inbound message the way the REAL bridge delivers one: the row lands in `messages.db` AND the app's doorbell is
   * rung (bridge-contract: one webhook POST per inbound, `X-Bridge-Token` = the bridge's token), which is what makes
   * ingest scan now. `fake.inbound()` alone only writes the row - the fake is started before the app exists, so it has
   * no webhook URL, and in attach mode nothing else rings ingest between the boot-time pokes and the 30 s fallback
   * timer (`LIMITS.scanIntervalMs`, which `WCA_TIMERS.scanMs` does NOT shorten - that one is the triage queue's). A spec
   * that writes the row without ringing is betting on the 250 ms debounce window of the last boot poke.
   */
  deliver(app: ElectronApplication, msg: Parameters<FakeBridge['inbound']>[0]): Promise<{ id: string; rowid: number }>;
  /**
   * [V2] A message the USER typed on the phone (`from_me` row + doorbell ring, `isFromMe:true`). Automatic mode requires recent user
   * participation in the chat (AutoGate `no_user_participation`), and the only honest way to get it is a real outbound row.
   */
  deliverOwn(app: ElectronApplication, msg: { chatJid: string; text: string; ts?: Date }): Promise<{ id: string }>;
  /**
   * [V2] A media message (voice note / picture): the row (`media_type` audio|image, caption as text) lands in `messages.db`, its bytes
   * are scripted on the fake's `/api/media` route BEFORE the doorbell rings - the app fetches them itself (media/fetch.ts).
   */
  deliverMedia(
    app: ElectronApplication,
    msg: {
      chatJid: string;
      mediaType: 'audio' | 'image';
      bytes: Uint8Array;
      caption?: string;
      ts?: Date;
      pushName?: string;
    },
  ): Promise<{ id: string; rowid: number }>;
}

/**
 * ATTACH mode. The fake writes `messages.db` into `<userData>\bridge\store\`, exactly where the app's read-only
 * `bridgeDb` looks for it. Its `sent` journal and `violations` are folded into the spec's ledger on dispose.
 */
export async function attachBridge(
  ctx: E2eContext,
  userDataDir: string,
  opts: Partial<Omit<FakeBridgeOptions, 'token' | 'storeDir'>> = {},
): Promise<AttachedBridge> {
  const token = newBridgeToken();
  const storeDir = join(userDataDir, 'bridge', 'store');
  mkdirSync(storeDir, { recursive: true });
  const fake = await startFakeBridge({ ...opts, token, storeDir });
  ctx.onStop(async () => {
    for (const s of fake.sent) ctx.sends.push({ at: s.at, recipient: s.recipient, message: s.message, userDataDir });
    for (const m of fake.mediaRequests)
      ctx.mediaRequests.push({ chatJid: m.chatJid, messageId: m.messageId, userDataDir });
    ctx.violations.push(...fake.violations);
    await fake.stop();
  });
  // The fake writes messages.db while the app reads it (rollback journal, like the real bridge): a write that meets the app's
  // read lock answers SQLITE_BUSY. The real bridge's writer simply retries; so does the spec - the APP is not involved in this.
  const retryBusy = async <T>(write: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await write();
      } catch (e) {
        if (attempt >= 50 || !/database is locked|SQLITE_BUSY/i.test(String((e as Error).message))) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  };
  const ring = async (app: ElectronApplication, chatJid: string, content: string, isFromMe: boolean): Promise<void> => {
    // `__wcaTest.doorbellUrl` is the live `http://127.0.0.1:<port>/hook/<secret>` compose minted for this launch.
    const url = await wca(app).doorbellUrl();
    if (url === '') throw new Error('E2E: the app published no doorbell URL, so the inbound cannot be delivered');
    const status = await fake.ringDoorbell(url, {
      sender: isFromMe ? '972500000000' : (chatJid.split('@')[0] ?? ''),
      content,
      chatJID: chatJid,
      isFromMe,
    });
    if (status !== 200) throw new Error(`E2E: the doorbell answered HTTP ${status} to a well-formed ring`);
  };
  return {
    fake,
    userDataDir,
    token,
    env: { WCA_FAKE_BRIDGE_URL: fake.url, WCA_FAKE_BRIDGE_TOKEN: token },
    deliver: async (app, msg) => {
      const row = await retryBusy(() => fake.inbound(msg));
      await ring(app, msg.chatJid, msg.text, false);
      return row;
    },
    deliverOwn: async (app, msg) => {
      const row = await retryBusy(() => fake.outboundFromPhone(msg));
      await ring(app, msg.chatJid, msg.text, true);
      return row;
    },
    deliverMedia: async (app, msg) => {
      const row = await retryBusy(() =>
        fake.inbound({
          chatJid: msg.chatJid,
          text: msg.caption ?? '',
          mediaType: msg.mediaType,
          ...(msg.ts === undefined ? {} : { ts: msg.ts }),
          ...(msg.pushName === undefined ? {} : { pushName: msg.pushName }),
        }),
      );
      fake.setMedia(msg.chatJid, row.id, msg.bytes);
      await ring(app, msg.chatJid, msg.caption ?? '', false);
      return row;
    },
  };
}

export interface McpChild {
  journalFile: string;
  seedFile: string | null;
  /** `WCA_MCP_CMD`, ready to spread into `launch({ env })`. */
  env: Record<string, string>;
  /** Every journalled line so far (`env`, `argv`, `call`). */
  entries(): Array<{ at: number; kind: string; detail: unknown }>;
  /** Only the `create-event` tool calls, in order. */
  createEvents(): Array<{ at: number; args: Record<string, unknown> }>;
  calls(tool?: string): Array<{ at: number; tool: string; args: Record<string, unknown> }>;
  /**
   * [V2] The child's loopback control channel (REQUEST 12, `tests/fakes/fake-mcp-calendar-control.ts`): only when the spec asked
   * for it (`opts.control`), else it throws. Resolves once the LATEST child the app spawned answers `ping` (a respawn journals a new
   * port). Drives Google-side behaviour the app cannot see coming - e.g. `userEditsInGoogle` before an undo.
   */
  control(timeoutMs?: number): Promise<CalendarControlEndpoint>;
  /** One control verb on the latest child (`control()` + `calendarControl`); rejects with the fake's reason on any refusal. */
  controlVerb<V extends CalendarControlVerb>(verb: V, args?: CalendarControlArgs[V]): Promise<unknown>;
}

interface JournalCall {
  at: number;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * `WCA_MCP_CMD`: the calendar MCP server the app spawns is `fake-mcp-calendar.ts` under the system `node`, never the
 * staged real server and never a Google account. Its `create-event` calls feed the ledger.
 */
export function mcpChild(
  ctx: E2eContext,
  label: string,
  seed?: {
    events?: unknown[];
    calendars?: unknown[];
    accounts?: string;
    scenario?: string;
    /** [V2] T2 3.7 scenarios active from the child's start (`drift`, `restore_refused`, `event_missing`, ...). */
    v2Scenarios?: string[];
  },
  /** [V2] the profile this calendar belongs to (its calls are checked against that profile's app.db only). */
  userDataDir?: string,
  /** [V2] `control: true` starts the child's 127.0.0.1 control listener (ephemeral port, fresh random secret per child). */
  opts: { control?: boolean } = {},
): McpChild {
  const journalFile = ctx.writeTempFile(`${label}-mcp-journal.jsonl`, '');
  const controlSecret = opts.control === true ? newCalendarControlSecret() : null;
  // The child reads `--seed` as its FakeCalendarOptions (seedEvents / calendars / accounts / v2Scenarios).
  const seedFile =
    seed === undefined
      ? null
      : ctx.writeTempFile(
          `${label}-mcp-seed.json`,
          JSON.stringify({
            ...(seed.events === undefined ? {} : { seedEvents: seed.events }),
            ...(seed.calendars === undefined ? {} : { calendars: seed.calendars }),
            ...(seed.accounts === undefined ? {} : { accounts: seed.accounts }),
            ...(seed.v2Scenarios === undefined ? {} : { v2Scenarios: seed.v2Scenarios }),
          }),
        );

  const entries = (): Array<{ at: number; kind: string; detail: unknown }> => {
    if (!existsSync(journalFile)) return [];
    const out: Array<{ at: number; kind: string; detail: unknown }> = [];
    for (const line of readFileSync(journalFile, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as { at: number; kind: string; detail: unknown });
      } catch {
        /* a half-written line is not an assertion */
      }
    }
    return out;
  };
  const calls = (tool?: string): JournalCall[] =>
    entries()
      .filter((e) => e.kind === 'call')
      .map((e) => e.detail as JournalCall)
      .filter((c) => c !== null && typeof c === 'object' && (tool === undefined || c.tool === tool));

  const control = (timeoutMs = 15_000): Promise<CalendarControlEndpoint> => {
    if (controlSecret === null)
      return Promise.reject(new Error(`E2E: mcpChild('${label}') was started without { control: true }`));
    return waitForCalendarControl(journalFile, controlSecret, timeoutMs);
  };

  ctx.onStop(() => {
    for (const c of calls('create-event')) ctx.createEvents.push({ at: c.at, args: c.args, userDataDir });
    // [V2] ledger rules 6-9: every tool call (create-event, update-event and any delete-event attempt), and the fake's own violations
    for (const c of calls())
      ctx.calendarCalls.push({ at: c.at, tool: c.tool, args: c.args, source: label, userDataDir });
    for (const e of entries())
      if (e.kind === 'violation' && typeof e.detail === 'string') ctx.violations.push(e.detail);
  });

  return {
    journalFile,
    seedFile,
    env: {
      WCA_MCP_CMD: JSON.stringify({
        command: process.execPath,
        args: [
          FAKE_MCP_TS,
          '--journal',
          journalFile,
          ...(seedFile === null ? [] : ['--seed', seedFile]),
          ...(seed?.scenario === undefined ? [] : ['--scenario', String(seed.scenario)]),
          ...(controlSecret === null ? [] : calendarControlArgv(controlSecret)),
        ],
      }),
    },
    entries,
    createEvents: () => calls('create-event').map((c) => ({ at: c.at, args: c.args })),
    calls,
    control,
    controlVerb: async (verb, args) => calendarControl(await control(), verb, args),
  };
}

/** `WCA_LLAMA_CMD`: the "local model server" is `fake-llama-server.ts`; `llama-server.exe` is never spawned in a test. */
export function llamaCmdSeam(extraArgs: string[] = []): Record<string, string> {
  return {
    WCA_LLAMA_CMD: JSON.stringify({ command: process.execPath, args: [FAKE_LLAMA_TS, ...extraArgs] }),
  };
}

// =====================================================================================================================
// [V2] T2 10.0 - the spawnable job fakes (vendor CLIs, whisper) and the scripted native dialog
// =====================================================================================================================

/** One parsed journal line of a spawned fake; lines sharing an `invocation` id collapse to the last one (the `final` phase). */
export type JournalEntry = Record<string, unknown> & { violations?: string[] };

export function readJsonlJournal(file: string): JournalEntry[] {
  if (!existsSync(file)) return [];
  const byId = new Map<string, JournalEntry>();
  const rest: JournalEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const e = raw as JournalEntry;
    if (typeof e.invocation === 'string') byId.set(e.invocation, e);
    else rest.push(e);
  }
  return [...rest, ...byId.values()];
}

/** A `StubRule`-shaped script rule of the fake CLIs (T2 3.1 step 5): `when.stage` / `when.contains` -> structured | text | toolCalls. */
export interface FakeCliRule {
  when: {
    stage?: 'extract' | 'draft' | 'read_image' | 'smoke';
    purpose?: string;
    contains?: string;
    notContains?: string;
    imageSha256?: string;
    /** 0-based agentic turn of the draft stage (the fake's `pick(turn)`). */
    turn?: number;
  };
  respond: Record<string, unknown>;
}

export interface CliFakeHandle<S> {
  stateFile: string;
  scriptFile: string;
  journalFile: string;
  /** Rewrites the state file (re-read on EVERY invocation, T2 3.1), e.g. `{loggedIn:true}` after a sign-in. */
  setState(patch: Partial<S>): void;
  setScript(rules: FakeCliRule[]): void;
  journal(): JournalEntry[];
  /** The absolute command the app records as the CLI "exe" (`WCA_CLI_CMD.command` = the system node.exe). */
  command: string;
}

export interface CliFakes {
  /** `WCA_CLI_CMD`, ready to spread into `launch({ env })`. */
  env: Record<string, string>;
  claude: CliFakeHandle<FakeClaudeState> | null;
  agy: CliFakeHandle<FakeAgyState> | null;
}

type FakeOpts<S> = (Partial<S> & { script?: FakeCliRule[] }) | null | undefined;

/**
 * `WCA_CLI_CMD` (T2 4.1): per CLI provider the fake to spawn, or `null` (= that CLI is `not_installed`). Each fake gets its own state,
 * script and journal file under the spec's temp root; the journals join the spec's ledger (rule 11: every entry violation-free).
 * `claude: null` / omitted produces `{"claude_cli": null}` - the app then reports `not_installed` without probing the disk.
 */
export function cliFakes(
  ctx: E2eContext,
  opts: { claude?: FakeOpts<FakeClaudeState>; agy?: FakeOpts<FakeAgyState>; label?: string; userDataDir?: string },
): CliFakes {
  const dir = join(ctx.root, 'wca-fakes', opts.label ?? 'cli');
  mkdirSync(dir, { recursive: true });
  const make = <S extends object>(kind: 'claude' | 'agy', defaults: S, o: FakeOpts<S>): CliFakeHandle<S> | null => {
    if (o === undefined || o === null) return null;
    const { script: rules, ...state } = o;
    const stateFile = join(dir, `${kind}-state.json`);
    const scriptFile = join(dir, `${kind}-script.json`);
    const journalFile = join(dir, `${kind}-journal.jsonl`);
    let current: S = { ...defaults, ...(state as Partial<S>) };
    writeFileSync(stateFile, JSON.stringify(current), 'utf8');
    writeFileSync(scriptFile, JSON.stringify({ rules: rules ?? [] }), 'utf8');
    writeFileSync(journalFile, '', 'utf8');
    const journal = (): JournalEntry[] => readJsonlJournal(journalFile);
    ctx.journals.push({
      kind,
      entries: journal,
      ...(opts.userDataDir === undefined ? {} : { userDataDir: opts.userDataDir }),
    });
    return {
      stateFile,
      scriptFile,
      journalFile,
      command: process.execPath,
      setState: (patch) => {
        current = { ...current, ...patch };
        writeFileSync(stateFile, JSON.stringify(current), 'utf8');
      },
      setScript: (r) => writeFileSync(scriptFile, JSON.stringify({ rules: r }), 'utf8'),
      journal,
    };
  };
  const claude = make<FakeClaudeState>('claude', FAKE_CLAUDE_DEFAULT_STATE, opts.claude);
  const agy = make<FakeAgyState>('agy', FAKE_AGY_DEFAULT_STATE, opts.agy);
  const cmd = (fake: string, h: CliFakeHandle<object> | null): { command: string; args: string[] } | null =>
    h === null
      ? null
      : {
          command: process.execPath,
          args: [
            fake,
            '--fake-journal',
            h.journalFile,
            '--fake-state',
            h.stateFile,
            '--fake-script',
            h.scriptFile,
            '--fake-end',
          ],
        };
  return {
    env: {
      WCA_CLI_CMD: JSON.stringify({
        claude_cli: cmd(FAKE_CLAUDE_CLI_MJS, claude),
        antigravity_cli: cmd(FAKE_AGY_MJS, agy),
      }),
    },
    claude,
    agy,
  };
}

export interface WhisperFake {
  /** `WCA_WHISPER_CMD`, ready to spread into `launch({ env })`. */
  env: Record<string, string>;
  journalFile: string;
  journal(): JournalEntry[];
}

/**
 * `WCA_WHISPER_CMD` (T2 4.1): the voice job spawns `tests/fakes/whisper-cli.mjs` under the system node.exe instead of
 * `<resources>\whisper\whisper-cli.exe`. The transcript is looked up by the decoded duration (`byDuration["3.0"]`), so a synthetic
 * Ogg of exactly N seconds maps to exactly one scripted transcript.
 */
export function whisperFake(
  ctx: E2eContext,
  opts: {
    mode?: WhisperFakeMode;
    transcripts?: Record<string, { language: string; text: string }>;
    fallback?: { language: string; text: string };
    label?: string;
    userDataDir?: string;
  } = {},
): WhisperFake {
  const dir = join(ctx.root, 'wca-fakes', opts.label ?? 'whisper');
  mkdirSync(dir, { recursive: true });
  const journalFile = join(dir, 'whisper-journal.jsonl');
  const transcriptsFile = join(dir, 'whisper-transcripts.json');
  writeFileSync(journalFile, '', 'utf8');
  writeFileSync(
    transcriptsFile,
    JSON.stringify({
      byDuration: opts.transcripts ?? {},
      ...(opts.fallback === undefined ? {} : { default: opts.fallback }),
    }),
    'utf8',
  );
  const journal = (): JournalEntry[] => readJsonlJournal(journalFile);
  ctx.journals.push({
    kind: 'whisper',
    entries: journal,
    ...(opts.userDataDir === undefined ? {} : { userDataDir: opts.userDataDir }),
  });
  return {
    journalFile,
    journal,
    env: {
      WCA_WHISPER_CMD: JSON.stringify({
        command: process.execPath,
        args: [
          FAKE_WHISPER_MJS,
          '--fake-journal',
          journalFile,
          '--fake-mode',
          opts.mode ?? 'ok',
          '--fake-transcripts',
          transcriptsFile,
          '--fake-cores',
          String(cpus().length),
          '--fake-end',
        ],
      }),
    },
  };
}

/**
 * `WCA_DIALOG_SCRIPT` (T2 4.1): FIFO answers of the main-process dialog facade (the automatic-mode enable dialog, the agy
 * workspace-trust dialog). The REAL options object is still built and recorded (`__wcaTest.dialogs()`); an exhausted script answers
 * Cancel. It can never approve an action, an undo or a consent - those have no dialog seam.
 */
export function dialogScript(answers: SeamDialogAnswer[]): Record<string, string> {
  return { WCA_DIALOG_SCRIPT: JSON.stringify(answers) };
}
