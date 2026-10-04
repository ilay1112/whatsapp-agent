// src/main/voice/whisperCli.ts   ADD (C2 13) - owner V2-W1-07-media-voice.
// One whisper-cli.exe JOB per note, spawned through V2-W1-06's JobRunner (kind 'voice'): argv of ARCH-v2 B18 (paths + numbers + fixed
// flags only - never message text, B26), env = the llama allow-list (WHISPER_ENV_KEYS, never process.env wholesale), cwd = the bin dir,
// stdout IGNORED (it carries the transcript; B26), BELOW_NORMAL priority, timeout clamp(30 s, 4 x seconds x benchFactor, 300 s) (F33).
// The transcript is read ONLY from the -oj file (<outBase>.json, 1 MiB cap, zod), which is deleted together with the WAV in `finally`.
import { readFile, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import { LIMITS } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import { WHISPER_ENV_KEYS, type JobRunner, type JobSpec } from '../proc/jobRunner';

/** voice/whisperCli.ts - one JOB per note (B2): argv of ARCH-v2 B18 (no --prompt, no -ng), env = the llama allow-list, cwd = bin dir,
 *  stdio ['ignore','ignore','pipe'] (stdout carries the transcript and is NEVER read), BELOW_NORMAL, timeout clamp(30 s, 4 x s x benchFactor, 300 s) (F33),
 *  kill = taskkill /PID /T /F after 3 s. Exit 3 => VOICE_MODEL_MISSING ; -1073741515 => LLM_VCREDIST_MISSING ; no JSON => VOICE_DECODE_FAILED ;
 *  timeout => VOICE_TIMEOUT ; signal => aborted. The -oj file is parsed with zod, then deleted with the WAV in finally. */
export interface WhisperRunner {
  transcribe(
    input: {
      wavPath: string;
      modelPath: string;
      vadPath: string;
      language: 'he' | 'auto';
      seconds: number;
      threads: number;
    },
    signal: AbortSignal,
  ): Promise<{ text: string; language: string | null; wallMs: number }>;
}

/** C2 13 binding literal (ARCH-v2 B18). */
export function buildWhisperArgs(i: {
  model: string;
  wav: string;
  vad: string;
  lang: 'he' | 'auto';
  outBase: string;
  threads: number;
}): string[] {
  return [
    '-m',
    i.model,
    '-f',
    i.wav,
    '-l',
    i.lang,
    '-t',
    String(i.threads),
    '-oj',
    '-of',
    i.outBase,
    '-np',
    '-nt',
    '--vad',
    '--vad-model',
    i.vad,
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
}

/** B18: `threads = max(2, min(8, cores - 2))` for settings.voice.threads = 'auto'; an explicit setting (1..16) wins. */
export function whisperThreads(cores: number, setting: 'auto' | number = 'auto'): number {
  if (setting !== 'auto') return setting;
  const c = Number.isFinite(cores) ? Math.trunc(cores) : 0;
  return Math.max(2, Math.min(8, c - 2));
}

/** F33: job timeout = clamp(30 s, 4 x seconds x benchFactor, 300 s). */
export function whisperTimeoutMs(seconds: number, benchFactor: number): number {
  const raw = 4 * seconds * benchFactor * 1000;
  if (!Number.isFinite(raw)) return LIMITS.voiceJobMaxMs;
  return Math.min(LIMITS.voiceJobMaxMs, Math.max(LIMITS.voiceJobMinMs, Math.ceil(raw)));
}

/** The llama allow-list (C2 13 WHISPER_ENV_KEYS), values copied BY NAME from the given environment; nothing else ever. */
export function buildWhisperEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WHISPER_ENV_KEYS) {
    const v = source[key];
    if (typeof v === 'string' && v !== '') env[key] = v;
  }
  return env;
}

/** Windows STATUS_DLL_NOT_FOUND (0xC0000135) as a signed and an unsigned exit code (v1 llama rule). */
export const VCREDIST_EXIT_CODES = [-1073741515, 3221225781] as const;
/** B18: whisper-cli exits 3 when it cannot load the model. */
export const MODEL_MISSING_EXIT_CODE = 3;
/** The -oj file is read with this cap (P2 3.2 step 4). */
export const WHISPER_JSON_MAX_BYTES = 1024 * 1024;

export type WhisperErrorCode = Extract<
  ErrorCode,
  'VOICE_MODEL_MISSING' | 'LLM_VCREDIST_MISSING' | 'VOICE_DECODE_FAILED' | 'VOICE_TIMEOUT' | 'VOICE_LOCAL_FAILED'
