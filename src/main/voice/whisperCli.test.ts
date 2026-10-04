// src/main/voice/whisperCli.test.ts - owner V2-W1-07-media-voice. T2 5: buildWhisperArgs literal per tier (-l he / -l auto), threads
// formula, no --prompt / -ng, timeout clamp (F33), exit-code mapping (3, -1073741515 signed + unsigned, no JSON), env = the llama
// allow-list literally, stdout ignored, BELOW_NORMAL, the -oj file and the WAV deleted in finally. The job itself is the real fake
// whisper (tests/fakes/whisper-cli.mjs) run in-process behind a JobRunner double (W1-06's JobRunner is exercised at L3).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../shared/types';
import { JobBreakerOpenError, WHISPER_ENV_KEYS, type JobRunner, type JobSpec } from '../proc/jobRunner';
import {
  buildWhisperArgs,
  buildWhisperEnv,
  createWhisperRunner,
  outBaseOf,
  VCREDIST_EXIT_CODES,
  whisperThreads,
  whisperTimeoutMs,
  WhisperJobError,
  WHISPER_JSON_MAX_BYTES,
} from './whisperCli';
import { encodeWavPcm16 } from './wav';

const FAKES = fileURLToPath(new URL('../../../tests/fakes/', import.meta.url));
const FAKE_SELF = join(FAKES, 'whisper-cli.mjs');
const SINK = { stdout: { write: () => true }, stderr: { write: () => true } };
type FakeMain = (
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  self: string,
  io: unknown,
) => Promise<number>;

describe('buildWhisperArgs (C2 13 binding literal)', () => {
  it('is exactly the B18 argv, per language', () => {
    for (const lang of ['he', 'auto'] as const) {
      expect(buildWhisperArgs({ model: 'M', wav: 'W', vad: 'V', lang, outBase: 'O', threads: 6 })).toEqual([
        '-m',
        'M',
        '-f',
        'W',
        '-l',
        lang,
        '-t',
        '6',
        '-oj',
        '-of',
        'O',
        '-np',
        '-nt',
        '--vad',
        '--vad-model',
        'V',
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
      ]);
    }
    const args = buildWhisperArgs({ model: 'M', wav: 'W', vad: 'V', lang: 'he', outBase: 'O', threads: 2 });
    expect(args).not.toContain('--prompt');
    expect(args).not.toContain('-ng');
  });

  it('threads = max(2, min(8, cores - 2)); an explicit setting wins', () => {
    expect([1, 2, 4, 5, 8, 10, 11, 28].map((c) => whisperThreads(c))).toEqual([2, 2, 2, 3, 6, 8, 8, 8]);
    expect(whisperThreads(Number.NaN)).toBe(2);
    expect(whisperThreads(28, 12)).toBe(12);
  });

  it('timeout = clamp(30 s, 4 x seconds x benchFactor, 300 s)', () => {
    expect(whisperTimeoutMs(1, 1)).toBe(30_000);
    expect(whisperTimeoutMs(10, 1)).toBe(40_000);
    expect(whisperTimeoutMs(60, 0.5)).toBe(120_000);
    expect(whisperTimeoutMs(900, 1)).toBe(300_000);
    expect(whisperTimeoutMs(10, Number.POSITIVE_INFINITY)).toBe(LIMITS.voiceJobMaxMs);
    expect([LIMITS.voiceJobMinMs, LIMITS.voiceJobMaxMs]).toEqual([30_000, 300_000]);
  });

  it('env = the llama allow-list literally, values by name only; never any other key', () => {
    const source = {
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      TEMP: 'C:\\t',
      TMP: 'C:\\t',
      NUMBER_OF_PROCESSORS: '8',
      PATH: 'C:\\x',
      ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-1',
      WHATSAPP_BRIDGE_TOKEN: 'x',
      NODE_OPTIONS: '--inspect',
      EMPTY: '',
    };
    const env = buildWhisperEnv(source);
    expect(Object.keys(env).sort()).toEqual([...WHISPER_ENV_KEYS].sort());
    expect(buildWhisperEnv({ SystemRoot: '', TEMP: undefined })).toEqual({});
  });

  it('outBase = the WAV path without .wav', () => {
    expect(outBaseOf('C:\\u\\voice\\tmp\\job-1.wav')).toBe('C:\\u\\voice\\tmp\\job-1');
    expect(outBaseOf('C:\\u\\voice\\tmp\\job-1.WAV')).toBe('C:\\u\\voice\\tmp\\job-1');
    expect(outBaseOf('C:\\u\\job')).toBe('C:\\u\\job');
  });
});

