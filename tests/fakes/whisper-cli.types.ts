// tests/fakes/whisper-cli.types.ts - [V2] flag / journal shape of the fake whisper (T2 3.3). Wave 0 (V2-W0-scaffold);
// owner V2-W1-07-media-voice. Types only: whisper-cli.mjs is plain ESM.

export const WHISPER_FAKE_FLAGS = [
  '-m',
  '-f',
  '-l',
  '-t',
  '-oj',
  '-of',
  '-np',
  '-nt',
  '--vad',
  '--vad-model',
  '--vad-threshold',
  '--vad-min-silence-duration-ms',
  '--vad-speech-pad-ms',
  '--vad-max-speech-duration-s',
  '-bs',
  '-bo',
  '-tp',
  '-et',
  '-sns',
] as const;
export type WhisperFakeFlag = (typeof WHISPER_FAKE_FLAGS)[number];
/** `--fake-mode`; `slow:<ms>` delays the answer (virtual clock in L3). */
export type WhisperFakeMode =
  | 'ok'
  | 'empty'
  | `slow:${number}`
  | 'hang'
  | 'exit3'
  | 'nojson'
  | 'badjson'
  | 'crash'
  | 'vcredist'
  | 'huge'
  | 'injection'
  | 'wrong_lang';
/** `--fake-transcripts` file. Keys of byDuration are seconds with one decimal ("3.0"). */
export interface WhisperFakeTranscripts {
  byDuration: Record<string, { language: string; text: string }>;
  default?: { language: string; text: string };
}
export interface WhisperFakeJournalEntry {
  argv: string[];
  cwd: string;
  wav: { path: string; underVoiceTmp: boolean; headerOk: boolean; dataBytes: number; seconds: number } | null;
  modelMagicOk: boolean;
  vadModelMagicOk: boolean | null;
  threads: number | null;
  envKeys: string[];
  mode: string;
  exit: number;
  violations: string[]; // 'whisper_argv:<index>', 'unknown_flag:<f>', ...
}
