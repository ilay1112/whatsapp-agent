// tests/security/redaction.test.ts - gate item 9 of TESTS 8.2 (logging). Owner: W2-02.
//
// Two halves: a golden table for every C-41 pattern of the REAL `redact()`, and a full pipeline run through the REAL
// `compose()` whose temp `userData` tree, database and captured log are then grepped for every sentinel.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import { backupNow } from '../../src/main/db/backup.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import {
  LOG_FILE_COUNT,
  LOG_FILE_MAX_BYTES,
  configureElectronLog,
  createLogger,
  errorMeta,
  redact,
  sha8,
  toolMeta,
  type ElectronLogLike,
} from '../../src/main/logger.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Synthetic sentinels (rule T5): none of these is a real identifier.
const SENTINEL_MSG_TEXT = 'ZZSENTINELMESSAGEBODYZZ';
const SENTINEL_NAME = 'ZZSENTINELPUSHNAMEZZ';
const CHAT = '972550000005@s.whatsapp.net';
const CHAT_DIGITS = '972550000005';
const HARNESS_BRIDGE_TOKEN = 'harness-bridge-token-0123456789abcdef';

// ---------------------------------------------------------------------------------------------------------------------
// 1. the C-41 golden table
// ---------------------------------------------------------------------------------------------------------------------
describe('C-41 - redact() golden table', () => {
  const CASES: Array<[string, string, string]> = [
    ['anthropic key', 'key=sk-ant-TESTONLY-0123456789abcdef done', 'key=[REDACTED-ANTHROPIC-KEY] done'],
    ['google key', 'key=AIzaTESTONLY0123456789abcdefghijklmno done', 'key=[REDACTED-GOOGLE-KEY] done'],
    ['google access token', 'tok=ya29.TESTONLYaccessTOKEN_value done', 'tok=[REDACTED-GOOGLE-ACCESS-TOKEN] done'],
    ['google refresh token', 'tok=1//0TESTONLYrefreshTOKENvalue1234 done', 'tok=[REDACTED-GOOGLE-REFRESH-TOKEN] done'],
    ['authorization header', 'authorization: Bearer abc.def.ghi', 'authorization: [REDACTED]'],
    ['x-bridge-token header', 'x-bridge-token: 0123456789abcdef', 'x-bridge-token: [REDACTED]'],
    ['proxy-authorization', 'proxy-authorization: Basic Zm9v', 'proxy-authorization: [REDACTED]'],
    ['x-api-key', 'x-api-key=abcdef123456', 'x-api-key: [REDACTED]'],
    ['bare bearer', 'sent Bearer eyJhbGciOiJIUzI1NiJ9.x.y', 'sent Bearer [REDACTED]'],
    [
      'doorbell secret',
      'url=http://127.0.0.1:41000/hook/abcdefghijklmnopqrstuvwx',
      'url=http://127.0.0.1:41000/hook/[REDACTED]',
    ],
    ['64-hex token', `token=${'a'.repeat(64)}`, 'token=[REDACTED-HEX64]'],
    [
      'oauth code',
      'https://x.example/cb?code=4/0AY0e-abc&state=xyz',
      'https://x.example/cb?code=[REDACTED]&state=[REDACTED]',
    ],
    ['access_token field', 'access_token=ya29abc&x=1', 'access_token=[REDACTED]&x=1'],
    ['refresh_token field', 'refresh_token=1//abc def', 'refresh_token=[REDACTED] def'],
    ['client_secret field', 'client_secret=GOCSPX-abc def', 'client_secret=[REDACTED] def'],
    // `@s.whatsapp.net` is not an e-mail TLD the EMAIL pattern matches, so the digits alone are replaced.
    ['phone JID', `chat=${CHAT}`, 'chat=[PHONE]@s.whatsapp.net'],
    ['lid JID', 'chat=123456789012@lid', 'chat=[PHONE]@lid'],
    ['e-mail', 'to=someone@example.com now', 'to=[EMAIL] now'],
    ['E.164 phone', 'called +972550000005 now', 'called [PHONE] now'],
    [
      'windows user path',
      'path=C:\\Users\\someone\\AppData\\Roaming\\x',
      'path=C:\\Users\\[USER]\\AppData\\Roaming\\x',
    ],
  ];

  it.each(CASES)('%s', (_label, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('is idempotent: redacting twice changes nothing', () => {
    for (const [, input] of CASES) {
      const once = redact(input);
      expect(redact(once), input).toBe(once);
    }
  });

  it('keeps an ErrorCode readable (a bare `code=` is not a query parameter)', () => {
    expect(redact('bridge_spawn_refused code=BRIDGE_SPAWN_REFUSED')).toBe(
      'bridge_spawn_refused code=BRIDGE_SPAWN_REFUSED',
    );
  });

  it('never lets a model-chosen tool name through literally', () => {
    const hostile = `delete-event-${SENTINEL_MSG_TEXT}`;
    const meta = toolMeta(hostile);
    expect(JSON.stringify(meta)).not.toContain(SENTINEL_MSG_TEXT);
    expect(meta).toEqual({ toolSha8: sha8(hostile), toolLen: hostile.length });
    // Our own READ tools (the two app-authored names of agent/toolDefs.ts) stay readable.
    expect(toolMeta('get_freebusy')).toEqual({ tool: 'get_freebusy' });
    expect(toolMeta('get_current_time')).toEqual({ tool: 'get_current_time' });
    // A REAL MCP tool name is not one of ours, so it is hashed like any other model-chosen string.
    expect(toolMeta('list-events')).toEqual({ toolSha8: sha8('list-events'), toolLen: 11 });
  });

  it('never logs a provider error message', () => {
    const err = new Error(`provider said: ${SENTINEL_MSG_TEXT} for ${CHAT}`);
    expect(JSON.stringify(errorMeta(err))).not.toContain(SENTINEL_MSG_TEXT);
    expect(errorMeta(err)).toEqual({ code: 'INTERNAL' });
    expect(errorMeta({ code: 'BRIDGE_SPAWN_REFUSED' })).toEqual({ code: 'BRIDGE_SPAWN_REFUSED' });
    expect(errorMeta({ code: SENTINEL_MSG_TEXT })).toEqual({ code: 'INTERNAL' });
  });

  it('every line a logger emits has passed through redact() exactly once', () => {
    const lines: string[] = [];
    const log = createLogger({ logsDir: 'C:\\nowhere', sink: (l) => lines.push(l), now: () => 0 });
    log.child('bridge').warn('spawn_refused', {
      jid: CHAT,
      token: 'a'.repeat(64),
      hook: '/hook/abcdefghijklmnopqrstuvwx',
      key: 'sk-ant-TESTONLY-0123456789abcdef',
      tool: `create-event-${SENTINEL_MSG_TEXT}`,
      path: 'C:\\Users\\someone\\AppData',
    });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    for (const secret of [
      CHAT_DIGITS,
      'a'.repeat(64),
      'abcdefghijklmnopqrstuvwx',
      'sk-ant-TESTONLY',
      SENTINEL_MSG_TEXT,
    ]) {
      expect(line, secret).not.toContain(secret);
    }
    expect(line).toContain('bridge.spawn_refused');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. electron-log wiring
// ---------------------------------------------------------------------------------------------------------------------
describe('ARCH 14 - exactly one transport hook', () => {
  it('turns the console and ipc transports off and keeps only the file transport', () => {
    const elog: ElectronLogLike = {
      transports: {
        file: { level: 'silly', maxSize: 0, format: 'whatever' },
        console: { level: 'silly' },
        ipc: { level: 'silly' },
      },
      info: () => undefined,
    };
    const sink = configureElectronLog(elog, {
      logsDir: 'C:\\temp\\logs',
      fs: { existsSync: () => false, renameSync: () => undefined, unlinkSync: () => undefined },
    });
    expect(elog.transports.console.level).toBe(false);
    expect(elog.transports.ipc!.level).toBe(false);
    expect(elog.transports.file.level).toBe('info');
    expect(elog.transports.file.maxSize).toBe(LOG_FILE_MAX_BYTES);
    expect(elog.transports.file.format).toBe('{text}');
    expect(LOG_FILE_COUNT).toBe(5);
    expect(typeof sink).toBe('function');
  });

  it('`console.*` is lint-banned in src/main and absent from the source', () => {
    const eslintConfig = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8');
    expect(eslintConfig).toMatch(/no-console/);
    expect(eslintConfig).toMatch(/src\/main/);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.fixtures.ts')) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        if (/\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir)\b/.test(code)) {
          offenders.push(full.slice(REPO_ROOT.length + 1));
        }
      }
    };
    walk(join(REPO_ROOT, 'src', 'main'));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. a full run, then a recursive grep
// ---------------------------------------------------------------------------------------------------------------------
const RULES: StubRule[] = [
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'schedule_request',
        needsReply: true,
        title: SENTINEL_MSG_TEXT,
        dateKind: 'weekday',
        weekday: 4,
        time24h: '17:00',
        durationMin: 60,
      }),
    },
  },
  // An attacker turn whose TOOL NAME carries the sentinel: the gate blocks it and the log must only hold a hash.
  {
    when: { purpose: 'draft', turn: 1 },
    respond: {
      toolCalls: [{ name: `delete-event-${SENTINEL_MSG_TEXT}`, input: { calendarId: 'primary' } }],
      stopReason: 'tool_use',
    },
  },
  { when: { purpose: 'draft' }, respond: { text: 'Thursday 17:00 works', stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** Every file under `root` except the app database and the bridge's own store. */
function filesToGrep(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = full.slice(root.length + 1).replaceAll(sep, '/');
      if (rel.startsWith('bridge/store')) continue; // the bridge's own message store is not ours to sanitise
      if (/^app\.db(-wal|-shm)?$/.test(rel)) continue; // the app database legitimately holds message text
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function grepSentinels(files: string[], sentinels: string[]): Array<{ file: string; sentinel: string }> {
  const hits: Array<{ file: string; sentinel: string }> = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'latin1');
    } catch {
      continue;
    }
    for (const s of sentinels) if (text.includes(s)) hits.push({ file, sentinel: s });
  }
  return hits;
}

describe('the userData tree holds no sentinel after a full run', () => {
  it('logs, run/ and the databases carry metadata only', async () => {
    h = await createHarness({ rules: RULES });
    const doorbellUrl = h.app.doorbellUrl();
    const doorbellSecret = doorbellUrl === null ? null : new URL(doorbellUrl).pathname.slice('/hook/'.length);

    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - 3_600_000) });
    await h.bridge.inbound({
      chatJid: CHAT,
      text: `coffee Thursday at 5? ${SENTINEL_MSG_TEXT}`,
      pushName: SENTINEL_NAME,
    });
    await h.settle();

    const SENTINELS = [
      SENTINEL_MSG_TEXT,
      SENTINEL_NAME,
      CHAT,
      CHAT_DIGITS,
      'sk-ant-TESTONLY',
      'AIzaTESTONLY',
      HARNESS_BRIDGE_TOKEN,
      ...(doorbellSecret === null ? [] : [doorbellSecret]),
    ];

    // (a) the captured log
    const logText = h.logs.join('\n');
    for (const s of SENTINELS) expect(logText, `log line leaks ${s}`).not.toContain(s);

    // (b) the on-disk tree (logs\, run\, google\, models\, ... - everything except app.db and bridge\store)
    const hits = grepSentinels(filesToGrep(h.userData), SENTINELS);
    expect(
      hits.map((x) => `${x.file.slice(h!.userData.length + 1)} :: ${x.sentinel}`),
      'a file under userData leaks a sentinel',
    ).toEqual([]);

    // (c) the columns TESTS 8.2 names explicitly
    const audit = h.repos.db.prepare(`SELECT detail_json FROM audit_log`).all() as Array<{ detail_json: string }>;
    const queue = h.repos.db.prepare(`SELECT last_error FROM triage_queue`).all() as Array<{
      last_error: string | null;
    }>;
    const runs = h.repos.db.prepare(`SELECT error_code FROM runs`).all() as Array<{ error_code: string | null }>;
    const sqlText = JSON.stringify({ audit, queue, runs });
    for (const s of SENTINELS) expect(sqlText, `a SQL column leaks ${s}`).not.toContain(s);

    // (d) the blocked tool name appears nowhere, in any form
    const everything = [logText, sqlText, ...filesToGrep(h.userData).map((f) => readFileSync(f, 'latin1'))].join('\n');
    expect(everything).not.toContain(`delete-event-${SENTINEL_MSG_TEXT}`);
  });

  it('the diagnostics bundle is built from metadata sources only', async () => {
    h = await createHarness({ rules: RULES });
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - 3_600_000) });
    await h.bridge.inbound({
      chatJid: CHAT,
      text: `coffee Thursday at 5? ${SENTINEL_MSG_TEXT}`,
      pushName: SENTINEL_NAME,
    });
    await h.settle();

    // The export bundle is `{version, generatedAt, health, settings, counts, recovery, tsFormatBroken}` - the same
    // sources this test reads back. (The harness's save dialog always cancels, so nothing is written to disk.)
    const bundle = JSON.stringify({
      health: h.health(),
      settings: h.repos.settings.get(),
      counts: h.repos.items.counts(),
      recovery: h.app.recovery,
    });
    for (const s of [SENTINEL_MSG_TEXT, SENTINEL_NAME, CHAT, CHAT_DIGITS, HARNESS_BRIDGE_TOKEN]) {
      expect(bundle, `the diagnostics bundle leaks ${s}`).not.toContain(s);
    }
    const res = await h.invoke('diagnostics:export', undefined);
    expect(res.ok).toBe(true); // cancelled dialog -> { saved: false }, and nothing was written
  });

  it('after data:purgeNow neither app.db nor the daily backups still hold the message text', async () => {
    h = await createHarness({ rules: RULES });
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - 3_600_000) });
    // An explicit ts on the VIRTUAL clock: without one the fake bridge stamps the row from the wall clock, which sits
    // hours away from the virtual one, and a message dated in the future would fall outside every retention window by
    // accident (`purge` is `ts < before`) - which would make the purge half of this test vacuous all over again.
    await h.bridge.inbound({
      chatJid: CHAT,
      text: `coffee Thursday at 5? ${SENTINEL_MSG_TEXT}`,
      pushName: SENTINEL_NAME,
      ts: new Date(h.clock.now()),
    });
    await h.settle();

    // Retention only ever NULLs the payload of a TERMINAL action (CONTRACTS 15.2 / `trg_actions_frozen`), so reject the
    // pending approvals first - a user who presses "Delete now" with an approval still waiting keeps that one payload.
    const pending = h.repos.db.prepare(`SELECT id FROM actions WHERE state = 'pending'`).all() as Array<{ id: string }>;
    expect(pending.length, 'the run produced no pending action').toBeGreaterThan(0);
    for (const a of pending) expect((await h.invoke('action:reject', { actionId: a.id })).ok).toBe(true);

    // The daily backup timer is a whole day away in harness time, so stand in for it: without a real copy on disk the
    // "backups are clean" half of this test asserts nothing (the directory is simply empty).
    const backupsDir = h.paths.backupsDir;
    const daily = backupNow(h.repos.db, { backupsDir, now: () => h!.clock.now() });
    expect(
      grepSentinels([daily], [SENTINEL_MSG_TEXT]),
      'the daily copy was expected to carry the message text before the purge',
    ).not.toEqual([]);
    await h.advance(60_000); // the user presses "Delete now" a minute later, not in the same millisecond

    const purged = await h.invoke('data:purgeNow', { confirm: true });
    expect(purged.ok).toBe(true);

    // (a) `backups\`: every pre-purge copy is gone and the one fresh copy holds none of the purged TEXT. A backup is a
    // copy of app.db, so - exactly like app.db, which filesToGrep skips - it legitimately keeps chat metadata (the JID
    // and the contact name live in `chats` and are not retention material); the promise it must keep is about text.
    const after = readdirSync(backupsDir);
    expect(after, 'purgeNow must wipe `backups\\` and leave exactly one fresh copy').toEqual([basename(daily)]);
    const backupFiles = after.map((f) => join(backupsDir, f));
    expect(
      grepSentinels(backupFiles, [SENTINEL_MSG_TEXT, HARNESS_BRIDGE_TOKEN, 'sk-ant-TESTONLY', 'AIzaTESTONLY']),
      'a daily copy still holds the purged text',
    ).toEqual([]);

    // (b) the rest of the tree, as before (app.db, bridge\store and the database copies excepted).
    const SENTINELS = [SENTINEL_MSG_TEXT, SENTINEL_NAME, CHAT, CHAT_DIGITS, HARNESS_BRIDGE_TOKEN];
    const files = filesToGrep(h.userData).filter((f) => !f.startsWith(backupsDir + sep));
    const hits = grepSentinels(files, SENTINELS);
    expect(hits.map((x) => `${x.file.slice(h!.userData.length + 1)} :: ${x.sentinel}`)).toEqual([]);

    // (c) app.db itself, which filesToGrep deliberately skips: purgeNow runs with retentionDays = 0, so the text columns
    // are NULL even though the message is a minute old and `privacy.retentionDays` is 30.
    const texts = h.repos.db.prepare(`SELECT text FROM item_messages`).all() as Array<{ text: string | null }>;
    expect(texts.length, 'the run seeded no message snapshot to purge').toBeGreaterThan(0);
    expect(texts.map((r) => r.text)).toEqual(texts.map(() => null));
    const rest = h.repos.db
      .prepare(`SELECT draft_text, extraction_json, event_json FROM proposals`)
      .all()
      .concat(h.repos.db.prepare(`SELECT canonical_json, approved_final_json FROM actions`).all());
    expect(JSON.stringify(rest)).not.toContain(SENTINEL_MSG_TEXT);
  });
});
