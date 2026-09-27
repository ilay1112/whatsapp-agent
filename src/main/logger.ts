// src/main/logger.ts - redact() + createLogger (build-plan section 3; owner W1-12). Safety-critical: 100 % coverage (TESTS 13).
// ONE redaction choke point: every line handed to a sink has passed through redact() exactly once (ARCHITECTURE 14 / C-41).
import { createHash } from 'node:crypto';
import type { LogMeta, Logger } from './deps';
import { ERROR_CODES, type ErrorCode } from '../shared/errors';
import { READ_TOOL_NAMES } from './agent/toolDefs';

/** C-41 pattern table (docs/research/security-threat-model.md 6.3) plus the JID / e-mail / user-path / OAuth rows of the seam doc. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED-ANTHROPIC-KEY]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED-GOOGLE-KEY]'],
  [/\bya29\.[0-9A-Za-z_-]+\b/g, '[REDACTED-GOOGLE-ACCESS-TOKEN]'],
  [/\b1\/\/[0-9A-Za-z_-]{20,}\b/g, '[REDACTED-GOOGLE-REFRESH-TOKEN]'],
  // The optional scheme word keeps `authorization: Bearer <token>` in one match without swallowing the NEXT log field on a
  // second pass (the C-41 `(\s+\S+)?` tail is not idempotent, and redact() must be).
  [
    /(authorization|x-bridge-token|x-api-key|x-goog-api-key|x-auth-token|proxy-authorization)\s*[:=]\s*(?:Bearer\s+|Basic\s+)?\S+/gi,
    '$1: [REDACTED]',
  ],
  [/\bBearer\s+\S+/g, 'Bearer [REDACTED]'],
  [/\/hook\/[A-Za-z0-9_-]{16,}/g, '/hook/[REDACTED]'],
  [/\b[0-9a-f]{64}\b/g, '[REDACTED-HEX64]'],
  // Query-string parameters only: a bare `code=` is how this logger renders an ErrorCode, which MUST stay readable.
  [/([?&])(code|state|token|client_id)=[^&\s"'<>]+/gi, '$1$2=[REDACTED]'],
  [/\b(access_token|refresh_token|client_secret|api_key|apikey)=[^&\s"'<>]+/gi, '$1=[REDACTED]'],
  [/\b\d{5,20}(?=@(?:s\.whatsapp\.net|lid|c\.us|g\.us))/g, '[PHONE]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/(?<![\w.+])\+\d{7,15}\b/g, '[PHONE]'],
  [/([A-Za-z]:\\Users\\)[^\\/\s"'<>;|]+/g, '$1[USER]'],
];

/** Replaces tokens, API keys (sk-ant-..., AIza...), Bearer values, JIDs, phone numbers, e-mail addresses, userData paths and
 *  `code=`/`access_token`/`refresh_token`/`client_secret` values with fixed placeholders. Pure; idempotent. */
export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** sha256(value).slice(0, 8) - the only form in which an untrusted identifier may appear in a log line or an audit row. */
export function sha8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

