// [V2] V2-W0-scaffold: at least one passing test for every Wave-0 test asset of T2 15 - the complete bodies (ogg-fixtures,
// image-fixtures, fake-bridge-db seeders, stub-llm deltas, electron mock v2) and the frozen skeletons (spawned fakes exit
// 99, typed shapes load). Owners extend or replace the matching block when their bodies land.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import * as ogg from '../fakes/ogg-fixtures.ts';
import * as img from '../fakes/image-fixtures.ts';
import { createFakeBridgeDb } from '../fakes/fake-bridge-db.ts';
import { StubLlm } from '../fakes/stub-llm.ts';
import { TOOL_SERVER_PROBE_MATRIX, rawProbe } from '../fakes/fake-mcp-client.ts';
import {
  FAKE_CLAUDE_DEFAULT_STATE,
  FAKE_CLAUDE_MODES,
  FAKE_NOT_IMPLEMENTED_EXIT,
} from '../fakes/fake-claude-cli.types.ts';
import { FAKE_AGY_MODES } from '../fakes/fake-agy.types.ts';
import { FAKE_MEDIA_SCENARIOS } from '../fakes/fake-bridge.ts';
import { dialog, nativeImage, Notification, resetElectronMock } from '../mocks/electron.ts';
import { V1_GOLDEN_FILES, GOLDEN_FILES } from '../helpers/goldenLoader.ts';

const FAKES = fileURLToPath(new URL('../fakes/', import.meta.url));