describe('createWhisperRunner over a JobRunner double running the fake whisper', () => {
  let root: string;
  let tmp: string;
  let model: string;
  let vad: string;
  let tx: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wca-wcli-'));
    tmp = join(root, 'voice', 'tmp');
    mkdirSync(tmp, { recursive: true });
    model = join(root, 'ggml-model.bin');
    vad = join(root, 'ggml-silero.bin');
    writeFileSync(model, Buffer.from([0x6c, 0x6d, 0x67, 0x67]));
    writeFileSync(vad, Buffer.from([0x6c, 0x6d, 0x67, 0x67]));
    tx = join(root, 'tx.json');
    writeFileSync(
      tx,
      JSON.stringify({ byDuration: { '2.0': { language: 'he', text: 'SENTINEL_TRANSCRIPT מחר בשש' } } }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const wav = (seconds: number, name = 'job-abc'): string => {
    const p = join(tmp, `${name}.wav`);
    writeFileSync(p, encodeWavPcm16(new Float32Array(Math.round(seconds * 16_000)), 16_000));
    return p;
  };
  /** A JobRunner double: records the spec, runs the fake's main() in-process with the prefix + production argv. */
  function jobsWith(
    mode: string,
    over: Partial<{ timedOut: boolean; killed: boolean; exit: number | null; throws: Error }> = {},
  ) {
    const specs: JobSpec[] = [];
    const jobs: JobRunner = {
      run: vi.fn(async (spec: JobSpec, use, signal: AbortSignal) => {
        specs.push(spec);
        if (over.throws) throw over.throws;
        const fake = (await import('../../../tests/fakes/whisper-cli.mjs')) as { main: FakeMain };
        const code = await fake.main(
          ['--fake-mode', mode, '--fake-transcripts', tx, '--fake-cores', '8', '--fake-end', ...spec.args],
          spec.env,
          spec.cwd,
          FAKE_SELF,
          SINK,
        );
        const done = Promise.resolve({
          exitCode: over.exit !== undefined ? over.exit : code,
          killed: over.killed ?? false,
          timedOut: over.timedOut ?? false,
          stderrMarkers: [],
          ms: 42,
        });
        void signal;
        return use({ pid: 1234, lines: async function* () {}, write: () => undefined, kill: () => undefined, done });
      }) as JobRunner['run'],
      breaker: () => ({ open: false, failures: 0, openedAt: null }),
      resetBreaker: () => undefined,
      killAll: async () => undefined,
      jobPids: () => ({ cli: [], voice: [] }),
    };
    return { jobs, specs };
  }
  const runner = (jobs: JobRunner, bench = 1) =>
    createWhisperRunner({
      jobs,
      whisperCliExe: 'C:\\res\\whisper\\whisper-cli.exe',
      binDir: FAKES,
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\leak' },
      benchFactor: () => bench,
    });
  const input = (w: string, seconds = 2) => ({
    wavPath: w,
    modelPath: model,
    vadPath: vad,
    language: 'he' as const,
    seconds,
    threads: 6,
  });
  const live = (): AbortSignal => new AbortController().signal;

  it('ok: the transcript comes from the -oj file only; the spec is kind voice, stdout ignored, BELOW_NORMAL, env allow-listed; files deleted', async () => {
    const { jobs, specs } = jobsWith('ok');
    const w = wav(2);
    const r = await runner(jobs, 2).transcribe(input(w), live());
    expect(r).toEqual({ text: ' SENTINEL_TRANSCRIPT מחר בשש', language: 'he', wallMs: 42 });
    const spec = specs[0] as JobSpec;
    expect(spec.kind).toBe('voice');
    expect(spec.exePath).toBe('C:\\res\\whisper\\whisper-cli.exe');
    expect(spec.stdout).toBe('ignore');
    expect(spec.stdin).toBeNull();
    expect(spec.belowNormal).toBe(true);
    expect(spec.cwd).toBe(FAKES);
    expect(spec.graceMs).toBe(LIMITS.voiceKillGraceMs);
    expect(spec.wallClockMs).toBe(30_000); // 4 x 2 s x 2 = 16 s -> clamped up to 30 s
    expect(spec.env).toEqual({ SystemRoot: 'C:\\Windows' });
    expect(spec.args).toEqual(buildWhisperArgs({ model, wav: w, vad, lang: 'he', outBase: outBaseOf(w), threads: 6 }));
    expect(spec.args.join(' ')).not.toContain('SENTINEL');
    expect(existsSync(w)).toBe(false);
    expect(existsSync(`${outBaseOf(w)}.json`)).toBe(false);
  });

  it('argsPrefix (WCA_WHISPER_CMD seam) goes in front of the production argv', async () => {
    const { jobs, specs } = jobsWith('ok');
    const r = createWhisperRunner({
      jobs,
      whisperCliExe: process.execPath,
      binDir: FAKES,
      env: {},
      benchFactor: () => 1,
      argsPrefix: [FAKE_SELF, '--fake-end'],
    });
    await expect(r.transcribe(input(wav(2)), live())).rejects.toBeDefined(); // the double feeds the prefix to main() as argv
    expect(specs[0]?.args.slice(0, 2)).toEqual([FAKE_SELF, '--fake-end']);
  });

  it.each<[string, Partial<{ timedOut: boolean; killed: boolean; exit: number | null }>, string]>([
    ['exit3', {}, 'VOICE_MODEL_MISSING'],
    ['vcredist', { exit: VCREDIST_EXIT_CODES[0] }, 'LLM_VCREDIST_MISSING'],
    ['vcredist', { exit: VCREDIST_EXIT_CODES[1] }, 'LLM_VCREDIST_MISSING'],
    ['nojson', {}, 'VOICE_DECODE_FAILED'],
    ['badjson', {}, 'VOICE_DECODE_FAILED'],
    ['crash', {}, 'VOICE_LOCAL_FAILED'],
    ['ok', { timedOut: true }, 'VOICE_TIMEOUT'],
    ['ok', { killed: true }, 'VOICE_LOCAL_FAILED'],
    ['ok', { exit: null }, 'VOICE_LOCAL_FAILED'],
  ])('mode %s %j => %s, WAV and JSON deleted', async (mode, over, code) => {
    const { jobs } = jobsWith(mode, over);
    const w = wav(2);
    await expect(runner(jobs).transcribe(input(w), live())).rejects.toMatchObject({ code });
    expect(existsSync(w)).toBe(false);
    expect(existsSync(`${outBaseOf(w)}.json`)).toBe(false);
  });

  it('empty and huge transcripts are returned as-is (the service caps and classifies them)', async () => {
    await expect(runner(jobsWith('empty').jobs).transcribe(input(wav(2)), live())).resolves.toMatchObject({ text: '' });
    const huge = await runner(jobsWith('huge').jobs).transcribe(input(wav(2)), live());
    expect(huge.text.length).toBe(50_001);
  });

  it('a JSON file above 1 MiB or of the wrong shape => VOICE_DECODE_FAILED', async () => {
    for (const body of ['x'.repeat(WHISPER_JSON_MAX_BYTES + 1), JSON.stringify({ transcription: 'nope' })]) {
      const w = wav(2);
      const jobs: JobRunner = {
        ...jobsWith('ok').jobs,
        run: (async (_spec: JobSpec, use: Parameters<JobRunner['run']>[1]) => {
          writeFileSync(`${outBaseOf(w)}.json`, body);
          return use({
            pid: 1,
            lines: async function* () {},
            write: () => undefined,
            kill: () => undefined,
            done: Promise.resolve({ exitCode: 0, killed: false, timedOut: false, stderrMarkers: [], ms: 1 }),
          });
        }) as JobRunner['run'],
      };
      await expect(runner(jobs).transcribe(input(w), live())).rejects.toMatchObject({ code: 'VOICE_DECODE_FAILED' });
    }
  });

  it('breaker open / spawn failure => VOICE_LOCAL_FAILED; abort => the abort reason, never a WhisperJobError', async () => {
    const breaker = jobsWith('ok', { throws: new JobBreakerOpenError('VOICE_LOCAL_FAILED') });
    await expect(runner(breaker.jobs).transcribe(input(wav(2)), live())).rejects.toMatchObject({
      code: 'VOICE_LOCAL_FAILED',
    });
    const pre = new AbortController();
    pre.abort(new Error('paused'));
    await expect(runner(jobsWith('ok').jobs).transcribe(input(wav(2)), pre.signal)).rejects.toThrow('paused');
    const bare = new AbortController();
    bare.abort('x');
    await expect(runner(jobsWith('ok').jobs).transcribe(input(wav(2)), bare.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    const during = new AbortController();
    const killed = jobsWith('ok', { throws: new Error('killed') });
    (killed.jobs.run as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      during.abort(new Error('quit'));
      throw new Error('killed');
    });
    await expect(runner(killed.jobs).transcribe(input(wav(2)), during.signal)).rejects.toThrow('quit');
    const after = new AbortController();
    const late = jobsWith('ok');
    const inner = late.jobs.run;
    late.jobs.run = (async (spec: JobSpec, use: Parameters<JobRunner['run']>[1], signal: AbortSignal) => {
      const r = await inner(spec, use, signal);
      after.abort(new Error('late'));
      return r;
    }) as JobRunner['run'];
    await expect(runner(late.jobs).transcribe(input(wav(2)), after.signal)).rejects.toThrow('late');
    expect(new WhisperJobError('VOICE_TIMEOUT').message).toBe('whisper_job:VOICE_TIMEOUT');
  });
});