>;
/** A whisper job that ended without a transcript. Carries an ErrorCode only - never stderr, never text. */
export class WhisperJobError extends Error {
  constructor(readonly code: WhisperErrorCode) {
    super(`whisper_job:${code}`);
  }
}

/** Only these two fields of the -oj JSON are ever read (P2 3.2 step 4); everything else whisper writes is ignored. */
const WhisperJsonSchema = z.object({
  result: z
    .object({ language: z.string().max(16).optional() })
    .partial()
    .optional(),
  transcription: z.array(z.object({ text: z.string() })).max(100_000),
});

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
}

/** Temp files go in `finally`; a file Windows still holds open is swept later by the voice tmp purge. */
async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // never mask the job outcome
  }
}

/** `<tmp>\<jobId>.wav` -> `<tmp>\<jobId>` (the -of base; whisper appends .json). */
export function outBaseOf(wavPath: string): string {
  return wavPath.toLowerCase().endsWith('.wav') ? wavPath.slice(0, -4) : wavPath;
}

async function readTranscriptJson(path: string): Promise<{ text: string; language: string | null }> {
  let raw: string;
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > WHISPER_JSON_MAX_BYTES) throw new WhisperJobError('VOICE_DECODE_FAILED');
    raw = await readFile(path, 'utf8');
  } catch {
    throw new WhisperJobError('VOICE_DECODE_FAILED');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new WhisperJobError('VOICE_DECODE_FAILED');
  }
  const parsed = WhisperJsonSchema.safeParse(json);
  if (!parsed.success) throw new WhisperJobError('VOICE_DECODE_FAILED');
  const text = parsed.data.transcription.map((t) => t.text).join('');
  return { text, language: parsed.data.result?.language ?? null };
}

/** [W0 seam] Factory of the whisper runner over V2-W1-06's JobRunner (kind 'voice'); v2-wave0-seams.md.
 *  [V2-W1-07 refinement, REQUESTS -> orchestrator/W2-01] optional `argsPrefix`: the WCA_WHISPER_CMD seam (T2 4.1) spawns
 *  `node.exe <tests/fakes/whisper-cli.mjs> --fake-... --fake-end` + the production argv; production passes nothing. */
export function createWhisperRunner(deps: {
  jobs: import('../proc/jobRunner').JobRunner;
  whisperCliExe: string;
  binDir: string;
  env: Record<string, string>;
  benchFactor: () => number;
  argsPrefix?: readonly string[];
}): WhisperRunner {
  const jobs: JobRunner = deps.jobs;
  const env = buildWhisperEnv(deps.env);
  return {
    async transcribe(input, signal) {
      if (signal.aborted) throw abortError(signal);
      const outBase = outBaseOf(input.wavPath);
      const jsonPath = `${outBase}.json`;
      const spec: JobSpec = {
        kind: 'voice',
        exePath: deps.whisperCliExe,
        args: [
          ...(deps.argsPrefix ?? []),
          ...buildWhisperArgs({
            model: input.modelPath,
            wav: input.wavPath,
            vad: input.vadPath,
            lang: input.language,
            outBase,
            threads: input.threads,
          }),
        ],
        env,
        cwd: deps.binDir,
        stdin: null,
        stdout: 'ignore',
        wallClockMs: whisperTimeoutMs(input.seconds, deps.benchFactor()),
        graceMs: LIMITS.voiceKillGraceMs,
        belowNormal: true,
      };
      try {
        let done: Awaited<import('../proc/jobRunner').JobHandle['done']>;
        try {
          done = await jobs.run(spec, (job) => job.done, signal);
        } catch {
          if (signal.aborted) throw abortError(signal);
          // JobBreakerOpenError (5 failures / 10 min) or a spawn failure: the health line VOICE_LOCAL_FAILED; never a retry here
          throw new WhisperJobError('VOICE_LOCAL_FAILED');
        }
        if (signal.aborted) throw abortError(signal);
        if (done.timedOut) throw new WhisperJobError('VOICE_TIMEOUT');
        const code = done.exitCode;
        if (code === MODEL_MISSING_EXIT_CODE) throw new WhisperJobError('VOICE_MODEL_MISSING');
        if (code !== null && (VCREDIST_EXIT_CODES as readonly number[]).includes(code))
          throw new WhisperJobError('LLM_VCREDIST_MISSING');
        if (code !== 0 || done.killed) throw new WhisperJobError('VOICE_LOCAL_FAILED');
        const out = await readTranscriptJson(jsonPath);
        return { text: out.text, language: out.language, wallMs: done.ms };
      } finally {
        await removeQuietly(jsonPath);
        await removeQuietly(input.wavPath);
      }
    },
  };
}