describe('ogg-fixtures (T2 3.6)', () => {
  it('oggSilence(3) is RFC 3533/7845-shaped: BOS head, tags, CRC-valid pages, exact final granule', () => {
    const bytes = ogg.oggSilence(3);
    const pages = ogg.parseOggPages(bytes);
    expect(pages.length).toBe(2 + 3);
    expect(pages.every((p) => p.crcOk)).toBe(true);
    expect(pages[0]!.headerType).toBe(0x02);
    expect(pages.at(-1)!.headerType).toBe(0x04);
    expect(pages.at(-1)!.granule).toBe(BigInt(312 + 3 * 50 * 960));
    expect(new Set(pages.map((p) => p.serial)).size).toBe(1);
    expect(pages.map((p) => p.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(Buffer.from(bytes.subarray(28, 36)).toString('latin1')).toBe('OpusHead');
  });

  it('the hostile builders break exactly one rule each', () => {
    expect(ogg.parseOggPages(ogg.badCrc()).some((p) => !p.crcOk)).toBe(true);
    expect(new Set(ogg.parseOggPages(ogg.wrongSerial()).map((p) => p.serial)).size).toBe(2);
    expect(ogg.parseOggPages(ogg.twoStreams()).filter((p) => p.headerType === 0x02)).toHaveLength(2);
    expect(ogg.parseOggPages(ogg.truncatedPage()).length).toBeLessThan(ogg.parseOggPages(ogg.oggSilence(1)).length);
    expect(ogg.parseOggPages(ogg.missingOpusTags()).length).toBe(2);
    expect(ogg.parseOggPages(ogg.hugeGranule(16)).at(-1)!.granule).toBe(BigInt(312 + 16 * 60 * 48_000));
    expect(ogg.zeroLength().length).toBe(0);
    expect(Buffer.from(ogg.id3Prefixed().subarray(0, 3)).toString('latin1')).toBe('ID3');
    expect(Buffer.from(ogg.riffWav().subarray(0, 4)).toString('latin1')).toBe('RIFF');
    const head = ogg.parseOggPages(ogg.absurdPreSkip());
    expect(head[0]!.crcOk).toBe(true);
    expect(ogg.parseOggPages(ogg.segmentTableOverflow()).length).toBe(2); // the bogus page is not walkable
  });

  it('sparse65MiB streams 65 MiB + 1 byte without materialising it', async () => {
    let total = 0;
    let largest = 0;
    for await (const chunk of ogg.sparse65MiB()) {
      total += (chunk as Buffer).length;
      largest = Math.max(largest, (chunk as Buffer).length);
    }
    expect(total).toBe(ogg.SPARSE_BYTES);
    expect(largest).toBeLessThanOrEqual(64 * 1024);
  });

  it('the silence packet decodes with the real opus-decoder (S-OPUS, U-V1): 20 ms, no errors', async () => {
    const { OpusDecoder } = await import('opus-decoder');
    const d = new OpusDecoder({ channels: 1, sampleRate: 16000, preSkip: 0 });
    await d.ready;
    const r = d.decodeFrame(ogg.OPUS_SILENCE_20MS);
    d.free();
    expect(r.errors).toEqual([]);
    expect(r.samplesDecoded).toBe(320);
  });
});

describe('image-fixtures (T2 3.6)', () => {
  it('png / jpeg carry the requested dimensions in their headers', () => {
    expect(img.pngSize(img.png(33, 17))).toEqual({ width: 33, height: 17 });
    expect(img.jpegSize(img.jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    const j = img.jpeg(64, 64);
    expect([j[j.length - 2], j[j.length - 1]]).toEqual([0xff, 0xd9]);
  });
  it('the bombs declare huge sizes in tiny files; the rest are what they claim', () => {
    expect(img.jpegSize(img.jpegBomb())).toEqual({ width: 6000, height: 4400 });
    expect(img.jpegBomb().length).toBeLessThan(1024);
    expect(img.pngSize(img.pngBomb())).toEqual({ width: 10_000, height: 10_000 });
    expect(img.truncatedJpeg().at(-1)).not.toBe(0xd9);
    expect(img.pngSize(img.pngNamedJpg().bytes)).not.toBeNull();
    expect(Buffer.from(img.gif().subarray(0, 6)).toString('latin1')).toBe('GIF89a');
    expect(Buffer.from(img.webp().subarray(8, 12)).toString('latin1')).toBe('WEBP');
    expect(img.tooBig().length).toBe(img.MAX_IMAGE_BYTES + 1);
    const poly = img.polyglot();
    expect(Buffer.from(poly).indexOf(Buffer.from('PK\x03\x04', 'latin1'))).toBeGreaterThan(0);
  });
});

describe('fake-bridge-db v2 seeders (T2 3.5)', () => {
  it('seeds media, group, status, newsletter, reaction, deleted and bulk rows like the bridge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-fbdb-'));
    const db = createFakeBridgeDb({ path: join(dir, 'messages.db') });
    try {
      const chat = '972550000001@s.whatsapp.net';
      db.seedMediaRow({ chatJid: chat, id: 'A1', mediaType: 'audio', filename: 'note.ogg' });
      db.seedMediaRow({ chatJid: chat, id: 'I1', mediaType: 'image', caption: 'flyer', fromMe: true });
      db.seedGroupRow({ chatJid: '972550000002-1600000000@g.us', id: 'G1', content: 'group row' });
      db.seedStatusRow({ id: 'S1', content: 'status row' });
      db.seedNewsletterRow({ chatJid: '972550000003@newsletter', id: 'N1', content: 'news' });
      db.seedReaction({ chatJid: chat, id: 'R1', targetId: 'I1', emoji: '+1' });
      db.seedDeleted({ chatJid: chat, id: 'D1', sender: '972550000001', content: 'gone', fromMe: false });
      const last = db.seedBulk({
        chatJid: '972550000004@s.whatsapp.net',
        rows: 500,
        startTs: Date.UTC(2026, 8, 1),
        stepMs: 60_000,
        fromMeEvery: 10,
      });
      expect(last).toBe(db.maxRowid());
      expect(() => db.seedGroupRow({ chatJid: chat, id: 'X', content: 'x' })).toThrow(/g\.us/);
    } finally {
      db.close();
    }
    const raw = new DatabaseSync(join(dir, 'messages.db'));
    try {
      const rows = raw
        .prepare(
          "SELECT id, chat_jid, media_type, filename, content, is_from_me, deleted_at IS NOT NULL AS del FROM messages WHERE id NOT LIKE 'BULK%' ORDER BY rowid",
        )
        .all() as Array<Record<string, unknown>>;
      expect(rows.map((r) => [r.id, r.media_type, r.filename])).toEqual([
        ['A1', 'audio', 'note.ogg'],
        ['I1', 'image', null],
        ['G1', '', null],
        ['S1', '', null],
        ['N1', '', null],
        ['R1', 'reaction', 'I1'],
        ['D1', '', null],
      ]);
      expect(rows.find((r) => r.id === 'S1')!.chat_jid).toBe('status@broadcast');
      expect(rows.find((r) => r.id === 'D1')!.del).toBe(1);
      expect(rows.find((r) => r.id === 'I1')!.content).toBe('flyer');
      const bulk = raw
        .prepare("SELECT COUNT(*) AS n, SUM(is_from_me) AS me FROM messages WHERE id LIKE 'BULK%'")
        .get() as { n: number; me: number };
      expect(bulk).toEqual({ n: 500, me: 50 });
    } finally {
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stub-llm v2 deltas (T2 3.9)', () => {
  it('matches when.stage against the purpose and writes the CLI fake script with stage defaults', async () => {
    const stub = new StubLlm({
      id: 'claude_cli',
      rules: [
        { when: { stage: 'read_image' }, respond: { structured: { readable: false } } },
        { when: { purpose: 'extract' }, respond: { structured: { intent: 'smalltalk' } } },
      ],
    });
    expect(stub.id).toBe('claude_cli');
    const ac = new AbortController();
    const out = await stub.structured([{ role: 'user', content: 'x' }], { type: 'object' } as never, {
      purpose: 'read_image',
      maxOutputTokens: 10,
      signal: ac.signal,
    });
    expect(out).toEqual({ readable: false });
    const dir = mkdtempSync(join(tmpdir(), 'wca-stub-'));
    try {
      const file = join(dir, 'script.json');
      stub.toCliScript(file);
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        id: string;
        rules: Array<{ when: { stage?: string } }>;
      };
      expect(parsed.id).toBe('claude_cli');
      expect(parsed.rules.map((r) => r.when.stage)).toEqual(['read_image', 'extract']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('electron mock v2 (T2 3.10)', () => {
  it('showMessageBox plays a FIFO script, records the real options, and answers Cancel when exhausted', async () => {
    resetElectronMock();
    dialog.__script([{ response: 1, checkboxChecked: true }]);
    const win = { id: 7 };
    expect(await dialog.showMessageBox(win, { buttons: ['Cancel', 'Turn on'], cancelId: 0 })).toEqual({
      response: 1,
      checkboxChecked: true,
    });
    expect(await dialog.showMessageBox(win, { buttons: ['Cancel', 'Turn on'], cancelId: 0 })).toEqual({
      response: 0,
      checkboxChecked: false,
    });
    expect(dialog.messageBoxes.map((m) => m.parentWindowId)).toEqual([7, 7]);
    resetElectronMock();
  });
  it('Notification records actions and lets a test activate one; nativeImage is deterministic and spied', () => {
    resetElectronMock();
    const n = new Notification({ title: 't', body: 'b', actions: [{ type: 'button', text: 'Undo' }] });
    let got = -1;
    n.on('action', (_e: unknown, i: number) => {
      got = i;
    });
    n.show();
    expect(Notification.shown).toEqual([{ title: 't', body: 'b', actions: ['Undo'] }]);
    Notification.__emitAction(0, 0);
    expect(got).toBe(0);
    const image = nativeImage.createFromBuffer(Buffer.from(img.png(400, 200)));
    expect(image.getSize()).toEqual({ width: 400, height: 200 });
    expect(image.resize({ width: 200 }).getSize()).toEqual({ width: 200, height: 100 });
    expect(nativeImage.createFromBufferCalls).toBe(1);
    resetElectronMock();
  });
});

describe('frozen skeletons load', () => {
  it('the spawned fakes exit 99 "not implemented" until their owners land them', () => {
    // [V2-W1-07] whisper-cli.mjs is implemented (its own block below)
    // [V2-W1-06] fake-claude-cli.mjs is implemented (tests/security/cli.sandbox.test.ts, tests/integration/cli-provider.test.ts)
    // [V2-W1-09] fake-agy.mjs is implemented (tests/security/agy.sandbox.test.ts, tests/integration/agy-provider.test.ts) - all three
    // spawned fakes have landed, so this loop is empty; V2-W2-01 may delete the test.
    for (const f of [] as string[]) {
      const r = spawnSync(process.execPath, [join(FAKES, f), '--fake-journal', 'x', '--fake-end', '-p'], {
        encoding: 'utf8',
      });
      expect(r.status, f).toBe(FAKE_NOT_IMPLEMENTED_EXIT);
      expect(r.stderr).toMatch(/not implemented/);
    }
  });
  it('typed shapes and data tables are importable', async () => {
    expect(FAKE_CLAUDE_DEFAULT_STATE.version).toBe('2.1.258');
    expect(FAKE_CLAUDE_MODES).toContain('is_error_success');
    expect(FAKE_AGY_MODES).toContain('global_mcp_present');
    expect(FAKE_MEDIA_SCENARIOS).toContain('wrong_bytes');
    expect(TOOL_SERVER_PROBE_MATRIX.filter((r) => r.expect === 405).map((r) => r.id)).toEqual([
      'get_authenticated',
      'delete_authenticated',
    ]);
    expect(TOOL_SERVER_PROBE_MATRIX.some((r) => (r.expect as unknown) === 401 || (r.expect as unknown) === 403)).toBe(
      false,
    );
    // [V2-W1-05] rawProbe is implemented: nothing listens on 127.0.0.1:1, so the probe reports 'refused'
    await expect(rawProbe(1, 't', {})).resolves.toMatchObject({ status: 'refused' });
    expect(GOLDEN_FILES).toEqual([...V1_GOLDEN_FILES, 'edits', 'images', 'voice']);
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] FAKE WHISPER (T2 3.3) - V2-W1-07-media-voice
// ---------------------------------------------------------------------------------------------------------------------
describe('whisper-cli.mjs fake (T2 3.3)', () => {
  function layout(seconds: number): {
    root: string;
    tmp: string;
    wav: string;
    of: string;
    model: string;
    vad: string;
    journal: string;
    tx: string;
  } {
    const root = mkdtempSync(join(tmpdir(), 'wca-whisper-'));
    const tmp = join(root, 'userData', 'voice', 'tmp');
    mkdirSync(tmp, { recursive: true });
    const jobId = 'job-0001';
    const wav = join(tmp, `${jobId}.wav`);
    const data = Math.round(seconds * 32_000);
    const buf = Buffer.alloc(44 + data);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(36 + data, 4);
    buf.write('WAVEfmt ', 8, 'latin1');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16_000, 24);
    buf.writeUInt32LE(32_000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'latin1');
    buf.writeUInt32LE(data, 40);
    writeFileSync(wav, buf);
    const model = join(root, 'ggml-model.bin');
    const vad = join(root, 'ggml-silero.bin');
    writeFileSync(model, Buffer.from([0x6c, 0x6d, 0x67, 0x67, 1, 2]));
    writeFileSync(vad, Buffer.from([0x6c, 0x6d, 0x67, 0x67, 3]));
    const tx = join(root, 'transcripts.json');
    writeFileSync(
      tx,
      JSON.stringify({
        byDuration: { '3.0': { language: 'he', text: 'SENTINEL_TRANSCRIPT ביום רביעי בחמש' } },
        default: { language: 'en', text: 'default' },
      }),
    );
    return { root, tmp, wav, of: join(tmp, jobId), model, vad, journal: join(root, 'journal.ndjson'), tx };
  }
  const argvOf = (l: ReturnType<typeof layout>, lang: 'he' | 'auto' = 'he', threads = 6): string[] => [
    '-m',
    l.model,
    '-f',
    l.wav,
    '-l',
    lang,
    '-t',
    String(threads),
    '-oj',
    '-of',
    l.of,
    '-np',
    '-nt',
    '--vad',
    '--vad-model',
    l.vad,
    '--vad-threshold',
    '0.5',
    '--vad-min-silence-duration-ms',
    '400',
    '--vad-speech-pad-ms',
    '60',
    '--vad-max-speech-duration-s',
    '30',
    '-bs',
    '5',
    '-bo',
    '5',
    '-tp',
    '0',
    '-et',
    '2.4',
    '-sns',
  ];
  const ENV = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', NUMBER_OF_PROCESSORS: '8' };
  const journalOf = (l: ReturnType<typeof layout>): Array<Record<string, unknown>> =>
    readFileSync(l.journal, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('spawned with node.exe: a clean run writes <of>.json by duration, journals no violation, prints the stdout/stderr sentinels', () => {
    const l = layout(3);
    try {
      const r = spawnSync(
        process.execPath,
        [
          join(FAKES, 'whisper-cli.mjs'),
          '--fake-journal',
          l.journal,
          '--fake-mode',
          'ok',
          '--fake-transcripts',
          l.tx,
          '--fake-cores',
          '8',
          '--fake-end',
          ...argvOf(l),
        ],
        { cwd: FAKES, env: ENV, encoding: 'utf8', windowsHide: true },
      );
      expect(r.status).toBe(0);
      const out = JSON.parse(readFileSync(`${l.of}.json`, 'utf8')) as {
        result: { language: string };
        transcription: Array<{ text: string }>;
      };
      expect(out.result.language).toBe('he');
      expect(
        out.transcription
          .map((t) => t.text)
          .join('')
          .trim(),
      ).toBe('SENTINEL_TRANSCRIPT ביום רביעי בחמש');
      expect(r.stdout).toContain('SENTINEL_TRANSCRIPT_STDOUT');
      expect(r.stderr).toContain('SENTINEL_WHISPER_STDERR');
      const [entry] = journalOf(l);
      expect(entry?.violations).toEqual([]);
      expect(entry?.threads).toBe(6);
      expect(entry?.modelMagicOk).toBe(true);
      expect((entry?.wav as { seconds: number }).seconds).toBe(3);
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  });

  it('in-process: modes, argv / env / cwd / input violations', async () => {
    const fake = (await import('../fakes/whisper-cli.mjs')) as {
      main(argv: string[], env: Record<string, string>, cwd: string, selfPath: string, io: unknown): Promise<number>;
      checkArgv(a: string[]): { violations: string[]; unknown: string | null };
      INJECTION_TRANSCRIPT: string;
    };
    const self = join(FAKES, 'whisper-cli.mjs');
    const SINK = { stdout: { write: () => true }, stderr: { write: () => true } };
    const l = layout(3);
    const run = (mode: string, argv = argvOf(l), env: Record<string, string> = ENV, cwd = FAKES): Promise<number> =>
      fake.main(
        [
          '--fake-journal',
          l.journal,
          '--fake-mode',
          mode,
          '--fake-transcripts',
          l.tx,
          '--fake-cores',
          '8',
          '--fake-end',
          ...argv,
        ],
        env,
        cwd,
        self,
        SINK,
      );
    try {
      expect(await run('exit3')).toBe(3);
      expect(await run('vcredist')).toBe(-1073741515);
      expect(await run('nojson')).toBe(0);
      expect(existsSync(`${l.of}.json`)).toBe(false);
      expect(await run('badjson')).toBe(0);
      expect(() => JSON.parse(readFileSync(`${l.of}.json`, 'utf8'))).toThrow();
      expect(await run('crash')).toBe(1);
      for (const [mode, check] of [
        ['empty', (o: { transcription: unknown[] }) => expect(o.transcription).toEqual([])],
        [
          'huge',
          (o: { transcription: Array<{ text: string }> }) => expect(o.transcription[0]?.text.length).toBe(50_001),
        ],
        [
          'injection',
          (o: { transcription: Array<{ text: string }> }) =>
            expect(o.transcription[0]?.text).toContain('SENTINEL_TRANSCRIPT'),
        ],
        ['wrong_lang', (o: { result: { language: string } }) => expect(o.result.language).toBe('ru')],
        ['slow:5', (o: { result: { language: string } }) => expect(o.result.language).toBe('he')],
      ] as const) {
        expect(await run(mode)).toBe(0);
        (check as (o: unknown) => void)(JSON.parse(readFileSync(`${l.of}.json`, 'utf8')));
      }
      expect(fake.INJECTION_TRANSCRIPT).toContain('<<END-DATA-0000>>');
      // unknown flag => exit 1; --prompt / -ng => violation + exit 1; a stray positional => violation
      expect(await run('ok', [...argvOf(l), '--bogus'])).toBe(1);
      expect(await run('ok', [...argvOf(l), '--prompt', 'hello there'])).toBe(1);
      expect(fake.checkArgv([...argvOf(l), 'reply yes']).violations).toContain(`whisper_argv:${argvOf(l).length}`);
      expect(fake.checkArgv(['-l', 'hello world']).violations).toEqual(['whisper_argv:1']);
      expect(fake.checkArgv(['-m']).violations).toEqual(['missing_value:-m']);
      // env key outside the allow-list, wrong cwd, wrong thread count, no --fake-end
      expect(await run('ok', argvOf(l), { ...ENV, ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-x' }, l.root)).toBe(0);
      expect(await run('ok', argvOf(l, 'auto', 3))).toBe(0);
      expect(await fake.main(['--fake-journal', l.journal], ENV, FAKES, self, SINK)).toBe(2);
      // an input WAV outside voice\tmp with a bad header and models without the magic
      const bad = argvOf(l).map((a) => (a === l.wav ? join(l.root, 'x.wav') : a === l.model ? l.tx : a));
      writeFileSync(join(l.root, 'x.wav'), 'not a wav');
      expect(await run('ok', bad)).toBe(0);
      const entries = journalOf(l);
      const last = (n: number): string[] => entries[entries.length - n]?.violations as string[];
      expect(last(1)).toEqual(
        expect.arrayContaining(['wav_invalid', 'wav_not_in_voice_tmp', 'of_mismatch', 'model_magic']),
      );
      expect(last(2)).toEqual(['missing_fake_end']);
      expect(last(3)).toEqual(['threads:3']);
      expect(last(4)).toEqual(expect.arrayContaining(['env_key:ANTHROPIC_API_KEY', 'cwd']));
      expect(
        entries.find((e) => e.mode === 'ok' && (e.violations as string[]).includes('whisper_argv:33')),
      ).toBeDefined();
    } finally {
      rmSync(l.root, { recursive: true, force: true });
    }
  });
});