/** Metadata for a tool name: the literal name only when it is one of our own READ tools, otherwise a hash + length ([R2] ARCHITECTURE 14). */
export function toolMeta(name: string): LogMeta {
  return (READ_TOOL_NAMES as readonly string[]).includes(name)
    ? { tool: name }
    : { toolSha8: sha8(name), toolLen: name.length };
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Metadata for a caught error: its ErrorCode (or INTERNAL) - NEVER `err.message`, which may echo prompt or message text. */
export function errorMeta(err: unknown): { code: ErrorCode } {
  const candidate = (err as { code?: unknown } | null | undefined)?.code;
  return {
    code: typeof candidate === 'string' && ERROR_CODE_SET.has(candidate) ? (candidate as ErrorCode) : 'INTERNAL',
  };
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface CreateLoggerInput {
  logsDir: string;
  /** Injected sink (electron-log in production, an array in tests). Receives ALREADY-redacted lines. */
  sink?: (line: string) => void;
  now?: () => number;
}

/** Formats one entry. Values are rendered as `key=value`; the whole line goes through redact() once. */
function formatLine(ts: number, level: LogLevel, scope: string, event: string, meta: LogMeta | undefined): string {
  const parts: string[] = [new Date(ts).toISOString(), level.toUpperCase(), scope ? `${scope}.${event}` : event];
  if (meta) {
    for (const [key, raw] of Object.entries(meta)) {
      if (raw === undefined) continue;
      // toolMeta() expands a model-chosen tool name into a hash + length; every other key is rendered as it is.
      const entries = key === 'tool' && typeof raw === 'string' ? Object.entries(toolMeta(raw)) : [[key, raw] as const];
      for (const [k, v] of entries) {
        parts.push(`${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
      }
    }
  }
  return redact(parts.join(' '));
}

/** Metadata-only structured logger: `event` + flat meta, every value passed through redact(). Never message text. */
export function createLogger(input: CreateLoggerInput): Logger {
  const now = input.now ?? Date.now;
  const sink = input.sink ?? ((): void => {});
  const make = (scope: string): Logger => ({
    info: (event, meta) => sink(formatLine(now(), 'info', scope, event, meta)),
    warn: (event, meta) => sink(formatLine(now(), 'warn', scope, event, meta)),
    error: (event, meta) => sink(formatLine(now(), 'error', scope, event, meta)),
    child: (child) => make(scope ? `${scope}.${child}` : child),
  });
  return make('');
}

// ---------------------------------------------------------------------------------------------------------------------
// electron-log wiring (ARCHITECTURE 14: 5 files x 1 MB). electron-log itself is injected so this module stays Node-only
// and testable; src/main/compose.ts (W2-01) passes the real `electron-log/main` instance - see the REQUESTS in the notes.
// ---------------------------------------------------------------------------------------------------------------------
export const LOG_FILE_NAME = 'main.log';
export const LOG_FILE_MAX_BYTES = 1024 * 1024;
export const LOG_FILE_COUNT = 5;

export interface ElectronLogLike {
  transports: {
    file: {
      level: string | false;
      maxSize: number;
      format: string;
      resolvePathFn?: (variables: { fileName?: string }) => string;
      archiveLogFn?: (file: { path: string }) => void;
    };
    console: { level: string | false };
    ipc?: { level: string | false } | null;
  };
  info(message: string): void;
}

export interface FileOps {
  existsSync(p: string): boolean;
  renameSync(from: string, to: string): void;
  unlinkSync(p: string): void;
}

/** Keeps `<logsDir>\main.log` plus at most LOG_FILE_COUNT-1 numbered archives (`main.1.log` ... `main.4.log`). */
export function rotateLogFiles(currentPath: string, fs: FileOps, keep: number = LOG_FILE_COUNT): void {
  const base = currentPath.replace(/\.log$/i, '');
  const oldest = `${base}.${keep - 1}.log`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let i = keep - 2; i >= 1; i--) {
    const from = `${base}.${i}.log`;
    if (fs.existsSync(from)) fs.renameSync(from, `${base}.${i + 1}.log`);
  }
  if (fs.existsSync(currentPath)) fs.renameSync(currentPath, `${base}.1.log`);
}

/** Configures the injected electron-log instance for metadata-only file logging and returns the sink for createLogger(). */
export function configureElectronLog(
  elog: ElectronLogLike,
  input: { logsDir: string; fs: FileOps },
): (line: string) => void {
  const filePath = `${input.logsDir}\\${LOG_FILE_NAME}`;
  elog.transports.console.level = false;
  if (elog.transports.ipc) elog.transports.ipc.level = false;
  elog.transports.file.level = 'info';
  elog.transports.file.maxSize = LOG_FILE_MAX_BYTES;
  elog.transports.file.format = '{text}';
  elog.transports.file.resolvePathFn = () => filePath;
  elog.transports.file.archiveLogFn = (file) => rotateLogFiles(file.path, input.fs);
  return (line: string) => elog.info(line);
}
